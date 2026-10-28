// Structured owner decisions (docs/design/OWNER_UI_V2.md WP2) over the existing task blockers. A decision is a task's
// `blocked` record that needs the owner: a B3 stop, or a checker that still rejects after the repair rounds. Its options,
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
    ...(text(d.continues, 500) ? { continues: d.continues } : {}), ...(text(d.unanswered, 500) ? { unanswered: d.unanswered } : {}) };
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

/** Durable decision context for the step's builders and verifiers, within its bound authority. */
export function answerGuidance(decision, { option = null, text: words = null }) {
  const chosen = option ? decision?.options?.find((o) => o.id === option) : null;
  return ['The owner answered the decision this step stopped for.',
    decision?.question ? `Question: ${decision.question}` : null,
    chosen ? `Chosen option: ${chosen.label} (${chosen.id}). Consequence: ${chosen.consequence}` : null, words ? `The owner's words: ${words}` : null,
    'This is a recorded owner answer, available to implementers and verifiers. Apply it within the packet; do not ask for the same decision again. If it conflicts with the approved acceptance or permissions, identify the exact amendment needed; it does not silently widen authority.'].filter(Boolean).join(' ');
}
