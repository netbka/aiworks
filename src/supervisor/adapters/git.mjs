// AIWorks workspace and publication adapter. Every function is idempotent: it inspects
// existing state before creating anything, so a controller restarted at any point can call
// it again. Worktrees are never removed here (cleanup stays a separate owner/maintenance step).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SHA = /^[0-9a-f]{40}$/;

export function exec(command, args, { cwd, input, timeoutMs = 180_000 } = {}) {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd, input, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: !result.error && result.status === 0, status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim(), error: result.error?.code };
}

function must(result, what) {
  if (!result.ok) throw new Error(`${what} failed: ${result.error || result.stderr || result.stdout || `exit ${result.status}`}`.slice(0, 1000));
  return result.stdout;
}

export const branchName = (campaignId, taskId) => `campaign/${campaignId}/${taskId}`;

/** Isolated implementer worktree on the task branch; created from origin/<base> once, then reused. */
export function prepareImplementWorkspace({ git, repoPath, worktreeRoot, campaignId, taskId, baseBranch, baseSha }) {
  if (baseSha !== undefined && !SHA.test(baseSha)) throw new Error('implementation base must be a full SHA');
  const path = join(worktreeRoot, `${campaignId}-${taskId}`);
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
  const path = join(worktreeRoot, `${campaignId}-${taskId}-verify-${targetSha.slice(0, 12)}-${attempt}`);
  if (existsSync(path)) {
    const head = must(exec(git, ['rev-parse', 'HEAD'], { cwd: path }), 'read verify head');
    const dirty = must(exec(git, ['status', '--porcelain'], { cwd: path }), 'read verify status');
    if (head !== targetSha || dirty) throw new Error(`verify worktree ${path} is not a clean checkout of ${targetSha}`);
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

export function currentHead({ git, path }) {
  return exec(git, ['rev-parse', 'HEAD'], { cwd: path }).stdout;
}

/** A verifier may only accept the unchanged checkout it was dispatched to inspect. */
export function checkVerification({ git, path, targetSha }) {
  if (currentHead({ git, path }) !== targetSha) return 'verifier checkout no longer matches the target SHA';
  const status = exec(git, ['status', '--porcelain'], { cwd: path });
  if (!status.ok || status.stdout) return 'verifier checkout is not clean';
  return null;
}

/** Push exactly the verified SHA (not a moving HEAD) to the campaign branch. */
export function pushVerified({ git, repoPath, branch, sha }) {
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
