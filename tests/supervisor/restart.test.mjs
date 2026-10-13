// AIWorks disposable crash/restart rehearsal with real `serve` processes. Each case kills
// the controller (or the whole host-side process tree) at a mutation boundary and proves the
// replacement continues without an owner "continue", without duplicate dispatch or publication.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readJsonIfExists } from '../../src/supervisor/proc.mjs';
import { declaration, environment, skipWithoutSqlite, sleep, runtimeCheckout } from './helpers.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

/**
 * One more disposable origin and clone for `repository` (a project registered in the test governance), added to the
 * environment's config.json before `serve` reads it. Campaigns on different repositories never share a write domain.
 */
function addRepository(env, repository) {
  const name = repository.split('/')[1];
  const origin = join(env.tmp, `${name}-origin.git`);
  const repo = join(env.tmp, `${name}-repo`);
  git(env.tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(env.tmp, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'Supervisor Test');
  git(repo, 'config', 'user.email', 'supervisor-test@example.invalid');
  writeFileSync(join(repo, 'AGENTS.md'), `# ${name} test repository rules\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  mkdirSync(join(env.tmp, `${name}-worktrees`), { recursive: true });
  env.config.repositories[repository] = { path: repo, worktreeRoot: join(env.tmp, `${name}-worktrees`) };
  writeFileSync(join(env.dataDir, 'config.json'), JSON.stringify(env.config, null, 2));
  return origin;
}

async function harness(t, { scenario, decl, config = {}, repositories = [] }) {
  const { Store } = await import('../../src/supervisor/store.mjs');
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const { stopOwnedRun } = await import('../../src/supervisor/proc.mjs');
  const env = environment({ scenario, config });
  const origins = { 'example-org/sampleapp': env.origin };
  for (const repository of repositories) origins[repository] = addRepository(env, repository);
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = decl ?? declaration({ tasks: [declaration().tasks[0]] });
  campaignStart(store, d);
  // `serve` starts new work only from code merged into origin/main (AW-005): run it from a merged runtime checkout.
  const runtime = runtimeCheckout();
  const children = new Set();
  const serve = (extraEnv = {}) => {
    const child = spawn(process.execPath, ['--no-warnings', runtime.cli, 'serve', '--data', env.dataDir], {
      env: { ...process.env, ...env.env, ...extraEnv }, stdio: 'ignore', windowsHide: true,
    });
    children.add(child);
    child.exited = new Promise((done) => child.on('exit', (code) => { children.delete(child); done(code); }));
    return child;
  };
  // Up to three contained runs (20-30 s each under heavy load, measure-liveness.mjs), a lease takeover and a stale
  // heartbeat must fit; a passing case returns as soon as the predicate holds (historical regression).
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
    runtime.cleanup();
  });
  // The branch head in the origin of `repository`, or null.
  const remoteHead = (repository, branch) => spawnSync('git', ['ls-remote', origins[repository], `refs/heads/${branch}`],
    { encoding: 'utf8', windowsHide: true }).stdout.split(/\s/)[0] || null;
  return { env, store, d, id: d.campaignId, serve, waitFor, finished, stopOwnedRun, remoteHead };
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

// ---- RUN6 (ADAPTIVE_SCHEDULER slice S7): the same guarantees with several open operations and two controllers. ----
// The fake worker commits at the repository root, so each task here declares no `writes` and owns its whole repository
// (ADAPTIVE_SCHEDULER 4.3). Campaigns that may run side by side target different repositories; campaigns on one
// repository share its domain and must take turns.

const PROJECTS = { 'example-org/sampleapp': 'sampleapp', 'example-org/service': 'otp', 'example-org/sample-wiki': 'sample-wiki' };
/** A campaign of one commit task on `repository`. */
const single = (campaignId, issue, repository = 'example-org/sampleapp') => {
  const d = declaration({ campaignId, tasks: [{ id: 'T1', issue, title: `task of ${campaignId}`, deliverable: 'commit',
    goal: `Produce the artifact of ${campaignId}.`, dependsOn: [], acceptance: ['artifact exists'], references: ['AGENTS.md'] }] });
  return { ...d, target: { ...d.target, repository, projectId: PROJECTS[repository] } };
};
const implementCalls = (h) => h.env.calls().filter((c) => c.role === 'implement').length;
const allFinished = (h, ids) => ids.every((id) => h.store.campaign(id).control === 'finished');
const openOperations = (store) => store.all("SELECT id, campaign_id, kind FROM operations WHERE state IN ('recorded', 'dispatched')");
/**
 * The most operations the store ever held open at once. An operation is open from its record (created_at) until its
 * final state (updated_at); one still open counts to the end. At equal times a close comes before an open: admission
 * reads only committed rows, so a slot freed and taken in the same millisecond was never shared.
 */
const peakOpen = (store) => {
  const events = store.all('SELECT state, created_at, updated_at FROM operations').flatMap((op) =>
    [[op.created_at, 1], ...(['recorded', 'dispatched'].includes(op.state) ? [] : [[op.updated_at, -1]])]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0, peak = 0;
  for (const [, delta] of events) peak = Math.max(peak, open += delta);
  return peak;
};

test('killed between two checkpoints: each recorded operation launches once', { skip: skipWithoutSqlite }, async (t) => {
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const work = 'sleep:2000:commit';
  const h = await harness(t, { decl: single('rec-a', 501), config: { scheduler: { enabled: true, maxWorkers: 4 } },
    repositories: ['example-org/service'], scenario: { implement: [work, work] } });
  campaignStart(h.store, single('rec-b', 502, 'example-org/service'));
  // First kill: the first admitted operation is recorded, then the controller dies before launching it.
  assert.equal(await h.serve({ AIWORKS_FAULT: 'after-record' }).exited, 86);
  assert.deepEqual(h.store.all('SELECT state FROM operations').map((op) => op.state), ['recorded']);
  assert.equal(h.env.calls().length, 0);
  // Second kill: the replacement resumes or still holds that operation, admits the other campaign's step, records it and
  // dies before launching it. Resuming records nothing new, so the fault fires only at the second record.
  assert.equal(await h.serve({ AIWORKS_FAULT: 'after-record' }).exited, 86);
  const recorded = h.store.all('SELECT id, campaign_id, kind FROM operations ORDER BY created_at');
  assert.deepEqual(recorded.map((op) => op.kind), ['implement', 'implement'], 'two operations recorded');
  assert.deepEqual(recorded.map((op) => op.campaign_id).sort(), ['rec-a', 'rec-b'], 'one per campaign');
  assert.ok(implementCalls(h) <= 1, 'the operation recorded last never launched');
  const next = h.serve();
  await h.waitFor(() => allFinished(h, ['rec-a', 'rec-b']));
  next.kill();
  assert.equal(implementCalls(h), 2, 'one implement call per task: no recorded operation launched twice or was replaced');
  const implement = h.store.all("SELECT id, outcome FROM operations WHERE kind = 'implement' ORDER BY created_at");
  assert.deepEqual(implement.map((op) => op.id), recorded.map((op) => op.id), 'the recorded operations themselves ran, under their ids');
  for (const op of implement) assert.equal(op.outcome?.class, 'result');
});

test('takeover with three live runs adopts all and dispatches none again', { skip: skipWithoutSqlite }, async (t) => {
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  // A run must outlive the two other launches (up to dispatchWaitMs each under load), the kill and the lease takeover.
  const slow = 'sleep:30000:commit';
  const h = await harness(t, { decl: single('live-a', 511), config: { scheduler: { enabled: true, maxWorkers: 3 } },
    repositories: ['example-org/service', 'example-org/sample-wiki'], scenario: { implement: [slow, slow, slow] } });
  campaignStart(h.store, single('live-b', 512, 'example-org/service'));
  campaignStart(h.store, single('live-c', 513, 'example-org/sample-wiki'));
  const first = h.serve();
  await h.waitFor(() => implementCalls(h) === 3, 180_000);
  first.kill();
  await first.exited;
  const live = openOperations(h.store);
  assert.deepEqual(live.map((op) => op.campaign_id).sort(), ['live-a', 'live-b', 'live-c'], 'three runs open when the controller died');
  const second = h.serve();
  await h.waitFor(() => allFinished(h, ['live-a', 'live-b', 'live-c']), 240_000);
  second.kill();
  assert.equal(implementCalls(h), 3, 'all three adopted; none dispatched again');
  for (const op of live) {
    const implement = h.store.all("SELECT id, outcome FROM operations WHERE campaign_id = ? AND kind = 'implement'", op.campaign_id);
    assert.deepEqual(implement.map((row) => [row.id, row.outcome?.class]), [[op.id, 'result']], `${op.campaign_id}: the adopted run's result was consumed`);
  }
  assert.ok(peakOpen(h.store) <= 3, `never more than the ceiling of three open (saw ${peakOpen(h.store)})`);
});

test('two controllers with parallel admission never exceed the ceiling or share a domain', { skip: skipWithoutSqlite }, async (t) => {
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const work = 'sleep:3000:commit';
  // two-a and two-b both own example-org/sampleapp; two-c and two-d have repositories of their own.
  const h = await harness(t, { decl: single('two-a', 521), config: { scheduler: { enabled: true, maxWorkers: 2 }, integrationPollMs: 1000 },
    repositories: ['example-org/service', 'example-org/sample-wiki'], scenario: { implement: [work, work, work, work] } });
  campaignStart(h.store, single('two-b', 522));
  campaignStart(h.store, single('two-c', 523, 'example-org/service'));
  campaignStart(h.store, single('two-d', 524, 'example-org/sample-wiki'));
  // The owner merges in a clone of their own, never in the checkout the running controllers use.
  const owner = join(h.env.tmp, 'owner-clone');
  git(h.env.tmp, 'clone', '-q', h.env.origin, owner);
  git(owner, 'config', 'user.name', 'Owner');
  git(owner, 'config', 'user.email', 'owner@example.invalid');
  const a = h.serve();
  const b = h.serve();
  let merged = null;
  await h.waitFor(() => {
    // Whichever of two-a and two-b publishes first holds example-org/sampleapp until the owner merges its PR; under load either may.
    const first = ['two-a', 'two-b'].find((id) => h.store.task(id, 'T1').state === 'done');
    if (!merged && first) {
      git(owner, 'fetch', '-q', 'origin', 'main');
      git(owner, 'checkout', '-q', '--detach', 'origin/main');
      git(owner, 'fetch', '-q', 'origin', `campaign/${first}/T1`);
      git(owner, 'merge', '-q', '--no-ff', '-m', `Merge ${first}`, h.store.task(first, 'T1').verified_sha);
      merged = { first, second: first === 'two-a' ? 'two-b' : 'two-a', at: Date.now() };
      git(owner, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    }
    return allFinished(h, ['two-a', 'two-b', 'two-c', 'two-d']);
  }, 300_000);
  a.kill();
  b.kill();
  assert.equal(peakOpen(h.store), 2, 'work ran in parallel up to the ceiling of two, never above it');
  const writers = (id) => h.store.all("SELECT created_at, updated_at FROM operations WHERE campaign_id = ? AND kind = 'implement'", id);
  assert.equal(writers(merged.first).length, 1);
  assert.equal(writers(merged.second).length, 1);
  assert.ok(writers(merged.second)[0].created_at >= writers(merged.first)[0].updated_at, 'example-org/sampleapp was never written by two steps at once');
  assert.ok(writers(merged.second)[0].created_at >= merged.at, `${merged.second} started only after ${merged.first}'s PR was merged`);
  assert.equal(implementCalls(h), 4, 'no step dispatched twice by the two controllers');
  const heads = h.env.prs().map((pr) => pr.head).sort();
  assert.deepEqual(heads, ['two-a', 'two-b', 'two-c', 'two-d'].map((id) => `campaign/${id}/T1`), 'one PR each, none twice');
});

test('killed between push and PR with two tasks publishing: one PR each', { skip: skipWithoutSqlite }, async (t) => {
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const h = await harness(t, { decl: single('pub-a', 531), config: { scheduler: { enabled: true, maxWorkers: 4 } }, repositories: ['example-org/service'] });
  campaignStart(h.store, single('pub-b', 532, 'example-org/service'));
  const repositories = { 'pub-a': 'example-org/sampleapp', 'pub-b': 'example-org/service' };
  assert.equal(await h.serve({ AIWORKS_FAULT: 'after-push' }).exited, 86, 'killed after the first push, before its PR');
  assert.equal(h.env.prs().length, 0);
  const pushed = Object.entries(repositories).filter(([id, repository]) => h.remoteHead(repository, `campaign/${id}/T1`));
  assert.equal(pushed.length, 1, 'one branch pushed without its PR');
  const next = h.serve();
  await h.waitFor(() => allFinished(h, ['pub-a', 'pub-b']));
  next.kill();
  const heads = h.env.prs().map((pr) => pr.head).sort();
  assert.deepEqual(heads, ['campaign/pub-a/T1', 'campaign/pub-b/T1'], 'one PR for each task, none twice');
  for (const [id, repository] of Object.entries(repositories)) {
    assert.equal(h.remoteHead(repository, `campaign/${id}/T1`), h.store.task(id, 'T1').verified_sha, `${id}: the branch carries the verified head`);
  }
});

test('cancelling one campaign stops only its runs and releases domains after containment', { skip: skipWithoutSqlite }, async (t) => {
  const { campaignCancel, campaignStart } = await import('../../src/supervisor/api.mjs');
  // Both first runs must still be live when the cancel lands and while containment stops cut-a's run.
  const slow = 'sleep:30000:commit';
  const h = await harness(t, { decl: single('cut-a', 541), config: { scheduler: { enabled: true, maxWorkers: 3 } },
    repositories: ['example-org/service'], scenario: { implement: [slow, slow, 'commit'] } });
  campaignStart(h.store, single('keep-b', 542, 'example-org/service'));
  const serve = h.serve();
  await h.waitFor(() => implementCalls(h) === 2, 180_000);
  // wait-c shares example-org/sampleapp with cut-a's running step; the ceiling of three has room, so only the domain holds it.
  campaignStart(h.store, single('wait-c', 543));
  await sleep(1000);
  assert.equal(h.store.all("SELECT id FROM operations WHERE campaign_id = 'wait-c'").length, 0, 'wait-c waits for example-org/sampleapp');
  campaignCancel(h.store, 'cut-a', 'rehearsal');
  const cut = await h.waitFor(() => h.store.get("SELECT id, outcome, updated_at FROM operations WHERE campaign_id = 'cut-a' AND state = 'abandoned'"));
  assert.equal(cut.outcome.class, 'cancelled');
  assert.equal(cut.outcome.detail, 'stopped', 'containment confirmed the stop');
  assert.deepEqual(openOperations(h.store).filter((op) => op.campaign_id === 'keep-b').map((op) => op.kind), ['implement'], 'keep-b is still running');
  await h.waitFor(() => allFinished(h, ['keep-b', 'wait-c']), 240_000);
  serve.kill();
  assert.equal(h.store.campaign('cut-a').control, 'cancelled');
  const kept = h.store.all("SELECT state, outcome FROM operations WHERE campaign_id = 'keep-b' AND kind = 'implement'");
  assert.deepEqual(kept.map((op) => [op.state, op.outcome?.class]), [['finished', 'result']], "the other campaign's run was not touched");
  const waited = h.store.get("SELECT created_at FROM operations WHERE campaign_id = 'wait-c' AND kind = 'implement'");
  assert.ok(waited.created_at >= cut.updated_at, 'example-org/sampleapp was admitted again only after containment stopped the cancelled run');
  assert.equal(h.env.prs().filter((pr) => pr.head === 'campaign/cut-a/T1').length, 0, 'the cancelled campaign published nothing');
  assert.equal(h.remoteHead('example-org/sampleapp', 'campaign/cut-a/T1'), null, 'nor pushed its branch');
});
