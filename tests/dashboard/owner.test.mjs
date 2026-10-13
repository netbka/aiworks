// Owner view (governance-archive#78/#79): what needs the owner, finished steps joined with their merge state from local
// git, plain-language wording, host identity and link navigation. Disposable stores and synthetic merge state only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request } from 'node:http';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart, campaignPause, CampaignError } from '../../src/supervisor/api.mjs';
import { scopeDigest, validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { declaration } from '../supervisor/helpers.mjs';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { ownerView, delivery, purpose, SYSTEM_GROUP } from '../../src/dashboard/owner.mjs';
import { configuredCheckouts, configuredGitCommand, MergeWatcher, publishedSteps } from '../../src/dashboard/merges.mjs';
import { buildReviewFixture, REVIEW_STATES } from './fixtures/review-store.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';

const three = () => [
  { id: 'T1', issue: 437, title: 'first task', deliverable: 'commit', goal: 'First.', dependsOn: [], acceptance: ['a'], references: ['AGENTS.md'] },
  { id: 'T2', issue: 438, title: 'second task', deliverable: 'commit', goal: 'Second.', dependsOn: [], acceptance: ['a'], references: ['AGENTS.md'] },
  { id: 'T3', issue: 439, title: 'third task', deliverable: 'commit', goal: 'Third.', dependsOn: ['T1', 'T2'], acceptance: ['a'], references: ['AGENTS.md'] },
];

function fixture(t, d = declaration({ tasks: three() })) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-owner-'));
  const store = new Store(join(dataDir, 'supervisor.db'));
  // Registered 10 minutes ago: past the grace period a campaign gets before restart advice for "not picked up yet".
  campaignStart(store, d, Date.now() - 10 * 60_000);
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const finish = (taskId, prUrl, extra = {}) => {
    const task = store.task(d.campaignId, taskId);
    store.patch('tasks', { campaign_id: d.campaignId, task_id: taskId }, task.version, { state: 'done', pr_url: prUrl, ...extra }, Date.now());
  };
  return { dataDir, store, d, finish };
}

/** Merge state as the local merge check reports it: example-org/sampleapp fetched just now, and a result per campaign step. */
const checked = (steps = {}, repo = {}) => ({ repositories: [{ repository: 'example-org/sampleapp', configured: true, fetchedAt: Date.now(), attemptedAt: Date.now(), error: null, ...repo }], steps });
const result = (sha, merged, mergedAt = null) => ({ sha, baseBranch: 'main', merged, mergedAt });
const A = 'a'.repeat(40), B = 'b'.repeat(40);

test('plain-language purpose and outcomes are optional, bounded and never change the immutable scope', () => {
  const d = declaration();
  const worded = { ...d, purpose: 'One accountable delivery from bootstrap to a verified release',
    tasks: d.tasks.map((task) => ({ ...task, outcome: `Owners can see ${task.id} working` })) };
  assert.doesNotThrow(() => validateDeclaration(worded));
  assert.equal(scopeDigest(worded), scopeDigest(d), 'wording for the owner is not scope');
  assert.notEqual(scopeDigest({ ...d, tasks: d.tasks.map((task) => ({ ...task, goal: 'changed' })) }), scopeDigest(d));
  assert.throws(() => validateDeclaration({ ...d, purpose: '' }), /purpose/);
  assert.throws(() => validateDeclaration({ ...d, purpose: 'x'.repeat(301) }), /purpose/);
  assert.throws(() => validateDeclaration({ ...d, tasks: d.tasks.map((task) => ({ ...task, outcome: 'x'.repeat(301) })) }), /outcome/);
});

test('changing the owner wording of a registered campaign needs a higher authorization version and keeps its scope', (t) => {
  const { store, d } = fixture(t, declaration());
  const before = store.campaign(d.campaignId).scope_digest;
  const worded = { ...d, tasks: d.tasks.map((task) => ({ ...task, outcome: `Plain result of ${task.id}` })) };
  assert.throws(() => campaignStart(store, worded), (error) => error instanceof CampaignError && error.code === 'AUTHORIZATION_VERSION_REQUIRED');
  campaignStart(store, { ...worded, authorization: { ...worded.authorization, version: 2 } });
  const after = store.campaign(d.campaignId);
  assert.equal(after.scope_digest, before);
  assert.equal(after.declaration.tasks[0].outcome, 'Plain result of T1');
});

test('a finished step is merged only when a current local git check saw it; otherwise it is published, merge not seen yet', () => {
  const now = Date.now(), pr = 'https://github.com/example-org/sampleapp/pull/463';
  const task = (url = pr, extra = {}) => ({ id: 'T1', state: 'done', resultUrl: url, verifiedSha: A, ...extra });
  const seen = (merged, repo) => checked({ 'c1/T1': result(A, merged) }, repo);
  const say = (t, merges) => { const d = delivery(t, merges, now, 'c1'); return [d.state, d.reason ?? null, d.pending ?? null]; };
  assert.deepEqual(say(task(), seen(true)), ['merged', null, null]);
  assert.equal(delivery(task('https://github.com/example-org/sampleapp/pull/463'), seen(true), now, 'c1').state, 'merged', 'repository names match case-insensitively');
  assert.deepEqual(say(task(), seen(false)), ['published', null, false], 'not reachable from origin/main: published, merge not seen yet');
  assert.equal(delivery(task(), seen(false), now, 'c1').note, 'Your review and merge');
  // Missing data never reads as merged.
  assert.deepEqual(say(task(), seen(null)), ['published', 'checking', true], 'a commit not checked yet is being checked');
  assert.deepEqual(say(task(), checked()), ['published', 'checking', true]);
  assert.deepEqual(say(task(), { repositories: [], steps: {} }), ['published', 'checking', true], 'a repository not checked yet is not fine');
  assert.deepEqual(say(task(), checked({ 'c1/T1': result(B, true) })), ['published', 'checking', true], 'a result for another commit says nothing about this one');
  assert.deepEqual(say(task('https://github.com/example-org/sampleapp/pull/463', { verifiedSha: null }), seen(true)), ['published', 'no-verified-sha', false]);
  assert.deepEqual(say(task(), seen(true, { configured: false, fetchedAt: null })), ['published', 'no-checkout', false]);
  // Stale data never reads as merged, and says when the check is from.
  const old = now - 20 * 60_000;
  assert.deepEqual(say(task(), seen(true, { fetchedAt: old })), ['published', 'checking', true]);
  assert.deepEqual(delivery(task(), seen(true, { fetchedAt: old }), now, 'c1').asOf, { at: old, reason: 'old' });
  assert.deepEqual(say(task(), seen(true, { fetchedAt: old, error: 'fetch-failed' })), ['published', 'fetch-failed', false]);
  // A failed fetch keeps the last state while it is current, and shows its age.
  const recent = now - 2 * 60_000, kept = delivery(task(), seen(true, { fetchedAt: recent, error: 'fetch-failed' }), now, 'c1');
  assert.deepEqual([kept.state, kept.asOf], ['merged', { at: recent, reason: 'fetch-failed' }]);
  assert.equal(delivery(task('https://github.com/example-org/sampleapp/issues/437#issuecomment-1'), seen(true), now, 'c1').state, 'report-posted');
  assert.equal(delivery({ id: 'T1', state: 'verifying', resultUrl: null }, seen(true), now, 'c1'), null);
  // Campaign titles come from the declaration only; no issue title is fetched.
  assert.equal(purpose({ purpose: null, repository: 'example-org/sampleapp', trackingIssue: 443, tasks: [{}, {}] }), null);
});

test('each review names the accepted commit, points to the pull request for CI and conflicts, and says what merging unlocks', (t) => {
  const { dataDir, store, d, finish } = fixture(t);
  finish('T1', 'https://github.com/example-org/sampleapp/pull/463', { attempts: 10, verified_sha: A });
  finish('T2', 'https://github.com/example-org/sampleapp/pull/464', { verified_sha: B });
  const now = Date.now();
  store.insert('operations', { id: 'v1', campaign_id: d.campaignId, task_id: 'T1', kind: 'verify', seq: 1, idempotency_key: 'v1', lease_generation: 1,
    state: 'finished', session_id: 's', run_dir: join(dataDir, 'runs', 'v1'), workspace: 'w', packet: {}, packet_digest: 'p',
    outcome: { class: 'result', value: { verdict: 'rejected', summary: 'worker-secret' } }, created_at: now, updated_at: now, executor_kind: 'claude-cli' });
  const supervisor = supervisorSnapshot(dataDir);
  assert.equal(supervisor.campaigns[0].tasks[0].verifierRejections, 1);
  const merges = checked({ [`${d.campaignId}/T1`]: result(A, false), [`${d.campaignId}/T2`]: result(B, true) });
  const view = ownerView(supervisor, merges, { host: 'workstation' });
  assert.deepEqual(view.items.map((item) => item.kind), ['review', 'controller'], 'no live controller lease in this store: that needs the owner too');
  const [review, controller] = view.items;
  // Led by what the step delivers; the action and the pull request link sit beside it, the PR number appears once.
  assert.deepEqual([review.action, review.text, review.link], ['Review and merge', 'first task', { label: 'Open PR #463', url: 'https://github.com/example-org/sampleapp/pull/463' }]);
  assert.equal(review.evidence, 'Passed the check at aaaaaaa · CI and conflicts on the PR');
  assert.equal(review.detail, 'Passed the independent check at commit aaaaaaa. This dashboard does not read CI checks or conflicts; see them on the pull request before merging.',
    'the dashboard reads no merge readiness: it never says "ready to merge"');
  assert.equal(review.mergeCheck, null, 'a current merge check needs no note');
  assert.ok(!/ready to merge/i.test(JSON.stringify(view)));
  assert.deepEqual(review.points.map((point) => point.text), ['Check its review history first: it took 10 tries and the independent checker rejected it 1 time before it passed the check.',
    'Merging lets “third task” build on it.']);
  assert.equal(controller.text, 'AIWorks on this computer has not picked up this work yet', 'this store never had a controller lease');
  assert.match(controller.points[0].text, /AIWorks has not picked it up\. If nobody is updating it right now, restart it on this computer: .*“AIWorks Supervisor”/);
  const lapsed = { ...supervisor, campaigns: supervisor.campaigns.map((c) => ({ ...c, readiness: 'CONTROLLER_OFFLINE', leaseExpiresAt: new Date(now - 10 * 60_000).toISOString() })) };
  const stopped = ownerView(lapsed, merges, { host: 'workstation', now }).items.find((item) => item.kind === 'controller');
  assert.equal(stopped.text, 'AIWorks stopped on this computer');
  assert.equal(stopped.at, now - 10 * 60_000);
  assert.deepEqual(view.campaigns[d.campaignId].counts, { total: 3, delivered: 2, merged: 1, awaiting: 1, checking: 0, unknown: 0, reports: 0 });
  assert.equal(view.campaigns[d.campaignId].purpose, null, 'no declared purpose and several steps: the page shows the campaign id');
  assert.ok(!JSON.stringify(view).includes('worker-secret'));
  const unknown = ownerView(supervisor, { repositories: [], steps: {} });
  assert.deepEqual(unknown.items.map((item) => item.kind), ['controller']);
  assert.equal(unknown.unknownResults, 2, 'before the first merge check the two finished steps are being checked, not "nothing needs you"');
  // A step whose merge this computer cannot see is listed, and says why.
  const unseen = ownerView(supervisor, checked({}, { configured: false, fetchedAt: null })).items.filter((item) => item.kind === 'review');
  assert.equal(unseen.length, 2);
  assert.equal(unseen[0].points[0].text, 'This computer has no checkout of the repository configured, so the merge cannot be seen here; check the pull request.');
  // A stale check behind a review item says when it is from.
  const old = now - 20 * 60_000;
  const failing = ownerView(supervisor, checked(merges.steps, { fetchedAt: old, error: 'fetch-failed' }), { now }).items.filter((item) => item.kind === 'review');
  assert.deepEqual(failing.map((item) => [item.text, item.mergeCheck]), [['first task', { at: old, reason: 'fetch-failed' }], ['second task', { at: old, reason: 'fetch-failed' }]],
    'a merge seen before the fetch started failing is not shown as merged once the check is old');
  // When nothing else waits on the step, release follows the project's rule; the owner is not assumed to release.
  const done = { ...supervisor, campaigns: supervisor.campaigns.map((c) => ({ ...c, tasks: c.tasks.map((task) => task.id === 'T3' ? { ...task, state: 'done', resultUrl: null } : task) })) };
  assert.equal(ownerView(done, merges).items[0].points.at(-1).text,
    'Nothing else in this work waits on it; after merging, release follows SampleApp\'s release policy.');
});

test('a working agent with a silent supervisor is said plainly, and same-titled campaigns are told apart', () => {
  const now = Date.now();
  const campaign = (id) => ({ id, repository: 'example-org/sampleapp', trackingIssue: 442, trackingUrl: 'https://github.com/example-org/sampleapp/issues/442', purpose: 'Run a controlled pilot', control: 'registered',
    controllerLive: false, livenessDefect: false, leaseExpiresAt: new Date(now - 10 * 60_000).toISOString(), blocker: null, tasks: [],
    agents: [{ heartbeatState: 'unknown', progress: { lastActivityAt: now - 30_000 } }] });
  const supervisor = { available: true, campaigns: [campaign('sampleapp-442-pilot-telegram'), campaign('sampleapp-442-pilot-whatsapp')], coordinator: null, recent: null };
  const view = ownerView(supervisor, checked(), { host: 'workstation', now });
  // One item for AIWorks stopped on this computer, however many pieces of work it holds up (review F9).
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].text, 'An AI worker is still working, but AIWorks stopped checking in on this computer');
  assert.equal(view.items[0].at, now - 10 * 60_000);
  assert.match(view.items[0].points[0].text, /result is collected and checked only when AIWorks runs again/);
  assert.equal(view.items[0].points[1].text, 'Held up in SampleApp: “Run a controlled pilot (Telegram)”, “Run a controlled pilot (Whatsapp)”.');
  assert.equal(view.campaigns['sampleapp-442-pilot-telegram'].liveness, 'agent-working-supervisor-silent');
  assert.deepEqual(['sampleapp-442-pilot-telegram', 'sampleapp-442-pilot-whatsapp'].map((id) => view.campaigns[id].purpose.variant), ['Telegram', 'Whatsapp']);
});

test('campaigns with something for the owner and active ones come first; finished ones collapse to one line, newest first', () => {
  const now = Date.now(), hours = (n) => new Date(now - n * 3600_000).toISOString();
  const campaign = (id, control, extra = {}) => ({ id, repository: 'example-org/sampleapp', trackingIssue: 443, trackingUrl: 'https://github.com/example-org/sampleapp/issues/443',
    purpose: `Purpose of ${id}`, control, readiness: control === 'registered' ? 'ACTIVE' : control === 'finished' ? 'COMPLETE' : 'CANCELLED',
    controllerLive: control === 'registered', livenessDefect: false, leaseExpiresAt: null, blocker: null, tasks: [], agents: [], lastProgressAt: null, ...extra });
  const sha = (number) => String(number).padStart(40, '0');
  const done = (id, number) => ({ id, title: `${id} title`, outcome: null, state: 'done', resultUrl: `https://github.com/example-org/sampleapp/pull/${number}`, dependsOn: [],
    attempts: 1, verifierRejections: 0, verifiedSha: sha(number) });
  // Snapshot order: active first, then finished and cancelled campaigns by creation.
  const supervisor = { available: true, coordinator: null, recent: null, campaigns: [
    campaign('active', 'registered', { tasks: [{ ...done('A1', 1), state: 'pending', resultUrl: null }] }),
    campaign('finished-old', 'finished', { tasks: [done('O1', 461)], lastProgressAt: hours(3) }),
    campaign('finished-review', 'finished', { tasks: [done('R1', 463)], lastProgressAt: hours(5) }),
    campaign('cancelled', 'cancelled', { tasks: [done('C1', 462), { ...done('C2', 0), state: 'pending', resultUrl: null }], lastProgressAt: hours(2) }),
    campaign('finished-new', 'finished', { tasks: [done('N1', 464)], lastProgressAt: hours(1) }),
  ] };
  const view = ownerView(supervisor, checked({ 'finished-old/O1': result(sha(461), true), 'cancelled/C1': result(sha(462), true),
    'finished-review/R1': result(sha(463), false), 'finished-new/N1': result(sha(464), true) }), { now });
  assert.deepEqual(view.items.map((item) => item.campaignId), ['finished-review']);
  assert.deepEqual(view.layout, { cards: ['finished-review', 'active'], finished: ['finished-new', 'cancelled', 'finished-old'] });
  assert.equal(view.campaigns['finished-new'].outcome, 'The merged work is ready; release follows SampleApp\'s release policy');
  assert.equal(view.campaigns['finished-review'].finished, 'All steps are finished · 1 step waits for your review (merge not seen yet)');
  assert.equal(view.campaigns.cancelled.outcome, 'Cancelled · 1 of 2 steps delivered');
  assert.equal(view.campaigns.active.outcome, null);
  // The page follows that order, gives finished campaigns one line each, and shows no controls on a finished card.
  const page = readFileSync(join(resolve(import.meta.dirname, '../..'), 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /const controls = terminal \? null : el\('div', \{ class: 'campaign-controls' \}/);
  assert.match(page, /terminal \? null : el\('div', \{\}, controls, note \?/);
  assert.match(page, /\.\.\.cards\.map\(\(c\) => campaignCard\(c, false\)\)/);
  assert.match(page, /el\('div', \{ class: 'subtext' \}, ownerCampaign\(c\)\?\.outcome/);
});

test('the summary since the last visit counts merged, delivered, newly waiting and failed runs', (t) => {
  const { dataDir, store, d, finish } = fixture(t);
  const before = Date.now() - 60_000;
  finish('T1', 'https://github.com/example-org/sampleapp/pull/463', { verified_sha: A });
  finish('T2', 'https://github.com/example-org/sampleapp/pull/464', { verified_sha: B });
  store.journal(d.campaignId, 'published', { task: 'T1', url: 'https://github.com/example-org/sampleapp/pull/463' }, Date.now());
  store.journal(d.campaignId, 'operation-finished', { op: 'x', class: 'result', terminal: 'rejected' }, Date.now());
  store.journal(d.campaignId, 'operation-finished', { op: 'y', class: 'timeout' }, Date.now());
  store.journal(d.campaignId, 'operation-finished', { op: 'z', class: 'quota' }, Date.now());
  store.journal(d.campaignId, 'published', { task: 'T0', url: 'https://github.com/example-org/sampleapp/pull/1' }, before - 3_600_000);
  // A failing supervisor step is journaled on every tick: it is the supervisor's problem, not a failed agent run.
  for (let i = 0; i < 3; i++) store.journal(d.campaignId, 'step-error', { message: 'raw error text' }, Date.now());
  store.journal(d.campaignId, 'liveness-defect', { tasks: [] }, Date.now());
  const supervisor = supervisorSnapshot(dataDir, Date.now(), { since: before });
  // The merge time is the merge commit's time in local git.
  const view = ownerView(supervisor, checked({ [`${d.campaignId}/T1`]: result(A, false), [`${d.campaignId}/T2`]: result(B, true, Date.now()) }));
  assert.equal(view.recent.delivered.length, 1, 'only publications since the last visit');
  assert.deepEqual(view.recent.waiting.map((item) => item.number), [463]);
  assert.deepEqual(view.recent.merged.map((item) => item.number), [464]);
  const unknownTime = ownerView(supervisor, checked({ [`${d.campaignId}/T2`]: result(B, true, null) }));
  assert.deepEqual(unknownTime.recent.merged, [], 'a merge without a known time (a fast-forward) is not claimed as recent');
  assert.equal(view.recent.failures, 2, 'a provider limit is a wait, not a failure, and supervisor errors are not agent runs');
  assert.equal(view.recent.rejected, 1);
  assert.deepEqual([view.recent.supervisorErrors, view.recent.livenessProblems], [3, 1]);
  assert.ok(!JSON.stringify(view).includes('raw error text'));
  assert.equal(supervisorSnapshot(dataDir).recent, null, 'no since: no summary');
});

test('stops, decisions, unchecked merges and an unreadable inbox need the owner; a pause by itself does not', (t) => {
  const { dataDir, store, d, finish } = fixture(t, declaration({ tasks: three().map((task) => ({ ...task, outcome: `Owners get ${task.title}` })) }));
  finish('T1', 'https://github.com/example-org/sampleapp/pull/465');
  const t2 = store.task(d.campaignId, 'T2');
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T2' }, t2.version, { blocked: { class: 'B3', reason: 'owner-reserved: worker text' } }, Date.now());
  campaignPause(store, d.campaignId, 'Supervisor upgrade', Date.now());
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ coordinator: { enabled: true, permissionMode: 'auto', reportTo: 'example-org/aiworks#3' } }));
  const supervisor = supervisorSnapshot(dataDir);
  assert.equal(supervisor.campaigns[0].tasks[0].outcome, 'Owners get first task');
  assert.equal(supervisor.campaigns[0].pausedReason, 'Supervisor upgrade');
  const view = ownerView(supervisor, checked());
  const kinds = view.items.map((item) => item.kind);
  // No pause item: the pause is shown on the campaign card. This store never had a supervisor, though, and a paused
  // campaign still needs one, so that is listed.
  assert.deepEqual(kinds, ['review', 'decision', 'controller', 'coordinator']);
  assert.deepEqual([view.items[0].action, view.items[0].text, view.items[0].link.label], ['Review and merge', 'Owners get first task', 'Open PR #465']);
  assert.equal(view.items[0].points[0].text, 'No verified commit is recorded, so the merge cannot be checked here; check the pull request.');
  assert.deepEqual([view.items[1].action, view.items[1].text], ['Decision needed', 'Owners get second task']);
  assert.ok(!view.items[1].points[0].text.includes('worker text'), 'stop reasons are supervisor words, never worker output');
  assert.equal(view.items[2].text, 'AIWorks on this computer has not picked up this work yet (it is paused)');
  assert.ok(!view.items.some((item) => /is paused$|Supervisor upgrade/.test(item.text)), 'the pause reason is never an owner item');
  assert.equal(view.items[3].text, 'The coordinator cannot read your messages');
  assert.ok(view.layout.cards.includes(d.campaignId), 'a paused campaign keeps its card');
});

test('Needs me groups today\'s items by project, case-insensitively, with "AIWorks itself" last and counts that add up', () => {
  const now = Date.now(), sha = (n) => String(n).padStart(40, '0');
  const campaign = (id, repository, extra = {}) => ({ id, repository, trackingIssue: 1, trackingUrl: `https://github.com/${repository}/issues/1`, purpose: `Purpose of ${id}`,
    control: 'registered', controllerLive: true, livenessDefect: false, leaseExpiresAt: null, blocker: null, tasks: [], agents: [], lastProgressAt: null, ...extra });
  const review = (id, repository, number) => ({ id, title: `${id} title`, outcome: `${id} outcome`, state: 'done', resultUrl: `https://github.com/${repository}/pull/${number}`,
    dependsOn: [], attempts: 1, verifierRejections: 0, verifiedSha: sha(number) });
  const decision = (id, repository) => ({ id, title: `${id} title`, outcome: `${id} outcome`, state: 'pending', resultUrl: null, dependsOn: [], attempts: 1, verifierRejections: 0,
    blocked: 'B3', blockedReason: 'owner-reserved decision; see the task issue', issueUrl: `https://github.com/${repository}/issues/9` });
  const supervisor = { available: true, recent: null, campaigns: [
    campaign('sampleapp-a', 'example-org/sampleapp', { tasks: [review('A1', 'example-org/sampleapp', 463)] }),
    // A supervisor fault says it is not an owner action: it belongs to AIWorks itself, still naming its project.
    campaign('shop-fault', 'example/shop', { livenessDefect: true, tasks: [decision('S1', 'example/shop')] }),
    campaign('sampleapp-b', 'example-org/sampleapp', { tasks: [review('B1', 'example-org/sampleapp', 464)] }),
    // Another owner's repository with the same short name keeps its owner in the group name.
    campaign('other-sampleapp', 'example/SampleApp', { tasks: [review('O1', 'example/SampleApp', 7)] }),
    // A stopped supervisor is one fact about this computer and restarting it is the owner's action: it is counted under
    // AIWorks itself, never under the project (review F9).
    campaign('notes-stopped', 'example/notes', { controllerLive: false, leaseExpiresAt: new Date(now - 60 * 60_000).toISOString() }),
    // Waiting for an AI worker's usage limit to reset is never listed (AW-002).
    campaign('notes-wait', 'example/notes', { waitingReason: 'provider-availability', tasks: [{ ...decision('W1', 'example/notes'), blocked: null, blockedReason: null }] }),
  ], coordinator: { configError: 'coordinator.reportTo is missing', blocked: null, messages: [] } };
  const merges = { repositories: ['example-org/sampleapp', 'example/SampleApp'].map((repository) => ({ repository, configured: true, fetchedAt: now, attemptedAt: now, error: null })),
    steps: { 'sampleapp-a/A1': result(sha(463), false), 'sampleapp-b/B1': result(sha(464), false), 'other-sampleapp/O1': result(sha(7), false) } };
  const view = ownerView(supervisor, merges, { host: 'workstation', now });
  assert.deepEqual(view.groups.map((group) => [group.name, group.project, group.count]), [
    ['example-org/sampleapp', 'example-org/sampleapp', 2], ['shop', 'example/shop', 1], ['example/SampleApp', 'example/SampleApp', 1], [SYSTEM_GROUP, null, 1]]);
  assert.equal(SYSTEM_GROUP, 'AIWorks itself');
  assert.deepEqual(view.groups[0].items.map((item) => item.campaignId), ['sampleapp-a', 'sampleapp-b'], 'one project whatever the spelling of its name');
  // The fault and the unreadable inbox are listed but not counted (review F17); the stop is counted.
  assert.deepEqual(view.groups.at(-1).items.map((item) => [item.kind, item.repository, item.about, item.text, Boolean(item.system)]), [
    ['controller', null, 'example/shop', 'AIWorks has a problem of its own with this work', true],
    ['controller', null, 'example/notes', 'AIWorks stopped on this computer', false],
    ['coordinator', null, undefined, 'The coordinator cannot read your messages', true]]);
  assert.equal(view.groups.at(-1).notCounted, 2);
  // Grouping only: the same items, in today's order within each group, and the count is today's headline count.
  const grouped = view.groups.flatMap((group) => group.items);
  assert.equal(grouped.length, view.items.length);
  assert.deepEqual(new Set(grouped), new Set(view.items), 'no item is added, dropped or copied');
  assert.equal(view.headline, `Needs you (${view.groups.reduce((n, group) => n + group.count, 0)})`);
  assert.ok(!view.items.some((item) => item.campaignId === 'notes-wait'), 'a usage-limit wait is not an owner task');
  // Nothing for the owner: no group at all, not an empty one. No supervisor state: no groups either.
  const calm = ownerView({ ...supervisor, coordinator: null, campaigns: [supervisor.campaigns.at(-1)] }, merges, { now });
  assert.deepEqual([calm.items, calm.groups, calm.headline], [[], [], 'Nothing is blocked on you right now']);
  assert.deepEqual(ownerView({ available: false }).groups, []);
});

test('on the review fixture, Needs me lists the same items and count as before, grouped by project', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-owner-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const { dataDir } = buildReviewFixture(root);
  const watcher = new MergeWatcher({ steps: () => publishedSteps(dataDir), checkouts: configuredCheckouts(dataDir), git: configuredGitCommand(dataDir) });
  await watcher.refresh();
  const now = Date.now(), view = ownerView(supervisorSnapshot(dataDir, now), watcher.snapshot(), { host: 'review-pc', now });
  assert.ok(view.items.length > 0);
  // Listed items that are not owner actions are not counted (review F17).
  assert.equal(view.headline, `Needs you (${view.items.filter((item) => !item.system).length})`);
  assert.equal(view.count, view.groups.reduce((n, group) => n + group.count, 0));
  const grouped = view.groups.flatMap((group) => group.items);
  assert.deepEqual(new Set(grouped), new Set(view.items));
  assert.equal(grouped.length, view.items.length);
  assert.deepEqual(view.groups.map((group) => group.name), ['notes-site', 'shop-app', SYSTEM_GROUP], 'projects in the order of their first item, AIWorks itself last');
  for (const group of view.groups.slice(0, -1)) assert.ok(group.items.every((item) => item.repository.toLowerCase() === group.project.toLowerCase() && !item.system), group.name);
  // The supervisor fault in notes-site says it is not an owner action, so it is listed under AIWorks itself, and so is
  // the one item for AIWorks stopped on this computer (review F9).
  assert.deepEqual(view.groups.at(-1).items.map((item) => [item.campaignId, item.about]), [[REVIEW_STATES['supervisor-fault'].campaignId, 'example/notes-site'], [null, undefined]]);
  // Neither the usage-limit wait nor a pause with a running supervisor is listed.
  for (const state of ['provider-wait', 'paused']) assert.ok(!view.items.some((item) => item.campaignId === REVIEW_STATES[state].campaignId), state);
});

test('the Needs me page shows one headed group per project, linked to it, and "AIWorks itself" with the project its item is about', () => {
  const page = readFileSync(join(resolve(import.meta.dirname, '../..'), 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /const \{ headline, count, groups = \[\], unknownResults: unknown, also, reply \} = owner;/);
  assert.match(page, /\.\.\.groups\.map\(needsGroup\),/);
  assert.match(page, /el\('h3', \{ id: `needs-group-\$\{group\.key\}`, class: 'section-title' \}, group\.project \? routeLink\(group\.name, \{ screen: 'project', project: group\.project \}\) : group\.name, NEEDS\.groupCount\(group\.count, group\.notCounted\)\)/);
  assert.match(page, /el\('ul', \{ class: 'needs-list' \}, \.\.\.group\.items\.map\(needsItem\)\)/);
  assert.match(page, /item\.about \? `Project \$\{projectName\(item\.about\)\}` : null/);
  assert.doesNotMatch(page, /\.\.\.items\.map\(\(item\) => el\('li', \{ class: `needs-item/, 'no ungrouped list is left on the page');
});

const raw = (base, path, headers, method = 'GET') => new Promise((resolve, reject) => {
  const req = request(`${base}${path}`, { method, headers }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject); req.end();
});

test('a dashboard link opened from another site loads the page, while data and commands stay same-origin only', async (t) => {
  const { dataDir, d } = fixture(t);
  let checks = 0;
  const roadmap = { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) };
  const merges = { refresh: () => { checks++; return Promise.resolve(); }, snapshot: () => ({ refreshing: false, repositories: [], steps: {} }) };
  const server = createDashboardServer({ dataDir, roadmap, merges, host: { name: 'TestPc', revision: 'abc1234def56' } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const navigate = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal(await raw(base, '/', navigate), 200, 'following a link from GitHub or Telegram opens the page');
  assert.equal(await raw(base, '/#overview', navigate), 200);
  assert.equal(await raw(base, '/api/state', navigate), 403, 'data never answers a cross-site request');
  assert.equal(await raw(base, '/api/session', navigate), 403, 'the command token never answers a cross-site request');
  assert.equal(await raw(base, '/dashboard.js', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }), 403);
  assert.equal(await raw(base, '/', { ...navigate, 'Sec-Fetch-Dest': 'iframe' }), 403, 'framing is not a page navigation');
  assert.equal(await raw(base, '/', { ...navigate, Origin: 'https://evil.example' }), 403);
  assert.equal(await raw(base, '/', { ...navigate, Host: 'evil.example' }), 403, 'the exact loopback Host is still required');
  assert.equal(await raw(base, '/api/commands', { ...navigate, 'Content-Type': 'application/json' }, 'POST'), 403);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual(state.host, { name: 'TestPc', revision: 'abc1234def56' });
  assert.equal(state.owner.available, true);
  assert.equal(checks, 1, 'only a same-origin state request starts a local merge check');
  assert.deepEqual(state.merges, { refreshing: false, repositories: [] });
  assert.ok(d.campaignId in state.owner.campaigns);
});
