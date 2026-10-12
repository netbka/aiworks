// Now and the state copy (docs/design/OWNER_WORKSPACE.md slice S4, build slice UI5): every state of §7 has its text in
// one module (src/dashboard/copy.mjs); no primary text uses a machine word; no text about an open pull request claims
// merged, deployed, released, live, done or accepted; unknown is never "0" or "nothing". On the review fixture (S0) each
// state shows its exact copy and its one primary action, and a project's Now screen needs the owner exactly when that
// project has Needs me items (the per-project calm rule). Disposable stores and local git only; no network, model or
// GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { ownerView } from '../../src/dashboard/owner.mjs';
import { projectsView } from '../../src/dashboard/projects.mjs';
import { configuredCheckouts, configuredGitCommand, MergeWatcher, publishedSteps } from '../../src/dashboard/merges.mjs';
import { DETAIL_ONLY_WORDS, NOT_FOR_OPEN, STATE_KEYS, nowView, progressText, sinceLines, stateCopy } from '../../src/dashboard/copy.mjs';
import { buildReviewFixture, PROJECTS, REVIEW_STATES } from './fixtures/review-store.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const M = 60_000;
const NOW = Date.UTC(2026, 9, 12, 12, 0);
// Fixed formatters, so the expected sentences do not depend on this computer's time zone.
const FORMAT = { time: (value) => `T${(NOW - value) / M}`, dateTime: (value) => `D${(NOW - value) / M}` };
const PR = 'https://github.com/example/shop-app/pull/465';
const ISSUE = 'https://github.com/example/shop-app/issues/441';
/** Data that fills every placeholder of every state. */
const SAMPLE = { project: 'example/shop-app', host: 'HomePc', now: NOW, loadedAt: NOW - 3 * M, at: NOW - 20 * M, count: 3, pausedAt: NOW - 60 * M,
  reason: 'Paused for an update', campaignId: 'shop-search', step: 'Search page', next: 'Price sync', provider: 'claude-cli', startedAt: NOW - 10 * M,
  lastActivityAt: NOW - 2 * M, minutes: 25, number: 465, url: PR, registeredAt: NOW - 2 * M, attempts: 5, action: 'Review and merge', text: 'Search page',
  linkLabel: 'Review pull request #465', reasons: ['Codex is not set up on this computer'], awaiting: 2, merged: 0, reports: 2, closed: 1, delivered: 4,
  total: 9, standing: false, decision: true, retryAt: NOW + 65 * M, also: 'Also: 2 reports for you to read' };
const all = (data = SAMPLE) => STATE_KEYS.map((key) => stateCopy(key, data, FORMAT));
const words = (copy) => [copy.title, copy.text, copy.primary?.label ?? ''].join(' ');
const has = (text, word) => new RegExp(`\\b${word.replace(' ', '\\s+')}\\b`, 'i').test(text);

/** The full review fixture with today's local merge check, read the way the dashboard reads it. */
async function reviewState(t, store = 'full') {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-copy-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const { dataDir } = buildReviewFixture(root, { store });
  const now = Date.now(), supervisor = supervisorSnapshot(dataDir, now);
  if (!supervisor.available) return { supervisor, owner: ownerView(supervisor), merges: null, now };
  const watcher = new MergeWatcher({ steps: () => publishedSteps(dataDir), checkouts: configuredCheckouts(dataDir), git: configuredGitCommand(dataDir) });
  await watcher.refresh();
  const merges = watcher.snapshot();
  return { supervisor, owner: ownerView(supervisor, merges, { host: 'HomePc', now }), merges, now };
}
/** The Now screen of a project that has only this one piece of work, with that work's own Needs me items. */
const alone = ({ supervisor, owner, merges, now }, campaignId) => {
  const c = supervisor.campaigns.find((item) => item.id === campaignId);
  return nowView(c.repository, { supervisor: { ...supervisor, campaigns: [c] }, owner: { ...owner, items: owner.items.filter((item) => item.campaignId === campaignId) },
    merges, host: { name: 'HomePc' } }, { now });
};

test('every state of §7 has its text in the copy module', () => {
  // Each case of OWNER_WORKSPACE §7 (and the §4.4 primary-action states) is one key; §7.4 is the merge-check copy (C1).
  const cases = { '7.1': ['projects-empty', 'no-work', 'needs-calm', 'results-empty', 'cost-empty'],
    '7.2': ['page-disconnected', 'unreadable', 'supervisor-stopped', 'supervisor-late'], '7.3': ['provider-wait', 'no-worker-can-run', 'nothing-running'],
    '7.4': ['merge-old', 'merge-failed', 'merge-never'], '7.5': ['paused', 'paused-stopped'],
    '7.6': ['builder-working', 'checker-working', 'possibly-stuck', 'waiting-for-merge', 'awaiting-pickup', 'cancelling'],
    '7.7': ['needs-decision', 'failed-attempts', 'recorded-blocker', 'others-continue', 'supervisor-fault'],
    '7.8': ['finished-open', 'finished-merged', 'finished-unknown', 'finished-reports', 'finished-closed', 'finished-local', 'cancelled'],
    '4.4': ['review', 'one-thing', 'several'] };
  assert.deepEqual([...STATE_KEYS].sort(), Object.values(cases).flat().sort(), 'one key per case, none missing and none extra');
  for (const [section, keys] of Object.entries(cases)) for (const key of keys) {
    const copy = stateCopy(key, SAMPLE, FORMAT);
    assert.equal(copy.section, section, key);
    assert.match(copy.title, /^[A-Z0-9“].*[.…]$/, `${key} has a sentence: ${copy.title}`);
    assert.equal(typeof copy.text, 'string', key);
    assert.doesNotMatch(words(copy), /undefined|null|NaN|\[object/, `${key} fills every placeholder: ${words(copy)}`);
    // At most one primary action, and never a disabled decoration: a route, a link or a command, or nothing.
    assert.ok(copy.primary === null || copy.primary.label && (copy.primary.route || copy.primary.url || copy.primary.command), key);
  }
  assert.throws(() => stateCopy('no-such-state'), /No copy for state no-such-state/);
  // The exact sentences of §7, filled from data.
  const exact = (key, data = {}) => { const copy = stateCopy(key, { ...SAMPLE, ...data }, FORMAT); return `${copy.title} ${copy.text}`.trim(); };
  assert.equal(exact('page-disconnected'), 'Can’t reach AIWorks on this computer. Showing what was loaded at T3. Buttons are off until it reconnects. Trying again every 5 seconds.');
  assert.equal(exact('supervisor-stopped'), 'AIWorks has stopped on HomePc. No new step starts. If nobody is updating it right now, restart it there: sign in on that computer, or start the task “AIWorks Supervisor”.');
  assert.equal(exact('provider-wait'), 'Waiting for an AI worker to be free. Claude can start again at T-65. Work continues by itself. Nothing for you to do.');
  assert.equal(exact('paused'), 'Paused since D60. No new step starts. A step already running may finish. Reason given: “Paused for an update”.');
  assert.equal(exact('builder-working'), 'Working on: Search page. The builder (Claude) started at T10 · last activity 2 minutes ago.');
  assert.equal(exact('possibly-stuck'), 'Search page: no progress for 25 minutes. AIWorks retries by itself if the worker stops.');
  assert.equal(exact('waiting-for-merge'), 'Waiting for you to merge “Search page”. “Price sync” starts once you merge it.');
  assert.equal(exact('failed-attempts'), 'Stopped: 5 attempts failed. Search page. It will not retry by itself. Fix the cause, then check it again.');
  assert.equal(exact('finished-merged', { project: 'example/recipes' }), 'All steps are finished and merged. Release follows recipes’ release policy.');
  assert.equal(exact('finished-merged', { standing: true }), 'All steps are finished and merged. Release follows shop-app’s standing deploy authorization.');
  assert.equal(exact('cancelled'), 'Cancelled. 4 of 9 steps had results before it stopped.');
});

test('powers not built yet stay off: Start work and Add project are offered only when switched on', () => {
  const noWork = stateCopy('no-work', { project: 'example/shop-app' });
  assert.equal(noWork.primary, null, 'Start work (OW S9) is not built: no button that leads nowhere');
  assert.match(noWork.text, /Starting work from this page is not built yet\.$/);
  assert.deepEqual(stateCopy('no-work', { project: 'example/shop-app', startWork: true }).primary, { label: 'Start work', route: { screen: 'start', project: 'example/shop-app' } });
  assert.equal(stateCopy('projects-empty').primary, null, 'Add project (OW S11) is not built');
  assert.equal(stateCopy('projects-empty', { addProject: true }).primary.label, 'Add project');
  // nowView keeps Start work off unless asked.
  const supervisor = { available: true, campaigns: [] }, owner = { available: true, items: [], campaigns: {} };
  assert.equal(nowView('example/shop-app', { supervisor, owner }).state.primary, null);
  assert.equal(nowView('example/shop-app', { supervisor, owner }, { startWork: true }).state.primary.label, 'Start work');
});

test('no primary text uses a machine word', async (t) => {
  const texts = [...all(), ...all({ ...SAMPLE, merged: 3, decision: false, standing: true }), stateCopy('no-work', { ...SAMPLE, startWork: true }), stateCopy('projects-empty', { addProject: true })].map(words);
  const review = await reviewState(t);
  for (const id of new Set(Object.values(REVIEW_STATES).map((entry) => entry.campaignId).filter(Boolean))) {
    const view = alone(review, id);
    texts.push(words(view.state), view.progress, view.note ? words(view.note) : '', ...(view.since ?? []).map((line) => line.text));
  }
  for (const project of PROJECTS) texts.push(words(nowView(project, { ...review, host: { name: 'HomePc' } }, { now: review.now }).state));
  // "Release" is not "lease": whole words only.
  assert.ok(texts.some((text) => /Release follows/.test(text)));
  for (const text of texts) for (const word of DETAIL_ONLY_WORDS) assert.ok(!has(text, word), `"${word}" in: ${text}`);
});

test('no text for an open pull request claims merged, deployed, released, live, done or accepted', () => {
  // Every state an open pull request can be in, with nothing merged beside it.
  const open = { ...SAMPLE, merged: 0 };
  const texts = ['waiting-for-merge', 'review', 'finished-open', 'one-thing', 'several'].map((key) => words(stateCopy(key, open, FORMAT)));
  texts.push(progressText({ total: 3, delivered: 2, merged: 0, awaiting: 2, checking: 0, unknown: 0, reports: 0 }));
  texts.push(progressText({ total: 3, delivered: 2, merged: 0, awaiting: 1, checking: 1, unknown: 0, reports: 0 }));
  texts.push(...sinceLines({ merged: [], delivered: [{ campaignId: 'c' }], waiting: [{ campaignId: 'c', number: 465, url: PR }] }, ['c']).map((line) => line.text));
  for (const text of texts) for (const word of NOT_FOR_OPEN) assert.ok(!has(text, word), `"${word}" in: ${text}`);
  // Merged is said only for what is merged, next to the open ones.
  assert.equal(stateCopy('finished-open', { ...SAMPLE, merged: 3 }).text, '2 pull requests wait for your review · 3 merged.');
});

test('unknown is never shown as 0 or nothing', () => {
  const unknown = [stateCopy('finished-unknown', SAMPLE, FORMAT), stateCopy('merge-never', SAMPLE, FORMAT), stateCopy('page-disconnected', SAMPLE, FORMAT),
    stateCopy('page-disconnected', { ...SAMPLE, loadedAt: null }, FORMAT), stateCopy('unreadable', SAMPLE, FORMAT), stateCopy('merge-failed', { ...SAMPLE, at: null }, FORMAT)].map(words);
  unknown.push(progressText(null), progressText({}), progressText({ total: 2, delivered: 2, merged: 0, awaiting: 0, checking: 2, unknown: 0, reports: 0 }));
  for (const text of unknown) assert.doesNotMatch(text, /\b0\b|\bnothing\b|\bzero\b|\bnone\b/i, text);
  assert.equal(progressText(null), 'Progress is not known yet.');
  assert.equal(stateCopy('merge-never', { count: 3 }).text, 'The state of 3 results is not known yet.');
  // While the records cannot be read, or the page is disconnected, the Now state is not known: never calm, never "needs you".
  const supervisor = { available: false, campaigns: [] }, owner = { available: false, items: [] };
  for (const view of [nowView('example/shop-app', { supervisor, owner }), nowView('example/shop-app', { supervisor: { available: true, campaigns: [] }, owner: { available: true, items: [] }, offline: true })]) {
    assert.equal(view.state.needsYou, null);
    assert.equal(view.state.primary, null, 'buttons are off');
    assert.doesNotMatch(words(view.state), /\bnothing\b|\b0\b/i);
  }
});

test('on the review fixture each state shows its exact copy and its one primary action', async (t) => {
  const review = await reviewState(t);
  // The project with only that piece of work: [state key, primary action]. Where two fixture states share one piece of
  // work, the Now sentence says the one that leads (a decision while other steps continue; a recorded blocker that is
  // "no AI worker can run"; a failed merge check with results to check counts what needs the owner).
  const expected = { 'no-runs': ['awaiting-pickup', null], 'supervisor-stopped': ['supervisor-stopped', null], 'supervisor-late': ['supervisor-late', null],
    'provider-wait': ['provider-wait', null], 'no-worker-can-run': ['no-worker-can-run', null], 'nothing-running': ['nothing-running', 'Open current work'],
    'merge-check-failed': ['several', 'See the 3 things that need you'], 'paused': ['paused', 'Resume'], 'paused-supervisor-stopped': ['paused-stopped', null],
    'builder-working': ['builder-working', 'Open current work'], 'checker-working': ['checker-working', 'Open current work'], 'possibly-stuck': ['possibly-stuck', 'Open current work'],
    'waiting-for-merge': ['waiting-for-merge', 'Review pull request #104'], 'awaiting-pickup': ['awaiting-pickup', null],
    'needs-decision': ['others-continue', 'Open the step issue'], 'others-continue': ['others-continue', 'Open the step issue'], 'failed-attempts': ['failed-attempts', 'Open the step issue'],
    'recorded-blocker': ['no-worker-can-run', null], 'supervisor-fault': ['supervisor-fault', null], 'finished-all-merged': ['finished-merged', 'See results'],
    'finished-open-and-merged': ['finished-open', 'See results'], 'closed-without-merging': ['finished-open', 'See results'], 'finished-reports': ['finished-reports', 'See results'],
    'finished-unknown': ['several', 'See the 3 things that need you'], 'cancelled': ['cancelled', 'See results'] };
  for (const [name, entry] of Object.entries(REVIEW_STATES)) {
    if (entry.store) continue;
    const view = alone(review, entry.campaignId);
    assert.deepEqual([view.state.key, view.state.primary?.label ?? null], expected[name], name);
  }
  const at = (name) => alone(review, REVIEW_STATES[name].campaignId);
  assert.equal(`${at('waiting-for-merge').state.title} ${at('waiting-for-merge').state.text}`, 'Waiting for you to merge “Contracts import”. “Price sync” starts once you merge it.');
  assert.match(at('waiting-for-merge').state.primary.url, /^https:\/\/github\.com\/example\/shop-app\/pull\/104$/);
  assert.equal(at('finished-open-and-merged').state.text, '2 pull requests wait for your review · 1 merged.');
  assert.equal(at('finished-all-merged').state.title, 'All steps are finished and merged.');
  assert.equal(at('possibly-stuck').state.title, 'Wishlist page: no progress for 25 minutes.');
  assert.equal(at('failed-attempts').state.title, 'Stopped: 5 attempts failed.');
  assert.equal(at('paused').state.primary.command, 'resume');
  assert.equal(at('paused').state.primary.campaignId, 'recipes-import');
  assert.match(at('provider-wait').state.text, /^Claude can start again at \d\d:\d\d\. Work continues by itself\. Nothing for you to do\.$/);
  // The failed merge check is said where its data is used, and a project of reports only has no merge note.
  assert.equal(at('merge-check-failed').note.title, 'The merge check failed; retrying.');
  assert.equal(at('finished-reports').note, null);
  // Progress in the owner's terms; an open pull request is never counted as merged.
  assert.equal(at('finished-open-and-merged').progress, '3 of 3 steps have results · 1 merged · 2 waiting for your review');
  assert.equal(at('cancelled').state.text, '1 of 3 steps had results before it stopped.');
  // The goal is the work's declared purpose.
  assert.equal(at('checker-working').goal.text, 'Show product reviews');
  // The other two stores: the first run (a project with no work) and records that cannot be read.
  const empty = await reviewState(t, 'empty');
  assert.equal(nowView('example/shop-app', empty, { now: empty.now }).state.key, 'no-work');
  const unreadable = await reviewState(t, 'unreadable');
  assert.equal(nowView('example/shop-app', unreadable, { now: unreadable.now }).state.key, 'unreadable');
});

test('per-project calm rule: Now needs the owner exactly when that project has Needs me items', async (t) => {
  const review = await reviewState(t);
  const mine = (project) => review.owner.items.filter((item) => item.repository?.toLowerCase() === project.toLowerCase());
  const projects = projectsView(review.supervisor, review.owner, { repositories: PROJECTS });
  // Every project of the fixture, with all its work: the same answer as its Needs me group and its Projects row.
  for (const project of PROJECTS) {
    const view = nowView(project, { ...review, host: { name: 'HomePc' } }, { now: review.now });
    assert.equal(view.state.needsYou, mine(project).length > 0, `${project}: ${view.state.key}`);
    assert.equal(view.state.needsYou, projects.projects.find((row) => row.id === project).state.key === 'needs-you', `${project} agrees with Projects`);
    // Upper case in the address opens the same project.
    assert.deepEqual(nowView(project.toUpperCase(), { ...review }, { now: review.now }).state.key, view.state.key);
  }
  assert.ok(mine('example/notes-site').length > 1 && !mine('example/recipes').length, 'the fixture has a project that needs the owner and one that does not');
  // Every piece of work alone: its Now state is calm exactly when it has no Needs me item.
  for (const id of new Set(Object.values(REVIEW_STATES).map((entry) => entry.campaignId).filter(Boolean))) {
    const view = alone(review, id), items = review.owner.items.filter((item) => item.campaignId === id);
    assert.equal(view.state.needsYou, items.length > 0, `${id}: ${view.state.key}`);
  }
  // Another project's items never reach this one: calm is per project, not across the computer.
  const shop = review.supervisor.campaigns.find((c) => c.id === 'shop-checkout'), notes = review.supervisor.campaigns.find((c) => c.id === 'notes-theme');
  const owner = { ...review.owner, items: review.owner.items.filter((item) => item.campaignId === 'notes-theme') };
  const two = { supervisor: { ...review.supervisor, campaigns: [shop, notes] }, owner };
  assert.equal(nowView('example/shop-app', two, { now: review.now }).state.key, 'builder-working');
  assert.equal(nowView('example/shop-app', two, { now: review.now }).state.needsYou, false);
  assert.equal(nowView('example/notes-site', two, { now: review.now }).state.needsYou, true);
  // A calm sentence is never shown while the project has an item, whatever its work is doing.
  const calm = STATE_KEYS.filter((key) => stateCopy(key, SAMPLE).needsYou === false);
  assert.ok(calm.includes('nothing-running') && calm.includes('finished-merged') && calm.includes('paused'));
  for (const project of PROJECTS) if (mine(project).length) assert.ok(!calm.includes(nowView(project, review, { now: review.now }).state.key), project);
});

test('since you last looked is about this project only', () => {
  const recent = { merged: [{ campaignId: 'a', number: 1, url: 'https://github.com/x/a/pull/1' }, { campaignId: 'b', number: 2, url: 'https://github.com/x/b/pull/2' }],
    delivered: [{ campaignId: 'a' }], waiting: [{ campaignId: 'b', number: 3, url: 'https://github.com/x/b/pull/3' }] };
  const failures = [{ campaignId: 'a', kind: 'rejected' }, { campaignId: 'a', kind: 'failed-run' }, { campaignId: 'a', kind: 'step-error' }, { campaignId: 'b', kind: 'failed-run' }];
  assert.deepEqual(sinceLines(recent, ['a'], failures).map((line) => line.text), ['1 step merged', '1 step finished and passed the check',
    '2 AI worker runs did not succeed (1 rejected by the independent checker); AIWorks retries by itself']);
  assert.deepEqual(sinceLines(recent, ['b'], failures).map((line) => [line.text, line.links.map((item) => item.label)]), [['1 step merged', ['#2']],
    ['1 newly waiting for your review', ['#3']], ['1 AI worker run did not succeed; AIWorks retries by itself', []]]);
  assert.deepEqual(sinceLines(recent, ['c']), []);
  assert.equal(sinceLines(null, ['a']), null, 'not known is not "nothing changed"');
});

test('the copy module runs in the page as it is, and the Now screen takes its sentences from it', () => {
  const module = readFileSync(join(ROOT, 'src/dashboard/copy.mjs'), 'utf8'), page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  // No imports and no Node or DOM globals: the browser and Node load the same file.
  assert.doesNotMatch(module, /^\s*import\s|require\(|\bprocess\.|\bdocument\.|\bwindow\.|\blocalStorage\b/m);
  // The page loads it, and today's view stays while it cannot (the server serves it at /copy.mjs).
  assert.match(page, /const copy = await import\('\/copy\.mjs'\)\.catch\(\(\) => null\);/);
  assert.match(page, /copy\.nowView\(project, \{ \.\.\.state, offline \}/);
  // §7 sentences are written once, in the module.
  for (const sentence of ['Can’t reach AIWorks on this computer.', 'AIWorks is a few minutes late checking in.', 'Waiting for an AI worker to be free.',
    'One step is stopped; the others continue.', 'All steps are finished and merged.', 'Stopped: needs your decision.']) {
    assert.ok(module.includes(sentence), sentence);
    assert.ok(!page.includes(sentence), `dashboard.js repeats: ${sentence}`);
  }
});
