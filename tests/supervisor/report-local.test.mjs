// A campaign with `reportPublication: "local"` (campaign.mjs; docs/SUPERVISOR.md section 16): its verified report stays
// in this installation's store and leaves only through the campaign API's report route, never as a GitHub comment; and
// that route never hands out a report independent verification has not accepted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { declaration, skipWithoutSqlite } from './helpers.mjs';
import { harness } from './restart-harness.mjs';

const reportTask = { id: 'R1', issue: 437, title: 'research', deliverable: 'report', goal: 'Research only.', dependsOn: [], acceptance: ['reported'], references: ['AGENTS.md'] };

test('a report-local campaign posts its verified report nowhere on GitHub and keeps it for the report route', { skip: skipWithoutSqlite }, async (t) => {
  const { campaignReports } = await import('../../src/supervisor/remote-campaigns.mjs');
  const decl = { ...declaration({ tasks: [reportTask] }), reportPublication: 'local' };
  const h = await harness(t, { decl, scenario: { implement: ['report'], verify: ['accept-report-criterion'] } });
  const run = h.serve();
  await h.finished();
  run.kill();
  const { tasks } = campaignReports(h.store, h.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].state, 'done');
  assert.ok(tasks[0].report, 'the verified report is readable through the report route');
  assert.equal(h.env.comments().filter((c) => c.issue === '437').length, 0, 'nothing posted to the task issue');
  assert.ok(!h.env.comments().some((c) => String(c.body ?? '').includes(tasks[0].report)), 'the report text is in no GitHub comment');
});

test('the report route never returns a report that independent verification has not accepted', { skip: skipWithoutSqlite }, async (t) => {
  const { Store } = await import('../../src/supervisor/store.mjs');
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const { campaignReports } = await import('../../src/supervisor/remote-campaigns.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-report-route-'));
  const store = new Store(join(dir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const decl = { ...declaration({ campaignId: 'report-route', tasks: [reportTask] }), reportPublication: 'local' };
  campaignStart(store, decl);
  const patch = (changes) => store.patch('tasks', { campaign_id: decl.campaignId, task_id: 'R1' }, store.task(decl.campaignId, 'R1').version, changes, Date.now());

  patch({ state: 'implemented', result: JSON.stringify({ report: 'unverified worker output' }), head_sha: 'a'.repeat(40) });
  assert.equal(campaignReports(store, decl.campaignId).tasks[0].report, null, 'an implemented, unverified report is withheld');

  patch({ state: 'verified', verified_sha: 'a'.repeat(40) });
  assert.equal(campaignReports(store, decl.campaignId).tasks[0].report, null, 'a state label alone is not independent verification');
  const accepted = { verdict: 'accepted', targetSha: 'a'.repeat(40),
    reportDigest: createHash('sha256').update('unverified worker output').digest('hex'), findings: [],
    criteria: [{ criterion: 1, result: 'pass', check: 'Read the report', evidence: 'The requested finding is present.' }] };
  for (const invalid of [
    { ...accepted, targetSha: 'b'.repeat(40) },
    { ...accepted, reportDigest: '0'.repeat(64) },
    { ...accepted, criteria: [] },
    { ...accepted, criteria: [{ ...accepted.criteria[0], result: 'not-checked' }] },
    { ...accepted, criteria: [{ ...accepted.criteria[0], result: 'fail' }] },
    { ...accepted, findings: [{ severity: 'blocking', description: 'Required finding absent' }] }
  ]) {
    patch({ verification: JSON.stringify(invalid) });
    const result = campaignReports(store, decl.campaignId).tasks[0];
    assert.equal(result.report, null, 'stale, incomplete or failing verification never releases a report');
    assert.equal(result.reportSha256, null); assert.equal(result.verifiedSha, null);
  }
  patch({ verification: JSON.stringify(accepted) });
  assert.equal(campaignReports(store, decl.campaignId).tasks[0].report, 'unverified worker output', 'released after the exact report passed every required check');

  patch({ state: 'pending' });
  assert.equal(campaignReports(store, decl.campaignId).tasks[0].report, null, 'a task sent back for another round is withheld again');
});
