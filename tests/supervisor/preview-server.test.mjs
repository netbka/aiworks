// Server previews of a checked version (preview-server.mjs, aiworks#39): only the operator-declared Node script of the
// exact commit is ever planned, and a server that never answers, listens beyond loopback or outlives its deadline is
// stopped with its whole process tree. These run synthetic servers under the real Windows job containment.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ServerPreviews, serverPreviewDeclaration, serverPreviewPlan, startServerPreview } from '../../src/supervisor/preview-server.mjs';
import { cachedTarball, materializePackages } from '../../src/supervisor/preview-packages.mjs';
import { cache, integrityOf, locked, lockfile, packageTarball } from '../fixtures/preview-packages.mjs';

const skip = process.platform !== 'win32' ? 'Windows job containment only' : false;
const run = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
};
const serving = (host) => `import { createServer } from 'node:http';
createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Synthetic shop</h1>'); }).listen(Number(process.env.PORT), ${host});\n`;

/** A disposable repository with one commit of synthetic servers. */
function repository(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'aiworks-server-preview-')), repo = join(tmp, 'repo');
  t.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  mkdirSync(join(repo, 'withdeps'), { recursive: true });
  run(tmp, 'init', '-q', '-b', 'main', repo);
  run(repo, 'config', 'user.name', 'Preview Test');
  run(repo, 'config', 'user.email', 'preview-test@example.invalid');
  const files = { 'ok.mjs': serving('process.env.HOST'), 'wide.mjs': serving("'0.0.0.0'"), 'silent.mjs': 'setInterval(() => {}, 1000);\n',
    'withdeps/server.mjs': serving('process.env.HOST'), 'withdeps/package.json': '{"dependencies":{"example-server":"1.0.0"}}\n', 'install.sh': 'echo synthetic\n' };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
  run(repo, 'add', '-A');
  run(repo, 'commit', '-q', '-m', 'Synthetic servers');
  return { tmp, repo, sha: run(repo, 'rev-parse', 'HEAD') };
}

/** Processes whose command line names `dir`: a server preview's runner, helper and server all carry its folder. */
const processesIn = (dir) => {
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${dir.replaceAll("'", "''")}') }).Count`],
  { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return Number(out.stdout.trim());
};

test('only an operator-declared plain Node script of the checked commit that needs nothing installed is ever planned', (t) => {
  const project = 'example-org/sampleapp', config = (entry) => ({ previews: { servers: { [project]: entry } } });
  assert.equal(serverPreviewDeclaration({}, project), null, 'no declaration, no server preview');
  assert.equal(serverPreviewDeclaration(config({ script: 'ok.mjs' }), 'example-org/otherapp'), null, 'a declaration is for its project only');
  for (const entry of [{ script: '../ok.mjs' }, { script: 'C:/ok.mjs' }, { script: '/ok.mjs' }, { script: 'install.sh' }, { script: '.hidden/ok.mjs' },
    { script: 'ok.mjs', command: 'node ok.mjs' }, { script: 'ok.mjs', args: ['--inspect'] }, { script: 'ok.mjs', ready: 'http://example.invalid/' }, 'node ok.mjs']) {
    assert.ok(serverPreviewDeclaration(config(entry), project)?.error, JSON.stringify(entry));
  }
  assert.deepEqual(serverPreviewDeclaration(config({ script: 'ok.mjs' }), 'Example-Org/SampleApp'), { script: 'ok.mjs', ready: '/' });
  const { repo, sha } = repository(t);
  assert.throws(() => serverPreviewPlan({ repoPath: repo, sha, declaration: { script: 'missing.mjs', ready: '/' } }), { code: 'PREVIEW_SERVER_SCRIPT_MISSING' });
  assert.throws(() => serverPreviewPlan({ repoPath: repo, sha, declaration: { script: 'withdeps/server.mjs', ready: '/' } }), { code: 'PREVIEW_SERVER_NEEDS_INSTALL' });
  assert.throws(() => serverPreviewPlan({ repoPath: repo, sha: 'f'.repeat(40), declaration: { script: 'ok.mjs', ready: '/' } }), { code: 'PREVIEW_COMMIT_MISSING' });
  assert.equal(serverPreviewPlan({ repoPath: repo, sha, declaration: { script: 'ok.mjs', ready: '/' } }).sha, sha);
});

test('a server that never answers, listens beyond loopback or outlives its deadline is stopped with its process tree; a restart starts clean', { skip, timeout: 300_000 }, async (t) => {
  const { tmp, repo, sha } = repository(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => unrelated.kill());
  const plan = (script) => serverPreviewPlan({ repoPath: repo, sha, declaration: { script, ready: '/' } });
  const folder = () => mkdtempSync(join(tmp, 'work-'));
  for (const [label, script, code, options] of [['never answers', 'silent.mjs', 'PREVIEW_SERVER_TIMEOUT', { readyMs: 8000 }],
    ['listens beyond loopback', 'wide.mjs', 'PREVIEW_SERVER_EXPOSED', {}]]) {
    const workDir = folder();
    await assert.rejects(startServerPreview({ repoPath: repo, plan: plan(script), workDir, ...options }), { code }, label);
    assert.equal(processesIn(workDir), 0, `${label}: no process of the preview is left`);
    assert.equal(existsSync(workDir), false, `${label}: its folder is removed`);
  }

  // The job kills a server at its deadline even when nobody stops it.
  const workDir = folder();
  const server = await startServerPreview({ repoPath: repo, plan: plan('ok.mjs'), workDir, ttlMs: 12_000 });
  assert.equal((await server.request('')).status, 200);
  assert.ok(processesIn(workDir) > 0, 'the server was running');
  for (let i = 0; i < 120 && server.running(); i++) await new Promise((done) => setTimeout(done, 250));
  assert.equal(server.running(), false, 'the server stopped at its deadline');
  assert.equal(await server.stop(), 'stopped');
  assert.equal(processesIn(workDir), 0, 'deadline: no process of the preview is left');
  assert.equal((await server.request('')).status, 410);

  // Starting more than the limit stops the oldest first; closing stops every one; another process is untouched.
  const root = join(tmp, 'servers'), servers = new ServerPreviews({ root });
  const started = [];
  for (let i = 0; i < 3; i++) started.push(await servers.start({ repoPath: repo, plan: plan('ok.mjs') }));
  assert.equal(started[0].running(), false);
  assert.equal(processesIn(started[0].workDir), 0, 'restart: the oldest server is gone');
  assert.ok(started.slice(1).every((each) => each.running()));
  assert.deepEqual(await servers.close(), ['stopped', 'stopped']);
  assert.equal(processesIn(root), 0, 'close: no process of any preview is left');
  assert.equal(unrelated.exitCode, null, 'an unrelated process is untouched');
});

// The greeting the synthetic locked dependency gives the app: the page shows it only when that package was placed.
const GREETING = 'Hello from the locked package';
const lockedServer = `import { createServer } from 'node:http';
import { greeting } from 'example-greeting';
createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>' + greeting + '</h1>'); }).listen(Number(process.env.PORT), process.env.HOST);\n`;

/**
 * A disposable repository whose folders are apps with dependencies, one per case, and a disposable npm cache holding
 * the synthetic packages their lockfiles pin.
 */
function lockedRepository(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'aiworks-locked-preview-')), repo = join(tmp, 'repo'), npmCache = join(tmp, 'npm-cache');
  t.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  run(tmp, 'init', '-q', '-b', 'main', repo);
  run(repo, 'config', 'user.name', 'Preview Test');
  run(repo, 'config', 'user.email', 'preview-test@example.invalid');
  const greeting = cache(npmCache, packageTarball('example-greeting', '1.0.0', { 'index.mjs': `export { words as greeting } from '@example/words';\n`, '.npmrc': 'registry=x\n', 'server.key': 'synthetic\n' }));
  const words = cache(npmCache, packageTarball('@example/words', '2.1.0', { 'index.mjs': `export const words = ${JSON.stringify(GREETING)};\n` }));
  const notCached = integrityOf(Buffer.from('a package never prepared on this computer'));
  const manifest = (dependencies) => ({ name: 'example-shop', version: '1.0.0', type: 'module', dependencies });
  const app = (folder, appManifest, packages, extra = {}) => {
    const files = { 'server.mjs': lockedServer, 'package.json': JSON.stringify(appManifest), ...(packages ? { 'package-lock.json': lockfile(appManifest, packages) } : {}), ...extra };
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(repo, folder, path)), { recursive: true }); writeFileSync(join(repo, folder, path), text); }
  };
  const pinned = { 'node_modules/example-greeting': locked('example-greeting', '1.0.0', greeting), 'node_modules/@example/words': locked('@example/words', '2.1.0', words) };
  app('locked', { ...manifest({ 'example-greeting': '^1.0.0' }), devDependencies: { 'example-devtool': '1.0.0' } },
    { ...pinned, 'node_modules/example-devtool': locked('example-devtool', '1.0.0', notCached, { dev: true }) });
  app('nolock', manifest({ 'example-greeting': '^1.0.0' }), null);
  app('stale', manifest({ 'example-greeting': '^2.0.0' }), pinned, { 'package-lock.json': lockfile(manifest({ 'example-greeting': '^1.0.0' }), pinned) });
  app('scripted', manifest({ 'example-greeting': '^1.0.0' }), { ...pinned, 'node_modules/example-greeting': { ...pinned['node_modules/example-greeting'], hasInstallScript: true } });
  app('escape', manifest({ 'example-greeting': '^1.0.0' }), { ...pinned, 'node_modules/../../outside': locked('example-greeting', '1.0.0', greeting) });
  app('linked', manifest({ 'example-greeting': '^1.0.0' }), { ...pinned, 'node_modules/example-greeting': { resolved: '../greeting', link: true } });
  app('credential', manifest({ 'example-greeting': '^1.0.0' }), { ...pinned, 'node_modules/example-greeting': { ...pinned['node_modules/example-greeting'],
    // Split so this file itself holds no address with a password.
    resolved: ['https://reader', 'synthetic-pass@registry.example.invalid/example-greeting/-/example-greeting-1.0.0.tgz'].join(':') } });
  app('vendored', manifest({ 'example-greeting': '^1.0.0' }), pinned, { 'node_modules/example-greeting/index.mjs': 'export const greeting = "substituted";\n' });
  app('missing', manifest({ 'example-greeting': '^1.0.0' }), { ...pinned, 'node_modules/@example/words': locked('@example/words', '2.1.0', notCached) });
  run(repo, 'add', '-A');
  run(repo, 'commit', '-q', '-m', 'Synthetic apps with locked dependencies');
  return { tmp, repo, npmCache, sha: run(repo, 'rev-parse', 'HEAD') };
}

test('a version with dependencies is planned only with the packages its lockfile pins from cached copies; unlocked, stale, scripted, escaping, linked, credential-bearing, vendored and missing ones are refused', (t) => {
  const { repo, npmCache, sha } = lockedRepository(t);
  const plan = (folder, packageCache = npmCache) => serverPreviewPlan({ repoPath: repo, sha, declaration: { script: `${folder}/server.mjs`, ready: '/' }, packageCache });
  assert.deepEqual(plan('locked').packages.map((each) => [each.dir, each.name, each.version]),
    [['locked/node_modules/example-greeting', 'example-greeting', '1.0.0'], ['locked/node_modules/@example/words', '@example/words', '2.1.0']], 'development dependencies are left out');
  for (const [folder, code] of [['nolock', 'PREVIEW_SERVER_NEEDS_INSTALL'], ['stale', 'PREVIEW_DEPENDENCY_STALE'], ['scripted', 'PREVIEW_DEPENDENCY_SCRIPT'],
    ['escape', 'PREVIEW_DEPENDENCY_UNSAFE'], ['linked', 'PREVIEW_DEPENDENCY_UNSUPPORTED'], ['credential', 'PREVIEW_DEPENDENCY_SECRET'],
    ['vendored', 'PREVIEW_DEPENDENCY_UNSUPPORTED'], ['missing', 'PREVIEW_DEPENDENCY_MISSING']]) {
    assert.throws(() => plan(folder), { code }, folder);
  }
  assert.throws(() => plan('locked', null), { code: 'PREVIEW_DEPENDENCY_MISSING' }, 'no usable cache, nothing is planned');
});

test('a locked package is placed only from bytes matching its pinned integrity and name, as plain files inside its folder', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'aiworks-locked-packages-')), npmCache = join(tmp, 'npm-cache');
  t.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  let round = 0;
  const place = (bytes, { name = 'example-greeting', version = '1.0.0', integrity = cache(npmCache, bytes) } = {}) => {
    const appDir = join(tmp, `app-${++round}`);
    mkdirSync(appDir);
    materializePackages([{ dir: 'node_modules/example-greeting', name, version, integrity, tarball: cachedTarball(npmCache, integrity) }], appDir);
    return appDir;
  };
  const good = packageTarball('example-greeting', '1.0.0', { 'index.mjs': 'export const greeting = 1;\n', '.npmrc': 'registry=x\n', 'certs/server.key': 'synthetic\n' });
  const appDir = place(good), folder = join(appDir, 'node_modules', 'example-greeting');
  assert.equal(readFileSync(join(folder, 'index.mjs'), 'utf8'), 'export const greeting = 1;\n');
  assert.equal(existsSync(join(folder, '.npmrc')) || existsSync(join(folder, 'certs', 'server.key')), false, 'hidden and secret-like files are left out');

  // A cached copy altered after it was pinned.
  const integrity = cache(npmCache, good);
  writeFileSync(cachedTarball(npmCache, integrity), packageTarball('example-greeting', '1.0.0', { 'index.mjs': 'export const greeting = "altered";\n' }));
  assert.throws(() => place(good, { integrity }), { code: 'PREVIEW_DEPENDENCY_TAMPERED' }, 'altered copy');
  assert.throws(() => place(packageTarball('example-other', '1.0.0')), { code: 'PREVIEW_DEPENDENCY_TAMPERED' }, 'another package under the locked name');
  assert.throws(() => place(packageTarball('example-greeting', '9.9.9')), { code: 'PREVIEW_DEPENDENCY_TAMPERED' }, 'another version under the locked one');
  const outside = join(tmp, 'outside.mjs');
  for (const [label, entry] of [['symbolic link', { path: 'package/linked.mjs', type: '2', linkname: outside }], ['hard link', { path: 'package/linked.mjs', type: '1', linkname: 'package/index.mjs' }],
    ['parent folder', { path: 'package/../../outside.mjs', body: 'x' }], ['absolute name', { path: '/outside.mjs', body: 'x' }],
    ['its own node_modules', { path: 'package/node_modules/example-words/index.mjs', body: 'x' }], ['Windows-unsafe name', { path: 'package/con.mjs', body: 'x' }]]) {
    assert.throws(() => place(packageTarball('example-greeting', '1.0.0', {}, [entry])), { code: 'PREVIEW_DEPENDENCY_UNSAFE' }, label);
  }
  assert.equal(existsSync(outside), false, 'nothing was written outside the preview');
});

test('a locked dependency-based app runs from its placed packages under the same containment, and stops with its process tree', { skip, timeout: 120_000 }, async (t) => {
  const { tmp, repo, npmCache, sha } = lockedRepository(t);
  const workDir = mkdtempSync(join(tmp, 'work-'));
  const plan = serverPreviewPlan({ repoPath: repo, sha, declaration: { script: 'locked/server.mjs', ready: '/' }, packageCache: npmCache });
  const server = await startServerPreview({ repoPath: repo, plan, workDir });
  const page = await server.request('');
  assert.equal(page.status, 200);
  assert.ok(page.body.toString('utf8').includes(GREETING), 'the page comes from the locked packages');
  assert.equal(await server.stop(), 'stopped');
  assert.equal(processesIn(workDir), 0, 'no process of the preview is left');
  assert.equal(existsSync(workDir), false, 'its folder, with the placed packages, is removed');
});
