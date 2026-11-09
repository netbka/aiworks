// A routed (routing.mode auto) commit campaign whose only implementer on Windows is the brokered Cursor provider must be
// able to start: the code broker grant reaches exactly the routing candidate (kind, model) it was judged for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoReceipt, policyInputs } from '../../src/supervisor/router.mjs';
import { environment, declaration, skipWithoutSqlite } from './helpers.mjs';
import { Store } from '../../src/supervisor/store.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';

const claude = { kind: 'claude-cli', model: 'example-claude-model', permissionMode: 'dontAsk' };
const routing = (cursorModels) => ({
  mode: 'auto',
  candidates: [...cursorModels.map((model) => ({ kind: 'cursor-cli', model, tier: 2 })), { kind: 'claude-cli', model: claude.model, tier: 3 }],
  pin: { implementer: { tier: 2 }, verifier: { kind: 'claude-cli', model: claude.model } },
});
const spec = { deliverable: 'commit', web: null, references: ['AGENTS.md'], acceptance: ['works'], dependsOn: [], writes: ['src/'] };
const facts = () => ({ cliConfigured: true, hostUnavailable: null, wait: null });
const choose = (routes, providers) => autoReceipt(policyInputs({ stage: 'implement', spec, routing: routes, providers, platform: 'win32', facts })).decision.chosen;
const cursor = (model, granted) => ({ kind: 'cursor-cli', model, ...(granted ? { brokeredCode: true } : {}) });

test('a routed commit step on Windows runs only on a Cursor model its operator granted, and on nothing without a grant', () => {
  assert.equal(choose(routing(['granted-model']), [cursor('granted-model', true), claude])?.kind, 'cursor-cli');
  assert.equal(choose(routing(['granted-model']), [cursor('granted-model', false), claude]), null,
    'without the grant no tier-2 implementer may commit, and the pin keeps Claude out');
  for (let i = 0; i < 2; i++) {
    const order = i ? ['other-model', 'granted-model'] : ['granted-model', 'other-model'];
    assert.equal(choose(routing(order), [cursor('granted-model', true), cursor('other-model', false), claude])?.model, 'granted-model',
      'an ungranted model of the same provider is never chosen');
  }
});

// A Windows host with global Cursor configuration and the WSL transport, and a controller over campaign `d` that records
// dispatches without starting a provider process. `broker` is the code broker grant for `model`, or null for none.
function brokerHost(t, d, model, { broker = null, includedOnly = null } = {}) {
  const env = environment();
  const oldHome = process.env.CURSOR_CONFIG_DIR;
  // Restored even when a step below fails, so a later test never reads this run's Cursor home.
  t.after(() => { if (oldHome === undefined) delete process.env.CURSOR_CONFIG_DIR; else process.env.CURSOR_CONFIG_DIR = oldHome; });
  t.after(() => env.cleanup());
  process.env.CURSOR_CONFIG_DIR = join(env.tmp, 'cursor-home'); mkdirSync(process.env.CURSOR_CONFIG_DIR);
  writeFileSync(join(process.env.CURSOR_CONFIG_DIR, 'cli-config.json'), '{}'); // global configuration a tool-free run never loads
  const packageRoot = join(env.tmp, 'package'); mkdirSync(packageRoot);
  for (const name of ['node', 'index.js']) writeFileSync(join(packageRoot, name), 'synthetic, never executed');
  const credentialFile = join(env.tmp, 'public-fixture.txt'); writeFileSync(credentialFile, 'not a credential');
  const configPath = join(env.tmp, 'transport.json');
  writeFileSync(configPath, JSON.stringify({ version: 1, distribution: 'ExampleLinux', allowedRoot: env.tmp, packageRoot, credentialFile, allowedModels: [model] }));
  env.config.commands.cursor = [process.execPath, fileURLToPath(new URL('../../src/supervisor/adapters/cursor-wsl.mjs', import.meta.url)), '--config', configPath];
  if (broker) env.config.codeBroker = { enabled: true, repositories: { [d.target.repository]: { campaigns: [d.campaignId], models: [model],
    roles: broker.roles, includedOnly: { attestedBy: 'owner', paidOverages: false, recordedAt: '2026-01-01' },
    nativeModels: { [model]: 'Example Included' }, allowedRoot: env.tmp, verificationCommand: ['npm', 'run', 'check'] } } };
  if (includedOnly) env.config.includedOnly = { 'cursor-cli': includedOnly };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  campaignStart(store, d);
  const ctl = new Controller({ store, config: env.config, dataDir: env.dataDir });
  ctl.launch = async () => {}; // Durable dispatch only; no real provider process.
  t.after(() => { ctl.release(); store.close(); });
  return { env, store, ctl };
}

test('a routed brokered implementer dispatches on a host with global Cursor configuration', { skip: skipWithoutSqlite || process.platform !== 'win32' }, async (t) => {
  const d = declaration({ tasks: [{ ...declaration().tasks[0], writes: ['note.txt'] }] });
  const model = 'example-included-model';
  d.executor = { kind: 'cli-chain', providers: [{ kind: 'cursor-cli', model }, claude], implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
  d.routing = { ...routing([model]) };
  const { store, ctl } = brokerHost(t, d, model, { broker: { roles: ['implementer', 'verification'] } });
  await ctl.tick();
  const op = store.openOperations(d.campaignId)[0];
  assert.equal(op?.executor_kind, 'cursor-cli', JSON.stringify(store.campaign(d.campaignId).blocker));
});

// PR #81 review: host findings were per provider, so one model's finding (or a role's) held every Cursor model in
// repeated 15-minute waits. They are judged per candidate model and role now, and only a provider whose every model the
// role could run fails waits.
test('a host finding for one Cursor model or another role never holds the provider\'s eligible model', { skip: skipWithoutSqlite || process.platform !== 'win32' }, async (t) => {
  const granted = 'example-included-model';
  const d = declaration({ tasks: [{ ...declaration().tasks[0], writes: ['note.txt'] }] });
  d.executor = { kind: 'cli-chain', providers: [{ kind: 'cursor-cli', model: granted }, claude], implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
  d.routing = routing(['example-other-model', granted]);
  const included = { attestedBy: 'owner', paidOverages: false, recordedAt: '2026-01-01', models: [granted] };
  const { env, store, ctl } = brokerHost(t, d, granted, { broker: { roles: ['implementer'] }, includedOnly: included });
  const ctx = { id: d.campaignId };
  const checkout = env.config.repositories[d.target.repository].path;
  // The Claude-pinned verify step judges no Cursor model, so it records no Cursor wait for the next implement step.
  assert.deepEqual([...ctl.routedHostChecks(ctx, d, { ...store.task(ctx.id, 'T1'), state: 'implemented' }, checkout, false, null)], []);
  assert.equal(store.all('SELECT * FROM executor_waits WHERE campaign_id = ?', ctx.id).length, 0);
  await ctl.tick();
  assert.equal(store.openOperations(ctx.id)[0]?.executor_kind, 'cursor-cli', JSON.stringify(store.campaign(ctx.id).blocker));

  // A research step whose included-only record names one of two models: only the other model is left out, and no wait.
  const report = declaration({ campaignId: 'research-campaign', tasks: [{ ...declaration().tasks[0], deliverable: 'report' }] });
  report.executor = { kind: 'cli-chain', providers: [{ kind: 'cursor-cli', model: granted, researchOnly: true }, { ...claude, researchOnly: true }],
    implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
  report.routing = routing(['example-other-model', granted]);
  campaignStart(store, report);
  const task = store.task(report.campaignId, 'T1');
  const found = ctl.routedHostChecks({ id: report.campaignId }, report, task, checkout, false, null);
  assert.deepEqual([...found.keys()], ['cursor-cli/example-other-model']);
  assert.match(found.get('cursor-cli/example-other-model'), /included-only eligibility is unknown/);
  assert.equal(store.all('SELECT * FROM executor_waits WHERE campaign_id = ?', report.campaignId).length, 0);
  const chosen = ctl.executorChoice(report, task, Date.now(), { hostUnavailable: found }).executor;
  assert.deepEqual([chosen?.kind, chosen?.model], ['cursor-cli', granted], 'the attested model runs; the other never does');
});
