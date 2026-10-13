// Owner decision 2026-10-10: no campaign capacity limits by default. Every limit is optional; omitted or null
// means no limit, and only provider subscription/usage limits stop work. A budget exists only when declared. Synthetic workers only; no model, network or GitHub access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, runUntil, SQLITE, skipWithoutSqlite } from './helpers.mjs';

const api = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const { campaignLimits, validateDeclaration } = await import('../../src/supervisor/campaign.mjs');
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const NONE = { maxWorkerRuns: null, slots: 1, maxRepairRounds: null, maxRetriesPerTask: null };

function setup(t, { decl, scenario }) {
  const env = environment({ scenario });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  api.campaignStart(store, decl);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  return { env, store, controller, id: decl.campaignId };
}

test('every limit is optional and defaults to no limit', () => {
  const d = declaration();
  const UNLIMITED = { slots: 1, maxWorkerRuns: null, maxRepairRounds: null, maxRetriesPerTask: null, maxCostUsd: null, unknownRunCostUsd: null };
  const { limits: _omitted, ...noLimits } = d;
  assert.deepEqual(campaignLimits(validateDeclaration(noLimits)), UNLIMITED, 'no limits object at all');
  assert.deepEqual(campaignLimits(validateDeclaration({ ...d, limits: {} })), UNLIMITED, 'an empty limits object');
  assert.deepEqual(campaignLimits(validateDeclaration({ ...d, limits: NONE })), UNLIMITED, 'explicit nulls');
  for (const key of ['maxWorkerRuns', 'maxRepairRounds', 'maxRetriesPerTask']) {
    const limits = { ...NONE }; delete limits[key];
    assert.equal(campaignLimits(validateDeclaration({ ...d, limits }))[key], null, `omitting ${key} means no limit`);
  }
  assert.equal(campaignLimits(validateDeclaration({ ...d, limits: { maxCostUsd: null } })).maxCostUsd, null);
  // A declared budget still binds and is still validated.
  assert.deepEqual(campaignLimits(validateDeclaration({ ...d, limits: { maxWorkerRuns: 7, maxCostUsd: 50, unknownRunCostUsd: 3 } })),
    { ...UNLIMITED, maxWorkerRuns: 7, maxCostUsd: 50, unknownRunCostUsd: 3 });
  assert.throws(() => validateDeclaration({ ...d, limits: { maxWorkerRuns: 0 } }), /maxWorkerRuns/);
  assert.throws(() => validateDeclaration({ ...d, limits: { maxCostUsd: 50 } }), /unknownRunCostUsd/);
  assert.throws(() => validateDeclaration({ ...d, limits: { unknownRunCostUsd: 3 } }), /requires maxCostUsd/);
  assert.throws(() => validateDeclaration({ ...d, limits: { slots: 9 } }), /slots/); // 1..8 or "auto" since RUN4
  assert.throws(() => validateDeclaration({ ...d, limits: null }), /limits must be an object/);
  assert.throws(() => validateDeclaration({ ...d, limits: { maxRuns: 3 } }), /unknown limits key/);
  const live = validateDeclaration(JSON.parse(readFileSync(new URL('../../tests/fixtures/campaigns/sample-chain.json', import.meta.url), 'utf8')));
  assert.deepEqual(campaignLimits(live), UNLIMITED);
  assert.equal(live.authorization.version, 4);
});

test('a campaign declared without any limits runs past every former cap', { skip: skipWithoutSqlite }, async (t) => {
  const { limits: _omitted, ...decl } = declaration({ tasks: [declaration().tasks[0]] });
  const { env, store, controller, id } = setup(t, { decl, scenario: { verify: ['reject', 'reject', 'reject', 'reject', 'reject', 'reject', 'accept'] } });
  assert.equal(api.campaignStatus(store, id).maxWorkerRuns, null);
  await runUntil(controller, store, id, (c) => c.control === 'finished', { timeoutMs: 120_000 });
  assert.equal(store.task(id, 'T1').repair_rounds, 6, 'more repairs than the old maximum of five');
  assert.equal(env.calls().filter((c) => c.role === 'verify').length, 7);
  assert.equal(api.campaignStatus(store, id).budget.exhausted, null);
});

test('with no run cap the budget never blocks dispatch', { skip: !SQLITE }, () => {
  const c = { id: 'c', cost_usd: 10_000, runs_used: 5_000, declaration: { limits: NONE } };
  assert.equal(api.campaignBudget({ all: () => [] }, c).exhausted, null);
  assert.equal(api.campaignBudget({ all: () => [] }, { ...c, declaration: {} }).exhausted, null, 'no limits object');
});

test('without a repair limit a rejected deliverable keeps getting repair rounds until it is accepted', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: NONE });
  const { env, store, controller, id } = setup(t, { decl, scenario: { verify: ['reject', 'reject', 'reject', 'reject', 'reject', 'reject', 'accept'] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished', { timeoutMs: 120_000 });
  assert.equal(store.task(id, 'T1').repair_rounds, 6, 'six repairs, more than the old maximum of five');
  assert.equal(env.calls().filter((c) => c.role === 'verify').length, 7);
});

test('without a retry limit a failing task keeps retrying instead of stalling', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: NONE });
  const { env, store, controller, id } = setup(t, { decl, scenario: { implement: ['no-result', 'no-result', 'no-result', 'no-result', 'no-result', 'no-result', 'no-result', 'commit'] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished', { timeoutMs: 120_000 });
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 8);
  assert.equal(store.all("SELECT * FROM journal WHERE kind = 'blocker-raised'").length, 0);
});

test('an amendment that removes the limits releases stalls caused only by those limits', { skip: skipWithoutSqlite }, async (t) => {
  const first = declaration().tasks[0];
  const decl = declaration({ tasks: [first, { ...first, id: 'T2', issue: 438, title: 'second' }],
    limits: { maxWorkerRuns: 12, slots: 1, maxRepairRounds: 1, maxRetriesPerTask: 0 } });
  const { store, controller, id } = setup(t, { decl, scenario: { verify: ['reject', 'reject', 'accept', 'accept'], implement: ['commit', 'commit', 'no-result', 'commit'] } });
  await runUntil(controller, store, id, () => store.tasks(id).every((task) => task.blocked), { timeoutMs: 120_000 });
  assert.match(store.task(id, 'T1').blocked.reason, /verifier still rejects/);
  assert.match(store.task(id, 'T2').blocked.reason, /failed attempts/);
  store.run("UPDATE tasks SET blocked = ? WHERE task_id = 'T2'", { class: 'B3', reason: 'owner-reserved: synthetic', at: Date.now() });
  api.campaignStart(store, { ...decl, authorization: { ...decl.authorization, version: 2 }, limits: NONE });
  assert.equal(store.task(id, 'T1').blocked, null, 'the repair stall is released');
  assert.equal(store.task(id, 'T2').blocked.class, 'B3', 'an owner-reserved block is never released by an amendment');
  assert.ok(store.all("SELECT kind FROM journal WHERE kind = 'stall-released'").length === 1);
  await runUntil(controller, store, id, () => store.task(id, 'T1').state === 'done', { timeoutMs: 120_000 });
});

test('a task that keeps returning evidence-unavailable stops for an owner decision even without limits (historical regression)', { skip: skipWithoutSqlite }, async (t) => {
  const { limits: _omitted, ...decl } = declaration({ tasks: [declaration().tasks[0]] });
  const { env, store, controller, id } = setup(t, { decl, scenario: { implement: ['unavailable', 'unavailable', 'unavailable', 'unavailable', 'commit'] } });
  const blocked = await runUntil(controller, store, id, (c) => c.status === 'blocked-owner-decision', { timeoutMs: 120_000 });
  assert.ok(blocked);
  const task = store.task(id, 'T1');
  assert.equal(task.blocked.class, 'B3');
  assert.match(task.blocked.reason, /no progress: 4 evidence-unavailable results; last: synthetic: no cohort assigned/);
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 4, 'exactly four attempts, then it stops');
  const runs = store.campaign(id).runs_used;
  for (let i = 0; i < 5; i++) await controller.tick();
  assert.equal(store.campaign(id).runs_used, runs, 'no further dispatch while it waits for the owner');
  api.campaignRecheck(store, id, { task: 'T1', note: 'cohort assigned' });
  await runUntil(controller, store, id, (c) => c.control === 'finished', { timeoutMs: 120_000 });
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 5, 'a recheck naming the task resets the count and resumes it');
});

test('the worker contract routes authorization and owner-decision blockers to blocked-owner-reserved (historical regression)', async () => {
  const { buildPrompt } = await import('../../src/supervisor/adapters/claude.mjs');
  const packet = { goal: 'g', constraints: [], acceptance: ['a'], references: [] };
  const prompt = buildPrompt({ role: 'implementer', deliverable: 'commit', packet, packetDigest: 'd'.repeat(64), repository: 'example-org/sampleapp',
    issue: 1, branch: 'b', baseSha: 'a'.repeat(40), targetSha: null, report: null, reportDigest: null, note: null, instructions: [] });
  assert.match(prompt, /authorization scope or a decision only the owner can make, return blocked-owner-reserved instead/);
});
