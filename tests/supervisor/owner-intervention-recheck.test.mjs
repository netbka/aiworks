// aiworks#1 owner-intervention core, recheck side (harness in owner-intervention-harness.mjs): the deterministic budget
// probe, B0/B1 recovery, timer rechecks, the notification outbox and a restart during a recheck probe run.
// Synthetic workers only; no network, Telegram, credential or production access.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, runUntil, skipWithoutSqlite, sleep, runtimeCheckout } from './helpers.mjs';
import { blockers, notes, OI, ops, parents, setup } from './owner-intervention-harness.mjs';

test('B3 budget: a recheck runs the deterministic probe and fails on evidence; the amendment resolves it', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: { maxWorkerRuns: 1 } });
  const { m, store, controller, env, id } = await setup(t, { decl });
  await runUntil(controller, store, id, (c) => c.status === 'blocked-owner-decision');
  const record = store.get('SELECT * FROM blockers');
  assert.deepEqual([record.class, record.dependency, record.next_recheck_at], ['B3', 'budget', null], 'a decision has no timer');
  assert.deepEqual(parents(store, record.fingerprint).map((p) => p.phase), ['implemented']);
  m.campaignRecheck(store, id);
  await runUntil(controller, store, id, () => store.get('SELECT recheck_attempts FROM blockers').recheck_attempts === 1);
  const failed = store.get('SELECT * FROM blockers');
  assert.deepEqual([failed.status, failed.last_evidence.pass, failed.last_evidence.probe], ['open', false, 'deterministic']);
  assert.match(failed.last_evidence.detail, /worker-run cap reached/);
  assert.equal(store.campaign(id).status, 'blocked-owner-decision');
  m.campaignStart(store, { ...decl, authorization: { ...decl.authorization, version: 2 }, limits: { ...decl.limits, maxWorkerRuns: 2 } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const resolved = store.get('SELECT * FROM blockers');
  assert.deepEqual([resolved.status, resolved.resolution.trigger], ['resolved', 'state-change']);
  assert.deepEqual(env.calls().map((c) => c.role), ['implement', 'verify'], 'resumed in the verify phase, not from the beginning');
  assert.equal(notes(store).length, 1);
});

test('B0/B1 recovery (retry, usage-limit wait, evidence-unavailable rerun) never creates a blocker or notification', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: { maxRetriesPerTask: 3 } });
  const { m, store, controller, id } = await setup(t, { decl, scenario: { implement: ['quota', 'no-result', 'unavailable', 'commit'] } });
  await runUntil(controller, store, id, (c) => /provider usage reset/.test(c.next_action ?? ''));
  assert.deepEqual([blockers(store).length, notes(store).length], [0, 0]);
  m.campaignRecheck(store, id);
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.deepEqual([blockers(store).length, notes(store).length], [0, 0]);
});

test('timer recheck with an injected deterministic probe resumes on passing evidence without a probe run', { skip: skipWithoutSqlite }, async (t) => {
  let healthy = false;
  const calls = [];
  const probes = { auth: ({ record }) => { calls.push(record.fingerprint); return { pass: healthy, evidence: healthy ? 'login verified' : 'still signed out' }; } };
  const decl = declaration({ tasks: [declaration().tasks[0]] });
  const { store, controller, env, id } = await setup(t, { decl, probes, scenario: { implement: ['auth', 'commit'] } });
  await runUntil(controller, store, id, (c) => c.status === 'blocked-owner-action');
  const record = store.get('SELECT * FROM blockers');
  assert.equal(record.next_recheck_at - record.first_detected_at, 15 * 60_000, 'first B2 recheck after 15 minutes');
  for (let i = 0; i < 3; i++) { await controller.tick(); await sleep(20); }
  assert.equal(calls.length, 0, 'no recheck before the schedule');
  // Simulate the interval elapsing in durable state; the controller clock stays real so runner liveness is unaffected.
  const elapse = () => store.run('UPDATE blockers SET next_recheck_at = ?', Date.now() - 1);
  elapse();
  await runUntil(controller, store, id, () => store.get('SELECT recheck_attempts FROM blockers').recheck_attempts === 1);
  const failed = store.get('SELECT * FROM blockers');
  assert.equal(store.campaign(id).status, 'blocked-owner-action', 'failed evidence keeps the blocker');
  assert.ok(failed.next_recheck_at - failed.last_evidence.at === 60 * 60_000, 'the second recheck waits 60 minutes');
  assert.equal(env.calls().length, 1, 'a timer never spends a worker run');
  healthy = true;
  elapse();
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const resolved = store.get('SELECT * FROM blockers');
  assert.deepEqual([resolved.status, resolved.resolution.trigger, resolved.resolution.probe], ['resolved', 'timer', 'deterministic']);
  assert.equal(calls.length, 2);
  assert.deepEqual(env.calls().map((c) => c.role), ['implement', 'implement', 'verify']);
});

test('notification outbox: disabled by default, no-op transport sends nothing, a fake transport retries failed delivery', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]] });
  const disabled = await setup(t, { decl, config: {}, scenario: { implement: ['auth'] } });
  await runUntil(disabled.controller, disabled.store, disabled.id, (c) => c.status === 'blocked-owner-action');
  assert.deepEqual([blockers(disabled.store).length, notes(disabled.store).length], [0, 0], 'feature disabled: no records');
  assert.equal(disabled.store.campaign(disabled.id).blocker.fingerprint, undefined);

  const sent = [];
  let failures = 1;
  const fake = { name: 'fake', live: true, async send({ key, message }) {
    sent.push({ key, message });
    if (failures-- > 0) throw new Error('synthetic transport failure');
    return { delivered: true, receipt: `fake:${key}` };
  } };
  const noop = await setup(t, { decl, config: { ownerIntervention: { enabled: true, deliver: true } }, scenario: { implement: ['auth'] } });
  await runUntil(noop.controller, noop.store, noop.id, (c) => c.status === 'blocked-owner-action');
  for (let i = 0; i < 3; i++) { await noop.controller.tick(); await sleep(20); }
  assert.deepEqual(notes(noop.store).map((n) => [n.state, n.attempts]), [['pending', 0]], 'the no-op transport never sends');

  const live = await setup(t, { decl, notifier: fake, config: { ownerIntervention: { enabled: true, deliver: true } }, scenario: { implement: ['auth'] } });
  await runUntil(live.controller, live.store, live.id, () => notes(live.store)[0]?.state === 'delivered');
  const [delivered] = notes(live.store);
  assert.equal(delivered.attempts, 2);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].key, sent[1].key, 'a retry reuses the idempotency key');
  for (let i = 0; i < 3; i++) { await live.controller.tick(); await sleep(20); }
  assert.equal(sent.length, 2, 'a delivered notification is not resent');
});

test('restart during the recheck probe: the probe launches once and the dependent task resumes', { skip: skipWithoutSqlite }, async (t) => {
  const { Store } = await import('../../src/supervisor/store.mjs');
  const { campaignStart, campaignRecheck } = await import('../../src/supervisor/api.mjs');
  const env = environment({ scenario: { implement: ['auth', 'commit', 'commit'] }, config: OI });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = declaration();
  campaignStart(store, d);
  // `serve` starts new work only from code merged into origin/main (AW-005): run it from a merged runtime checkout.
  const runtime = runtimeCheckout();
  const children = new Set();
  const serve = (extraEnv = {}) => {
    const child = spawn(process.execPath, ['--no-warnings', runtime.cli, 'serve', '--data', env.dataDir], {
      env: { ...process.env, ...env.env, ...extraEnv }, stdio: 'ignore', windowsHide: true,
    });
    children.add(child);
    child.exited = new Promise((done) => child.on('exit', (code) => { children.delete(child); done(code); }));
    return child;
  };
  const waitFor = async (predicate, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (predicate()) return; await sleep(50); }
    throw new Error(`timed out: ${JSON.stringify(store.campaign(d.campaignId))} ${JSON.stringify(blockers(store))}`);
  };
  t.after(async () => {
    for (const child of children) child.kill();
    await sleep(200);
    store.close();
    env.cleanup();
    runtime.cleanup();
  });
  const first = serve();
  await waitFor(() => store.campaign(d.campaignId).status === 'blocked-owner-action');
  first.kill();
  await first.exited;
  campaignRecheck(store, d.campaignId, { note: 'owner re-authenticated' });
  // The replacement records the probe operation and dies before launching it.
  assert.equal(await serve({ AIWORKS_FAULT: 'after-record' }).exited, 86);
  assert.equal(store.get('SELECT status FROM blockers').status, 'rechecking');
  assert.deepEqual(ops(store, d.campaignId).map((op) => [op.id.split('.').slice(1).join('.'), op.state]),
    [['T1.implement.1', 'finished'], ['T1.implement.2', 'recorded']]);
  const last = serve();
  await waitFor(() => store.campaign(d.campaignId).control === 'finished');
  last.kill();
  assert.deepEqual(env.calls().map((c) => c.role), ['implement', 'implement', 'verify', 'implement', 'verify'], 'no duplicate dispatch');
  const ids = ops(store, d.campaignId).map((op) => op.id);
  assert.equal(new Set(ids).size, ids.length);
  const record = store.get('SELECT * FROM blockers');
  assert.equal(record.status, 'resolved');
  assert.equal(record.resolution.operation, `${d.campaignId}.T1.implement.2`);
  assert.equal(notes(store).length, 1);
});
