// AIWorks merge gate (aiworks#138, AW-001 as amended): the supervisor merges a verified pull request itself, only in a
// repository the owner opted in through config.json, and only when merging it puts exactly the independently verified
// tree on the base branch. Off by default. It merges with a merge commit through REST (PUT .../merge, merge_method=merge,
// sha=<verified>); never a squash, a rebase, a force-push, an admin bypass or a branch deletion. It never deploys,
// releases or changes provider resources. AIWorks's own repository with local main trusted (config.json `selfHosting`,
// docs/design/LOCAL_OPERATION.md section 4.4, slice SELF8) merges its verified local reviews locally instead: a merge
// commit of the trusted tip and the verified head with the verified tree (or, after a passed refresh, the gated merge
// result), main moved only from the trusted tip, and a main ledger row (release/local-merge.mjs). It reads no remote and
// makes no GitHub call; the owner's optional backup of trusted main (github-backup.mjs, slice SELF9) runs after those
// merges and never holds one. In a project whose acceptance mode is "owner" (AW-015, project-settings.mjs) every one of
// these merges also needs the owner's acceptance of exactly the verified head and report (result-review.mjs
// awaitingAcceptance), checked when candidates are chosen and again inside the fenced write that requests the merge.
// After a recorded GitHub merge, the project's own folder is fast-forwarded to the merged base when it is clean on that
// branch (updateFolder, AW-018); otherwise it is left as it is with the reason journaled.
// P1 of the Git maintenance and merge orchestrator plan (docs/plans/git-maintenance-merge-orchestrator.md): inside the
// fenced merge request the fetched base is checked against the newest merge AIWorks recorded on it (baseFresh), a
// refused call backs off (refusalWait), GitHub's mergeable_state holds a protected head back (mergeBlocker), and each
// requested merge is checked once for the shape it asked for (checkMergeShape), recorded as information, never a hold.
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gitA from './adapters/git.mjs';
import * as github from './adapters/github.mjs';
import { mergeWithMergeCommit } from './release/github-merge.mjs';
import { fastForwardFolder } from './release/folder-update.mjs';
import { isPlannedMerge, moveMain, writeMergeCommit } from './release/local-merge.mjs';
import { mainLedger, recordMainCommit, trustedTip } from './self-hosting.mjs';
import { backupStep } from './github-backup.mjs';
import { reviewItem, WORK_REFERENCE, workLink } from './work-list.mjs';
import { effectiveLimits } from './project-settings.mjs';
import { specsOf } from './plan.mjs';
import { resolveCheckout } from './project-connect.mjs';
import { passedTree, refreshSettings, refreshStep } from './merge-refresh.mjs';
import { batchStep, groupTree } from './merge-batch.mjs';
import { ConflictError, FencedError } from './store.mjs';
import { awaitingAcceptance, mergeRefusal, pendingChanges } from './result-review.mjs';
import { authorityChange } from './release/authority-path.mjs';
import { contentFindings, privateTerms } from '../shared/public-text.mjs';

const SHA = /^[0-9a-f]{40}$/;

/**
 * How many of the commits a local merge would add to main (`trusted..sha`) have a message the public-history check of
 * a push refuses (scripts/check-public-scope.mjs: credentials, a personal path, another owner's project, an installation's
 * private terms), or null when git cannot list them. On 2026-10-30 a worker's default merge message named a local
 * repository path; once on trusted main, every later main contained it and GitHub main could never take it (#125).
 * Unreadable private terms (.local/publication.json) count as none: they never block a local review.
 */
export function privateMessages({ git, repoPath, trusted, sha, also = [] }) {
  let terms = [];
  try { terms = privateTerms(repoPath); } catch { /* malformed settings: the built-in checks still apply */ }
  const listed = gitA.exec(git, ['-c', 'log.showSignature=false', 'log', '--format=%B%x00', `${trusted}..${sha}`], { cwd: repoPath });
  if (!listed.ok) return null;
  return [...listed.stdout.split('\0'), ...also].filter((message) => message.trim() && refusedMessage(message, terms)).length;
}

// As checkPublicHistory reads a message: GitHub's own pull request merge header names a branch of this repository's
// owner, not another project, so only that finding is set aside for it.
const GITHUB_MERGE = /^(Merge pull request #[1-9]\d* from )netbka\//;
function refusedMessage(message, terms) {
  let findings = contentFindings(message, terms);
  if (GITHUB_MERGE.test(message) && !contentFindings(message.replace(GITHUB_MERGE, '$1')).includes('another upstream-owner project')) {
    findings = findings.filter((finding) => finding !== 'another upstream-owner project');
  }
  return findings.length > 0;
}
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
      // A head whose full check failed, or that neither passed its check nor is a delivery with known defects (AW-017), never merges.
      const refused = mergeRefusal(task);
      if (refused) { wait(controller, { campaignId: id, task }, `never merged: ${refused}`); continue; }
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

/** A durable passed refresh for this exact verified head and current base; ordering only, never merge authority. */
export function refreshedOnBase(store, { campaignId, task }, baseSha) {
  return SHA.test(baseSha ?? '') && SHA.test(task.verified_sha ?? '')
    && SHA.test(passedTree(store, campaignId, task.task_id, task.verified_sha, baseSha) ?? '');
}

/** Promote checked results within each branch's existing positions, keeping age/plan order among equal ranks. */
function prioritizeRefreshed(store, items, bases) {
  const branches = new Map();
  for (const item of items) {
    const branch = item.decl.target.baseBranch;
    if (!branches.has(branch)) branches.set(branch, []);
    branches.get(branch).push({ item, ready: refreshedOnBase(store, item, bases.get(branch)) });
  }
  for (const entries of branches.values()) entries.sort((a, b) => Number(b.ready) - Number(a.ready));
  return items.map((item) => branches.get(item.decl.target.baseBranch).shift().item);
}

const PRIORITY_BUSY = Symbol('checked merge waiting for campaign lease');
function priorityBusy(controller, item) {
  const key = `${item.campaignId}:${item.task.task_id}:${item.task.verified_sha}`;
  const reason = 'the checked merge result waits for its campaign lease; siblings on this base wait until the next merge pass';
  if (controller.mergeWaits.get(key) !== reason) {
    controller.mergeWaits.set(key, reason);
    controller.log(`merge of ${item.campaignId}/${item.task.task_id} waits: ${reason}`);
  }
  return PRIORITY_BUSY;
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
      // With merges.batch, AIWorks's own verified reviews waiting for trusted main first merge as one group (merge-batch.mjs).
      if (settings.batch) {
        try {
          const tip = trustedTip(controller.store, { git: controller.cmd.git, repoPath, repository: decl.target.repository });
          if (tip.state === 'TRUSTED' && await batchStep(controller, items.filter((item) => item.decl.target.baseBranch === 'main' &&
            !authorityBlocked(controller, item, repoPath, tip.tip)), settings, repoPath, tip.main)) continue;
        } catch (error) {
          if (error instanceof FencedError || error instanceof ConflictError) { controller.log(`group merge for ${decl.target.repository} retried later: ${error.message}`); continue; }
          controller.log(`group merge for ${decl.target.repository} failed, merging one at a time: ${error.stack || error}`);
        }
      }
      // Re-read after a group step: a stopped group may have advanced trusted main.
      const tip = trustedTip(controller.store, { git: controller.cmd.git, repoPath, repository: decl.target.repository });
      const ordered = settings.refresh && tip.state === 'TRUSTED'
        ? prioritizeRefreshed(controller.store, items, new Map([['main', tip.tip]])) : items;
      const busy = new Set();
      for (const item of ordered) {
        if (busy.has(item.decl.target.baseBranch)) continue;
        try {
          const result = mergeLocal(controller, item, settings, repoPath, null, true);
          if (result === PRIORITY_BUSY) { busy.add(item.decl.target.baseBranch); continue; }
          if (result) break;
        } catch (error) {
          if (error instanceof FencedError || error instanceof ConflictError) { controller.log(`merge of ${item.campaignId}/${item.task.task_id} retried later: ${error.message}`); break; }
          controller.log(`merge of ${item.campaignId}/${item.task.task_id} failed: ${error.stack || error}`);
          break;
        }
      }
      continue;
    }
    const bases = new Map(), shapeChecked = new Set(), repository = decl.target.repository;
    controller.mergePassReads = new Map();
    // After the base is fetched, the newest merge AIWorks requested on it is checked once for the shape it asked for (P1
    // safe promotion): recorded and logged, never a hold, since condition 3 already sends the next head onto that base
    // through a verifier when it does not contain it.
    const checkShape = (branch) => {
      if (!SHA.test(bases.get(branch) ?? '') || shapeChecked.has(branch)) return;
      shapeChecked.add(branch);
      try { checkMergeShape(controller, repository, branch, repoPath); } catch (error) {
        if (!(error instanceof FencedError || error instanceof ConflictError)) throw error;
        controller.log(`merge shape check for ${repository} retried later: ${error.message}`);
      }
    };
    if (settings.batch) {
      const branch = decl.target.baseBranch;
      bases.set(branch, (await controller.fetchBase(repoPath, branch)).sha);
      checkShape(branch);
      try {
        if (SHA.test(bases.get(branch) ?? '') && await batchStep(controller, items.filter((item) => item.decl.target.baseBranch === branch &&
          !authorityBlocked(controller, item, repoPath, bases.get(branch))), settings, repoPath, bases.get(branch))) continue;
      } catch (error) {
        if (error instanceof FencedError || error instanceof ConflictError) { controller.log(`group merge for ${decl.target.repository} retried later: ${error.message}`); continue; }
        controller.log(`group merge for ${decl.target.repository} failed, merging one at a time: ${error.stack || error}`);
      }
      bases.set(branch, (await controller.fetchBase(repoPath, branch)).sha);
    }
    // Rank against freshly fetched bases, including the re-fetch after a group step. Other branches retain their slots.
    for (const branch of new Set(items.map((item) => item.decl.target.baseBranch))) {
      if (!bases.has(branch)) bases.set(branch, (await controller.fetchBase(repoPath, branch)).sha);
      checkShape(branch);
    }
    const ordered = settings.refresh ? prioritizeRefreshed(controller.store, items, bases) : items;
    const busy = new Set();
    for (const item of ordered) {
      const branch = item.decl.target.baseBranch;
      if (busy.has(branch)) continue;
      if (!SHA.test(bases.get(branch) ?? '')) { controller.log(`merge of ${item.campaignId}/${item.task.task_id} waits: ${branch} could not be fetched`); continue; }
      checkShape(branch);
      try {
        const result = mergeOne(controller, item, settings, repoPath, bases.get(branch));
        if (result === PRIORITY_BUSY) { busy.add(branch); continue; }
        if (result) break;
      } catch (error) {
        if (error instanceof FencedError || error instanceof ConflictError) { controller.log(`merge of ${item.campaignId}/${item.task.task_id} retried later: ${error.message}`); break; }
        controller.log(`merge of ${item.campaignId}/${item.task.task_id} failed: ${error.stack || error}`);
        break;
      }
    }
  }
  // After the local merges, also in a pass with nothing to merge, so a backup the interval deferred still follows. A
  // GitHub project's own folder follows its newest recorded merge (AW-018).
  for (const key of due) {
    if (controller.selfHosted(key)) backup(controller, key);
    else {
      try { await updateFolder(controller, key); } catch (error) {
        if (error instanceof FencedError || error instanceof ConflictError) controller.log(`folder update for ${key} retried later: ${error.message}`);
        else controller.log(`folder update for ${key} failed: ${error.message}`);
      }
    }
  }
}

/** The journal kinds of a folder update (AW-018), shown on the project as information. */
export const FOLDER_UPDATED = 'project-folder-updated';
export const FOLDER_LEFT = 'project-folder-left';
const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const comparable = (path) => {
  let value;
  try { value = realpathSync.native(path); } catch { value = resolve(path); }
  value = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
/** Whether folder `a` is folder `b` or lies inside it, after links and junctions are resolved. */
const within = (a, b) => { const [x, y] = [comparable(a), comparable(b)]; return x === y || x.startsWith(`${y}/`); };
const foldPath = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);
/** Whether repository path `changed` is, contains or lies inside the folder-relative path `held`. */
const touches = (changed, held) => { const p = foldPath(changed); return p === held || p.startsWith(`${held}/`) || held.startsWith(`${p}/`); };

/**
 * Bring a GitHub project's configured folder (config.json `repositories` path, or the connected project's root) up to
 * the newest merge AIWorks recorded for it (AW-018). Only a fast-forward of the base branch, and only when that branch
 * is checked out there with no changes and no commits of its own: anything else is the owner's, left as it is with the
 * reason recorded, and tried again after the next merge. Each recorded merge is tried once. Never the folder AIWorks
 * itself runs from or keeps its data in, nor one inside them; a folder holding them moves only when the fast-forward
 * changes nothing there. AIWorks's own repository with local main trusted is not handled here (its main moves through
 * the local merge gate). No hook of the folder runs. Returns the journal kind recorded, or null when nothing was due.
 */
export async function updateFolder(controller, key) {
  const { store } = controller, git = controller.cmd.git;
  let newest = null;
  for (const { id } of store.all("SELECT id FROM campaigns WHERE control IN ('registered', 'finished') ORDER BY created_at")) {
    const decl = store.campaign(id).declaration;
    if (String(decl.target.repository ?? '').toLowerCase() !== key || controller.selfHosted(decl.target.repository)) continue;
    const row = store.get("SELECT seq, detail FROM journal WHERE campaign_id = ? AND kind = 'merged' ORDER BY seq DESC LIMIT 1", id);
    if (row && !row.detail?.local && SHA.test(row.detail?.mergeCommit ?? '') && (!newest || row.seq > newest.seq)) newest = { ...row, campaignId: id, decl };
  }
  if (!newest) return null;
  const { campaignId, decl } = newest, mergeCommit = newest.detail.mergeCommit, base = decl.target.baseBranch;
  const tried = store.get(`SELECT 1 AS present FROM journal WHERE campaign_id = ? AND kind IN (?, ?) AND json_extract(detail, '$.mergeCommit') = ?`,
    campaignId, FOLDER_UPDATED, FOLDER_LEFT, mergeCommit);
  if (tried) return null;
  const folder = resolveCheckout(store, controller.config, decl.target.repository);
  if (!folder?.path || folder.conflict) return null;
  const path = folder.path;
  const note = (kind, detail) => {
    const ctx = lease(controller, campaignId);
    if (!ctx) return null;
    controller.fenced(ctx, () => store.journal(campaignId, kind, { repository: decl.target.repository, branch: base, mergeCommit, task: newest.detail.task, ...detail }, controller.now()));
    controller.log(`project folder of ${decl.target.repository} ${kind === FOLDER_UPDATED ? 'updated' : `left as it is (${detail.reason})`} after merge ${mergeCommit}`);
    return kind;
  };
  const left = (reason) => note(FOLDER_LEFT, { reason });
  const own = [controller.runtimeRoot ?? RUNTIME_ROOT, controller.dataDir].filter(Boolean);
  if (own.some((dir) => within(path, dir))) return left('aiworks-runtime');
  // The runtime checkout or data directory may sit in an ignored folder of this checkout (the AIWorks source with its
  // `.local/`), beside task worktrees, campaigns and governance. The folder then moves only when the fast-forward changes
  // no tracked path anywhere in that top-level folder: Git would write over ignored files.
  const held = own.filter((dir) => within(dir, path)).map((dir) => comparable(dir).slice(comparable(path).length + 1).split('/')[0]);
  const fetched = await controller.fetchBase(path, base, decl.target.repository);
  // The merged base could not be read: nothing is recorded, so the next pass tries the same merge again.
  if (!fetched.ok) return null;
  if (!gitA.isAncestor({ git, path, ancestor: mergeCommit, descendant: fetched.sha })) return left('unreadable');
  const head = gitA.exec(git, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: path });
  if (!head.ok || !SHA.test(head.stdout)) return left('unreadable');
  if (held.length) {
    const changed = gitA.changedPaths({ git, path, from: head.stdout, to: fetched.sha });
    if (!changed) return left('unreadable');
    if (changed.some((file) => held.some((dir) => touches(file, dir)))) return left('aiworks-runtime');
  }
  // The fast-forward starts only from the head checked here.
  const moved = fastForwardFolder({ git, path, branch: base, target: fetched.sha, hooksOff: join(controller.dataDir, 'no-hooks'), expectedHead: head.stdout });
  return moved.updated ? note(FOLDER_UPDATED, { from: moved.from, to: moved.to, already: moved.already }) : left(moved.reason);
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

/**
 * What GitHub's mergeable_state says holds a pull request back (P1 pre-integration check): branch protection with
 * required checks or reviews still missing (`blocked`), a head behind a protected base (`behind`), conflicts (`dirty`)
 * or a draft. Read only; the gate never changes protection and never bypasses it. Any other state, or none, decides nothing.
 */
const PROTECTION_WAITS = Object.freeze({
  blocked: 'GitHub reports the pull request blocked: branch protection still requires checks or reviews at this head',
  behind: 'GitHub reports the head behind a protected base',
  dirty: 'GitHub reports the pull request in conflict with its base',
  draft: 'the pull request is a draft',
});

/** Why CI or GitHub holds a pull request back right now, or null. With CI repair on, only a passed or absent CI merges. */
export function mergeBlocker(controller, { campaignId, task }, pr) {
  const sha = task.verified_sha;
  if (controller.ci && !ciMergeable(controller.store, campaignId, task.task_id, sha)) {
    return ciAt(controller.store, campaignId, task.task_id, sha) === 'ci-failed' ? 'CI failed at the verified head; CI repair runs first'
      : 'CI has not passed at the verified head yet';
  }
  if (pr.draft) return PROTECTION_WAITS.draft;
  if (typeof pr.mergeableState === 'string' && Object.hasOwn(PROTECTION_WAITS, pr.mergeableState)) return PROTECTION_WAITS[pr.mergeableState];
  if (pr.mergeable !== true) return pr.mergeable === false ? 'GitHub reports it not mergeable' : 'GitHub has not computed mergeability yet';
  return null;
}

// A refused merge call is tried once more at the next poll; from the second refusal of the same head on, the wait
// doubles, from one poll interval up to an hour, and the head is never given up by itself (AW-017: a refusal that
// does not clear stays visible as its wait, and an integration repair or the owner's change settles it). A refusal
// whose outcome the next read settles (a merge whose response was lost) is reconciled before this wait is judged,
// since inspect() reads the pull request first.
const MAX_REFUSAL_WAIT_MS = 60 * 60_000;

/**
 * The wait a refused head still owes, or null when it may be tried now: { reason, until }. Counts every `merge-refused`
 * of this head in the journal, so a restart keeps the count.
 */
export function refusalWait(controller, { campaignId, task }) {
  const refusals = controller.store.all(`SELECT at FROM journal WHERE campaign_id = ? AND kind = 'merge-refused'
    AND json_extract(detail, '$.task') = ? AND json_extract(detail, '$.sha') = ? ORDER BY seq DESC`, campaignId, task.task_id, task.verified_sha);
  if (refusals.length < 2) return null;
  const delay = Math.min(MAX_REFUSAL_WAIT_MS, controller.config.integrationPollMs * 2 ** (refusals.length - 2));
  const until = refusals[0].at + delay;
  if (until <= controller.now()) return null;
  return { until, reason: `the merge call was refused ${refusals.length} times; it is tried again after ${new Date(until).toISOString()}` };
}

/**
 * The newest merge AIWorks recorded on a repository's base branch, across campaigns: { mergeCommit, campaignId, task },
 * or null. A GitHub merge only (a local merge moves main itself, which the trusted tip reads).
 */
export function newestRecordedMerge(store, repository, branch) {
  const row = store.get(`SELECT j.campaign_id, j.detail FROM journal j JOIN campaigns c ON c.id = j.campaign_id
    WHERE j.kind = 'merged' AND lower(json_extract(c.declaration, '$.target.repository')) = ? AND json_extract(c.declaration, '$.target.baseBranch') = ?
    AND json_extract(j.detail, '$.local') IS NULL ORDER BY j.seq DESC LIMIT 1`, String(repository).toLowerCase(), branch);
  return row && SHA.test(row.detail?.mergeCommit ?? '') ? { mergeCommit: row.detail.mergeCommit, campaignId: row.campaign_id, task: row.detail.task } : null;
}

/**
 * Whether `baseSha`, the base this pass fetched, is at or after every merge AIWorks itself recorded on that base: the
 * repository's own merges serialize across supervisor instances through the store's write lock, so a merge recorded by
 * another instance after this fetch shows here before any call. False when that merge commit is not an ancestor of the
 * fetched base, or is not readable locally yet (a merge just made elsewhere): the base is fetched again next pass.
 */
export function baseFresh(controller, repository, branch, repoPath, baseSha) {
  const newest = newestRecordedMerge(controller.store, repository, branch);
  if (!newest || newest.mergeCommit === baseSha) return true;
  return gitA.isAncestor({ git: controller.cmd.git, path: repoPath, ancestor: newest.mergeCommit, descendant: baseSha });
}

/** The journal kind of the post-merge check of a GitHub merge commit's shape (P1 safe promotion). */
export const MERGE_SHAPE = 'merge-shape';

/**
 * Check, once, the shape of the newest GitHub merge AIWorks requested in a repository, after its base was fetched: the
 * merge commit's parents must be the base the request named and the verified head, and its tree the verified tree, or the
 * gated tree a refresh or group named. Journals `merge-shape` ({ ok, parents, tree, expected }) under the campaign's
 * lease; a merge whose commit is not readable locally yet is checked on a later pass. A failed check is recorded and
 * logged as information about the base, never a hold: nothing on the base is rewritten, and the next head onto that base
 * is judged by condition 3 as always (an integration repair, through a verifier, when it does not contain the base).
 * Returns the detail recorded, or null when nothing was due.
 */
export function checkMergeShape(controller, repository, branch, repoPath) {
  const { store } = controller, git = controller.cmd.git;
  const newest = newestRecordedMerge(store, repository, branch);
  if (!newest) return null;
  const { mergeCommit, campaignId, task: taskId } = newest;
  const merged = store.get(`SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'merged' AND json_extract(detail, '$.mergeCommit') = ? ORDER BY seq DESC LIMIT 1`,
    campaignId, mergeCommit)?.detail;
  if (!merged?.requested) return null; // merged elsewhere, or reconciled from a merge nobody here requested: not AIWorks's shape to check
  if (store.get(`SELECT 1 AS present FROM journal WHERE campaign_id = ? AND kind = ? AND json_extract(detail, '$.mergeCommit') = ?`, campaignId, MERGE_SHAPE, mergeCommit)) return null;
  const request = lastRequest(store, campaignId, taskId, merged.sha);
  if (!request || !SHA.test(request.base ?? '')) return null;
  const shown = gitA.exec(git, ['show', '-s', '--format=%T %P', mergeCommit], { cwd: repoPath, timeoutMs: 30_000 });
  if (!shown.ok) return null;
  const [tree, ...parents] = shown.stdout.split(/\s+/);
  const verifiedTree = commitTree(git, repoPath, merged.sha);
  const expected = { parents: [request.base, merged.sha], tree: typeof request.tree === 'string' ? request.tree : verifiedTree };
  const ok = Boolean(expected.tree) && tree === expected.tree && parents.length === 2 && parents[0] === expected.parents[0] && parents[1] === expected.parents[1];
  const ctx = lease(controller, campaignId);
  if (!ctx) return null;
  const detail = { task: taskId, sha: merged.sha, mergeCommit, ok, parents, tree, expected };
  controller.fenced(ctx, () => store.journal(campaignId, MERGE_SHAPE, detail, controller.now()));
  if (!ok) controller.log(`merge ${mergeCommit} of ${campaignId}/${taskId} on ${repository} does not have the requested shape: parents ${parents.join(' ')}, tree ${tree}; expected ${expected.parents.join(' ')} with tree ${expected.tree}. The base carries it as it is; the next head onto it is judged against that base.`);
  return detail;
}

const commitTree = (git, repoPath, sha) => {
  const out = gitA.exec(git, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`], { cwd: repoPath, timeoutMs: 30_000 });
  return out.ok && SHA.test(out.stdout) ? out.stdout : null;
};

/**
 * Judge one published pull request against the gate and act on it. Returns true when it acted on the repository (a
 * merge call, a recorded merge or an integration repair), so the pass moves on to the next repository.
 */
function mergeOne(controller, item, settings, repoPath, baseSha) {
  if (authorityBlocked(controller, item, repoPath, baseSha)) return false;
  const git = controller.cmd.git, sha = item.task.verified_sha;
  const { pr, acted } = inspect(controller, item, settings, repoPath, baseSha);
  if (!pr) return acted;
  const priority = Boolean(settings.refresh) && refreshedOnBase(controller.store, item, baseSha);
  // Only an otherwise eligible checked result holds siblings when its actual lease acquisition loses a race.
  if (priority) {
    const blocker = mergeBlocker(controller, item, pr), owed = refusalWait(controller, item);
    if (blocker || owed) return wait(controller, item, blocker ?? owed.reason);
    if (!stillMergeable(controller, item) || !baseFresh(controller, item.decl.target.repository, item.decl.target.baseBranch, repoPath, baseSha)) return false;
  }

  // The verified head must contain the current base, or the merge result is a tree no verifier ran: integration repair,
  // unless the refresh (merges.refresh) ran the gate on that exact merge result itself. While its gate runs, the
  // repository waits, so the next pull request is judged against the base this one leaves.
  let gated = null;
  if (!gitA.isAncestor({ git, path: repoPath, ancestor: baseSha, descendant: sha })) {
    const ctx = lease(controller, item.campaignId);
    if (!ctx) return priority ? priorityBusy(controller, item) : false;
    const step = settings.refresh ? refreshStep(controller, ctx, item, repoPath, baseSha, settings.refresh) : { next: 'repair' };
    if (step.next === 'wait') { wait(controller, item, step.reason); return true; }
    if (step.next === 'repair') return controller.fenced(ctx, () => repair(controller, ctx, item, repoPath, baseSha, step.detail));
    // The merge carries the gated merge result, which the shape check expects (checkMergeShape).
    if (SHA.test(step.tree ?? '')) gated = step.tree;
  }
  const blocker = mergeBlocker(controller, item, pr);
  if (blocker) return wait(controller, item, blocker);
  const owed = refusalWait(controller, item);
  if (owed) return wait(controller, item, owed.reason);
  return mergeNow(controller, item, baseSha, repoPath, gated, priority);
}

function authorityBlocked(controller, item, repoPath, baseSha) {
  let problem;
  try {
    // The common base excludes legitimate owner authority changes integrated
    // from main, while retaining edits introduced by the worker's branch.
    const common = gitA.exec(controller.cmd.git, ['merge-base', baseSha, item.task.verified_sha], { cwd: repoPath });
    problem = common.ok ? authorityChange(controller, item.decl, repoPath, common.stdout, item.task.verified_sha)
      : 'The release authority boundary could not be checked';
  } catch { problem = 'The registered release authority boundary could not be read'; }
  if (problem) wait(controller, item, problem);
  return Boolean(problem);
}

/** Current task eligibility, rechecked inside the fenced merge request and before a priority lease wait. */
function stillMergeable(controller, { campaignId, task }) {
  const { store } = controller, c = store.campaign(campaignId), t = store.task(campaignId, task.task_id);
  return ['registered', 'finished'].includes(c.control) && t.state === 'done' && !t.blocked && t.verified_sha === task.verified_sha && t.pr_url === task.pr_url && !mergeRefusal(t)
    && !pendingChanges(store, campaignId, task.task_id, task.verified_sha) && !awaitingAcceptance(store, c, t)
    && (!controller.ci || ciMergeable(store, campaignId, task.task_id, task.verified_sha));
}

/**
 * The merge call for a pull request already judged mergeable onto a checked tree: journal the request, merge the exact
 * verified SHA with a merge commit, record it. Returns false when the campaign lease or the task changed, true otherwise
 * (merged, or refused or unknown, which the next pass settles by reading the pull request first). Priority singles return
 * PRIORITY_BUSY only when an otherwise eligible checked result could not acquire its lease; group callers stay boolean.
 */
export function mergeNow(controller, item, baseSha, repoPath = null, tree = null, priority = false) {
  const { store } = controller, { campaignId, decl, task, number } = item;
  const gh = controller.cmd.gh, sha = task.verified_sha, url = task.pr_url, repository = decl.target.repository, branch = decl.target.baseBranch;
  if (priority && (!stillMergeable(controller, item) || !baseFresh(controller, repository, branch, repoPath ?? controller.repo(decl).path, baseSha))) return false;
  const ctx = lease(controller, campaignId);
  if (!ctx) return priority ? priorityBusy(controller, item) : false;
  // The request is committed before the call: after a crash the next pass reads the pull request before any retry.
  const still = () => stillMergeable(controller, item);
  // Under the store's write lock, so a merge another instance recorded since this pass fetched the base is seen: a base
  // that moved under such a merge is judged again from a fresh fetch, never merged onto from this one (P1 serialization).
  const requested = controller.fenced(ctx, () => {
    if (!still()) return false;
    if (!baseFresh(controller, repository, branch, repoPath ?? controller.repo(decl).path, baseSha)) return 'stale';
    store.journal(campaignId, 'merge-requested', { task: task.task_id, sha, url, base: baseSha, ...(tree ? { tree } : {}) }, controller.now());
    return true;
  });
  if (requested === 'stale') {
    const moved = newestRecordedMerge(store, repository, branch)?.mergeCommit;
    return wait(controller, item, `${branch} moved under the merge ${moved} AIWorks recorded: the fetched ${baseSha} does not contain it; it is fetched again next pass`);
  }
  if (!requested) return false;
  controller.injectFault('before-merge');
  try {
    controller.fenced(ctx, () => {
      const { mergeCommit } = mergeWithMergeCommit({ gh, repository, number, sha, local: { git: controller.cmd.git, repoPath: repoPath ?? controller.repo(decl).path, base: baseSha, head: sha, tree } });
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
function recordLocal(controller, ctx, item, { trusted, mergeCommit, reconciled, requested, group = null }) {
  const { campaignId, decl, task } = item;
  const row = recordMainCommit(controller.store, { repository: decl.target.repository, kind: 'gate-merge', oldTip: trusted, newTip: mergeCommit,
    campaignId, taskId: task.task_id, verifiedSha: task.verified_sha, now: controller.now() });
  if (!row.recorded) throw new Error(`the main ledger refused the merge: ${row.reason}`);
  record(controller, ctx, item, mergeCommit, { reconciled, requested, local: true, trusted, ledger: row.seq, ...(group ? { group } : {}) });
}

/**
 * Why a verified local review cannot merge into main, whatever main is (its target, an owner hold, its review item, its
 * branch head), or null. Shared by mergeLocal and the group merge (merge-batch.mjs).
 */
export function localBlocker(controller, item, settings, repoPath) {
  const { campaignId, decl, task } = item, sha = task.verified_sha, url = task.pr_url;
  if (decl.target.baseBranch !== 'main') return `the local merge gate merges into main only, not ${decl.target.baseBranch}`;
  if (settings.held.has(url.toLowerCase())) return 'held by the owner (merges.held)';
  const review = reviewItem(controller.store, { campaignId, taskId: task.task_id });
  if (!review || workLink(review.number) !== url) return `${url} is not the review item recorded for this task`;
  const branch = gitA.branchName(campaignId, task.task_id), head = commitAt(controller.cmd.git, repoPath, `refs/heads/${branch}`);
  if (head !== sha) return `the local branch ${branch} is at ${head ?? 'no commit'}, not the verified ${sha}`;
  return null;
}

/**
 * The local merge gate (LOCAL_OPERATION.md section 4.4) for one verified local review of the self-hosted repository.
 * Returns true when it acted on the repository (a merge, a recorded merge, a refusal, a running refresh gate or an
 * integration repair). Main moves only when the trusted tip is an ancestor of the verified head or a refresh gate passed
 * on their exact merge result (merges.refresh), main is exactly the trusted tip, the checkout that
 * has main checked out is clean, the task's branch and review item are bound to the verified head, the campaign is
 * neither paused nor cancelled and this instance holds the campaign's lease. With `step` ({ group, base, tree }, from the
 * group merge, merge-batch.mjs) it merges one checked step of a group: only from the trusted tip `base`, with exactly the
 * tree `tree` that step predicted. Priority singles may return PRIORITY_BUSY on a lost lease acquisition; group steps
 * keep their boolean result and recorded order.
 */
export function mergeLocal(controller, item, settings, repoPath, step = null, prioritize = false) {
  const { store } = controller, { campaignId, decl, task } = item;
  const git = controller.cmd.git, sha = task.verified_sha, url = task.pr_url, repository = decl.target.repository;
  const blocked = localBlocker(controller, item, settings, repoPath);
  if (blocked) return wait(controller, item, blocked);
  const branch = gitA.branchName(campaignId, task.task_id);
  const tip = trustedTip(store, { git, repoPath, repository });
  // The message of the merge commit the gate writes; `gated` is the refresh gate's tree, if any.
  const mergeMessage = (gated) => `Merge ${task.task_id} of campaign ${campaignId} (${url})\n\nVerified ${sha} on ${branch}, merged under the local merge gate` +
    `${step ? `; its group passed one gate on the combined result ${step.group}` : gated ? `; its merge with ${tip.tip} passed the refresh gate` : ''}.`;
  if (tip.state !== 'TRUSTED') return wait(controller, item, `local main is not trusted (${tip.state}): ${tip.reason}`);
  if (authorityBlocked(controller, item, repoPath, tip.tip)) return false;
  const stillDone = (t) => t.state === 'done' && !t.blocked && t.verified_sha === sha && t.pr_url === url && !mergeRefusal(t);
  const still = () => ['registered', 'finished'].includes(store.campaign(campaignId).control) && stillDone(store.task(campaignId, task.task_id))
    && !pendingChanges(store, campaignId, task.task_id, sha);
  // A new merge also needs the owner's acceptance where they accept results (AW-015); a merge already made is recorded.
  const accepted = () => !awaitingAcceptance(store, store.campaign(campaignId), store.task(campaignId, task.task_id));

  // After a crash, main is read before any retry: the planned merge commit on main is recorded once and never made again.
  // A refreshed request names the gated tree, which counts only as the tree of the refresh that passed for this base, or,
  // for a group step, as this head's step of the group whose gate passed.
  const requested = lastRequest(store, campaignId, task.task_id, sha);
  const plannedTree = requested?.tree === undefined ? null : requested.tree;
  const group = typeof requested?.group === 'string' ? requested.group : null;
  if (requested && tip.main !== tip.tip && requested.base === tip.tip
    && (plannedTree === null || plannedTree === (group ? groupTree(store, group, { campaignId, task: task.task_id, sha })
      : passedTree(store, campaignId, task.task_id, sha, tip.tip)))
    && isPlannedMerge({ git, repoPath, sha: tip.main, trusted: tip.tip, verified: sha, tree: plannedTree })) {
    const ctx = lease(controller, campaignId);
    if (!ctx) return false;
    controller.fenced(ctx, () => {
      if (still()) recordLocal(controller, ctx, item, { trusted: tip.tip, mergeCommit: tip.main, reconciled: true, requested: true, group });
    });
    return true;
  }

  const owed = refusalWait(controller, item);
  if (owed) return wait(controller, item, owed.reason);
  // Main never takes a commit whose message a push of main would refuse (#125): neither one the merge adds nor its own
  // merge commit. Checked before any refresh gate runs and before the request, so main and the ledger stay as they are
  // and no gate is spent; refusals back off (refusalWait). No matched value is written anywhere.
  const leaks = privateMessages({ git, repoPath, trusted: tip.tip, sha, also: [mergeMessage(null)] });
  if (leaks !== 0) {
    const ctx = lease(controller, campaignId);
    if (!ctx) return false;
    const detail = leaks === null ? 'the commit messages it would add to main cannot be read'
      : `${leaks} commit message(s) it would add to main contain private information (a personal path, a credential or a private name), which a push of main refuses; the branch needs those commits rewritten`;
    controller.fenced(ctx, () => { if (still()) store.journal(campaignId, 'merge-refused', { task: task.task_id, sha, url, local: true, detail }, controller.now()); });
    controller.log(`merge of ${campaignId}/${task.task_id} refused: ${detail}`);
    return true;
  }

  const priority = prioritize && !step && Boolean(settings.refresh) && refreshedOnBase(store, item, tip.tip);
  let checkout;
  if (priority) {
    if (!still() || !accepted()) return false;
    if (tip.unrecordedCount) return wait(controller, item, `main has ${tip.unrecordedCount} commits AIWorks did not put there`);
    checkout = mainCheckout(git, repoPath);
    if (checkout?.unreadable) return wait(controller, item, 'the checkout that has main checked out cannot be read');
    if (checkout?.dirty) return wait(controller, item, 'your checkout has unsaved changes');
  }

  // The verified head must contain the trusted tip, or the merge result is a tree no verifier ran: integration repair,
  // unless the refresh (merges.refresh, merge-refresh.mjs) ran the gate on that exact merge result itself. Then the merge
  // commit carries that gated tree. While its gate runs, the repository waits.
  let gated = null;
  if (step) {
    if (tip.tip !== step.base || !SHA.test(step.tree ?? '')) return wait(controller, item, 'main is not at the checked step of its group');
    gated = step.tree;
  } else if (!gitA.isAncestor({ git, path: repoPath, ancestor: tip.tip, descendant: sha })) {
    const ctx = lease(controller, campaignId);
    if (!ctx) return priority ? priorityBusy(controller, item) : false;
    const step = settings.refresh ? refreshStep(controller, ctx, item, repoPath, tip.tip, settings.refresh) : { next: 'repair' };
    if (step.next === 'wait') { wait(controller, item, step.reason); return true; }
    if (step.next !== 'merge' || !SHA.test(step.tree ?? '')) return controller.fenced(ctx, () => repair(controller, ctx, item, repoPath, tip.tip, step.detail ?? null));
    gated = step.tree;
  }
  if (tip.unrecordedCount) return wait(controller, item, `main has ${tip.unrecordedCount} commits AIWorks did not put there`);
  checkout = mainCheckout(git, repoPath);
  if (checkout?.unreadable) return wait(controller, item, 'the checkout that has main checked out cannot be read');
  if (checkout?.dirty) return wait(controller, item, 'your checkout has unsaved changes');

  const ctx = lease(controller, campaignId);
  if (!ctx) return priority ? priorityBusy(controller, item) : false;
  // The request names the trusted tip before any object is written, so a restart recognizes the planned commit.
  if (!controller.fenced(ctx, () => {
    if (!still() || !accepted()) return false;
    store.journal(campaignId, 'merge-requested', { task: task.task_id, sha, url, base: tip.tip, local: true, ...(gated ? { tree: gated } : {}),
      ...(step ? { group: step.group } : {}) }, controller.now());
    return true;
  })) return false;
  controller.injectFault('before-merge');
  const refuse = (detail) => {
    controller.fenced(ctx, () => store.journal(campaignId, 'merge-refused', { task: task.task_id, sha, url, local: true, detail: String(detail).slice(0, 500) }, controller.now()));
    controller.log(`merge of ${campaignId}/${task.task_id} refused: ${detail}`);
    return true;
  };
  const planned = writeMergeCommit({ git, repoPath, trusted: tip.tip, verified: sha, tree: gated,
    message: mergeMessage(gated) });
  if (!planned.ok) return refuse(planned.reason);
  controller.injectFault('after-commit-tree');
  try {
    controller.fenced(ctx, () => {
      // Checked again under the write lock: a pause, cancellation or switch to owner acceptance since the request moves nothing.
      if (!still() || !accepted()) return;
      const moved = moveMain({ git, repoPath, trusted: tip.tip, commit: planned.commit, checkout: checkout?.path ?? null });
      if (!moved.ok) throw new Error(moved.reason);
      controller.injectFault('after-merge');
      recordLocal(controller, ctx, item, { trusted: tip.tip, mergeCommit: planned.commit, reconciled: false, requested: true, group: step?.group ?? null });
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
      `Merge ${baseSha} into this branch (git merge -m "Merge ${base} at ${baseSha.slice(0, 12)} into this branch" ${baseSha}: always this message, never Git's default, which can name a local path), resolve any conflicts, run the full gate and commit the merge. Never rebase, reset or amend: ${sha} must stay an ancestor of the new head.`,
  };
  const stalled = controller.reopenPublished(ctx, fresh, finding, { limits: effectiveLimits(store, decl), now,
    lastError: `merge-base-moved: ${sha} does not contain ${base} at ${baseSha}`,
    stalledReason: `the base moved before merging, after ${fresh.repair_rounds} repair rounds`, bounded: false });
  store.journal(campaignId, 'merge-base-moved', { task: task.task_id, sha, base: baseSha, paths, commits: commits.map((entry) => entry.sha), stalled }, now);
  controller.log(`merge of ${campaignId}/${task.task_id} waits for an integration repair: ${base} moved to ${baseSha}`);
  return true;
}
