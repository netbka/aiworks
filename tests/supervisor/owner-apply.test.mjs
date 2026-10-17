// STA18 (WORK_ENVELOPE slice E13, section 8.6): the owner applies a verified local result, and can undo it. Apply runs
// only on the owner route (the dashboard's caller check); a rescan against the baseline's manifest refuses any change
// to a path the result touches and writes nothing; the backup is recorded before the first write; Undo apply restores
// the folder byte for byte and refuses over a file changed since; a crash midway is reconciled, never repeated; no
// release record or grant is created and nothing calls gh. Real temporary folders, disposable Git repositories, a
// logging git wrapper and a synthetic process lookup: no network, model or GitHub call. A crash is a real child process
// that exits at a chosen point. The caller check names its platform explicitly, so every test runs on Windows and
// Linux; none is skipped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/supervisor/store.mjs';
import { MIRROR_REPO, SNAPSHOT_DIR } from '../../src/supervisor/adapters/mirror.mjs';
import { recordCandidate } from '../../src/supervisor/local-candidates.mjs';
import { connectFolderProject, connectLocalGitProject } from '../../src/supervisor/project-connect.mjs';
import { projects } from '../../src/supervisor/projects.mjs';
import { APPLY_BACKUP_PREFIX } from '../../src/supervisor/release/local-apply.mjs';
import { ownerApplies, ownerApply, OwnerApplyError, reconcileOwnerApplies, undoOwnerApply } from '../../src/supervisor/release/owner-apply.mjs';

const GOVERNANCE = fileURLToPath(new URL('../fixtures/governance', import.meta.url));
const MODULE = fileURLToPath(new URL('../../src/supervisor/release/owner-apply.mjs', import.meta.url));
const STORE_MODULE = fileURLToPath(new URL('../../src/supervisor/store.mjs', import.meta.url));
const CAMPAIGN = 'owner-apply';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const NO_PR = /[Pp]ull|[Mm]erge|^pr(?:[A-Z_]|$)/;

const run = (cwd, args, { input, env = {} } = {}) => {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const owner = ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid'];

function write(root, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
}

/** Every file and directory under `root`, links not followed, with each file's hash. */
function snapshot(root) {
  const seen = {};
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) seen[key] = 'link';
      else if (entry.isDirectory()) { seen[key] = 'dir'; walk(join(dir, entry.name), key); }
      else seen[key] = sha256(readFileSync(join(dir, entry.name)));
    }
  };
  walk(root, '');
  return seen;
}

/** A local result never reports a pull request or merge state. */
function local(result) {
  for (const key of Object.keys(result)) assert.doesNotMatch(key, NO_PR, `a local result has no ${key}`);
  return result;
}

/**
 * A commit on top of `parent` in a repository AIWorks owns (the copy or the mirror), written with a temporary index so
 * nothing is checked out: `files` maps a path to its new bytes, or to null to delete it; `links` adds symbolic links.
 */
function candidateCommit(repo, parent, { files = {}, links = {} }, tmp) {
  const env = { GIT_INDEX_FILE: join(tmp, `index-${process.hrtime.bigint()}`) };
  run(repo, ['read-tree', parent], { env });
  for (const [path, bytes] of Object.entries(files)) {
    if (bytes === null) { run(repo, ['update-index', '--force-remove', path], { env }); continue; }
    const blob = run(repo, ['hash-object', '-w', '--stdin'], { input: bytes });
    run(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
  }
  for (const [path, target] of Object.entries(links)) {
    const blob = run(repo, ['hash-object', '-w', '--stdin'], { input: target });
    run(repo, ['update-index', '--add', '--cacheinfo', `120000,${blob},${path}`], { env });
  }
  const tree = run(repo, ['write-tree'], { env });
  const sha = run(repo, [...owner, 'commit-tree', tree, '-p', parent, '-m', 'the verified result']);
  run(repo, ['update-ref', `refs/heads/aiworks/task/${sha.slice(0, 12)}`, sha]);
  return sha;
}

/** The dashboard's caller check, answered by a synthetic process lookup (local-admission.mjs checkCaller). */
const OWNER = Object.freeze({ platform: 'win32', lookup: async () => ({ pid: 999_991, ancestors: [999_990], jobs: [] }) });
const FROM_AIWORKS = Object.freeze({ platform: 'win32', lookup: async () => ({ pid: 999_992, ancestors: [process.pid], jobs: [] }) });
const NO_LOOKUP = Object.freeze({ platform: 'win32' });
const OTHER_PLATFORM = Object.freeze({ platform: 'linux', lookup: OWNER.lookup });

let requests = 0;
const nextRequest = () => `req-${(requests += 1)}`;

/**
 * A connected project (plain folder or local Git) with one verified candidate in the local ledger, a data directory
 * beside it and a git command line that logs every call. `result` is what the verified commit changes.
 */
function rig(t, { kind = 'folder', files, result }) {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiworks-owner-apply-')));
  const root = join(tmp, 'Notes');
  mkdirSync(root);
  write(root, files);
  if (kind === 'local-git') {
    run(root, ['init', '-q', '-b', 'main']);
    // The host's own line-ending setting must not decide what the checkout holds.
    run(root, ['config', 'core.autocrlf', 'false']);
    run(root, ['add', '-A']);
    run(root, [...owner, 'commit', '-q', '-m', 'the owner\'s work']);
  }
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
  const git = [process.execPath, wrapper];
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const gitEnv = { GIT_CEILING_DIRECTORIES: tmp };
  const connect = kind === 'folder' ? connectFolderProject : connectLocalGitProject;
  const connected = connect({ path: root }, { store, dataDir, governanceRoot: GOVERNANCE, git, gitEnv });
  assert.equal(connected.ok, true, connected.message);
  const project = projects(store)[0];
  const repo = join(project.mirror_root, kind === 'folder' ? SNAPSHOT_DIR : MIRROR_REPO);
  const sha = candidateCommit(repo, project.current_baseline.commit, result, tmp);
  const recorded = recordCandidate(store, {
    declaration: { campaignId: CAMPAIGN, target: { projectId: project.id, source: kind, baseline: project.current_baseline } },
    task: { task_id: 'T1', verified_sha: sha, verification: { verdict: 'accepted', summary: 'Independent verification.', checks: [], findings: [] } },
    deliverable: 'commit', now: Date.now(),
  });
  const options = (extra = {}) => ({ campaignId: CAMPAIGN, taskId: 'T1', requestId: nextRequest(), caller: OWNER, dataDir, git, gitEnv, ...extra });
  const apply = (extra) => ownerApply(store, options(extra));
  const undo = (applyId, extra = {}) => undoOwnerApply(store, { applyId, requestId: nextRequest(), caller: OWNER, git, gitEnv, ...extra });
  const appliesDir = join(dataDir, 'applies', project.id);
  return { tmp, root, dataDir, store, git, gitEnv, calls, project, repo, sha, candidate: recorded, options, apply, undo, appliesDir };
}

const FOLDER_FILES = { 'README.md': '# Notes\r\nline two\r\n', 'src/app.js': 'console.log("app");\n', 'old.txt': 'to be deleted\n', 'keep.txt': 'untouched\n' };
const FOLDER_RESULT = { files: { 'README.md': '# Notes\r\nline two\r\nline three\r\n', 'src/search/index.js': 'export const search = () => [];\n', 'old.txt': null } };
const AFTER = { 'README.md': '# Notes\r\nline two\r\nline three\r\n', 'src/search/index.js': 'export const search = () => [];\n' };

/** The folder equals the verified result: written, created and deleted files, everything else untouched. */
function assertApplied(root) {
  for (const [path, content] of Object.entries(AFTER)) assert.equal(readFileSync(join(root, path), 'utf8'), content, `${path} holds the result`);
  assert.equal(existsSync(join(root, 'old.txt')), false, 'the deleted file is gone');
  assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'untouched\n');
}

/** A child process that presses Apply once and exits with code 70 at the first call of `hook`. */
function crash(r, hook) {
  const script = join(r.tmp, `crash-${hook}.mjs`);
  writeFileSync(script, [
    "import { pathToFileURL } from 'node:url';",
    'const [moduleUrl, storeUrl, input, hook] = process.argv.slice(2);',
    'const { ownerApply } = await import(pathToFileURL(moduleUrl).href);',
    'const { Store } = await import(pathToFileURL(storeUrl).href);',
    'const options = JSON.parse(input);',
    'const store = new Store(options.db);',
    'options.caller = { platform: "win32", lookup: async () => ({ pid: 999991, ancestors: [], jobs: [] }) };',
    'options.hooks = { [hook]: () => process.exit(70) };',
    'await ownerApply(store, options);',
    'process.exit(0);',
  ].join('\n'));
  const { caller, ...input } = r.options();
  const result = spawnSync(process.execPath, [script, MODULE, STORE_MODULE, JSON.stringify({ ...input, db: join(r.dataDir, 'supervisor.db') }), hook],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 70, `the child stopped at ${hook}: ${result.stderr}`);
}

const applyRows = (store) => store.all('SELECT * FROM local_applies ORDER BY attempt');
const journal = (store, kind) => store.all('SELECT * FROM journal WHERE kind = ? ORDER BY seq', kind);

test('Apply runs only on the owner route: a request from AIWorks, or one the check cannot place, writes nothing', async (t) => {
  const r = rig(t, { files: FOLDER_FILES, result: FOLDER_RESULT });
  const before = snapshot(r.root);
  for (const [caller, code] of [[FROM_AIWORKS, 'APPLY_FROM_AIWORKS'], [NO_LOOKUP, 'APPLY_UNCHECKED'], [OTHER_PLATFORM, 'APPLY_UNCHECKED'],
    [{ platform: 'win32', lookup: async () => { throw new Error('lookup failed'); } }, 'APPLY_UNCHECKED']]) {
    await assert.rejects(r.apply({ caller }), (error) => error instanceof OwnerApplyError && error.code === code);
  }
  assert.deepEqual(snapshot(r.root), before, 'the folder is byte-identical');
  assert.equal(existsSync(r.appliesDir), false, 'no backup was taken');
  assert.deepEqual(ownerApplies(r.store, CAMPAIGN), [], 'no attempt is recorded');
  // A worker's own process tree: the lookup names an open run's job.
  r.store.insert('operations', { id: 'op-1', campaign_id: CAMPAIGN, task_id: 'T1', kind: 'implement', seq: 1, idempotency_key: 'op-1', lease_generation: 1,
    state: 'dispatched', session_id: 's-1', run_dir: r.tmp, workspace: r.tmp, packet: '{}', packet_digest: 'd', created_at: Date.now(), updated_at: Date.now() });
  writeFileSync(join(r.tmp, 'runner.json'), JSON.stringify({ pid: 999_993, jobName: 'aiworks-run-op-1' }));
  await assert.rejects(r.apply({ caller: { platform: 'win32', lookup: async () => ({ pid: 999_994, ancestors: [], jobs: ['aiworks-run-op-1'] }) } }),
    (error) => error.code === 'APPLY_FROM_AIWORKS');
  assert.deepEqual(snapshot(r.root), before);
  r.store.run("UPDATE operations SET state = 'finished' WHERE id = 'op-1'");
  const result = local(await r.apply());
  assert.equal(result.outcome, 'applied', result.reason);
  assert.equal(result.undo, true, 'the result offers Undo apply');
  assertApplied(r.root);
  const [receipt] = r.store.all('SELECT * FROM local_apply_receipts');
  assert.equal(receipt.caller, 'owner-browser', 'the receipt records the caller check');
});

test('one changed file the result touches refuses with nothing written; a change elsewhere does not', async (t) => {
  const r = rig(t, { files: FOLDER_FILES, result: FOLDER_RESULT });
  writeFileSync(join(r.root, 'README.md'), '# Notes, edited by the owner\n');
  const before = snapshot(r.root);
  const refused = local(await r.apply());
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.code, 'APPLY_FOLDER_CHANGED');
  assert.deepEqual(refused.files, ['README.md'], 'the changed file is named');
  assert.deepEqual(snapshot(r.root), before, 'nothing was written');
  assert.equal(existsSync(r.appliesDir), false, 'no backup was taken either');
  // A file the result creates already exists: also refused.
  writeFileSync(join(r.root, 'README.md'), FOLDER_FILES['README.md']);
  write(r.root, { 'src/search/index.js': 'the owner\'s own search\n' });
  const created = await r.apply();
  assert.equal(created.code, 'APPLY_FOLDER_CHANGED');
  assert.deepEqual(created.files, ['src/search/index.js']);
  rmSync(join(r.root, 'src/search'), { recursive: true });
  // A file the result does not touch may change: the rescan checks only the result's paths.
  writeFileSync(join(r.root, 'keep.txt'), 'the owner kept working\n');
  const applied = await r.apply();
  assert.equal(applied.outcome, 'applied', applied.reason);
  assert.equal(readFileSync(join(r.root, 'keep.txt'), 'utf8'), 'the owner kept working\n');
  assert.equal(applyRows(r.store).length, 1, 'the refused presses took no backup, so the one attempt went on');
});

test('the backup is recorded before the first write, under the data directory', async (t) => {
  const r = rig(t, { files: FOLDER_FILES, result: FOLDER_RESULT });
  const before = snapshot(r.root);
  let seen = null;
  const result = await r.apply({ hooks: { afterIntent: () => {
    const [row] = applyRows(r.store);
    const record = JSON.parse(readFileSync(join(row.backup_dir, 'apply.json'), 'utf8'));
    seen = { state: record.state, folder: snapshot(r.root), backups: record.entries.filter((entry) => entry.backup)
      .map((entry) => [entry.path, sha256(readFileSync(join(row.backup_dir, entry.backup)))]) };
  } } });
  assert.equal(result.outcome, 'applied');
  assert.equal(seen.state, 'applying', 'the intent is recorded before any write');
  assert.deepEqual(seen.folder, before, 'nothing was written before the backup and the intent');
  assert.deepEqual(Object.fromEntries(seen.backups), { 'README.md': before['README.md'], 'old.txt': before['old.txt'] }, 'every changed or deleted file is backed up');
  const [row] = applyRows(r.store);
  assert.ok(row.backup_dir.startsWith(join(r.dataDir, 'applies')), 'the backup lives under AIWorks\'s data directory');
});

test('Undo apply restores the folder byte for byte, and refuses over a file changed since', async (t) => {
  const r = rig(t, { files: FOLDER_FILES, result: FOLDER_RESULT });
  const before = snapshot(r.root);
  const applied = await r.apply();
  assert.equal(applied.outcome, 'applied');
  await assert.rejects(r.undo(applied.applyId, { caller: FROM_AIWORKS }), (error) => error.code === 'APPLY_FROM_AIWORKS');
  assertApplied(r.root);
  const undone = local(await r.undo(applied.applyId));
  assert.equal(undone.outcome, 'rolled-back', undone.reason);
  assert.deepEqual(snapshot(r.root), before, 'the folder is byte for byte as before, created directories removed');
  await assert.rejects(r.undo(applied.applyId), (error) => error.code === 'UNDO_NOT_APPLIED');
  // Apply again is a new attempt with its own backup; the owner then edits an applied file and presses Undo apply.
  const again = await r.apply();
  assert.equal(again.outcome, 'applied');
  assert.notEqual(again.applyId, applied.applyId);
  writeFileSync(join(r.root, 'README.md'), 'the owner, after the apply\n');
  const changed = snapshot(r.root);
  const refused = await r.undo(again.applyId);
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.code, 'UNDO_FOLDER_CHANGED');
  assert.deepEqual(refused.files, ['README.md']);
  assert.deepEqual(snapshot(r.root), changed, 'nothing was written over the owner\'s work');
  assert.equal(existsSync(join(applyRows(r.store)[1].backup_dir, 'before')), true, 'the backup is kept');
});

test('a repeated request is answered, never acted on twice; a request id names one action', async (t) => {
  const r = rig(t, { files: FOLDER_FILES, result: FOLDER_RESULT });
  const first = await r.apply({ requestId: 'press-1' });
  assert.equal(first.outcome, 'applied');
  const after = snapshot(r.root);
  const repeat = await r.apply({ requestId: 'press-1' });
  assert.equal(repeat.applyId, first.applyId);
  assert.equal(repeat.outcome, 'applied');
  const pressedAgain = await r.apply();
  assert.equal(pressedAgain.outcome, 'applied');
  assert.match(pressedAgain.reason, /already applied/);
  assert.deepEqual(snapshot(r.root), after, 'nothing was written again');
  assert.equal(applyRows(r.store).length, 1, 'one attempt, one backup');
  assert.equal(journal(r.store, 'owner-apply-finished').length, 1, 'the adapter ran once');
  assertApplied(r.root);
  await assert.rejects(r.undo(first.applyId, { requestId: 'press-1' }), (error) => error.code === 'APPLY_REQUEST_REUSED');
});

test('a crash after the first write is reconciled from the folder, never repeated', async (t) => {
  const r = rig(t, { files: FOLDER_FILES, result: FOLDER_RESULT });
  const before = snapshot(r.root);
  crash(r, 'afterWrite');
  assert.notDeepEqual(snapshot(r.root), before, 'the crash left the folder half written');
  const [open] = applyRows(r.store);
  assert.equal(JSON.parse(readFileSync(join(open.backup_dir, 'apply.json'), 'utf8')).state, 'applying');
  const result = await r.apply();
  assert.equal(result.outcome, 'applied', result.reason);
  assert.equal(result.applyId, open.apply_id, 'the same attempt was settled, not a new one');
  assert.equal(applyRows(r.store).length, 1, 'one attempt, one backup');
  assert.equal(journal(r.store, 'owner-apply-reconciled').length, 1, 'it was reconciled');
  assertApplied(r.root);
  const undone = await r.undo(result.applyId);
  assert.equal(undone.outcome, 'rolled-back');
  assert.deepEqual(snapshot(r.root), before, 'the backup taken before the crash restores the folder');
});

test('a crash before the first write: reconcile proves it not done, and the next press applies it once', async (t) => {
  const r = rig(t, { files: FOLDER_FILES, result: FOLDER_RESULT });
  const before = snapshot(r.root);
  crash(r, 'afterIntent');
  assert.deepEqual(snapshot(r.root), before);
  const [settled] = reconcileOwnerApplies(r.store, { git: r.git, gitEnv: r.gitEnv });
  assert.equal(settled.outcome, 'not-done', 'reconcile reads the folder and writes nothing new');
  assert.deepEqual(snapshot(r.root), before);
  assert.deepEqual(reconcileOwnerApplies(r.store, { git: r.git, gitEnv: r.gitEnv }).map((row) => row.outcome), ['not-done'],
    'reconcile itself never applies');
  const result = await r.apply();
  assert.equal(result.outcome, 'applied');
  assert.equal(result.applyId, settled.applyId, 'the proven-not-done attempt went on with its own backup');
  assertApplied(r.root);
  assert.deepEqual(reconcileOwnerApplies(r.store, { git: r.git, gitEnv: r.gitEnv }), [], 'nothing is left open');
});

test('a crash, then the owner edits a pending file: reconcile stops, writes nothing and keeps the backup', async (t) => {
  const r = rig(t, { files: FOLDER_FILES, result: FOLDER_RESULT });
  crash(r, 'afterWrite');
  writeFileSync(join(r.root, 'old.txt'), 'the owner, after the crash\n');
  const changed = snapshot(r.root);
  const result = await r.apply();
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.code, 'APPLY_FOLDER_CHANGED');
  assert.deepEqual(result.files, ['old.txt']);
  assert.deepEqual(snapshot(r.root), changed, 'nothing was written over the owner\'s edit');
  assert.equal(existsSync(join(applyRows(r.store)[0].backup_dir, 'before')), true, 'the backup is kept');
});

test('links, junctions and paths outside the folder are refused with nothing written', async (t) => {
  // A link in the result is never written.
  const linked = rig(t, { files: FOLDER_FILES, result: { files: { 'README.md': 'changed\n' }, links: { 'shortcut': 'README.md' } } });
  const before = snapshot(linked.root);
  const refused = await linked.apply();
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.code, 'APPLY_PATH_REFUSED');
  assert.deepEqual(refused.files.map((item) => item.path), ['shortcut']);
  assert.deepEqual(snapshot(linked.root), before);
  // A directory the result writes into is a junction (a directory link elsewhere) to a folder outside the project.
  const outside = rig(t, { files: FOLDER_FILES, result: { files: { 'shared/notes.txt': 'written through a link\n' } } });
  const elsewhere = join(outside.tmp, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(outside.root, 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
  const through = await outside.apply();
  assert.equal(through.outcome, 'refused');
  assert.equal(through.code, 'APPLY_PATH_REFUSED');
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing was written outside the folder');
  assert.equal(existsSync(outside.appliesDir), false, 'no backup was taken');
});

test('Local Git: fast-forward only on the owner route; a dirty tree refuses; Undo apply never resets the owner\'s work', async (t) => {
  const r = rig(t, { kind: 'local-git', files: { 'README.md': 'version 1\n' }, result: { files: { 'README.md': 'version 2\n', 'src/search.js': 'search\n' } } });
  const baseline = run(r.root, ['rev-parse', 'HEAD']);
  await assert.rejects(r.apply({ caller: FROM_AIWORKS }), (error) => error.code === 'APPLY_FROM_AIWORKS');
  writeFileSync(join(r.root, 'README.md'), 'the owner, not committed\n');
  const dirty = await r.apply();
  assert.equal(dirty.outcome, 'refused');
  assert.equal(dirty.code, 'APPLY_TREE_DIRTY');
  assert.equal(run(r.root, ['rev-parse', 'HEAD']), baseline, 'the branch did not move');
  assert.equal(readFileSync(join(r.root, 'README.md'), 'utf8'), 'the owner, not committed\n');
  run(r.root, ['checkout', '--', 'README.md']);
  const applied = local(await r.apply());
  assert.equal(applied.outcome, 'applied', applied.reason);
  assert.equal(run(r.root, ['rev-parse', 'HEAD']), r.sha, 'fast-forwarded to the verified commit');
  assert.equal(run(r.root, ['rev-parse', `${APPLY_BACKUP_PREFIX}${applied.applyId}`]), baseline, 'the backup ref is at the old head');
  assert.equal(readFileSync(join(r.root, 'src/search.js'), 'utf8'), 'search\n');
  assert.ok(!r.calls().some((args) => args.includes('reset') && !args.includes('--keep')), 'no hard reset ever runs');
  const undone = await r.undo(applied.applyId);
  assert.equal(undone.outcome, 'rolled-back', undone.reason);
  assert.equal(run(r.root, ['rev-parse', 'HEAD']), baseline);
  assert.equal(readFileSync(join(r.root, 'README.md'), 'utf8'), 'version 1\n');
  // Apply again, then the owner commits on top: Undo apply refuses and moves nothing.
  const again = await r.apply();
  assert.equal(again.outcome, 'applied');
  writeFileSync(join(r.root, 'notes.txt'), 'the owner\n');
  run(r.root, ['add', '-A']);
  run(r.root, [...owner, 'commit', '-q', '-m', 'the owner\'s next commit']);
  const ownerHead = run(r.root, ['rev-parse', 'HEAD']);
  const refused = await r.undo(again.applyId);
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.code, 'UNDO_BRANCH_CHANGED');
  assert.equal(run(r.root, ['rev-parse', 'HEAD']), ownerHead, 'the owner\'s commit stays');
});

test('Local Git: a crash after the fast-forward is reconciled from the branch head, never repeated', async (t) => {
  const r = rig(t, { kind: 'local-git', files: { 'README.md': 'version 1\n' }, result: { files: { 'README.md': 'version 2\n' } } });
  crash(r, 'afterApply');
  assert.equal(run(r.root, ['rev-parse', 'HEAD']), r.sha, 'the crash came after the fast-forward');
  const merges = () => r.calls().filter((args) => args.includes('merge') && args.includes('--ff-only')).length;
  assert.equal(merges(), 1);
  const result = await r.apply();
  assert.equal(result.outcome, 'applied', result.reason);
  assert.equal(journal(r.store, 'owner-apply-reconciled').length, 1);
  assert.equal(merges(), 1, 'the fast-forward never ran again');
  assert.equal(applyRows(r.store).length, 1);
});

test('no release record, grant or GitHub call: Apply is an owner action under Review only', async (t) => {
  const r = rig(t, { files: FOLDER_FILES, result: FOLDER_RESULT });
  const applied = await r.apply();
  assert.equal(applied.outcome, 'applied');
  await r.undo(applied.applyId);
  assert.equal(r.store.get('SELECT count(*) AS n FROM releases').n, 0, 'no release record');
  assert.equal(r.store.get('SELECT count(*) AS n FROM release_locks').n, 0, 'no destination lock');
  assert.equal(r.store.get("SELECT 1 AS present FROM sqlite_master WHERE name = 'release_modes'"), null, 'no release mode was set');
  const everything = [];
  const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { everything.push(entry.name); if (entry.isDirectory()) walk(join(dir, entry.name)); } };
  walk(r.dataDir);
  assert.ok(!everything.some((name) => /grant|credential|RELEASE-STOP/i.test(name)), 'no grant or credential file');
  assert.equal(r.store.all("SELECT kind FROM journal WHERE kind LIKE 'release%'").length, 0, 'no release event');
  for (const args of r.calls()) {
    assert.ok(!['push', 'ls-remote', 'remote', 'clone'].some((verb) => args.includes(verb)), `no remote Git call: ${args.join(' ')}`);
    assert.ok(!args.some((arg) => /^(https?|ssh|git):\/\//.test(arg) || /^[^/\\]+@[^:]+:/.test(arg)), `no URL: ${args.join(' ')}`);
  }
  // The module cannot reach GitHub or a release: it imports neither, and runs no gh.
  const source = readFileSync(MODULE, 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(([, from]) => from);
  assert.deepEqual(imports.filter((from) => /github|credential|authorization|eligibility|\/state\.mjs|runner\.mjs|classify|^\.\/state|^\.\/runner/.test(from)), []);
  assert.doesNotMatch(source, /['"]gh['"]|fetch\(|node:https?|node:net/, 'no gh, HTTP or socket');
  for (const key of Object.keys(applied)) assert.doesNotMatch(key, /release|grant/i, `no ${key} in the result`);
});

test('only an independently verified commit result of a recorded baseline is applied', async (t) => {
  const r = rig(t, { files: FOLDER_FILES, result: FOLDER_RESULT });
  const before = snapshot(r.root);
  recordCandidate(r.store, {
    declaration: { campaignId: CAMPAIGN, target: { projectId: r.project.id, source: 'folder', baseline: r.project.current_baseline } },
    task: { task_id: 'T2', verified_sha: r.sha, verification: { verdict: 'accepted' }, result: { report: 'notes' } }, deliverable: 'report', now: Date.now(),
  });
  await assert.rejects(r.apply({ taskId: 'T2' }), (error) => error.code === 'APPLY_NOTHING');
  recordCandidate(r.store, {
    declaration: { campaignId: CAMPAIGN, target: { projectId: r.project.id, source: 'folder', baseline: { seq: 9, commit: r.project.current_baseline.commit } } },
    task: { task_id: 'T3', verified_sha: r.sha, verification: { verdict: 'accepted' } }, deliverable: 'commit', now: Date.now(),
  });
  await assert.rejects(r.apply({ taskId: 'T3' }), (error) => error.code === 'APPLY_BASELINE_UNKNOWN');
  await assert.rejects(r.apply({ taskId: 'T9' }), (error) => error.code === 'APPLY_NO_CANDIDATE');
  assert.deepEqual(snapshot(r.root), before);
});
