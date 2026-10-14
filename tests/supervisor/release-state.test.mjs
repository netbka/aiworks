// REL3 (AUTO_RELEASE slice R3): durable release rows, one lock per destination, intent before effect, reconciliation
// with a fake adapter. Built switched off: nothing outside these tests calls release/state.mjs until example-org/aiworks#33.
// No model, network or GitHub call: the adapter is a fake that records what it was asked to do.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FencedError, Store } from '../../src/supervisor/store.mjs';
import { acquireLock, createRelease, destinationState, markUnknownAfterRestart, reconcile, release, runStep } from '../../src/supervisor/release/state.mjs';

const SHA = 'a'.repeat(40);
const ELIGIBLE = () => ({ eligible: true, failed: [], inputs: { grantDigest: 'g'.repeat(64) } });
const TTL = 60_000;

function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-release-state-'));
  const path = join(dir, 'supervisor.db');
  const rig = { path, now: 1_000_000, stores: [] };
  rig.open = () => { const store = new Store(path); rig.stores.push(store); return store; };
  t.after(() => { for (const store of rig.stores) try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
  rig.store = rig.open();
  rig.leaseFor = (store, instanceId) => ({ instanceId, generation: store.acquireLease('c', instanceId, rig.now, TTL).generation });
  rig.lease = rig.leaseFor(rig.store, 'first');
  rig.at = (lease = rig.lease) => ({ lease, now: rig.now });
  rig.make = (destination = 'prod', { store = rig.store, lease = rig.lease, steps = ['merge', 'deploy', 'check'] } = {}) => createRelease(store, {
    project: 'sampleapp', destination, campaignId: 'c', taskId: 'T1', verifiedSha: SHA, grantVersion: 1, grantDigest: 'g'.repeat(64), steps, lease, now: rig.now }).id;
  rig.locked = (destination, options = {}) => {
    const id = rig.make(destination, options);
    assert.equal(acquireLock(options.store ?? rig.store, id, { ...rig.at(options.lease), recheck: ELIGIBLE }).locked, true);
    return id;
  };
  return rig;
}

/** A fake adapter: `run` and `observe` record the step and answer from the given functions. */
function fake({ run = () => 'done', observe = () => 'unknown' } = {}) {
  const adapter = { runs: [], looks: [] };
  adapter.run = async (r, step) => { adapter.runs.push(step); return run(r, step); };
  adapter.observe = async (r, step) => { adapter.looks.push(step); return observe(r, step); };
  return adapter;
}

test('two candidates for one destination never hold the lock together', async (t) => {
  const r = rig(t);
  const one = r.make(), two = r.make(), other = r.make('staging');
  assert.notEqual(one, two, 'a second attempt gets its own id');
  assert.equal(release(r.store, two).idempotency_key, `sampleapp.prod.${SHA}.2`);
  assert.equal(acquireLock(r.store, one, { ...r.at(), recheck: ELIGIBLE }).locked, true);
  const waiting = acquireLock(r.store, two, { ...r.at(), recheck: ELIGIBLE });
  assert.deepEqual([waiting.locked, waiting.refused, waiting.waitingFor, waiting.release.state], [false, false, one, 'eligible'], 'it waits; it is not an error');
  assert.equal(acquireLock(r.store, one, { ...r.at(), recheck: ELIGIBLE }).locked, true, 'idempotent for the holder');
  assert.equal(acquireLock(r.store, other, { ...r.at(), recheck: ELIGIBLE }).locked, true, 'another destination is independent');
  assert.throws(() => r.store.run("INSERT INTO release_locks (destination, release_id, instance_id, generation, acquired_at) VALUES ('sampleapp.prod', ?, 'x', 1, 0)", two),
    /UNIQUE|PRIMARY KEY/, 'the table itself allows one holder per destination');

  // The lock is freed only at a known terminal state, so two only gets it after one is accepted.
  const adapter = fake();
  for (const step of ['merge', 'deploy']) {
    await runStep(r.store, adapter, one, r.at());
    assert.equal(acquireLock(r.store, two, { ...r.at(), recheck: ELIGIBLE }).locked, false, `still held after ${step}`);
  }
  assert.equal((await runStep(r.store, adapter, one, r.at())).state, 'accepted');
  assert.equal(destinationState(r.store, 'sampleapp', 'prod').free, true);
  assert.equal(acquireLock(r.store, two, { ...r.at(), recheck: ELIGIBLE }).locked, true, 'free again once accepted');

  // A re-check that fails, throws, is missing or answers late refuses without taking the lock.
  for (const recheck of [() => ({ eligible: false, failed: [{ reason: 'E6: base moved' }] }), () => { throw new Error('unreadable'); }, undefined,
    async () => ELIGIBLE(), () => ({ eligible: true, failed: [], inputs: { grantDigest: 'h'.repeat(64) } })]) {
    const id = r.make('canary');
    const result = acquireLock(r.store, id, { ...r.at(), recheck });
    assert.deepEqual([result.locked, result.refused, result.release.state], [false, true, 'refused']);
    assert.equal(destinationState(r.store, 'sampleapp', 'canary').free, true);
  }
});

test('unknown and rollback-failed keep the lock', async (t) => {
  const r = rig(t);
  const one = r.locked('prod');
  const lost = await runStep(r.store, fake({ run: () => { throw new Error('connection reset mid-merge'); } }), one, r.at());
  assert.equal(lost.state, 'unknown', 'a step whose outcome is not known is unknown');
  const two = r.make('prod');
  assert.equal(acquireLock(r.store, two, { ...r.at(), recheck: ELIGIBLE }).waitingFor, one);
  assert.deepEqual(destinationState(r.store, 'sampleapp', 'prod'), { free: false, releaseId: one, state: 'unknown' });

  const three = r.locked('staging');
  const failing = fake({ run: (release, step) => (step === 'check' || step === 'rollback' ? 'failed' : 'done') });
  for (let i = 0; i < 4; i++) await runStep(r.store, failing, three, r.at());
  assert.deepEqual(failing.runs, ['merge', 'deploy', 'check', 'rollback'], 'a failed check is followed by rollback');
  assert.equal(release(r.store, three).state, 'rollback-failed');
  await assert.rejects(runStep(r.store, failing, three, r.at()), /no step to run/, 'nothing more runs on it');
  assert.equal(acquireLock(r.store, r.make('staging'), { ...r.at(), recheck: ELIGIBLE }).waitingFor, three,
    'a failed rollback is an incident: the destination stays locked');

  const four = r.locked('canary');
  const recovering = fake({ run: (release, step) => (step === 'check' ? 'failed' : 'done') });
  for (let i = 0; i < 4; i++) await runStep(r.store, recovering, four, r.at());
  assert.equal(release(r.store, four).state, 'rolled-back');
  assert.equal(destinationState(r.store, 'sampleapp', 'canary').free, true, 'rolled-back is a known terminal state and frees it');
});

test('a started step with no outcome is unknown after restart', async (t) => {
  const r = rig(t);
  const one = r.locked('prod');
  let seen;
  // The controller dies while the merge runs: the adapter never answers.
  const dying = { run: (row, step) => { seen = { ...release(r.store, one), step }; return new Promise(() => {}); }, observe: async () => 'unknown' };
  void runStep(r.store, dying, one, r.at());
  assert.deepEqual([seen.state, seen.step, seen.step_key, seen.step_outcome], ['merging', 'merge', `${one}.merge.1`, null],
    'the intent was committed before the adapter acted');
  assert.deepEqual(seen.history.map((entry) => [entry.key, entry.outcome]), [[`${one}.merge.1`, null]]);

  // Restart: a new process opens the same database after the old lease expired.
  r.store.close();
  r.now += TTL + 1;
  const store = r.open();
  const lease = r.leaseFor(store, 'second');
  assert.equal(lease.generation, 2);
  assert.deepEqual(markUnknownAfterRestart(store, 'c', { lease, now: r.now }), [one]);
  assert.equal(release(store, one).state, 'unknown');
  assert.deepEqual(markUnknownAfterRestart(store, 'c', { lease, now: r.now }), [], 'a settled or already unknown release is left alone');
  assert.ok(store.all("SELECT * FROM journal WHERE kind = 'release-unknown'").some((row) => row.detail.release === one && row.detail.after === 'restart'));
});

test('an unknown step is reconciled before any action', async (t) => {
  const r = rig(t);
  const one = r.locked('prod');
  await runStep(r.store, fake({ run: () => { throw new Error('lost'); } }), one, r.at());
  const adapter = fake({ observe: () => ({ outcome: 'done', mergeCommit: 'b'.repeat(40) }) });
  await assert.rejects(runStep(r.store, adapter, one, r.at()), /reconcile it before any action/);
  assert.deepEqual(adapter.runs, [], 'nothing ran');
  const after = await reconcile(r.store, adapter, one, r.at());
  assert.deepEqual([after.state, after.step_outcome, after.merge_commit], ['merged', 'done', 'b'.repeat(40)], 'proven done: recorded, not repeated');
  await runStep(r.store, adapter, one, r.at());
  assert.deepEqual([adapter.looks, adapter.runs], [['merge'], ['deploy']], 'the merge is never run twice; the next step continues');

  const two = r.locked('staging');
  await runStep(r.store, fake({ run: () => 'not an answer' }), two, r.at());
  assert.equal(release(r.store, two).state, 'unknown', 'an unreadable answer is unknown too');
  const notDone = fake({ observe: () => 'not-done' });
  const back = await reconcile(r.store, notDone, two, r.at());
  assert.deepEqual([back.state, back.step, back.step_outcome], ['locked', 'merge', 'not-done'], 'proven not done: it may run again');
  const again = await runStep(r.store, notDone, two, r.at());
  assert.deepEqual([notDone.runs, again.step_key, again.state], [['merge'], `${two}.merge.2`, 'merged'], 'the rerun has its own step key');
});

test('a read failure is never treated as not done', async (t) => {
  const r = rig(t);
  const one = r.locked('prod');
  const adapter = fake();
  await runStep(r.store, adapter, one, r.at());
  await runStep(r.store, fake({ run: () => { throw new Error('deploy runner killed'); } }), one, r.at());
  for (const observe of [() => { throw new Error('GitHub unreachable'); }, () => 'unknown', () => undefined, () => ({ outcome: 'probably-fine' })]) {
    const reader = fake({ observe });
    const after = await reconcile(r.store, reader, one, r.at());
    assert.deepEqual([after.state, after.step, after.step_outcome], ['unknown', 'deploy', null]);
    await assert.rejects(runStep(r.store, reader, one, r.at()), /reconcile it before any action/);
    assert.deepEqual(reader.runs, [], 'the deploy is not run again');
  }
  assert.equal(acquireLock(r.store, r.make('prod'), { ...r.at(), recheck: ELIGIBLE }).waitingFor, one, 'it keeps the lock while unknown');
  assert.equal(r.store.all("SELECT * FROM journal WHERE kind = 'release-still-unknown'").length, 4);
});

test('takeover with a new generation reconciles first', async (t) => {
  const r = rig(t);
  const one = r.locked('prod');
  const old = r.lease;
  await runStep(r.store, fake(), one, r.at());
  // The old controller starts the deploy and its lease expires before it hears back.
  let finish;
  const slow = fake({ run: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = runStep(r.store, slow, one, r.at(old));
  r.now += TTL + 1;
  const lease = r.leaseFor(r.store, 'second');
  assert.equal(lease.generation, 2);

  const adapter = fake({ observe: () => ({ outcome: 'done', deployedDigest: 'sha256:new' }) });
  await assert.rejects(runStep(r.store, adapter, one, r.at(lease)), /reconcile it after the takeover first/);
  assert.deepEqual(adapter.runs, []);
  const after = await reconcile(r.store, adapter, one, r.at(lease));
  assert.deepEqual([after.state, after.generation, after.deployed_digest], ['deployed', 2, 'sha256:new']);
  assert.equal(r.store.get('SELECT generation FROM release_locks WHERE release_id = ?', one).generation, 2, 'the new holder adopted the lock');

  finish('done');
  await assert.rejects(pending, FencedError, 'the old controller can no longer write');
  await assert.rejects(runStep(r.store, fake(), one, r.at(old)), FencedError);
  await runStep(r.store, adapter, one, r.at(lease));
  assert.deepEqual(adapter.runs, ['check'], 'the deploy that may have happened is not repeated');
  assert.equal(release(r.store, one).state, 'accepted');
  assert.deepEqual(release(r.store, one).history.map((entry) => [entry.step, entry.outcome, entry.how]),
    [['merge', 'done', 'ran'], ['deploy', 'done', 'observed'], ['check', 'done', 'ran']]);
});

test('the release tables are additive to an existing store', (t) => {
  const r = rig(t);
  r.store.db.exec('DROP TABLE releases; DROP TABLE release_locks;');
  r.store.close();
  const store = r.open();
  const tables = store.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'release%' ORDER BY name").map((row) => row.name);
  assert.deepEqual(tables, ['release_locks', 'releases']);
  assert.throws(() => createRelease(store, { project: 'sampleapp', destination: 'prod', campaignId: 'c', taskId: 'T1', verifiedSha: 'abc', steps: ['check'],
    lease: { instanceId: 'first', generation: 1 }, now: r.now }), /40-character/);
  assert.throws(() => createRelease(store, { project: 'sampleapp', destination: 'prod', campaignId: 'c', taskId: 'T1', verifiedSha: SHA, steps: ['merge'],
    lease: { instanceId: 'first', generation: 1 }, now: r.now }), /ends with its check step/);
});
