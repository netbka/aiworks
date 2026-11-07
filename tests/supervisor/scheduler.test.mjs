// RUN5 (ADAPTIVE_SCHEDULER slice S4), the admission rules as functions over a real store: write domains never overlap,
// fair order across projects, fan-out that grows only on useful results while work waited, one wait reason per step and
// the host ceiling; RUN7 (slice S5) adds the host pressure gate. No model, network or GitHub call; nothing is spawned.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { WAIT_REASONS, admissionCheck, hostCeiling } from '../../src/supervisor/scheduler.mjs';
import { declaration } from './helpers.mjs';

const commitTask = (id, issue, extra = {}) => ({ id, issue, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`,
  dependsOn: [], acceptance: [`${id} exists`], references: ['AGENTS.md'], ...extra });

function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-scheduler-'));
  const store = new Store(join(dir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let clock = Date.now();
  const register = (campaignId, tasks, { projectId = 'sampleapp', limits = {} } = {}) => {
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
  const state = (campaignId, taskId, changes) => {
    const task = store.task(campaignId, taskId);
    store.patch('tasks', { campaign_id: campaignId, task_id: taskId }, task.version, changes, clock);
  };
  const candidate = (decl, taskId, kind = 'implement') => ({ campaignId: decl.campaignId, taskId, kind, declaration: decl,
    ord: decl.tasks.findIndex((task) => task.id === taskId), createdAt: store.campaign(decl.campaignId).created_at });
  return { store, register, open, state, candidate, advance: (ms) => { clock += ms; }, now: () => clock };
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
  const floor = { minFreeMemoryBytes: 3 * GiB }; // the memory floor is off by default, so this host sets one
  const sampler = createHostSampler({ os: h.os, fs: h.fs, volumes: ['W:/worktrees'], thresholds: floor });
  const pass = () => {
    const pressure = hostPressure(r.store, sampler, r.now());
    r.advance(5000);
    return admissionCheck(r.store, r.candidate(two, 'B'), { ceiling: 4, pressure });
  };
  assert.equal(pass(), null, 'a calm host admits B');

  h.free = 2 * GiB; // below the 3 GiB floor
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
  const other = createHostSampler({ os: h.os, fs: h.fs, volumes: ['W:/worktrees'], thresholds: floor });
  assert.equal(pass()?.reason, 'host-pressure');
  assert.equal(hostPressure(r.store, other, r.now())?.signal, 'memory');
  assert.equal(r.store.all("SELECT kind FROM journal WHERE kind = 'host-pressure'").length, 2, 'two episodes, two entries');
});
