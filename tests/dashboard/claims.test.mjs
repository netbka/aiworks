// Owner-facing statements claim no more than the state supports (governance-archive#91 review): a posted report is for the owner to
// read, a finished campaign is calm only when every step is merged or a report, "merged" needs a current local git check,
// and the dashboard never says "ready to merge" (it reads no CI or conflict state). Disposable stores and synthetic merge state only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart, campaignPause } from '../../src/supervisor/api.mjs';
import { declaration } from '../supervisor/helpers.mjs';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { ownerView, delivery, mergeCheck } from '../../src/dashboard/owner.mjs';
import { readReleaseAuthorizations } from '../../src/dashboard/roadmap.mjs';
import { stateCopy, workLine } from '../../src/dashboard/copy.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const GOVERNANCE = join(ROOT, 'tests/fixtures/governance');
const task = (id, title, extra = {}) => ({ id, issue: 437 + Number(id.slice(1)), title, deliverable: 'commit', goal: `${title}.`, dependsOn: [], acceptance: ['a'], references: ['AGENTS.md'], ...extra });

function fixture(t, tasks, registeredAt = Date.now()) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-claims-'));
  const store = new Store(join(dataDir, 'supervisor.db'));
  const d = declaration({ tasks });
  campaignStart(store, d, registeredAt);
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const finish = (taskId, url, extra = {}) => {
    const row = store.task(d.campaignId, taskId);
    store.patch('tasks', { campaign_id: d.campaignId, task_id: taskId }, row.version, { state: 'done', pr_url: url, ...extra }, Date.now());
  };
  const close = (nextAction) => {
    const c = store.campaign(d.campaignId);
    store.patch('campaigns', { id: d.campaignId }, c.version, { control: 'finished', status: 'ready', next_action: nextAction }, Date.now());
  };
  return { dataDir, store, d, finish, close };
}

/** Merge state as the local merge check reports it: example-org/sampleapp fetched just now, and a result per campaign step. */
const checked = (steps = {}, repo = {}) => ({ repositories: [{ repository: 'example-org/sampleapp', configured: true, fetchedAt: Date.now(), attemptedAt: Date.now(), error: null, ...repo }], steps });
/** One result per task id of the test campaign: true merged, false not reachable from the base branch. */
const results = (campaignId, merged) => Object.fromEntries(Object.entries(merged).map(([taskId, value]) => [`${campaignId}/${taskId}`,
  { sha: sha(taskId), baseBranch: 'main', merged: value, mergedAt: null }]));
const sha = (taskId) => taskId.replace(/\D/g, '').padStart(40, 'a');
/** Everything a "Needs you" item says, in reading order: subject, full evidence sentence, then its points. */
const whole = (item) => [`${item.text}.`, item.detail, ...item.points.map((point) => point.text)].filter(Boolean).join(' ');

test('a posted report is for the owner to read; a finished report campaign shows the supervisor’s next action', (t) => {
  const { dataDir, d, finish, close } = fixture(t, [task('T1', 'pilot report', { deliverable: 'report' }), task('T2', 'decision report', { deliverable: 'report' })]);
  finish('T1', 'https://github.com/example-org/sampleapp/issues/438#issuecomment-1');
  finish('T2', 'https://github.com/example-org/sampleapp/issues/439#issuecomment-2');
  const action = 'Planning reports published in example-org/sampleapp; review recommendations before assigning implementation.';
  close(action);
  const supervisor = supervisorSnapshot(dataDir);
  assert.equal(supervisor.campaigns[0].nextAction, action, 'the controller’s own sentence for a finished reports campaign reaches the owner');
  const view = ownerView(supervisor, checked());
  const owner = view.campaigns[d.campaignId];
  assert.equal(owner.deliveries.T1.state, 'report-posted');
  assert.equal(owner.deliveries.T1.note, 'For you to read and decide on');
  assert.equal(owner.finished, `All steps are finished · ${action}`);
  assert.equal(owner.counts.reports, 2);
  // Any other stored next action can quote worker text: it is not passed through, and the count says what waits.
  close('T1: worker text; run recheck after recovery');
  const generic = ownerView(supervisorSnapshot(dataDir), checked());
  assert.equal(generic.campaigns[d.campaignId].finished, 'All steps are finished · 2 reports posted for you to read');
  assert.ok(!JSON.stringify(generic).includes('worker text'));
  // The page takes these sentences from the owner view instead of claiming nothing waits.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.doesNotMatch(page, /Nothing for you to do/i);
  assert.doesNotMatch(page, /nothing waits for you/i);
});

test('a finished campaign says "nothing waits for you" only when every step is merged or a report', (t) => {
  const { dataDir, d, finish, close } = fixture(t, [task('T1', 'first'), task('T2', 'second'), task('T3', 'third')]);
  for (const [id, number] of [['T1', 463], ['T2', 464], ['T3', 465]]) finish(id, `https://github.com/example-org/sampleapp/pull/${number}`, { verified_sha: sha(id) });
  close('Release gate: review campaign deliveries under example-org/sampleapp\'s own merge and release policy.');
  const supervisor = supervisorSnapshot(dataDir);
  const finished = (merges) => ownerView(supervisor, merges).campaigns[d.campaignId];
  // Before the first merge check.
  const first = finished({ repositories: [], steps: {} });
  assert.equal(first.finished, 'All steps are finished · the merge of 3 steps is being checked; check again shortly');
  assert.equal(first.deliveries.T1.note, 'Checking the base branch for the merge; check again shortly');
  // The fetch fails and there is no earlier result: the merges are not seen, so the steps wait for the owner.
  const failed = finished(checked({}, { fetchedAt: null, error: 'fetch-failed' }));
  assert.equal(failed.finished, 'All steps are finished · 3 steps wait for your review (merge not seen yet)');
  assert.equal(failed.deliveries.T1.note, 'The last check of the base branch failed; showing the last known state');
  assert.equal(finished(checked(results(d.campaignId, { T1: true, T2: true, T3: false }))).finished,
    'All steps are finished · 1 step waits for your review (merge not seen yet) · 2 merged');
  assert.equal(finished(checked(results(d.campaignId, { T1: true, T2: true, T3: null }))).finished,
    'All steps are finished · the merge of 1 step is being checked; check again shortly · 2 merged');
  assert.equal(finished(checked(results(d.campaignId, { T1: true, T2: true, T3: true }))).finished,
    'All steps are finished · the merged work is ready; release follows SampleApp\'s release policy');
  // Stale merge data never reads as merged, so it never makes a campaign ready for release.
  const stale = finished(checked(results(d.campaignId, { T1: true, T2: true, T3: true }), { fetchedAt: Date.now() - 20 * 60_000 }));
  assert.equal(stale.releaseReady, false);
  assert.equal(stale.finished, 'All steps are finished · the merge of 3 steps is being checked; check again shortly');
  // The calm sentence needs every step merged or a report: here, a campaign with nothing delivered for the owner.
  const empty = { available: true, coordinator: null, recent: null, campaigns: [{ ...supervisor.campaigns[0], tasks: [], agents: [] }] };
  assert.equal(ownerView(empty, checked()).campaigns[d.campaignId].finished, 'All steps are finished · nothing waits for you');
});

test('a finished step with a missing or unrecognised result link is unknown, never published or settled', (t) => {
  for (const url of [null, 'https://github.com/example-org/sampleapp/issues/437', 'https://github.com/example-org/sampleapp/pull/5#issuecomment-1']) {
    const result = delivery({ id: 'T1', state: 'done', resultUrl: url, verifiedSha: sha('T1') }, checked(), Date.now(), 'c1');
    assert.deepEqual([result.state, result.reason, result.note], ['unknown', 'no-link', 'No result link was recorded; check the step issue'], String(url));
  }
  const { dataDir, d, finish, close } = fixture(t, [task('T1', 'first'), task('T2', 'second')]);
  finish('T1', 'https://github.com/example-org/sampleapp/pull/463', { verified_sha: sha('T1') });
  finish('T2', 'https://github.com/example-org/sampleapp/issues/439');
  close(null);
  const supervisor = supervisorSnapshot(dataDir);
  const view = ownerView(supervisor, checked(results(d.campaignId, { T1: true })));
  // A missing link never clears by itself, so it is not "checking": it is an item to check, never nothing.
  assert.equal(view.unknownResults, 0);
  assert.deepEqual(view.items.map((item) => [item.kind, item.action, item.text, item.link.label]), [['check', 'Check on GitHub', 'second', 'Open the step issue']]);
  assert.equal(view.items[0].points[0].text, 'This step finished, but no result link was recorded, so the dashboard cannot tell where it stands.');
  assert.equal(view.headline, 'Needs you (1)');
  assert.equal(view.campaigns[d.campaignId].finished, 'All steps are finished · 1 step has no recorded result link; check its issue · 1 merged');
  // Only a merge check that can still come shortly keeps the heading at "checking": before the first check, or while it is old.
  for (const merges of [{ repositories: [], steps: {} }, checked(results(d.campaignId, { T1: true }), { fetchedAt: Date.now() - 20 * 60_000 })]) {
    const checking = ownerView(supervisor, merges);
    assert.equal(checking.unknownResults, 1);
    assert.deepEqual(checking.items.map((item) => item.text), ['second']);
    assert.equal(checking.headline, 'Needs you (1)');
  }
  const onlyTransient = ownerView({ ...supervisor, campaigns: [{ ...supervisor.campaigns[0], tasks: supervisor.campaigns[0].tasks.filter((item) => item.id === 'T1') }] }, { repositories: [], steps: {} });
  assert.deepEqual([onlyTransient.unknownResults, onlyTransient.items, onlyTransient.headline], [1, [], 'Checking for merges before listing what needs you']);
});

test('the dashboard never says "ready to merge": it names the accepted commit and points to the pull request for CI and conflicts', (t) => {
  const { dataDir, d, finish } = fixture(t, [task('T1', 'first'), task('T2', 'second', { dependsOn: ['T1'] })]);
  finish('T1', 'https://github.com/example-org/sampleapp/pull/463', { verified_sha: 'a'.repeat(40) });
  const supervisor = supervisorSnapshot(dataDir), now = Date.now();
  const steps = { [`${d.campaignId}/T1`]: { sha: 'a'.repeat(40), baseBranch: 'main', merged: false, mergedAt: null } };
  const review = (repo = {}) => ownerView(supervisor, checked(steps, repo), { now }).items.find((entry) => entry.kind === 'review');
  const expected = /^first\. Passed the independent check at commit aaaaaaa\. This dashboard does not read CI checks or conflicts; see them on the pull request before merging\. Merging lets “second” build on it\.$/;
  // Fresh, old and failing merge data alike: no readiness claim is ever made.
  for (const repo of [{}, { fetchedAt: now - 20 * 60_000, error: 'fetch-failed' }, { fetchedAt: now - 60_000, error: 'fetch-failed' }, { configured: false, fetchedAt: null }]) {
    const item = review(repo);
    assert.doesNotMatch(whole(item), /Ready to merge|no conflicts|CI checks? passed/i, JSON.stringify(repo));
    assert.equal(item.ready, undefined, 'there is no readiness field');
  }
  assert.match(whole(review()), expected);
  assert.deepEqual([review().evidence, review().detail], ['Passed the check at aaaaaaa · CI and conflicts on the PR',
    'Passed the independent check at commit aaaaaaa. This dashboard does not read CI checks or conflicts; see them on the pull request before merging.']);
  // The page has no readiness styling or wording left.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.doesNotMatch(page, /Ready to merge|item\.ready|statusCheckRollup|mergeable/);
});

test('restart advice waits a few minutes after the controller lease lapses', () => {
  const now = Date.now();
  const campaign = (lapsedMs, agents = []) => ({ id: 'c1', repository: 'example-org/sampleapp', trackingIssue: 443, trackingUrl: 'https://github.com/example-org/sampleapp/issues/443', purpose: null,
    control: 'registered', readiness: 'CONTROLLER_OFFLINE', controllerLive: false, livenessDefect: false, leaseExpiresAt: new Date(now - lapsedMs).toISOString(), blocker: null, tasks: [], agents });
  const view = (c) => ownerView({ available: true, campaigns: [c], coordinator: null, recent: null }, [], { host: 'workstation', now });
  const working = [{ heartbeatState: 'unknown', progress: { lastActivityAt: now - 30_000 } }];
  for (const c of [campaign(2 * 60_000), campaign(2 * 60_000, working)]) {
    const late = view(c);
    assert.equal(late.campaigns.c1.liveness, 'late');
    assert.equal(late.campaigns.c1.lastCheckIn, now - 2 * 60_000);
    assert.deepEqual(late.items, [], 'an upgrade or restart in progress is not an owner action yet');
  }
  const stopped = view(campaign(10 * 60_000));
  assert.equal(stopped.campaigns.c1.liveness, 'stopped');
  assert.equal(stopped.items[0].points[0].text, 'No new step starts. If nobody is updating it right now, restart it on this computer: sign out and sign in again, or start the task “AIWorks Supervisor”.');
});

test('a campaign no supervisor has picked up yet gets the same grace from its registration', (t) => {
  const registered = Date.now() - 2 * 60_000;
  const { dataDir, d } = fixture(t, [task('T1', 'first')], registered);
  const supervisor = supervisorSnapshot(dataDir);
  assert.equal(supervisor.campaigns[0].readiness, 'BOOTSTRAP_REQUIRED');
  assert.equal(supervisor.campaigns[0].registeredAt, registered, 'the snapshot carries the registration time');
  const view = (now) => ownerView(supervisor, [], { host: 'workstation', now });
  const fresh = view(registered + 2 * 60_000);
  assert.equal(fresh.campaigns[d.campaignId].liveness, 'awaiting-pickup');
  assert.equal(fresh.campaigns[d.campaignId].registeredAt, registered);
  assert.deepEqual(fresh.items, [], 'just registered: no restart advice yet');
  const late = view(registered + 6 * 60_000);
  assert.equal(late.campaigns[d.campaignId].liveness, 'stopped');
  assert.equal(late.items[0].text, 'AIWorks on this computer has not picked up this work yet');
  assert.match(late.items[0].points[0].text, /^It is approved, but AIWorks has not picked it up\. If nobody is updating it right now, restart it on this computer: /);
  // A campaign that had a lease uses the lease, not its registration.
  const lapsed = { ...supervisor, campaigns: supervisor.campaigns.map((c) => ({ ...c, readiness: 'CONTROLLER_OFFLINE', leaseExpiresAt: new Date(registered - 60 * 60_000).toISOString() })) };
  assert.equal(ownerView(lapsed, [], { now: registered + 60_000 }).campaigns[d.campaignId].liveness, 'stopped');
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /'awaiting-pickup': 'Waiting for the supervisor'/);
});

test('"Merging lets X build on it" names only steps that have not started; a started step keeps its base', (t) => {
  const { dataDir, store, d, finish } = fixture(t, [task('T1', 'first'), task('T2', 'second', { dependsOn: ['T1'] }), task('T3', 'third', { dependsOn: ['T1'] })]);
  finish('T1', 'https://github.com/example-org/sampleapp/pull/463', { verified_sha: 'a'.repeat(40) });
  const start = (taskId, changes) => {
    const row = store.task(d.campaignId, taskId);
    store.patch('tasks', { campaign_id: d.campaignId, task_id: taskId }, row.version, changes, Date.now());
  };
  const merges = checked({ [`${d.campaignId}/T1`]: { sha: 'a'.repeat(40), baseBranch: 'main', merged: false, mergedAt: null } });
  const say = () => ownerView(supervisorSnapshot(dataDir), merges).items.find((item) => item.kind === 'review').points[0].text;
  assert.match(say(), /Merging lets “second” and “third” build on it\.$/, 'neither has started');
  start('T3', { state: 'implementing', attempts: 1 });
  assert.match(say(), /Merging lets “second” build on it\.$/, 'a running dependent already has its base');
  // A step back in "pending" after a failed attempt keeps the worktree, and so the base, it started with.
  start('T2', { attempts: 1, retry_at: Date.now() + 60_000, last_error: 'timeout: synthetic' });
  assert.match(say(), /“second” and “third” already started without it, so merging now does not change those steps\.$/);
  assert.doesNotMatch(say(), /build on it|releasing it is your next step/, 'started dependents are not unblocked, and the campaign is not ready for release');
});

test('the calm heading is about what blocks on the owner; reports to read and releases are named apart', (t) => {
  const { dataDir, d, finish, close } = fixture(t, [task('T1', 'pilot report', { deliverable: 'report' }), task('T2', 'second'), task('T3', 'third')]);
  finish('T1', 'https://github.com/example-org/sampleapp/issues/438#issuecomment-1');
  finish('T2', 'https://github.com/example-org/sampleapp/pull/464', { verified_sha: sha('T2') });
  finish('T3', 'https://github.com/example-org/sampleapp/pull/465', { verified_sha: sha('T3') });
  close('Release gate: review campaign deliveries under example-org/sampleapp\'s own merge and release policy.');
  const supervisor = supervisorSnapshot(dataDir);
  const view = ownerView(supervisor, checked(results(d.campaignId, { T2: true, T3: true })));
  assert.deepEqual(view.items, []);
  assert.equal(view.headline, 'Nothing is blocked on you right now');
  // Reports are for the owner; who releases the merged work is the project's rule, not assumed to be the owner.
  assert.deepEqual(view.also, { reports: 1, release: [{ campaignId: d.campaignId, repository: 'example-org/sampleapp' }],
    text: 'Also: 1 report for you to read · merged work in SampleApp is ready; release follows its release policy', short: '1 report for you to read · merged work ready for release' });
  assert.equal(view.campaigns[d.campaignId].finished, 'All steps are finished · 1 report posted for you to read · the merged work is ready; release follows SampleApp\'s release policy');
  // Not ready for release while a pull request is open; it is then a "Needs you" item, and the heading counts it.
  const open = ownerView(supervisor, checked(results(d.campaignId, { T2: true, T3: false })));
  assert.equal(open.headline, 'Needs you (1)');
  assert.deepEqual(open.also, { reports: 1, release: [], text: 'Also: 1 report for you to read', short: '1 report for you to read' });
  assert.equal(ownerView(supervisor, { repositories: [], steps: {} }).headline, 'Checking for merges before listing what needs you', 'an unchecked merge is never calm');
  const nothing = ownerView({ ...supervisor, campaigns: [] }, checked());
  assert.deepEqual([nothing.headline, nothing.also], ['Nothing is blocked on you right now', null]);
  // The page shows the owner view's heading and "Also for you" line; its calm text is scoped to what blocks on the owner.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.doesNotMatch(page, /Nothing needs you|Nothing is waiting for you/);
  assert.match(page, /el\('h2', \{ id: 'needs-title' \}, headline\)/);
  assert.match(page, /also \? el\('p', \{ class: 'needs-also' \}, also\.text\)/);
  assert.match(page, /'Nothing is blocked on you'/);
});

test('"Needs you" items from an old or failing merge check say when it is from, and never read as merged', (t) => {
  const { dataDir, d, finish } = fixture(t, [task('T1', 'first'), task('T2', 'second')]);
  finish('T1', 'https://github.com/example-org/sampleapp/pull/463', { verified_sha: sha('T1') });
  finish('T2', 'https://github.com/example-org/sampleapp/pull/464', { verified_sha: sha('T2') });
  const supervisor = supervisorSnapshot(dataDir), now = Date.now();
  const merges = (repo) => checked(results(d.campaignId, { T1: false, T2: true }), repo);
  const view = (repo) => ownerView(supervisor, merges(repo), { now });
  const old = now - 20 * 60_000, recent = now - 60_000;
  // A failing fetch with an old last success: both steps are review items with the check's time; the merge seen before is not claimed.
  const failing = view({ fetchedAt: old, error: 'fetch-failed' });
  assert.deepEqual(failing.items.map((item) => [item.kind, item.text, item.mergeCheck]), [['review', 'first', { at: old, reason: 'fetch-failed' }], ['review', 'second', { at: old, reason: 'fetch-failed' }]]);
  assert.equal(failing.campaigns[d.campaignId].counts.merged, 0);
  // Old data with no failure: a check is due, so the steps are being checked rather than listed.
  const due = view({ fetchedAt: old });
  assert.deepEqual([due.items.filter((item) => item.kind === 'review'), due.unknownResults, due.campaigns[d.campaignId].counts.merged], [[], 2, 0]);
  // A recent failure keeps the last state (merged stays merged) and shows its age.
  const kept = view({ fetchedAt: recent, error: 'fetch-failed' });
  assert.deepEqual(kept.items.filter((item) => item.kind === 'review').map((item) => [item.text, item.mergeCheck]), [['first', { at: recent, reason: 'fetch-failed' }]]);
  assert.deepEqual([kept.campaigns[d.campaignId].deliveries.T2.state, kept.campaigns[d.campaignId].deliveries.T2.asOf], ['merged', { at: recent, reason: 'fetch-failed' }]);
  // A current, successful check needs no note.
  const fresh = view({ fetchedAt: recent });
  assert.deepEqual(fresh.items.filter((item) => item.kind === 'review').map((item) => [item.text, item.mergeCheck]), [['first', null]]);
  assert.deepEqual(mergeCheck(merges({ fetchedAt: null }), 'example-org/sampleapp', now), { fresh: false, at: null, reason: 'not-checked' }, 'never fetched is not current');
  assert.deepEqual(mergeCheck(merges({ configured: false }), 'example-org/sampleapp', now), { fresh: false, at: null, reason: 'no-checkout' });
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /`Merge check from \$\{/);
  assert.match(page, /'the last fetch failed, retrying within 5 minutes' : 'checking again'/);
  assert.match(page, /item\.mergeCheck \? el\('div', \{ class: 'needs-stale' \}, mergeAsOf\(item\.mergeCheck\)\)/);
});

test('a pause by itself is a neutral campaign state, never a "Needs you" item', (t) => {
  const { dataDir, store, d } = fixture(t, [task('T1', 'first')], Date.now() - 10 * 60_000);
  campaignPause(store, d.campaignId, 'runtime upgrade window to a9e2402', Date.now());
  // A supervisor holds the paused campaign's lease (the controller renews it for paused campaigns too).
  store.acquireLease(d.campaignId, 'synthetic-instance', Date.now(), 60_000);
  const supervisor = supervisorSnapshot(dataDir);
  assert.deepEqual([supervisor.campaigns[0].control, supervisor.campaigns[0].controllerLive], ['paused', true]);
  const view = ownerView(supervisor, [], { host: 'workstation' });
  assert.deepEqual(view.items, [], 'who paused is not recorded, so a pause with a running supervisor is not an owner action');
  assert.equal(view.headline, 'Nothing is blocked on you right now');
  assert.equal(view.campaigns[d.campaignId].liveness, 'running');
  assert.deepEqual(view.layout.cards, [d.campaignId], 'the paused campaign keeps its card, where the pause is shown');
  assert.equal(supervisor.campaigns[0].pausedReason, 'runtime upgrade window to a9e2402', 'the reason is shown as given');
  // The card reads neutral and consistent: "Supervisor running · campaign paused", with the reason as plain text.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /if \(c\.control === 'paused'\) return badge\(\['running', 'late', 'awaiting-pickup'\]\.includes\(liveness\) \? 'unknown' : 'stale', `\$\{livenessNames\[liveness\] \?\? 'Supervisor state unknown'\} · campaign paused`\);/);
  assert.match(workLine(supervisor.campaigns[0], view.campaigns[d.campaignId]), /^Paused since .+ · no new step starts; a step already running may finish · reason given: “runtime upgrade window to a9e2402”$/);
});

test('a paused campaign whose supervisor stopped, or never started, is listed with the restart action', (t) => {
  const registered = Date.now() - 60 * 60_000;
  const { dataDir, d } = fixture(t, [task('T1', 'first')], registered);
  const paused = (lease) => {
    const supervisor = supervisorSnapshot(dataDir);
    const c = { ...supervisor.campaigns[0], control: 'paused', readiness: 'PAUSED', pausedAt: registered, pausedReason: 'runtime upgrade window', controllerLive: false, leaseExpiresAt: lease };
    return { ...supervisor, campaigns: [c] };
  };
  const now = Date.now();
  // An upgrade paused the campaign and the restart failed: the lease lapsed past the grace period, so no supervisor runs.
  const stopped = ownerView(paused(new Date(now - 10 * 60_000).toISOString()), [], { host: 'workstation', now });
  assert.equal(stopped.campaigns[d.campaignId].liveness, 'stopped');
  assert.deepEqual(stopped.items.map((item) => [item.kind, item.text, item.at]), [['controller', 'This work was paused, then AIWorks stopped on this computer', now - 10 * 60_000]]);
  assert.match(stopped.items[0].points[0].text, /^No step starts while it is paused, and it can’t resume until AIWorks runs again\. If nobody is updating it right now, restart it on this computer: /);
  assert.equal(stopped.headline, 'Needs you (1)', 'never "nothing is blocked" while the supervisor is down');
  // Within the grace period it is a restart in progress: late, not yet listed.
  const late = ownerView(paused(new Date(now - 2 * 60_000).toISOString()), [], { host: 'workstation', now });
  assert.deepEqual([late.campaigns[d.campaignId].liveness, late.items], ['late', []]);
  // Paused before any supervisor picked it up, registered an hour ago: not started, with the restart action.
  const never = ownerView(paused(null), [], { host: 'workstation', now });
  assert.deepEqual(never.items.map((item) => item.text), ['AIWorks on this computer has not picked up this work yet (it is paused)']);
  assert.match(never.items[0].points[0].text, /^It is approved and paused, but AIWorks has not picked it up\. If nobody is updating it right now, restart it on this computer: /);
  // The work's line is not calm either: it says AIWorks stopped on this computer, and when.
  const c = paused(new Date(now - 10 * 60_000).toISOString()).campaigns[0];
  assert.match(workLine(c, stopped.campaigns[d.campaignId], { time: () => '12:31', dateTime: () => '13 Oct 11:31' }),
    /^Paused since 13 Oct 11:31 · .* · reason given: “runtime upgrade window” · AIWorks stopped on this computer at about 12:31$/);
});

test('each "Needs you" item leads with what its step delivers, with the evidence in one line', (t) => {
  const { dataDir, d, finish } = fixture(t, [task('T1', 'ingest', { outcome: 'Telegram ingestion: analysed messages are not sent again' }),
    task('T2', 'pairing', { outcome: 'WhatsApp pairing recovers an interrupted result' })]);
  finish('T1', 'https://github.com/example-org/sampleapp/pull/463', { verified_sha: 'a'.repeat(40) });
  finish('T2', 'https://github.com/example-org/sampleapp/pull/464', { verified_sha: 'b'.repeat(40) });
  const view = ownerView(supervisorSnapshot(dataDir), checked({ [`${d.campaignId}/T1`]: { sha: 'a'.repeat(40), baseBranch: 'main', merged: false, mergedAt: null },
    [`${d.campaignId}/T2`]: { sha: 'b'.repeat(40), baseBranch: 'main', merged: false, mergedAt: null } }));
  assert.equal(view.headline, 'Needs you (2)', 'one item per pull request');
  assert.deepEqual(view.items.map((item) => [item.action, item.text, item.link]), [
    ['Review and merge', 'Telegram ingestion: analysed messages are not sent again', { label: 'Open PR #463', url: 'https://github.com/example-org/sampleapp/pull/463' }],
    ['Review and merge', 'WhatsApp pairing recovers an interrupted result', { label: 'Open PR #464', url: 'https://github.com/example-org/sampleapp/pull/464' }]]);
  for (const item of view.items) {
    assert.ok(item.evidence.length <= 60, `compact evidence: ${item.evidence}`);
    assert.match(item.detail, /^Passed the independent check at commit [ab]{7}\. This dashboard does not read CI checks or conflicts; see them on the pull request before merging\.$/);
    assert.ok(item.points.every((point) => !point.text.includes(item.detail)), 'the full evidence sentence is not repeated in the body');
  }
  // The page shows the evidence line as a disclosure whose body is the full sentence.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /item\.evidence \? disclosure\(`needs\/\$\{item\.link\?\.url \?\? item\.text\}`, el\('span', \{ class: 'evidence' \}, item\.evidence\),\s*el\('p', \{ class: 'needs-detail' \}, item\.detail\)\)/);
  assert.match(page, /item\.action \? el\('div', \{ class: 'needs-action' \}, item\.action\)/);
});

test('"AIWorks itself" holds the items that say they are not owner actions, uncounted; a project group never names a campaign', (t) => {
  const { dataDir, store, d, finish } = fixture(t, [task('T1', 'first', { outcome: 'Telegram ingestion: analysed messages are not sent again' })], Date.now() - 10 * 60_000);
  finish('T1', 'https://github.com/example-org/sampleapp/pull/463', { verified_sha: sha('T1') });
  store.acquireLease(d.campaignId, 'synthetic-instance', Date.now(), 60_000);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ coordinator: { enabled: true, permissionMode: 'auto', reportTo: 'example-org/aiworks#3' } }));
  const supervisor = supervisorSnapshot(dataDir);
  const merges = checked(results(d.campaignId, { T1: false }));
  const healthy = ownerView(supervisor, merges);
  assert.deepEqual(healthy.groups.map((group) => [group.name, group.items.map((item) => item.kind)]), [['SampleApp', ['review']], ['AIWorks itself', ['coordinator']]]);
  const faulty = ownerView({ ...supervisor, campaigns: supervisor.campaigns.map((c) => ({ ...c, livenessDefect: true })) }, merges, { host: 'workstation' });
  const [project, system] = faulty.groups;
  assert.deepEqual([project.name, project.items.map((item) => item.kind)], ['SampleApp', ['review']]);
  assert.deepEqual(system.items.map((item) => item.kind), ['controller', 'coordinator']);
  // The fault names the project whose work it holds up, but no project counts it (aiworks#11 review F6).
  assert.deepEqual([system.items[0].system, system.items[0].repository, system.items[0].about], [true, null, 'example-org/sampleapp'], 'the fault still names the project whose work it holds up');
  for (const item of system.items) assert.match(whole(item), /Not yours to fix|for whoever maintains AIWorks/, item.text);
  for (const item of project.items) assert.doesNotMatch(whole(item), /Not yours to fix|for whoever maintains AIWorks/, item.text);
  // Listed, but not counted: neither says it is the owner's to do (review F17).
  assert.equal(faulty.headline, 'Needs you (1)', 'only the owner action is counted');
  assert.deepEqual(faulty.groups.map((group) => [group.count, group.notCounted]), [[1, 0], [0, 2]]);
  assert.equal(healthy.headline, 'Needs you (1)', 'an unreadable inbox is listed, not counted');
  assert.ok(faulty.groups.every((group) => !group.name.includes(d.campaignId)), 'groups are named by project, never by campaign');
});

test('release wording follows the project registry: a recorded standing authorization, else the project’s own policy', (t) => {
  const releases = readReleaseAuthorizations(GOVERNANCE);
  assert.deepEqual(releases['example-org/sampleapp'], { source: 'deploy/AGENTS.md', approval: 'https://github.com/example-org/governance-archive/issues/82' });
  assert.equal(releases['example-org/local-tool'], undefined, 'a recorded gap is not an accepted authorization');
  const { dataDir, d, finish, close } = fixture(t, [task('T1', 'first'), task('T2', 'second')]);
  finish('T1', 'https://github.com/example-org/sampleapp/pull/463', { verified_sha: sha('T1') });
  finish('T2', 'https://github.com/example-org/sampleapp/pull/464', { verified_sha: sha('T2') });
  close('Release gate: review campaign deliveries under example-org/sampleapp\'s own merge and release policy.');
  const supervisor = supervisorSnapshot(dataDir);
  const oneOpen = checked(results(d.campaignId, { T1: false, T2: true }));
  const open = (options) => ownerView(supervisor, oneOpen, options).items[0].points.at(-1).text;
  assert.equal(open({ releases }), 'Nothing else in this work waits on it; after merging, release follows SampleApp\'s standing deploy authorization.');
  assert.equal(open({}), 'Nothing else in this work waits on it; after merging, release follows SampleApp\'s release policy.', 'nothing recorded: no one is named');
  const merged = ownerView(supervisor, checked(results(d.campaignId, { T1: true, T2: true })), { releases });
  assert.equal(merged.campaigns[d.campaignId].finished, 'All steps are finished · the merged work is ready; release follows SampleApp\'s standing deploy authorization');
  assert.equal(merged.also.text, 'Also: merged work in SampleApp is ready; release follows its standing deploy authorization');
  for (const view of [merged, ownerView(supervisor, oneOpen, { releases })]) {
    assert.doesNotMatch(JSON.stringify(view), /your release|releasing it is your next step/i, 'the owner is never assumed to release');
  }
  assert.doesNotMatch(readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8'), /your release/i);
});

// Results (OWNER_WORKSPACE slice S6, build slice UI7). "Changes requested" is not built: it needs GitHub's review state,
// which the dashboard does not read (PROJECT_WORKSPACE_PLAN §6.12 C1, gap G3).
test('Results group finished steps by state in the screen order, with the oldest waiting review as the one primary action', (t) => {
  const { dataDir, d, finish } = fixture(t, [task('T1', 'first'), task('T2', 'second'), task('T3', 'third'), task('T4', 'pilot report', { deliverable: 'report' }),
    task('T5', 'fifth'), task('T6', 'sixth', { outcome: 'Sixth step delivers its outcome' }), task('T7', 'not finished')]);
  finish('T1', 'https://github.com/example-org/sampleapp/pull/470', { verified_sha: sha('T1') });
  finish('T2', 'https://github.com/example-org/sampleapp/pull/468', { verified_sha: sha('T2') });
  finish('T3', 'https://github.com/example-org/sampleapp/pull/463', { verified_sha: sha('T3') });
  finish('T4', 'https://github.com/example-org/sampleapp/issues/441#issuecomment-1');
  finish('T5', 'https://github.com/example-org/sampleapp/issues/442');
  finish('T6', 'https://github.com/example-org/sampleapp/pull/471', { verified_sha: sha('T6') });
  const supervisor = supervisorSnapshot(dataDir);
  const view = ownerView(supervisor, checked(results(d.campaignId, { T1: false, T2: false, T3: true, T6: null })));
  assert.deepEqual(Object.keys(view.results), ['example-org/sampleapp'], 'one entry per project, by its lowercased repository');
  const sampleapp = view.results['example-org/sampleapp'];
  assert.equal(sampleapp.total, 6, 'every finished step is a result; an unfinished one is not');
  // Waiting for your review, reports, merged, then not known yet. Nothing is closed without merging: the local merge
  // check cannot see it, so the group is left out rather than shown empty.
  assert.deepEqual(sampleapp.groups.map((group) => [group.title, group.count, group.rows.map((row) => row.taskId)]), [
    ['Waiting for your review', 2, ['T2', 'T1']], ['Reports to read', 1, ['T4']], ['Merged', 1, ['T3']], ['Not known yet', 2, ['T5', 'T6']]]);
  const row = (id) => sampleapp.groups.flatMap((group) => group.rows).find((item) => item.taskId === id);
  assert.deepEqual([row('T2').word, row('T2').note, row('T2').link], ['Pull request #468 · waiting for your review', 'The merge is not seen on the base branch yet',
    { label: 'Pull request #468', url: 'https://github.com/example-org/sampleapp/pull/468' }]);
  assert.deepEqual([row('T4').word, row('T4').link.url], ['Report posted · for you to read', 'https://github.com/example-org/sampleapp/issues/441#issuecomment-1']);
  assert.deepEqual([row('T5').word, row('T5').note, row('T5').link.label], ['Not known yet', 'No result link was recorded; check the step issue', 'Open the step issue']);
  // A merge check that can still come shortly is not known yet: neither waiting nor merged.
  assert.deepEqual([row('T6').text, row('T6').word, row('T6').note], ['Sixth step delivers its outcome', 'Not known yet', 'Checking the base branch for the merge; check again shortly']);
  assert.deepEqual(sampleapp.primary, { label: 'Review pull request #468', url: 'https://github.com/example-org/sampleapp/pull/468' }, 'the oldest waiting review');
  // Without a waiting review there is no primary action.
  const settled = ownerView(supervisor, checked(results(d.campaignId, { T1: true, T2: true, T3: true, T6: true }))).results['example-org/sampleapp'];
  assert.deepEqual([settled.primary, settled.groups.map((group) => group.key)], [null, ['reports', 'merged', 'unknown']]);
  // No finished step: no results entry, and the page shows the §7.1 empty copy.
  assert.deepEqual(ownerView({ ...supervisor, campaigns: supervisor.campaigns.map((c) => ({ ...c, tasks: c.tasks.filter((item) => item.state !== 'done') })) }, checked()).results, {});
  assert.deepEqual(ownerView({ available: false }).results, {});
  // There is no "Changes requested" state anywhere: the dashboard reads no review decision (C1, gap G3).
  assert.doesNotMatch(JSON.stringify(view.results), /changes requested|reviewDecision/i);
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.doesNotMatch(page, /changes requested|reviewDecision/i);
  assert.match(page, /if \(route\.tab === 'results'\) return \[resultsScreen\(project\), finishedList\(finished\)\]/);
  const none = stateCopy('results-empty');
  assert.deepEqual(view.noResults, { title: none.title, text: none.text }, 'the §7.1 empty copy, written once in copy.mjs');
  assert.match(page, /empty\(state\.owner\.noResults\.title, state\.owner\.noResults\.text\)/);
  assert.match(page, /results\.primary \? link\(`\$\{results\.primary\.label\} ↗`, results\.primary\.url, 'button'\) : null/);
});

test('a merged result never reads released, deployed or live; stale merge data never reads merged', (t) => {
  const releases = readReleaseAuthorizations(GOVERNANCE);
  const { dataDir, d, finish } = fixture(t, [task('T1', 'first'), task('T2', 'second')]);
  finish('T1', 'https://github.com/example-org/sampleapp/pull/463', { verified_sha: sha('T1') });
  finish('T2', 'https://github.com/example-org/sampleapp/pull/464', { verified_sha: sha('T2') });
  const supervisor = supervisorSnapshot(dataDir), now = Date.now(), mergedAt = now - 60 * 60_000;
  const steps = Object.fromEntries(Object.entries(results(d.campaignId, { T1: true, T2: true })).map(([key, value]) => [key, { ...value, mergedAt }]));
  const view = (options, repo = {}) => ownerView(supervisor, checked(steps, repo), { now, ...options }).results['example-org/sampleapp'];
  const merged = (options) => view(options).groups.find((group) => group.key === 'merged').rows;
  // The release line is the project's rule from the registry, else its own policy; it never says who acts.
  assert.deepEqual(merged({ releases }).map((row) => [row.word, row.mergedAt, row.release]), [
    ['Merged', mergedAt, 'Release follows SampleApp\'s standing deploy authorization.'], ['Merged', mergedAt, 'Release follows SampleApp\'s standing deploy authorization.']]);
  assert.deepEqual(merged({}).map((row) => row.release), ['Release follows SampleApp\'s release policy.', 'Release follows SampleApp\'s release policy.']);
  for (const options of [{ releases }, {}]) {
    const text = JSON.stringify(view(options).groups.map((group) => [group.title, ...group.rows.map((row) => [row.word, row.note, row.release, row.evidence, row.detail])]));
    assert.doesNotMatch(text, /releas(ed|ing)|deployed|\blive\b|accepted|\bdone\b/i, text);
  }
  // Old or never-fetched merge data: the merge is not claimed. A check that is due is not known yet, never merged.
  for (const repo of [{ fetchedAt: now - 20 * 60_000 }, { fetchedAt: null }]) {
    assert.deepEqual(view({ releases }, repo).groups.map((group) => [group.key, group.count]), [['unknown', 2]], JSON.stringify(repo));
  }
  // A failing fetch with an old last success: the merges are not seen, so both wait for the owner's review.
  const failing = view({ releases }, { fetchedAt: now - 20 * 60_000, error: 'fetch-failed' });
  assert.deepEqual(failing.groups.map((group) => [group.key, group.count]), [['review', 2]]);
  assert.deepEqual([failing.groups[0].rows[0].note, failing.groups[0].rows[0].asOf], ['The last check of the base branch failed; showing the last known state',
    { at: now - 20 * 60_000, reason: 'fetch-failed' }]);
  // The page writes a merged row as "Merged <date>. <release rule>", and has no released state.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /row\.group === 'merged' \? \[`Merged\$\{row\.mergedAt \? ` \$\{dateTime\(row\.mergedAt\)\}` : ''\}\.`, row\.release\]\.join\(' '\) : row\.word/);
  assert.doesNotMatch(page, /'Released'|Released ·|released: \[/);
});

test('Results say "Passed the check" for the checked commit, and keep the ready-to-merge conditions unchanged', (t) => {
  const { dataDir, d, finish } = fixture(t, [task('T1', 'first'), task('T2', 'second'), task('T3', 'pilot report', { deliverable: 'report' })]);
  finish('T1', 'https://github.com/example-org/sampleapp/pull/463', { verified_sha: 'a'.repeat(40) });
  finish('T2', 'https://github.com/example-org/sampleapp/pull/464');
  finish('T3', 'https://github.com/example-org/sampleapp/issues/440#issuecomment-1', { verified_sha: 'c'.repeat(40) });
  const supervisor = supervisorSnapshot(dataDir), now = Date.now();
  const steps = { [`${d.campaignId}/T1`]: { sha: 'a'.repeat(40), baseBranch: 'main', merged: false, mergedAt: null } };
  for (const repo of [{}, { fetchedAt: now - 20 * 60_000, error: 'fetch-failed' }, { configured: false, fetchedAt: null }]) {
    const rows = ownerView(supervisor, checked(steps, repo), { now }).results['example-org/sampleapp'].groups.flatMap((group) => group.rows);
    const row = (id) => rows.find((item) => item.taskId === id);
    assert.deepEqual([row('T1').evidence, row('T1').detail], ['Passed the check at commit aaaaaaa',
      'Passed the independent check at commit aaaaaaa. This dashboard does not read CI checks or conflicts; see them on the pull request.'], JSON.stringify(repo));
    // No verified commit: the check is not claimed.
    assert.deepEqual([row('T2').evidence, row('T2').detail], ['Independent check not recorded here',
      'The independent check is not recorded here. This dashboard does not read CI checks or conflicts; see them on the pull request.']);
    // A report has no pull request to point to.
    assert.deepEqual([row('T3').evidence, row('T3').detail], ['Passed the check at commit ccccccc', 'Passed the independent check at commit ccccccc.']);
    // "Accepted" stays free for recorded acceptance (#4); no readiness claim is made (the dashboard reads no CI or conflicts).
    const text = JSON.stringify(rows);
    assert.doesNotMatch(text, /accepted/i);
    assert.doesNotMatch(text, /Ready to merge|no conflicts|CI checks? passed/i);
    assert.ok(rows.every((item) => item.ready === undefined), 'there is no readiness field');
  }
  // The checker's verdict in a step's history uses the same words.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /const terminalLabels = \{ accepted: 'passed the check',/);
  assert.match(page, /disclosure\(`results\/\$\{row\.campaignId\}\/\$\{row\.taskId\}`, el\('span', \{ class: 'evidence' \}, row\.evidence\),/);
});
