// Owner decision 2026-10-10: no campaign capacity limits by default, so the no-progress guard is the one stop for a
// task that fails the same way forever: every attempt is a paid worker run (harness in unlimited-harness.mjs).
// Synthetic workers only; no model, network or GitHub access.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declaration, runUntil, skipWithoutSqlite } from './helpers.mjs';
import { NONE, setup } from './unlimited-harness.mjs';
import { isDecision } from '../../src/supervisor/decisions.mjs';

test('repeated evidence-unavailable stops paid attempts for system recovery even without limits', { skip: skipWithoutSqlite }, async (t) => {
  const { limits: _omitted, ...decl } = declaration({ tasks: [declaration().tasks[0]] });
  const { env, store, controller, id } = setup(t, { decl, scenario: { implement: ['unavailable', 'unavailable', 'unavailable', 'unavailable', 'commit'] } });
  const blocked = await runUntil(controller, store, id, (c) => c.status === 'blocked-child', { timeoutMs: 120_000 });
  assert.ok(blocked);
  const task = store.task(id, 'T1');
  assert.equal(task.blocked.class, 'stalled');
  assert.equal(task.blocked.recovery, 'system');
  assert.equal(isDecision(task), false);
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 4, 'exactly four attempts, then it stops');
  const runs = store.campaign(id).runs_used;
  for (let i = 0; i < 5; i++) await controller.tick();
  assert.equal(store.campaign(id).runs_used, runs, 'no further paid dispatch before recovery');
});

test('four identical non-provider failures hold paid attempts for system recovery', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: NONE });
  const { env, store, controller, id } = setup(t, { decl, scenario: { implement: ['no-result', 'no-result', 'no-result', 'no-result', 'commit'] } });
  await runUntil(controller, store, id, (c) => c.status === 'blocked-child', { timeoutMs: 120_000 });
  const task = store.task(id, 'T1');
  assert.equal(task.blocked.class, 'stalled');
  assert.equal(task.blocked.recovery, 'system');
  assert.equal(isDecision(task), false);
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 4, 'exactly four attempts, then it stops');
  const runs = store.campaign(id).runs_used;
  for (let i = 0; i < 5; i++) await controller.tick();
  assert.equal(store.campaign(id).runs_used, runs, 'no fifth paid dispatch before recovery');
});
