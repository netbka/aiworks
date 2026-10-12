// The governance root: AIWorks reads Engineering Platform's registry, policy catalog and roadmap docs from an explicit
// read-only checkout. Configured, missing and invalid roots, for the library, the CLI, the controller and the dashboard.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { assertRegisteredTarget, projectGovernance } from '../../src/supervisor/campaign.mjs';
import { configuredGovernanceRoot, GovernanceRootError, requireGovernanceRoot } from '../../src/supervisor/governance.mjs';
import { RoadmapSource, readReleaseAuthorizations, readRoadmap } from '../../src/dashboard/roadmap.mjs';
import { CLI, declaration, environment, GOVERNANCE, skipWithoutSqlite, SQLITE } from './helpers.mjs';
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};

const temp = (t, prefix = 'aiworks-governance-root-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
};
const codeOf = (fn) => { try { fn(); } catch (error) { return error.code ?? error.name; } return null; };

test('a configured root resolves; the key is read from config.json and a bad config reads as not configured', (t) => {
  assert.equal(requireGovernanceRoot(GOVERNANCE), GOVERNANCE);
  const data = temp(t);
  assert.equal(configuredGovernanceRoot(data), null, 'no config.json');
  writeFileSync(join(data, 'config.json'), JSON.stringify({ governanceRoot: GOVERNANCE }));
  assert.equal(configuredGovernanceRoot(data), GOVERNANCE);
  for (const content of ['{ not json', JSON.stringify({}), JSON.stringify({ governanceRoot: 7 }), JSON.stringify({ governanceRoot: '  ' })]) {
    writeFileSync(join(data, 'config.json'), content);
    assert.equal(configuredGovernanceRoot(data), null, content);
  }
  assert.equal(projectGovernance('netbka/Dyk', GOVERNANCE).project, 'dyk');
  assert.doesNotThrow(() => assertRegisteredTarget(declaration(), GOVERNANCE));
});

test('a missing root fails closed with GOVERNANCE_ROOT_REQUIRED and never falls back to the AIWorks code root', () => {
  for (const missing of [undefined, null, '', '   ']) {
    assert.equal(codeOf(() => requireGovernanceRoot(missing)), 'GOVERNANCE_ROOT_REQUIRED');
    assert.equal(codeOf(() => projectGovernance('netbka/Dyk', missing)), 'GOVERNANCE_ROOT_REQUIRED');
    assert.equal(codeOf(() => assertRegisteredTarget(declaration(), missing)), 'GOVERNANCE_ROOT_REQUIRED');
  }
  assert.throws(() => projectGovernance('netbka/Dyk'), GovernanceRootError, 'no default root');
});

test('an invalid root fails closed with GOVERNANCE_ROOT_INVALID', (t) => {
  const empty = temp(t);
  const noProjects = temp(t);
  mkdirSync(join(noProjects, 'registry'));
  writeFileSync(join(noProjects, 'registry', 'projects'), 'a file, not a directory');
  for (const invalid of [join(empty, 'does-not-exist'), empty, noProjects, 'relative/path']) {
    assert.equal(codeOf(() => requireGovernanceRoot(invalid)), 'GOVERNANCE_ROOT_INVALID', invalid);
    assert.equal(codeOf(() => projectGovernance('netbka/Dyk', invalid)), 'GOVERNANCE_ROOT_INVALID', invalid);
    assert.equal(codeOf(() => assertRegisteredTarget(declaration(), invalid)), 'GOVERNANCE_ROOT_INVALID', invalid);
  }
});

const cli = (data, args, { env = {} } = {}) => {
  const childEnv = { ...process.env, AIWORKS_DATA: '', ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--no-warnings', CLI, ...args, '--data', data], { env: childEnv, windowsHide: true, encoding: 'utf8' });
};

test('CLI start: --governance, config.json governanceRoot, or a coded refusal', { skip: !SQLITE }, (t) => {
  const root = temp(t, 'aiworks-governance-cli-');
  const file = join(root, 'campaign.json');
  writeFileSync(file, JSON.stringify(declaration({ campaignId: 'governed' })));
  const data = (name, config) => {
    const dir = join(root, name);
    mkdirSync(dir);
    if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    return dir;
  };

  const none = cli(data('none'), ['start', file]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /GOVERNANCE_ROOT_REQUIRED/);

  const bad = cli(data('bad', { governanceRoot: join(root, 'nowhere') }), ['start', file]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /GOVERNANCE_ROOT_INVALID/);

  const viaFlag = cli(data('flag'), ['start', file, '--governance', GOVERNANCE]);
  assert.equal(viaFlag.status, 0, viaFlag.stderr);

  const viaConfig = cli(data('config', { governanceRoot: GOVERNANCE }), ['start', file]);
  assert.equal(viaConfig.status, 0, viaConfig.stderr);

  const flagWins = cli(data('wins', { governanceRoot: GOVERNANCE }), ['start', file, '--governance', join(root, 'nowhere')]);
  assert.equal(flagWins.status, 1, 'an explicit --governance overrides config.json');
  assert.match(flagWins.stderr, /GOVERNANCE_ROOT_INVALID/);

  const store = new Store(join(data('status'), 'supervisor.db'));
  try { campaignStart(store, declaration({ campaignId: 'stored' })); } finally { store.close(); }
  const status = cli(join(root, 'status'), ['status', 'stored']);
  assert.equal(status.status, 0, 'commands other than registering a new campaign need no governance root');
});

test('the controller dispatches no worker without a governance root and raises a coded B2 blocker', { skip: skipWithoutSqlite }, async (t) => {
  for (const [name, governanceConfig] of [['missing', {}], ['invalid', { governanceRoot: join(tmpdir(), 'aiworks-no-such-governance-root') }]]) {
    const env = environment({ config: { governanceRoot: undefined, ...governanceConfig } });
    const store = new Store(join(env.dataDir, 'supervisor.db'));
    const decl = declaration({ tasks: [declaration().tasks[0]], campaignId: `no-governance-${name}` });
    campaignStart(store, decl);
    const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
    controller.launch = async () => { throw new Error('no worker may launch without governance'); };
    t.after(() => { controller.release(); store.close(); env.cleanup(); });
    await controller.tick();
    assert.ok(!store.get('SELECT * FROM operations WHERE campaign_id = ?', decl.campaignId), `${name}: no operation recorded`);
    const { blocker } = store.campaign(decl.campaignId);
    assert.equal(blocker?.kind, 'project-governance', name);
    assert.equal(blocker.class, 'B2');
    assert.match(blocker.reason, name === 'missing' ? /GOVERNANCE_ROOT_REQUIRED/ : /GOVERNANCE_ROOT_INVALID/);
    assert.match(blocker.requestedAction, /governanceRoot/);
  }
});

test('the controller takes the root from config.json, and an explicit constructor root overrides it', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  assert.equal(new Controller({ store, config: env.config, dataDir: env.dataDir }).governanceRoot, GOVERNANCE);
  assert.equal(new Controller({ store, config: env.config, dataDir: env.dataDir, governanceRoot: '/elsewhere' }).governanceRoot, '/elsewhere');
});

test('the dashboard roadmap reads the governance root, and degrades instead of crashing without one', (t) => {
  const cache = temp(t);
  const configured = new RoadmapSource({ root: GOVERNANCE, cacheDir: cache });
  assert.equal(configured.governance.configured, true);
  assert.ok(configured.snapshot().entries.length > 0);
  assert.deepEqual(configured.snapshot().governance, { configured: true, code: null, reason: null });

  const missing = new RoadmapSource({ root: null, cacheDir: cache, repositories: ['netbka/Dyk'] });
  assert.equal(missing.snapshot().governance.configured, false);
  assert.equal(missing.snapshot().governance.code, 'GOVERNANCE_ROOT_REQUIRED');
  assert.match(missing.snapshot().governance.reason, /governance checkout not configured/);
  assert.deepEqual(missing.snapshot().entries, []);
  assert.deepEqual(missing.repositories, ['netbka/Dyk'], 'configured project repositories are still tracked');

  const empty = temp(t);
  const invalid = new RoadmapSource({ root: empty, cacheDir: cache });
  assert.equal(invalid.snapshot().governance.configured, false);
  assert.equal(invalid.snapshot().governance.code, 'GOVERNANCE_ROOT_INVALID');
  assert.match(invalid.snapshot().governance.reason, /not usable/);

  // A valid checkout whose roadmap docs are missing is also reported, not thrown.
  const partial = temp(t);
  mkdirSync(join(partial, 'registry', 'projects'), { recursive: true });
  const unreadable = new RoadmapSource({ root: partial, cacheDir: cache });
  assert.equal(unreadable.snapshot().governance.configured, false);
  assert.equal(unreadable.snapshot().governance.code, 'ENOENT');

  assert.throws(() => readRoadmap(undefined), GovernanceRootError);
  assert.deepEqual(readReleaseAuthorizations(null), {}, 'no root records no release authorization');
  assert.deepEqual(readReleaseAuthorizations(empty), {});
});
