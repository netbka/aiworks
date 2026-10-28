// Review of a result (docs/design/OWNER_UI_V2.md WP4): accept binds the exact verified head, and a goal with unresolved
// evidence is never shown as complete. Synthetic store and campaigns only; nothing here reads or writes GitHub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { validResult } from '../../src/supervisor/adapters/claude.mjs';
import { applyResultReview, supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { ownerView } from '../../src/dashboard/owner.mjs';
import { goalStrip } from '../../src/dashboard/views.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { declaration, environment } from '../supervisor/helpers.mjs';

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40), REPORT = '# Synthetic report';
const DIGEST = createHash('sha256').update(REPORT, 'utf8').digest('hex');
const task = (id, issue) => ({ id, issue, title: `${id} change`, deliverable: 'commit', goal: `Make the ${id} change.`, dependsOn: [],
  acceptance: ['The list shows every item', 'The list loads within one second'], references: ['AGENTS.md'] });
const verification = (criteria) => ({ verdict: 'accepted', targetSha: SHA, reportDigest: DIGEST, summary: 'Checked.', verdictSummary: 'It does what was promised.',
  findings: [], checks: [{ command: 'npm run check', result: 'pass' }], criteria, eyesOn: ['The wording of the empty list'] });

function rig(t) {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration({ campaignId: 'review-goal', tasks: [task('T1', 501), task('T2', 502)] });
  campaignStart(store, d);
  const finish = (taskId, criteria) => {
    const row = store.task(d.campaignId, taskId);
    store.patch('tasks', { campaign_id: d.campaignId, task_id: taskId }, row.version, { state: 'done', head_sha: SHA, verified_sha: SHA, result: { result: 'resolved', report: REPORT },
      verification: verification(criteria), pr_url: `https://github.com/example-org/sampleapp/pull/${row.task_id === 'T1' ? 7 : 8}` }, Date.now());
  };
  const view = () => supervisorSnapshot(env.dataDir).campaigns[0];
  const bind = (taskId, extra = {}) => {
    const c = view(), row = c.tasks.find((item) => item.id === taskId);
    return { requestId: randomUUID(), campaignId: c.id, taskId, taskVersion: row.version, version: c.version, authorizationVersion: c.authorizationVersion,
      scopeDigest: c.scopeDigest, verifiedSha: SHA, reportDigest: DIGEST, ...extra };
  };
  return { env, store, d, finish, view, bind };
}

test('accept records only the exact verified head and report; a changed, failing or merged head is refused and nothing merges', (t) => {
  const { env, store, d, finish, view, bind } = rig(t);
  finish('T1', [{ criterion: 1, result: 'pass', check: 'Opened the list', evidence: 'All 12 synthetic items shown.' },
    { criterion: 2, result: 'not-checked', check: 'No timing harness', evidence: 'Not measured.' }]);
  finish('T2', [{ criterion: 1, result: 'fail', check: 'Opened the list', evidence: 'Two items missing.' }]);
  const review = view().tasks.find((item) => item.id === 'T1').review;
  assert.deepEqual(review.criteria.map((item) => item.result), ['pass', 'not-checked']);
  assert.deepEqual([review.state, review.canAccept, review.unresolved.notChecked], ['ready', true, 1]);
  assert.deepEqual(view().tasks.find((item) => item.id === 'T2').review.criteria.map((item) => item.result), ['fail', 'not-checked'],
    'a criterion the checker did not report is not checked, never a pass');

  // A checker can never return a failed criterion as accepted.
  assert.equal(validResult('verification', verification([{ criterion: 1, result: 'fail', check: 'x', evidence: 'y' }]), { targetSha: SHA, reportDigest: DIGEST }),
    'accepted with a failed criterion');

  // Another head, another report, a stale step version, a failed criterion: refused, with nothing recorded.
  const refused = (input, status = 409) => assert.throws(() => applyResultReview(env.dataDir, 'accept', input), (error) => error.status === status);
  refused(bind('T1', { verifiedSha: OTHER }));
  refused(bind('T1', { reportDigest: 'c'.repeat(64) }));
  refused(bind('T1', { taskVersion: 99 }));
  refused(bind('T2'));
  refused(bind('T1', { text: 'not for accept' }), 400);
  assert.equal(store.all("SELECT 1 FROM events WHERE kind IN ('result-accepted', 'dashboard-command')").length, 0);

  const accept = bind('T1');
  assert.equal(applyResultReview(env.dataDir, 'accept', accept).duplicate, false);
  assert.equal(applyResultReview(env.dataDir, 'accept', accept).duplicate, true, 'an exact retry is acknowledged, never recorded twice');
  refused(bind('T1'));
  assert.equal(view().tasks.find((item) => item.id === 'T1').review.state, 'accepted');
  assert.equal(store.all("SELECT 1 FROM journal WHERE kind = 'result-accepted'").length, 1);
  // Acceptance is a record: no merge, publication or worker run follows from it.
  assert.equal(store.all("SELECT 1 FROM journal WHERE kind IN ('merged', 'merge-requested')").length, 0);
  assert.equal(store.all('SELECT 1 FROM outbox').length, 0);
  assert.equal(store.all('SELECT 1 FROM operations').length, 0);

  // A merged head takes no change request: changing it needs a new plan.
  store.journal(d.campaignId, 'merged', { task: 'T1', sha: SHA, url: 'https://github.com/example-org/sampleapp/pull/7' }, Date.now());
  assert.throws(() => applyResultReview(env.dataDir, 'request-changes', bind('T1', { text: 'Sort the list.' })), (error) => error.status === 409);
  assert.equal(store.all("SELECT 1 FROM events WHERE kind = 'result-changes'").length, 0);
});

test('a finished goal whose results have a criterion failed or not checked is never shown as complete', (t) => {
  const { env, store, d, finish } = rig(t);
  const all = [{ criterion: 1, result: 'pass', check: 'Opened the list', evidence: 'Shown.' }, { criterion: 2, result: 'pass', check: 'Timed it', evidence: '0.3 s.' }];
  finish('T1', all);
  finish('T2', [all[0]]);
  const c = store.campaign(d.campaignId);
  store.patch('campaigns', { id: d.campaignId }, c.version, { control: 'finished', status: 'finished' }, Date.now());
  const owner = () => ownerView(supervisorSnapshot(env.dataDir)).campaigns[d.campaignId];
  assert.equal(owner().counts.unresolved, 1);
  assert.equal(owner().releaseReady, false);
  assert.match(owner().finished, /not checked/);
  const t2 = store.task(d.campaignId, 'T2');
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T2' }, t2.version, { verification: verification(all) }, Date.now());
  assert.equal(owner().counts.unresolved, 0);
  assert.doesNotMatch(owner().finished, /not checked/);
});

test('Accept result and Request changes run the caller check first: a program AIWorks started records nothing', async (t) => {
  const { env, store, finish, bind } = rig(t);
  finish('T1', [{ criterion: 1, result: 'pass', check: 'Opened the list', evidence: 'All 12 synthetic items shown.' }]);
  const roadmap = { snapshot: () => ({ entries: [] }) };
  const serve = async (callerCheck) => {
    const server = createDashboardServer({ dataDir: env.dataDir, roadmap, callerCheck });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
    return async (path, body) => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
  };
  const lookup = (ancestors) => ({ platform: 'win32', lookup: async () => ({ pid: 999_991, ancestors, jobs: [] }) });
  const fromAIWorks = await serve(lookup([process.pid])), unchecked = await serve({}), owner = await serve(lookup([999_990]));
  const recorded = () => store.all("SELECT 1 FROM events WHERE kind IN ('result-accepted', 'result-changes', 'dashboard-command')").length;

  for (const post of [fromAIWorks, unchecked]) {
    const accept = await post('/api/v2/results/accept', bind('T1'));
    const changes = await post('/api/v2/results/request-changes', bind('T1', { text: 'Sort the list.' }));
    assert.deepEqual([accept.status, changes.status], [403, 403]);
  }
  assert.equal((await fromAIWorks('/api/v2/results/accept', bind('T1'))).body.code, 'APPROVAL_FROM_AIWORKS');
  assert.equal((await unchecked('/api/v2/results/accept', bind('T1'))).body.code, 'APPROVAL_UNCHECKED');
  assert.equal(recorded(), 0, 'nothing was accepted or sent back');

  const accepted = await owner('/api/v2/results/accept', bind('T1'));
  assert.equal(accepted.status, 202, accepted.body.error);
  assert.equal(store.all("SELECT 1 FROM journal WHERE kind = 'result-accepted'").length, 1);
});

test('a checked result with its criteria not checked is never shown or counted as passed, and links only to its own result', (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration({ campaignId: 'report-goal', tasks: [{ ...task('R1', 601), deliverable: 'report',
    acceptance: ['The review names each risk', 'Each risk has evidence', 'Each risk has an owner action'] }] });
  campaignStart(store, d);
  const finish = (criteria, url) => {
    const row = store.task(d.campaignId, 'R1');
    store.patch('tasks', { campaign_id: d.campaignId, task_id: 'R1' }, row.version, { state: 'done', head_sha: SHA, verified_sha: SHA,
      result: { result: 'resolved', report: REPORT }, verification: verification(criteria), pr_url: url }, Date.now());
  };
  const read = () => {
    const snapshot = supervisorSnapshot(env.dataDir), c = snapshot.campaigns[0];
    const rows = Object.values(ownerView(snapshot).results).flatMap((project) => project.groups.flatMap((group) => group.rows));
    return { step: c.tasks[0], strip: goalStrip(c), row: rows.find((item) => item.taskId === 'R1') };
  };

  // Accepted by the checker, yet none of its three criteria reported, and its comment sits on an unrelated pull request.
  finish([], 'https://github.com/example-org/sampleapp/pull/9#issuecomment-12');
  const unchecked = read();
  assert.equal(unchecked.step.review.unresolved.notChecked, 3);
  assert.equal(unchecked.step.checkPassed, false);
  assert.equal(unchecked.strip.checked, 0, 'an unchecked result is never counted as checked');
  assert.equal(unchecked.step.resultUrl, null, 'a link to another pull request is not this step\'s result');

  const all = [1, 2, 3].map((criterion) => ({ criterion, result: 'pass', check: 'Read the report', evidence: 'Present.' }));
  finish(all, 'https://github.com/example-org/sampleapp/issues/601#issuecomment-13');
  const passed = read();
  assert.equal(passed.step.checkPassed, true);
  assert.equal(passed.strip.checked, 1);
  assert.equal(passed.step.resultUrl, 'https://github.com/example-org/sampleapp/issues/601#issuecomment-13');

  // Partly checked on its own issue: the row's evidence is never the passed one.
  finish(all.slice(0, 2), 'https://github.com/example-org/sampleapp/issues/601#issuecomment-13');
  const partly = read();
  assert.equal(partly.step.checkPassed, false);
  assert.notEqual(partly.row.evidence, passed.row.evidence, 'a partly checked result is never shown as passed');
});
