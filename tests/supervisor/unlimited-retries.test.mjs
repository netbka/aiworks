// Owner decision 2026-10-10: no campaign capacity limits by default, retry side (harness in unlimited-harness.mjs):
// without a retry limit a failing task keeps retrying, an amendment releases limit-caused stalls, and the no-progress
// guard still stops a task for an owner decision. Synthetic workers only; no model, network or GitHub access.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declaration, runUntil, skipWithoutSqlite } from './helpers.mjs';
import { api, NONE, setup } from './unlimited-harness.mjs';

test('without a retry limit a failing task keeps retrying instead of stalling', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: NONE });
  // Seven failures, never four identical ones in a row (those stop for the owner, aiworks#136): a different detail resets that count.
  const { env, store, controller, id } = setup(t, { decl, scenario: { implement: ['no-result', 'no-result', 'no-result', 'dirty', 'no-result', 'no-result', 'no-result', 'commit'] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished', { timeoutMs: 120_000 });
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 8);
  assert.equal(store.all("SELECT * FROM journal WHERE kind = 'blocker-raised'").length, 0);
});

test('an amendment that removes the limits releases stalls caused only by those limits', { skip: skipWithoutSqlite }, async (t) => {
  const first = declaration().tasks[0];
  const decl = declaration({ tasks: [first, { ...first, id: 'T2', issue: 438, title: 'second' }],
    limits: { maxWorkerRuns: 12, slots: 1, maxRepairRounds: 1, maxRetriesPerTask: 0 } });
  const { store, controller, id } = setup(t, { decl, scenario: { verify: ['reject', 'reject', 'accept', 'accept'], implement: ['commit', 'commit', 'no-result', 'commit'] } });
  await runUntil(controller, store, id, () => store.tasks(id).every((task) => task.blocked), { timeoutMs: 120_000 });
  assert.match(store.task(id, 'T1').blocked.reason, /verifier still rejects/);
  assert.match(store.task(id, 'T2').blocked.reason, /failed attempts/);
  store.run("UPDATE tasks SET blocked = ? WHERE task_id = 'T2'", { class: 'B3', reason: 'owner-reserved: synthetic', at: Date.now() });
  api.campaignStart(store, { ...decl, authorization: { ...decl.authorization, version: 2 }, limits: NONE });
  assert.equal(store.task(id, 'T1').blocked, null, 'the repair stall is released');
  assert.equal(store.task(id, 'T2').blocked.class, 'B3', 'an owner-reserved block is never released by an amendment');
  assert.ok(store.all("SELECT kind FROM journal WHERE kind = 'stall-released'").length === 1);
  await runUntil(controller, store, id, () => store.task(id, 'T1').state === 'done', { timeoutMs: 120_000 });
});

test('a task that keeps returning evidence-unavailable stops for an owner decision even without limits (historical regression)', { skip: skipWithoutSqlite }, async (t) => {
  const { limits: _omitted, ...decl } = declaration({ tasks: [declaration().tasks[0]] });
  const { env, store, controller, id } = setup(t, { decl, scenario: { implement: ['unavailable', 'unavailable', 'unavailable', 'unavailable', 'commit'] } });
  const blocked = await runUntil(controller, store, id, (c) => c.status === 'blocked-owner-decision', { timeoutMs: 120_000 });
  assert.ok(blocked);
  const task = store.task(id, 'T1');
  assert.equal(task.blocked.class, 'B3');
  assert.match(task.blocked.reason, /no progress: 4 evidence-unavailable results; last: synthetic: no cohort assigned/);
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 4, 'exactly four attempts, then it stops');
  const runs = store.campaign(id).runs_used;
  for (let i = 0; i < 5; i++) await controller.tick();
  assert.equal(store.campaign(id).runs_used, runs, 'no further dispatch while it waits for the owner');
  api.campaignRecheck(store, id, { task: 'T1', note: 'cohort assigned' });
  await runUntil(controller, store, id, (c) => c.control === 'finished', { timeoutMs: 120_000 });
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 5, 'a recheck naming the task resets the count and resumes it');
});

test('four identical non-provider failures in a row hold the task as one owner decision naming the detail (aiworks#136)', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: NONE });
  const same = ['no-result', 'no-result', 'no-result', 'no-result'];
  const { env, store, controller, id } = setup(t, { decl, scenario: { implement: [...same, 'no-result', 'no-result', 'no-result', 'commit'] } });
  await runUntil(controller, store, id, (c) => c.status === 'blocked-owner-decision', { timeoutMs: 120_000 });
  const task = store.task(id, 'T1');
  assert.equal(task.blocked.class, 'B3');
  assert.equal(task.blocked.reason, 'no progress: 4 identical exit-without-result failures; last: normal exit without a structured terminal result');
  assert.equal(task.retry_at, null);
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 4, 'exactly four attempts, then it stops');
  const runs = store.campaign(id).runs_used;
  for (let i = 0; i < 5; i++) await controller.tick();
  assert.equal(store.campaign(id).runs_used, runs, 'no fifth dispatch while it waits for the owner');
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 4);
  assert.equal(store.all("SELECT * FROM outbox WHERE key LIKE '%:T1:blocked:%'").length, 1, 'one visible problem, not one per attempt');
  // A recheck naming the task clears the count: three more identical failures do not hold it again, and it finishes.
  api.campaignRecheck(store, id, { task: 'T1', note: 'reader fixed' });
  await runUntil(controller, store, id, (c) => c.control === 'finished', { timeoutMs: 120_000 });
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 8);
  assert.equal(store.task(id, 'T1').blocked, null);
});

test('a resolved result resets the identical-failure count (aiworks#136)', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: NONE });
  const three = ['no-result', 'no-result', 'no-result'];
  const { env, store, controller, id } = setup(t, { decl, scenario: { implement: [...three, 'commit', ...three, 'commit'], verify: ['reject', 'accept'] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished', { timeoutMs: 120_000 });
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 8, 'six identical failures, split by a resolved result, never hold the task');
  assert.equal(store.all("SELECT * FROM journal WHERE kind = 'blocker-raised'").length, 0);
  assert.equal(store.task(id, 'T1').blocked, null);
});

test('the worker contract routes authorization and owner-decision blockers to blocked-owner-reserved (historical regression)', async () => {
  const { buildPrompt } = await import('../../src/supervisor/adapters/claude.mjs');
  const packet = { goal: 'g', constraints: [], acceptance: ['a'], references: [] };
  const prompt = buildPrompt({ role: 'implementer', deliverable: 'commit', packet, packetDigest: 'd'.repeat(64), repository: 'example-org/sampleapp',
    issue: 1, branch: 'b', baseSha: 'a'.repeat(40), targetSha: null, report: null, reportDigest: null, note: null, instructions: [] });
  assert.match(prompt, /authorization scope or a decision only the owner can make, return blocked-owner-reserved instead/);
});
