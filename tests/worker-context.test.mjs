import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { validatePolicy, validatePacket, packetDigest, planContext, acceptsLease, settleWithin } from '../scripts/lib/worker-context.mjs';

const policy = JSON.parse(readFileSync(new URL('../registry/worker-context-policy.json', import.meta.url)));
const clone = (value) => structuredClone(value);
function fixture() {
  const packet = {
    version: 1, tenantId: 'synthetic-tenant', projectId: 'example-project', environment: 'test',
    taskId: 'TASK-1', stageId: 'contract-check', runId: 'synthetic-run-2', role: 'implementer',
    revision: 'a'.repeat(40), authorityDigest: 'b'.repeat(64), access: 'read-only',
    goal: 'Verify bounded context admission using synthetic data.',
    constraints: ['Do not touch production or personal browser profiles.'],
    acceptance: ['A cleanup timeout cannot authorize stale actions.'],
    references: [{ path: 'docs/WORKER_CONTEXT_LIFECYCLE.md', revision: 'a'.repeat(40) }],
  };
  const hash = packetDigest(packet, policy);
  return {
    packet, authorityCurrent: true, predecessorSafe: true,
    checkpoint: { ...packet, committed: true, packetDigest: hash },
    budget: { inputTokens: 1000, outputReserveTokens: 1000, safetyTokens: 500, windowTokens: 10000 },
    capabilities: { freshSession: 'verified', dedicatedBrowser: 'verified' },
    replacementAttempts: 0, quarantinedSessions: 0, capacityAvailable: true,
    session: { ...packet, sessionId: 'synthetic-session-2', state: 'active', isolation: 'verified',
      provenance: 'fresh-task', loadedPacketDigest: hash, resetOutstanding: false,
      cleanupResult: 'not-needed', independent: true, browserOwnership: 'dedicated' },
  };
}
function rebind(input) {
  const hash = packetDigest(input.packet, policy);
  input.checkpoint = { ...input.packet, committed: true, packetDigest: hash };
  Object.assign(input.session, input.packet, { loadedPacketDigest: hash });
  return input;
}

test('checked-in policy is bounded and packet validates', () => {
  assert.equal(validatePolicy(policy), policy);
  const input = fixture();
  assert.equal(validatePacket(input.packet, policy), input.packet);
  assert.equal(planContext(input, policy).action, 'continue');
});
for (const [key, value] of [['cleanupTimeoutMs', 0], ['cleanupTimeoutMs', Infinity], ['maxCleanupAttempts', 2],
  ['maxReplacementAttempts', 0], ['maxQuarantinedSessions', 17], ['maxReaperAttempts', 6],
  ['maxPacketBytes', 999], ['softOccupancy', 0.91], ['hardOccupancy', 1]]) {
  test(`reject invalid policy ${key}=${value}`, () => assert.throws(() => validatePolicy({ ...policy, [key]: value }), TypeError));
}
test('unknown policy keys and absent packet fields are rejected', () => {
  assert.throws(() => validatePolicy({ ...policy, disableIsolation: true }), TypeError);
  const input = fixture(); delete input.packet.constraints;
  assert.throws(() => planContext(input, policy), TypeError);
});
test('sparse required arrays cannot discard packet constraints, acceptance or references', () => {
  for (const key of ['constraints', 'acceptance', 'references']) {
    for (const keepFirst of [false, true]) {
      const input = fixture();
      input.packet[key] = keepFirst ? [...input.packet[key], ,] : Array(1);
      assert.throws(() => validatePacket(input.packet, policy), TypeError, key);
      assert.throws(() => packetDigest(input.packet, policy), TypeError, key);
      assert.throws(() => planContext(input, policy), TypeError, key);
    }
  }
});
for (const field of ['tenantId', 'projectId', 'environment', 'taskId', 'stageId', 'runId', 'role', 'revision', 'authorityDigest', 'access']) {
  test(`no context inheritance across ${field}`, () => {
    const input = fixture(); input.session[field] = 'different';
    assert.equal(planContext(input, policy).action, 'start-fresh');
  });
}
test('fresh session is independent of old-session cleanup', () => {
  const input = fixture(); input.session = null;
  assert.deepEqual(planContext(input, policy), { action: 'start-fresh', reason: 'task-boundary', retirePrevious: false, cleanupOnCriticalPath: false });
});
for (const state of ['pending', 'quarantined', 'retired']) {
  test(`never admit ${state} session`, () => {
    const input = fixture(); input.session.state = state;
    assert.equal(planContext(input, policy).action, 'start-fresh');
  });
}
for (const cleanupResult of ['failed', 'timed-out', 'unsupported']) {
  test(`optional cleanup ${cleanupResult} is non-blocking only after settlement`, () => {
    const input = fixture(); input.session.cleanupResult = cleanupResult;
    assert.equal(planContext(input, policy).action, 'continue-degraded');
    input.session.resetOutstanding = true;
    assert.equal(planContext(input, policy).action, 'start-fresh');
  });
}
for (const property of ['authorityCurrent', 'predecessorSafe']) {
  test(`${property} fails closed even with a fresh-session adapter`, () => {
    const input = fixture(); input[property] = false; input.session = null;
    assert.equal(planContext(input, policy).action, 'block-branch');
  });
}
test('checkpoint must be durable, current and bound to actual packet contents', () => {
  for (const change of [
    (i) => { i.checkpoint.committed = false; },
    (i) => { i.checkpoint.revision = 'c'.repeat(40); },
    (i) => { i.packet.constraints.push('A requirement added after the checkpoint.'); },
    (i) => { i.checkpoint = null; },
  ]) {
    const input = fixture(); change(input);
    assert.equal(planContext(input, policy).reason, 'checkpoint-missing-or-stale');
  }
});
test('packet hash is stable across object key order, not content changes', () => {
  const packet = fixture().packet;
  const reordered = Object.fromEntries(Object.entries(packet).reverse());
  assert.equal(packetDigest(packet, policy), packetDigest(reordered, policy));
  const changed = clone(packet); changed.constraints.push('Another constraint.');
  assert.notEqual(packetDigest(packet, policy), packetDigest(changed, policy));
});
test('byte limit includes multibyte text; invalid references cannot masquerade as pointers', () => {
  const packet = fixture().packet;
  packet.constraints = Array(32).fill('Ж'.repeat(1000));
  assert.throws(() => validatePacket(packet, policy), /byte budget/);
  for (const path of ['../secret', '/etc/passwd', 'C:\\private', 'https://host/token', 'docs/%2e%2e/x', 'docs/\nraw']) {
    const candidate = fixture().packet; candidate.references[0].path = path;
    assert.throws(() => validatePacket(candidate, policy), TypeError);
  }
});
test('full context budgets include output reserve and safety margin', () => {
  const input = fixture(); input.budget.inputTokens = 6000;
  assert.equal(planContext(input, policy).maintenance, 'checkpoint-and-rotate-at-safe-boundary');
  input.budget.inputTokens = 7500;
  assert.equal(planContext(input, policy).action, 'continue'); // exact 90% hard bound
  input.budget.inputTokens = 7501;
  assert.equal(planContext(input, policy).action, 'repack');
  input.budget.inputTokens = NaN;
  assert.equal(planContext(input, policy).reason, 'context-budget-unknown');
});
test('unknown capacity and exhausted recovery limits block only the adapter branch', () => {
  for (const change of [
    (i) => { i.capabilities.freshSession = 'unknown'; },
    (i) => { i.capacityAvailable = false; },
    (i) => { i.replacementAttempts = policy.maxReplacementAttempts; },
    (i) => { i.quarantinedSessions = policy.maxQuarantinedSessions; },
  ]) {
    const input = fixture(); input.session = null; change(input);
    assert.equal(planContext(input, policy).action, 'block-branch');
  }
});
test('independent verification cannot inherit implementer session or write access', () => {
  const input = rebind(fixture()); input.packet.role = 'verification'; rebind(input);
  input.session.independent = false;
  assert.equal(planContext(input, policy).reason, 'reviewer-independence-unverified');
  input.session.independent = true; input.session.role = 'implementer';
  assert.equal(planContext(input, policy).action, 'start-fresh');
  input.packet.access = 'write'; input.session = null;
  assert.equal(planContext(input, policy).reason, 'reviewer-must-be-read-only');
});
test('browser review requires dedicated ownership, not clearing the personal profile', () => {
  const input = fixture(); input.packet.role = 'browser-review'; rebind(input);
  input.session.browserOwnership = 'personal';
  assert.equal(planContext(input, policy).action, 'start-fresh');
  input.capabilities.dedicatedBrowser = 'unknown';
  assert.equal(planContext(input, policy).reason, 'dedicated-browser-unsupported');
});
function lease() {
  return { ...fixture().packet, sessionId: 'session-2', generation: 2, expiresAtMs: 1000, state: 'active' };
}
test('stale actions and expired leases are rejected without acting as an authorization service', () => {
  const current = lease();
  assert.equal(acceptsLease(current, clone(current), 999), true);
  assert.equal(acceptsLease(current, clone(current), 1000), false);
  assert.equal(acceptsLease({ ...current, state: 'revoked' }, current, 999), false);
  for (const field of ['tenantId', 'projectId', 'environment', 'taskId', 'stageId', 'runId', 'sessionId', 'revision', 'authorityDigest', 'generation']) {
    assert.equal(acceptsLease(current, { ...current, [field]: field === 'generation' ? 1 : 'stale' }, 999), false, field);
  }
  assert.equal(acceptsLease({}, {}, 0), false);
  assert.equal(acceptsLease(current, current, NaN), false);
});
test('cleanup can succeed or throw synchronously; no error payload is emitted', async () => {
  assert.deepEqual(await settleWithin(() => 'receipt', 100), { status: 'succeeded', value: 'receipt', remoteSettlement: 'unknown' });
  assert.deepEqual(await settleWithin(() => { throw new Error('synthetic-private-data'); }, 100), { status: 'failed', remoteSettlement: 'unknown' });
});
test('hanging cleanup times out; late success cannot change the immutable result', async () => {
  let complete; let signal;
  const pending = settleWithin((s) => { signal = s; return new Promise((resolve) => { complete = resolve; }); }, 10);
  const outcome = await pending;
  assert.deepEqual(outcome, { status: 'timed-out', remoteSettlement: 'unknown' });
  assert.equal(signal.aborted, true);
  complete('late'); await delay(0);
  assert.equal(outcome.status, 'timed-out');
  assert.equal(Object.isFrozen(outcome), true);
});
test('late rejection is consumed, and abort rejection cannot turn a timeout into success', async () => {
  let reject;
  const outcome = await settleWithin(() => new Promise((_, fail) => { reject = fail; }), 10);
  reject(new Error('late synthetic failure')); await delay(0);
  assert.equal(outcome.status, 'timed-out');
  const aborted = await settleWithin((signal) => new Promise((_, fail) => {
    signal.addEventListener('abort', () => fail(new Error('cancelled')), { once: true });
  }), 10);
  assert.equal(aborted.status, 'timed-out');
});
test('invalid deadlines fail before invoking the adapter', async () => {
  let called = false;
  await assert.rejects(settleWithin(() => { called = true; }, 0), TypeError);
  assert.equal(called, false);
});

test('quarantine capacity does not stop a healthy existing task session', () => {
  const input = fixture(); input.quarantinedSessions = policy.maxQuarantinedSessions;
  assert.equal(planContext(input, policy).action, 'continue');
});
