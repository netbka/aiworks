// Server preview of a checked version (aiworks#39): for a project whose preview script the operator declared, only the
// exact verified head's server starts, only after the caller check, contained, and it stops as soon as its version is no
// longer the checked one. Synthetic repository, store and servers under the real Windows job containment.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { captureResultPreview, openResultPreview, previewStillChecked, supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { PreviewSessions } from '../../src/supervisor/preview.mjs';
import { PreviewCaptures } from '../../src/supervisor/preview-capture.mjs';
import { ServerPreviews } from '../../src/supervisor/preview-server.mjs';
import { declaration, environment } from '../supervisor/helpers.mjs';

const skip = process.platform !== 'win32' ? 'Windows job containment only' : false;
const CHROME = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)
  .map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((path) => existsSync(path));
const REPORT = '# Synthetic report', DIGEST = createHash('sha256').update(REPORT, 'utf8').digest('hex');
// What the server may see of its environment: what Windows needs to start a process and the logon variables Windows adds,
// its own folders, HOST and PORT; nothing the dashboard was started with.
const ALLOWED_ENV = ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'HOST', 'PORT', 'PSMODULEPATH', 'PATHEXT',
  'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME',
  'GIT_LFS_SKIP_SMUDGE', 'GIT_LFS_SKIP_PUSH'];
// The checked server: it reports what it could reach, and offers a credential-looking answer that must never be relayed.
const SERVER = `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const probe = (act) => { try { act(); return 'allowed'; } catch (error) { return error.code ?? 'refused'; } };
const report = { outside: probe(() => readFileSync(process.env.SystemRoot + '\\\\win.ini')), dotenv: probe(() => readFileSync(new URL('./.env', import.meta.url))),
  child: probe(() => spawnSync(process.execPath, ['-e', '0'])), env: Object.keys(process.env), host: process.env.HOST };
createServer((req, res) => {
  if (req.url === '/leak') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('token ghp_${'a'.repeat(36)}'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Synthetic shop</title><h1>Find a product</h1><pre id="report" style="white-space:pre-wrap;word-break:break-all">' + JSON.stringify(report) + '</pre>');
}).listen(Number(process.env.PORT), process.env.HOST);
`;
const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
};
const processesIn = (dir) => {
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${dir.replaceAll("'", "''")}') }).Count`],
  { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return Number(out.stdout.trim());
};

function rig(t) {
  const env = environment({ config: { previews: { servers: { 'example-org/sampleapp': { script: 'app/server.mjs' } } }, ...(CHROME ? { commands: { chrome: [CHROME] } } : {}) } });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  mkdirSync(join(env.repo, 'app'), { recursive: true });
  writeFileSync(join(env.repo, 'app', 'server.mjs'), SERVER);
  writeFileSync(join(env.repo, 'app', '.env'), 'SHOP_MODE=demo\n');
  git(env.repo, 'add', '-A');
  git(env.repo, 'commit', '-q', '-m', 'Synthetic shop server');
  const sha = git(env.repo, 'rev-parse', 'HEAD'), parent = git(env.repo, 'rev-parse', 'HEAD~1');
  // A later, unchecked change in the working copy is never what a preview runs.
  writeFileSync(join(env.repo, 'app', 'server.mjs'), SERVER.replace('Find a product', 'Unchecked edit'));
  const d = declaration({ campaignId: 'preview-goal' });
  campaignStart(store, d);
  const row = store.task(d.campaignId, 'T1');
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, row.version, { state: 'done', head_sha: sha, verified_sha: sha,
    result: { result: 'resolved', report: REPORT }, verification: { verdict: 'accepted', targetSha: sha, reportDigest: DIGEST, summary: 'Checked.', findings: [], checks: [] } }, Date.now());
  const bind = (taskId, extra = {}) => {
    const c = supervisorSnapshot(env.dataDir).campaigns[0], task = c.tasks.find((item) => item.id === taskId);
    return { campaignId: c.id, taskId, taskVersion: task.version, version: c.version, authorizationVersion: c.authorizationVersion,
      scopeDigest: c.scopeDigest, verifiedSha: sha, reportDigest: DIGEST, ...extra };
  };
  const servers = new ServerPreviews({ root: join(env.dataDir, 'preview-servers') });
  t.after(() => servers.close());
  return { env, store, sha, parent, bind, servers };
}

test('a server preview starts only the declared script of the exact checked head, after the caller check, contained, and stops with its version', { skip, timeout: 240_000 }, async (t) => {
  const { env, store, sha, parent, bind, servers } = rig(t);
  const sessions = new PreviewSessions({ stillValid: (binding) => previewStillChecked(env.dataDir, binding) });
  t.after(() => sessions.close());
  let checks = 0;
  const owner = async () => { checks++; };
  const refusedCaller = async () => { throw Object.assign(new Error('Only the owner can do this.'), { status: 403 }); };
  // A request that names a command or another head, and a caller that fails the check, start nothing.
  await assert.rejects(openResultPreview(env.dataDir, bind('T1', { command: 'node app/server.mjs' }), sessions, { servers, ownerCheck: owner }), { status: 400 });
  await assert.rejects(openResultPreview(env.dataDir, bind('T1', { verifiedSha: parent }), sessions, { servers, ownerCheck: owner }), { status: 409 });
  await assert.rejects(openResultPreview(env.dataDir, bind('T2'), sessions, { servers, ownerCheck: owner }), { status: 409 });
  await assert.rejects(openResultPreview(env.dataDir, bind('T1'), sessions, { servers, ownerCheck: refusedCaller }), { status: 403 });
  // Over HTTP, a dashboard without the caller lookup refuses before it starts a server.
  const dashboard = createDashboardServer({ dataDir: env.dataDir, roadmap: { snapshot: () => ({ entries: [] }) } });
  dashboard.listen(0, '127.0.0.1'); await once(dashboard, 'listening');
  t.after(() => new Promise((resolve) => { dashboard.closeAllConnections(); dashboard.close(resolve); }));
  const base = `http://127.0.0.1:${dashboard.address().port}`;
  const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
  const viaHttp = await fetch(`${base}/api/v2/results/preview`, { method: 'POST', body: JSON.stringify(bind('T1')),
    headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf } });
  assert.notEqual(viaHttp.status, 200);
  assert.equal(checks, 0);
  assert.equal(servers.servers.length, 0);
  assert.equal(processesIn(env.dataDir), 0, 'nothing was started');

  const opened = await openResultPreview(env.dataDir, bind('T1'), sessions, { servers, ownerCheck: owner });
  assert.equal(checks, 1);
  assert.equal(opened.runtime, 'server');
  assert.equal(opened.verifiedSha, sha);
  assert.ok(!JSON.stringify(opened).includes(env.tmp.replaceAll('\\', '\\\\')) && !/port/i.test(Object.keys(opened).join()), 'the answer names no folder or port');
  const token = /^\/preview\/([0-9a-f]{32})\//.exec(opened.url)[1];
  const page = await sessions.serve(token, '');
  assert.equal(page.status, 200);
  const body = page.body.toString('utf8');
  assert.ok(body.includes('Find a product') && !body.includes('Unchecked edit'), 'the checked commit, not the working copy');
  const report = JSON.parse(/<pre id="report"[^>]*>(.*)<\/pre>/s.exec(body)[1]);
  assert.equal(report.outside, 'ERR_ACCESS_DENIED', 'no file outside its own folder can be read');
  assert.equal(report.child, 'ERR_ACCESS_DENIED', 'it cannot start another program');
  assert.equal(report.dotenv, 'ENOENT', 'hidden and secret-like files are not written for it');
  assert.equal(report.host, '127.0.0.1');
  assert.deepEqual(report.env.filter((name) => !ALLOWED_ENV.includes(name.toUpperCase())), [], 'none of the dashboard’s environment');
  assert.equal((await sessions.serve(token, 'leak')).status, 404, 'credential-looking text is never relayed');
  assert.equal((await sessions.serve(token, '..%2F..%2Fconfig.json')).status, 404);
  assert.ok(processesIn(env.dataDir) > 0);

  // Reopening the step ends the preview and stops its server, even while nothing is requested.
  const row = store.task('preview-goal', 'T1');
  store.patch('tasks', { campaign_id: 'preview-goal', task_id: 'T1' }, row.version, { state: 'running' }, Date.now());
  for (let i = 0; i < 120 && processesIn(env.dataDir) > 0; i++) await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(processesIn(env.dataDir), 0, 'no process of the stale version is left');
  assert.equal((await sessions.serve(token, '')).status, 410);
  assert.deepEqual(readdirSync(join(env.dataDir, 'preview-servers')), [], 'its folder is removed');
});

test('a server version yields desktop and phone screenshots, and the capture leaves no process behind', { skip: skip || (!CHROME && 'no installed Chrome'), timeout: 300_000 }, async (t) => {
  const { env, sha, bind, servers } = rig(t);
  const captures = new PreviewCaptures({ root: join(env.dataDir, 'preview-captures') });
  t.after(() => captures.close());
  const captured = await captureResultPreview(env.dataDir, bind('T1'), captures, { servers });
  assert.equal(captured.verifiedSha, sha);
  assert.deepEqual(captured.shots.map((shot) => [shot.size, shot.viewport.width]), [['desktop', 1366], ['phone', 390]]);
  for (const shot of captured.shots) assert.match(shot.image, /^data:image\/png;base64,/);
  assert.equal(processesIn(env.dataDir), 0, 'neither the browser nor the server is left running');
});
