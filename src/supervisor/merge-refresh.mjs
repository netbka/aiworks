// Merge-gate refresh (opt-in, config.json `merges.refresh`): when the base moved past a verified pull request without
// touching any file the pull request changed, the supervisor gates the exact merge result itself instead of reopening
// the task for an AI repair round. Measured 2026-10-16/17: 19 of 23 `merge-base-moved` rounds shared no file with the
// base, and each round cost a fresh implementer, a fresh verifier and two full gates.
//
// The rule (merge.mjs, condition 3): a pull request merges only when the merge commit carries a tree that was checked.
// Without a refresh that tree is the verified head itself. With a refresh it is the clean merge of the verified head
// and the current base, built with `git merge-tree`, committed only locally (never pushed) and checked out in a detached
// worktree, where the configured gate command runs through the gate helper (gate.mjs) as a separate process. GitHub's
// merge of the unchanged pull request head into that same base writes that same tree; the local merge gate of the
// self-hosted repository (merge.mjs mergeLocal) writes a merge commit with exactly that tree itself. A shared file, a textual
// conflict, a failed or stuck gate, or a git failure falls back to the integration repair (merge.mjs repair). The
// journal records every step, so a restart continues the same refresh: `merge-refresh-started` (with the worktree and
// gate process), then `merge-refresh-passed` or `merge-refresh-failed`. A gate is never killed. Worktrees are left in
// place, like every supervisor worktree (adapters/git.mjs).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gitA from './adapters/git.mjs';
import { GATE_FILES, gateFailure, readGateRun } from './gate.mjs';

const GATE = fileURLToPath(new URL('./gate.mjs', import.meta.url));
const KINDS = ['merge-refresh-started', 'merge-refresh-passed', 'merge-refresh-failed'];
const DEFAULT_TIMEOUT_MINUTES = 120;
export const IDENTITY = ['-c', 'user.name=AIWorks Supervisor', '-c', 'user.email=supervisor@aiworks.invalid'];

/**
 * `merges.refresh` from config.json: `{ "command": ["npm", "ci", "&&", "npm", "run", "check"], "timeoutMinutes": 120 }`.
 * Absent: null (no refresh; every moved base is an integration repair, as before). Malformed: { problem }.
 */
export function refreshSettings(value) {
  if (value === undefined || value === null) return null;
  const problem = (text) => ({ problem: `merges.refresh ${text}` });
  if (typeof value !== 'object' || Array.isArray(value)) return problem('must be an object');
  const { command, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES } = value;
  if (!Array.isArray(command) || !command.length || !command.every((part) => typeof part === 'string' && part.trim())) {
    return problem('.command must list the gate command, for example ["npm", "ci", "&&", "npm", "run", "check"]');
  }
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1) return problem('.timeoutMinutes must be a positive number of minutes');
  return { command: [...command], timeoutMs: timeoutMinutes * 60_000 };
}

/** The refresh records for one verified head against one base, oldest first. */
function records(store, campaignId, taskId, sha, base) {
  return store.all(`SELECT kind, at, detail FROM journal WHERE campaign_id = ? AND kind IN (${KINDS.map(() => '?').join(', ')})
    AND json_extract(detail, '$.task') = ? AND json_extract(detail, '$.sha') = ? AND json_extract(detail, '$.base') = ? ORDER BY seq`,
  campaignId, ...KINDS, taskId, sha, base);
}

export const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
export const gatePid = (path) => {
  const file = join(path, GATE_FILES.pid);
  const pid = existsSync(file) ? Number(readFileSync(file, 'utf8').trim()) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};

/** Starts the gate helper in `path` as a separate process; it returns at once. */
export function startGate(path, command) {
  const started = gitA.exec([process.execPath], [GATE, 'start', ...command], { cwd: path, timeoutMs: 60_000 });
  if (!started.ok) throw new Error(`gate start failed: ${started.stderr || started.stdout || `exit ${started.status}`}`.slice(0, 500));
}

/** A clean detached checkout of `commit` in `path`, reusing one that is already there. */
export function checkout(git, repoPath, path, commit) {
  if (existsSync(path)) {
    const head = gitA.exec(git, ['rev-parse', 'HEAD'], { cwd: path });
    if (head.ok && head.stdout === commit) return;
    throw new Error(`refresh worktree ${path} exists at ${head.stdout || 'an unreadable head'}, not ${commit}`);
  }
  const added = gitA.exec(git, ['worktree', 'add', '--detach', path, commit], { cwd: repoPath });
  if (!added.ok) throw new Error(`create refresh worktree failed: ${added.stderr || `exit ${added.status}`}`.slice(0, 500));
}

/** The merge tree to gate ({ tree }), or why the base and the pull request need an AI round instead ({ reason, shared }). */
function refreshPlan(git, repoPath, baseSha, sha) {
  const ours = gitA.changedPaths({ git, path: repoPath, from: baseSha, to: sha });
  const theirs = gitA.changedPaths({ git, path: repoPath, from: sha, to: baseSha });
  if (!ours || !theirs) return { reason: 'the changed files could not be read' };
  const fold = (path) => path.toLowerCase();
  const moved = new Set(theirs.map(fold));
  const shared = ours.filter((path) => moved.has(fold(path)));
  if (shared.length) return { reason: `the base changed ${shared.length} file(s) this pull request changed too`, shared: shared.slice(0, 20) };
  const check = gitA.mergeCheck({ git, repoPath, baseSha, sha });
  if (!check.clean) return { reason: 'the merge has conflicts', shared: check.paths.slice(0, 20) };
  return { tree: check.tree };
}

/**
 * The tree whose gate passed for one verified head against one base, or null. Read-only: the local merge gate uses it
 * after a crash to recognize the refreshed merge commit it requested (merge.mjs mergeLocal).
 */
export function passedTree(store, campaignId, taskId, sha, base) {
  const done = records(store, campaignId, taskId, sha, base).find((row) => row.kind !== 'merge-refresh-started');
  return done?.kind === 'merge-refresh-passed' && typeof done.detail.tree === 'string' ? done.detail.tree : null;
}

/**
 * One step of the refresh of `item` against `baseSha`, inside the merge pass and holding the campaign lease (`ctx`).
 * Returns { tree, next: 'merge' } when the exact merge result, `tree`, passed the gate, { next: 'wait', reason } while the gate runs, or
 * { next: 'repair', detail } when the integration repair must run instead (`detail` goes into its finding).
 */
export function refreshStep(controller, ctx, item, repoPath, baseSha, settings) {
  const { store } = controller, git = controller.cmd.git, { campaignId, decl, task } = item;
  const sha = task.verified_sha, key = { task: task.task_id, sha, base: baseSha }, now = controller.now();
  const journal = (kind, detail) => controller.fenced(ctx, () => store.journal(campaignId, kind, { ...key, ...detail }, now));
  const seen = records(store, campaignId, task.task_id, sha, baseSha);
  const done = seen.find((row) => row.kind !== 'merge-refresh-started');
  if (done?.kind === 'merge-refresh-passed') return { tree: done.detail.tree, next: 'merge' };
  if (done) return { next: 'repair', detail: done.detail.reason };
  const fail = (reason, extra = {}) => {
    journal('merge-refresh-failed', { reason, ...extra });
    controller.log(`refresh of ${campaignId}/${task.task_id} against ${baseSha}: ${reason}`);
    return { next: 'repair', detail: reason };
  };

  const started = seen.find((row) => row.kind === 'merge-refresh-started');
  if (!started) {
    let plan;
    try { plan = refreshPlan(git, repoPath, baseSha, sha); } catch (error) { return fail(`the merge could not be computed: ${error.message}`); }
    if (!plan.tree) return fail(plan.reason, plan.shared ? { paths: plan.shared } : {});
    const path = join(controller.repo(decl).worktreeRoot, `${gitA.workspaceName(campaignId, task.task_id)}-refresh-${sha.slice(0, 12)}-${baseSha.slice(0, 12)}`);
    try {
      const commit = gitA.exec(git, [...IDENTITY, 'commit-tree', plan.tree, '-p', baseSha, '-p', sha, '-m', `AIWorks refresh: ${sha} merged with ${baseSha} (local only)`], { cwd: repoPath });
      if (!commit.ok) throw new Error(`commit-tree failed: ${commit.stderr || `exit ${commit.status}`}`);
      checkout(git, repoPath, path, commit.stdout);
      // Recorded before the gate starts: after a crash here the next pass finds the worktree and starts the gate.
      journal('merge-refresh-started', { tree: plan.tree, commit: commit.stdout, path, command: settings.command });
      startGate(path, settings.command);
    } catch (error) {
      return fail(`the refresh could not start: ${error.message}`);
    }
    controller.log(`refresh of ${campaignId}/${task.task_id}: gate started on the merge with ${baseSha} in ${path}`);
    return { next: 'wait', reason: `the base moved without touching this pull request; the gate runs on the merge result (${baseSha.slice(0, 12)})` };
  }

  const { path } = started.detail;
  const run = readGateRun(path);
  if (run?.exit === null || run === null) {
    const pid = gatePid(path);
    // Never killed: after a reboot the recorded process id can belong to another process, and the gate's own children
    // run outside any Job Object. A gate past its bound fails the refresh, and the repair takes over.
    if (now - started.at > settings.timeoutMs) return fail(`the gate did not finish within ${Math.round(settings.timeoutMs / 60_000)} minutes`);
    // A gate that ended without an exit code (a supervisor restart, a reboot) starts again in the same worktree. A reused
    // process id reads as alive, so that gate waits out its bound instead, which is slow but safe.
    if (pid === null || !alive(pid)) {
      try { startGate(path, started.detail.command ?? settings.command); } catch (error) { return fail(`the gate could not restart: ${error.message}`); }
      controller.log(`refresh of ${campaignId}/${task.task_id}: gate restarted in ${path}`);
    }
    return { next: 'wait', reason: `the gate runs on the merge result (${baseSha.slice(0, 12)})` };
  }
  const failure = gateFailure(run);
  if (failure) return fail(`the gate on the merge result ${failure}`, { summary: run.summary });
  // The pass counts only for the checkout it was meant for: still at the recorded commit, whose tree is the merge tree.
  const head = gitA.exec(git, ['rev-parse', 'HEAD', 'HEAD^{tree}'], { cwd: path });
  if (!head.ok || head.stdout.split(/\s+/).join(' ') !== `${started.detail.commit} ${started.detail.tree}`) {
    return fail(`the gate passed, but its checkout is no longer at the merge result ${started.detail.commit}`);
  }
  journal('merge-refresh-passed', { tree: started.detail.tree, summary: run.summary });
  controller.log(`refresh of ${campaignId}/${task.task_id}: the merge with ${baseSha} passed the gate`);
  return { tree: started.detail.tree, next: 'merge' };
}
