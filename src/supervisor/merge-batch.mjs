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
//
// AIWorks's own repository with local main trusted groups its verified local reviews the same way: the base is trusted
// local main, and each step is a local merge (merge.mjs mergeLocal) from exactly the previous step, with exactly the tree
// that step predicted, recorded with its main ledger row and `merged` entry. A refused step ends the group.
import { join } from 'node:path';
import * as gitA from './adapters/git.mjs';
import { gateFailure, readGateRun } from './gate.mjs';
import { IDENTITY, alive, checkout, gatePid, startGate } from './merge-refresh.mjs';
import { inspect, localBlocker, mergeBlocker, mergeLocal, mergeNow, wait } from './merge.mjs';
import { trustedTip } from './self-hosting.mjs';

const KINDS = ['merge-batch-started', 'merge-batch-passed', 'merge-batch-failed', 'merge-batch-stopped', 'merge-batch-done'];
const ENDED = new Set(['merge-batch-failed', 'merge-batch-stopped', 'merge-batch-done']);

/** How long the group waits for GitHub to compute a member's mergeability after the gate passed. */
const MERGEABLE_WAIT_MS = 15 * 60_000;

/** The groups of one repository and base branch, oldest first: { id, started, passed, last }. */
function groups(store, repository, branch) {
  const rows = store.all(`SELECT seq, kind, at, detail FROM journal WHERE campaign_id IS NULL AND kind IN (${KINDS.map(() => '?').join(', ')})
    AND json_extract(detail, '$.repository') = ? ORDER BY seq`, ...KINDS, repository);
  const byId = new Map();
  for (const row of rows) byId.set(row.detail.id, [...(byId.get(row.detail.id) ?? []), row]);
  return [...byId.entries()].map(([id, list]) => ({
    id, started: list.find((row) => row.kind === 'merge-batch-started'), passed: list.find((row) => row.kind === 'merge-batch-passed'), last: list.at(-1),
  })).filter((group) => group.started?.detail.branch === branch);
}

/** The latest journal row of `kind` for one member's verified head written after journal row `since`, or null. */
const memberRow = (store, { campaignId, task, sha }, kind, since = 0) => store.get(`SELECT detail FROM journal WHERE campaign_id = ? AND kind = ?
  AND json_extract(detail, '$.task') = ? AND json_extract(detail, '$.sha') = ? AND seq > ? ORDER BY seq DESC LIMIT 1`, campaignId, kind, task, sha, since)?.detail ?? null;

/** A refresh of this verified head against this base that started and has not ended (merge-refresh.mjs). */
const refreshRunning = (store, { campaignId, task }, base) => store.all(`SELECT kind FROM journal WHERE campaign_id = ?
  AND kind IN ('merge-refresh-started', 'merge-refresh-passed', 'merge-refresh-failed') AND json_extract(detail, '$.task') = ?
  AND json_extract(detail, '$.sha') = ? AND json_extract(detail, '$.base') = ?`, campaignId, task.task_id, task.verified_sha, base)
  .map((row) => row.kind).join(' ') === 'merge-refresh-started';

/**
 * The tree one verified head's step must carry in group `id` once that group's gate passed, or null. Read-only: the local
 * merge gate uses it after a crash to recognize the group step it requested (merge.mjs mergeLocal).
 */
export function groupTree(store, id, { campaignId, task, sha }) {
  const row = (kind) => store.get(`SELECT detail FROM journal WHERE campaign_id IS NULL AND kind = ? AND json_extract(detail, '$.id') = ?
    ORDER BY seq DESC LIMIT 1`, kind, id)?.detail ?? null;
  if (!row('merge-batch-passed')) return null;
  const member = row('merge-batch-started')?.members?.find((m) => m.campaignId === campaignId && m.task === task && m.sha === sha);
  return typeof member?.tree === 'string' ? member.tree : null;
}

/** Local main of the self-hosted repository: { tip, main } of trustedTip, or null when it is not trusted. */
function localMain(controller, repoPath, repository) {
  const tip = trustedTip(controller.store, { git: controller.cmd.git, repoPath, repository });
  return tip.state === 'TRUSTED' ? tip : null;
}

/**
 * One group-merge step for the waiting pull requests (or, in the self-hosted repository, local reviews) of one repository
 * and base branch (`items`, oldest campaign first, then plan order). `baseSha` is the fetched base, or local main.
 * Returns true when the group handled the repository this pass (it acted or waits), false when they go one at a time
 * instead.
 */
export function batchStep(controller, items, settings, repoPath, baseSha) {
  if (!items.length) return false;
  const repository = items[0].decl.target.repository.toLowerCase();
  const note = (kind, detail) => controller.store.tx(() => controller.store.journal(null, kind, { repository, ...detail }, controller.now()));
  const all = groups(controller.store, repository, items[0].decl.target.baseBranch);
  const open = all.find((group) => group.started && !ENDED.has(group.last.kind));
  return open ? continueGroup(controller, open, items, settings, repoPath, baseSha, note)
    : startGroup(controller, all, items, settings, repoPath, baseSha, note);
}

function startGroup(controller, all, items, settings, repoPath, baseSha, note) {
  const git = controller.cmd.git, ready = [], local = Boolean(items[0].local);
  // A local group starts only from trusted main with nothing unrecorded on it.
  if (local) {
    const tip = localMain(controller, repoPath, items[0].decl.target.repository);
    if (!tip || tip.tip !== baseSha || tip.main !== baseSha) return false;
  }
  for (const item of items) {
    if (local) {
      const blocker = localBlocker(controller, item, settings, repoPath);
      if (blocker) { wait(controller, item, blocker); continue; }
      if (!gitA.isAncestor({ git, path: repoPath, ancestor: item.task.verified_sha, descendant: baseSha })) ready.push(item);
      continue;
    }
    const { pr, acted } = inspect(controller, item, settings, repoPath, baseSha);
    if (acted) return true;
    if (!pr) continue;
    const blocker = mergeBlocker(controller, item, pr);
    if (blocker) { wait(controller, item, blocker); continue; }
    ready.push(item);
  }
  // A pull request whose own refresh already runs on this base finishes that first.
  if (ready.length < 2 || ready.some((item) => refreshRunning(controller.store, item, baseSha))) return false;
  // The same candidates on the same base are combined once: after a failure they go one at a time.
  const candidates = ready.map((item) => `${item.campaignId}:${item.task.task_id}:${item.task.verified_sha}`).join(' ');
  if (all.some((group) => group.started.detail.base === baseSha && group.started.detail.candidates === candidates)) return false;
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
  if (all.some((group) => group.started.detail.base === baseSha && group.started.detail.signature === signature)) return false;
  const branch = items[0].decl.target.baseBranch;
  const path = join(controller.repo(items[0].decl).worktreeRoot, `merge-batch-${baseSha.slice(0, 12)}-${head.slice(0, 12)}`);
  try { checkout(git, repoPath, path, head); } catch (error) { controller.log(`group merge onto ${baseSha} could not start: ${error.message}`); return false; }
  // Recorded before the gate starts: after a crash here the next pass finds the worktree and starts the gate.
  note('merge-batch-started', { id: head, base: baseSha, branch, members, signature, candidates, path, command: settings.refresh.command });
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
  const { store } = controller, git = controller.cmd.git, { detail } = open.started, local = Boolean(items[0].local);
  const matchesStep = (commit, member, parent) => {
    const actual = gitA.exec(git, ['show', '-s', '--format=%T %P', commit], { cwd: repoPath });
    return actual.ok && actual.stdout === `${member.tree} ${parent} ${member.sha}`;
  };
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

  // Only this group's requests and merges count: an older refused attempt of the same head does not stop it.
  const since = open.started.seq, passedAt = open.passed?.at ?? controller.now();
  const itemOf = (member) => items.find((entry) => entry.campaignId === member.campaignId && entry.task.task_id === member.task && entry.task.verified_sha === member.sha);
  /** Whether a member may merge onto `base` now: {} yes, { acted } or { waiting } keep the group, { stop } ends it. */
  const check = (member, item, base) => {
    if (local) {
      const blocker = localBlocker(controller, item, settings, repoPath);
      return blocker ? { stop: `${member.campaignId}/${member.task}: ${blocker}` } : {};
    }
    const { pr, acted } = inspect(controller, item, settings, repoPath, base);
    if (acted) return { acted: true };
    if (!pr) return { stop: `${member.campaignId}/${member.task} cannot merge now` };
    const blocker = mergeBlocker(controller, item, pr);
    if (!blocker) return {};
    // Right after the previous merge GitHub may still be computing mergeability: wait for it, keep the group, for a while.
    if (pr.mergeable === null && blocker === mergeBlocker({ ci: false }, item, pr)) {
      if (controller.now() - passedAt > MERGEABLE_WAIT_MS) return { stop: `GitHub did not report whether ${member.url} can merge within ${MERGEABLE_WAIT_MS / 60_000} minutes` };
      wait(controller, item, blocker);
      return { waiting: true };
    }
    return { stop: `${member.campaignId}/${member.task}: ${blocker}` };
  };

  // Before the first merge every member must still be able to merge, so the group never stops halfway on a known cause.
  if (!detail.members.some((member) => memberRow(store, member, 'merged', since) || memberRow(store, member, 'merge-requested', since))) {
    if (baseSha !== detail.base) { end('merge-batch-stopped', `the base moved to ${baseSha} before the first merge`); return false; }
    let waiting = false;
    for (const member of detail.members) {
      const item = itemOf(member);
      if (!item) { end('merge-batch-stopped', `${member.campaignId}/${member.task} no longer waits to merge at ${member.sha}`); return false; }
      const result = check(member, item, baseSha);
      if (result.acted) return true;
      if (result.stop) { end('merge-batch-stopped', result.stop); return false; }
      waiting ||= Boolean(result.waiting);
    }
    if (waiting) return true;
  }

  // Merge in chain order. Each merge puts exactly the next checked step on the base, or the group stops.
  let base = baseSha, parent = detail.base;
  for (const member of detail.members) {
    const merged = memberRow(store, member, 'merged', since);
    if (merged) {
      if (!matchesStep(merged.mergeCommit, member, parent)) {
        end('merge-batch-stopped', `the recovered merge of ${member.url} does not match its checked tree and parents`);
        return true;
      }
      parent = merged.mergeCommit; continue;
    }
    const item = itemOf(member);
    if (!item) { end('merge-batch-stopped', `${member.campaignId}/${member.task} no longer waits to merge at ${member.sha}`); return false; }
    // A merge requested before a crash is settled by reading the pull request first, never by a second call. One GitHub
    // refused ends the group: the pull request goes on alone, through mergeOne. A local step refused ends it too; a local
    // step requested before a crash is settled by mergeLocal, which reads main first: it records the planned merge commit
    // already on main once, or, while main is still the previous step, merges that step again.
    const requested = memberRow(store, member, 'merge-requested', since);
    if (requested && local) {
      const refused = memberRow(store, member, 'merge-refused', since);
      if (refused) { end('merge-batch-stopped', `${member.campaignId}/${member.task} was not merged: ${refused.detail}`); return false; }
    } else if (requested) {
      if (inspect(controller, item, settings, repoPath, base).acted) return true;
      end('merge-batch-stopped', `${member.campaignId}/${member.task} was not merged: ${memberRow(store, member, 'merge-refused', since)?.detail ?? 'unknown'}`);
      return false;
    }
    // Main already past the previous step counts only as this step's planned merge commit, recorded by mergeLocal.
    const recovering = Boolean(requested) && local && base !== parent;
    const moved = () => { end('merge-batch-stopped', `the base is ${base}, not the checked step ${parent}`); return false; };
    if (base !== parent && !recovering) return moved();
    const result = check(member, item, base);
    if (result.acted || result.waiting) return true;
    if (result.stop) { end('merge-batch-stopped', result.stop); return false; }
    // A merge that did not happen (a lost lease, a changed task) is judged again next pass.
    if (local) mergeLocal(controller, item, settings, repoPath, { group: open.id, base: parent, tree: member.tree });
    else mergeNow(controller, item, base);
    controller.mergePassReads = new Map();
    const done = memberRow(store, member, 'merged', since);
    if (!done) {
      if (recovering) return moved();
      const refused = local && memberRow(store, member, 'merge-refused', since);
      if (refused) { end('merge-batch-stopped', `${member.campaignId}/${member.task} was not merged: ${refused.detail}`); return false; }
      return true;
    }
    base = local ? localMain(controller, repoPath, items[0].decl.target.repository)?.main ?? null : controller.fetchBase(repoPath, detail.branch).sha;
    if (base !== done.mergeCommit || !matchesStep(done.mergeCommit, member, parent)) {
      end('merge-batch-stopped', `the merge of ${member.url} left the base at ${base}, not at the checked tree ${member.tree}`);
      return true;
    }
    parent = done.mergeCommit;
  }
  end('merge-batch-done', `merged ${detail.members.length} pull requests after one gate run`);
  return true;
}
