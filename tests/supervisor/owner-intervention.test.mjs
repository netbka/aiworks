// aiworks#1 owner-intervention core on the AIWorks supervisor (harness in owner-intervention-harness.mjs): blocker
// fingerprint and dedup, store migration, B2 and B3 records and the secret scan. Recheck probes, the outbox and the
// restart rehearsal are in owner-intervention-recheck.test.mjs. Synthetic workers only; no network, Telegram,
// credential or production access.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { declaration, environment, runUntil, skipWithoutSqlite, sleep } from './helpers.mjs';
import { blockers, independent, keyShape, load, notes, ops, parents, SECRETS, setup } from './owner-intervention-harness.mjs';

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
  assert.equal(oi.redact('otp=123456'), 'otp=[redacted]', 'one-time passwords remain credential material');
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
