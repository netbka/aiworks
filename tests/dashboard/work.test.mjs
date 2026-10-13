// Work and Step (OWNER_WORKSPACE slice S5, build slice UI6, resolutions C6 and C7): wait reasons named by step outcome,
// built from today's supervisor fields; a step's own attempt history; a stopped step in the §7.7 words; and the More
// menu (Pause, Check again, Cancel) with Resume as the primary action of paused work, absent on finished work. Synthetic
// review fixture and disposable stores only; no network, model or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/supervisor/store.mjs';
import { applyCommand, supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { stateCopy } from '../../src/dashboard/copy.mjs';
import { buildReviewFixture, REVIEW_STATES } from './fixtures/review-store.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const page = () => readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
const M = 60_000;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-work-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return buildReviewFixture(root);
}
/** Changes the fixture's store, then closes it, so the dashboard reads it as it would live. */
function change(dataDir, write) {
  const store = new Store(join(dataDir, 'supervisor.db'));
  try { return write(store); } finally { store.close(); }
}
const view = (dataDir, now = Date.now()) => {
  const snapshot = supervisorSnapshot(dataDir, now);
  assert.equal(snapshot.available, true);
  return { snapshot, campaign: (id) => snapshot.campaigns.find((c) => c.id === id), step: (id, taskId) => snapshot.campaigns.find((c) => c.id === id).tasks.find((task) => task.id === taskId) };
};
let seq = 1000;
function operation(store, dataDir, campaignId, taskId, kind, { state = 'finished', at = Date.now() - 30 * M, outcome = null, executor = 'claude-cli' } = {}) {
  const id = `${campaignId}.${taskId}.${kind}.${++seq}`;
  store.insert('operations', { id, campaign_id: campaignId, task_id: taskId, kind, seq, idempotency_key: id, lease_generation: 1, state,
    session_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, run_dir: join(dataDir, 'runs', id), workspace: join(dataDir, 'worktrees', id),
    packet: { synthetic: true, prompt: 'WORKER-PROMPT-must-not-leak' }, packet_digest: '0'.repeat(64), outcome, created_at: at, updated_at: state === 'finished' ? at + 5 * M : at, executor_kind: executor });
  return id;
}

test('a step’s history holds its own attempts and events only, newest first, with how each attempt ended', (t) => {
  const { dataDir } = fixture(t);
  const now = Date.now();
  const ids = change(dataDir, (store) => {
    // Two steps of one piece of work, each with a rejected check and a journal entry that names only its operation.
    const own = operation(store, dataDir, 'shop-search', 'T1', 'verify', { at: now - 20 * M,
      outcome: { class: 'result', value: { verdict: 'rejected', findings: [{ severity: 'blocking' }, { severity: 'blocking' }, { severity: 'note' }] } } });
    const other = operation(store, dataDir, 'shop-search', 'T2', 'verify', { at: now - 19 * M, outcome: { class: 'timeout' } });
    store.journal('shop-search', 'operation-finished', { op: own, class: 'result', terminal: 'rejected', blocking: 2 }, now - 15 * M);
    store.journal('shop-search', 'operation-finished', { op: other, class: 'timeout' }, now - 14 * M);
    store.journal('shop-search', 'dashboard-command', { action: 'recheck', task: 'T2' }, now - 13 * M);
    return { own, other };
  });
  const { step } = view(dataDir, now);
  const mine = step('shop-search', 'T1').history, theirs = step('shop-search', 'T2').history;
  // T1: its implement and verify runs from the fixture, and the rejected check added here; never T2's.
  assert.deepEqual(mine.attempts.map((a) => a.id.split('.').slice(1, 3).join('.')), ['T1.verify', 'T1.verify', 'T1.implement']);
  assert.equal(mine.attempts[0].id, ids.own, 'newest first');
  assert.deepEqual(Object.fromEntries(Object.entries(mine.attempts[0]).filter(([key]) => ['role', 'executor', 'state', 'outcome', 'terminal', 'blockingFindings'].includes(key))),
    { role: 'Verifier', executor: 'claude-cli', state: 'finished', outcome: 'result', terminal: 'rejected', blockingFindings: 2 });
  assert.equal(mine.attempts[0].endedAt, now - 15 * M, 'when it ended');
  assert.ok(mine.attempts.every((a) => !a.id.includes('.T2.')) && !mine.attempts.some((a) => a.id === ids.other));
  assert.deepEqual(mine.events.map((e) => [e.kind, e.taskId, e.operation]), [['operation-finished', 'T1', ids.own], ['published', 'T1', null]]);
  assert.deepEqual(theirs.events.map((e) => [e.kind, e.taskId]), [['dashboard-command', 'T2'], ['operation-finished', 'T2'], ['published', 'T2']]);
  assert.ok(theirs.attempts.some((a) => a.id === ids.other) && theirs.attempts.every((a) => !a.id.includes('.T1.')));
  // Every step of every piece of work has a history, and nothing in it belongs to another step.
  for (const c of view(dataDir, now).snapshot.campaigns) {
    for (const task of c.tasks) {
      assert.ok(task.history.attempts.every((a) => a.id.startsWith(`${c.id}.${task.id}.`)), `${c.id}/${task.id}`);
      assert.ok(task.history.events.every((e) => e.taskId === task.id && e.campaignId === c.id), `${c.id}/${task.id}`);
    }
  }
  // A step that never ran has an empty history, not a missing one.
  assert.deepEqual(step('recipes-idle', 'T1').history, { attempts: [], events: [] });
  // The global journal is unchanged by the shared mapping: the same entry reads the same in both places.
  const journal = view(dataDir, now).snapshot.activity.find((e) => e.operation === ids.own);
  assert.deepEqual(journal, mine.events[0]);
});

test('no worker text leaks into Work or Step: no output, prompt, finding, error or stop reason the worker wrote', (t) => {
  const { dataDir } = fixture(t);
  const now = Date.now();
  change(dataDir, (store) => {
    const op = operation(store, dataDir, 'notes-theme', 'T1', 'implement', { at: now - 40 * M, outcome: { class: 'result',
      value: { result: 'blocked-owner-reserved', summary: 'WORKER-SUMMARY-must-not-leak', findings: [{ severity: 'blocking', text: 'WORKER-FINDING-must-not-leak' }] } } });
    operation(store, dataDir, 'notes-theme', 'T2', 'implement', { state: 'abandoned', at: now - 30 * M, outcome: { class: 'admission-blocked', detail: 'WORKER-ADMISSION-must-not-leak' } });
    store.journal('notes-theme', 'operation-finished', { op, class: 'result', terminal: 'blocked-owner-reserved', detail: 'WORKER-DETAIL-must-not-leak', reason: 'WORKER REASON must not leak' }, now - 35 * M);
    store.journal('notes-theme', 'step-error', { task: 'T2', error: 'WORKER-ERROR-must-not-leak' }, now - 20 * M);
    const task = store.task('notes-theme', 'T2');
    store.patch('tasks', { campaign_id: 'notes-theme', task_id: 'T2' }, task.version, { last_error: 'quota: WORKER-QUOTA-must-not-leak', retry_at: now + 20 * M }, now);
  });
  const { campaign, step } = view(dataDir, now);
  const served = JSON.stringify(campaign('notes-theme'));
  assert.doesNotMatch(served, /must.not.leak/i, 'only codes, counts, times and run IDs are served');
  // The worker's own stop reason is stored ("owner-reserved: the colour palette is a brand decision"); only the supervisor's words are served.
  assert.doesNotMatch(served, /colour palette|brand decision/);
  const decided = step('notes-theme', 'T1');
  assert.equal(decided.history.attempts[0].terminal, 'blocked-owner-reserved');
  assert.equal(decided.history.events[0].reason, null, 'a reason that is not a code is dropped');
  assert.deepEqual(step('notes-theme', 'T2').history.attempts.map((a) => [a.state, a.outcome, a.endedAt]), [['abandoned', 'admission-blocked', now - 30 * M]]);
});

test('wait sentences name the steps they wait for by outcome, never by ID, and say when AIWorks tries again', (t) => {
  const { dataDir, now } = fixture(t);
  change(dataDir, (store) => {
    // A run that ended without a result, retried by AIWorks itself.
    const task = store.task('recipes-idle', 'T1');
    store.patch('tasks', { campaign_id: 'recipes-idle', task_id: 'T1' }, task.version, { attempts: 1, last_error: 'timeout: the run took too long', retry_at: now + 5 * M }, now);
  });
  const { step } = view(dataDir, now);
  const wait = (state) => step(REVIEW_STATES[state].campaignId, REVIEW_STATES[state].taskId).wait;
  // §4.7's own examples: "Starts after 'Contracts import' is merged", "Waiting for an AI worker to be free · next try 14:05".
  assert.deepEqual(wait('waiting-for-merge'), { text: 'Starts after “Contracts import” is merged', retryAt: now + 10 * M });
  assert.deepEqual(wait('provider-wait'), { text: 'Waiting for an AI worker to be free', retryAt: now + 45 * M });
  assert.deepEqual(step('shop-checkout', 'T2').wait, { text: 'Starts after “Checkout form” is finished', retryAt: null });
  assert.deepEqual(step('recipes-idle', 'T1').wait, { text: 'The last run did not finish; AIWorks tries again by itself', retryAt: now + 5 * M });
  // C7: today's machine sentence stays as it is for the views that read it; the Work view reads the new one.
  assert.equal(step('shop-contracts', 'T2').waitingReason, 'Waiting for verified dependencies in main: T1');
  // No wait for a step that is ready, being worked on, stopped or finished.
  for (const [id, taskId] of [['shop-checkout', 'T1'], ['shop-reviews', 'T1'], ['notes-theme', 'T1'], ['notes-search', 'T1'], ['shop-search', 'T1'], ['recipes-share', 'T1']]) {
    assert.equal(step(id, taskId).wait, null, `${id}/${taskId}`);
  }
  for (const c of view(dataDir, now).snapshot.campaigns) {
    for (const task of c.tasks.filter((item) => item.wait)) assert.doesNotMatch(task.wait.text, /\bT\d+\b|dependenc|provider|executor|quota/i, `${c.id}/${task.id}: ${task.wait.text}`);
  }
  // The page shows the wait on each Work row and on the Step, with the retry time.
  assert.match(page(), /const waitLine = \(wait\) => wait \? `\$\{wait\.text\}\$\{wait\.retryAt \? ` · next try \$\{timeOnly\(wait\.retryAt\)\}` : ''\}` : null;/);
  assert.match(page(), /\.\.\.\[whoIsOn\(c, task\), task\.stopped\?\.title, waitLine\(task\.wait\)\]/);
});

test('a stopped step reads as in §7.7, with the step issue as its one primary action', (t) => {
  const { dataDir } = fixture(t);
  const now = Date.now();
  change(dataDir, (store) => {
    // The checker still rejects after the repair rounds: an owner decision (§5.7), though the supervisor records it as stalled.
    const task = store.task('notes-theme', 'T2');
    store.patch('tasks', { campaign_id: 'notes-theme', task_id: 'T2' }, task.version, { attempts: 4, repair_rounds: 3, blocked: { class: 'stalled', reason: 'verifier still rejects after 3 repair rounds' } }, now);
  });
  const { step } = view(dataDir, now);
  const decision = step('notes-theme', 'T1'), rejected = step('notes-theme', 'T2'), failed = step('notes-search', 'T1');
  const issue = (repo, n) => ({ label: 'Open the step issue', url: `https://github.com/${repo}/issues/${n}` });
  assert.deepEqual(decision.stopped, { key: 'needs-decision', title: 'Stopped: needs your decision.',
    text: 'Dark theme: the AI worker needs your decision; see the step issue.', primary: issue('example/notes-site', 111) });
  assert.deepEqual(rejected.stopped, { key: 'needs-decision', title: 'Stopped: needs your decision.',
    text: 'Theme switch: the independent checker still rejects it after 3 repair rounds; decide whether to accept the gap, narrow the step or allow more rounds, then check it again.',
    primary: issue('example/notes-site', 112) });
  assert.deepEqual(failed.stopped, { key: 'failed-attempts', title: 'Stopped: 5 attempts failed.',
    text: 'Notes search. It will not retry by itself. Fix the cause, then check it again.', primary: issue('example/notes-site', 121) });
  // The words are the state copy module's own (one source for §7), not written again here.
  const { title, text, primary } = stateCopy('failed-attempts', { step: 'Notes search', attempts: 5, url: 'https://github.com/example/notes-site/issues/121' });
  assert.deepEqual(failed.stopped, { key: 'failed-attempts', title, text, primary });
  assert.equal(step('notes-theme', 'T2').wait, null);
  assert.equal(step('shop-checkout', 'T1').stopped, null, 'a step that is not stopped has no stop copy');
  // The Step screen leads with it and offers its primary action; Check again sits in the step's More menu.
  assert.match(page(), /const primary = task\.stopped \? primaryAction\(task\.stopped\.primary\)/);
  assert.match(page(), /task\.stopped \? el\('strong', \{\}, task\.stopped\.title\)/);
  assert.match(page(), /const actions = task \? allowed\.filter\(\(action\) => action === 'recheck' && task\.state !== 'done' && Boolean\(task\.blocked \|\| task\.retryAt \|\| task\.errorClass\)\) : allowed;/);
});

test('the More menu offers Pause, Check again and Cancel, Resume leads when paused, and finished work has no menu', (t) => {
  const { dataDir } = fixture(t);
  const { campaign } = view(dataDir);
  const controls = (state) => campaign(REVIEW_STATES[state].campaignId).controls;
  assert.deepEqual(controls('builder-working'), { primary: null, more: ['pause', 'recheck', 'cancel'] });
  assert.deepEqual(controls('needs-decision'), { primary: null, more: ['pause', 'recheck', 'cancel'] });
  assert.deepEqual(controls('paused'), { primary: 'resume', more: ['recheck', 'cancel'] });
  for (const state of ['finished-all-merged', 'finished-open-and-merged', 'finished-reports', 'finished-unknown', 'cancelled']) {
    assert.deepEqual(controls(state), { primary: null, more: [] }, state);
  }
  // The page builds the menu from those controls and leaves it out when there is nothing in it.
  const js = page();
  assert.match(js, /const allowed = c\.controls\?\.more \?\? \[\];/);
  assert.match(js, /if \(!actions\.length\) return null;\r?\n  const labels = \{ pause: 'Pause', recheck: 'Check again' \};/);
  assert.match(js, /\? el\('button', \{ class: 'button text-danger small', disabled: commandsOff\(\), onclick: \(\) => askCancel\(c\) \}, 'Cancel work…'\)/);
  assert.match(js, /const resumeButton = \(c\) => c\.controls\?\.primary === 'resume' \? button\('Resume', \(\) => command\(c, 'resume'\), '', commandsOff\(\)\) : null;/);
  assert.match(js, /el\('div', \{\}, resumeButton\(c\), moreMenu\(c\)\)\),/);
  assert.match(js, /return \[\.\.\.cards\.map\(\(c\) => workPanel\(project, c\)\),/);
  // Cancel keeps today's confirmation dialog.
  assert.match(js, /function askCancel\(c\) \{\r?\n  pendingCancel = c; \$\('#cancel-description'\)\.textContent = campaignTitle\(c\); \$\('#cancel-dialog'\)\.showModal\(\);/);
});

test('every command the menu offers is one the supervisor accepts, still bound to the version seen and its request ID', (t) => {
  const { dataDir } = fixture(t);
  const now = Date.now();
  const payload = (c, action, extra = {}) => ({ campaignId: c.id, action, version: c.version, authorizationVersion: c.authorizationVersion,
    scopeDigest: c.scopeDigest, requestId: randomUUID(), ...extra });
  // Check again on a stopped step, from the step's own menu.
  let c = view(dataDir, now).campaign('notes-search'), task = c.tasks[0];
  assert.ok(c.controls.more.includes('recheck'));
  const recheck = payload(c, 'recheck', { taskId: task.id, taskVersion: task.version });
  assert.deepEqual(applyCommand(dataDir, recheck, now), { accepted: true, duplicate: false, action: 'recheck' });
  assert.deepEqual(applyCommand(dataDir, recheck, now), { accepted: true, duplicate: true, action: 'recheck' }, 'a repeat is acknowledged, not applied again');
  // Pause, then Cancel from the paused menu.
  c = view(dataDir, now).campaign('recipes-idle');
  assert.deepEqual(c.controls.more, ['pause', 'recheck', 'cancel']);
  const stale = payload(c, 'pause');
  assert.equal(applyCommand(dataDir, payload(c, 'pause'), now).accepted, true);
  assert.throws(() => applyCommand(dataDir, stale, now), (error) => error.status === 409, 'a command for a version no longer shown is refused');
  c = view(dataDir, now).campaign('recipes-idle');
  assert.deepEqual(c.controls, { primary: 'resume', more: ['recheck', 'cancel'] });
  assert.equal(applyCommand(dataDir, payload(c, 'cancel'), now).accepted, true);
  // Cancelled work offers nothing, and the supervisor refuses anything sent anyway.
  c = view(dataDir, now).campaign('recipes-idle');
  assert.deepEqual(c.controls.more, []);
  for (const state of ['finished-all-merged', 'cancelled']) {
    const done = view(dataDir, now).campaign(REVIEW_STATES[state].campaignId);
    for (const action of ['pause', 'recheck', 'cancel']) assert.throws(() => applyCommand(dataDir, payload(done, action), now), (error) => error.status === 409, `${state}: ${action}`);
  }
  // The page sends every menu command through command(), which carries the version, authorization, scope and a new request ID.
  assert.match(page(), /: button\(labels\[action\], \(\) => command\(c, action, task \?\? undefined\), 'secondary small', commandsOff\(\)\)/);
  assert.match(page(), /return deliver\(\{ campaignId: c\.id, action, requestId: crypto\.randomUUID\(\), version: c\.version,\r?\n    authorizationVersion: c\.authorizationVersion, scopeDigest: c\.scopeDigest,/);
});
