// RUN3 (ADAPTIVE_SCHEDULER slice S1): a usage limit, a failed login or an unavailable host belongs to the provider account,
// not to one campaign. One wait on the account holds every campaign that uses it; a recheck or a success ends it once, and
// the campaigns waiting on it resume at once. Accounts are named per executor kind in config.json (providerAccounts) and
// default to the kind. Workers are played through applyOutcome, so nothing is spawned and the tests run on Linux CI too.
// No model, network or GitHub call: a disposable git origin and the synthetic gh of helpers.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignRecheck, campaignStart, campaignStatus } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { accountOf, accountWait, laterWait } from '../../src/supervisor/accounts.mjs';
import { declaration, environment } from './helpers.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

const HOUR = 60 * 60_000;
const chain = (...kinds) => ({ kind: 'cli-chain', providers: kinds.map((kind) => (kind === 'claude-cli' ? { kind, model: 'opus', permissionMode: 'auto' } : { kind })),
  implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 });
/** One task campaign. `executor` defaults to the single-provider claude-cli of helpers.mjs. */
const campaign = (campaignId, issue, { executor = null, deliverable = 'commit' } = {}) => {
  const d = declaration({ campaignId, tasks: [{ id: 'T1', issue, title: `${campaignId} task`, deliverable, goal: 'Produce it.',
    dependsOn: [], acceptance: ['it exists'], references: ['AGENTS.md'] }] });
  return executor ? { ...d, executor } : d;
};

function rig(t, config = {}) {
  const env = environment();
  Object.assign(env.config, config, { commands: { ...env.config.commands, ...config.commands } });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  controller.launch = async () => {}; // the test plays the worker; nothing is spawned
  const open = (id) => store.openOperations(id)[0] ?? null;
  const ctx = (id) => ({ id, generation: controller.held.get(id) });
  const opened = (id) => store.all('SELECT * FROM operations WHERE campaign_id = ?', id);
  const play = (id, outcome) => {
    const op = open(id);
    assert.ok(op, `${id} has an open operation`);
    controller.applyOutcome(ctx(id), op, { receipt: { sessionId: op.session_id }, ...outcome(op) });
  };
  return {
    env, store, controller, open, opened,
    tick: () => controller.tick(),
    quota: (id, retryAt) => play(id, () => ({ class: 'quota', retryAt, detail: 'usage limit reached; resets later' })),
    auth: (id) => play(id, () => ({ class: 'auth', detail: 'not logged in' })),
    // A useful result on the account: the worker committed and reported.
    succeed: (id) => play(id, (op) => {
      writeFileSync(join(op.workspace, `${id}.txt`), `${id}\n`);
      git(op.workspace, 'add', '-A'); git(op.workspace, 'commit', '-qm', `work for ${id}`);
      return { class: 'result', value: { result: 'resolved', summary: 'implemented', headSha: git(op.workspace, 'rev-parse', 'HEAD'), report: '# Report' } };
    }),
    cleared: (id) => store.all("SELECT kind FROM journal WHERE campaign_id = ? AND kind = 'provider-wait-cleared'", id).length,
  };
}

test('one account cooldown holds every campaign using that account', async (t) => {
  const r = rig(t);
  campaignStart(r.store, campaign('camp-a', 801, { executor: chain('claude-cli') }));
  await r.tick();
  const resetAt = Date.now() + HOUR;
  r.quota('camp-a', resetAt);
  assert.equal(accountWait(r.store, r.env.config, 'claude-cli')?.retry_at, resetAt, 'the usage limit is recorded on the account');

  // Campaigns registered afterwards use the same Claude account: neither sends work to the exhausted account.
  campaignStart(r.store, campaign('camp-b', 802, { executor: chain('claude-cli') }));
  campaignStart(r.store, campaign('camp-s', 803)); // single provider
  await r.tick();
  await r.tick();
  for (const id of ['camp-b', 'camp-s']) assert.deepEqual(r.opened(id), [], `${id} made no claude-cli call before the reset`);
  const waiting = r.store.task('camp-b', 'T1');
  assert.equal(waiting.retry_at, resetAt);
  assert.match(waiting.last_error, /^waiting for executor availability/);
  assert.equal(r.store.campaign('camp-s').blocker, null, 'the single-provider campaign waits silently');
  for (const id of ['camp-b', 'camp-s']) {
    assert.deepEqual(campaignStatus(r.store, id).executorWaits.map((w) => [w.executor_kind, w.retry_at]), [['claude-cli', resetAt]], `${id} status shows the account wait`);
  }
});

test('different accounts cool down independently', async (t) => {
  const r = rig(t, { providerAccounts: { 'claude-cli': 'claude-main' } });
  assert.equal(accountOf(r.env.config, 'claude-cli'), 'claude-main');
  assert.equal(accountOf({ providerAccounts: { 'claude-cli': '../bad name' } }, 'claude-cli'), 'claude-cli', 'a malformed name falls back to the kind');
  assert.equal(accountOf({}, 'codex-cli'), 'codex-cli', 'without a mapping the account is the executor kind');
  // A usage limit on another Claude account (another login, or an earlier mapping) never holds claude-main.
  r.store.run('INSERT INTO provider_waits (account, executor_kind, retry_at, reason, campaign_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    'claude-other', 'claude-cli', Date.now() + HOUR, 'quota: another account', 'elsewhere', Date.now());
  campaignStart(r.store, campaign('camp-c', 821));
  campaignStart(r.store, campaign('camp-d', 822, { executor: chain('claude-cli') }));
  await r.tick();
  assert.ok(r.open('camp-c'), 'the single-provider campaign on claude-main is not held by claude-other');
  assert.ok(r.open('camp-d'), 'the chain on claude-main is not held by claude-other');
  r.quota('camp-c', Date.now() + HOUR);
  assert.ok(accountWait(r.store, r.env.config, 'claude-cli'), 'the limit lands on claude-main');
  assert.equal(r.store.all("SELECT * FROM provider_waits WHERE account = 'claude-other'").length, 1, 'the other account is untouched');
});

test('a recheck of one campaign ends the account wait once, and every campaign waiting on it resumes at once', async (t) => {
  const r = rig(t);
  campaignStart(r.store, campaign('camp-a', 811, { executor: chain('claude-cli') }));
  campaignStart(r.store, campaign('camp-b', 812, { executor: chain('claude-cli') }));
  campaignStart(r.store, campaign('camp-s', 813));
  await r.tick();
  // All three were running when the provider refused: each recorded the limit, and the account holds one wait.
  for (const id of ['camp-a', 'camp-b', 'camp-s']) r.quota(id, Date.now() + HOUR);
  assert.equal(r.store.all('SELECT * FROM provider_waits').length, 1, 'one wait for the account');
  await r.tick();
  for (const id of ['camp-a', 'camp-b', 'camp-s']) assert.equal(r.open(id), null, `${id} waits`);

  campaignRecheck(r.store, 'camp-a', { note: 'the owner says the limit lifted' });
  await r.tick();
  await r.tick();
  assert.equal(accountWait(r.store, r.env.config, 'claude-cli'), null, 'the account wait ended');
  assert.equal(r.store.all("SELECT * FROM executor_waits WHERE executor_kind = 'claude-cli'").length, 0, 'no campaign keeps its own copy');
  for (const id of ['camp-a', 'camp-b', 'camp-s']) {
    assert.ok(r.open(id), `${id} resumed without waiting for its own timer or its own recheck`);
    assert.equal(r.cleared(id), 1, `${id} journals the cleared wait once`);
  }
});

test('a success on the account ends its wait once for every campaign using it', async (t) => {
  const r = rig(t);
  campaignStart(r.store, campaign('camp-a', 831, { executor: chain('claude-cli') }));
  campaignStart(r.store, campaign('camp-s', 832));
  campaignStart(r.store, campaign('camp-ok', 833));
  await r.tick();
  r.quota('camp-a', Date.now() + HOUR);
  r.quota('camp-s', Date.now() + HOUR);
  await r.tick();
  assert.equal(r.open('camp-a'), null);
  assert.equal(r.open('camp-s'), null);

  r.succeed('camp-ok'); // a run started before the limit finishes with a useful result: the account works
  assert.equal(accountWait(r.store, r.env.config, 'claude-cli'), null, 'the success ended the account wait');
  await r.tick();
  await r.tick();
  assert.ok(r.open('camp-a'), 'the chain campaign resumed at once');
  assert.ok(r.open('camp-s'), 'the single-provider campaign resumed at once');
  for (const id of ['camp-a', 'camp-s', 'camp-ok']) assert.equal(r.cleared(id), 1, `${id} journals the cleared wait once`);
});

test('a failed login found by a chain holds other campaigns silently until one recheck', async (t) => {
  const r = rig(t);
  campaignStart(r.store, campaign('camp-a', 841, { executor: chain('claude-cli') }));
  await r.tick();
  r.auth('camp-a');
  assert.equal(r.store.campaign('camp-a').blocker?.class, 'B2', 'the campaign that found it asks the owner');
  assert.equal(accountWait(r.store, r.env.config, 'claude-cli')?.retry_at, null, 'an untimed wait on the account');

  campaignStart(r.store, campaign('camp-s', 842));
  await r.tick();
  assert.deepEqual(r.opened('camp-s'), [], 'no work is sent to an account whose login failed');
  assert.equal(r.store.campaign('camp-s').blocker, null, 'no second owner question, and no false "no executor supports this role"');
  assert.match(r.store.task('camp-s', 'T1').last_error, /^waiting for executor availability: the claude-cli account waits for a recheck/);

  campaignRecheck(r.store, 'camp-a', { note: 'the owner logged in again' });
  await r.tick();
  await r.tick();
  assert.equal(accountWait(r.store, r.env.config, 'claude-cli'), null);
  assert.ok(r.open('camp-s'), 'the other campaign resumed with the one recheck');
});

test('a finding about one project stays with its campaign', async (t) => {
  const r = rig(t, { commands: { codex: [process.execPath, '-e', '0'] } }); // configured, never launched
  // The target project carries its own Codex extensions: a finding about this project, not about the account.
  mkdirSync(join(r.env.repo, '.codex'));
  writeFileSync(join(r.env.repo, '.codex', 'config.toml'), '# project extension\n');
  git(r.env.repo, 'add', '-A'); git(r.env.repo, 'commit', '-qm', 'project extension'); git(r.env.repo, 'push', '-q', 'origin', 'main');
  campaignStart(r.store, campaign('camp-x', 851, { executor: chain('codex-cli'), deliverable: 'report' }));
  await r.tick();
  assert.equal(r.open('camp-x'), null);
  assert.match(r.store.get("SELECT reason FROM executor_waits WHERE campaign_id = 'camp-x' AND executor_kind = 'codex-cli'")?.reason ?? '',
    /project CLI extensions/, 'the campaign records the finding');
  assert.equal(accountWait(r.store, r.env.config, 'codex-cli'), null, 'the account does not wait for one project\'s configuration');
});

test('the later wait wins, and an untimed wait beats any time', () => {
  const at = (retry_at) => ({ retry_at });
  assert.equal(laterWait(null, null), null);
  assert.deepEqual(laterWait(at(5), null), at(5));
  assert.deepEqual(laterWait(null, at(5)), at(5));
  assert.deepEqual(laterWait(at(5), at(9)), at(9));
  assert.deepEqual(laterWait(at(9), at(null)), at(null));
});
