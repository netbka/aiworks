// Review of a finished result (docs/design/OWNER_UI_V2.md WP4). Each acceptance criterion of a step is mapped to what
// the independent verifier checked and saw, from the validated `criteria` of its accepted verification
// (adapters/claude.mjs CRITERIA_SCHEMA); a criterion it did not report is "not checked", never a pass. The owner may
// accept the exact verified head, or request changes: that reopens the step as a bounded repair round on its own branch
// (Controller.reopenPublished), keeps every earlier run and check, and needs a fresh independent verification of the new
// head before anything is published again. Acceptance never merges or applies anything itself: a GitHub result merges
// only through the supervisor's merge gate, and a local result is applied only by the owner's Apply. In a project whose
// acceptance mode is "owner" (AW-015) the merge gate also waits for that acceptance (awaitingAcceptance).
import { createHash } from 'node:crypto';
import { acceptanceMode, projectOf } from './project-settings.mjs';

/** The finding that reopens a finished step at the owner's request. */
export const OWNER_CHANGES = 'owner-changes';
export const MAX_FEEDBACK = 2000;
const SHA = /^[0-9a-f]{40}$/;

/** The digest of the report the verifier reviewed, as it was bound in its result. */
export const reportDigestOf = (task) => createHash('sha256').update(String(task?.result?.report ?? ''), 'utf8').digest('hex');

/**
 * The accepted verification of a task's verified head, or null: the stored verdict must be "accepted", name exactly the
 * verified head and the report the task holds. Anything else is not evidence about this result.
 */
export function verifiedReview(task) {
  const v = task?.verification;
  if (!v || v.verdict !== 'accepted' || !SHA.test(task.verified_sha ?? '') || v.targetSha !== task.verified_sha) return null;
  if (v.reportDigest !== reportDigestOf(task)) return null;
  return v;
}

/**
 * Each acceptance criterion with its result, check and evidence. `pass` and `fail` come only from the verifier's entry
 * for that criterion; a criterion without one, or with more than one, is `not-checked`.
 */
export function criterionEvidence(acceptance, verification) {
  const entries = Array.isArray(verification?.criteria) ? verification.criteria : [];
  return (Array.isArray(acceptance) ? acceptance : []).map((text, i) => {
    const mine = entries.filter((item) => item?.criterion === i + 1);
    const item = mine.length === 1 ? mine[0] : null;
    const result = ['pass', 'fail', 'not-checked'].includes(item?.result) ? item.result : 'not-checked';
    return { criterion: i + 1, text, result, check: item?.check ?? null, evidence: item?.evidence ?? null, reported: Boolean(item) };
  });
}

/**
 * What is still unresolved about a finished step's result: criteria that failed or were not checked, and blocking
 * findings. A parent with any of them is never shown as complete.
 */
export function unresolvedOf(criteria, verification) {
  const blocking = (verification?.findings ?? []).filter((finding) => finding?.severity === 'blocking').length;
  return { failed: criteria.filter((item) => item.result === 'fail').length, notChecked: criteria.filter((item) => item.result === 'not-checked').length, blocking };
}

/**
 * Whether a step's result passed the independent check: an accepted verification of exactly its verified head and
 * report, every acceptance criterion reported as passed and no blocking finding. A verified head alone is not a pass:
 * a criterion not checked or failed leaves the result unchecked or partly checked, and it is never shown or counted as passed.
 */
export function passedCheck(task, acceptance) {
  const v = verifiedReview(task);
  if (!v) return false;
  const unresolved = unresolvedOf(criterionEvidence(acceptance, v), v);
  return !unresolved.failed && !unresolved.notChecked && !unresolved.blocking;
}

/**
 * One campaign's review records, each read from the store once, on first use: its merges and the owner's pending change
 * requests and acceptances. A view of many steps asks it per step instead of reading the campaign's records again for
 * each one; the single-step helpers below answer from it, so both always give the same answer. `merged()` is the
 * campaign's merge entries, newest first.
 */
export function reviewRecords(store, campaignId) {
  const rows = {};
  const merged = () => (rows.merged ??= store.all("SELECT at, detail FROM journal WHERE campaign_id = ? AND kind = 'merged' ORDER BY seq DESC", campaignId));
  const changes = () => (rows.changes ??= store.all(
    "SELECT seq, payload, received_at FROM events WHERE campaign_id = ? AND kind = 'result-changes' AND processed_at IS NULL ORDER BY seq", campaignId));
  const accepted = () => (rows.accepted ??= store.all(
    "SELECT seq, payload, received_at FROM events WHERE campaign_id = ? AND kind = 'result-accepted' ORDER BY seq", campaignId));
  return {
    merged,
    mergedHead: (taskId, sha) => merged().some((row) => row.detail?.task === taskId && row.detail?.sha === sha),
    pendingChanges: (taskId, sha) => changes().find((event) => event.payload?.taskId === taskId && event.payload?.verifiedSha === sha) ?? null,
    acceptedHead: (taskId, sha, reportDigest) => accepted()
      .find((event) => event.payload?.taskId === taskId && event.payload?.verifiedSha === sha && event.payload?.reportDigest === reportDigest) ?? null,
  };
}

/** Whether a step's verified head was recorded as merged. */
export const mergedHead = (store, campaignId, taskId, sha) => reviewRecords(store, campaignId).mergedHead(taskId, sha);

/** The owner's change request for a verified head that the controller has not handled yet, or null. */
export const pendingChanges = (store, campaignId, taskId, sha) => reviewRecords(store, campaignId).pendingChanges(taskId, sha);

/**
 * The owner's recorded acceptance of exactly this verified head and the report it was checked with, or null. An
 * acceptance of another head, or of the same head with another report, is not this one.
 */
export const acceptedHead = (store, campaignId, taskId, sha, reportDigest) => reviewRecords(store, campaignId).acceptedHead(taskId, sha, reportDigest);

/**
 * Why the merge gate holds a verified head for the owner (AW-015), or null. With the project's acceptance mode "owner"
 * the head merges only once the owner accepted exactly it with the report the task holds now; the mode is read from the
 * newest settings at every call, so it holds after a restart and follows a switch either way. "automatic" holds nothing.
 */
export function awaitingAcceptance(store, campaign, task) {
  if (acceptanceMode(store, projectOf(campaign?.declaration)) !== 'owner') return null;
  if (SHA.test(task?.verified_sha ?? '') && acceptedHead(store, campaign.id, task.task_id, task.verified_sha, reportDigestOf(task))) return null;
  return 'waits for your acceptance of this checked version (you accept results yourself in this project)';
}

/**
 * The blocking finding of an owner-requested repair round. The owner's words are data for the next worker: the request
 * never widens the packet, and the verified head must stay an ancestor of the repair.
 */
export function ownerChangesFinding({ verifiedSha, text, criterion = null }) {
  const request = String(text ?? '').slice(0, MAX_FEEDBACK);
  return {
    id: OWNER_CHANGES, severity: 'blocking', verified: verifiedSha, criterion, request,
    description: `Owner request: the owner reviewed the verified commit ${verifiedSha}${criterion ? ` against acceptance criterion ${criterion}` : ''} and asked for changes: "${request}". ` +
      'Make the change on top of this branch within the packet (the request does not widen it), run the full gate and commit. ' +
      `Never rebase, reset or amend: ${verifiedSha} must stay an ancestor of the new head.`,
  };
}
