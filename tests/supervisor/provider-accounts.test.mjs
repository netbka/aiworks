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
import { PROFILE_RECHECK_MS, accountAfterRun, accountFull, accountLimit, accountOf, accountWait, laterWait, openOnAccount, selectProfile } from '../../src/supervisor/accounts.mjs';
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

function rig(t, config = {}, { Ctl = Controller, now = undefined, profiles = null } = {}) {
  const env = environment();
  Object.assign(env.config, config, { commands: { ...env.config.commands, ...config.commands } });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const controller = new Ctl({ store, config: env.config, dataDir: env.dataDir, fault: null, now, profiles });
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

// ---- CAAM3 (ACCOUNT_ADAPTER_CAAM.md section 3.3): choose a CAAM profile per run, inside the dispatch transaction. ----

const CAAM = { caam: { enabled: true } };
/** A CAAM profile record as caam.mjs caamRobotStatus returns it; `cooldownUntil` makes CAAM report it cooling down. */
const profile = (name, cooldownUntil = null) => ({ id: `claude/${name}`, name, eligible: cooldownUntil === null,
  cooldown: { active: cooldownUntil !== null, until: cooldownUntil, reason: cooldownUntil === null ? null : 'rate limited' },
  reasons: cooldownUntil === null ? [] : ['cooldown active'] });
/** A synthetic CAAM inventory: Claude profiles only; any other kind keeps its static account. */
const inventory = (list) => (kind) => (kind === 'claude-cli' ? list() : null);
const bound = (r) => r.store.all("SELECT account_identity FROM operations WHERE executor_kind = 'claude-cli' ORDER BY created_at, rowid").map((op) => op.account_identity);
const profileWait = (r, account, retryAt, reason, now) => r.store.run(`INSERT INTO provider_waits (account, executor_kind, retry_at, reason,
  campaign_id, updated_at) VALUES (?, 'claude-cli', ?, ?, 'elsewhere', ?)`, account, retryAt, reason, now);

test('selection rotates among eligible profiles across consecutive dispatches', async (t) => {
  let clock = Date.now();
  const r = rig(t, CAAM, { now: () => clock, profiles: inventory(() => [profile('work-a'), profile('work-b')]) });
  for (const [i, id] of ['rot-1', 'rot-2', 'rot-3', 'rot-4'].entries()) {
    campaignStart(r.store, campaign(id, 901 + i));
    await r.tick();
    clock += 1;
  }
  assert.deepEqual(bound(r), ['claude/work-a', 'claude/work-b', 'claude/work-a', 'claude/work-b'], 'least recently used first: A, B, A, B');
  assert.deepEqual(r.store.all("SELECT detail FROM journal WHERE kind = 'operation-recorded' ORDER BY seq").map((row) => row.detail.account),
    ['claude/work-a', 'claude/work-b', 'claude/work-a', 'claude/work-b'], 'each run journals its profile');
  assert.equal(selectProfile(r.store, 'claude-cli', [profile('work-a'), profile('work-b'), profile('work-c')], clock).account, 'claude/work-c',
    'a profile never used goes first');
});

test('rotation holds when dispatches share a timestamp', async (t) => {
  const clock = Date.now();
  const r = rig(t, CAAM, { now: () => clock, profiles: inventory(() => [profile('work-a'), profile('work-b')]) });
  for (const [i, id] of ['same-1', 'same-2', 'same-3', 'same-4'].entries()) {
    campaignStart(r.store, campaign(id, 951 + i));
    await r.tick();
  }
  assert.deepEqual(bound(r), ['claude/work-a', 'claude/work-b', 'claude/work-a', 'claude/work-b'], 'the newer operation counts as the later use');
});

test('a profile with an active wait or a CAAM cooldown is skipped', async (t) => {
  let clock = Date.now();
  let list = [profile('work-a'), profile('work-b')];
  const r = rig(t, CAAM, { now: () => clock, profiles: inventory(() => list) });
  // work-a has a usage-limit row of its own: work-b takes both runs.
  profileWait(r, 'claude/work-a', clock + HOUR, 'quota: usage limit', clock);
  for (const [i, id] of ['skip-1', 'skip-2'].entries()) {
    campaignStart(r.store, campaign(id, 911 + i));
    await r.tick();
    clock += 1;
  }
  assert.deepEqual(bound(r), ['claude/work-b', 'claude/work-b'], 'the waiting profile is skipped');
  // work-a's row has run out and CAAM now reports work-b cooling down: work-a takes the next run.
  clock += HOUR;
  list = [profile('work-a'), profile('work-b', clock + HOUR)];
  campaignStart(r.store, campaign('skip-3', 913));
  await r.tick();
  assert.deepEqual(bound(r), ['claude/work-b', 'claude/work-b', 'claude/work-a'], 'the profile CAAM cools down is skipped');
  // A profile at its learned concurrency limit is skipped while another has room.
  r.store.run("INSERT INTO capacity (scope, id, value, reason, updated_at) VALUES ('account', 'claude/work-a', 1, 'test', ?)", clock);
  assert.equal(selectProfile(r.store, 'claude-cli', [profile('work-a'), profile('work-c')], clock).account, 'claude/work-c');
  // An untimed wait (a failed login) skips the profile until a success or a recheck ends it.
  profileWait(r, 'claude/work-c', null, 'auth: not logged in', clock);
  assert.equal(selectProfile(r.store, 'claude-cli', [profile('work-c'), profile('work-d')], clock).account, 'claude/work-d');
});

test('when every profile waits, the campaign waits for the earliest reset and records nothing', async (t) => {
  const clock = Date.now();
  const r = rig(t, CAAM, { now: () => clock, profiles: inventory(() => [profile('work-a'), profile('work-b', clock + 2 * HOUR)]) });
  profileWait(r, 'claude/work-a', clock + HOUR, 'quota: usage limit', clock);
  campaignStart(r.store, campaign('wait-all', 921));
  await r.tick();
  await r.tick();
  assert.deepEqual(r.opened('wait-all'), [], 'no operation is recorded');
  const task = r.store.task('wait-all', 'T1');
  assert.equal(task.retry_at, clock + HOUR, 'the campaign waits for the earliest reset among the profiles');
  assert.match(task.last_error, /^waiting for executor availability/);
  assert.equal(task.attempts, 0, 'no retry is spent');
  assert.equal(r.store.campaign('wait-all').runs_used, 0, 'no run is counted');
  assert.equal(r.store.campaign('wait-all').blocker, null, 'a provider limit is not an owner stop');
  assert.equal(accountWait(r.store, r.env.config, 'claude-cli'), null, 'no wait is invented for the whole executor kind');

  // No timed reset at all (CAAM lists no profile, or cannot be read): a bounded re-read, never an owner blocker.
  assert.deepEqual(selectProfile(r.store, 'claude-cli', [], clock), { account: null, retryAt: clock + PROFILE_RECHECK_MS, reason: 'CAAM lists no claude-cli profile' });
  const broken = rig(t, CAAM, { now: () => clock, profiles: () => { throw Object.assign(new Error('caam missing'), { code: 'missing-executable' }); } });
  campaignStart(broken.store, campaign('wait-broken', 922));
  await broken.tick();
  assert.deepEqual(broken.opened('wait-broken'), [], 'an unreadable inventory fails closed');
  assert.equal(broken.store.task('wait-broken', 'T1').retry_at, clock + PROFILE_RECHECK_MS);
  assert.equal(broken.store.campaign('wait-broken').blocker, null);
});

test('the profile is reserved in the same transaction as recordOperation', async (t) => {
  let clock = Date.now();
  const r = rig(t, CAAM, { now: () => clock, profiles: inventory(() => [profile('work-a'), profile('work-b')]) });
  const reads = [];
  const read = r.controller.profiles;
  r.controller.profiles = (kind, now) => { reads.push(r.store.depth > 0); return read(kind, now); };
  const recorded = [];
  const record = r.store.recordOperation.bind(r.store);
  r.store.recordOperation = (row) => { recorded.push({ inTx: r.store.depth > 0, account: row.account_identity }); return record(row); };
  campaignStart(r.store, campaign('atom-1', 931));
  await r.tick();
  assert.deepEqual(recorded, [{ inTx: true, account: 'claude/work-a' }], 'recordOperation binds the chosen profile inside the transaction');
  assert.equal(reads.at(-1), true, 'the profile is chosen again inside the dispatch transaction');
  assert.equal(r.open('atom-1').account_identity, 'claude/work-a');

  // A dispatch whose transaction fails after recordOperation leaves no reservation: work-b is still the next choice.
  clock += 1;
  r.store.recordOperation = (row) => { record(row); throw new Error('injected failure after recordOperation'); };
  campaignStart(r.store, campaign('atom-2', 932));
  await r.tick().catch(() => {});
  assert.deepEqual(r.opened('atom-2'), [], 'the operation rolled back');
  assert.equal(selectProfile(r.store, 'claude-cli', [profile('work-a'), profile('work-b')], clock).account, 'claude/work-b',
    'the rolled-back reservation does not count as a use');
  r.store.recordOperation = record;
  clock += 1;
  await r.tick();
  assert.equal(r.open('atom-2')?.account_identity, 'claude/work-b');
});

test('profile selection is off unless config.json enables it and an inventory is supplied', async (t) => {
  const off = rig(t, {}, { profiles: inventory(() => [profile('work-a')]) });
  campaignStart(off.store, campaign('off-1', 941));
  await off.tick();
  assert.ok(off.open('off-1'));
  assert.equal(off.open('off-1').account_identity, null, 'without "caam": { "enabled": true } nothing is bound');
  const none = rig(t, CAAM);
  campaignStart(none.store, campaign('off-2', 942));
  await none.tick();
  assert.ok(none.open('off-2'));
  assert.equal(none.open('off-2').account_identity, null, 'without an inventory (cli.mjs supplies none) nothing is bound');
  assert.equal(none.store.all("SELECT detail FROM journal WHERE kind = 'operation-recorded'")[0].detail.account, undefined);
});

// ---- CAAM5 (ACCOUNT_ADAPTER_CAAM.md section 3.5): outcomes land on the run's own profile, also after a restart. ----

const waitRows = (r) => r.store.all("SELECT account, retry_at FROM provider_waits WHERE executor_kind = 'claude-cli' ORDER BY account");
const limits = (r) => r.store.all("SELECT id, value FROM capacity WHERE scope = 'account' ORDER BY id");
/** A replacement controller on the same store, as after a supervisor crash: it takes the leases once they expire. */
function restarted(r, now, profiles) {
  const controller = new Controller({ store: r.store, config: r.env.config, dataDir: r.env.dataDir, fault: null, now, profiles });
  const launched = [];
  controller.launch = async (ctx, op) => { launched.push(op.id); };
  const play = (id, outcome) => {
    const op = r.open(id);
    assert.ok(op, `${id} has an open operation`);
    controller.applyOutcome({ id, generation: controller.held.get(id) }, op, { receipt: { sessionId: op.session_id }, ...outcome });
  };
  return { controller, launched, play };
}

test('a usage limit on profile A waits and throttles A only; the task moves to profile B', async (t) => {
  let clock = Date.now();
  const r = rig(t, CAAM, { now: () => clock, profiles: inventory(() => [profile('work-a'), profile('work-b')]) });
  for (const [i, id] of ['quota-1', 'quota-2', 'quota-3'].entries()) {
    campaignStart(r.store, campaign(id, 961 + i));
    await r.tick();
    clock += 1;
  }
  assert.deepEqual(bound(r), ['claude/work-a', 'claude/work-b', 'claude/work-a'], 'two runs open on A, one on B');

  const resetAt = clock + HOUR;
  r.quota('quota-1', resetAt);
  assert.deepEqual(waitRows(r), [{ account: 'claude/work-a', retry_at: resetAt }], 'the wait is on profile A only');
  assert.equal(accountWait(r.store, r.env.config, 'claude-cli'), null, 'the executor kind as a whole does not wait');
  assert.deepEqual(limits(r), [{ id: 'claude/work-a', value: 1 }], 'half of the two runs open on A; B and the kind keep no limit');
  assert.deepEqual(r.store.all("SELECT detail FROM journal WHERE kind = 'account-concurrency-lowered'").map((row) => [row.detail.account, row.detail.to]),
    [['claude/work-a', 1]]);
  assert.equal(selectProfile(r.store, 'claude-cli', [profile('work-a'), profile('work-b')], clock).account, 'claude/work-b', 'profile B remains available');

  const task = r.store.task('quota-1', 'T1');
  assert.equal(task.state, 'pending');
  assert.equal(task.retry_at, clock, 'the task is due again at once, on another profile');
  assert.match(task.last_error, /^claude\/work-a: quota:/);
  assert.equal(r.store.campaign('quota-1').blocker, null, 'a provider limit is not an owner stop');
  await r.tick();
  assert.equal(r.open('quota-1')?.account_identity, 'claude/work-b', 'the next tick dispatches to profile B');
  assert.equal(r.open('quota-3')?.account_identity, 'claude/work-a', 'the run already open on A keeps running');
});

test('a chain run on a profile leaves no campaign-wide wait for the kind', async (t) => {
  let clock = Date.now();
  const r = rig(t, CAAM, { now: () => clock, profiles: inventory(() => [profile('work-a'), profile('work-b')]) });
  campaignStart(r.store, campaign('chain-1', 971, { executor: chain('claude-cli') }));
  await r.tick();
  assert.equal(r.open('chain-1')?.account_identity, 'claude/work-a');
  r.quota('chain-1', clock + HOUR);
  assert.deepEqual(r.store.all("SELECT * FROM executor_waits WHERE campaign_id = 'chain-1'"), [], 'no campaign row holds every Claude profile');
  assert.deepEqual(waitRows(r), [{ account: 'claude/work-a', retry_at: clock + HOUR }]);
  clock += 1;
  await r.tick();
  assert.equal(r.open('chain-1')?.account_identity, 'claude/work-b');
});

test('a failed login on profile A waits untimed on A, moves the task to B, and a recheck ends it', async (t) => {
  let clock = Date.now();
  const r = rig(t, CAAM, { now: () => clock, profiles: inventory(() => [profile('work-a'), profile('work-b')]) });
  campaignStart(r.store, campaign('auth-1', 981));
  await r.tick();
  r.auth('auth-1');
  assert.deepEqual(waitRows(r), [{ account: 'claude/work-a', retry_at: null }], 'an untimed wait on profile A only');
  assert.equal(r.store.campaign('auth-1').blocker, null, 'profile B still works: no owner stop');
  assert.equal(r.store.all("SELECT * FROM journal WHERE kind = 'profile-fallback'").length, 1);
  clock += 1;
  await r.tick();
  assert.equal(r.open('auth-1')?.account_identity, 'claude/work-b');

  campaignRecheck(r.store, 'auth-1', { note: 'the owner logged profile A in again' });
  clock += 1;
  await r.tick();
  assert.deepEqual(waitRows(r), [], 'the recheck ends the profile wait');
});

test('a success clears the wait of its own profile only', async (t) => {
  let clock = Date.now();
  const r = rig(t, CAAM, { now: () => clock, profiles: inventory(() => [profile('work-a'), profile('work-b')]) });
  for (const [i, id] of ['ok-1', 'ok-2'].entries()) {
    campaignStart(r.store, campaign(id, 991 + i));
    await r.tick();
    clock += 1;
  }
  assert.deepEqual(bound(r), ['claude/work-a', 'claude/work-b']);
  // Both profiles were refused elsewhere while these runs were open.
  profileWait(r, 'claude/work-a', clock + HOUR, 'quota: usage limit', clock);
  profileWait(r, 'claude/work-b', clock + HOUR, 'quota: usage limit', clock);
  r.succeed('ok-1');
  assert.deepEqual(waitRows(r), [{ account: 'claude/work-b', retry_at: clock + HOUR }], 'A works again; B still waits');
  assert.deepEqual(r.store.all("SELECT campaign_id, detail FROM journal WHERE kind = 'provider-wait-cleared' ORDER BY campaign_id").map((row) => [row.campaign_id, row.detail.account]),
    [['ok-1', 'claude/work-a'], ['ok-2', 'claude/work-a']], 'each campaign on the kind journals the cleared wait of A once');
});

test('after a restart an open run keeps its durable profile, without a second operation', async (t) => {
  let clock = Date.now();
  let list = [profile('work-a'), profile('work-b')];
  const r = rig(t, CAAM, { now: () => clock, profiles: inventory(() => list) });
  campaignStart(r.store, campaign('crash-1', 1001));
  await r.tick();
  const before = r.open('crash-1');
  assert.equal(before.account_identity, 'claude/work-a');

  // The supervisor dies without releasing its leases. CAAM now lists only B: a selection now would give B, so only the
  // durable row can attribute the open run to A.
  list = [profile('work-b')];
  clock += r.controller.config.leaseMs + 1;
  const next = restarted(r, () => clock, inventory(() => list));
  await next.controller.tick();
  clock += 1;
  await next.controller.tick();
  assert.deepEqual(r.opened('crash-1').map((op) => [op.id, op.account_identity]), [[before.id, 'claude/work-a']],
    'the replacement reloads the same operation with its exact profile and records no second one');
  assert.deepEqual([...new Set(next.launched)], [before.id], 'only the recorded operation is resumed');

  next.play('crash-1', { class: 'quota', retryAt: clock + HOUR, detail: 'usage limit reached; resets later' });
  assert.deepEqual(waitRows(r), [{ account: 'claude/work-a', retry_at: clock + HOUR }], 'the outcome lands on A from the durable row');
  assert.deepEqual(limits(r), [{ id: 'claude/work-a', value: 1 }]);
  clock += 1;
  await next.controller.tick();
  assert.deepEqual(r.opened('crash-1').map((op) => op.account_identity), ['claude/work-a', 'claude/work-b'], 'one retry, on B');
});
