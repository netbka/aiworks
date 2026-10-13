// Projects from today's data (docs/design/OWNER_WORKSPACE.md slice S2, build slice UI3, resolution C5): one row per
// repository with work or configuration, grouped case-insensitively, each with one state and one action; projects that
// need the owner first, then those with work running, then the rest. A configured repository with no work reads "No work
// yet". No campaign id at the primary level, and a project's state never contradicts its Needs me items.
// Disposable stores and synthetic merge state only; no network, model or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { declaration } from '../supervisor/helpers.mjs';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { ownerView, RESTART_GRACE_MS } from '../../src/dashboard/owner.mjs';
import { configuredRepositories, projectsView } from '../../src/dashboard/projects.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const task = (id, title, extra = {}) => ({ id, issue: 437 + Number(id.slice(1)), title, deliverable: 'commit', goal: `${title}.`, dependsOn: [], acceptance: ['a'], references: ['AGENTS.md'], ...extra });
const sha = (taskId) => taskId.replace(/\D/g, '').padStart(40, 'a');

/** A disposable supervisor directory with a store and, when given, a config.json listing `repositories`. */
function fixture(t, repositories = null) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-projects-'));
  const store = new Store(join(dataDir, 'supervisor.db'));
  if (repositories) writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ repositories }));
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const start = (campaignId, repository, tasks, registeredAt = Date.now()) => {
    const d = declaration({ campaignId, tasks: tasks ?? [task('T1', `${campaignId} step`)] });
    d.target.repository = repository;
    campaignStart(store, d, registeredAt);
    return d;
  };
  const finish = (campaignId, taskId, url, extra = {}) => {
    const row = store.task(campaignId, taskId);
    store.patch('tasks', { campaign_id: campaignId, task_id: taskId }, row.version, { state: 'done', pr_url: url, ...extra }, Date.now());
  };
  const close = (campaignId, control = 'finished') => {
    const c = store.campaign(campaignId);
    store.patch('campaigns', { id: campaignId }, c.version, { control, status: 'ready' }, Date.now());
  };
  return { dataDir, store, start, finish, close };
}

/** The owner view and the Projects screen exactly as /api/state builds them. */
function view(dataDir, merges = { repositories: [], steps: {} }) {
  const supervisor = supervisorSnapshot(dataDir), owner = ownerView(supervisor, merges);
  return { supervisor, owner, projects: projectsView(supervisor, owner, { repositories: configuredRepositories(dataDir) }) };
}

/** Every project's state agrees with Needs me: "needs you" exactly when Needs me lists an item for its repository. */
function assertAgreesWithNeedsMe({ owner, projects }) {
  for (const project of projects.projects) {
    const items = owner.items.filter((item) => item.repository?.toLowerCase() === project.repository.toLowerCase()).length;
    assert.equal(project.details.needsYou, items, project.id);
    assert.equal(project.state.key === 'needs-you', items > 0, `${project.id}: ${project.state.text}`);
  }
  assert.equal(projects.projects.reduce((n, project) => n + project.details.needsYou, 0), owner.items.filter((item) => item.repository).length,
    'every Needs me item about a repository belongs to exactly one project');
  // The same number as the project's own group on Needs me (aiworks#11 review F6).
  for (const project of projects.projects) {
    const group = owner.groups.find((item) => item.project?.toLowerCase() === project.repository.toLowerCase());
    assert.equal(project.details.needsYou, group?.count ?? 0, `${project.id} counts what its Needs me group counts`);
  }
}

test('one row per repository, grouped case-insensitively; the configured spelling names it', (t) => {
  const { dataDir, start } = fixture(t, { 'example-org/sampleapp': { path: 'C:/work/sampleapp' } });
  start('sampleapp-443-waves', 'example-org/sampleapp');
  start('sampleapp-455-telegram-ingest', 'EXAMPLE-ORG/SAMPLEAPP');
  start('shop-checkout', 'example/shop-app');
  const { projects } = view(dataDir);
  assert.equal(projects.available, true);
  assert.deepEqual(projects.projects.map((project) => project.id).sort(), ['example-org/sampleapp', 'example/shop-app']);
  const sampleapp = projects.projects.find((project) => project.id === 'example-org/sampleapp');
  assert.deepEqual([sampleapp.name, sampleapp.kind, sampleapp.details], ['sampleapp', 'GitHub', { owner: 'example-org', work: 2, configured: true, needsYou: 0 }]);
  const shop = projects.projects.find((project) => project.id === 'example/shop-app');
  assert.deepEqual([shop.name, shop.details.configured, shop.details.work], ['shop-app', false, 1], 'work without configuration is still a project');
});

test('without configuration, the first campaign’s spelling names the project; two owners of one name keep the owner', () => {
  const snapshot = { available: true, campaigns: [
    { id: 'a', repository: 'example-org/sampleapp', control: 'finished', tasks: [], agents: [] },
    { id: 'b', repository: 'EXAMPLE-ORG/SAMPLEAPP', control: 'finished', tasks: [], agents: [] },
    { id: 'c', repository: 'example/sampleapp', control: 'finished', tasks: [], agents: [] }] };
  const { projects } = projectsView(snapshot, { items: [], campaigns: {} });
  assert.deepEqual(projects.map((project) => [project.id, project.name, project.details.work]).sort(),
    [['example-org/sampleapp', 'example-org/sampleapp', 2], ['example/sampleapp', 'example/sampleapp', 1]]);
});

test('order: needs you, then work running, then the rest by last activity; one state and one action each', (t) => {
  const old = Date.now() - RESTART_GRACE_MS - 60_000;
  const { dataDir, start, finish, close } = fixture(t, { 'example/notes-site': { path: 'C:/work/notes' }, 'example/recipes': { path: 'C:/work/recipes' } });
  // Finished: every step is a posted report, so nothing waits for the owner.
  start('recipes-units', 'example/recipes', [task('T1', 'unit report', { deliverable: 'report' })], old - 60_000);
  finish('recipes-units', 'T1', 'https://github.com/example/recipes/issues/438#issuecomment-1');
  close('recipes-units');
  // Running: registered just now, so AIWorks still has its grace to pick it up (nothing for the owner yet).
  start('shop-checkout', 'example/shop-app');
  // Needs you: a published pull request the current merge check does not see merged.
  start('sampleapp-443-waves', 'example-org/sampleapp', [task('T1', 'waves', { outcome: 'Telegram waves are sent once' })]);
  finish('sampleapp-443-waves', 'T1', 'https://github.com/example-org/sampleapp/pull/465', { verified_sha: sha('T1') });
  const merges = { repositories: [{ repository: 'example-org/sampleapp', configured: true, fetchedAt: Date.now(), attemptedAt: Date.now(), error: null }],
    steps: { 'sampleapp-443-waves/T1': { sha: sha('T1'), baseBranch: 'main', merged: false, mergedAt: null } } };
  const seen = view(dataDir, merges);
  assert.deepEqual(seen.projects.projects.map((project) => [project.id, project.state.key]), [
    ['example-org/sampleapp', 'needs-you'], ['example/shop-app', 'running'], ['example/recipes', 'finished'], ['example/notes-site', 'no-work']]);
  const [sampleapp, shop, recipes, notes] = seen.projects.projects;
  assert.deepEqual([sampleapp.state.text, sampleapp.action], ['One thing needs you.', { label: 'Review pull request #465', url: 'https://github.com/example-org/sampleapp/pull/465' }]);
  assert.deepEqual([shop.state.text, shop.action], ['No AI worker is busy on this project right now.',
    { label: 'Open current work', route: { screen: 'project', project: 'example/shop-app', tab: 'work' } }]);
  assert.deepEqual([recipes.state.text, recipes.action], ['All steps are finished · 1 report posted for you to read.',
    { label: 'See results', route: { screen: 'project', project: 'example/recipes', tab: 'results' } }]);
  // Each project has exactly one state and one action, never a list of either.
  for (const project of seen.projects.projects) {
    assert.deepEqual(Object.keys(project.state).sort(), ['key', 'text']);
    assert.equal(typeof project.state.text, 'string');
    assert.equal(typeof project.action.label, 'string');
    assert.equal(Boolean(project.action.url) !== Boolean(project.action.route), true, `${project.id}: one link or one screen`);
  }
  assertAgreesWithNeedsMe(seen);
  // A stopped supervisor is one fact about this computer, listed once under AIWorks itself (review F9): no project counts it.
  start('notes-search', 'example/notes-site', null, old);
  const stopped = view(dataDir, merges);
  assertAgreesWithNeedsMe(stopped);
  assert.deepEqual(stopped.owner.groups.map((group) => [group.name, group.count]), [['sampleapp', 1], ['AIWorks itself', 1]]);
  assert.deepEqual(stopped.projects.projects.map((project) => [project.id, project.state.key, project.details.needsYou]).slice(0, 2),
    [['example-org/sampleapp', 'needs-you', 1], ['example/shop-app', 'running', 0]]);
});

test('a configured repository with no work shows "No work yet" and opens the project', (t) => {
  const { dataDir } = fixture(t, { 'example/notes-site': { path: 'C:/work/notes' }, 'not a repository': { path: 'C:/x' } });
  const { projects } = view(dataDir);
  assert.deepEqual(projects.projects, [{ id: 'example/notes-site', name: 'notes-site', repository: 'example/notes-site', kind: 'GitHub',
    state: { key: 'no-work', text: 'No work yet.' }, action: { label: 'Open project', route: { screen: 'project', project: 'example/notes-site', tab: 'now' } },
    lastActivityAt: null, details: { owner: 'example', work: 0, configured: true, needsYou: 0 } }]);
  // Names only: a missing, unreadable or odd config lists nothing and never fails the screen.
  const empty = mkdtempSync(join(tmpdir(), 'aiworks-projects-config-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.deepEqual(configuredRepositories(empty), []);
  for (const content of ['{', '[]', '{"repositories":["example-org/sampleapp"]}', '{"repositories":null}']) {
    writeFileSync(join(empty, 'config.json'), content);
    assert.deepEqual(configuredRepositories(empty), [], content);
  }
});

test('running work says who is working on which step; paused and cancelled work are not running', () => {
  const tasks = [{ id: 'T1', title: 'checkout', outcome: 'Checkout takes a card' }, { id: 'T2', title: 'reviews', outcome: null }];
  const campaign = (id, repository, extra) => ({ id, repository, control: 'registered', tasks, agents: [], ...extra });
  const snapshot = { available: true, campaigns: [
    campaign('shop-checkout', 'example/shop-app', { agents: [{ role: 'Implementer', taskId: 'T1' }] }),
    campaign('notes-reviews', 'example/notes-site', { agents: [{ role: 'Verifier', taskId: 'T2' }] }),
    campaign('recipes-tags', 'example/recipes', { waitingReason: 'provider-availability' }),
    campaign('blog-import', 'example/blog', { control: 'paused', lastProgressAt: new Date(Date.now() - 1000).toISOString() }),
    campaign('wiki-print', 'example/wiki', { control: 'cancelled', lastProgressAt: new Date(Date.now() - 2000).toISOString() })] };
  const owner = { items: [], campaigns: { 'wiki-print': { outcome: 'Cancelled · 0 of 2 steps delivered' } } };
  const states = Object.fromEntries(projectsView(snapshot, owner).projects.map((project) => [project.id, [project.state.key, project.state.text]]));
  assert.deepEqual(states, {
    'example/shop-app': ['running', 'Working on: Checkout takes a card.'],
    'example/notes-site': ['running', 'Checking: reviews.'],
    'example/recipes': ['running', 'Waiting for an AI worker to be free. Work continues by itself.'],
    'example/blog': ['paused', 'Paused. No new step starts.'],
    'example/wiki': ['cancelled', 'Cancelled · 0 of 2 steps delivered.'] });
  assert.deepEqual(projectsView(snapshot, owner).projects.slice(3).map((project) => project.id), ['example/blog', 'example/wiki'], 'the rest by last activity');
  // Several items: one action, to Needs me, which lists them all.
  const many = projectsView(snapshot, { items: [{ repository: 'example/blog', link: null }, { repository: 'EXAMPLE/BLOG', link: { url: 'https://github.com/example/blog/pull/3' } }], campaigns: {} });
  const blog = many.projects[0];
  assert.deepEqual([blog.id, blog.state.text, blog.action], ['example/blog', '2 things need you.', { label: 'See all 2 in Needs me', route: { screen: 'needs' } }]);
});

test('no campaign id at the primary level: name, state and action never show one', (t) => {
  const old = Date.now() - RESTART_GRACE_MS - 60_000;
  const { dataDir, start, finish, close } = fixture(t, { 'example/notes-site': { path: 'C:/work/notes' } });
  start('sampleapp-443-waves', 'example-org/sampleapp', [task('T1', 'waves')], old);
  start('notes-search', 'example/notes-site');
  start('recipes-print', 'example/recipes', [task('T1', 'print'), task('T2', 'share')]);
  finish('recipes-print', 'T1', 'https://github.com/example/recipes/pull/7', { verified_sha: sha('T1') });
  close('recipes-print', 'cancelled');
  start('shop-search', 'example/shop-app', [task('T1', 'search', { deliverable: 'report' })]);
  finish('shop-search', 'T1', 'https://github.com/example/shop-app/issues/438#issuecomment-1');
  close('shop-search');
  const seen = view(dataDir);
  assert.equal(seen.projects.projects.length, 4);
  const ids = seen.supervisor.campaigns.map((c) => c.id);
  for (const project of seen.projects.projects) {
    for (const text of [project.name, project.state.text, project.action.label]) {
      for (const id of ids) assert.ok(!text.includes(id), `${project.id} shows campaign ${id}: ${text}`);
    }
  }
  assertAgreesWithNeedsMe(seen);
});

test('an unreadable supervisor store lists no projects rather than calm ones', () => {
  assert.deepEqual(projectsView({ available: false, campaigns: [] }, { items: [] }, { repositories: ['example-org/sampleapp'] }), { available: false, projects: [] });
});

test('/api/state carries the Projects screen, with repository names and never a configured path', async (t) => {
  const { dataDir, start } = fixture(t, { 'example/notes-site': { path: join(tmpdir(), 'secret-checkout-path') } });
  start('shop-checkout', 'example/shop-app');
  const roadmap = { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) };
  const server = createDashboardServer({ dataDir, roadmap, host: { name: 'TestPc', revision: 'abc1234def56' } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/state`)).text();
  const state = JSON.parse(body);
  assert.equal(state.projects.available, true);
  assert.deepEqual(state.projects.projects.map((project) => [project.id, project.state.key]), [['example/shop-app', 'running'], ['example/notes-site', 'no-work']]);
  assert.ok(!body.includes('secret-checkout-path'), 'the configured checkout path is never served');
});

test('the page draws Projects from the server’s list: one state in words and one action per row', () => {
  const js = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  const screen = /function projectsScreen\(\) \{[\s\S]*?\n\}/.exec(js)[0];
  assert.match(js, /const projectList = \(\) => state\.projects\?\.projects \?\? \[\];/);
  assert.match(screen, /project\.state\.text/);
  assert.equal(screen.match(/projectAction\(/g).length, 1, 'one action per row');
  assert.match(screen, /badge\(stateTones\[project\.state\.key\] \?\? 'unknown', stateWords\[project\.state\.key\] \?\? 'Not known'\)/, 'the state has its word, not colour alone');
  assert.doesNotMatch(screen, /\.campaignId|c\.id\b/, 'no campaign id at the primary level');
  // OWNER_WORKSPACE §7.1, before Add project exists.
  assert.match(screen, /'No projects yet\.', 'Projects appear here when the AIWorks configuration file on this computer lists a repository\. Adding a project from this page is not built yet\.'/);
  // A project address in any spelling opens the same project.
  assert.match(js, /const projectCampaigns = \(project\) => state\.supervisor\.campaigns\.filter\(\(c\) => sameProject\(c\.repository, project\)\);/);
  assert.match(js, /empty\('No work yet\.', `Work in \$\{projectName\(project\)\} appears here once it is registered on this computer\./);
});
