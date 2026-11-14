// 2026-10-29: Wiki package checks (maxRetriesPerTask: 1) stalled after one retry when the worker never started
// (`spawn-failed: runner-process-identity-unavailable`, the runner never attached its job). A launch that never
// started is retried without using one of the task's attempts; the repeat guard still stops one that keeps failing.
// Owner decision 2026-10-10: a campaign has no capacity limits by default, so the no-progress guards are the one stop
// for a task that fails the same way forever, and every attempt is a paid worker run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller, NO_PROGRESS_LIMIT } from '../../src/supervisor/controller.mjs';
import { declaration } from './helpers.mjs';

const decl = declaration({ tasks: [declaration().tasks[0]], limits: { maxRetriesPerTask: 1 } });
const controller = Object.assign(Object.create(Controller.prototype), { config: { retryBackoffMs: [1000, 5000] } });
const step = (task, v) => ({ ...task, ...controller.transition({ id: 'c' }, task, { kind: 'implement', executor_kind: 'claude-cli' }, v, decl, 0) });
const notStarted = { class: 'spawn-failed', detail: 'runner-process-identity-unavailable', notStarted: true };

test('a launch that never started is retried without using an attempt; the repeat guard still stops it', () => {
  let task = { task_id: 'T1', state: 'pending', failures: {} };
  for (let i = 1; i <= 3; i++) {
    task = step(task, notStarted);
    assert.equal(task.blocked, undefined, `launch ${i} is retried`);
    assert.equal(task.failures['not-started'], i);
  }
  assert.equal(step(task, notStarted).blocked.class, 'stalled', 'four identical launch failures stop with a reason');
  const started = step({ task_id: 'T1', state: 'pending', failures: { 'not-started': 2 } }, { class: 'timeout', detail: 'x' });
  assert.equal(started.blocked, undefined, 'a real attempt after launch failures is the first attempt');
  assert.equal(step(started, { class: 'timeout', detail: 'y' }).blocked.class, 'stalled', 'the second real failure exceeds maxRetriesPerTask: 1');
  assert.equal(step({ task_id: 'T1', state: 'pending', failures: { timeout: 1 } }, { class: 'spawn-failed', detail: 'containment-helper-failed' }).blocked.class, 'stalled',
    'a launch failure after the worker started still counts');
});

test('launches that never start stop at the bound even when their errors alternate, and a started run clears the count', () => {
  let task = { task_id: 'T1', state: 'pending', failures: {} };
  const details = ['runner-process-identity-unavailable', 'containment-helper-failed'];
  for (let i = 1; i <= 3; i++) {
    task = step(task, { ...notStarted, detail: details[i % 2] });
    assert.equal(task.blocked, undefined, `launch ${i} is retried`);
  }
  const stopped = step(task, { ...notStarted, detail: details[0] });
  assert.equal(stopped.blocked?.class, 'stalled', 'the fourth launch failure in a row stops, whatever its detail');
  assert.match(stopped.blocked.reason, /never started a worker/);
  const cleared = step({ task_id: 'T1', state: 'pending', failures: { 'not-started': 3 } }, { class: 'timeout', detail: 'x' });
  assert.equal(cleared.failures['not-started'], undefined, 'a run that started clears earlier launch failures');
});

test('without limits, repeated evidence-unavailable results or identical failures stop paid attempts for system recovery', () => {
  const unlimited = declaration({ tasks: [declaration().tasks[0]], limits: { maxWorkerRuns: null, slots: 1, maxRepairRounds: null, maxRetriesPerTask: null } });
  // No earlier attempt had the same input, so only the no-progress counters can stop the task.
  const ctl = Object.assign(Object.create(Controller.prototype), { config: { retryBackoffMs: [1000, 5000] }, brokeredAttempts: () => [] });
  const op = { kind: 'implement', executor_kind: 'claude-cli' };
  const outcomes = {
    'evidence-unavailable': { class: 'result', value: { result: 'evidence-unavailable', summary: 'cannot proceed', tried: 'synthetic: nothing assigned' } },
    'identical failure': { class: 'exit-without-result', detail: 'the worker exited without a result' },
  };
  for (const [name, v] of Object.entries(outcomes)) {
    let task = { task_id: 'T1', state: 'pending', failures: {} };
    for (let i = 1; i < NO_PROGRESS_LIMIT; i++) {
      task = { ...task, ...ctl.transition({ id: 'c' }, task, op, v, unlimited, i) };
      assert.equal(task.blocked, undefined, `${name}: attempt ${i} is retried`);
    }
    const stopped = ctl.transition({ id: 'c' }, task, op, v, unlimited, NO_PROGRESS_LIMIT);
    assert.equal(stopped.blocked?.class, 'stalled', name);
    assert.equal(stopped.blocked.recovery, 'system', `${name}: held for system recovery`);
    assert.equal(stopped.retry_at, null, `${name}: no further paid attempt is scheduled`);
  }
});
