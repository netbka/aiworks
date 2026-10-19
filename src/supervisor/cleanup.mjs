// Cleanup after finished work (PROJECT_WORKSPACE_PLAN 6.8c, slice CLN1; decision (l) of section 8). Built switched off:
// nothing here runs unless config.json says "cleanup": { "enabled": true }; absent or any other value is off. CLN2
// switches it on through the upgrade procedure.
//
// A task is finished when it has no open operation and either the trusted main contains its verified commit or its
// campaign is finished or cancelled. Its worktrees are the workspaces its operations recorded; a coordinator or planning
// checkout is owned by the coordinator runs that recorded it, and is finished when none of them is open. Only a
// registered worktree inside its registered folder is removed, with `git worktree remove` (never --force); one with
// changes or untracked files is kept and reported, and so is a worktree nobody owns. A local task branch goes with
// `git branch -d` (never -D) only when the trusted main contains its tip. Nothing deletes a remote branch, a run
// directory or a folder recursively. Each removal is journaled `cleanup-started` before and `cleanup-finished` after,
// so a restart settles an interrupted one from what git shows and never repeats it.
import { constants, copyFileSync, existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import * as gitA from './adapters/git.mjs';
import { GATE_FILES } from './gate.mjs';
import { LANE as COORDINATOR_LANE, coordinatorWorktreeRoot } from './coordinator.mjs';
import { isLocalTarget } from './local-candidates.mjs';

const SHA = /^[0-9a-f]{40}$/;
const OPEN = ['recorded', 'dispatched'];
const GATE_NAMES = new Set(Object.values(GATE_FILES));

export const cleanupEnabled = (config) => config?.cleanup?.enabled === true;

// Per controller: when the last pass ran, whether interrupted removals were settled, and what was already reported kept.
const memory = new WeakMap();

const key = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
const within = (root, path) => {
  const rel = relative(root, path);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
};
/** Inside the registered folder by name and, when it exists, after links are resolved. */
function insideRoot(root, path) {
  if (!root || !within(resolve(root), resolve(path))) return false;
  if (!existsSync(path)) return true;
  try { return within(realpathSync.native(root), realpathSync.native(path)); } catch { return false; }
}

/**
 * One cleanup pass, at most once per integrationPollMs. Returns { removed, deleted, kept } (paths and branches), or null
 * when it did not run: switched off, unmerged runtime code (AW-005), or not yet due.
 */
export function cleanupPass(ctl) {
  if (!cleanupEnabled(ctl.config) || ctl.unmergedRevision()) return null;
  const state = memory.get(ctl) ?? { checkedAt: -Infinity, reconciled: false, reported: new Set() };
  memory.set(ctl, state);
  const now = ctl.now();
  if (state.checkedAt + ctl.config.integrationPollMs > now) return null;
  state.checkedAt = now;
  if (!state.reconciled) { reconcile(ctl); state.reconciled = true; }
  const report = { removed: [], deleted: [], kept: [] };
  const keep = (campaignId, item) => {
    report.kept.push(item);
    const seen = `${item.path ?? item.branch}\n${item.reason}`;
    if (state.reported.has(seen)) return;
    state.reported.add(seen);
    ctl.store.journal(campaignId, 'cleanup-kept', item, ctl.now());
  };
  const coordinator = coordinatorOwners(ctl);
  for (const repo of repositories(ctl)) cleanRepository(ctl, repo, coordinator, report, keep);
  cleanCoordinator(ctl, coordinator, report, keep);
  if (report.removed.length || report.deleted.length) ctl.log(`cleanup removed ${report.removed.length} worktrees and ${report.deleted.length} branches`);
  return report;
}

/** A live lease held by another supervisor instance: that instance may be working on it, so nothing is touched. */
function foreignLease(ctl, id) {
  const lease = ctl.store.lease(id);
  return Boolean(lease && lease.instance_id !== ctl.instanceId && lease.expires_at > ctl.now());
}

/** Every campaign grouped by its checkout, with the tasks and recorded workspaces it owns. */
function repositories(ctl) {
  const byPath = new Map();
  for (const c of ctl.store.all('SELECT id, control, declaration FROM campaigns')) {
    const repo = ctl.checkout(c.declaration);
    if (!repo?.path || !repo.worktreeRoot) continue;
    const entry = byPath.get(key(repo.path)) ?? { path: repo.path, root: repo.worktreeRoot, repository: c.declaration.target.repository, local: true, campaigns: [] };
    if (!isLocalTarget(c.declaration)) entry.local = false;
    entry.campaigns.push(c);
    byPath.set(key(repo.path), entry);
  }
  return [...byPath.values()];
}

function cleanRepository(ctl, repo, coordinator, report, keep) {
  const git = ctl.cmd.git;
  const list = gitA.worktreeList({ git, repoPath: repo.path });
  if (!list) { keep(null, { path: repo.path, reason: 'worktree-list-unreadable' }); return; }
  const registered = new Map(list.slice(1).map((wt) => [key(wt.path), wt]));
  // The trusted main: origin/main as the supervisor fetches it, or the trusted tip of local main when self-hosted.
  const main = repo.local || !repo.repository ? null : ctl.fetchBase(repo.path, 'main', repo.repository).sha;
  const contained = (sha) => SHA.test(sha ?? '') && SHA.test(main ?? '') && gitA.isAncestor({ git, path: repo.path, ancestor: sha, descendant: main });
  const owners = new Map(), finishedTasks = [];
  for (const c of repo.campaigns) {
    const terminal = ['finished', 'cancelled'].includes(c.control), foreign = foreignLease(ctl, c.id);
    for (const task of ctl.store.tasks(c.id)) {
      const ops = ctl.store.all('SELECT workspace, state, run_dir FROM operations WHERE campaign_id = ? AND task_id = ? ORDER BY created_at', c.id, task.task_id);
      const finished = !foreign && !ops.some((op) => OPEN.includes(op.state)) && (terminal || (task.state === 'done' && contained(task.verified_sha)));
      for (const op of ops) owners.set(key(op.workspace), { campaignId: c.id, task: task.task_id, finished, runDir: op.run_dir, path: op.workspace });
      if (finished && !isLocalTarget(c.declaration)) finishedTasks.push({ campaignId: c.id, task: task.task_id });
    }
  }
  for (const [path, wt] of registered) {
    if (owners.has(path) || coordinator.has(path)) continue;
    if (within(resolve(repo.root), resolve(wt.path))) keep(null, { path: wt.path, reason: 'unowned' });
  }
  for (const [path, owner] of owners) {
    const wt = registered.get(path);
    if (!wt || !owner.finished) continue;
    if (!insideRoot(repo.root, wt.path)) { keep(owner.campaignId, { path: wt.path, task: owner.task, reason: 'outside-root' }); continue; }
    removeWorktree(ctl, repo.path, wt, owner, report, keep);
  }
  if (!SHA.test(main ?? '')) return;
  const checkedOut = new Set((gitA.worktreeList({ git, repoPath: repo.path }) ?? list).map((wt) => wt.branch).filter(Boolean));
  for (const { campaignId, task } of finishedTasks) {
    const branch = gitA.branchName(campaignId, task);
    const tip = gitA.exec(git, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { cwd: repo.path }).stdout;
    if (!SHA.test(tip ?? '')) continue;
    if (checkedOut.has(branch)) { keep(campaignId, { branch, task, reason: 'checked-out' }); continue; }
    if (!contained(tip)) { keep(campaignId, { branch, task, reason: 'not-in-main' }); continue; }
    const started = ctl.store.journal(campaignId, 'cleanup-started', { action: 'delete-branch', task, branch, sha: tip, repoPath: repo.path }, ctl.now());
    const result = gitA.deleteMergedBranch({ git, repoPath: repo.path, branch });
    const reason = result.ok ? null : (result.stderr || result.error || `exit ${result.status}`).slice(0, 300);
    ctl.store.journal(campaignId, 'cleanup-finished', { started, outcome: result.ok ? 'deleted' : 'kept', reason }, ctl.now());
    if (result.ok) report.deleted.push(branch); else keep(campaignId, { branch, task, reason: 'git-refused' });
  }
}

/**
 * Remove one finished, owned, registered worktree inside its folder. The verifier's gate files at its root are copied
 * into the owning run directory first: git would delete them when ignored, and refuse the removal when untracked.
 */
function removeWorktree(ctl, repoPath, wt, owner, report, keep) {
  const git = ctl.cmd.git, item = { path: wt.path, task: owner.task, run: owner.run };
  if (wt.locked) { keep(owner.campaignId, { ...item, reason: 'locked' }); return; }
  const present = existsSync(wt.path);
  const changes = present ? gitA.worktreeChanges({ git, path: wt.path }) : [];
  if (changes === null) { keep(owner.campaignId, { ...item, reason: 'status-unreadable' }); return; }
  const gateArtifact = (entry) => entry.startsWith('?? ') && GATE_NAMES.has(entry.slice(3));
  if (changes.some((entry) => !gateArtifact(entry))) { keep(owner.campaignId, { ...item, reason: 'changes', entries: changes.slice(0, 5) }); return; }
  // A detached checkout whose commit no branch or remote ref holds would lose that commit with it.
  if (present && !wt.branch && !gitA.exec(git, ['for-each-ref', '--count=1', '--contains', wt.head, 'refs/heads', 'refs/remotes', 'refs/aiworks'], { cwd: repoPath }).stdout) {
    keep(owner.campaignId, { ...item, reason: 'unreferenced-commit' }); return;
  }
  const gateFiles = present ? [...GATE_NAMES].filter((name) => existsSync(join(wt.path, name))) : [];
  if (gateFiles.length && !preserveGateFiles(wt.path, owner.runDir, gateFiles)) { keep(owner.campaignId, { ...item, reason: 'evidence-not-preserved' }); return; }
  const started = ctl.store.journal(owner.campaignId, 'cleanup-started', { action: 'remove-worktree', ...item, repoPath }, ctl.now());
  // Only the untracked gate files, each one file and already copied; every other file is git's to refuse.
  for (const entry of changes) unlinkSync(join(wt.path, entry.slice(3)));
  const result = gitA.removeWorktree({ git, repoPath, path: wt.path });
  const reason = result.ok ? null : (result.stderr || result.error || `exit ${result.status}`).slice(0, 300);
  ctl.store.journal(owner.campaignId, 'cleanup-finished', { started, outcome: result.ok ? 'removed' : 'kept', reason }, ctl.now());
  if (result.ok) report.removed.push(wt.path); else keep(owner.campaignId, { ...item, reason: 'git-refused' });
}

/** Copy each gate file into the run directory under a name of this worktree; an identical earlier copy counts. */
function preserveGateFiles(path, runDir, names) {
  if (!runDir || !existsSync(runDir)) return false;
  for (const name of names) {
    const from = join(path, name), to = join(runDir, `worktree-${basename(path)}-${name}`);
    try {
      copyFileSync(from, to, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST' || !readFileSync(from).equals(readFileSync(to))) return false;
    }
  }
  return true;
}

/** Coordinator and planning checkouts by path: owned by the coordinator runs that recorded them. */
function coordinatorOwners(ctl) {
  const owners = new Map();
  for (const run of ctl.store.all('SELECT id, workspace, state, run_dir FROM coordinator_runs ORDER BY created_at')) {
    const previous = owners.get(key(run.workspace));
    owners.set(key(run.workspace), { campaignId: COORDINATOR_LANE, run: run.id, runDir: run.run_dir, path: run.workspace,
      finished: (previous?.finished ?? true) && !OPEN.includes(run.state) });
  }
  return owners;
}

function cleanCoordinator(ctl, owners, report, keep) {
  // A boundary violation keeps every coordinator checkout until the owner has inspected it and cleared the lane.
  if (!owners.size || foreignLease(ctl, COORDINATOR_LANE) || ctl.store.get("SELECT 1 AS v FROM meta WHERE key = 'coordinator_violation'")) return;
  const root = coordinatorWorktreeRoot(ctl);
  for (const owner of owners.values()) {
    if (!owner.finished || !existsSync(owner.path)) continue;
    // The checkout's own repository lists it; the first entry is that repository's main checkout.
    const list = gitA.worktreeList({ git: ctl.cmd.git, repoPath: owner.path });
    const wt = list?.slice(1).find((entry) => key(entry.path) === key(owner.path));
    if (!wt) continue;
    if (!insideRoot(root, wt.path)) { keep(COORDINATOR_LANE, { path: wt.path, run: owner.run, reason: 'outside-root' }); continue; }
    removeWorktree(ctl, list[0].path, wt, owner, report, keep);
  }
}

/** After a restart: settle every removal journaled as started but never finished, from what git shows now. */
function reconcile(ctl) {
  const git = ctl.cmd.git;
  const open = ctl.store.all(`SELECT s.seq, s.campaign_id, s.detail FROM journal s WHERE s.kind = 'cleanup-started' AND NOT EXISTS
    (SELECT 1 FROM journal f WHERE f.kind = 'cleanup-finished' AND json_extract(f.detail, '$.started') = s.seq) ORDER BY s.seq`);
  for (const { seq, campaign_id: campaignId, detail } of open) {
    let done;
    if (detail.action === 'remove-worktree') {
      const list = gitA.worktreeList({ git, repoPath: detail.repoPath });
      done = Boolean(list) && !list.some((wt) => key(wt.path) === key(detail.path)) && !existsSync(detail.path);
    } else {
      done = existsSync(detail.repoPath) && !gitA.exec(git, ['rev-parse', '--verify', '--quiet', `refs/heads/${detail.branch}`], { cwd: detail.repoPath }).ok;
    }
    // Not done: the next pass decides again from its own checks; nothing is retried from this record.
    ctl.store.journal(campaignId, 'cleanup-finished', { started: seq, outcome: done ? (detail.action === 'remove-worktree' ? 'removed' : 'deleted') : 'interrupted', reconciled: true }, ctl.now());
  }
}
