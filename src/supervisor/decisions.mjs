// Structured decisions (docs/design/OWNER_UI_V2.md WP2) over the existing task blockers. A decision is a task's `blocked`
// record a worker stopped for: a B3 stop, or a checker that still rejects after the repair rounds. AIWorks answers it
// (AW-017, controller.answerSuggested); the owner may still answer it first from the dashboard. Its options,
// suggestion, what continues and what happens unanswered come only from the validated `decision` field of a worker result
// (adapters/claude.mjs DECISION_SCHEMA); a stop without one stays a free-text decision, answered in the owner's own words.
// An answer is delivered as owner guidance under the unchanged packet and authority, so it can never widen the work.
import { createHash } from 'node:crypto';

const OPTION = /^[a-z][a-z0-9-]{0,31}$/;
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max ? value : null;

/** The validated decision fields of a worker result, or null. Options must be unique and a suggestion must name one. */
export function structuredDecision(value) {
  const d = value?.decision;
  if (!d || typeof d !== 'object' || Array.isArray(d) || !text(d.question, 500) || !Array.isArray(d.options) || d.options.length < 2 || d.options.length > 4) return null;
  const options = d.options.map((o) => OPTION.test(o?.id ?? '') && text(o.label, 120) && text(o.consequence, 500) ? { id: o.id, label: o.label, consequence: o.consequence } : null);
  if (options.includes(null) || new Set(options.map((o) => o.id)).size !== options.length) return null;
  const suggestion = d.suggestion && options.some((o) => o.id === d.suggestion.option) && text(d.suggestion.reason, 500)
    ? { option: d.suggestion.option, reason: d.suggestion.reason } : null;
  return { question: d.question, options, ...(suggestion ? { suggestion } : {}),
    ...(text(d.continues, 500) ? { continues: d.continues } : {}), ...(text(d.unanswered, 500) ? { unanswered: d.unanswered } : {}),
    ...(d.reversible === true ? { reversible: true } : {}),
    ...(typeof d.safeOption === 'string' && options.some((o) => o.id === d.safeOption) ? { safeOption: d.safeOption } : {}) };
}

/** Whether a task's stop is an owner decision the dashboard may answer (the same rule as the "needs-decision" copy). */
export const isDecision = (task) => Boolean(task?.blocked) && task.state !== 'done' &&
  (task.blocked.class === 'B3' || /^verifier still rejects/.test(String(task.blocked.reason ?? '')));

/**
 * The identity of one decision: its campaign, task and the stop it belongs to. A later stop of the same task is a new
 * decision, so an answer to an earlier one can never clear it.
 */
export function decisionId(campaignId, taskId, blocked) {
  return createHash('sha256').update(JSON.stringify([campaignId, taskId, blocked?.class ?? null, blocked?.at ?? null, blocked?.fingerprint ?? null]), 'utf8')
    .digest('hex').slice(0, 32);
}

/**
 * AW-017: whether AIWorks answers a decision itself, with its suggestion: every owner-reserved stop (B3) whose decision
 * names a suggested option. The answer goes the same way as the owner's (answerDecision), so it never widens the packet.
 */
/**
 * The option AIWorks answers with on its own, or null. An owner-reserved decision may be about disclosing or publishing, so
 * the worker's suggestion is taken only when the worker marked it reversible (nothing published, disclosed or spent);
 * otherwise only the option the worker marked as the safe one (safeOption: publishes or discloses nothing new). Never a guess.
 */
export function autoOption(decision) {
  const ids = new Set((decision?.options ?? []).map((o) => o.id));
  if (decision?.reversible === true && decision.suggestion && ids.has(decision.suggestion.option)) return decision.suggestion.option;
  return decision?.safeOption && ids.has(decision.safeOption) ? decision.safeOption : null;
}

// A "verifier still rejects" stall at the repair limit is not answered: answering it would raise the repair limit, so the
// controller settles it instead (settleStopped: delivered with known defects, or ended as not done).
export const answersItself = (task) => isDecision(task) && task.blocked.class === 'B3' &&
  autoOption(task.blocked.decision) !== null;

/** AW-017: a worker's owner-reserved stop AIWorks cannot answer: no usable suggestion, or one neither marked reversible nor backed by a safeOption. It goes back to its step once, to decide within the packet. */
export const sendsBack = (task) => isDecision(task) && task.blocked.class === 'B3' && /^owner-reserved:/.test(String(task.blocked.reason ?? '')) && !answersItself(task);

/** The guidance for a step sent back to decide by itself (sendsBack). */
export function decideGuidance(blocked) {
  return ['AIWorks does not wait for the owner: this step stopped for a decision that AIWorks cannot answer (no options and suggestion, or a suggestion neither marked reversible nor backed by a safeOption), so it comes back to you once to decide within the packet. If you stop for a decision again, mark reversible honestly (true only when nothing is published, disclosed or spent) or name a safeOption, the option that publishes and discloses nothing new.',
    blocked?.decision?.question ? `Question: ${blocked.decision.question}` : null, blocked?.reason ? `The stop: ${String(blocked.reason).slice(0, 1000)}` : null,
    'Choose what keeps to the packet, its acceptance and its permissions, and publishes or discloses nothing new, record the choice and why in your report, and finish the work. If the outcome cannot be reached within the packet, return evidence-unavailable and say exactly what is missing: AIWorks then ends the step as not done and records a follow-up. Never widen the packet.']
    .filter(Boolean).join(' ');
}

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * The provenance line of a recorded owner answer: the decision it answers, the dashboard request the owner's checked
 * session made (the caller check admits only the owner's own browser) and the digest of the owner's words. Only the
 * supervisor writes it, from the owner's own event; nothing a worker or a GitHub comment says becomes one.
 */
export const ownerProvenance = ({ decision = null, requestId = null, text: words = null }) => [
  decision ? `decision ${String(decision).slice(0, 32)}` : null, requestId ? `owner request ${String(requestId).slice(0, 36)}` : null,
  words ? `owner's words sha256 ${sha256(words)}` : null].filter(Boolean).join(', ');

/** Durable decision context for the step's builders and verifiers, within its bound authority. */
export function answerGuidance(decision, { option = null, text: words = null, auto = false, decision: id = null, requestId = null }) {
  const chosen = option ? decision?.options?.find((o) => o.id === option) : null;
  const provenance = auto ? null : ownerProvenance({ decision: id, requestId, text: words });
  return [auto ? 'AIWorks answered the decision this step stopped for with the option that publishes or discloses nothing new, as the owner decided (AW-017). The owner can change the answer later.'
    : 'The owner answered the decision this step stopped for.',
    decision?.question ? `Question: ${decision.question}` : null,
    chosen ? `Chosen option: ${chosen.label} (${chosen.id}). Consequence: ${chosen.consequence}` : null, words ? `The owner's words: ${words}` : null,
    provenance ? `Recorded by the supervisor from the owner's dashboard (${provenance}).` : null,
    auto ? 'This is AIWorks\'s recorded answer with the suggested option, available to implementers and verifiers. Apply it within the packet and decide any further choice yourself within it; do not stop for the owner. If it conflicts with the approved acceptance or permissions, identify the exact amendment needed; it does not silently widen authority.'
      : 'This is a recorded owner answer, available to implementers and verifiers. Apply it within the packet; do not ask for the same decision again. Any point it leaves open is yours to decide within the packet (AW-017): record the choice in your report and do not stop for the owner. If it conflicts with the approved acceptance or permissions, identify the exact amendment needed; it does not silently widen authority.'].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------------------------------------------------
// Changing a recorded answer (docs/design/HOME_V2.md 2.1). The first answer and every change stay in the journal; the
// latest is in force. A change never clears or reopens a step, never touches a run, and keeps the campaign's authority.

/** The receipt key of a decision's answer instruction, and of a change to it. Only the supervisor and the owner route write these. */
export const answerKey = (campaignId, decision) => `instruction:decision:${campaignId}:${decision}`;
export const changeKey = (campaignId, decision, requestId) => `${answerKey(campaignId, decision)}:change:${requestId}`;

/**
 * The decision instructions in force among `rows` (agent-instruction events of one campaign, any order): for each
 * decision only its latest answer or change, so a changed answer reaches later runs and the one it replaced does not.
 */
export function inForce(rows, campaignId) {
  const prefix = `instruction:decision:${campaignId}:`, latest = new Map();
  for (const row of rows) {
    if (!row.dedup_key?.startsWith(prefix)) continue;
    const id = row.dedup_key.slice(prefix.length, prefix.length + 32);
    if (!latest.has(id) || latest.get(id).seq < row.seq) latest.set(id, row);
  }
  const keep = new Set([...latest.values()].map((row) => row.seq));
  return rows.filter((row) => !row.dedup_key?.startsWith(prefix) || keep.has(row.seq));
}

// A step in these states has used its answer: a checked head, a merged or finished result, or a step that ended.
const CONSUMED = new Set(['verified', 'done', 'cancelled', 'abandoned']);

/**
 * What a change of a recorded answer may do, decided from the store as it is now. `history` is the decision's journal
 * rows (`decision-answered`, then `decision-changed`), oldest first; `input` binds the answer the owner saw (`answer`,
 * its journal seq) and the new `option`; `ranSince` says whether a worker run of the step started at or after the
 * decision's first answer, or is still open.
 * - refused: `unanswered`, `stale` (the answer in force is not the one the owner saw, or the step is gone),
 *   `not-recorded` (the decision's options were not kept), `not-option`, `same` (nothing would change);
 * - `follow-up`: the step already used the answer (checked, merged, finished or ended). Nothing of it is rewritten or
 *   reopened; one follow-up item records the new answer for new, bounded work, and the step follows the new answer
 *   only if it is ever reopened;
 * - `superseded`: the step's later runs follow the new answer. `followUp` is true whenever a run worked under an
 *   earlier answer: its work is kept, never replayed or undone, and a follow-up item makes sure it is checked against
 *   the new answer, because the step's only later run may be a check that passes it.
 */
export function answerChange({ task, history, input, ranSince = false }) {
  const current = history?.at(-1);
  if (!current) return { refused: 'unanswered' };
  if (!task || current.seq !== input?.answer || current.detail?.task !== task.task_id) return { refused: 'stale' };
  const recorded = recordedDecision(current.detail);
  if (!recorded) return { refused: 'not-recorded' };
  if (!recorded.options.some((o) => o.id === input.option)) return { refused: 'not-option' };
  if (input.option === current.detail.option && !input.text) return { refused: 'same' };
  if (CONSUMED.has(task.state)) return { outcome: 'follow-up', decision: recorded, current };
  return { outcome: 'superseded', followUp: ranSince === true, decision: recorded, current };
}

/** The validated question and options a journaled answer or change kept, or null. */
export function recordedDecision(detail) {
  return detail ? structuredDecision({ decision: { question: detail.question, options: detail.options, suggestion: detail.suggestion } }) : null;
}

/** The guidance that replaces an earlier answer for the step's later builders and verifiers, within its bound authority. */
export function changeGuidance(decision, { from = null, option, text: words = null, decision: id = null, requestId = null }) {
  const label = (key) => decision?.options?.find((o) => o.id === key);
  const before = label(from), chosen = label(option);
  return ['The owner changed the answer to a decision this step stopped for. This answer replaces the earlier one; follow it from now on.',
    decision?.question ? `Question: ${decision.question}` : null,
    before ? `Earlier answer: ${before.label} (${before.id}).` : null,
    chosen ? `New answer: ${chosen.label} (${chosen.id}). Consequence: ${chosen.consequence}` : null, words ? `The owner's words: ${words}` : null,
    `Recorded by the supervisor from the owner's dashboard (${ownerProvenance({ decision: id, requestId, text: words })}).`,
    'Keep committed work and history: build on them, never rewrite, reset or force-push them, and never repeat or undo an action that published, disclosed, deployed or spent something. Any point the answer leaves open is yours to decide within the packet. If following the new answer needs more than the packet allows, identify the exact amendment needed; it does not widen authority.']
    .filter(Boolean).join(' ');
}
