// A long tick can let a campaign's lease lapse before admission. The candidate whose lease is gone is skipped for that
// pass and nothing is dispatched for it; the next candidate is still admitted, so the core loop never stalls on one
// lost lease (production, 2026-11-13). No model, network or GitHub call: workers are not spawned.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, skipWithoutSqlite, SQLITE } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const { campaignStart } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const { orderCandidates } = SQLITE ? await import('../../src/supervisor/scheduler.mjs') : {};

const task = (id, issue, dir) => ({ id, issue, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`, dependsOn: [],
  acceptance: [`${id} exists`], references: ['AGENTS.md'], writes: [dir] });

test('a candidate whose lease was lost is skipped and the next candidate is still dispatched', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  for (const [campaignId, id, issue, dir] of [['camp-a', 'A', 801, 'a/'], ['camp-b', 'B', 802, 'b/']]) {
    campaignStart(store, declaration({ campaignId, tasks: [task(id, issue, dir)] }));
  }
  let now = Date.now();
  const config = { ...env.config, scheduler: { enabled: true, maxWorkers: 4 } };
  const controller = new Controller({ store, config, dataDir: env.dataDir, now: () => now, fault: null, sampler: { sample: () => null } });
  controller.launch = async () => {}; // records the operation; nothing is spawned
  controller.candidates = [];
  for (const id of ['camp-a', 'camp-b']) await controller.step(id);
  assert.equal(controller.candidates.length, 2, 'both campaigns have an admission candidate');

  // The first candidate in fair order loses its lease to another instance after its step.
  const [first, second] = orderCandidates(store, controller.candidates, config);
  store.releaseLease(first.campaignId, controller.instanceId, controller.held.get(first.campaignId), now);
  assert.ok(store.acquireLease(first.campaignId, 'other-controller', now, config.leaseMs));
  assert.equal(controller.held.has(first.campaignId), true, 'held does not see the lost lease yet');

  await controller.admit();
  assert.deepEqual(store.openOperations(first.campaignId), [], 'nothing is dispatched under a lease that is not held');
  const ops = store.openOperations(second.campaignId);
  assert.equal(ops.length, 1, 'the next candidate is still admitted and dispatched');
  assert.equal(ops[0].task_id, second.taskId);
  assert.equal(controller.held.has(first.campaignId), false, 'the lost lease no longer counts as held');
  assert.equal(store.lease(first.campaignId).instance_id, 'other-controller', 'the fence stays with the new holder');
  controller.release();
});
