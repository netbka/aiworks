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
import { accountAfterRun, accountFull, accountLimit, accountOf, accountWait, laterWait, openOnAccount } from '../../src/supervisor/accounts.mjs';
import { WAIT_REASONS, admissionCheck, classifyRun } from '../../src/supervisor/scheduler.mjs';
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

function rig(t, config = {}, { Ctl = Controller, now = undefined } = {}) {
  const env = environment();
  Object.assign(env.config, config, { commands: { ...env.config.commands, ...config.commands } });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const controller = new Ctl({ store, config: env.config, dataDir: env.dataDir, fault: null, now });
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

// ---- RUN8 (ADAPTIVE_SCHEDULER slice S6): a usage-limit refusal lowers the account's concurrency; useful results raise it. ----

/**
 * The controller with the RUN8 wiring this slice proposes for controller.mjs, which RUN8 does not own (see the PR's
 * finding): admission asks accountFull about the provider the candidate would get, and every finished run is passed to
 * accountAfterRun with its stored outcome. The live controller calls neither yet.
 */
class Wired extends Controller {
  constructor(options) { super(options); this.accountWaited = new Set(); }
  admissionInputs() {
    return { ...super.admissionInputs(), accountFull: (candidate) => {
      const executor = this.executorChoice(candidate.declaration, this.store.task(candidate.campaignId, candidate.taskId)).executor;
      return executor ? accountFull(this.store, this.config, executor.kind, this.accountWaited) : null;
    } };
  }
  applyOutcome(ctx, op, outcome) {
    const open = ['recorded', 'dispatched'].includes(this.store.get('SELECT state FROM operations WHERE id = ?', op.id)?.state);
    super.applyOutcome(ctx, op, outcome);
    const done = this.store.get('SELECT state, outcome FROM operations WHERE id = ?', op.id);
    if (!this.sched || !open || done.state !== 'finished') return;
    accountAfterRun(this.store, this.config, { kind: op.executor_kind, opId: op.id, quota: done.outcome.class === 'quota',
      run: classifyRun(op.kind, done.outcome), waited: this.accountWaited, campaignId: ctx.id, now: this.now() });
  }
}

const SCHED = { scheduler: { enabled: true, maxWorkers: 4 } };
/** One-task campaigns on the default claude-cli account, each in its own project, writing only the file r.succeed commits. */
function startMany(r, ids, issue) {
  ids.forEach((id, i) => {
    const d = campaign(id, issue + i);
    campaignStart(r.store, { ...d, target: { ...d.target, projectId: `p-${id}` }, tasks: d.tasks.map((task) => ({ ...task, writes: [`${id}.txt`] })) });
  });
}
const limitRow = (r) => r.store.get("SELECT value FROM capacity WHERE scope = 'account' AND id = 'claude-cli'")?.value ?? null;
const accountRuns = (r) => r.store.all("SELECT id, outcome FROM operations WHERE executor_kind = 'claude-cli' ORDER BY created_at, id");

test('a throttle lowers account concurrency without a retry storm', async (t) => {
  let clock = Date.now();
  const r = rig(t, SCHED, { Ctl: Wired, now: () => clock });
  const ids = ['camp-a', 'camp-b', 'camp-c', 'camp-d'];
  startMany(r, ids, 861);
  for (let i = 0; i < 4; i += 1) { await r.tick(); clock += 1; }
  assert.equal(ids.filter((id) => r.open(id)).length, 4, 'four runs open on one Claude account');
  assert.equal(limitRow(r), null, 'no limit before the provider complained');

  // The provider refuses camp-a's run for its usage limit: the account cools down until the reset, and from then on may
  // run half of the four that were open when it refused.
  const resetAt = clock + HOUR;
  r.quota('camp-a', resetAt);
  assert.equal(limitRow(r), 2, 'half of the four runs open at the refusal');
  assert.equal(openOnAccount(r.store, r.env.config, 'claude-cli'), 3, 'running work continues: nothing is stopped');

  // Every tick from here: a new run may start on the account only while fewer runs than its limit are open on it.
  const seen = new Set(accountRuns(r).map((op) => op.id));
  const tickAndCheck = async (label) => {
    const openBefore = openOnAccount(r.store, r.env.config, 'claude-cli');
    const limit = accountLimit(r.store, r.env.config, 'claude-cli');
    await r.tick();
    clock += 1;
    const started = accountRuns(r).filter((op) => !seen.has(op.id));
    for (const op of started) seen.add(op.id);
    if (started.length) assert.ok(openBefore < limit, `${label}: a run started while ${openBefore} were open under a limit of ${limit}`);
    return started.length;
  };

  // Inside the wait nothing is sent to the account: no retry storm.
  for (let i = 0; i < 3; i += 1) assert.equal(await tickAndCheck('inside the wait'), 0, 'no run starts during the cooldown');

  // After the reset camp-a is due again, but three runs still use the account: it waits for concurrency, not cooldown.
  clock = resetAt + 1;
  assert.equal(await tickAndCheck('after the reset'), 0);
  assert.equal(r.controller.waitReasons.get('camp-a/T1')?.reason, 'provider-concurrency');
  assert.deepEqual(r.controller.waitReasons.get('camp-a/T1')?.detail, { account: 'claude-cli', limit: 2, open: 3 });
  assert.ok(WAIT_REASONS.includes('provider-concurrency'));

  // A run that was already open ends with a useful result while camp-a waited for the account: the limit grows by one,
  // and camp-a starts again, still only while the account is under its limit.
  r.succeed('camp-b');
  assert.equal(limitRow(r), 3, 'a useful result while work waited raises the limit by one');
  for (let i = 0; i < 4; i += 1) await tickAndCheck('after a useful result');
  assert.ok(r.open('camp-a'), 'camp-a runs again once the account has room');
  assert.ok(openOnAccount(r.store, r.env.config, 'claude-cli') <= 3, 'never more runs than the limit');
  assert.equal(accountRuns(r).filter((op) => op.outcome?.class === 'quota').length, 1, 'one usage-limit refusal, no repeat');
  assert.deepEqual(r.store.all("SELECT kind FROM journal WHERE kind LIKE 'account-concurrency-%' ORDER BY seq").map((row) => row.kind),
    ['account-concurrency-lowered', 'account-concurrency-raised'], 'every change is journalled, once');
});

test('a repeated throttle halves again from the runs open then, never below one; growth needs waiting work', async (t) => {
  let clock = Date.now();
  const r = rig(t, SCHED, { Ctl: Wired, now: () => clock });
  startMany(r, ['camp-e', 'camp-f', 'camp-g', 'camp-h'], 871);
  for (let i = 0; i < 4; i += 1) { await r.tick(); clock += 1; }
  r.quota('camp-e', clock + HOUR);
  assert.equal(limitRow(r), 2, 'four open: two');
  r.quota('camp-f', clock + HOUR);
  assert.equal(limitRow(r), 1, 'a second refusal halves again: three open, one');
  r.quota('camp-g', clock + HOUR);
  assert.equal(limitRow(r), 1, 'never below one, and a throttle never raises the limit');
  r.succeed('camp-h');
  assert.equal(limitRow(r), 1, 'a useful result with no work waiting for the account changes nothing');
  assert.equal(r.store.all("SELECT kind FROM journal WHERE kind LIKE 'account-concurrency-%'").length, 2, 'only real changes are journalled');
});

test('no limit appears for an account that never throttled', async (t) => {
  let clock = Date.now();
  const r = rig(t, { ...SCHED, providerAccounts: { 'codex-cli': 'codex-main' } }, { Ctl: Wired, now: () => clock });
  startMany(r, ['calm-a', 'calm-b', 'calm-c'], 881);
  for (let i = 0; i < 3; i += 1) { await r.tick(); clock += 1; }
  const op = r.open('calm-a');
  r.controller.applyOutcome({ id: 'calm-a', generation: r.controller.held.get('calm-a') }, op, { class: 'timeout', detail: 'slow', receipt: { sessionId: op.session_id } });
  r.succeed('calm-b');
  for (let i = 0; i < 3; i += 1) { await r.tick(); clock += 1; }
  assert.equal(r.store.all("SELECT * FROM capacity WHERE scope = 'account'").length, 0, 'failures and successes alone never add a limit');
  assert.equal(accountLimit(r.store, r.env.config, 'claude-cli'), null);
  assert.equal(accountFull(r.store, r.env.config, 'claude-cli'), null, 'an unlimited account is never full');

  // A throttle on one account limits that account only.
  accountAfterRun(r.store, r.env.config, { kind: 'codex-cli', opId: null, quota: true, campaignId: 'calm-c', now: clock });
  assert.equal(accountLimit(r.store, r.env.config, 'codex-cli'), 1);
  assert.equal(accountLimit(r.store, r.env.config, 'claude-cli'), null, 'claude-cli never complained, so it stays unlimited');
  // A new campaign on claude-cli is admitted, with the account input and without it (the controller as it is today).
  startMany(r, ['calm-d'], 884);
  const candidate = { campaignId: 'calm-d', taskId: 'T1', kind: 'implement', ord: 0, declaration: r.store.campaign('calm-d').declaration };
  assert.equal(admissionCheck(r.store, candidate, { ...r.controller.admissionInputs(), ceiling: 8 }), null);
  assert.equal(admissionCheck(r.store, candidate, { ceiling: 8 }), null);
});
