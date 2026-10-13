// RUN5 (ADAPTIVE_SCHEDULER slice S4), the admission rules as functions over a real store: write domains never overlap,
// fair order across projects, fan-out that grows only on useful results while work waited, one wait reason per step and
// the host ceiling; RUN7 (slice S5) adds the host pressure gate. No model, network or GitHub call; nothing is spawned.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { WAIT_REASONS, adjustFanout, admissionCheck, classifyRun, currentFanout, fanoutBound, hostCeiling, orderCandidates, thrashing } from '../../src/supervisor/scheduler.mjs';
import { declaration } from './helpers.mjs';

const commitTask = (id, issue, extra = {}) => ({ id, issue, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`,
  dependsOn: [], acceptance: [`${id} exists`], references: ['AGENTS.md'], ...extra });

function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-scheduler-'));
  const store = new Store(join(dir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let clock = Date.now();
  const register = (campaignId, tasks, { projectId = 'dyk', limits = {} } = {}) => {
    const d = declaration({ campaignId, tasks, limits });
    const decl = { ...d, target: { ...d.target, projectId } };
    campaignStart(store, decl);
    return decl;
  };
  /** Record an open operation as dispatch would, `ago` ms before the rig's clock. */
  const open = (campaignId, taskId, kind = 'implement', ago = 0) => {
    const at = clock - ago, seq = store.all('SELECT id FROM operations WHERE campaign_id = ? AND task_id = ?', campaignId, taskId).length + 1;
    const id = `${campaignId}.${taskId}.${kind}.${seq}`;
    store.run(`INSERT INTO operations (id, campaign_id, task_id, kind, seq, idempotency_key, lease_generation, state, session_id, run_dir,
      workspace, packet, packet_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'dispatched', ?, ?, ?, '{}', 'd', ?, ?)`,
    id, campaignId, taskId, kind, seq, id, `s-${id}`, `r-${id}`, `w-${id}`, at, at);
    return id;
  };
  const finish = (id, outcome) => store.run("UPDATE operations SET state = 'finished', outcome = ?, updated_at = ? WHERE id = ?", outcome, clock, id);
  const state = (campaignId, taskId, changes) => {
    const task = store.task(campaignId, taskId);
    store.patch('tasks', { campaign_id: campaignId, task_id: taskId }, task.version, changes, clock);
  };
  const candidate = (decl, taskId, kind = 'implement') => ({ campaignId: decl.campaignId, taskId, kind, declaration: decl,
    ord: decl.tasks.findIndex((task) => task.id === taskId), createdAt: store.campaign(decl.campaignId).created_at });
  return { store, register, open, finish, state, candidate, advance: (ms) => { clock += ms; }, now: () => clock };
}

test('admission never admits two overlapping write domains, across campaigns and inside one', (t) => {
  const r = rig(t);
  const a = r.register('camp-a', [commitTask('A1', 1, { writes: ['src/dashboard/'] }), commitTask('A2', 2, { writes: ['src/supervisor/'] })], { limits: { slots: 4 } });
  const b = r.register('camp-b', [commitTask('B1', 3, { writes: ['src/dashboard/public/'] }), commitTask('B2', 4, { writes: ['docs/'] })], { limits: { slots: 4 } });
  const c = r.register('camp-c', [commitTask('C1', 5)], { limits: { slots: 4 } });
  r.store.run("INSERT INTO capacity (scope, id, value, reason, updated_at) VALUES ('campaign', 'camp-a', 4, 'test', 0), ('campaign', 'camp-b', 4, 'test', 0)");
  const ctx = { ceiling: 8 };
  r.open('camp-a', 'A1'); r.state('camp-a', 'A1', { state: 'implementing' });
  const busy = admissionCheck(r.store, r.candidate(b, 'B1'), ctx);
  assert.equal(busy?.reason, 'write-domain', 'src/dashboard/public/ is inside src/dashboard/');
  assert.deepEqual(busy.detail.holders.map((h) => `${h.campaignId}/${h.taskId}:${h.reason}`), ['camp-a/A1:writing']);
  assert.equal(admissionCheck(r.store, r.candidate(b, 'B2'), ctx), null, 'docs/ is disjoint: it may run alongside');
  assert.equal(admissionCheck(r.store, r.candidate(a, 'A2'), ctx), null, 'two independent steps of one campaign overlap');
  assert.equal(admissionCheck(r.store, r.candidate(c, 'C1'), ctx)?.reason, 'write-domain', 'a step without declared writes owns the whole repository');
  assert.equal(admissionCheck(r.store, r.candidate(a, 'A1', 'verify'), ctx)?.reason, 'already-running', 'one open operation per task');
});

test('a verifier holds no write domain and is never refused for one', (t) => {
  const r = rig(t);
  const a = r.register('camp-a', [commitTask('A1', 1)]);
  const b = r.register('camp-b', [commitTask('B1', 2)]);
  r.open('camp-a', 'A1'); r.state('camp-a', 'A1', { state: 'implementing' });
  r.state('camp-b', 'B1', { state: 'implemented', head_sha: 'b'.repeat(40) });
  assert.equal(admissionCheck(r.store, r.candidate(b, 'B1', 'verify'), { ceiling: 4 }), null);
  assert.equal(admissionCheck(r.store, r.candidate(a, 'A1'), { ceiling: 4 })?.reason, 'already-running');
});

test('two projects progress fairly under a ceiling of one', (t) => {
  const r = rig(t);
  const dyk = r.register('dyk-busy', [commitTask('D1', 1, { writes: ['a/'] }), commitTask('D2', 2, { writes: ['b/'] }), commitTask('D3', 3, { writes: ['c/'] })], { projectId: 'dyk', limits: { slots: 'auto' } });
  const aiw = r.register('aiw-quiet', [commitTask('Q1', 4, { writes: ['q/'] })], { projectId: 'aiworks' });
  const served = [];
  // Round by round: admit the first admissible candidate under a ceiling of one, run it to the end, then the next round.
  for (let round = 0; round < 4; round++) {
    const pending = (decl) => decl.tasks.filter((task) => r.store.task(decl.campaignId, task.id).state === 'pending').map((task) => r.candidate(decl, task.id));
    const ordered = orderCandidates(r.store, [...pending(dyk), ...pending(aiw)]);
    const next = ordered.find((c) => !admissionCheck(r.store, c, { ceiling: 1 }));
    if (!next) break;
    served.push(next.declaration.target.projectId);
    const op = r.open(next.campaignId, next.taskId);
    r.finish(op, { class: 'result', value: { result: 'resolved' } });
    r.state(next.campaignId, next.taskId, { state: 'done' });
    r.advance(1000);
  }
  assert.deepEqual(served.slice(0, 2).sort(), ['aiworks', 'dyk'], 'each project is served once before either is served twice');
  assert.equal(served.filter((p) => p === 'aiworks').length, 1);
});

test('within a campaign, verify comes before implement, then declaration order; never-served projects first', (t) => {
  const r = rig(t);
  const old = r.register('old', [commitTask('O1', 1, { writes: ['o/'] }), commitTask('O2', 2, { writes: ['p/'] })], { projectId: 'old' });
  const fresh = r.register('fresh', [commitTask('F1', 3)], { projectId: 'fresh' });
  r.finish(r.open('old', 'O1', 'implement', 5000), { class: 'result', value: { result: 'resolved' } });
  const order = orderCandidates(r.store, [r.candidate(old, 'O2'), r.candidate(old, 'O1', 'verify'), r.candidate(fresh, 'F1')]);
  assert.deepEqual(order.map((c) => `${c.taskId}:${c.kind}`), ['F1:implement', 'O1:verify', 'O2:implement']);
});

test('fan-out grows only after useful results while work waited, and shrinks on failures and thrash', (t) => {
  const r = rig(t);
  const auto = r.register('auto', [commitTask('A1', 1)], { limits: { slots: 'auto' } });
  const bound = fanoutBound(auto, 3);
  assert.equal(bound, 3, '"auto" is bounded by the host ceiling');
  assert.equal(fanoutBound(r.register('two', [commitTask('T1', 2)], { limits: { slots: 2 } }), 3), 2, 'a declared number is the owner\'s own maximum');
  const now = r.now();
  assert.equal(currentFanout(r.store, 'auto', bound), 1, 'starts at one');
  assert.equal(adjustFanout(r.store, { campaignId: 'auto', bound, run: 'useful', waited: false, now }), 1, 'no growth without waiting work');
  assert.equal(adjustFanout(r.store, { campaignId: 'auto', bound, run: 'useful', waited: true, now }), 2);
  assert.equal(adjustFanout(r.store, { campaignId: 'auto', bound, run: 'useful', waited: true, now }), 3);
  assert.equal(adjustFanout(r.store, { campaignId: 'auto', bound, run: 'useful', waited: true, now }), 3, 'never above the bound');
  assert.equal(adjustFanout(r.store, { campaignId: 'auto', bound, run: 'failed', now }), 2, 'a failed run lowers it by one');
  assert.equal(adjustFanout(r.store, { campaignId: 'auto', bound, run: 'neutral', waited: true, now }), 2, 'a refunded or neutral run changes nothing');
  assert.equal(adjustFanout(r.store, { campaignId: 'auto', bound, run: 'failed', thrash: true, now }), 1, 'thrash drops it to one');
  const journal = r.store.all("SELECT kind FROM journal WHERE campaign_id = 'auto' AND kind LIKE 'fanout-%' ORDER BY seq").map((row) => row.kind);
  assert.deepEqual(journal, ['fanout-raised', 'fanout-raised', 'fanout-lowered', 'fanout-lowered']);

  assert.equal(classifyRun('implement', { class: 'result', value: { result: 'resolved' } }), 'useful');
  assert.equal(classifyRun('verify', { class: 'result', value: { verdict: 'rejected', findings: [{ severity: 'blocking' }] } }), 'useful', 'a rejection that found a real problem is useful');
  assert.equal(classifyRun('verify', { class: 'result', value: { verdict: 'evidence-unavailable' } }), 'failed');
  for (const cls of ['lost', 'timeout', 'exit-without-result', 'invalid-result', 'spawn-failed', 'error']) assert.equal(classifyRun('implement', { class: cls }), 'failed', cls);
  assert.equal(classifyRun('implement', { class: 'unavailable' }), 'neutral', 'a refunded run is neither');

  const f1 = r.open('auto', 'A1'); r.finish(f1, { class: 'timeout' });
  assert.equal(thrashing(r.store, 'auto', r.now(), 60_000), false);
  const f2 = r.open('auto', 'A1'); r.finish(f2, { class: 'lost' });
  assert.equal(thrashing(r.store, 'auto', r.now(), 60_000), true, 'two failed runs within one window');
});

test('every waiting step has exactly one reason, the first that applies', (t) => {
  const r = rig(t);
  const a = r.register('camp-a', [commitTask('A1', 1, { writes: ['x/'] }), commitTask('A2', 2, { writes: ['x/y/'] })]);
  r.open('camp-a', 'A1'); r.state('camp-a', 'A1', { state: 'implementing' });
  // A2 is refused by fan-out (one slot), host capacity (ceiling 1), pressure, its domain and a cooling provider at once:
  const all = { ceiling: 1, pressure: { memory: 'low' }, providerWaiting: () => true };
  const reason = admissionCheck(r.store, r.candidate(a, 'A2'), all);
  assert.equal(reason.reason, 'campaign-fanout');
  assert.ok(WAIT_REASONS.includes(reason.reason));
  r.store.run("INSERT INTO capacity (scope, id, value, reason, updated_at) VALUES ('campaign', 'camp-a', 4, 'test', 0)");
  assert.equal(admissionCheck(r.store, r.candidate(a, 'A2'), { ...all, ceiling: 1 }).reason, 'campaign-fanout', 'slots 1 bounds the learned value');
  const wide = r.register('wide', [commitTask('W1', 3, { writes: ['w/'] }), commitTask('W2', 4, { writes: ['w/z/'] })], { limits: { slots: 4 } });
  r.store.run("INSERT INTO capacity (scope, id, value, reason, updated_at) VALUES ('campaign', 'wide', 4, 'test', 0)");
  r.open('wide', 'W1'); r.state('wide', 'W1', { state: 'implementing' });
  assert.equal(admissionCheck(r.store, r.candidate(wide, 'W2'), all).reason, 'host-capacity');
  assert.equal(admissionCheck(r.store, r.candidate(wide, 'W2'), { ...all, ceiling: 8 }).reason, 'host-pressure');
  assert.equal(admissionCheck(r.store, r.candidate(wide, 'W2'), { ...all, ceiling: 8, pressure: null }).reason, 'write-domain');
  const free = r.register('free', [commitTask('F1', 5, { writes: ['f/'] })], { projectId: 'other' });
  assert.equal(admissionCheck(r.store, r.candidate(free, 'F1'), { ...all, ceiling: 8, pressure: null }).reason, 'provider-cooldown');
  assert.equal(admissionCheck(r.store, r.candidate(free, 'F1'), { ceiling: 8 }), null);
});

test('the host ceiling is the configured number or a quarter of the cores, between one and four', () => {
  assert.equal(hostCeiling({ scheduler: { maxWorkers: 6 } }), 6);
  assert.equal(hostCeiling({ scheduler: { maxWorkers: 0 } }, 20), 4, 'an invalid value falls back to the default');
  assert.equal(hostCeiling({}, 2), 1);
  assert.equal(hostCeiling({}, 8), 2);
  assert.equal(hostCeiling({}, 64), 4);
});

// ---- RUN7 (ADAPTIVE_SCHEDULER slice S5): host pressure stops new admission; running work continues. The host is a
// synthetic os/fs; host.mjs and hostPressure are imported per test, so each test fails on its own where they are absent.

const GiB = 1024 ** 3;
/** A synthetic host: memory, CPU times and free disk the test sets; nothing reads the real machine. */
function fakeHost({ total = 32 * GiB } = {}) {
  const h = { free: 16 * GiB, busy: 0, idle: 0, disk: { 'W:/worktrees': 100 * GiB } };
  h.os = { freemem: () => h.free, totalmem: () => total, cpus: () => [{ times: { user: h.busy, nice: 0, sys: 0, idle: h.idle, irq: 0 } }] };
  h.fs = { statfsSync: (volume) => {
    if (!(volume in h.disk)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { bavail: h.disk[volume] / 4096, bsize: 4096 };
  } };
  return h;
}

test('host pressure stops new admission and leaves running work alone', async (t) => {
  const { createHostSampler } = await import('../../src/supervisor/host.mjs');
  const { hostPressure } = await import('../../src/supervisor/scheduler.mjs');
  const r = rig(t);
  const one = r.register('one', [commitTask('A', 1, { writes: ['a/'] })]);
  const two = r.register('two', [commitTask('B', 2, { writes: ['b/'] })], { projectId: 'other' });
  const running = r.open('one', 'A'); r.state('one', 'A', { state: 'implementing' });
  const before = r.store.get('SELECT * FROM operations WHERE id = ?', running);
  const h = fakeHost();
  const sampler = createHostSampler({ os: h.os, fs: h.fs, volumes: ['W:/worktrees'] });
  const pass = () => {
    const pressure = hostPressure(r.store, sampler, r.now());
    r.advance(5000);
    return admissionCheck(r.store, r.candidate(two, 'B'), { ceiling: 4, pressure });
  };
  assert.equal(pass(), null, 'a calm host admits B');

  h.free = 2 * GiB; // below max(2 GiB, 10% of 32 GiB)
  const refused = pass();
  assert.equal(refused?.reason, 'host-pressure', 'an injected low-memory sample refuses new admission');
  assert.equal(refused.detail.signal, 'memory');
  assert.equal(pass()?.reason, 'host-pressure', 'and keeps refusing while it lasts');
  assert.deepEqual(r.store.get('SELECT * FROM operations WHERE id = ?', running), before, 'the running operation is untouched');
  assert.deepEqual(r.store.all("SELECT task_id, state FROM operations WHERE state IN ('recorded', 'dispatched')"), [{ task_id: 'A', state: 'dispatched' }]);
  assert.equal(r.store.task('one', 'A').state, 'implementing');
  assert.equal(admissionCheck(r.store, r.candidate(one, 'A'), { ceiling: 4, pressure: refused.detail })?.reason, 'already-running',
    'a running step keeps its own reason; pressure never reclassifies it');

  h.free = 16 * GiB;
  assert.equal(pass(), null, 'admission resumes when the pressure clears');
  const journal = r.store.all("SELECT campaign_id, kind, detail FROM journal WHERE kind LIKE 'host-pressure%' ORDER BY seq");
  assert.deepEqual(journal.map((row) => row.kind), ['host-pressure', 'host-pressure-cleared'], 'journalled once per episode, and its end once');
  assert.equal(journal[0].campaign_id, null, 'a host fact, not one campaign\'s');
  assert.equal(journal[0].detail.signal, 'memory');
  assert.equal(journal[1].detail.signal, 'memory');

  // A second episode, seen by two controllers on one store: each samples, the episode is journalled once.
  h.free = 1 * GiB;
  const other = createHostSampler({ os: h.os, fs: h.fs, volumes: ['W:/worktrees'] });
  assert.equal(pass()?.reason, 'host-pressure');
  assert.equal(hostPressure(r.store, other, r.now())?.signal, 'memory');
  assert.equal(r.store.all("SELECT kind FROM journal WHERE kind = 'host-pressure'").length, 2, 'two episodes, two entries');
});

test('the host sampler reports memory, CPU over a full window, disk on every volume and late heartbeats, in that order', async () => {
  const { createHostSampler, PRESSURE_SIGNALS, PRESSURE_DEFAULTS } = await import('../../src/supervisor/host.mjs');
  assert.deepEqual(PRESSURE_SIGNALS, ['memory', 'cpu', 'disk', 'heartbeats']);
  assert.equal(PRESSURE_DEFAULTS.minFreeMemoryBytes, 2 * GiB);
  const h = fakeHost();
  h.disk['V:/other'] = 100 * GiB;
  const host = createHostSampler({ os: h.os, fs: h.fs, volumes: ['W:/worktrees', 'X:/unmounted', 'V:/other'], heartbeatMs: 10_000, staleMs: 90_000 });
  assert.equal(host.sample({ now: 0 }), null, 'a calm host');

  h.free = 3 * GiB; // above 2 GiB but below 10% of 32 GiB
  assert.equal(host.sample({ now: 1 })?.signal, 'memory', 'the floor is the larger of 2 GiB and 10% of total memory');
  h.free = 16 * GiB;

  h.busy = 95; h.idle = 5;
  assert.equal(host.sample({ now: 30_000 }), null, 'CPU is judged only over a full window');
  assert.equal(host.sample({ now: 60_000 })?.signal, 'cpu', '95% busy over 60 s');
  h.busy = 100; h.idle = 1000;
  assert.equal(host.sample({ now: 120_000 }), null, 'a mostly idle next window clears it');
  h.busy = 10_000;
  assert.equal(host.sample({ now: 500_000 }), null, 'a window far longer than a minute says nothing about the last minute');

  h.disk['V:/other'] = 4 * GiB;
  assert.deepEqual(host.sample({ now: 500_001 }), { signal: 'disk', detail: { volume: 'V:/other', freeBytes: 4 * GiB } },
    'any worktree volume below 5 GiB; an unreadable one gives no signal');
  h.disk['V:/other'] = 100 * GiB;

  assert.equal(host.sample({ now: 600_000, beats: [600_000 - 35_000] })?.signal, 'heartbeats', 'older than three intervals');
  assert.equal(host.sample({ now: 600_000, beats: [600_000 - 95_000] }), null, 'a stale run is the controller\'s to reconcile, not pressure');
  assert.equal(host.sample({ now: 600_000, beats: [600_000 - 5_000, 0, Number.NaN] }), null, 'on time, or no beat yet');

  h.free = 1 * GiB; h.disk['W:/worktrees'] = 1;
  assert.equal(host.sample({ now: 600_001, beats: [600_000 - 35_000] })?.signal, 'memory', 'the first signal that applies');
});

test('pressure thresholds come from config.scheduler.pressure; invalid values keep the defaults', async () => {
  const { hostSamplerFor, pressureThresholds, PRESSURE_DEFAULTS } = await import('../../src/supervisor/host.mjs');
  assert.deepEqual(pressureThresholds(undefined), PRESSURE_DEFAULTS);
  assert.deepEqual(pressureThresholds({ minFreeDiskBytes: 'lots', maxCpuBusy: -1, lateHeartbeats: Infinity, cpuWindowMs: 0 }), PRESSURE_DEFAULTS);
  const h = fakeHost();
  h.disk['D:/wt'] = 8 * GiB;
  const config = { heartbeatMs: 100, staleMs: 5000, scheduler: { pressure: { minFreeDiskBytes: 10 * GiB, lateHeartbeats: 5 } },
    repositories: { 'o/a': { path: 'D:/a', worktreeRoot: 'D:/wt' }, 'o/b': { path: 'D:/b', worktreeRoot: 'D:/wt' }, 'o/c': { path: 'D:/c' } } };
  const host = hostSamplerFor(config, { os: h.os, fs: h.fs });
  assert.equal(host.limits.minFreeDiskBytes, 10 * GiB);
  assert.equal(host.sample({ now: 0 })?.signal, 'disk', 'the configured worktree volume, against the configured floor');
  h.disk['D:/wt'] = 100 * GiB;
  assert.equal(host.sample({ now: 1000, beats: [1000 - 450] }), null, 'five intervals of the configured heartbeat, not three');
  assert.equal(host.sample({ now: 1000, beats: [1000 - 600] })?.signal, 'heartbeats');
});

test('open run heartbeats are read for worker and coordinator runs only while they are open', async (t) => {
  const { openRunBeats } = await import('../../src/supervisor/host.mjs');
  const r = rig(t);
  r.register('one', [commitTask('A', 1), commitTask('B', 2)]);
  const dirs = mkdtempSync(join(tmpdir(), 'aiworks-beats-'));
  t.after(() => rmSync(dirs, { recursive: true, force: true }));
  const runDir = (name, beat) => {
    const dir = join(dirs, name);
    mkdirSync(dir);
    if (beat !== undefined) writeFileSync(join(dir, 'heartbeat'), String(beat));
    return dir;
  };
  const open = r.open('one', 'A');
  r.store.run('UPDATE operations SET run_dir = ? WHERE id = ?', runDir('open', 1111), open);
  const done = r.open('one', 'B');
  r.store.run('UPDATE operations SET run_dir = ? WHERE id = ?', runDir('done', 2222), done);
  r.finish(done, { class: 'result', value: { result: 'resolved' } });
  const fresh = r.open('one', 'B');
  r.store.run('UPDATE operations SET run_dir = ? WHERE id = ?', runDir('fresh'), fresh);
  for (const [id, state, beat] of [['c1', 'dispatched', 3333], ['c2', 'finished', 4444]]) {
    r.store.insert('coordinator_runs', { id, state, session_id: id, run_dir: runDir(id, beat), workspace: dirs, message_ids: [], created_at: 0, updated_at: 0 });
  }
  assert.deepEqual(openRunBeats(r.store).sort(), [1111, 3333], 'a finished run is not read; a run without a beat yet is left out');
});
