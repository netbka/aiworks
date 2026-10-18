// AIWorks crash/restart rehearsal with several open operations and two controllers (RUN6, ADAPTIVE_SCHEDULER slice S7;
// harness in restart-harness.mjs): a takeover adopts every live run, parallel admission never exceeds the ceiling or
// shares a write domain, and cancelling one campaign stops only its runs. These are the longest cases, in a file of their own.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { skipWithoutSqlite, sleep } from './helpers.mjs';
import { allFinished, git, harness, implementCalls, openOperations, peakOpen, single } from './restart-harness.mjs';

test('takeover with three live runs adopts all and dispatches none again', { skip: skipWithoutSqlite }, async (t) => {
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  // A run must outlive the two other launches (up to dispatchWaitMs each under load), the kill and the lease takeover.
  const slow = 'sleep:30000:commit';
  const h = await harness(t, { decl: single('live-a', 511), config: { scheduler: { enabled: true, maxWorkers: 3 } },
    repositories: ['example-org/service', 'example-org/sample-wiki'], scenario: { implement: [slow, slow, slow] } });
  campaignStart(h.store, single('live-b', 512, 'example-org/service'));
  campaignStart(h.store, single('live-c', 513, 'example-org/sample-wiki'));
  const first = h.serve();
  await h.waitFor(() => implementCalls(h) === 3, 180_000);
  first.kill();
  await first.exited;
  const live = openOperations(h.store);
  assert.deepEqual(live.map((op) => op.campaign_id).sort(), ['live-a', 'live-b', 'live-c'], 'three runs open when the controller died');
  const second = h.serve();
  await h.waitFor(() => allFinished(h, ['live-a', 'live-b', 'live-c']), 240_000);
  second.kill();
  assert.equal(implementCalls(h), 3, 'all three adopted; none dispatched again');
  for (const op of live) {
    const implement = h.store.all("SELECT id, outcome FROM operations WHERE campaign_id = ? AND kind = 'implement'", op.campaign_id);
    assert.deepEqual(implement.map((row) => [row.id, row.outcome?.class]), [[op.id, 'result']], `${op.campaign_id}: the adopted run's result was consumed`);
  }
  assert.ok(peakOpen(h.store) <= 3, `never more than the ceiling of three open (saw ${peakOpen(h.store)})`);
});

test('two controllers with parallel admission never exceed the ceiling or share a domain', { skip: skipWithoutSqlite }, async (t) => {
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const work = 'sleep:3000:commit';
  // two-a and two-b both own example-org/sampleapp; two-c and two-d have repositories of their own.
  const h = await harness(t, { decl: single('two-a', 521), config: { scheduler: { enabled: true, maxWorkers: 2 }, integrationPollMs: 1000 },
    repositories: ['example-org/service', 'example-org/sample-wiki'], scenario: { implement: [work, work, work, work] } });
  campaignStart(h.store, single('two-b', 522));
  campaignStart(h.store, single('two-c', 523, 'example-org/service'));
  campaignStart(h.store, single('two-d', 524, 'example-org/sample-wiki'));
  // The owner merges in a clone of their own, never in the checkout the running controllers use.
  const owner = join(h.env.tmp, 'owner-clone');
  git(h.env.tmp, 'clone', '-q', h.env.origin, owner);
  git(owner, 'config', 'user.name', 'Owner');
  git(owner, 'config', 'user.email', 'owner@example.invalid');
  const a = h.serve();
  const b = h.serve();
  let merged = null;
  await h.waitFor(() => {
    // Whichever of two-a and two-b publishes first holds example-org/sampleapp until the owner merges its PR; under load either may.
    const first = ['two-a', 'two-b'].find((id) => h.store.task(id, 'T1').state === 'done');
    if (!merged && first) {
      git(owner, 'fetch', '-q', 'origin', 'main');
      git(owner, 'checkout', '-q', '--detach', 'origin/main');
      git(owner, 'fetch', '-q', 'origin', `campaign/${first}/T1`);
      git(owner, 'merge', '-q', '--no-ff', '-m', `Merge ${first}`, h.store.task(first, 'T1').verified_sha);
      merged = { first, second: first === 'two-a' ? 'two-b' : 'two-a', at: Date.now() };
      git(owner, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    }
    return allFinished(h, ['two-a', 'two-b', 'two-c', 'two-d']);
  }, 300_000);
  a.kill();
  b.kill();
  assert.equal(peakOpen(h.store), 2, 'work ran in parallel up to the ceiling of two, never above it');
  const writers = (id) => h.store.all("SELECT created_at, updated_at FROM operations WHERE campaign_id = ? AND kind = 'implement'", id);
  assert.equal(writers(merged.first).length, 1);
  assert.equal(writers(merged.second).length, 1);
  assert.ok(writers(merged.second)[0].created_at >= writers(merged.first)[0].updated_at, 'example-org/sampleapp was never written by two steps at once');
  assert.ok(writers(merged.second)[0].created_at >= merged.at, `${merged.second} started only after ${merged.first}'s PR was merged`);
  assert.equal(implementCalls(h), 4, 'no step dispatched twice by the two controllers');
  const heads = h.env.prs().map((pr) => pr.head).sort();
  assert.deepEqual(heads, ['two-a', 'two-b', 'two-c', 'two-d'].map((id) => `campaign/${id}/T1`), 'one PR each, none twice');
});

test('cancelling one campaign stops only its runs and releases domains after containment', { skip: skipWithoutSqlite }, async (t) => {
  const { campaignCancel, campaignStart } = await import('../../src/supervisor/api.mjs');
  // Both first runs must still be live when the cancel lands and while containment stops cut-a's run.
  const slow = 'sleep:30000:commit';
  const h = await harness(t, { decl: single('cut-a', 541), config: { scheduler: { enabled: true, maxWorkers: 3 } },
    repositories: ['example-org/service'], scenario: { implement: [slow, slow, 'commit'] } });
  campaignStart(h.store, single('keep-b', 542, 'example-org/service'));
  const serve = h.serve();
  await h.waitFor(() => implementCalls(h) === 2, 180_000);
  // wait-c shares example-org/sampleapp with cut-a's running step; the ceiling of three has room, so only the domain holds it.
  campaignStart(h.store, single('wait-c', 543));
  await sleep(1000);
  assert.equal(h.store.all("SELECT id FROM operations WHERE campaign_id = 'wait-c'").length, 0, 'wait-c waits for example-org/sampleapp');
  campaignCancel(h.store, 'cut-a', 'rehearsal');
  const cut = await h.waitFor(() => h.store.get("SELECT id, outcome, updated_at FROM operations WHERE campaign_id = 'cut-a' AND state = 'abandoned'"));
  assert.equal(cut.outcome.class, 'cancelled');
  assert.equal(cut.outcome.detail, 'stopped', 'containment confirmed the stop');
  assert.deepEqual(openOperations(h.store).filter((op) => op.campaign_id === 'keep-b').map((op) => op.kind), ['implement'], 'keep-b is still running');
  await h.waitFor(() => allFinished(h, ['keep-b', 'wait-c']), 240_000);
  serve.kill();
  assert.equal(h.store.campaign('cut-a').control, 'cancelled');
  const kept = h.store.all("SELECT state, outcome FROM operations WHERE campaign_id = 'keep-b' AND kind = 'implement'");
  assert.deepEqual(kept.map((op) => [op.state, op.outcome?.class]), [['finished', 'result']], "the other campaign's run was not touched");
  const waited = h.store.get("SELECT created_at FROM operations WHERE campaign_id = 'wait-c' AND kind = 'implement'");
  assert.ok(waited.created_at >= cut.updated_at, 'example-org/sampleapp was admitted again only after containment stopped the cancelled run');
  assert.equal(h.env.prs().filter((pr) => pr.head === 'campaign/cut-a/T1').length, 0, 'the cancelled campaign published nothing');
  assert.equal(h.remoteHead('example-org/sampleapp', 'campaign/cut-a/T1'), null, 'nor pushed its branch');
});
