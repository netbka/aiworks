// Needs me lists only owner decisions, and its counts agree (aiworks#11, UX-002 review of the owner dashboard at
// 96ed590, findings F6, F9, F16 and F17). A project's count on Projects is its Needs me group's count; AIWorks stopped on
// this computer is one item, not one per piece of work; "AIWorks itself" counts toward Needs you only for an owner
// action; a project's Now leads with what needs the owner, or its Resume. The review fixture through the real dashboard
// server (tests/dashboard/fixtures/page.mjs) and synthetic snapshots; local git and a loopback server only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { ownerView, SYSTEM_GROUP } from '../../src/dashboard/owner.mjs';
import { projectsView } from '../../src/dashboard/projects.mjs';
import { nowView } from '../../src/dashboard/copy.mjs';
import { configuredCheckouts, configuredGitCommand, MergeWatcher, publishedSteps } from '../../src/dashboard/merges.mjs';
import { buildReviewFixture, PROJECTS, REVIEW_STATES } from './fixtures/review-store.mjs';
import { openPage, visibleText } from './fixtures/page.mjs';

const address = (project, tail = '') => `#/p/${encodeURIComponent(project)}${tail}`;
const screen = (page) => visibleText(page.$('#main'));

/** The full review fixture as the dashboard reads it, with today's local merge check. */
async function review(t, store = 'full') {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-needs-counts-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const { dataDir } = buildReviewFixture(root, { store });
  const watcher = new MergeWatcher({ steps: () => publishedSteps(dataDir), checkouts: configuredCheckouts(dataDir), git: configuredGitCommand(dataDir) });
  await watcher.refresh();
  const now = Date.now(), supervisor = supervisorSnapshot(dataDir, now), merges = watcher.snapshot();
  return { supervisor, merges, now, owner: ownerView(supervisor, merges, { host: 'review-pc', now }) };
}

const NOW = Date.UTC(2026, 9, 13, 12, 0);
/** A synthetic campaign of the supervisor snapshot; a live lease unless `extra` says otherwise. */
const campaign = (id, repository, extra = {}) => ({ id, repository, trackingIssue: 1, trackingUrl: `https://github.com/${repository}/issues/1`, purpose: `Purpose of ${id}`,
  control: 'registered', controllerLive: true, livenessDefect: false, leaseExpiresAt: null, blocker: null, tasks: [], agents: [], lastProgressAt: null, ...extra });
const lapsed = (minutes) => ({ controllerLive: false, leaseExpiresAt: new Date(NOW - minutes * 60_000).toISOString() });
const decision = (id, repository) => ({ id, title: `${id} title`, outcome: `${id} outcome`, state: 'pending', resultUrl: null, dependsOn: [], attempts: 1,
  verifierRejections: 0, blocked: 'B3', blockedReason: 'owner-reserved decision; see the task issue', issueUrl: `https://github.com/${repository}/issues/9` });

test('F6: a project counts on Projects exactly what Needs me lists under it, on the data and on the page', async (t) => {
  const { supervisor, owner } = await review(t);
  const { projects } = projectsView(supervisor, owner, { repositories: PROJECTS });
  for (const project of projects) {
    const group = owner.groups.find((item) => item.project?.toLowerCase() === project.repository.toLowerCase());
    assert.equal(project.details.needsYou, group?.count ?? 0, `${project.id}: Projects and Needs me give one number`);
    assert.equal(project.state.key === 'needs-you', Boolean(group?.count), project.id);
  }
  // notes-site holds the supervisor fault, which is listed under AIWorks itself: Projects does not count it either.
  const notes = owner.groups.find((group) => group.project === 'example/notes-site');
  assert.ok(owner.items.some((item) => item.system && item.about === 'example/notes-site'), 'the fixture has a fault about notes-site');
  const page = await openPage(t);
  await page.go('#/projects');
  assert.ok(screen(page).includes(`${notes.count} things need you. See all ${notes.count} in Needs me`), screen(page));
  await page.go('#/needs');
  assert.ok(screen(page).includes(`notes-site (${notes.count})`), screen(page));
});

test('F9: AIWorks stopped on this computer is one Needs me item for all the work it holds up, under AIWorks itself', async (t) => {
  // AIWorks itself stopped is the stopped store: no lease is live (review 4 F2; the full store's AIWorks runs).
  const { owner } = await review(t, 'stopped');
  const stops = owner.items.filter((item) => item.kind === 'controller' && !item.system);
  assert.equal(stops.length, 1, JSON.stringify(stops.map((item) => item.text)));
  const [stop] = stops;
  assert.deepEqual([stop.repository, stop.campaignId, stop.text], [null, null, 'AIWorks stopped on this computer']);
  assert.deepEqual(owner.groups.at(-1).name, SYSTEM_GROUP);
  assert.ok(owner.groups.at(-1).items.includes(stop), 'listed once, under AIWorks itself');
  // It names the work it holds up, and what the pause means for the paused one.
  for (const state of ['supervisor-stopped', 'paused-supervisor-stopped']) {
    assert.equal(owner.campaigns[REVIEW_STATES[state].campaignId].liveness, 'stopped', state);
  }
  const held = stop.points.map((point) => point.text).find((text) => text.startsWith('Held up in notes-site: '));
  assert.match(held, /“Archive old notes”/);
  assert.match(held, /“Tag notes” \(paused; it can’t resume until AIWorks runs again\)/);
  // While AIWorks runs (the full store), the same two pieces of work are each their own item under notes-site.
  const running = (await review(t)).owner;
  assert.equal(running.items.filter((item) => item.kind === 'controller' && !item.system).length, 0);
  assert.deepEqual(running.items.filter((item) => item.kind === 'unattended').map((item) => [item.campaignId, item.repository]).sort(),
    [['notes-archive', 'example/notes-site'], ['notes-tags', 'example/notes-site']]);
  // Several projects: still one item, one line per project; the restart advice is said once.
  const view = ownerView({ available: true, coordinator: null, recent: null, campaigns: [
    campaign('notes-a', 'example/notes', lapsed(60)), campaign('notes-b', 'example/notes', { ...lapsed(60), control: 'paused' }),
    campaign('shop-a', 'example/shop', lapsed(30)), campaign('shop-b', 'example/shop', { controllerLive: false, leaseExpiresAt: null, registeredAt: NOW - 60 * 60_000 }),
  ] }, undefined, { now: NOW });
  assert.equal(view.items.length, 1);
  assert.deepEqual(view.items[0].points.map((point) => point.text).slice(1), [
    'Held up in notes: “Purpose of notes-a”, “Purpose of notes-b” (paused; it can’t resume until AIWorks runs again).',
    'Held up in shop: “Purpose of shop-a”, “Purpose of shop-b” (not picked up yet).']);
  assert.equal(view.items[0].points.filter((point) => /restart it on this computer/.test(point.text)).length, 1);
  assert.equal(view.items[0].at, NOW - 30 * 60_000, 'the last time AIWorks checked in');
  assert.deepEqual([view.headline, view.groups.map((group) => [group.name, group.count])], ['Needs you (1)', [[SYSTEM_GROUP, 1]]]);
});

test('F17: "AIWorks itself" counts toward Needs you only when it holds an owner action', async (t) => {
  // A supervisor fault and an unreadable inbox say they are not the owner's: listed, never counted.
  const only = ownerView({ available: true, recent: null, campaigns: [campaign('shop-fault', 'example/shop', { livenessDefect: true })],
    coordinator: { configError: 'coordinator.reportTo is missing', blocked: null, messages: [] } }, undefined, { now: NOW });
  assert.deepEqual([only.headline, only.count], ['No work is blocked on you right now', 0]);
  assert.deepEqual(only.groups.map((group) => [group.name, group.count, group.notCounted]), [[SYSTEM_GROUP, 0, 2]]);
  // With an owner action of its own (AIWorks stopped), that one is counted, and the rest still is not.
  // Every lease lapsed, so AIWorks itself stopped (review 4 F2: one live lease would mean it runs).
  const both = ownerView({ available: true, recent: null, coordinator: null, campaigns: [campaign('shop-fault', 'example/shop', { livenessDefect: true, ...lapsed(60) }),
    campaign('notes', 'example/notes', { ...lapsed(60), tasks: [decision('N1', 'example/notes')] })] }, undefined, { now: NOW });
  assert.deepEqual([both.headline, both.groups.map((group) => [group.name, group.count, group.notCounted])],
    ['Needs you (2)', [['notes', 1, 0], [SYSTEM_GROUP, 1, 1]]]);
  // The review fixture: the headline, the group headings and the global count all leave the fault out.
  const { owner } = await review(t);
  const actions = owner.items.filter((item) => !item.system).length;
  assert.ok(owner.items.length > actions, 'the fixture lists a fault that is not an owner action');
  assert.equal(owner.headline, `Needs you (${actions})`);
  const page = await openPage(t);
  await page.go('#/needs');
  const text = screen(page);
  assert.ok(text.includes(`Needs you (${actions})`), text);
  // AIWorks runs in the full store, so "AIWorks itself" holds no owner action, only the fault (review 4 F2).
  assert.ok(text.includes(`${SYSTEM_GROUP} · 1 item for its maintainers, not counted`), text);
  assert.equal(page.$('#needs-count').textContent, String(actions));
});

test('F16: with several pieces of work, Now leads with what needs the owner, or its Resume', async (t) => {
  const data = await review(t);
  const now = (project) => nowView(project, { ...data, host: { name: 'review-pc' } }, { now: data.now }).state;
  // recipes: nothing waits on the owner, and a paused piece of work AIWorks runs can be resumed: Resume leads.
  const recipes = now('example/recipes');
  assert.deepEqual([recipes.key, recipes.primary], ['paused', { label: 'Resume', command: 'resume', campaignId: REVIEW_STATES.paused.campaignId }]);
  // notes-site: its Needs me items lead, with the count its Needs me group shows, not the paused and stopped "Tag notes".
  const notes = now('example/notes-site'), group = data.owner.groups.find((item) => item.project === 'example/notes-site');
  assert.deepEqual([notes.key, notes.title], ['several', `${group.count} things need you.`]);
  // shop-app: its Needs me items lead too.
  assert.equal(now('example/shop-app').needsYou, true);
  // On the page: recipes' Now shows the pause and its Resume button.
  const page = await openPage(t);
  await page.go(address('example/recipes'));
  assert.match(screen(page), /Paused since .*\. No new step starts\. .* Resume/);
  // Synthetic: work running by itself does not hide a pause the owner can resume, nor a stopped AIWorks the owner must
  // restart; the owner's own items lead over both.
  const working = campaign('build', 'example/app', { tasks: [{ id: 'T1', title: 'build', outcome: 'Build it', state: 'implementing', dependsOn: [] }],
    agents: [{ taskId: 'T1', role: 'Implementer', executor: 'claude-cli', startedAt: NOW - 60_000, progress: { lastActivityAt: NOW - 30_000 } }] });
  const paused = campaign('pause', 'example/app', { control: 'paused', pausedAt: NOW - 3600_000, pausedReason: 'Later' });
  const stopped = campaign('stop', 'example/app', lapsed(60));
  const blocked = campaign('block', 'example/app', { tasks: [decision('D1', 'example/app')] });
  const lead = (...campaigns) => {
    const supervisor = { available: true, coordinator: null, recent: null, campaigns };
    return nowView('example/app', { supervisor, owner: ownerView(supervisor, undefined, { now: NOW }) }, { now: NOW }).state.key;
  };
  assert.equal(lead(working), 'builder-working');
  assert.equal(lead(working, paused), 'paused');
  // AIWorks runs (a live lease), so the lapsed work is its own owner item, which leads (review 4 F2).
  assert.equal(lead(working, stopped), 'work-lapsed');
  assert.equal(lead(working, paused, stopped), 'work-lapsed');
  assert.equal(lead(working, stopped, paused, blocked), 'several');
  // No lease is live: AIWorks itself stopped, and the owner's own items still lead over it.
  assert.equal(lead(stopped), 'supervisor-stopped');
  assert.equal(lead(stopped, { ...blocked, ...lapsed(60) }), 'needs-decision');
});
