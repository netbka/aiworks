// Work and Step (OWNER_WORKSPACE slice S5, build slice UI6, resolutions C6 and C7): wait reasons named by step outcome,
// built from today's supervisor fields; a step's own attempt history; a stopped step in the §7.7 words; and the More
// menu (Pause, Check again, Cancel) with Resume as the primary action of paused work, absent on finished work. Synthetic
// review fixture and disposable stores only; no network, model or GitHub call. Since UI11 (plan §6.12 C7, ADAPTIVE_SCHEDULER
// slice S8, dashboard half) the wait of each step is the status `wait` field, with no worker text in a reason. Since UI18
// (SCOPED_READING section 13, the dashboard half of READ3) a Step says which rule a returned change broke and which sections
// the next attempt was given, from status `reading` and the supervisor's own records: path, section slug and heading only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStatus } from '../../src/supervisor/api.mjs';
import { applyCommand, supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { stateCopy, DETAIL_ONLY_WORDS } from '../../src/dashboard/copy.mjs';
// A namespace import, so on a base without UI18 only the reading tests fail, not the whole file.
import * as copy from '../../src/dashboard/copy.mjs';
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
function operation(store, dataDir, campaignId, taskId, kind, { state = 'finished', at = Date.now() - 30 * M, outcome = null, executor = 'claude-cli', packet = null } = {}) {
  const id = `${campaignId}.${taskId}.${kind}.${++seq}`;
  store.insert('operations', { id, campaign_id: campaignId, task_id: taskId, kind, seq, idempotency_key: id, lease_generation: 1, state,
    session_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, run_dir: join(dataDir, 'runs', id), workspace: join(dataDir, 'worktrees', id),
    packet: packet ?? { synthetic: true, prompt: 'WORKER-PROMPT-must-not-leak' }, packet_digest: '0'.repeat(64), outcome, created_at: at, updated_at: state === 'finished' ? at + 5 * M : at, executor_kind: executor });
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

test('wait sentences name the steps they wait for, never by ID, and say what AIWorks does next and when', (t) => {
  const { dataDir, now } = fixture(t);
  change(dataDir, (store) => {
    // A run that ended without a result, retried by AIWorks itself.
    const task = store.task('recipes-idle', 'T1');
    store.patch('tasks', { campaign_id: 'recipes-idle', task_id: 'T1' }, task.version, { attempts: 1, last_error: 'timeout: the run took too long', retry_at: now + 5 * M }, now);
  });
  const { step } = view(dataDir, now);
  const wait = (state) => step(REVIEW_STATES[state].campaignId, REVIEW_STATES[state].taskId).wait;
  const at = (ms) => new Date(ms).toISOString();
  // The supervisor's sentences (status `wait`, ADAPTIVE_SCHEDULER section 6), since C7: the step it waits for by name, and the next automatic action.
  assert.deepEqual(wait('waiting-for-merge'), { code: 'integration', text: 'Waiting for "contracts import" to be merged into main (PR #104)',
    next: 'Checks the base branch again automatically; starts after "contracts import" is merged', until: at(now + 10 * M) });
  assert.deepEqual(wait('provider-wait'), { code: 'provider-cooldown', text: `AI worker usage limit; resets at ${at(now + 45 * M)}`,
    next: `Tries again at ${at(now + 45 * M)}`, until: at(now + 45 * M) });
  assert.deepEqual(step('shop-checkout', 'T2').wait, { code: 'dependency', text: 'Waiting for "checkout form" to finish', next: 'Starts when that step is done', until: null });
  assert.deepEqual(step('recipes-idle', 'T1').wait, { code: 'retry-backoff', text: `Retrying after a failed attempt at ${at(now + 5 * M)}`,
    next: `Tries again at ${at(now + 5 * M)}`, until: at(now + 5 * M) });
  // C7: today's machine sentence stays as it is for the views that read it; the Work view reads the status one.
  assert.equal(step('shop-contracts', 'T2').waitingReason, 'Waiting for verified dependencies in main: T1');
  // No wait for a step that is ready, being worked on, stopped or finished.
  for (const [id, taskId] of [['shop-checkout', 'T1'], ['shop-reviews', 'T1'], ['notes-theme', 'T1'], ['notes-search', 'T1'], ['shop-search', 'T1'], ['recipes-share', 'T1']]) {
    assert.equal(step(id, taskId).wait, null, `${id}/${taskId}`);
  }
  for (const c of view(dataDir, now).snapshot.campaigns) {
    for (const task of c.tasks.filter((item) => item.wait)) {
      for (const line of [task.wait.text, task.wait.next]) assert.doesNotMatch(line, /\bT\d+\b|dependenc|provider|executor|quota/i, `${c.id}/${task.id}: ${line}`);
    }
  }
  // The page shows the wait and the next action on each Work row and on the Step, with times as clock times.
  assert.match(page(), /const waitLine = \(wait\) => wait \? `\$\{clockTimes\(wait\.text\)\} · \$\{clockTimes\(wait\.next\)\}` : null;/);
  // Who is on it, why it stops or waits, then the agent's verdict as a label under that text (owner review 2026-10-13).
  assert.match(page(), /\.\.\.\[whoLine\(c, task\), task\.stopped\?\.title, waitLine\(task\.wait\)\]\.filter\(Boolean\)\.map\(\(text\) => el\('div', \{ class: 'subtext' \}, text\)\),\r?\n\s+verdictLabel\(c, task\),/);
});

test('the Work view takes each step’s wait from the status wait field, with the controller’s own config', (t) => {
  const { dataDir, now } = fixture(t);
  // RUN9's status is the one source (C7): every unfinished step of live work reads exactly what status says, in the
  // owner's word for an AI worker; only running, ready and stopped steps, and finished work, show no wait.
  const compare = () => {
    const { snapshot } = view(dataDir, now);
    const config = JSON.parse((() => { try { return readFileSync(join(dataDir, 'config.json'), 'utf8'); } catch { return '{}'; } })());
    const store = new Store(join(dataDir, 'supervisor.db'), { readOnly: true });
    let shown = 0;
    try {
      for (const c of snapshot.campaigns) {
        const status = campaignStatus(store, c.id, now, { config });
        for (const task of c.tasks) {
          const wait = status.tasks.find((item) => item.id === task.id).wait;
          const hidden = !wait || ['running', 'ready'].includes(wait.code) || task.blocked || ['finished', 'cancelled'].includes(c.control);
          if (hidden) { assert.equal(task.wait, null, `${c.id}/${task.id}`); continue; }
          const owner = (line) => line.replace(/\bAI provider\b/g, 'AI worker').replace(/\bprovider account\b/g, 'AI worker account');
          assert.deepEqual(task.wait, { code: wait.code, text: owner(wait.text), next: owner(wait.next), until: wait.until }, `${c.id}/${task.id}`);
          assert.ok(task.wait.text && task.wait.next, `${c.id}/${task.id} says why and what happens next`);
          shown += 1;
        }
      }
    } finally { store.close(); }
    return { snapshot, shown };
  };
  // Scheduler off (no config): one worker per work program; paused work and the recorded blocker read the supervisor's words.
  const off = compare();
  assert.ok(off.shown >= 5, `${off.shown} waits shown`);
  const step = (id, taskId) => off.snapshot.campaigns.find((c) => c.id === id).tasks.find((task) => task.id === taskId);
  assert.deepEqual(step('recipes-import', 'T1').wait, { code: 'paused', text: 'Paused by you', next: 'None until you resume it', until: null });
  assert.deepEqual(step('notes-deploy', 'T1').wait, { code: 'owner', text: 'Needs you: no allowed AI worker can run this work', next: 'None; listed in Needs me', until: null });
  assert.equal(step('recipes-print', 'T2').wait, null, 'cancelled work no longer waits');
  // Scheduler on: status names the scheduler's admission check, and the dashboard passes the same config to it.
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ scheduler: { enabled: true, maxWorkers: 1 } }));
  const on = compare();
  assert.ok(on.shown >= off.shown);
  // A ready step whose run is held by the host ceiling of one waits for a free worker on this computer.
  const held = on.snapshot.campaigns.flatMap((c) => c.tasks.map((task) => task.wait?.code)).filter(Boolean);
  assert.ok(held.includes('host-capacity'), `codes: ${held.join(', ')}`);
});

test('no worker text reaches a wait reason, whatever the worker wrote into errors, stops, results or the journal', (t) => {
  const { dataDir, now } = fixture(t);
  change(dataDir, (store) => {
    const patch = (id, taskId, changes) => store.patch('tasks', { campaign_id: id, task_id: taskId }, store.task(id, taskId).version, changes, now);
    // Each kind of wait, with worker text planted in every stored field a sentence could be built from.
    patch('shop-contracts', 'T2', { last_error: 'dependency-integration: WORKER-INTEGRATION-must-not-leak T1', retry_at: now + 10 * M });
    patch('recipes-tags', 'T1', { last_error: 'quota: WORKER-QUOTA-must-not-leak', retry_at: now + 45 * M });
    patch('recipes-idle', 'T1', { attempts: 1, last_error: 'timeout: WORKER-TIMEOUT-must-not-leak', retry_at: now + 5 * M });
    patch('shop-checkout', 'T2', { last_error: 'failed: WORKER-PENDING-must-not-leak' });
    patch('notes-theme', 'T2', { last_error: 'waiting for executor availability: WORKER-AVAILABILITY-must-not-leak', retry_at: now + 30 * M });
    const deploy = store.campaign('notes-deploy');
    store.patch('campaigns', { id: 'notes-deploy' }, deploy.version, { blocker: { ...deploy.blocker, reason: 'WORKER-BLOCKER-must-not-leak', requestedAction: 'WORKER-ACTION-must-not-leak' } }, now);
    store.insert('executor_waits', { campaign_id: 'recipes-idle', executor_kind: 'codex-cli', retry_at: now + 50 * M, reason: 'quota: WORKER-WAIT-must-not-leak' });
    const op = operation(store, dataDir, 'shop-checkout', 'T2', 'implement', { at: now - 40 * M,
      outcome: { class: 'result', value: { result: 'failed', summary: 'WORKER-SUMMARY-must-not-leak' } } });
    store.journal('shop-checkout', 'operation-finished', { op, class: 'result', reason: 'WORKER-JOURNAL-must-not-leak' }, now - 35 * M);
  });
  const { snapshot, step } = view(dataDir, now);
  const waits = snapshot.campaigns.flatMap((c) => c.tasks.filter((task) => task.wait).map((task) => [`${c.id}/${task.id}`, task.wait]));
  // Every planted case still waits, so the check below reads real reasons, not missing ones.
  for (const [id, taskId, kind] of [['shop-contracts', 'T2', 'integration'], ['recipes-tags', 'T1', 'provider-cooldown'], ['recipes-idle', 'T1', 'retry-backoff'],
    ['shop-checkout', 'T2', 'dependency'], ['notes-theme', 'T2', 'provider-cooldown'], ['notes-deploy', 'T1', 'owner']]) {
    assert.equal(step(id, taskId).wait?.code, kind, `${id}/${taskId}`);
  }
  for (const [where, wait] of waits) {
    assert.doesNotMatch(JSON.stringify(wait), /must.not.leak/i, where);
    assert.deepEqual(Object.keys(wait), ['code', 'text', 'next', 'until'], `${where}: only the code, two sentences and a time are served`);
  }
  // The page renders only those fields of a wait.
  const js = page();
  assert.deepEqual([...js.matchAll(/\bwait\.(\w+)/g)].map((m) => m[1]).sort(), ['next', 'text']);
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
  // The Step screen leads with it and offers its primary action. The Check again its sentence names is shown beside that
  // action (aiworks#11 review F12); a step that is not stopped keeps Check again in its More menu.
  assert.match(page(), /const primary = task\.stopped \? primaryAction\(task\.stopped\.primary\)/);
  assert.match(page(), /task\.stopped \? el\('strong', \{\}, task\.stopped\.title\)/);
  assert.match(page(), /const canCheckAgain = \(c, task\) => \(c\.controls\?\.more \?\? \[\]\)\.includes\('recheck'\) && task\.state !== 'done' && Boolean\(task\.blocked \|\| task\.retryAt \|\| task\.errorClass\);/);
  assert.match(page(), /const actions = task \? task\.stopped \|\| !canCheckAgain\(c, task\) \? \[\] : \['recheck'\] : allowed;/);
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

test('a long outcome gives way to the short step title in wait sentences, never cut mid-word (owner review 2026-10-13)', async (t) => {
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const { declaration } = await import('../supervisor/helpers.mjs');
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-long-outcome-'));
  const store = new Store(join(dataDir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const long = 'Child tasks are admitted, chained to the envelope and idempotent across crash and retry; every widening is refused with its code.';
  const base = declaration().tasks[0];
  campaignStart(store, declaration({ tasks: [
    { ...base, id: 'T1', title: 'Child tasks are admitted inside the envelope', outcome: long },
    { ...base, id: 'T2', issue: base.issue + 1, title: 'Children run with their own packet binding', outcome: 'Short outcome', dependsOn: ['T1'] },
  ] }));
  const t2 = supervisorSnapshot(dataDir).campaigns[0].tasks.find((task) => task.id === 'T2');
  // The sentence is the status wait (C7, UI11), which names the step by its short title.
  assert.equal(t2.wait.text, 'Waiting for "Child tasks are admitted inside the envelope" to finish');
  assert.doesNotMatch(t2.wait.text, /widening|refused with "/,'the long sentence is not quoted, so nothing is cut mid-word');
  // The page's row rule: a short outcome leads; a long one gives way to the title and becomes the line under it.
  assert.match(page(), /const OUTCOME_LEAD_MAX = 100;/);
  assert.match(page(), /const lead = outcome && \(outcome\.length <= OUTCOME_LEAD_MAX \|\| !title\) \? outcome : title \?\? outcome \?\? task\.id;/);
});

// ---- Scoped reading on the Step screen (SCOPED_READING section 13, slice UI18) ----

/** A step with marked sections: its attempt resolved two, one fell back; the check returned it for two rules. */
function rejectedForRules(store, dataDir, now) {
  const first = operation(store, dataDir, 'recipes-idle', 'T1', 'implement', { at: now - 60 * M,
    packet: { references: [{ path: 'docs/guide.md#1-start', revision: 'a'.repeat(40) }, { path: 'docs/guide.md#old-heading', revision: 'a'.repeat(40) }] },
    outcome: { class: 'result', value: { result: 'resolved', headSha: 'b'.repeat(40), report: 'WORKER-REPORT-must-not-leak' } } });
  store.journal('recipes-idle', 'reference-section-resolved', { op: first, anchored: 2, resolved: 1, fallback: 1 }, now - 60 * M);
  store.journal('recipes-idle', 'reference-section-fallback', { task: 'T1', op: first, path: 'docs/guide.md', anchor: 'old-heading', reason: 'missing' }, now - 60 * M);
  const check = operation(store, dataDir, 'recipes-idle', 'T1', 'verify', { at: now - 40 * M, outcome: { class: 'result',
    value: { verdict: 'rejected', findings: [
      { id: 'F1', severity: 'blocking', description: 'WORKER-FINDING-must-not-leak', cites: ['docs/guide.md#2-rules', 'docs/runbook.md'] },
      { id: 'F2', severity: 'note', description: 'WORKER-NOTE-must-not-leak', cites: ['docs/guide.md#3-notes'] }] },
    reading: { cites: [
      { finding: 'F1', cite: 'docs/guide.md#2-rules', path: 'docs/guide.md', anchor: '2-rules', heading: '2. Rules', from: 10, to: 20, classification: 'section-miss', implementerRead: false,
        text: 'DOCUMENT-TEXT-must-not-leak' },
      { finding: 'F1', cite: 'docs/runbook.md', path: 'docs/runbook.md', anchor: null, classification: 'unreferenced-doc', implementerRead: null },
      { finding: 'F2', cite: 'docs/guide.md#3-notes', path: 'docs/guide.md', anchor: '3-notes', heading: '3. Notes', from: 21, to: 30 }] } } });
  store.journal('recipes-idle', 'section-miss', { task: 'T1', op: check, finding: 'F1', path: 'docs/guide.md', anchor: '2-rules', implementerRead: false }, now - 39 * M);
  store.journal('recipes-idle', 'unreferenced-doc', { task: 'T1', op: check, finding: 'F1', path: 'docs/runbook.md', anchor: null, implementerRead: null }, now - 39 * M);
  return { first, check };
}

test('a returned change names the rule it broke, then which sections the next attempt was given', (t) => {
  const { dataDir } = fixture(t);
  const now = Date.now();
  change(dataDir, (store) => rejectedForRules(store, dataDir, now));
  // Before the next attempt starts: the rules of the blocking finding only, and that nothing was given yet.
  let reading = view(dataDir, now).step('recipes-idle', 'T1').reading;
  assert.deepEqual(reading, { anchored: 2, fallbacks: [{ path: 'docs/guide.md', anchor: 'old-heading', reason: 'missing' }],
    misses: { section: 1, unreferenced: 1 }, extended: 0, extendedSections: [],
    broke: [{ path: 'docs/guide.md', anchor: '2-rules', heading: '2. Rules', kind: 'section-miss', given: null },
      { path: 'docs/runbook.md', anchor: null, heading: null, kind: 'unreferenced-doc', given: null }],
    nextStarted: false });
  assert.deepEqual(copy.readingLines(reading), { title: 'What it reads and the rules it broke', lines: [
    'This step was asked to start with 2 marked sections of its documents.',
    'The checker returned the last change: it broke the rule in section “2. Rules” of docs/guide.md. The plan had marked other sections of that document, not this one.',
    'The checker returned the last change: it broke the rule in docs/runbook.md (the whole document). The plan had not named that document for this step.',
    'The next attempt has not started yet. It will be given those sections to read.',
    '1 marked section could not be found, so the whole document was given instead: docs/guide.md (#old-heading, no longer there).',
    'So far the checker found 1 broken rule in sections the plan did not mark and 1 broken rule in documents the plan did not name.'] });
  // The repair round starts with the cited section in its references; the whole-document cite did not fit.
  change(dataDir, (store) => operation(store, dataDir, 'recipes-idle', 'T1', 'implement', { state: 'dispatched', at: now - 20 * M,
    packet: { references: [{ path: 'docs/guide.md#1-start', revision: 'c'.repeat(40) }, { path: 'docs/guide.md#2-rules', revision: 'c'.repeat(40) }] } }));
  reading = view(dataDir, now).step('recipes-idle', 'T1').reading;
  assert.deepEqual(reading.broke.map((item) => [item.path, item.given]), [['docs/guide.md', true], ['docs/runbook.md', false]]);
  assert.equal(reading.nextStarted, true);
  const lines = copy.readingLines(reading).lines;
  assert.ok(lines.includes('The next attempt was given section “2. Rules” of docs/guide.md to read.'), lines.join('\n'));
  assert.ok(lines.includes('The next attempt had no room for docs/runbook.md (the whole document), so it reads that rule in the checker’s finding.'), lines.join('\n'));
  assert.ok(!lines.some((line) => /has not started yet/.test(line)));
  // An accepted check after it: no rule is broken any more; the counts stay, as status keeps them.
  change(dataDir, (store) => operation(store, dataDir, 'recipes-idle', 'T1', 'verify', { at: now - 10 * M, outcome: { class: 'result', value: { verdict: 'accepted', findings: [] } } }));
  reading = view(dataDir, now).step('recipes-idle', 'T1').reading;
  assert.deepEqual([reading.broke, reading.nextStarted, reading.misses], [[], null, { section: 1, unreferenced: 1 }]);
  // Owner words only: no machine word of §2.2 in any line.
  for (const line of lines) {
    for (const word of DETAIL_ONLY_WORDS) assert.doesNotMatch(line, new RegExp(`\\b${word}\\b`, 'i'), `${word}: ${line}`);
  }
});

test('sections added from another step’s finding are named, and a section heading reads in its own words or its slug', (t) => {
  const { dataDir } = fixture(t);
  const now = Date.now();
  change(dataDir, (store) => {
    const op = operation(store, dataDir, 'recipes-idle', 'T1', 'implement', { state: 'dispatched', at: now - 5 * M });
    store.journal('recipes-idle', 'reference-section-resolved', { op, anchored: 1, resolved: 1, fallback: 0 }, now - 5 * M);
    for (const anchor of ['2-rules', '4-limits', '2-rules']) {
      store.journal('recipes-idle', 'reading-guide-extended', { op, task: 'T1', from: { task: 'T2', finding: 'F1' }, path: 'docs/guide.md', anchor }, now - 5 * M);
    }
    // Another step's extension is not this step's.
    store.journal('recipes-idle', 'reading-guide-extended', { op, task: 'T9', from: { task: 'T2', finding: 'F1' }, path: 'docs/other.md', anchor: 'x' }, now - 5 * M);
  });
  const reading = view(dataDir, now).step('recipes-idle', 'T1').reading;
  assert.deepEqual(reading, { anchored: 1, fallbacks: [], misses: { section: 0, unreferenced: 0 }, extended: 3,
    extendedSections: [{ path: 'docs/guide.md', anchor: '2-rules' }, { path: 'docs/guide.md', anchor: '4-limits' }], broke: [], nextStarted: null });
  assert.deepEqual(copy.readingLines(reading).lines, ['This step was asked to start with 1 marked section of its documents.',
    '3 sections were added to what it reads, because the checker found them missed in another step of this work: section #2-rules of docs/guide.md; section #4-limits of docs/guide.md.']);
  // One fallback for each reason, in the owner's words.
  const words = (reason) => copy.readingLines({ anchored: 1, fallbacks: [{ path: 'a.md', anchor: 'x', reason }], misses: { section: 0, unreferenced: 0 }, extended: 0, broke: [] }).lines[1];
  assert.equal(words('ambiguous'), '1 marked section could not be found, so the whole document was given instead: a.md (#x, more than one heading matches).');
  assert.equal(words('not-markdown'), '1 marked section could not be found, so the whole document was given instead: a.md (#x, not a document AIWorks reads by section).');
  assert.equal(words('unreadable'), '1 marked section could not be found, so the whole document was given instead: a.md (#x, could not be read).');
  assert.equal(words(null), '1 marked section could not be found, so the whole document was given instead: a.md (#x).');
});

test('a step whose reading is null shows nothing new: no field content, no copy, no block on the page', (t) => {
  const { dataDir } = fixture(t);
  const now = Date.now();
  // A rejected check with cites but no reading event (a store before READ3): status says null, so the Step does too.
  change(dataDir, (store) => operation(store, dataDir, 'recipes-idle', 'T1', 'verify', { at: now - 10 * M, outcome: { class: 'result',
    value: { verdict: 'rejected', findings: [{ id: 'F1', severity: 'blocking', cites: ['docs/guide.md#2-rules'] }] },
    reading: { cites: [{ finding: 'F1', cite: 'docs/guide.md#2-rules', path: 'docs/guide.md', anchor: '2-rules', heading: '2. Rules' }] } } }));
  const { snapshot } = view(dataDir, now);
  for (const c of snapshot.campaigns) {
    for (const task of c.tasks) assert.equal(task.reading, null, `${c.id}/${task.id}`);
  }
  assert.equal(copy.readingLines(null), null);
  assert.equal(copy.readingLines({ anchored: 0, fallbacks: [], misses: { section: 0, unreferenced: 0 }, extended: 0, extendedSections: [], broke: [], nextStarted: null }), null,
    'a reading that says nothing adds nothing either');
  // The Step screen adds its block only when the copy has lines.
  const js = page();
  assert.match(js, /const reading = readingLines\(task\.reading\);/);
  assert.match(js, /reading \? el\('div', \{ class: 'instruction-list' \}, el\('h3', \{ class: 'section-title' \}, reading\.title\), \.\.\.reading\.lines\.map\(\(line\) => el\('p', \{\}, line\)\)\) : null,/);
});

test('only a path, a section slug and a heading are served: no document text, finding or worker text, nothing unsafe', (t) => {
  const { dataDir } = fixture(t);
  const now = Date.now();
  change(dataDir, (store) => {
    const { first, check } = rejectedForRules(store, dataDir, now);
    // Planted: a heading that holds a credential, a cite and fallbacks outside the repository, and an unknown reason.
    const op = store.get('SELECT outcome FROM operations WHERE id = ?', check);
    op.outcome.reading.cites.push({ finding: 'F1', cite: 'docs/keys.md#k', path: 'docs/keys.md', anchor: 'k', heading: `token ghp_${'a'.repeat(36)}`, classification: 'covered' },
      { finding: 'F1', cite: '../outside.md#a', path: '../outside.md', anchor: 'a', heading: 'Outside', classification: 'covered' },
      { finding: 'F1', cite: 'docs/x.md#Bad Anchor', path: 'docs/x.md', anchor: 'Bad Anchor', heading: 'Bad', classification: 'WORKER-KIND-must-not-leak' });
    store.updateOperation(check, { outcome: op.outcome }, now - 40 * M);
    store.journal('recipes-idle', 'reference-section-fallback', { task: 'T1', op: first,
      path: '/etc/passwd', anchor: 'x', reason: 'WORKER REASON must not leak' }, now - 39 * M);
  });
  const reading = view(dataDir, now).step('recipes-idle', 'T1').reading;
  const served = JSON.stringify(reading);
  assert.doesNotMatch(served, /must.not.leak|ghp_|outside|passwd|Bad/i);
  assert.deepEqual(Object.keys(reading), ['anchored', 'fallbacks', 'misses', 'extended', 'extendedSections', 'broke', 'nextStarted']);
  for (const item of reading.broke) assert.deepEqual(Object.keys(item), ['path', 'anchor', 'heading', 'kind', 'given']);
  for (const item of reading.fallbacks) assert.deepEqual(Object.keys(item), ['path', 'anchor', 'reason']);
  // The credential heading is withheld, and its section is named by its slug instead.
  assert.deepEqual(reading.broke.map((item) => [item.path, item.anchor, item.heading]),
    [['docs/guide.md', '2-rules', '2. Rules'], ['docs/runbook.md', null, null], ['docs/keys.md', 'k', null]]);
  assert.ok(copy.readingLines(reading).lines.includes('The checker returned the last change: it broke the rule in section #k of docs/keys.md. That section was already in what this step had to read.'));
  // The note finding's cite never shows as a broken rule; the whole campaign's served state holds no worker or document text.
  assert.ok(!reading.broke.some((item) => item.anchor === '3-notes'));
  assert.doesNotMatch(JSON.stringify(view(dataDir, now).campaign('recipes-idle')), /must.not.leak/i);
  // The page reads the copy only: it renders no field of `reading` itself.
  assert.deepEqual([...page().matchAll(/\btask\.reading\b(\.\w+)?/g)].map((m) => m[0]), ['task.reading']);
});

test('320px: the reading lines wrap long paths instead of scrolling sideways', () => {
  // The block reuses the Guidance list's layout on the Step screen, whose paragraphs wrap anywhere.
  const css = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.css'), 'utf8');
  assert.match(css, /\.instruction-list p\{[^}]*overflow-wrap:anywhere/);
  assert.match(page(), /reading \? el\('div', \{ class: 'instruction-list' \}, el\('h3', \{ class: 'section-title' \}, reading\.title\), \.\.\.reading\.lines\.map\(\(line\) => el\('p', \{\}, line\)\)\)/);
  // A path at the reference limit is one unbroken word: it still reaches the page whole, for the browser to wrap.
  const path = `docs/${'a'.repeat(500)}.md`;
  const line = copy.readingLines({ anchored: 0, fallbacks: [], misses: { section: 0, unreferenced: 0 }, extended: 0, extendedSections: [],
    broke: [{ path, anchor: null, heading: null, kind: null, given: true }], nextStarted: true }).lines.at(-1);
  assert.equal(line, `The next attempt was given ${path} (the whole document) to read.`);
});
