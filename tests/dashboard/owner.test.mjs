// Owner view (engineering-platform-archive#78/#79): what needs the owner, finished steps joined with GitHub state, plain-language wording,
// host identity and link navigation. Disposable stores and synthetic GitHub metadata only.
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
import { ownerView, delivery, purpose } from '../../src/dashboard/owner.mjs';
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

const source = (items, extra = {}) => ({ repository: 'netbka/Dyk', fetchedAt: new Date().toISOString(), error: null, items, ...extra });
const pr = (number, state, extra = {}) => ({ kind: 'pr', number, state, url: `https://github.com/netbka/Dyk/pull/${number}`, mergedAt: state === 'MERGED' ? '2026-10-10T08:49:00Z' : null, ...extra });

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

test('finished steps show where they stand on GitHub; unknown stays unknown', () => {
  const task = (url) => ({ id: 'T1', state: 'done', resultUrl: url });
  const sources = [source([pr(463, 'OPEN'), pr(464, 'MERGED'), pr(465, 'CLOSED')])];
  assert.equal(delivery(task('https://github.com/netbka/Dyk/pull/463'), sources).state, 'awaiting-review');
  assert.equal(delivery(task('https://github.com/netbka/dyk/pull/464'), sources).state, 'merged', 'repository names match case-insensitively');
  assert.equal(delivery(task('https://github.com/netbka/Dyk/pull/465'), sources).state, 'closed-unmerged');
  assert.equal(delivery(task('https://github.com/netbka/Dyk/pull/999'), sources).state, 'unknown');
  assert.equal(delivery(task('https://github.com/netbka/elma_wiki/pull/111'), sources).state, 'unknown', 'a repository not fetched yet is unknown, not fine');
  assert.equal(delivery(task('https://github.com/netbka/Dyk/issues/437#issuecomment-1'), sources).state, 'report-posted');
  assert.equal(delivery({ id: 'T1', state: 'verifying', resultUrl: null }, sources), null);
  assert.equal(delivery(task('https://github.com/netbka/Dyk/pull/463'), [source([pr(463, 'OPEN')], { error: 'refresh failed' })]).stale, true);
  assert.deepEqual(purpose({ purpose: null, repository: 'netbka/Dyk', trackingIssue: 443 },
    [source([{ kind: 'issue', number: 443, title: 'WAVE-00: one accountable delivery campaign from bootstrap to verified release' }])]),
  { text: 'One accountable delivery campaign from bootstrap to verified release', from: 'tracking-issue' });
});

test('each review says what to check, whether it is ready and what merging unlocks', (t) => {
  const { dataDir, store, d, finish } = fixture(t);
  finish('T1', 'https://github.com/netbka/Dyk/pull/463', { attempts: 10, verified_sha: 'a'.repeat(40) });
  finish('T2', 'https://github.com/netbka/Dyk/pull/464', { verified_sha: 'b'.repeat(40) });
  const now = Date.now();
  store.insert('operations', { id: 'v1', campaign_id: d.campaignId, task_id: 'T1', kind: 'verify', seq: 1, idempotency_key: 'v1', lease_generation: 1,
    state: 'finished', session_id: 's', run_dir: join(dataDir, 'runs', 'v1'), workspace: 'w', packet: {}, packet_digest: 'p',
    outcome: { class: 'result', value: { verdict: 'rejected', summary: 'worker-secret' } }, created_at: now, updated_at: now, executor_kind: 'claude-cli' });
  const supervisor = supervisorSnapshot(dataDir);
  assert.equal(supervisor.campaigns[0].tasks[0].verifierRejections, 1);
  const view = ownerView(supervisor, [source([pr(463, 'OPEN'), pr(464, 'MERGED'), { kind: 'issue', number: 443, title: 'WAVE-00: deliver the waves' }])], { host: 'HomePc' });
  assert.deepEqual(view.items.map((item) => item.kind), ['review', 'controller'], 'no live controller lease in this store: that needs the owner too');
  const [review, controller] = view.items;
  // Led by what the step delivers; the action and the pull request link sit beside it, the PR number appears once.
  assert.deepEqual([review.action, review.text, review.link], ['Review and merge', 'first task', { label: 'Open PR #463', url: 'https://github.com/netbka/Dyk/pull/463' }]);
  assert.equal(review.evidence, 'Checker accepted aaaaaaa · conflicts and CI not confirmed');
  assert.equal(review.detail, 'An independent checker accepted commit aaaaaaa; check conflicts and CI on GitHub before merging.',
    'without GitHub merge data the acceptance is not "ready to merge"');
  assert.deepEqual(review.points.map((point) => point.text), ['Check its review history first: it took 10 tries and the checker rejected it 1 time before it was accepted.',
    'Merging lets T3 build on it.']);
  assert.equal(controller.text, `The supervisor on HomePc has not started ${d.campaignId} yet`, 'this store never had a controller lease');
  assert.match(controller.points[0].text, /no supervisor has picked it up\. If nobody is upgrading it right now, restart it there: .*“AIWorks Supervisor”/);
  const lapsed = { ...supervisor, campaigns: supervisor.campaigns.map((c) => ({ ...c, readiness: 'CONTROLLER_OFFLINE', leaseExpiresAt: new Date(now - 10 * 60_000).toISOString() })) };
  const stopped = ownerView(lapsed, [], { host: 'HomePc', now }).items.find((item) => item.kind === 'controller');
  assert.equal(stopped.text, `The supervisor on HomePc stopped running ${d.campaignId}`);
  assert.equal(stopped.at, now - 10 * 60_000);
  assert.deepEqual(view.campaigns[d.campaignId].counts, { total: 3, delivered: 2, merged: 1, awaiting: 1, closed: 0, unknown: 0, reports: 0 });
  assert.equal(view.campaigns[d.campaignId].purpose.text, 'Deliver the waves');
  assert.ok(!JSON.stringify(view).includes('worker-secret'));
  const unknown = ownerView(supervisor, []);
  assert.deepEqual(unknown.items.map((item) => item.kind), ['controller']);
  assert.equal(unknown.unknownResults, 2, 'without GitHub metadata the two finished steps are unknown, not "nothing needs you"');
  // When nothing else waits on the step, the owner's next gate is the release.
  const done = { ...supervisor, campaigns: supervisor.campaigns.map((c) => ({ ...c, tasks: c.tasks.map((task) => task.id === 'T3' ? { ...task, state: 'done', resultUrl: null } : task) })) };
  // When nothing else waits on the step, release follows the project's rule; the owner is not assumed to release.
  assert.equal(ownerView(done, [source([pr(463, 'OPEN'), pr(464, 'MERGED')])]).items[0].points.at(-1).text,
    'Nothing else in this campaign waits on it; after merging, release follows Dyk\'s release policy.');
});

test('a working agent with a silent supervisor is said plainly, and same-titled campaigns are told apart', () => {
  const now = Date.now();
  const campaign = (id) => ({ id, repository: 'netbka/Dyk', trackingIssue: 442, trackingUrl: 'https://github.com/netbka/Dyk/issues/442', purpose: null, control: 'registered',
    controllerLive: false, livenessDefect: false, leaseExpiresAt: new Date(now - 10 * 60_000).toISOString(), blocker: null, tasks: [],
    agents: [{ heartbeatState: 'unknown', progress: { lastActivityAt: now - 30_000 } }] });
  const supervisor = { available: true, campaigns: [campaign('dyk-442-pilot-telegram'), campaign('dyk-442-pilot-whatsapp')], coordinator: null, recent: null };
  const view = ownerView(supervisor, [source([{ kind: 'issue', number: 442, title: 'WAVE-06: run a controlled pilot' }])], { host: 'HomePc', now });
  assert.equal(view.items[0].text, 'An agent is still working, but the supervisor on HomePc stopped checking in');
  assert.equal(view.items[0].at, now - 10 * 60_000);
  assert.match(view.items[0].points[0].text, /result is collected and checked only when the supervisor runs again/);
  assert.equal(view.campaigns['dyk-442-pilot-telegram'].liveness, 'agent-working-supervisor-silent');
  assert.deepEqual(['dyk-442-pilot-telegram', 'dyk-442-pilot-whatsapp'].map((id) => view.campaigns[id].purpose.variant), ['Telegram', 'Whatsapp']);
});

test('campaigns with something for the owner and active ones come first; finished ones collapse to one line, newest first', () => {
  const now = Date.now(), hours = (n) => new Date(now - n * 3600_000).toISOString();
  const campaign = (id, control, extra = {}) => ({ id, repository: 'netbka/Dyk', trackingIssue: 443, trackingUrl: 'https://github.com/netbka/Dyk/issues/443',
    purpose: `Purpose of ${id}`, control, readiness: control === 'registered' ? 'ACTIVE' : control === 'finished' ? 'COMPLETE' : 'CANCELLED',
    controllerLive: control === 'registered', livenessDefect: false, leaseExpiresAt: null, blocker: null, tasks: [], agents: [], lastProgressAt: null, ...extra });
  const done = (id, number) => ({ id, title: `${id} title`, outcome: null, state: 'done', resultUrl: `https://github.com/netbka/Dyk/pull/${number}`, dependsOn: [],
    attempts: 1, verifierRejections: 0, verifiedSha: null });
  // Snapshot order: active first, then finished and cancelled campaigns by creation.
  const supervisor = { available: true, coordinator: null, recent: null, campaigns: [
    campaign('active', 'registered', { tasks: [{ ...done('A1', 1), state: 'pending', resultUrl: null }] }),
    campaign('finished-old', 'finished', { tasks: [done('O1', 461)], lastProgressAt: hours(3) }),
    campaign('finished-review', 'finished', { tasks: [done('R1', 463)], lastProgressAt: hours(5) }),
    campaign('cancelled', 'cancelled', { tasks: [done('C1', 462), { ...done('C2', 0), state: 'pending', resultUrl: null }], lastProgressAt: hours(2) }),
    campaign('finished-new', 'finished', { tasks: [done('N1', 464)], lastProgressAt: hours(1) }),
  ] };
  const view = ownerView(supervisor, [source([pr(461, 'MERGED'), pr(462, 'MERGED'), pr(463, 'OPEN'), pr(464, 'MERGED')])], { now });
  assert.deepEqual(view.items.map((item) => item.campaignId), ['finished-review']);
  assert.deepEqual(view.layout, { cards: ['finished-review', 'active'], finished: ['finished-new', 'cancelled', 'finished-old'] });
  assert.equal(view.campaigns['finished-new'].outcome, 'The merged work is ready; release follows Dyk\'s release policy');
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
  finish('T1', 'https://github.com/netbka/Dyk/pull/463');
  finish('T2', 'https://github.com/netbka/Dyk/pull/464');
  store.journal(d.campaignId, 'published', { task: 'T1', url: 'https://github.com/netbka/Dyk/pull/463' }, Date.now());
  store.journal(d.campaignId, 'operation-finished', { op: 'x', class: 'result', terminal: 'rejected' }, Date.now());
  store.journal(d.campaignId, 'operation-finished', { op: 'y', class: 'timeout' }, Date.now());
  store.journal(d.campaignId, 'operation-finished', { op: 'z', class: 'quota' }, Date.now());
  store.journal(d.campaignId, 'published', { task: 'T0', url: 'https://github.com/netbka/Dyk/pull/1' }, before - 3_600_000);
  // A failing supervisor step is journaled on every tick: it is the supervisor's problem, not a failed agent run.
  for (let i = 0; i < 3; i++) store.journal(d.campaignId, 'step-error', { message: 'raw error text' }, Date.now());
  store.journal(d.campaignId, 'liveness-defect', { tasks: [] }, Date.now());
  const supervisor = supervisorSnapshot(dataDir, Date.now(), { since: before });
  const view = ownerView(supervisor, [source([pr(463, 'OPEN'), pr(464, 'MERGED', { mergedAt: new Date().toISOString() })])]);
  assert.equal(view.recent.delivered.length, 1, 'only publications since the last visit');
  assert.deepEqual(view.recent.waiting.map((item) => item.number), [463]);
  assert.deepEqual(view.recent.merged.map((item) => item.number), [464]);
  assert.equal(view.recent.failures, 2, 'a provider limit is a wait, not a failure, and supervisor errors are not agent runs');
  assert.equal(view.recent.rejected, 1);
  assert.deepEqual([view.recent.supervisorErrors, view.recent.livenessProblems], [3, 1]);
  assert.ok(!JSON.stringify(view).includes('raw error text'));
  assert.equal(supervisorSnapshot(dataDir).recent, null, 'no since: no summary');
});

test('stops, decisions, closed pull requests and an unreadable inbox need the owner; a pause by itself does not', (t) => {
  const { dataDir, store, d, finish } = fixture(t, declaration({ tasks: three().map((task) => ({ ...task, outcome: `Owners get ${task.title}` })) }));
  finish('T1', 'https://github.com/netbka/Dyk/pull/465');
  const t2 = store.task(d.campaignId, 'T2');
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T2' }, t2.version, { blocked: { class: 'B3', reason: 'owner-reserved: worker text' } }, Date.now());
  campaignPause(store, d.campaignId, 'Supervisor upgrade', Date.now());
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ coordinator: { enabled: true, permissionMode: 'auto', reportTo: 'netbka/aiworks#3' } }));
  const supervisor = supervisorSnapshot(dataDir);
  assert.equal(supervisor.campaigns[0].tasks[0].outcome, 'Owners get first task');
  assert.equal(supervisor.campaigns[0].pausedReason, 'Supervisor upgrade');
  const view = ownerView(supervisor, [source([pr(465, 'CLOSED')])]);
  const kinds = view.items.map((item) => item.kind);
  // No pause item: the pause is shown on the campaign card. This store never had a supervisor, though, and a paused
  // campaign still needs one, so that is listed.
  assert.deepEqual(kinds, ['closed', 'decision', 'controller', 'coordinator']);
  assert.deepEqual([view.items[0].action, view.items[0].text, view.items[0].link.label], ['Closed without merging', 'Owners get first task', 'Open PR #465']);
  assert.match(view.items[0].points[0].text, /^It was checked and published, but its pull request was closed/);
  assert.deepEqual([view.items[1].action, view.items[1].text], ['Decision needed', 'Owners get second task']);
  assert.ok(!view.items[1].points[0].text.includes('worker text'), 'stop reasons are supervisor words, never worker output');
  assert.equal(view.items[2].text, `The supervisor on its computer has not started ${d.campaignId} yet (it is paused)`);
  assert.ok(!view.items.some((item) => /is paused$|Supervisor upgrade/.test(item.text)), 'the pause reason is never an owner item');
  assert.equal(view.items[3].text, 'The coordinator cannot read your messages');
  assert.ok(view.layout.cards.includes(d.campaignId), 'a paused campaign keeps its card');
});

const raw = (base, path, headers, method = 'GET') => new Promise((resolve, reject) => {
  const req = request(`${base}${path}`, { method, headers }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject); req.end();
});

test('a dashboard link opened from another site loads the page, while data and commands stay same-origin only', async (t) => {
  const { dataDir, d } = fixture(t);
  const tracked = [];
  const roadmap = { snapshot: () => ({ entries: [], sources: [], work: [] }), refresh: async () => {}, track: (repos) => tracked.push(...repos), sources: [] };
  const server = createDashboardServer({ dataDir, roadmap, host: { name: 'TestPc', revision: 'abc1234def56' } });
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
  assert.deepEqual(tracked, [d.target.repository], 'campaign target repositories are always fetched');
});
