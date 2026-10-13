import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart, campaignPause } from '../../src/supervisor/api.mjs';
import { declaration, environment, runtimeCheckout } from '../supervisor/helpers.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { pendingInstructions } from '../../src/supervisor/instructions.mjs';
import { RoadmapSource, readRoadmap, safeText } from '../../src/dashboard/roadmap.mjs';
import { applyCommand, applyCommand as applyMain, supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { ownerView } from '../../src/dashboard/owner.mjs';
import { COMMANDS } from '../../src/dashboard/copy.mjs';

test('completed campaigns do not appear offline or request controller recovery', (t) => {
  const { dataDir, store, d } = fixture(t);
  const c = store.campaign(d.campaignId);
  store.patch('campaigns', { id: c.id }, c.version, { control: 'finished', status: 'ready' }, Date.now());
  const snapshot = supervisorSnapshot(dataDir);
  assert.equal(snapshot.campaigns[0].readiness, 'COMPLETE');
  assert.equal(snapshot.campaigns[0].controllerLive, false);
  // The owner view (which replaced the unused public/status.mjs helpers) neither badges it offline nor asks for a restart.
  const view = ownerView(snapshot, { repositories: [], steps: {} }, { now: Date.now() + 60 * 60_000 });
  assert.equal(view.campaigns[d.campaignId].liveness, 'finished');
  assert.ok(!view.items.some((item) => item.kind === 'controller'));
  assert.deepEqual(snapshot.campaigns[0].tasks.map((task) => task.deliverable), ['commit', 'commit']);
});

test('the platform roadmap is definitions from the governance checkout, with no GitHub work state or cache', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-dashboard-roadmap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A GitHub snapshot left in an old cache directory is never read or served.
  writeFileSync(join(dir, 'roadmap-cache.json'), JSON.stringify({ version: 1, sources: [{ repository: 'example-org/governance', fetchedAt: new Date().toISOString(),
    items: [{ kind: 'issue', number: 7, title: 'GOV-08: cached issue', state: 'CLOSED', packages: ['GOV-08'] }] }] }));
  const source = new RoadmapSource({ root: resolve(import.meta.dirname, '../fixtures/governance'), cacheDir: dir, repositories: ['example-org/sample-wiki'] });
  const snapshot = source.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ['entries', 'governance']);
  assert.equal(snapshot.entries.length, 6);
  assert.ok(snapshot.entries.every((entry) => !('status' in entry) && !('items' in entry)), 'no progress is claimed for roadmap items');
  assert.ok(!JSON.stringify(snapshot).includes('cached issue'));
  assert.ok(!snapshot.entries.some((entry) => entry.repository === 'example-org/sample-wiki'), 'a configured repository adds no backlog');
});

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-dashboard-'));
  const store = new Store(join(dataDir, 'supervisor.db'));
  const d = declaration();
  campaignStart(store, d);
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const payload = (action, extra = {}) => {
    const c = store.campaign(d.campaignId);
    return { campaignId: c.id, action, version: c.version, authorizationVersion: c.authorization_version,
      scopeDigest: c.scope_digest, requestId: randomUUID(), ...extra };
  };
  return { dataDir, store, d, payload };
}

test('roadmap includes every product phase, next increment and rollout package', () => {
  const entries = readRoadmap(resolve(import.meta.dirname, '../fixtures/governance'));
  assert.equal(entries.length, 6);
  assert.equal(entries.filter((e) => e.track === 'Product control plane').length, 2);
  assert.equal(entries.filter((e) => e.track === 'Product · next').length, 1);
  assert.equal(entries.filter((e) => e.track === 'Autonomous governance').length, 3);
  assert.equal(entries.find((e) => e.id === 'GOV-08').repository, 'example-org/sampleapp');
  assert.match(entries.find((e) => e.id === 'GOV-08').title, /manifest/);
  assert.deepEqual(entries.find((e) => e.id === 'GOV-21').dependencies, ['GOV-01', 'GOV-08']);
  assert.equal(entries.find((e) => e.id === 'PCTRL-01').owner, 'product-architect');
  assert.equal(safeText('Bearer synthetic-sensitive-value'), '[sensitive content omitted]');
});

test('snapshots never bootstrap a store and cannot mutate an existing store', (t) => {
  const { dataDir, store, d } = fixture(t);
  const missing = join(dataDir, 'missing');
  assert.equal(supervisorSnapshot(missing).available, false);
  assert.equal(existsSync(missing), false);
  const before = store.campaign(d.campaignId);
  const reader = new Store(join(dataDir, 'supervisor.db'), { readOnly: true });
  assert.throws(() => reader.run('UPDATE campaigns SET runs_used = 99'), /readonly/i);
  reader.close();
  assert.equal(supervisorSnapshot(dataDir).available, true);
  assert.deepEqual(store.campaign(d.campaignId), before);
});

test('monitor snapshots omit raw errors, prompts, identity and local paths', (t) => {
  const { dataDir, store, d } = fixture(t);
  const runDir = join(dataDir, 'runs', 'test'); mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'heartbeat'), String(Date.now()));
  store.run('UPDATE tasks SET last_error = ?, blocked = ? WHERE task_id = ?', 'error: secret-marker', { class: 'B3', reason: 'secret-marker' }, 'T1');
  store.insert('operations', { id: 'synthetic-op', campaign_id: d.campaignId, task_id: 'T1', kind: 'implement', seq: 1,
    idempotency_key: 'synthetic-op', lease_generation: 1, state: 'dispatched', session_id: 'secret-marker', run_dir: runDir,
    workspace: 'secret-marker', packet: { raw: 'secret-marker' }, packet_digest: 'digest', created_at: Date.now(), updated_at: Date.now() });
  store.journal(d.campaignId, 'operation-finished', { message: 'secret-marker', op: 'synthetic-op', class: 'error' }, Date.now());
  const state = supervisorSnapshot(dataDir);
  assert.equal(state.campaigns[0].agents[0].heartbeatState, 'recent');
  assert.ok(!JSON.stringify(state).includes('secret-marker'));
  assert.ok(!JSON.stringify(state).includes(dataDir.replaceAll('\\', '\\\\')));
});

test('commands reuse registered authority, are audited and deduplicate exact retries', (t) => {
  const { dataDir, store, d, payload } = fixture(t);
  // Resume needs the stored declaration in campaigns/ on origin/main (AW-005): here, a merged temp repository.
  const runtime = runtimeCheckout({ declarations: { [`${d.campaignId}.json`]: d } });
  t.after(() => runtime.cleanup());
  const applyCommand = (dir, input) => applyMain(dir, input, Date.now(), { provenanceRoot: runtime.root });
  const before = store.campaign(d.campaignId);
  const pause = payload('pause');
  assert.equal(applyCommand(dataDir, pause).accepted, true);
  assert.equal(store.campaign(d.campaignId).control, 'paused');
  assert.equal(applyCommand(dataDir, pause).duplicate, true);
  assert.throws(() => applyCommand(dataDir, { ...pause, action: 'cancel' }), /different request/);
  assert.equal(store.all("SELECT * FROM journal WHERE kind = 'dashboard-command'").length, 1);
  applyCommand(dataDir, payload('resume'));
  assert.equal(store.campaign(d.campaignId).control, 'registered');
  assert.deepEqual(store.campaign(d.campaignId).declaration, before.declaration);
  assert.equal(store.campaign(d.campaignId).runs_used, before.runs_used);
  applyCommand(dataDir, payload('recheck', { taskId: 'T1', taskVersion: store.task(d.campaignId, 'T1').version }));
  assert.equal(store.all("SELECT * FROM events WHERE kind = 'recheck'").length, 1);
  applyCommand(dataDir, payload('cancel'));
  assert.equal(store.campaign(d.campaignId).control, 'cancel-requested');
});

test('provider priority, credit waits, slot limits and fallback activity are visible without raw errors', (t) => {
  const { dataDir, store, d } = fixture(t);
  campaignPause(store, d.campaignId);
  d.authorization.version++;
  d.executor = { ...d.executor, kind: 'cli-chain', providers: [{ kind: 'codex-cli' },
    { kind: 'claude-cli', model: 'opus', permissionMode: 'auto' }, { kind: 'cursor-cli' }] };
  delete d.executor.model; delete d.executor.permissionMode;
  campaignStart(store, d);
  const retry = Date.now() + 60000;
  store.run('INSERT INTO executor_waits (campaign_id, executor_kind, retry_at, reason) VALUES (?, ?, ?, ?)',
    d.campaignId, 'codex-cli', retry, 'quota: provider credits/billing limit secret-marker');
  store.journal(d.campaignId, 'executor-fallback', { task: 'T1', from: 'codex-cli', executor: 'claude-cli', reason: 'quota', credits: true }, Date.now());
  const state = supervisorSnapshot(dataDir), campaign = state.campaigns[0];
  assert.equal(campaign.slots, 1);
  assert.deepEqual(campaign.providers.map((p) => p.kind), ['codex-cli', 'claude-cli', 'cursor-cli']);
  assert.equal(campaign.providers[0].state, 'cooldown');
  assert.equal(campaign.providers[0].credits, true);
  assert.equal(campaign.providers[0].retryAt, retry);
  assert.equal(state.activity[0].fromExecutor, 'codex-cli');
  assert.equal(state.activity[0].executor, 'claude-cli');
  assert.ok(!JSON.stringify(state).includes('secret-marker'));
});

test('stale, ABA, wrong-task and expanded-authority commands are rejected', (t) => {
  const { dataDir, store, d, payload } = fixture(t);
  const stale = payload('cancel');
  campaignPause(store, d.campaignId);
  campaignStart(store, d);
  assert.throws(() => applyCommand(dataDir, stale), /Work changed/);
  assert.throws(() => applyCommand(dataDir, payload('recheck', { taskId: 'absent', taskVersion: 1 })), /^Error: This step changed or is already finished\. Refresh the page and try again\.$/);
  for (const extra of [{ cap: 100 }, { command: 'git push' }, { declaration: d }, { action: 'start' }]) {
    assert.throws(() => applyCommand(dataDir, payload('recheck', extra)), /Invalid dashboard command/);
  }
  assert.throws(() => applyCommand(dataDir, payload('resume')), /^Error: Only paused work can resume\. Refresh the page to see where it stands\.$/);
  assert.equal(store.campaign(d.campaignId).control, 'registered');
});

test('Resume preserves private stored authority and refuses unmerged runtime code', (t) => {
  const { dataDir, store, d, payload } = fixture(t);
  campaignPause(store, d.campaignId);
  const before = store.campaign(d.campaignId);
  const merged = runtimeCheckout(), unmerged = runtimeCheckout({ unmerged: true });
  t.after(() => { merged.cleanup(); unmerged.cleanup(); });
  assert.throws(() => applyMain(dataDir, payload('resume'), Date.now(), { provenanceRoot: unmerged.root }),
    (error) => error.status === 409 && error.message === COMMANDS.resumeRefused && /not merged/.test(error.detail));
  assert.equal(store.campaign(d.campaignId).control, 'paused');
  assert.equal(store.all("SELECT * FROM journal WHERE kind = 'dashboard-command'").length, 0);
  assert.equal(applyMain(dataDir, payload('resume'), Date.now(), { provenanceRoot: merged.root }).accepted, true);
  const after = store.campaign(d.campaignId);
  assert.equal(after.control, 'registered');
  assert.deepEqual(after.declaration, before.declaration);
  assert.equal(after.scope_digest, before.scope_digest);
  assert.equal(after.authorization_version, before.authorization_version);
  assert.equal(after.runs_used, before.runs_used);
});
test('instruction validation, role binding, exact retries and bounded queue preserve authority', (t) => {
  const { dataDir, store, d, payload } = fixture(t);
  const extra = { taskId: 'T1', taskVersion: 1, role: 'implement', text: 'Explain the edge cases in the report.' };
  const instruction = payload('instruct', extra);
  const before = store.campaign(d.campaignId);
  applyCommand(dataDir, instruction);
  assert.equal(applyCommand(dataDir, instruction).duplicate, true);
  assert.throws(() => applyCommand(dataDir, { ...instruction, text: 'Changed text' }), /different request/);
  assert.equal(pendingInstructions(store, before, 'T1', 'implement').length, 1);
  assert.equal(pendingInstructions(store, before, 'T1', 'verify').length, 0);
  assert.deepEqual(store.campaign(d.campaignId), before);
  for (const invalid of [{ text: '' }, { text: 'x'.repeat(2001) }, { text: 'Bearer synthetic-credential-material' },
    { text: 'bad\u001bcontrol' }, { role: 'shell' }, { taskId: undefined }, { taskVersion: 99 }]) {
    assert.throws(() => applyCommand(dataDir, payload('instruct', { ...extra, ...invalid })));
  }
  for (let i = 0; i < 4; i++) applyCommand(dataDir, payload('instruct', extra));
  assert.throws(() => applyCommand(dataDir, payload('instruct', extra)), /five queued/);
  assert.equal(supervisorSnapshot(dataDir).campaigns[0].instructions[0].status, 'queued');
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, 1, { state: 'done' }, Date.now());
  assert.equal(supervisorSnapshot(dataDir).campaigns[0].instructions[0].status, 'undelivered');
});

test('real dispatch atomically attaches only the matching role instruction to the immutable prompt', async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); campaignStart(store, d);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  // Inspect the committed handoff; no worker process or model is launched.
  controller.launch = async () => {};
  const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
  const ctx = { id: d.campaignId, generation: lease.generation };
  const campaign = store.campaign(d.campaignId);
  for (const role of ['implement', 'verify']) applyCommand(env.dataDir, { campaignId: d.campaignId, action: 'instruct', requestId: randomUUID(),
    version: campaign.version, authorizationVersion: campaign.authorization_version, scopeDigest: campaign.scope_digest,
    taskId: 'T1', taskVersion: 1, role, text: `${role} guidance with literal shell text $(do-not-execute)` });
  controller.processEvents(ctx);
  assert.equal(pendingInstructions(store, campaign, 'T1').length, 2, 'event processing cannot consume guidance');
  const task = store.task(d.campaignId, 'T1');
  const originalInsert = store.insert.bind(store);
  store.insert = (table, row) => { if (table === 'operations') throw new Error('synthetic preflight failure'); return originalInsert(table, row); };
  await assert.rejects(controller.dispatch(ctx, campaign, task, 'implement'), /synthetic preflight/);
  assert.equal(pendingInstructions(store, campaign, 'T1').length, 2, 'failed handoff leaves instructions queued');
  store.insert = originalInsert;
  await controller.dispatch(ctx, campaign, task, 'implement');
  const op = store.openOperations(d.campaignId)[0];
  assert.ok(op);
  const prompt = readFileSync(join(op.run_dir, 'prompt.txt'), 'utf8');
  assert.match(prompt, /implement guidance with literal shell text/);
  assert.ok(!prompt.includes('verify guidance'));
  assert.match(prompt, /cannot expand scope or tool permissions/);
  assert.deepEqual(op.packet.acceptance, d.tasks[0].acceptance);
  assert.equal(pendingInstructions(store, campaign, 'T1', 'implement').length, 0);
  assert.equal(pendingInstructions(store, campaign, 'T1', 'verify').length, 1);
  const receipt = supervisorSnapshot(env.dataDir).campaigns[0].instructions.find((item) => item.role === 'implement');
  assert.equal(receipt.status, 'attached'); assert.equal(receipt.operationId, op.id);
});

test('HTTP controls require exact loopback Host, Origin, CSRF and bounded JSON', async (t) => {
  const { dataDir, payload, store, d } = fixture(t);
  const roadmap = { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) };
  const server = createDashboardServer({ dataDir, roadmap });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
  const goodHeaders = { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf };
  for (const headers of [{ ...goodHeaders, Origin: 'https://evil.example' }, { ...goodHeaders, Origin: 'null' },
    { ...goodHeaders, Origin: '' }, { ...goodHeaders, 'X-Dashboard-CSRF': 'wrong' }]) {
    assert.equal((await fetch(`${base}/api/commands`, { method: 'POST', headers, body: JSON.stringify(payload('pause')) })).status, 403);
  }
  const wrongHost = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/state`, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/commands`, { method: 'POST', headers: goodHeaders, body: 'x'.repeat(16_385) })).status, 413);
  assert.equal(store.campaign(d.campaignId).control, 'registered');
  assert.equal((await fetch(`${base}/api/commands`, { method: 'POST', headers: goodHeaders, body: JSON.stringify(payload('pause')) })).status, 202);
  assert.equal(store.campaign(d.campaignId).control, 'paused');
  const page = await fetch(base);
  const unicodeInstruction = payload('instruct', { taskId: 'T1', taskVersion: 1, role: 'verify', text: '\u05d0'.repeat(2000) });
  assert.equal((await fetch(`${base}/api/commands`, { method: 'POST', headers: goodHeaders, body: JSON.stringify(unicodeInstruction) })).status, 202);
  assert.equal(store.get("SELECT payload FROM events WHERE kind = 'agent-instruction'").payload.text, unicodeInstruction.text);
  const splitInstruction = payload('instruct', { taskId: 'T1', taskVersion: 1, role: 'implement', text: '\u05d0 split transport' });
  const bytes = Buffer.from(JSON.stringify(splitInstruction));
  const splitAt = bytes.indexOf(Buffer.from('\u05d0')) + 1;
  const splitStatus = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/commands`, { method: 'POST', headers: goodHeaders }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.write(bytes.subarray(0, splitAt)); setTimeout(() => req.end(bytes.subarray(splitAt)), 20);
  });
  assert.equal(splitStatus, 202);
  assert.equal(store.get("SELECT payload FROM events WHERE kind = 'agent-instruction' ORDER BY seq DESC LIMIT 1").payload.text, splitInstruction.text);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  // The page opens on Projects; the heading takes focus on a route change (OWNER_WORKSPACE §6.2).
  assert.match(await page.text(), /<h1 id="view-title" tabindex="-1">Projects<\/h1>/);
  assert.equal((await fetch(`${base}/api/session`, { method: 'PUT' })).status, 405);
  assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers: goodHeaders, body: '{}' })).status, 404, 'there is no GitHub refresh route');
  // Every response isolates its window from cross-origin openers, alongside the existing headers.
  const refused = await fetch(`${base}/api/state`, { headers: { Origin: 'https://evil.example' } });
  for (const response of [page, await fetch(`${base}/api/state`), await fetch(`${base}/dashboard.js`), refused]) {
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(response.headers.get('content-security-policy'), /^default-src 'none'; script-src 'self';/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  assert.equal(refused.status, 403);
  assert.equal((await fetch(`${base}/status.mjs`)).status, 404, 'the unused status helper is no longer served');
});

test('the address router is served like the other page files and refused cross-site; no directory is served', async (t) => {
  const { dataDir } = fixture(t);
  const roadmap = { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) };
  const server = createDashboardServer({ dataDir, roadmap });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const router = await fetch(`${base}/router.mjs`), script = await fetch(`${base}/dashboard.js`);
  assert.equal(router.status, 200);
  assert.equal(await router.text(), readFileSync(resolve(import.meta.dirname, '../../src/dashboard/public/router.mjs'), 'utf8'));
  // A module script needs a JavaScript type; with nosniff, any other type would be refused by the browser.
  assert.equal(router.headers.get('content-type'), 'text/javascript; charset=utf-8');
  for (const header of ['content-security-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'x-content-type-options', 'referrer-policy', 'cache-control', 'content-type']) {
    assert.equal(router.headers.get(header), script.headers.get(header), `${header} matches dashboard.js`);
  }
  assert.equal(router.headers.get('access-control-allow-origin'), null);
  // Cross-site: another site's script tag, fetch or even a top-level navigation gets nothing; same-origin loads work.
  const refusals = [{ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }, { Origin: 'https://evil.example' },
    { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }];
  for (const headers of refusals) {
    const refused = await fetch(`${base}/router.mjs`, { headers });
    assert.equal(refused.status, 403, JSON.stringify(headers));
    assert.doesNotMatch(await refused.text(), /resolveRoute/);
    assert.equal(refused.headers.get('cross-origin-resource-policy'), 'same-origin');
  }
  assert.equal((await fetch(`${base}/router.mjs`, { headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'script', Origin: base } })).status, 200);
  const wrongHost = await new Promise((done, fail) => {
    const req = request(`${base}/router.mjs`, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); done(res.statusCode); });
    req.on('error', fail); req.end();
  });
  assert.equal(wrongHost, 403);
  // Only listed files are served: no directory, no source path and no other name for the same file.
  for (const path of ['/public/router.mjs', '/src/dashboard/public/router.mjs', '/router.mjs/', '/Router.mjs', '/router.js', '/public/', '/server.mjs', '/owner.mjs', '/%2e%2e/server.mjs']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
  assert.equal((await fetch(`${base}/router.mjs`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'no command without the CSRF token');
  // The page loads it as a module from its own origin.
  assert.match(readFileSync(resolve(import.meta.dirname, '../../src/dashboard/public/dashboard.js'), 'utf8'), /^import \{[^}]+\} from '\/router\.mjs';$/m);
});

test('every module the page imports is served by the real server, including the state copy module', async (t) => {
  const { dataDir } = fixture(t);
  const roadmap = { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) };
  const server = createDashboardServer({ dataDir, roadmap });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`, source = resolve(import.meta.dirname, '../../src/dashboard');
  const imports = [...readFileSync(resolve(source, 'public/dashboard.js'), 'utf8').matchAll(/^import \{[^}]+\} from '(\/[^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['/router.mjs', '/copy.mjs']);
  const script = await fetch(`${base}/dashboard.js`);
  for (const path of imports) {
    const module = await fetch(`${base}${path}`);
    assert.equal(module.status, 200, path);
    for (const header of ['content-security-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'x-content-type-options', 'referrer-policy', 'cache-control', 'content-type']) {
      assert.equal(module.headers.get(header), script.headers.get(header), `${path}: ${header} matches dashboard.js`);
    }
    // A served module imports nothing the server would refuse.
    assert.doesNotMatch(await module.text(), /^\s*import\s/m, path);
  }
  const copy = await fetch(`${base}/copy.mjs`);
  assert.equal(await copy.text(), readFileSync(resolve(source, 'copy.mjs'), 'utf8'));
  assert.equal((await fetch(`${base}/copy.mjs`, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' } })).status, 403);
  // Only that one file: no other name for it and no other file next to it.
  for (const path of ['/public/copy.mjs', '/src/dashboard/copy.mjs', '/copy.mjs/', '/Copy.mjs', '/copy.js', '/projects.mjs']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});
