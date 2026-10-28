// AIWorks workspace and publication adapter. Every function is idempotent: it inspects
// existing state before creating anything, so a controller restarted at any point can call
// it again. Removal is only the non-forced worktree remove and branch -d below; which ones may go is cleanup.mjs's rule.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { GATE_FILES } from '../gate.mjs';
import { assertActionsDisabled } from './github.mjs';
import { DEVELOPMENT_ENV } from '../development-policy.mjs';
import { githubRemote } from '../project-preflight.mjs';
import { environmentExamplePath, safeEnvironmentExample } from '../environment-example.mjs';

const SHA = /^[0-9a-f]{40}$/;

export function exec(command, args, { cwd, input, timeoutMs = 180_000 } = {}) {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd, input, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...DEVELOPMENT_ENV },
  });
  return { ok: !result.error && result.status === 0, status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim(), error: result.error?.code };
}

function must(result, what) {
  if (!result.ok) throw new Error(`${what} failed: ${result.error || result.stderr || result.stdout || `exit ${result.status}`}`.slice(0, 1000));
  return result.stdout;
}

export const branchName = (campaignId, taskId) => `campaign/${campaignId}/${taskId}`;

// Legal IDs reach 64 characters each, and a worktree folder named after both leaves too little of the 260-character Windows
// path for Git and a worker's own tools. A longer pair keeps a readable prefix and a digest of the whole pair; '+' is no ID
// character, so the result is never another pair's full name. Shorter pairs keep their names.
const NAME_LIMIT = 64;
export function workspaceName(campaignId, taskId) {
  const full = `${campaignId}-${taskId}`;
  if (full.length <= NAME_LIMIT) return full;
  const digest = createHash('sha256').update(`${campaignId}/${taskId}`).digest('hex').slice(0, 16);
  return `${full.slice(0, NAME_LIMIT - digest.length - 1)}+${digest}`;
}

/** The folder for `suffix` of this task: one a supervisor already made under the full name is reused. */
function workspacePath(worktreeRoot, campaignId, taskId, suffix = '') {
  const legacy = join(worktreeRoot, `${campaignId}-${taskId}${suffix}`);
  return existsSync(legacy) ? legacy : join(worktreeRoot, `${workspaceName(campaignId, taskId)}${suffix}`);
}

// The helper owns these root-level artifacts even when a target does not ignore *.log.
// Tracked changes, other untracked files, directories and linked files remain dirty.
function verificationCheckoutClean(git, path) {
  const status = exec(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: path });
  if (!status.ok) return false;
  const artifacts = new Set(Object.values(GATE_FILES));
  return status.stdout.split('\0').filter(Boolean).every((entry) => {
    if (!entry.startsWith('?? ') || !artifacts.has(entry.slice(3))) return false;
    try {
      const file = lstatSync(join(path, entry.slice(3)));
      return file.isFile() && !file.isSymbolicLink() && file.nlink === 1;
    } catch { return false; }
  });
}

/** Isolated implementer worktree on the task branch; created from origin/<base> once, then reused. */
export function prepareImplementWorkspace({ git, repoPath, worktreeRoot, campaignId, taskId, baseBranch, baseSha }) {
  if (baseSha !== undefined && !SHA.test(baseSha)) throw new Error('implementation base must be a full SHA');
  const path = workspacePath(worktreeRoot, campaignId, taskId);
  const branch = branchName(campaignId, taskId);
  if (existsSync(path)) {
    const current = must(exec(git, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path }), 'inspect worktree branch');
    if (current !== branch) throw new Error(`worktree ${path} is on ${current}, expected ${branch}`);
  } else {
    if (!baseSha) must(exec(git, ['fetch', 'origin', baseBranch], { cwd: repoPath }), 'fetch base');
    const hasBranch = exec(git, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath }).ok;
    must(exec(git, hasBranch ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, baseSha ?? `origin/${baseBranch}`], { cwd: repoPath }), 'create worktree');
  }
  const head = must(exec(git, ['rev-parse', 'HEAD'], { cwd: path }), 'read worktree head');
  return { path, branch, head };
}

/** Fresh detached checkout of the exact target for the independent verifier. */
export function prepareVerifyWorkspace({ git, repoPath, worktreeRoot, campaignId, taskId, targetSha, attempt }) {
  if (!SHA.test(targetSha)) throw new Error('verify target must be a full SHA');
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('verify attempt must be a positive integer');
  const path = workspacePath(worktreeRoot, campaignId, taskId, `-verify-${targetSha.slice(0, 12)}-${attempt}`);
  if (existsSync(path)) {
    const head = must(exec(git, ['rev-parse', 'HEAD'], { cwd: path }), 'read verify head');
    if (head !== targetSha || !verificationCheckoutClean(git, path)) throw new Error(`verify worktree ${path} is not a clean checkout of ${targetSha}`);
  } else {
    must(exec(git, ['worktree', 'add', '--detach', path, targetSha], { cwd: repoPath }), 'create verify worktree');
  }
  return { path };
}

/** Deterministic acceptance of an implementer's claim: exact head, clean tree, new descendant commit. */
export function checkImplementation({ git, path, baseSha, headSha }) {
  const head = exec(git, ['rev-parse', 'HEAD'], { cwd: path }).stdout;
  if (head !== headSha) return `worktree HEAD ${head || 'unknown'} does not match reported headSha ${headSha}`;
  if (head === baseSha) return 'no new commit on the task branch';
  const status = exec(git, ['status', '--porcelain'], { cwd: path });
  if (!status.ok) return 'cannot read worktree status';
  if (status.stdout) return `uncommitted changes remain: ${status.stdout.split('\n').slice(0, 5).join(', ')}`;
  if (!exec(git, ['merge-base', '--is-ancestor', baseSha, headSha], { cwd: path }).ok) return `headSha is not a descendant of base ${baseSha}`;
  return null;
}

/**
 * Paths a commit changed since it left `from` (three-dot: since their merge base), renames as delete + add; null if git
 * fails. NUL-separated, so a path with spaces or non-ASCII characters arrives as written, never quoted.
 */
export function changedPaths({ git, path, from, to }) {
  const out = exec(git, ['diff', '--name-only', '-z', '--no-renames', `${from}...${to}`], { cwd: path });
  return out.ok ? out.stdout.split('\0').filter(Boolean) : null;
}

/** Inspect only small regular source-template blobs at the exact reported commit. */
export function safeEnvironmentExamples({ git, path, sha, paths }) {
  if (!SHA.test(sha ?? '')) return [];
  return paths.filter(environmentExamplePath).filter((file) => {
    const entry = exec(git, ['ls-tree', sha, '--', file], { cwd: path });
    if (!entry.ok || !/^100644 blob [0-9a-f]{40}\t/.test(entry.stdout)) return false;
    const blob = entry.stdout.split(/\s+/)[2];
    const size = exec(git, ['cat-file', '-s', blob], { cwd: path });
    if (!size.ok || !/^\d+$/.test(size.stdout) || Number(size.stdout) > 65536) return false;
    const source = exec(git, ['cat-file', 'blob', blob], { cwd: path });
    return source.ok && safeEnvironmentExample(file, source.stdout);
  });
}

export function currentHead({ git, path }) {
  return exec(git, ['rev-parse', 'HEAD'], { cwd: path }).stdout;
}

/**
 * The root gate artifacts the target itself tracks (aiworks#1), matched case-insensitively because a case-insensitive
 * file system reads GATE.LOG as gate.log; null when git fails. A committed artifact is worker-controlled and clean, so it
 * could pass as the verifier's own gate run.
 */
function trackedGateFiles(git, path) {
  const specs = Object.values(GATE_FILES).map((name) => `:(top,icase,literal)${name}`);
  const out = exec(git, ['ls-files', '-z', '--full-name', '--', ...specs], { cwd: path });
  return out.ok ? out.stdout.split('\0').filter(Boolean) : null;
}

/** A verifier may only accept the unchanged checkout it was dispatched to inspect. */
export function checkVerification({ git, path, targetSha }) {
  if (currentHead({ git, path }) !== targetSha) return 'verifier checkout no longer matches the target SHA';
  const tracked = trackedGateFiles(git, path);
  if (tracked === null) return 'verifier checkout is not clean: cannot read the files it tracks';
  if (tracked.length) return `verifier checkout is not clean: the target tracks reserved gate evidence: ${tracked.slice(0, 5).join(', ')}`;
  if (!verificationCheckoutClean(git, path)) return 'verifier checkout is not clean';
  return null;
}

export function assertPushActionsDisabled({ git, gh, repoPath, remote, expectedRepository = null }) {
  const out = exec(git, ['remote', 'get-url', '--push', '--all', remote], { cwd: repoPath });
  const refuse = () => { throw Object.assign(new Error('LOCAL_DEVELOPMENT_ONLY: push destination could not be verified'), { code: 'LOCAL_DEVELOPMENT_ONLY' }); };
  if (!out.ok || !out.stdout) refuse();
  const repositories = new Set();
  for (const url of out.stdout.split(/\r?\n/)) {
    const repository = githubRemote(url);
    if (repository) {
      if (expectedRepository && repository.toLowerCase() !== expectedRepository.toLowerCase()) refuse();
      repositories.add(repository);
    } else {
      // Offline local repositories cannot run GitHub Actions; helper and network transports stay refused.
      if (!isAbsolute(url) || /^[\\/]{2}/.test(url) || url.includes('://') || !existsSync(url) || !lstatSync(url).isDirectory()) refuse();
    }
  }
  for (const repository of repositories) assertActionsDisabled({ gh, repository });
}

/** Push exactly the verified SHA (not a moving HEAD) to the campaign branch. */
export function pushVerified({ git, gh, repository, repoPath, branch, sha }) {
  assertActionsDisabled({ gh, repository });
  assertPushActionsDisabled({ git, gh, repoPath, remote: 'origin', expectedRepository: repository });
  must(exec(git, ['push', 'origin', `${sha}:refs/heads/${branch}`], { cwd: repoPath }), 'push verified commit');
  const remote = must(exec(git, ['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: repoPath }), 'read remote branch');
  if (!remote.startsWith(sha)) throw new Error(`remote ${branch} is not at verified ${sha}`);
}

/** Whether `ancestor` is reachable from `descendant`. Read-only. */
export function isAncestor({ git, path, ancestor, descendant }) {
  return exec(git, ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: path }).ok;
}

/** Heads of the remote branches matching `pattern` (for example `refs/heads/campaign/<id>/*`), or null when unreadable. */
export function remoteBranches({ git, repoPath, pattern }) {
  const out = exec(git, ['ls-remote', 'origin', pattern], { cwd: repoPath, timeoutMs: 30_000 });
  if (!out.ok) return null;
  return new Map(out.stdout.split('\n').filter(Boolean).map((line) => line.split(/\s+/)).map(([sha, ref]) => [ref, sha]));
}

/**
 * Heads of the local branches matching `pattern`, as remoteBranches returns them, or null when unreadable. The
 * self-hosted repository (LOCAL_OPERATION.md section 4, slice SELF4) keeps its campaign branches here: no remote is read.
 */
export function localBranches({ git, repoPath, pattern }) {
  const out = exec(git, ['for-each-ref', '--format=%(objectname) %(refname)', pattern.replace(/\/\*$/, '/')], { cwd: repoPath, timeoutMs: 30_000 });
  if (!out.ok) return null;
  return new Map(out.stdout.split('\n').filter(Boolean).map((line) => line.split(/\s+/)).map(([sha, ref]) => [ref, sha]));
}

/**
 * Local integration check (aiworks#27): would `sha` merge cleanly into `baseSha`? `git merge-tree --write-tree` (Git 2.38+)
 * only writes objects: it never touches a worktree, the index or a ref, and makes no network or GitHub call.
 * Returns { clean, tree, baseTree, paths }: `paths` are the conflicting files.
 */
export function mergeCheck({ git, repoPath, baseSha, sha }) {
  if (!SHA.test(baseSha) || !SHA.test(sha)) throw new Error('merge check needs full SHAs');
  const out = exec(git, ['merge-tree', '--write-tree', '--name-only', '--no-messages', baseSha, sha], { cwd: repoPath, timeoutMs: 60_000 });
  if (out.status !== 0 && out.status !== 1) must(out, 'merge-tree');
  const [tree, ...paths] = out.stdout.split('\n').map((line) => line.trim());
  if (!SHA.test(tree ?? '')) throw new Error(`merge-tree returned no tree: ${out.stdout.slice(0, 200)}`);
  const baseTree = must(exec(git, ['rev-parse', `${baseSha}^{tree}`], { cwd: repoPath }), 'read base tree');
  return { clean: out.status === 0, tree, baseTree, paths: out.status === 0 ? [] : [...new Set(paths.filter(Boolean))] };
}

/** The base commits, absent from `sha`, that changed any of `paths` (newest first, at most `limit`). */
export function siblingCommits({ git, repoPath, baseSha, sha, paths, limit = 10 }) {
  const out = exec(git, ['log', `--max-count=${limit}`, '--format=%H %s', baseSha, `^${sha}`, '--', ...paths], { cwd: repoPath });
  return out.ok ? out.stdout.split('\n').filter(Boolean).map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41, 200) })) : [];
}

/** The repository's registered worktrees ({ path, head, branch, locked }), the main checkout first; null when unreadable. */
export function worktreeList({ git, repoPath }) {
  const out = exec(git, ['worktree', 'list', '--porcelain', '-z'], { cwd: repoPath, timeoutMs: 30_000 });
  if (!out.ok) return null;
  const list = [];
  for (const field of out.stdout.split('\0')) {
    const [key, ...rest] = field.split(' '), value = rest.join(' ');
    if (key === 'worktree') list.push({ path: value, head: null, branch: null, locked: false });
    else if (!list.length) continue;
    else if (key === 'HEAD') list.at(-1).head = value;
    else if (key === 'branch') list.at(-1).branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'locked') list.at(-1).locked = true;
  }
  return list;
}

/**
 * Uncommitted, untracked (`?? `) and ignored (`!! `) entries of a checkout; null when git cannot read it. A non-forced
 * `git worktree remove` deletes ignored files, so they are listed too: an ignored directory as one `!! dir/` entry.
 */
export function worktreeChanges({ git, path }) {
  const out = exec(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], { cwd: path, timeoutMs: 60_000 });
  return out.ok ? out.stdout.split('\0').filter(Boolean) : null;
}

/** `git worktree remove` without --force: git itself refuses a checkout with changes, untracked files or a lock. */
export function removeWorktree({ git, repoPath, path }) {
  return exec(git, ['worktree', 'remove', path], { cwd: repoPath, timeoutMs: 120_000 });
}

/** `git branch -d`, never -D: git itself refuses a branch that is checked out or not merged. */
export function deleteMergedBranch({ git, repoPath, branch }) {
  return exec(git, ['branch', '-d', branch], { cwd: repoPath, timeoutMs: 30_000 });
}
