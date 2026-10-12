// RUN5 (ADAPTIVE_SCHEDULER slice S4) through the real controller: with config.scheduler.enabled, independent steps of
// one campaign run at the same time once fan-out has grown, conflicting writers never do, a step without declared writes
// owns the whole repository, two campaigns on one repository never write one domain together (until the first is merged
// into origin), two projects share a ceiling of one fairly, one synthetic DAG finishes sooner in parallel with the same
// published SHAs, and with the switch off nothing changes. Workers are played through applyOutcome (launch is stubbed)
// on a simulated clock: no spawn, model, network or GitHub call, so these run the same on Windows and Linux.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { declaration, environment } from './helpers.mjs';

// Fixed identity and dates make a commit's SHA depend only on its parent, tree and message (the DAG test compares SHAs).
const FIXED = { GIT_AUTHOR_NAME: 'Fake Worker', GIT_AUTHOR_EMAIL: 'worker@example.invalid', GIT_COMMITTER_NAME: 'Fake Worker',
  GIT_COMMITTER_EMAIL: 'worker@example.invalid', GIT_AUTHOR_DATE: '2026-10-13T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-13T00:00:00Z' };
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...FIXED } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const commitTask = (id, issue, extra = {}) => ({ id, issue, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`,
  dependsOn: [], acceptance: [`${id} exists`], references: ['AGENTS.md'], ...extra });
const STEP_MS = 1000; // simulated time per tick

function rig(t, { scheduler = { enabled: true, maxWorkers: 4 } } = {}) {
  const env = environment();
  if (scheduler) env.config.scheduler = scheduler;
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  let clock = Date.now();
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null, now: () => clock });
  controller.launch = async () => {}; // the test plays the worker; nothing is spawned
  const register = (campaignId, tasks, { projectId = 'dyk', limits = {} } = {}) => {
    const d = declaration({ campaignId, tasks, limits });
    campaignStart(store, { ...d, target: { ...d.target, projectId } });
  };
  const openOps = () => store.all("SELECT * FROM operations WHERE state IN ('recorded', 'dispatched') ORDER BY created_at, id");
  const open = () => openOps().map((op) => `${op.campaign_id}/${op.task_id}:${op.kind}`);
  const ctx = (id) => ({ id, generation: controller.held.get(id) });
  const opOf = (campaignId, taskId) => store.openOperations(campaignId).find((op) => op.task_id === taskId);
  const play = (op) => {
    if (op.kind === 'verify') {
      controller.applyOutcome(ctx(op.campaign_id), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { verdict: 'accepted', summary: 'checked', targetSha: op.target_sha, findings: [], checks: [{ command: 'npm run check', result: 'pass' }] } });
      return;
    }
    const spec = store.campaign(op.campaign_id).declaration.tasks.find((task) => task.id === op.task_id);
    const file = `${spec.writes?.[0] ?? ''}${op.task_id}.txt`;
    mkdirSync(join(op.workspace, file, '..'), { recursive: true });
    writeFileSync(join(op.workspace, file), `${op.task_id}\n`);
    git(op.workspace, 'add', '-A'); git(op.workspace, 'commit', '-qm', `work for ${op.task_id}`);
    controller.applyOutcome(ctx(op.campaign_id), op, { class: 'result', receipt: { sessionId: op.session_id },
      value: { result: 'resolved', summary: 'done', headSha: git(op.workspace, 'rev-parse', 'HEAD'), report: '# r' } });
  };
  const finish = (campaignId, taskId) => play(opOf(campaignId, taskId));
  const reason = (campaignId, taskId) => controller.waitReasons.get(`${campaignId}/${taskId}`)?.reason ?? null;
  const tick = async () => { clock += STEP_MS; await controller.tick(); };
  return { env, store, controller, register, open, openOps, play, finish, reason, tick,
    clock: () => clock, advance: (ms) => { clock += ms; } };
}

test('two independent steps in one campaign overlap; conflicting writers never do', async (t) => {
  const r = rig(t);
  r.register('camp', [commitTask('A', 1, { writes: ['a/'] }), commitTask('B', 2, { writes: ['b/'] }), commitTask('C', 3, { writes: ['a/x/'] })], { limits: { slots: 'auto' } });
  await r.tick();
  assert.deepEqual(r.open(), ['camp/A:implement'], 'fan-out starts at one');
  assert.equal(r.reason('camp', 'B'), 'campaign-fanout');
  r.finish('camp', 'A'); // a useful result while B and C waited: fan-out 2
  await r.tick();
  assert.deepEqual(r.open(), ['camp/A:verify'], 'verify before implement, one launch per tick');
  await r.tick();
  assert.deepEqual(r.open(), ['camp/A:verify', 'camp/B:implement'], 'two independent steps of one campaign run at once');
  r.finish('camp', 'A'); // useful again: fan-out 3
  await r.tick(); // publishes A
  await r.tick();
  assert.equal(r.store.task('camp', 'A').state, 'done');
  assert.ok(!r.open().includes('camp/C:implement'), 'C writes inside a/, which A holds until its PR merges');
  assert.equal(r.reason('camp', 'C'), 'write-domain');
  const kinds = r.store.all("SELECT kind FROM journal WHERE campaign_id = 'camp' AND kind LIKE 'fanout-%'").map((row) => row.kind);
  assert.deepEqual(kinds, ['fanout-raised', 'fanout-raised']);
});

test('a step without declared writes owns the whole repository', async (t) => {
  const r = rig(t);
  r.register('whole', [commitTask('W', 41)]);
  r.register('narrow', [commitTask('N', 42, { writes: ['docs/'] })]);
  await r.tick();
  assert.deepEqual(r.open(), ['whole/W:implement']);
  await r.tick();
  assert.deepEqual(r.open(), ['whole/W:implement'], 'no other writer while the whole repository is held');
  assert.equal(r.reason('narrow', 'N'), 'write-domain');
  r.finish('whole', 'W');
  await r.tick();
  assert.deepEqual(r.open(), ['whole/W:verify'], 'implemented but not integrated: still held; its verifier is read-only');
  assert.equal(r.reason('narrow', 'N'), 'write-domain');
  // And the other way round: an open declared writer keeps a step without writes waiting.
  const s = rig(t);
  s.register('narrow', [commitTask('N', 43, { writes: ['docs/'] })]);
  s.register('whole', [commitTask('W', 44)]);
  await s.tick();
  await s.tick();
  assert.deepEqual(s.open(), ['narrow/N:implement']);
  assert.equal(s.reason('whole', 'W'), 'write-domain');
});

test('two campaigns on one repository never write the same domain together', async (t) => {
  const r = rig(t);
  r.register('wide', [commitTask('W', 11, { writes: ['src/'] })]);
  r.register('narrow', [commitTask('N', 12, { writes: ['src/ui/'] })]);
  const nStarted = () => r.store.all("SELECT id FROM operations WHERE campaign_id = 'narrow' AND kind = 'implement'").length > 0;
  await r.tick();
  await r.tick();
  assert.deepEqual(r.open(), ['wide/W:implement']);
  assert.equal(r.reason('narrow', 'N'), 'write-domain');
  r.finish('wide', 'W');
  await r.tick();
  r.finish('wide', 'W'); // verified
  await r.tick(); // published
  const sha = r.store.task('wide', 'W').verified_sha;
  assert.equal(r.store.task('wide', 'W').state, 'done');
  assert.equal(r.env.remoteHead('campaign/wide/W'), sha, 'published');
  for (let i = 0; i < 3; i++) { r.advance(r.controller.config.integrationPollMs); await r.tick(); }
  assert.equal(nStarted(), false, 'published but not in origin main: the domain stays held');
  assert.equal(r.reason('narrow', 'N'), 'write-domain');
  // The owner merges the PR: the test pushes the verified head to origin main.
  git(r.env.repo, 'push', '-q', 'origin', `${sha}:refs/heads/main`);
  r.advance(r.controller.config.integrationPollMs);
  await r.tick();
  await r.tick();
  assert.deepEqual(r.open(), ['narrow/N:implement'], 'starts once the first change is in origin main');
});

test('two projects progress fairly under a ceiling of one', async (t) => {
  const r = rig(t, { scheduler: { enabled: true, maxWorkers: 1 } });
  const three = (p) => [1, 2, 3].map((n) => commitTask(`${p}${n}`, n, { writes: [`${p}${n}/`] }));
  r.register('busy', three('B'), { projectId: 'busy', limits: { slots: 'auto' } });
  r.register('quiet', three('Q'), { projectId: 'quiet', limits: { slots: 'auto' } });
  const project = (campaignId) => (campaignId === 'busy' ? 'busy' : 'quiet');
  const admissions = [];
  const seen = new Set();
  for (let i = 0; i < 200 && r.store.tasks('busy').concat(r.store.tasks('quiet')).some((task) => task.state !== 'done'); i++) {
    await r.tick();
    const ops = r.openOps();
    assert.ok(ops.length <= 1, 'never above the ceiling');
    for (const op of ops) {
      if (seen.has(op.id)) { r.play(op); continue; }
      seen.add(op.id);
      // Did the other project have a candidate that only this tick's one launch kept waiting? Its domains are disjoint
      // and its provider is free, so after this launch it reads host-capacity (or launch-turn): admissible but for it.
      const other = project(op.campaign_id) === 'busy' ? 'quiet' : 'busy';
      const otherReady = r.controller.candidates.some((c) => c.campaignId === other && ['host-capacity', 'launch-turn'].includes(r.reason(c.campaignId, c.taskId)));
      admissions.push({ project: project(op.campaign_id), otherReady });
    }
  }
  assert.equal(admissions.length, 12, 'three implements and three verifies per project');
  assert.ok(admissions.filter((a) => a.otherReady).length >= 6, 'the other project was usually ready: the order below is a real choice');
  for (let i = 1; i < admissions.length; i++) {
    assert.ok(!(admissions[i].project === admissions[i - 1].project && admissions[i].otherReady),
      `admission ${i} went to ${admissions[i].project} twice in a row while the other project had an admissible step`);
  }
  assert.deepEqual(admissions.slice(0, 2).map((a) => a.project).sort(), ['busy', 'quiet'], 'each project is served before either is served twice');
});

/** Run one synthetic DAG to the end on a simulated clock; every played worker run takes RUN_MS. */
async function runDag(t, scheduler) {
  const RUN_MS = 30_000;
  const r = rig(t, { scheduler });
  r.register('dag', [commitTask('A', 51, { writes: ['a/'] }), commitTask('B', 52, { writes: ['b/'] }),
    commitTask('C', 53, { writes: ['c/'] }), commitTask('D', 54, { writes: ['d/'], dependsOn: ['A'] })], { limits: { slots: 'auto' } });
  const start = r.clock();
  let peak = 0;
  for (let i = 0; i < 1000 && r.store.tasks('dag').some((task) => task.state !== 'done'); i++) {
    await r.tick();
    const ops = r.openOps();
    peak = Math.max(peak, ops.length);
    for (const op of ops) if (r.clock() - op.created_at >= RUN_MS) r.play(op);
  }
  assert.ok(r.store.tasks('dag').every((task) => task.state === 'done'), 'the DAG finished');
  const published = Object.fromEntries(r.store.tasks('dag').map((task) => [task.task_id, { verified: task.verified_sha, remote: r.env.remoteHead(`campaign/dag/${task.task_id}`) }]));
  return { elapsed: r.clock() - start, peak, published, base: git(r.env.repo, 'rev-parse', 'main') };
}

test('a serial and a parallel run of one synthetic DAG publish the same SHAs, the parallel one sooner', async (t) => {
  // Both disposable repositories start from an identical initial commit, so equal work gives equal SHAs.
  const saved = Object.fromEntries(Object.keys(FIXED).map((key) => [key, process.env[key]]));
  Object.assign(process.env, FIXED);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const serial = await runDag(t, null);
  const parallel = await runDag(t, { enabled: true, maxWorkers: 4 });
  assert.equal(parallel.base, serial.base, 'the same initial commit');
  assert.equal(serial.peak, 1, 'with the scheduler off one operation at a time');
  assert.ok(parallel.peak >= 2, 'with it on independent steps overlapped');
  for (const [id, { verified, remote }] of Object.entries(serial.published)) {
    assert.match(verified ?? '', /^[0-9a-f]{40}$/, `${id} has a verified SHA`);
    assert.equal(remote, verified, `${id} was published at its verified SHA`);
  }
  assert.deepEqual(parallel.published, serial.published, 'the same published SHAs');
  assert.ok(parallel.elapsed < serial.elapsed, `parallel ${parallel.elapsed} ms is less than serial ${serial.elapsed} ms`);
});

test('with the scheduler off a campaign keeps one operation at a time, whatever its slots', async (t) => {
  const r = rig(t, { scheduler: null });
  r.register('camp', [commitTask('A', 31, { writes: ['a/'] }), commitTask('B', 32, { writes: ['b/'] })], { limits: { slots: 4 } });
  await r.tick();
  r.finish('camp', 'A');
  await r.tick();
  await r.tick();
  assert.equal(r.open().length, 1, 'one slot, as before');
  assert.equal(r.store.all('SELECT * FROM capacity').length, 0, 'no fan-out is learned while the scheduler is off');
});
