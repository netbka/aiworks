// Routing receipts in static mode (docs/design/MODEL_ROUTING.md section 9, slice R2): every new operation stores a
// receipt naming today's choice and model, route(receipt.inputs) replays it, and dispatch behaviour is unchanged.
// Synthetic executables and disposable stores and repositories only; no model, network or GitHub call.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { canonicalJson } from '../../src/supervisor/campaign.mjs';
import { route, staticReceipt, STATIC_POLICY } from '../../src/supervisor/router.mjs';
import { declaration, environment, runtimeCheckout, SQLITE, skipWithoutSqlite, sleep } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const chain = { kind: 'cli-chain', providers: [{ kind: 'codex-cli' }, { kind: 'claude-cli', model: 'opus', permissionMode: 'auto' }, { kind: 'cursor-cli' }],
  implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
const sha256 = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
const deepFreeze = (value) => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
};

/** Receipt inputs as the controller builds them, for a pure route() test. */
const inputs = ({ deliverable = 'commit', web = false, platform = 'win32', chain: isChain = true, priorAttempts = [], waits = {} } = {}) => ({
  stage: 'implement', chain: isChain, task: { deliverable, web },
  candidates: [
    { kind: 'codex-cli', model: null, tier: null, researchOnly: false },
    { kind: 'claude-cli', model: 'opus', tier: null, researchOnly: false },
    { kind: 'cursor-cli', model: null, tier: null, researchOnly: false },
    { kind: 'agy-cli', model: 'gemini', tier: null, researchOnly: false },
  ],
  candidatesDigest: 'synthetic', platform,
  hostFacts: ['codex-cli', 'claude-cli', 'cursor-cli', 'agy-cli'].map((kind) => ({ kind, cliConfigured: true, hostUnavailable: null, wait: waits[kind] ?? null })),
  escalation: { priorAttempts },
});
const attempt = (kind, changes = {}) => ({ op: `op-${kind}`, kind, model: null, class: 'error', terminal: null, denied: false, tier: null, ...changes });

test('route takes its inputs as its only argument and reads nothing else', () => {
  assert.equal(route.length, 1);
  const frozen = deepFreeze(inputs({ deliverable: 'report' }));
  const first = route(frozen);
  assert.deepEqual(route(structuredClone(frozen)), first, 'the same inputs give the same decision');
  assert.deepEqual(first.chosen, { kind: 'codex-cli', model: null, tier: null });
  assert.equal(first.basis, 'declared-order');
  const receipt = staticReceipt(frozen);
  assert.equal(receipt.mode, 'static');
  assert.equal(receipt.policy, STATIC_POLICY);
  assert.equal(receipt.inputsDigest, sha256(frozen));
  assert.deepEqual(receipt.decision, first);
});

test('eligibility lists both roles, and only Codex commit support depends on the platform', () => {
  const windows = route(inputs({ platform: 'win32' }));
  const linux = route(inputs({ platform: 'linux' }));
  assert.equal(windows.eligibility.length, 8, 'four candidates, two roles each');
  for (const kind of ['codex-cli', 'claude-cli', 'cursor-cli', 'agy-cli']) {
    assert.deepEqual(windows.eligibility.filter((item) => item.kind === kind).map((item) => item.role), ['implementer', 'verification']);
  }
  const changed = windows.eligibility.map((item, index) => [item, linux.eligibility[index]])
    .filter(([a, b]) => JSON.stringify(a) !== JSON.stringify(b));
  assert.deepEqual(changed, [[
    { kind: 'codex-cli', model: null, role: 'implementer', reasons: ['role-unsupported'] },
    { kind: 'codex-cli', model: null, role: 'implementer', reasons: [] },
  ], [
    // Codex cannot run the repository's tests in its read-only sandbox on Windows (#113).
    { kind: 'codex-cli', model: null, role: 'verification', reasons: ['role-unsupported'] },
    { kind: 'codex-cli', model: null, role: 'verification', reasons: [] },
  ]]);
  assert.deepEqual(windows.eligibility.find((item) => item.kind === 'cursor-cli' && item.role === 'implementer').reasons, ['role-unsupported']);
  assert.deepEqual(windows.eligibility.find((item) => item.kind === 'agy-cli' && item.role === 'implementer').reasons, ['web-mismatch', 'role-unsupported']);
  assert.equal(windows.chosen.kind, 'claude-cli', 'on Windows Codex cannot commit, so Claude implements');
  assert.equal(linux.chosen.kind, 'codex-cli');
});

test('static mode moves a failed provider behind the others from priorAttempts alone, and never after a denial', () => {
  const report = { deliverable: 'report' };
  const failed = route(inputs({ ...report, priorAttempts: [attempt('codex-cli'), attempt('claude-cli')] }));
  assert.deepEqual([failed.chosen.kind, failed.basis, failed.avoided], ['claude-cli', 'failed-provider-last', 'codex-cli'], 'only the newest attempt counts');
  const unusable = route(inputs({ ...report, priorAttempts: [attempt('codex-cli', { class: 'result', terminal: 'evidence-unavailable' })] }));
  assert.equal(unusable.chosen.kind, 'claude-cli');
  for (const kept of [{ denied: true }, { class: 'quota' }, { class: 'auth' }, { class: 'unavailable' }, { class: 'result', terminal: 'resolved' }, { class: null }]) {
    const decision = route(inputs({ ...report, priorAttempts: [attempt('codex-cli', kept)] }));
    assert.deepEqual([decision.chosen.kind, decision.basis, decision.avoided], ['codex-cli', 'declared-order', null], JSON.stringify(kept));
  }
  const single = route(inputs({ ...report, chain: false, priorAttempts: [attempt('codex-cli')] }));
  assert.equal(single.chosen.kind, 'codex-cli', 'a single-provider campaign is never reordered');
  const others = { 'claude-cli': { retryAt: 5, reason: 'quota: synthetic' }, 'cursor-cli': { retryAt: null, reason: 'auth: synthetic' } };
  const only = route(inputs({ ...report, waits: others, priorAttempts: [attempt('codex-cli')] }));
  assert.deepEqual([only.chosen.kind, only.basis], ['codex-cli', 'failed-provider-only']);
  const none = route(inputs({ ...report, waits: { ...others, 'codex-cli': { retryAt: 9, reason: 'quota: synthetic' } } }));
  assert.deepEqual([none.chosen, none.retryAt], [null, 5], 'the earliest timed wait bounds the retry');
});

function fixture(t, tasks = [{ ...declaration().tasks[0], deliverable: 'report' }]) {
  const env = environment();
  const oldHomes = { CODEX_HOME: process.env.CODEX_HOME, CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR };
  for (const key of Object.keys(oldHomes)) process.env[key] = join(env.tmp, key);
  t.after(() => { for (const [key, value] of Object.entries(oldHomes)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  env.config.commands.codex = ['synthetic-codex'];
  env.config.commands.cursor = ['synthetic-cursor'];
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = declaration({ tasks });
  d.executor = structuredClone(chain);
  campaignStart(store, d);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir });
  controller.launch = async () => {}; // Exercise durable dispatch without an external model process.
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  const ops = () => store.all('SELECT * FROM operations WHERE campaign_id = ? ORDER BY created_at', d.campaignId);
  const finish = (op, outcome) => controller.applyOutcome({ id: d.campaignId, generation: controller.held.get(d.campaignId) }, op, { receipt: {}, ...outcome });
  return { env, store, d, controller, id: d.campaignId, ops, finish };
}

/** Every receipt replays to its own decision, and that decision is the executor and model the operation runs. */
function assertReplays(store, d, op) {
  const receipt = op.routing;
  assert.equal(receipt.mode, 'static');
  assert.deepEqual(route(receipt.inputs), receipt.decision, `${op.id} replays`);
  assert.equal(receipt.inputsDigest, sha256(receipt.inputs));
  assert.equal(receipt.decision.chosen.kind, op.executor_kind);
  const provider = chain.providers.find((item) => item.kind === op.executor_kind);
  assert.equal(receipt.decision.chosen.model, provider.model ?? null);
  const argv = JSON.parse(readFileSync(join(op.run_dir, 'spec.json'), 'utf8')).argv;
  const at = argv.indexOf('--model');
  assert.equal(at >= 0 ? argv[at + 1] : null, receipt.decision.chosen.model, `${op.id} runs the receipt's model`);
  assert.equal(receipt.inputs.platform, process.platform);
  assert.deepEqual(receipt.inputs.candidates.map((item) => [item.kind, item.model, item.researchOnly]),
    chain.providers.map((item) => [item.kind, item.model ?? null, false]));
  assert.deepEqual(receipt.inputs.hostFacts.map((item) => item.kind), chain.providers.map((item) => item.kind));
  assert.equal(receipt.decision.eligibility.length, 2 * chain.providers.length, 'both roles per candidate');
  const recorded = store.all("SELECT detail FROM journal WHERE kind = 'operation-recorded'").find((row) => row.detail.op === op.id);
  assert.equal(recorded.detail.model, receipt.decision.chosen.model, 'the journal names the model');
}

test('every operation of a chain campaign with fallback stores a receipt that replays to the executor actually run', { skip: skipWithoutSqlite }, async (t) => {
  const { store, d, controller, id, ops, finish } = fixture(t);
  await controller.tick();
  for (const kind of ['codex-cli', 'claude-cli', 'cursor-cli']) {
    const op = store.openOperations(id)[0];
    assert.equal(op.executor_kind, kind);
    finish(op, { class: 'quota', retryAt: Date.now() + 60_000, detail: 'synthetic quota' });
    await controller.tick();
  }
  const all = ops();
  assert.deepEqual(all.map((op) => op.executor_kind), ['codex-cli', 'claude-cli', 'cursor-cli']);
  for (const op of all) assertReplays(store, d, op);
  const [, second, third] = all.map((op) => op.routing);
  assert.deepEqual(second.inputs.escalation.priorAttempts.map((item) => [item.kind, item.class]), [['codex-cli', 'quota']]);
  assert.equal(second.decision.basis, 'declared-order', 'a quota is not a task-level failure');
  assert.deepEqual(second.decision.eligibility.find((item) => item.kind === 'codex-cli' && item.role === 'implementer').reasons, ['account-wait']);
  assert.deepEqual(third.inputs.escalation.priorAttempts.map((item) => [item.kind, item.model]), [['claude-cli', 'opus'], ['codex-cli', null]],
    'newest first, each with the model of its own receipt');
});

test('a retry after a task-level failure moves the failed provider behind the others; a retry after a denial keeps the order', { skip: skipWithoutSqlite }, async (t) => {
  const { store, d, controller, id, ops, finish } = fixture(t);
  await controller.tick();
  finish(store.openOperations(id)[0], { class: 'error', detail: 'failed tests' });
  await sleep(100); // retryBackoffMs in FAST
  await controller.tick();
  const failed = ops()[1];
  assert.equal(failed.executor_kind, 'claude-cli');
  assert.deepEqual([failed.routing.decision.basis, failed.routing.decision.avoided], ['failed-provider-last', 'codex-cli']);
  assert.ok(failed.routing.inputs.hostFacts.every((item) => item.wait === null), 'no provider waits: the move comes from priorAttempts');
  assert.equal(route({ ...failed.routing.inputs, escalation: { priorAttempts: [] } }).chosen.kind, 'codex-cli');

  finish(failed, { class: 'error', detail: 'permission denied by the sandbox' });
  await sleep(100);
  await controller.tick();
  const denied = ops()[2];
  assert.equal(denied.routing.inputs.escalation.priorAttempts[0].denied, true);
  assert.equal(denied.executor_kind, 'codex-cli', 'never route around a denial');
  assert.equal(denied.routing.decision.basis, 'declared-order');
  for (const op of ops()) assertReplays(store, d, op);
});

test('a store from before receipts opens, and its operations read routing as null', { skip: !SQLITE }, (t) => {
  const env = environment();
  t.after(() => env.cleanup());
  const path = join(env.dataDir, 'legacy.db');
  const old = new Store(path);
  campaignStart(old, declaration());
  old.db.exec('ALTER TABLE operations DROP COLUMN routing');
  old.insert('operations', { id: 'old-run', campaign_id: 'test-campaign', task_id: 'T1', kind: 'implement',
    seq: 1, idempotency_key: 'old-run', lease_generation: 1, state: 'finished', session_id: 'old-session',
    run_dir: 'synthetic', workspace: 'synthetic', packet: {}, packet_digest: 'a'.repeat(64), created_at: 1, updated_at: 1 });
  old.close();
  const reader = new Store(path, { readOnly: true });
  try { assert.ok(!reader.all('PRAGMA table_info(operations)').some((column) => column.name === 'routing'), 'a reader never migrates'); }
  finally { reader.close(); }
  const migrated = new Store(path);
  t.after(() => migrated.close());
  assert.equal(migrated.get('SELECT routing FROM operations WHERE id = ?', 'old-run').routing, null);
});

test('a crash after record relaunches the same operation with the same receipt and model', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = declaration({ tasks: [declaration().tasks[0]] });
  campaignStart(store, d);
  // `serve` starts new work only from code merged into origin/main (AW-005): run it from a merged runtime checkout.
  const runtime = runtimeCheckout();
  const children = new Set();
  const serve = (extraEnv = {}) => {
    const child = spawn(process.execPath, ['--no-warnings', runtime.cli, 'serve', '--data', env.dataDir], {
      env: { ...process.env, ...env.env, ...extraEnv }, stdio: 'ignore', windowsHide: true,
    });
    children.add(child);
    child.exited = new Promise((done) => child.once('exit', (code) => { children.delete(child); done(code); }));
    return child;
  };
  t.after(async () => {
    for (const child of children) child.kill();
    await sleep(200);
    store.close();
    env.cleanup();
    runtime.cleanup();
  });
  assert.equal(await serve({ AIWORKS_FAULT: 'after-record' }).exited, 86);
  const [recorded] = store.all('SELECT * FROM operations');
  assert.equal(recorded.state, 'recorded');
  assert.equal(recorded.routing.decision.chosen.model, 'opus');
  assert.equal(env.calls().length, 0);
  const next = serve();
  const deadline = Date.now() + 120_000;
  while (store.campaign(d.campaignId).control !== 'finished') {
    assert.ok(Date.now() < deadline, `timed out: ${JSON.stringify(store.tasks(d.campaignId))}`);
    await sleep(50);
  }
  next.kill();
  const implement = store.all("SELECT * FROM operations WHERE kind = 'implement'");
  assert.deepEqual(implement.map((op) => op.id), [recorded.id], 'the recorded operation itself ran');
  assert.deepEqual(implement[0].routing, recorded.routing, 'the receipt did not change');
  const call = env.calls().find((item) => item.role === 'implement');
  assert.equal(call.sessionId, recorded.session_id);
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'opus', 'the relaunch runs the recorded model');
  for (const op of store.all('SELECT * FROM operations')) {
    assert.deepEqual(route(op.routing.inputs), op.routing.decision);
    assert.equal(op.routing.decision.chosen.kind, op.executor_kind);
  }
});
