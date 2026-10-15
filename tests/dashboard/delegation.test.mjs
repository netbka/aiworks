// Verified pull requests the owner delegated are not "Needs you" items (example-org/aiworks#97). The owner decided that a
// pull request which passed the supervisor's independent check of its exact head is merged without an owner step (#17).
// config.json `merges` records that delegation; the dashboard only reads it. Without it nothing changes; with it a
// verified, unmerged pull request is passed and merged for the owner, and a held one says why in owner words. One that
// waited longer than merges.stallHours since its check is the owner's again (#139).
// Disposable stores, synthetic merge state, the review fixture's local git and a loopback server only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { declaration } from '../supervisor/helpers.mjs';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { ownerView } from '../../src/dashboard/owner.mjs';
import { configuredMergeDelegation } from '../../src/dashboard/merges.mjs';
import { projectsView } from '../../src/dashboard/projects.mjs';
import { DELEGATED, nowView, progressText } from '../../src/dashboard/copy.mjs';
import { openPage, internalWords, visibleText } from './fixtures/page.mjs';

const PR = (n) => `https://github.com/example-org/sampleapp/pull/${n}`;
const sha = (taskId) => taskId.replace(/\D/g, '').padStart(40, 'a');
const task = (id, title) => ({ id, issue: 437 + Number(id.slice(1)), title, deliverable: 'commit', goal: `${title}.`, dependsOn: [], acceptance: ['a'], references: ['AGENTS.md'] });
const DELEGATION = { delegatedTo: 'monitor', decision: '#17', held: {} };

/** A finished campaign in example-org/sampleapp: T1 verified and not merged, T2 verified and merged, T3 published without a verified commit. */
function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-delegation-'));
  const store = new Store(join(dataDir, 'supervisor.db'));
  const d = declaration({ tasks: [task('T1', 'first'), task('T2', 'second'), task('T3', 'third')] });
  campaignStart(store, d, Date.now());
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  for (const [id, number, verified] of [['T1', 463, true], ['T2', 464, true], ['T3', 465, false]]) {
    const row = store.task(d.campaignId, id);
    store.patch('tasks', { campaign_id: d.campaignId, task_id: id }, row.version, { state: 'done', pr_url: PR(number), ...(verified ? { verified_sha: sha(id) } : {}) }, Date.now());
  }
  const c = store.campaign(d.campaignId);
  store.patch('campaigns', { id: d.campaignId }, c.version, { control: 'finished', status: 'ready', next_action: 'Release gate: review campaign deliveries under example-org/sampleapp\'s own merge and release policy.' }, Date.now());
  // A current local merge check: T2 is on the base branch, T1 and T3 are not.
  const merges = { repositories: [{ repository: 'example-org/sampleapp', configured: true, fetchedAt: Date.now(), attemptedAt: Date.now(), error: null }],
    steps: Object.fromEntries([['T1', false], ['T2', true], ['T3', false]].map(([id, merged]) => [`${d.campaignId}/${id}`, { sha: sha(id), baseBranch: 'main', merged, mergedAt: null }])) };
  return { dataDir, d, store, supervisor: supervisorSnapshot(dataDir), merges };
}

const reviewItems = (view) => view.items.filter((item) => item.kind === 'review');
const results = (view) => view.results['example-org/sampleapp'].groups;

test('without merges.delegatedTo, a verified, unmerged pull request is a Needs me item exactly as today', (t) => {
  const { d, supervisor, merges } = fixture(t);
  const today = ownerView(supervisor, merges);
  // No setting and an explicit null are the same view, item for item.
  assert.deepEqual(ownerView(supervisor, merges, { delegation: null }), today);
  assert.deepEqual(reviewItems(today).map((item) => [item.action, item.link.url]), [['Review and merge', PR(463)], ['Review and merge', PR(465)]]);
  assert.equal(today.count, 2);
  assert.equal(today.headline, 'Needs you (2)');
  assert.equal(today.campaigns[d.campaignId].deliveries.T1.state, 'published');
  assert.equal(today.campaigns[d.campaignId].counts.awaiting, 2);
  assert.ok(!('delegated' in today.campaigns[d.campaignId].counts), 'the counts are as before');
  assert.deepEqual(results(today).map((group) => group.key), ['review', 'merged']);
  assert.equal(today.results['example-org/sampleapp'].primary.label, 'Review pull request #463');
});

test('with merges.delegatedTo, a verified, unmerged pull request is not in Needs me, counted nowhere and passed and merged for the owner', (t) => {
  const { d, supervisor, merges } = fixture(t);
  const view = ownerView(supervisor, merges, { delegation: DELEGATION });
  // Only the step without a verified commit is still the owner's: it has not passed the check.
  assert.deepEqual(reviewItems(view).map((item) => item.link.url), [PR(465)]);
  assert.ok(!view.items.some((item) => item.link?.url === PR(463)));
  assert.equal(view.count, 1);
  assert.equal(view.headline, 'Needs you (1)');
  assert.deepEqual(view.groups.map((group) => [group.name, group.count]), [['sampleapp', 1]]);
  const projects = projectsView(supervisor, view);
  assert.equal(projects.projects.find((project) => project.repository === 'example-org/sampleapp').details.needsYou, 1);
  // Work: the step's state and the line under it.
  const owner = view.campaigns[d.campaignId], t1 = owner.deliveries.T1;
  assert.equal(t1.state, 'delegated');
  assert.equal(t1.held, null);
  assert.equal(t1.note, 'Will be merged for you. Nothing for you to do.');
  assert.deepEqual({ awaiting: owner.counts.awaiting, delegated: owner.counts.delegated, merged: owner.counts.merged }, { awaiting: 1, delegated: 1, merged: 1 });
  assert.equal(progressText(owner.counts), '3 of 3 steps have results · 1 merged · 1 waiting for your review · 1 to be merged for you');
  assert.equal(owner.finished, 'All steps are finished · 1 step waits for your review (merge not seen yet) · 1 to be merged for you · 1 merged');
  assert.equal(owner.releaseReady, false, 'work merged for the owner is not merged yet, so nothing is ready for release');
  // Results: its own group, never "Merged" before the merge check sees it, and never the owner's primary action.
  const groups = results(view);
  assert.deepEqual(groups.map((group) => [group.key, group.title, group.count]), [['review', 'Waiting for your review', 1], ['delegated', 'Being merged for you', 1], ['merged', 'Merged', 1]]);
  const row = groups.find((group) => group.key === 'delegated').rows[0];
  assert.equal(row.word, 'Pull request #463 · passed the check · will be merged for you');
  assert.equal(row.link.url, PR(463));
  assert.equal(row.evidence, `Passed the check at commit ${sha('T1').slice(0, 7)}`);
  assert.equal(view.results['example-org/sampleapp'].primary.label, 'Review pull request #465');
  // Once the merge check sees it on the base branch, it is merged, as before.
  const seen = { ...merges, steps: { ...merges.steps, [`${d.campaignId}/T1`]: { ...merges.steps[`${d.campaignId}/T1`], merged: true } } };
  assert.equal(ownerView(supervisor, seen, { delegation: DELEGATION }).campaigns[d.campaignId].deliveries.T1.state, 'merged');
  // A merge check that can still come shortly stays "not known yet", with or without the setting.
  const checking = ownerView(supervisor, { ...merges, repositories: [{ ...merges.repositories[0], fetchedAt: null }] }, { delegation: DELEGATION });
  assert.equal(checking.campaigns[d.campaignId].deliveries.T1.state, 'published');
  assert.equal(checking.campaigns[d.campaignId].deliveries.T1.pending, true);
});

test('with every open pull request delegated, nothing needs the owner and the finished work says so', (t) => {
  const { d, supervisor, merges } = fixture(t);
  const verified = { ...supervisor, campaigns: supervisor.campaigns.map((c) => ({ ...c, tasks: c.tasks.filter((item) => item.id !== 'T3') })) };
  const view = ownerView(verified, merges, { delegation: DELEGATION });
  assert.deepEqual(view.items, []);
  assert.equal(view.count, 0);
  assert.equal(view.headline, 'Nothing is blocked on you right now');
  const now = nowView('example-org/sampleapp', { supervisor: verified, owner: view, merges }, { now: Date.now() });
  assert.equal(now.state.key, 'finished-delegated');
  assert.equal(now.state.needsYou, false);
  assert.equal(now.state.text, '1 pull request passed the check and is to be merged for you · 1 merged.');
  assert.equal(projectsView(verified, view).projects[0].details.needsYou, 0);
  assert.equal(view.campaigns[d.campaignId].counts.awaiting, 0);
});

test('a held pull request shows its plain reason', (t) => {
  const { d, supervisor, merges } = fixture(t);
  const held = (reason) => ownerView(supervisor, merges, { delegation: { ...DELEGATION, held: { [PR(463).toLowerCase()]: reason } } });
  const view = held('newer-work'), t1 = view.campaigns[d.campaignId].deliveries.T1;
  assert.equal(t1.state, 'delegated');
  assert.equal(t1.held, 'newer-work');
  assert.equal(t1.note, 'Held: waiting to be combined with newer work');
  assert.ok(!view.items.some((item) => item.link?.url === PR(463)), 'a held pull request is not the owner’s either');
  const row = results(view).find((group) => group.key === 'delegated').rows[0];
  assert.equal(row.word, 'Pull request #463 · held: waiting to be combined with newer work');
  assert.equal(held('other').campaigns[d.campaignId].deliveries.T1.note, 'Held for now; the pull request says why');
  for (const text of [t1.note, row.word, held('other').campaigns[d.campaignId].deliveries.T1.note]) assert.deepEqual(internalWords(text), [], text);
});

test('config.json merges: absent by default, both fields required, anything malformed is ignored', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-delegation-config-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const write = (config) => writeFileSync(join(dataDir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  assert.equal(configuredMergeDelegation(dataDir), null, 'no config.json');
  write({ repositories: {} });
  assert.equal(configuredMergeDelegation(dataDir), null, 'no merges setting');
  for (const merges of [{ delegatedTo: 'monitor' }, { decision: '#17' }, { delegatedTo: '', decision: '#17' }, { delegatedTo: 'monitor', decision: '17' },
    { delegatedTo: ['monitor'], decision: '#17' }, 'monitor', null]) {
    write({ merges });
    assert.equal(configuredMergeDelegation(dataDir), null, JSON.stringify(merges));
  }
  write('{ not json');
  assert.equal(configuredMergeDelegation(dataDir), null, 'an unreadable file');
  write({ merges: { delegatedTo: 'monitor', decision: '#17', held: { [PR(88).replace('example-org', 'Example-Org')]: 'newer-work', [PR(89)]: 'internal-hold-B3', 'https://example.com/x': 'newer-work' } } });
  assert.deepEqual(configuredMergeDelegation(dataDir), { delegatedTo: 'monitor', decision: '#17',
    held: { [PR(88).toLowerCase()]: 'newer-work', [PR(89).toLowerCase()]: 'other' }, stallHours: 3 }, 'pull request links only; an unknown reason reads as other');
  // merges.stallHours: a whole number of hours from 1 to 720; anything else is the default, 3.
  for (const [stallHours, expected] of [[undefined, 3], [1, 1], [12, 12], [720, 720], [0, 3], [-2, 3], [1.5, 3], [721, 3], ['6', 3], [null, 3]]) {
    write({ merges: { delegatedTo: 'monitor', decision: '#17', stallHours } });
    assert.equal(configuredMergeDelegation(dataDir).stallHours, expected, String(stallHours));
  }
});

// A delegated merge that waits too long comes back to Needs me (#139). Fixed clock: T1 passed the check at VERIFIED_AT.
const VERIFIED_AT = 1_791_000_000_000, HOUR = 60 * 60_000;
const verifyRun = (store, d, id, { sha: target = sha('T1'), verdict = 'accepted', at = VERIFIED_AT } = {}) => store.insert('operations', { id, campaign_id: d.campaignId,
  task_id: 'T1', kind: 'verify', seq: 1, idempotency_key: id, lease_generation: 1, state: 'finished', session_id: 's', run_dir: id, workspace: 'w', target_sha: target,
  packet: {}, packet_digest: 'p', outcome: { class: 'result', value: { verdict } }, created_at: at - 60_000, updated_at: at, executor_kind: 'claude-cli' });

/** The fixture with T1's accepting check run at VERIFIED_AT, and the owner view at `now` with a merge check current at that time. */
function stalling(t) {
  const { dataDir, d, store, merges } = fixture(t);
  verifyRun(store, d, 'v-old', { at: VERIFIED_AT - 9 * HOUR });
  verifyRun(store, d, 'v-other-commit', { sha: 'f'.repeat(40), at: VERIFIED_AT + HOUR });
  verifyRun(store, d, 'v-rejected', { verdict: 'rejected', at: VERIFIED_AT + 2 * HOUR });
  verifyRun(store, d, 'v1');
  const supervisor = supervisorSnapshot(dataDir);
  const at = (now) => ({ ...merges, repositories: [{ ...merges.repositories[0], fetchedAt: now - 60_000, attemptedAt: now - 60_000 }] });
  const view = (now, delegation = DELEGATION) => ownerView(supervisor, at(now), { now, delegation });
  return { d, supervisor, store, at, view };
}

test('the time a step passed the check is the latest accepting check of its verified commit, else when the step last changed', (t) => {
  const { d, supervisor, store } = stalling(t);
  const tasks = Object.fromEntries(supervisor.campaigns[0].tasks.map((item) => [item.id, item]));
  assert.equal(tasks.T1.verifiedAt, VERIFIED_AT, 'not an older run, a run on another commit or a rejection');
  assert.equal(tasks.T3.verifiedAt, null, 'no verified commit');
  // No recorded check run: when the step last changed, which is never earlier than its check.
  assert.equal(tasks.T2.verifiedAt, store.task(d.campaignId, 'T2').updated_at);
});

test('a delegated, verified, unmerged pull request that waited longer than merges.stallHours since its check is a counted Needs me item that opens it', (t) => {
  const { d, supervisor, at, view } = stalling(t);
  // Up to the threshold it reads as today: no item, counted nowhere, "will be merged for you".
  for (const now of [VERIFIED_AT + HOUR, VERIFIED_AT + 3 * HOUR]) {
    const before = view(now), t1 = before.campaigns[d.campaignId].deliveries.T1;
    assert.equal(t1.state, 'delegated');
    assert.equal(t1.stalled, null);
    assert.equal(t1.note, 'Will be merged for you. Nothing for you to do.');
    assert.ok(!before.items.some((item) => item.link?.url === PR(463)));
    assert.deepEqual([before.count, before.headline], [1, 'Needs you (1)']);
    assert.equal(results(before).find((group) => group.key === 'delegated').rows[0].word, 'Pull request #463 · passed the check · will be merged for you');
  }
  // Past it: one counted item whose one action opens the pull request.
  const now = VERIFIED_AT + 3 * HOUR + 60_000, after = view(now);
  const stalled = after.items.filter((item) => item.kind === 'merge-stalled');
  assert.deepEqual(stalled.map((item) => ({ action: item.action, text: item.text, link: item.link, points: item.points, repository: item.repository })), [{
    action: 'Check why it is not merged', text: 'first', link: { label: 'Open PR #463', url: PR(463) },
    points: [{ link: null, text: 'Checked and waiting to be merged for 3 hours. Nothing has merged it.' }], repository: 'example-org/sampleapp' }]);
  assert.deepEqual([after.count, after.headline], [2, 'Needs you (2)']);
  assert.deepEqual(after.groups.map((group) => [group.name, group.count, group.notCounted]), [['sampleapp', 2, 0]]);
  assert.equal(projectsView(supervisor, after).projects.find((project) => project.repository === 'example-org/sampleapp').details.needsYou, 2);
  // Work and Results say how long it waited; it is never called merged.
  const t1 = after.campaigns[d.campaignId].deliveries.T1;
  assert.deepEqual([t1.state, t1.stalled, t1.note], ['delegated', 3, 'Checked and waiting to be merged for 3 hours. Nothing has merged it.']);
  const row = results(after).find((group) => group.key === 'delegated').rows[0];
  assert.deepEqual([row.word, row.link.url], ['Pull request #463 · checked and waiting to be merged for 3 hours', PR(463)]);
  assert.equal(results(view(VERIFIED_AT + 26 * HOUR + 59 * 60_000)).find((group) => group.key === 'delegated').rows[0].word,
    'Pull request #463 · checked and waiting to be merged for 26 hours', 'whole hours, rounded down');
  // Now, with nothing else for the owner: the one thing, whose action opens the pull request.
  const alone = { ...supervisor, campaigns: supervisor.campaigns.map((c) => ({ ...c, tasks: c.tasks.filter((item) => item.id !== 'T3') })) };
  const only = ownerView(alone, at(now), { now, delegation: DELEGATION });
  const state = nowView('example-org/sampleapp', { supervisor: alone, owner: only, merges: at(now) }, { now }).state;
  assert.deepEqual([state.key, state.needsYou, state.title, state.text, state.primary],
    ['one-thing', true, 'One thing needs you.', 'first: Checked and waiting to be merged for 3 hours. Nothing has merged it.', { label: 'Open pull request #463', url: PR(463) }]);
  for (const text of [stalled[0].action, stalled[0].points[0].text, row.word, state.text, state.primary.label]) assert.deepEqual(internalWords(text), [], text);
  // Once the merge check sees it on the base branch, it is merged and no longer an item.
  const merged = at(now);
  merged.steps = { ...merged.steps, [`${d.campaignId}/T1`]: { ...merged.steps[`${d.campaignId}/T1`], merged: true } };
  const seen = ownerView(supervisor, merged, { now, delegation: DELEGATION });
  assert.equal(seen.campaigns[d.campaignId].deliveries.T1.state, 'merged');
  assert.equal(seen.items.filter((item) => item.kind === 'merge-stalled').length, 0);
});

test('a held pull request keeps its reason however long it waits; merges.stallHours sets the threshold; without the setting nothing changes', (t) => {
  const { d, view } = stalling(t);
  const late = VERIFIED_AT + 40 * HOUR;
  const held = view(late, { ...DELEGATION, held: { [PR(463).toLowerCase()]: 'newer-work' } });
  assert.deepEqual([held.campaigns[d.campaignId].deliveries.T1.stalled, held.campaigns[d.campaignId].deliveries.T1.note], [null, 'Held: waiting to be combined with newer work']);
  assert.ok(!held.items.some((item) => item.kind === 'merge-stalled'));
  assert.equal(held.count, 1);
  // A threshold of 1 hour.
  const one = { ...DELEGATION, stallHours: 1 };
  assert.equal(view(VERIFIED_AT + HOUR, one).campaigns[d.campaignId].deliveries.T1.stalled, null);
  assert.equal(view(VERIFIED_AT + HOUR + 1, one).items.find((item) => item.kind === 'merge-stalled').points[0].text,
    'Checked and waiting to be merged for 1 hour. Nothing has merged it.');
  assert.equal(view(VERIFIED_AT + 5 * HOUR, { ...DELEGATION, stallHours: 6 }).count, 1);
  // Without the setting the pull request is the owner's to review and merge, as before: no stalled item.
  const today = view(late, null);
  assert.deepEqual(today.items.map((item) => item.kind), ['review', 'review']);
});

test('with delegatedTo "supervisor", Work and Results say AIWorks merges it after the check against the latest main; no text mentions CI for merging', (t) => {
  const { d, supervisor, merges } = fixture(t);
  const words = (delegation) => {
    const view = ownerView(supervisor, merges, { delegation }), owner = view.campaigns[d.campaignId];
    const row = results(view).find((group) => group.key === 'delegated').rows[0];
    const verified = { ...supervisor, campaigns: supervisor.campaigns.map((c) => ({ ...c, tasks: c.tasks.filter((item) => item.id !== 'T3') })) };
    const now = nowView('example-org/sampleapp', { supervisor: verified, owner: ownerView(verified, merges, { delegation }), merges }, { now: Date.now() });
    return { note: owner.deliveries.T1.note, row: row.word, progress: progressText(owner.counts), finished: owner.finished, now: now.state.text };
  };
  const aiworks = words({ ...DELEGATION, delegatedTo: 'supervisor', decision: '#138' });
  assert.deepEqual(aiworks, {
    note: 'AIWorks merges it after it passes the check against the latest main. Nothing for you to do.',
    row: 'Pull request #463 · passed the check · AIWorks merges it after it passes the check against the latest main',
    progress: '3 of 3 steps have results · 1 merged · 1 waiting for your review · 1 to be merged for you',
    finished: 'All steps are finished · 1 step waits for your review (merge not seen yet) · 1 to be merged for you · 1 merged',
    now: '1 pull request passed the check and is to be merged for you · 1 merged.' });
  const other = words(DELEGATION);
  for (const text of [...Object.values(aiworks), ...Object.values(other), ...Object.values(DELEGATED.held), DELEGATED.stalled(4), DELEGATED.stalledRow(463, 4), DELEGATED.stalledAction]) {
    assert.doesNotMatch(text, /\bCI\b/, text);
    assert.deepEqual(internalWords(text), [], text);
  }
});

test('the page: with the setting, Needs me, Work and Results say it in owner words; without it, today’s page', async (t) => {
  const page = await openPage(t);
  const shop = 'example/shop-app', contracts = 'https://github.com/example/shop-app/pull/104';
  await page.go('#/needs');
  const before = visibleText(page.$('#main'));
  assert.match(before, /Review and merge/);
  assert.ok(before.includes('Open PR #102'), 'without the setting, the verified pull request is the owner’s to review and merge');
  // The setting is read on every refresh: no restart.
  const configPath = join(page.dataDir, 'config.json'), config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, merges: { delegatedTo: 'monitor', decision: '#17', held: { [contracts]: 'newer-work' } } }));
  await page.refresh();
  const after = visibleText(page.$('#main'));
  assert.ok(!['#102', '#103', '#104'].some((number) => after.includes(`Open PR ${number}`)), after);
  await page.go(`#/p/${encodeURIComponent(shop)}/results`);
  const resultsText = visibleText(page.$('#main'));
  assert.match(resultsText, /Being merged for you/);
  assert.match(resultsText, /Pull request #102 · passed the check · will be merged for you/);
  assert.match(resultsText, /Pull request #103 · passed the check · will be merged for you/);
  assert.match(resultsText, /Pull request #104 · held: waiting to be combined with newer work/);
  await page.go(`#/p/${encodeURIComponent(shop)}/work`);
  const work = visibleText(page.$('#main'));
  // The verified step whose merge the next step waits for: passed the check, and why it is held.
  // The step's name once (its title only repeats the outcome here, so it is not shown twice), then where it stands.
  assert.match(work, /Contracts import Passed the check Held: waiting to be combined with newer work/);
  for (const [where, text] of [['needs', after], ['results', resultsText], ['work', work]]) assert.deepEqual(internalWords(text), [], where);
  // AIWorks itself merges (#138): Results and Work say it merges after its check against the latest main, never after CI.
  writeFileSync(configPath, JSON.stringify({ ...config, merges: { delegatedTo: 'supervisor', decision: '#138' } }));
  await page.refresh();
  await page.go(`#/p/${encodeURIComponent(shop)}/results`);
  const aiworksResults = visibleText(page.$('#main'));
  assert.match(aiworksResults, /Pull request #102 · passed the check · AIWorks merges it after it passes the check against the latest main/);
  await page.go(`#/p/${encodeURIComponent(shop)}/work`);
  const aiworksWork = visibleText(page.$('#main'));
  assert.match(aiworksWork, /AIWorks merges it after it passes the check against the latest main\. Nothing for you to do\./);
  for (const text of [resultsText, work, aiworksResults, aiworksWork]) assert.doesNotMatch(text, /after CI|CI passes/);
});
