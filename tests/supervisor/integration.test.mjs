import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
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
  controller.reconcileIntegration(ctx);
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
  controller.reconcileIntegration(ctx);
  assert.equal(store.task(d.campaignId, 'T2').retry_at, null);
  assert.equal(store.task(d.campaignId, 'T2').last_error, null);
  await controller.schedule(ctx);
  assert.deepEqual(dispatched, ['T3', 'T2']);
});

test('failed remote refresh cannot admit a dependency from stale local refs', (t) => {
  const env = environment(); const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); d.tasks[1].requiresMergedDependencies = true; campaignStart(store, d);
  const sha = git(env.repo, 'rev-parse', 'HEAD');
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, 1, { state: 'done', verified_sha: sha }, Date.now());
  git(env.repo, 'remote', 'set-url', 'origin', join(env.tmp, 'missing-origin.git'));
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
  controller.reconcileIntegration({ id: d.campaignId, generation: lease.generation });
  assert.match(store.task(d.campaignId, 'T2').last_error, /remote refresh unavailable/);
  assert.ok(store.task(d.campaignId, 'T2').retry_at > Date.now());
});

test('integration declarations reject ambiguous switches', () => {
  const d = declaration(); d.tasks[1].requiresMergedDependencies = false;
  assert.throws(() => validateDeclaration(d), /requiresMergedDependencies/);
});

test('squash merge receipt admits only the exact reviewed PR head in the freshly fetched base', (t) => {
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
  const url = 'https://github.com/netbka/Dyk/pull/123';
  const script = join(env.tmp, 'merge-receipt.mjs');
  const receipt = { url, state: 'MERGED', headRefOid: reviewedSha, baseRefName: 'main', mergeCommit: { oid: squashSha } };
  const setReceipt = (overrides = {}) => writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify({ ...receipt, ...overrides }))});`);
  setReceipt();
  const gh = [process.execPath, script];
  const input = { gh, repository: 'netbka/Dyk', url, headSha: reviewedSha, baseBranch: 'main' };
  assert.equal(integratedPullRequest(input), squashSha);
  for (const overrides of [{ url: 'https://github.com/foreign/repo/pull/123' }, { state: 'OPEN' },
    { headRefOid: base }, { baseRefName: 'foreign' }, { mergeCommit: { oid: 'invalid' } }]) {
    setReceipt(overrides); assert.equal(integratedPullRequest(input), null);
  }
  setReceipt();
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, 1,
    { state: 'done', verified_sha: reviewedSha, pr_url: url }, Date.now());
  const controller = new Controller({ store, config: { ...env.config, commands: { ...env.config.commands, gh } }, dataDir: env.dataDir, fault: null });
  const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
  controller.reconcileIntegration({ id: d.campaignId, generation: lease.generation });
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
    worktreeRoot: env.config.repositories['netbka/Dyk'].worktreeRoot,
    campaignId: 'pinned', taskId: 'T2', baseBranch: 'main', baseSha: sha });
  assert.equal(ws.head, sha);
});
