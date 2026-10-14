// Owner decision 2026-10-10: no campaign capacity limits by default. Every limit is optional; omitted or null
// means no limit, and only provider subscription/usage limits stop work. A budget exists only when declared. Synthetic workers only; no model, network or GitHub access.
// The retry, amendment and no-progress cases are in unlimited-retries.test.mjs (harness in unlimited-harness.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { campaignLimits, validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { declaration, runUntil, SQLITE, skipWithoutSqlite } from './helpers.mjs';
import { api, NONE, setup } from './unlimited-harness.mjs';

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
