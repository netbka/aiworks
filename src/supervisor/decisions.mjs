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
    ...(d.reversible === true ? { reversible: true } : {}) };
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
// A "verifier still rejects" stall at the repair limit is not answered: answering it would raise the repair limit, so the
// controller settles it instead (settleStopped: delivered with known defects, or ended as not done).
export const answersItself = (task) => isDecision(task) && task.blocked.class === 'B3' &&
  Boolean(task.blocked.decision?.suggestion && task.blocked.decision.options?.some((o) => o.id === task.blocked.decision.suggestion.option));

/** AW-017: a worker's owner-reserved stop without a usable suggestion. It goes back to its step once, to decide within the packet. */
export const sendsBack = (task) => isDecision(task) && task.blocked.class === 'B3' && /^owner-reserved:/.test(String(task.blocked.reason ?? '')) && !answersItself(task);

/** The guidance for a step sent back to decide by itself (sendsBack). */
export function decideGuidance(blocked) {
  return ['AIWorks does not wait for the owner: this step stopped for a decision without options and a suggestion, so it comes back to you once to decide within the packet.',
    blocked?.decision?.question ? `Question: ${blocked.decision.question}` : null, blocked?.reason ? `The stop: ${String(blocked.reason).slice(0, 1000)}` : null,
    'Choose what keeps to the packet, its acceptance and its permissions, record the choice and why in your report, and finish the work. If the outcome cannot be reached within the packet, return evidence-unavailable and say exactly what is missing: AIWorks then ends the step as not done and records a follow-up. Never widen the packet.']
    .filter(Boolean).join(' ');
}

/** Durable decision context for the step's builders and verifiers, within its bound authority. */
export function answerGuidance(decision, { option = null, text: words = null, auto = false }) {
  const chosen = option ? decision?.options?.find((o) => o.id === option) : null;
  return [auto ? 'AIWorks answered the decision this step stopped for with the suggested option, as the owner decided (AW-017).'
    : 'The owner answered the decision this step stopped for.',
    decision?.question ? `Question: ${decision.question}` : null,
    chosen ? `Chosen option: ${chosen.label} (${chosen.id}). Consequence: ${chosen.consequence}` : null, words ? `The owner's words: ${words}` : null,
    auto ? 'This is AIWorks\'s recorded answer with the suggested option, available to implementers and verifiers. Apply it within the packet and decide any further choice yourself within it; do not stop for the owner. If it conflicts with the approved acceptance or permissions, identify the exact amendment needed; it does not silently widen authority.'
      : 'This is a recorded owner answer, available to implementers and verifiers. Apply it within the packet; do not ask for the same decision again. If it conflicts with the approved acceptance or permissions, identify the exact amendment needed; it does not silently widen authority.'].filter(Boolean).join(' ');
}
