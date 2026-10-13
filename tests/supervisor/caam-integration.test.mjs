// CAAM6 (docs/design/ACCOUNT_ADAPTER_CAAM.md section 4, slice CAAM6-VERIFY): the validation matrix end to end, through the
// real controller, the real store and the real CAAM discovery adapter (caam.mjs caamRobotStatus) reading a synthetic
// `caam` executable that this file writes into a temporary directory. Two profiles run at once on separate run
// directories and worktrees; selection rotates A, B, A, B; a usage limit on A moves the task to B with one commit and one
// PR; a restarted supervisor keeps the durable profile of an open run; no secret the CAAM inventory or the host carries
// reaches the database, the run directories or the log; and "caam": { "enabled": false } in config.json brings back the
// single-account behaviour. Workers are played through applyOutcome (launch is stubbed) on a simulated clock, so nothing
// is spawned except the synthetic caam and gh scripts and git: no model, network or GitHub call, the same on Windows and
// Linux. Per-profile HOME and USERPROFILE at launch are the CAAM4 launch slice; cli.mjs supplies no inventory yet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { accountWait } from '../../src/supervisor/accounts.mjs';
import { caamRobotStatus } from '../../src/supervisor/adapters/caam.mjs';
import { ISOLATION_ARGS } from '../../src/supervisor/adapters/claude.mjs';
import { declaration, environment } from './helpers.mjs';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
// Secret canaries. The synthetic CAAM prints them next to its profile records, a failing CAAM prints them on stdout and
// stderr, and the host environment carries them as provider credentials. None may be written anywhere by AIWorks.
const TOKEN = 'sk-ant-oat01-CAAMCANARY0123456789abcdefABCDEF';
const REFRESH = 'rt-CAAMCANARY-refresh-9f8e7d6c5b4a';
const EMAIL = 'profile-owner-a@example.invalid';
const LEAKS = [
  new RegExp(TOKEN), new RegExp(REFRESH), new RegExp(EMAIL), /CAAMCANARY/,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}/, /sk-ant-[A-Za-z0-9_-]{12,}/, /gh[pousr]_[A-Za-z0-9]{20,}/, /"(access|refresh|id)_token"/,
];

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

/**
 * A synthetic `caam` CLI. `robot status <provider>` prints CAAM v0.1.23's RobotOutput for the profiles in caam-state.json,
 * with an email, auth paths and tokens the adapter must drop; `fail: true` makes it exit non-zero with the token on
 * stdout and stderr. Every call is logged, so a test can prove AIWorks only ever reads status and never runs `caam run`.
 */
const FAKE_CAAM = `import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
const args = process.argv.slice(3);
appendFileSync(join(dir, 'caam-calls.jsonl'), JSON.stringify(args) + '\\n');
const state = JSON.parse(readFileSync(join(dir, 'caam-state.json'), 'utf8'));
if (state.fail) {
  process.stdout.write('caam: vault unlock failed for token ' + state.token + '\\n');
  process.stderr.write('Authorization: Bearer ' + state.token + '\\n');
  process.exit(3);
}
if (args[0] !== 'robot' || args[1] !== 'status') { process.stderr.write('unsupported in this fake: ' + args.join(' ') + '\\n'); process.exit(64); }
const provider = args[2];
const profiles = (state.profiles[provider] ?? []).map((p) => ({
  name: p.name, active: p.active === true, system: false, plan_type: 'max', email: state.email,
  auth_paths: ['.claude/.credentials.json'], access_token: state.token, refresh_token: state.refresh,
  health: { status: p.health ?? 'healthy', expires_at: state.expiresAt, error_count_1h: 0 },
  cooldown: p.cooldownUntil ? { active: true, until: new Date(p.cooldownUntil).toISOString(), reason: 'rate limited' } : { active: false },
}));
process.stdout.write(JSON.stringify({ success: true, data: { providers: [{ id: provider, profiles }] } }));
`;

const tasksOf = (campaignId, issue) => [{ id: 'T1', issue, title: `${campaignId} task`, deliverable: 'commit', goal: 'Produce it.',
  dependsOn: [], acceptance: ['it exists'], references: ['AGENTS.md'] }];

/**
 * A data directory whose config.json enables CAAM (or not), the synthetic caam executable, and a controller built from
 * that config.json as cli.mjs reads it. `restart()` builds a replacement controller on the same store, as after a
 * supervisor crash: it reads config.json again, so an edited "caam" switch takes effect there.
 */
function rig(t, { caam = true } = {}) {
  const env = environment();
  const caamDir = join(env.tmp, 'caam');
  mkdirSync(caamDir, { recursive: true });
  writeFileSync(join(caamDir, 'fake-caam.mjs'), FAKE_CAAM);
  const command = [process.execPath, join(caamDir, 'fake-caam.mjs'), caamDir];
  let clock = Date.now();
  const caamState = { email: EMAIL, token: TOKEN, refresh: REFRESH, expiresAt: new Date(clock + 30 * DAY).toISOString(), fail: false,
    profiles: { claude: [{ name: 'work-a', active: true }, { name: 'work-b' }] } };
  const setCaam = (patch) => { Object.assign(caamState, patch); writeFileSync(join(caamDir, 'caam-state.json'), JSON.stringify(caamState)); };
  setCaam({});
  const configPath = join(env.dataDir, 'config.json');
  const writeConfig = (patch) => writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, 'utf8')), ...patch }, null, 2));
  writeConfig({ commands: { ...env.config.commands, caam: command }, ...(caam === null ? {} : { caam: { enabled: caam } }) });

  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const logs = [];
  // The inventory a serving supervisor would pass: the real discovery adapter over the configured caam command.
  const inventory = (kind, now) => (kind === 'claude-cli' ? caamRobotStatus({ command, kind, now }).profiles : null);
  const launched = [];
  const build = () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null, now: () => clock, profiles: inventory,
      log: (...line) => logs.push(line.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')) });
    controller.launch = async (ctx, op) => { launched.push(op.id); }; // the test plays the worker; nothing is spawned
    return controller;
  };
  const r = {
    env, store, logs, launched, caamDir, setCaam, writeConfig,
    controller: build(),
    clock: () => clock,
    advance: (ms) => { clock += ms; },
    tick: async () => { clock += 1; await r.controller.tick(); },
    restart: () => { r.controller = build(); return r.controller; },
    register: (campaignId, issue) => campaignStart(store, declaration({ campaignId, tasks: tasksOf(campaignId, issue) })),
    open: (campaignId) => store.openOperations(campaignId)[0] ?? null,
    opened: (campaignId) => store.all('SELECT * FROM operations WHERE campaign_id = ? ORDER BY created_at, rowid', campaignId),
    caamCalls: () => (existsSync(join(caamDir, 'caam-calls.jsonl'))
      ? readFileSync(join(caamDir, 'caam-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    play: (campaignId, outcome) => {
      const op = r.open(campaignId);
      assert.ok(op, `${campaignId} has an open operation`);
      r.controller.applyOutcome({ id: campaignId, generation: r.controller.held.get(campaignId) }, op,
        { receipt: { sessionId: op.session_id }, ...(typeof outcome === 'function' ? outcome(op) : outcome) });
      return op;
    },
    quota: (campaignId, retryAt) => r.play(campaignId, { class: 'quota', retryAt, detail: 'usage limit reached; resets later' }),
    // The implementer commits once and reports; the verifier accepts that exact commit.
    implement: (campaignId) => r.play(campaignId, (op) => {
      assert.equal(op.kind, 'implement');
      writeFileSync(join(op.workspace, `${campaignId}.txt`), `${campaignId}\n`);
      git(op.workspace, 'add', '-A'); git(op.workspace, 'commit', '-qm', `work for ${campaignId}`);
      return { class: 'result', value: { result: 'resolved', summary: 'implemented', headSha: git(op.workspace, 'rev-parse', 'HEAD'), report: '# Report' } };
    }),
    verify: (campaignId) => r.play(campaignId, (op) => {
      assert.equal(op.kind, 'verify');
      return { class: 'result', value: { verdict: 'accepted', summary: 'checked', targetSha: op.target_sha, findings: [],
        checks: [{ command: 'npm run check', result: 'pass' }] } };
    }),
  };
  return r;
}

const bound = (r) => r.store.all("SELECT account_identity FROM operations WHERE executor_kind = 'claude-cli' ORDER BY created_at, rowid").map((op) => op.account_identity);
const waitRows = (r) => r.store.all('SELECT account, executor_kind, retry_at FROM provider_waits ORDER BY account');

/** Implement, verify and publish the open task of `campaignId`; returns the task row once it is done. */
async function deliver(r, campaignId) {
  r.implement(campaignId);
  await r.tick();
  r.verify(campaignId);
  for (let i = 0; i < 5 && r.store.task(campaignId, 'T1').state !== 'done'; i++) await r.tick();
  const task = r.store.task(campaignId, 'T1');
  assert.equal(task.state, 'done', `${campaignId} was published`);
  return task;
}

/** The commits the published task branch adds over main, read from the disposable origin. */
const branchCommits = (r, campaignId) => git(r.env.repo, 'rev-list', '--count', `main..${r.env.remoteHead(`campaign/${campaignId}/T1`)}`, '--');

test('two CAAM profiles run at the same time, each bound durably in its own run directory and worktree', async (t) => {
  const r = rig(t);
  r.register('iso-a', 1101);
  r.register('iso-b', 1102);
  await r.tick();
  const a = r.open('iso-a');
  const b = r.open('iso-b');
  assert.ok(a && b, 'both campaigns have an operation open in the same tick');
  assert.deepEqual([a.account_identity, b.account_identity], ['claude/work-a', 'claude/work-b'], 'two distinct profiles, one per run');
  assert.deepEqual(r.store.all("SELECT account_identity FROM operations WHERE state IN ('recorded', 'dispatched') ORDER BY account_identity")
    .map((op) => op.account_identity), ['claude/work-a', 'claude/work-b'], 'both runs are open at once');
  assert.notEqual(a.run_dir, b.run_dir, 'each run has its own run directory');
  assert.notEqual(a.workspace, b.workspace, 'each run has its own worktree');
  assert.deepEqual([...r.launched].sort(), [a.id, b.id].sort(), 'both are launched');
  assert.deepEqual(r.store.all("SELECT detail FROM journal WHERE kind = 'operation-recorded' ORDER BY seq").map((row) => row.detail.account),
    ['claude/work-a', 'claude/work-b'], 'each run journals its profile');

  // A change in A's worktree is invisible in B's: the runs share no files.
  writeFileSync(join(a.workspace, 'only-in-a.txt'), 'A\n');
  assert.equal(existsSync(join(b.workspace, 'only-in-a.txt')), false);
  assert.equal(git(b.workspace, 'status', '--porcelain'), '', 'B\'s worktree is untouched');

  // Switching profiles keeps AIWorks' isolation flags, and adds no credential or home override of its own to the spec.
  for (const op of [a, b]) {
    const spec = JSON.parse(readFileSync(join(op.run_dir, 'spec.json'), 'utf8'));
    for (let i = 0; i < ISOLATION_ARGS.length; i++) assert.ok(spec.argv.includes(ISOLATION_ARGS[i]), `${op.account_identity}: ${ISOLATION_ARGS[i]} stays`);
    assert.equal(spec.argv[spec.argv.indexOf('--setting-sources') + 1], '', '--setting-sources "" disables user settings and hooks');
    assert.ok(spec.argv.includes('--strict-mcp-config'));
    assert.equal(spec.cwd, op.workspace, 'the worker starts in its own worktree');
    for (const name of Object.keys(spec.env ?? {})) assert.doesNotMatch(name, /TOKEN|API_KEY|SECRET|CREDENTIAL/i, `spec env ${name}`);
  }
  assert.ok(r.caamCalls().length > 0 && r.caamCalls().every((args) => args.join(' ') === 'robot status claude'),
    'AIWorks only reads CAAM status; it never wraps a worker in caam run or activates a profile');
});

test('selection rotates A, B, A, B; skips a profile CAAM cools down; waits for the earliest reset when all cool down', async (t) => {
  const r = rig(t);
  for (const [i, id] of ['rr-1', 'rr-2', 'rr-3', 'rr-4'].entries()) {
    r.register(id, 1201 + i);
    await r.tick();
  }
  assert.deepEqual(bound(r), ['claude/work-a', 'claude/work-b', 'claude/work-a', 'claude/work-b'], 'least recently used first');

  // CAAM reports A cooling down: B takes the next two runs.
  r.setCaam({ profiles: { claude: [{ name: 'work-a', active: true, cooldownUntil: r.clock() + 2 * HOUR }, { name: 'work-b' }] } });
  for (const [i, id] of ['rr-5', 'rr-6'].entries()) {
    r.register(id, 1205 + i);
    await r.tick();
  }
  assert.deepEqual(bound(r).slice(4), ['claude/work-b', 'claude/work-b'], 'the cooling-down profile is skipped');

  // Both cool down: nothing is recorded, no retry is spent, and the task waits for the earlier reset.
  const resetA = r.clock() + 2 * HOUR;
  const resetB = r.clock() + HOUR;
  r.setCaam({ profiles: { claude: [{ name: 'work-a', active: true, cooldownUntil: resetA }, { name: 'work-b', cooldownUntil: resetB }] } });
  r.register('rr-7', 1207);
  await r.tick();
  await r.tick();
  assert.deepEqual(r.opened('rr-7'), [], 'no operation while every profile cools down');
  const task = r.store.task('rr-7', 'T1');
  assert.equal(task.retry_at, resetB, 'the earliest reset among the profiles');
  assert.equal(task.attempts, 0);
  assert.equal(r.store.campaign('rr-7').runs_used, 0);
  assert.equal(r.store.campaign('rr-7').blocker, null, 'a provider cooldown is not an owner stop');

  // B's reset passes and CAAM lists it eligible again: the task runs on B.
  r.setCaam({ profiles: { claude: [{ name: 'work-a', active: true, cooldownUntil: resetA }, { name: 'work-b' }] } });
  r.advance(HOUR);
  await r.tick();
  assert.equal(r.open('rr-7')?.account_identity, 'claude/work-b');
});

test('a usage limit on profile A sends the task to profile B with exactly one commit and one PR', async (t) => {
  const r = rig(t);
  r.register('fail-1', 1301);
  await r.tick();
  const first = r.open('fail-1');
  assert.equal(first.account_identity, 'claude/work-a');
  const resetAt = r.clock() + HOUR;
  r.quota('fail-1', resetAt);

  assert.deepEqual(waitRows(r), [{ account: 'claude/work-a', executor_kind: 'claude-cli', retry_at: resetAt }], 'only profile A waits');
  assert.equal(accountWait(r.store, r.controller.config, 'claude-cli'), null, 'the executor kind as a whole does not wait');
  assert.deepEqual(r.store.all("SELECT * FROM executor_waits WHERE campaign_id = 'fail-1'"), [], 'the campaign keeps no wait for every Claude profile');
  await r.tick();
  const second = r.open('fail-1');
  assert.equal(second?.account_identity, 'claude/work-b', 'the next tick dispatches to profile B');
  assert.notEqual(second.id, first.id);

  const task = await deliver(r, 'fail-1');
  const ops = r.opened('fail-1');
  assert.deepEqual(ops.map((op) => [op.kind, op.account_identity, op.state, op.outcome?.class]), [
    ['implement', 'claude/work-a', 'finished', 'quota'],
    ['implement', 'claude/work-b', 'finished', 'result'],
    ['verify', 'claude/work-b', 'finished', 'result'],
  ], 'one refused run on A, one implementation on B, one verification on B while A still waits');
  assert.equal(r.env.prs().length, 1, 'exactly one PR');
  assert.equal(r.env.prs()[0].head, 'campaign/fail-1/T1');
  assert.equal(branchCommits(r, 'fail-1'), '1', 'exactly one commit on the published branch');
  assert.equal(r.env.remoteHead('campaign/fail-1/T1'), task.verified_sha, 'the published head is the verified commit');
  assert.equal(new Set(ops.map((op) => op.idempotency_key)).size, ops.length, 'no operation was recorded twice');
});

test('after a supervisor crash an open run keeps its durable profile; it finishes once, with one PR', async (t) => {
  const r = rig(t);
  r.register('crash-1', 1401);
  await r.tick();
  const before = r.open('crash-1');
  assert.equal(before.account_identity, 'claude/work-a');

  // The supervisor dies without releasing its leases. CAAM now lists only B, so a fresh selection would give B: only the
  // durable operation row can still say the open run is A's.
  r.setCaam({ profiles: { claude: [{ name: 'work-b' }] } });
  r.advance(r.controller.config.leaseMs + 1);
  r.launched.length = 0;
  r.restart();
  await r.tick();
  await r.tick();
  assert.deepEqual(r.opened('crash-1').map((op) => [op.id, op.account_identity]), [[before.id, 'claude/work-a']],
    'the replacement reloads the same operation with its exact profile and records no second one');
  assert.deepEqual([...new Set(r.launched)], [before.id], 'only the recorded operation is resumed');

  await deliver(r, 'crash-1');
  assert.deepEqual(r.opened('crash-1').map((op) => [op.kind, op.account_identity]),
    [['implement', 'claude/work-a'], ['verify', 'claude/work-b']], 'one implementation, bound to A from the start; the verifier gets B');
  assert.equal(r.env.prs().length, 1, 'exactly one PR');
  assert.equal(branchCommits(r, 'crash-1'), '1', 'exactly one commit');
});

/** Every file under `dir`, recursively. */
const filesUnder = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

test('no CAAM or host secret reaches the database, the run directories or the log', async (t) => {
  // The host carries provider credentials, as an owner's shell may. Restored afterwards; this file runs in its own process.
  const saved = Object.fromEntries(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN'].map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  process.env.ANTHROPIC_API_KEY = TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = `Bearer ${REFRESH}`;
  process.env.GH_TOKEN = 'ghp_CAAMCANARY000000000000000000000000';

  const r = rig(t);
  // Profile A runs, hits its limit, and the task moves to B and is delivered; a second campaign runs on A concurrently.
  r.register('sec-1', 1501);
  r.register('sec-2', 1502);
  await r.tick();
  r.quota('sec-1', r.clock() + HOUR);
  await r.tick();
  await deliver(r, 'sec-1');
  // Then CAAM itself fails and prints the token: the inventory fails closed, and its error is recorded without it.
  r.setCaam({ fail: true });
  r.register('sec-3', 1503);
  await r.tick();
  assert.deepEqual(r.opened('sec-3'), [], 'an unreadable inventory dispatches nothing');
  assert.match(r.store.task('sec-3', 'T1').last_error ?? '', /^waiting for executor availability/);
  assert.ok(r.caamCalls().length > 0);

  // Every row of every table, the raw database files (including the WAL), every run file and the log.
  const tables = r.store.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
  const rows = tables.map((name) => JSON.stringify(r.store.all(`SELECT * FROM "${name}"`))).join('\n');
  assert.ok(rows.includes('claude/work-a') && rows.includes('claude/work-b'), 'the scan reads the rows that name the profiles');
  const files = filesUnder(r.env.dataDir);
  assert.ok(files.some((path) => path.endsWith('spec.json')) && files.some((path) => path.endsWith('prompt.txt')), 'the scan covers run files');
  assert.ok(files.some((path) => path.endsWith('supervisor.db')), 'the scan covers the database file');
  const sources = [['database rows', rows], ['log', r.logs.join('\n')],
    ...files.map((path) => [path, readFileSync(path).toString('latin1')])];
  for (const [where, text] of sources) {
    for (const pattern of LEAKS) assert.doesNotMatch(text, pattern, `${where} must not contain ${pattern}`);
  }
});

test('"caam": { "enabled": false } in config.json falls back to the single-account behaviour without errors', async (t) => {
  const r = rig(t);
  r.register('roll-1', 1601);
  await r.tick();
  const open = r.open('roll-1');
  assert.equal(open.account_identity, 'claude/work-a', 'with the adapter on, the run is bound to a profile');
  const callsOn = r.caamCalls().length;
  assert.ok(callsOn > 0);

  // The owner turns the adapter off in config.json and the supervisor restarts while that run is still open.
  r.writeConfig({ caam: { enabled: false } });
  r.advance(r.controller.config.leaseMs + 1);
  r.restart();
  await r.tick();
  assert.equal(r.open('roll-1')?.id, open.id, 'the open run keeps running: no second operation');
  assert.equal(r.open('roll-1').account_identity, 'claude/work-a', 'its durable binding is kept, not rewritten');
  await deliver(r, 'roll-1');
  assert.equal(r.env.prs().length, 1);

  // New work runs exactly as before the adapter: no profile, no CAAM call, the executor kind's one static account.
  for (const [i, id] of ['roll-2', 'roll-3'].entries()) {
    r.register(id, 1602 + i);
    await r.tick();
    assert.equal(r.open(id)?.account_identity, null, `${id} is not bound to a profile`);
  }
  assert.deepEqual(r.store.all("SELECT detail FROM journal WHERE kind = 'operation-recorded' AND campaign_id IN ('roll-2', 'roll-3')")
    .map((row) => row.detail.account), [undefined, undefined], 'no profile is journalled');
  assert.equal(r.caamCalls().length, callsOn, 'CAAM is not called at all with the adapter off');
  r.quota('roll-2', r.clock() + HOUR);
  assert.deepEqual(waitRows(r).filter((row) => row.account !== 'claude/work-a').map((row) => row.account), ['claude-cli'],
    'a usage limit lands on the single static account, as before the adapter');
  await r.tick();
  assert.equal(r.open('roll-2'), null, 'the single account waits for its reset: no profile to fail over to');
  assert.equal(r.store.campaign('roll-2').blocker, null);
  assert.equal(r.store.get('PRAGMA integrity_check').integrity_check, 'ok', 'the store is not corrupted');

  // Without any "caam" key the adapter is off too.
  const plain = rig(t, { caam: null });
  plain.register('roll-4', 1604);
  await plain.tick();
  assert.equal(plain.open('roll-4')?.account_identity, null);
  assert.deepEqual(plain.caamCalls(), []);

  // Turning it back on, after the static account's reset, resumes selection from the durable history: B, never used,
  // goes first, then A. The waiting roll-2 and the new roll-5 each get one profile.
  r.writeConfig({ caam: { enabled: true } });
  r.advance(HOUR);
  r.restart();
  r.register('roll-5', 1605);
  await r.tick();
  assert.deepEqual(['roll-2', 'roll-5'].map((id) => r.open(id)?.account_identity).sort(), ['claude/work-a', 'claude/work-b']);
});
