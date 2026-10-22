// MOD7 (MODEL_ROUTING slice R7): routed dispatch's activation-critical cases, on a real controller over a disposable
// repository with the synthetic claude executable. The cohort is the documentation/design kind the first live cohort uses:
// one commit task inside docs/. Three fictional models of one declared provider are the candidates. No model, network or
// GitHub call is made, and no measurement is claimed: the costs are the fixture's.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { declaration, environment, runUntil, SQLITE, skipWithoutSqlite, sleep } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const { setAccountWait } = SQLITE ? await import('../../src/supervisor/accounts.mjs') : {};

const SMALL = 'synthetic-small';
const MEDIUM = 'synthetic-medium';
const LARGE = 'synthetic-large';

/** A documentation cohort campaign: routing on, three tiers of one provider, one docs task, an exact run budget. */
function cohort(campaignId, maxWorkerRuns) {
  const d = declaration({ campaignId, limits: { maxWorkerRuns, maxRepairRounds: 3, maxRetriesPerTask: 3 }, tasks: [
    { id: 'D1', issue: 437, title: 'design note', deliverable: 'commit', goal: 'Write the synthetic design note.', dependsOn: [],
      acceptance: ['the note exists'], references: ['AGENTS.md'], writes: ['docs/'] },
  ] });
  d.routing = { mode: 'auto', sensitivePaths: ['src/supervisor/'], pin: null, candidates: [
    { kind: 'claude-cli', model: SMALL, tier: 1 }, { kind: 'claude-cli', model: MEDIUM, tier: 2 }, { kind: 'claude-cli', model: LARGE, tier: 3 },
  ] };
  return d;
}

function setup(t, campaignId, maxWorkerRuns, byModel) {
  const env = environment({ scenario: { commitDir: 'docs/design', byModel } });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const decl = cohort(campaignId, maxWorkerRuns);
  campaignStart(store, decl);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  return { env, store, controller, id: campaignId };
}

const modelOf = (call) => call.args[call.args.indexOf('--model') + 1];
const operations = (store, id) => store.all('SELECT id, kind, session_id, target_sha, outcome, routing FROM operations WHERE campaign_id = ? ORDER BY seq', id);

test('a routed cohort picks the eligible model, sidesteps a refused one, escalates after rejections and verifies the exact head', { skip: skipWithoutSqlite }, async (t) => {
  // The small model is not on the account; the medium one's work is rejected twice; the large one's is accepted.
  // Six runs are the budget: three implement and three verify runs. A charged refusal would exhaust it before acceptance.
  const { env, store, controller, id } = setup(t, 'routed-docs', 6, {
    [SMALL]: { implement: ['unknown-model'] },
    [MEDIUM]: { implement: ['commit', 'commit'], verify: ['reject', 'reject', 'accept'] },
    [LARGE]: { implement: ['commit'] },
  });
  const campaign = await runUntil(controller, store, id, (c) => c.control === 'finished', { timeoutMs: 120_000 });

  const calls = env.calls();
  assert.deepEqual(calls.map((call) => [call.role, modelOf(call)]), [
    ['implement', SMALL], // cold start: the lowest tier at the R0/C1 floor
    ['implement', MEDIUM], // the refused model waits alone; the next eligible tier runs
    ['verify', MEDIUM], // the verifier floor is tier 2
    ['implement', MEDIUM],
    ['verify', MEDIUM],
    ['implement', LARGE], // two rejected results on tier 2 move the step up, never down
    ['verify', MEDIUM],
  ]);
  assert.equal(campaign.runs_used, 6, 'the refusal was refunded; every other run was charged once');
  assert.ok(store.get("SELECT 1 AS n FROM executor_waits WHERE campaign_id = ? AND executor_kind = ?", id, `claude-cli/${SMALL}`),
    'only the refused model waits');
  assert.ok(store.all('SELECT kind FROM journal WHERE campaign_id = ?', id).some((row) => row.kind === 'model-unavailable'));

  const ops = operations(store, id);
  for (const op of ops) {
    assert.equal(op.routing.policy, 'routing-policy/1');
    assert.equal(op.routing.mode, 'auto');
    // No history yet: the expected cost is unknown, never zero or invented.
    for (const row of op.routing.decision.costs) assert.equal(row.expectedCost, null);
  }
  assert.equal(ops.at(-2).routing.decision.escalation.escalated, true);
  assert.equal(ops.at(-2).routing.decision.escalation.tier, 3);
  // Each review is a fresh session on the exact head the implement attempt before it produced.
  const sessions = ops.filter((op) => op.kind === 'implement').map((op) => op.session_id);
  for (const [index, op] of ops.entries()) {
    if (op.kind !== 'verify') continue;
    assert.ok(!sessions.includes(op.session_id), 'the verifier session is new');
    assert.equal(op.target_sha, ops[index - 1].outcome.value.headSha, 'the verifier reviews the exact head');
    const head = ops[index - 1].routing.decision.chosen.model;
    assert.equal(op.routing.decision.independence, op.routing.decision.chosen.model === head ? 'fresh-session-same-model' : 'different-model');
  }
  assert.equal(store.task(id, 'D1').verified_sha, ops.at(-2).outcome.value.headSha, 'only the accepted head is verified');
});

test('an account wait holds every model on it and no declared model that fits runs nothing at all', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id } = setup(t, 'routed-refusal', 1, {
    [SMALL]: { implement: ['unknown-model'] }, [MEDIUM]: { implement: ['unknown-model'] }, [LARGE]: { implement: ['unknown-model'] },
  });
  // A usage limit on the shared account: no other model on the same login is tried while it lasts.
  const until = Date.now() + 2000;
  setAccountWait(store, env.config, { kind: 'claude-cli', retryAt: until, reason: 'quota: synthetic usage limit', campaignId: id, now: Date.now() });
  await controller.tick();
  assert.equal(store.get('SELECT COUNT(*) AS n FROM operations WHERE campaign_id = ?', id).n, 0, 'nothing is dispatched during the wait');
  assert.equal(controller.accountHoldUntil('claude-cli'), until, 'the account wait holds the campaign and bounds the retry');
  await sleep(until - Date.now() + 50);

  // After it, every declared model is refused in turn: each refusal is refunded, and the step stops on one owner blocker
  // instead of reaching for a model, provider or budget the declaration does not grant. The budget of one run is untouched.
  const campaign = await runUntil(controller, store, id, (c) => c.blocker);
  assert.deepEqual(env.calls().map((call) => [call.role, modelOf(call)]), [['implement', SMALL], ['implement', MEDIUM], ['implement', LARGE]]);
  assert.equal(store.campaign(id).runs_used, 0);
  assert.equal(store.task(id, 'D1').state, 'pending');
  assert.equal(campaign.blocker.class, 'B2');
  assert.equal(campaign.status, 'blocked-owner-action');
  for (let i = 0; i < 5; i += 1) await controller.tick();
  assert.equal(env.calls().length, 3, 'a refused cohort is not retried on its own');
});
