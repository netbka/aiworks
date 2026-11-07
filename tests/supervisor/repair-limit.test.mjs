// AW-002 (amended 2026-11-06) with AW-017: repair rounds default to 3, a project's settings may set them, and every path
// that reaches the limit finishes the step without waiting for the owner. Synthetic store and campaign only; no worker
// runs, no git, network or GitHub call: each path is driven through the controller's own code for it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { effectiveLimits, saveSettings } from '../../src/supervisor/project-settings.mjs';
import { reportDigestOf } from '../../src/supervisor/result-review.mjs';
import { items } from '../../src/supervisor/work-list.mjs';
import { declaration, environment, skipWithoutSqlite } from './helpers.mjs';

const HEAD = 'a'.repeat(40);
const PROJECT = 'example-org/sampleapp';
const PASSED = { exit: '0', summary: '# tests 3\n# pass 3\n# fail 0' };
const ONE = [{ id: 'T1', issue: 437, title: 'first task', deliverable: 'commit', goal: 'Produce the first artifact.', dependsOn: [], acceptance: ['artifact exists'], references: ['AGENTS.md'] }];
let requests = 0;

/** One registered single-step campaign whose declaration omits maxRepairRounds unless `limits` names it. */
function setup(t, { limits = { maxRepairRounds: undefined } } = {}) {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration({ tasks: ONE, limits });
  campaignStart(store, d);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
  const ctx = { id: d.campaignId, generation: lease.generation };
  const id = d.campaignId;
  const set = (patch) => { const task = store.task(id, 'T1'); store.patch('tasks', { campaign_id: id, task_id: 'T1' }, task.version, patch, Date.now()); return store.task(id, 'T1'); };
  const settings = (limits) => saveSettings(store, { project: PROJECT, expectedVersion: Number(store.get('SELECT COALESCE(MAX(version), 0) AS v FROM project_settings')?.v ?? 0),
    requestId: `repair-limit-${++requests}`, settings: { limits } }, Date.now());
  const followUps = () => items(store).filter((item) => item.task_id === 'T1');
  return { store, controller, ctx, id, set, settings, followUps, limitOf: () => effectiveLimits(store, store.campaign(id).declaration).maxRepairRounds };
}

// A published step at the limit: done at its verified head, with its pull request.
const published = (r, rounds) => r.set({ state: 'done', head_sha: HEAD, verified_sha: HEAD, pr_url: 'https://github.com/example-org/sampleapp/pull/9', repair_rounds: rounds,
  result: { result: 'resolved', summary: 'done', headSha: HEAD, report: 'synthetic report' }, verification: { verdict: 'accepted', targetSha: HEAD, findings: [], gate: PASSED } });

// The step stops instead of waiting for the owner: it ends as not done with exactly one follow-up item.
function endedNotDone(r) {
  r.controller.answerSuggested(r.ctx);
  const task = r.store.task(r.id, 'T1');
  assert.equal(task.state, 'cancelled', 'the step is finished, not left stalled for the owner');
  assert.equal(task.blocked, null);
  assert.match(task.last_error, /^not done:/);
  assert.equal(r.followUps().length, 1, 'one follow-up item');
  r.controller.answerSuggested(r.ctx);
  assert.equal(r.followUps().length, 1, 'nothing is recorded twice');
  r.controller.refreshStatus(r.ctx);
  assert.equal(r.store.campaign(r.id).control, 'finished', 'the campaign finishes instead of waiting');
}

test('the repair limit is the declaration\'s number, its explicit null, the project setting, else 3; settings are versioned and validated', { skip: skipWithoutSqlite }, (t) => {
  const omitted = setup(t);
  assert.equal(omitted.limitOf(), 3, 'a declaration without maxRepairRounds gets 3');
  assert.equal(omitted.settings({ maxRepairRounds: 1 }).version, 1);
  assert.equal(omitted.limitOf(), 1, 'the project setting applies when the declaration omits the key');
  assert.equal(omitted.settings({ maxRepairRounds: null }).version, 2);
  assert.equal(omitted.limitOf(), null, 'the project may say no limit');
  assert.equal(omitted.settings({}).version, 3);
  assert.equal(omitted.limitOf(), 3, 'an unset project setting is the default again');
  for (const bad of [6, -1, '2', 1.5, { maxRepairRounds: 1 }]) {
    assert.throws(() => omitted.settings({ maxRepairRounds: bad }), { code: 'SETTINGS_LIMITS' });
  }
  assert.throws(() => omitted.settings({ maxWorkerRuns: 5 }), { code: 'SETTINGS_LIMITS' }, 'settings set repair rounds only');
  assert.equal(omitted.store.get('SELECT MAX(version) AS v FROM project_settings').v, 3, 'a refused save stores nothing');
  omitted.settings({ maxRepairRounds: 1 });
  const declared = setup(t, { limits: { maxRepairRounds: 2 } });
  saveSettings(declared.store, { project: PROJECT, expectedVersion: 0, requestId: 'repair-limit-declared', settings: { limits: { maxRepairRounds: 1 } } }, Date.now());
  assert.equal(declared.limitOf(), 2, 'a declared number wins over the project setting');
  const unlimited = setup(t, { limits: { maxRepairRounds: null } });
  saveSettings(unlimited.store, { project: PROJECT, expectedVersion: 0, requestId: 'repair-limit-unlimited', settings: { limits: { maxRepairRounds: 1 } } }, Date.now());
  assert.equal(unlimited.limitOf(), null, 'an explicit null stays unlimited');
});

test('verifier rejection at the default limit is delivered with known defects and one follow-up; a step already past it finishes its open round first', { skip: skipWithoutSqlite }, (t) => {
  const r = setup(t);
  const decl = r.store.campaign(r.id).declaration, op = { kind: 'verify', executor_kind: 'claude-cli', target_sha: HEAD };
  const result = { result: 'resolved', summary: 'done', headSha: HEAD, report: 'synthetic report' };
  const finding = { id: 'F1', severity: 'blocking', description: 'A synthetic defect.' };
  const rejected = { class: 'result', value: { verdict: 'rejected', targetSha: HEAD, reportDigest: reportDigestOf({ result }), summary: 'rejected', findings: [finding], checks: [], gate: PASSED } };
  // Below the default a rejection is one more repair round.
  let task = r.set({ state: 'implemented', head_sha: HEAD, result, repair_rounds: 2 });
  assert.equal(r.controller.transition(r.ctx, task, op, rejected, decl, Date.now()).repair_rounds, 3);
  // Deployed while a step is already past the new default: its open round runs to its end, building and checking.
  task = r.set({ state: 'pending', repair_rounds: 5 });
  const built = r.controller.transition(r.ctx, task, { kind: 'implement', executor_kind: 'claude-cli' }, { class: 'result', value: result }, decl, Date.now());
  assert.equal(built.state, 'implemented');
  assert.equal(built.blocked, undefined, 'the open round is not cut short');
  task = r.set({ state: 'implemented', repair_rounds: 5 });
  const accepted = r.controller.transition(r.ctx, task, op, { class: 'result', value: { ...rejected.value, verdict: 'accepted', findings: [] } }, decl, Date.now());
  assert.equal(accepted.state, 'verified', 'an accepted open round is kept');
  // At the limit a rejection stops the step, and AIWorks finishes it without the owner.
  task = r.set({ state: 'implemented', repair_rounds: 3 });
  const stopped = r.controller.transition(r.ctx, task, op, rejected, decl, Date.now());
  assert.match(stopped.blocked?.reason ?? '', /^verifier still rejects after 3 repair rounds/);
  r.set(stopped);
  r.controller.answerSuggested(r.ctx);
  task = r.store.task(r.id, 'T1');
  assert.equal(task.state, 'verified', 'delivered as it is');
  assert.deepEqual(task.verification.knownDefects.map((f) => f.id), ['F1']);
  assert.equal(r.followUps().length, 1, 'one follow-up item');
});

test('owner-requested changes at the default limit end the step as not done with one follow-up', { skip: skipWithoutSqlite }, (t) => {
  const r = setup(t);
  r.controller.inBase = () => false; // the head is not in its base: no git read in this test
  published(r, 3);
  const c = r.store.campaign(r.id);
  r.store.addEvent(r.id, 'result-changes', { taskId: 'T1', verifiedSha: HEAD, authorizationVersion: c.authorization_version, scopeDigest: c.scope_digest,
    text: 'Synthetic owner request.', criterion: null }, `result-changes:${r.id}:T1:${HEAD}`, Date.now());
  r.controller.requestedChanges(r.ctx);
  assert.match(r.store.task(r.id, 'T1').blocked?.reason ?? '', /^owner requested changes on .* after 3 repair rounds/);
  endedNotDone(r);
});

test('a CI failure at a limit from Project settings ends the step as not done with one follow-up', { skip: skipWithoutSqlite }, (t) => {
  const r = setup(t);
  r.settings({ maxRepairRounds: 1 });
  const task = published(r, 1);
  r.controller.recordCi(r.ctx, task, { state: 'failure', checks: [{ name: 'build', conclusion: 'failure' }], pr: { url: task.pr_url, headRefOid: HEAD } });
  assert.match(r.store.task(r.id, 'T1').blocked?.reason ?? '', /^CI failure on .* after 1 repair rounds/);
  endedNotDone(r);
});

test('a refused publication at the default limit ends the step as not done with one follow-up', { skip: skipWithoutSqlite }, (t) => {
  const r = setup(t);
  const task = r.set({ state: 'verified', head_sha: HEAD, verified_sha: HEAD, repair_rounds: 3,
    result: { result: 'resolved', summary: 'done', headSha: HEAD, report: 'synthetic report' }, verification: { verdict: 'accepted', targetSha: HEAD, findings: [], gate: PASSED } });
  const decl = r.store.campaign(r.id).declaration;
  r.controller.publicationRefused(r.ctx, decl, decl.tasks[0], task, { findings: ['a local path'], sources: ['report'] });
  assert.match(r.store.task(r.id, 'T1').blocked?.reason ?? '', /^publication refused/);
  assert.equal(r.store.task(r.id, 'T1').repair_rounds, 3, 'no round past the limit');
  endedNotDone(r);
});
