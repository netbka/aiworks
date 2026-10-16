// STA5 (PROJECT_CONNECTION slice S5, design 8.4): plain folders connect through AIWorks's managed snapshot with
// baselines. The owner's folder is only read and stays byte-identical; starting work stays off (LOCAL_START_OFF) until
// D2 (#24) and D4 (#32). Real temporary folders and a logging git wrapper only: no network, model or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/supervisor/store.mjs';
import { prepareImplementWorkspace } from '../../src/supervisor/adapters/git.mjs';
import { BASELINE_BRANCH, folderManifest, manifestDigest, MirrorError, SNAPSHOT_DIR, syncFolderSnapshot } from '../../src/supervisor/adapters/mirror.mjs';
import { checkFolderProject, connectCopy, connectFolderProject, folderMatches, rebuildFolderMirror, refreshFolderProject,
  relocateFolderProject } from '../../src/supervisor/project-connect.mjs';
import { preflight } from '../../src/supervisor/project-preflight.mjs';
import { project, projects, rootKey, updateProject } from '../../src/supervisor/projects.mjs';

const GOVERNANCE = fileURLToPath(new URL('../fixtures/governance', import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const gitBytes = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
};
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function write(root, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
}

// CRLF text, a binary file with NUL bytes and a non-ASCII name: the copy must keep all three byte for byte.
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x00, 0xff, 0xfe, 0x00]);
const BASE_FILES = {
  'README.md': '# Notes\r\nline two\r\n',
  'src/app.js': 'console.log("app");\n',
  'assets/logo.png': BINARY,
  'docs/résumé-日本.txt': 'non-ASCII name\n',
};

/**
 * A disposable plain folder, a data directory beside it, and a git command line that logs every call (argv) before
 * running the real git, so a test can prove which commands ran and where.
 */
function rig(t, { name = 'Notes', files = BASE_FILES } = {}) {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiworks-project-folder-')));
  const root = join(tmp, name);
  mkdirSync(root);
  write(root, files);
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
  // GIT_CEILING_DIRECTORIES: a host whose profile folder is a repository must not make the folder look like part of it.
  const options = (extra = {}) => ({ store, dataDir, governanceRoot: GOVERNANCE, git: loggedGit, gitEnv: { GIT_CEILING_DIRECTORIES: tmp }, ...extra });
  const connect = (input = {}, extra = {}) => connectFolderProject({ path: root, ...input }, options(extra));
  const check = (id) => checkFolderProject(store, id, options());
  const refresh = (id, extra = {}) => refreshFolderProject(store, id, options(extra));
  const rebuild = (id) => rebuildFolderMirror(store, id, options());
  return { tmp, root, dataDir, store, git: loggedGit, calls, options, connect, check, refresh, rebuild };
}

const snapshotRepo = (saved) => join(saved.mirror_root, SNAPSHOT_DIR);

/** Every file of a commit in the copy, with its exact bytes. */
function treeOf(repo, commit) {
  const out = {};
  for (const path of gitBytes(repo, 'ls-tree', '-r', '-z', '--name-only', commit).toString('utf8').split('\0').filter(Boolean)) {
    out[path] = gitBytes(repo, 'cat-file', 'blob', `${commit}:${path}`);
  }
  return out;
}

/** Every entry under `root`, links not followed: kind, size, mtimeNs and content hash, plus each directory's listing. */
function sourceState(root) {
  const out = {};
  const walk = (rel) => {
    const dir = rel === '' ? root : join(root, rel);
    const names = readdirSync(dir).sort();
    out[`${rel}/`] = names.join('|');
    for (const name of names) {
      const child = rel === '' ? name : `${rel}/${name}`;
      const stat = lstatSync(join(root, child), { bigint: true });
      if (stat.isSymbolicLink()) out[child] = `link ${stat.mtimeNs}`;
      else if (stat.isDirectory()) { out[child] = `dir ${stat.mtimeNs}`; walk(child); }
      else out[child] = `file ${stat.size} ${stat.mtimeNs} ${sha256(readFileSync(join(root, child)))}`;
    }
  };
  walk('');
  return out;
}

const inside = (child, parent) => { const c = rootKey(child); const p = rootKey(parent); return c === p || c.startsWith(`${p}/`); };

test('a plain folder connects: the copy holds the included files byte for byte, including CRLF, binary and non-ASCII names', (t) => {
  // A .gitattributes asking for line-ending conversion must not change what the copy stores.
  const r = rig(t, { files: { ...BASE_FILES, '.gitattributes': '* text=auto eol=crlf\n*.png filter=lfs\n' } });
  const result = r.connect();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.status, 'ready');
  const saved = projects(r.store)[0];
  assert.equal(saved.source_kind, 'folder');
  assert.equal(saved.fingerprint, null, 'a folder has nothing AIWorks may mark');
  assert.deepEqual(saved.governance, { kind: 'none' }, 'D2 is not in force: no rules are bound');
  assert.equal(saved.mirror_root, join(r.tmp, 'mirrors', saved.id), 'next to worktrees/, beside the data directory (design 5.1)');
  assert.ok(!inside(saved.mirror_root, r.root) && !inside(r.root, saved.mirror_root), 'the copy and the folder never contain each other');
  const repo = snapshotRepo(saved);
  assert.equal(git(repo, 'rev-parse', '--is-bare-repository'), 'false');
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads'), `refs/heads/${BASELINE_BRANCH}`, 'the one branch is aiworks/baseline');
  assert.equal(git(repo, 'rev-parse', BASELINE_BRANCH), saved.current_baseline.commit);
  assert.equal(git(repo, 'remote'), '', 'the copy has no remote');
  assert.equal(existsSync(join(repo, '.git', 'hooks')), false, 'the copy has no hooks');
  assert.equal(readFileSync(join(repo, '.git', 'info', 'attributes'), 'utf8'), '* -text -eol -filter -ident\n');
  assert.equal(git(repo, 'log', '-1', '--format=%an <%ae>', BASELINE_BRANCH), 'AIWorks <aiworks@localhost>');

  const expected = { ...BASE_FILES, '.gitattributes': '* text=auto eol=crlf\n*.png filter=lfs\n' };
  const tree = treeOf(repo, saved.current_baseline.commit);
  assert.deepEqual(Object.keys(tree).sort(), Object.keys(expected).sort());
  for (const [path, content] of Object.entries(expected)) assert.ok(tree[path].equals(Buffer.from(content)), `${path} is stored byte for byte`);

  const [baseline] = r.store.all('SELECT * FROM project_baselines WHERE project_id = ?', saved.id);
  assert.equal(baseline.seq, 1);
  assert.equal(baseline.commit_sha, saved.current_baseline.commit);
  assert.equal(baseline.files, Object.keys(expected).length);
  assert.equal(baseline.bytes, Object.values(expected).reduce((sum, content) => sum + Buffer.from(content).length, 0));
  // The manifest digest is the SHA-256 of the canonical JSON of the sorted [path, size, sha256, binary] list (design 5.3).
  const rows = Object.entries(expected).map(([path, content]) => {
    const bytes = Buffer.from(content);
    return [path, bytes.length, sha256(bytes), bytes.subarray(0, 8192).includes(0)];
  }).sort(([a], [b]) => (a < b ? -1 : 1));
  assert.equal(baseline.manifest_digest, sha256(JSON.stringify(rows)));
  assert.equal(baseline.manifest_digest, manifestDigest(rows));
  assert.deepEqual(folderManifest({ mirrorRoot: saved.mirror_root, commit: baseline.commit_sha, digest: baseline.manifest_digest }), rows);
  assert.equal(rows.find(([path]) => path === 'assets/logo.png')[3], true, 'the binary file is marked');
  assert.deepEqual(r.store.all("SELECT kind FROM journal WHERE kind LIKE 'project-%' ORDER BY seq").map((row) => row.kind),
    ['project-connected', 'project-baseline-taken']);
});

test('the folder is byte-identical after preflight, connect, refresh, check and rebuild, and no .git appears in it', (t) => {
  const r = rig(t, { files: { ...BASE_FILES, '.gitignore': 'build/\n', 'build/out.txt': 'built\n' } });
  const before = sourceState(r.root);
  assert.equal(preflight(r.root, { governanceRoot: GOVERNANCE, gitEnv: { GIT_CEILING_DIRECTORIES: r.tmp } }).kind, 'folder');
  const saved = r.connect().project;
  assert.equal(r.refresh(saved.id).ok, true);
  assert.equal(r.check(saved.id).ok, true);
  const repo = snapshotRepo(saved);
  const tampered = git(repo, '-c', 'user.name=X', '-c', 'user.email=x@example.invalid', 'commit-tree', `${BASELINE_BRANCH}^{tree}`, '-m', 'tamper');
  git(repo, 'update-ref', `refs/heads/${BASELINE_BRANCH}`, tampered);
  assert.equal(r.check(saved.id).code, 'MIRROR_CHANGED');
  assert.equal(r.rebuild(saved.id).ok, true);
  assert.deepEqual(sourceState(r.root), before, 'every path, size, mtimeNs, hash and directory listing is unchanged');
  assert.equal(existsSync(join(r.root, '.git')), false, 'no .git appears in the folder');
  // Git is never given the folder as a work tree or a repository: the only git commands that name it are preflight's
  // read-only detection, run where the folder is. The .gitignore matching runs in the copy.
  const sourceKey = rootKey(r.root);
  for (const argv of r.calls()) {
    // `rev-parse --git-dir` only asks where the repository is; --git-dir=<path> and --work-tree would set one.
    assert.ok(!argv.some((arg) => /^--(work-tree(=|$)|git-dir=)/.test(arg)), `no work tree or git dir is set: ${argv.join(' ')}`);
    const named = argv.filter((arg) => /[\\/]/.test(arg) && inside(arg.replace(/^[^=]*=/, ''), r.root));
    if (!named.length) continue;
    const at = argv.indexOf('-C');
    assert.equal(rootKey(argv[at + 1]), sourceKey, `the folder appears only as preflight's -C: ${argv.join(' ')}`);
    const sub = argv.slice(at + 2).find((arg) => !arg.startsWith('-'));
    assert.equal(sub, 'rev-parse', `git ${sub} ran in the folder`);
  }
  assert.ok(r.calls().some((argv) => argv.includes('check-ignore')), 'the .gitignore files were matched');
});

test('.env, id_rsa, *.pem and .git are left out and never reach the copy\'s objects', (t) => {
  const markers = { '.env': 'ENV-SECRET-MARKER', '.env.local': 'ENV-LOCAL-MARKER', 'keys/id_rsa': 'RSA-SECRET-MARKER',
    'certs/server.pem': 'PEM-SECRET-MARKER', 'config/credentials.json': 'CREDENTIALS-MARKER' };
  const r = rig(t, { files: { ...BASE_FILES, ...markers } });
  // A Git repository with no commits may connect as a plain folder; its .git is left out like any secret-like path (4.2).
  git(r.root, 'init', '-q');
  writeFileSync(join(r.root, '.git', 'description'), 'GIT-DIR-MARKER');
  const result = r.connect();
  assert.equal(result.ok, true, result.message);
  const saved = result.project;
  const repo = snapshotRepo(saved);
  const names = Object.keys(treeOf(repo, saved.current_baseline.commit));
  assert.deepEqual(names.sort(), Object.keys(BASE_FILES).sort());
  const objects = gitBytes(repo, 'cat-file', '--batch-all-objects', '--batch').toString('latin1');
  for (const marker of [...Object.values(markers), 'GIT-DIR-MARKER']) assert.ok(!objects.includes(marker), `${marker} is in no object`);
  for (const name of ['.env', 'id_rsa', 'server.pem', 'credentials.json']) assert.ok(!objects.includes(name), `${name} is named by no object`);
  for (const path of Object.keys(markers)) assert.equal(existsSync(join(repo, path)), false, `${path} is not in the copy's work tree`);
  const notice = result.notices.find((item) => item.code === 'EXCLUDED_NOTICE');
  assert.equal(notice.secrets, Object.keys(markers).length + 1, 'the secret-like files and .git are counted');
  assert.ok(notice.examples.secrets.includes('.git') && notice.examples.secrets.includes('.env'));
  assert.equal(notice.message, `AIWorks left out ${Object.keys(markers).length + 1} items and never copies them: ${Object.keys(markers).length + 1} secret-like files (for example .env), 0 links, 0 other Git repositories, 0 ignored files.`);
  const [baseline] = r.store.all('SELECT excluded FROM project_baselines WHERE project_id = ?', saved.id);
  assert.equal(JSON.parse(baseline.excluded).secrets.count, Object.keys(markers).length + 1, 'the baseline keeps the excluded-path summary');
});

test('junctions to outside and inside the folder are left out and listed; a nested repository is left out', (t) => {
  const r = rig(t);
  const outside = join(r.tmp, 'outside');
  write(outside, { 'secret-plan.txt': 'OUTSIDE-MARKER' });
  // A junction needs no privilege on Windows; elsewhere Node makes a directory symbolic link.
  symlinkSync(outside, join(r.root, 'to-outside'), 'junction');
  symlinkSync(join(r.root, 'src'), join(r.root, 'to-inside'), 'junction');
  write(r.root, { 'vendor/lib/.git/HEAD': 'ref: refs/heads/main\n', 'vendor/lib/code.js': 'NESTED-MARKER', 'vendor/keep.txt': 'kept\n' });
  const result = r.connect();
  assert.equal(result.ok, true, result.message);
  const repo = snapshotRepo(result.project);
  const names = Object.keys(treeOf(repo, result.project.current_baseline.commit));
  assert.deepEqual(names.sort(), [...Object.keys(BASE_FILES), 'vendor/keep.txt'].sort());
  const notice = result.notices.find((item) => item.code === 'EXCLUDED_NOTICE');
  assert.equal(notice.links, 2);
  assert.deepEqual(notice.examples.links.sort(), ['to-inside', 'to-outside']);
  assert.equal(notice.repos, 1);
  assert.deepEqual(notice.examples.repos, ['vendor/lib']);
  const objects = gitBytes(repo, 'cat-file', '--batch-all-objects', '--batch').toString('latin1');
  assert.ok(!objects.includes('OUTSIDE-MARKER') && !objects.includes('NESTED-MARKER'));
  assert.ok(readdirSync(repo).every((entry) => !lstatSync(join(repo, entry)).isSymbolicLink()), 'the copy holds no link');
});

test('.gitignore files in the folder are honoured, and node_modules is left out by default', (t) => {
  const r = rig(t, { files: {
    ...BASE_FILES,
    '.gitignore': 'build/\n*.log\n',
    'docs/.gitignore': 'draft.md\n',
    'docs/draft.md': 'draft\n',
    'build/out.txt': 'built\n',
    'debug.log': 'log\n',
    'node_modules/pkg/index.js': 'module\n',
  } });
  const result = r.connect();
  assert.equal(result.ok, true, result.message);
  const names = Object.keys(treeOf(snapshotRepo(result.project), result.project.current_baseline.commit));
  assert.deepEqual(names.sort(), [...Object.keys(BASE_FILES), '.gitignore', 'docs/.gitignore'].sort());
  const notice = result.notices.find((item) => item.code === 'EXCLUDED_NOTICE');
  assert.equal(notice.ignored, 3);
  assert.deepEqual(notice.examples.ignored.sort(), ['build/out.txt', 'debug.log', 'docs/draft.md']);
  assert.equal(notice.modules, 1);
  assert.deepEqual(notice.examples.modules, ['node_modules']);
  assert.match(notice.message, /, 3 ignored files\.$/);
  const ignore = r.calls().filter((argv) => argv.includes('check-ignore'));
  assert.ok(ignore.length >= 1);
  for (const argv of ignore) {
    assert.ok(argv.includes('--no-index'));
    assert.equal(rootKey(argv[argv.indexOf('-C') + 1]), rootKey(snapshotRepo(result.project)), 'matched in the copy, never the folder');
  }
});

test('the scan limits stop before anything is copied: files, bytes, one file, time and space', (t) => {
  const r = rig(t, { files: { 'a.txt': 'aaaa', 'b.txt': 'bbbb', 'c.txt': 'cccccc' } });
  const refusedWith = (code, result) => {
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.status, 'not-saved');
    assert.equal(result.project, null);
    assert.equal(projects(r.store).length, 0);
    assert.equal(existsSync(join(r.tmp, 'mirrors')), false, 'no copy for a refused folder');
    return result;
  };
  const files = refusedWith('TOO_LARGE', r.connect({}, { limits: { maxFiles: 2 } }));
  assert.match(files.message, /^This folder is too big to copy safely \(3 files, \d+ bytes\)\. Leave out large folders such as build output, or choose a smaller folder\.$/);
  refusedWith('TOO_LARGE', r.connect({}, { limits: { maxBytes: 10 } }));
  const one = refusedWith('FILE_TOO_LARGE', r.connect({}, { limits: { maxFileBytes: 5 } }));
  assert.equal(one.message, '1 files are larger than 100 MB, for example c.txt. Leave them out to continue.');
  let clock = 0;
  const slow = refusedWith('SCAN_TIMEOUT', r.connect({}, { limits: { timeoutMs: 2500 }, clock: () => (clock += 1000) }));
  assert.equal(slow.message, 'Reading this folder took too long. Leave out large folders, then try again.');
  const space = refusedWith('MIRROR_SPACE', r.connect({}, { statfs: () => ({ bavail: 3n, bsize: 1n }) }));
  assert.match(space.message, /^There isn't enough free space for AIWorks's copy: \d+ bytes needed, 3 bytes free on .+\.$/);
  assert.equal(r.connect({}, { limits: { maxFiles: 3, maxBytes: 14, maxFileBytes: 6 }, statfs: () => ({ bavail: 31n, bsize: 1n }) }).ok, true,
    'exactly at every limit connects');
});

test('CASE_COLLISION through an injected listing, and on a real case-sensitive folder where the platform has one', (t) => {
  const r = rig(t, { files: { 'Readme.md': 'a', 'docs/x.md': 'x' } });
  // NTFS cannot hold both names without per-directory case sensitivity, so the listing is injected (as in the preflight
  // test): only Readme.md exists, and its lstat answers for README.md too.
  const listing = (path) => (rootKey(path) === rootKey(r.root) ? ['Readme.md', 'README.md', 'docs'] : readdirSync(path));
  const phantom = join(r.root, 'README.md');
  const lstat = (path) => lstatSync(path === phantom ? join(r.root, 'Readme.md') : path, { bigint: true });
  const injected = r.connect({}, { io: { readdir: listing, lstat } });
  assert.equal(injected.code, 'CASE_COLLISION');
  assert.equal(injected.message, "Readme.md and README.md differ only in capital letters. AIWorks's copy can't keep both. Rename one or leave it out.");
  assert.equal(projects(r.store).length, 0);

  writeFileSync(join(r.root, 'docs', 'X.md'), 'X');
  if (readdirSync(join(r.root, 'docs')).length < 2) {
    t.skip('this file system folds case, so it cannot hold both names; the injected listing covers the code');
    return;
  }
  const real = r.connect();
  assert.equal(real.code, 'CASE_COLLISION');
  assert.deepEqual([real.detail.a, real.detail.b].sort(), ['docs/X.md', 'docs/x.md']);
  assert.equal(existsSync(join(r.tmp, 'mirrors')), false);
});

test('a file that changes between hash and re-hash gets one retry, then CHANGED_DURING_COPY with the previous baseline kept', (t) => {
  const r = rig(t);
  const saved = r.connect().project;
  const target = join(r.root, 'src', 'app.js');
  let edits = 0;
  const always = { afterHash: (rel) => { if (rel === 'src/app.js') writeFileSync(target, `edit ${(edits += 1)}\n`); } };
  const failed = r.refresh(saved.id, { hooks: always });
  assert.equal(edits, 2, 'one retry, then stop');
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'CHANGED_DURING_COPY');
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.message, connectCopy('CHANGED_DURING_COPY'));
  assert.equal(failed.message, 'Files changed while AIWorks was copying them. Finish saving your work, then check again.');
  assert.equal(failed.taken, false);
  const kept = project(r.store, saved.id);
  assert.deepEqual(kept.current_baseline, saved.current_baseline, 'the earlier baseline stays current');
  assert.equal(git(snapshotRepo(saved), 'rev-parse', BASELINE_BRANCH), saved.current_baseline.commit, 'aiworks/baseline did not move');
  assert.equal(r.store.all('SELECT seq FROM project_baselines WHERE project_id = ?', saved.id).length, 1);
  assert.equal(kept.status, 'unavailable');
  assert.equal(r.check(saved.id).ok, true, 'a later check clears it');

  let once = 0;
  const first = { afterHash: (rel) => { if (rel === 'src/app.js' && !once) { once += 1; writeFileSync(target, 'settled\n'); } } };
  const retried = r.refresh(saved.id, { hooks: first });
  assert.equal(retried.ok, true, retried.message);
  assert.equal(retried.taken, true, 'the retry copies the settled file');
  assert.equal(treeOf(snapshotRepo(saved), retried.project.current_baseline.commit)['src/app.js'].toString(), 'settled\n');

  const other = rig(t, { name: 'Other' });
  const atConnect = other.connect({}, { hooks: { afterHash: (rel) => { if (rel === 'README.md') writeFileSync(join(other.root, rel), `${Math.random()}`); } } });
  assert.equal(atConnect.code, 'CHANGED_DURING_COPY');
  assert.equal(atConnect.status, 'unavailable');
  assert.equal(projects(other.store).length, 0);
  assert.equal(existsSync(join(other.tmp, 'mirrors', 'other')), false, 'a failed connect leaves no copy');
});

test('Refresh takes baseline 2 without a deleted file, and none when the folder is unchanged', (t) => {
  const r = rig(t);
  const saved = r.connect().project;
  const same = r.refresh(saved.id);
  assert.equal(same.ok, true);
  assert.equal(same.taken, false);
  unlinkSync(join(r.root, 'src', 'app.js'));
  writeFileSync(join(r.root, 'README.md'), '# Notes, edited\r\n');
  const refreshed = r.refresh(saved.id);
  assert.equal(refreshed.taken, true);
  assert.equal(refreshed.project.current_baseline.seq, 2);
  const repo = snapshotRepo(saved);
  const tree = treeOf(repo, refreshed.project.current_baseline.commit);
  assert.equal('src/app.js' in tree, false, 'the deleted file is gone from baseline 2');
  assert.equal(existsSync(join(repo, 'src', 'app.js')), false, 'and from the copy');
  assert.equal(tree['README.md'].toString(), '# Notes, edited\r\n');
  assert.equal(git(repo, 'rev-parse', `${BASELINE_BRANCH}^`), saved.current_baseline.commit, 'baseline 2 follows baseline 1');
  assert.ok('src/app.js' in treeOf(repo, saved.current_baseline.commit), 'baseline 1 is kept');
  assert.deepEqual(r.store.all('SELECT seq, files FROM project_baselines WHERE project_id = ? ORDER BY seq', saved.id).map((row) => ({ ...row })),
    [{ seq: 1, files: 4 }, { seq: 2, files: 3 }]);
});

test('tampering with aiworks/baseline gives MIRROR_CHANGED until Rebuild copy', (t) => {
  const r = rig(t);
  const saved = r.connect().project;
  const repo = snapshotRepo(saved);
  writeFileSync(join(repo, 'planted.txt'), 'planted\n');
  git(repo, 'add', 'planted.txt');
  git(repo, '-c', 'user.name=X', '-c', 'user.email=x@example.invalid', 'commit', '-q', '-m', 'tamper');
  git(repo, 'branch', '-f', BASELINE_BRANCH, 'HEAD');
  const checked = r.check(saved.id);
  assert.equal(checked.code, 'MIRROR_CHANGED');
  assert.equal(checked.status, 'needs-setup');
  assert.equal(checked.message, "AIWorks's copy of this project changed unexpectedly, so AIWorks stopped using it.");
  const refused = r.refresh(saved.id);
  assert.equal(refused.code, 'MIRROR_CHANGED', 'Refresh does not paper over a changed copy');
  const rebuilt = r.rebuild(saved.id);
  assert.equal(rebuilt.ok, true, rebuilt.message);
  assert.equal(rebuilt.project.status, 'ready');
  assert.equal(rebuilt.project.current_baseline.seq, 2);
  const tree = treeOf(repo, rebuilt.project.current_baseline.commit);
  assert.deepEqual(Object.keys(tree).sort(), Object.keys(BASE_FILES).sort(), 'the planted file is gone');
  assert.equal(existsSync(join(repo, 'planted.txt')), false);
  assert.equal(r.check(saved.id).ok, true);
});

test('startWork is false with LOCAL_START_OFF, and cannot be switched on', (t) => {
  const r = rig(t);
  const result = r.connect();
  const saved = result.project;
  assert.deepEqual(saved.capabilities.startWork, { allowed: false, reason: 'LOCAL_START_OFF' });
  assert.equal(saved.capabilities.plan.allowed, true);
  assert.equal(saved.capabilities.publish.allowed, false);
  const off = result.notices.find((notice) => notice.code === 'LOCAL_START_OFF');
  assert.equal(off.message, "AIWorks can't plan or start work in a project without GitHub yet. That waits for two decisions, one in your project rules and one of yours; the project's Details say what each allows.");
  assert.throws(() => updateProject(r.store, saved.id, saved.version,
    { capabilities: { ...saved.capabilities, startWork: { allowed: true } } }, Date.now()), { code: 'LOCAL_START_OFF' });
  const again = r.connect();
  assert.equal(again.project.id, saved.id, 'a second connect of the same folder is idempotent');
  assert.equal(r.store.all('SELECT seq FROM project_baselines').length, 1);
  assert.equal(r.store.all('SELECT id FROM operations').length, 0, 'connecting starts no work');
});

test('moving the folder and choosing "Move here" keeps the id, with the match count shown', (t) => {
  const r = rig(t);
  const saved = r.connect().project;
  const moved = join(r.tmp, 'Notes-moved');
  renameSync(r.root, moved);
  assert.equal(r.check(saved.id).code, 'ROOT_MISSING');
  writeFileSync(join(moved, 'README.md'), 'changed after the move\n');
  assert.deepEqual(folderMatches(r.store, saved.id, moved), { files: 4, matches: 3 });
  const relocated = relocateFolderProject(r.store, saved.id, moved, r.options());
  assert.equal(relocated.ok, true, relocated.message);
  assert.deepEqual(relocated.match, { files: 4, matches: 3 });
  assert.equal(relocated.project.id, saved.id);
  assert.equal(rootKey(relocated.project.root_path), rootKey(moved));
  assert.equal(relocated.project.mirror_root, saved.mirror_root, 'the copy and baselines stay');
  assert.equal(r.store.all("SELECT kind FROM journal WHERE kind = 'project-relocated'").length, 1);
  const refreshed = r.refresh(saved.id);
  assert.equal(refreshed.ok, true, refreshed.message);
  assert.equal(refreshed.taken, true);
  assert.equal(treeOf(snapshotRepo(saved), refreshed.project.current_baseline.commit)['README.md'].toString(), 'changed after the move\n');
  assert.equal(projects(r.store).length, 1);
});

test('the copy is refused inside the folder, and the folder inside the copy', (t) => {
  const r = rig(t);
  assert.throws(() => syncFolderSnapshot({ mirrorRoot: join(r.root, '.aiworks-copy'), sourceRoot: r.root }),
    (error) => error instanceof MirrorError && error.code === 'MIRROR_OVERLAP');
  const mirrorRoot = join(r.tmp, 'mirrors', 'outer');
  const nested = join(mirrorRoot, 'inner');
  write(nested, { 'a.txt': 'a' });
  assert.throws(() => syncFolderSnapshot({ mirrorRoot, sourceRoot: nested }), (error) => error instanceof MirrorError && error.code === 'MIRROR_OVERLAP');
  assert.equal(existsSync(join(r.root, '.aiworks-copy')), false, 'nothing is created in the folder');
  // Through connect, AIWorks's mirrors and data folders are protected roots.
  const inMirrors = connectFolderProject({ path: nested }, r.options());
  assert.equal(inMirrors.code, 'PATH_PROTECTED');
  const inData = join(r.dataDir, 'notes');
  write(inData, { 'a.txt': 'a' });
  assert.equal(connectFolderProject({ path: inData }, r.options()).code, 'PATH_PROTECTED');
});

test('a Git repository is refused as a plain folder, and a worktree from the copy needs no fetch', (t) => {
  const r = rig(t);
  const repoFolder = join(r.tmp, 'Repo');
  write(repoFolder, { 'a.txt': 'a\n' });
  git(repoFolder, 'init', '-q');
  git(repoFolder, 'add', '-A');
  git(repoFolder, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '-m', 'first');
  const refused = connectFolderProject({ path: repoFolder }, r.options());
  assert.equal(refused.code, 'NOT_FOLDER');
  assert.equal(refused.message, 'This folder is a Git repository. Connect it as a GitHub or local Git project.');

  const saved = r.connect().project;
  const before = r.calls().length;
  const workspace = prepareImplementWorkspace({ git: r.git, repoPath: snapshotRepo(saved), worktreeRoot: join(r.tmp, 'worktrees', saved.id),
    campaignId: 'local', taskId: 'T1', baseBranch: BASELINE_BRANCH, baseSha: saved.current_baseline.commit });
  assert.equal(workspace.head, saved.current_baseline.commit);
  assert.ok(readFileSync(join(workspace.path, 'assets', 'logo.png')).equals(BINARY));
  assert.ok(!r.calls().slice(before).some((argv) => argv.includes('fetch') || argv.includes('origin')), 'no fetch and no origin');
  assert.equal(existsSync(join(r.root, '.git')), false, 'the worktree record is in the copy, not the folder');
});
