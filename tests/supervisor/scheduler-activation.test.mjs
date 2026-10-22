// RUN10 (ADAPTIVE_SCHEDULER slice S9): the scheduler's activation-critical case, on actual `serve` controllers over
// disposable repositories (harness in restart-harness.mjs). Host pressure and an account at its learned limit keep new
// paid runs waiting while nothing runs twice; independent projects are admitted fairly up to the hard host ceiling while
// an overlapping write domain waits for integration; a controller killed with runs open is replaced without a second
// dispatch or a second budget charge. The account state is the row an earlier usage-limit refusal leaves (accounts.mjs).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { skipWithoutSqlite, sleep } from './helpers.mjs';
import { allFinished, git, harness, implementCalls, openOperations, peakOpen, single } from './restart-harness.mjs';

const IDS = ['act-a', 'act-b', 'act-c', 'act-d'];
const ACCOUNT = 'claude-cli'; // the account of the fake executor kind: no providerAccounts mapping, as by default

test('the activation cohort waits for pressure, account and domain limits without a second paid dispatch', { skip: skipWithoutSqlite }, async (t) => {
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const work = 'sleep:8000:commit';
  // Every campaign may spend exactly its implement and verify runs: a second dispatch or a second charge after the
  // takeover exhausts it. act-a and act-b own example-org/sampleapp; act-c and act-d have repositories of their own.
  const limited = (decl) => ({ ...decl, limits: { maxWorkerRuns: 2 } });
  const h = await harness(t, { decl: limited(single('act-a', 551)), repositories: ['example-org/service', 'example-org/sample-wiki'],
    config: { scheduler: { enabled: true, maxWorkers: 2, pressure: { minFreeDiskBytes: Number.MAX_SAFE_INTEGER } }, integrationPollMs: 1000 },
    scenario: { implement: [work, work, work, work] } });
  campaignStart(h.store, limited(single('act-b', 552)));
  campaignStart(h.store, limited(single('act-c', 553, 'example-org/service')));
  campaignStart(h.store, limited(single('act-d', 554, 'example-org/sample-wiki')));

  // Host pressure: every worktree volume reads as full, so nothing starts at all.
  const pressured = h.serve();
  await h.waitFor(() => h.store.get("SELECT detail FROM journal WHERE kind = 'host-pressure'"));
  await sleep(1500);
  pressured.kill();
  await pressured.exited;
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM operations').n, 0, 'host pressure admitted no operation');
  assert.equal(h.env.calls().length, 0, 'and started no paid run');
  assert.equal(h.store.get("SELECT detail FROM journal WHERE kind = 'host-pressure'").detail.signal, 'disk');

  // The activation configuration, and an account that throttled earlier: its learned limit is one run at a time.
  writeFileSync(join(h.env.dataDir, 'config.json'), JSON.stringify({ ...h.env.config, scheduler: { enabled: true, maxWorkers: 2 }, integrationPollMs: 1000 }, null, 2));
  h.store.run("INSERT INTO capacity (scope, id, value, reason, updated_at) VALUES ('account', ?, 1, 'an earlier usage-limit refusal', ?)", ACCOUNT, Date.now());
  const owner = join(h.env.tmp, 'owner-clone');
  git(h.env.tmp, 'clone', '-q', h.env.origin, owner);
  git(owner, 'config', 'user.name', 'Owner');
  git(owner, 'config', 'user.email', 'owner@example.invalid');
  let merged = null;
  const ownerMerges = () => {
    // Whichever of act-a and act-b publishes first holds example-org/sampleapp until the owner merges it.
    const first = ['act-a', 'act-b'].find((id) => h.store.task(id, 'T1').state === 'done');
    if (merged || !first) return;
    git(owner, 'fetch', '-q', 'origin', 'main');
    git(owner, 'checkout', '-q', '--detach', 'origin/main');
    git(owner, 'fetch', '-q', 'origin', `campaign/${first}/T1`);
    git(owner, 'merge', '-q', '--no-ff', '-m', `Merge ${first}`, h.store.task(first, 'T1').verified_sha);
    merged = { first, second: first === 'act-a' ? 'act-b' : 'act-a', at: Date.now() };
    git(owner, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  };

  // Kill the controller while two runs are open and both launched, then let a replacement adopt them.
  const first = h.serve();
  const launched = await h.waitFor(() => {
    ownerMerges();
    const open = openOperations(h.store);
    const recorded = h.store.get('SELECT COUNT(*) AS n FROM operations').n;
    return open.length === 2 && h.env.calls().length === recorded ? open : null;
  }, 240_000);
  first.kill();
  await first.exited;
  const second = h.serve();
  await h.waitFor(() => { ownerMerges(); return allFinished(h, IDS); }, 300_000);
  second.kill();

  const ops = h.store.all('SELECT id, campaign_id, kind, state, outcome, created_at, updated_at FROM operations ORDER BY created_at, id');
  assert.ok(ops[1].created_at >= ops[0].updated_at, 'while the account allowed one run, the second started only after the first ended');
  const raised = h.store.all("SELECT detail FROM journal WHERE kind = 'account-concurrency-raised'").map((row) => row.detail);
  assert.deepEqual(raised.map((d) => [d.account, d.from, d.to]), [[ACCOUNT, 1, 2]], 'a useful result while work waited raised the account limit once');
  assert.ok(['act-c', 'act-d'].includes(ops[1].campaign_id), 'a never-served project was admitted before the served project went on');
  assert.ok(peakOpen(h.store) <= 2, `never more than the host ceiling of two open (saw ${peakOpen(h.store)})`);
  assert.equal(peakOpen(h.store), 2, 'independent work ran side by side once the account allowed it');

  const writers = (id) => ops.filter((op) => op.campaign_id === id && op.kind === 'implement');
  assert.ok(writers(merged.second)[0].created_at >= writers(merged.first)[0].updated_at, 'example-org/sampleapp was never written by two steps at once');
  assert.ok(writers(merged.second)[0].created_at >= merged.at, `${merged.second} started only after ${merged.first} was merged`);

  for (const op of launched) {
    const row = ops.find((item) => item.id === op.id);
    assert.deepEqual([row.state, row.outcome?.class], ['finished', 'result'], `${op.id} was adopted and its result consumed`);
  }
  for (const id of IDS) {
    assert.deepEqual(ops.filter((op) => op.campaign_id === id).map((op) => [op.kind, op.state]), [['implement', 'finished'], ['verify', 'finished']],
      `${id}: one implement and one verify run, none dispatched again`);
    const campaign = h.store.campaign(id);
    assert.equal(campaign.runs_used, 2, `${id}: each run charged once`);
    assert.equal(campaign.blocker, null, `${id}: the budget was never exhausted by a duplicate`);
  }
  assert.equal(implementCalls(h), 4, 'four paid implement runs in all');
  assert.equal(h.env.calls().filter((call) => call.role === 'verify').length, 4, 'four paid verify runs in all');
  assert.deepEqual(h.env.prs().map((pr) => pr.head).sort(), IDS.map((id) => `campaign/${id}/T1`), 'one PR each, none twice');
});
