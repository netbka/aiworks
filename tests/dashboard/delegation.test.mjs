// Verified pull requests the owner delegated are not "Needs you" items (example-org/aiworks#97). The owner decided that a
// pull request which passed the supervisor's independent check of its exact head is merged without an owner step (#17).
// config.json `merges` records that delegation; the dashboard only reads it. Without it nothing changes; with it a
// verified, unmerged pull request is passed and merged for the owner after CI, and a held one says why in owner words.
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
import { nowView, progressText } from '../../src/dashboard/copy.mjs';
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
  return { dataDir, d, supervisor: supervisorSnapshot(dataDir), merges };
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
  assert.deepEqual(view.groups.map((group) => [group.name, group.count]), [['SampleApp', 1]]);
  const projects = projectsView(supervisor, view);
  assert.equal(projects.projects.find((project) => project.repository === 'example-org/sampleapp').details.needsYou, 1);
  // Work: the step's state and the line under it.
  const owner = view.campaigns[d.campaignId], t1 = owner.deliveries.T1;
  assert.equal(t1.state, 'delegated');
  assert.equal(t1.held, null);
  assert.equal(t1.note, 'Will be merged for you after CI passes. Nothing for you to do.');
  assert.deepEqual({ awaiting: owner.counts.awaiting, delegated: owner.counts.delegated, merged: owner.counts.merged }, { awaiting: 1, delegated: 1, merged: 1 });
  assert.equal(progressText(owner.counts), '3 of 3 steps have results · 1 merged · 1 waiting for your review · 1 to be merged for you after CI');
  assert.equal(owner.finished, 'All steps are finished · 1 step waits for your review (merge not seen yet) · 1 to be merged for you after CI · 1 merged');
  assert.equal(owner.releaseReady, false, 'work merged for the owner is not merged yet, so nothing is ready for release');
  // Results: its own group, never "Merged" before the merge check sees it, and never the owner's primary action.
  const groups = results(view);
  assert.deepEqual(groups.map((group) => [group.key, group.title, group.count]), [['review', 'Waiting for your review', 1], ['delegated', 'Being merged for you', 1], ['merged', 'Merged', 1]]);
  const row = groups.find((group) => group.key === 'delegated').rows[0];
  assert.equal(row.word, 'Pull request #463 · passed the check · will be merged for you after CI');
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
  assert.equal(now.state.text, '1 pull request passed the check and is to be merged for you after CI · 1 merged.');
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
    held: { [PR(88).toLowerCase()]: 'newer-work', [PR(89).toLowerCase()]: 'other' } }, 'pull request links only; an unknown reason reads as other');
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
  assert.match(resultsText, /Pull request #102 · passed the check · will be merged for you after CI/);
  assert.match(resultsText, /Pull request #103 · passed the check · will be merged for you after CI/);
  assert.match(resultsText, /Pull request #104 · held: waiting to be combined with newer work/);
  await page.go(`#/p/${encodeURIComponent(shop)}/work`);
  const work = visibleText(page.$('#main'));
  // The verified step whose merge the next step waits for: passed the check, and why it is held.
  // The step's name once (its title only repeats the outcome here, so it is not shown twice), then where it stands.
  assert.match(work, /Contracts import Passed the check Held: waiting to be combined with newer work/);
  for (const [where, text] of [['needs', after], ['results', resultsText], ['work', work]]) assert.deepEqual(internalWords(text), [], where);
});
