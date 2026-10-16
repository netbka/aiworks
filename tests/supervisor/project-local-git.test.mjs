// STA4 (PROJECT_CONNECTION slice S4, design 8.3): local Git projects connect through AIWorks's managed mirror. The
// owner's repository is only read; starting work stays off (LOCAL_START_OFF) until D2 (#24) and D4 (#32). Disposable
// repositories only: no remote is ever contacted, and no network, model or GitHub call is made.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/supervisor/store.mjs';
import { prepareImplementWorkspace } from '../../src/supervisor/adapters/git.mjs';
import { MIRROR_REPO, sourceRef } from '../../src/supervisor/adapters/mirror.mjs';
import { checkLocalGitProject, connectCopy, connectLocalGitProject, rebuildLocalGitMirror, refreshLocalGitProject,
  relocateLocalGitProject } from '../../src/supervisor/project-connect.mjs';
import { project, projects, rootKey, updateProject } from '../../src/supervisor/projects.mjs';

const GOVERNANCE = fileURLToPath(new URL('../fixtures/governance', import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const commit = (root, message, files = {}) => {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '--allow-empty', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
};

/**
 * A disposable local Git repository with no remote, a data directory beside it, and a Git command line that logs every
 * call (argv) before running the real git, so a test can prove which commands ran and where.
 */
function rig(t, { name = 'Notes', commits = 1 } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'aiworks-project-local-git-'));
  const root = join(tmp, name);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  for (let i = 1; i <= commits; i += 1) commit(root, `commit ${i}`, { 'README.md': `version ${i}\n` });
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir);
  const store = new Store(join(dataDir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const log = join(tmp, 'git-calls.jsonl');
  const wrapper = join(tmp, 'git-logger.mjs');
  writeFileSync(wrapper, [
    "import { spawnSync } from 'node:child_process';",
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    "const result = spawnSync('git', process.argv.slice(2), { stdio: 'inherit', windowsHide: true });",
    'process.exit(result.status ?? 1);',
  ].join('\n'));
  const loggedGit = [process.execPath, wrapper];
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const options = (extra = {}) => ({ store, dataDir, governanceRoot: GOVERNANCE, git: loggedGit, gitEnv: { GIT_CEILING_DIRECTORIES: tmp }, ...extra });
  const connect = (input = {}, extra = {}) => connectLocalGitProject({ path: root, ...input }, options(extra));
  const check = (id) => checkLocalGitProject(store, id, options());
  const refresh = (id) => refreshLocalGitProject(store, id, options());
  return { tmp, root, dataDir, store, git: loggedGit, calls, options, connect, check, refresh };
}

/** Every file under `root`, including .git, with its content hash. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return out;
}

const mirrorRepo = (saved) => join(saved.mirror_root, MIRROR_REPO);
const inside = (child, parent) => { const c = rootKey(child); const p = rootKey(parent); return c === p || c.startsWith(`${p}/`); };

test('a no-remote repository connects: the mirror is outside the source and baseline 1 is the branch head', (t) => {
  const r = rig(t);
  const head = git(r.root, 'rev-parse', 'HEAD');
  const result = r.connect();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.status, 'ready');
  const saved = projects(r.store)[0];
  assert.equal(saved.source_kind, 'local-git');
  assert.equal(saved.local_branch, 'main');
  assert.equal(saved.fingerprint, git(r.root, 'rev-list', '--max-parents=0', 'HEAD'));
  assert.deepEqual(saved.governance, { kind: 'none' }, 'D2 is not in force: no rules are bound');
  assert.equal(saved.mirror_root, join(r.tmp, 'mirrors', saved.id), 'next to worktrees/, beside the data directory (design 5.1)');
  assert.ok(!inside(saved.mirror_root, r.root) && !inside(r.root, saved.mirror_root), 'mirror and source never contain each other');
  assert.equal(git(r.tmp, '-C', mirrorRepo(saved), 'rev-parse', '--is-bare-repository'), 'true');
  assert.equal(git(r.tmp, '-C', mirrorRepo(saved), 'rev-parse', sourceRef('main')), head);
  assert.equal(git(r.tmp, '-C', mirrorRepo(saved), 'remote'), '', 'the mirror has no remote to push to');
  assert.deepEqual(saved.current_baseline.seq, 1);
  assert.equal(saved.current_baseline.commit, head);
  const [baseline] = r.store.all('SELECT * FROM project_baselines WHERE project_id = ?', saved.id);
  assert.equal(baseline.seq, 1);
  assert.equal(baseline.commit_sha, head);
  assert.equal(baseline.manifest_digest, head, 'for local Git the manifest is the commit tree (design 5.3)');
  assert.equal(baseline.files, 1);
  assert.equal(baseline.bytes, 'version 1\n'.length);
  assert.deepEqual(r.store.all("SELECT kind FROM journal WHERE kind LIKE 'project-%' ORDER BY seq").map((row) => row.kind),
    ['project-connected', 'project-baseline-taken']);
});

test("the owner's repository is byte-identical after connect and refresh: no worktree records, refs or config keys", (t) => {
  const r = rig(t, { commits: 2 });
  writeFileSync(join(r.root, 'draft.txt'), 'not committed\n');
  const before = snapshot(r.root);
  const refs = git(r.root, 'show-ref');
  const config = git(r.root, 'config', '--local', '--list');
  const saved = r.connect().project;
  assert.equal(r.refresh(saved.id).ok, true);
  assert.equal(r.check(saved.id).ok, true);
  assert.deepEqual(snapshot(r.root), before, 'every file under the folder, including .git, is unchanged');
  assert.equal(existsSync(join(r.root, '.git', 'worktrees')), false, 'no worktree record in the owner repository');
  assert.equal(git(r.root, 'show-ref'), refs, 'no new or moved refs');
  assert.equal(git(r.root, 'config', '--local', '--list'), config, 'no config keys');
  // Every command that named the owner's folder only read it: the source is never the target of a write.
  const sourceKey = rootKey(r.root);
  const reads = new Set(['rev-parse', 'rev-list', 'remote', 'symbolic-ref', 'status', 'ls-files', 'count-objects']);
  for (const argv of r.calls()) {
    const at = argv.indexOf('-C');
    if (at < 0 || rootKey(argv[at + 1]) !== sourceKey) continue;
    const sub = argv.slice(at + 2).find((arg) => !arg.startsWith('-'));
    assert.ok(reads.has(sub), `git ${sub} ran in the owner's repository`);
  }
});

test('Refresh takes baseline 2 after a new commit, and none when the branch is unchanged', (t) => {
  const r = rig(t);
  const saved = r.connect().project;
  const same = r.refresh(saved.id);
  assert.equal(same.ok, true);
  assert.equal(same.taken, false);
  const next = commit(r.root, 'second', { 'NOTES.md': 'more\n' });
  const refreshed = r.refresh(saved.id);
  assert.equal(refreshed.taken, true);
  assert.equal(refreshed.project.current_baseline.seq, 2);
  assert.equal(refreshed.project.current_baseline.commit, next);
  assert.equal(git(r.tmp, '-C', mirrorRepo(saved), 'rev-parse', sourceRef('main')), next);
  assert.deepEqual(r.store.all('SELECT seq, commit_sha, files FROM project_baselines WHERE project_id = ? ORDER BY seq', saved.id).map((row) => ({ ...row })),
    [{ seq: 1, commit_sha: saved.current_baseline.commit, files: 1 }, { seq: 2, commit_sha: next, files: 2 }]);
});

test('uncommitted changes give UNCOMMITTED_NOTICE and are not in the mirror', (t) => {
  const r = rig(t);
  const head = git(r.root, 'rev-parse', 'HEAD');
  writeFileSync(join(r.root, 'README.md'), 'edited, not committed\n');
  writeFileSync(join(r.root, 'new.txt'), 'untracked\n');
  const result = r.connect();
  assert.equal(result.ok, true);
  const notice = result.notices.find((item) => item.code === 'UNCOMMITTED_NOTICE');
  assert.ok(notice, 'the owner is told');
  assert.equal(notice.message, `You have changes that aren't committed. AIWorks works from your last commit (${head.slice(0, 7)}) and never touches your files.`);
  const mirror = mirrorRepo(result.project);
  assert.equal(git(r.tmp, '-C', mirror, 'ls-tree', '-r', '--name-only', sourceRef('main')), 'README.md');
  assert.equal(git(r.tmp, '-C', mirror, 'show', `${sourceRef('main')}:README.md`), 'version 1');
  assert.equal(readFileSync(join(r.root, 'README.md'), 'utf8'), 'edited, not committed\n', 'the owner file is untouched');
});

test('an empty repository gives GIT_NO_COMMITS and creates nothing', (t) => {
  const r = rig(t, { commits: 0 });
  const result = r.connect();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_NO_COMMITS');
  assert.equal(result.status, 'not-saved');
  assert.equal(result.message, 'This Git repository has no commits yet. Make a first commit, or connect it as a plain folder.');
  assert.equal(projects(r.store).length, 0);
  assert.equal(existsSync(join(r.tmp, 'mirrors')), false, 'no mirror for a refused folder');
});

test('a non-GitHub origin is treated as local Git and is never contacted', (t) => {
  const r = rig(t);
  const origin = 'https://git.example.invalid/owner/notes.git';
  git(r.root, 'remote', 'add', 'origin', origin);
  const result = r.connect();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.project.source_kind, 'local-git');
  assert.equal(result.project.github_repository, null);
  assert.equal(r.refresh(result.project.id).ok, true);
  const calls = r.calls();
  assert.ok(calls.some((argv) => argv.includes('fetch')), 'the copy is fetched (from the folder path)');
  for (const argv of calls) {
    assert.ok(!argv.some((arg) => arg.includes('example.invalid')), `no command names the remote: ${argv.join(' ')}`);
    assert.ok(!argv.includes('origin'), `no command names origin: ${argv.join(' ')}`);
    assert.ok(!argv.some((arg) => ['ls-remote', 'push', 'pull'].includes(arg)), `no remote command: ${argv.join(' ')}`);
    if (argv.includes('fetch')) {
      const source = argv[argv.indexOf('--') + 1];
      assert.equal(rootKey(source), rootKey(r.root), 'fetch reads the owner folder by path, never a remote');
    }
  }
});

test('a different root commit at the same path gives IDENTITY_CHANGED', (t) => {
  const r = rig(t);
  const saved = r.connect().project;
  rmSync(join(r.root, '.git'), { recursive: true, force: true });
  git(r.root, 'init', '-q', '-b', 'main');
  commit(r.root, 'an unrelated history', { 'OTHER.md': 'other\n' });
  const again = r.connect();
  assert.equal(again.code, 'IDENTITY_CHANGED');
  assert.equal(again.project, null, 'nothing is switched silently');
  const checked = r.check(saved.id);
  assert.equal(checked.code, 'IDENTITY_CHANGED');
  assert.equal(checked.status, 'needs-setup', 'work pauses until the owner decides');
  assert.equal(project(r.store, saved.id).status, 'needs-setup');
  assert.equal(project(r.store, saved.id).fingerprint, saved.fingerprint, 'the identity is kept');
});

test('a moved repository is offered "Move here" and keeps its id', (t) => {
  const r = rig(t);
  const saved = r.connect().project;
  const moved = join(r.tmp, 'Notes-moved');
  renameSync(r.root, moved);
  assert.equal(r.check(saved.id).code, 'ROOT_MISSING');
  const offered = connectLocalGitProject({ path: moved }, r.options());
  assert.equal(offered.code, 'PROJECT_MOVED');
  assert.equal(offered.status, 'confirm');
  assert.equal(offered.detail.projectId, saved.id);
  assert.match(offered.message, /^This is "Notes", connected before at .+\. Move "Notes" here to keep its history\.$/);
  assert.equal(projects(r.store).length, 1, 'no second project is created');
  const relocated = relocateLocalGitProject(r.store, saved.id, moved, r.options());
  assert.equal(relocated.ok, true);
  assert.equal(relocated.project.id, saved.id);
  assert.equal(rootKey(relocated.project.root_path), rootKey(moved));
  assert.equal(relocated.project.mirror_root, saved.mirror_root, 'the mirror and baselines stay');
  assert.equal(r.store.all("SELECT kind FROM journal WHERE kind = 'project-relocated'").length, 1);
  const next = commit(moved, 'after the move', { 'MOVED.md': 'here\n' });
  const refreshed = r.refresh(saved.id);
  assert.equal(refreshed.ok, true, refreshed.message);
  assert.equal(refreshed.project.current_baseline.commit, next);
  assert.equal(relocateLocalGitProject(r.store, saved.id, r.tmp, r.options()).ok, false, 'a folder that is not the same repository is refused');
});

test('tampering with the mirror head gives MIRROR_CHANGED until Rebuild copy', (t) => {
  const r = rig(t, { commits: 2 });
  const saved = r.connect().project;
  const older = git(r.root, 'rev-parse', 'HEAD~1');
  git(r.tmp, '-C', mirrorRepo(saved), 'update-ref', sourceRef('main'), older);
  const checked = r.check(saved.id);
  assert.equal(checked.code, 'MIRROR_CHANGED');
  assert.equal(checked.status, 'needs-setup');
  assert.equal(checked.message, "AIWorks's copy of this project changed unexpectedly, so AIWorks stopped using it.");
  assert.equal(project(r.store, saved.id).reason, 'MIRROR_CHANGED');
  const refused = r.refresh(saved.id);
  assert.equal(refused.code, 'MIRROR_CHANGED', 'Refresh does not paper over a changed copy');
  assert.equal(refused.taken, false);
  // Restoring the ref by hand is not enough either: only the owner's Rebuild copy clears it.
  git(r.tmp, '-C', mirrorRepo(saved), 'update-ref', sourceRef('main'), saved.current_baseline.commit);
  assert.equal(r.check(saved.id).code, 'MIRROR_CHANGED');
  git(r.tmp, '-C', mirrorRepo(saved), 'update-ref', sourceRef('main'), older);
  const rebuilt = rebuildLocalGitMirror(r.store, saved.id, r.options());
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.project.status, 'ready');
  assert.equal(rebuilt.project.current_baseline.seq, 2);
  assert.equal(git(r.tmp, '-C', mirrorRepo(saved), 'rev-parse', sourceRef('main')), git(r.root, 'rev-parse', 'HEAD'));
  assert.equal(r.check(saved.id).ok, true);
});

test('startWork is false with LOCAL_START_OFF, and cannot be switched on', (t) => {
  const r = rig(t);
  const result = r.connect();
  const saved = result.project;
  assert.deepEqual(saved.capabilities.startWork, { allowed: false, reason: 'LOCAL_START_OFF' });
  assert.equal(saved.capabilities.plan.allowed, true, 'planning is possible');
  assert.equal(saved.capabilities.publish.allowed, false, 'no GitHub, so no pull request');
  assert.equal(saved.status, 'ready', 'a healthy local project is not shown as broken');
  const off = result.notices.find((notice) => notice.code === 'LOCAL_START_OFF');
  assert.equal(off.message, connectCopy('LOCAL_START_OFF'));
  assert.equal(off.message, "AIWorks can't plan or start work in a project without GitHub yet. That waits for two decisions, one in your project rules and one of yours; the project's Details say what each allows.");
  assert.throws(() => updateProject(r.store, saved.id, saved.version,
    { capabilities: { ...saved.capabilities, startWork: { allowed: true } } }, Date.now()), { code: 'LOCAL_START_OFF' });
});

test('a worktree from the mirror via prepareImplementWorkspace with baseSha makes no fetch origin call', (t) => {
  const r = rig(t);
  const saved = r.connect().project;
  const before = r.calls().length;
  const workspace = prepareImplementWorkspace({ git: r.git, repoPath: mirrorRepo(saved), worktreeRoot: join(r.tmp, 'worktrees', saved.id),
    campaignId: 'local', taskId: 'T1', baseBranch: 'main', baseSha: saved.current_baseline.commit });
  assert.equal(workspace.head, saved.current_baseline.commit);
  assert.equal(readFileSync(join(workspace.path, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), 'version 1\n');
  const calls = r.calls().slice(before);
  assert.ok(calls.some((argv) => argv[0] === 'worktree' && argv[1] === 'add'));
  assert.ok(!calls.some((argv) => argv.includes('fetch') || argv.includes('origin')), 'no fetch and no origin');
  assert.equal(existsSync(join(r.root, '.git', 'worktrees')), false, 'the worktree record is in the mirror, not the owner repository');
});

test('an unregistered GitHub checkout may connect as local Git; a registered one must connect as GitHub', (t) => {
  const unregistered = rig(t);
  git(unregistered.root, 'remote', 'add', 'origin', 'https://github.com/example-org/Unlisted.git');
  const local = unregistered.connect();
  assert.equal(local.ok, true, local.message);
  assert.equal(local.project.source_kind, 'local-git');
  assert.equal(local.project.github_repository, null, 'the remote is ignored and never pushed to');
  assert.ok(!unregistered.calls().some((argv) => argv.some((arg) => arg.includes('github.com/example-org/Unlisted')) || argv.includes('origin')));

  const registered = rig(t, { name: 'SampleApp' });
  git(registered.root, 'remote', 'add', 'origin', 'https://github.com/example-org/sampleapp.git');
  const refused = registered.connect();
  assert.equal(refused.code, 'GITHUB_REGISTERED');
  assert.equal(refused.message, "example-org/sampleapp is in governance provider's project list, so connect it as a GitHub project.");
  assert.equal(projects(registered.store).length, 0);
  assert.equal(existsSync(join(registered.tmp, 'mirrors')), false);
});

test('MIRROR_SPACE stops before the copy; a second connect is idempotent; a missing branch is refused', (t) => {
  const r = rig(t);
  // Incompressible content, so the repository's objects take real space.
  commit(r.root, 'data', { 'data.bin': randomBytes(256 * 1024) });
  const tight = r.connect({}, { statfs: () => ({ bavail: 1n, bsize: 1n }) });
  assert.equal(tight.code, 'MIRROR_SPACE');
  assert.equal(tight.status, 'not-saved');
  assert.match(tight.message, /^There isn't enough free space for AIWorks's copy: .+ needed, 1 bytes free on .+\.$/);
  assert.equal(existsSync(join(r.tmp, 'mirrors')), false);
  assert.equal(projects(r.store).length, 0);

  const missing = r.connect({ branch: 'release' });
  assert.equal(missing.code, 'LOCAL_BRANCH_MISSING');
  assert.equal(missing.message, 'This repository has no branch named release. Choose the branch AIWorks should copy.');

  const first = r.connect();
  const again = r.connect();
  assert.equal(again.ok, true);
  assert.equal(again.project.id, first.project.id);
  assert.equal(projects(r.store).length, 1);
  assert.equal(r.store.all('SELECT seq FROM project_baselines').length, 1, 'reconnecting takes no new baseline');
});
