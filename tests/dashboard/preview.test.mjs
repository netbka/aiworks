// Preview of a checked version (docs/design/OWNER_UI_V2.md WP7): only the exact verified head opens, nothing a request
// names runs, and a preview serves only its own folder of that commit, sandboxed. Synthetic repository and store only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { openResultPreview, supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { PreviewSessions } from '../../src/supervisor/preview.mjs';
import { declaration, environment } from '../supervisor/helpers.mjs';

const REPORT = '# Synthetic report', DIGEST = createHash('sha256').update(REPORT, 'utf8').digest('hex');
const PAGE = '<!doctype html><title>Synthetic shop</title><link rel="stylesheet" href="style.css"><h1>Find a product</h1>\n';
const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, input: args.includes('--stdin') ? '../AGENTS.md' : undefined });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
};

function rig(t) {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  // The checked commit: a page with its stylesheet under public/, files that must never be served beside it, and a link.
  const files = { 'public/index.html': PAGE, 'public/style.css': 'h1{color:#123}\n', 'public/.env': 'SHOP_MODE=demo\n',
    'public/secret-settings.json': '{"mode":"demo"}\n', 'public/leak.js': `const key = "ghp_${'a'.repeat(36)}";\n` };
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(env.repo, path, '..'), { recursive: true }); writeFileSync(join(env.repo, path), text); }
  git(env.repo, 'add', '-A');
  git(env.repo, 'update-index', '--add', '--cacheinfo', `120000,${git(env.repo, 'hash-object', '-w', '--stdin')},public/link.html`);
  git(env.repo, 'commit', '-q', '-m', 'Synthetic shop page');
  const sha = git(env.repo, 'rev-parse', 'HEAD'), parent = git(env.repo, 'rev-parse', 'HEAD~1');
  // A later, unchecked change in the working copy is never what a preview shows.
  writeFileSync(join(env.repo, 'public', 'index.html'), '<h1>Unchecked edit</h1>');
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
  return { env, store, sha, parent, bind };
}

test('a preview opens only the exact verified head with its report, and a request cannot name a command or a path', async (t) => {
  const { env, sha, parent, bind } = rig(t);
  const sessions = new PreviewSessions();
  const refused = (input, status) => assert.rejects(openResultPreview(env.dataDir, input, sessions), (error) => error.status === status);
  await refused(bind('T1', { command: 'node -e "process.exit(0)"' }), 400);
  await refused(bind('T1', { path: '../../' }), 400);
  await refused(bind('T1', { verifiedSha: parent }), 409);
  await refused(bind('T1', { reportDigest: 'c'.repeat(64) }), 409);
  await refused(bind('T1', { taskVersion: 99 }), 409);
  // A step without an accepted check of its head is never previewed.
  await refused(bind('T2'), 409);
  assert.equal(sessions.open.size, 0);
  const opened = await openResultPreview(env.dataDir, bind('T1'), sessions);
  assert.match(opened.url, /^\/preview\/[0-9a-f]{32}\/index\.html$/);
  assert.equal(opened.verifiedSha, sha);
  assert.ok(!JSON.stringify(opened).includes(env.tmp.replaceAll('\\', '\\\\')) && !JSON.stringify(opened).includes(env.repo), 'the answer names no folder');
});

test('a preview serves only its folder of the checked commit, sandboxed, and never a link, hidden or secret-looking file', async (t) => {
  const { env, bind } = rig(t);
  const server = createDashboardServer({ dataDir: env.dataDir, roadmap: { snapshot: () => ({ entries: [] }) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
  const opened = await (await fetch(`${base}/api/v2/results/preview`, { method: 'POST', body: JSON.stringify(bind('T1')),
    headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf } })).json();
  const folder = opened.url.slice(0, -'index.html'.length);
  // Raw request paths, so neither fetch nor URL parsing removes the dot segments first.
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: server.address().port, path, headers }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject).end();
  });
  const page = await get(opened.url, { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'iframe' });
  assert.equal(page.status, 200);
  assert.equal(page.body, PAGE, 'the checked commit, not the working copy');
  assert.match(page.headers['content-security-policy'], /^sandbox allow-scripts;/);
  assert.match(page.headers['content-security-policy'], /connect-src 'none'/);
  // The page's own subresource request comes from its opaque origin.
  assert.equal((await get(`${folder}style.css`, { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' })).status, 200);
  for (const path of ['../AGENTS.md', '..%2FAGENTS.md', '%2e%2e/AGENTS.md', '..%5CAGENTS.md', '.env', 'secret-settings.json', 'leak.js', 'link.html']) {
    const answer = await get(`${folder}${path}`);
    assert.ok(answer.status === 404 || answer.status === 410, `${path} answered ${answer.status}`);
    assert.ok(!answer.body.includes('Test repository rules') && !answer.body.includes('ghp_') && !answer.body.includes('SHOP_MODE'), path);
  }
  assert.equal((await get(`/preview/${'0'.repeat(32)}/index.html`)).status, 410);
  assert.equal((await get(opened.url, { Origin: 'http://example.invalid' })).status, 403);
});

test('an open preview ends as soon as its version is reopened and no longer the checked one', async (t) => {
  const { env, store, bind } = rig(t);
  const server = createDashboardServer({ dataDir: env.dataDir, roadmap: { snapshot: () => ({ entries: [] }) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
  const opened = await (await fetch(`${base}/api/v2/results/preview`, { method: 'POST', body: JSON.stringify(bind('T1')),
    headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf } })).json();
  assert.equal((await fetch(`${base}${opened.url}`)).status, 200);
  const row = store.task('preview-goal', 'T1');
  store.patch('tasks', { campaign_id: 'preview-goal', task_id: 'T1' }, row.version, { state: 'running' }, Date.now());
  // An open preview checks its version again at most once a second.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await fetch(`${base}${opened.url}`)).status, 410);
});
