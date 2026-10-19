// OWNER_UI_V2 WP6: owner alerts. Without a transport nothing is sent; the synthetic rehearsal transport records each
// alert once across a restart with secrets redacted and never claims a delivery; quiet hours hold an alert without
// spending its retries, a muted kind is never sent, and failures stop after a bounded number of attempts.
// Synthetic store and fictional data only; no network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FAST, SQLITE } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const alerts = SQLITE ? await import('../../src/supervisor/alerts.mjs') : {};
const skip = SQLITE ? false : 'node:sqlite is required';

const CAMPAIGN = 'alerts-campaign';
const SECRET_REF = 'vault:alerts/relay-key';
const AT_2300_UTC = Date.UTC(2026, 9, 19, 23, 0);
const AT_0800_UTC = Date.UTC(2026, 9, 20, 8, 0);

/** A store and a controller over it; `restart()` builds a fresh controller on the same store, `drain()` runs one tick's drain. */
function harness(t, config = {}, notifier = undefined) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-alerts-'));
  const store = new Store(join(dataDir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const clock = { now: AT_0800_UTC };
  const logs = [];
  const restart = () => {
    const controller = new Controller({ store, dataDir, now: () => clock.now, log: (line) => logs.push(line), instanceId: 'alerts-instance',
      config: { ...FAST, ownerIntervention: { enabled: true }, ...config }, ...(notifier ? { notifier } : {}) });
    // One supervisor tick's drain, holding the campaign lease as the tick would.
    return { drain: () => {
      controller.held.set(CAMPAIGN, store.acquireLease(CAMPAIGN, 'alerts-instance', clock.now, FAST.leaseMs).generation);
      return controller.drainOwnerNotifications();
    } };
  };
  const notify = (key, cls, kind = 'initial', blocked = 'A fictional blocker.') => store.run(`INSERT INTO owner_notifications
    (key, fingerprint, campaign_id, kind, class, message, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  key, `fp-${key}`, CAMPAIGN, kind, cls, { kind, class: cls, project: 'example-org/sampleapp', blocked, impact: '1 parent task(s) held',
    nextAction: 'Open Needs me.', safeState: 'Nothing was merged or deployed.', link: null }, clock.now, clock.now);
  const row = (key) => store.get('SELECT state, attempts, delivered_at FROM owner_notifications WHERE key = ?', key);
  return { store, clock, logs, restart, notify, row };
}

test('without a configured transport, or with one this version has no adapter for, nothing is sent and no secret reference is disclosed', { skip }, async (t) => {
  for (const config of [{}, { alerts: { transport: { kind: 'chat-relay', secretRef: SECRET_REF } } },
    { alerts: { transport: { kind: 'synthetic', secretRef: '123456789:AAHfictionalfictionalfictionalfiction' } } }]) {
    const { store, logs, restart, notify, row } = harness(t, config);
    notify('n1', 'B3');
    await restart().drain();
    assert.deepEqual({ ...row('n1') }, { state: 'pending', attempts: 0, delivered_at: null });
    assert.equal(store.get('SELECT COUNT(*) AS n FROM alert_rehearsals').n, 0);
    const recorded = JSON.stringify([logs, store.all('SELECT * FROM journal'), store.all('SELECT * FROM owner_notifications')]);
    assert.ok(!recorded.includes(SECRET_REF) && !recorded.includes('AAHfictional'), 'no secret reference or value is recorded');
  }
});

test('the rehearsal transport records each alert once after a crash between send and record, redacted, and never as delivered', { skip }, async (t) => {
  const { store, clock, restart, notify, row } = harness(t, { alerts: { transport: { kind: 'synthetic' } } });
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  notify('n1', 'B2', 'initial', `Sign in again; the old token=${token} expired.`);
  // The previous run claimed the attempt and the transport recorded the alert, then the process died before the outcome.
  store.run('UPDATE owner_notifications SET attempts = 1 WHERE key = ?', 'n1');
  const message = store.get('SELECT message FROM owner_notifications WHERE key = ?', 'n1').message;
  await alerts.syntheticTransport(store).send({ key: 'n1', alert: alerts.renderAlert(message) });
  clock.now += 60_000;
  const controller = restart();
  await controller.drain();
  await controller.drain();
  assert.deepEqual({ ...row('n1') }, { state: 'rehearsed', attempts: 2, delivered_at: null });
  const recorded = store.all('SELECT alert FROM alert_rehearsals');
  assert.equal(recorded.length, 1, 'recorded once');
  assert.ok(!JSON.stringify(recorded).includes(token), 'the credential is redacted');
  assert.equal(store.all("SELECT * FROM journal WHERE kind = 'owner-notification-delivered'").length, 0);
});

test('quiet hours hold an alert without spending its retries, a muted kind is never sent, and failures stop after five attempts', { skip }, async (t) => {
  const sent = [];
  const failing = { name: 'fictional-live', live: true, async send({ key }) { sent.push(key); throw new Error('relay refused'); } };
  const { store, clock, restart, notify, row } = harness(t, { alerts: { transport: { kind: 'synthetic' } } });
  store.tx(() => alerts.saveAlertRules(store, { expectedVersion: 0, requestId: 'rules-request-1', rules: { classes: { B2: true, B3: true, B4: false, B5: true },
    reminders: false, quietHours: { start: '22:00', end: '07:00', timeZone: 'UTC', incidents: false } } }, clock.now));
  clock.now = AT_2300_UTC;
  notify('action', 'B2'); notify('wait', 'B4'); notify('reminder', 'B3', 'reminder-1'); notify('incident', 'B5');
  const controller = restart();
  await controller.drain();
  assert.deepEqual([row('action').state, row('action').attempts, row('incident').state, row('wait').state, row('reminder').state],
    ['pending', 0, 'pending', 'muted', 'muted']);
  clock.now = AT_0800_UTC;
  await controller.drain();
  assert.deepEqual([row('action').state, row('incident').state], ['rehearsed', 'rehearsed']);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM alert_rehearsals').n, 2);

  // A live transport that keeps failing is tried at most five times, with backoff, then given up.
  const live = harness(t, { ownerIntervention: { enabled: true, deliver: true } }, failing);
  live.notify('n1', 'B2');
  const liveController = live.restart();
  for (let i = 0; i < 12; i += 1) { await liveController.drain(); live.clock.now += 10_000; }
  assert.deepEqual([live.row('n1').state, live.row('n1').attempts, sent.length], ['failed', 5, 5]);
});
