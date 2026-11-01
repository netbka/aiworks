// A controller that holds several campaigns keeps all their leases while one long step runs, so a second controller never
// takes a campaign over mid-step and dispatches its work again. A lease that already lapsed is never revived.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { environment, skipWithoutSqlite, SQLITE } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};

test('held leases are renewed past one long step; a lapsed lease stays with its new holder', { skip: skipWithoutSqlite }, (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  let time = 1_000_000;
  const ttl = 10_000;
  const controller = new Controller({ store, config: { ...env.config, leaseMs: ttl }, dataDir: env.dataDir, now: () => time });
  t.after(() => { store.close(); env.cleanup(); });
  for (const id of ['first', 'second']) controller.held.set(id, store.acquireLease(id, controller.instanceId, time, ttl).generation);

  // A step of 'first' runs for longer than the lease while the renewal timer fires.
  for (let elapsed = 0; elapsed < 3 * ttl; elapsed += ttl / 4) { time += ttl / 4; controller.renewHeld(); }
  assert.equal(store.acquireLease('second', 'other-controller', time, ttl), null, 'a second controller cannot take a held campaign');
  assert.equal(store.acquireLease('first', 'other-controller', time, ttl), null);

  // Renewal stopped (the event loop was blocked) past the lease: the other controller takes it, and renewing no longer
  // reclaims it for the first.
  time += ttl + 1;
  const taken = store.acquireLease('second', 'other-controller', time, ttl);
  assert.ok(taken && taken.takeover, 'an expired lease goes to the controller that asks');
  controller.renewHeld();
  assert.equal(store.lease('second').instance_id, 'other-controller', 'renewal never revives a lease that changed hands');
  assert.equal(controller.held.has('second'), false, 'and the first controller stops counting it as held');

  // A tick that hangs is covered by the timer only up to its bound; then its leases lapse, so it shows as stopped.
  controller.tickStartedAt = time;
  const bound = Math.max(10 * ttl, 15 * 60_000);
  for (let elapsed = 0; elapsed <= bound + 2 * ttl; elapsed += ttl / 4) { time += ttl / 4; controller.renewOnTimer(); }
  assert.ok(store.acquireLease('first', 'other-controller', time, ttl), 'a hung tick no longer keeps its campaigns');
});
