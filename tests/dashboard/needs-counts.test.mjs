// Needs me lists only owner decisions, and its counts agree (aiworks#11, UX-002 review of the owner dashboard at
// 96ed590, findings F6, F9, F16 and F17). A project's count on Projects is its Needs me group's count; AIWorks stopped on
// this computer is one item, not one per piece of work; "AIWorks itself" counts toward Needs you only for an owner
// action; a project's Now leads with what needs the owner, or its Resume. The review fixture through the real dashboard
// server (tests/dashboard/fixtures/page.mjs) and synthetic snapshots; local git and a loopback server only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/supervisor/store.mjs';
import { createProject } from '../../src/supervisor/projects.mjs';
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
  // It holds up work in several projects, so AIWorks itself leads Needs me, with it at the top (review 4 F5).
  assert.ok(stop.holdsUp.length > 1, JSON.stringify(stop.holdsUp));
  assert.deepEqual(owner.groups[0].name, SYSTEM_GROUP);
  assert.equal(owner.groups[0].items[0], stop, 'listed once, under AIWorks itself, first');
  assert.equal(owner.items.filter((item) => item === stop).length, 1);
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
  assert.equal(view.items[0].points.filter((point) => /sign out of this computer and sign in again/.test(point.text)).length, 1);
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

test('F3: while a merge check runs, the Needs me count and each project state read as partial, then final once it ends', async (t) => {
  // The dashboard's first answer, before any merge check finished (review 4: "Needs me 7" and shop-app "Running", then 10).
  let merges = { refreshing: true, repositories: [], steps: {} };
  const page = await openPage(t, { server: { merges: { refresh: () => {}, snapshot: () => merges } } });
  const views = () => {
    const now = Date.now(), supervisor = supervisorSnapshot(page.dataDir, now), owner = ownerView(supervisor, merges, { host: 'review-pc', now });
    return { owner, projects: projectsView(supervisor, owner, { repositories: PROJECTS, now }).projects };
  };
  /** A project's state never contradicts its Needs me items, and never reads final while its results are unknown. */
  const agree = ({ owner, projects }) => {
    for (const project of projects) {
      const group = owner.groups.find((item) => item.project?.toLowerCase() === project.repository.toLowerCase());
      assert.equal(project.state.key === 'needs-you', Boolean(group?.count), `${project.id}: ${project.state.text}`);
      assert.equal(project.details.needsYou, group?.count ?? 0, project.id);
      if (project.details.checking) {
        assert.ok(!['running', 'finished', 'cancelled', 'no-work'].includes(project.state.key), `${project.id}: ${project.state.key}`);
        assert.match(project.state.text, new RegExp(`Checking GitHub… The state of ${project.details.checking} results? is not known yet\.$`), project.id);
      } else assert.doesNotMatch(project.state.text, /Checking GitHub/, project.id);
    }
  };
  const first = views();
  assert.ok(first.owner.unknownResults > 0 && first.owner.count > 0, 'the fixture has owner items and results not checked yet');
  agree(first);
  const checking = first.projects.filter((project) => project.details.checking);
  assert.ok(checking.length > 1, 'several projects wait for the check');
  const shop = first.projects.find((project) => project.id === 'example/shop-app');
  assert.ok(shop.details.checking && shop.state.key !== 'running', `shop-app never reads merely Running: ${shop.state.key}`);
  // On first load the global count is partial, never the confirmed number alone.
  assert.equal(page.$('#needs-count').textContent, `${first.owner.count} + checking`);
  await page.go('#/projects');
  for (const project of checking) assert.ok(screen(page).includes(project.state.text), `${project.id}: ${screen(page)}`);
  // "Nothing changed" is never said while what merged is not known yet.
  assert.doesNotMatch(screen(page), /Nothing changed/);

  // The check ends: the final count, and every project state final.
  const watcher = new MergeWatcher({ steps: () => publishedSteps(page.dataDir), checkouts: configuredCheckouts(page.dataDir), git: configuredGitCommand(page.dataDir) });
  await watcher.refresh();
  merges = watcher.snapshot();
  const final = views();
  assert.equal(final.owner.unknownResults, 0);
  assert.ok(final.owner.count > first.owner.count, `${first.owner.count} then ${final.owner.count}`);
  agree(final);
  assert.ok(final.projects.every((project) => !project.details.checking));
  await page.refresh();
  assert.equal(page.$('#needs-count').textContent, String(final.owner.count));
  assert.doesNotMatch(screen(page), /Checking GitHub/);
});

test('F5: an AIWorks itself item that holds up several projects leads Needs me; one that holds up one project stays last', async (t) => {
  const two = ownerView({ available: true, coordinator: { configError: 'coordinator.reportTo is missing', blocked: null, messages: [] }, recent: null, campaigns: [
    campaign('notes-a', 'example/notes', { ...lapsed(60), tasks: [decision('N1', 'example/notes')] }), campaign('shop-a', 'example/shop', lapsed(30)),
    campaign('shop-fault', 'example/shop', { livenessDefect: true, ...lapsed(60) })] }, undefined, { now: NOW });
  assert.deepEqual(two.groups.map((group) => [group.name, group.items.map((item) => item.kind)]),
    [[SYSTEM_GROUP, ['controller', 'controller', 'coordinator']], ['notes', ['decision']]]);
  assert.deepEqual(two.groups[0].items[0].holdsUp, ['example/notes', 'example/shop']);
  // Grouping only: the same items and counts.
  assert.deepEqual([two.headline, two.groups.reduce((n, group) => n + group.count, 0)], ['Needs you (2)', 2]);
  const one = ownerView({ available: true, coordinator: null, recent: null, campaigns: [
    campaign('notes-a', 'example/notes', { ...lapsed(60), tasks: [decision('N1', 'example/notes')] })] }, undefined, { now: NOW });
  assert.deepEqual(one.groups.map((group) => group.name), ['notes', SYSTEM_GROUP]);
  // On the page (the stopped store): AIWorks itself is the first group heading, before every project.
  const page = await openPage(t, { store: 'stopped' });
  await page.go('#/needs');
  const headings = page.document.querySelectorAll('.needs-group h3').map((heading) => visibleText(heading));
  assert.ok(headings[0].startsWith(SYSTEM_GROUP), JSON.stringify(headings));
  assert.ok(headings.length > 1 && headings.slice(1).every((heading) => !heading.startsWith(SYSTEM_GROUP)), JSON.stringify(headings));
});

// aiworks#11 review 5 G5 (and review 4 F14): a project's Now answers "Where are we now?" for the whole project. The
// owner's items lead, but running work, possibly stuck work and a pause with its Resume stay in view, on Now and in
// short on the project's row.
test('G5 and F14: beside Needs me items, Now and the Projects row keep running, possibly stuck and paused work in view', async (t) => {
  const step = (id, outcome) => ({ id, title: id, outcome, state: 'implementing', dependsOn: [] });
  const agent = (taskId, minutesAgo) => ({ taskId, role: 'Implementer', executor: 'claude-cli', startedAt: NOW - 600 * 60_000, progress: { lastActivityAt: NOW - minutesAgo * 60_000 } });
  const busy = campaign('shop-import', 'example/shop-app', { tasks: [step('T1', 'Import supplier contracts'), step('T2', 'Checkout form'), decision('D1', 'example/shop-app')],
    agents: [agent('T1', 1), agent('T2', 565)] });
  const paused = campaign('shop-search', 'example/shop-app', { control: 'paused', pausedAt: NOW - 3600_000, pausedReason: 'Paused for an update on this computer', controls: { primary: 'resume' } });
  const supervisor = { available: true, coordinator: null, recent: null, campaigns: [busy, paused] };
  const owner = ownerView(supervisor, undefined, { now: NOW });
  assert.equal(owner.groups.find((group) => group.project === 'example/shop-app').count, 1, 'one Needs me item: the decision');
  const now = nowView('example/shop-app', { supervisor, owner }, { now: NOW });
  assert.equal(now.state.needsYou, true, 'the owner’s item still leads');
  assert.deepEqual(now.also.map((line) => [line.kind, line.workId, line.primary]), [
    ['possibly-stuck', 'shop-import', null],
    ['paused', 'shop-search', { label: 'Resume', command: 'resume', campaignId: 'shop-search' }],
    ['working', 'shop-import', null]]);
  const [stuck, pause, working] = now.also;
  assert.equal(stuck.text, `${owner.campaigns['shop-import'].purpose.text} · Possibly stuck: Checkout form has made no progress for 565 minutes.`);
  assert.match(pause.text, /^.+ · Paused since .+\.$/);
  assert.equal(working.title, 'Working on: Import supplier contracts.');
  // The Projects row: Needs me leads, and what Now keeps in view follows in short.
  const row = projectsView(supervisor, owner, { now: NOW }).projects.find((project) => project.id === 'example/shop-app');
  assert.deepEqual(row.state, { key: 'needs-you',
    text: 'One thing needs you. Also: 1 AI worker possibly stuck · 1 piece of work paused, with Resume on Now · 1 AI worker working.' });
  // What Now leads with is not said twice: with no item, the pause leads and the workers follow.
  const calm = { ...busy, tasks: busy.tasks.filter((task) => !task.blocked) }, lead = { available: true, coordinator: null, recent: null, campaigns: [calm, paused] };
  const view = nowView('example/shop-app', { supervisor: lead, owner: ownerView(lead, undefined, { now: NOW }) }, { now: NOW });
  assert.deepEqual([view.state.key, ...view.also.map((line) => line.kind)], ['paused', 'possibly-stuck', 'working']);
  // Work AIWorks is not checking on is its own item, not a line here.
  const away = { available: true, coordinator: null, recent: null, campaigns: [{ ...calm, ...lapsed(60) }, paused] };
  assert.deepEqual(nowView('example/shop-app', { supervisor: away, owner: ownerView(away, undefined, { now: NOW }) }, { now: NOW }).also.map((line) => line.kind), ['paused']);
  // On the page, shop-app's items lead its Now, and its possibly stuck worker is in view below them.
  const page = await openPage(t);
  await page.go(address('example/shop-app'));
  assert.match(screen(page), /Also in this project.*Possibly stuck: .+ has made no progress for \d+ minutes\./s, screen(page));
});

// aiworks#11 review 5 G7: Needs me never gives an all-clear while an owner decision holds a project. A project without
// GitHub waits for two decisions (D2, D4) before work can start: no work is blocked, so it is no counted item, but the
// calm headline names it and a row links to its Now.
test('G7: with one project waiting for the owner’s decisions and no work, Needs me names that project', async (t) => {
  const empty = { available: true, coordinator: null, recent: null, campaigns: [] };
  const local = { id: 'recipes-local', name: 'Recipes', source_kind: 'local-git', status: 'ready', capabilities: { startWork: { allowed: false, reason: 'LOCAL_START_OFF' } } };
  assert.equal(ownerView(empty, undefined, { now: NOW }).headline, 'No work is blocked on you right now');
  const owner = ownerView(empty, undefined, { now: NOW, connected: [local] });
  assert.equal(owner.count, 0, 'no work is blocked, so nothing is counted');
  assert.equal(owner.headline, 'No work is blocked on you right now, but Recipes waits for your decisions before work can start');
  assert.deepEqual(owner.held, [{ id: 'recipes-local', name: 'Recipes', text: 'Can’t start work until your decisions are made. Its Now says which, and where each is made.' }]);
  assert.equal(ownerView(empty, undefined, { now: NOW, connected: [local, { ...local, id: 'notes', name: 'Notes', source_kind: 'folder' }] }).headline,
    'No work is blocked on you right now, but 2 projects wait for your decisions before work can start');
  // Setup problems are said on Projects and Now (§4.2), and a project where work can start waits for nothing.
  const other = ownerView(empty, undefined, { now: NOW, connected: [{ ...local, status: 'needs-setup' },
    { ...local, id: 'shop', source_kind: 'github', capabilities: { startWork: { allowed: true } } }] });
  assert.deepEqual([other.headline, other.held], ['No work is blocked on you right now', []]);
  // Through the dashboard server and on the page: a connected Local Git project and no work.
  const page = await openPage(t, { store: 'empty' });
  const config = JSON.parse(readFileSync(join(page.dataDir, 'config.json'), 'utf8'));
  writeFileSync(join(page.dataDir, 'config.json'), JSON.stringify({ ...config, projectConnection: { enabled: true } }));
  const store = new Store(join(page.dataDir, 'supervisor.db'));
  try {
    createProject(store, { id: 'recipes-local', tenant_id: 'local', name: 'Recipes', source_kind: 'local-git', root_path: join(page.dataDir, 'Recipes'), local_branch: 'main',
      status: 'ready', capabilities: { plan: { allowed: true }, startWork: { allowed: false, reason: 'LOCAL_START_OFF' }, publish: { allowed: false, reason: 'NO_GITHUB' } } }, NOW);
  } finally { store.close(); }
  await page.refresh();
  await page.go('#/needs');
  const text = screen(page);
  assert.match(text, /No work is blocked on you right now, but Recipes waits for your decisions before work can start/, text);
  assert.match(text, /Recipes · Can’t start work until your decisions are made\. Its Now says which, and where each is made\. Open Recipes/, text);
  assert.doesNotMatch(text, /No work is blocked on you right now(?!, but)/, 'never the bare all-clear');
});

// aiworks#11 review 5 G11: Now's progress counts the whole project, as Results does, and says so with several pieces of
// work, so the two screens never give two numbers for one question.
test('G11: Now’s progress counts what Results counts, and names it with several pieces of work', async (t) => {
  const data = await review(t);
  for (const project of PROJECTS) {
    const view = nowView(project, { ...data, host: { name: 'review-pc' } }, { now: data.now });
    const groups = data.owner.results[project.toLowerCase()]?.groups ?? [];
    const count = (key) => groups.find((group) => group.key === key)?.count ?? 0;
    const several = data.supervisor.campaigns.filter((c) => c.repository === project).length > 1;
    assert.equal(view.progress.startsWith('All work in this project: '), several, `${project}: ${view.progress}`);
    const awaiting = Number(/(\d+) waiting for your review/.exec(view.progress)?.[1] ?? 0);
    const merged = Number(/(\d+) merged/.exec(view.progress)?.[1] ?? 0);
    assert.deepEqual([awaiting, merged], [count('review'), count('merged')], `${project}: Now “${view.progress}” and Results agree`);
    const results = /(\d+) of \d+ steps? ha(?:s|ve) results/.exec(view.progress)?.[1];
    assert.equal(Number(results), data.owner.results[project.toLowerCase()]?.total ?? 0, `${project}: steps with results, as Results counts them`);
  }
});
