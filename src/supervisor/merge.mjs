// AIWorks merge gate (aiworks#138, AW-001 as amended): the supervisor merges a verified pull request itself, only in a
// repository the owner opted in through config.json, and only when merging it puts exactly the independently verified
// tree on the base branch. Off by default. It merges with a merge commit through REST (PUT .../merge, merge_method=merge,
// sha=<verified>); never a squash, a rebase, a force-push, an admin bypass or a branch deletion. It never deploys,
// releases or changes provider resources.
import * as gitA from './adapters/git.mjs';
import * as github from './adapters/github.mjs';
import { mergeWithMergeCommit } from './release/github-merge.mjs';
import { campaignLimits } from './campaign.mjs';
import { specsOf } from './plan.mjs';
import { resolveCheckout } from './project-connect.mjs';
import { refreshSettings, refreshStep } from './merge-refresh.mjs';
import { ConflictError, FencedError } from './store.mjs';

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const MISSING_RECHECK_MS = 60 * 60_000;
const OFF = Object.freeze({ enabled: false, repositories: new Set(), held: new Set(), refresh: null, problem: null });

/**
 * Merge settings from config.json `merges`, the setting the dashboard already reads (src/dashboard/merges.mjs):
 * `"delegatedTo": "supervisor"` and an explicit `"repositories": ["owner/name", ...]` turn merging on for exactly those
 * repositories. `held` (pull request URL to reason) still holds a pull request back. `refresh` (merge-refresh.mjs) gates
 * the merge result itself when the base moved without touching the pull request's files. Absent, delegated to anyone
 * else (for example "monitor"), or malformed: off, and `problem` says what is malformed.
 */
export function mergeSettings(config) {
  const merges = config?.merges;
  if (merges === undefined || merges === null) return OFF;
  const off = (problem) => ({ ...OFF, problem: `merging stays off: ${problem}` });
  if (typeof merges !== 'object' || Array.isArray(merges)) return off('merges must be an object');
  if (merges.delegatedTo !== 'supervisor') return OFF;
  const list = merges.repositories;
  if (!Array.isArray(list) || !list.length || !list.every((item) => typeof item === 'string' && REPOSITORY.test(item))) {
    return off('merges.repositories must list the owner/name repositories the supervisor may merge in');
  }
  if (merges.held !== undefined && (!merges.held || typeof merges.held !== 'object' || Array.isArray(merges.held))) {
    return off('merges.held must map pull request URLs to reasons');
  }
  const refresh = refreshSettings(merges.refresh);
  if (refresh?.problem) return off(refresh.problem);
  return { enabled: true, repositories: new Set(list.map((item) => item.toLowerCase())), problem: null, refresh,
    held: new Set(Object.keys(merges.held ?? {}).map((url) => url.toLowerCase())) };
}

/** Journal entries of one kind for a campaign, as `<task>:<sha>` keys. */
const journaled = (store, campaignId, kind) => new Set(store.all('SELECT detail FROM journal WHERE campaign_id = ? AND kind = ?', campaignId, kind)
  .map((row) => `${row.detail?.task}:${row.detail?.sha}`));

/** The latest CI journal kind recorded for one task head (`ci-passed`, `ci-failed`, ...), or null when never read. */
function ciAt(store, campaignId, taskId, sha) {
  const row = store.get(`SELECT kind FROM journal WHERE campaign_id = ? AND kind IN ('ci-pending', 'ci-passed', 'ci-failed', 'ci-inconclusive', 'ci-none')
    AND json_extract(detail, '$.task') = ? AND json_extract(detail, '$.sha') = ? ORDER BY seq DESC LIMIT 1`, campaignId, taskId, sha);
  return row?.kind ?? null;
}
/** CI lets this head merge: it passed, or the repository runs no CI on it. */
const ciMergeable = (store, campaignId, taskId, sha) => ['ci-passed', 'ci-none'].includes(ciAt(store, campaignId, taskId, sha));

/**
 * Published commit tasks not yet recorded as merged, in campaigns that are neither paused nor cancelled, whose target
 * repository the owner listed. Oldest campaign first, then plan order.
 */
function candidates(store, repositories) {
  const out = [];
  for (const { id } of store.all("SELECT id FROM campaigns WHERE control IN ('registered', 'finished') ORDER BY created_at")) {
    const campaign = store.campaign(id), decl = campaign.declaration, repository = decl.target.repository;
    if (!repositories.has(String(repository).toLowerCase())) continue;
    const specs = specsOf(store, id, decl), merged = journaled(store, id, 'merged');
    for (const task of store.tasks(id)) {
      if (task.state !== 'done' || task.blocked || !SHA.test(task.verified_sha ?? '') || specs.get(task.task_id)?.deliverable !== 'commit') continue;
      if (!String(task.pr_url ?? '').startsWith(`https://github.com/${repository}/pull/`) || merged.has(`${task.task_id}:${task.verified_sha}`)) continue;
      out.push({ campaignId: id, decl, task, number: Number(/\/pull\/(\d+)$/.exec(task.pr_url)?.[1]) });
    }
  }
  return out.filter((item) => Number.isSafeInteger(item.number) && item.number > 0);
}

/**
 * One merge pass, after the campaign steps of a tick. Each listed repository is visited at most once per
 * integrationPollMs; its base is fetched first, and at most one of its pull requests is merged or sent back for an
 * integration repair, so the next one is judged against the refreshed base.
 */
export async function mergePass(controller) {
  const settings = controller.merges;
  if (!settings.enabled) return;
  // AW-005: code that is not merged into origin/main merges nothing.
  if (controller.unmergedRevision()) return;
  const now = controller.now();
  // Listed repositories due a check; between checks a tick reads nothing.
  const due = new Set([...settings.repositories].filter((key) => (controller.mergeCheckedAt.get(key) ?? -Infinity) + controller.config.integrationPollMs <= now));
  if (!due.size) return;
  for (const key of due) controller.mergeCheckedAt.set(key, now);
  const byRepository = new Map();
  for (const item of candidates(controller.store, due)) {
    const key = item.decl.target.repository.toLowerCase();
    byRepository.set(key, [...(byRepository.get(key) ?? []), item]);
  }
  for (const items of byRepository.values()) {
    const decl = items[0].decl;
    if (resolveCheckout(controller.store, controller.config, decl.target.repository)?.conflict) { controller.log(`merge pass for ${decl.target.repository} skipped: CONFIG_CONFLICT`); continue; }
    let repoPath;
    try { repoPath = controller.repo(decl).path; } catch (error) { controller.log(`merge pass for ${decl.target.repository} skipped: ${error.message}`); continue; }
    const bases = new Map();
    for (const item of items) {
      const branch = item.decl.target.baseBranch;
      if (!bases.has(branch)) bases.set(branch, controller.fetchBase(repoPath, branch).sha);
      if (!SHA.test(bases.get(branch) ?? '')) { controller.log(`merge of ${item.campaignId}/${item.task.task_id} waits: ${branch} could not be fetched`); continue; }
      try {
        if (mergeOne(controller, item, settings, repoPath, bases.get(branch))) break;
      } catch (error) {
        if (error instanceof FencedError || error instanceof ConflictError) { controller.log(`merge of ${item.campaignId}/${item.task.task_id} retried later: ${error.message}`); break; }
        controller.log(`merge of ${item.campaignId}/${item.task.task_id} failed: ${error.stack || error}`);
        break;
      }
    }
  }
}

/** The campaign's lease, acquired or renewed for a write; null while another instance holds it. */
function lease(controller, campaignId) {
  const held = controller.store.acquireLease(campaignId, controller.instanceId, controller.now(), controller.config.leaseMs, controller.codeRevision);
  if (!held) { controller.held.delete(campaignId); return null; }
  controller.held.set(campaignId, held.generation);
  return { id: campaignId, generation: held.generation };
}

/** Why a pull request is not merged yet: logged and journaled when it changes, so the journal does not grow per poll. */
function wait(controller, item, reason) {
  const key = `${item.campaignId}:${item.task.task_id}:${item.task.verified_sha}`;
  if (controller.mergeWaits.get(key) === reason) return false;
  controller.mergeWaits.set(key, reason);
  controller.log(`merge of ${item.campaignId}/${item.task.task_id} waits: ${reason}`);
  const ctx = lease(controller, item.campaignId);
  if (ctx) controller.fenced(ctx, () => controller.store.journal(item.campaignId, 'merge-waiting',
    { task: item.task.task_id, sha: item.task.verified_sha, url: item.task.pr_url, reason }, controller.now()));
  return false;
}

/**
 * Judge one published pull request against the gate and act on it. Returns true when it acted on the repository (a
 * merge call, a recorded merge or an integration repair), so the pass moves on to the next repository.
 */
function mergeOne(controller, item, settings, repoPath, baseSha) {
  const { store } = controller, { campaignId, decl, task, number } = item;
  const git = controller.cmd.git, gh = controller.cmd.gh;
  const sha = task.verified_sha, url = task.pr_url, base = decl.target.baseBranch, repository = decl.target.repository;
  if (settings.held.has(url.toLowerCase())) return wait(controller, item, 'held by the owner (merges.held)');
  const requested = journaled(store, campaignId, 'merge-requested').has(`${task.task_id}:${sha}`);
  const inBase = gitA.isAncestor({ git, path: repoPath, ancestor: sha, descendant: baseSha });
  // Already in the base and never requested here: merged by someone else; nothing to do or read.
  if (inBase && !requested) return false;

  // A pull request GitHub reports missing cannot merge; reading it every pass spends the account's shared REST quota.
  const key = `${campaignId}:${task.task_id}:${sha}`;
  if ((controller.mergeMissingUntil.get(key) ?? -Infinity) > controller.now()) return false;
  // Every attempt starts by reading the pull request, so an unknown outcome is settled before any retry.
  let pr;
  try { pr = github.pullRequest({ gh, repository, number }); }
  catch (error) {
    if (error.status === 404) {
      controller.mergeMissingUntil.set(key, controller.now() + MISSING_RECHECK_MS);
      return wait(controller, item, 'GitHub reports the pull request does not exist; it is read again hourly');
    }
    controller.log(`merge of ${campaignId}/${task.task_id}: GET pull failed: ${error.message}`);
    return wait(controller, item, 'the pull request could not be read');
  }
  const branch = gitA.branchName(campaignId, task.task_id);
  if (pr.merged) {
    if (pr.url !== url || pr.headSha !== sha || pr.baseRef !== base || pr.headRef !== branch || !SHA.test(pr.mergeCommit ?? '')) {
      return wait(controller, item, `merged on GitHub at ${pr.headSha ?? 'an unknown head'}, not as verified`);
    }
    const ctx = lease(controller, campaignId);
    if (!ctx) return false;
    controller.fenced(ctx, () => record(controller, ctx, item, pr.mergeCommit, { reconciled: true, requested }));
    return true;
  }
  if (inBase) return wait(controller, item, 'the verified head is in the base but GitHub does not report the pull request merged');
  if (pr.url !== url || pr.state !== 'open') return wait(controller, item, 'the pull request is not open');
  if (pr.headRef !== branch) return wait(controller, item, `the pull request head ${pr.headRef} is not the campaign branch ${branch}`);
  if (pr.baseRef !== base) return wait(controller, item, `the pull request base ${pr.baseRef} is not the declared base ${base}`);
  if (pr.headSha !== sha) return wait(controller, item, `the pull request head ${pr.headSha} is not the verified ${sha}`);

  // The verified head must contain the current base, or the merge result is a tree no verifier ran: integration repair,
  // unless the refresh (merges.refresh) ran the gate on that exact merge result itself. While its gate runs, the
  // repository waits, so the next pull request is judged against the base this one leaves.
  if (!gitA.isAncestor({ git, path: repoPath, ancestor: baseSha, descendant: sha })) {
    const ctx = lease(controller, campaignId);
    if (!ctx) return false;
    const step = settings.refresh ? refreshStep(controller, ctx, item, repoPath, baseSha, settings.refresh) : { next: 'repair' };
    if (step.next === 'wait') { wait(controller, item, step.reason); return true; }
    if (step.next === 'repair') return controller.fenced(ctx, () => repair(controller, ctx, item, repoPath, baseSha, step.detail));
  }
  // With CI repair on, CI is read: merge only a head whose CI passed or that has no CI, never one still running or red.
  if (controller.ci && !ciMergeable(store, campaignId, task.task_id, sha)) {
    return wait(controller, item, ciAt(store, campaignId, task.task_id, sha) === 'ci-failed' ? 'CI failed at the verified head; CI repair runs first'
      : 'CI has not passed at the verified head yet');
  }
  if (pr.mergeable !== true) return wait(controller, item, pr.mergeable === false ? 'GitHub reports it not mergeable' : 'GitHub has not computed mergeability yet');

  const ctx = lease(controller, campaignId);
  if (!ctx) return false;
  // The request is committed before the call: after a crash the next pass reads the pull request before any retry.
  const still = () => {
    const c = store.campaign(campaignId), t = store.task(campaignId, task.task_id);
    return ['registered', 'finished'].includes(c.control) && t.state === 'done' && !t.blocked && t.verified_sha === sha && t.pr_url === url
      && (!controller.ci || ciMergeable(store, campaignId, task.task_id, sha));
  };
  if (!controller.fenced(ctx, () => {
    if (!still()) return false;
    store.journal(campaignId, 'merge-requested', { task: task.task_id, sha, url, base: baseSha }, controller.now());
    return true;
  })) return false;
  controller.injectFault('before-merge');
  try {
    controller.fenced(ctx, () => {
      const { mergeCommit } = mergeWithMergeCommit({ gh, repository, number, sha });
      controller.injectFault('after-merge');
      record(controller, ctx, item, mergeCommit, { reconciled: false, requested: true });
    });
  } catch (error) {
    if (error instanceof FencedError) throw error;
    controller.fenced(ctx, () => store.journal(campaignId, 'merge-refused', { task: task.task_id, sha, url, detail: String(error.message).slice(0, 500) }, controller.now()));
    controller.log(`merge of ${campaignId}/${task.task_id} refused or unknown: ${error.message}`);
  }
  return true;
}

/** Journal the merge and tell the tracking issue. Inside fenced(). */
function record(controller, ctx, { campaignId, decl, task }, mergeCommit, { reconciled, requested }) {
  const now = controller.now(), base = decl.target.baseBranch;
  controller.store.journal(campaignId, 'merged', { task: task.task_id, sha: task.verified_sha, url: task.pr_url, mergeCommit, reconciled, requested }, now);
  controller.mergeWaits.delete(`${campaignId}:${task.task_id}:${task.verified_sha}`);
  controller.log(`merged ${campaignId}/${task.task_id}: ${task.pr_url} as ${mergeCommit}`);
  if (requested) {
    controller.enqueue(campaignId, `${campaignId}:${task.task_id}:merged:${task.verified_sha}`, decl,
      `**${task.task_id}** is merged into ${base} under the merge gate: ${task.pr_url}, verified \`${task.verified_sha}\`, merge commit \`${mergeCommit}\`. ` +
      'Merged is not deployed: nothing was released or deployed.', now);
  }
}

/**
 * The base moved past the verified head: reopen the task as an integration repair round on its own branch and PR (the
 * existing aiworks#27 repair). The round merges the base in and needs a fresh independent verification; the pull request
 * is merged only once that new head is verified and published. `refreshed` says why a refresh did not merge it. Inside
 * fenced(). Returns true.
 */
function repair(controller, ctx, item, repoPath, baseSha, refreshed) {
  const { store } = controller, git = controller.cmd.git, { campaignId, decl, task } = item;
  const fresh = store.task(campaignId, task.task_id);
  if (fresh.version !== task.version || fresh.state !== 'done') return false;
  const sha = task.verified_sha, base = decl.target.baseBranch, now = controller.now();
  const check = gitA.mergeCheck({ git, repoPath, baseSha, sha });
  const paths = check.paths.slice(0, 20);
  const commits = gitA.siblingCommits({ git, repoPath, baseSha, sha, paths });
  const finding = {
    id: 'integration-conflict', severity: 'blocking', moved: true, base: baseSha, verified: sha, paths, commits,
    description: `Base moved: the verified commit ${sha} (${task.pr_url}) does not contain ${base} at ${baseSha}, so merging it would put a tree on ${base} that no verifier ran. ` +
      `${paths.length ? `Conflicting paths: ${paths.join(', ')}. ` : 'It merges without a textual conflict; a semantic conflict is still possible. '}` +
      `${refreshed ? `The supervisor's refresh did not merge it: ${refreshed}. ` : ''}` +
      `Sibling commits on ${base}: ${commits.map((entry) => `${entry.sha.slice(0, 12)} ${entry.subject}`).join('; ') || 'unknown'}. ` +
      `Merge ${baseSha} into this branch (git merge ${baseSha}), resolve any conflicts, run the full gate and commit the merge. Never rebase, reset or amend: ${sha} must stay an ancestor of the new head.`,
  };
  const stalled = controller.reopenPublished(ctx, fresh, finding, { limits: campaignLimits(decl), now,
    lastError: `merge-base-moved: ${sha} does not contain ${base} at ${baseSha}`,
    stalledReason: `the base moved before merging, after ${fresh.repair_rounds} repair rounds` });
  store.journal(campaignId, 'merge-base-moved', { task: task.task_id, sha, base: baseSha, paths, commits: commits.map((entry) => entry.sha), stalled }, now);
  controller.log(`merge of ${campaignId}/${task.task_id} waits for an integration repair: ${base} moved to ${baseSha}`);
  return true;
}
