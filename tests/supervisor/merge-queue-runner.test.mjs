// The merge queue's default gate (runnerGate in src/supervisor/merge-queue.mjs): gate.mjs run inside the contained
// runner a worker uses. Synthetic gate scripts in a temporary directory stand in for npm run check; no model, network or
// GitHub call. Windows only: the runner needs Job Object containment.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runnerGate } from '../../src/supervisor/merge-queue.mjs';

const skip = process.platform !== 'win32' && 'Windows Job Object containment required';

async function gated(t, script) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-queue-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  process.env.AIWORKS_GATE_SLOTS_DIR = join(dir, 'slots');
  writeFileSync(join(dir, 'gate.mjs'), script);
  const state = { runDir: join(dir, 'run'), cwd: dir, startedAt: Date.now() };
  runnerGate.start({ ...state, heartbeatMs: 500, command: 'node gate.mjs' });
  const limits = { staleMs: 30_000, startGraceMs: 30_000 };
  for (let tries = 0; tries < 240; tries += 1) {
    const out = runnerGate.read(state, { now: Date.now(), ...limits });
    if (out) return out;
    await sleep(250);
  }
  assert.fail('the gate never finished');
}

test('runnerGate: a passing gate reports exit 0 and its final summary', { skip }, async (t) => {
  const out = await gated(t, "console.log('noise'); console.log('# all test files'); console.log('# tests 2'); console.log('# pass 2'); console.log('# fail 0');");
  assert.deepEqual(out, { exit: '0', summary: '# all test files\n# tests 2\n# pass 2\n# fail 0' });
});

test('runnerGate: a failing gate reports its exit code', { skip }, async (t) => {
  const out = await gated(t, "console.log('# tests 1'); console.log('# fail 1'); process.exitCode = 3;");
  assert.equal(out.exit, '3');
  assert.equal(out.summary, '# tests 1\n# fail 1');
});

test('runnerGate: a gate that never started is reported lost after the start grace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-queue-gate-'));
  try {
    const state = { runDir: join(dir, 'missing'), cwd: dir, startedAt: 0 };
    assert.equal(runnerGate.read(state, { now: 10_000, staleMs: 90_000, startGraceMs: 30_000 }), null, 'within the grace');
    assert.deepEqual(runnerGate.read(state, { now: 60_000, staleMs: 90_000, startGraceMs: 30_000 }), { exit: 'lost (no runner)', summary: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
