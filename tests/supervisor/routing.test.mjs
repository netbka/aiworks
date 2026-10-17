// Model routing at dispatch (docs/design/MODEL_ROUTING.md slice R5): a campaign with routing.mode "auto" runs the
// router's model, moves up only on recorded poor-quality outcomes, checks host support before the choice, and holds a
// model the provider refused. No model call decides routing. Synthetic executables and disposable stores and
// repositories only; no model, network or GitHub call.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { classify, runNotCounted } from '../../src/supervisor/adapters/executors.mjs';
import { POLICY, replay } from '../../src/supervisor/router.mjs';
import { declaration, environment, runUntil, SQLITE, skipWithoutSqlite, sleep } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};

const claudeTiers = [{ kind: 'claude-cli', model: 'haiku', tier: 1 }, { kind: 'claude-cli', model: 'sonnet', tier: 2 },
  { kind: 'claude-cli', model: 'opus', tier: 3 }];
const routing = (changes = {}) => ({ mode: 'auto', candidates: claudeTiers, sensitivePaths: ['src/supervisor/'], ...changes });
// A key set to undefined is left out (a report task declares no writes).
const task = (changes = {}) => Object.fromEntries(Object.entries({ id: 'T1', issue: 437, title: 'fix a typo', deliverable: 'commit', writes: ['docs/'],
  goal: 'Fix one typo in the docs.', dependsOn: [], acceptance: ['the typo is fixed'], references: ['AGENTS.md'], ...changes }).filter(([, value]) => value !== undefined));
// Claude and a synthetic Codex: a report task may run on either, on Windows and Linux alike.
const chain = { kind: 'cli-chain', providers: [{ kind: 'claude-cli', model: 'opus', permissionMode: 'auto' }, { kind: 'codex-cli' }],
  implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
const valueOf = (list, flag) => { const index = list.indexOf(flag); return index >= 0 ? list[index + 1] : null; };

/** A disposable campaign. `stub` replaces the worker launch, so outcomes are applied by the test (finish). */
function fixture(t, { tasks = [task()], routed = routing(), executor = null, scenario = {}, stub = false } = {}) {
  const env = environment({ scenario });
  const homes = { CODEX_HOME: process.env.CODEX_HOME, CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR };
  for (const key of Object.keys(homes)) process.env[key] = join(env.tmp, key);
  env.config.commands.codex = ['synthetic-codex'];
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = declaration({ tasks });
  if (executor) d.executor = structuredClone(executor);
  d.routing = structuredClone(routed);
  campaignStart(store, d);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir });
  if (stub) controller.launch = async () => {};
  t.after(() => {
    controller.release(); store.close(); env.cleanup();
    for (const [key, value] of Object.entries(homes)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const ops = (kind = null) => store.all('SELECT * FROM operations WHERE campaign_id = ? ORDER BY created_at, seq', d.campaignId)
    .filter((op) => !kind || op.kind === kind);
  const finish = (op, outcome) => controller.applyOutcome({ id: d.campaignId, generation: controller.held.get(d.campaignId) }, op, { receipt: {}, ...outcome });
  const models = (role) => env.calls().filter((call) => call.role === role).map((call) => valueOf(call.args, '--model'));
  return { env, store, d, controller, id: d.campaignId, ops, finish, models };
}

/** Every routed operation stores a routing-policy/1 receipt that replays to its decision and names the model it ran. */
function assertRouted(op) {
  assert.equal(op.routing.mode, 'auto');
  assert.equal(op.routing.policy, POLICY);
  assert.deepEqual(replay(op.routing), op.routing.decision, `${op.id} replays from its receipt alone`);
  assert.equal(op.routing.decision.chosen.kind, op.executor_kind);
  const argv = JSON.parse(readFileSync(join(op.run_dir, 'spec.json'), 'utf8')).argv;
  if (op.executor_kind === 'claude-cli') assert.equal(valueOf(argv, '--model'), op.routing.decision.chosen.model, `${op.id} runs the receipt's model`);
}

test('an unknown-model refusal of a routed run is unavailability of that candidate; unrouted runs are unchanged', () => {
  const run = { exitCode: 1 };
  const stdoutText = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, session_id: 's', num_turns: 1, total_cost_usd: 0,
    result: "There's an issue with the selected model (claude-nope). It may not exist or you may not have access to it." });
  const args = { executorKind: 'claude-cli', role: 'implementer', run, stdoutText, stderrText: '', expect: { deliverable: 'commit' }, now: 1000 };
  const routed = classify({ ...args, routed: true });
  assert.equal(routed.class, 'unavailable');
  assert.equal(routed.modelUnavailable, true);
  assert.equal(runNotCounted(routed), true, 'no task attempt took place, so the run is not charged');
  assert.equal(classify(args).class, 'error', 'a campaign without routing classifies exactly as before');
  const codex = classify({ ...args, executorKind: 'codex-cli', routed: true, stdoutText: '',
    stderrText: 'ERROR: The model `gpt-nope` does not exist or you do not have access to it.' });
  assert.equal(codex.class, 'unavailable');
  // A denial is never unavailability, and an ordinary failure stays a task failure.
  const denied = classify({ ...args, routed: true, stdoutText: JSON.stringify({ type: 'result', is_error: true, result: 'permission denied for the selected model' }) });
  assert.equal(denied.class, 'error');
  const failed = classify({ ...args, routed: true, stdoutText: JSON.stringify({ type: 'result', is_error: true, result: 'tests failed' }) });
  assert.equal(failed.class, 'error');
});

test('a trivial task starts on tier 1 and its check on tier 2; idle ticks call no model and read no history', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id, ops, models, env } = fixture(t, { scenario: { commitDir: 'docs' } });
  let historyReads = 0;
  const read = controller.routingHistory.bind(controller);
  controller.routingHistory = (...args) => { historyReads += 1; return read(...args); };
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.deepEqual(models('implement'), ['haiku']);
  assert.deepEqual(models('verify'), ['sonnet']);
  const [implement, verify] = ops();
  for (const op of ops()) assertRouted(op);
  assert.deepEqual(implement.routing.decision.indicators, { risk: 'R0', complexity: 'C1' });
  assert.equal(implement.routing.decision.basis, 'cold-start');
  assert.deepEqual(verify.routing.inputs.implementerSessions, [implement.session_id]);
  assert.notEqual(verify.session_id, implement.session_id);
  assert.deepEqual(verify.routing.inputs.headImplementer, { session: implement.session_id, kind: 'claude-cli', model: 'haiku' });
  const recorded = store.all("SELECT detail FROM journal WHERE kind = 'operation-recorded'").map((row) => row.detail.model);
  assert.deepEqual(recorded, ['haiku', 'sonnet'], 'the journal names each model');
  assert.equal(historyReads, 2, 'history is read once per dispatch');
  const calls = env.calls().length;
  for (let i = 0; i < 25; i += 1) await controller.tick();
  assert.equal(env.calls().length, calls, 'no model call on idle ticks');
  assert.equal(historyReads, 2, 'no history read on idle ticks');
  assert.equal(ops().length, 2);
});

test('a later step reads the recorded outcomes of earlier steps as aggregated history, never its own', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id, ops } = fixture(t, { tasks: [task(), task({ id: 'T2', issue: 438, title: 'fix another typo',
    goal: 'Fix another typo in the docs.', dependsOn: ['T1'] })], scenario: { commitDir: 'docs' } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const [first, , second] = ops();
  assert.deepEqual(first.routing.inputs.history, [], 'the first step has no history');
  const [implementRow, verifyRow] = second.routing.inputs.history;
  assert.deepEqual({ ...implementRow, window: undefined }, { kind: 'claude-cli', model: 'haiku', class: 'implement/R0/C1', attempts: 1, accepted: 1,
    cost: { unit: 'usd-reported', known: 1, unknown: 0, mean: 0.01 }, medianMs: implementRow.medianMs, window: undefined });
  assert.deepEqual(implementRow.window, { fromOp: first.id, toOp: first.id, to: first.updated_at });
  assert.deepEqual([verifyRow.model, verifyRow.class, verifyRow.attempts, verifyRow.accepted], ['sonnet', 'verify/R0/C1', 1, 1]);
  assert.deepEqual(second.routing.decision.chosen, { kind: 'claude-cli', model: 'haiku', tier: 1 });
  assert.deepEqual(replay(second.routing), second.routing.decision);
});

test('a supervisor task starts on the strongest tier, and its check is a fresh session', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id, ops, models } = fixture(t, { tasks: [task({ title: 'supervisor change', writes: ['src/supervisor/'] })],
    scenario: { commitDir: 'src/supervisor' } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.deepEqual(models('implement'), ['opus']);
  assert.deepEqual(models('verify'), ['opus'], 'tier 3 has one candidate: the same model checks in a new session');
  const [implement, verify] = ops();
  for (const op of ops()) assertRouted(op);
  assert.equal(implement.routing.decision.indicators.risk, 'R2');
  assert.equal(implement.routing.decision.floor, 3);
  assert.equal(verify.routing.decision.independence, 'fresh-session-same-model');
  assert.notEqual(verify.session_id, implement.session_id);
});

test('two rejected heads move the repair up one tier; the verifier stays on its own floor', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id, ops, models } = fixture(t, { scenario: { commitDir: 'docs', verify: ['reject', 'reject', 'accept'] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.deepEqual(models('implement'), ['haiku', 'haiku', 'sonnet'], 'one rejection stays (no other tier-1 candidate); the second moves up');
  assert.deepEqual(models('verify'), ['sonnet', 'sonnet', 'sonnet'], 'a rejection is a useful review, not a verifier failure');
  const implement = ops('implement');
  for (const op of ops()) assertRouted(op);
  assert.deepEqual(implement[1].routing.inputs.escalation.priorAttempts.map((item) => item.terminal), ['rejected']);
  assert.equal(implement[1].routing.decision.escalation.escalated, false);
  assert.deepEqual(implement[2].routing.inputs.escalation.priorAttempts.map((item) => [item.model, item.terminal]),
    [['haiku', 'rejected'], ['haiku', 'rejected']], 'the escalation comes from the recorded outcomes alone');
  assert.equal(implement[2].routing.decision.escalation.tier, 2);
  assert.match(implement[2].routing.decision.reason, /moved up to tier 2/);
});

test('a denial never moves the task to another model', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id, ops, finish } = fixture(t, { stub: true });
  await controller.tick();
  for (let i = 0; i < 2; i += 1) {
    finish(store.openOperations(id)[0], { class: 'error', detail: 'executor permission or sandbox denial' });
    await sleep(100); // retryBackoffMs in FAST
    await controller.tick();
  }
  const all = ops();
  assert.deepEqual(all.map((op) => op.routing.decision.chosen.model), ['haiku', 'haiku', 'haiku']);
  assert.ok(all[2].routing.inputs.escalation.priorAttempts.every((item) => item.denied));
  assert.equal(all[2].routing.decision.escalation.escalated, false);
  assert.notEqual(all[2].routing.decision.basis, 'sidestep');
  for (const op of all) assert.deepEqual(replay(op.routing), op.routing.decision);
});

test('a quota moves to the next eligible candidate, and the first returns after the reset', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id, ops, finish } = fixture(t, { stub: true, executor: chain, tasks: [task({ deliverable: 'report', writes: undefined })],
    routed: routing({ candidates: [claudeTiers[0], { kind: 'codex-cli', model: 'gpt-synthetic', tier: 1 }, claudeTiers[1]] }) });
  await controller.tick();
  finish(store.openOperations(id)[0], { class: 'quota', retryAt: Date.now() + 400, detail: 'synthetic usage limit' });
  await controller.tick();
  const fallback = store.openOperations(id)[0];
  assert.deepEqual([fallback.executor_kind, fallback.routing.decision.chosen.model], ['codex-cli', 'gpt-synthetic']);
  assert.ok(fallback.routing.decision.eligibility.find((item) => item.model === 'haiku' && item.role === 'implementer').reasons.includes('account-wait'));
  assert.equal(fallback.routing.decision.escalation.escalated, false, 'a usage limit is not a quality signal');
  await sleep(450);
  finish(fallback, { class: 'error', detail: 'synthetic failure' });
  await sleep(100);
  await controller.tick();
  const all = ops();
  assert.deepEqual(all.map((op) => [op.executor_kind, op.routing.decision.chosen.model]),
    [['claude-cli', 'haiku'], ['codex-cli', 'gpt-synthetic'], ['claude-cli', 'haiku']]);
  assert.ok(all.every((op) => op.routing.decision.chosen.tier === 1), 'nothing moved up a tier');
  for (const op of all) assert.deepEqual(replay(op.routing), op.routing.decision);
});

test('a pinned model holds through its account wait and never falls back', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id, ops, finish } = fixture(t, { stub: true, executor: chain, tasks: [task({ deliverable: 'report', writes: undefined })],
    routed: routing({ candidates: [claudeTiers[0], { kind: 'codex-cli', model: 'gpt-synthetic', tier: 1 }],
      pin: { implementer: { kind: 'claude-cli', model: 'haiku' } } }) });
  await controller.tick();
  // The wait must outlast five ticks on a loaded host, so it is long and the test sleeps only until it ends.
  const resetAt = Date.now() + 3000;
  finish(store.openOperations(id)[0], { class: 'quota', retryAt: resetAt, detail: 'synthetic usage limit' });
  for (let i = 0; i < 5; i += 1) await controller.tick();
  assert.equal(ops().length, 1, 'the step waits for its pinned model');
  assert.ok(store.task(id, 'T1').retry_at > Date.now() - 1000);
  await sleep(Math.max(0, resetAt - Date.now()) + 50);
  await controller.tick();
  assert.deepEqual(ops().map((op) => [op.executor_kind, op.routing.decision.chosen.model]), [['claude-cli', 'haiku'], ['claude-cli', 'haiku']]);
  assert.equal(ops()[1].routing.decision.basis, 'pin');
});

test('host support is checked before the choice: a Codex with project extensions is passed over in the same tick', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id, ops } = fixture(t, { stub: true, executor: { ...chain, providers: [...chain.providers].reverse() },
    tasks: [task({ deliverable: 'report', writes: undefined })],
    routed: routing({ candidates: [{ kind: 'codex-cli', model: 'gpt-synthetic', tier: 1 }, claudeTiers[0]] }) });
  mkdirSync(join(env.repo, '.codex'), { recursive: true });
  writeFileSync(join(env.repo, '.codex', 'config.toml'), 'model = "unreviewed"\n');
  await controller.tick();
  const [op] = ops();
  assert.deepEqual([op.executor_kind, op.routing.decision.chosen.model], ['claude-cli', 'haiku']);
  const codex = op.routing.decision.eligibility.find((item) => item.kind === 'codex-cli' && item.role === 'implementer');
  assert.ok(codex.reasons.includes('host-unavailable'), JSON.stringify(codex));
  assert.equal(op.routing.inputs.hostFacts.find((item) => item.kind === 'codex-cli').hostUnavailable, 'project CLI extensions require a scoped adapter policy');
  assert.equal(store.get("SELECT reason FROM executor_waits WHERE campaign_id = ? AND executor_kind = 'codex-cli'", id).reason,
    'project CLI extensions require a scoped adapter policy');
});

test('a model the provider refuses waits alone until a recheck; the task continues on another model', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id, ops, models } = fixture(t, { scenario: { commitDir: 'docs', byModel: { haiku: { implement: ['unknown-model'] } } } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.deepEqual(models('implement'), ['haiku', 'sonnet']);
  const [refused, next] = ops('implement');
  assert.equal(refused.outcome.class, 'unavailable');
  assert.equal(refused.outcome.refunded, true);
  assert.equal(store.campaign(id).runs_used, 2, 'the refused run is not counted: one implement and one verify run');
  const wait = store.get("SELECT * FROM executor_waits WHERE campaign_id = ? AND executor_kind = 'claude-cli/haiku'", id);
  assert.equal(wait.retry_at, null, 'untimed until a recheck, so it does not loop');
  assert.ok(!store.get("SELECT 1 AS found FROM executor_waits WHERE campaign_id = ? AND executor_kind = 'claude-cli'", id),
    'the provider\'s other models do not wait');
  assert.ok(next.routing.decision.eligibility.find((item) => item.model === 'haiku' && item.role === 'implementer').reasons.includes('account-wait'));
  assert.equal(next.routing.decision.escalation.escalated, false, 'an unavailable model is not a quality signal');
  assert.equal(store.all("SELECT * FROM journal WHERE kind = 'model-unavailable'").length, 1);
  for (const op of ops()) assertRouted(op);
});

test('a restart launches the recorded operation with its recorded model, never a new choice', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, d, controller, id, ops, models } = fixture(t, { scenario: { commitDir: 'docs' } });
  const launch = controller.launch;
  controller.launch = async () => {}; // the controller dies between record and launch
  await controller.tick();
  const [recorded] = ops();
  assert.equal(recorded.state, 'recorded');
  assert.equal(recorded.routing.decision.chosen.model, 'haiku');
  controller.release();
  controller.launch = launch;
  // Were the choice made again, haiku would now be passed over.
  store.run('INSERT INTO executor_waits (campaign_id, executor_kind, retry_at, reason) VALUES (?, ?, NULL, ?)', id, 'claude-cli/haiku', 'unavailable: synthetic');
  const restarted = new Controller({ store, config: env.config, dataDir: env.dataDir });
  try { await runUntil(restarted, store, d.campaignId, (c) => c.control === 'finished'); }
  finally { restarted.release(); }
  assert.deepEqual(ops('implement').map((op) => op.id), [recorded.id], 'the recorded operation itself ran');
  assert.deepEqual(ops('implement')[0].routing, recorded.routing, 'its receipt did not change');
  assert.deepEqual(models('implement'), ['haiku'], 'the relaunch runs the recorded model');
});
