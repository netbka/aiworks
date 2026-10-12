// RUN5 (ADAPTIVE_SCHEDULER slice S4), the admission rules as functions over a real store: write domains never overlap,
// fair order across projects, fan-out that grows only on useful results while work waited, one wait reason per step and
// the host ceiling. No model, network or GitHub call; nothing is spawned.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
