// AIWorks merge gate (aiworks#138, AW-001 as amended): the supervisor merges a verified pull request itself, only in a
// repository the owner opted in through config.json, and only when merging it puts exactly the independently verified
// tree on the base branch. Off by default. It merges with a merge commit through REST (PUT .../merge, merge_method=merge,
// sha=<verified>); never a squash, a rebase, a force-push, an admin bypass or a branch deletion. It never deploys,
// releases or changes provider resources. AIWorks's own repository with local main trusted (config.json `selfHosting`,
// docs/design/LOCAL_OPERATION.md section 4.4, slice SELF8) merges its verified local reviews locally instead: a merge
// commit of the trusted tip and the verified head with the verified tree, main moved only from the trusted tip, and a
// main ledger row (release/local-merge.mjs). It reads no remote and makes no GitHub call; the owner's optional backup of
// trusted main (github-backup.mjs, slice SELF9) runs after those merges and never holds one. In a project whose
// acceptance mode is "owner" (AW-015, project-settings.mjs) every one of these merges also needs the owner's acceptance
// of exactly the verified head and report (result-review.mjs awaitingAcceptance), checked when candidates are chosen and
// again inside the fenced write that requests the merge.
import * as gitA from './adapters/git.mjs';
import * as github from './adapters/github.mjs';
import { mergeWithMergeCommit } from './release/github-merge.mjs';
import { isPlannedMerge, moveMain, writeMergeCommit } from './release/local-merge.mjs';
import { mainLedger, recordMainCommit, trustedTip } from './self-hosting.mjs';
import { backupStep } from './github-backup.mjs';
import { reviewItem, WORK_REFERENCE, workLink } from './work-list.mjs';
import { campaignLimits } from './campaign.mjs';
import { specsOf } from './plan.mjs';
import { resolveCheckout } from './project-connect.mjs';
import { refreshSettings, refreshStep } from './merge-refresh.mjs';
import { batchStep } from './merge-batch.mjs';
import { ConflictError, FencedError } from './store.mjs';
import { awaitingAcceptance, pendingChanges } from './result-review.mjs';

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
  if (merges.batch !== undefined && typeof merges.batch !== 'boolean') return off('merges.batch must be true or false');
  if (merges.batch === true && !refresh) return off('merges.batch needs merges.refresh, the gate command it runs on the combined result');
  return { enabled: true, repositories: new Set(list.map((item) => item.toLowerCase())), problem: null, refresh, batch: merges.batch === true,
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
 * repository the owner listed. Oldest campaign first, then plan order. In the self-hosted repository with local main
 * trusted, a candidate is a local review (`aiworks-work:<n>`, `local: true`); elsewhere a GitHub pull request.
 */
function candidates(controller, repositories) {
  const { store } = controller, out = [];
  for (const { id } of store.all("SELECT id FROM campaigns WHERE control IN ('registered', 'finished') ORDER BY created_at")) {
    const campaign = store.campaign(id), decl = campaign.declaration, repository = decl.target.repository;
    if (!repositories.has(String(repository).toLowerCase())) continue;
    const local = controller.selfHosted(repository);
    const specs = specsOf(store, id, decl), merged = journaled(store, id, 'merged');
    for (const task of store.tasks(id)) {
      if (task.state !== 'done' || task.blocked || !SHA.test(task.verified_sha ?? '') || specs.get(task.task_id)?.deliverable !== 'commit') continue;
      if (merged.has(`${task.task_id}:${task.verified_sha}`)) continue;
      // The owner asked for changes to this head (OWNER_UI_V2 WP4): it is never merged while the request waits.
      if (pendingChanges(store, id, task.task_id, task.verified_sha)) continue;
      // The owner accepts results in this project (AW-015): a head they have not accepted waits, said once per reason.
      const held = awaitingAcceptance(store, campaign, task);
      if (held) { wait(controller, { campaignId: id, task }, held); continue; }
      if (local) {
        const number = Number(WORK_REFERENCE.exec(String(task.pr_url ?? ''))?.[1]);
        if (number) out.push({ campaignId: id, decl, task, number, local: true });
        continue;
      }
      if (!String(task.pr_url ?? '').startsWith(`https://github.com/${repository}/pull/`)) continue;
      out.push({ campaignId: id, decl, task, number: Number(/\/pull\/(\d+)$/.exec(task.pr_url)?.[1]) });
    }
  }
  return out.filter((item) => Number.isSafeInteger(item.number) && item.number > 0);
}

/**
 * One merge pass, after the campaign steps of a tick. Each listed repository is visited at most once per
 * integrationPollMs; its base is fetched first, and at most one of its pull requests is merged or sent back for an
 * integration repair, so the next one is judged against the refreshed base. With merges.batch, the waiting pull requests
 * of a base first merge as one group after one gate run (merge-batch.mjs); only what the group leaves goes one at a time.
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
  for (const item of candidates(controller, due)) {
    const key = item.decl.target.repository.toLowerCase();
    byRepository.set(key, [...(byRepository.get(key) ?? []), item]);
  }
  for (const items of byRepository.values()) {
    const decl = items[0].decl;
    if (resolveCheckout(controller.store, controller.config, decl.target.repository)?.conflict) { controller.log(`merge pass for ${decl.target.repository} skipped: CONFIG_CONFLICT`); continue; }
    let repoPath;
    try { repoPath = controller.repo(decl).path; } catch (error) { controller.log(`merge pass for ${decl.target.repository} skipped: ${error.message}`); continue; }
    if (items[0].local) {
      for (const item of items) {
        try {
          if (mergeLocal(controller, item, settings, repoPath)) break;
        } catch (error) {
          if (error instanceof FencedError || error instanceof ConflictError) { controller.log(`merge of ${item.campaignId}/${item.task.task_id} retried later: ${error.message}`); break; }
          controller.log(`merge of ${item.campaignId}/${item.task.task_id} failed: ${error.stack || error}`);
          break;
        }
      }
      continue;
    }
    const bases = new Map();
    controller.mergePassReads = new Map();
    if (settings.batch) {
      const branch = decl.target.baseBranch;
      bases.set(branch, controller.fetchBase(repoPath, branch).sha);
      try {
        if (SHA.test(bases.get(branch) ?? '') && batchStep(controller, items.filter((item) => item.decl.target.baseBranch === branch), settings, repoPath, bases.get(branch))) continue;
      } catch (error) {
        if (error instanceof FencedError || error instanceof ConflictError) { controller.log(`group merge for ${decl.target.repository} retried later: ${error.message}`); continue; }
        controller.log(`group merge for ${decl.target.repository} failed, merging one at a time: ${error.stack || error}`);
      }
      bases.set(branch, controller.fetchBase(repoPath, branch).sha);
    }
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
  // After the local merges, also in a pass with nothing to merge, so a backup the interval deferred still follows.
  for (const key of due) if (controller.selfHosted(key)) backup(controller, key);
}

/**
 * The optional backup of trusted local main (github-backup.mjs) in the checkout of the campaign that made the newest
 * recorded local merge. Nothing waits on it: a refused, unreachable or failing push is journaled and logged, and the
 * next merge is judged as if it never ran.
 */
function backup(controller, key) {
  if (!controller.selfHosting.backup.enabled) return;
  try {
    const merge = mainLedger(controller.store, key).reverse().find((row) => row.kind === 'gate-merge');
    const campaign = merge && controller.store.campaign(merge.campaign_id);
    // Its journal takes the entries, under its lease, as for a merge: only while it is registered or finished.
    if (!campaign || !['registered', 'finished'].includes(campaign.control)) return;
    const decl = campaign.declaration;
    backupStep({ store: controller.store, settings: controller.selfHosting, git: controller.cmd.git, gh: controller.cmd.gh, repoPath: controller.repo(decl).path,
      repository: decl.target.repository, now: controller.now(), log: (line) => controller.log(line),
      write: (campaignId, fn) => {
        const ctx = lease(controller, campaignId);
        return ctx ? (controller.fenced(ctx, fn), true) : false;
      } });
  } catch (error) {
    controller.log(`backup of ${key} skipped: ${error.message}`);
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
export function wait(controller, item, reason) {
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
 * Read and judge one published pull request on everything but the tree it would put on the base. Returns { pr } when it
 * is open at the verified head on the declared branches, or { acted } after recording why not (acted: a merge done
 * elsewhere was reconciled). Shared by mergeOne and the group merge (merge-batch.mjs).
 */
export function inspect(controller, item, settings, repoPath, baseSha) {
  const { store } = controller, { campaignId, decl, task, number } = item;
  const git = controller.cmd.git, gh = controller.cmd.gh;
  const sha = task.verified_sha, url = task.pr_url, base = decl.target.baseBranch, repository = decl.target.repository;
  const not = (acted = false) => ({ pr: null, acted });
  if (settings.held.has(url.toLowerCase())) return not(wait(controller, item, 'held by the owner (merges.held)'));
  const requested = journaled(store, campaignId, 'merge-requested').has(`${task.task_id}:${sha}`);
  const inBase = gitA.isAncestor({ git, path: repoPath, ancestor: sha, descendant: baseSha });
  // Already in the base and never requested here: merged by someone else; nothing to do or read.
  if (inBase && !requested) return not();

  // A pull request GitHub reports missing cannot merge; reading it every pass spends the account's shared REST quota.
  const key = `${campaignId}:${task.task_id}:${sha}`;
  if ((controller.mergeMissingUntil.get(key) ?? -Infinity) > controller.now()) return not();
  // Every attempt starts by reading the pull request, so an unknown outcome is settled before any retry. One read per pass.
  let pr = controller.mergePassReads?.get(key);
  if (!pr) {
    try { pr = github.pullRequest({ gh, repository, number }); }
    catch (error) {
      if (error.status === 404) {
        controller.mergeMissingUntil.set(key, controller.now() + MISSING_RECHECK_MS);
        return not(wait(controller, item, 'GitHub reports the pull request does not exist; it is read again hourly'));
      }
      controller.log(`merge of ${campaignId}/${task.task_id}: GET pull failed: ${error.message}`);
      return not(wait(controller, item, 'the pull request could not be read'));
    }
    controller.mergePassReads?.set(key, pr);
  }
  const branch = gitA.branchName(campaignId, task.task_id);
  if (pr.merged) {
    if (pr.url !== url || pr.headSha !== sha || pr.baseRef !== base || pr.headRef !== branch || !SHA.test(pr.mergeCommit ?? '')) {
      return not(wait(controller, item, `merged on GitHub at ${pr.headSha ?? 'an unknown head'}, not as verified`));
    }
    const ctx = lease(controller, campaignId);
    if (!ctx) return not();
    controller.fenced(ctx, () => record(controller, ctx, item, pr.mergeCommit, { reconciled: true, requested }));
    return not(true);
  }
  if (inBase) return not(wait(controller, item, 'the verified head is in the base but GitHub does not report the pull request merged'));
  if (pr.url !== url || pr.state !== 'open') return not(wait(controller, item, 'the pull request is not open'));
  if (pr.headRef !== branch) return not(wait(controller, item, `the pull request head ${pr.headRef} is not the campaign branch ${branch}`));
  if (pr.baseRef !== base) return not(wait(controller, item, `the pull request base ${pr.baseRef} is not the declared base ${base}`));
  if (pr.headSha !== sha) return not(wait(controller, item, `the pull request head ${pr.headSha} is not the verified ${sha}`));
  return { pr, acted: false };
}

/** Why CI or GitHub holds a pull request back right now, or null. With CI repair on, only a passed or absent CI merges. */
export function mergeBlocker(controller, { campaignId, task }, pr) {
  const sha = task.verified_sha;
  if (controller.ci && !ciMergeable(controller.store, campaignId, task.task_id, sha)) {
    return ciAt(controller.store, campaignId, task.task_id, sha) === 'ci-failed' ? 'CI failed at the verified head; CI repair runs first'
      : 'CI has not passed at the verified head yet';
  }
  if (pr.mergeable !== true) return pr.mergeable === false ? 'GitHub reports it not mergeable' : 'GitHub has not computed mergeability yet';
  return null;
}

/**
 * Judge one published pull request against the gate and act on it. Returns true when it acted on the repository (a
 * merge call, a recorded merge or an integration repair), so the pass moves on to the next repository.
 */
function mergeOne(controller, item, settings, repoPath, baseSha) {
  const git = controller.cmd.git, sha = item.task.verified_sha;
  const { pr, acted } = inspect(controller, item, settings, repoPath, baseSha);
  if (!pr) return acted;

  // The verified head must contain the current base, or the merge result is a tree no verifier ran: integration repair,
  // unless the refresh (merges.refresh) ran the gate on that exact merge result itself. While its gate runs, the
  // repository waits, so the next pull request is judged against the base this one leaves.
  if (!gitA.isAncestor({ git, path: repoPath, ancestor: baseSha, descendant: sha })) {
    const ctx = lease(controller, item.campaignId);
    if (!ctx) return false;
    const step = settings.refresh ? refreshStep(controller, ctx, item, repoPath, baseSha, settings.refresh) : { next: 'repair' };
    if (step.next === 'wait') { wait(controller, item, step.reason); return true; }
    if (step.next === 'repair') return controller.fenced(ctx, () => repair(controller, ctx, item, repoPath, baseSha, step.detail));
  }
  const blocker = mergeBlocker(controller, item, pr);
  if (blocker) return wait(controller, item, blocker);
  return mergeNow(controller, item, baseSha);
}

/**
 * The merge call for a pull request already judged mergeable onto a checked tree: journal the request, merge the exact
 * verified SHA with a merge commit, record it. Returns false when the campaign lease or the task changed, true otherwise
 * (merged, or refused or unknown, which the next pass settles by reading the pull request first).
 */
export function mergeNow(controller, item, baseSha) {
  const { store } = controller, { campaignId, decl, task, number } = item;
  const gh = controller.cmd.gh, sha = task.verified_sha, url = task.pr_url, repository = decl.target.repository;
  const ctx = lease(controller, campaignId);
  if (!ctx) return false;
  // The request is committed before the call: after a crash the next pass reads the pull request before any retry.
  const still = () => {
    const c = store.campaign(campaignId), t = store.task(campaignId, task.task_id);
    return ['registered', 'finished'].includes(c.control) && t.state === 'done' && !t.blocked && t.verified_sha === sha && t.pr_url === url
      && !pendingChanges(store, campaignId, task.task_id, sha) && !awaitingAcceptance(store, c, t)
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
function record(controller, ctx, { campaignId, decl, task }, mergeCommit, { reconciled, requested, ...extra }) {
  const now = controller.now(), base = decl.target.baseBranch;
  controller.store.journal(campaignId, 'merged', { task: task.task_id, sha: task.verified_sha, url: task.pr_url, mergeCommit, reconciled, requested, ...extra }, now);
  controller.mergeWaits.delete(`${campaignId}:${task.task_id}:${task.verified_sha}`);
  controller.log(`merged ${campaignId}/${task.task_id}: ${task.pr_url} as ${mergeCommit}`);
  if (requested) {
    controller.enqueue(campaignId, `${campaignId}:${task.task_id}:merged:${task.verified_sha}`, decl,
      `**${task.task_id}** is merged into ${base} under the merge gate: ${task.pr_url}, verified \`${task.verified_sha}\`, merge commit \`${mergeCommit}\`. ` +
      'Merged is not deployed: nothing was released or deployed.', now);
  }
}

const commitAt = (git, repoPath, ref) => {
  const out = gitA.exec(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoPath, timeoutMs: 30_000 });
  return out.ok && SHA.test(out.stdout) ? out.stdout : null;
};

/** The detail of the newest `merge-requested` entry for one task head, or null. */
const lastRequest = (store, campaignId, taskId, sha) => store.get(`SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'merge-requested'
  AND json_extract(detail, '$.task') = ? AND json_extract(detail, '$.sha') = ? ORDER BY seq DESC LIMIT 1`, campaignId, taskId, sha)?.detail ?? null;

/**
 * The worktree that has main checked out, if any: { path, dirty }, or { unreadable: true }. Tracked changes and untracked
 * files make it dirty, so the owner's unsaved work is never overwritten or carried into a merge.
 */
function mainCheckout(git, repoPath) {
  const list = gitA.worktreeList({ git, repoPath });
  if (!list) return { unreadable: true };
  const entry = list.find((worktree) => worktree.branch === 'main');
  if (!entry) return null;
  const status = gitA.exec(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: entry.path, timeoutMs: 60_000 });
  if (!status.ok) return { unreadable: true };
  return { path: entry.path, dirty: status.stdout.length > 0 };
}

/**
 * Record a local merge: the `gate-merge` main ledger row and the `merged` journal entry in the caller's fenced
 * transaction, so both commit or neither does. A ledger refusal throws and rolls the transaction back.
 */
function recordLocal(controller, ctx, item, { trusted, mergeCommit, reconciled, requested }) {
  const { campaignId, decl, task } = item;
  const row = recordMainCommit(controller.store, { repository: decl.target.repository, kind: 'gate-merge', oldTip: trusted, newTip: mergeCommit,
    campaignId, taskId: task.task_id, verifiedSha: task.verified_sha, now: controller.now() });
  if (!row.recorded) throw new Error(`the main ledger refused the merge: ${row.reason}`);
  record(controller, ctx, item, mergeCommit, { reconciled, requested, local: true, trusted, ledger: row.seq });
}

/**
 * The local merge gate (LOCAL_OPERATION.md section 4.4) for one verified local review of the self-hosted repository.
 * Returns true when it acted on the repository (a merge, a recorded merge, a refusal or an integration repair). Main
 * moves only when the trusted tip is an ancestor of the verified head, main is exactly the trusted tip, the checkout that
 * has main checked out is clean, the task's branch and review item are bound to the verified head, the campaign is
 * neither paused nor cancelled and this instance holds the campaign's lease.
 */
function mergeLocal(controller, item, settings, repoPath) {
  const { store } = controller, { campaignId, decl, task } = item;
  const git = controller.cmd.git, sha = task.verified_sha, url = task.pr_url, repository = decl.target.repository;
  if (decl.target.baseBranch !== 'main') return wait(controller, item, `the local merge gate merges into main only, not ${decl.target.baseBranch}`);
  if (settings.held.has(url.toLowerCase())) return wait(controller, item, 'held by the owner (merges.held)');
  const review = reviewItem(store, { campaignId, taskId: task.task_id });
  if (!review || workLink(review.number) !== url) return wait(controller, item, `${url} is not the review item recorded for this task`);
  const branch = gitA.branchName(campaignId, task.task_id), head = commitAt(git, repoPath, `refs/heads/${branch}`);
  if (head !== sha) return wait(controller, item, `the local branch ${branch} is at ${head ?? 'no commit'}, not the verified ${sha}`);
  const tip = trustedTip(store, { git, repoPath, repository });
  if (tip.state !== 'TRUSTED') return wait(controller, item, `local main is not trusted (${tip.state}): ${tip.reason}`);
  const stillDone = (t) => t.state === 'done' && !t.blocked && t.verified_sha === sha && t.pr_url === url;
  const still = () => ['registered', 'finished'].includes(store.campaign(campaignId).control) && stillDone(store.task(campaignId, task.task_id))
    && !pendingChanges(store, campaignId, task.task_id, sha);
  // A new merge also needs the owner's acceptance where they accept results (AW-015); a merge already made is recorded.
  const accepted = () => !awaitingAcceptance(store, store.campaign(campaignId), store.task(campaignId, task.task_id));

  // After a crash, main is read before any retry: the planned merge commit on main is recorded once and never made again.
  const requested = lastRequest(store, campaignId, task.task_id, sha);
  if (requested && tip.main !== tip.tip && requested.base === tip.tip && isPlannedMerge({ git, repoPath, sha: tip.main, trusted: tip.tip, verified: sha })) {
    const ctx = lease(controller, campaignId);
    if (!ctx) return false;
    controller.fenced(ctx, () => {
      if (still()) recordLocal(controller, ctx, item, { trusted: tip.tip, mergeCommit: tip.main, reconciled: true, requested: true });
    });
    return true;
  }

  // The verified head must contain the trusted tip, or the merge result is a tree no verifier ran: integration repair.
  if (!gitA.isAncestor({ git, path: repoPath, ancestor: tip.tip, descendant: sha })) {
    const ctx = lease(controller, campaignId);
    if (!ctx) return false;
    return controller.fenced(ctx, () => repair(controller, ctx, item, repoPath, tip.tip, null));
  }
  if (tip.unrecordedCount) return wait(controller, item, `main has ${tip.unrecordedCount} commits AIWorks did not put there`);
  const checkout = mainCheckout(git, repoPath);
  if (checkout?.unreadable) return wait(controller, item, 'the checkout that has main checked out cannot be read');
  if (checkout?.dirty) return wait(controller, item, 'your checkout has unsaved changes');

  const ctx = lease(controller, campaignId);
  if (!ctx) return false;
  // The request names the trusted tip before any object is written, so a restart recognizes the planned commit.
  if (!controller.fenced(ctx, () => {
    if (!still() || !accepted()) return false;
    store.journal(campaignId, 'merge-requested', { task: task.task_id, sha, url, base: tip.tip, local: true }, controller.now());
    return true;
  })) return false;
  controller.injectFault('before-merge');
  const refuse = (detail) => {
    controller.fenced(ctx, () => store.journal(campaignId, 'merge-refused', { task: task.task_id, sha, url, local: true, detail: String(detail).slice(0, 500) }, controller.now()));
    controller.log(`merge of ${campaignId}/${task.task_id} refused: ${detail}`);
    return true;
  };
  const planned = writeMergeCommit({ git, repoPath, trusted: tip.tip, verified: sha,
    message: `Merge ${task.task_id} of campaign ${campaignId} (${url})\n\nVerified ${sha} on ${branch}, merged under the local merge gate.` });
  if (!planned.ok) return refuse(planned.reason);
  controller.injectFault('after-commit-tree');
  try {
    controller.fenced(ctx, () => {
      // Checked again under the write lock: a pause, cancellation or switch to owner acceptance since the request moves nothing.
      if (!still() || !accepted()) return;
      const moved = moveMain({ git, repoPath, trusted: tip.tip, commit: planned.commit, checkout: checkout?.path ?? null });
      if (!moved.ok) throw new Error(moved.reason);
      controller.injectFault('after-merge');
      recordLocal(controller, ctx, item, { trusted: tip.tip, mergeCommit: planned.commit, reconciled: false, requested: true });
    });
  } catch (error) {
    if (error instanceof FencedError) throw error;
    return refuse(error.message);
  }
  return true;
}

/**
 * The base moved past the verified head: reopen the task as an integration repair round on its own branch and PR (the
 * existing aiworks#27 repair). The round merges the base in and needs a fresh independent verification; the pull request
 * is merged only once that new head is verified and published. A moved base is B1: its round never counts toward
 * maxRepairRounds and never stalls the task. `refreshed` says why a refresh did not merge it. Inside fenced(). Returns true.
 */
function repair(controller, ctx, item, repoPath, baseSha, refreshed) {
  const { store } = controller, git = controller.cmd.git, { campaignId, decl, task } = item;
  const fresh = store.task(campaignId, task.task_id);
  // A cancellation or pause committed after this task was selected keeps the completed task as it is (aiworks#5).
  if (fresh.version !== task.version || fresh.state !== 'done' || !controller.takesRepair(campaignId)) return false;
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
    stalledReason: `the base moved before merging, after ${fresh.repair_rounds} repair rounds`, bounded: false });
  store.journal(campaignId, 'merge-base-moved', { task: task.task_id, sha, base: baseSha, paths, commits: commits.map((entry) => entry.sha), stalled }, now);
  controller.log(`merge of ${campaignId}/${task.task_id} waits for an integration repair: ${base} moved to ${baseSha}`);
  return true;
}
