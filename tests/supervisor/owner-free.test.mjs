// AW-017: no stalled or stopped step waits for the owner. Synthetic store and campaign only; no worker runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { mergeRefusal, reportDigestOf } from '../../src/supervisor/result-review.mjs';
import { items } from '../../src/supervisor/work-list.mjs';
import { declaration, environment, skipWithoutSqlite } from './helpers.mjs';

const HEAD = 'a'.repeat(40);
const PASSED = { exit: '0', summary: '# tests 3\n# pass 3\n# fail 0' };
const FAILED = { exit: '1', summary: '# tests 3\n# pass 2\n# fail 1' };

function setup(t) {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); campaignStart(store, d);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
  const ctx = { id: d.campaignId, generation: lease.generation };
  // T1 stalls at the repair limit: the verifier rejected exactly its head and report, with one finding of its own.
  const stall = (gate) => {
    const result = { result: 'resolved', summary: 'done', headSha: HEAD, report: 'synthetic report' };
    const finding = { id: 'F1', severity: 'blocking', description: 'A synthetic defect.' };
    const task = store.task(d.campaignId, 'T1');
    store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, task.version, { state: 'pending', head_sha: HEAD, result, findings: [finding],
      verification: { verdict: 'rejected', targetSha: HEAD, reportDigest: reportDigestOf({ result }), summary: 'rejected', findings: [finding], checks: [], gate },
      blocked: { class: 'stalled', reason: 'verifier still rejects after 2 repair rounds', at: 1000 } }, Date.now());
  };
  return { store, controller, ctx, id: d.campaignId, stall };
}

test('a stalled step whose head passed the full check is delivered with known defects and a follow-up, and may merge', { skip: skipWithoutSqlite }, (t) => {
  const { store, controller, ctx, id, stall } = setup(t);
  stall(PASSED);
  controller.answerSuggested(ctx);
  const task = store.task(id, 'T1');
  assert.equal(task.state, 'verified', 'it goes the normal publication way');
  assert.equal(task.blocked, null);
  assert.equal(task.verified_sha, HEAD);
  assert.deepEqual(task.verification.knownDefects.map((f) => f.id), ['F1'], 'the open findings are recorded as known defects');
  assert.equal(mergeRefusal({ ...task, state: 'done' }), null, 'the merge gate may merge it');
  assert.equal(items(store, { state: 'open' }).filter((item) => item.task_id === 'T1').length, 1, 'one follow-up item');
  controller.answerSuggested(ctx);
  assert.equal(items(store).length, 1, 'nothing is recorded twice');
});

test('a stalled step whose head failed the full check is never merged: it and its dependents end as not done and the campaign finishes', { skip: skipWithoutSqlite }, (t) => {
  const { store, controller, ctx, id, stall } = setup(t);
  stall(FAILED);
  controller.answerSuggested(ctx);
  assert.equal(store.task(id, 'T1').state, 'cancelled');
  assert.match(store.task(id, 'T1').last_error, /^not done:/);
  assert.equal(store.task(id, 'T1').verified_sha, null, 'nothing of it is verified');
  assert.equal(store.task(id, 'T2').state, 'cancelled', 'the step that needs it ends too');
  assert.deepEqual(items(store).map((item) => item.task_id).sort(), ['T1', 'T2'], 'each gets a follow-up item');
  controller.refreshStatus(ctx);
  assert.equal(store.campaign(id).control, 'finished', 'the campaign finishes instead of waiting');
  // The merge gate's own check: a head whose full check failed, or a rejection that is no delivery, never merges.
  const done = { state: 'done', verified_sha: HEAD };
  assert.ok(mergeRefusal({ ...done, verification: { verdict: 'rejected', targetSha: HEAD, gate: FAILED, knownDefects: [] } }));
  assert.ok(mergeRefusal({ ...done, verification: { verdict: 'accepted', targetSha: HEAD, gate: FAILED } }));
  assert.ok(mergeRefusal({ ...done, verification: { verdict: 'rejected', targetSha: HEAD, gate: PASSED } }));
});
