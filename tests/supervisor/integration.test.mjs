import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart, campaignStatus } from '../../src/supervisor/api.mjs';
import { validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { integratedPullRequest } from '../../src/supervisor/adapters/github.mjs';
import { prepareImplementWorkspace } from '../../src/supervisor/adapters/git.mjs';
import { declaration, environment } from './helpers.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test('integration gate advances automatically only after fresh main contains verified dependency; independent work continues', async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration();
  d.tasks[1].requiresMergedDependencies = true;
  d.tasks.push({ ...d.tasks[0], id: 'T3', dependsOn: [] });
  campaignStart(store, d);
  writeFileSync(join(env.repo, 'dependency.txt'), 'verified synthetic dependency\n');
  git(env.repo, 'add', 'dependency.txt'); git(env.repo, 'commit', '-qm', 'dependency');
  const sha = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'push', 'origin', `${sha}:refs/heads/campaign/dependency`);
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, 1,
    { state: 'done', verified_sha: sha, head_sha: sha }, Date.now());
  let now = Date.now();
  const controller = new Controller({ store, config: { ...env.config, leaseMs: 600_000 }, dataDir: env.dataDir, now: () => now, fault: null });
  const lease = store.acquireLease(d.campaignId, controller.instanceId, now, 600_000);
  const ctx = { id: d.campaignId, generation: lease.generation };
  const dispatched = [];
  controller.dispatch = async (_ctx, _c, task) => { dispatched.push(task.task_id); };
  await controller.reconcileIntegration(ctx);
  assert.match(store.task(d.campaignId, 'T2').last_error, /dependency-integration/);
  assert.ok(store.task(d.campaignId, 'T2').retry_at > now);
  await controller.schedule(ctx);
  assert.deepEqual(dispatched, ['T3']);
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T3' }, 1, { state: 'done' }, now);
  controller.refreshStatus(ctx);
  assert.ok(campaignStatus(store, d.campaignId, now).nextWakeupAt);
  git(env.repo, 'push', 'origin', `${sha}:refs/heads/main`);
  now += controller.config.integrationPollMs + 1;
  store.acquireLease(d.campaignId, controller.instanceId, now, 600_000);
  await controller.reconcileIntegration(ctx);
  assert.equal(store.task(d.campaignId, 'T2').retry_at, null);
  assert.equal(store.task(d.campaignId, 'T2').last_error, null);
  await controller.schedule(ctx);
  assert.deepEqual(dispatched, ['T3', 'T2']);
});

test('failed remote refresh cannot admit a dependency from stale local refs', async (t) => {
  const env = environment(); const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); d.tasks[1].requiresMergedDependencies = true; campaignStart(store, d);
  const sha = git(env.repo, 'rev-parse', 'HEAD');
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, 1, { state: 'done', verified_sha: sha }, Date.now());
  git(env.repo, 'remote', 'set-url', 'origin', join(env.tmp, 'missing-origin.git'));
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
  await controller.reconcileIntegration({ id: d.campaignId, generation: lease.generation });
  assert.match(store.task(d.campaignId, 'T2').last_error, /remote refresh unavailable/);
  assert.ok(store.task(d.campaignId, 'T2').retry_at > Date.now());
});

test('integration declarations reject ambiguous switches', () => {
  const d = declaration(); d.tasks[1].requiresMergedDependencies = false;
  assert.throws(() => validateDeclaration(d), /requiresMergedDependencies/);
});

test('squash merge receipt admits only the exact reviewed PR head in the freshly fetched base', async (t) => {
  const env = environment(); const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); d.tasks[1].requiresMergedDependencies = true; campaignStart(store, d);
  const base = git(env.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(env.repo, 'dependency.txt'), 'same reviewed bytes\n');
  git(env.repo, 'add', '.'); git(env.repo, 'commit', '-qm', 'reviewed head');
  const reviewedSha = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'checkout', '--detach', base);
  writeFileSync(join(env.repo, 'dependency.txt'), 'same reviewed bytes\n');
  git(env.repo, 'add', '.'); git(env.repo, 'commit', '-qm', 'coordinator squash merge');
  const squashSha = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'push', 'origin', `${squashSha}:refs/heads/main`);
  const url = 'https://github.com/example-org/sampleapp/pull/123';
  const script = join(env.tmp, 'merge-receipt.mjs');
  // The REST receipt of GET repos/{repo}/pulls/{n}; any other gh call (a GraphQL-backed gh pr view) is refused.
  const receipt = { html_url: url, merged: true, head: { sha: reviewedSha }, base: { ref: 'main' }, merge_commit_sha: squashSha };
  const setReceipt = (overrides = {}) => writeFileSync(script, `const args = process.argv.slice(2);
if (args[0] !== 'api' || !args.includes('repos/example-org/sampleapp/pulls/123')) process.exit(9);
process.stdout.write('HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n' +${JSON.stringify(JSON.stringify({ ...receipt, ...overrides }))});`);
  setReceipt();
  const gh = [process.execPath, script];
  const input = { gh, repository: 'example-org/sampleapp', url, headSha: reviewedSha, baseBranch: 'main' };
  assert.equal(integratedPullRequest(input), squashSha);
  for (const overrides of [{ html_url: 'https://github.com/foreign/repo/pull/123' }, { merged: false },
    { head: { sha: base } }, { base: { ref: 'foreign' } }, { merge_commit_sha: 'invalid' }]) {
    setReceipt(overrides); assert.equal(integratedPullRequest(input), null);
  }
  setReceipt();
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, 1,
    { state: 'done', verified_sha: reviewedSha, pr_url: url }, Date.now());
  const controller = new Controller({ store, config: { ...env.config, commands: { ...env.config.commands, gh } }, dataDir: env.dataDir, fault: null });
  const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
  await controller.reconcileIntegration({ id: d.campaignId, generation: lease.generation });
  assert.equal(store.task(d.campaignId, 'T2').retry_at, null);
  assert.equal(store.task(d.campaignId, 'T2').last_error, null);
});

test('budget recovery cannot dispatch published but unintegrated dependencies', async (t) => {
  const env = environment(); const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration({ limits: { maxWorkerRuns: 1 } }); d.tasks[1].requiresMergedDependencies = true;
  campaignStart(store, d);
  writeFileSync(join(env.repo, 'dependency.txt'), 'not integrated\n');
  git(env.repo, 'add', '.'); git(env.repo, 'commit', '-qm', 'unmerged dependency');
  const sha = git(env.repo, 'rev-parse', 'HEAD');
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, 1, { state: 'done', verified_sha: sha }, Date.now());
  const c = store.campaign(d.campaignId);
  store.patch('campaigns', { id: c.id }, c.version, { runs_used: 1, blocker: { kind: 'budget', class: 'B3' } }, Date.now());
  d.authorization.version++; d.limits.maxWorkerRuns = null; campaignStart(store, d);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  controller.launch = async () => assert.fail('unintegrated dependency cannot launch');
  await controller.step(d.campaignId);
  assert.equal(store.campaign(d.campaignId).blocker, null);
  assert.match(store.task(d.campaignId, 'T2').last_error, /dependency-integration/);
  assert.equal(store.openOperations(d.campaignId).length, 0);
  assert.equal(store.task(d.campaignId, 'T2').attempts, 0);
});

test('admission rejects an existing checkout missing dependencies even after main integration', async (t) => {
  const env = environment(); const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); d.tasks[1].requiresMergedDependencies = true; campaignStart(store, d);
  const repoConfig = env.config.repositories[d.target.repository];
  prepareImplementWorkspace({ git: ['git'], repoPath: env.repo, worktreeRoot: repoConfig.worktreeRoot,
    campaignId: d.campaignId, taskId: 'T2', baseBranch: 'main' });
  writeFileSync(join(env.repo, 'dependency.txt'), 'integrated after old checkout\n');
  git(env.repo, 'add', '.'); git(env.repo, 'commit', '-qm', 'dependency');
  const sha = git(env.repo, 'rev-parse', 'HEAD'); git(env.repo, 'push', 'origin', `${sha}:refs/heads/main`);
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, 1, { state: 'done', verified_sha: sha }, Date.now());
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  controller.launch = async () => assert.fail('stale checkout cannot launch');
  await controller.step(d.campaignId);
  assert.match(store.task(d.campaignId, 'T2').blocked.reason, /workspace lacks/);
  assert.equal(store.task(d.campaignId, 'T2').attempts, 0);
  assert.equal(store.openOperations(d.campaignId).length, 0);
});

test('new checkout uses the exact validated base instead of refetching a moving main', (t) => {
  const env = environment(); t.after(() => env.cleanup());
  const original = git(env.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(env.repo, 'dependency.txt'), 'validated dependency\n');
  git(env.repo, 'add', '.'); git(env.repo, 'commit', '-qm', 'validated base');
  const sha = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'push', 'origin', `${sha}:refs/heads/main`);
  git(env.repo, 'fetch', 'origin', 'main');
  git(env.repo, 'push', '--force', 'origin', `${original}:refs/heads/main`);
  const ws = prepareImplementWorkspace({ git: ['git'], repoPath: env.repo,
    worktreeRoot: env.config.repositories['example-org/sampleapp'].worktreeRoot,
    campaignId: 'pinned', taskId: 'T2', baseBranch: 'main', baseSha: sha });
  assert.equal(ws.head, sha);
});

test('one admission pass fetches the base once for every candidate needing merged dependencies and sees a merge made earlier in the pass', async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  // A git that counts the base fetches, then runs the real git.
  const counter = join(env.tmp, 'base-fetches.txt');
  const wrapper = join(env.tmp, 'counting-git.mjs');
  writeFileSync(counter, '');
  writeFileSync(wrapper, [
    "import { appendFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    'const args = process.argv.slice(2);',
    `if (args[0] === 'fetch' && args.some((a) => a.includes('refs/aiworks/base/'))) appendFileSync(${JSON.stringify(counter)}, 'f');`,
    "const result = spawnSync('git', args, { stdio: 'inherit', windowsHide: true });",
    'process.exit(result.status ?? 1);',
  ].join('\n'));
  const fetches = () => readFileSync(counter, 'utf8').length;
  const task = (id, issue, writes, dependsOn = []) => ({ id, issue, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`,
    dependsOn, acceptance: [`${id} exists`], references: ['AGENTS.md'], writes: [writes],
    ...(dependsOn.length ? { requiresMergedDependencies: true } : {}) });
  const d = declaration({ tasks: [task('D0', 601, 'a/'), task('D1', 602, 'b/'),
    task('W1', 603, 'c/', ['D0']), task('W2', 604, 'd/', ['D0']), task('R1', 605, 'e/', ['D1'])] });
  campaignStart(store, d);
  // Both dependencies are verified and published, neither is in main yet.
  const heads = {};
  for (const id of ['D0', 'D1']) {
    git(env.repo, 'checkout', '-q', '-b', `dep-${id}`, 'main');
    writeFileSync(join(env.repo, `${id}.txt`), `${id}\n`);
    git(env.repo, 'add', '-A'); git(env.repo, 'commit', '-qm', id);
    heads[id] = git(env.repo, 'rev-parse', 'HEAD');
    git(env.repo, 'push', '-q', 'origin', `${heads[id]}:refs/heads/campaign/${id}`);
    store.patch('tasks', { campaign_id: d.campaignId, task_id: id }, store.task(d.campaignId, id).version,
      { state: 'done', verified_sha: heads[id], head_sha: heads[id] }, Date.now());
  }
  git(env.repo, 'checkout', '-q', 'main');
  let now = Date.now();
  const config = { ...env.config, scheduler: { enabled: true, maxWorkers: 4 }, commands: { ...env.config.commands, git: [process.execPath, wrapper] } };
  const controller = new Controller({ store, config, dataDir: env.dataDir, now: () => now, fault: null, sampler: { sample: () => null } });
  controller.launch = async () => {};
  await controller.tick(); // takes the lease; the step loop finds every dependent waiting
  assert.match(store.task(d.campaignId, 'R1').last_error, /dependency-integration/);

  // Later in the same pass the merge pass merged D1; all three dependents are due again and reach admission.
  git(env.repo, 'push', '-q', 'origin', `${heads.D1}:refs/heads/main`);
  for (const id of ['W1', 'W2', 'R1']) {
    store.patch('tasks', { campaign_id: d.campaignId, task_id: id }, store.task(d.campaignId, id).version, { retry_at: null, last_error: null }, now);
  }
  const ctx = { id: d.campaignId, generation: controller.held.get(d.campaignId) };
  const decl = store.campaign(d.campaignId).declaration;
  controller.candidates = ['W1', 'W2', 'R1'].map((id) => ({ ctx, campaignId: d.campaignId, taskId: id, kind: 'implement',
    ord: store.task(d.campaignId, id).ord, declaration: decl, createdAt: store.campaign(d.campaignId).created_at }));
  const before = fetches();
  await controller.admit();
  assert.equal(fetches() - before, 1, 'one base fetch for the whole admission pass');
  for (const id of ['W1', 'W2']) {
    assert.match(store.task(d.campaignId, id).last_error, /dependency-integration: waiting for D0/);
    assert.ok(store.task(d.campaignId, id).retry_at > now);
  }
  const [op] = store.openOperations(d.campaignId);
  assert.equal(op?.task_id, 'R1', 'the dependent of the dependency merged earlier in the pass launches');
  assert.equal(op.base_sha, heads.D1, 'it starts from the base with that merge');
  assert.equal(controller.baseFetches, null, 'the shared fetch ends with admission');
  await controller.fetchBase(env.repo, 'main', d.target.repository);
  assert.equal(fetches() - before, 2, 'after admission the base is fetched afresh');
  controller.release();
});

// aiworks#140: a Git command that runs the real git except for `fetch`, which sleeps `delayMs` first (or forever when
// hung) after writing raw Git output with a URL to stderr that must never reach a log.
function slowFetchGit(dir, { hung = false, delayMs = 0 } = {}) {
  const script = join(dir, `slow-fetch-${hung ? 'hung' : delayMs}.mjs`);
  writeFileSync(script, `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const real = () => process.exit(spawnSync('git', args, { stdio: 'inherit', windowsHide: true }).status ?? 1);
if (!args.includes('fetch')) real();
process.stderr.write('fatal: unable to access https://example.invalid/repo.git synthetic-raw-marker');
setTimeout(() => process.exit(0), 60_000);
${hung ? '' : `setTimeout(real, ${delayMs});`}
`);
  return [process.execPath, script];
}

test('a hung base read ends at its deadline with a fixed failure, the event loop keeps running and nothing is admitted', async (t) => {
  const env = environment(); const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); d.tasks[1].requiresMergedDependencies = true; campaignStart(store, d);
  const sha = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'push', 'origin', `${sha}:refs/heads/main`);
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, 1, { state: 'done', verified_sha: sha }, Date.now());
  const config = { ...env.config, baseReadMs: 300, commands: { ...env.config.commands, git: slowFetchGit(env.tmp, { hung: true }) } };
  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  const logs = [];
  controller.log = (line) => logs.push(line);
  const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
  let timerRuns = 0;
  const timer = setInterval(() => { timerRuns += 1; }, 20);
  const started = Date.now();
  try {
    await controller.reconcileIntegration({ id: d.campaignId, generation: lease.generation });
  } finally { clearInterval(timer); }
  assert.ok(Date.now() - started < 10_000, 'the read ends at its deadline, not when the remote answers');
  assert.ok(timerRuns >= 3, 'timers such as the lease renewal keep running while the read waits');
  assert.match(store.task(d.campaignId, 'T2').last_error, /remote refresh unavailable/, 'no dependency is admitted on a failed read');
  assert.deepEqual(await controller.fetchBase(env.repo, 'main', d.target.repository), { ok: false, sha: null, failure: 'fetch-timeout' });
  assert.ok(logs.includes('base read unavailable: fetch-timeout'));
  assert.equal(logs.some((line) => /synthetic-raw-marker|example\.invalid|fatal/.test(line)), false, 'no raw error, URL or credential is logged');
});

test('a task changed while its base read runs is not written from that read', async (t) => {
  const env = environment(); const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); d.tasks[1].requiresMergedDependencies = true; campaignStart(store, d);
  const sha = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'push', 'origin', `${sha}:refs/heads/main`);
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, 1, { state: 'done', verified_sha: sha }, Date.now());
  const config = { ...env.config, commands: { ...env.config.commands, git: slowFetchGit(env.tmp, { delayMs: 300 }) } };
  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T2' }, store.task(d.campaignId, 'T2').version,
    { last_error: 'dependency-integration: waiting for T1 in main' }, Date.now());
  // While the fetch runs, the task is changed (here: paused by its own retry time), so the read's verdict is stale.
  setTimeout(() => store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T2' }, store.task(d.campaignId, 'T2').version,
    { retry_at: Date.now() + 3_600_000 }, Date.now()), 50);
  const changed = new Promise((done) => setTimeout(done, 100));
  await assert.rejects(controller.reconcileIntegration({ id: d.campaignId, generation: lease.generation }), /changed since version/);
  await changed;
  const row = store.task(d.campaignId, 'T2');
  assert.match(row.last_error, /dependency-integration/, 'the stale read did not clear the wait');
  assert.ok(row.retry_at > Date.now());
});
