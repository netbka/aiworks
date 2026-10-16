// UI13: Add project from the Projects screen (PROJECT_CONNECTION slice S6 with OWNER_WORKSPACE slice S11, plan
// resolution C5). The owner connects a GitHub checkout, a local Git repository or a plain folder through the dashboard
// server; connecting never changes a file in the folder, no response carries an absolute path except the owner's own
// project root, the routes keep the server's same-origin, CSRF and 16 KiB rules, and it is all off unless config.json
// switches it on. Starting work on a project without GitHub stays off (#24, #32).
// Disposable folders and git repositories, synthetic gh and branch reads, a loopback server: no network, model or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Store } from '../../src/supervisor/store.mjs';
import { CONNECT_CODES } from '../../src/supervisor/project-connect.mjs';
import { PREFLIGHT_CODES } from '../../src/supervisor/project-preflight.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { LOCAL_START, OWN_COPY, PROJECT_COPY, projectAction, projectMessage, UNREGISTERED } from '../../src/dashboard/projects.mjs';
import { openPage, visibleText } from './fixtures/page.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GOVERNANCE = fileURLToPath(new URL('../fixtures/governance', import.meta.url));
const roadmap = { snapshot: () => ({ governance: { configured: false, code: null, reason: null }, entries: [] }) };
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x00, 0xff]);

function write(root, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
}

/** Every entry under `root`, `.git` included: each directory's listing, and each file's size, mtimeNs and SHA-256. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    const names = readdirSync(dir).sort();
    out[`${relative(root, dir).replaceAll('\\', '/')}/`] = names.join('|');
    for (const name of names) {
      const path = join(dir, name), stat = lstatSync(path, { bigint: true });
      if (stat.isDirectory()) walk(path);
      else out[relative(root, path).replaceAll('\\', '/')] = `${stat.size}:${stat.mtimeNs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    }
  };
  walk(root);
  return out;
}

/** One loopback request with full control of Host, Origin, CSRF and content type. */
function call(port, method, path, { headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const sent = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    const req = request({ host: '127.0.0.1', port, path, method, headers: sent }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        done({ status: res.statusCode, text, json });
      });
    });
    req.on('error', fail);
    req.end(body);
  });
}

/**
 * A disposable data directory with a supervisor store and config.json (Add project on unless `enabled` is false), a
 * dashboard server with synthetic gh and branch reads, and helpers to make folders and repositories beside it. Every
 * response body is kept in `bodies` for the path check.
 */
async function rig(t, { enabled = true } = {}) {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiworks-connect-')));
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir);
  new Store(join(dataDir, 'supervisor.db')).close();
  // A worker command that would log if anything started one: connecting must never start work.
  const spawned = join(tmp, 'worker-started.log');
  const worker = join(tmp, 'worker.mjs');
  writeFileSync(worker, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(spawned)}, 'started\\n');`);
  const config = { governanceRoot: GOVERNANCE, commands: { claude: [process.execPath, worker], codex: [process.execPath, worker] },
    ...(enabled ? { projectConnection: { enabled: true } } : {}) };
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
  const ghCalls = [];
  const gh = { down: false };
  const ghRun = (args) => {
    ghCalls.push(args);
    if (gh.down) return { status: 1, stdout: '', stderr: 'error connecting to api.github.com: could not resolve host' };
    if (args[0] === 'auth') return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: JSON.stringify({ full_name: args[1].replace(/^repos\//, ''), default_branch: 'main' }), stderr: '' };
  };
  const server = createDashboardServer({ dataDir, roadmap, host: { name: 'TestPc', revision: 'abc1234def56' },
    projectConnection: { gh: ghRun, lsRemote: (_, branch) => branch === 'main', gitEnv: { GIT_CEILING_DIRECTORIES: tmp } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); server.close(); await once(server, 'close').catch(() => {});
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const bodies = [];
  const csrf = (await call(port, 'GET', '/api/session', { headers: { 'sec-fetch-site': 'same-origin' } })).json.csrf;
  const get = async (path) => { const response = await call(port, 'GET', path, { headers: { 'sec-fetch-site': 'same-origin' } }); bodies.push(response.text); return response; };
  const post = async (path, value, headers = {}) => {
    const response = await call(port, 'POST', path, { headers: { origin, 'x-dashboard-csrf': csrf, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
      body: typeof value === 'string' ? value : JSON.stringify(value) });
    bodies.push(response.text);
    return response;
  };
  const folder = (name = 'Notes', files = { 'README.md': '# Notes\r\nline two\r\n', 'src/app.js': 'console.log("app");\n', 'assets/logo.png': BINARY, '.env': 'TOKEN=synthetic\n' }) => {
    const root = join(tmp, name);
    mkdirSync(root);
    write(root, files);
    return root;
  };
  const repository = (name, origin = null) => {
    const root = join(tmp, name);
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    write(root, { 'README.md': `# ${name}\n` });
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '-m', 'first');
    if (origin) git(root, 'remote', 'add', 'origin', origin);
    return root;
  };
  // Each read opens and closes the store, so nothing holds the file when the directory is removed (Windows).
  const read = (method) => (sql, ...args) => {
    const opened = new Store(join(dataDir, 'supervisor.db'), { readOnly: true });
    try { return opened[method](sql, ...args); } finally { opened.close(); }
  };
  const store = () => ({ all: read('all'), get: read('get') });
  return { tmp, dataDir, port, origin, csrf, get, post, folder, repository, store, ghCalls, gh, spawned, bodies };
}

/** Every body, with each owner's own project root taken out, names no place under the test's directory. */
function assertNoOtherPath(r, roots) {
  const forms = (path) => [path, path.replaceAll('\\', '/'), JSON.stringify(path).slice(1, -1)];
  const places = forms(r.tmp);
  for (const body of r.bodies) {
    let rest = body;
    for (const root of roots) for (const form of forms(root)) rest = rest.replaceAll(form, '<project root>');
    for (const place of places) assert.ok(!rest.includes(place), `a response names a path other than a project root: ${rest.slice(Math.max(0, rest.indexOf(place) - 80), rest.indexOf(place) + 160)}`);
  }
}

test('off by default: without the switch every Add project route answers as before and the Projects screen is unchanged', async (t) => {
  const r = await rig(t, { enabled: false });
  const root = r.folder();
  const before = snapshot(root);
  assert.equal((await r.get('/api/projects')).status, 404);
  for (const route of ['preflight', 'connect', 'check', 'relocate', 'disconnect']) {
    const response = await r.post(`/api/projects/${route}`, { path: root, projectId: 'notes', version: 1 });
    assert.deepEqual([response.status, response.json], [404, { error: 'Not found.' }], route);
  }
  const state = (await r.get('/api/state')).json;
  assert.deepEqual(state.projects, { available: true, projects: [] }, 'no addProject flag and no connected projects');
  assert.deepEqual(snapshot(root), before);
  assert.equal(r.store().all('SELECT id FROM projects').length, 0);
});

test('the connect routes keep the same-origin, CSRF, JSON and 16 KiB rules', async (t) => {
  const r = await rig(t);
  const root = r.folder();
  const body = JSON.stringify({ path: root });
  for (const route of ['preflight', 'connect', 'check', 'relocate', 'disconnect']) {
    const path = `/api/projects/${route}`;
    const send = (headers, value = body) => call(r.port, 'POST', path, { headers: { 'sec-fetch-site': 'same-origin', ...headers }, body: value });
    const ok = { origin: r.origin, 'x-dashboard-csrf': r.csrf, 'content-type': 'application/json' };
    assert.equal((await send({ ...ok, origin: undefined })).status, 403, `${route}: no Origin`);
    assert.equal((await send({ ...ok, origin: 'http://evil.example' })).status, 403, `${route}: another origin`);
    assert.equal((await send({ ...ok, 'x-dashboard-csrf': 'f'.repeat(64) })).status, 403, `${route}: wrong CSRF token`);
    assert.equal((await send({ ...ok, 'x-dashboard-csrf': undefined })).status, 403, `${route}: no CSRF token`);
    assert.equal((await send({ ...ok, host: 'example.invalid' })).status, 403, `${route}: another Host`);
    assert.equal((await send({ ...ok, 'sec-fetch-site': 'cross-site' })).status, 403, `${route}: cross-site`);
    assert.equal((await send({ ...ok, 'content-type': 'text/plain' })).status, 415, `${route}: not JSON`);
    assert.equal((await send(ok, JSON.stringify({ path: 'x'.repeat(16_400) }))).status, 413, `${route}: over 16 KiB`);
    assert.equal((await send(ok, '{')).status, 400, `${route}: invalid JSON`);
    assert.equal((await send(ok, JSON.stringify({ path: root, projectId: 'notes', version: 1, extra: true }))).status, 400, `${route}: an unknown field`);
  }
  assert.equal((await call(r.port, 'GET', '/api/projects', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'reading the list is same-origin too');
  assert.equal(r.store().all('SELECT id FROM projects').length, 0, 'no refused request saved anything');
});

test('a plain folder connects through the dashboard: the folder is byte-identical and starting work says it is not available yet', async (t) => {
  const r = await rig(t);
  const root = r.folder();
  const before = snapshot(root);
  const preview = (await r.post('/api/projects/preflight', { path: root })).json;
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual([preview.found.kind, preview.found.kinds, preview.found.text, preview.found.folder, preview.found.root], ['folder', ['folder'], 'Ordinary folder, no Git', 'Notes', root]);
  assert.deepEqual(preview.found.notes, [OWN_COPY, LOCAL_START[0]]);
  assert.match(preview.notices.map((item) => item.message).join(' '), /^AIWorks left out 1 items and never copies them: 1 secret-like files \(for example \.env\)/);
  assert.deepEqual(snapshot(root), before, 'checking the folder changes nothing');
  const connected = (await r.post('/api/projects/connect', { path: preview.found.root, kind: 'folder', requestId: '6f1c1d2e-0000-4000-8000-000000000001' })).json;
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.deepEqual([connected.project.id, connected.project.route, connected.project.kind, connected.project.status, connected.project.root],
    ['notes', 'notes', 'Folder', 'ready', root]);
  assert.deepEqual(connected.project.startWork, { allowed: false, text: LOCAL_START[0], detail: LOCAL_START[1] });
  // PROJECT_CONNECTION §8.3: the exact LOCAL_START_OFF copy, with the exclusions it left out.
  assert.equal(connected.notices[0].message, "AIWorks can't plan or start work in a project without GitHub yet. That waits for two decisions, one in your project rules and one of yours; the project's Details say what each allows.");
  assert.deepEqual(snapshot(root), before, 'connecting changes no file, listing or time in the folder');
  assert.ok(!existsSync(join(root, '.git')), 'no .git appears in the folder');
  // A repeat of the same request opens the same project: nothing is connected twice.
  const again = (await r.post('/api/projects/connect', { path: root, kind: 'folder', requestId: '6f1c1d2e-0000-4000-8000-000000000001' })).json;
  assert.deepEqual([again.ok, again.project.id, again.notices.at(-1).message], [true, 'notes', 'This folder is already connected as "Notes".']);
  assert.equal(r.store().all('SELECT id FROM projects').length, 1);
  // The Projects screen: one row of its own, addressed by its id, saying starting work is not available yet.
  const state = (await r.get('/api/state')).json;
  assert.equal(state.projects.addProject, true);
  assert.deepEqual(state.projects.projects.map((row) => [row.id, row.name, row.kind, row.state.key, row.state.text, row.action.label]),
    [['notes', 'Notes', 'Folder', 'cannot-start', LOCAL_START[0], 'Open project']]);
  assert.equal(state.projects.projects[0].connection.root, undefined, 'the polled state never carries the folder path');
  assertNoOtherPath(r, [root]);
  assert.ok(!existsSync(r.spawned), 'no worker started');
});

test('a local Git repository connects: its .git is untouched and starting work stays off', async (t) => {
  const r = await rig(t);
  const root = r.repository('Recipes');
  write(root, { 'draft.txt': 'not committed\n' });
  const before = snapshot(root);
  const preview = (await r.post('/api/projects/preflight', { path: root })).json;
  assert.deepEqual([preview.found.kind, preview.found.text, preview.found.branch], ['local-git', 'Git repository, no GitHub remote', 'main']);
  assert.match(preview.notices.map((item) => item.message).join(' '), /You have changes that aren't committed\. AIWorks works from your last commit \([0-9a-f]{7}\) and never touches your files\./);
  const connected = (await r.post('/api/projects/connect', { path: root, kind: 'local-git' })).json;
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.deepEqual([connected.project.kind, connected.project.status, connected.project.startWork.allowed, connected.project.baseline.seq], ['Local Git', 'ready', false, 1]);
  assert.deepEqual(snapshot(root), before, 'no file under the repository, .git included, changed');
  assertNoOtherPath(r, [root]);
});

test('a GitHub checkout connects Ready; an unregistered one is saved and reads as OWNER_WORKSPACE §5.2', async (t) => {
  const r = await rig(t);
  const root = r.repository('SampleApp', 'https://github.com/example-org/sampleapp.git');
  const before = snapshot(root);
  const preview = (await r.post('/api/projects/preflight', { path: root })).json;
  assert.deepEqual([preview.found.kind, preview.found.kinds, preview.found.text, preview.found.registered, preview.found.notes],
    ['github', ['github', 'local-git'], 'Git repository with GitHub remote example-org/sampleapp, main branch main', true, []]);
  const connected = (await r.post('/api/projects/connect', { path: root, kind: 'github' })).json;
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.deepEqual([connected.project.route, connected.project.kind, connected.project.status, connected.project.startWork.allowed], ['example-org/sampleapp', 'GitHub', 'ready', true]);
  assert.deepEqual(snapshot(root), before, 'no file under the checkout, .git included, changed');
  assert.deepEqual(r.ghCalls.map((args) => args[0]), ['auth', 'api'], 'gh reads only: no GraphQL-backed command');

  const unlisted = r.repository('Unlisted', 'https://github.com/example-org/unlisted-app.git');
  const seen = (await r.post('/api/projects/preflight', { path: unlisted })).json;
  assert.deepEqual([seen.found.registered, seen.found.notes], [false, [UNREGISTERED]]);
  const saved = (await r.post('/api/projects/connect', { path: unlisted, kind: 'github' })).json;
  // PROJECT_CONNECTION §8.2: the exact REGISTRY_MISSING copy, and its one action.
  assert.deepEqual([saved.ok, saved.code, saved.status, saved.message, saved.action],
    [false, 'REGISTRY_MISSING', 'needs-setup', "example-org/unlisted-app isn't listed in your project rules, so AIWorks can't start work on it. You decide which projects AIWorks may work on: listing it in your project rules lets AIWorks start work on it. Your project rules are kept outside AIWorks, in a folder on this computer that the AIWorks configuration file names. Then check again.",
      { do: 'check', label: 'Check again' }]);
  assert.deepEqual([saved.project.status, saved.project.startWork], ['needs-setup', { allowed: false, text: UNREGISTERED, detail: null }]);
  const row = (await r.get('/api/state')).json.projects.projects.find((item) => item.id === 'example-org/unlisted-app');
  assert.deepEqual([row.kind, row.state, row.action.label], ['GitHub', { key: 'needs-setup', text: UNREGISTERED }, 'Open project']);
  assertNoOtherPath(r, [root, unlisted]);
});

test('refusals save nothing and say what to do, with their one action', async (t) => {
  const r = await rig(t);
  const repo = r.repository('Shop');
  mkdirSync(join(repo, 'src'));
  const inside = (await r.post('/api/projects/preflight', { path: join(repo, 'src') })).json;
  assert.deepEqual([inside.ok, inside.code, inside.message, inside.action],
    [false, 'GIT_SUBFOLDER', `This folder is inside the Git repository ${repo}. Connect ${repo} instead.`, { do: 'use-path', label: `Use ${repo}`, path: repo }]);
  const relativePath = (await r.post('/api/projects/preflight', { path: 'Projects/my-app' })).json;
  assert.deepEqual([relativePath.code, relativePath.message, relativePath.action], ['PATH_NOT_ABSOLUTE', 'Enter the full folder path, for example D:\\Projects\\my-app.', null]);
  const missing = (await r.post('/api/projects/connect', { path: join(r.tmp, 'Nowhere'), kind: 'folder' })).json;
  assert.deepEqual([missing.ok, missing.code, missing.message, missing.project], [false, 'PATH_NOT_FOUND', "AIWorks can't find this folder. Check the path and try again.", null]);
  const own = (await r.post('/api/projects/preflight', { path: r.dataDir })).json;
  assert.equal(own.code, 'PATH_PROTECTED', 'the data directory is never a project');
  const empty = join(r.tmp, 'Empty');
  mkdirSync(empty);
  git(empty, 'init', '-q', '-b', 'main');
  const noCommits = (await r.post('/api/projects/preflight', { path: empty })).json;
  assert.deepEqual([noCommits.code, noCommits.action], ['GIT_NO_COMMITS', { do: 'kind', label: 'Connect as plain folder', kind: 'folder' }]);
  const asFolder = (await r.post('/api/projects/preflight', { path: empty, kind: 'folder' })).json;
  assert.deepEqual([asFolder.ok, asFolder.found.kind], [true, 'folder'], 'the owner may connect it as a plain folder instead');
  assert.equal(r.store().all('SELECT id FROM projects').length, 0);
  // Inside a connected project: the overlap names it and opens it.
  const notes = r.folder();
  assert.equal((await r.post('/api/projects/connect', { path: notes, kind: 'folder' })).json.ok, true);
  const overlap = (await r.post('/api/projects/preflight', { path: join(notes, 'src') })).json;
  assert.deepEqual([overlap.code, overlap.message, overlap.action],
    ['PATH_OVERLAP', 'This folder overlaps the project "Notes". Projects can\'t be inside each other.', { do: 'open', label: 'Open "Notes"', project: 'notes' }]);
});

/**
 * aiworks#11 review F1: a stop the page cannot fix says what is missing and that the fix is outside AIWorks, in the
 * owner's words, and offers only Check again. Settings has no control for these, so nothing points there.
 */
function assertOutside(answer, code, cause) {
  assert.equal(answer.code, code, JSON.stringify(answer));
  assert.match(answer.message, cause);
  assert.match(answer.message, /outside AIWorks/, `${code} says the fix is outside AIWorks`);
  assert.doesNotMatch(answer.message, /Settings|governance provider|rules folder/, `${code} sends the owner nowhere and names no internal part`);
  assert.deepEqual(answer.action, { do: 'check', label: 'Check again' }, code);
}

test('Add project stopped by something outside the page: no project rules, no Git, a configuration file that disagrees (aiworks#11 F1)', async (t) => {
  const r = await rig(t);
  const config = JSON.parse(readFileSync(join(r.dataDir, 'config.json'), 'utf8'));
  const setConfig = (changes) => writeFileSync(join(r.dataDir, 'config.json'), JSON.stringify({ ...config, ...changes }));
  const notes = r.folder();
  // No project rules on this computer: checking and connecting both stop, and nothing is saved.
  setConfig({ governanceRoot: join(r.tmp, 'no-rules') });
  assertOutside((await r.post('/api/projects/preflight', { path: notes })).json, 'GOVERNANCE_ROOT_MISSING', /^AIWorks can't find the project rules on this computer, so it can't add a project yet\./);
  const notSaved = (await r.post('/api/projects/connect', { path: notes, kind: 'folder' })).json;
  assertOutside(notSaved, 'GOVERNANCE_ROOT_MISSING', /^AIWorks can't find the project rules/);
  assert.equal(notSaved.project, null);
  // No Git where the configuration file says it is.
  setConfig({ commands: { ...config.commands, git: [join(r.tmp, 'no-such-git')] } });
  assertOutside((await r.post('/api/projects/preflight', { path: notes })).json, 'GIT_CLI_MISSING', /^AIWorks can't find Git on this computer, so it can't check this folder\./);
  assert.equal(r.store().all('SELECT id FROM projects').length, 0);
  // The configuration file puts the same repository in another folder: the project is saved as needing setup, and its
  // sentence names only the other folder's name, never its full path.
  const elsewhere = r.folder('Elsewhere', { 'README.md': 'old copy\n' });
  setConfig({ repositories: { 'example-org/sampleapp': { path: elsewhere } } });
  const root = r.repository('SampleApp', 'https://github.com/example-org/sampleapp.git');
  const saved = (await r.post('/api/projects/connect', { path: root, kind: 'github' })).json;
  const conflict = `The AIWorks configuration file on this computer puts example-org/sampleapp at Elsewhere, but this project is at ${root}. AIWorks won't guess which one is right. Correct that entry in the configuration file, which is outside AIWorks, or disconnect this project. Then choose Check again.`;
  assertOutside(saved, 'CONFIG_CONFLICT', /^The AIWorks configuration file on this computer puts example-org\/sampleapp at Elsewhere,/);
  assert.equal(saved.message, conflict);
  assert.equal(saved.project.status, 'needs-setup');
  const again = (await r.post('/api/projects/check', { projectId: saved.project.id, requestId: crypto.randomUUID() })).json;
  assertOutside(again, 'CONFIG_CONFLICT', /^The AIWorks configuration file/);
  assert.equal(again.message, conflict);
  assertNoOtherPath(r, [notes, root]);
  // No code this page can meet points to Settings, and the page has no way to.
  for (const code of [...Object.keys(PREFLIGHT_CODES), ...Object.keys(CONNECT_CODES), ...Object.keys(PROJECT_COPY)]) {
    assert.notEqual(projectAction(code, DETAIL)?.do, 'settings', code);
    assert.doesNotMatch(projectMessage(code, DETAIL) ?? '', /Settings/, code);
  }
  const page = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
  assert.doesNotMatch(/^function connectAction\([\s\S]*?\n}$/m.exec(page)[0], /settings/i);
});

test('through the page: Add project without project rules says so with Check again only, and Needs me claims only work (aiworks#11 F1, F8)', async (t) => {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiworks-connect-outside-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const root = join(tmp, 'Recipes');
  write(root, { 'soup.md': '# Soup\n' });
  const page = await openPage(t, { store: 'empty', server: { projectConnection: { gitEnv: { GIT_CEILING_DIRECTORIES: tmp } } } });
  const config = JSON.parse(readFileSync(join(page.dataDir, 'config.json'), 'utf8'));
  const setRules = (governanceRoot) => writeFileSync(join(page.dataDir, 'config.json'), JSON.stringify({ ...config, governanceRoot, projectConnection: { enabled: true } }));
  setRules(join(tmp, 'no-rules'));
  await page.refresh();
  await page.go('#/projects/add');
  const path = page.$('#add-path');
  path.value = root;
  path.dispatchEvent({ type: 'input', preventDefault() {} });
  page.$('form[data-add-form]').dispatchEvent({ type: 'submit', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  await page.settle();
  const answer = page.$('#add-result');
  assert.equal(visibleText(answer), `${PROJECT_COPY.GOVERNANCE_ROOT_MISSING} Check again`);
  assert.deepEqual(answer.querySelectorAll('a').map((node) => node.getAttribute('href')), [], 'no link leads to a screen without the control');
  assert.deepEqual(answer.querySelectorAll('button').map((node) => node.textContent), ['Check again']);
  assert.ok(!page.$('#content').querySelectorAll('a').some((node) => /settings/i.test(node.getAttribute('href') ?? '')), 'nothing on Add project points to Settings');
  // Needs me lists work only, so in this state it never says that nothing is blocked.
  await page.go('#/needs');
  const needs = visibleText(page.$('#main'));
  assert.match(needs, /No work is blocked on you right now/);
  assert.doesNotMatch(needs, /Nothing is blocked/);
  // Once the fix outside AIWorks is made, Check again finds the folder.
  setRules(GOVERNANCE);
  await page.go('#/projects/add');
  page.$('#add-result').querySelectorAll('button').find((node) => node.textContent === 'Check again').click();
  await page.settle();
  assert.ok(visibleText(page.$('#add-result')).startsWith('Ordinary folder, no Git. Folder Recipes.'), visibleText(page.$('#add-result')));
});

test('two projects at once (PROJECT_CONNECTION §8.5): separate records, independent statuses, and no work starts', async (t) => {
  const r = await rig(t);
  const github = r.repository('SampleApp', 'https://github.com/example-org/sampleapp.git');
  const folder = r.folder('Notes');
  const before = { github: snapshot(github), folder: snapshot(folder) };
  assert.equal((await r.post('/api/projects/connect', { path: github, kind: 'github' })).json.ok, true);
  assert.equal((await r.post('/api/projects/connect', { path: folder, kind: 'folder' })).json.ok, true);
  const records = Object.fromEntries(r.store().all('SELECT id, source_kind, mirror_root, worktree_root, governance FROM projects').map((row) => [row.source_kind, row]));
  assert.notEqual(records.github.id, records.folder.id);
  assert.equal(records.github.mirror_root, null, 'a GitHub project has no copy');
  assert.ok(records.folder.mirror_root && !records.folder.mirror_root.startsWith(folder), 'the copy is outside the folder');
  assert.notEqual(records.github.worktree_root, records.folder.worktree_root);
  assert.deepEqual([JSON.parse(records.github.governance).kind, JSON.parse(records.folder.governance).kind], ['registry', 'none']);
  const list = (await r.get('/api/projects')).json;
  assert.deepEqual(list.projects.map((item) => [item.id, item.kind, item.status]).sort(), [['notes', 'Folder', 'ready'], ['sampleapp', 'GitHub', 'ready']]);
  // A failure in one does not change the other.
  r.gh.down = true;
  const checked = (await r.post('/api/projects/check', { projectId: 'sampleapp' })).json;
  assert.deepEqual([checked.ok, checked.code, checked.status, checked.message],
    [false, 'GH_UNREACHABLE', 'unavailable', "GitHub can't be reached right now. Your project is unchanged; AIWorks will check again."]);
  const after = (await r.get('/api/projects')).json;
  assert.deepEqual(after.projects.map((item) => [item.id, item.status]).sort(), [['notes', 'ready'], ['sampleapp', 'unavailable']]);
  r.gh.down = false;
  assert.equal((await r.post('/api/projects/check', { projectId: 'sampleapp' })).json.status, 'ready', 'Check again clears it');
  // Connecting started nothing: no work, no operation and no worker.
  const store = r.store();
  assert.deepEqual([store.all('SELECT id FROM campaigns').length, store.all('SELECT id FROM operations').length], [0, 0]);
  assert.ok(!existsSync(r.spawned), 'no worker started');
  assert.deepEqual({ github: snapshot(github), folder: snapshot(folder) }, before);
  assertNoOtherPath(r, [github, folder]);
});

test('Check again, Move here and Disconnect: the folder is only read, and a stale view is refused', async (t) => {
  const r = await rig(t);
  const root = r.folder('Notes');
  assert.equal((await r.post('/api/projects/connect', { path: root, kind: 'folder' })).json.ok, true);
  const moved = join(r.tmp, 'Notes-moved');
  renameSync(root, moved);
  const gone = (await r.post('/api/projects/check', { projectId: 'notes' })).json;
  assert.deepEqual([gone.code, gone.status, gone.message, gone.action],
    ['ROOT_MISSING', 'unavailable', `AIWorks can't reach ${root}. If it's on a removable drive, plug it in.`, { do: 'check', label: 'Check again' }]);
  const before = snapshot(moved);
  const compare = (await r.post('/api/projects/relocate', { projectId: 'notes', path: moved })).json;
  assert.deepEqual([compare.ok, compare.confirm, compare.match, compare.message],
    [true, true, { files: 3, matches: 3 }, '3 of 3 files here match AIWorks\'s last copy of "Notes".']);
  assert.equal(r.store().get('SELECT root_path FROM projects WHERE id = ?', 'notes').root_path, root, 'nothing moves before the owner confirms');
  const done = (await r.post('/api/projects/relocate', { projectId: 'notes', path: moved, confirm: true })).json;
  assert.deepEqual([done.ok, done.project.root, done.project.id], [true, moved, 'notes']);
  assert.equal((await r.post('/api/projects/check', { projectId: 'notes' })).json.status, 'ready');
  const { version } = (await r.get('/api/projects')).json.projects[0];
  assert.equal((await r.post('/api/projects/disconnect', { projectId: 'notes', version: version + 1 })).status, 409, 'a stale view is refused');
  const left = (await r.post('/api/projects/disconnect', { projectId: 'notes', version })).json;
  assert.deepEqual(left, { ok: true, code: null, message: 'Disconnected "Notes". AIWorks kept its history and its copy; your folder was not touched.', action: null });
  assert.deepEqual((await r.get('/api/projects')).json.projects, []);
  assert.equal((await r.post('/api/projects/check', { projectId: 'notes' })).status, 404);
  assert.deepEqual(snapshot(moved), before, 'Move here and Disconnect leave the folder as it was');
  assertNoOtherPath(r, [root, moved]);
});

// PROJECT_CONNECTION §8.1 to §8.4, read from the design itself: every code's copy, with its placeholders filled.
const DESIGN = readFileSync(join(ROOT, 'docs/design/PROJECT_CONNECTION.md'), 'utf8');
const PATH = '/srv/projects/Notes';
// One detail for every code. SECRET_TRACKED and the file limits name their first example as {path}, so it is the same path.
const DETAIL = { name: 'Notes', path: PATH, canonical: '/srv/projects/notes-real', top: '/srv/projects', main: '/srv/projects/main', repository: 'example-org/sampleapp',
  branch: 'main', ids: ['sampleapp', 'sampleapp-copy'], configPath: 'SampleApp-old', root: '/srv/projects/SampleApp', sha7: 'abc1234', need: 1.5 * 1024 ** 3,
  free: 512 * 1024 ** 2, drive: 'D:\\', count: 3, examples: [PATH], files: 250000, bytes: 3 * 1024 ** 3, a: 'Readme.md', b: 'README.md',
  was: 'example-org/sampleapp', now: 'example-org/other', n: 9, secrets: 2, links: 1, repos: 1, ignored: 5 };
const VALUES = { ...DETAIL, repo: DETAIL.repository, ids: 'sampleapp, sampleapp-copy', need: '1.5 GB', free: '512 MB', size: '3.0 GB' };

test('exact copy for each code of PROJECT_CONNECTION §8, and copy for every code connect can return', () => {
  const section = DESIGN.slice(DESIGN.indexOf('### 8.1'), DESIGN.indexOf('### 8.5'));
  const rows = [...section.matchAll(/^\| `([A-Z_]+)` \| [^|]+ \| (.+?) \| [^|]* \|\r?$/gm)].map(([, code, copy]) => [code, copy]);
  assert.ok(rows.length >= 45, `${rows.length} rows`);
  for (const [code, copy] of rows) {
    // RULES_* appear only after slice S7 (#24), and REGISTRY_CHANGED is a notice no built connect raises: none has copy yet.
    if (/^RULES_/.test(code) || code === 'REGISTRY_CHANGED') { assert.equal(projectMessage(code, DETAIL), null, code); continue; }
    const expected = copy.replace(/\{(\w+)\}/g, (_, key) => String(VALUES[key]));
    assert.equal(projectMessage(code, DETAIL), expected, code);
  }
  // Every code preflight or connect can return has a sentence (some are named by the design without copy).
  for (const code of [...Object.keys(PREFLIGHT_CODES), ...Object.keys(CONNECT_CODES), 'NOT_GITHUB', 'LOCAL_START_OFF', 'EXCLUDED_NOTICE', 'UNCOMMITTED_NOTICE', 'SECRET_TRACKED']) {
    assert.equal(typeof projectMessage(code, DETAIL), 'string', code);
  }
  // A placeholder without its value is never said as "undefined": the status sentence stands in.
  assert.equal(projectMessage('ROOT_MISSING', {}), null);
  assert.equal(projectMessage('CONFIG_CONFLICT', { repository: 'example-org/sampleapp' }), null);
});

test('keyboard only, through the page: Add project is the empty screen’s one action, and a plain folder connects (UX-001, UX-002)', async (t) => {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiworks-connect-page-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const root = join(tmp, 'Recipes');
  write(root, { 'soup.md': '# Soup\n', 'notes/bread.txt': 'flour\n' });
  const before = snapshot(root);
  const page = await openPage(t, { store: 'empty', server: { projectConnection: { gitEnv: { GIT_CEILING_DIRECTORIES: tmp } } } });
  const config = JSON.parse(readFileSync(join(page.dataDir, 'config.json'), 'utf8'));
  writeFileSync(join(page.dataDir, 'config.json'), JSON.stringify({ ...config, governanceRoot: GOVERNANCE, projectConnection: { enabled: true } }));
  // The switch is read on every request: the next refresh shows it.
  await page.refresh();
  await page.go('#/projects');
  const screen = () => visibleText(page.$('#main'));
  assert.match(screen(), /No projects yet\. Add a folder on this computer\. It can be a GitHub repository, a local Git repository or an ordinary folder\. Add project/);
  const add = page.$('#content').querySelectorAll('a').find((node) => node.textContent === 'Add project');
  assert.equal(add.getAttribute('href'), '#/projects/add', 'a link, so it opens with Enter and in a new tab');
  add.click();
  await page.settle();
  assert.equal(page.location.hash, '#/projects/add');
  // Every field has a label around it; the answer is announced in a polite live region.
  const path = page.$('#add-path');
  assert.equal(path.closest('label')?.querySelector('strong').textContent, 'Folder path');
  assert.equal(path.getAttribute('aria-describedby'), 'add-path-hint');
  assert.deepEqual([page.$('#add-result').getAttribute('role'), page.$('#add-result').getAttribute('aria-live')], ['status', 'polite']);
  path.value = root;
  path.dispatchEvent({ type: 'input', preventDefault() {} });
  // Enter in the field submits the form.
  page.$('form[data-add-form]').dispatchEvent({ type: 'submit', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  await page.settle();
  const answer = visibleText(page.$('#add-result'));
  assert.ok(answer.startsWith(`Ordinary folder, no Git. Folder Recipes. ${OWN_COPY} ${LOCAL_START[0]}`), answer);
  assert.equal(page.document.activeElement, page.$('#add-result'), 'focus moves to the answer, so the next Tab reaches Connect project');
  assert.equal(page.$('#add-id').closest('label')?.querySelector('strong').textContent, 'Short name (optional)');
  // One primary action: Connect project; Check folder is now secondary.
  const buttons = page.$('#content').querySelectorAll('button');
  assert.deepEqual(buttons.map((node) => [node.textContent, node.className]), [['Check folder', 'button secondary'], ['Connect project', 'button']]);
  // Everything that acts is a native button, link, field or form, so it works from the keyboard.
  for (const node of page.$('#content').walk()) {
    if (Object.keys(node.listeners).length) assert.ok(['BUTTON', 'A', 'INPUT', 'FORM'].includes(node.tagName), `${node.tagName} acts but is not keyboard-operable`);
    assert.ok(!(Number(node.getAttribute('tabindex')) > 0), 'no positive tabindex');
  }
  buttons[1].click();
  await page.settle();
  assert.equal(page.location.hash, '#/p/recipes');
  // The notice says it connected; the Now screen it opens leads with what the project can do, said once (review 5 G2).
  assert.ok(screen().includes(`Connected "Recipes". ${LOCAL_START[0]}`), screen());
  assert.ok(screen().includes(LOCAL_START[0]), screen());
  assert.ok(!page.$('#content').querySelectorAll('a').some((node) => node.textContent === 'Plan work'), 'no Start work for a project without GitHub');
  assert.deepEqual(snapshot(root), before, 'the folder is unchanged');
  // The Projects screen lists it, with Add project as the screen's action.
  await page.go('#/projects');
  assert.ok(screen().includes(`Recipes Folder Can't start work yet ${LOCAL_START[0]} Open project`), screen());
  assert.ok(page.$('#content').querySelectorAll('a').some((node) => node.textContent === 'Add project'));
});

test('320px: the Add project form and the paths it shows wrap instead of scrolling sideways; touch targets are 44px', () => {
  const css = readFileSync(join(ROOT, 'src/dashboard/public/dashboard.css'), 'utf8');
  assert.match(css, /\.start-form input\[type=text\]\{width:100%;min-height:44px;/);
  assert.match(css, /\.add-form,\.add-form \.button\{overflow-wrap:anywhere\}\.add-form \.button\{white-space:normal;min-height:44px;/);
  const rules = css.slice(css.indexOf('/* Add project (UI13)'), css.indexOf('.instruction-list'));
  assert.doesNotMatch(rules, /(?:^|[;{])(?:min-)?width:\s*\d{3,}px/, 'no fixed width wider than a phone');
});

// aiworks#11 review 5 G2, G3, G9, G10, G14 and G15, through the page: after connecting a project AIWorks cannot start
// work in (a Local Git project, and a GitHub project the project rules do not list), every screen tells one true story
// in owner words. None claims planning or starting, none shows a decision code or issue number outside Settings ›
// Diagnostics, none shows a green Ready, and Release mode lists the project.
test('a connected project AIWorks cannot start work in says so truthfully on every screen, in owner words (review 5 G2, G3, G9, G10, G14, G15)', async (t) => {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiworks-connect-story-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const repo = (name, files, origin = null) => {
    const root = join(tmp, name);
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    write(root, files);
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '-m', 'first');
    if (origin) git(root, 'remote', 'add', 'origin', origin);
    return root;
  };
  // One committed file that looks like a secret (G15).
  const local = repo('Recipes', { 'README.md': '# Recipes\n', 'certs/site.pem': 'synthetic\n' });
  const unlisted = repo('Unlisted', { 'README.md': '# Unlisted\n' }, 'https://github.com/example-org/unlisted-app.git');
  const gh = (args) => args[0] === 'auth' ? { status: 0, stdout: '', stderr: '' }
    : { status: 0, stdout: JSON.stringify({ full_name: args[1].replace(/^repos\//, ''), default_branch: 'main' }), stderr: '' };
  const page = await openPage(t, { store: 'empty', server: { projectConnection: { gh, lsRemote: (_, branch) => branch === 'main', gitEnv: { GIT_CEILING_DIRECTORIES: tmp } } } });
  const config = JSON.parse(readFileSync(join(page.dataDir, 'config.json'), 'utf8'));
  writeFileSync(join(page.dataDir, 'config.json'), JSON.stringify({ ...config, governanceRoot: GOVERNANCE, projectConnection: { enabled: true } }));
  await page.refresh();
  const screen = () => visibleText(page.$('#main'));
  // What the Details disclosures hold, which visibleText leaves out.
  const details = () => page.$('#content').querySelectorAll('details').map((node) => node.textContent).join(' ');
  // A claim of planning or starting, a Ready, and decision codes or issue numbers.
  const claims = /plan work here|can plan|You can open|not built yet|\bReady\b|is ready/;
  const codes = /\b[DQ]\d+\b|#\d+|\b[A-Z]+_[A-Z_]+\b/;
  const owner = (text, where) => {
    assert.doesNotMatch(text, claims, `${where}: ${text}`);
    assert.doesNotMatch(text, codes, `${where}: ${text}`);
  };
  const check = async (root) => {
    await page.go('#/projects/add');
    const path = page.$('#add-path');
    path.value = root;
    path.dispatchEvent({ type: 'input', preventDefault() {} });
    page.$('form[data-add-form]').dispatchEvent({ type: 'submit', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
    await page.settle();
    return page.$('#add-result');
  };
  const connect = async () => {
    page.$('#content').querySelectorAll('button').find((node) => node.textContent === 'Connect project').click();
    await page.settle();
  };

  // Local Git. Check folder: no stray "null" (G14), and the secrets warning in its singular form (G15).
  const found = await check(local);
  assert.doesNotMatch(found.textContent, /null/, 'a check without a confirm step adds no "null" text');
  const answer = visibleText(found);
  assert.match(answer, /^Git repository, no GitHub remote\. Folder Recipes\./);
  assert.ok(answer.includes('1 committed file looks like a secret, for example certs/site.pem. Workers will see it.'), answer);
  owner(answer, 'Add project result, Local Git');
  await connect();
  assert.equal(page.location.hash, '#/p/recipes');
  // The connect notice and Now: one true sentence, and no Start work.
  assert.match(screen(), /Connected "Recipes"\./);
  assert.ok(screen().includes(LOCAL_START[0]), screen());
  owner(screen(), 'connect notice and Now, Local Git');
  assert.ok(!page.$('#content').querySelectorAll('a').some((node) => /^(Start|Plan) work$/.test(node.textContent) || /\/start$/.test(node.getAttribute('href') ?? '')));
  // Now › Details: who decides, what each decision allows and where to act, in owner words.
  owner(details(), 'Now › Details, Local Git');
  assert.ok(details().includes(LOCAL_START[1]), details());
  assert.match(LOCAL_START[1], /your project rules on this computer/i);
  assert.match(LOCAL_START[1], /\byou decide\b/i);
  assert.match(LOCAL_START[1], /Settings › Diagnostics/);
  await page.go('#/p/recipes/work');
  owner(screen(), 'Work, Local Git');
  assert.ok(screen().includes(LOCAL_START[0]), screen());

  // A GitHub project the project rules do not list. Check folder offers the two ways to connect, with no "null".
  const seen = await check(unlisted);
  assert.doesNotMatch(seen.textContent, /null/);
  owner(visibleText(seen), 'Add project result, unlisted GitHub');
  assert.ok(visibleText(seen).includes(UNREGISTERED), visibleText(seen));
  await connect();
  assert.equal(page.location.hash, '#/p/example-org%2Funlisted-app');
  owner(screen(), 'connect notice and Now, unlisted GitHub');
  owner(details(), 'Now › Details, unlisted GitHub');
  assert.ok(screen().includes(UNREGISTERED), screen());
  assert.ok(!page.$('#content').querySelectorAll('a').some((node) => /^(Start|Plan) work$/.test(node.textContent) || /\/start$/.test(node.getAttribute('href') ?? '')), 'no Start work where work cannot start');
  await page.go('#/p/example-org%2Funlisted-app/work');
  owner(screen(), 'Work, unlisted GitHub');
  assert.ok(screen().includes(UNREGISTERED), screen());

  // Projects: one state that matches its sentence, never a green Ready (G9).
  await page.go('#/projects');
  owner(screen(), 'Projects');
  assert.ok(screen().includes(`Recipes Local Git Can't start work yet ${LOCAL_START[0]} Open project`), screen());
  assert.ok(!page.$('#content').querySelectorAll('.badge').some((node) => node.className.includes('done')), 'no green badge');
  // Settings: the same state, and a Release mode entry for each project Settings lists (G10).
  await page.go('#/settings');
  owner(screen(), 'Settings');
  assert.ok(screen().includes("Recipes · Local Git Can't start work yet. Connected from the folder Recipes."), screen());
  assert.ok(screen().includes('unlisted-app · GitHub Needs setup.'), screen());
  const release = screen().slice(screen().indexOf('Release mode'));
  assert.ok(release.includes('Recipes Release does not apply yet to a project without GitHub'), release);
  assert.ok(release.includes('unlisted-app Review only · On'), release);
  // The decision codes and issue numbers are in Diagnostics.
  await page.go('#/settings/diagnostics');
  assert.match(screen(), /Recipes: starting work is off \(LOCAL_START_OFF\)\. It waits for D2\b.*#24.*D4\b.*Q2.*#32/);
  assert.match(screen(), /unlisted-app: needs setup \(REGISTRY_MISSING\)/);
});
