// aiworks#1 owner-intervention core on the AIWorks supervisor: blocker fingerprint and dedup, category-bounded
// recheck, evidence-gated resume and the notification outbox (no-op transport by default). Synthetic workers
// only; no network, Telegram, credential or production access.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { declaration, environment, runUntil, skipWithoutSqlite, sleep, runtimeCheckout } from './helpers.mjs';

const OI = { ownerIntervention: { enabled: true } };
// The synthetic credential-shaped values the `owner-leak` fixture mode puts in its trigger text. The key
// shape is assembled at runtime so no token-shaped literal is committed (repository leak scan).
const keyShape = (value) => ['sk', 'ant', 'api03', value].join('-');
const SECRETS = [keyShape('SYNTHETICfakeVALUE0123456789abcdef'), 'SYNTHETICfakePassphrase', 'SYNTHETICfake'];

const load = async () => ({
  ...(await import('../../src/supervisor/api.mjs')),
  ...(await import('../../src/supervisor/controller.mjs')),
  ...(await import('../../src/supervisor/store.mjs')),
  oi: await import('../../src/supervisor/owner-intervention.mjs'),
});

async function setup(t, { scenario, config = OI, decl, notifier, probes } = {}) {
  const m = await load();
  const env = environment({ scenario, config });
  const store = new m.Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = decl ?? declaration();
  m.campaignStart(store, d);
  const controller = new m.Controller({ store, config: env.config, dataDir: env.dataDir, fault: null, notifier, probes });
  return { m, env, store, controller, d, id: d.campaignId };
}

const blockers = (store) => store.all('SELECT * FROM blockers ORDER BY first_detected_at');
const notes = (store) => store.all('SELECT * FROM owner_notifications ORDER BY created_at');
const parents = (store, fp) => store.all('SELECT * FROM blocker_parents WHERE fingerprint = ? ORDER BY campaign_id, task_id', fp);
const ops = (store, id) => store.all('SELECT id, task_id, kind, state, created_at FROM operations WHERE campaign_id = ? ORDER BY created_at', id);
const independent = () => {
  const [first, second] = declaration().tasks;
  return declaration({ tasks: [first, { ...second, id: 'T3', dependsOn: [] }] });
};

test('fingerprint: stable for one cause, new for a changed cause, never derived from a secret value', async () => {
  const { oi } = await load();
  const base = { project: 'sampleapp', environment: 'research', dependency: 'auth', blockerClass: 'B2', identity: 'claude-cli' };
  assert.equal(oi.blockerFingerprint(base), oi.blockerFingerprint({ ...base }));
  assert.match(oi.blockerFingerprint(base), /^[0-9a-f]{64}$/);
  for (const change of [{ identity: 'codex-cli' }, { blockerClass: 'B5' }, { dependency: 'research-context' }, { environment: 'production' }, { project: 'other' }]) {
    assert.notEqual(oi.blockerFingerprint({ ...base, ...change }), oi.blockerFingerprint(base), JSON.stringify(change));
  }
  // Two causes differing only in a secret value share one fingerprint: the value never reaches the hash.
  assert.equal(oi.blockerFingerprint({ ...base, identity: `key ${SECRETS[0]} rejected` }),
    oi.blockerFingerprint({ ...base, identity: `key ${keyShape('OTHERfakeVALUE9876543210zyxwvu')} rejected` }));
  const text = `Rotate ${SECRETS[0]} token=${SECRETS[1]} Bearer abcDEF1234567890xyz https://user:pa55@host/x 123456789:AAHsyntheticBotTokenValue_abcdefghijklmn`;
  const clean = oi.redact(text);
  for (const value of [...SECRETS, 'pa55', 'abcDEF1234567890xyz', 'AAHsyntheticBotTokenValue']) assert.ok(!clean.includes(value), `${value} survived: ${clean}`);
  assert.equal(oi.redact('verified a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'), 'verified a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'Git SHAs stay readable');
});

test('recheck schedule is bounded per category and reminders follow the 60-minute / 24-hour default', async () => {
  const { oi } = await load();
  const at = (cls, attempts) => oi.nextRecheckAt(cls, attempts, 0);
  assert.deepEqual([0, 1, 2, 3].map((n) => at('B2', n)), [15 * 60_000, 60 * 60_000, 240 * 60_000, null], 'B2 stops timing after three rechecks');
  assert.deepEqual([0, 1, 2, 9].map((n) => at('B4', n)), [60_000, 5 * 60_000, 15 * 60_000, 15 * 60_000], 'B4 monitors at a capped interval');
  assert.equal(at('B3', 0), null, 'a decision has no timer');
  assert.equal(at('B5', 0), null, 'an incident has no blocker timer');
  const record = { class: 'B2', status: 'open', last_notified_at: 0, reminders: 0 };
  assert.equal(oi.reminderDue(record, 59 * 60_000), null);
  assert.equal(oi.reminderDue(record, 60 * 60_000), 1);
  assert.equal(oi.reminderDue({ ...record, reminders: 1 }, 23 * 60 * 60_000), null);
  assert.equal(oi.reminderDue({ ...record, reminders: 1 }, 24 * 60 * 60_000), 2);
  assert.equal(oi.reminderDue({ ...record, class: 'B4' }, 48 * 60 * 60_000), null, 'external wait does not nag the owner');
  assert.equal(oi.reminderDue({ ...record, status: 'resolved' }, 48 * 60 * 60_000), null);
  assert.equal(oi.noopTransport.live, false);
});

test('older stores gain the blocker tables idempotently; read-only status of an unmigrated store still works', { skip: skipWithoutSqlite }, async (t) => {
  const m = await load();
  const env = environment();
  t.after(() => env.cleanup());
  const path = join(env.dataDir, 'supervisor.db');
  const d = declaration();
  let store = new m.Store(path);
  m.campaignStart(store, d);
  store.close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE blockers; DROP TABLE blocker_parents; DROP TABLE owner_notifications;');
  raw.close();
  const readOnly = new m.Store(path, { readOnly: true });
  const legacy = m.campaignStatus(readOnly, d.campaignId);
  assert.equal(legacy.ownerBlockers, undefined);
  readOnly.close();
  for (let i = 0; i < 2; i++) {
    store = new m.Store(path);
    assert.equal(store.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('blockers', 'blocker_parents', 'owner_notifications')").length, 3);
    assert.equal(store.tasks(d.campaignId).length, 2, 'existing rows are untouched');
    store.close();
  }
});

test('a repeated B2 is one fingerprint and one notification; acknowledgement never resumes; recheck evidence does', { skip: skipWithoutSqlite }, async (t) => {
  const { m, store, controller, env, id } = await setup(t, { decl: independent(), scenario: { implement: ['auth', 'auth', 'commit', 'commit'] } });
  const blocked = await runUntil(controller, store, id, (c) => c.status === 'blocked-owner-action');
  const [record] = blockers(store);
  assert.equal(blocked.blocker.fingerprint, record.fingerprint);
  assert.deepEqual([record.class, record.dependency, record.status], ['B2', 'auth', 'open']);
  assert.deepEqual(parents(store, record.fingerprint).map((p) => [p.task_id, p.phase]), [['T1', 'pending'], ['T3', 'pending']]);
  assert.equal(notes(store).length, 1);
  assert.equal(notes(store)[0].message.label, 'Action required');
  assert.equal(notes(store)[0].state, 'pending', 'no transport: the outbox records what would be sent');

  m.blockerAcknowledge(store, record.fingerprint);
  for (let i = 0; i < 5; i++) { await controller.tick(); await sleep(30); }
  assert.equal(env.calls().length, 1, 'owner acknowledgement alone dispatches nothing');
  assert.ok(store.get('SELECT acknowledged_at FROM blockers').acknowledged_at);

  // Owner says Done without fixing: the probe run fails the same way, the same record stays open, no new alert.
  m.campaignRecheck(store, id);
  await runUntil(controller, store, id, () => env.calls().length === 2 && store.campaign(id).blocker);
  const failed = store.get('SELECT * FROM blockers');
  assert.deepEqual([blockers(store).length, failed.status, failed.recheck_attempts, failed.occurrences], [1, 'open', 1, 2]);
  assert.equal(failed.last_evidence.pass, false);
  assert.equal(notes(store).length, 1, 'a failed recheck does not alert again');
  assert.deepEqual(ops(store, id).map((op) => op.task_id), ['T1', 'T1'], 'only the probe task ran');

  m.campaignRecheck(store, id);
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const resolved = store.get('SELECT * FROM blockers');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolution.pass, true);
  assert.equal(resolved.resolution.operation, `${id}.T1.implement.3`);
  const sequence = ops(store, id);
  const firstT3 = sequence.find((op) => op.task_id === 'T3');
  assert.ok(firstT3.created_at >= resolved.resolved_at, 'the held parent resumed only after the probe evidence passed');
  assert.equal(sequence.filter((op) => op.task_id === 'T3' && op.kind === 'implement').length, 1);
  assert.ok(parents(store, resolved.fingerprint).every((p) => p.released_at));
  assert.equal(notes(store).length, 1);
  await runUntil(controller, store, id, () => store.all("SELECT * FROM outbox WHERE state = 'pending'").length === 0);
  assert.equal(env.comments().filter((c) => c.body.includes('is blocked (B2)')).length, 1, 'one tracking-issue blocker comment per fingerprint');
  assert.equal(env.comments().filter((c) => c.body.includes('resolved after recheck evidence')).length, 1);
});

test('one root blocker across two campaigns: one fingerprint, one notification, both parents resume', { skip: skipWithoutSqlite }, async (t) => {
  const { m, store, controller, env, d } = await setup(t, { decl: declaration({ tasks: [declaration().tasks[0]], campaignId: 'camp-a' }),
    scenario: { implement: ['auth', 'auth', 'commit', 'commit'] } });
  const second = declaration({ tasks: [{ ...declaration().tasks[0], issue: 439 }], campaignId: 'camp-b' });
  m.campaignStart(store, second);
  const both = () => ['camp-a', 'camp-b'].every((id) => store.campaign(id).status === 'blocked-owner-action');
  await runUntil(controller, store, d.campaignId, both);
  const [record] = blockers(store);
  assert.equal(blockers(store).length, 1);
  assert.deepEqual(parents(store, record.fingerprint).map((p) => [p.campaign_id, p.task_id]), [['camp-a', 'T1'], ['camp-b', 'T1']]);
  assert.equal(notes(store).length, 1);
  // Which campaign blocks first is scheduling order; the alert names only the parent that opened the record.
  const opener = notes(store)[0].campaign_id;
  assert.ok(['camp-a', 'camp-b'].includes(opener), opener);
  assert.deepEqual(notes(store)[0].message.tasks, [`${opener}/T1`], 'the second parent attaches without a second alert');
  m.campaignRecheck(store, 'camp-a');
  await runUntil(controller, store, 'camp-a', () => ['camp-a', 'camp-b'].every((id) => store.campaign(id).control === 'finished'));
  assert.equal(store.get('SELECT status FROM blockers').status, 'resolved');
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 4, 'camp-b resumed on camp-a\'s evidence without its own probe');
  assert.ok(store.all("SELECT * FROM journal WHERE campaign_id = 'camp-b' AND kind = 'blocker-resumed'").length === 1);
});

test('B3 owner decision: no secret in any record or outbox field; a changed cause is a new fingerprint', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]] });
  const { m, store, controller, id } = await setup(t, { decl, scenario: { implement: ['owner-leak', 'owner', 'commit'] } });
  await runUntil(controller, store, id, (c) => c.status === 'blocked-owner-decision');
  const [first] = blockers(store);
  assert.deepEqual([first.class, first.dependency], ['B3', 'owner-decision']);
  assert.equal(store.task(id, 'T1').blocked.fingerprint, first.fingerprint);
  assert.equal(notes(store).length, 1);
  assert.equal(notes(store)[0].message.label, 'Decision required');

  m.blockerAcknowledge(store, first.fingerprint);
  m.campaignRecheck(store, id);
  for (let i = 0; i < 5; i++) { await controller.tick(); await sleep(30); }
  assert.equal(store.get('SELECT status FROM blockers').status, 'open', 'acknowledgement and a generic recheck do not record a decision');
  m.campaignRecheck(store, id, { task: 'T1', note: 'owner decided on #437' });
  await runUntil(controller, store, id, () => blockers(store).length === 2);
  const [resolved, second] = blockers(store);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolution.probe, 'decision');
  assert.notEqual(second.fingerprint, first.fingerprint, 'a different owner trigger is a different cause');
  assert.equal(notes(store).length, 2);
  m.campaignRecheck(store, id, { task: 'T1', note: 'second decision' });
  await runUntil(controller, store, id, (c) => c.control === 'finished');

  const rows = [...blockers(store), ...store.all('SELECT * FROM blocker_parents'), ...notes(store), ...store.all('SELECT * FROM outbox')];
  const serialized = JSON.stringify(rows);
  for (const value of SECRETS) assert.ok(!serialized.includes(value), `${value} leaked into blocker/outbox state`);
  assert.ok(serialized.includes('[redacted]'), 'the cause stays visible with its values redacted');
});

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
