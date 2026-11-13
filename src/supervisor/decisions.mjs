// Structured decisions (docs/design/OWNER_UI_V2.md WP2) over the existing task blockers. A decision is a task's `blocked`
// record a worker stopped for: a B3 stop, or a checker that still rejects after the repair rounds. AIWorks answers it
// (AW-017, controller.answerSuggested); the owner may still answer it first from the dashboard. Its options,
// suggestion, what continues and what happens unanswered come only from the validated `decision` field of a worker result
// (adapters/claude.mjs DECISION_SCHEMA); a stop without one stays a free-text decision, answered in the owner's own words.
// An answer is delivered as owner guidance under the unchanged packet and authority, so it can never widen the work.
import { createHash } from 'node:crypto';

const OPTION = /^[a-z][a-z0-9-]{0,31}$/;
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max ? value : null;

/** Two to four validated, unique options, or null. */
function optionsOf(list) {
  if (!Array.isArray(list) || list.length < 2 || list.length > 4) return null;
  const options = list.map((o) => OPTION.test(o?.id ?? '') && text(o.label, 120) && text(o.consequence, 500) ? { id: o.id, label: o.label, consequence: o.consequence } : null);
  return options.includes(null) || new Set(options.map((o) => o.id)).size !== options.length ? null : options;
}
const suggestionOf = (s, options) => s && options.some((o) => o.id === s.option) && text(s.reason, 500) ? { option: s.option, reason: s.reason } : null;

/**
 * The validated sub-questions of a decision (aiworks-work #2), or null: one to six parts, each with its own id, question,
 * options, optional suggestion and safeOption. The owner may answer some parts and leave the rest open.
 */
function partsOf(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PARTS) return null;
  const parts = list.map((p) => {
    const options = OPTION.test(p?.id ?? '') && text(p.question, 500) ? optionsOf(p.options) : null;
    if (!options) return null;
    const suggestion = suggestionOf(p.suggestion, options);
    return { id: p.id, question: p.question, options, ...(suggestion ? { suggestion } : {}),
      ...(typeof p.safeOption === 'string' && options.some((o) => o.id === p.safeOption) ? { safeOption: p.safeOption } : {}) };
  });
  return parts.includes(null) || new Set(parts.map((p) => p.id)).size !== parts.length ? null : parts;
}
export const MAX_PARTS = 6;

/**
 * The validated decision fields of a worker result, or null. A decision has either whole options (two to four, unique,
 * a suggestion must name one) or parts, its sub-questions; never both. A decision with parts has `options: []`.
 */
export function structuredDecision(value) {
  const d = value?.decision;
  if (!d || typeof d !== 'object' || Array.isArray(d) || !text(d.question, 500)) return null;
  const parts = d.parts === undefined ? null : partsOf(d.parts);
  const options = parts ? [] : optionsOf(d.options);
  if (d.parts !== undefined && (!parts || d.options !== undefined && (!Array.isArray(d.options) || d.options.length))) return null;
  if (!parts && !options) return null;
  const suggestion = parts ? null : suggestionOf(d.suggestion, options);
  return { question: d.question, options, ...(parts ? { parts } : {}), ...(suggestion ? { suggestion } : {}),
    ...(text(d.continues, 500) ? { continues: d.continues } : {}), ...(text(d.unanswered, 500) ? { unanswered: d.unanswered } : {}),
    ...(d.reversible === true ? { reversible: true } : {}),
    ...(!parts && typeof d.safeOption === 'string' && options.some((o) => o.id === d.safeOption) ? { safeOption: d.safeOption } : {}) };
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
  if (decision?.parts) return null;
  const ids = new Set((decision?.options ?? []).map((o) => o.id));
  if (decision?.reversible === true && decision.suggestion && ids.has(decision.suggestion.option)) return decision.suggestion.option;
  return decision?.safeOption && ids.has(decision.safeOption) ? decision.safeOption : null;
}

// A "verifier still rejects" stall at the repair limit is not answered: answering it would raise the repair limit, so the
// controller settles it instead (settleStopped: delivered with known defects, or ended as not done).
export const answersItself = (task) => isDecision(task) && task.blocked.class === 'B3' &&
  (autoOption(task.blocked.decision) !== null || Object.keys(autoParts(structuredDecision({ decision: task.blocked.decision }))).length > 0);

/**
 * The parts AIWorks answers on its own, by the same rule as autoOption: a part's suggestion when the worker marked the
 * decision reversible, otherwise the part's safeOption. A part with neither stays open for the worker to decide.
 */
export function autoParts(decision) {
  const out = {};
  for (const part of decision?.parts ?? []) {
    const option = decision.reversible === true && part.suggestion ? part.suggestion.option : part.safeOption ?? null;
    if (option) out[part.id] = { option, by: 'aiworks' };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Answered points stay answered (aiworks-work #2). Every recorded answer and change keeps the decision it answered, so a
// later stop of the same step that asks an answered point again is answered from the record instead of reaching the
// owner again. Points are matched by their question and option wording, never by a worker's ids alone.

const plain = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The answers in force of one journaled answer or change: { partId, or '' for a whole decision: { option, by, from } }. */
export function answersOf(detail) {
  if (detail?.answers && typeof detail.answers === 'object') return detail.answers;
  return detail?.option ? { '': { option: detail.option, by: detail.auto ? 'aiworks' : 'owner', from: detail.decision ?? null } } : {};
}

/**
 * Every point a step's earlier decisions settled, from its journal rows (`decision-answered`, `decision-changed`, any
 * order): plain question wording -> { question, label, by, from }. A later record of the same decision replaces an earlier one.
 */
export function settledPoints(rows) {
  const latest = new Map();
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) if (row.detail?.decision) latest.set(row.detail.decision, row.detail);
  const out = new Map();
  for (const detail of latest.values()) {
    const d = recordedDecision(detail);
    if (!d) continue;
    for (const [part, answer] of Object.entries(answersOf(detail))) {
      const point = part ? d.parts?.find((p) => p.id === part) : d.parts ? null : d;
      const chosen = point?.options.find((o) => o.id === answer.option);
      if (chosen) out.set(plain(point.question), { question: point.question, label: chosen.label, by: answer.by, from: answer.from ?? detail.decision });
    }
  }
  return out;
}

/**
 * The answers a new decision inherits from points its step already settled: for a whole decision `{ '': answer }`, for a
 * decision with parts one entry per part asked again. An option is matched by its wording; a point whose options no
 * longer hold the settled answer is not inherited and stays to be answered.
 */
export function carriedAnswers(decision, settled) {
  const out = {};
  for (const point of decision?.parts ?? (decision ? [{ ...decision, id: '' }] : [])) {
    const was = settled.get(plain(point.question));
    const option = was && point.options.find((o) => plain(o.label) === plain(was.label));
    if (option) out[point.id] = { option: option.id, by: was.by, from: was.from, carried: true };
  }
  return out;
}

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

/**
 * The guidance of a decision answered point by point: each point with who answered it (the owner, AIWorks, or an earlier
 * answer asked again), or as still open. An open point is the worker's to decide within the packet; an answered one is
 * settled and never asked again. The owner's own answers carry the supervisor's provenance line.
 */
export function pointsGuidance(decision, answers, { words = null, decision: id = null, requestId = null, lead }) {
  const points = decision?.parts ?? (decision ? [{ ...decision, id: '' }] : []);
  const owner = Object.values(answers).some((a) => a.by === 'owner' && !a.carried);
  const lines = points.map((point) => {
    const answer = answers[point.id], chosen = answer && point.options.find((o) => o.id === answer.option);
    const name = point.id ? `Part ${point.id}: ${point.question}` : `Question: ${point.question}`;
    if (!chosen) return `${name} Still open: decide it yourself within the packet and record the choice and why in your report; do not stop for the owner about it.`;
    const who = answer.carried ? (answer.by === 'owner' ? 'already answered by the owner' : 'already answered by AIWorks')
      : answer.by === 'owner' ? 'the owner\'s answer' : 'AIWorks\'s answer';
    return `${name} Settled, ${who}: ${chosen.label} (${chosen.id}). Consequence: ${chosen.consequence}`;
  });
  return [lead, decision?.parts ? `Question: ${decision.question}` : null, ...lines, words ? `The owner's words: ${words}` : null,
    owner ? `Recorded by the supervisor from the owner's dashboard (${ownerProvenance({ decision: id, requestId, text: words })}).` : null,
    Object.values(answers).some((a) => a.carried && a.by === 'owner')
      ? `An answer marked as already answered by the owner was recorded by the supervisor from the owner's dashboard for an earlier stop of this step (${[...new Set(Object.values(answers).filter((a) => a.carried && a.by === 'owner').map((a) => `decision ${String(a.from ?? '').slice(0, 32)}`))].join(', ')}); it is the owner's answer.` : null,
    'Settled points are final for this step: apply them within the packet and never ask about them again. If you must stop again, ask only about a point that is still open or new, and say which part of an answer you could not use and why. If an answer conflicts with the approved acceptance or permissions, identify the exact amendment needed; it does not silently widen authority.']
    .filter(Boolean).join(' ');
}

/** Durable decision context for the step's builders and verifiers, within its bound authority. */
export function answerGuidance(decision, { option = null, text: words = null, auto = false, decision: id = null, requestId = null, answers = null }) {
  if (decision?.parts || answers) {
    const all = Object.values(answers ?? {});
    return pointsGuidance(decision, answers ?? {}, { words, decision: id, requestId,
      lead: all.length && all.every((a) => a.carried) ? 'This step asked again about points that were already answered. Their recorded answers apply; nothing new was asked of the owner.'
        : all.some((a) => a.by === 'owner' && !a.carried) ? 'The owner answered the decision this step stopped for, point by point; a point the owner left open is still open.'
          : 'AIWorks answered the points of this decision it may answer itself, with the options that publish or disclose nothing new or the worker\'s reversible suggestions (AW-017). The owner can change any answer later.' });
  }
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
  if (recorded.parts) {
    // Parts are answered one by one: the change names only the parts it answers; the others keep the answer in force.
    const given = input.parts && typeof input.parts === 'object' && !Array.isArray(input.parts) ? Object.entries(input.parts) : [];
    if (!given.length || input.option != null) return { refused: 'not-option' };
    if (given.some(([part, option]) => !recorded.parts.find((p) => p.id === part)?.options.some((o) => o.id === option))) return { refused: 'not-option' };
    const before = answersOf(current.detail);
    if (given.every(([part, option]) => before[part]?.option === option && before[part]?.by === 'owner' && !before[part]?.carried) && !input.text) return { refused: 'same' };
  } else {
    if (input.parts !== undefined || !recorded.options.some((o) => o.id === input.option)) return { refused: 'not-option' };
    if (input.option === current.detail.option && !input.text) return { refused: 'same' };
  }
  if (CONSUMED.has(task.state)) return { outcome: 'follow-up', decision: recorded, current };
  return { outcome: 'superseded', followUp: ranSince === true, decision: recorded, current };
}

/** The validated question and options a journaled answer or change kept, or null. */
export function recordedDecision(detail) {
  return detail?.question ? structuredDecision({ decision: { question: detail.question, ...(detail.parts ? { parts: detail.parts } : { options: detail.options }),
    ...(detail.suggestion ? { suggestion: detail.suggestion } : {}) } }) : null;
}

/** The guidance that replaces an earlier answer for the step's later builders and verifiers, within its bound authority. */
export function changeGuidance(decision, { from = null, option, text: words = null, decision: id = null, requestId = null, answers = null }) {
  if (decision?.parts) return pointsGuidance(decision, answers ?? {}, { words, decision: id, requestId,
    lead: 'The owner changed or added answers to parts of a decision this step stopped for. These answers replace the earlier ones; follow them from now on. Keep committed work and history: build on them, never rewrite, reset or force-push them, and never repeat or undo an action that published, disclosed, deployed or spent something.' });
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
