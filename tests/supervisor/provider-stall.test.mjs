// A full stall on AI worker availability (AW-022) sends one owner alert: a re-wait while the account stays unusable
// must not end the stall and queue another alert, and the record closes only once a worker is free again.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, skipWithoutSqlite, SQLITE } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const { campaignStart } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const { clearAccountWait, setAccountWait } = SQLITE ? await import('../../src/supervisor/accounts.mjs') : {};

test('a full worker stall alerts once across re-waits and closes when a worker is free', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  campaignStart(store, declaration({ campaignId: 'camp' }));
  let now = Date.now();
  const config = { ...env.config, ownerIntervention: { enabled: true } };
  const controller = new Controller({ store, config, dataDir: env.dataDir, now: () => now, fault: null, sampler: { sample: () => null } });
  controller.launch = async () => {};
  await controller.step('camp');
  const ctx = { id: 'camp', generation: controller.held.get('camp') };
  const advance = (ms) => { now += ms; store.run('UPDATE leases SET expires_at = ?', now + 3_600_000); };
  const alerts = () => store.all("SELECT key FROM owner_notifications WHERE key IN (SELECT fingerprint || ':' || episode || ':initial' FROM blockers WHERE dependency = 'provider-stall') OR class = 'B4'");
  const record = () => store.get("SELECT status, episode FROM blockers WHERE dependency = 'provider-stall'");

  // The only worker's account is signed out (untimed): dispatch re-waits the task every 15 minutes.
  setAccountWait(store, config, { kind: 'claude-cli', retryAt: null, reason: 'auth: signed out', campaignId: 'camp', now });
  for (let i = 0; i < 4; i++) {
    store.run("UPDATE tasks SET state = 'pending', retry_at = ?, last_error = 'waiting for executor availability: x' WHERE campaign_id = 'camp' AND task_id = 'T1'", now + 15 * 60_000);
    controller.providerStallTick(ctx);
    advance(16 * 60_000); // the re-wait time has passed before the next tick
    controller.providerStallTick(ctx);
  }
  assert.deepEqual([record()?.status, record()?.episode, alerts().length], ['open', 1, 1], 'one alert for one stall, however many re-waits');

  clearAccountWait(store, config, 'claude-cli');
  advance(60_000);
  controller.providerStallTick(ctx);
  assert.deepEqual([record().status, alerts().length], ['resolved', 1], 'a free worker closes the record without another alert');
  controller.release();
});
