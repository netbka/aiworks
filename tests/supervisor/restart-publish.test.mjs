// AIWorks crash/restart rehearsal, publication side (harness in restart-harness.mjs): a controller killed around a push,
// a PR or a report post, with one or several operations open, publishes each result exactly once when replaced.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declaration, skipWithoutSqlite } from './helpers.mjs';
import { allFinished, harness, implementCalls, ops, single } from './restart-harness.mjs';

test('killed between push and PR creation: exactly one PR at the verified SHA', { skip: skipWithoutSqlite }, async (t) => {
  const h = await harness(t, {});
  assert.equal(await h.serve({ AIWORKS_FAULT: 'after-push' }).exited, 86);
  const next = h.serve();
  await h.finished();
  next.kill();
  const prs = h.env.prs();
  assert.equal(prs.length, 1);
  const task = h.store.task(h.id, 'T1');
  assert.equal(h.env.remoteHead(`campaign/${h.id}/T1`), task.verified_sha);
});

test('killed after posting a verified report: the replacement reconciles and does not repost', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [{ id: 'R1', issue: 437, title: 'research', deliverable: 'report', goal: 'Research only.', dependsOn: [], acceptance: ['posted'], references: ['AGENTS.md'] }] });
  const h = await harness(t, { decl, scenario: { implement: ['report'] } });
  assert.equal(await h.serve({ AIWORKS_FAULT: 'after-report-post' }).exited, 86);
  const next = h.serve();
  await h.finished();
  next.kill();
  assert.equal(h.env.comments().filter((c) => c.issue === '437').length, 1);
});

test('killed between two checkpoints: each recorded operation launches once', { skip: skipWithoutSqlite }, async (t) => {
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const work = 'sleep:2000:commit';
  const h = await harness(t, { decl: single('rec-a', 501), config: { scheduler: { enabled: true, maxWorkers: 4 } },
    repositories: ['example-org/service'], scenario: { implement: [work, work] } });
  campaignStart(h.store, single('rec-b', 502, 'example-org/service'));
  // First kill: the first admitted operation is recorded, then the controller dies before launching it.
  assert.equal(await h.serve({ AIWORKS_FAULT: 'after-record' }).exited, 86);
  assert.deepEqual(h.store.all('SELECT state FROM operations').map((op) => op.state), ['recorded']);
  assert.equal(h.env.calls().length, 0);
  // Second kill: the replacement resumes or still holds that operation, admits the other campaign's step, records it and
  // dies before launching it. Resuming records nothing new, so the fault fires only at the second record.
  assert.equal(await h.serve({ AIWORKS_FAULT: 'after-record' }).exited, 86);
  const recorded = h.store.all('SELECT id, campaign_id, kind FROM operations ORDER BY created_at');
  assert.deepEqual(recorded.map((op) => op.kind), ['implement', 'implement'], 'two operations recorded');
  assert.deepEqual(recorded.map((op) => op.campaign_id).sort(), ['rec-a', 'rec-b'], 'one per campaign');
  assert.ok(implementCalls(h) <= 1, 'the operation recorded last never launched');
  const next = h.serve();
  await h.waitFor(() => allFinished(h, ['rec-a', 'rec-b']));
  next.kill();
  assert.equal(implementCalls(h), 2, 'one implement call per task: no recorded operation launched twice or was replaced');
  const implement = h.store.all("SELECT id, outcome FROM operations WHERE kind = 'implement' ORDER BY created_at");
  assert.deepEqual(implement.map((op) => op.id), recorded.map((op) => op.id), 'the recorded operations themselves ran, under their ids');
  for (const op of implement) assert.equal(op.outcome?.class, 'result');
});

test('killed between push and PR with two tasks publishing: one PR each', { skip: skipWithoutSqlite }, async (t) => {
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const h = await harness(t, { decl: single('pub-a', 531), config: { scheduler: { enabled: true, maxWorkers: 4 } }, repositories: ['example-org/service'] });
  campaignStart(h.store, single('pub-b', 532, 'example-org/service'));
  const repositories = { 'pub-a': 'example-org/sampleapp', 'pub-b': 'example-org/service' };
  assert.equal(await h.serve({ AIWORKS_FAULT: 'after-push' }).exited, 86, 'killed after the first push, before its PR');
  assert.equal(h.env.prs().length, 0);
  const pushed = Object.entries(repositories).filter(([id, repository]) => h.remoteHead(repository, `campaign/${id}/T1`));
  assert.equal(pushed.length, 1, 'one branch pushed without its PR');
  const next = h.serve();
  await h.waitFor(() => allFinished(h, ['pub-a', 'pub-b']));
  next.kill();
  const heads = h.env.prs().map((pr) => pr.head).sort();
  assert.deepEqual(heads, ['campaign/pub-a/T1', 'campaign/pub-b/T1'], 'one PR for each task, none twice');
  for (const [id, repository] of Object.entries(repositories)) {
    assert.equal(h.remoteHead(repository, `campaign/${id}/T1`), h.store.task(id, 'T1').verified_sha, `${id}: the branch carries the verified head`);
  }
});
