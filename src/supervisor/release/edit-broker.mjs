import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { containsSecret } from '../coordinator.mjs';
import { writeAtomic } from '../proc.mjs';

const MAX_EDITS = 32;
const MAX_BYTES = 512 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MARKER = 'AIWorks-Edit-Operation:';
const SECRET = /(?:-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret[_-]?key)\s*[:=]\s*\S|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b)/i;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const DENIED_SEGMENTS = new Set(['.git', '.local', 'node_modules', '.env', '.ssh', '.cursor', '.claude', '.codex', 'hooks']);

const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(`edit broker refused: ${message}`); };
function run(git, workspace, args, { input, allowFailure = false } = {}) {
  if (!Array.isArray(git) || !git.length || git.some((part) => typeof part !== 'string')) fail('invalid git command');
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_AUTHOR_|GIT_COMMITTER_|GIT_DIR$|GIT_WORK_TREE$|GIT_COMMON_DIR$|GIT_INDEX_FILE$|GIT_OBJECT_DIRECTORY$|GIT_ALTERNATE_OBJECT_DIRECTORIES$)/.test(key)));
  const result = spawnSync(git[0], [...git.slice(1), '-C', workspace, ...args], {
    encoding: 'buffer', input, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...cleanEnv, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_LFS_SKIP_PUSH: '1' },
  });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    fail(`git ${args[0]} failed${result.error?.code ? ` (${result.error.code})` : ''}`);
  }
  return result.stdout;
}
const str = (buffer) => buffer.toString('utf8').replace(/\r?\n$/, '');

function canonicalPath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x1f\x7f]/.test(value) || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) fail('unsafe path');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || part.includes(':') || RESERVED.test(part))) fail('unsafe path');
  const folded = parts.map((part) => part.toLowerCase());
  if (folded.some((part) => DENIED_SEGMENTS.has(part)) || folded[0] === '.github' && folded[1] === 'workflows') fail('protected path');
  if (folded.some((part) => /^\.env/i.test(part) || /(?:secret|credential|auth|token|password|private[-_]?key)/i.test(part))) fail('sensitive path');
  return { path: value, folded: folded.join('/') };
}
function secretFree(value) { if (containsSecret(value)) fail('secret-shaped content'); }
function pathSet(values, label) {
  if (!Array.isArray(values) || values.some((p) => typeof p !== 'string')) fail(`invalid ${label}`);
  return values.map(canonicalPath);
}
function validateEdits(edits, allowedPaths, deniedPaths) {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > MAX_EDITS) fail('invalid edit count');
  const allowed = pathSet(allowedPaths, 'allowlist');
  const denied = deniedPaths.map((path) => ({ path, folded: path.replace(/\/$/, '').toLowerCase() }));
  const allowSet = new Set(allowed.map((p) => p.folded));
  if (new Set(allowed.map((p) => p.folded)).size !== allowed.length) fail('duplicate allowlist path');
  let bytes = 0;
  const seen = new Map();
  const normalized = edits.map((edit) => {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit) || typeof edit.before !== 'string' || typeof edit.after !== 'string' || Object.keys(edit).sort().join(',') !== 'after,before,path' || edit.before.includes('\0') || edit.after.includes('\0')) fail('invalid edit');
    const { path, folded } = canonicalPath(edit.path);
    if (seen.has(folded) && seen.get(folded) !== path) fail('aliased edit path');
    seen.set(folded, path);
    if (!allowSet.has(folded) || denied.some((p) => folded === p.folded || folded.startsWith(`${p.folded}/`))) fail('path outside authorized scope');
    if (edit.before.length === 0 && edit.after.length === 0) fail('empty edit');
    bytes += Buffer.byteLength(edit.before) + Buffer.byteLength(edit.after);
    secretFree(edit.before); secretFree(edit.after);
    return { path, folded, before: edit.before, after: edit.after };
  });
  if (bytes > MAX_BYTES) fail('edit payload too large');
  return normalized;
}
function checkNoLinks(workspace, path, { mayBeMissing = false } = {}) {
  let current = workspace;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink() || st.isDirectory() !== (i < parts.length - 1) || !st.isFile() && i === parts.length - 1) fail('non-regular or reparse path');
    } catch (error) {
      if (error.code === 'ENOENT' && mayBeMissing) return false;
      if (error.code === 'ENOENT') fail('missing path component');
      throw error;
    }
  }
  return true;
}
function trackedBlob(git, workspace, baseSha, path) {
  const raw = run(git, workspace, ['ls-tree', '-z', baseSha, '--', path]);
  const entry = raw.toString('utf8').replace(/\0$/, '');
  if (!entry) return null;
  const match = /^([0-7]{6}) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
  if (!match || match[3] !== path || !['100644', '100755'].includes(match[1])) fail('base path is not a regular file');
  return { mode: match[1], content: run(git, workspace, ['cat-file', 'blob', match[2]]).toString('utf8') };
}

// Every preimage refers to the pinned base, never to a preceding edit's output.
// Collapse disjoint ranges into one durable file image before any mutation.
function fileEdits(git, workspace, baseSha, edits) {
  const groups = new Map();
  for (const edit of edits) {
    if (!groups.has(edit.path)) groups.set(edit.path, []);
    groups.get(edit.path).push(edit);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const base = trackedBlob(git, workspace, baseSha, group[0].path);
    if (!base) fail('multiple edits cannot create the same file');
    const ranges = group.map((edit) => {
      const start = base.content.indexOf(edit.before);
      if (!edit.before || start < 0 || base.content.indexOf(edit.before, start + 1) !== -1) fail('before text must be one exact base substring');
      return { ...edit, start, end: start + edit.before.length };
    }).sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) if (ranges[i].start < ranges[i - 1].end) fail('overlapping base edits');
    let after = base.content;
    for (const edit of ranges.reverse()) after = after.slice(0, edit.start) + edit.after + after.slice(edit.end);
    return { ...group[0], before: base.content, after };
  });
}
function treeMode(git, workspace, tree, path) {
  const entry = run(git, workspace, ['ls-tree', '-z', tree, '--', path]).toString('utf8').replace(/\0$/, '');
  const match = /^([0-7]{6}) blob [0-9a-f]{40}\t(.+)$/.exec(entry);
  if (!match || match[2] !== path) fail('expected tree is missing an edited file');
  return match[1];
}
function statusPaths(git, workspace) {
  const raw = run(git, workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).toString('utf8');
  if (!raw) return [];
  const out = [];
  const records = raw.split('\0');
  for (const record of records) {
    if (!record) continue;
    if (record.length < 4) fail('unparseable worktree status');
    const status = record.slice(0, 2);
    if (status.includes('R') || status.includes('C')) fail('rename/copy state in worktree');
    out.push(record.slice(3));
  }
  return out;
}
function durableJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
function createIntent(path, intent) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(intent)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}
function contextHash(context, edits) {
  return hash(JSON.stringify({ ...context, edits: edits.map(({ path, before, after }) => ({ path, before: hash(before), after: hash(after) })) }));
}
function readIntent(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; fail('corrupt reserved intent'); }
}
function assertIdentity(intent, context, digest) {
  if (intent.identity !== digest || intent.operationId !== context.operationId || intent.sessionId !== context.sessionId || intent.packetDigest !== context.packetDigest || intent.snapshotDigest !== context.snapshotDigest || intent.baseSha !== context.baseSha) fail('operation is already reserved with different input');
}
function exactCommit(git, workspace, intent, head) {
  const parent = str(run(git, workspace, ['rev-parse', `${head}^`]));
  const tree = str(run(git, workspace, ['rev-parse', `${head}^{tree}`]));
  const message = run(git, workspace, ['show', '-s', '--format=%B', head]).toString('utf8').trimEnd();
  return parent === intent.baseSha && tree === intent.expectedTree && message === intent.message;
}

/** Apply one audited, exact edit response and commit it once on a clean isolated task branch. */
export function applyEdits({ git = ['git'], workspace, runDir, operationId, sessionId, packetDigest, baseSha, snapshotDigest, edits, allowedPaths, deniedPaths = [], expectedBranch, checkpoint = () => {} } = {}) {
  if (!workspace || !runDir || !SAFE_ID.test(operationId ?? '') || !SAFE_ID.test(sessionId ?? '') || !/^[a-f0-9]{64}$/.test(packetDigest ?? '') || !/^[a-f0-9]{64}$/.test(snapshotDigest ?? '') || !SHA.test(baseSha ?? '')) fail('invalid operation context');
  workspace = resolve(workspace); runDir = resolve(runDir);
  if (!existsSync(workspace) || !existsSync(runDir)) fail('workspace or run directory missing');
  const runRelative = relative(workspace, runDir);
  if (runRelative === '' || (!isAbsolute(runRelative) && runRelative !== '..' && !runRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))) fail('intent directory must be outside workspace');
  if (typeof expectedBranch !== 'string' || !expectedBranch || !Array.isArray(deniedPaths) || deniedPaths.some((p) => typeof p !== 'string')) fail('missing branch or denied scope');
  const normalized = validateEdits(edits, allowedPaths, deniedPaths);
  const context = { operationId, sessionId, packetDigest, baseSha, snapshotDigest,
    allowedPaths: pathSet(allowedPaths, 'allowlist').map((p) => p.path), deniedPaths: [...deniedPaths], expectedBranch };
  const identity = contextHash(context, normalized);
  const intentPath = join(runDir, 'edit-broker.intent.json');
  let intent = readIntent(intentPath);
  if (intent) assertIdentity(intent, context, identity);
  else {
    const head = str(run(git, workspace, ['rev-parse', 'HEAD']));
    if (resolve(str(run(git, workspace, ['rev-parse', '--show-toplevel']))) !== workspace) fail('workspace must be the repository root');
    if (str(run(git, workspace, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) !== expectedBranch) fail('workspace is not on its expected task branch');
    if (head !== baseSha) fail('workspace head differs from pinned base');
    if (statusPaths(git, workspace).length) fail('workspace is not clean');
    const entries = fileEdits(git, workspace, baseSha, normalized).map((edit) => {
      const base = trackedBlob(git, workspace, baseSha, edit.path);
      if (base === null) {
        if (edit.before !== '' || checkNoLinks(workspace, edit.path, { mayBeMissing: true })) fail('new file must be absent at base and in workspace');
        return { ...edit, existed: false, beforeImage: null, afterImage: edit.after, blobImage: edit.after };
      }
      if (!edit.before || (base.content.split(edit.before).length - 1) !== 1) fail('before text must be one exact base substring');
      const exists = checkNoLinks(workspace, edit.path);
      if (!exists) fail('base file missing from workspace');
      const work = readFileSync(join(workspace, ...edit.path.split('/')), 'utf8');
      const crlf = work !== base.content && !base.content.includes('\r') && work.replaceAll('\r\n', '\n') === base.content;
      if (work !== base.content && !crlf) fail('workspace file differs from base image');
      const blobImage = base.content.replace(edit.before, () => edit.after);
      const afterImage = blobImage;
      secretFree(blobImage);
      return { ...edit, existed: true, baseMode: base.mode, beforeImage: base.content, afterImage, blobImage };
    });
    const message = `AIWorks: apply audited edits\n\n${MARKER} ${operationId}`;
    intent = { version: 1, ...context, identity, entries, message, expectedTree: null, createdAt: new Date().toISOString() };
    createIntent(intentPath, intent);
    checkpoint('intent');
  }
  if (resolve(str(run(git, workspace, ['rev-parse', '--show-toplevel']))) !== workspace) fail('workspace must be the repository root');
  if (str(run(git, workspace, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) !== expectedBranch) fail('workspace is not on its expected task branch');
  const targetWorkspace = workspace;
  const targetHead = str(run(git, targetWorkspace, ['rev-parse', 'HEAD']));
  if (targetHead !== baseSha) {
    if (intent.expectedHead === targetHead && exactCommit(git, targetWorkspace, intent, targetHead)
        && statusPaths(git, targetWorkspace).length === 0) return receipt(targetHead, intent);
    fail('task branch moved away from the reserved base');
  }
  if (statusPaths(git, targetWorkspace).length) fail('task worktree has unrelated changes');
  // Commit in a controller-owned detached worktree first. Normal hooks remain active. Only a fast-forward
  // of this direct child can then advance the task branch; a concurrent sibling commit makes it fail.
  workspace = join(runDir, 'edit-workspace');
  if (!existsSync(workspace)) run(git, targetWorkspace, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'worktree', 'add', '--detach', workspace, baseSha]);
  if (str(run(git, workspace, ['rev-parse', '--show-toplevel'])).replaceAll('\\', '/').toLowerCase() !== workspace.replaceAll('\\', '/').toLowerCase()) fail('candidate workspace identity changed');
  const owned = new Set(intent.entries.map((entry) => entry.path));
  const currentHead = str(run(git, workspace, ['rev-parse', 'HEAD']));
  if (currentHead !== intent.baseSha) {
    if (!exactCommit(git, workspace, intent, currentHead) || statusPaths(git, workspace).length) fail('candidate head or tree changed');
    return promote(currentHead);
  }
  for (const path of statusPaths(git, workspace)) if (!owned.has(path)) fail('worktree has unrelated evidence or changes');
  for (const entry of intent.entries) {
    const exists = checkNoLinks(workspace, entry.path, { mayBeMissing: true });
    const actual = exists ? readFileSync(join(workspace, ...entry.path.split('/')), 'utf8') : null;
    if (actual === entry.afterImage) continue;
    if (actual !== entry.beforeImage) fail('owned file has an unknown image');
  }
  // Validate all destinations before any writes; then each write is an owned before-image to after-image transition.
  for (const entry of intent.entries) {
    const destination = join(workspace, ...entry.path.split('/'));
    const actual = existsSync(destination) ? readFileSync(destination, 'utf8') : null;
    if (actual === entry.afterImage) continue;
    mkdirSync(dirname(destination), { recursive: true });
    if (actual === null) writeFileSync(destination, entry.afterImage, { flag: 'wx' });
    else writeAtomic(destination, entry.afterImage);
  }
  checkpoint('write');
  const args = ['--literal-pathspecs', 'add', '--', ...intent.entries.map((entry) => entry.path)];
  run(git, workspace, args);
  checkpoint('stage');
  const stagedTree = str(run(git, workspace, ['write-tree']));
  if (intent.expectedTree && intent.expectedTree !== stagedTree) fail('staged tree differs from reserved tree');
  for (const entry of intent.entries) {
    if (treeMode(git, workspace, stagedTree, entry.path) !== (entry.existed ? entry.baseMode : '100644')) fail('edited file mode changed');
    const staged = run(git, workspace, ['show', `${stagedTree}:${entry.path}`]).toString('utf8');
    if (staged !== entry.blobImage) fail('Git conversion changed the proposed blob');
  }
  if (!intent.expectedTree) { intent.expectedTree = stagedTree; durableJson(intentPath, intent); }
  const stagedStatus = statusPaths(git, workspace);
  if (stagedStatus.some((path) => !owned.has(path))) fail('unrelated change appeared while staging');
  checkpoint('tree');
  run(git, workspace, ['-c', 'user.name=AIWorks Supervisor', '-c', 'user.email=aiworks-supervisor@localhost', 'commit', '-m', intent.message]);
  checkpoint('commit');
  const head = str(run(git, workspace, ['rev-parse', 'HEAD']));
  if (!exactCommit(git, workspace, intent, head) || statusPaths(git, workspace).length !== 0) fail('commit or hooks changed the reserved result');
  return promote(head);
  function promote(head) {
    intent.expectedHead = head; durableJson(intentPath, intent);
    checkpoint('candidate');
    if (str(run(git, targetWorkspace, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) !== expectedBranch
        || str(run(git, targetWorkspace, ['rev-parse', 'HEAD'])) !== baseSha || statusPaths(git, targetWorkspace).length) fail('task branch changed before fast-forward');
    run(git, targetWorkspace, ['merge', '--ff-only', '--no-edit', head]);
    checkpoint('promote');
    if (str(run(git, targetWorkspace, ['rev-parse', 'HEAD'])) !== head || statusPaths(git, targetWorkspace).length) fail('task fast-forward is not exact');
    return receipt(head, intent);
  }
}
function receipt(headSha, intent) {
  return { headSha, receipt: { operationId: intent.operationId, sessionId: intent.sessionId, packetDigest: intent.packetDigest,
    snapshotDigest: intent.snapshotDigest, baseSha: intent.baseSha, headSha, tree: intent.expectedTree, identity: intent.identity } };
}
