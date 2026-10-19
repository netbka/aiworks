// Group merge (opt-in, config.json `merges.batch: true`, AW-014): when several verified pull requests wait for one base,
// the supervisor merges them together instead of one at a time. Each was verified on its own, but on an older base; what
// lands on the base is their combination, so that combination is what the gate runs on, once.
//
// The group is built locally: each head is merged in turn onto the previous result with `git merge-tree`, committed only
// locally (never pushed) and checked out in a detached worktree, where the configured gate command (merges.refresh) runs
// through the gate helper. A pull request that conflicts stays out of the group. When the gate passes, the pull requests
// merge on GitHub in the same order, each only while the base is exactly the previous step of the checked chain, and each
// merge commit must carry the tree that step predicted. A failed or stuck gate, a base that moved, or a pull request that
// can no longer merge ends the group; the rest go one at a time as before (merge.mjs). The journal (no campaign) records
// `merge-batch-started`, `-passed`, `-failed`, `-stopped` and `-done`, so a restart continues the same group. A gate is
// never killed.
import { join } from 'node:path';
import * as gitA from './adapters/git.mjs';
import { gateFailure, readGateRun } from './gate.mjs';
import { IDENTITY, alive, checkout, gatePid, startGate } from './merge-refresh.mjs';
import { inspect, mergeBlocker, mergeNow, wait } from './merge.mjs';

const KINDS = ['merge-batch-started', 'merge-batch-passed', 'merge-batch-failed', 'merge-batch-stopped', 'merge-batch-done'];
const ENDED = new Set(['merge-batch-failed', 'merge-batch-stopped', 'merge-batch-done']);

/** The groups of one repository, oldest first: { id, started, last }. */
function groups(store, repository) {
  const rows = store.all(`SELECT kind, at, detail FROM journal WHERE campaign_id IS NULL AND kind IN (${KINDS.map(() => '?').join(', ')})
    AND json_extract(detail, '$.repository') = ? ORDER BY seq`, ...KINDS, repository);
  const byId = new Map();
  for (const row of rows) byId.set(row.detail.id, [...(byId.get(row.detail.id) ?? []), row]);
  return [...byId.entries()].map(([id, list]) => ({ id, started: list.find((row) => row.kind === 'merge-batch-started'), last: list.at(-1) }));
}

/** The latest journal row of `kind` for one member's verified head, or null. */
const memberRow = (store, { campaignId, task, sha }, kind) => store.get(`SELECT detail FROM journal WHERE campaign_id = ? AND kind = ?
  AND json_extract(detail, '$.task') = ? AND json_extract(detail, '$.sha') = ? ORDER BY seq DESC LIMIT 1`, campaignId, kind, task, sha)?.detail ?? null;

/** A refresh of this verified head against this base that started and has not ended (merge-refresh.mjs). */
const refreshRunning = (store, { campaignId, task }, base) => store.all(`SELECT kind FROM journal WHERE campaign_id = ?
  AND kind IN ('merge-refresh-started', 'merge-refresh-passed', 'merge-refresh-failed') AND json_extract(detail, '$.task') = ?
  AND json_extract(detail, '$.sha') = ? AND json_extract(detail, '$.base') = ?`, campaignId, task.task_id, task.verified_sha, base)
  .map((row) => row.kind).join(' ') === 'merge-refresh-started';

const treeOf = (git, repoPath, commit) => gitA.exec(git, ['rev-parse', `${commit}^{tree}`], { cwd: repoPath }).stdout;

/**
 * One group-merge step for the waiting pull requests of one repository and base branch (`items`, oldest campaign first,
 * then plan order). Returns true when the group handled the repository this pass (it acted or waits), false when the pull
 * requests go one at a time instead.
 */
export function batchStep(controller, items, settings, repoPath, baseSha) {
  if (!items.length) return false;
  const repository = items[0].decl.target.repository.toLowerCase();
  const note = (kind, detail) => controller.store.tx(() => controller.store.journal(null, kind, { repository, ...detail }, controller.now()));
  const all = groups(controller.store, repository);
  const open = all.find((group) => group.started && !ENDED.has(group.last.kind));
  return open ? continueGroup(controller, open, items, settings, repoPath, baseSha, note)
    : startGroup(controller, all, items, settings, repoPath, baseSha, note);
}

function startGroup(controller, all, items, settings, repoPath, baseSha, note) {
  const git = controller.cmd.git, ready = [];
  for (const item of items) {
    const { pr, acted } = inspect(controller, item, settings, repoPath, baseSha);
    if (acted) return true;
    if (!pr) continue;
    const blocker = mergeBlocker(controller, item, pr);
    if (blocker) { wait(controller, item, blocker); continue; }
    ready.push(item);
  }
  // A pull request whose own refresh already runs on this base finishes that first.
  if (ready.length < 2 || ready.some((item) => refreshRunning(controller.store, item, baseSha))) return false;
  const members = [];
  let head = baseSha;
  for (const item of ready) {
    const sha = item.task.verified_sha;
    let check;
    try { check = gitA.mergeCheck({ git, repoPath, baseSha: head, sha }); } catch { continue; }
    if (!check.clean) continue;
    const commit = gitA.exec(git, [...IDENTITY, 'commit-tree', check.tree, '-p', head, '-p', sha, '-m', `AIWorks group merge: ${sha} onto ${head} (local only)`], { cwd: repoPath });
    if (!commit.ok) continue;
    members.push({ campaignId: item.campaignId, task: item.task.task_id, sha, url: item.task.pr_url, tree: check.tree });
    head = commit.stdout;
  }
  if (members.length < 2) return false;
  // The same group on the same base is gated once: after a failure its pull requests go one at a time.
  const signature = members.map((m) => `${m.campaignId}:${m.task}:${m.sha}`).join(' ');
  if (all.some((group) => group.started?.detail.base === baseSha && group.started.detail.signature === signature)) return false;
  const branch = items[0].decl.target.baseBranch;
  const path = join(controller.repo(items[0].decl).worktreeRoot, `merge-batch-${baseSha.slice(0, 12)}-${head.slice(0, 12)}`);
  try { checkout(git, repoPath, path, head); } catch (error) { controller.log(`group merge onto ${baseSha} could not start: ${error.message}`); return false; }
  // Recorded before the gate starts: after a crash here the next pass finds the worktree and starts the gate.
  note('merge-batch-started', { id: head, base: baseSha, branch, members, signature, path, command: settings.refresh.command });
  try { startGate(path, settings.refresh.command); } catch (error) {
    note('merge-batch-failed', { id: head, reason: `the gate could not start: ${error.message}` });
    return false;
  }
  controller.log(`group merge of ${members.length} pull requests onto ${baseSha}: gate started on the combined result in ${path}`);
  for (const item of ready.filter((entry) => members.some((m) => m.campaignId === entry.campaignId && m.task === entry.task.task_id))) {
    wait(controller, item, `merged as a group of ${members.length}: the gate runs once on the combined result (${head.slice(0, 12)})`);
  }
  return true;
}

function continueGroup(controller, open, items, settings, repoPath, baseSha, note) {
  const { store } = controller, git = controller.cmd.git, { detail } = open.started;
  const end = (kind, reason, extra = {}) => {
    note(kind, { id: open.id, reason, ...extra });
    controller.log(`group merge ${open.id.slice(0, 12)}: ${reason}`);
  };
  if (open.last.kind === 'merge-batch-started') {
    if (baseSha !== detail.base) { end('merge-batch-failed', `the base moved to ${baseSha} before the gate finished`); return false; }
    const run = readGateRun(detail.path);
    if (run === null || run.exit === null) {
      if (controller.now() - open.started.at > settings.refresh.timeoutMs) {
        end('merge-batch-failed', `the gate did not finish within ${Math.round(settings.refresh.timeoutMs / 60_000)} minutes`);
        return false;
      }
      // A gate that ended without an exit code (a restart, a reboot) starts again in the same worktree.
      const pid = gatePid(detail.path);
      if (pid === null || !alive(pid)) {
        try { startGate(detail.path, detail.command); } catch (error) { end('merge-batch-failed', `the gate could not restart: ${error.message}`); return false; }
      }
      return true;
    }
    const failure = gateFailure(run);
    if (failure) { end('merge-batch-failed', `the gate on the combined result ${failure}`, { summary: run.summary }); return false; }
    const head = gitA.exec(git, ['rev-parse', 'HEAD'], { cwd: detail.path });
    if (!head.ok || head.stdout !== open.id) { end('merge-batch-failed', `the gate passed, but its checkout is no longer at ${open.id}`); return false; }
    note('merge-batch-passed', { id: open.id, summary: run.summary });
  }

  // Merge in chain order. Each merge puts exactly the next checked step on the base, or the group stops.
  let base = baseSha, parent = detail.base;
  for (const member of detail.members) {
    const merged = memberRow(store, member, 'merged');
    if (merged) { parent = merged.mergeCommit; continue; }
    const item = items.find((entry) => entry.campaignId === member.campaignId && entry.task.task_id === member.task && entry.task.verified_sha === member.sha);
    if (!item) { end('merge-batch-stopped', `${member.campaignId}/${member.task} no longer waits to merge at ${member.sha}`); return false; }
    controller.mergePassReads = new Map();
    // A merge requested before a crash is settled by reading the pull request first, never by a second call. One GitHub
    // refused ends the group: the pull request goes on alone, through mergeOne.
    if (memberRow(store, member, 'merge-requested')) {
      if (inspect(controller, item, settings, repoPath, base).acted) return true;
      end('merge-batch-stopped', `${member.campaignId}/${member.task} was not merged: ${memberRow(store, member, 'merge-refused')?.detail ?? 'unknown'}`);
      return false;
    }
    if (base !== parent) { end('merge-batch-stopped', `the base is ${base}, not the checked step ${parent}`); return false; }
    const { pr, acted } = inspect(controller, item, settings, repoPath, base);
    if (acted) return true;
    if (!pr) { end('merge-batch-stopped', `${member.campaignId}/${member.task} cannot merge now`); return false; }
    const blocker = mergeBlocker(controller, item, pr);
    // Right after the previous merge GitHub may still be computing mergeability: wait for it, keep the group.
    if (blocker && pr.mergeable === null && blocker === mergeBlocker({ ci: false }, item, pr)) { wait(controller, item, blocker); return true; }
    if (blocker) { end('merge-batch-stopped', `${member.campaignId}/${member.task}: ${blocker}`); return false; }
    if (!mergeNow(controller, item, base)) return true;
    const done = memberRow(store, member, 'merged');
    if (!done) return true;
    base = controller.fetchBase(repoPath, detail.branch).sha;
    if (base !== done.mergeCommit || treeOf(git, repoPath, done.mergeCommit) !== member.tree) {
      end('merge-batch-stopped', `the merge of ${member.url} left the base at ${base}, not at the checked tree ${member.tree}`);
      return true;
    }
    parent = done.mergeCommit;
  }
  end('merge-batch-done', `merged ${detail.members.length} pull requests after one gate run`);
  return true;
}
