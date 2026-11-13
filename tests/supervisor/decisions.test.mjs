// Changing a recorded decision answer (docs/design/HOME_V2.md 2.1). Synthetic store and campaigns only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { decisionInstructions, pendingInstructions } from '../../src/supervisor/instructions.mjs';
import { applyAnswerChange, applyDecision, supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { declaration, environment } from './helpers.mjs';

const DECISION = { question: 'Which palette?', options: [{ id: 'brand', label: 'Brand', consequence: 'Two contrast fixes.' },
  { id: 'neutral', label: 'Neutral', consequence: 'Plainer.' }], suggestion: { option: 'neutral', reason: 'Passes contrast.' }, reversible: true };

/** A campaign whose step T1 AIWorks answered itself (AW-017), and a change request bound to what the page shows. */
function answered(t) {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); campaignStart(store, d);
  const task = store.task(d.campaignId, 'T1');
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, task.version, { blocked: { class: 'B3', reason: 'owner-reserved: palette', at: 1000, decision: DECISION } }, Date.now());
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
  controller.answerSuggested({ id: d.campaignId, generation: lease.generation });
  const shown = () => supervisorSnapshot(env.dataDir).campaigns[0].autoDecisions.find((item) => item.taskId === 'T1');
  const bind = (extra = {}) => {
    const c = store.campaign(d.campaignId), row = store.task(d.campaignId, 'T1'), view = shown();
    return { requestId: randomUUID(), campaignId: c.id, taskId: 'T1', taskVersion: row.version, version: c.version, authorizationVersion: c.authorization_version,
      scopeDigest: c.scope_digest, decision: view.decision, answer: view.answer, option: 'brand', ...extra };
  };
  return { env, store, campaignId: d.campaignId, shown, bind };
}

test('a stale, replayed or already-used answer change never rewrites the step, reopens it or repeats its work', (t) => {
  const { env, store, campaignId, shown, bind } = answered(t);
  const changes = () => store.all("SELECT kind FROM journal WHERE campaign_id = ? AND kind = 'decision-changed'", campaignId).length;
  const first = shown();
  assert.equal(first.chosen, 'Neutral');

  // Bound to an answer that is not the one in force: refused, nothing written.
  assert.throws(() => applyAnswerChange(env.dataDir, bind({ answer: first.answer + 1000 })), (error) => error.status === 409);
  assert.equal(changes(), 0);

  // The change is applied once; a retry of the same request is acknowledged, and another request bound to the same,
  // now replaced answer is stale.
  const request = bind();
  assert.equal(applyAnswerChange(env.dataDir, request).outcome, 'changed');
  assert.equal(applyAnswerChange(env.dataDir, request).duplicate, true);
  assert.throws(() => applyAnswerChange(env.dataDir, { ...request, requestId: randomUUID() }), (error) => error.status === 409);
  assert.equal(changes(), 1);

  // A run worked under an earlier answer (here one recorded after AIWorks's answer): the change is never reported as
  // simply applied, and exactly one follow-up makes sure that work is checked against the new answer.
  const latest = () => store.all("SELECT seq FROM journal WHERE campaign_id = ? AND kind = 'decision-changed' ORDER BY seq", campaignId).at(-1).seq;
  const items = () => store.all("SELECT number FROM work_items WHERE campaign_id = ? AND task_id = 'T1'", campaignId).length;
  store.insert('operations', { id: 'synthetic.implement.1', campaign_id: campaignId, task_id: 'T1', kind: 'implement', seq: 1, idempotency_key: 'synthetic-1',
    lease_generation: 1, state: 'finished', session_id: 's', run_dir: 'r', workspace: 'w', packet: '{}', packet_digest: 'd', created_at: Date.now(), updated_at: Date.now() });
  const afterRun = { ...request, requestId: randomUUID(), option: 'neutral', answer: latest() };
  assert.equal(applyAnswerChange(env.dataDir, afterRun).outcome, 'changed-later');
  assert.equal(items(), 1, 'one bounded follow-up');
  assert.equal(applyAnswerChange(env.dataDir, afterRun).duplicate, true);
  assert.equal(items(), 1, 'a replay adds none');

  // The step already used the answer: its result, head and runs are kept exactly; one more follow-up records the new
  // answer, which is kept for the step only in case it is reopened.
  const row = store.task(campaignId, 'T1');
  store.patch('tasks', { campaign_id: campaignId, task_id: 'T1' }, row.version, { state: 'done', head_sha: 'a'.repeat(40), verified_sha: 'a'.repeat(40) }, Date.now());
  const before = JSON.stringify(store.task(campaignId, 'T1')), ops = JSON.stringify(store.all('SELECT * FROM operations WHERE campaign_id = ?', campaignId));
  const replaced = latest();
  const used = { ...request, requestId: randomUUID(), taskVersion: store.task(campaignId, 'T1').version, option: 'brand', answer: replaced };
  assert.equal(applyAnswerChange(env.dataDir, used).outcome, 'follow-up');
  assert.equal(JSON.stringify(store.task(campaignId, 'T1')), before, 'the finished step is not reopened or rewritten');
  assert.equal(JSON.stringify(store.all('SELECT * FROM operations WHERE campaign_id = ?', campaignId)), ops, 'no run is started or changed');
  assert.deepEqual(decisionInstructions(store, store.campaign(campaignId), 'T1').map((item) => item.payload.provenance?.replaces), [replaced]);
  assert.equal(items(), 2);
  assert.equal(applyAnswerChange(env.dataDir, used).duplicate, true);
  assert.equal(items(), 2, 'a replay adds none');
  // The whole history stays: AIWorks's answer with its provenance, then every change.
  assert.deepEqual(store.all("SELECT kind, detail FROM journal WHERE campaign_id = ? AND kind IN ('decision-answered', 'decision-changed') ORDER BY seq", campaignId)
    .map((r) => [r.kind, r.detail.option, r.detail.auto ?? r.detail.by]),
  [['decision-answered', 'neutral', true], ['decision-changed', 'brand', 'owner'], ['decision-changed', 'neutral', 'owner'], ['decision-changed', 'brand', 'owner']]);
});

test('a changed answer replaces the earlier one in every later run under the same authority, and never under another', (t) => {
  const { env, store, campaignId, shown, bind } = answered(t);
  const first = shown(), request = bind({ text: 'Keep the logo blue.' });
  applyAnswerChange(env.dataDir, request);
  const c = store.campaign(campaignId);
  const original = store.get('SELECT seq FROM events WHERE dedup_key = ?', `instruction:decision:${campaignId}:${first.decision}`)?.seq;
  assert.ok(original, 'the replaced answer stays in the record');
  assert.deepEqual(decisionInstructions(store, c, 'T1').map((item) => [item.dedup_key, item.payload.provenance.requestId, item.payload.provenance.replaces]),
    [[`instruction:decision:${campaignId}:${first.decision}:change:${request.requestId}`, request.requestId, first.answer]], 'only the owner change reaches the packet');
  assert.ok(!pendingInstructions(store, c, 'T1').some((item) => item.seq === original), 'the replaced answer is never delivered again');
  assert.equal(decisionInstructions(store, { ...c, authorization_version: c.authorization_version + 1 }, 'T1').length, 0, 'another authority inherits nothing');
  assert.equal(decisionInstructions(store, c, 'T2').length, 0, 'nor does another step');
  assert.equal(store.task(campaignId, 'T1').blocked, null, 'a change clears and sets no stop');
});

test('a part the owner answered reaches the worker as the owner\'s, the rest stays open, and a point asked again is answered from the record', (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); campaignStart(store, d);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  const ctx = () => ({ id: d.campaignId, generation: store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000).generation });
  const stop = (at, parts) => {
    const task = store.task(d.campaignId, 'T1');
    store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, task.version, { blocked: { class: 'B3', reason: 'owner-reserved: release choices', at,
      decision: { question: 'Release choices', parts } } }, Date.now());
  };
  // Neither part is reversible nor has a safeOption: AIWorks may not answer them itself.
  const palette = (id) => ({ id, question: 'Which palette?', options: [{ id: 'brand', label: 'Brand', consequence: 'Two contrast fixes.' }, { id: 'plain', label: 'Neutral', consequence: 'Plainer.' }] });
  const font = { id: 'font', question: 'Which font?', options: [{ id: 'serif', label: 'Serif', consequence: 'Classic.' }, { id: 'sans', label: 'Sans', consequence: 'Modern.' }] };
  stop(1000, [palette('palette'), font]);

  const shown = () => supervisorSnapshot(env.dataDir).campaigns[0].tasks.find((item) => item.id === 'T1').decision;
  assert.deepEqual(shown().parts.map((p) => p.id), ['palette', 'font']);
  const c = store.campaign(d.campaignId), requestId = randomUUID();
  const bind = { requestId, campaignId: c.id, taskId: 'T1', taskVersion: store.task(c.id, 'T1').version, version: c.version,
    authorizationVersion: c.authorization_version, scopeDigest: c.scope_digest, decision: shown().id };
  assert.throws(() => applyDecision(env.dataDir, 'answer', { ...bind, parts: { palette: 'other' } }), (error) => error.status === 400);
  applyDecision(env.dataDir, 'answer', { ...bind, parts: { palette: 'brand' } });
  controller.processEvents(ctx());

  // The worker's packet gets the owner's part with the supervisor's provenance, and the unanswered part as open.
  const texts = () => decisionInstructions(store, store.campaign(d.campaignId), 'T1').map((item) => item.payload.text);
  const first = texts().at(-1);
  assert.match(first, /Part palette: Which palette\? Settled, the owner's answer: Brand \(brand\)/);
  assert.match(first, new RegExp(`owner request ${requestId}`));
  assert.match(first, /Part font: Which font\? Still open/);
  assert.equal(store.task(d.campaignId, 'T1').blocked, null);

  // The worker stops again and asks the palette again under another id, beside the open font: the palette is answered
  // from the owner's record, nothing reaches the owner, and the font stays the worker's to decide.
  stop(2000, [palette('colours'), font]);
  controller.answerSuggested(ctx());
  assert.equal(store.task(d.campaignId, 'T1').blocked, null, 'the step goes on without asking anyone');
  assert.equal(shown(), null, 'no open decision is shown to the owner');
  const again = texts().at(-1);
  assert.match(again, /Part colours: Which palette\? Settled, already answered by the owner: Brand \(brand\)/);
  assert.match(again, /Part font: Which font\? Still open/);
  assert.equal(store.all("SELECT 1 FROM journal WHERE campaign_id = ? AND kind = 'decision-reasked'", d.campaignId).length, 1);
});

test('only the owner\'s own session changes an answer: a program AIWorks started is refused and nothing is written', async (t) => {
  const { env, store, campaignId, bind } = answered(t);
  const serve = async (callerCheck) => {
    const server = createDashboardServer({ dataDir: env.dataDir, roadmap: { snapshot: () => ({ entries: [] }) }, callerCheck });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
    return async (body) => {
      const response = await fetch(`${base}/api/v2/decisions/change`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
  };
  const lookup = (ancestors) => ({ platform: 'win32', lookup: async () => ({ pid: 999_991, ancestors, jobs: [] }) });
  for (const [post, code] of [[await serve(lookup([process.pid])), 'APPROVAL_FROM_AIWORKS'], [await serve({}), 'APPROVAL_UNCHECKED']]) {
    const refused = await post(bind());
    assert.deepEqual([refused.status, refused.body.code], [403, code]);
  }
  assert.equal(store.all("SELECT 1 FROM journal WHERE campaign_id = ? AND kind = 'decision-changed'", campaignId).length, 0);
  assert.equal(store.all("SELECT 1 FROM events WHERE kind = 'decision-change'").length, 0);
  const owner = await serve(lookup([999_990]));
  assert.equal((await owner(bind())).status, 202);
});
