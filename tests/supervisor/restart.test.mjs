// AIWorks disposable crash/restart rehearsal with real `serve` processes. Each case kills
// the controller (or the whole host-side process tree) at a mutation boundary and proves the
// replacement continues without an owner "continue", without duplicate dispatch or publication.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { readJsonIfExists } from '../../src/supervisor/proc.mjs';
import { CLI, declaration, environment, skipWithoutSqlite, sleep } from './helpers.mjs';

async function harness(t, { scenario, decl }) {
  const { Store } = await import('../../src/supervisor/store.mjs');
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const { stopOwnedRun } = await import('../../src/supervisor/proc.mjs');
  const env = environment({ scenario });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = decl ?? declaration({ tasks: [declaration().tasks[0]] });
  campaignStart(store, d);
  const children = new Set();
  const serve = (extraEnv = {}) => {
    const child = spawn(process.execPath, ['--no-warnings', CLI, 'serve', '--data', env.dataDir], {
      env: { ...process.env, ...env.env, ...extraEnv }, stdio: 'ignore', windowsHide: true,
    });
    children.add(child);
    child.exited = new Promise((done) => child.on('exit', (code) => { children.delete(child); done(code); }));
    return child;
  };
  // Up to three contained runs (20-30 s each under heavy load, measure-liveness.mjs), a lease takeover and a stale
  // heartbeat must fit; a passing case returns as soon as the predicate holds (engineering-platform-archive#58).
  const waitFor = async (predicate, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`timed out: ${JSON.stringify(store.campaign(d.campaignId))} ${JSON.stringify(store.tasks(d.campaignId))}`);
  };
  const finished = () => waitFor(() => store.campaign(d.campaignId).control === 'finished');
  t.after(async () => {
    for (const child of children) child.kill();
    await sleep(200);
    store.close();
    env.cleanup();
  });
  return { env, store, d, id: d.campaignId, serve, waitFor, finished, stopOwnedRun };
}

const ops = (store, id) => store.all('SELECT id, kind, state, outcome FROM operations WHERE campaign_id = ? ORDER BY created_at', id);

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
  // first and the stop found nothing running (engineering-platform-archive#58). Stop on the runner receipt that carries the job identity.
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

test('killed between push and PR creation: exactly one PR at the verified SHA', { skip: skipWithoutSqlite }, async (t) => {
  const h = await harness(t, {});
  assert.equal(await h.serve({ AIWORKS_FAULT: 'after-push' }).exited, 86);
  const next = h.serve();
  await h.finished();
  next.kill();
  const prs = h.env.prs();
  assert.equal(prs.length, 1);
  const task = h.store.task(h.id, 'T1');
  assert.equal(h.env.remoteHead(`campaign/${h.id}/T1`), task.verified_sha);
});

test('killed after posting a verified report: the replacement reconciles and does not repost', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [{ id: 'R1', issue: 437, title: 'research', deliverable: 'report', goal: 'Research only.', dependsOn: [], acceptance: ['posted'], references: ['AGENTS.md'] }] });
  const h = await harness(t, { decl, scenario: { implement: ['report'] } });
  assert.equal(await h.serve({ AIWORKS_FAULT: 'after-report-post' }).exited, 86);
  const next = h.serve();
  await h.finished();
  next.kill();
  assert.equal(h.env.comments().filter((c) => c.issue === '437').length, 1);
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
