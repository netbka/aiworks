// AIWorks disposable crash/restart rehearsal with real `serve` processes (harness in restart-harness.mjs). Each case kills
// the controller (or the whole host-side process tree) at a mutation boundary and proves the replacement continues
// without an owner "continue", without duplicate dispatch or publication. The publication and multi-operation cases
// are in restart-publish.test.mjs and restart-parallel.test.mjs so the three files run side by side.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { readJsonIfExists } from '../../src/supervisor/proc.mjs';
import { declaration, skipWithoutSqlite } from './helpers.mjs';
import { harness, ops } from './restart-harness.mjs';

test('killed between durable checkpoint and launch: the same operation launches once', { skip: skipWithoutSqlite }, async (t) => {
  const h = await harness(t, {});
  assert.equal(await h.serve({ AIWORKS_FAULT: 'after-record' }).exited, 86);
  assert.deepEqual(ops(h.store, h.id).map((op) => op.state), ['recorded']);
  assert.equal(h.env.calls().length, 0);
  const next = h.serve();
  await h.finished();
  next.kill();
  assert.deepEqual(h.env.calls().map((c) => c.role), ['implement', 'verify']);
  assert.deepEqual(ops(h.store, h.id).map((op) => [op.kind, op.state]), [['implement', 'finished'], ['verify', 'finished']]);
});

test('killed after launching the runner: the replacement adopts the run instead of dispatching again', { skip: skipWithoutSqlite }, async (t) => {
  const h = await harness(t, { scenario: { implement: ['sleep:600:commit'] } });
  assert.equal(await h.serve({ AIWORKS_FAULT: 'after-spawn' }).exited, 86);
  const next = h.serve();
  await h.finished();
  next.kill();
  assert.equal(h.env.calls().filter((c) => c.role === 'implement').length, 1);
});

test('controller killed while the worker runs: the live run is adopted, not duplicated', { skip: skipWithoutSqlite }, async (t) => {
  const h = await harness(t, { scenario: { implement: ['sleep:1500:commit'] } });
  const first = h.serve();
  await h.waitFor(() => h.env.calls().length === 1);
  first.kill();
  await first.exited;
  const second = h.serve();
  await h.finished();
  second.kill();
  assert.equal(h.env.calls().filter((c) => c.role === 'implement').length, 1);
  const takeovers = h.store.all("SELECT detail FROM journal WHERE kind = 'lease-acquired'");
  assert.equal(takeovers.length, 2);
  assert.equal(takeovers[1].detail.generation, 2);
});

test('whole process tree lost (reboot): stale heartbeat is reconciled and a fresh session retries', { skip: skipWithoutSqlite }, async (t) => {
  // The first worker must outlive the owned stop: under load the stop alone took up to 7.2 s, so a 4 s worker could finish
  // first and the stop found nothing running (historical regression). Stop on the runner receipt that carries the job identity.
  const h = await harness(t, { scenario: { implement: ['sleep:30000:commit', 'commit'] } });
  const first = h.serve();
  await h.waitFor(() => h.env.calls().length === 1);
  const op = ops(h.store, h.id)[0];
  const runner = await h.waitFor(() => [readJsonIfExists(join(h.env.dataDir, 'runs', op.id, 'runner.json'))].find((receipt) => receipt?.containment));
  first.kill();
  await first.exited;
  assert.equal(h.stopOwnedRun(runner), 'stopped');
  const second = h.serve();
  await h.finished();
  second.kill();
  const implement = h.env.calls().filter((c) => c.role === 'implement');
  assert.equal(implement.length, 2);
  assert.notEqual(implement[0].sessionId, implement[1].sessionId, 'retry is a fresh session, never a resumed one');
  assert.equal(ops(h.store, h.id)[0].outcome.class, 'lost');
});

test('two controllers running at once never dispatch the same work twice', { skip: skipWithoutSqlite }, async (t) => {
  const h = await harness(t, { decl: declaration() });
  const a = h.serve();
  const b = h.serve();
  await h.finished();
  a.kill();
  b.kill();
  assert.deepEqual(h.env.calls().map((c) => c.role), ['implement', 'verify', 'implement', 'verify']);
  assert.equal(h.env.prs().length, 2);
});
