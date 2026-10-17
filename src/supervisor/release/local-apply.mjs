// The local apply adapters: write one verified result into the owner's local Git repository or plain folder, with a
// backup first and a way back (docs/design/AUTO_RELEASE.md sections 7.5 and 8, slice R8; plan slice REL8). A library:
// the owner's Apply (slice STA18, docs/design/WORK_ENVELOPE.md section 8.6) is its first caller. It holds no release
// grant, creates no release record, starts no Auto Release (that waits for example-org/aiworks#33) and makes no network
// or GitHub call. Every run follows the same order:
// 1. rescan: every path the result writes or deletes must still be as the baseline says, else refused, nothing written;
// 2. backup: Local Git, a ref at the current head; plain folder, a copy of every file that will change or be deleted,
//    with a manifest of paths and hashes, in `backupDir` (outside the target). Recorded in `<backupDir>/apply.json`;
// 3. intent: the record says `applying` before the first write;
// 4. apply: Local Git, fast-forward only; plain folder, a temporary file in the same directory renamed over the target,
//    deletions last;
// 5. confirm: every path equals the result, else roll back to the backup;
// 6. rollback and undo: only where the target still equals what the apply wrote. Anything else is someone else's work:
//    stop, keep the backup and name the files, never write over it;
// 7. reconcile: an apply left open by a crash is settled by reading the target, never by running it again blindly.
// Nothing is written outside the target and `backupDir`. No result reports a pull request or merge state: a local
// project has neither (docs/PROJECT_WORKSPACE_PLAN.md, #8).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync,
  unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { writeAtomic } from '../proc.mjs';
import { SECRET_LIKE_PATH_PATTERN } from '../../../scripts/lib/worker-context.mjs';

export const LOCAL_GIT_APPLY = 'local-git-apply';
export const LOCAL_FOLDER_APPLY = 'local-folder-apply';
/** The owner's Apply keeps its backup ref here (WORK_ENVELOPE.md 8.6); a future Auto Release passes RELEASE_BACKUP_PREFIX. */
export const APPLY_BACKUP_PREFIX = 'refs/aiworks/apply-backup/';
export const RELEASE_BACKUP_PREFIX = 'refs/aiworks/release-backup/';
const RECORD = 'apply.json';
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])(?<!\.lock)$/;
const SECRET_LIKE_PATH = new RegExp(SECRET_LIKE_PATH_PATTERN, 'u');
const FINAL = Object.freeze(['applied', 'rolled-back', 'stopped']);

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const canonical = (path) => {
  let real;
  try { real = realpathSync.native(path); } catch { real = resolve(path); }
  const slashed = real.replaceAll('\\', '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
};
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
const apart = (a, b) => !inside(canonical(a), canonical(b)) && !inside(canonical(b), canonical(a));
const lstat = (path) => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

/** The current SHA-256 of one file, or null when it is absent. */
const hashOf = (path) => { try { return sha256(readFileSync(path)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

/** Write bytes durably: open, write, flush, close. */
function writeDurable(path, bytes) {
  const fd = openSync(path, 'w');
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

const readRecord = (backupDir) => {
  const path = join(backupDir, RECORD);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};
const save = (backupDir, record) => writeAtomic(join(backupDir, RECORD), JSON.stringify(record, null, 2));

/** What a caller is told. Never a pull request or merge field. */
const told = (record, outcome, extra = {}) => ({ kind: record.kind, id: record.id, outcome, state: record.state, backupDir: record.backupDir, ...extra });
const refused = (kind, id, code, files, reason) => ({ kind, id, outcome: 'refused', state: null, code, files, reason });

function named(id, backupDir) {
  if (!ID.test(id ?? '')) throw new TypeError('an apply id is a plain name');
  if (typeof backupDir !== 'string' || !isAbsolute(backupDir)) throw new TypeError('an apply needs an absolute backup directory');
}

// ---- Plain folder (local-folder-apply) ----

/**
 * Why one relative path may not be written in `root`, or null. Refused: anything not a plain relative path, a path
 * that leaves the folder, a `.git` or secret-like path, a link or junction anywhere on the way (lstat only, so none is
 * followed; Node reports a junction as a symbolic link on Windows), a nested repository, a hard link (a conflict class,
 * PROJECT_CONNECTION.md 4.3), and anything that is not a regular file.
 */
function pathRefusal(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 4096 || rel.includes('\0')) return 'not a relative file path';
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || /^[\\/]/.test(rel)) return 'outside the folder';
  const parts = rel.split(/[\\/]/);
  if (parts.some((part) => part === '..')) return 'outside the folder';
  if (parts.some((part) => part === '' || part === '.')) return 'not a relative file path';
  if (process.platform === 'win32' && parts.some((part) => /[:<>"|?*]|[ .]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) {
    return 'not a file name Windows keeps as written';
  }
  if (SECRET_LIKE_PATH.test(parts.join('/'))) return 'a .git or secret-like path';
  const target = join(root, ...parts);
  if (!inside(resolve(target).replaceAll('\\', '/'), resolve(root).replaceAll('\\', '/'))) return 'outside the folder';
  for (let depth = 1; depth < parts.length; depth += 1) {
    const dir = join(root, ...parts.slice(0, depth));
    const stat = lstat(dir);
    if (!stat) break;
    if (stat.isSymbolicLink()) return 'a link or junction on the way';
    if (!stat.isDirectory()) return 'a file stands where a directory is needed';
    if (lstat(join(dir, '.git'))) return 'inside a nested repository';
  }
  const stat = lstat(target);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return 'a link or junction';
  if (!stat.isFile()) return 'not a regular file';
  if (stat.nlink > 1) return 'a hard link';
  return null;
}

/** The directories a write would create, outermost first. */
function missingDirs(root, rel) {
  const parts = rel.split(/[\\/]/);
  const missing = [];
  for (let depth = 1; depth < parts.length; depth += 1) {
    const dir = parts.slice(0, depth).join('/');
    if (!lstat(join(root, dir))) missing.push(dir);
  }
  return missing;
}

function folderPlan({ id, targetRoot, backupDir, changes }) {
  named(id, backupDir);
  if (typeof targetRoot !== 'string' || !isAbsolute(targetRoot)) throw new TypeError('a folder apply needs the absolute folder path');
  if (!Array.isArray(changes) || !changes.length) throw new TypeError('a folder apply needs at least one change');
  const entries = changes.map((change, index) => {
    const before = change?.before ?? null;
    const bytes = change?.after === null || change?.after === undefined ? null : Buffer.from(change.after);
    if (before !== null && !HASH.test(before)) throw new TypeError(`change ${index}: before is a SHA-256 or null (absent)`);
    if (before === null && bytes === null) throw new TypeError(`change ${index} deletes a file the baseline does not have`);
    const after = bytes === null ? null : sha256(bytes);
    if (after === before) throw new TypeError(`change ${index} changes nothing`);
    return { path: String(change?.path ?? ''), before, after, bytes };
  });
  return entries;
}

const folderDigest = (record) => sha256(JSON.stringify([record.kind, record.id, canonical(record.targetRoot),
  record.entries.map(({ path, before, after }) => [path, before, after])]));
const at = (record, entry) => join(record.targetRoot, ...entry.path.split(/[\\/]/));
const temp = (record, entry) => join(dirname(at(record, entry)), `.${basename(at(record, entry))}.${sha256(record.id).slice(0, 12)}.aiworks.tmp`);
const removeTemp = (record) => { for (const entry of record.entries) { try { unlinkSync(temp(record, entry)); } catch { /* absent */ } } };

/** Put `bytes` at the entry's path through a temporary file in the same directory, or delete it when `bytes` is null. */
function place(record, entry, bytes) {
  const path = at(record, entry);
  if (bytes === null) { try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } return; }
  mkdirSync(dirname(path), { recursive: true });
  writeDurable(temp(record, entry), bytes);
  renameSync(temp(record, entry), path);
}

/** The hash of every entry's path now: { before, after, other } lists of entries. */
function where(record) {
  const seen = { before: [], after: [], other: [] };
  for (const entry of record.entries) {
    const now = hashOf(at(record, entry));
    seen[now === entry.before ? 'before' : now === entry.after ? 'after' : 'other'].push(entry);
  }
  return seen;
}

const stagedBytes = (record, entry, side) => {
  if (entry[side] === null) return null;
  const bytes = readFileSync(join(record.backupDir, entry[side === 'before' ? 'backup' : 'staged']));
  if (sha256(bytes) !== entry[side]) throw new Error(`the ${side === 'before' ? 'backup' : 'staged result'} of ${entry.path} is damaged`);
  return bytes;
};

/** Write every entry still at its baseline hash, writes first and deletions last; stop at a path someone else changed. */
function forward(record, hooks) {
  record.state = 'applying';
  save(record.backupDir, record);
  hooks.afterIntent?.();
  const ordered = [...record.entries.filter((entry) => entry.after !== null), ...record.entries.filter((entry) => entry.after === null)];
  for (const entry of ordered) {
    const now = hashOf(at(record, entry));
    if (now === entry.after) continue;
    if (now !== entry.before) return [entry.path];
    place(record, entry, stagedBytes(record, entry, 'after'));
    hooks.afterWrite?.(entry.path);
  }
  return [];
}

/**
 * Put back the backup where the folder still holds what the apply wrote. A path with any other content is someone
 * else's: it is left as it is and named. Directories the apply created are removed when they are empty again.
 */
function backward(record, hooks) {
  record.state = 'rolling-back';
  save(record.backupDir, record);
  const foreign = [];
  for (const entry of record.entries) {
    const now = hashOf(at(record, entry));
    if (now === entry.before) continue;
    if (now !== entry.after) { foreign.push(entry.path); continue; }
    place(record, entry, stagedBytes(record, entry, 'before'));
    hooks.afterRestore?.(entry.path);
  }
  for (const dir of [...record.createdDirs].reverse()) { try { rmdirSync(join(record.targetRoot, ...dir.split('/'))); } catch { /* not empty or gone */ } }
  removeTemp(record);
  record.state = foreign.length ? 'stopped' : 'rolled-back';
  save(record.backupDir, record);
  return foreign;
}

function confirmFolder(record, hooks) {
  const seen = where(record);
  if (seen.after.length === record.entries.length) {
    removeTemp(record);
    record.state = 'applied';
    save(record.backupDir, record);
    return told(record, 'applied');
  }
  const foreign = backward(record, hooks);
  return foreign.length
    ? told(record, 'stopped', { code: 'APPLY_FOLDER_CHANGED', files: foreign, reason: 'files changed while AIWorks applied; the backup is kept' })
    : told(record, 'rolled-back', { reason: 'the folder did not match the result after the apply' });
}

/** Run forward, confirm, and roll back on any failure. A failure of the rollback itself leaves it for reconcile. */
function applyFolder(record, hooks) {
  let foreign;
  try { foreign = forward(record, hooks); } catch (error) {
    try {
      const left = backward(record, hooks);
      return left.length
        ? told(record, 'stopped', { code: 'APPLY_FOLDER_CHANGED', files: left, reason: `the apply failed (${error.message}) and files changed meanwhile; the backup is kept` })
        : told(record, 'rolled-back', { reason: `the apply failed and was rolled back: ${error.message}` });
    } catch (again) { return told(record, 'unknown', { reason: `the apply and its rollback failed: ${again.message}; reconcile it` }); }
  }
  if (foreign.length) {
    const left = backward(record, hooks);
    return told(record, 'stopped', { code: 'APPLY_FOLDER_CHANGED', files: [...new Set([...foreign, ...left])], reason: 'a file changed during the apply; the backup is kept' });
  }
  return confirmFolder(record, hooks);
}

/**
 * Apply one result to a plain folder. `changes` lists every path the result writes or deletes:
 * { path (relative, `/`-separated), before: the baseline SHA-256 or null when absent, after: the new bytes or null to
 * delete }. `backupDir` must be outside the folder; it holds the record, the backup and the result's bytes, so a crash
 * can be finished from it alone. `hooks` (afterIntent, afterWrite, afterRestore) let tests fail or stop the process at
 * a chosen point. Returns { kind, id, outcome, state, backupDir, code?, files?, reason? }; outcome is `applied`,
 * `refused` (nothing written), `rolled-back`, `stopped` (someone else changed a file; the backup is kept) or
 * `unknown`. Running it again on the same backupDir continues only when nothing has been written yet.
 */
export function localFolderApply({ id, targetRoot, backupDir, changes, hooks = {} }) {
  const entries = folderPlan({ id, targetRoot, backupDir, changes });
  const kind = LOCAL_FOLDER_APPLY;
  const rootStat = lstat(targetRoot);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return refused(kind, id, 'APPLY_PATH_REFUSED', [], 'the folder is missing or is a link');
  if (!apart(targetRoot, backupDir)) throw new TypeError('the backup directory and the folder must not contain each other');
  const blocked = entries.map((entry) => ({ path: entry.path, reason: pathRefusal(targetRoot, entry.path) })).filter((item) => item.reason);
  const folded = new Map();
  for (const entry of entries) {
    const fold = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path;
    if (folded.has(fold)) blocked.push({ path: entry.path, reason: `the same file as ${folded.get(fold)}` });
    folded.set(fold, entry.path);
  }
  if (blocked.length) return refused(kind, id, 'APPLY_PATH_REFUSED', blocked, 'AIWorks does not write these paths');
  const record = { version: 1, kind, id, targetRoot: resolve(targetRoot), backupDir: resolve(backupDir), state: 'backing-up', createdDirs: [],
    entries: entries.map(({ path, before, after }, index) => ({ path: path.replaceAll('\\', '/'), before, after,
      backup: before === null ? null : `before/${index}`, staged: after === null ? null : `after/${index}` })) };
  record.digest = folderDigest(record);
  const earlier = readRecord(backupDir);
  if (earlier) {
    if (earlier.digest !== record.digest || earlier.kind !== kind) throw new Error(`${backupDir} holds another apply`);
    if (earlier.state !== 'backup-complete') throw new Error(`apply ${id} is ${earlier.state}: reconcile it, never run it again`);
  }
  // Rescan: every path must still have its baseline hash.
  const changed = entries.filter((entry) => hashOf(at(record, entry)) !== entry.before).map((entry) => entry.path);
  if (changed.length) return refused(kind, id, 'APPLY_FOLDER_CHANGED', changed, 'files changed since the work started; nothing was written');
  if (earlier) return applyFolder(earlier, hooks);
  // Backup, then the result's bytes, each read back; then the record that allows the first write.
  mkdirSync(join(backupDir, 'before'), { recursive: true });
  mkdirSync(join(backupDir, 'after'), { recursive: true });
  record.entries.forEach((entry, index) => {
    if (entry.backup) {
      const bytes = readFileSync(at(record, entry));
      if (sha256(bytes) !== entry.before) throw new Error(`${entry.path} changed while AIWorks backed it up; nothing was written to the folder`);
      writeDurable(join(backupDir, entry.backup), bytes);
    }
    if (entry.staged) writeDurable(join(backupDir, entry.staged), entries[index].bytes);
    stagedBytes(record, entry, 'before');
    stagedBytes(record, entry, 'after');
  });
  record.createdDirs = [...new Set(record.entries.filter((entry) => entry.after !== null).flatMap((entry) => missingDirs(targetRoot, entry.path)))];
  record.state = 'backup-complete';
  save(backupDir, record);
  return applyFolder(record, hooks);
}

/**
 * Undo apply for a plain folder: put the backup back, but only when every path still holds what the apply wrote.
 * Where the owner changed a file since, nothing is written: refused, with the files named, and the backup is kept.
 */
export function undoLocalFolderApply({ backupDir, hooks = {} }) {
  const record = readRecord(backupDir);
  if (!record || record.kind !== LOCAL_FOLDER_APPLY) throw new Error(`${backupDir} holds no folder apply`);
  if (record.state !== 'applied') throw new Error(`apply ${record.id} is ${record.state}; only an applied result is undone`);
  const seen = where(record);
  if (seen.other.length) return told(record, 'refused', { code: 'UNDO_FOLDER_CHANGED', files: seen.other.map((entry) => entry.path), reason: 'files changed since the apply; nothing was written' });
  const left = backward(record, hooks);
  return left.length ? told(record, 'stopped', { code: 'UNDO_FOLDER_CHANGED', files: left, reason: 'files changed during the undo; the backup is kept' }) : told(record, 'rolled-back');
}

/**
 * Settle a folder apply after a crash by reading the folder (AUTO_RELEASE.md section 8, local-folder row). Every hash
 * the result's: applied. Every hash the baseline's: not done (the record is back at backup-complete; the same apply may
 * run again). A mix of the two only: the remaining writes are finished from the staged bytes. Any other hash: someone
 * else changed the file: stopped, nothing written, backup kept. An open rollback is finished the same way. A finished
 * apply is only reported. Returns the same shape as localFolderApply; `not-done` and `none` (no record) are added.
 */
export function reconcileLocalFolderApply({ backupDir, hooks = {} }) {
  const record = readRecord(backupDir);
  if (!record) return { kind: LOCAL_FOLDER_APPLY, id: null, outcome: 'none', state: null, backupDir };
  if (record.kind !== LOCAL_FOLDER_APPLY) throw new Error(`${backupDir} holds no folder apply`);
  if (FINAL.includes(record.state)) return told(record, record.state);
  if (record.state === 'backing-up') {
    // The intent was never written, so the folder was never written.
    return told(record, 'not-done', { reason: 'the backup was not finished; nothing was written to the folder' });
  }
  const seen = where(record);
  if (seen.other.length) {
    record.state = 'stopped';
    save(backupDir, record);
    return told(record, 'stopped', { code: 'APPLY_FOLDER_CHANGED', files: seen.other.map((entry) => entry.path), reason: 'someone else changed these files; the backup is kept' });
  }
  if (record.state === 'rolling-back') {
    const left = backward(record, hooks);
    return left.length ? told(record, 'stopped', { code: 'APPLY_FOLDER_CHANGED', files: left }) : told(record, 'rolled-back', { reason: 'the open rollback was finished' });
  }
  if (seen.before.length === record.entries.length) {
    removeTemp(record);
    record.state = 'backup-complete';
    save(backupDir, record);
    return told(record, 'not-done', { reason: 'nothing was written; the same apply may run again' });
  }
  return applyFolder(record, hooks);
}

// ---- Local Git (local-git-apply) ----

// Per-command settings: no fsmonitor, no automatic gc or maintenance. They write no configuration anywhere.
const GIT_PREFIX = Object.freeze(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']);

/** One Git command in the owner's repository. Inherited GIT_* variables could point Git elsewhere, so they are dropped. */
function runGit(git, args, { gitEnv, hooksOff }) {
  const [command, ...prefix] = git;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  // An absent hooks directory: no hook of the owner's repository runs from an apply.
  const result = spawnSync(command, [...prefix, ...GIT_PREFIX, '-c', `core.hooksPath=${hooksOff}`, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...env, ...gitEnv, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error?.code === 'ENOENT') throw new Error('git was not found');
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function gitOf(record, { git = ['git'], gitEnv } = {}) {
  const options = { gitEnv, hooksOff: join(record.backupDir, 'no-hooks') };
  const run = (...args) => runGit(git, ['-C', record.repoRoot, ...args], options);
  const head = () => {
    const read = run('rev-parse', '--verify', '-q', `refs/heads/${record.branch}^{commit}`);
    const sha = read.stdout.trim();
    return read.ok && SHA.test(sha) ? sha : null;
  };
  /** Where the branch is checked out: 'here' (repoRoot), 'elsewhere' (another worktree), 'nowhere', or null unread. */
  const checkout = () => {
    const read = run('worktree', 'list', '--porcelain');
    if (!read.ok) return null;
    const holders = read.stdout.split(/\r?\n\r?\n/).filter((block) => block.split(/\r?\n/).includes(`branch refs/heads/${record.branch}`))
      .map((block) => block.split(/\r?\n/).find((line) => line.startsWith('worktree '))?.slice('worktree '.length));
    if (!holders.length) return 'nowhere';
    return holders.some((path) => path && canonical(path) === canonical(record.repoRoot)) ? 'here' : 'elsewhere';
  };
  /** The changed and untracked paths of the working tree, or null unread. */
  const dirty = () => {
    const read = run('status', '--porcelain=v1', '-z', '--untracked-files=all');
    return read.ok ? read.stdout.split('\0').filter(Boolean).map((line) => line.slice(3)) : null;
  };
  return { run, head, checkout, dirty };
}

/** Is the branch at `sha` with nothing left over: the head equals it and, where it is checked out here, the tree is clean. */
function settledAt(g, sha) {
  if (g.head() !== sha) return false;
  const place = g.checkout();
  if (place === 'nowhere') return true;
  return place === 'here' && g.dirty()?.length === 0;
}

/**
 * Move the branch back to the backup, only while it still holds the applied result and nothing else: the head equals
 * the verified SHA and the tree is clean. Otherwise the owner has moved on: stopped, never reset over their work.
 * A checked-out branch moves with `reset --keep`, which also refuses to drop any local change.
 */
function backwardGit(record, g) {
  record.state = 'rolling-back';
  save(record.backupDir, record);
  if (settledAt(g, record.baseline)) {
    record.state = 'rolled-back';
    save(record.backupDir, record);
    return null;
  }
  if (!settledAt(g, record.verifiedSha)) {
    record.state = 'stopped';
    save(record.backupDir, record);
    return 'the branch or its working tree changed after the apply; AIWorks did not move it and the backup ref is kept';
  }
  const place = g.checkout();
  const moved = place === 'here' ? g.run('reset', '-q', '--keep', record.backupRef)
    : g.run('update-ref', `refs/heads/${record.branch}`, record.baseline, record.verifiedSha);
  if (!moved.ok || !settledAt(g, record.baseline)) {
    record.state = 'stopped';
    save(record.backupDir, record);
    return `the branch could not be moved back: ${moved.stderr.trim().slice(0, 300) || 'it did not land on the backup'}`;
  }
  record.state = 'rolled-back';
  save(record.backupDir, record);
  return null;
}

function rolledBackGit(record, g, why) {
  try {
    const stop = backwardGit(record, g);
    return stop ? told(record, 'stopped', { code: 'APPLY_BRANCH_CHANGED', reason: `${why}; ${stop}` }) : told(record, 'rolled-back', { reason: why });
  } catch (error) { return told(record, 'unknown', { reason: `${why}; the rollback failed: ${error.message}; reconcile it` }); }
}

function applyGit(record, g, hooks) {
  record.state = 'applying';
  save(record.backupDir, record);
  hooks.afterIntent?.();
  const place = g.checkout();
  // Fast-forward only: no merge commit, no rebase, no reset.
  const moved = place === 'here' ? g.run('merge', '--ff-only', '-q', record.verifiedSha)
    : place === 'nowhere' ? g.run('update-ref', `refs/heads/${record.branch}`, record.verifiedSha, record.baseline)
      : { ok: false, stderr: 'the branch is checked out in another worktree' };
  hooks.afterApply?.();
  if (!moved.ok) return rolledBackGit(record, g, `the fast-forward failed: ${moved.stderr.trim().slice(0, 300)}`);
  if (!settledAt(g, record.verifiedSha)) return rolledBackGit(record, g, 'the branch did not equal the result after the apply');
  record.state = 'applied';
  save(record.backupDir, record);
  return told(record, 'applied', { head: record.verifiedSha });
}

/**
 * Apply one verified revision to one branch of the owner's local Git repository. Refused, with nothing written, unless
 * the branch head equals `baseline`, the working tree is clean where the branch is checked out (here, or nowhere: then
 * only the ref moves), and `verifiedSha` descends from `baseline`. When the owner's repository lacks the commit it is
 * fetched by SHA from `source` (AIWorks's mirror, by path; no remote is ever named). Then the backup ref
 * `<backupRefPrefix><id>` is written at the head and recorded in `<backupDir>/apply.json`, the intent is recorded,
 * and the branch fast-forwards. Returns the shape of localFolderApply, with `head` when applied.
 */
export function localGitApply({ id, repoRoot, branch, baseline, verifiedSha, source = null, backupDir, backupRefPrefix = APPLY_BACKUP_PREFIX,
  git = ['git'], gitEnv, hooks = {} }) {
  named(id, backupDir);
  const kind = LOCAL_GIT_APPLY;
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot)) throw new TypeError('a Git apply needs the absolute repository path');
  if (typeof branch !== 'string' || !BRANCH.test(branch)) throw new TypeError('a Git apply needs a plain branch name');
  if (!SHA.test(baseline ?? '') || !SHA.test(verifiedSha ?? '')) throw new TypeError('a Git apply needs the full baseline and verified SHAs');
  if (![APPLY_BACKUP_PREFIX, RELEASE_BACKUP_PREFIX].includes(backupRefPrefix)) throw new TypeError('the backup ref lives under refs/aiworks/');
  if (!apart(repoRoot, backupDir)) throw new TypeError('the backup directory and the repository must not contain each other');
  const record = { version: 1, kind, id, repoRoot: resolve(repoRoot), backupDir: resolve(backupDir), branch, baseline, verifiedSha,
    backupRef: `${backupRefPrefix}${id}`, state: 'checking' };
  const g = gitOf(record, { git, gitEnv });
  const rootStat = lstat(repoRoot);
  if (!rootStat || rootStat.isSymbolicLink()) return refused(kind, id, 'APPLY_PATH_REFUSED', [], 'the repository is missing or is a link');
  const top = g.run('rev-parse', '--show-toplevel');
  if (!top.ok || canonical(top.stdout.trim()) !== canonical(repoRoot)) return refused(kind, id, 'APPLY_PATH_REFUSED', [], 'the folder is not the top of a Git repository');
  const earlier = readRecord(backupDir);
  if (earlier) {
    if (earlier.kind !== kind || ['repoRoot', 'branch', 'baseline', 'verifiedSha', 'backupRef'].some((field) => earlier[field] !== record[field])) {
      throw new Error(`${backupDir} holds another apply`);
    }
    if (earlier.state !== 'backup-complete') throw new Error(`apply ${id} is ${earlier.state}: reconcile it, never run it again`);
  }
  // Rescan.
  const head = g.head();
  if (head !== baseline) return refused(kind, id, 'APPLY_BRANCH_CHANGED', [], head ? `the branch is at ${head}, not at the baseline; nothing was written` : 'the branch does not exist');
  const place = g.checkout();
  if (place === null) return refused(kind, id, 'APPLY_BRANCH_CHANGED', [], 'AIWorks could not read where the branch is checked out');
  if (place === 'elsewhere') return refused(kind, id, 'APPLY_BRANCH_CHANGED', [], 'the branch is checked out in another worktree');
  if (place === 'here') {
    const files = g.dirty();
    if (files === null || files.length) return refused(kind, id, 'APPLY_TREE_DIRTY', files ?? [], 'the working tree has changes; nothing was written');
  }
  const has = () => g.run('cat-file', '-e', `${verifiedSha}^{commit}`).ok;
  if (!has() && source) {
    if (!apart(source, repoRoot)) throw new TypeError('the source and the repository must not contain each other');
    g.run('fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--', resolve(source).replaceAll('\\', '/'), verifiedSha);
  }
  if (!has()) return refused(kind, id, 'APPLY_CANDIDATE_MISSING', [], 'the verified revision is not available');
  if (!g.run('merge-base', '--is-ancestor', baseline, verifiedSha).ok) return refused(kind, id, 'APPLY_NOT_FAST_FORWARD', [], 'the result does not build on the baseline; AIWorks applies fast-forward only');
  if (earlier) return applyGit(earlier, g, hooks);
  // Backup: the ref is created only when absent (or already at the baseline), then recorded.
  mkdirSync(backupDir, { recursive: true });
  const backup = g.run('update-ref', record.backupRef, baseline, '');
  const existing = g.run('rev-parse', '--verify', '-q', record.backupRef).stdout.trim();
  if (!backup.ok && existing !== baseline) throw new Error(`the backup ref ${record.backupRef} could not be written; nothing was applied`);
  record.state = 'backup-complete';
  save(backupDir, record);
  return applyGit(record, g, hooks);
}

/** Undo apply for Local Git: only while the branch is still at the result and clean; otherwise refused, nothing moved. */
export function undoLocalGitApply({ backupDir, git = ['git'], gitEnv }) {
  const record = readRecord(backupDir);
  if (!record || record.kind !== LOCAL_GIT_APPLY) throw new Error(`${backupDir} holds no Git apply`);
  if (record.state !== 'applied') throw new Error(`apply ${record.id} is ${record.state}; only an applied result is undone`);
  const g = gitOf(record, { git, gitEnv });
  if (!settledAt(g, record.verifiedSha)) return told(record, 'refused', { code: 'UNDO_BRANCH_CHANGED', reason: 'the branch or its working tree changed since the apply; nothing was moved' });
  const stop = backwardGit(record, g);
  return stop ? told(record, 'stopped', { code: 'UNDO_BRANCH_CHANGED', reason: stop }) : told(record, 'rolled-back', { head: record.baseline });
}

/**
 * Settle a Git apply after a crash by reading the branch head (AUTO_RELEASE.md section 8, local-git row). Head at the
 * result and clean: applied, never applied again. Head at the baseline and clean: not done (back at backup-complete;
 * the same apply may run again). Anything else: stopped for the owner, never reset. An open rollback is finished only
 * while the head is still at the result.
 */
export function reconcileLocalGitApply({ backupDir, git = ['git'], gitEnv }) {
  const record = readRecord(backupDir);
  if (!record) return { kind: LOCAL_GIT_APPLY, id: null, outcome: 'none', state: null, backupDir };
  if (record.kind !== LOCAL_GIT_APPLY) throw new Error(`${backupDir} holds no Git apply`);
  if (FINAL.includes(record.state)) return told(record, record.state);
  if (record.state === 'backup-complete') return told(record, 'not-done', { reason: 'the intent was not recorded; nothing was applied' });
  const g = gitOf(record, { git, gitEnv });
  if (record.state === 'rolling-back') return rolledBackGit(record, g, 'the open rollback was finished');
  if (settledAt(g, record.verifiedSha)) {
    record.state = 'applied';
    save(backupDir, record);
    return told(record, 'applied', { head: record.verifiedSha });
  }
  if (settledAt(g, record.baseline)) {
    record.state = 'backup-complete';
    save(backupDir, record);
    return told(record, 'not-done', { reason: 'the branch is still at the baseline; the same apply may run again' });
  }
  record.state = 'stopped';
  save(backupDir, record);
  return told(record, 'stopped', { code: 'APPLY_BRANCH_CHANGED', reason: 'the branch is neither at the baseline nor at the result; AIWorks never resets it' });
}
