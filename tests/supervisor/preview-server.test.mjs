// Server previews of a checked version (preview-server.mjs, aiworks#39): only the operator-declared Node script of the
// exact commit is ever planned, and a server that never answers, listens beyond loopback or outlives its deadline is
// stopped with its whole process tree. These run synthetic servers under the real Windows job containment.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerPreviews, serverPreviewDeclaration, serverPreviewPlan, startServerPreview } from '../../src/supervisor/preview-server.mjs';

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
