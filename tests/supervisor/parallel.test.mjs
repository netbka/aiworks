// RUN5 (ADAPTIVE_SCHEDULER slice S4) through the real controller: with config.scheduler.enabled, independent steps of
// one campaign run at the same time once fan-out has grown, conflicting writers never do, two campaigns on one
// repository never write one domain together, two projects share a ceiling of one fairly, and with the switch off
// nothing changes. Workers are played through applyOutcome (launch is stubbed): no spawn, model, network or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { declaration, environment } from './helpers.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const commitTask = (id, issue, extra = {}) => ({ id, issue, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`,
  dependsOn: [], acceptance: [`${id} exists`], references: ['AGENTS.md'], ...extra });

function rig(t, { scheduler = { enabled: true, maxWorkers: 4 } } = {}) {
  const env = environment();
  if (scheduler) env.config.scheduler = scheduler;
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  controller.launch = async () => {}; // the test plays the worker; nothing is spawned
  const register = (campaignId, tasks, { projectId = 'dyk', limits = {} } = {}) => {
    const d = declaration({ campaignId, tasks, limits });
    campaignStart(store, { ...d, target: { ...d.target, projectId } });
  };
  const open = () => store.all("SELECT campaign_id, task_id, kind FROM operations WHERE state IN ('recorded', 'dispatched') ORDER BY created_at")
    .map((op) => `${op.campaign_id}/${op.task_id}:${op.kind}`);
  const ctx = (id) => ({ id, generation: controller.held.get(id) });
  const opOf = (campaignId, taskId) => store.openOperations(campaignId).find((op) => op.task_id === taskId);
  const implement = (campaignId, taskId, file) => {
    const op = opOf(campaignId, taskId);
    mkdirSync(join(op.workspace, file, '..'), { recursive: true });
    writeFileSync(join(op.workspace, file), `${taskId}\n`);
    git(op.workspace, 'add', '-A'); git(op.workspace, 'commit', '-qm', `work for ${taskId}`);
    controller.applyOutcome(ctx(campaignId), op, { class: 'result', receipt: { sessionId: op.session_id },
      value: { result: 'resolved', summary: 'done', headSha: git(op.workspace, 'rev-parse', 'HEAD'), report: '# r' } });
  };
  const verify = (campaignId, taskId) => {
    const op = opOf(campaignId, taskId);
    controller.applyOutcome(ctx(campaignId), op, { class: 'result', receipt: { sessionId: op.session_id },
      value: { verdict: 'accepted', summary: 'checked', targetSha: op.target_sha, findings: [], checks: [{ command: 'npm run check', result: 'pass' }] } });
  };
  const reason = (campaignId, taskId) => controller.waitReasons.get(`${campaignId}/${taskId}`)?.reason ?? null;
  return { env, store, controller, register, open, implement, verify, reason, tick: () => controller.tick() };
}

test('two independent steps of one campaign overlap once fan-out grows; conflicting writers never do', async (t) => {
  const r = rig(t);
  r.register('camp', [commitTask('A', 1, { writes: ['a/'] }), commitTask('B', 2, { writes: ['b/'] }), commitTask('C', 3, { writes: ['a/x/'] })], { limits: { slots: 'auto' } });
  await r.tick();
  assert.deepEqual(r.open(), ['camp/A:implement'], 'fan-out starts at one');
  assert.equal(r.reason('camp', 'B'), 'campaign-fanout');
  r.implement('camp', 'A', 'a/a.txt'); // a useful result while B and C waited: fan-out 2
  await r.tick();
  assert.deepEqual(r.open(), ['camp/A:verify'], 'verify before implement, one launch per tick');
  await r.tick();
  assert.deepEqual(r.open(), ['camp/A:verify', 'camp/B:implement'], 'two independent steps of one campaign run at once');
  r.verify('camp', 'A'); // useful again: fan-out 3
  await r.tick(); // publishes A
  await r.tick();
  assert.equal(r.store.task('camp', 'A').state, 'done');
  assert.ok(!r.open().includes('camp/C:implement'), 'C writes inside a/, which A holds until its PR merges');
  assert.equal(r.reason('camp', 'C'), 'write-domain');
  const kinds = r.store.all("SELECT kind FROM journal WHERE campaign_id = 'camp' AND kind LIKE 'fanout-%'").map((row) => row.kind);
  assert.deepEqual(kinds, ['fanout-raised', 'fanout-raised']);
});

test('two campaigns on one repository never write the same domain together', async (t) => {
  const r = rig(t);
  r.register('wide', [commitTask('W', 11, { writes: ['src/'] })]);
  r.register('narrow', [commitTask('N', 12, { writes: ['src/ui/'] })]);
  await r.tick();
  await r.tick();
  assert.deepEqual(r.open(), ['wide/W:implement']);
  assert.equal(r.reason('narrow', 'N'), 'write-domain');
});

test('two projects share a ceiling of one fairly', async (t) => {
  const r = rig(t, { scheduler: { enabled: true, maxWorkers: 1 } });
  r.register('busy', [commitTask('B1', 21, { writes: ['b1/'] }), commitTask('B2', 22, { writes: ['b2/'] })], { projectId: 'busy', limits: { slots: 'auto' } });
  r.register('quiet', [commitTask('Q1', 23, { writes: ['q1/'] })], { projectId: 'quiet' });
  await r.tick();
  assert.deepEqual(r.open(), ['busy/B1:implement']);
  assert.equal(r.reason('quiet', 'Q1'), 'host-capacity');
  r.implement('busy', 'B1', 'b1/x.txt');
  await r.tick();
  assert.deepEqual(r.open(), ['quiet/Q1:implement'], 'the project not served yet goes before busy\'s verify');
});

test('with the scheduler off a campaign keeps one operation at a time, whatever its slots', async (t) => {
  const r = rig(t, { scheduler: null });
  r.register('camp', [commitTask('A', 31, { writes: ['a/'] }), commitTask('B', 32, { writes: ['b/'] })], { limits: { slots: 4 } });
  await r.tick();
  r.implement('camp', 'A', 'a/a.txt');
  await r.tick();
  await r.tick();
  assert.equal(r.open().length, 1, 'one slot, as before');
  assert.equal(r.store.all("SELECT * FROM capacity").length, 0, 'no fan-out is learned while the scheduler is off');
});
