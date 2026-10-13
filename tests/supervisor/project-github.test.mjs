// STA3 (PROJECT_CONNECTION slice S3, design 8.2): GitHub projects connect, and campaigns resolve their checkout through
// them. gh and the remote branch read are synthetic runners; no network, no GraphQL. Connect only reads the folder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { connectGithubProject, resolveCheckout } from '../../src/supervisor/project-connect.mjs';
import { createProject, projects } from '../../src/supervisor/projects.mjs';
import { declaration, environment } from './helpers.mjs';

const GOVERNANCE = fileURLToPath(new URL('../fixtures/governance', import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** A disposable checkout whose origin names a github.com repository (never contacted: gh and ls-remote are synthetic). */
function rig(t, { origin = 'https://github.com/netbka/Dyk.git', governanceRoot = GOVERNANCE, config = {} } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'aiworks-project-github-'));
  const root = join(tmp, 'Dyk');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'first');
  git(root, 'remote', 'add', 'origin', origin);
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir);
  const store = new Store(join(dataDir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const ghCalls = [];
  const replies = { auth: { status: 0, stdout: '', stderr: '' }, api: { status: 0, stdout: JSON.stringify({ full_name: 'netbka/Dyk', default_branch: 'main' }), stderr: '' } };
  const gh = (args) => { ghCalls.push(args); return replies[args[0]]; };
  const branches = new Set(['main']);
  const connect = (input = {}) => connectGithubProject({ path: root, ...input }, { store, config, dataDir, governanceRoot, gh,
    lsRemote: (_, branch) => branches.has(branch), gitEnv: { GIT_CEILING_DIRECTORIES: tmp } });
  return { tmp, root, dataDir, store, replies, ghCalls, branches, connect };
}

/** Every file under `root`, including .git, with its content hash. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return out;
}

test("a GitHub checkout connects Ready and stores owner/name without the URL's user info", (t) => {
  const r = rig(t, { origin: 'https://x-access-token:synthetic-token@github.com/netbka/Dyk.git' });
  const result = r.connect();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.status, 'ready');
  const [saved] = projects(r.store);
  assert.equal(saved.github_repository, 'netbka/Dyk');
  assert.equal(saved.base_branch, 'main');
  assert.equal(saved.worktree_root, join(r.tmp, 'worktrees', 'Dyk'), 'worktree root next to the data directory (SUPERVISOR.md 6)');
  assert.equal(saved.governance.kind, 'registry');
  assert.equal(saved.governance.entryId, 'dyk');
  assert.match(saved.governance.entryDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.fromEntries(Object.entries(saved.capabilities).map(([key, value]) => [key, value.allowed])),
    { plan: true, startWork: true, publish: true, apply: false });
  assert.ok(!JSON.stringify(saved).includes('synthetic-token'), 'no credential from the remote URL is stored');
  assert.deepEqual(r.ghCalls, [['auth', 'status'], ['api', 'repos/netbka/Dyk', '--jq', '{full_name: .full_name, default_branch: .default_branch}']],
    'REST only: never gh repo view or any GraphQL-backed command');
});

test('connect leaves the source byte-identical: no new refs, worktrees or config keys', (t) => {
  const r = rig(t);
  const before = snapshot(r.root);
  const config = git(r.root, 'config', '--local', '--list');
  assert.equal(r.connect().ok, true);
  assert.deepEqual(snapshot(r.root), before, 'every file under the folder, including .git, is unchanged');
  assert.equal(git(r.root, 'config', '--local', '--list'), config);
  assert.equal(git(r.root, 'worktree', 'list').split('\n').length, 1);
});

test('each gh failure maps to its code and saves the project to check again', (t) => {
  const cases = [
    ['GH_MISSING', (r) => { r.replies.auth = { status: null, stdout: '', stderr: '', error: 'ENOENT' }; }, 'needs-setup'],
    ['GH_SIGNED_OUT', (r) => { r.replies.auth = { status: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' }; }, 'needs-setup'],
    ['GH_UNREACHABLE', (r) => { r.replies.auth = { status: 1, stdout: '', stderr: 'error connecting to api.github.com: could not resolve host' }; }, 'unavailable'],
    ['GH_NO_ACCESS', (r) => { r.replies.api = { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }; }, 'needs-setup'],
    ['GH_UNREACHABLE', (r) => { r.replies.api = { status: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' }; }, 'unavailable'],
  ];
  for (const [code, arrange, status] of cases) {
    const r = rig(t);
    arrange(r);
    const result = r.connect();
    assert.equal(result.code, code);
    assert.equal(result.status, status);
    assert.ok(result.message && !/undefined/.test(result.message), `${code} has its owner copy`);
    const [saved] = projects(r.store);
    assert.equal(saved.status, status);
    assert.equal(saved.reason, code);
    assert.equal(saved.capabilities.startWork.allowed, false);
  }
});

test('registry missing, duplicate and invalid entries stop at their code', (t) => {
  const copy = (r, edit) => {
    const root = join(r.tmp, 'governance');
    cpSync(GOVERNANCE, root, { recursive: true });
    edit(join(root, 'registry', 'projects'));
    return root;
  };
  const missing = rig(t, { origin: 'https://github.com/netbka/Unlisted.git' });
  missing.replies.api.stdout = JSON.stringify({ full_name: 'netbka/Unlisted', default_branch: 'main' });
  assert.equal(missing.connect().code, 'REGISTRY_MISSING');
  assert.equal(projects(missing.store)[0].capabilities.plan.allowed, true, 'AIWorks can still plan');

  const twice = rig(t);
  const duplicated = copy(twice, (dir) => writeFileSync(join(dir, 'dyk-again.json'),
    JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'dyk.json'), 'utf8')), id: 'dyk-again' })));
  const ambiguous = connectGithubProject({ path: twice.root }, { store: twice.store, dataDir: twice.dataDir, governanceRoot: duplicated,
    gh: (args) => twice.replies[args[0]], lsRemote: () => true, gitEnv: { GIT_CEILING_DIRECTORIES: twice.tmp } });
  assert.equal(ambiguous.code, 'REGISTRY_AMBIGUOUS');
  assert.match(ambiguous.message, /dyk, dyk-again|dyk-again, dyk/);

  const broken = rig(t);
  const invalidRoot = copy(broken, (dir) => {
    const entry = JSON.parse(readFileSync(join(dir, 'dyk.json'), 'utf8'));
    writeFileSync(join(dir, 'dyk.json'), JSON.stringify({ ...entry, governance: { ...entry.governance, authorities: 'not a list' } }));
  });
  const invalid = connectGithubProject({ path: broken.root }, { store: broken.store, dataDir: broken.dataDir, governanceRoot: invalidRoot,
    gh: (args) => broken.replies[args[0]], lsRemote: () => true, gitEnv: { GIT_CEILING_DIRECTORIES: broken.tmp } });
  assert.equal(invalid.code, 'REGISTRY_INVALID');
});

test('a base branch the remote does not have stops at BRANCH_MISSING', (t) => {
  const r = rig(t);
  const result = r.connect({ baseBranch: 'release' });
  assert.equal(result.code, 'BRANCH_MISSING');
  assert.match(result.message, /no branch named release/);
});

test('CONFIG_CONFLICT raises the B2 blocker and does not dispatch', async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const elsewhere = join(env.tmp, 'other-checkout');
  mkdirSync(elsewhere);
  createProject(store, { id: 'dyk', tenant_id: 'netbka', name: 'Dyk', source_kind: 'github', root_path: elsewhere,
    github_repository: 'netbka/Dyk', base_branch: 'main', worktree_root: join(env.tmp, 'worktrees'), status: 'ready' }, Date.now());
  const decl = declaration();
  campaignStart(store, decl);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  controller.launch = async () => { throw new Error('nothing may launch'); };
  await controller.tick();
  const blocker = store.campaign(decl.campaignId).blocker;
  assert.equal(blocker?.kind, 'project-connection');
  assert.equal(blocker.class, 'B2');
  assert.equal(blocker.code, 'CONFIG_CONFLICT');
  assert.match(blocker.reason, /Settings point netbka\/Dyk to .*, but this project is at .*other-checkout/);
  assert.equal(store.all('SELECT id FROM operations').length, 0);
  assert.equal(controller.inBase(decl, 'a'.repeat(40)), false, 'local base reads skip a conflicting checkout');

  // At connect: a second checkout of a repository config.json already places elsewhere is saved Needs setup.
  const r = rig(t, { config: { repositories: { 'netbka/Dyk': { path: env.repo, worktreeRoot: join(env.tmp, 'worktrees') } } } });
  const result = r.connect();
  assert.equal(result.code, 'CONFIG_CONFLICT');
  assert.equal(result.status, 'needs-setup');
});

test('Controller.repo() prefers the project record and falls back to config', (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const decl = declaration();
  const configured = env.config.repositories['netbka/Dyk'];
  const repo = (config) => new Controller({ store, config, dataDir: env.dataDir, fault: null }).repo(decl);
  assert.equal(repo(env.config).path, configured.path, 'no project: config.json as before');
  assert.equal(resolveCheckout(store, env.config, 'netbka/Dyk'), configured, 'no project: the same config.json entry, unchanged');
  assert.equal(resolveCheckout(store, env.config, 'NETBKA/dyk'), null, 'no project: the exact config.json key, as before');
  createProject(store, { id: 'dyk', tenant_id: 'netbka', name: 'Dyk', source_kind: 'github', root_path: configured.path,
    github_repository: 'NETBKA/dyk', base_branch: 'main', worktree_root: configured.worktreeRoot, status: 'ready' }, Date.now());
  assert.equal(resolveCheckout(store, env.config, 'netbka/Dyk').source, 'project', 'the project, matched ignoring case, when both agree');
  const projectOnly = { ...env.config, repositories: {} };
  assert.equal(repo(projectOnly).path, configured.path, 'a project alone is enough');
  assert.equal(repo(projectOnly).worktreeRoot, configured.worktreeRoot);
  assert.throws(() => repo({ ...env.config, repositories: { 'netbka/Dyk': { path: env.tmp, worktreeRoot: configured.worktreeRoot } } }), { code: 'CONFIG_CONFLICT' });
  assert.throws(() => new Controller({ store, config: projectOnly, dataDir: env.dataDir, fault: null }).repo({ ...decl, target: { ...decl.target, repository: 'netbka/None' } }),
    /no local checkout configured/);
});

test('subfolders, worktrees and bare repositories are refused unsaved', (t) => {
  const r = rig(t);
  const sub = join(r.root, 'src');
  mkdirSync(sub);
  const options = { store: r.store, dataDir: r.dataDir, governanceRoot: GOVERNANCE, gh: (args) => r.replies[args[0]], lsRemote: () => true, gitEnv: { GIT_CEILING_DIRECTORIES: r.tmp } };
  assert.equal(connectGithubProject({ path: sub }, options).code, 'GIT_SUBFOLDER');
  const tree = join(r.tmp, 'tree');
  git(r.root, 'worktree', 'add', '-q', '-b', 'side', tree);
  assert.equal(connectGithubProject({ path: tree }, options).code, 'GIT_WORKTREE');
  const bare = join(r.tmp, 'bare.git');
  git(r.tmp, 'init', '-q', '--bare', bare);
  assert.equal(connectGithubProject({ path: bare }, options).code, 'GIT_BARE');
  assert.equal(projects(r.store).length, 0);
  assert.equal(r.ghCalls.length, 0, 'GitHub is not asked about a folder that cannot be connected');
});

test('a second connect of the same root is idempotent; a changed origin gives IDENTITY_CHANGED', (t) => {
  const r = rig(t);
  const first = r.connect();
  const again = r.connect();
  assert.equal(again.ok, true);
  assert.equal(again.project.id, first.project.id);
  assert.equal(projects(r.store).length, 1);
  assert.equal(r.store.all("SELECT kind FROM journal WHERE kind = 'project-connected'").length, 1);
  git(r.root, 'remote', 'set-url', 'origin', 'https://github.com/netbka/Other.git');
  const changed = r.connect();
  assert.equal(changed.code, 'IDENTITY_CHANGED');
  assert.equal(changed.project, null, 'nothing is switched silently');
  assert.equal(projects(r.store)[0].github_repository, 'netbka/Dyk');
});

test('CONFIG_CONFLICT with a task waiting for merged dependencies still raises the blocker, not a step failure', async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const elsewhere = join(env.tmp, 'other-checkout');
  mkdirSync(elsewhere);
  createProject(store, { id: 'dyk', tenant_id: 'netbka', name: 'Dyk', source_kind: 'github', root_path: elsewhere,
    github_repository: 'netbka/Dyk', base_branch: 'main', worktree_root: join(env.tmp, 'worktrees'), status: 'ready' }, Date.now());
  const decl = declaration({ tasks: [{ id: 'T1', issue: 437, title: 'gated task', deliverable: 'commit', goal: 'Produce the artifact.',
    dependsOn: [], requiresMergedDependencies: true, acceptance: ['artifact exists'], references: ['AGENTS.md'] }] });
  campaignStart(store, decl);
  const logs = [];
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null, log: (line) => logs.push(line) });
  controller.launch = async () => { throw new Error('nothing may launch'); };
  await controller.tick();
  assert.deepEqual(logs.filter((line) => /step failed/.test(line)), []);
  assert.equal(store.campaign(decl.campaignId).blocker?.code, 'CONFIG_CONFLICT');
  assert.equal(store.all('SELECT id FROM operations').length, 0);
});
