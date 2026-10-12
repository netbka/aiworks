// Owner-facing statements claim no more than the state supports (engineering-platform-archive#91 review): a posted report is for the owner to
// read, a finished campaign is calm only when every step's GitHub state is known and settled, and "ready to merge"
// needs GitHub to confirm the accepted commit, no conflicts and passing CI. Disposable stores and a synthetic gh only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart, campaignPause } from '../../src/supervisor/api.mjs';
import { declaration } from '../supervisor/helpers.mjs';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { ownerView, delivery, githubStale } from '../../src/dashboard/owner.mjs';
import { RoadmapSource, readReleaseAuthorizations } from '../../src/dashboard/roadmap.mjs';

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

const source = (items, extra = {}) => ({ repository: 'netbka/Dyk', fetchedAt: new Date().toISOString(), error: null, items, ...extra });
/** Everything a "Needs you" item says, in reading order: subject, full evidence sentence, then its points. */
const whole = (item) => [`${item.text}.`, item.detail, ...item.points.map((point) => point.text)].filter(Boolean).join(' ');
const pr = (number, state, extra = {}) => ({ kind: 'pr', number, state, url: `https://github.com/netbka/Dyk/pull/${number}`, mergedAt: state === 'MERGED' ? '2026-10-10T08:49:00Z' : null, ...extra });

test('a posted report is for the owner to read; a finished report campaign shows the supervisor’s next action', (t) => {
  const { dataDir, d, finish, close } = fixture(t, [task('T1', 'pilot report', { deliverable: 'report' }), task('T2', 'decision report', { deliverable: 'report' })]);
  finish('T1', 'https://github.com/netbka/Dyk/issues/438#issuecomment-1');
  finish('T2', 'https://github.com/netbka/Dyk/issues/439#issuecomment-2');
  const action = 'Planning reports published in netbka/Dyk; review recommendations before assigning implementation.';
  close(action);
  const supervisor = supervisorSnapshot(dataDir);
  assert.equal(supervisor.campaigns[0].nextAction, action, 'the controller’s own sentence for a finished reports campaign reaches the owner');
  const view = ownerView(supervisor, [source([])]);
  const owner = view.campaigns[d.campaignId];
  assert.equal(owner.deliveries.T1.state, 'report-posted');
  assert.equal(owner.deliveries.T1.note, 'For you to read and decide on');
  assert.equal(owner.finished, `All steps are finished · ${action}`);
  assert.equal(owner.counts.reports, 2);
  // Any other stored next action can quote worker text: it is not passed through, and the count says what waits.
  close('T1: worker text; run recheck after recovery');
  const generic = ownerView(supervisorSnapshot(dataDir), [source([])]);
  assert.equal(generic.campaigns[d.campaignId].finished, 'All steps are finished · 2 reports posted for you to read');
  assert.ok(!JSON.stringify(generic).includes('worker text'));
  // The page takes these sentences from the owner view instead of claiming nothing waits.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.doesNotMatch(page, /Nothing for you to do/i);
  assert.doesNotMatch(page, /nothing waits for you/i);
});

test('a finished campaign says "nothing waits for you" only when every step’s GitHub state is known and settled', (t) => {
  const { dataDir, d, finish, close } = fixture(t, [task('T1', 'first'), task('T2', 'second'), task('T3', 'third')]);
  finish('T1', 'https://github.com/netbka/Dyk/pull/463');
  finish('T2', 'https://github.com/netbka/Dyk/pull/464');
  finish('T3', 'https://github.com/netbka/Dyk/pull/465');
  close('Release gate: review campaign deliveries under netbka/Dyk\'s own merge and release policy.');
  const supervisor = supervisorSnapshot(dataDir);
  const finished = (sources) => ownerView(supervisor, sources).campaigns[d.campaignId];
  // Before the first GitHub fetch.
  const first = finished([]);
  assert.equal(first.finished, 'All steps are finished · GitHub state of 3 steps not loaded yet; check again shortly');
  assert.equal(first.deliveries.T1.note, 'Not loaded from GitHub yet; check again shortly');
  // gh fails and there is no cache.
  assert.equal(finished([source([], { fetchedAt: null, error: 'GitHub refresh failed.' })]).finished,
    'All steps are finished · GitHub could not be read, so the state of 3 steps is unknown; check them on GitHub');
  // A pull request missing from the fetched list.
  assert.equal(finished([source([pr(463, 'MERGED'), pr(464, 'MERGED')])]).finished,
    'All steps are finished · the GitHub state of 1 step is not known; check it on GitHub · 2 merged');
  assert.equal(finished([source([pr(463, 'MERGED'), pr(464, 'MERGED'), pr(465, 'CLOSED')])]).finished,
    'All steps are finished · 1 pull request was closed without merging · 2 merged');
  assert.equal(finished([source([pr(463, 'MERGED'), pr(464, 'OPEN'), pr(465, 'OPEN')])]).finished,
    'All steps are finished · 2 steps wait for your review · 1 merged');
  assert.equal(finished([source([pr(463, 'MERGED'), pr(464, 'MERGED'), pr(465, 'MERGED')])]).finished,
    'All steps are finished · the merged work is ready; release follows Dyk\'s release policy');
  // The calm sentence needs every step known and settled: here, a campaign with nothing delivered for the owner.
  const empty = { available: true, coordinator: null, recent: null, campaigns: [{ ...supervisor.campaigns[0], tasks: [], agents: [] }] };
  assert.equal(ownerView(empty, []).campaigns[d.campaignId].finished, 'All steps are finished · nothing waits for you');
});

test('a finished step with a missing or unrecognised result link is unknown, never published or settled', (t) => {
  const sources = [source([pr(463, 'MERGED')])];
  for (const url of [null, 'https://github.com/netbka/Dyk/issues/437', 'https://github.com/netbka/Dyk/pull/5#issuecomment-1']) {
    const result = delivery({ id: 'T1', state: 'done', resultUrl: url }, sources);
    assert.deepEqual([result.state, result.reason, result.note], ['unknown', 'no-link', 'No result link was recorded; check the step issue'], String(url));
  }
  const { dataDir, d, finish, close } = fixture(t, [task('T1', 'first'), task('T2', 'second')]);
  finish('T1', 'https://github.com/netbka/Dyk/pull/463');
  finish('T2', 'https://github.com/netbka/Dyk/issues/439');
  close(null);
  const supervisor = supervisorSnapshot(dataDir);
  const view = ownerView(supervisor, sources);
  // A missing link never clears by itself, so it is not "checking GitHub": it is an item to check, never nothing.
  assert.equal(view.unknownResults, 0);
  assert.deepEqual(view.items.map((item) => [item.kind, item.action, item.text, item.link.label]), [['check', 'Check on GitHub', 'second', 'Open step issue (T2)']]);
  assert.equal(view.items[0].points[0].text, 'This step finished, but no result link was recorded, so the dashboard cannot tell where it stands.');
  assert.equal(view.headline, 'Needs you (1)');
  assert.equal(view.campaigns[d.campaignId].finished, 'All steps are finished · 1 step has no recorded result link; check its issue · 1 merged');
  // A pull request missing from the data GitHub returned is the same: a check item with both links, not "checking".
  const missing = ownerView(supervisor, [source([pr(1, 'OPEN')])]);
  assert.deepEqual(missing.items.map((item) => [item.kind, item.text, item.points[0].link?.label ?? null]), [['check', 'first', 'PR #463'], ['check', 'second', null]]);
  assert.equal(missing.items[0].points[0].text, 'This step finished, but its pull request is not in the GitHub data the dashboard has, so where it stands is unknown.');
  // Only state a refresh can still bring keeps the heading at "checking": before the first fetch, or while GitHub fails.
  for (const sourcesNow of [[], [source([], { fetchedAt: null, error: 'GitHub refresh failed.' })]]) {
    const checking = ownerView(supervisor, sourcesNow);
    assert.equal(checking.unknownResults, 1);
    assert.deepEqual(checking.items.map((item) => item.text), ['second']);
    assert.equal(checking.headline, 'Needs you (1)');
  }
  const onlyTransient = ownerView({ ...supervisor, campaigns: [{ ...supervisor.campaigns[0], tasks: supervisor.campaigns[0].tasks.filter((item) => item.id === 'T1') }] }, []);
  assert.deepEqual([onlyTransient.unknownResults, onlyTransient.items, onlyTransient.headline], [1, [], 'Checking GitHub for anything that needs you']);
});

test('"Ready to merge" needs fresh GitHub data: the accepted commit is the head, no conflicts and every CI check passed', (t) => {
  const { dataDir, finish } = fixture(t, [task('T1', 'first'), task('T2', 'second', { dependsOn: ['T1'] })]);
  finish('T1', 'https://github.com/netbka/Dyk/pull/463', { verified_sha: 'a'.repeat(40) });
  const supervisor = supervisorSnapshot(dataDir), now = Date.now();
  const checks = (passed, failed = 0, pending = 0) => ({ total: passed + failed + pending, passed, failed, pending });
  const good = { head: 'a'.repeat(40), mergeable: 'MERGEABLE', checks: checks(2) };
  const review = (merge, { item = {}, from = {} } = {}) =>
    ownerView(supervisor, [source([pr(463, 'OPEN', { merge, ...item })], from)], { now }).items.find((entry) => entry.kind === 'review');
  const say = (merge, options) => whole(review(merge, options));
  const cautious = /^first\. An independent checker accepted commit aaaaaaa; check conflicts and CI on GitHub before merging\./;
  assert.match(say(undefined), cautious, 'an accepted commit alone is not "ready to merge"');
  assert.doesNotMatch(say(undefined), /Ready to merge/);
  assert.match(say(good), /^first\. Ready to merge: an independent checker accepted commit aaaaaaa, it is still the pull request's head, GitHub reports no conflicts and all 2 CI checks passed\. Merging lets T2 build on it\.$/);
  assert.match(say({ ...good, head: 'b'.repeat(40) }), /accepted commit aaaaaaa, but the pull request now points at commit bbbbbbb; check what changed before merging\./);
  assert.match(say({ ...good, mergeable: 'CONFLICTING' }), /GitHub reports conflicts with the base branch; they must be resolved before merging\./);
  assert.match(say({ ...good, mergeable: 'UNKNOWN' }), /GitHub has not finished checking it for conflicts, so check conflicts and CI on GitHub before merging\./);
  assert.match(say({ ...good, checks: checks(1, 1) }), /no conflicts, but 1 CI check failed; check it on GitHub before merging\./);
  assert.match(say({ ...good, checks: checks(1, 0, 1) }), /no conflicts, but 1 CI check has not passed yet; check again before merging\./);
  assert.match(say({ ...good, checks: checks(0) }), /no conflicts; no CI checks ran on it, so nothing else has tested it\./);
  assert.match(say(good, { item: { draft: true } }), /the pull request is still a draft/);
  assert.match(say(good, { from: { error: 'GitHub refresh failed.' } }), cautious, 'a failing refresh shows last known data, never "ready"');
  assert.match(say(good, { from: { fetchedAt: new Date(now - 10 * 60_000).toISOString() } }), cautious, 'a cache read at startup is not fresh');
  for (const merge of [undefined, { ...good, head: 'b'.repeat(40) }, { ...good, checks: checks(0) }]) assert.doesNotMatch(say(merge), /Ready to merge/);
  // The same evidence in one compact line; the full sentence above stays one click away.
  assert.deepEqual([review(good).evidence, review(good).ready], ['Ready to merge · checker accepted the head · no conflicts · all 2 CI checks passed', true]);
  assert.deepEqual([review(undefined).evidence, review(undefined).ready], ['Checker accepted aaaaaaa · conflicts and CI not confirmed', false]);
  assert.equal(review({ ...good, head: 'b'.repeat(40) }).evidence, 'Checker accepted aaaaaaa · the pull request now points at bbbbbbb');
  assert.equal(review({ ...good, checks: checks(1, 1) }).evidence, 'Checker accepted the head · no conflicts · 1 CI check failed');
  assert.equal(review({ ...good, checks: checks(0) }).evidence, 'Checker accepted the head · no conflicts · no CI checks ran');
});

test('merge readiness is fetched read-only for open pull requests, kept as counts, and a failure leaves it unknown', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-claims-gh-'));
  const previous = process.env.AIWORKS_FAKE_GH_MODE;
  t.after(() => { if (previous === undefined) delete process.env.AIWORKS_FAKE_GH_MODE; else process.env.AIWORKS_FAKE_GH_MODE = previous; rmSync(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'fake-gh.mjs'), calls = join(dir, 'calls.jsonl');
  writeFileSync(fake, `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2), state = args[args.indexOf('--state') + 1];
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const pr = (number, state) => ({ number, title: 'step', state, url: '', isDraft: false, labels: [], assignees: [], updatedAt: '2026-10-10', closedAt: null, mergedAt: null, closingIssuesReferences: [] });
if (args[0] === 'issue') process.stdout.write('[]');
else if (state === 'all') process.stdout.write(JSON.stringify([pr(463, 'OPEN'), pr(462, 'MERGED')]));
else if (process.env.AIWORKS_FAKE_GH_MODE === 'fail') process.exit(1);
else process.stdout.write(JSON.stringify([{ number: 463, headRefOid: '${'a'.repeat(40)}', mergeable: 'MERGEABLE', statusCheckRollup: [
  { __typename: 'CheckRun', name: 'secret-check-name', detailsUrl: 'https://example.invalid/run', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
  { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' }] }]));
`);
  const roadmap = new RoadmapSource({ root: GOVERNANCE, cacheDir: dir, gh: [process.execPath, fake] });
  await roadmap.fetch();
  const dyk = roadmap.sources.find((item) => item.repository === 'netbka/Dyk');
  assert.equal(dyk.error, null);
  assert.deepEqual(dyk.items.find((item) => item.number === 463).merge,
    { head: 'a'.repeat(40), mergeable: 'MERGEABLE', checks: { total: 3, passed: 1, failed: 1, pending: 1 } });
  assert.equal(dyk.items.find((item) => item.number === 462).merge, undefined, 'only open pull requests carry readiness');
  assert.ok(!JSON.stringify(roadmap.sources).includes('secret-check-name') && !JSON.stringify(roadmap.sources).includes('example.invalid'), 'check names and links are not kept');
  const commands = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(commands.every((args) => ['issue', 'pr'].includes(args[0]) && args[1] === 'list'), 'read-only: list commands only');
  assert.ok(commands.some((args) => args.includes('open') && args.at(-1) === 'number,headRefOid,mergeable,statusCheckRollup'));
  process.env.AIWORKS_FAKE_GH_MODE = 'fail';
  await roadmap.fetch();
  const failed = roadmap.sources.find((item) => item.repository === 'netbka/Dyk');
  assert.equal(failed.error, null, 'a readiness failure never fails the repository metadata');
  assert.equal(failed.items.find((item) => item.number === 463).merge, undefined, 'readiness stays unknown');
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
  const say = () => ownerView(supervisorSnapshot(dataDir), [source([pr(463, 'OPEN')])]).items.find((item) => item.kind === 'review').points[0].text;
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
  finish('T2', 'https://github.com/netbka/Dyk/pull/464');
  finish('T3', 'https://github.com/netbka/Dyk/pull/465');
  close('Release gate: review campaign deliveries under netbka/Dyk\'s own merge and release policy.');
  const supervisor = supervisorSnapshot(dataDir);
  const view = ownerView(supervisor, [source([pr(464, 'MERGED'), pr(465, 'MERGED')])]);
  assert.deepEqual(view.items, []);
  assert.equal(view.headline, 'Nothing is blocked on you right now');
  // Reports are for the owner; who releases the merged work is the project's rule, not assumed to be the owner.
  assert.deepEqual(view.also, { reports: 1, release: [{ campaignId: d.campaignId, repository: 'netbka/Dyk' }],
    text: 'Also: 1 report for you to read · merged work in Dyk is ready; release follows its release policy', short: '1 report for you to read · merged work ready for release' });
  assert.equal(view.campaigns[d.campaignId].finished, 'All steps are finished · 1 report posted for you to read · the merged work is ready; release follows Dyk\'s release policy');
  // Not ready for release while a pull request is open; it is then a "Needs you" item, and the heading counts it.
  const open = ownerView(supervisor, [source([pr(464, 'MERGED'), pr(465, 'OPEN')])]);
  assert.equal(open.headline, 'Needs you (1)');
  assert.deepEqual(open.also, { reports: 1, release: [], text: 'Also: 1 report for you to read', short: '1 report for you to read' });
  assert.equal(ownerView(supervisor, []).headline, 'Checking GitHub for anything that needs you', 'unknown GitHub state is never calm');
  const nothing = ownerView({ ...supervisor, campaigns: [] }, []);
  assert.deepEqual([nothing.headline, nothing.also], ['Nothing is blocked on you right now', null]);
  // The page shows the owner view's heading and "Also for you" line; its calm text is scoped to what blocks on the owner.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.doesNotMatch(page, /Nothing needs you|Nothing is waiting for you/);
  assert.match(page, /el\('h2', \{ id: 'needs-title' \}, headline\)/);
  assert.match(page, /also \? el\('p', \{ class: 'needs-also' \}, also\.text\)/);
  assert.match(page, /'Nothing is blocked on you'/);
});

test('"Needs you" items from a startup cache or old GitHub data say when the data is from, and are never "ready"', (t) => {
  const { dataDir, finish } = fixture(t, [task('T1', 'first'), task('T2', 'second')]);
  finish('T1', 'https://github.com/netbka/Dyk/pull/463', { verified_sha: 'a'.repeat(40) });
  finish('T2', 'https://github.com/netbka/Dyk/pull/464');
  const supervisor = supervisorSnapshot(dataDir), now = Date.now();
  const good = { head: 'a'.repeat(40), mergeable: 'MERGEABLE', checks: { total: 1, passed: 1, failed: 0, pending: 0 } };
  const items = (from) => ownerView(supervisor, [source([pr(463, 'OPEN', { merge: good }), pr(464, 'CLOSED')], from)], { now }).items;
  const at = now - 30_000;
  for (const [from, reason] of [[{ fetchedAt: new Date(at).toISOString(), cached: true }, 'startup-cache'],
    [{ fetchedAt: new Date(now - 10 * 60_000).toISOString() }, 'old'], [{ fetchedAt: new Date(at).toISOString(), error: 'GitHub refresh failed.' }, 'refresh-failed']]) {
    const stale = items(from);
    const when = Date.parse(from.fetchedAt);
    assert.doesNotMatch(whole(stale[0]), /Ready to merge/, `${reason}: never "ready", even when the cache is minutes old`);
    assert.match(stale[0].detail, /check conflicts and CI on GitHub before merging/);
    assert.deepEqual(stale.map((item) => [item.kind, item.github]), [['review', { at: when, reason }], ['closed', { at: when, reason }]], reason);
  }
  // Data from a successful fetch under 5 minutes old is fresh: no note, and readiness can be confirmed.
  const fresh = items({ fetchedAt: new Date(at).toISOString() });
  assert.match(fresh[0].detail, /Ready to merge/);
  assert.deepEqual(fresh.map((item) => [item.kind, item.github]), [['review', null], ['closed', null]]);
  assert.equal(githubStale({ repository: 'netbka/Dyk', fetchedAt: null, error: 'failed' }, now), null, 'never fetched is unknown, not stale');
  // The cache read at startup is marked until the first successful fetch.
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-claims-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'roadmap-cache.json'), JSON.stringify({ version: 1, sources: [source([pr(463, 'OPEN', { merge: good })], { fetchedAt: new Date(at).toISOString() })] }));
  const roadmap = new RoadmapSource({ root: GOVERNANCE, cacheDir: dir });
  const cached = roadmap.sources.find((item) => item.repository === 'netbka/Dyk');
  assert.equal(cached.cached, true);
  assert.deepEqual(githubStale(cached, now), { at, reason: 'startup-cache' });
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /`GitHub data from \$\{/);
  assert.match(page, /'the last refresh failed, retrying' : 'refreshing'/);
  assert.match(page, /item\.github \? el\('div', \{ class: 'needs-stale' \}, githubAsOf\(item\.github\)\)/);
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
  const { dataDir, finish } = fixture(t, [task('T1', 'ingest', { outcome: 'Telegram ingestion: analysed messages are not sent again' }),
    task('T2', 'pairing', { outcome: 'WhatsApp pairing recovers an interrupted result' })]);
  finish('T1', 'https://github.com/netbka/Dyk/pull/463', { verified_sha: 'a'.repeat(40) });
  finish('T2', 'https://github.com/netbka/Dyk/pull/464', { verified_sha: 'b'.repeat(40) });
  const view = ownerView(supervisorSnapshot(dataDir), [source([pr(463, 'OPEN'), pr(464, 'OPEN')])]);
  assert.equal(view.headline, 'Needs you (2)', 'one item per pull request');
  assert.deepEqual(view.items.map((item) => [item.action, item.text, item.link]), [
    ['Review and merge', 'Telegram ingestion: analysed messages are not sent again', { label: 'Open PR #463', url: 'https://github.com/netbka/Dyk/pull/463' }],
    ['Review and merge', 'WhatsApp pairing recovers an interrupted result', { label: 'Open PR #464', url: 'https://github.com/netbka/Dyk/pull/464' }]]);
  for (const item of view.items) {
    assert.ok(item.evidence.length <= 60, `compact evidence: ${item.evidence}`);
    assert.match(item.detail, /^An independent checker accepted commit [ab]{7}; check conflicts and CI on GitHub before merging\.$/);
    assert.ok(item.points.every((point) => !point.text.includes(item.detail)), 'the full evidence sentence is not repeated in the body');
  }
  // The page shows the evidence line as a disclosure whose body is the full sentence.
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.match(page, /item\.evidence \? disclosure\(`needs\/\$\{item\.link\?\.url \?\? item\.text\}`, el\('span', \{ class: item\.ready \? 'evidence ready' : 'evidence' \}, item\.evidence\),\s*el\('p', \{ class: 'needs-detail' \}, item\.detail\)\)/);
  assert.match(page, /item\.action \? el\('div', \{ class: 'needs-action' \}, item\.action\)/);
});

test('release wording follows the project registry: a recorded standing authorization, else the project’s own policy', (t) => {
  const releases = readReleaseAuthorizations(GOVERNANCE);
  assert.deepEqual(releases['netbka/dyk'], { source: 'deploy/AGENTS.md', approval: 'https://github.com/netbka/engineering-platform-archive/issues/82' });
  assert.equal(releases['netbka/local-commander-mcp'], undefined, 'a recorded gap is not an accepted authorization');
  const { dataDir, d, finish, close } = fixture(t, [task('T1', 'first'), task('T2', 'second')]);
  finish('T1', 'https://github.com/netbka/Dyk/pull/463');
  finish('T2', 'https://github.com/netbka/Dyk/pull/464');
  close('Release gate: review campaign deliveries under netbka/Dyk\'s own merge and release policy.');
  const supervisor = supervisorSnapshot(dataDir);
  const open = (options) => ownerView(supervisor, [source([pr(463, 'OPEN'), pr(464, 'MERGED')])], options).items[0].points.at(-1).text;
  assert.equal(open({ releases }), 'Nothing else in this campaign waits on it; after merging, release follows Dyk\'s standing deploy authorization.');
  assert.equal(open({}), 'Nothing else in this campaign waits on it; after merging, release follows Dyk\'s release policy.', 'nothing recorded: no one is named');
  const merged = ownerView(supervisor, [source([pr(463, 'MERGED'), pr(464, 'MERGED')])], { releases });
  assert.equal(merged.campaigns[d.campaignId].finished, 'All steps are finished · the merged work is ready; release follows Dyk\'s standing deploy authorization');
  assert.equal(merged.also.text, 'Also: merged work in Dyk is ready; release follows its standing deploy authorization');
  for (const view of [merged, ownerView(supervisor, [source([pr(463, 'OPEN'), pr(464, 'MERGED')])], { releases })]) {
    assert.doesNotMatch(JSON.stringify(view), /your release|releasing it is your next step/i, 'the owner is never assumed to release');
  }
  assert.doesNotMatch(readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8'), /your release/i);
});
