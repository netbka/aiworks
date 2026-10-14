// The router policy routing-policy/1 as a pure function (docs/design/MODEL_ROUTING.md slice R4): the section 10 table case
// by case, property tests over generated receipts, and replay of every receipt. Pure inputs only: no store, no model,
// network or GitHub call, and nothing dispatches with this policy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { autoReceipt, indicators, POLICY, policyInputs, REASON_CODES, receiptInputs, replay, route, routeAuto, staticReceipt,
  STATIC_POLICY } from '../../src/supervisor/router.mjs';

const HAIKU = { kind: 'claude-cli', model: 'haiku', tier: 1 };
const SONNET = { kind: 'claude-cli', model: 'sonnet', tier: 2 };
const OPUS = { kind: 'claude-cli', model: 'opus', tier: 3 };
const CODEX = { kind: 'codex-cli', model: 'gpt-6-astra', tier: 3 };
const AGY = { kind: 'agy-cli', model: 'gemini', tier: 2 };
// Section 4.1's candidates. The web case declares AGY first, the browser workers' order (executors.mjs BROWSER_KINDS).
const CANDIDATES = [HAIKU, SONNET, OPUS, CODEX];
const PROVIDERS = [{ kind: 'claude-cli', model: 'opus' }, { kind: 'codex-cli' }, { kind: 'agy-cli', model: 'gemini' }, { kind: 'cursor-cli', researchOnly: true }];
const catalogFile = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/governance/registry/agents.json'), 'utf8'));
const CATALOG = { digest: 'synthetic',
  independentFrom: Object.fromEntries(catalogFile.roles.filter((role) => role.independent_from).map((role) => [role.id, role.independent_from])) };

const list = (n, prefix = 'item') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
const spec = (changes = {}) => ({ id: 'T1', deliverable: 'commit', references: list(2, 'docs/ref'), acceptance: list(2), ...changes });
const facts = ({ waits = {}, missing = [], host = {} } = {}) => (kind) => missing.includes(kind)
  ? { cliConfigured: false, cliRecheckAt: 9_000, hostUnavailable: null, wait: null }
  : { cliConfigured: true, hostUnavailable: host[kind] ?? null, wait: waits[kind] ?? null };
const make = ({ stage = 'implement', task = spec(), candidates = CANDIDATES, pin = null, platform = 'win32', waits, missing, host,
  history = [], priorAttempts = [], providers = PROVIDERS, verify = {} } = {}) => policyInputs({
  stage, spec: task, routing: { mode: 'auto', candidates, sensitivePaths: ['src/supervisor/'], pin }, providers, platform,
  facts: facts({ waits, missing, host }), history, priorAttempts, catalog: CATALOG,
  ...(stage === 'verify' ? { session: 'S2', implementerSessions: ['S1'], headImplementer: { session: 'S1', kind: 'claude-cli', model: 'opus' }, ...verify } : {}),
});
const attempt = (candidate, cls = 'result', terminal = null, changes = {}) =>
  ({ op: `op-${candidate.model}`, kind: candidate.kind, model: candidate.model, class: cls, terminal, denied: false, tier: candidate.tier, ...changes });
const row = (candidate, cls, attempts, accepted, mean, unit = 'usd-reported', medianMs = 600_000) => ({ kind: candidate.kind, model: candidate.model,
  class: cls, attempts, accepted, cost: { unit, mean, known: mean === null ? 0 : attempts, unknown: mean === null ? attempts : 0 }, medianMs,
  window: { fromOp: 'op-a', toOp: 'op-b', to: 1_760_000_000_000 } });
const head = (candidate) => ({ headImplementer: { session: 'S1', kind: candidate.kind, model: candidate.model } });
const of = (candidate) => ({ kind: candidate.kind, model: candidate.model, tier: candidate.tier });
const reasonsFor = (decision, candidate, role) => decision.eligibility.find((item) => item.kind === candidate.kind && item.model === candidate.model && item.role === role).reasons;
const deepFreeze = (value) => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
};

// Every receipt a test generates is replayed here and kept for the reason-code coverage check at the end.
const receipts = [];
const decide = (inputs) => {
  const receipt = autoReceipt(deepFreeze(inputs));
  assert.equal(receipt.policy, POLICY);
  assert.deepEqual(replay(structuredClone(receipt)), receipt.decision, 'replaying the receipt gives the same decision');
  receipts.push(receipt);
  return receipt.decision;
};

test('routeAuto takes the receipt inputs as its only argument and reads no clock, store or host state', () => {
  assert.equal(routeAuto.length, 1);
  const inputs = deepFreeze(make());
  assert.deepEqual(routeAuto(structuredClone(inputs)), routeAuto(inputs));
  const source = readFileSync(join(import.meta.dirname, '../../src/supervisor/router.mjs'), 'utf8');
  for (const forbidden of [/\bDate\b/, /\bprocess\./, /Math\.random/, /performance\./, /node:fs/, /store\.mjs/, /node:child_process/]) {
    assert.doesNotMatch(source, forbidden, `router.mjs must not read ${forbidden}`);
  }
  assert.throws(() => replay({ policy: 'routing-policy/0', inputs }), /unknown routing policy/);
});

test('case 1: a typo fix starts on the economy tier and a standard verifier; two rejections move the repair up', () => {
  const task = spec({ writes: ['docs/X.md'] });
  const first = decide(make({ task }));
  assert.deepEqual(first.indicators, { risk: 'R0', complexity: 'C1' });
  assert.equal(first.floor, 1);
  assert.deepEqual(first.chosen, of(HAIKU));
  assert.equal(first.basis, 'cold-start');
  const check = decide(make({ stage: 'verify', task, verify: head(HAIKU) }));
  assert.equal(check.floor, 2);
  assert.deepEqual(check.chosen, of(SONNET));
  // Two unusable reviews in a row move the verifier up; two rejections are useful reviews and do not.
  const unusable = decide(make({ stage: 'verify', task, verify: head(HAIKU), priorAttempts: [attempt(SONNET, 'timeout'), attempt(SONNET, 'exit-without-result')] }));
  assert.equal(unusable.escalation.tier, 3);
  assert.deepEqual(unusable.chosen, of(OPUS));
  const rejections = decide(make({ stage: 'verify', task, verify: head(HAIKU),
    priorAttempts: [attempt(SONNET, 'result', 'rejected'), attempt(SONNET, 'result', 'rejected')] }));
  assert.deepEqual(rejections.chosen, of(SONNET));
  assert.equal(rejections.escalation.escalated, false);
  // One rejection: no other tier-1 candidate to sidestep to, so Haiku repairs once more.
  const once = decide(make({ task, priorAttempts: [attempt(HAIKU, 'result', 'rejected')] }));
  assert.deepEqual(once.chosen, of(HAIKU));
  assert.deepEqual(once.escalation, { tier: 1, qualityFailuresOnTier: 1, escalated: false, disabled: null });
  const twice = decide(make({ task, priorAttempts: [attempt(HAIKU, 'result', 'rejected'), attempt(HAIKU, 'result', 'rejected')] }));
  assert.deepEqual(twice.chosen, of(SONNET));
  assert.equal(twice.floor, 2);
  assert.equal(twice.escalation.escalated, true);
  assert.deepEqual(reasonsFor(twice, HAIKU, 'implementer'), ['below-floor']);
});

test('case 2: a new endpoint starts on standard, the dollar rule keeps Sonnet, two unusable results move to Opus', () => {
  const task = spec({ writes: ['src/api/'], references: list(7, 'src/ref'), acceptance: list(5) });
  const cold = decide(make({ task }));
  assert.deepEqual(cold.indicators, { risk: 'R0', complexity: 'C2' });
  assert.equal(cold.floor, 2);
  assert.deepEqual(cold.chosen, of(SONNET));
  const history = [row(SONNET, 'implement/R0/C2', 12, 9, 0.84), row(OPUS, 'implement/R0/C2', 12, 10, 3),
    row(SONNET, 'verify/R0/C2', 6, 6, 0.2), row(OPUS, 'verify/R0/C2', 6, 6, 0.8)];
  const priced = decide(make({ task, history }));
  assert.equal(priced.basis, 'comparable-cost');
  assert.deepEqual(priced.chosen, of(SONNET));
  const sonnet = priced.costs.find((item) => item.model === 'sonnet');
  assert.equal(sonnet.acceptance, 0.75, 'â = (9 + 4 × 0.75) / (12 + 4)');
  assert.ok(sonnet.expectedCost.value < priced.costs.find((item) => item.model === 'opus').expectedCost.value);
  // Sonnet is the only tier-2 candidate, so one invalid result cannot sidestep; the second moves up.
  const once = decide(make({ task, priorAttempts: [attempt(SONNET, 'invalid-result')] }));
  assert.deepEqual(once.chosen, of(SONNET));
  assert.equal(once.escalation.qualityFailuresOnTier, 1);
  const twice = decide(make({ task, priorAttempts: [attempt(SONNET, 'invalid-result'), attempt(SONNET, 'invalid-result')] }));
  assert.deepEqual(twice.chosen, of(OPUS));
  assert.equal(twice.escalation.tier, 3);
});

test('case 3: a cross-cutting refactor starts on the strongest tier, prefers a different verifier, and cannot escalate past the top', () => {
  const task = spec({ references: list(14, 'src/ref'), acceptance: list(8), dependsOn: ['A', 'B', 'C'], requiresMergedDependencies: true });
  assert.equal(indicators(make({ task })).points, 6);
  const implement = decide(make({ task }));
  assert.deepEqual(implement.indicators, { risk: 'R1', complexity: 'C3' });
  assert.equal(implement.floor, 3);
  assert.deepEqual(implement.chosen, of(OPUS));
  // Linux: Codex cannot verify a commit task on Windows (#113).
  const check = decide(make({ stage: 'verify', task, platform: 'linux', verify: head(OPUS) }));
  assert.equal(check.floor, 3);
  assert.deepEqual(check.chosen, of(CODEX));
  assert.equal(check.independence, 'different-model');
  const unusable = decide(make({ stage: 'verify', task, platform: 'linux', verify: head(OPUS), priorAttempts: [attempt(CODEX, 'timeout'), attempt(CODEX, 'invalid-result')] }));
  assert.deepEqual(unusable.escalation, { tier: 3, qualityFailuresOnTier: 2, escalated: false, disabled: null });
  assert.equal(unusable.chosen.tier, 3, 'already the top tier: backoff only');
  // A rejection is a useful review: it resets the unusable streak.
  const useful = decide(make({ stage: 'verify', task, platform: 'linux', verify: head(OPUS),
    priorAttempts: [attempt(CODEX, 'timeout'), attempt(CODEX, 'result', 'rejected'), attempt(CODEX, 'timeout')] }));
  assert.equal(useful.escalation.qualityFailuresOnTier, 1);
});

test('case 4: a browser acceptance runs on AGY, and on Claude with the browser while AGY waits, without escalating', () => {
  const task = spec({ deliverable: 'report', web: true, references: ['docs/page.md'], acceptance: ['the page loads'] });
  const candidates = [AGY, ...CANDIDATES];
  const first = decide(make({ task, candidates }));
  assert.deepEqual(first.indicators, { risk: 'R1', complexity: 'C1' });
  assert.equal(first.floor, 2);
  assert.deepEqual(first.chosen, of(AGY));
  assert.deepEqual(reasonsFor(first, CODEX, 'implementer'), ['web-mismatch', 'role-unsupported']);
  const waits = { 'agy-cli': { retryAt: 5_000, reason: 'quota: credits' } };
  const fallback = decide(make({ task, candidates, waits, priorAttempts: [attempt(AGY, 'quota')] }));
  assert.deepEqual(fallback.chosen, of(SONNET));
  assert.deepEqual(reasonsFor(fallback, AGY, 'implementer'), ['account-wait']);
  assert.deepEqual(fallback.escalation, first.escalation, 'a quota is not a quality signal');
});

test('case 5: a supervisor change is high risk; Codex checks Opus; Opus repairs because Codex cannot commit on Windows', () => {
  const task = spec({ writes: ['src/supervisor/'], role: 'backend-engineer' });
  const implement = decide(make({ task }));
  assert.equal(implement.indicators.risk, 'R2');
  assert.equal(implement.floor, 3);
  assert.deepEqual(implement.chosen, of(OPUS));
  assert.deepEqual(reasonsFor(implement, CODEX, 'implementer'), ['role-unsupported']);
  assert.deepEqual(reasonsFor(implement, CODEX, 'verification'), ['role-unsupported'], 'Codex cannot run the gate on Windows (#113)');
  assert.deepEqual(decide(make({ stage: 'verify', task, verify: head(OPUS) })).chosen, of(OPUS));
  const check = decide(make({ stage: 'verify', task, platform: 'linux', verify: head(OPUS) }));
  assert.deepEqual(check.chosen, of(CODEX));
  assert.equal(check.independence, 'different-model');
  assert.deepEqual(check.catalogIndependence, { role: 'verification-agent', value: 'declared' });
  const repair = decide(make({ task, priorAttempts: [attempt(OPUS, 'result', 'rejected')] }));
  assert.deepEqual(repair.escalation, { tier: 3, qualityFailuresOnTier: 1, escalated: false, disabled: null });
  assert.deepEqual(repair.chosen, of(OPUS));
  // The same receipt on Linux: Codex may commit there, so the R2 repair sidesteps to it.
  const linux = decide(make({ task, platform: 'linux', priorAttempts: [attempt(OPUS, 'result', 'rejected')] }));
  assert.deepEqual(linux.chosen, of(CODEX));
  assert.equal(linux.basis, 'sidestep');
  // A role the verifier role does not declare independence from is reported, not blocked.
  const undeclared = decide(make({ stage: 'verify', task: spec({ role: 'orchestrator' }), verify: head(OPUS) }));
  assert.deepEqual(undeclared.catalogIndependence, { role: 'verification-agent', value: 'not-declared' });
  assert.ok(undeclared.chosen);
});

test('case 6: a sandbox denial is never escalated and never routed around', () => {
  const codex1 = { ...CODEX, tier: 1 };
  const candidates = [codex1, HAIKU, SONNET, OPUS];
  const task = spec({ writes: ['docs/X.md'] });
  const first = decide(make({ task, candidates, platform: 'linux' }));
  assert.deepEqual(first.chosen, of(codex1));
  const denied = [attempt(codex1, 'error', null, { denied: true }), attempt(codex1, 'invalid-result', null, { denied: true }),
    attempt(codex1, 'result', 'rejected', { denied: true })];
  const after = decide(make({ task, candidates, platform: 'linux', priorAttempts: denied }));
  assert.deepEqual(after.chosen, of(codex1));
  assert.deepEqual(after.escalation, first.escalation);
  assert.equal(after.basis, first.basis);
});

test('case 7: a Claude usage limit moves to the next eligible candidate at the floor, and Opus resumes after the reset', () => {
  const task = spec({ writes: ['src/supervisor/'] });
  assert.deepEqual(decide(make({ task, platform: 'linux' })).chosen, of(OPUS));
  const waits = { 'claude-cli': { retryAt: 7_000, reason: 'quota: usage limit' } };
  const waiting = decide(make({ task, platform: 'linux', waits, priorAttempts: [attempt(OPUS, 'quota')] }));
  assert.deepEqual(waiting.chosen, of(CODEX));
  assert.equal(waiting.escalation.qualityFailuresOnTier, 0);
  for (const candidate of [HAIKU, SONNET, OPUS]) assert.ok(reasonsFor(waiting, candidate, 'implementer').includes('account-wait'));
  const resumed = decide(make({ task, platform: 'linux', priorAttempts: [attempt(CODEX, 'result', 'completed'), attempt(OPUS, 'quota')] }));
  assert.deepEqual(resumed.chosen, of(OPUS));
  const none = decide(make({ task, platform: 'linux', waits: { ...waits, 'codex-cli': { retryAt: 6_000, reason: 'quota: limit' } } }));
  assert.equal(none.chosen, null);
  assert.equal(none.retryAt, 6_000, 'the earliest timed wait bounds the retry');
});

test('case 8: an owner pin holds the model, turns escalation off and waits with its account', () => {
  const task = spec({ writes: ['docs/X.md'] });
  const pin = { implementer: { kind: 'claude-cli', model: 'opus' } };
  const pinned = decide(make({ task, pin }));
  assert.deepEqual(pinned.chosen, of(OPUS));
  assert.equal(pinned.basis, 'pin');
  assert.equal(pinned.floor, null);
  assert.deepEqual(reasonsFor(pinned, HAIKU, 'implementer'), ['pin-excluded']);
  const failed = decide(make({ task, pin, priorAttempts: [attempt(OPUS, 'result', 'rejected'), attempt(OPUS, 'result', 'rejected')] }));
  assert.deepEqual(failed.chosen, of(OPUS));
  assert.equal(failed.escalation.disabled, 'model-pin');
  assert.equal(failed.escalation.escalated, false);
  const waiting = decide(make({ task, pin, platform: 'linux', waits: { 'claude-cli': { retryAt: 8_000, reason: 'quota: usage limit' } } }));
  assert.equal(waiting.chosen, null, 'a pin means only this candidate: no fallback');
  assert.equal(waiting.retryAt, 8_000);
  // A tier pin keeps sidesteps within its tier.
  const tier = decide(make({ task, platform: 'linux', pin: { implementer: { tier: 3 } }, priorAttempts: [attempt(OPUS, 'invalid-result')] }));
  assert.deepEqual(tier.chosen, of(CODEX));
  assert.equal(tier.escalation.disabled, 'tier-pin');
});

test('case 9: a campaign without routing keeps the static policy and its failed-provider rotation', () => {
  const providers = [{ kind: 'claude-cli', model: 'opus' }, { kind: 'codex-cli' }];
  const inputs = (priorAttempts) => receiptInputs({ stage: 'implement', chain: true, spec: spec({ deliverable: 'report' }), providers, platform: 'linux',
    facts: () => ({ cliConfigured: true, hostUnavailable: null, wait: null }), priorAttempts });
  const first = staticReceipt(inputs([]));
  assert.equal(first.policy, STATIC_POLICY);
  assert.deepEqual(first.decision.chosen, { kind: 'claude-cli', model: 'opus', tier: null });
  assert.deepEqual(replay(structuredClone(first)), route(first.inputs));
  const rotated = staticReceipt(inputs([{ op: 'op-1', kind: 'claude-cli', model: 'opus', class: 'invalid-result', terminal: null, denied: false, tier: null }]));
  assert.deepEqual(rotated.decision.chosen, { kind: 'codex-cli', model: null, tier: null });
  assert.deepEqual(replay(structuredClone(rotated)), rotated.decision);
});

test('case 10: a verify step runs in a fresh session; a receipt with an equal session id has no decision', () => {
  const check = decide(make({ stage: 'verify', task: spec({ writes: ['docs/X.md'] }), verify: head(HAIKU) }));
  assert.ok(CANDIDATES.some((candidate) => candidate.kind === check.chosen.kind && candidate.model === check.chosen.model));
  assert.throws(() => routeAuto(make({ stage: 'verify', verify: { session: 'S1', ...head(HAIKU) } })), /fresh session/);
  assert.throws(() => routeAuto(make({ stage: 'verify', verify: { session: 'S3', implementerSessions: ['S1', 'S3'] } })), /fresh session/);
  assert.throws(() => routeAuto(make({ stage: 'verify', verify: { session: null } })), /fresh session/);
});

test('case 11: the projected verifier\'s cost can flip the implement choice, and both receipts replay', () => {
  const task = spec({ writes: ['docs/X.md'] });
  // Smoothed rates: â(Haiku) = (2 + 2.4) / 10 = 0.44, â(Sonnet) = (5 + 3) / 10 = 0.8, â(Opus) = (6 + 3.4) / 10 = 0.94.
  const implementRows = [row(HAIKU, 'implement/R0/C1', 6, 2, 1), row(SONNET, 'implement/R0/C1', 6, 5, 2), row(OPUS, 'implement/R0/C1', 6, 6, 20)];
  const verifyRows = (u) => [row(SONNET, 'verify/R0/C1', 6, 6, u), row(OPUS, 'verify/R0/C1', 6, 6, 30), row(CODEX, 'verify/R0/C1', 6, 6, null, 'tokens')];
  const cheap = decide(make({ task, history: [...implementRows, ...verifyRows(0)] }));
  const dear = decide(make({ task, history: [...implementRows, ...verifyRows(10)] }));
  for (const decision of [cheap, dear]) {
    assert.equal(decision.basis, 'comparable-cost');
    assert.deepEqual(decision.verifierProjection.map((item) => item.verifier), [of(SONNET), of(SONNET), of(SONNET)]);
  }
  assert.deepEqual(cheap.chosen, of(HAIKU));
  assert.deepEqual(dear.chosen, of(SONNET));
  const value = (decision, candidate) => decision.costs.find((item) => item.model === candidate.model).expectedCost.value;
  assert.ok(Math.abs(value(cheap, HAIKU) - 1 / 0.44) < 1e-9 && Math.abs(value(cheap, SONNET) - 2.5) < 1e-9);
  assert.ok(Math.abs(value(dear, HAIKU) - 11 / 0.44) < 1e-9 && Math.abs(value(dear, SONNET) - 15) < 1e-9);
  assert.deepEqual(cheap.verifierProjection[0].u, { unit: 'usd-reported', mean: 0 });
  assert.deepEqual(dear.verifierProjection[0].u, { unit: 'usd-reported', mean: 10 });
  // Codex: role-unsupported for a commit task on Windows in both roles (#113), eligible on Linux, recomputed from `platform` alone.
  assert.deepEqual(reasonsFor(cheap, CODEX, 'implementer'), ['role-unsupported']);
  assert.deepEqual(reasonsFor(cheap, CODEX, 'verification'), ['role-unsupported']);
  const linux = decide(make({ task, platform: 'linux', history: [...implementRows, ...verifyRows(0)] }));
  assert.deepEqual(reasonsFor(linux, CODEX, 'implementer'), []);
  assert.deepEqual(reasonsFor(linux, CODEX, 'verification'), []);
  assert.equal(linux.basis, 'tier-walk', 'Codex reports no dollars, so the costs no longer compare');
});

test('E is unknown, never zero, when the projected verifier has no known cost or another unit', () => {
  const task = spec({ writes: ['docs/X.md'] });
  const implementRows = [row(HAIKU, 'implement/R0/C1', 6, 2, 1), row(SONNET, 'implement/R0/C1', 6, 5, 2), row(OPUS, 'implement/R0/C1', 6, 6, 20)];
  for (const verifier of [row(SONNET, 'verify/R0/C1', 6, 6, null), row(SONNET, 'verify/R0/C1', 6, 6, 1200, 'tokens')]) {
    const decision = decide(make({ task, history: [...implementRows, verifier] }));
    assert.notEqual(decision.basis, 'comparable-cost');
    for (const item of decision.costs) assert.equal(item.expectedCost, null, `${item.model}: unknown, not zero`);
  }
  const missingVerifier = decide(make({ task, history: implementRows, waits: { 'codex-cli': { retryAt: null, reason: 'auth: login' } },
    candidates: [HAIKU, SONNET, OPUS, CODEX], pin: { verifier: { kind: 'codex-cli', model: 'gpt-6-astra' } } }));
  assert.ok(missingVerifier.verifierProjection.every((item) => item.verifier === null && item.u === null));
  assert.ok(missingVerifier.costs.every((item) => item.expectedCost === null));
});

test('a sidestep changes when only the newest prior attempt\'s kind and model change', () => {
  const codex2 = { ...CODEX, tier: 2 };
  const candidates = [SONNET, codex2, OPUS];
  const task = spec({ writes: ['src/api/'], references: list(7, 'src/ref') });
  const after = (failed) => decide(make({ task, candidates, platform: 'linux', priorAttempts: [attempt(failed, 'invalid-result')] }));
  assert.deepEqual(after(SONNET).chosen, of(codex2));
  assert.deepEqual(after(codex2).chosen, of(SONNET));
  assert.equal(after(SONNET).basis, 'sidestep');
});

test('the different-model verifier preference changes when only the head implementer\'s kind and model change', () => {
  const task = spec({ writes: ['src/supervisor/'] });
  const check = (implementer) => decide(make({ stage: 'verify', task, platform: 'linux', verify: head(implementer) }));
  assert.deepEqual(check(OPUS).chosen, of(CODEX));
  assert.deepEqual(check(CODEX).chosen, of(OPUS));
  assert.equal(check(CODEX).independence, 'different-model');
  // With only one eligible verifier the same model runs in a fresh session, recorded as such.
  const alone = decide(make({ stage: 'verify', task, candidates: [OPUS], verify: head(OPUS) }));
  assert.deepEqual(alone.chosen, of(OPUS));
  assert.equal(alone.independence, 'fresh-session-same-model');
});

test('eligibility lists every failing filter per candidate and role, and a floor above every candidate is capped', () => {
  const cursor = { kind: 'cursor-cli', model: 'auto', tier: 1 };
  const decision = decide(make({ candidates: [cursor, HAIKU, SONNET, CODEX, AGY], missing: ['codex-cli'],
    host: { 'agy-cli': 'project CLI extensions require a scoped adapter policy' } }));
  assert.deepEqual(reasonsFor(decision, cursor, 'implementer'), ['research-only', 'role-unsupported', 'below-floor']);
  assert.deepEqual(reasonsFor(decision, CODEX, 'implementer'), ['cli-not-configured', 'role-unsupported']);
  assert.deepEqual(reasonsFor(decision, AGY, 'implementer'), ['web-mismatch', 'role-unsupported', 'host-unavailable']);
  const capped = decide(make({ task: spec({ writes: ['src/supervisor/'] }), candidates: [HAIKU, SONNET] }));
  assert.equal(capped.floorCapped, true);
  assert.equal(capped.floor, 2);
  assert.deepEqual(capped.chosen, of(SONNET));
  assert.match(capped.reason, /floor-capped/);
});

// A small deterministic generator (mulberry32), so a failing case is reproducible from its seed.
const generator = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const POOL = [HAIKU, SONNET, OPUS, CODEX, AGY, { kind: 'cursor-cli', model: 'auto', tier: 2 }, { kind: 'codex-cli', model: 'mini', tier: 1 }];
const QUALITY = [['result', 'rejected'], ['invalid-result', null], ['exit-without-result', null], ['timeout', null], ['result', 'evidence-unavailable'],
  ['result', 'accepted'], ['result', 'completed']];
const NOT_QUALITY = ['quota', 'auth', 'spawn-failed', 'unavailable', 'admission-blocked', 'lost', 'error', 'boundary-violation'];

function generated(seed) {
  const random = generator(seed);
  const pickOne = (items) => items[Math.floor(random() * items.length)];
  const candidates = POOL.filter(() => random() < 0.6);
  if (!candidates.length) candidates.push(pickOne(POOL));
  const stage = random() < 0.5 ? 'implement' : 'verify';
  const web = random() < 0.2;
  const task = spec({ deliverable: web || random() < 0.3 ? 'report' : 'commit', web, references: list(1 + Math.floor(random() * 20), 'ref'),
    acceptance: list(1 + Math.floor(random() * 8)), dependsOn: list(Math.floor(random() * 3), 'T'), requiresMergedDependencies: random() < 0.3,
    ...(random() < 0.3 ? { role: pickOne(['backend-engineer', 'security-reviewer', 'orchestrator']) } : {}),
    ...(random() < 0.2 ? { routing: { risk: 'high' } } : {}) });
  if (task.deliverable === 'commit' && random() < 0.6) task.writes = [pickOne(['docs/', 'src/supervisor/router.mjs', 'src/', 'resource:db'])];
  const kinds = [...new Set(candidates.map((candidate) => candidate.kind))];
  const waits = Object.fromEntries(kinds.filter(() => random() < 0.2).map((kind) => [kind, { retryAt: random() < 0.5 ? null : 1_000 + Math.floor(random() * 9_000), reason: 'quota: x' }]));
  const missing = kinds.filter(() => random() < 0.1);
  const host = Object.fromEntries(kinds.filter(() => random() < 0.1).map((kind) => [kind, 'host finding']));
  const history = candidates.flatMap((candidate) => ['implement', 'verify'].flatMap((s) => ['R0', 'R1', 'R2'].flatMap((r) => ['C1', 'C2', 'C3'].flatMap((c) => {
    if (random() < 0.7) return [];
    const attempts = Math.floor(random() * 12);
    const unit = candidate.kind === 'claude-cli' ? 'usd-reported' : 'tokens';
    return [row(candidate, `${s}/${r}/${c}`, attempts, Math.floor(random() * (attempts + 1)), random() < 0.2 ? null : Math.round(random() * 400) / 100, unit)];
  }))));
  const priorAttempts = Array.from({ length: Math.floor(random() * 4) }, () => {
    const [cls, terminal] = pickOne(QUALITY);
    return attempt(pickOne(candidates), cls, terminal, { denied: random() < 0.15 });
  });
  const pinned = pickOne(candidates);
  const pin = random() < 0.15 ? { [stage === 'verify' ? 'verifier' : 'implementer']: random() < 0.5 ? { kind: pinned.kind, model: pinned.model } : { tier: pinned.tier } } : null;
  return make({ stage, task, candidates, pin, platform: random() < 0.5 ? 'win32' : 'linux', waits, missing, host, history, priorAttempts,
    verify: head(pickOne(candidates)) });
}

test('property: a choice is a declared, eligible candidate at or above the floor, and every receipt replays', () => {
  for (let seed = 1; seed <= 400; seed += 1) {
    const inputs = generated(seed);
    const decision = decide(inputs);
    const role = inputs.stage === 'verify' ? 'verification' : 'implementer';
    const pinned = inputs.pin?.[inputs.stage === 'verify' ? 'verifier' : 'implementer'];
    if (pinned) assert.equal(decision.floor, null, `seed ${seed}`);
    else if (decision.floorCapped) assert.equal(decision.floor, Math.max(...inputs.candidates.map((candidate) => candidate.tier)), `seed ${seed}`);
    if (!decision.chosen) { assert.equal(decision.basis, 'none-eligible', `seed ${seed}`); continue; }
    assert.ok(inputs.candidates.some((candidate) => candidate.kind === decision.chosen.kind && candidate.model === decision.chosen.model &&
      candidate.tier === decision.chosen.tier), `seed ${seed}: a declared candidate`);
    assert.deepEqual(reasonsFor(decision, decision.chosen, role), [], `seed ${seed}: eligible`);
    if (!pinned) assert.ok(decision.chosen.tier >= decision.floor, `seed ${seed}: never below the floor`);
    if (pinned && !('tier' in pinned)) assert.deepEqual([decision.chosen.kind, decision.chosen.model], [pinned.kind, pinned.model], `seed ${seed}`);
  }
});

test('property: a denial, limit, login, launch or host outcome never escalates and never changes the choice', () => {
  for (let seed = 1001; seed <= 1300; seed += 1) {
    const inputs = generated(seed);
    const random = generator(seed * 7);
    const quiet = Array.from({ length: 1 + Math.floor(random() * 4) }, () => {
      const candidate = inputs.candidates[Math.floor(random() * inputs.candidates.length)];
      return random() < 0.4 ? attempt(candidate, 'invalid-result', null, { denied: true })
        : attempt(candidate, NOT_QUALITY[Math.floor(random() * NOT_QUALITY.length)], null, { denied: random() < 0.3 });
    });
    const base = decide({ ...inputs, escalation: { priorAttempts: [] } });
    const after = decide({ ...inputs, escalation: { priorAttempts: quiet } });
    assert.deepEqual(after, base, `seed ${seed}: only non-quality outcomes`);
    // Added at any position among quality outcomes, they leave the escalation state unchanged.
    const mixed = [...inputs.escalation.priorAttempts];
    for (const item of quiet) mixed.splice(1 + Math.floor(random() * mixed.length), 0, item);
    assert.deepEqual(decide({ ...inputs, escalation: { priorAttempts: mixed } }).escalation, decide(inputs).escalation, `seed ${seed}: escalation`);
  }
});

test('property: a verify receipt whose session equals an implementer session never gets a decision', () => {
  for (let seed = 2001; seed <= 2100; seed += 1) {
    const inputs = generated(seed);
    if (inputs.stage !== 'verify') continue;
    assert.throws(() => routeAuto({ ...inputs, session: inputs.implementerSessions[0] }), /fresh session/, `seed ${seed}`);
    assert.notEqual(inputs.session, inputs.implementerSessions[0]);
  }
});

test('every reason code is covered and every generated receipt replays from its inputs alone', () => {
  const seen = new Set(receipts.flatMap((receipt) => receipt.decision.eligibility.flatMap((item) => item.reasons)));
  assert.deepEqual([...seen].sort(), [...REASON_CODES].sort());
  assert.ok(receipts.length > 500);
  for (const receipt of receipts) assert.deepEqual(routeAuto(JSON.parse(JSON.stringify(receipt.inputs))), receipt.decision);
});
