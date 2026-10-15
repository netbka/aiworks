// Dashboard path for owner messages: CSRF-protected endpoint, idempotent receipt, and receipt states in the snapshot.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { declaration } from '../supervisor/helpers.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { INSTRUCTION_LOOKS_SENSITIVE, PLAN_GOAL_LIMIT, PLAN_SOURCES, planRequestText, supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { ownerView } from '../../src/dashboard/owner.mjs';
import { safeText } from '../../src/dashboard/roadmap.mjs';
import { openPage, visibleText } from './fixtures/page.mjs';

test('owner messages are accepted only from the dashboard origin, stored once and shown with receipts', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-messages-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ coordinator: { repositories: ['example-org/aiworks'], reportTo: 'example-org/aiworks#3', maxRunsPerDay: 6 } }));
  const store = new Store(join(dataDir, 'supervisor.db'));
  campaignStart(store, declaration());
  const server = createDashboardServer({ dataDir, roadmap: { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); resolve(); }); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
  const headers = { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf };
  const send = (body, extra = {}) => fetch(`${base}/api/messages`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const requestId = randomUUID();
  const text = 'Review new PR and issues.\nPlan their execution.';
  assert.equal((await send({ requestId, text }, { 'X-Dashboard-CSRF': 'wrong' })).status, 403);
  assert.equal((await send({ requestId, text }, { Origin: 'https://evil.example' })).status, 403);
  const first = await send({ requestId, text });
  assert.equal(first.status, 202);
  const receipt = await first.json();
  assert.equal(receipt.state, 'received');
  assert.equal((await (await send({ requestId, text })).json()).duplicate, true);
  assert.equal((await send({ requestId, text: 'changed' })).status, 409);
  assert.equal((await send({ requestId: randomUUID(), text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' })).status, 400, 'secrets are refused');
  assert.equal((await send({ requestId: randomUUID(), text, extra: 1 })).status, 400);
  assert.equal(store.all('SELECT * FROM owner_messages').length, 1);
  // Receipt states and the reply link as the dashboard sees them.
  const now = Date.now();
  store.run("UPDATE owner_messages SET state = 'answered', read_at = ?, answered_at = ?, response_key = 'k' WHERE id = ?", now + 1, now + 2, receipt.id);
  store.run("INSERT INTO outbox (key, campaign_id, target, body, state, attempts, posted, updated_at) VALUES ('k', '_coordinator', 'example-org/aiworks#3', 'secret-marker', 'posted', 1, 'https://github.com/example-org/aiworks/issues/3#issuecomment-1', ?)", now);
  const view = supervisorSnapshot(dataDir).coordinator;
  assert.equal(view.configured, true);
  assert.equal(view.reportTo, 'example-org/aiworks#3');
  const message = view.messages[0];
  assert.deepEqual([message.state, message.text, message.source], ['answered', text, 'owner (dashboard)']);
  assert.ok(message.receivedAt <= message.readAt && message.readAt <= message.answeredAt);
  assert.equal(message.replyUrl, 'https://github.com/example-org/aiworks/issues/3#issuecomment-1');
  assert.ok(!JSON.stringify(view).includes('secret-marker'), 'the posted body is not exposed');
});

// Start work: Plan only (OWNER_WORKSPACE slice S9, build slice UI10). The page sends the parts; the supervisor module
// writes one structured coordinator message and stores it like any owner message. Disposable stores and a disposable
// git repository only; no network, model or GitHub call.
const ROOT = resolve(import.meta.dirname, '../..');
const page = () => readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');

/** A supervisor directory with one campaign on example-org/sampleapp and a configured project example/notes-site with a local checkout. */
async function planFixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-plan-only-'));
  const checkout = join(dataDir, 'notes-site');
  mkdirSync(checkout);
  writeFileSync(join(checkout, 'README.md'), 'Notes site.\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Plan Test', '-c', 'user.email=plan-test@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: checkout, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'initial');
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ coordinator: { repositories: ['example-org/sampleapp'], reportTo: 'example-org/sampleapp#3', maxRunsPerDay: 6 },
    repositories: { 'example/notes-site': { path: checkout } } }));
  const store = new Store(join(dataDir, 'supervisor.db'));
  campaignStart(store, declaration());
  const server = createDashboardServer({ dataDir, roadmap: { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(() => { store.close(); rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }); done(); }); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
  const send = (body, headers = {}) => fetch(`${base}/api/messages`, { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf, ...headers }, body: JSON.stringify(body) });
  return { dataDir, checkout, git, store, send };
}
const plan = (extra = {}) => ({ mode: 'plan-only', project: 'example-org/sampleapp', goal: 'Search finds recipes by ingredient.', from: 'issue', number: 443, ...extra });

test('Plan only: the coordinator message is built from the project, the goal and the issue or pull request', () => {
  assert.equal(planRequestText({ project: 'example-org/sampleapp', goal: 'Search finds recipes by ingredient.', from: 'issue', number: 443 }), [
    'Start work: Plan only, sent from the dashboard.',
    'Project: example-org/sampleapp',
    'Start from: GitHub issue #443 (https://github.com/example-org/sampleapp/issues/443)',
    'Goal (what should be true when this is finished):',
    'Search finds recipes by ingredient.',
    '',
    'Reply with a proposed plan: how success is checked, the main steps in order with the result of each, and any earlier or overlapping work in this project.',
    'This is Plan only. Change no file, register or start no work, and open, edit or comment on no issue or pull request.',
  ].join('\n'));
  assert.match(planRequestText({ project: 'example-org/sampleapp', goal: 'g', from: 'pull', number: 12 }), /^Start from: GitHub pull request #12 \(https:\/\/github\.com\/example-org\/sampleapp\/pull\/12\)$/m);
  assert.match(planRequestText({ project: 'example-org/sampleapp', goal: 'g', from: 'description' }), /^Start from: my description below$/m);
  assert.deepEqual(Object.keys(PLAN_SOURCES), ['description', 'issue', 'pull']);
  // The longest goal still fits the coordinator's 4,000-character message limit.
  assert.ok(planRequestText({ project: `${'o'.repeat(39)}/${'r'.repeat(100)}`, goal: 'x'.repeat(PLAN_GOAL_LIMIT), from: 'pull', number: Number.MAX_SAFE_INTEGER }).length <= 4000);
});

test('Plan only is stored once as a structured coordinator message, with the same origin, CSRF and secret checks', async (t) => {
  const { store, send, dataDir } = await planFixture(t);
  const requestId = randomUUID();
  assert.equal((await send({ requestId, plan: plan() }, { 'X-Dashboard-CSRF': 'wrong' })).status, 403);
  assert.equal((await send({ requestId, plan: plan() }, { Origin: 'https://evil.example' })).status, 403);
  const first = await send({ requestId, plan: plan({ project: 'EXAMPLE-ORG/sampleapp' }) });
  assert.equal(first.status, 202);
  const receipt = await first.json();
  assert.deepEqual([receipt.state, receipt.duplicate], ['received', false]);
  // A repeat with the same request ID is acknowledged once; a changed request under that ID is a conflict.
  const again = await (await send({ requestId, plan: plan({ project: 'EXAMPLE-ORG/sampleapp' }) })).json();
  assert.deepEqual([again.id, again.duplicate], [receipt.id, true]);
  assert.equal((await send({ requestId, plan: plan({ goal: 'Something else.' }) })).status, 409);
  const rows = store.all('SELECT * FROM owner_messages');
  assert.equal(rows.length, 1);
  // The project is written as this computer knows it, and the message is exactly the structured text.
  assert.equal(rows[0].text, planRequestText({ project: 'example-org/sampleapp', goal: 'Search finds recipes by ingredient.', from: 'issue', number: 443 }));
  assert.equal(rows[0].source, 'owner (Start work: Plan only)');
  assert.equal(rows[0].repository, 'example-org/sampleapp', 'project scope is durable metadata, not only prompt text');
  const shown = supervisorSnapshot(dataDir).coordinator.messages[0];
  assert.deepEqual([shown.id, shown.state, shown.source], [receipt.id, 'received', 'owner (Start work: Plan only)']);
  // Refused, and nothing stored: credential-like goals, unknown projects, missing numbers, extra fields, Plan and do.
  const refused = async (body, status, error) => {
    const response = await send({ requestId: randomUUID(), ...body });
    assert.equal(response.status, status, JSON.stringify(body));
    if (error) assert.match((await response.json()).error, error);
  };
  await refused({ plan: plan({ goal: 'Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 to deploy.' }) }, 400, /looks like it contains a secret/);
  await refused({ plan: plan({ project: 'example/unknown' }) }, 400, /not known on this computer/);
  await refused({ plan: plan({ number: undefined }) }, 400, /Give the issue number/);
  await refused({ plan: plan({ from: 'pull', number: 0 }) }, 400, /Give the pull request number/);
  await refused({ plan: plan({ from: 'description' }) }, 400);
  await refused({ plan: plan({ goal: '   ' }) }, 400, /1 to 2,000 characters/);
  await refused({ plan: plan({ goal: 'x'.repeat(PLAN_GOAL_LIMIT + 1) }) }, 400, /1 to 2,000 characters/);
  await refused({ plan: plan({ from: 'plan-file' }) }, 400);
  await refused({ plan: plan({ extra: 1 }) }, 400);
  await refused({ plan: plan(), text: 'both' }, 400);
  await refused({ plan: plan({ mode: 'plan-and-do' }) }, 409, /^Plan and do is not built yet\./);
  assert.equal(store.all('SELECT * FROM owner_messages').length, 1);
  // A plain message still goes the old way.
  assert.equal((await send({ requestId: randomUUID(), text: 'Review new PRs.' })).status, 202);
});

test('the dashboard serves a saved final plan and renders it as text, without a GitHub destination', async (t) => {
  const { store, send, dataDir } = await planFixture(t);
  const receipt = await (await send({ requestId: randomUUID(), plan: plan() })).json();
  const body = '## Sample plan\n<img src=x onerror=alert(1)>\nReview example-org/sampleapp#443.';
  store.run('INSERT INTO coordinator_replies (run_id, body) VALUES (?, ?)', 'plan-test', body);
  store.run("UPDATE owner_messages SET state = 'answered', run_id = 'plan-test', answered_at = ? WHERE id = ?", Date.now(), receipt.id);
  const snapshot = supervisorSnapshot(dataDir);
  const message = snapshot.coordinator.messages[0];
  assert.deepEqual(ownerView(snapshot).reply, { messageId: message.id, answeredAt: message.answeredAt, url: null });
  assert.equal(message.replyBody, body);
  assert.equal(message.replyUrl, null);
  const { messageReceipt } = fromPage(['function messageReceipt('], `
    const el = (tag, attrs, ...children) => ({ tag, attrs, children });
    const dateTime = () => 'now'; const clock = dateTime; const receiptStep = (done, label, detail) => ({ done, label, detail });
    const disclosure = (id, label, content) => ({ id, label, content });`);
  const rendered = messageReceipt(message, {});
  assert.equal(rendered.children.at(-1).content.tag, 'pre');
  assert.deepEqual(rendered.children.at(-1).content.children, [body], 'reply goes through text-node rendering, never HTML');
  assert.doesNotMatch(JSON.stringify(rendered), /posting the reply|aiworks#3/);
  assert.equal(store.all('SELECT * FROM outbox').length, 0);
});

test('Plan only never changes a project file or registers work', async (t) => {
  const { store, send, checkout, git } = await planFixture(t);
  const tables = store.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name);
  const dump = () => Object.fromEntries(tables.filter((name) => !['owner_messages', 'journal'].includes(name)).map((name) => [name, JSON.stringify(store.all(`SELECT * FROM "${name}"`))]));
  const files = () => readdirSync(checkout, { recursive: true }).map(String).filter((name) => !name.split(/[\\/]/).includes('.git')).sort()
    .map((name) => [name, statSync(join(checkout, name)).isFile() ? readFileSync(join(checkout, name), 'utf8') : null]);
  const before = { rows: dump(), files: files(), head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain', '--ignored'),
    journal: store.get('SELECT MAX(seq) AS seq FROM journal').seq };
  for (const project of ['example/notes-site', 'example-org/sampleapp']) {
    for (const source of [{ from: 'description', number: undefined }, { from: 'pull', number: 7 }]) {
      assert.equal((await send({ requestId: randomUUID(), plan: plan({ project, ...source }) })).status, 202);
    }
  }
  assert.ok(['campaigns', 'tasks', 'operations', 'events'].every((name) => tables.includes(name)), `the store has the work tables: ${tables}`);
  assert.deepEqual(dump(), before.rows, 'no campaign, task, operation or event is added or changed');
  assert.equal(store.all('SELECT * FROM owner_messages').length, 4);
  assert.deepEqual(store.all('SELECT kind FROM journal WHERE seq > ?', before.journal).map((row) => row.kind), Array(4).fill('message-received'));
  assert.deepEqual(files(), before.files, 'the project folder is unchanged');
  assert.equal(git('rev-parse', 'HEAD'), before.head);
  assert.equal(git('status', '--porcelain', '--ignored'), before.status);
});

/** Lines of dashboard.js, run here: `pick` finds a one-line constant or a whole top-level function by its pattern. */
function fromPage(names, stubs = '') {
  const source = page();
  const pick = (pattern) => { const found = pattern.exec(source); assert.ok(found, `dashboard.js has ${pattern}`); return found[0]; };
  const parts = names.map((name) => name.startsWith('function ') ? pick(new RegExp(`^${name.replace('(', '\\(')}[\\s\\S]*?\\n}$`, 'm')) : pick(new RegExp(`^const ${name} = .*$`, 'm')));
  return new Function(`${stubs}\n${parts.join('\n')}\nreturn { ${names.map((name) => name.replace(/^function |\($/g, '')).join(', ')} };`)();
}

test('the Start work page offers Plan only, shows Plan and do with its not-built line, and sends only Plan only', () => {
  const el = (tag, attributes = {}, ...children) => ({ tag, attributes, children: children.flat().filter((child) => child !== null && child !== undefined) });
  const stubs = `const el = ${el}; const empty = (title, detail) => el('div', { class: 'empty-state' }, title, detail);
    const routeLink = (text, route) => el('a', { href: route }, text); const formatRoute = (route) => '#/p/' + route.project + '/start';
    const drafts = { get: () => null }; const sameProject = (a, b) => a.toLowerCase() === b.toLowerCase();
    const projectList = () => [{ id: 'example/notes-site', kind: 'GitHub' }, { id: 'local-notes', kind: 'Folder' }]; const projectCampaigns = () => [];
    const state = { supervisor: { available: true, coordinator: { configured: true, reportTo: 'example/notes-site#1', messages: [] } } };
    const sending = false, offline = false, MESSAGES_ADDRESS = '#/settings/messages';`;
  const { startScreen } = fromPage(['PLAN_AND_DO_OFF', 'START_FROM', 'startBlocked', 'startDraft', 'readsKey', 'function startReceipt(', 'function startScreen('], stubs);
  const nodes = [], walk = (node) => { if (node && typeof node === 'object') { nodes.push(node); node.children.forEach(walk); } };
  startScreen('example/notes-site').forEach(walk);
  const text = nodes.flatMap((node) => node.children.filter((child) => typeof child === 'string')).join('\n');
  assert.match(text, /What should be true when this is finished\?/);
  for (const label of ['Just my description', 'A GitHub issue', 'A GitHub pull request']) assert.ok(text.includes(label), label);
  const radios = (name) => nodes.filter((node) => node.tag === 'input' && node.attributes.name === name).map((node) => node.attributes);
  assert.deepEqual(radios('start-from').map(({ value, checked }) => [value, checked]), [['description', true], ['issue', false], ['pull', false]]);
  assert.deepEqual(radios('start-mode').map(({ value, checked, disabled }) => [value, checked, disabled]), [['plan-only', true, undefined], ['plan-and-do', undefined, true]]);
  assert.match(text, /AIWorks looks and proposes a plan\. Nothing in your project changes\./);
  assert.match(text, /The plan appears here\. Nothing is posted to GitHub\./);
  assert.match(text, /Starting work from this page is not built yet\. Today, work starts when an authorized private plan is registered on this computer\./);
  assert.deepEqual(nodes.filter((node) => node.tag === 'button').map((node) => [node.attributes.type, node.children[0], node.attributes.disabled]), [['submit', 'Ask for a plan', false]]);
  // Local project intake is still unavailable even though answers can now be stored locally.
  const local = JSON.stringify(startScreen('local-notes'));
  assert.match(local, /Plan only is not available for this project yet\./);
  assert.doesNotMatch(local, /"(?:button|input|form|textarea)"/);
  // What the page sends: the parts of a Plan only request, never a mode the supervisor would have to refuse.
  const ask = /^async function askForPlan\([\s\S]*?\n}$/m.exec(page())?.[0] ?? '';
  assert.match(ask, /const plan = \{ mode: 'plan-only', project, goal: draft\.goal, from: draft\.from,/);
  assert.match(ask, /post\('\/api\/messages', \{ requestId, plan \}\)/);
  assert.doesNotMatch(page(), /mode: 'plan-and-do'/);
  // Start work is offered from Now, now that its screen exists.
  assert.match(page(), /nowView\(project, \{ \.\.\.state, offline \}, \{ now: Date\.now\(\), startWork: true \}\)/);
});

// An instruction the credential filter flags is refused with its own reason (aiworks#61). The filter is unchanged: the
// same texts are flagged, nothing is recorded or queued for them, and text it does not flag is still accepted.
test('an instruction the credential filter flags is refused as INSTRUCTION_LOOKS_SENSITIVE and nothing is recorded', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-sensitive-'));
  const store = new Store(join(dataDir, 'supervisor.db'));
  const d = declaration(); campaignStart(store, d);
  const server = createDashboardServer({ dataDir, roadmap: { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(() => { store.close(); rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }); done(); }); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
  const c = store.campaign(d.campaignId);
  const instruct = async (text, extra = {}) => {
    const response = await fetch(`${base}/api/commands`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf },
      body: JSON.stringify({ campaignId: d.campaignId, action: 'instruct', requestId: randomUUID(), version: c.version, authorizationVersion: c.authorization_version,
        scopeDigest: c.scope_digest, taskId: 'T1', taskVersion: 1, role: 'implement', text, ...extra }) });
    return { status: response.status, body: await response.json() };
  };
  const recorded = () => ({ events: store.all('SELECT seq FROM events').length, journal: store.all('SELECT * FROM journal').length });
  const before = recorded();
  // "session ... =" and "pass:" are the spans the owner hit in aiworks#61; the filter still flags both.
  for (const text of ['Keep the session label as it is; the retry count = 3 stays.', 'The checker is a pass: say so in its detail.', 'Bearer synthetic-credential-material']) {
    assert.notEqual(safeText(text, 2000), text, `the filter still flags: ${text}`);
    assert.deepEqual(await instruct(text), { status: 400, body: { error: INSTRUCTION_LOOKS_SENSITIVE, code: 'INSTRUCTION_LOOKS_SENSITIVE' } });
  }
  assert.equal(INSTRUCTION_LOOKS_SENSITIVE, 'This text looks like it may contain a credential, so nothing was sent. Remove any key, token, password or session value and send again.');
  assert.deepEqual(recorded(), before, 'nothing reaches the journal or the queue for a refused text');
  // Any other invalid instruction keeps the generic refusal, without the code.
  assert.deepEqual(await instruct('Explain the edge cases in the report.', { role: 'shell' }), { status: 400, body: { error: 'Invalid dashboard command.' } });
  // Text the filter does not flag is accepted and queued once.
  const plain = 'Keep the run limit as it is; the retry count stays at three.';
  assert.equal(safeText(plain, 2000), plain);
  const accepted = await instruct(plain);
  assert.deepEqual([accepted.status, accepted.body.accepted], [202, true]);
  assert.deepEqual(store.all("SELECT payload FROM events WHERE kind = 'agent-instruction'").map((event) => event.payload.text), [plain]);
});

test('the page shows the sensitive-text refusal next to the instruction and keeps the draft', () => {
  const source = page();
  // The code reaches the page, and only a successful send deletes the draft.
  assert.match(source, /throw Object\.assign\(new Error\(value\.error\), \{ known: true, detail: value\.detail \?\? null, code: value\.code \?\? null \}\)/);
  const deliver = /^async function deliver\([\s\S]*?\n}$/m.exec(source)?.[0] ?? '';
  assert.match(deliver, /if \(error\.code === 'INSTRUCTION_LOOKS_SENSITIVE' && payload\.action === 'instruct'\) return refuseInstruction\(payload, error\.message, draftAddress, from\);/);
  assert.equal(deliver.match(/drafts\.delete/g)?.length, 1);
  assert.ok(deliver.indexOf('drafts.delete') < deliver.indexOf('catch (error)'), 'the draft is deleted only when the instruction was accepted');
  assert.match(source, /\$\('#instruction-text'\)\.closest\('label'\)\.append\(el\('span', \{ id: 'instruction-refusal', class: 'notice warning', role: 'alert', hidden: true \}\)\);/);
  // Run refuseInstruction with a stand-in page: it opens the dialog again, with the reason beside the text.
  const stubs = `const nodes = { '#instruction-refusal': { hidden: true, textContent: '' }, '#instruction-text': { attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } } };
    const $ = (selector) => nodes[selector]; const calls = []; let dialogOpen = false; const current = { address: '#/p/example/work' };
    const document = { querySelector: () => (dialogOpen ? {} : null) };
    const campaignById = (id) => (id === 'c1' ? { id } : null);
    const openInstructions = (c) => calls.push(['open', c.id]); const notice = (...args) => calls.push(['notice', ...args]);
    const page = { nodes, calls, current, setDialogOpen: (open) => { dialogOpen = open; } };`;
  const refusal = /^function refuseInstruction\([\s\S]*?\n}$/m.exec(source)?.[0];
  assert.ok(refusal, 'dashboard.js has refuseInstruction');
  const { refuseInstruction, page: stand } = new Function(`${stubs}\n${refusal}\nreturn { refuseInstruction, page };`)();
  refuseInstruction({ campaignId: 'c1' }, INSTRUCTION_LOOKS_SENSITIVE, '#/p/example/work', '#/p/example/work');
  assert.deepEqual(stand.calls, [['open', 'c1']]);
  assert.deepEqual([stand.nodes['#instruction-refusal'].textContent, stand.nodes['#instruction-refusal'].hidden], [INSTRUCTION_LOOKS_SENSITIVE, false]);
  assert.equal(stand.nodes['#instruction-text'].attributes['aria-invalid'], 'true');
  // Moved to another screen meanwhile: the reason is a notice for the screen it was sent from; the draft stays saved there.
  stand.calls.length = 0; stand.current.address = '#/needs';
  refuseInstruction({ campaignId: 'c1' }, INSTRUCTION_LOOKS_SENSITIVE, '#/p/example/work', '#/p/example/work');
  assert.deepEqual(stand.calls, [['notice', INSTRUCTION_LOOKS_SENSITIVE, null, null, '#/p/example/work']]);
  // The reason is cleared whenever the dialog opens afresh.
  const open = /^function openInstructions\([\s\S]*?\n}$/m.exec(source)?.[0] ?? '';
  assert.match(open, /\$\('#instruction-refusal'\)\.hidden = true; \$\('#instruction-refusal'\)\.textContent = ''; \$\('#instruction-text'\)\.removeAttribute\('aria-invalid'\);/);
});

test('through the page: a flagged instruction opens again with its draft and the reason beside it; nothing is queued', async (t) => {
  const page = await openPage(t);
  await page.go('#/p/example%2Fshop-app/step/shop-wishlist/T1');
  const button = [...page.$('#content').walk()].find((node) => node.tagName === 'BUTTON' && node.textContent.trim() === 'Send guidance');
  assert.ok(button && !button.disabled, 'Send guidance is offered');
  button.click();
  const text = 'Keep the session label as it is; the retry count = 3 stays.';
  page.$('#instruction-text').value = text;
  page.$('#instruction-text').dispatchEvent({ type: 'input' });
  const queued = () => {
    const store = new Store(join(page.dataDir, 'supervisor.db'));
    try { return store.all("SELECT seq FROM events WHERE kind = 'agent-instruction'").length; } finally { store.close(); }
  };
  const before = queued();
  page.$('#instruction-form').dispatchEvent({ type: 'submit', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  await page.settle();
  const refusal = page.$('#instruction-refusal');
  assert.equal(page.$('#instruction-dialog').open, true, 'the dialog is open again');
  assert.equal(page.$('#instruction-text').value, text, 'the draft is kept');
  assert.deepEqual([refusal.hidden, visibleText(refusal)], [false, INSTRUCTION_LOOKS_SENSITIVE]);
  assert.equal(refusal.parentNode, page.$('#instruction-text').parentNode, 'the reason is beside the text it is about');
  assert.equal(page.$('#instruction-text').getAttribute('aria-invalid'), 'true');
  assert.equal(queued(), before, 'nothing was queued');
  // Opened again by the owner, the dialog starts without the old reason; the draft is still there.
  page.$('#close-instruction').click();
  button.click();
  assert.deepEqual([refusal.hidden, page.$('#instruction-text').value, page.$('#instruction-text').getAttribute('aria-invalid')], [true, text, null]);
});
