// OWNER_UI_V2 WP1 and LO L12 (docs/design/LOCAL_OPERATION.md section 9, slice UI19), dashboard half: pause for all, a
// project or a goal through the version-bound controls; Resume checked against the trusted main; the self-hosted
// repository's merge check without any fetch; and the v2 views without worker text or paths. Synthetic stores and
// disposable git repositories only; no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { recordAnchor } from '../../src/supervisor/self-hosting.mjs';
import { applyCommand, applyScopedControl, supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { MergeWatcher } from '../../src/dashboard/merges.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { pauseSummary } from '../../src/dashboard/views.mjs';
import { COMMANDS } from '../../src/dashboard/copy.mjs';
import { declaration, runtimeCheckout } from '../supervisor/helpers.mjs';

const SELF = 'example-org/aiworks';

function git(cwd, ...args) {
  const out = spawnSync('git', ['-c', 'user.name=Dashboard Test', '-c', 'user.email=dashboard@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}

/** A data directory with three goals: two in example-org/sampleapp, one in example-org/other. */
function goals(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-dashboard-pause-'));
  const store = new Store(join(dataDir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const make = (campaignId, repository, issue) => {
    const d = declaration({ campaignId, tasks: [{ id: 'T1', issue, title: 'only task', deliverable: 'commit', goal: 'Produce the artifact.', dependsOn: [], acceptance: ['artifact exists'], references: ['AGENTS.md'] }] });
    d.target = { ...d.target, repository };
    campaignStart(store, d);
  };
  make('goal-a', 'example-org/sampleapp', 501);
  make('goal-b', 'example-org/sampleapp', 502);
  make('goal-c', 'example-org/other', 503);
  const view = () => supervisorSnapshot(dataDir).goals;
  const bind = (list) => list.map(({ campaignId, version, authorizationVersion, scopeDigest }) => ({ campaignId, version, authorizationVersion, scopeDigest }));
  const summary = (scope) => pauseSummary(view().filter((goal) => scope.kind === 'all' || goal.project === scope.project), scope);
  return { dataDir, store, view, bind, summary };
}

test('scoped pause binds every running goal of its scope, shows stopping until open runs end, and resume returns only what that scope paused', (t) => {
  const { dataDir, store, view, summary } = goals(t);
  const runtime = runtimeCheckout(), unmerged = runtimeCheckout({ unmerged: true });
  t.after(() => { runtime.cleanup(); unmerged.cleanup(); });
  const send = (input, root = runtime.root) => applyScopedControl(dataDir, { requestId: randomUUID(), ...input }, Date.now(), { provenanceRoot: root });
  const control = () => Object.fromEntries(view().map((goal) => [goal.id, goal.control]));

  // A run of goal-a is still open when the owner pauses.
  store.insert('operations', { id: 'op-a', campaign_id: 'goal-a', task_id: 'T1', kind: 'implement', seq: 1, idempotency_key: 'op-a', lease_generation: 1,
    state: 'dispatched', session_id: 'session-a', run_dir: 'run-a', workspace: 'workspace-a', packet: '{}', packet_digest: 'digest', created_at: 1, updated_at: 1 });

  // Goal-b alone first, as the owner paused it from its own menu: a pause of the goal, not of the project.
  assert.equal(applyCommand(dataDir, { campaignId: 'goal-b', action: 'pause', requestId: randomUUID(), ...(({ version, authorizationVersion, scopeDigest }) =>
    ({ version, authorizationVersion, scopeDigest }))(view().find((goal) => goal.id === 'goal-b')) }).accepted, true);

  // A binding that misses a running goal of the scope, or carries an old version, changes nothing.
  const all = summary({ kind: 'all' });
  assert.deepEqual(all.pause.map((goal) => goal.campaignId), ['goal-a', 'goal-c']);
  assert.throws(() => send({ action: 'pause', scope: 'all', goals: all.pause.slice(0, 1) }), (error) => error.status === 409);
  assert.throws(() => send({ action: 'pause', scope: 'all', goals: all.pause.map((goal) => ({ ...goal, version: goal.version + 1 })) }), (error) => error.status === 409);
  assert.deepEqual(control(), { 'goal-a': 'registered', 'goal-b': 'paused', 'goal-c': 'registered' });

  const request = { action: 'pause', scope: 'all', goals: all.pause, requestId: randomUUID() };
  assert.equal(send(request).goals, 2);
  assert.equal(send(request).duplicate, true, 'an exact retry is acknowledged, never applied twice');
  assert.deepEqual(control(), { 'goal-a': 'paused', 'goal-b': 'paused', 'goal-c': 'paused' });
  const a = view().find((goal) => goal.id === 'goal-a');
  assert.deepEqual([a.openRuns, a.pauseScope], [1, { kind: 'all' }], 'the open run is still shown: goal-a is stopping, not stopped');

  // Resume all binds only what Pause all paused: goal-b, paused on its own, keeps its own Resume.
  const resume = summary({ kind: 'all' });
  assert.deepEqual(resume.resume.map((goal) => goal.campaignId), ['goal-a', 'goal-c']);
  assert.throws(() => send({ action: 'resume', scope: 'all', goals: summary({ kind: 'goal' }).resume }), (error) => error.status === 409);
  // An untrusted runtime resumes nothing.
  assert.throws(() => send({ action: 'resume', scope: 'all', goals: resume.resume }, unmerged.root),
    (error) => error.status === 409 && error.message === COMMANDS.resumeRefused && /not merged/.test(error.detail));
  assert.deepEqual(control(), { 'goal-a': 'paused', 'goal-b': 'paused', 'goal-c': 'paused' });
  assert.equal(send({ action: 'resume', scope: 'all', goals: resume.resume }).goals, 2);
  assert.deepEqual(control(), { 'goal-a': 'registered', 'goal-b': 'paused', 'goal-c': 'registered' });

  // A project's pause covers that project only, and its resume refuses work it did not pause.
  const project = summary({ kind: 'project', project: 'example-org/sampleapp' });
  assert.equal(send({ action: 'pause', scope: 'project', project: 'example-org/sampleapp', goals: project.pause }).goals, 1);
  assert.deepEqual(control(), { 'goal-a': 'paused', 'goal-b': 'paused', 'goal-c': 'registered' });
  const back = summary({ kind: 'project', project: 'example-org/sampleapp' });
  assert.deepEqual(back.resume.map((goal) => goal.campaignId), ['goal-a']);
  assert.equal(send({ action: 'resume', scope: 'project', project: 'example-org/sampleapp', goals: back.resume }).goals, 1);
  assert.deepEqual(control(), { 'goal-a': 'registered', 'goal-b': 'paused', 'goal-c': 'registered' });
});

test('with local main trusted, Resume refuses a runtime the main ledger does not record, with no origin remote at all', (t) => {
  const { dataDir, store, view } = goals(t);
  const repo = mkdtempSync(join(tmpdir(), 'aiworks-dashboard-self-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'file.txt'), '1\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'anchor');
  const anchor = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', anchor);
  assert.equal(recordAnchor(store, { repoPath: repo, repository: SELF, sha: anchor, now: 1 }).recorded, true);
  // No origin at all from here on: a fetch would fail, and origin/main is gone.
  git(repo, 'update-ref', '-d', 'refs/remotes/origin/main');
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ selfHosting: { repository: SELF, trustedMain: 'local' } }));
  const pause = (id) => {
    const goal = view().find((item) => item.id === id);
    applyCommand(dataDir, { campaignId: id, action: 'pause', requestId: randomUUID(), version: goal.version, authorizationVersion: goal.authorizationVersion, scopeDigest: goal.scopeDigest });
    return view().find((item) => item.id === id);
  };
  const resume = (goal) => applyCommand(dataDir, { campaignId: goal.id, action: 'resume', requestId: randomUUID(), version: goal.version,
    authorizationVersion: goal.authorizationVersion, scopeDigest: goal.scopeDigest }, Date.now(), { provenanceRoot: repo });

  // A commit on main that no ledger row put there: the runtime is not trusted, whatever main points at.
  writeFileSync(join(repo, 'file.txt'), '2\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'unrecorded');
  const paused = pause('goal-a');
  assert.throws(() => resume(paused), (error) => error.status === 409 && error.message === COMMANDS.resumeRefused && /trusted tip of local main/.test(error.detail));
  assert.equal(view().find((goal) => goal.id === 'goal-a').control, 'paused');
  // The recorded tip itself is trusted with no origin remote at all.
  git(repo, 'checkout', '-q', '--detach', anchor);
  assert.equal(resume(paused).accepted, true);
  assert.equal(view().find((goal) => goal.id === 'goal-a').control, 'registered');
});

test('the merge check reads local main of the self-hosted repository with no git fetch; another repository still fetches', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-dashboard-merges-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const self = join(dir, 'self'), other = join(dir, 'other');
  for (const repo of [self, other]) {
    git(dir, 'init', '-q', '-b', 'main', repo);
    writeFileSync(join(repo, 'file.txt'), '1\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'one');
  }
  const verified = git(self, 'rev-parse', 'HEAD');
  // Every git command the watcher runs is logged by a wrapper, then run unchanged.
  const log = join(dir, 'git.log'), wrapper = join(dir, 'git-wrapper.mjs');
  writeFileSync(wrapper, `import { appendFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, JSON.stringify([process.cwd(), args]) + '\\n');
const out = spawnSync('git', args, { stdio: 'inherit', windowsHide: true }); process.exit(out.status ?? 1);\n`);
  writeFileSync(log, '');
  const steps = [{ campaignId: 'self-goal', taskId: 'T1', repository: SELF, baseBranch: 'main', sha: verified },
    { campaignId: 'other-goal', taskId: 'T1', repository: 'example-org/other', baseBranch: 'main', sha: verified }];
  const watcher = new MergeWatcher({ steps: () => steps, checkouts: { [SELF]: self, 'example-org/other': other }, localMain: new Set([SELF]),
    git: [process.execPath, wrapper] });
  await watcher.refresh();
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(calls.length > 0);
  assert.equal(calls.filter(([cwd, args]) => cwd === self && args.includes('fetch')).length, 0, 'the self-hosted repository is never fetched');
  assert.equal(calls.filter(([cwd, args]) => cwd === other && args.includes('fetch')).length, 1, 'other repositories keep their fetch');
  const snapshot = watcher.snapshot();
  assert.equal(snapshot.steps['self-goal/T1'].merged, true);
  assert.equal(snapshot.repositories.find((repo) => repo.repository === SELF).local, true);
  // The other repository has no origin, so its fetch failed and nothing reads as merged there.
  assert.equal(snapshot.steps['other-goal/T1'].merged, null);
});

test('the v2 views and typed events carry no worker text, recorded reasons or local paths', async (t) => {
  const { dataDir, store } = goals(t);
  const marker = 'secret-marker-token';
  store.journal('goal-a', 'operation-finished', { op: 'op-x', class: 'failed', detail: `${marker} at ${dataDir}`, terminal: null }, Date.now());
  store.journal('goal-a', 'blocker-raised', { kind: 'other', reason: `${marker} worker said ${dataDir}`, task: 'T1' }, Date.now());
  store.patch('campaigns', { id: 'goal-b' }, store.campaign('goal-b').version, { control: 'paused' }, Date.now());
  store.journal('goal-b', 'paused', { reason: marker, scope: { kind: 'project', project: dataDir } }, Date.now());
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ selfHosting: { repository: SELF, trustedMain: 'local' }, repositories: { [SELF]: { path: join(dataDir, 'missing') } } }));
  const roadmap = { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) };
  const server = createDashboardServer({ dataDir, roadmap });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const escaped = JSON.stringify(dataDir).slice(1, -1);
  for (const path of ['/api/v2/home', '/api/v2/settings', '/api/v2/events', '/api/v2/events?type=run-failed', `/api/v2/projects/${encodeURIComponent('example-org/sampleapp')}`]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    const text = await response.text();
    assert.ok(!text.includes(marker), `${path} leaks recorded text`);
    assert.ok(!text.includes(dataDir) && !text.includes(escaped), `${path} leaks a local path`);
  }
  const events = await (await fetch(`${base}/api/v2/events`)).json();
  assert.ok(events.events.some((event) => event.type === 'run-failed'));
  assert.ok(events.events.some((event) => event.type === 'needs-you'));
});
