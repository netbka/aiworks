// aiworks#7 slice S1 (STA1): project records exist in the store and survive restarts.
// Disposable SQLite stores in temporary folders only; no model, network, git, gh or GitHub calls.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SQLITE } from './helpers.mjs';
const { DatabaseSync } = SQLITE ? await import('node:sqlite') : {};
const { Store, STORE_VERSION, ConflictError } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const p = SQLITE ? await import('../../src/supervisor/projects.mjs') : {};
const options = { skip: SQLITE ? false : 'node:sqlite requires Node >= 22.5; the supervisor refuses to run without it' };
const PROJECT_TABLES = ['projects', 'project_baselines', 'project_overlays'];

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-projects-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function memory(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}
const github = (dir, patch = {}) => ({
  id: 'site', tenant_id: 'netbka', name: 'Site', source_kind: 'github', root_path: join(dir, 'site'),
  github_repository: 'netbka/site', base_branch: 'main', ...patch,
});
const plain = (dir, patch = {}) => ({ id: 'notes', tenant_id: 'netbka', name: 'Notes', source_kind: 'folder', root_path: join(dir, 'notes'), ...patch });
const code = (expected) => (error) => { assert.equal(error.code, expected, error.message); return true; };
const projectJournal = (store) => store.all("SELECT * FROM journal WHERE kind LIKE 'project-%' ORDER BY seq");

test('an older store gains the project tables with the store version unchanged; read-only opens never migrate', options, (t) => {
  const path = join(folder(t), 'supervisor.db');
  let store = new Store(path);
  store.journal('older-campaign', 'kept', { a: 1 }, 1);
  store.close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE projects; DROP TABLE project_baselines; DROP TABLE project_overlays;');
  raw.close();
  const tables = (s) => s.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${PROJECT_TABLES.map(() => '?').join(', ')})`, ...PROJECT_TABLES);
  const readOnly = new Store(path, { readOnly: true });
  assert.equal(tables(readOnly).length, 0, 'a read-only open of an older store does not add tables');
  readOnly.close();
  for (let i = 0; i < 2; i++) {
    store = new Store(path);
    assert.deepEqual(tables(store).map((row) => row.name).sort(), [...PROJECT_TABLES].sort());
    assert.equal(store.get("SELECT value FROM meta WHERE key = 'store_version'").value, String(STORE_VERSION));
    assert.equal(STORE_VERSION, 1);
    assert.equal(store.all("SELECT * FROM journal WHERE kind = 'kept'").length, 1, 'existing rows are untouched');
    store.close();
  }
});

test('a project record survives a restart with every field intact', options, (t) => {
  const dir = folder(t);
  const path = join(dir, 'supervisor.db');
  let store = new Store(path);
  const created = p.createProject(store, github(dir, {
    root_file_id: 'f'.repeat(64), worktree_root: join(dir, 'worktrees', 'site'), status: 'ready',
    governance: { kind: 'registry', entryId: 'site', entryDigest: 'd'.repeat(64), governanceRevision: 'a'.repeat(40) },
    capabilities: { plan: { allowed: true }, startWork: { allowed: true }, publish: { allowed: true }, apply: { allowed: false, reason: 'NOT_AVAILABLE' } },
    last_preflight: { codes: ['SECRET_TRACKED'], counts: { files: 3 }, examples: ['config/.env.example'] },
  }), 1000);
  store.close();
  store = new Store(path);
  try {
    const read = p.project(store, 'site');
    assert.deepEqual(read, created);
    assert.equal(read.version, 1);
    assert.equal(read.fingerprint, 'netbka/site', 'a GitHub project is identified by owner/name');
    assert.equal(read.governance.kind, 'registry');
    assert.equal(read.capabilities.plan.allowed, true);
    assert.deepEqual(read.last_preflight.codes, ['SECRET_TRACKED']);
    assert.deepEqual(read.exclusions, []);
    assert.deepEqual(p.projects(store).map((row) => row.id), ['site']);
    const local = p.createProject(store, plain(dir, { exclusions: ['build', 'tmp/cache'] }), 2000);
    assert.equal(local.status, 'needs-setup', 'a new record is not Ready until a check says so');
    assert.deepEqual(Object.keys(local.capabilities), p.CAPABILITIES);
    assert.ok(Object.values(local.capabilities).every((c) => c.allowed === false && c.reason === 'NOT_CHECKED'));
    assert.deepEqual(local.governance, { kind: 'none' });
    assert.equal(local.fingerprint, null);
  } finally {
    store.close(); // before the folder is removed: Windows cannot delete an open database
  }
});

test('updates and disconnects use compare-and-swap on version', options, (t) => {
  const dir = folder(t);
  const store = memory(t);
  const first = p.createProject(store, plain(dir), 1);
  const renamed = p.updateProject(store, 'notes', first.version, { name: '  Notebook ', status: 'ready', reason: null }, 2);
  assert.equal(renamed.version, 2);
  assert.equal(renamed.name, 'Notebook');
  assert.equal(renamed.updated_at, 2);
  assert.throws(() => p.updateProject(store, 'notes', first.version, { name: 'Stale' }, 3), ConflictError);
  assert.throws(() => p.disconnectProject(store, 'notes', first.version, 3), ConflictError);
  assert.equal(p.project(store, 'notes').name, 'Notebook', 'a stale write changes nothing');
  assert.equal(p.project(store, 'notes').disconnected_at, null);
  for (const key of ['id', 'tenant_id', 'source_kind', 'root_path', 'root_key', 'fingerprint', 'github_repository', 'version', 'disconnected_at']) {
    assert.throws(() => p.updateProject(store, 'notes', 2, { [key]: 'x' }, 4), code('PROJECT_INVALID'), `${key} is identity, not a field to edit`);
  }
  assert.throws(() => p.updateProject(store, 'missing', 1, { name: 'x' }, 4), code('PROJECT_NOT_FOUND'));
  const gone = p.disconnectProject(store, 'notes', 2, 5);
  assert.equal(gone.disconnected_at, 5);
  assert.throws(() => p.updateProject(store, 'notes', gone.version, { name: 'Again' }, 6), code('PROJECT_DISCONNECTED'));
});

test('project ids follow the id rule', options, (t) => {
  const dir = folder(t);
  const store = memory(t);
  for (const id of ['A-site', '-site', 's', 'site_1', 'site.1', 'x'.repeat(41), '', 'site ', 'säte', 42, undefined]) {
    assert.throws(() => p.createProject(store, plain(dir, { id }), 1), code('PROJECT_ID_INVALID'), `refuses ${JSON.stringify(id)}`);
  }
  for (const [n, id] of ['ab', '0site', 'my-site-2', 'x'.repeat(40)].entries()) {
    assert.equal(p.createProject(store, plain(dir, { id, root_path: join(dir, `ok-${n}`) }), 1).id, id);
  }
  assert.equal(p.projects(store).length, 4, 'only valid ids were saved');
});

test('a disconnected id is a tombstone and is never reused; its folder can be connected under a new id', options, (t) => {
  const dir = folder(t);
  const store = memory(t);
  const first = p.createProject(store, plain(dir), 1);
  assert.throws(() => p.createProject(store, plain(dir, { root_path: join(dir, 'other') }), 2), code('PROJECT_ID_TAKEN'));
  p.disconnectProject(store, 'notes', first.version, 3);
  assert.deepEqual(p.projects(store), [], 'a tombstone is not a live project');
  assert.equal(p.projects(store, { includeDisconnected: true }).length, 1, 'the tombstone keeps its history');
  assert.equal(p.disconnectProject(store, 'notes', 99, 4).disconnected_at, 3, 'disconnecting again changes nothing');
  assert.throws(() => p.createProject(store, plain(dir), 5), (error) => {
    assert.equal(error.code, 'PROJECT_ID_TAKEN');
    assert.match(error.message, /never reused/);
    return true;
  });
  assert.throws(() => p.createProject(store, plain(dir, { root_path: join(dir, 'elsewhere') }), 5), code('PROJECT_ID_TAKEN'));
  const again = p.createProject(store, plain(dir, { id: 'notes-2' }), 6);
  assert.equal(again.root_key, first.root_key, 'the same folder connects again under a new id');
  assert.equal(p.project(store, 'notes').disconnected_at, 3, 'the old record stays a tombstone');
});

test('one live project per root and per GitHub repository', options, (t) => {
  const dir = folder(t);
  const store = memory(t);
  p.createProject(store, github(dir), 1);
  assert.throws(() => p.createProject(store, plain(dir, { root_path: join(dir, 'site') }), 2), (error) => {
    assert.equal(error.code, 'ALREADY_CONNECTED');
    assert.equal(error.projectId, 'site');
    assert.equal(error.message, 'This folder is already connected as "Site".');
    return true;
  });
  assert.throws(() => p.createProject(store, github(dir, { id: 'site-copy', root_path: join(dir, 'copy'), github_repository: 'NetBKA/Site' }), 2),
    (error) => {
      assert.equal(error.code, 'ALREADY_CONNECTED');
      assert.equal(error.message, 'This repository is already connected as "Site".');
      return true;
    }, 'GitHub names compare without case');
  // The partial unique indexes hold even for a writer that skips the module's checks.
  const row = store.get("SELECT * FROM projects WHERE id = 'site'");
  assert.throws(() => store.insert('projects', { ...row, id: 'raw-root', github_repository: null }), /UNIQUE/);
  assert.throws(() => store.insert('projects', { ...row, id: 'raw-repo', root_key: 'elsewhere', github_repository: 'NETBKA/SITE' }), /UNIQUE/);
  p.disconnectProject(store, 'site', 1, 3);
  store.insert('projects', { ...row, id: 'raw-after', version: 1 });
  assert.equal(store.all("SELECT * FROM projects WHERE root_key = ?", row.root_key).length, 2, 'tombstones do not hold the root');
});

test('the root key unifies separators and, on Windows only, case', options, (t) => {
  assert.equal(p.rootKey('D:\\Projects\\My-App', 'win32'), 'd:/projects/my-app');
  assert.equal(p.rootKey('/home/me/My-App', 'linux'), '/home/me/My-App');
  assert.equal(p.rootKey('/home/me/My-App', 'darwin'), '/home/me/My-App');
  const dir = folder(t);
  const store = memory(t);
  p.createProject(store, plain(dir, { root_path: join(dir, 'Case') }), 1);
  const lower = () => p.createProject(store, plain(dir, { id: 'case-2', root_path: join(dir, 'case') }), 2);
  // Windows paths compare without case, so the same folder spelled differently is one project; Linux paths are case-sensitive.
  if (process.platform === 'win32') assert.throws(lower, code('ALREADY_CONNECTED'));
  else assert.equal(lower().id, 'case-2');
});

test('a remote URL with user info is stored as owner/name only', options, (t) => {
  const dir = folder(t);
  const store = memory(t);
  const secret = 'ghp_SYNTHETICTOKEN0123456789';
  const remotes = [
    `https://x-access-token:${secret}@github.com/NetBKA/site.git`,
    `https://${secret}@github.com/NetBKA/site/`,
    'git@github.com:NetBKA/site.git',
    'ssh://git@github.com:22/NetBKA/site.git',
    'https://github.com/NetBKA/site?tab=readme',
    'NetBKA/site',
  ];
  for (const remote of remotes) assert.equal(p.githubRepository(remote), 'NetBKA/site', remote.replace(secret, '***'));
  for (const remote of ['https://gitlab.com/netbka/site.git', `https://${secret}@example.com/netbka/site`, 'file:///tmp/site.git',
    'netbka/site/extra', 'netbka', 'https://github.com/netbka', 'netbka/..', '']) {
    assert.throws(() => p.githubRepository(remote), (error) => {
      assert.equal(error.code, 'PROJECT_INVALID');
      assert.ok(!error.message.includes(secret), 'the refusal never echoes a credential');
      return true;
    }, remote.replace(secret, '***'));
  }
  const saved = p.createProject(store, github(dir, { github_repository: remotes[0] }), 1);
  assert.equal(saved.github_repository, 'NetBKA/site');
  assert.equal(saved.fingerprint, 'NetBKA/site');
  const dump = JSON.stringify([store.all('SELECT * FROM projects'), store.all('SELECT * FROM journal')]);
  assert.ok(!dump.includes(secret) && !dump.includes('x-access-token'), 'no user info reaches the store');
});

test('connect and disconnect write project journal entries outside any campaign', options, (t) => {
  const dir = folder(t);
  const store = memory(t);
  const created = p.createProject(store, github(dir, { github_repository: 'https://github.com/netbka/site.git' }), 10);
  assert.throws(() => p.createProject(store, github(dir, { id: 'dup' }), 11), code('ALREADY_CONNECTED'));
  p.updateProject(store, 'site', created.version, { status: 'ready' }, 12);
  p.disconnectProject(store, 'site', 2, 13);
  p.disconnectProject(store, 'site', 3, 14);
  const entries = projectJournal(store);
  assert.deepEqual(entries.map((e) => [e.campaign_id, e.kind, e.at]), [[null, 'project-connected', 10], [null, 'project-disconnected', 13]],
    'a refused create and a repeated disconnect write nothing');
  assert.deepEqual(entries[0].detail, { projectId: 'site', tenantId: 'netbka', sourceKind: 'github', githubRepository: 'netbka/site' });
  assert.deepEqual(entries[1].detail, { projectId: 'site' });
});

test('starting work stays off for projects without GitHub, and records keep to their kind', options, (t) => {
  const dir = folder(t);
  const store = memory(t);
  const off = { plan: { allowed: true }, startWork: { allowed: true } };
  assert.throws(() => p.createProject(store, plain(dir, { capabilities: off }), 1), code('LOCAL_START_OFF'));
  assert.throws(() => p.createProject(store, plain(dir, { id: 'repo', source_kind: 'local-git', local_branch: 'main', capabilities: off }), 1), code('LOCAL_START_OFF'));
  const local = p.createProject(store, plain(dir, { id: 'repo', source_kind: 'local-git', local_branch: 'main', fingerprint: 'a'.repeat(40) }), 1);
  assert.throws(() => p.updateProject(store, 'repo', local.version, { capabilities: off }, 2), code('LOCAL_START_OFF'));
  assert.equal(p.project(store, 'repo').capabilities.startWork.allowed, false);
  const refused = [
    plain(dir, { id: 'a1', github_repository: 'netbka/site' }),
    plain(dir, { id: 'a2', local_branch: 'main' }),
    plain(dir, { id: 'a3', fingerprint: 'x' }),
    plain(dir, { id: 'a4', root_path: 'relative/notes' }),
    plain(dir, { id: 'a5', exclusions: [join(dir, 'abs')] }),
    plain(dir, { id: 'a6', source_kind: 'svn' }),
    plain(dir, { id: 'a7', status: 'connected' }),
    plain(dir, { id: 'a8', name: 'n'.repeat(81) }),
    plain(dir, { id: 'a9', governance: { kind: 'registry' } }),
    plain(dir, { id: 'b1', capabilities: { plan: { allowed: false } } }),
    plain(dir, { id: 'b2', capabilities: { publish: { allowed: true } } }),
    github(dir, { id: 'b3', exclusions: ['build'] }),
    github(dir, { id: 'b4', mirror_root: join(dir, 'mirror') }),
    github(dir, { id: 'b5', github_repository: undefined }),
  ];
  for (const input of refused) assert.throws(() => p.createProject(store, input, 3), code('PROJECT_INVALID'), input.id);
  assert.deepEqual(p.projects(store).map((row) => row.id), ['repo']);
  assert.equal(projectJournal(store).length, 1);
});
