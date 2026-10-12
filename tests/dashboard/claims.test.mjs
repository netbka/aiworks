// Owner-facing statements claim no more than the state supports (engineering-platform-archive#91 review): a posted report is for the owner to
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

/** Merge state as the local merge check reports it: netbka/Dyk fetched just now, and a result per campaign step. */
const checked = (steps = {}, repo = {}) => ({ repositories: [{ repository: 'netbka/Dyk', configured: true, fetchedAt: Date.now(), attemptedAt: Date.now(), error: null, ...repo }], steps });
/** One result per task id of the test campaign: true merged, false not reachable from the base branch. */
const results = (campaignId, merged) => Object.fromEntries(Object.entries(merged).map(([taskId, value]) => [`${campaignId}/${taskId}`,
  { sha: sha(taskId), baseBranch: 'main', merged: value, mergedAt: null }]));
const sha = (taskId) => taskId.replace(/\D/g, '').padStart(40, 'a');
/** Everything a "Needs you" item says, in reading order: subject, full evidence sentence, then its points. */
const whole = (item) => [`${item.text}.`, item.detail, ...item.points.map((point) => point.text)].filter(Boolean).join(' ');

test('a posted report is for the owner to read; a finished report campaign shows the supervisor’s next action', (t) => {
  const { dataDir, d, finish, close } = fixture(t, [task('T1', 'pilot report', { deliverable: 'report' }), task('T2', 'decision report', { deliverable: 'report' })]);
  finish('T1', 'https://github.com/netbka/Dyk/issues/438#issuecomment-1');
  finish('T2', 'https://github.com/netbka/Dyk/issues/439#issuecomment-2');
  const action = 'Planning reports published in netbka/Dyk; review recommendations before assigning implementation.';
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
  for (const [id, number] of [['T1', 463], ['T2', 464], ['T3', 465]]) finish(id, `https://github.com/netbka/Dyk/pull/${number}`, { verified_sha: sha(id) });
  close('Release gate: review campaign deliveries under netbka/Dyk\'s own merge and release policy.');
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
    'All steps are finished · the merged work is ready; release follows Dyk\'s release policy');
  // Stale merge data never reads as merged, so it never makes a campaign ready for release.
  const stale = finished(checked(results(d.campaignId, { T1: true, T2: true, T3: true }), { fetchedAt: Date.now() - 20 * 60_000 }));
  assert.equal(stale.releaseReady, false);
  assert.equal(stale.finished, 'All steps are finished · the merge of 3 steps is being checked; check again shortly');
  // The calm sentence needs every step merged or a report: here, a campaign with nothing delivered for the owner.
  const empty = { available: true, coordinator: null, recent: null, campaigns: [{ ...supervisor.campaigns[0], tasks: [], agents: [] }] };
  assert.equal(ownerView(empty, checked()).campaigns[d.campaignId].finished, 'All steps are finished · nothing waits for you');
});

test('a finished step with a missing or unrecognised result link is unknown, never published or settled', (t) => {
  for (const url of [null, 'https://github.com/netbka/Dyk/issues/437', 'https://github.com/netbka/Dyk/pull/5#issuecomment-1']) {
    const result = delivery({ id: 'T1', state: 'done', resultUrl: url, verifiedSha: sha('T1') }, checked(), Date.now(), 'c1');
    assert.deepEqual([result.state, result.reason, result.note], ['unknown', 'no-link', 'No result link was recorded; check the step issue'], String(url));
  }
  const { dataDir, d, finish, close } = fixture(t, [task('T1', 'first'), task('T2', 'second')]);
  finish('T1', 'https://github.com/netbka/Dyk/pull/463', { verified_sha: sha('T1') });
  finish('T2', 'https://github.com/netbka/Dyk/issues/439');
  close(null);
  const supervisor = supervisorSnapshot(dataDir);
  const view = ownerView(supervisor, checked(results(d.campaignId, { T1: true })));
  // A missing link never clears by itself, so it is not "checking": it is an item to check, never nothing.
  assert.equal(view.unknownResults, 0);
  assert.deepEqual(view.items.map((item) => [item.kind, item.action, item.text, item.link.label]), [['check', 'Check on GitHub', 'second', 'Open step issue (T2)']]);
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
  finish('T1', 'https://github.com/netbka/Dyk/pull/463', { verified_sha: 'a'.repeat(40) });
  const supervisor = supervisorSnapshot(dataDir), now = Date.now();
  const steps = { [`${d.campaignId}/T1`]: { sha: 'a'.repeat(40), baseBranch: 'main', merged: false, mergedAt: null } };
  const review = (repo = {}) => ownerView(supervisor, checked(steps, repo), { now }).items.find((entry) => entry.kind === 'review');
  const expected = /^first\. An independent checker accepted commit aaaaaaa\. This dashboard does not read CI checks or conflicts; see them on the pull request before merging\. Merging lets T2 build on it\.$/;
  // Fresh, old and failing merge data alike: no readiness claim is ever made.
  for (const repo of [{}, { fetchedAt: now - 20 * 60_000, error: 'fetch-failed' }, { fetchedAt: now - 60_000, error: 'fetch-failed' }, { configured: false, fetchedAt: null }]) {
    const item = review(repo);
    assert.doesNotMatch(whole(item), /Ready to merge|no conflicts|CI checks? passed/i, JSON.stringify(repo));
    assert.equal(item.ready, undefined, 'there is no readiness field');
  }
  assert.match(whole(review()), expected);
  assert.deepEqual([review().evidence, review().detail], ['Checker accepted aaaaaaa · CI and conflicts on the PR',
    'An independent checker accepted commit aaaaaaa. This dashboard does not read CI checks or conflicts; see them on the pull request before merging.']);
  // The page has no readiness styling or wording left.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.doesNotMatch(page, /Ready to merge|item\.ready|statusCheckRollup|mergeable/);
});

test('restart advice waits a few minutes after the controller lease lapses', () => {
  const now = Date.now();
  const campaign = (lapsedMs, agents = []) => ({ id: 'c1', repository: 'netbka/Dyk', trackingIssue: 443, trackingUrl: 'https://github.com/netbka/Dyk/issues/443', purpose: null,
    control: 'registered', readiness: 'CONTROLLER_OFFLINE', controllerLive: false, livenessDefect: false, leaseExpiresAt: new Date(now - lapsedMs).toISOString(), blocker: null, tasks: [], agents });
  const view = (c) => ownerView({ available: true, campaigns: [c], coordinator: null, recent: null }, [], { host: 'HomePc', now });
  const working = [{ heartbeatState: 'unknown', progress: { lastActivityAt: now - 30_000 } }];
  for (const c of [campaign(2 * 60_000), campaign(2 * 60_000, working)]) {
    const late = view(c);
    assert.equal(late.campaigns.c1.liveness, 'late');
    assert.equal(late.campaigns.c1.lastCheckIn, now - 2 * 60_000);
    assert.deepEqual(late.items, [], 'an upgrade or restart in progress is not an owner action yet');
  }
  const stopped = view(campaign(10 * 60_000));
  assert.equal(stopped.campaigns.c1.liveness, 'stopped');
  assert.match(stopped.items[0].points[0].text, /restart it there/);
});

test('a campaign no supervisor has picked up yet gets the same grace from its registration', (t) => {
  const registered = Date.now() - 2 * 60_000;
  const { dataDir, d } = fixture(t, [task('T1', 'first')], registered);
  const supervisor = supervisorSnapshot(dataDir);
  assert.equal(supervisor.campaigns[0].readiness, 'BOOTSTRAP_REQUIRED');
  assert.equal(supervisor.campaigns[0].registeredAt, registered, 'the snapshot carries the registration time');
  const view = (now) => ownerView(supervisor, [], { host: 'HomePc', now });
  const fresh = view(registered + 2 * 60_000);
  assert.equal(fresh.campaigns[d.campaignId].liveness, 'awaiting-pickup');
  assert.equal(fresh.campaigns[d.campaignId].registeredAt, registered);
  assert.deepEqual(fresh.items, [], 'just registered: no restart advice yet');
  const late = view(registered + 6 * 60_000);
  assert.equal(late.campaigns[d.campaignId].liveness, 'stopped');
  assert.equal(late.items[0].text, `The supervisor on HomePc has not started ${d.campaignId} yet`);
  assert.match(late.items[0].points[0].text, /no supervisor has picked it up\. If nobody is upgrading it right now, restart it there/);
  // A campaign that had a lease uses the lease, not its registration.
  const lapsed = { ...supervisor, campaigns: supervisor.campaigns.map((c) => ({ ...c, readiness: 'CONTROLLER_OFFLINE', leaseExpiresAt: new Date(registered - 60 * 60_000).toISOString() })) };
  assert.equal(ownerView(lapsed, [], { now: registered + 60_000 }).campaigns[d.campaignId].liveness, 'stopped');
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /'awaiting-pickup': 'Waiting for the supervisor'/);
});

test('"Merging lets X build on it" names only steps that have not started; a started step keeps its base', (t) => {
  const { dataDir, store, d, finish } = fixture(t, [task('T1', 'first'), task('T2', 'second', { dependsOn: ['T1'] }), task('T3', 'third', { dependsOn: ['T1'] })]);
  finish('T1', 'https://github.com/netbka/Dyk/pull/463', { verified_sha: 'a'.repeat(40) });
  const start = (taskId, changes) => {
    const row = store.task(d.campaignId, taskId);
    store.patch('tasks', { campaign_id: d.campaignId, task_id: taskId }, row.version, changes, Date.now());
  };
  const merges = checked({ [`${d.campaignId}/T1`]: { sha: 'a'.repeat(40), baseBranch: 'main', merged: false, mergedAt: null } });
  const say = () => ownerView(supervisorSnapshot(dataDir), merges).items.find((item) => item.kind === 'review').points[0].text;
  assert.match(say(), /Merging lets T2 and T3 build on it\.$/, 'neither has started');
  start('T3', { state: 'implementing', attempts: 1 });
  assert.match(say(), /Merging lets T2 build on it\.$/, 'a running dependent already has its base');
  // A step back in "pending" after a failed attempt keeps the worktree, and so the base, it started with.
  start('T2', { attempts: 1, retry_at: Date.now() + 60_000, last_error: 'timeout: synthetic' });
  assert.match(say(), /T2 and T3 already started without it, so merging now does not change those steps\.$/);
  assert.doesNotMatch(say(), /build on it|releasing it is your next step/, 'started dependents are not unblocked, and the campaign is not ready for release');
});

test('the calm heading is about what blocks on the owner; reports to read and releases are named apart', (t) => {
  const { dataDir, d, finish, close } = fixture(t, [task('T1', 'pilot report', { deliverable: 'report' }), task('T2', 'second'), task('T3', 'third')]);
  finish('T1', 'https://github.com/netbka/Dyk/issues/438#issuecomment-1');
  finish('T2', 'https://github.com/netbka/Dyk/pull/464', { verified_sha: sha('T2') });
  finish('T3', 'https://github.com/netbka/Dyk/pull/465', { verified_sha: sha('T3') });
  close('Release gate: review campaign deliveries under netbka/Dyk\'s own merge and release policy.');
  const supervisor = supervisorSnapshot(dataDir);
  const view = ownerView(supervisor, checked(results(d.campaignId, { T2: true, T3: true })));
  assert.deepEqual(view.items, []);
  assert.equal(view.headline, 'Nothing is blocked on you right now');
  // Reports are for the owner; who releases the merged work is the project's rule, not assumed to be the owner.
  assert.deepEqual(view.also, { reports: 1, release: [{ campaignId: d.campaignId, repository: 'netbka/Dyk' }],
    text: 'Also: 1 report for you to read · merged work in Dyk is ready; release follows its release policy', short: '1 report for you to read · merged work ready for release' });
  assert.equal(view.campaigns[d.campaignId].finished, 'All steps are finished · 1 report posted for you to read · the merged work is ready; release follows Dyk\'s release policy');
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
  finish('T1', 'https://github.com/netbka/Dyk/pull/463', { verified_sha: sha('T1') });
  finish('T2', 'https://github.com/netbka/Dyk/pull/464', { verified_sha: sha('T2') });
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
  assert.deepEqual(mergeCheck(merges({ fetchedAt: null }), 'netbka/Dyk', now), { fresh: false, at: null, reason: 'not-checked' }, 'never fetched is not current');
  assert.deepEqual(mergeCheck(merges({ configured: false }), 'netbka/dyk', now), { fresh: false, at: null, reason: 'no-checkout' });
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
  const view = ownerView(supervisor, [], { host: 'HomePc' });
  assert.deepEqual(view.items, [], 'who paused is not recorded, so a pause with a running supervisor is not an owner action');
  assert.equal(view.headline, 'Nothing is blocked on you right now');
  assert.equal(view.campaigns[d.campaignId].liveness, 'running');
  assert.deepEqual(view.layout.cards, [d.campaignId], 'the paused campaign keeps its card, where the pause is shown');
  assert.equal(supervisor.campaigns[0].pausedReason, 'runtime upgrade window to a9e2402', 'the reason is shown as given');
  // The card reads neutral and consistent: "Supervisor running · campaign paused", with the reason as plain text.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /if \(c\.control === 'paused'\) return badge\(\['running', 'late', 'awaiting-pickup'\]\.includes\(liveness\) \? 'unknown' : 'stale', `\$\{livenessNames\[liveness\] \?\? 'Supervisor state unknown'\} · campaign paused`\);/);
  assert.match(page, /reason given: “\$\{c\.pausedReason\}”/);
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
  const stopped = ownerView(paused(new Date(now - 10 * 60_000).toISOString()), [], { host: 'HomePc', now });
  assert.equal(stopped.campaigns[d.campaignId].liveness, 'stopped');
  assert.deepEqual(stopped.items.map((item) => [item.kind, item.text, item.at]), [['controller', `The supervisor on HomePc stopped while ${d.campaignId} was paused`, now - 10 * 60_000]]);
  assert.match(stopped.items[0].points[0].text, /^No work starts while it is paused, and none can resume until a supervisor runs again\. If nobody is upgrading it right now, restart it there/);
  assert.equal(stopped.headline, 'Needs you (1)', 'never "nothing is blocked" while the supervisor is down');
  // Within the grace period it is a restart in progress: late, not yet listed.
  const late = ownerView(paused(new Date(now - 2 * 60_000).toISOString()), [], { host: 'HomePc', now });
  assert.deepEqual([late.campaigns[d.campaignId].liveness, late.items], ['late', []]);
  // Paused before any supervisor picked it up, registered an hour ago: not started, with the restart action.
  const never = ownerView(paused(null), [], { host: 'HomePc', now });
  assert.deepEqual(never.items.map((item) => item.text), [`The supervisor on HomePc has not started ${d.campaignId} yet (it is paused)`]);
  assert.match(never.items[0].points[0].text, /^It is registered and paused, but no supervisor has picked it up\. If nobody is upgrading it right now, restart it there/);
  // The card is not calm either: the chip uses the warning tone and the banner names the stopped supervisor.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /` · the supervisor on \$\{host\} is not running\$\{owner\.lastCheckIn \?/);
});

test('each "Needs you" item leads with what its step delivers, with the evidence in one line', (t) => {
  const { dataDir, d, finish } = fixture(t, [task('T1', 'ingest', { outcome: 'Telegram ingestion: analysed messages are not sent again' }),
    task('T2', 'pairing', { outcome: 'WhatsApp pairing recovers an interrupted result' })]);
  finish('T1', 'https://github.com/netbka/Dyk/pull/463', { verified_sha: 'a'.repeat(40) });
  finish('T2', 'https://github.com/netbka/Dyk/pull/464', { verified_sha: 'b'.repeat(40) });
  const view = ownerView(supervisorSnapshot(dataDir), checked({ [`${d.campaignId}/T1`]: { sha: 'a'.repeat(40), baseBranch: 'main', merged: false, mergedAt: null },
    [`${d.campaignId}/T2`]: { sha: 'b'.repeat(40), baseBranch: 'main', merged: false, mergedAt: null } }));
  assert.equal(view.headline, 'Needs you (2)', 'one item per pull request');
  assert.deepEqual(view.items.map((item) => [item.action, item.text, item.link]), [
    ['Review and merge', 'Telegram ingestion: analysed messages are not sent again', { label: 'Open PR #463', url: 'https://github.com/netbka/Dyk/pull/463' }],
    ['Review and merge', 'WhatsApp pairing recovers an interrupted result', { label: 'Open PR #464', url: 'https://github.com/netbka/Dyk/pull/464' }]]);
  for (const item of view.items) {
    assert.ok(item.evidence.length <= 60, `compact evidence: ${item.evidence}`);
    assert.match(item.detail, /^An independent checker accepted commit [ab]{7}\. This dashboard does not read CI checks or conflicts; see them on the pull request before merging\.$/);
    assert.ok(item.points.every((point) => !point.text.includes(item.detail)), 'the full evidence sentence is not repeated in the body');
  }
  // The page shows the evidence line as a disclosure whose body is the full sentence.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /item\.evidence \? disclosure\(`needs\/\$\{item\.link\?\.url \?\? item\.text\}`, el\('span', \{ class: 'evidence' \}, item\.evidence\),\s*el\('p', \{ class: 'needs-detail' \}, item\.detail\)\)/);
  assert.match(page, /item\.action \? el\('div', \{ class: 'needs-action' \}, item\.action\)/);
});

test('release wording follows the project registry: a recorded standing authorization, else the project’s own policy', (t) => {
  const releases = readReleaseAuthorizations(GOVERNANCE);
  assert.deepEqual(releases['netbka/dyk'], { source: 'deploy/AGENTS.md', approval: 'https://github.com/netbka/engineering-platform-archive/issues/82' });
  assert.equal(releases['netbka/local-commander-mcp'], undefined, 'a recorded gap is not an accepted authorization');
  const { dataDir, d, finish, close } = fixture(t, [task('T1', 'first'), task('T2', 'second')]);
  finish('T1', 'https://github.com/netbka/Dyk/pull/463', { verified_sha: sha('T1') });
  finish('T2', 'https://github.com/netbka/Dyk/pull/464', { verified_sha: sha('T2') });
  close('Release gate: review campaign deliveries under netbka/Dyk\'s own merge and release policy.');
  const supervisor = supervisorSnapshot(dataDir);
  const oneOpen = checked(results(d.campaignId, { T1: false, T2: true }));
  const open = (options) => ownerView(supervisor, oneOpen, options).items[0].points.at(-1).text;
  assert.equal(open({ releases }), 'Nothing else in this campaign waits on it; after merging, release follows Dyk\'s standing deploy authorization.');
  assert.equal(open({}), 'Nothing else in this campaign waits on it; after merging, release follows Dyk\'s release policy.', 'nothing recorded: no one is named');
  const merged = ownerView(supervisor, checked(results(d.campaignId, { T1: true, T2: true })), { releases });
  assert.equal(merged.campaigns[d.campaignId].finished, 'All steps are finished · the merged work is ready; release follows Dyk\'s standing deploy authorization');
  assert.equal(merged.also.text, 'Also: merged work in Dyk is ready; release follows its standing deploy authorization');
  for (const view of [merged, ownerView(supervisor, oneOpen, { releases })]) {
    assert.doesNotMatch(JSON.stringify(view), /your release|releasing it is your next step/i, 'the owner is never assumed to release');
  }
  assert.doesNotMatch(readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8'), /your release/i);
});
