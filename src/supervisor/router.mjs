// AIWorks routing receipt (docs/design/MODEL_ROUTING.md section 9, slice R2). Static mode only: route() reproduces
// today's executorChoice exactly (declared order, one model per provider, a failed provider moved behind the others)
// and the controller stores the receipt with each new operation. It changes no dispatch decision.
//
// route(inputs) is a pure function of its one argument: no clock, store, host check or other input. The controller
// collects the facts (receiptInputs) once, at choice time, so replaying a stored receipt gives the same decision.
// Static mode keeps today's order of checks: the host and project check (unavailableReason) still runs after the choice,
// inside dispatch, so each host fact's hostUnavailable is null here and the static policy does not read it.
import { createHash } from 'node:crypto';
import { BROWSER_KINDS, roleUnavailableReason } from './adapters/executors.mjs';
import { canonicalJson } from './campaign.mjs';

export const RECEIPT_VERSION = 1;
export const STATIC_POLICY = 'routing-policy/static-1';
export const ROLES = ['implementer', 'verification'];
// Provider availability is governed by its wait: once that wait ends the provider resumes. Only a task-level failure
// moves the provider behind the others (controller.mjs lastFailedExecutor before slice R2).
const AVAILABILITY = new Set(['admission-blocked', 'quota', 'auth', 'spawn-failed', 'unavailable']);
// Never route around a denial: the next attempt keeps the declared provider order.
const DENIAL = /denied|permission|no provider fallback|unexpected tool|sandbox violation/i;

const sha256 = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

/** One escalation.priorAttempts entry from a finished operation row; an operation from before slice R2 has model null. */
export function priorAttempt(op) {
  const outcome = op.outcome ?? null;
  return {
    op: op.id, kind: op.executor_kind, model: op.routing?.decision?.chosen?.model ?? null,
    class: outcome?.class ?? null, terminal: outcome?.value?.result ?? outcome?.value?.verdict ?? null,
    denied: DENIAL.test(outcome?.detail ?? ''), tier: op.routing?.decision?.chosen?.tier ?? null,
  };
}

/**
 * The complete argument of route(). `providers` is the declared order (executorOrder), `facts(kind)` the host facts of one
 * provider kind observed now, `priorAttempts` the task's finished attempts of this stage, newest first.
 */
export function receiptInputs({ stage, chain, spec, providers, platform, facts, priorAttempts }) {
  const candidates = providers.map((provider) => ({ kind: provider.kind, model: provider.model ?? null, tier: null,
    researchOnly: provider.researchOnly === true }));
  return {
    stage, chain,
    task: { deliverable: spec.deliverable, web: Boolean(spec.web) },
    candidates, candidatesDigest: sha256(candidates), platform,
    hostFacts: candidates.map(({ kind }) => ({ kind, ...facts(kind) })),
    escalation: { priorAttempts },
  };
}

/** Every failing filter of one candidate for one role (section 4.2), not only the first. */
function reasons(candidate, fact, role, { deliverable, web }, platform) {
  const out = [];
  if (candidate.researchOnly && deliverable !== 'report') out.push('research-only');
  if (web ? !BROWSER_KINDS.includes(candidate.kind) : candidate.kind === 'agy-cli') out.push('web-mismatch');
  if (!fact.cliConfigured) out.push('cli-not-configured');
  if (roleUnavailableReason({ kind: candidate.kind, researchOnly: candidate.researchOnly }, role, deliverable, platform, web)) out.push('role-unsupported');
  if (fact.hostUnavailable) out.push('host-unavailable');
  if (fact.wait) out.push('account-wait');
  return out;
}

/** The static decision for `inputs`, exactly as executorChoice chose before slice R2. */
export function route(inputs) {
  const { stage, chain, task, candidates, platform, hostFacts, escalation } = inputs;
  const role = stage === 'verify' ? 'verification' : 'implementer';
  const fact = (kind) => hostFacts.find((item) => item.kind === kind);
  const eligibility = candidates.flatMap((candidate) => ROLES.map((r) => ({ kind: candidate.kind, model: candidate.model, role: r,
    reasons: reasons(candidate, fact(candidate.kind), r, task, platform) })));
  const last = chain ? escalation.priorAttempts[0] ?? null : null;
  const failed = last && last.class !== null && !AVAILABILITY.has(last.class) && !last.denied &&
    (last.class !== 'result' || last.terminal === 'evidence-unavailable');
  const avoid = failed ? last.kind : null;
  let retryAt = null;
  let fallback = null;
  const earliest = (at) => { retryAt = retryAt === null ? at : Math.min(retryAt, at); };
  const pick = (candidate, basis, reason) => ({ eligibility, chosen: { kind: candidate.kind, model: candidate.model, tier: candidate.tier },
    basis, reason, avoided: avoid, retryAt: null });
  // The walk keeps today's order of checks: an unconfigured CLI bounds the retry even when its role is unsupported.
  for (const candidate of candidates) {
    const own = fact(candidate.kind);
    if (candidate.researchOnly && task.deliverable !== 'report') continue;
    if (task.web ? !BROWSER_KINDS.includes(candidate.kind) : candidate.kind === 'agy-cli') continue;
    if (!own.cliConfigured) { earliest(own.cliRecheckAt); continue; }
    if (roleUnavailableReason({ kind: candidate.kind, researchOnly: candidate.researchOnly }, role, task.deliverable, platform, task.web)) continue;
    if (own.wait) { if (own.wait.retryAt !== null) earliest(own.wait.retryAt); continue; }
    if (candidate.kind === avoid) { fallback ??= candidate; continue; }
    return pick(candidate, avoid ? 'failed-provider-last' : 'declared-order',
      avoid ? `${avoid} failed the last attempt; next eligible provider in the declared order` : 'first eligible provider in the declared order');
  }
  if (fallback) return pick(fallback, 'failed-provider-only', `${avoid} failed the last attempt but is the only eligible provider`);
  return { eligibility, chosen: null, basis: 'none-eligible', reason: retryAt === null ? 'no provider supports this role' : 'every eligible provider waits',
    avoided: avoid, retryAt };
}

/** The immutable receipt stored with the operation (operations.routing). */
export function staticReceipt(inputs) {
  return { version: RECEIPT_VERSION, policy: STATIC_POLICY, mode: 'static', inputs, decision: route(inputs), inputsDigest: sha256(inputs) };
}
