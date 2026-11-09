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
import { applyAnswerChange, supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
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

  // The step already used the answer: its result, head and runs are kept exactly; one follow-up records the new answer.
  const row = store.task(campaignId, 'T1');
  store.patch('tasks', { campaign_id: campaignId, task_id: 'T1' }, row.version, { state: 'done', head_sha: 'a'.repeat(40), verified_sha: 'a'.repeat(40) }, Date.now());
  const before = JSON.stringify(store.task(campaignId, 'T1')), ops = store.all('SELECT * FROM operations WHERE campaign_id = ?', campaignId).length;
  const instructions = store.all("SELECT seq FROM events WHERE kind = 'agent-instruction'").length;
  const later = { ...request, requestId: randomUUID(), taskVersion: store.task(campaignId, 'T1').version, option: 'neutral',
    answer: store.get("SELECT seq FROM journal WHERE campaign_id = ? AND kind = 'decision-changed'", campaignId).seq };
  assert.equal(applyAnswerChange(env.dataDir, later).outcome, 'follow-up');
  assert.equal(JSON.stringify(store.task(campaignId, 'T1')), before, 'the finished step is not reopened or rewritten');
  assert.equal(store.all('SELECT * FROM operations WHERE campaign_id = ?', campaignId).length, ops, 'no run is started or changed');
  assert.equal(store.all("SELECT seq FROM events WHERE kind = 'agent-instruction'").length, instructions, 'no guidance for a run that will not come');
  assert.equal(store.all("SELECT number FROM work_items WHERE campaign_id = ? AND task_id = 'T1'", campaignId).length, 1, 'one bounded follow-up');
  assert.equal(applyAnswerChange(env.dataDir, later).duplicate, true);
  assert.equal(store.all("SELECT number FROM work_items WHERE campaign_id = ? AND task_id = 'T1'", campaignId).length, 1, 'a replay adds none');
  // The whole history stays: AIWorks's answer with its provenance, then both changes.
  assert.deepEqual(store.all("SELECT kind, detail FROM journal WHERE campaign_id = ? AND kind IN ('decision-answered', 'decision-changed') ORDER BY seq", campaignId)
    .map((r) => [r.kind, r.detail.option, r.detail.auto ?? r.detail.by]), [['decision-answered', 'neutral', true], ['decision-changed', 'brand', 'owner'], ['decision-changed', 'neutral', 'owner']]);
});

test('a changed answer replaces the earlier one in every later run under the same authority, and never under another', (t) => {
  const { env, store, campaignId, bind } = answered(t);
  const request = bind({ text: 'Keep the logo blue.' });
  applyAnswerChange(env.dataDir, request);
  const c = store.campaign(campaignId);
  const inForce = decisionInstructions(store, c, 'T1');
  assert.equal(inForce.length, 1, 'only the answer in force reaches the packet');
  assert.match(inForce[0].payload.text, /New answer: Brand \(brand\)/);
  assert.match(inForce[0].payload.text, new RegExp(`owner request ${request.requestId}`), 'it names the owner request it came from');
  assert.equal(pendingInstructions(store, c, 'T1').filter((item) => /Chosen option: Neutral/.test(item.payload.text)).length, 0, 'the replaced answer is never delivered again');
  assert.equal(store.all("SELECT seq FROM events WHERE kind = 'agent-instruction' AND payload LIKE '%Chosen option: Neutral%'").length, 1, 'but it stays in the record');
  assert.equal(decisionInstructions(store, { ...c, authorization_version: c.authorization_version + 1 }, 'T1').length, 0, 'another authority inherits nothing');
  assert.equal(decisionInstructions(store, c, 'T2').length, 0, 'nor does another step');
  assert.equal(store.task(campaignId, 'T1').blocked, null, 'a change clears and sets no stop');
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
