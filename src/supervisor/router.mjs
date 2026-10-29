// AIWorks routing receipt (docs/design/MODEL_ROUTING.md section 9, slice R2). Static mode at dispatch: route() reproduces
// today's executorChoice exactly (declared order, one model per provider, a failed provider moved behind the others)
// and the controller stores the receipt with each new operation. It changes no dispatch decision.
//
// route(inputs) is a pure function of its one argument: no clock, store, host check or other input. The controller
// collects the facts (receiptInputs) once, at choice time, so replaying a stored receipt gives the same decision.
// Static mode keeps today's order of checks: the host and project check (unavailableReason) still runs after the choice,
// inside dispatch, so each host fact's hostUnavailable is null here and the static policy does not read it.
import { createHash } from 'node:crypto';
import { BROWSER_KINDS, roleUnavailableReason, webFlag } from './adapters/executors.mjs';
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
    task: { deliverable: spec.deliverable, web: webFlag(spec.web) },
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

// routing-policy/1 (docs/design/MODEL_ROUTING.md sections 3 to 6 and 9, slice R4): indicators, filters, floors, ranking,
// escalation, pin and verifier independence, as a pure function of the receipt's inputs. The controller dispatches with it
// for a campaign whose routing.mode is "auto" (slice R5); every other campaign keeps the static receipt above.

export const POLICY = 'routing-policy/1';
export const REASON_CODES = ['research-only', 'web-mismatch', 'cli-not-configured', 'role-unsupported', 'host-unavailable',
  'account-wait', 'below-floor', 'pin-excluded'];
// Policy constants of routing-policy/1 (section 5.2), to be replaced by the measured baseline before any cohort.
const PRIOR = { 1: 0.6, 2: 0.75, 3: 0.85 };
const PRIOR_WEIGHT = 4;
const MIN_ATTEMPTS = 5;
const MAX_EXPECTED_ATTEMPTS = 2;
const HIGH_RISK_ROLES = ['security-reviewer', 'database-engineer', 'infrastructure-sre', 'release-agent'];
// Poor-quality outcomes (section 5.4). Denials, limits, logins, launches and host failures are never quality signals.
const UNUSABLE = new Set(['invalid-result', 'exit-without-result', 'timeout']);
const asDir = (path) => (path.endsWith('/') ? path : `${path}/`).toLowerCase();
const same = (a, b) => a.kind === b.kind && a.model === b.model;
const named = ({ kind, model, tier }) => ({ kind, model, tier });

/** The step's risk and complexity (sections 3.2 and 3.3), from the declaration only. A declared value can only raise them. */
export function indicators({ task, sensitivePaths = [] }) {
  const paths = (task.writes ?? []).filter((entry) => !entry.startsWith('resource:'));
  const sensitive = paths.some((write) => sensitivePaths.some((prefix) => asDir(write).startsWith(asDir(prefix)) || asDir(prefix).startsWith(asDir(write))));
  const risk = HIGH_RISK_ROLES.includes(task.role) || sensitive || task.declared?.risk === 'high' ? 'R2'
    : task.deliverable === 'commit' && !task.writes?.length || task.web ? 'R1' : 'R0';
  const points = (task.deliverable === 'commit' ? 1 : 0) + (task.references > 5 ? 1 : 0) + (task.references > 12 ? 1 : 0) +
    (task.acceptance > 4 ? 1 : 0) + (task.dependsOn >= 2 ? 1 : 0) + (task.requiresMergedDependencies ? 1 : 0);
  const complexity = task.declared?.complexity === 'high' || points >= 4 ? 'C3' : points >= 2 ? 'C2' : 'C1';
  return { risk, complexity, points };
}

/** The lowest tier a step may start on before escalation (section 5.1). */
function baseFloor(stage, { risk, complexity }) {
  if (stage === 'verify') return risk === 'R2' || complexity === 'C3' ? 3 : 2;
  return risk === 'R2' || complexity === 'C3' ? 3 : risk === 'R1' || complexity === 'C2' ? 2 : 1;
}

/** Whether a finished attempt of `stage` is poor-quality evidence (section 5.4). A denial never is. */
function poorQuality(stage, attempt) {
  if (attempt.denied) return false;
  if (UNUSABLE.has(attempt.class)) return true;
  // An implement attempt whose head the verifier rejected carries terminal "rejected". For a verifier a rejection is a useful review.
  return stage === 'implement' && attempt.class === 'result' && ['rejected', 'evidence-unavailable'].includes(attempt.terminal);
}

/**
 * The escalated tier of this task and stage, derived from its finished attempts alone (section 5.4), sticky and never
 * down: two poor results on a tier move up one declared tier (one for an R2 implement step); a verifier moves up after
 * two unusable reviews in a row. A pin turns escalation off. `failed` is the newest attempt when it was poor (sidestep).
 */
function escalationState(stage, priorAttempts, risk, start, tiers, pin) {
  const disabled = pin ? ('tier' in pin ? 'tier-pin' : 'model-pin') : null;
  const threshold = stage === 'implement' && risk === 'R2' ? 1 : 2;
  const counts = new Map();
  let tier = start;
  for (const attempt of [...priorAttempts].reverse()) {
    if (stage === 'verify' && attempt.class === 'result' && ['accepted', 'rejected'].includes(attempt.terminal)) { counts.clear(); continue; }
    if (!poorQuality(stage, attempt)) continue;
    const on = attempt.tier ?? tier;
    counts.set(on, (counts.get(on) ?? 0) + 1);
    if (!disabled && counts.get(on) >= threshold) tier = Math.max(tier, tiers.find((t) => t > on) ?? on);
  }
  const newest = priorAttempts[0] ?? null;
  return { tier: disabled ? start : tier, qualityFailuresOnTier: counts.get(tier) ?? 0, escalated: !disabled && tier > start, disabled,
    failed: newest && poorQuality(stage, newest) ? { kind: newest.kind, model: newest.model } : null };
}

/** Whether a pin admits a candidate for its role (section 6): one declared candidate, or every candidate of one tier. */
const pinAdmits = (pin, candidate) => !pin || ('tier' in pin ? candidate.tier === pin.tier : same(pin, candidate));

/** Smoothed acceptance, mean cost per attempt and run time of one candidate in one class, from aggregated history (5.2). */
function stats(history, candidate, cls) {
  const row = history.find((item) => same(item, candidate) && item.class === cls) ?? null;
  const attempts = row?.attempts ?? 0;
  const rate = ((row?.accepted ?? 0) + PRIOR_WEIGHT * PRIOR[candidate.tier]) / (attempts + PRIOR_WEIGHT);
  const known = typeof row?.cost?.mean === 'number' && row.cost.known > 0;
  return { attempts, rate, u: { unit: row?.cost?.unit ?? null, mean: known ? row.cost.mean : null }, medianMs: row?.medianMs ?? null };
}

/** Expected cost of an accepted result: null (unknown, never zero) when a cost is unknown or the units differ. */
function expected(u, rate, verifier) {
  if (u.mean === null) return null;
  if (verifier === undefined) return { unit: u.unit, value: u.mean / rate };
  if (verifier === null || verifier.mean === null || verifier.unit !== u.unit) return null;
  return { unit: u.unit, value: (u.mean + verifier.mean) / rate };
}

/**
 * One choice among the eligible `pool` (section 5.3), for the step itself or for the verifier projection. `projection(m)`
 * gives an implement candidate's projected verifier; `avoid` is the newest poor-quality attempt (the sidestep).
 */
function rank(pool, { history, cls, projection = null, avoid = null }) {
  const rows = pool.map((candidate, index) => {
    const own = stats(history, candidate, cls);
    const projected = projection ? projection(candidate) : undefined;
    return { candidate, index, ...own, projected, cost: expected(own.u, own.rate, projected === undefined ? undefined : projected?.u ?? null) };
  });
  const comparable = rows.every((row) => row.attempts >= MIN_ATTEMPTS && row.cost !== null &&
      (row.projected === undefined || row.projected.attempts >= MIN_ATTEMPTS)) && new Set(rows.map((row) => row.cost.unit)).size === 1;
  // Lowest E where the costs compare, then (tier walk) fewest expected attempts, then shorter median run time, then declared order.
  const order = (list, { cost, attempts }) => [...list].sort((a, b) => (cost ? a.cost.value - b.cost.value : 0) ||
    (attempts ? b.rate - a.rate : 0) || (a.medianMs ?? Infinity) - (b.medianMs ?? Infinity) || a.index - b.index);
  const qualifies = (row) => 1 / row.rate <= MAX_EXPECTED_ATTEMPTS;
  let ordered;
  let basis;
  let reason;
  if (comparable) {
    ordered = order(rows, { cost: true, attempts: false });
    basis = 'comparable-cost';
    reason = `lowest expected ${ordered[0].cost.unit} per accepted result; every candidate has ${MIN_ATTEMPTS} or more attempts with known cost`;
  } else if (rows.every((row) => row.attempts === 0)) {
    const low = Math.min(...rows.map((row) => row.candidate.tier));
    ordered = rows.filter((row) => row.candidate.tier === low);
    basis = 'cold-start';
    reason = `no history for ${cls}: the lowest eligible tier, in declared order`;
  } else {
    const tiers = [...new Set(rows.map((row) => row.candidate.tier))].sort((a, b) => a - b);
    const found = tiers.find((t) => rows.some((row) => row.candidate.tier === t && qualifies(row)));
    const group = rows.filter((row) => row.candidate.tier === (found ?? tiers.at(-1)));
    ordered = order(group, { cost: group.every((row) => row.cost !== null) && new Set(group.map((row) => row.cost.unit)).size === 1, attempts: true });
    basis = 'tier-walk';
    reason = found === undefined ? `no tier has at most ${MAX_EXPECTED_ATTEMPTS} expected attempts: the top tier`
      : `lowest tier with at most ${MAX_EXPECTED_ATTEMPTS} expected attempts`;
    if (group.some((row) => row.cost === null)) reason += '; expected cost unknown for some candidates';
  }
  let top = ordered[0];
  const failed = (candidate) => avoid && candidate.kind === avoid.kind && (avoid.model === null || candidate.model === avoid.model);
  if (failed(top.candidate)) {
    const other = rows.filter((row) => row.candidate.tier === top.candidate.tier && !failed(row.candidate));
    const next = order(other, { cost: comparable, attempts: !comparable })[0];
    if (next) {
      top = next;
      basis = 'sidestep';
      reason = `${avoid.kind} failed the last attempt: another candidate on tier ${top.candidate.tier}`;
    }
  }
  return { top, rows, basis, reason };
}

/**
 * Catalog independence (section 4.3 rule 5), report-only. The verifier's catalog role is security-reviewer for an R2 step
 * with the security role, otherwise verification-agent. `catalog.independentFrom` maps those two role ids to their lists.
 */
function catalogIndependence(risk, taskRole, catalog) {
  if (!taskRole) return null;
  const lists = catalog?.independentFrom ?? {};
  const role = risk === 'R2' && taskRole === 'security-reviewer' ? 'security-reviewer' : 'verification-agent';
  return { role, value: (lists[role] ?? []).includes(taskRole) ? 'declared' : 'not-declared' };
}

/**
 * routing-policy/1: the decision for `inputs`, the receipt's inputs (section 9). A pure function of its one argument: no
 * clock, store, host check or other input, so replaying a receipt gives the same decision.
 */
export function routeAuto(inputs) {
  const { stage, task, candidates, platform, hostFacts, history = [], pin = null, catalog = null } = inputs;
  const priorAttempts = inputs.escalation?.priorAttempts ?? [];
  const role = stage === 'verify' ? 'verification' : 'implementer';
  // Verifier rule 1 (section 4.3): the verifier's session is new. A receipt that says otherwise gets no decision.
  if (stage === 'verify' && (typeof inputs.session !== 'string' || (inputs.implementerSessions ?? []).includes(inputs.session))) {
    throw new Error('a verify step needs a fresh session that differs from every implementer session');
  }
  const ind = indicators(inputs);
  const tiers = [...new Set(candidates.map((candidate) => candidate.tier))].sort((a, b) => a - b);
  const pins = { implementer: pin?.implementer ?? null, verification: pin?.verifier ?? null };
  const esc = escalationState(stage, priorAttempts, ind.risk, baseFloor(stage, ind), tiers, pins[role]);
  // Floors per role; the current stage's floor includes its escalation. A pinned role has no floor (section 6).
  const floors = {};
  for (const [r, s] of [['implementer', 'implement'], ['verification', 'verify']]) {
    if (pins[r]) { floors[r] = { value: null, capped: false }; continue; }
    const wanted = s === stage ? Math.max(baseFloor(s, ind), esc.tier) : baseFloor(s, ind);
    const capped = !candidates.some((candidate) => candidate.tier >= wanted);
    floors[r] = { value: capped ? tiers.at(-1) : wanted, capped };
  }
  // A host fact naming a model belongs to that candidate only (an unknown model waits alone, slice R5); else the kind's fact.
  const fact = (candidate) => hostFacts.find((item) => item.kind === candidate.kind && item.model === candidate.model) ??
    hostFacts.find((item) => item.kind === candidate.kind && item.model === undefined);
  const eligibility = candidates.flatMap((candidate) => ROLES.map((r) => {
    const out = reasons(candidate, fact(candidate), r, task, platform);
    if (floors[r].value !== null && candidate.tier < floors[r].value) out.push('below-floor');
    if (!pinAdmits(pins[r], candidate)) out.push('pin-excluded');
    return { kind: candidate.kind, model: candidate.model, role: r, reasons: out };
  }));
  const reasonsOf = (candidate, r) => eligibility.find((item) => same(item, candidate) && item.role === r).reasons;
  const eligible = (r) => candidates.filter((candidate) => reasonsOf(candidate, r).length === 0);
  // Rule 4 (section 4.3): for R2 or C3 work, a verifier of another model than the head's implementer ranks first, if one is eligible.
  const risky = ind.risk === 'R2' || ind.complexity === 'C3';
  const verifierPool = (head) => {
    const pool = eligible('verification');
    const other = risky && head ? pool.filter((candidate) => !same(candidate, head)) : [];
    return other.length ? other : pool;
  };
  const independence = (chosen, head) => !chosen || !head ? null : same(chosen, head) ? 'fresh-session-same-model' : 'different-model';
  // The verifier projection (section 4.4): the verify choice as if `m` had produced the head, from the verify-class rows.
  const projections = new Map();
  const project = (m) => {
    const key = JSON.stringify([m.kind, m.model]);
    if (!projections.has(key)) {
      const pool = verifierPool(m);
      const top = pool.length ? rank(pool, { history, cls: `verify/${ind.risk}/${ind.complexity}` }).top : null;
      projections.set(key, top && { verifier: top.candidate, attempts: top.attempts, u: top.u });
    }
    return projections.get(key);
  };
  const decision = {
    indicators: { risk: ind.risk, complexity: ind.complexity }, floor: floors[role].value, floorCapped: floors[role].capped,
    escalation: { tier: esc.tier, qualityFailuresOnTier: esc.qualityFailuresOnTier, escalated: esc.escalated, disabled: esc.disabled },
    eligibility,
    verifierProjection: stage === 'implement' ? eligible('implementer').map((m) => {
      const projected = project(m);
      return { implementer: { kind: m.kind, model: m.model }, verifier: projected ? named(projected.verifier) : null,
        independence: independence(projected?.verifier ?? null, m), u: projected ? projected.u : null };
    }) : [],
    costs: [], chosen: null, basis: 'none-eligible', reason: '', independence: null,
    catalogIndependence: stage === 'verify' ? catalogIndependence(ind.risk, task.role ?? null, catalog) : null, retryAt: null,
  };
  const pool = stage === 'verify' ? verifierPool(inputs.headImplementer ?? null) : eligible('implementer');
  if (!pool.length) {
    // Only waits and unconfigured CLIs clear by themselves; the earliest timed one bounds the retry.
    const times = candidates.filter((candidate) => reasonsOf(candidate, role).every((code) => code === 'account-wait' || code === 'cli-not-configured'))
      .flatMap((candidate) => { const own = fact(candidate); return [own.wait?.retryAt, own.cliConfigured ? null : own.cliRecheckAt]; })
      .filter((at) => typeof at === 'number');
    decision.retryAt = times.length ? Math.min(...times) : null;
    decision.reason = pins[role] ? 'the pinned candidate is not eligible now; the step waits for it' : 'no declared candidate is eligible';
    return decision;
  }
  const choice = rank(pool, { history, cls: `${stage}/${ind.risk}/${ind.complexity}`, projection: stage === 'implement' ? project : null, avoid: esc.failed });
  const modelPin = pins[role] && !('tier' in pins[role]);
  decision.costs = choice.rows.map((row) => ({ ...named(row.candidate), attempts: row.attempts, acceptance: row.rate,
    expectedAttempts: 1 / row.rate, expectedCost: row.cost }));
  decision.chosen = named(choice.top.candidate);
  decision.basis = modelPin ? 'pin' : choice.basis;
  decision.reason = modelPin ? 'the owner pinned this candidate' : choice.reason;
  if (esc.escalated) decision.reason += `; moved up to tier ${esc.tier} after poor-quality results`;
  if (floors[role].capped) decision.reason += '; floor-capped: no declared candidate at the step floor';
  decision.independence = stage === 'verify' ? independence(decision.chosen, inputs.headImplementer ?? null) : null;
  return decision;
}

/**
 * The complete argument of routeAuto() for a campaign with `routing` (section 9). `facts(kind)` gives one provider kind's
 * host facts observed now; `history` holds the aggregated rows of the step's class and, for an implement step, the
 * verify class. An implement attempt whose head the verifier rejected is listed with terminal "rejected".
 */
export function policyInputs({ stage, spec, routing, providers, platform, facts, history = [], priorAttempts = [], catalog = null,
  session = null, implementerSessions = [], headImplementer = null }) {
  const candidates = routing.candidates.map(({ kind, model, tier }) => ({ kind, model, tier,
    researchOnly: providers.find((provider) => provider.kind === kind)?.researchOnly === true }));
  return {
    stage,
    task: { deliverable: spec.deliverable, web: webFlag(spec.web), role: spec.role ?? null, references: spec.references?.length ?? 0,
      acceptance: spec.acceptance?.length ?? 0, dependsOn: spec.dependsOn?.length ?? 0,
      requiresMergedDependencies: spec.requiresMergedDependencies === true, writes: spec.writes ?? null,
      declared: { risk: spec.routing?.risk ?? null, complexity: spec.routing?.complexity ?? null } },
    sensitivePaths: routing.sensitivePaths ?? [], catalog, candidates, candidatesDigest: sha256(candidates), platform,
    hostFacts: [...new Set(candidates.map((candidate) => candidate.kind))].map((kind) => ({ kind, ...facts(kind) })),
    history, escalation: { priorAttempts }, pin: routing.pin ?? null, session, implementerSessions, headImplementer,
  };
}

/** The immutable receipt of a routing-policy/1 decision. */
export function autoReceipt(inputs) {
  return { version: RECEIPT_VERSION, policy: POLICY, mode: 'auto', inputs, decision: routeAuto(inputs), inputsDigest: sha256(inputs) };
}

/** Replay a stored receipt with the policy it names: an old receipt keeps its old policy. */
export function replay(receipt) {
  if (receipt.policy === STATIC_POLICY) return route(receipt.inputs);
  if (receipt.policy === POLICY) return routeAuto(receipt.inputs);
  throw new Error(`unknown routing policy ${receipt.policy}`);
}
