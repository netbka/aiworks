// 2026-10-29: Wiki package checks (maxRetriesPerTask: 1) stalled after one retry when the worker never started
// (`spawn-failed: runner-process-identity-unavailable`, the runner never attached its job). A launch that never
// started is retried without using one of the task's attempts; the repeat guard still stops one that keeps failing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../../src/supervisor/controller.mjs';
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
