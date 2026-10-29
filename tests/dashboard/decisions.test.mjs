// Structured decisions (docs/design/OWNER_UI_V2.md WP2) and the scoped pause body limit. Synthetic store and campaigns only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { pendingInstructions } from '../../src/supervisor/instructions.mjs';
import { validResult } from '../../src/supervisor/adapters/claude.mjs';
import { applyDecision, supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { createDashboardServer, SCOPED_CONTROL_BYTES } from '../../src/dashboard/server.mjs';
import { declaration, environment } from '../supervisor/helpers.mjs';

const DECISION = { question: 'Which palette?', options: [{ id: 'brand', label: 'Brand', consequence: 'Two contrast fixes.' },
  { id: 'neutral', label: 'Neutral', consequence: 'Plainer.' }], suggestion: { option: 'neutral', reason: 'Passes contrast.' } };

test('only the owner answers a decision, once; a program AIWorks started, stale, wrong-step and replayed answers change nothing', async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); campaignStart(store, d);
  const block = (taskId, blocked) => { const task = store.task(d.campaignId, taskId); store.patch('tasks', { campaign_id: d.campaignId, task_id: taskId }, task.version, { blocked }, Date.now()); };
  block('T1', { class: 'B3', reason: 'owner-reserved: palette', at: 1000, decision: DECISION });
  block('T2', { class: 'B3', reason: 'owner-reserved: free text', at: 2000 });
  const c0 = store.campaign(d.campaignId);
  store.patch('campaigns', { id: d.campaignId }, c0.version, { blocker: { kind: 'budget', class: 'B3', reason: 'synthetic campaign blocker' } }, Date.now());
  const view = () => supervisorSnapshot(env.dataDir).campaigns[0];
  const bind = (taskId, extra = {}) => {
    const c = store.campaign(d.campaignId), task = view().tasks.find((item) => item.id === taskId);
    return { requestId: randomUUID(), campaignId: c.id, taskId, taskVersion: task.version, version: c.version, authorizationVersion: c.authorization_version,
      scopeDigest: c.scope_digest, decision: task.decision?.id ?? 'f'.repeat(32), ...extra };
  };
  const events = () => store.all("SELECT kind FROM events WHERE kind LIKE 'decision-%' OR kind = 'agent-instruction'").length;

  const t1 = view().tasks.find((item) => item.id === 'T1').decision;
  assert.deepEqual([t1.structured, t1.options.map((o) => o.id), t1.suggestion.option], [true, ['brand', 'neutral'], 'neutral']);
  assert.equal(view().tasks.find((item) => item.id === 'T2').decision.structured, false, 'a free-text stop stays answerable');

  // Wrong step, stale step version, an option the decision does not offer, an unknown field: refused with nothing written.
  assert.throws(() => applyDecision(env.dataDir, 'answer', { ...bind('T1', { option: 'brand' }), taskId: 'T2' }), (error) => error.status === 409);
  assert.throws(() => applyDecision(env.dataDir, 'answer', bind('T1', { option: 'brand', taskVersion: 99 })), (error) => error.status === 409);
  assert.throws(() => applyDecision(env.dataDir, 'answer', bind('T1', { option: 'other' })), (error) => error.status === 400);
  assert.throws(() => applyDecision(env.dataDir, 'answer', bind('T1', { option: 'brand', maxWorkerRuns: 99 })), (error) => error.status === 400);
  assert.equal(events(), 0);

  // Through the dashboard's own routes the caller check runs first: a program AIWorks started, or a request whose caller
  // could not be looked up, can neither answer, snooze nor dismiss a decision, and nothing is written.
  const serve = async (callerCheck) => {
    const server = createDashboardServer({ dataDir: env.dataDir, roadmap: { snapshot: () => ({ entries: [] }) }, callerCheck });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
    return async (action, body) => {
      const response = await fetch(`${base}/api/v2/decisions/${action}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
  };
  const lookup = (ancestors) => ({ platform: 'win32', lookup: async () => ({ pid: 999_991, ancestors, jobs: [] }) });
  const fromAIWorks = await serve(lookup([process.pid])), unchecked = await serve({}), owner = await serve(lookup([999_990]));
  for (const [post, code] of [[fromAIWorks, 'APPROVAL_FROM_AIWORKS'], [unchecked, 'APPROVAL_UNCHECKED']]) {
    for (const [action, extra] of [['answer', { option: 'brand' }], ['snooze', { snooze: '4h' }], ['not-needed', {}]]) {
      const refused = await post(action, bind('T1', extra));
      assert.deepEqual([refused.status, refused.body.code], [403, code], action);
    }
  }
  assert.equal(events(), 0, 'nothing was answered, snoozed or dismissed');
  assert.ok(store.task(d.campaignId, 'T1').blocked.decision, 'the decision is still open');

  const answer = bind('T1', { option: 'brand', text: 'Keep the logo blue.' });
  const answered = await owner('answer', answer);
  assert.equal(answered.status, 202, answered.body.error);
  assert.equal(answered.body.duplicate, false);
  assert.equal((await owner('answer', answer)).body.duplicate, true, 'an exact retry is acknowledged, never recorded twice');
  assert.throws(() => applyDecision(env.dataDir, 'answer', { ...answer, option: 'neutral' }), (error) => error.status === 409, 'one request id, one request');
  assert.throws(() => applyDecision(env.dataDir, 'answer', bind('T1', { option: 'neutral' })), (error) => error.status === 409, 'a decision is answered once');

  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
  const ctx = { id: d.campaignId, generation: lease.generation };
  controller.processEvents(ctx);
  controller.processEvents(ctx);
  const campaign = store.campaign(d.campaignId);
  assert.equal(store.task(d.campaignId, 'T1').blocked, null, 'the answered stop is cleared');
  assert.equal(store.task(d.campaignId, 'T2').blocked.class, 'B3', 'another step keeps its decision');
  assert.equal(campaign.blocker.reason, 'synthetic campaign blocker', 'the campaign blocker is not cleared');
  const guidance = pendingInstructions(store, campaign, 'T1', 'implement');
  assert.equal(guidance.length, 1, 'the next run gets the answer exactly once');
  assert.match(guidance[0].payload.text, /Brand \(brand\).*Keep the logo blue\./);
  assert.equal(store.task(d.campaignId, 'T1').state, 'pending');

  // After the step stopped again, the old answer's decision is gone: a replay of it, or of the old id, changes nothing.
  block('T1', { class: 'B3', reason: 'owner-reserved: palette again', at: 3000, decision: DECISION });
  assert.throws(() => applyDecision(env.dataDir, 'answer', { ...bind('T1', { option: 'brand' }), decision: t1.id }), (error) => error.status === 409);
  const again = bind('T1', { option: 'neutral' });
  applyDecision(env.dataDir, 'answer', again);
  block('T1', { class: 'B3', reason: 'owner-reserved: a newer stop before the controller read the answer', at: 4000 });
  controller.processEvents(ctx);
  assert.equal(store.task(d.campaignId, 'T1').blocked.at, 4000, 'an answer to an earlier stop never clears a newer one');
  assert.equal(pendingInstructions(store, campaign, 'T1', 'implement').length, 1, 'and gives no second guidance');

  // Snooze and "did not need me" are feedback only: the step stays stopped.
  applyDecision(env.dataDir, 'snooze', bind('T2', { snooze: '4h' }));
  applyDecision(env.dataDir, 'not-needed', bind('T2', { text: 'AIWorks could have chosen this.' }));
  assert.throws(() => applyDecision(env.dataDir, 'not-needed', bind('T2')), (error) => error.status === 409);
  controller.processEvents(ctx);
  const t2 = view().tasks.find((item) => item.id === 'T2');
  assert.equal(store.task(d.campaignId, 'T2').blocked.class, 'B3');
  assert.ok(t2.decision.snoozedUntil > Date.now() && t2.decision.notNeeded);
  assert.equal(pendingInstructions(store, campaign, 'T2').length, 0);
});

test('worker results may carry a structured decision; a result without one is valid as before and an unknown field is refused', () => {
  const expect = { deliverable: 'commit', targetSha: null, reportDigest: null };
  const base = { result: 'blocked-owner-reserved', summary: 'needs owner', ownerTrigger: 'Synthetic owner-reserved trigger' };
  assert.equal(validResult('implementation', base, expect), null);
  assert.equal(validResult('implementation', { ...base, decision: DECISION }, expect), null);
  assert.match(validResult('implementation', { ...base, decision: { ...DECISION, run: 'git push' } }, expect), /structured_output invalid/);
  assert.match(validResult('implementation', { ...base, decision: { ...DECISION, options: DECISION.options.slice(0, 1) } }, expect), /structured_output invalid/);
});

test('an accepted report must pass every acceptance criterion by entry, or the verification runs again instead of withholding the report forever', () => {
  const sha = 'a'.repeat(40), digest = 'b'.repeat(64), expect = { deliverable: 'report', targetSha: sha, reportDigest: digest, acceptance: 2 };
  const verdict = { verdict: 'accepted', targetSha: sha, reportDigest: digest, summary: 'holds', findings: [], checks: [{ command: 'Criterion 1', result: 'pass' }] };
  const entry = (criterion, result = 'pass') => ({ criterion, result, check: 'read the report', evidence: 'present' });
  assert.match(validResult('verification', verdict, expect), /every acceptance criterion/);
  assert.match(validResult('verification', { ...verdict, criteria: [entry(1), entry(2, 'not-checked')] }, expect), /every acceptance criterion/);
  assert.equal(validResult('verification', { ...verdict, criteria: [entry(1), entry(2)] }, expect), null);
  assert.equal(validResult('verification', verdict, { ...expect, deliverable: 'commit' }), null);
});

test('scoped pause accepts its largest valid selection and refuses a larger body unread, with nothing paused', async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); campaignStart(store, d);
  const server = createDashboardServer({ dataDir: env.dataDir, roadmap: { snapshot: () => ({ entries: [] }) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
  const headers = { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf };
  // 200 goal bindings, each field at its largest valid size: the parser lets it through to the all-or-nothing check,
  // which refuses it as not the scope's goals (409), never as too large.
  const goals = Array.from({ length: 200 }, (_, n) => ({ campaignId: `g${String(n).padStart(3, '0')}${'x'.repeat(60)}`, version: Number.MAX_SAFE_INTEGER,
    authorizationVersion: Number.MIN_SAFE_INTEGER, scopeDigest: 'a'.repeat(64) }));
  const largest = JSON.stringify({ requestId: randomUUID(), scope: 'all', goals });
  assert.ok(largest.length > 16_384 && largest.length <= SCOPED_CONTROL_BYTES);
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body });
  assert.equal((await post('/api/v2/pause', largest)).status, 409);
  assert.equal((await post('/api/v2/pause', JSON.stringify({ requestId: randomUUID(), scope: 'all', goals: [...goals, goals[0]] }))).status, 400);
  assert.equal((await post('/api/v2/pause', 'x'.repeat(SCOPED_CONTROL_BYTES + 1))).status, 413);
  assert.equal((await post('/api/commands', 'x'.repeat(16_385))).status, 413, 'every other command keeps its 16 KiB limit');
  assert.equal(store.campaign(d.campaignId).control, 'registered');
  assert.equal(store.get("SELECT COUNT(*) AS n FROM events WHERE kind = 'dashboard-command'").n, 0);
});

test('AW-016: AIWorks answers only a running step\'s reversible suggestion itself, once, and the owner sees what it chose', (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); campaignStart(store, d);
  const block = (taskId, blocked) => { const task = store.task(d.campaignId, taskId); store.patch('tasks', { campaign_id: d.campaignId, task_id: taskId }, task.version, { blocked }, Date.now()); };
  block('T1', { class: 'B3', reason: 'owner-reserved: palette', at: 1000, decision: { ...DECISION, reversible: true } });
  block('T2', { class: 'B3', reason: 'owner-reserved: spending', at: 2000, decision: DECISION });
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
  const ctx = { id: d.campaignId, generation: lease.generation };
  const campaign = () => store.campaign(d.campaignId);

  // Paused work is never answered for the owner.
  store.patch('campaigns', { id: d.campaignId }, campaign().version, { control: 'paused' }, Date.now());
  controller.answerSuggested(ctx);
  assert.equal(store.task(d.campaignId, 'T1').blocked.class, 'B3', 'nothing is answered while the work is paused');
  store.patch('campaigns', { id: d.campaignId }, campaign().version, { control: 'registered' }, Date.now());

  controller.answerSuggested(ctx);
  controller.answerSuggested(ctx);
  assert.equal(store.task(d.campaignId, 'T1').blocked, null, 'the reversible suggestion was taken');
  assert.equal(store.task(d.campaignId, 'T2').blocked.class, 'B3', 'a suggestion not marked reversible waits for the owner');
  const guidance = pendingInstructions(store, campaign(), 'T1', 'implement');
  assert.equal(guidance.length, 1, 'answered once, as guidance to the next run');
  assert.match(guidance[0].payload.text, /AIWorks answered.*Neutral \(neutral\)/);
  assert.equal(pendingInstructions(store, campaign(), 'T2').length, 0);

  const decided = supervisorSnapshot(env.dataDir).campaigns[0].autoDecisions;
  assert.deepEqual(decided.map((item) => [item.taskId, item.chosen, item.others]), [['T1', 'Neutral', ['Brand']]], 'the owner can read and change what AIWorks chose');

  // A second decision on the same step, under the same approval, waits for the owner: no answer loop of paid runs.
  block('T1', { class: 'B3', reason: 'owner-reserved: palette again', at: 5000, decision: { ...DECISION, reversible: true } });
  controller.answerSuggested(ctx);
  assert.equal(store.task(d.campaignId, 'T1').blocked?.class, 'B3', 'one automatic answer per step');
  // A "verifier still rejects" stall at the repair limit is never answered for the owner, reversible or not.
  block('T2', { class: 'stalled', reason: 'verifier still rejects after 2 repair rounds', at: 6000, decision: { ...DECISION, reversible: true } });
  controller.answerSuggested(ctx);
  assert.equal(store.task(d.campaignId, 'T2').blocked?.class, 'stalled', 'the owner\'s repair limit is never raised by AIWorks');
});

test('AW-016: a published result without a check on record goes back to the checker at the same head, once per head', (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); campaignStart(store, d);
  const head = 'c'.repeat(40);
  const task = store.task(d.campaignId, 'T1');
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, task.version,
    { state: 'done', head_sha: head, verified_sha: null, verification: null, pr_url: 'https://github.com/example-org/sampleapp/pull/9' }, Date.now());
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
  const ctx = { id: d.campaignId, generation: lease.generation };

  // A head merged, closed or pushed by someone else is left for the owner, recorded once; an unreadable GitHub waits.
  controller.uncheckedGone = () => undefined;
  controller.recheckUnchecked(ctx);
  assert.equal(store.task(d.campaignId, 'T1').state, 'done', 'nothing happens while GitHub cannot be read');
  controller.uncheckedGone = () => 'its pull request is no longer open';
  controller.recheckUnchecked(ctx);
  assert.equal(store.task(d.campaignId, 'T1').state, 'done', 'a closed pull request is never checked and published again');
  assert.equal(store.get("SELECT COUNT(*) AS n FROM events WHERE kind = 'unchecked-recheck-skipped'").n, 1);
  controller.uncheckedGone = () => null;
  controller.recheckUnchecked(ctx);
  assert.equal(store.task(d.campaignId, 'T1').state, 'done', 'a head left for the owner stays left');
  store.run("DELETE FROM events WHERE kind = 'unchecked-recheck-skipped'");

  controller.recheckUnchecked(ctx);
  const reopened = store.task(d.campaignId, 'T1');
  assert.deepEqual([reopened.state, reopened.head_sha, reopened.verified_sha], ['implemented', head, null], 'the next run is a check of the same head, nothing is rebuilt');

  // The check is lost again at the same head: no second check is started for it.
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, reopened.version, { state: 'done' }, Date.now());
  controller.recheckUnchecked(ctx);
  assert.equal(store.task(d.campaignId, 'T1').state, 'done', 'one check per head, never a loop of paid runs');
  assert.equal(store.get("SELECT COUNT(*) AS n FROM events WHERE kind = 'unchecked-recheck'").n, 1);
});
