// Settings and Diagnostics (OWNER_WORKSPACE slice S8, build slice UI9): this computer, its AI workers once, each project's
// connection, release mode as text, Messages, and Diagnostics with the journal, steps, roadmap and merge-check freshness.
// Plan §6.12 C1: the dashboard stays GitHub-free, so Diagnostics shows how fresh each merge check is instead of
// "Refresh GitHub". Synthetic review fixture, disposable stores and made-up campaign rows only; no network, model or
// GitHub call. The operating system is passed in, so the Windows and Linux rules are both checked on either host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { aiWorkers, computerSettings, configuredCommandNames, releaseModes, supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { buildReviewFixture } from './fixtures/review-store.mjs';
import { openPage, visibleText } from './fixtures/page.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const page = () => readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
const M = 60_000;
const NOW = Date.UTC(2026, 9, 13, 12, 0);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-settings-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return buildReviewFixture(root);
}
/** Lines of dashboard.js, run here: `pick` finds a one-line constant or a whole top-level function by its pattern. */
function fromPage(names, stubs = '') {
  const source = page();
  const pick = (pattern) => { const found = pattern.exec(source); assert.ok(found, `dashboard.js has ${pattern}`); return found[0]; };
  const parts = names.map((name) => name.startsWith('function ') ? pick(new RegExp(`^${name.replace('(', '\\(')}[\\s\\S]*?\\n}$`, 'm')) : pick(new RegExp(`^const ${name} = .*$`, 'm')));
  return new Function(`${stubs}\n${parts.join('\n')}\nreturn { ${names.map((name) => name.replace(/^function |\($/g, '')).join(', ')} };`)();
}
/** A made-up campaign row with today's provider fields (supervisorSnapshot's `providers`). */
const campaign = (id, control, providers) => ({ id, control, repository: 'example/shop-app', executors: providers.filter((p) => p.priority).map((p) => p.kind),
  providers: providers.map((p) => ({ priority: null, state: 'not-configured', reason: null, availabilityReason: null, credits: false, retryAt: null, ...p })) });

test('AI workers are listed once per computer, merged from every piece of work’s providers', (t) => {
  const { dataDir } = fixture(t);
  const state = supervisorSnapshot(dataDir);
  assert.equal(state.available, true);
  // Today the same provider boxes repeat on every campaign (#4); Settings lists each worker once.
  const repeated = state.campaigns.flatMap((c) => c.providers.map((p) => p.kind));
  assert.ok(repeated.length > 3, 'the fixture repeats providers across campaigns');
  assert.deepEqual(state.settings.workers.map((w) => w.kind), ['claude-cli', 'codex-cli', 'cursor-cli']);
  // The fixture's config.json sets no command: Cursor is not set up, Claude falls back to `claude` on PATH as the controller does.
  const linux = aiWorkers(state.campaigns, { repositories: {} }, { platform: 'linux' });
  assert.equal(linux.find((w) => w.kind === 'cursor-cli').state, 'not-set-up');
  // A worker the supervisor is running right now is in use, whatever the settings say.
  assert.equal(linux.find((w) => w.kind === 'codex-cli').state, 'running');
  assert.equal(linux.find((w) => w.kind === 'claude-cli').setUp, 'default');
  assert.equal(linux.find((w) => w.kind === 'claude-cli').usedBy, state.campaigns.filter((c) => !['finished', 'cancelled'].includes(c.control) && c.executors.includes('claude-cli')).length);
});

test('merging providers: running beats waiting, the earliest retry wins, finished work is not read, Cursor is never available on Windows', () => {
  const config = { commands: { codex: ['C:/Tools/codex.exe'], cursor: ['/opt/cursor/agent'] } };
  const campaigns = [
    campaign('a', 'registered', [{ kind: 'claude-cli', priority: 1, state: 'cooldown', reason: 'quota', retryAt: NOW + 45 * M },
      { kind: 'codex-cli', priority: 2, state: 'cooldown', reason: 'quota', retryAt: NOW + 30 * M, credits: true }]),
    campaign('b', 'paused', [{ kind: 'codex-cli', priority: 1, state: 'cooldown', reason: 'quota', retryAt: NOW + 10 * M }, { kind: 'claude-cli', priority: 2, state: 'running' }]),
    // Finished work keeps old rows; they are not read.
    campaign('c', 'finished', [{ kind: 'cursor-cli', priority: 1, state: 'unavailable', availabilityReason: 'Native sandbox is unavailable on this host' }]),
  ];
  const workers = (platform) => Object.fromEntries(aiWorkers(campaigns, config, { platform, now: NOW }).map((w) => [w.kind, w]));
  const linux = workers('linux');
  assert.equal(linux['claude-cli'].state, 'running');
  assert.equal(linux['claude-cli'].usedBy, 2);
  assert.deepEqual([linux['codex-cli'].state, linux['codex-cli'].retryAt, linux['codex-cli'].reason, linux['codex-cli'].credits], ['waiting', NOW + 10 * M, 'quota', true]);
  assert.equal(linux['cursor-cli'].state, 'ready');
  assert.equal(linux['cursor-cli'].usedBy, 0);
  assert.equal(linux['cursor-cli'].buildLimit, 'checks-only');
  const windows = workers('win32');
  assert.equal(windows['cursor-cli'].state, 'host-unavailable');
  assert.equal(windows['codex-cli'].buildLimit, 'checks-only');
  assert.equal(linux['codex-cli'].buildLimit, null);
  // An overdue retry is still a wait, said as due.
  assert.equal(aiWorkers(campaigns, config, { platform: 'linux', now: NOW + 20 * M }).find((w) => w.kind === 'codex-cli').overdue, true);
  // Unavailable on an active campaign, with the supervisor's reason; AGY appears only when set up or allowed.
  const unavailable = [campaign('d', 'registered', [{ kind: 'codex-cli', priority: 1, state: 'unavailable', availabilityReason: 'Native sandbox is unavailable on this host' }])];
  const codex = aiWorkers(unavailable, config, { platform: 'linux' }).find((w) => w.kind === 'codex-cli');
  assert.deepEqual([codex.state, codex.availabilityReason], ['unavailable', 'Native sandbox is unavailable on this host']);
  assert.ok(!aiWorkers(unavailable, config, { platform: 'linux' }).some((w) => w.kind === 'agy-cli'));
  const agy = aiWorkers(unavailable, { commands: { agy: ['agy.exe'] } }, { platform: 'linux' }).find((w) => w.kind === 'agy-cli');
  assert.deepEqual([agy.state, agy.buildLimit], ['not-set-up', 'web-only'], 'AGY also needs Chrome');
});

test('no command path is in the response: only the names of the commands config.json sets', async (t) => {
  const { dataDir, root } = fixture(t);
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  const paths = [join(root, 'bin', 'codex.exe'), join(root, 'bin', 'claude-secret-wrapper.cmd'), join(root, 'bin', 'gh.exe'), '/usr/local/libexec/git-core/git'];
  config.commands = { codex: [paths[0], '--no-daemon'], claude: [paths[1]], gh: [paths[2]], git: [paths[3]], unknown: ['/opt/elsewhere/tool'], cursor: [] };
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
  assert.deepEqual(configuredCommandNames(config), ['claude', 'codex', 'git', 'gh']);
  const server = createDashboardServer({ dataDir, roadmap: { snapshot: () => ({ entries: [], governance: { configured: false, reason: 'Synthetic test.' } }) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/state`);
  assert.equal(response.status, 200);
  const body = await response.text(), state = JSON.parse(body);
  assert.deepEqual(state.supervisor.settings.commands, ['claude', 'codex', 'git', 'gh']);
  for (const path of [...paths, '/opt/elsewhere/tool', ...Object.values(config.repositories).map((entry) => entry.path)]) {
    assert.ok(!body.includes(path) && !body.includes(JSON.stringify(path).slice(1, -1)), `the response never carries ${path}`);
  }
  assert.ok(!/codex\.exe|wrapper\.cmd|--no-daemon/.test(body));
});

const DECISION = 'https://github.com/netbka/aiworks/issues/33';
/** The release panel as dashboard.js renders it, as a tree of { tag, attributes, children }. */
function renderReleases(releases) {
  const el = (tag, attributes = {}, ...children) => ({ tag, attributes, children: children.flat().filter((child) => child !== null && child !== undefined) });
  const { releasePanel } = fromPage(['function releasePanel('], `const el = ${el}; const panel = (title, description, body) => el('section', {}, title, description, body);
    const empty = (title, detail) => el('div', {}, title, detail); const link = (text, url) => el('a', { href: url }, text); const projectName = (r) => r.split('/')[1];`);
  const tree = releasePanel(releases);
  const nodes = [], walk = (node) => { if (node && typeof node === 'object') { nodes.push(node); node.children.forEach(walk); } };
  walk(tree);
  return { tree, nodes };
}

test('release mode is text: Review only on, Auto Release off and not available, with no control', (t) => {
  const { dataDir } = fixture(t);
  // config.json "autoReleaseDecision" names the decision Auto Release waits for: the link shown before it was configurable.
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...config, autoReleaseDecision: DECISION }));
  const releases = supervisorSnapshot(dataDir).settings.releases;
  // One per project: the configured repositories and the campaigns' targets, case-insensitively.
  assert.deepEqual(releases.map((r) => r.repository), ['example/notes-site', 'example/recipes', 'example/shop-app']);
  assert.deepEqual(releaseModes(['example/App', 'example/app', 'not a repository']).map((r) => r.repository), ['example/App']);
  // Every project Settings lists (aiworks#11 review 5 G10): a connected GitHub project by its repository, and a project
  // without GitHub with one line that release does not apply to it yet, and no mode.
  const connected = [{ id: 'notes', name: 'Notes', source_kind: 'folder' }, { id: 'shop', name: 'Shop', source_kind: 'github', github_repository: 'example/Shop-App' },
    { id: 'recipes', name: 'Recipes', source_kind: 'local-git' }];
  assert.deepEqual(releaseModes(['example/shop-app', 'example/notes-site'], { connected }).map((r) => [r.repository, r.name ?? null, r.modes.length, r.text ?? null]), [
    ['example/notes-site', null, 2, null], ['example/shop-app', null, 2, null],
    [null, 'Notes', 0, "Release does not apply yet to a project without GitHub: AIWorks can't start work here yet, so there is nothing to release."],
    [null, 'Recipes', 0, "Release does not apply yet to a project without GitHub: AIWorks can't start work here yet, so there is nothing to release."]]);
  assert.deepEqual(renderReleases(releaseModes([], { connected })).nodes.filter((node) => ['button', 'input', 'select', 'textarea', 'form'].includes(node.tag)), []);
  for (const release of releases) {
    assert.equal(release.mode, 'review-only');
    assert.deepEqual(release.modes.map((m) => [m.key, m.on]), [['review-only', true], ['auto-release', false]]);
    const auto = release.modes[1];
    assert.equal(auto.available, false);
    assert.equal(auto.text, 'Not available. Turning this on needs your separate release approval for this project, which has not been given.');
    assert.equal(auto.waitsFor, DECISION);
    for (const mode of release.modes) assert.deepEqual(Object.keys(mode).filter((key) => /control|toggle|switch|action|enabl/i.test(key)), [], 'nothing a page could turn into a control');
  }
  // The page renders it with no button, input, select or switch, and nothing clickable but the link to the decision.
  const { tree, nodes } = renderReleases(releases);
  assert.deepEqual(nodes.filter((node) => ['button', 'input', 'select', 'textarea', 'form'].includes(node.tag) || node.attributes.role === 'switch' ||
    Object.keys(node.attributes).some((key) => key.startsWith('on') || key === 'disabled')), []);
  assert.deepEqual(nodes.filter((node) => node.tag === 'a').map((node) => [node.attributes.href, node.children]), releases.map(() => [DECISION, ['issue #33 ↗']]));
  const text = JSON.stringify(tree);
  assert.match(text, /Review only · On/);
  assert.match(text, /Auto Release · Off/);
  assert.match(text, /It waits for the release decision in /);
});

test('without a configured decision link, Auto Release keeps its text and shows no link', (t) => {
  const { dataDir } = fixture(t);
  for (const autoReleaseDecision of [undefined, '', 'not a link', 'https://example.com/issues/33', 33]) {
    const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...config, autoReleaseDecision }));
    const releases = supervisorSnapshot(dataDir).settings.releases;
    assert.equal(releases.length, 3);
    for (const release of releases) {
      const auto = release.modes[1];
      assert.deepEqual([auto.key, auto.on, auto.available, auto.waitsFor], ['auto-release', false, false, null], String(autoReleaseDecision));
      assert.equal(auto.text, 'Not available. Turning this on needs your separate release approval for this project, which has not been given.');
    }
    const { tree, nodes } = renderReleases(releases);
    assert.deepEqual(nodes.filter((node) => node.tag === 'a'), [], 'no link');
    const text = JSON.stringify(tree);
    assert.match(text, /Auto Release · Off/);
    assert.match(text, /Not available\. Turning this on needs your separate release approval for this project, which has not been given\./);
    assert.doesNotMatch(text, /waits for the release decision|github\.com/);
  }
  assert.equal(releaseModes(['example/app'])[0].modes[1].waitsFor, null);
});

test('each AI worker is one plain line: “Claude · ready”, “Codex · not set up on this computer”, “Cursor · not available on Windows”', () => {
  const { workerLine } = fromPage(['provider', 'plural', 'timeOnly', 'function workerLine(']);
  const worker = (kind, state, extra = {}) => workerLine({ kind, state, setUp: 'configured', usedBy: 1, retryAt: null, overdue: false, credits: false, availabilityReason: null, buildLimit: null, ...extra });
  assert.equal(worker('claude-cli', 'ready').text, 'Claude · ready');
  assert.equal(worker('codex-cli', 'not-set-up').text, 'Codex · not set up on this computer');
  assert.equal(worker('cursor-cli', 'host-unavailable').text, 'Cursor Agent · not available on Windows');
  assert.equal(worker('claude-cli', 'running').text, 'Claude · in use now');
  const waiting = worker('claude-cli', 'waiting', { retryAt: NOW + 45 * M });
  assert.equal(waiting.text, 'Claude · waiting for its usage limit');
  assert.match(waiting.notes[0], /^AIWorks tries it again at \d\d:\d\d\. No action needed\.$/);
  assert.match(worker('codex-cli', 'unavailable', { availabilityReason: 'Native sandbox is unavailable on this host' }).notes[0], /^Native sandbox is unavailable on this host\.$/);
  assert.ok(worker('claude-cli', 'ready', { setUp: 'default' }).notes.includes('Uses the claude command on this computer’s PATH; the AIWorks configuration file sets none.'));
  assert.ok(worker('codex-cli', 'ready', { buildLimit: 'checks-only' }).notes.includes('Can check and report here, but cannot build code here.'));
  assert.ok(worker('codex-cli', 'ready', { usedBy: 0 }).notes.includes('No current work allows it.'));
  // A usage-limit wait is never an owner task (AW-002), and no line names a path.
  for (const line of [waiting, worker('codex-cli', 'waiting', { retryAt: NOW - M, overdue: true })]) assert.match(line.notes[0], /No action needed\.$/);
});

test('Diagnostics shows how fresh each merge check is, in place of Refresh GitHub (plan §6.12 C1)', () => {
  const { mergeFreshness } = fromPage(['timeOnly', 'dateTime', 'whenAt', 'function mergeFreshness(']);
  const now = Date.now(), fetched = now - 2 * M;
  assert.equal(mergeFreshness(undefined, now), 'No published step to check yet.');
  assert.equal(mergeFreshness({ configured: false, fetchedAt: null, error: null }, now), 'Merges are not checked: the AIWorks configuration file on this computer sets no local checkout for it.');
  assert.equal(mergeFreshness({ configured: true, fetchedAt: null, error: null }, now), 'Merges not checked yet; the first check is running.');
  assert.equal(mergeFreshness({ configured: true, fetchedAt: null, error: 'fetch-failed' }, now), 'Merges not checked yet: the first fetch failed, retrying within 5 minutes.');
  assert.match(mergeFreshness({ configured: true, fetchedAt: fetched, error: null }, now), /^Merges checked at (\d\d:\d\d|\d{1,2} \w{3,4} \d\d:\d\d); next check after \d\d:\d\d\.$/);
  assert.match(mergeFreshness({ configured: true, fetchedAt: fetched, error: 'fetch-failed' }, now), /^Merge check from .+; the last fetch failed, retrying within 5 minutes\.$/);
  assert.match(mergeFreshness({ configured: true, fetchedAt: now - 3 * 86_400_000, error: null }, now), /^Merge check from \d{1,2} \w{3,4} \d\d:\d\d; checking again\.$/);
  const js = page();
  // No refresh control and no GitHub call: the page talks only to its own /api routes.
  const code = js.split('\n').filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join('\n');
  assert.ok(!/Refresh GitHub/i.test(code), 'no Refresh GitHub text or control outside comments');
  // `post(path, …)` is the one indirect fetch, and every caller names an /api route.
  assert.deepEqual([...js.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1]).filter((target) => !/^[`']\/api\//.test(target)), ['path']);
  assert.match(js, /^async function post\(path, body\) \{\r?\n  const response = await fetch\(path,/m);
  assert.deepEqual([...js.matchAll(/\bpost\(([^,)]+)/g)].map((m) => m[1]).filter((target) => !/^'\/api\//.test(target) && target !== 'path'), []);
  // Diagnostics keeps every fact of today's Plans, Issues & PRs and Activity views, and adds the merge checks.
  assert.match(js, /else if \(diagnostics\) patch\(content, \[trackOverview\(\), roadmapView\(\), workView\(\), mergeChecksPanel\(\), projectWaitsPanel\(\),\r?\n\s+panel\('Execution journal'/);
});

test('Settings shows this computer, AI workers, project connections and release mode, then Messages and Diagnostics', (t) => {
  const js = page();
  assert.match(js, /return \[computer, workers, connections, releasePanel\(settings\.releases\), settingsLinks\(\)\];/);
  // AI workers come from the per-computer list, never from one campaign's provider boxes.
  const screen = /^function settingsScreen\(\)[\s\S]*?\n}$/m.exec(js)[0];
  assert.match(screen, /settings\.workers\.map/);
  assert.ok(!/providerStatus\(/.test(screen));
  // Messages keeps its own screen; the links stay.
  assert.match(js, /else if \(route\.screen === 'settings' && route\.section === 'messages'\) patch\(content, \[messagesPanel\(20\)\]\);/);
  for (const target of ['#/settings/messages', '#/settings/diagnostics']) assert.match(js, new RegExp(`routeLink\\('[^']+', '${target}'\\)`));
  // An unavailable store has no settings; an empty one has workers and no projects.
  const root = mkdtempSync(join(tmpdir(), 'aiworks-settings-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const { dataDir } = buildReviewFixture(join(root, 'r'), { store: 'empty' });
  const empty = supervisorSnapshot(dataDir);
  assert.deepEqual(empty.settings.releases, []);
  assert.deepEqual(empty.settings.workers.map((w) => w.kind), ['claude-cli', 'codex-cli', 'cursor-cli']);
  assert.equal(supervisorSnapshot(join(root, 'missing')).settings, undefined);
  assert.deepEqual(computerSettings([], {}).commands, []);
});

test('Settings › Projects and Projects tell one story about how a project appears, with Add project off and on (aiworks#11 F7)', async (t) => {
  const page = await openPage(t, { store: 'empty' });
  const config = JSON.parse(readFileSync(join(page.dataDir, 'config.json'), 'utf8'));
  const screen = async (address) => { await page.go(address); return visibleText(page.$('#content')); };
  const links = () => page.$('#content').querySelectorAll('a').map((node) => [node.textContent, node.getAttribute('href')]);
  // Off: both say the configuration file lists repositories; neither offers Add project.
  const OFF = 'No projects yet. Projects appear here when the AIWorks configuration file on this computer lists a repository.';
  assert.ok((await screen('#/projects')).startsWith(OFF));
  assert.ok((await screen('#/settings')).includes(OFF));
  assert.ok(!links().some(([text]) => text === 'Add project'));
  // On: both say the §7.1 sentence after S11 and lead to Add project; Settings keeps no primary button (§4.3).
  writeFileSync(join(page.dataDir, 'config.json'), JSON.stringify({ ...config, projectConnection: { enabled: true } }));
  await page.refresh();
  const ON = 'No projects yet. Add a folder on this computer. It can be a GitHub repository, a local Git repository or an ordinary folder. Add project';
  assert.ok((await screen('#/projects')).includes(ON));
  const settings = await screen('#/settings');
  assert.ok(settings.includes(ON), settings);
  assert.doesNotMatch(settings, /configuration file on this computer lists a repository/);
  const add = page.$('#content').querySelectorAll('a').find((node) => node.textContent === 'Add project');
  assert.deepEqual([add.getAttribute('href'), add.className], ['#/projects/add', ''], 'a plain link, not a primary button');
});

test('Settings displays AI worker accounts and their usage, with no action that adds, exports or imports a login', async (t) => {
  const page = await openPage(t, { store: 'empty' });
  await page.go('#/settings');
  const text = visibleText(page.$('#content'));
  assert.ok(text.includes('Logins and usage'));
  assert.ok(text.includes('No worker accounts yet.'));
  for (const action of ['Add account', 'Export accounts', 'Import accounts']) assert.ok(!text.includes(action), action);
  for (const id of ['account-dialog', 'export-accounts-dialog', 'import-accounts-dialog']) assert.equal(page.$(`#${id}`), null, id);
});

test('Settings › Accounts dedicated page displays worker accounts and back link', async (t) => {
  const page = await openPage(t, { store: 'empty' });
  await page.go('#/settings/accounts');
  const text = visibleText(page.$('#content'));
  assert.ok(text.includes('Worker accounts'));
  assert.ok(text.includes('Which AI worker logins and accounts are on this computer?'));
  assert.ok(text.includes('Back to Settings'));
  assert.ok(text.includes('Connect account…'));
  assert.ok(text.includes('No worker accounts added yet.'));
});


