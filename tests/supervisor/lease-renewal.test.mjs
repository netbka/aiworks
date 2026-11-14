// A controller that holds several campaigns keeps all their leases while one long step runs, so a second controller never
// takes a campaign over mid-step and dispatches its work again. A lease that already lapsed is never revived.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, skipWithoutSqlite, sleep, SQLITE } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const { campaignPause, campaignStart } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const { exec, execAsync } = await import('../../src/supervisor/adapters/git.mjs');

test('a slow fenced effect preserves live held leases without reviving expired, released or replaced leases', { skip: skipWithoutSqlite }, (t) => {
  const env = environment();
  const file = join(env.dataDir, 'supervisor.db');
  const store = new Store(file), competitor = new Store(file);
  competitor.db.exec('PRAGMA busy_timeout = 0');
  let time = 1_000_000;
  const ttl = 10_000;
  const controller = new Controller({ store, config: { ...env.config, leaseMs: ttl }, dataDir: env.dataDir, now: () => time });
  t.after(() => { competitor.close(); store.close(); env.cleanup(); });
  const first = store.acquireLease('first', controller.instanceId, time, ttl);
  for (const id of ['second', 'released', 'replaced', 'taken']) {
    controller.held.set(id, store.acquireLease(id, controller.instanceId, time, ttl).generation);
  }
  controller.held.set('expired', store.acquireLease('expired', controller.instanceId, time - 2 * ttl, ttl).generation);
  controller.held.set('long', store.acquireLease('long', controller.instanceId, time, 100 * ttl).generation);
  const longEnd = store.lease('long').expires_at;
  store.releaseLease('taken', controller.instanceId, controller.held.get('taken'), time);
  store.acquireLease('taken', 'other-controller', time, ttl);
  const ctx = { id: 'first', generation: first.generation }; // The fenced context need not be in held.
  let releasedAt, replaced;
  assert.equal(controller.fenced(ctx, () => {
    time += 2 * ttl;
    assert.throws(() => competitor.acquireLease('second', 'other-controller', time, ttl), /locked|busy/i,
      'the database fence prevents takeover throughout the effect');
    releasedAt = time;
    store.releaseLease('released', controller.instanceId, controller.held.get('released'), time);
    replaced = store.acquireLease('replaced', controller.instanceId, time, ttl);
    time += ttl;
    return 'done';
  }), 'done');
  for (const id of ['first', 'second']) assert.equal(competitor.acquireLease(id, 'other-controller', time, ttl), null,
    'the lease remains owned when the write lock is released');
  assert.equal(store.lease('released').expires_at, releasedAt);
  assert.equal(store.lease('replaced').generation, replaced.generation);
  assert.equal(store.lease('replaced').expires_at, time, 'a replacement generation is not renewed through stale held state');
  assert.equal(store.lease('taken').instance_id, 'other-controller');
  assert.equal(store.lease('long').expires_at, longEnd, 'a fenced effect never shortens a lease taken for longer');
  for (const id of ['expired', 'released', 'replaced']) assert.ok(competitor.acquireLease(id, 'other-controller', time, ttl));
  const before = store.lease('second');
  assert.throws(() => controller.fenced(ctx, () => { time += 2 * ttl; throw new Error('effect failed'); }), /effect failed/);
  assert.deepEqual(store.lease('second'), before, 'failure rolls back without renewing leases');
  assert.ok(competitor.acquireLease('second', 'other-controller', time, ttl));
});

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

// aiworks#39: a Git call of minutes inside spawnSync blocked the event loop, the timer could not renew, and every campaign
// lease lapsed and was taken over. A dispatch's worktree creation now runs outside its fenced write. The rig: a controller
// whose Git is real except that creating a worktree first waits one and a half leases, a second store connection that
// never waits for a lock, and the serve timer renewing held leases. Resolves once that worktree step is under way.
async function slowWorktreeDispatch(t) {
  const env = environment();
  // Long enough that the quick blocking reads around the slow step, and a busy machine, stay well inside one lease.
  const ttl = 4_000;
  const started = join(env.tmp, 'worktree-started'), ended = join(env.tmp, 'worktree-ended');
  const slowGit = join(env.tmp, 'slow-git.mjs');
  writeFileSync(slowGit, `import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2), slow = args[0] === 'worktree' && args[1] === 'add';
if (slow) writeFileSync(${JSON.stringify(started)}, '');
setTimeout(() => {
  const status = spawnSync('git', args, { stdio: 'inherit', windowsHide: true }).status ?? 1;
  if (slow) writeFileSync(${JSON.stringify(ended)}, '');
  process.exit(status);
}, slow ? ${1.5 * ttl} : 0);\n`);
  const file = join(env.dataDir, 'supervisor.db');
  const store = new Store(file), competitor = new Store(file);
  competitor.db.exec('PRAGMA busy_timeout = 0');
  const controller = new Controller({ store, config: { ...env.config, leaseMs: ttl, commands: { ...env.config.commands, git: [process.execPath, slowGit] } },
    dataDir: env.dataDir, fault: null });
  controller.launch = async () => {}; // records the operation; nothing is spawned
  const timer = setInterval(() => controller.renewOnTimer(), ttl / 4);
  t.after(() => { clearInterval(timer); competitor.close(); store.close(); env.cleanup(); });
  const d = declaration({ tasks: [declaration().tasks[0]] });
  campaignStart(store, d);
  controller.held.set('other-campaign', store.acquireLease('other-campaign', controller.instanceId, Date.now(), ttl).generation);
  const stepping = controller.step(d.campaignId);
  const deadline = Date.now() + 60_000;
  while (!existsSync(started) && Date.now() < deadline) await sleep(20);
  assert.ok(existsSync(started), 'the dispatch creates its worktree');
  assert.equal(existsSync(ended), false, 'the controller keeps running while the worktree is created');
  return { ttl, store, competitor, controller, id: d.campaignId, stepping, ended };
}

test('a Git step slower than the lease inside a dispatch holds no write lock and lets the timer renew every lease', { skip: skipWithoutSqlite }, async (t) => {
  const { ttl, store, competitor, controller, id, stepping, ended } = await slowWorktreeDispatch(t);
  assert.ok(competitor.acquireLease('probe', 'other-controller', Date.now(), ttl), 'no write lock is held while Git runs');
  await stepping;
  assert.ok(existsSync(ended));
  assert.equal(competitor.acquireLease('other-campaign', 'other-controller', Date.now(), ttl), null, 'no other campaign lapsed during the Git step');
  assert.equal(competitor.acquireLease(id, 'other-controller', Date.now(), ttl), null);
  assert.equal(store.openOperations(id).length, 1, 'the dispatch is recorded after the Git step');
  controller.release();
});

// The write lock is free during that step, so an owner's pause can commit meanwhile: the dispatch decides again after the
// step and starts no worker for a campaign paused under it.
test('an owner pause committed while a dispatch creates its worktree records no operation', { skip: skipWithoutSqlite }, async (t) => {
  const { store, competitor, controller, id, stepping } = await slowWorktreeDispatch(t);
  campaignPause(competitor, id, 'owner pause during the Git step');
  await stepping;
  assert.equal(store.campaign(id).control, 'paused');
  assert.deepEqual(store.openOperations(id), [], 'no operation is open');
  assert.equal(store.get("SELECT COUNT(*) AS n FROM journal WHERE campaign_id = ? AND kind = 'operation-recorded'", id).n, 0, 'none was recorded');
  controller.release();
});

// A Git call that hangs must still end at its bound, or the tick that awaits it never ends: the async call fails exactly
// as the blocking one did, also for a command that cannot start, and also while a process it started (a hook's shell,
// a credential helper) still holds its output.
test('a hanging or missing Git command fails the async call as it failed the blocking call', async () => {
  const hang = [process.execPath, '-e', 'setTimeout(() => {}, 60000)'];
  const outcome = ({ ok, status, error }) => ({ ok, status, error });
  const timedOut = { ok: false, status: null, error: 'ETIMEDOUT' };
  let started = Date.now();
  assert.deepEqual(outcome(await execAsync(hang, [], { timeoutMs: 500 })), timedOut);
  assert.ok(Date.now() - started < 30_000, 'the hanging process was ended at its timeout');
  assert.deepEqual(outcome(await execAsync(hang, [], { timeoutMs: 500 })), outcome(exec(hang, [], { timeoutMs: 500 })));
  const holder = [process.execPath, '-e', "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' }); setTimeout(() => {}, 60000)"];
  started = Date.now();
  assert.deepEqual(outcome(await execAsync(holder, [], { timeoutMs: 500, killMs: 5_000 })), timedOut);
  assert.ok(Date.now() - started < 30_000, 'a process holding the output does not keep the call waiting');
  const missing = ['aiworks-no-such-git-command'];
  assert.deepEqual(outcome(await execAsync(missing, ['status'])), outcome(exec(missing, ['status'])));
});
