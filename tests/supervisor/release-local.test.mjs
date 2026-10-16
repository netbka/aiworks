// REL8 (AUTO_RELEASE slice R8, sections 7.5 and 8): the local apply adapters write a verified result into a plain
// folder or a local Git repository with a backup first, roll back on failure and reconcile after a crash without
// repeating. Temporary folders and disposable Git repositories only: no network, model or GitHub call. A crash is a
// real child process that exits at a chosen point. Every test runs on Windows and Linux; none is skipped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLY_BACKUP_PREFIX, localFolderApply, localGitApply, reconcileLocalFolderApply, reconcileLocalGitApply, undoLocalFolderApply,
  undoLocalGitApply } from '../../src/supervisor/release/local-apply.mjs';

const MODULE = fileURLToPath(new URL('../../src/supervisor/release/local-apply.mjs', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const NO_PR = /[Pp]ull|[Mm]erge|^pr(?:[A-Z_]|$)/;

/** A local result never reports a pull request or merge state, in its fields or its record. */
function local(result) {
  for (const key of Object.keys(result)) assert.doesNotMatch(key, NO_PR, `a local result has no ${key}`);
  return result;
}

/** Every file and directory under `root`, with each file's hash. */
function snapshot(root) {
  const seen = new Map();
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) seen.set(key, 'link');
      else if (entry.isDirectory()) { seen.set(key, 'dir'); walk(path, key); }
      else seen.set(key, sha256(readFileSync(path)));
    }
  };
  walk(root, '');
  return seen;
}

/** The paths that differ between two snapshots. */
function changed(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).sort();
}

/** Assert that only paths under the given top-level names changed. */
function onlyUnder(before, after, names) {
  const outside = changed(before, after).filter((key) => !names.some((name) => key === name || key.startsWith(`${name}/`)));
  assert.deepEqual(outside, [], `written outside ${names.join(' and ')}`);
}

function sandbox(t, prefix) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return tmp;
}

/** A child process that runs one adapter function and exits with code 70 at the `count`-th call of `hook`. */
function crash(t, fn, input, hook, count = 1) {
  const dir = sandbox(t, 'aiworks-release-local-crash-');
  const script = join(dir, 'crash.mjs');
  writeFileSync(script, [
    "import { pathToFileURL } from 'node:url';",
    'const [module, fn, json, hook, count] = process.argv.slice(2);',
    'const adapters = await import(pathToFileURL(module));',
    'const input = JSON.parse(json);',
    'let calls = 0;',
    'input.hooks = { [hook]: () => { calls += 1; if (calls >= Number(count)) process.exit(70); } };',
    'adapters[fn](input);',
    'process.exit(0);',
  ].join('\n'));
  const result = spawnSync(process.execPath, [script, MODULE, fn, JSON.stringify(input), hook, String(count)], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 70, `the child should stop at ${hook}: ${result.stderr}`);
}

// ---- Plain folder ----

const ORIGINAL = { 'a.txt': 'alpha\n', 'b.txt': 'bravo\n', 'gone.txt': 'to be deleted\n', 'keep/k.txt': 'untouched\n' };

function folderRig(t) {
  const tmp = sandbox(t, 'aiworks-release-local-folder-');
  const root = join(tmp, 'folder');
  for (const [rel, text] of Object.entries(ORIGINAL)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  mkdirSync(join(tmp, 'elsewhere'));
  writeFileSync(join(tmp, 'elsewhere', 'other.txt'), 'not the target\n');
  const backupDir = join(tmp, 'backups', 'apply-1');
  const changes = [
    { path: 'a.txt', before: sha256(ORIGINAL['a.txt']), after: 'alpha, changed\n' },
    { path: 'b.txt', before: sha256(ORIGINAL['b.txt']), after: 'bravo, changed\n' },
    { path: 'new/dir/c.txt', before: null, after: 'charlie, new\n' },
    { path: 'gone.txt', before: sha256(ORIGINAL['gone.txt']), after: null },
  ];
  const input = (extra = {}) => ({ id: 'apply-1', targetRoot: root, backupDir, changes, ...extra });
  const read = (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);
  const asResult = () => {
    assert.equal(read('a.txt'), 'alpha, changed\n');
    assert.equal(read('b.txt'), 'bravo, changed\n');
    assert.equal(read('new/dir/c.txt'), 'charlie, new\n');
    assert.equal(read('gone.txt'), null);
    assert.equal(read('keep/k.txt'), 'untouched\n');
  };
  const original = snapshot(root);
  return { tmp, root, backupDir, changes, input, read, asResult, original, record: () => JSON.parse(readFileSync(join(backupDir, 'apply.json'), 'utf8')) };
}

test('folder: owner edited a target file: refused, nothing written', (t) => {
  const rig = folderRig(t);
  writeFileSync(join(rig.root, 'b.txt'), 'the owner edited this\n');
  const before = snapshot(rig.tmp);
  const result = local(localFolderApply(rig.input()));
  assert.equal(result.outcome, 'refused');
  assert.equal(result.code, 'APPLY_FOLDER_CHANGED');
  assert.deepEqual(result.files, ['b.txt']);
  assert.deepEqual(changed(before, snapshot(rig.tmp)), [], 'nothing at all was written, not even the backup directory');
  // A file the baseline says is absent but now exists is a change too.
  writeFileSync(join(rig.root, 'b.txt'), ORIGINAL['b.txt']);
  mkdirSync(join(rig.root, 'new', 'dir'), { recursive: true });
  writeFileSync(join(rig.root, 'new', 'dir', 'c.txt'), 'the owner made this\n');
  const again = snapshot(rig.tmp);
  assert.deepEqual(localFolderApply(rig.input()).files, ['new/dir/c.txt']);
  assert.deepEqual(changed(again, snapshot(rig.tmp)), []);
});

test('folder: apply backs up first, writes only the folder and its backup, and Undo apply restores it byte for byte', (t) => {
  const rig = folderRig(t);
  const before = snapshot(rig.tmp);
  const result = local(localFolderApply(rig.input()));
  assert.equal(result.outcome, 'applied', result.reason);
  rig.asResult();
  onlyUnder(before, snapshot(rig.tmp), ['folder', 'backups']);
  const record = rig.record();
  assert.equal(record.state, 'applied');
  for (const key of Object.keys(record)) assert.doesNotMatch(key, NO_PR);
  // The backup holds the original bytes of every changed or deleted file, with their hashes.
  for (const entry of record.entries.filter((item) => item.before)) {
    assert.equal(sha256(readFileSync(join(rig.backupDir, entry.backup))), entry.before, entry.path);
  }
  assert.deepEqual(readdirSync(rig.root).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left');
  const undone = local(undoLocalFolderApply({ backupDir: rig.backupDir }));
  assert.equal(undone.outcome, 'rolled-back');
  assert.deepEqual(snapshot(rig.root), rig.original, 'the folder is as it was, and the created directories are gone');
  onlyUnder(before, snapshot(rig.tmp), ['backups']);
});

test('folder: a failure mid-apply rolls back to the backup', (t) => {
  const rig = folderRig(t);
  const before = snapshot(rig.tmp);
  let writes = 0;
  const result = local(localFolderApply(rig.input({ hooks: { afterWrite: () => { writes += 1; if (writes === 2) throw new Error('disk full'); } } })));
  assert.equal(result.outcome, 'rolled-back');
  assert.match(result.reason, /disk full/);
  assert.equal(rig.record().state, 'rolled-back');
  assert.deepEqual(snapshot(rig.root), rig.original, 'every write was undone from the backup');
  onlyUnder(before, snapshot(rig.tmp), ['backups']);
  assert.throws(() => localFolderApply(rig.input()), /rolled-back: reconcile it, never run it again/);
});

test('folder: a file changed by someone else during apply: stop, backup kept', (t) => {
  const rig = folderRig(t);
  const hooks = { afterWrite: (path) => { if (path === 'a.txt') writeFileSync(join(rig.root, 'b.txt'), 'the owner, meanwhile\n'); } };
  const result = local(localFolderApply(rig.input({ hooks })));
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.code, 'APPLY_FOLDER_CHANGED');
  assert.deepEqual(result.files, ['b.txt']);
  assert.equal(rig.read('b.txt'), 'the owner, meanwhile\n', "the owner's file is never written over");
  assert.equal(rig.read('a.txt'), ORIGINAL['a.txt'], 'what AIWorks wrote was put back');
  assert.equal(rig.record().state, 'stopped');
  assert.equal(readFileSync(join(rig.backupDir, rig.record().entries[1].backup), 'utf8'), ORIGINAL['b.txt'], 'the backup is kept');
});

test('folder: Undo apply refuses over a file changed since, nothing written', (t) => {
  const rig = folderRig(t);
  assert.equal(localFolderApply(rig.input()).outcome, 'applied');
  writeFileSync(join(rig.root, 'a.txt'), 'the owner kept working\n');
  const before = snapshot(rig.tmp);
  const result = local(undoLocalFolderApply({ backupDir: rig.backupDir }));
  assert.equal(result.outcome, 'refused');
  assert.equal(result.code, 'UNDO_FOLDER_CHANGED');
  assert.deepEqual(result.files, ['a.txt']);
  assert.deepEqual(changed(before, snapshot(rig.tmp)), []);
  assert.equal(rig.record().state, 'applied');
});

test('folder: killed midway after the intent record: reconcile finishes only the known writes, never repeats one', (t) => {
  const rig = folderRig(t);
  const before = snapshot(rig.tmp);
  crash(t, 'localFolderApply', rig.input(), 'afterWrite', 1);
  assert.equal(rig.record().state, 'applying', 'the intent was recorded before the first write');
  assert.equal(rig.read('a.txt'), 'alpha, changed\n');
  assert.equal(rig.read('b.txt'), ORIGINAL['b.txt']);
  // The same apply is never started again over an open intent.
  assert.throws(() => localFolderApply(rig.input()), /applying: reconcile it, never run it again/);
  const written = [];
  const result = local(reconcileLocalFolderApply({ backupDir: rig.backupDir, hooks: { afterWrite: (path) => written.push(path) } }));
  assert.equal(result.outcome, 'applied', result.reason);
  assert.deepEqual(written, ['b.txt', 'new/dir/c.txt', 'gone.txt'], 'the first write is not repeated');
  rig.asResult();
  const again = local(reconcileLocalFolderApply({ backupDir: rig.backupDir, hooks: { afterWrite: (path) => written.push(path) } }));
  assert.equal(again.outcome, 'applied');
  assert.equal(written.length, 3, 'a second reconcile writes nothing');
  onlyUnder(before, snapshot(rig.tmp), ['folder', 'backups']);
});

test('folder: killed right after the intent record: proven not done, then the same apply may run once', (t) => {
  const rig = folderRig(t);
  crash(t, 'localFolderApply', rig.input(), 'afterIntent', 1);
  assert.equal(rig.record().state, 'applying');
  assert.deepEqual(snapshot(rig.root), rig.original);
  const result = local(reconcileLocalFolderApply({ backupDir: rig.backupDir }));
  assert.equal(result.outcome, 'not-done');
  assert.equal(rig.record().state, 'backup-complete');
  assert.equal(local(localFolderApply(rig.input())).outcome, 'applied');
  rig.asResult();
});

test('folder: a crash, then the owner edits a pending file: reconcile stops, writes nothing, keeps the backup', (t) => {
  const rig = folderRig(t);
  crash(t, 'localFolderApply', rig.input(), 'afterWrite', 1);
  writeFileSync(join(rig.root, 'b.txt'), 'the owner, after the crash\n');
  const before = snapshot(rig.tmp);
  const result = local(reconcileLocalFolderApply({ backupDir: rig.backupDir }));
  assert.equal(result.outcome, 'stopped');
  assert.deepEqual(result.files, ['b.txt']);
  assert.deepEqual(changed(before, snapshot(rig.tmp)).filter((key) => !key.startsWith('backups/')), [], 'the folder is not written');
  assert.ok(existsSync(join(rig.backupDir, 'before', '0')), 'the backup is kept');
});

test('folder: a crash during a rollback is finished by reconcile', (t) => {
  const rig = folderRig(t);
  // The child fails its second write, so it rolls back, and is killed after the first restore.
  const dir = sandbox(t, 'aiworks-release-local-crash-');
  const script = join(dir, 'crash.mjs');
  writeFileSync(script, [
    "import { pathToFileURL } from 'node:url';",
    'const adapters = await import(pathToFileURL(process.argv[2]));',
    'const input = JSON.parse(process.argv[3]);',
    'let writes = 0;',
    "input.hooks = { afterWrite: () => { writes += 1; if (writes === 2) throw new Error('fail'); }, afterRestore: () => process.exit(70) };",
    'adapters.localFolderApply(input);',
  ].join('\n'));
  const child = spawnSync(process.execPath, [script, MODULE, JSON.stringify(rig.input())], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 70, child.stderr);
  assert.equal(rig.record().state, 'rolling-back');
  const result = local(reconcileLocalFolderApply({ backupDir: rig.backupDir }));
  assert.equal(result.outcome, 'rolled-back');
  assert.deepEqual(snapshot(rig.root), rig.original);
});

test('folder: symlink, junction, nested repository, hard link and outside paths are refused, nothing written', (t) => {
  const rig = folderRig(t);
  mkdirSync(join(rig.tmp, 'outside'));
  // A junction needs no privilege on Windows; on Linux the type is ignored and a directory symlink is made.
  symlinkSync(join(rig.tmp, 'outside'), join(rig.root, 'junction'), 'junction');
  mkdirSync(join(rig.root, 'nested', '.git'), { recursive: true });
  writeFileSync(join(rig.root, 'nested', 'n.txt'), 'nested\n');
  linkSync(join(rig.root, 'a.txt'), join(rig.root, 'hard.txt'));
  // A file symbolic link needs Developer Mode or elevation on Windows. Where it cannot be made, the junction and the
  // directory cases still run; the refusal rule is the same lstat check for both.
  let fileLink = true;
  try { symlinkSync(join(rig.tmp, 'elsewhere', 'other.txt'), join(rig.root, 'link.txt'), 'file'); } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    fileLink = false;
  }
  const cases = [
    ['../elsewhere/other.txt', 'outside the folder'],
    ['keep/../../elsewhere/other.txt', 'outside the folder'],
    [join(rig.tmp, 'elsewhere', 'other.txt'), 'outside the folder'],
    ['C:/Windows/x.txt', 'outside the folder'],
    ['/etc/x.txt', 'outside the folder'],
    ['junction/x.txt', 'a link or junction on the way'],
    ['junction', 'a link or junction'],
    ['nested/n.txt', 'inside a nested repository'],
    ['hard.txt', 'a hard link'],
    ['.git/config', 'a .git or secret-like path'],
    ['.env', 'a .git or secret-like path'],
    ['keep', 'not a regular file'],
    ...(fileLink ? [['link.txt', 'a link or junction']] : []),
  ];
  const before = snapshot(rig.tmp);
  for (const [path, reason] of cases) {
    const result = local(localFolderApply({ id: 'apply-1', targetRoot: rig.root, backupDir: rig.backupDir, changes: [{ path, before: null, after: 'x' }] }));
    assert.equal(result.outcome, 'refused', path);
    assert.equal(result.code, 'APPLY_PATH_REFUSED', path);
    assert.deepEqual(result.files, [{ path, reason }], path);
  }
  // One refused path refuses the whole result.
  const mixed = localFolderApply({ id: 'apply-1', targetRoot: rig.root, backupDir: rig.backupDir, changes: [...rig.changes, { path: 'junction/x.txt', before: null, after: 'x' }] });
  assert.equal(mixed.outcome, 'refused');
  // The folder itself must not be a link, and the backup may not be inside it.
  symlinkSync(rig.root, join(rig.tmp, 'folder-link'), 'junction');
  assert.equal(localFolderApply(rig.input({ targetRoot: join(rig.tmp, 'folder-link') })).outcome, 'refused');
  const linked = snapshot(rig.tmp);
  assert.throws(() => localFolderApply(rig.input({ backupDir: join(rig.root, 'backup') })), /must not contain each other/);
  assert.deepEqual(changed(before, linked).filter((key) => key !== 'folder-link'), [], 'nothing was written');
  assert.deepEqual(changed(linked, snapshot(rig.tmp)), []);
  assert.ok(fileLink || process.platform === 'win32');
});

test('folder: two paths that are one file on Windows are refused there', { skip: process.platform !== 'win32' && 'case folding applies to Windows folders only' }, (t) => {
  const rig = folderRig(t);
  const result = localFolderApply({ id: 'apply-1', targetRoot: rig.root, backupDir: rig.backupDir, changes: [
    { path: 'a.txt', before: sha256(ORIGINAL['a.txt']), after: 'one' }, { path: 'A.TXT', before: sha256(ORIGINAL['a.txt']), after: 'two' }] });
  assert.equal(result.outcome, 'refused');
  assert.deepEqual(result.files, [{ path: 'A.TXT', reason: 'the same file as a.txt' }]);
});

// ---- Local Git ----

const run = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const commit = (root, message, files) => {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', message);
  return run(root, 'rev-parse', 'HEAD');
};

/**
 * An owner repository on `main` with no remote, a candidate repository (standing in for AIWorks's mirror) holding one
 * verified commit on top, and a Git command line that logs every call, and fails one whose arguments include FAIL_ARG.
 */
function gitRig(t) {
  const tmp = sandbox(t, 'aiworks-release-local-git-');
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  run(repo, 'init', '-q', '-b', 'main');
  run(repo, 'config', 'core.autocrlf', 'false');
  const baseline = commit(repo, 'baseline', { 'README.md': 'version 1\n', 'notes.txt': 'notes\n' });
  const mirror = join(tmp, 'mirror');
  run(tmp, 'clone', '-q', '--no-local', repo, mirror);
  run(mirror, 'config', 'core.autocrlf', 'false');
  const verified = commit(mirror, 'verified result', { 'README.md': 'version 2\n', 'added.txt': 'new\n' });
  const tools = sandbox(t, 'aiworks-release-local-tools-');
  const log = join(tools, 'git-calls.jsonl');
  const wrapper = join(tools, 'git-logger.mjs');
  writeFileSync(wrapper, [
    "import { spawnSync } from 'node:child_process';",
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');`,
    'if (process.env.FAIL_ARG && args.includes(process.env.FAIL_ARG)) { process.stderr.write("refused by the test\\n"); process.exit(1); }',
    "const result = spawnSync('git', args, { stdio: 'inherit', windowsHide: true });",
    'process.exit(result.status ?? 1);',
  ].join('\n'));
  const git = [process.execPath, wrapper];
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const backupDir = join(tmp, 'backups', 'apply-1');
  const gitEnv = { GIT_CEILING_DIRECTORIES: tmp };
  const input = (extra = {}) => ({ id: 'apply-1', repoRoot: repo, branch: 'main', baseline, verifiedSha: verified, source: mirror, backupDir, git, gitEnv, ...extra });
  const head = () => run(repo, 'rev-parse', 'refs/heads/main');
  const status = () => run(repo, 'status', '--porcelain');
  return { tmp, repo, mirror, baseline, verified, git, gitEnv, calls, backupDir, input, head, status,
    record: () => JSON.parse(readFileSync(join(backupDir, 'apply.json'), 'utf8')) };
}

/** No Git call that could lose owner work: no reset other than --keep, no rebase, no non-fast-forward merge. */
function neverResets(calls) {
  for (const args of calls) {
    assert.ok(!args.includes('rebase'), args.join(' '));
    if (args.includes('merge')) assert.ok(args.includes('--ff-only'), args.join(' '));
    if (args.includes('reset')) assert.ok(args.includes('--keep') && !args.includes('--hard'), args.join(' '));
    assert.ok(!args.includes('push') && !args.includes('--force'), args.join(' '));
  }
}

test('git: owner edited the target: refused, nothing written', (t) => {
  const rig = gitRig(t);
  writeFileSync(join(rig.repo, 'notes.txt'), 'uncommitted owner work\n');
  const before = snapshot(rig.tmp);
  const dirty = local(localGitApply(rig.input()));
  assert.equal(dirty.outcome, 'refused');
  assert.equal(dirty.code, 'APPLY_TREE_DIRTY');
  assert.deepEqual(dirty.files, ['notes.txt']);
  assert.deepEqual(changed(before, snapshot(rig.tmp)), [], 'nothing at all was written, inside .git or out');
  run(rig.repo, 'checkout', '-q', '--', 'notes.txt');
  const owner = commit(rig.repo, 'owner commit', { 'notes.txt': 'committed owner work\n' });
  const moved = snapshot(rig.tmp);
  const result = local(localGitApply(rig.input()));
  assert.equal(result.outcome, 'refused');
  assert.equal(result.code, 'APPLY_BRANCH_CHANGED');
  assert.equal(rig.head(), owner);
  assert.deepEqual(changed(moved, snapshot(rig.tmp)), []);
});

test('git: apply fetches the result from the mirror, backs up, fast-forwards, and Undo apply moves the branch back', (t) => {
  const rig = gitRig(t);
  const before = snapshot(rig.tmp);
  const result = local(localGitApply(rig.input()));
  assert.equal(result.outcome, 'applied', result.reason);
  assert.equal(result.head, rig.verified);
  assert.equal(rig.head(), rig.verified);
  assert.equal(rig.status(), '');
  assert.equal(readFileSync(join(rig.repo, 'added.txt'), 'utf8'), 'new\n');
  assert.equal(run(rig.repo, 'rev-parse', `${APPLY_BACKUP_PREFIX}apply-1`), rig.baseline, 'the backup ref is at the baseline');
  assert.equal(run(rig.repo, 'rev-list', '--count', 'HEAD'), '2', 'fast-forward: no merge commit');
  onlyUnder(before, snapshot(rig.tmp), ['repo', 'backups']);
  const undone = local(undoLocalGitApply({ backupDir: rig.backupDir, git: rig.git, gitEnv: rig.gitEnv }));
  assert.equal(undone.outcome, 'rolled-back');
  assert.equal(rig.head(), rig.baseline);
  assert.equal(rig.status(), '');
  assert.equal(existsSync(join(rig.repo, 'added.txt')), false);
  assert.equal(readFileSync(join(rig.repo, 'README.md'), 'utf8'), 'version 1\n');
  onlyUnder(before, snapshot(rig.tmp), ['repo', 'backups']);
  neverResets(rig.calls());
});

test('git: a branch that is not checked out moves by ref only and the working tree is untouched', (t) => {
  const rig = gitRig(t);
  run(rig.repo, 'checkout', '-q', '-b', 'work');
  writeFileSync(join(rig.repo, 'scratch.txt'), 'owner scratch on another branch\n');
  const tree = snapshot(rig.repo);
  const result = local(localGitApply(rig.input()));
  assert.equal(result.outcome, 'applied', result.reason);
  assert.equal(rig.head(), rig.verified);
  assert.equal(run(rig.repo, 'symbolic-ref', 'HEAD'), 'refs/heads/work');
  const files = (map) => [...map].filter(([key]) => key !== '.git' && !key.startsWith('.git/'));
  assert.deepEqual(files(snapshot(rig.repo)), files(tree), 'the working tree is untouched');
  assert.equal(local(undoLocalGitApply({ backupDir: rig.backupDir, git: rig.git, gitEnv: rig.gitEnv })).outcome, 'rolled-back');
  assert.equal(rig.head(), rig.baseline);
});

test('git: local git apply is fast-forward only and never resets owner work', (t) => {
  const rig = gitRig(t);
  // A result that does not build on the baseline is refused.
  run(rig.mirror, 'checkout', '-q', '-b', 'side', rig.baseline);
  run(rig.mirror, 'commit', '-q', '--amend', '-m', 'rewritten baseline');
  const rewritten = run(rig.mirror, 'rev-parse', 'HEAD');
  const refused = local(localGitApply(rig.input({ verifiedSha: rewritten })));
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.code, 'APPLY_NOT_FAST_FORWARD');
  assert.equal(rig.head(), rig.baseline);
  assert.equal(spawnSync('git', ['-C', rig.repo, 'rev-parse', '--verify', '-q', `${APPLY_BACKUP_PREFIX}apply-1`]).status, 1, 'no backup ref');
  assert.equal(existsSync(rig.backupDir), false);
  // After an apply, the owner commits on top: Undo apply refuses and moves nothing.
  assert.equal(localGitApply(rig.input()).outcome, 'applied');
  const owner = commit(rig.repo, 'owner work on top', { 'notes.txt': 'owner\n' });
  const undo = local(undoLocalGitApply({ backupDir: rig.backupDir, git: rig.git, gitEnv: rig.gitEnv }));
  assert.equal(undo.outcome, 'refused');
  assert.equal(undo.code, 'UNDO_BRANCH_CHANGED');
  assert.equal(rig.head(), owner, "the owner's commit stays");
  // A dirty tree on the result refuses too.
  run(rig.repo, 'reset', '-q', '--hard', rig.verified);
  writeFileSync(join(rig.repo, 'README.md'), 'owner edit\n');
  assert.equal(undoLocalGitApply({ backupDir: rig.backupDir, git: rig.git, gitEnv: rig.gitEnv }).outcome, 'refused');
  assert.equal(readFileSync(join(rig.repo, 'README.md'), 'utf8'), 'owner edit\n');
  neverResets(rig.calls());
});

test('git: a failure mid-apply rolls back to the backup', (t) => {
  const rig = gitRig(t);
  const result = local(localGitApply(rig.input({ gitEnv: { ...rig.gitEnv, FAIL_ARG: '--ff-only' } })));
  assert.equal(result.outcome, 'rolled-back');
  assert.match(result.reason, /fast-forward failed/);
  assert.equal(rig.head(), rig.baseline);
  assert.equal(rig.status(), '');
  assert.equal(rig.record().state, 'rolled-back');
  neverResets(rig.calls());
});

test('git: the tree changed by someone else during apply: stop, backup kept, never reset', (t) => {
  const rig = gitRig(t);
  const hooks = { afterApply: () => writeFileSync(join(rig.repo, 'README.md'), 'owner, meanwhile\n') };
  const result = local(localGitApply(rig.input({ hooks })));
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.code, 'APPLY_BRANCH_CHANGED');
  assert.equal(rig.head(), rig.verified, 'the branch is not moved over the owner work');
  assert.equal(readFileSync(join(rig.repo, 'README.md'), 'utf8'), 'owner, meanwhile\n');
  assert.equal(run(rig.repo, 'rev-parse', `${APPLY_BACKUP_PREFIX}apply-1`), rig.baseline, 'the backup ref is kept');
  assert.equal(rig.record().state, 'stopped');
  neverResets(rig.calls());
});

test('git: a crash after the intent record is reconciled from the branch head and never repeated', (t) => {
  const rig = gitRig(t);
  const before = snapshot(rig.tmp);
  const input = rig.input();
  crash(t, 'localGitApply', input, 'afterApply', 1);
  assert.equal(rig.record().state, 'applying');
  assert.equal(rig.head(), rig.verified);
  assert.throws(() => localGitApply(input), /applying: reconcile it, never run it again/);
  const calls = rig.calls().length;
  const result = local(reconcileLocalGitApply({ backupDir: rig.backupDir, git: rig.git, gitEnv: rig.gitEnv }));
  assert.equal(result.outcome, 'applied');
  assert.equal(local(reconcileLocalGitApply({ backupDir: rig.backupDir, git: rig.git, gitEnv: rig.gitEnv })).outcome, 'applied');
  const later = rig.calls().slice(calls);
  assert.ok(later.length > 0, 'reconcile read the branch');
  assert.deepEqual(later.filter((args) => args.includes('merge') || args.includes('update-ref') || args.includes('reset')), [], 'reconcile only reads');
  onlyUnder(before, snapshot(rig.tmp), ['repo', 'backups']);
});

test('git: killed right after the intent record: proven not done, then the same apply may run once', (t) => {
  const rig = gitRig(t);
  crash(t, 'localGitApply', rig.input(), 'afterIntent', 1);
  assert.equal(rig.record().state, 'applying');
  assert.equal(rig.head(), rig.baseline);
  const result = local(reconcileLocalGitApply({ backupDir: rig.backupDir, git: rig.git, gitEnv: rig.gitEnv }));
  assert.equal(result.outcome, 'not-done');
  assert.equal(local(localGitApply(rig.input())).outcome, 'applied');
  assert.equal(rig.head(), rig.verified);
  // Owner work after a crash is never reset: a head that is neither stops for the owner.
  const other = gitRig(t);
  crash(t, 'localGitApply', other.input(), 'afterIntent', 1);
  const owner = commit(other.repo, 'owner commit after the crash', { 'notes.txt': 'owner\n' });
  const stopped = local(reconcileLocalGitApply({ backupDir: other.backupDir, git: other.git, gitEnv: other.gitEnv }));
  assert.equal(stopped.outcome, 'stopped');
  assert.equal(other.head(), owner);
  neverResets([...rig.calls(), ...other.calls()]);
});

test('git: outside paths are refused: a subfolder of the repository, a link to it, a backup inside it', (t) => {
  const rig = gitRig(t);
  mkdirSync(join(rig.repo, 'sub'));
  const before = snapshot(rig.tmp);
  const sub = local(localGitApply(rig.input({ repoRoot: join(rig.repo, 'sub') })));
  assert.equal(sub.outcome, 'refused');
  assert.equal(sub.code, 'APPLY_PATH_REFUSED');
  assert.throws(() => localGitApply(rig.input({ backupDir: join(rig.repo, '.git', 'aiworks') })), /must not contain each other/);
  assert.deepEqual(changed(before, snapshot(rig.tmp)), []);
  symlinkSync(rig.repo, join(rig.tmp, 'repo-link'), 'junction');
  assert.equal(lstatSync(join(rig.tmp, 'repo-link')).isSymbolicLink(), true);
  assert.equal(local(localGitApply(rig.input({ repoRoot: join(rig.tmp, 'repo-link') }))).outcome, 'refused');
  assert.equal(rig.head(), rig.baseline);
});

test('no pull request or merge state is ever reported for a local project', (t) => {
  const folder = folderRig(t);
  const repo = gitRig(t);
  const results = [
    localFolderApply(folder.input()), undoLocalFolderApply({ backupDir: folder.backupDir }), reconcileLocalFolderApply({ backupDir: folder.backupDir }),
    localGitApply(repo.input()), reconcileLocalGitApply({ backupDir: repo.backupDir, git: repo.git, gitEnv: repo.gitEnv }),
    undoLocalGitApply({ backupDir: repo.backupDir, git: repo.git, gitEnv: repo.gitEnv }),
  ];
  for (const result of results) {
    local(result);
    assert.ok(['local-folder-apply', 'local-git-apply'].includes(result.kind));
  }
  for (const record of [folder.record(), repo.record()]) for (const key of Object.keys(record)) assert.doesNotMatch(key, NO_PR);
});
