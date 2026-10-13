// aiworks#7 slice S2 (STA2): a read-only preflight tells a GitHub checkout, a local Git repository and a plain folder
// apart, and never changes the source. Real temporary folders, disposable git repositories and a synthetic git wrapper
// only; no model, network, gh or GitHub calls. A GitHub remote is a URL that is never contacted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { after, test } from 'node:test';
import { GOVERNANCE, ROOT, SQLITE } from './helpers.mjs';
// project-preflight.mjs reuses the project-record rules of projects.mjs, which loads the store and so node:sqlite.
const pf = SQLITE ? await import('../../src/supervisor/project-preflight.mjs') : {};
const { rootKey } = SQLITE ? await import('../../src/supervisor/projects.mjs') : {};
const options = { skip: SQLITE ? false : 'node:sqlite requires Node >= 22.5; the supervisor refuses to run without it' };
const posixOnly = process.platform === 'win32' ? 'Windows ACLs are not changed by chmod; the injected-io test covers this code on Windows' : false;
const rootUser = typeof process.getuid === 'function' && process.getuid() === 0;

// The real path, so a short-name or linked temporary folder never looks like a link to preflight. Git never looks above
// it: a host whose profile folder is itself a repository would otherwise make every test folder GIT_SUBFOLDER.
const TOP = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiworks-preflight-')));
after(() => rmSync(TOP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const GIT_ENV = { GIT_CEILING_DIRECTORIES: TOP };
function base(t) {
  const dir = mkdtempSync(join(TOP, 'case-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}
const git = (cwd, ...args) => {
  const out = spawnSync('git', ['-c', 'user.name=Preflight Test', '-c', 'user.email=preflight-test@example.invalid', ...args],
    { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...GIT_ENV } });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};
function repository(dir, name, { origin = null, files = { 'README.md': '# Project\n' }, commit = true } = {}) {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, '..'), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  if (commit) { git(path, 'add', '-A'); git(path, 'commit', '-q', '-m', 'initial'); }
  if (origin) git(path, 'remote', 'add', 'origin', origin);
  return path;
}
function folder(dir, name, files) {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, '..'), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  return path;
}
/** A git that records every command line and its GIT_OPTIONAL_LOCKS, then runs the real git. */
function recordingGit(dir) {
  const log = join(dir, 'git-calls.jsonl');
  const script = join(dir, 'recording-git.mjs');
  writeFileSync(script, [
    "import { spawnSync } from 'node:child_process';",
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), locks: process.env.GIT_OPTIONAL_LOCKS ?? null }) + '\\n');`,
    "const out = spawnSync('git', process.argv.slice(2), { stdio: 'inherit', windowsHide: true });",
    'process.exit(out.status ?? 1);',
  ].join('\n'));
  return {
    command: [process.execPath, script],
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
  };
}
/** Everything in a tree, including .git: type, mode, size, mtimeNs, content hash and link target. Never follows a link. */
function snapshot(root) {
  const out = {};
  const walk = (dir, rel) => {
    const names = readdirSync(dir).sort();
    out[`${rel}/`] = names.join('\n');
    for (const name of names) {
      const path = join(dir, name);
      const key = `${rel}/${name}`;
      const stat = lstatSync(path, { bigint: true });
      const entry = { mode: String(stat.mode), size: String(stat.size), mtimeNs: String(stat.mtimeNs) };
      if (stat.isSymbolicLink()) out[key] = { ...entry, link: readlinkSync(path) };
      else if (stat.isDirectory()) { out[key] = { mode: entry.mode, mtimeNs: entry.mtimeNs, dir: true }; walk(path, key); }
      else out[key] = { ...entry, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    }
  };
  walk(root, '');
  return out;
}
/** The stored record a later slice would save for this preflight result. */
const record = (result, patch = {}) => ({
  id: 'proj', name: 'Proj', source_kind: result.kind, root_path: result.root, root_key: result.rootKey,
  root_file_id: result.rootFileId, fingerprint: result.fingerprint, mirror_root: null, worktree_root: null,
  exclusions: [], disconnected_at: null, ...patch,
});
const defaults = (extra = {}) => ({ governanceRoot: GOVERNANCE, gitEnv: GIT_ENV, ...extra });
const check = (result, code) => {
  assert.equal(result.code, code, `expected ${code}, got ${result.code} ${JSON.stringify(result.detail)}`);
  assert.equal(result.ok, false);
  assert.equal(result.status, pf.PREFLIGHT_CODES[code]);
  return result;
};
const eacces = (path) => Object.assign(new Error(`EACCES: permission denied, ${path}`), { code: 'EACCES' });

test('a GitHub checkout, a local Git repository and a plain folder are told apart', options, (t) => {
  const dir = base(t);
  const site = repository(dir, 'site', { origin: 'https://someone:ghp_secretToken@github.com/example-org/site.git' });
  const ssh = repository(dir, 'ssh', { origin: 'git@github.com:example-org/ssh-site.git' });
  const local = repository(dir, 'local');
  const elsewhere = repository(dir, 'elsewhere', { origin: 'https://git.example.invalid/team/elsewhere.git' });
  const plain = folder(dir, 'notes', { 'a.txt': 'a\r\n', 'docs/b.md': '# b\n' });

  const github = pf.preflight(site, defaults());
  assert.equal(github.ok, true, JSON.stringify(github));
  assert.equal(github.code, null);
  assert.equal(github.kind, 'github');
  assert.equal(github.proposedKind, 'github');
  assert.equal(github.repository, 'example-org/site');
  assert.equal(github.fingerprint, 'example-org/site');
  assert.equal(github.branch, 'main');
  assert.match(github.head, /^[0-9a-f]{40}$/);
  assert.equal(github.root, site);
  assert.equal(github.rootKey, rootKey(site));
  assert.match(github.rootFileId, /^[0-9a-f]{64}$/);
  assert.equal(github.confirm, null);
  assert.equal(github.scan, null, 'a Git project is not scanned file by file');
  assert.doesNotMatch(JSON.stringify(github), /someone|ghp_secretToken/, 'user info in the remote never reaches the result');
  assert.equal(pf.preflight(ssh, defaults()).repository, 'example-org/ssh-site');

  const repo = pf.preflight(local, defaults());
  assert.equal(repo.ok, true);
  assert.equal(repo.kind, 'local-git');
  assert.equal(repo.repository, null);
  assert.equal(repo.fingerprint, git(local, 'rev-list', '--max-parents=0', 'HEAD'), 'a local repository is identified by its root commits');

  const other = pf.preflight(elsewhere, defaults());
  assert.equal(other.kind, 'local-git', 'a non-GitHub origin is ignored and the project is Local Git');
  assert.equal(other.repository, null);
  assert.doesNotMatch(JSON.stringify(other), /example\.invalid/);

  const notes = pf.preflight(plain, defaults());
  assert.equal(notes.ok, true);
  assert.equal(notes.kind, 'folder');
  assert.equal(notes.fingerprint, null);
  assert.equal(notes.branch, null);
  assert.deepEqual({ files: notes.scan.files, bytes: notes.scan.bytes }, { files: 2, bytes: 7 });
  assert.deepEqual(notes.notices, []);

  const switched = pf.preflight(site, defaults({ kind: 'local-git' }));
  assert.equal(switched.proposedKind, 'github');
  assert.equal(switched.kind, 'local-git', 'the owner may connect an unregistered GitHub checkout as Local Git');
  assert.equal(switched.repository, null);
  assert.equal(switched.fingerprint, git(site, 'rev-list', '--max-parents=0', 'HEAD'));
  assert.equal(pf.preflight(plain, defaults({ kind: 'github' })).kind, 'folder', 'a kind the folder cannot have is not taken');
});

test('every path code of design section 8.1 is returned', options, (t) => {
  const dir = base(t);
  const plain = folder(dir, 'plain', { 'a.txt': 'a' });
  const file = join(dir, 'file.txt');
  writeFileSync(file, 'x');
  const notAbsolute = ['', '   ', 'relative/dir', `${plain}${'x'.repeat(1025)}`, `${plain}\u0007`, null];
  if (process.platform === 'win32') notAbsolute.push('\\no-drive', 'C:relative');
  for (const input of notAbsolute) check(pf.preflight(input, defaults()), 'PATH_NOT_ABSOLUTE');
  check(pf.preflight(join(dir, 'missing'), defaults()), 'PATH_NOT_FOUND');
  check(pf.preflight(file, defaults()), 'PATH_NOT_DIRECTORY');
  check(pf.preflight('\\\\server\\share\\project', defaults()), 'PATH_NETWORK');
  check(pf.preflight('//server/share/project', defaults()), 'PATH_NETWORK');
  // Whether a mapped drive letter resolves to a UNC path is unknown (design 4.1), so the canonical root is checked too.
  check(pf.preflight(plain, defaults({ io: { realpath: () => '\\\\server\\share\\plain' } })), 'PATH_NETWORK');
  for (const device of ['\\\\?\\C:\\project', '\\\\.\\C:\\project']) check(pf.preflight(device, defaults()), 'PATH_PROTECTED');
  check(pf.preflight(plain, defaults({ io: { stat: (path) => { throw eacces(path); } } })), 'PATH_UNREADABLE');
  check(pf.preflight(plain, defaults({ io: { readdir: (path) => { throw eacces(path); } } })), 'PATH_UNREADABLE');
  check(pf.preflight(plain, { governanceRoot: join(dir, 'no-governance') }), 'GOVERNANCE_ROOT_MISSING');
  check(pf.preflight(plain, { governanceRoot: folder(dir, 'not-governance', { 'README.md': 'x' }) }), 'GOVERNANCE_ROOT_MISSING');
  check(pf.preflight(plain, {}), 'GOVERNANCE_ROOT_MISSING');
  check(pf.preflight(plain, defaults({ git: [join(dir, 'no-such-git')] })), 'GIT_CLI_MISSING');
});

test('a drive root, system folders, the profile root and AIWorks own folders are refused', options, (t) => {
  const dir = base(t);
  const plain = folder(dir, 'plain', { 'a.txt': 'a' });
  const data = folder(dir, 'data', { 'x.txt': 'x' });
  const inData = folder(dir, 'data/project', { 'x.txt': 'x' });
  const system = folder(dir, 'system', {});
  const inSystem = folder(dir, 'system/app', { 'x.txt': 'x' });
  check(pf.preflight(parse(dir).root, defaults()), 'PATH_PROTECTED');
  check(pf.preflight(ROOT, defaults()), 'PATH_PROTECTED');
  check(pf.preflight(join(ROOT, 'src'), defaults()), 'PATH_PROTECTED');
  check(pf.preflight(GOVERNANCE, defaults()), 'PATH_PROTECTED');
  check(pf.preflight(plain, defaults({ home: plain })), 'PATH_PROTECTED');
  assert.equal(pf.preflight(inData, defaults({ home: data })).ok, true, 'a folder inside the profile is a normal project');
  for (const name of ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)']) {
    check(pf.preflight(inSystem, defaults({ env: { [name]: system } })), 'PATH_PROTECTED');
  }
  check(pf.preflight(data, defaults({ protectedRoots: [data] })), 'PATH_PROTECTED');
  check(pf.preflight(inData, defaults({ protectedRoots: [data] })), 'PATH_PROTECTED');
  check(pf.preflight(dir, defaults({ protectedRoots: [data] })), 'PATH_PROTECTED');
  const other = { id: 'other', name: 'Other', source_kind: 'folder', root_key: rootKey(join(dir, 'elsewhere')), disconnected_at: null };
  check(pf.preflight(inData, defaults({ projects: [{ ...other, mirror_root: data }] })), 'PATH_PROTECTED');
  check(pf.preflight(dir, defaults({ projects: [{ ...other, worktree_root: data }] })), 'PATH_PROTECTED');
});

test('overlap, reconnect, a replaced root, a changed identity and a missing root have their codes', options, (t) => {
  const dir = base(t);
  const plain = folder(dir, 'plain', { 'a.txt': 'a', 'sub/b.txt': 'b' });
  const first = pf.preflight(plain, defaults());
  assert.equal(first.ok, true);
  const saved = record(first, { name: 'Plain' });
  const overlap = check(pf.preflight(join(plain, 'sub'), defaults({ projects: [saved] })), 'PATH_OVERLAP');
  assert.deepEqual(overlap.detail, { projectId: 'proj', name: 'Plain' });
  check(pf.preflight(dir, defaults({ projects: [saved] })), 'PATH_OVERLAP');
  assert.equal(pf.preflight(join(plain, 'sub'), defaults({ projects: [{ ...saved, disconnected_at: 5 }] })).ok, true,
    'a disconnected project does not hold its folder');
  const again = check(pf.preflight(plain, defaults({ projects: [saved] })), 'ALREADY_CONNECTED');
  assert.deepEqual(again.detail, { projectId: 'proj', name: 'Plain' });
  const light = pf.checkProject(saved, defaults());
  assert.equal(light.ok, true, JSON.stringify(light));
  assert.equal(light.code, null);

  // Moved away, not deleted: the old folder keeps its file id, so a new folder at the path cannot reuse it (ext4 can).
  renameSync(plain, `${plain}-moved`);
  const missing = check(pf.checkProject(saved, defaults()), 'ROOT_MISSING');
  assert.equal(missing.status, 'unavailable');
  folder(dir, 'plain', { 'a.txt': 'a' });
  check(pf.checkProject(saved, defaults()), 'ROOT_REPLACED');

  const repo = repository(dir, 'repo', { origin: 'https://github.com/example-org/site.git' });
  const github = record(pf.preflight(repo, defaults()));
  assert.equal(pf.checkProject(github, defaults()).ok, true);
  assert.equal(pf.checkProject({ ...github, fingerprint: 'Example-Org/Site' }, defaults()).ok, true, 'GitHub names ignore case');
  git(repo, 'remote', 'set-url', 'origin', 'https://github.com/example-org/other.git');
  const changed = check(pf.checkProject(github, defaults()), 'IDENTITY_CHANGED');
  assert.deepEqual([changed.detail.was, changed.detail.now], ['example-org/site', 'example-org/other']);

  const local = repository(dir, 'local');
  const localRecord = record(pf.preflight(local, defaults()));
  rmSync(local, { recursive: true, force: true });
  repository(dir, 'local', { files: { 'other.md': 'a different history\n' } });
  check(pf.checkProject({ ...localRecord, root_file_id: null }, defaults()), 'IDENTITY_CHANGED');

  const became = folder(dir, 'became', { 'a.txt': 'a' });
  const folderRecord = record(pf.preflight(became, defaults()));
  git(became, 'init', '-q', '-b', 'main');
  git(became, 'add', '-A');
  git(became, 'commit', '-q', '-m', 'now a repository');
  check(pf.checkProject(folderRecord, defaults()), 'IDENTITY_CHANGED');
});

test('a junction or symbolic link as the chosen path asks the owner to confirm the real folder', options, (t) => {
  const dir = base(t);
  const real = folder(dir, 'real', { 'a.txt': 'a' });
  const link = join(dir, 'link');
  symlinkSync(real, link, 'junction'); // No privilege needed on Windows; a directory symlink elsewhere.
  const result = pf.preflight(link, defaults());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.confirm, { code: 'PATH_IS_LINK', canonical: real });
  assert.equal(result.root, real, 'only the real path is used');
  assert.equal(pf.preflight(real, defaults()).confirm, null);
});

test('a real unreadable folder gives PATH_UNREADABLE', { ...options, skip: options.skip || posixOnly || (rootUser && 'root ignores file permissions') }, (t) => {
  const dir = base(t);
  const locked = folder(dir, 'locked', { 'a.txt': 'a' });
  chmodSync(locked, 0o100); // Can be entered, not listed.
  try { check(pf.preflight(locked, defaults()), 'PATH_UNREADABLE'); } finally { chmodSync(locked, 0o700); }
});

test('Git detection refuses a bare repository, a subfolder, a linked worktree, an untrusted and an empty repository', options, (t) => {
  const dir = base(t);
  const bare = join(dir, 'bare.git');
  git(dir, 'init', '-q', '--bare', bare);
  check(pf.preflight(bare, defaults()), 'GIT_BARE');
  const main = repository(dir, 'main', { files: { 'README.md': '# main\n', 'src/app.js': 'x\n' } });
  const sub = check(pf.preflight(join(main, 'src'), defaults()), 'GIT_SUBFOLDER');
  assert.equal(rootKey(sub.detail.top), rootKey(main));
  check(pf.preflight(join(main, '.git'), defaults()), 'GIT_SUBFOLDER');
  const linked = join(dir, 'linked');
  git(main, 'worktree', 'add', '-q', '-b', 'side', linked);
  const worktree = check(pf.preflight(linked, defaults()), 'GIT_WORKTREE');
  assert.equal(rootKey(worktree.detail.main), rootKey(main));
  const empty = repository(dir, 'empty', { commit: false, origin: 'https://github.com/example-org/empty.git' });
  const none = check(pf.preflight(empty, defaults()), 'GIT_NO_COMMITS');
  assert.equal(none.kind, 'local-git');
  assert.equal(none.detail.alternative, 'folder');
  const asFolder = pf.preflight(empty, defaults({ kind: 'folder' }));
  assert.equal(asFolder.ok, true, JSON.stringify(asFolder));
  assert.equal(asFolder.kind, 'folder', 'the owner may connect an empty repository as a plain folder');
  assert.equal(asFolder.scan.excluded.secrets.examples.includes('.git'), true, 'its .git is left out like any secret-like path');

  // Git refuses a folder another account owns; that cannot be staged without a second account, so a synthetic git says it.
  const untrustedGit = join(dir, 'untrusted-git.mjs');
  writeFileSync(untrustedGit, "process.stderr.write(\"fatal: detected dubious ownership in repository at 'x'\\n\"); process.exit(128);\n");
  check(pf.preflight(main, defaults({ git: [process.execPath, untrustedGit] })), 'GIT_UNTRUSTED');
});

test('Git projects carry the uncommitted-change and committed-secret notices', options, (t) => {
  const dir = base(t);
  const local = repository(dir, 'local', { files: { 'README.md': '# r\n', 'config/.env.production': 'X=1\n', 'certs/site.pem': 'p\n' } });
  const clean = pf.preflight(local, defaults());
  const secret = clean.notices.find((notice) => notice.code === 'SECRET_TRACKED');
  assert.deepEqual(secret, { code: 'SECRET_TRACKED', count: 2, examples: ['certs/site.pem', 'config/.env.production'] });
  assert.equal(clean.notices.some((notice) => notice.code === 'UNCOMMITTED_NOTICE'), false);
  writeFileSync(join(local, 'README.md'), '# changed\n');
  const dirty = pf.preflight(local, defaults());
  assert.deepEqual(dirty.notices.find((notice) => notice.code === 'UNCOMMITTED_NOTICE'), { code: 'UNCOMMITTED_NOTICE', sha7: clean.head.slice(0, 7) });
});

test('a plain-folder scan leaves out secrets, links, nested repositories, node_modules and owner exclusions', options, (t) => {
  const dir = base(t);
  const outside = folder(dir, 'outside', { 'secret-elsewhere.txt': 'x' });
  const plain = folder(dir, 'plain', {
    'index.html': '<p>hi</p>\r\n', '.env': 'TOKEN=1\n', 'keys/id_rsa': 'k', 'certs/site.pem': 'p', 'node_modules/x/index.js': 'x',
    'nested/.git/HEAD': 'ref: refs/heads/main\n', 'nested/file.txt': 'n', 'build/out.js': 'o', 'src/app.js': 'a', 'src/inside.txt': 'i',
  });
  symlinkSync(outside, join(plain, 'to-outside'), 'junction');
  symlinkSync(join(plain, 'src'), join(plain, 'to-inside'), 'junction');
  const result = pf.preflight(plain, defaults({ exclusions: ['build'] }));
  assert.equal(result.ok, true, JSON.stringify(result));
  const { excluded } = result.scan;
  assert.deepEqual(excluded.secrets.examples.sort(), ['.env', 'certs/site.pem', 'keys/id_rsa']);
  assert.deepEqual(excluded.links.examples.sort(), ['to-inside', 'to-outside'], 'a junction is reported as a link, inside or outside the root');
  assert.deepEqual(excluded.repos.examples, ['nested']);
  assert.deepEqual(excluded.modules.examples, ['node_modules']);
  assert.deepEqual(excluded.owner.examples, ['build']);
  assert.equal(result.scan.files, 3, 'index.html, src/app.js and src/inside.txt');
  assert.deepEqual(result.notices, [{ code: 'EXCLUDED_NOTICE', secrets: 3, links: 2, repos: 1, modules: 1, owner: 1, other: 0 }]);
  const withModules = pf.preflight(plain, defaults({ exclusions: ['build'], includeNodeModules: true }));
  assert.equal(withModules.scan.files, 4, 'the owner can include node_modules');
  assert.equal(lstatSync(join(plain, 'to-outside')).isSymbolicLink(), true, 'Node reports the junction as a link on this platform');
});

test('names that differ only in case are refused', options, (t) => {
  const dir = base(t);
  // NTFS cannot hold both names without per-directory case sensitivity, so the listing is injected. Its lstat is
  // injected too: only Readme.md exists, and a case-sensitive file system would report README.md as vanished (ENOENT)
  // instead of folding it to Readme.md as NTFS does, so the entry would never reach the collision check.
  const plain = folder(dir, 'plain', { 'Readme.md': 'a', 'docs/x.md': 'x' });
  const listing = (path) => (rootKey(path) === rootKey(plain) ? ['Readme.md', 'README.md', 'docs'] : readdirSync(path));
  const phantom = join(plain, 'README.md');
  const lstat = (path) => lstatSync(path === phantom ? join(plain, 'Readme.md') : path, { bigint: true });
  const injected = check(pf.preflight(plain, defaults({ io: { readdir: listing, lstat } })), 'CASE_COLLISION');
  assert.deepEqual(injected.detail, { a: 'Readme.md', b: 'README.md' });
});

test('names that differ only in case on a real case-sensitive folder are refused', options, (t) => {
  const dir = base(t);
  const plain = folder(dir, 'plain', { 'docs/Guide.md': 'a' });
  writeFileSync(join(plain, 'docs', 'guide.md'), 'b');
  if (readdirSync(join(plain, 'docs')).length < 2) {
    t.skip('this file system folds case, so it cannot hold both names; the injected listing covers the code');
    return;
  }
  const real = check(pf.preflight(plain, defaults()), 'CASE_COLLISION');
  assert.deepEqual([real.detail.a, real.detail.b].sort(), ['docs/Guide.md', 'docs/guide.md']);
});

test('scan limits stop before anything is copied: files, bytes, one file, time, readability and free space', options, (t) => {
  const dir = base(t);
  const plain = folder(dir, 'plain', { 'a.txt': '1234', 'b.txt': '12345678', 'c/d.txt': '12' });
  assert.deepEqual(pf.SCAN_LIMITS, { maxFiles: 200_000, maxBytes: 2 * 1024 ** 3, maxFileBytes: 100 * 1024 ** 2, timeoutMs: 120_000 });
  assert.equal(pf.preflight(plain, defaults({ limits: { maxFiles: 3 } })).ok, true);
  check(pf.preflight(plain, defaults({ limits: { maxFiles: 2 } })), 'TOO_LARGE');
  check(pf.preflight(plain, defaults({ limits: { maxBytes: 13 } })), 'TOO_LARGE');
  const big = check(pf.preflight(plain, defaults({ limits: { maxFileBytes: 5 } })), 'FILE_TOO_LARGE');
  assert.deepEqual(big.detail, { count: 1, examples: ['b.txt'] });
  let clock = 0;
  check(pf.preflight(plain, defaults({ limits: { timeoutMs: 2500 }, now: () => (clock += 1000) })), 'SCAN_TIMEOUT');
  const unreadable = check(pf.preflight(plain, defaults({ io: { canRead: (path) => !path.endsWith('d.txt') } })), 'UNREADABLE_FILES');
  assert.deepEqual(unreadable.detail, { count: 1, examples: ['c/d.txt'] });
  // 14 bytes x 2.2 = 30.8, so 31 bytes are needed at the mirror.
  const statfs = (free) => () => ({ bavail: BigInt(free), bsize: 1n });
  assert.equal(pf.preflight(plain, defaults({ mirrorParent: dir, io: { statfs: statfs(31) } })).ok, true);
  const space = check(pf.preflight(plain, defaults({ mirrorParent: dir, io: { statfs: statfs(30) } })), 'MIRROR_SPACE');
  assert.deepEqual(space.detail, { need: 31, free: 30 });
});

test('preflight leaves every source byte-identical, including .git, and runs only read-only git with optional locks off', options, (t) => {
  const dir = base(t);
  const recorder = recordingGit(dir);
  const site = repository(dir, 'site', { origin: 'https://github.com/example-org/site.git', files: { 'README.md': '# s\n', 'app.js': 'a\n' } });
  const local = repository(dir, 'local', { origin: 'ssh://git@git.example.invalid/never/contacted.git', files: { 'README.md': '# l\n' } });
  writeFileSync(join(local, 'README.md'), '# uncommitted\n');
  writeFileSync(join(local, 'untracked.txt'), 'u\n');
  const plain = folder(dir, 'plain', { 'a.txt': 'a\r\n', 'bin.dat': Buffer.from([0, 1, 2, 255]), 'é-name.txt': 'é', '.env': 'X=1\n' });
  symlinkSync(join(dir, 'site'), join(plain, 'link'), 'junction');
  const empty = repository(dir, 'empty', { commit: false });
  const sources = [site, local, plain, empty];
  const before = sources.map(snapshot);
  const worktreesBefore = git(site, 'worktree', 'list', '--porcelain');
  for (const source of sources) {
    for (const extra of [{}, { kind: 'local-git' }, { kind: 'folder' }]) pf.preflight(source, defaults({ git: recorder.command, ...extra }));
    const result = pf.preflight(source, defaults({ git: recorder.command }));
    if (source !== empty) assert.equal(result.ok, true, `${source}: ${JSON.stringify(result)}`);
    pf.checkProject(record(result), defaults({ git: recorder.command }));
  }
  assert.deepEqual(sources.map(snapshot), before, 'no file, directory, ref, index or config changed in any source');
  assert.equal(git(site, 'worktree', 'list', '--porcelain'), worktreesBefore, 'no worktree was added');
  assert.equal(existsSync(join(plain, '.git')), false, 'no .git appears in a plain folder');

  const calls = recorder.calls();
  assert.ok(calls.length >= 20, `git ran ${calls.length} times`);
  for (const { args, locks } of calls) {
    assert.equal(locks, '0', `GIT_OPTIONAL_LOCKS=0 for git ${args.join(' ')}`);
    assert.deepEqual(args.slice(0, 3), ['--no-optional-locks', '-c', 'core.fsmonitor=false'], args.join(' '));
    assert.equal(args[3], '-C');
    const [sub, ...rest] = args.slice(5);
    assert.ok(pf.READ_ONLY_GIT.includes(sub), `only read-only git runs, not git ${sub}`);
    if (sub === 'remote') assert.deepEqual(rest, ['-v']);
    if (sub === 'symbolic-ref') assert.deepEqual(rest, ['-q', '--short', 'HEAD']);
    assert.ok(!args.some((arg) => /safe\.directory|^config$|^fetch$|^ls-remote$|^init$|^worktree$/.test(arg)), args.join(' '));
  }
  assert.deepEqual(pf.READ_ONLY_GIT, ['rev-parse', 'rev-list', 'remote', 'symbolic-ref', 'status', 'ls-files']);
});
