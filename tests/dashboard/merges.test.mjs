// Merged state from local git only (AIWorks): a step is merged when its verified commit is reachable from
// origin/<base> in the configured checkout; the base branch is fetched at most once per repository every 5 minutes,
// one repository at a time; a failed fetch keeps the last state and shows its age; and no dashboard code path runs
// gh or calls the GitHub API. Disposable git repositories, a synthetic git wrapper and a synthetic gh only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { declaration, GOVERNANCE } from '../supervisor/helpers.mjs';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { configuredCheckouts, configuredGitCommand, FETCH_INTERVAL_MS, MergeWatcher, publishedSteps } from '../../src/dashboard/merges.mjs';
import { MERGE_FRESH_MS, ownerView } from '../../src/dashboard/owner.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const MERGED_AT = 1_791_000_000;
const git = (cwd, args, env = {}) => {
  const out = spawnSync('git', ['-c', 'user.name=Dashboard Test', '-c', 'user.email=dashboard-test@example.invalid', ...args],
    { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};

/**
 * A disposable origin, the configured checkout (cloned before anything is merged) and a second clone standing in for
 * GitHub's side: T1's commit is merged into main there, T2's is pushed on a branch that is never merged.
 */
function repositories(t, name = 'sampleapp') {
  const tmp = mkdtempSync(join(tmpdir(), 'aiworks-merges-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const origin = join(tmp, `${name}.git`), checkout = join(tmp, 'checkout'), remote = join(tmp, 'remote');
  git(tmp, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(tmp, ['init', '-q', '-b', 'main', remote]);
  git(remote, ['commit', '-q', '--allow-empty', '-m', 'initial']);
  git(remote, ['remote', 'add', 'origin', origin]);
  git(remote, ['push', '-q', 'origin', 'main']);
  git(tmp, ['clone', '-q', origin, checkout]);
  git(remote, ['checkout', '-q', '-b', 'step-1']);
  git(remote, ['commit', '-q', '--allow-empty', '-m', 'step 1']);
  const merged = git(remote, ['rev-parse', 'HEAD']);
  git(remote, ['push', '-q', 'origin', 'step-1']);
  git(remote, ['checkout', '-q', 'main']);
  git(remote, ['merge', '-q', '--no-ff', 'step-1', '-m', 'Merge pull request #463'], { GIT_COMMITTER_DATE: `${MERGED_AT} +0000` });
  git(remote, ['push', '-q', 'origin', 'main']);
  git(remote, ['checkout', '-q', '-b', 'step-2']);
  git(remote, ['commit', '-q', '--allow-empty', '-m', 'step 2']);
  const unmerged = git(remote, ['rev-parse', 'HEAD']);
  git(remote, ['push', '-q', 'origin', 'step-2']);
  return { tmp, origin, checkout, remote, merged, unmerged };
}

/** A supervisor store with one campaign on example-org/<name>: T1 and T2 published as pull requests with their verified commits. */
function store(t, { merged, unmerged }, { name = 'sampleapp', dataDir = mkdtempSync(join(tmpdir(), 'aiworks-merges-data-')) } = {}) {
  const s = new Store(join(dataDir, 'supervisor.db'));
  const d = { ...declaration({ campaignId: `campaign-${name.toLowerCase()}` }), target: { ...declaration().target, repository: `example-org/${name}` } };
  campaignStart(s, d);
  for (const [taskId, number, sha] of [['T1', 463, merged], ['T2', 464, unmerged]]) {
    const row = s.task(d.campaignId, taskId);
    s.patch('tasks', { campaign_id: d.campaignId, task_id: taskId }, row.version,
      { state: 'done', pr_url: `https://github.com/example-org/${name}/pull/${number}`, verified_sha: sha }, Date.now());
  }
  t.after(() => { s.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, store: s, d };
}

/** A git that records each call (and any fetch that overlaps another) before running the real git. */
function recordingGit(dir) {
  const script = join(dir, 'recording-git.mjs'), log = join(dir, 'git-calls.jsonl'), lock = join(dir, 'fetch.lock');
  writeFileSync(script, `import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2), fetch = args[0] === 'fetch';
let overlap = false;
if (fetch) { try { writeFileSync(${JSON.stringify(lock)}, '', { flag: 'wx' }); } catch { overlap = true; } }
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), overlap }) + '\\n');
if (fetch) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
const result = spawnSync('git', args, { stdio: 'inherit', windowsHide: true });
if (fetch && !overlap) rmSync(${JSON.stringify(lock)}, { force: true });
process.exit(result.status ?? 1);
`);
  return { git: [process.execPath, script], calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] };
}

test('a step whose verified commit is reachable from origin/main after a fetch is merged; one that is not is published, merge not seen yet', async (t) => {
  const repo = repositories(t);
  const { dataDir, d } = store(t, repo);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ repositories: { 'example-org/sampleapp': { path: repo.checkout, worktreeRoot: join(repo.tmp, 'worktrees') } } }));
  assert.deepEqual(configuredCheckouts(dataDir), { 'example-org/sampleapp': repo.checkout });
  assert.deepEqual(publishedSteps(dataDir).map((step) => [step.taskId, step.baseBranch, step.sha]), [['T1', 'main', repo.merged], ['T2', 'main', repo.unmerged]]);
  const recorder = recordingGit(repo.tmp);
  const watcher = new MergeWatcher({ steps: () => publishedSteps(dataDir), checkouts: configuredCheckouts(dataDir), git: recorder.git });
  const supervisor = supervisorSnapshot(dataDir);
  // Before any check: nothing is merged, and the steps are being checked.
  const before = ownerView(supervisor, watcher.snapshot());
  assert.deepEqual(Object.values(before.campaigns[d.campaignId].deliveries).map((item) => [item.state, item.pending]), [['published', true], ['published', true]]);
  await watcher.refresh();
  const snapshot = watcher.snapshot();
  assert.deepEqual(snapshot.repositories.map(({ repository, configured, error }) => [repository, configured, error]), [['example-org/sampleapp', true, null]]);
  assert.deepEqual(snapshot.steps[`${d.campaignId}/T1`], { sha: repo.merged, baseBranch: 'main', merged: true, mergedAt: MERGED_AT * 1000 });
  assert.deepEqual(snapshot.steps[`${d.campaignId}/T2`], { sha: repo.unmerged, baseBranch: 'main', merged: false, mergedAt: null });
  const view = ownerView(supervisor, snapshot);
  const deliveries = view.campaigns[d.campaignId].deliveries;
  assert.deepEqual([deliveries.T1.state, deliveries.T1.mergedAt], ['merged', MERGED_AT * 1000]);
  assert.deepEqual([deliveries.T2.state, deliveries.T2.pending, deliveries.T2.note], ['published', false, 'Your review and merge']);
  assert.deepEqual(view.items.filter((item) => item.kind === 'review').map((item) => item.link.label), ['Open PR #464']);
  // The git protocol only: one fetch of the base branch, then local reads.
  const calls = recorder.calls().map((call) => call.args[0]);
  assert.deepEqual(calls.filter((name) => name === 'fetch'), ['fetch']);
  assert.ok(calls.every((name) => ['fetch', 'rev-parse', 'merge-base', 'rev-list'].includes(name)), calls.join(' '));
  assert.deepEqual(recorder.calls().find((call) => call.args[0] === 'fetch').args, ['fetch', '--no-tags', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  // Data older than the freshness window never shows merged, even though git saw the merge.
  const later = ownerView(supervisor, snapshot, { now: Date.now() + MERGE_FRESH_MS + 1000 }).campaigns[d.campaignId].deliveries;
  assert.deepEqual([later.T1.state, later.T1.pending], ['published', true]);
  // The step merges later: once the base branch moves, the next check sees it.
  git(repo.remote, ['checkout', '-q', 'main']);
  git(repo.remote, ['merge', '-q', '--no-ff', 'step-2', '-m', 'Merge pull request #464']);
  git(repo.remote, ['push', '-q', 'origin', 'main']);
  const clock = { now: Date.now() + FETCH_INTERVAL_MS };
  const next = new MergeWatcher({ steps: () => publishedSteps(dataDir), checkouts: configuredCheckouts(dataDir), git: ['git'], now: () => clock.now });
  await next.refresh();
  assert.equal(next.snapshot().steps[`${d.campaignId}/T2`].merged, true);
});

test('git fetch runs at most once per repository per 5 minutes, one repository at a time', async (t) => {
  const one = repositories(t, 'sampleapp'), two = repositories(t, 'Other');
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-merges-two-'));
  const first = store(t, one, { name: 'sampleapp', dataDir });
  // Both campaigns live in one store.
  const d2 = { ...declaration({ campaignId: 'campaign-other' }), target: { ...declaration().target, repository: 'example-org/Other' } };
  campaignStart(first.store, d2);
  for (const [taskId, number, sha] of [['T1', 1, two.merged], ['T2', 2, two.unmerged]]) {
    const row = first.store.task(d2.campaignId, taskId);
    first.store.patch('tasks', { campaign_id: d2.campaignId, task_id: taskId }, row.version, { state: 'done', pr_url: `https://github.com/example-org/Other/pull/${number}`, verified_sha: sha }, Date.now());
  }
  const recorder = recordingGit(one.tmp);
  const clock = { now: 1_800_000_000_000 };
  const watcher = new MergeWatcher({ steps: () => publishedSteps(dataDir), checkouts: { 'example-org/sampleapp': one.checkout, 'example-org/other': two.checkout },
    git: recorder.git, now: () => clock.now });
  const fetches = () => recorder.calls().filter((call) => call.args[0] === 'fetch');
  // Concurrent requests share one refresh.
  await Promise.all([watcher.refresh(), watcher.refresh(), watcher.refresh()]);
  assert.equal(fetches().length, 2, 'one fetch per repository');
  assert.deepEqual(fetches().map((call) => resolve(call.cwd)).sort(), [resolve(one.checkout), resolve(two.checkout)].sort());
  for (const minutes of [1, 2, 4.9]) {
    clock.now = 1_800_000_000_000 + minutes * 60_000;
    await watcher.refresh();
  }
  assert.equal(fetches().length, 2, 'no fetch within 5 minutes of the last one');
  clock.now = 1_800_000_000_000 + FETCH_INTERVAL_MS;
  await watcher.refresh();
  await watcher.refresh();
  assert.equal(fetches().length, 4, 'one more fetch per repository after 5 minutes');
  assert.ok(fetches().every((call) => !call.overlap), 'never two fetches at once');
  assert.deepEqual(Object.values(watcher.snapshot().steps).map((step) => step.merged), [true, false, true, false]);
});

test('a failed fetch keeps the last state and shows its age, and is not retried for 5 minutes', async (t) => {
  const repo = repositories(t);
  const { dataDir, d } = store(t, repo);
  const recorder = recordingGit(repo.tmp);
  const start = Date.now(), clock = { now: start };
  const watcher = new MergeWatcher({ steps: () => publishedSteps(dataDir), checkouts: { 'example-org/sampleapp': repo.checkout }, git: recorder.git, now: () => clock.now });
  await watcher.refresh();
  const supervisor = supervisorSnapshot(dataDir);
  assert.equal(ownerView(supervisor, watcher.snapshot(), { now: clock.now }).campaigns[d.campaignId].deliveries.T1.state, 'merged');
  // The remote becomes unreachable.
  renameSync(repo.origin, `${repo.origin}.gone`);
  clock.now = start + FETCH_INTERVAL_MS;
  await watcher.refresh();
  const failed = watcher.snapshot();
  assert.deepEqual(failed.repositories.map(({ fetchedAt, attemptedAt, error }) => [fetchedAt, attemptedAt, error]), [[start, start + FETCH_INTERVAL_MS, 'fetch-failed']]);
  assert.equal(failed.steps[`${d.campaignId}/T1`].merged, true, 'the last result is kept');
  // While the last success is current, the kept state shows, with its age.
  const kept = ownerView(supervisor, failed, { now: clock.now });
  assert.deepEqual([kept.campaigns[d.campaignId].deliveries.T1.state, kept.campaigns[d.campaignId].deliveries.T1.asOf], ['merged', { at: start, reason: 'fetch-failed' }]);
  assert.deepEqual(kept.items.filter((item) => item.kind === 'review').map((item) => item.mergeCheck), [{ at: start, reason: 'fetch-failed' }]);
  // No retry within 5 minutes of the failure.
  clock.now = start + FETCH_INTERVAL_MS + 60_000;
  await watcher.refresh();
  assert.equal(recorder.calls().filter((call) => call.args[0] === 'fetch').length, 2);
  // Once the last success is old, stale data never shows merged; it says when the check is from.
  clock.now = start + MERGE_FRESH_MS + 1000;
  const stale = ownerView(supervisor, watcher.snapshot(), { now: clock.now });
  const t1 = stale.campaigns[d.campaignId].deliveries.T1;
  assert.deepEqual([t1.state, t1.reason, t1.asOf], ['published', 'fetch-failed', { at: start, reason: 'fetch-failed' }]);
  assert.equal(stale.campaigns[d.campaignId].counts.merged, 0);
  assert.ok(!/ready to merge/i.test(JSON.stringify(stale)));
  // A repository with no configured checkout is never fetched, and its merges are not seen.
  const unconfigured = new MergeWatcher({ steps: () => publishedSteps(dataDir), checkouts: {}, git: recorder.git });
  await unconfigured.refresh();
  assert.equal(recorder.calls().filter((call) => call.args[0] === 'fetch').length, 2);
  assert.deepEqual(ownerView(supervisor, unconfigured.snapshot()).campaigns[d.campaignId].deliveries.T1.reason, 'no-checkout');
});

test('the git command comes from the supervisor config, else git on PATH', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-merges-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(configuredGitCommand(dir), ['git']);
  assert.deepEqual(configuredCheckouts(dir), {});
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ commands: { git: ['C:/tools/git.exe'] }, repositories: { 'example-org/sampleapp': { path: 'C:/example/sampleapp' }, 'invalid path': { path: 'x' }, 'example-org/none': {} } }));
  assert.deepEqual(configuredGitCommand(dir), ['C:/tools/git.exe']);
  assert.deepEqual(configuredCheckouts(dir), { 'example-org/sampleapp': 'C:/example/sampleapp' });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ commands: { git: [] } }));
  assert.throws(() => configuredGitCommand(dir), /commands.git/);
});

test('no dashboard source runs gh or calls the GitHub API', () => {
  const dir = join(ROOT, 'src/dashboard');
  const files = readdirSync(dir).filter((file) => file.endsWith('.mjs')).map((file) => join(dir, file));
  files.push(...readdirSync(join(dir, 'public')).map((file) => join(dir, 'public', file)));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /api\.github\.com|graphql|commands\??\.gh\b|\['gh'\]|statusCheckRollup|\/api\/refresh/i, file);
  }
});

const freePort = () => new Promise((done, fail) => {
  const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); });
  probe.on('error', fail);
});

test('across startup, merge checks and every page and API route, the running dashboard makes zero gh calls', async (t) => {
  const repo = repositories(t);
  const { dataDir, store: s, d } = store(t, repo);
  // A synthetic gh that records every call, both as the configured command and first on PATH.
  const bin = join(repo.tmp, 'bin'), calls = join(repo.tmp, 'gh-calls.jsonl');
  mkdirSync(bin);
  const recorder = join(bin, 'record-gh.mjs');
  writeFileSync(recorder, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write('[]');\n`);
  writeFileSync(join(bin, 'gh.cmd'), `@"${process.execPath}" "${recorder}" %*\r\n`);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ governanceRoot: GOVERNANCE, commands: { gh: [process.execPath, recorder] },
    repositories: { 'example-org/sampleapp': { path: repo.checkout, worktreeRoot: join(repo.tmp, 'worktrees') } } }));
  const port = await freePort();
  const PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`;
  const child = spawn(process.execPath, [join(ROOT, 'src/dashboard/main.mjs'), '--data', dataDir, '--port', String(port), '--cache', join(repo.tmp, 'cache')],
    { env: { ...process.env, PATH, Path: PATH }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Stop the dashboard before the after hooks remove its checkout and data folders. Hooks run in the order they were
  // registered, so a hook here would run last; Windows refuses to remove folders a running dashboard still holds.
  const exited = new Promise((done) => child.on('exit', done));
  try {
    await new Promise((done, fail) => {
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('AIWorks dashboard:')) done(); });
      child.on('exit', (code) => fail(new Error(`dashboard exited ${code}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    for (const path of ['/', '/dashboard.css', '/dashboard.js', '/api/session', '/missing']) assert.ok([200, 404].includes((await fetch(`${base}${path}`)).status), path);
    const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
    const headers = { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf };
    assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers, body: '{}' })).status, 404, 'the GitHub refresh route is gone');
    assert.equal((await fetch(`${base}/api/messages`, { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), text: 'status?' }) })).status, 202);
    const c = s.campaign(d.campaignId);
    assert.equal((await fetch(`${base}/api/commands`, { method: 'POST', headers, body: JSON.stringify({ campaignId: c.id, action: 'pause', requestId: randomUUID(),
      version: c.version, authorizationVersion: c.authorization_version, scopeDigest: c.scope_digest }) })).status, 202);
    // Poll state until the merge check has fetched and seen the merge, as an open page would.
    let state;
    for (let i = 0; i < 100; i++) {
      state = await (await fetch(`${base}/api/state?since=${Date.now() - 60_000}`)).json();
      if (state.owner.campaigns[d.campaignId].deliveries.T1.state === 'merged' && !state.merges.refreshing) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(state.owner.campaigns[d.campaignId].deliveries.T1.state, 'merged');
    assert.equal(state.owner.campaigns[d.campaignId].deliveries.T2.state, 'published');
    assert.ok(state.roadmap.entries.length > 0, 'the roadmap is read from the governance checkout');
    assert.equal(state.roadmap.sources, undefined, 'no GitHub snapshot is served');
    assert.equal(existsSync(join(repo.tmp, 'cache')), false, 'no GitHub cache is written');
    assert.equal(existsSync(calls), false, `gh was called: ${existsSync(calls) ? readFileSync(calls, 'utf8') : ''}`);
  } finally {
    child.kill();
    await exited;
  }
});
