// UI14 (OWNER_WORKSPACE S10, WORK_ENVELOPE E8): Plan and do, Review, then Approve and start for a GitHub project.
// Approving registers exactly the reviewed plan through the same checks as the CLI start, and no dashboard path
// registers what the CLI would refuse. Disposable git repositories, a disposable merged runtime checkout and a
// synthetic gh only: no model, network or GitHub call is made.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, GOVERNANCE, runCli, runtimeCheckout, SQLITE } from '../supervisor/helpers.mjs';
import { authorityDigest, canonicalJson, scopeDigest } from '../../src/supervisor/campaign.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { campaignStart } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const intake = SQLITE ? await import('../../src/supervisor/intake.mjs') : {};
const { createProject } = SQLITE ? await import('../../src/supervisor/projects.mjs') : {};
const { connectLocalGitProject } = SQLITE ? await import('../../src/supervisor/project-connect.mjs') : {};
const { createDashboardServer } = SQLITE ? await import('../../src/dashboard/server.mjs') : {};
// Loaded leniently so that, on a revision without UI14, each test fails on its own assertion.
const work = await import('../../src/dashboard/work.mjs').catch(() => ({}));
// These tests run no worker, so they need SQLite only and run on Linux as on Windows.
const skip = SQLITE ? false : 'node:sqlite requires Node >= 22.5; the supervisor refuses to run without it';
// Only the disposable repositories below count, even when the temporary directory lies inside a Git work tree.
process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());

const REPO = 'example-org/sampleapp';
const ISSUE = { number: 512, title: 'Search inside chats', body: 'Let people search chats.', updated_at: '2026-10-19T08:00:00Z' };
const PROPOSAL = {
  summary: 'Add search inside chats.', plan: '1. Build the index.\n2. Show results.', steps: [{ title: 'Build the index', check: 'index tests pass' }], questions: [],
  declaration: {
    outcome: 'People can search the text of their chats.', acceptance: ['Searching a word shows every chat message containing it'],
    writes: ['src/search/', 'tests/search/'], deliverables: ['commit'], planning: 'adaptive', constraints: ['Keep the public API unchanged.'],
    tasks: [{ id: 'T1', title: 'Search index', goal: 'Build the chat search index.', acceptance: ['index tests pass'], references: ['AGENTS.md'],
      deliverable: 'commit', writes: ['src/search/'], dependsOn: [] }],
  },
};
// Synthetic gh: answers REST GET paths from routes.json ("down" = unreachable, absent = 404) and logs every call.
const GH = `import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const [state, ...args] = process.argv.slice(2);
appendFileSync(join(state, 'gh-calls.jsonl'), JSON.stringify(args) + '\\n');
const routes = JSON.parse(readFileSync(join(state, 'routes.json'), 'utf8'));
const hit = routes[args[args.length - 1]];
if (hit === undefined) { process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); }
if (hit === 'down') { process.stderr.write('error connecting to api.github.com'); process.exit(1); }
process.stdout.write(JSON.stringify(hit));
`;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const READY = { plan: { allowed: true }, startWork: { allowed: true }, publish: { allowed: true }, apply: { allowed: false, reason: 'NOT_LOCAL' } };

/** A store with a connected GitHub project on a disposable checkout, a merged runtime and a dashboard server. */
async function rig(t, { config = {}, runtime: runtimeOptions = {} } = {}) {
  const env = environment();
  const state = join(env.tmp, 'gh-state');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'gh.mjs'), GH);
  writeFileSync(join(state, 'routes.json'), JSON.stringify({ [`repos/${REPO}/issues/512`]: ISSUE }));
  const gh = [process.execPath, join(state, 'gh.mjs'), state];
  writeFileSync(join(env.dataDir, 'config.json'), JSON.stringify({ ...env.config, commands: { ...env.config.commands, gh }, ...config }, null, 2));
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  createProject(store, { id: 'sampleapp', tenant_id: 'example-org', name: 'Sample app', source_kind: 'github', root_path: env.repo,
    github_repository: REPO, base_branch: 'main', worktree_root: join(env.tmp, 'worktrees'), status: 'ready', capabilities: READY,
    governance: { kind: 'registry', entryId: 'sampleapp' } }, Date.now());
  const runtime = runtimeCheckout(runtimeOptions);
  const servers = [];
  const serve = async (options = {}) => {
    const server = createDashboardServer({ dataDir: env.dataDir, roadmap: { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) },
      provenanceRoot: runtime.root, ...options });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
    const headers = { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf };
    const post = (path, body, extra = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { base, post, approve: (body, extra) => post('/api/work/approve', body, extra), state: async () => (await fetch(`${base}/api/state`)).json() };
  };
  t.after(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
    store.close(); runtime.cleanup(); env.cleanup();
  });
  return {
    env, store, state, gh, runtime, serve,
    setRoutes: (next) => writeFileSync(join(state, 'routes.json'), JSON.stringify(next)),
    ghCalls: () => (existsSync(join(state, 'gh-calls.jsonl')) ? readFileSync(join(state, 'gh-calls.jsonl'), 'utf8').split('\n').filter(Boolean) : []),
  };
}

/** One issue request and its draft, as a finished intake read stores it. */
function drafted(r, { requestId = randomUUID(), proposal = PROPOSAL } = {}) {
  if (!intake.workRequest(r.store, requestId)) intake.submitWorkRequest(r.store, { requestId, projectId: 'sampleapp', route: 'issue', reference: 512 });
  const request = intake.workRequest(r.store, requestId);
  const pin = intake.pinRequest(r.store, request, { gh: r.gh });
  assert.equal(pin.ok, true, JSON.stringify(pin));
  r.store.run("UPDATE work_requests SET pinned = ?, state = 'drafting' WHERE request_id = ?", pin.pinned, requestId);
  return intake.recordDraft(r.store, { request: intake.workRequest(r.store, requestId), proposal, pinned: pin.pinned });
}
const reviewed = (draft, extra = {}) => ({ requestId: randomUUID(), plan: draft.request_id, version: draft.version, authorityDigest: draft.authority_digest, ...extra });
const hasTable = (store, name) => Boolean(store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", name));
/** Nothing registered and no approval kept. */
function nothingRegistered(store, message) {
  assert.equal(store.get('SELECT COUNT(*) AS n FROM campaigns WHERE id LIKE ?', 'sampleapp-intake-%').n, 0, `${message}: no campaign registered`);
  if (hasTable(store, 'approved_declarations')) assert.equal(store.get('SELECT COUNT(*) AS n FROM approved_declarations').n, 0, `${message}: no approval kept`);
  if (hasTable(store, 'envelope_approvals')) assert.equal(store.get('SELECT COUNT(*) AS n FROM envelope_approvals').n, 0, `${message}: no approval recorded`);
}

test('Approve and start registers exactly the reviewed plan, bound to its digest, once', { skip }, async (t) => {
  const r = await rig(t);
  const draft = drafted(r);
  const page = await r.serve();
  const before = (await page.state()).work;
  assert.equal(typeof before, 'object', 'the state carries the Review data');
  const shown = before.plans.find((plan) => plan.id === draft.request_id);
  assert.deepEqual([shown.code, shown.startable, shown.project, shown.version, shown.authorityDigest, shown.fingerprint, shown.release],
    ['DRAFT_READY', true, REPO, 1, draft.authority_digest, draft.authority_digest.slice(0, 12), 'review-only']);
  assert.deepEqual(shown.writes, ['src/search/', 'tests/search/']);
  assert.ok(!JSON.stringify(before).includes(r.env.repo.replaceAll('\\', '\\\\')), 'no local path is served');
  const command = reviewed(draft);
  const response = await page.approve(command);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual([body.accepted, body.duplicate, body.campaignId, body.project], [true, false, draft.declaration.campaignId, REPO]);
  const campaign = r.store.campaign(draft.declaration.campaignId);
  assert.equal(canonicalJson(campaign.declaration), canonicalJson(draft.declaration), 'the registered declaration is byte for byte the reviewed one');
  assert.equal(authorityDigest(campaign.declaration), command.authorityDigest);
  const kept = r.store.all('SELECT * FROM approved_declarations');
  assert.deepEqual(kept.map((row) => [row.campaign_id, row.authority_digest, row.approval_id, row.registered_at !== null]),
    [[campaign.id, command.authorityDigest, `dashboard-${command.requestId}`, true]], 'the private approval is kept with the plan it binds');
  assert.equal(JSON.parse(kept[0].approval_text).approvedBy, 'owner (dashboard)');
  assert.equal(r.store.get('SELECT COUNT(*) AS n FROM envelope_approvals WHERE campaign_id = ?', campaign.id).n, 1);
  // A repeat with the same request id is acknowledged once; another approval of a started plan is refused.
  const again = await (await page.approve(command)).json();
  assert.deepEqual([again.accepted, again.duplicate, again.campaignId], [true, true, campaign.id]);
  const second = await page.approve(reviewed(draft));
  assert.deepEqual([second.status, (await second.json()).code], [409, 'ALREADY_STARTED']);
  assert.equal(r.store.all("SELECT 1 FROM journal WHERE campaign_id = ? AND kind = 'registered'", campaign.id).length, 1, 'registered once');
  assert.equal(r.store.all('SELECT 1 FROM approved_declarations').length, 1);
  const after = (await page.state()).work.plans.find((plan) => plan.id === draft.request_id);
  assert.deepEqual([after.code, after.startable, typeof after.approvedAt], ['APPROVED', false, 'string']);
});

test('the route keeps the dashboard origin, CSRF, JSON and 16 KiB rules; a refused request registers nothing', { skip }, async (t) => {
  const r = await rig(t);
  const draft = drafted(r);
  const page = await r.serve();
  const command = reviewed(draft);
  assert.equal((await page.approve(command, { 'X-Dashboard-CSRF': 'wrong' })).status, 403, 'a wrong CSRF token');
  assert.equal((await page.approve(command, { 'X-Dashboard-CSRF': '' })).status, 403, 'no CSRF token');
  assert.equal((await page.approve(command, { Origin: 'https://evil.example' })).status, 403, 'another origin');
  assert.equal((await page.approve(command, { 'Content-Type': 'text/plain' })).status, 415, 'not JSON');
  assert.equal((await page.approve(JSON.stringify({ ...command, pad: 'x'.repeat(17_000) }))).status, 413, 'over 16 KiB');
  for (const bad of [{ ...command, extra: 1 }, { ...command, requestId: 'x' }, { ...command, version: 0 }, { ...command, authorityDigest: 'A'.repeat(64) }]) {
    assert.equal((await page.approve(bad)).status, 400, JSON.stringify(bad));
  }
  nothingRegistered(r.store, 'refused requests');
  // A Plan and do request is stored once and registers nothing; it is refused while drafting is off.
  const ask = { requestId: randomUUID(), project: REPO, goal: 'Search inside chats.', from: 'issue', number: 512 };
  assert.equal((await page.post('/api/work/requests', ask)).status, 409, 'Plan and do is off until drafting is switched on');
  writeFileSync(join(r.env.dataDir, 'config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(r.env.dataDir, 'config.json'), 'utf8')), coordinator: { intake: true } }));
  assert.equal((await page.post('/api/work/requests', ask, { 'X-Dashboard-CSRF': 'wrong' })).status, 403);
  const sent = await page.post('/api/work/requests', ask);
  const receipt = await sent.json();
  assert.deepEqual([sent.status, receipt.state, receipt.planOnly, receipt.route, receipt.project], [202, 'received', false, 'issue', REPO]);
  assert.equal((await (await page.post('/api/work/requests', ask)).json()).duplicate, true);
  assert.equal((await page.post('/api/work/requests', { ...ask, goal: 'Token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here.' , requestId: randomUUID() })).status, 400);
  assert.equal((await page.post('/api/work/requests', { ...ask, from: 'description', number: undefined, requestId: randomUUID() })).status, 400, 'a described goal names its report issue');
  assert.equal((await page.post('/api/work/requests', { ...ask, project: 'example-org/unknown', requestId: randomUUID() })).status, 409);
  assert.equal(((await page.state()).work.plans.find((plan) => plan.id === ask.requestId) ?? {}).code, 'DRAFTING');
  nothingRegistered(r.store, 'a Plan and do request');
});

test('a plan changed after review, a stale version, a moved base or an unreadable base is refused with nothing registered', { skip }, async (t) => {
  const r = await rig(t);
  const first = drafted(r);
  const page = await r.serve();
  const refusal = async (body, status, code, message) => {
    const response = await page.approve(body);
    const value = await response.json();
    assert.deepEqual([response.status, value.code], [status, code], `${message}: ${JSON.stringify(value)}`);
    nothingRegistered(r.store, message);
    return value;
  };
  // Another version was drafted after the owner opened version 1.
  const second = drafted(r, { requestId: first.request_id, proposal: { ...PROPOSAL, summary: 'Add search inside chats, revised.',
    declaration: { ...PROPOSAL.declaration, outcome: 'People can search the text of their chats and open the match.' } } });
  assert.equal(second.version, 2);
  assert.notEqual(second.authority_digest, first.authority_digest);
  const changed = await refusal(reviewed(first), 409, 'PLAN_CHANGED', 'a stale version');
  assert.equal(changed.error, 'This plan changed since you opened it. Review it again.');
  await refusal(reviewed(second, { authorityDigest: first.authority_digest }), 409, 'PLAN_CHANGED', 'another digest');
  // The stored plan was changed after review: same version and row digest, but its bytes no longer hash to them.
  const tampered = { ...second.declaration, envelope: { ...second.declaration.envelope, writes: ['src/'] } };
  r.store.run('UPDATE work_drafts SET declaration = ? WHERE request_id = ? AND version = 2', tampered, second.request_id);
  await refusal(reviewed(second), 409, 'PLAN_CHANGED', 'a plan changed after review');
  r.store.run('UPDATE work_drafts SET declaration = ? WHERE request_id = ? AND version = 2', second.declaration, second.request_id);
  const calls = r.ghCalls().length;
  // The project's base branch cannot be read: unknown is never fresh.
  const origin = git(r.env.repo, 'remote', 'get-url', 'origin');
  git(r.env.repo, 'remote', 'set-url', 'origin', join(r.env.tmp, 'missing.git'));
  await refusal(reviewed(second), 503, 'BASE_UNKNOWN', 'an unreadable base branch');
  git(r.env.repo, 'remote', 'set-url', 'origin', origin);
  // The base branch moved after drafting: the plan is out of date and cannot be approved.
  writeFileSync(join(r.env.repo, 'NEW.md'), 'new\n');
  git(r.env.repo, 'add', '-A');
  git(r.env.repo, 'commit', '-q', '-m', 'moved on');
  git(r.env.repo, 'push', '-q', 'origin', 'main');
  const stale = await refusal(reviewed(second), 409, 'DRAFT_STALE', 'a new base revision');
  assert.match(stale.error, /changed since this plan was drafted \(a new version of the project\)\. Draft it again before approving\.$/);
  assert.equal(r.ghCalls().length, calls, 'Approve and start runs no gh');
  // A draft the supervisor marked stale (here an edited issue, found by intake's own check) cannot be approved.
  r.setRoutes({ [`repos/${REPO}/issues/512`]: { ...ISSUE, updated_at: '2026-10-20T08:00:00Z' } });
  assert.equal(intake.checkDraftFreshness(r.store, second.request_id, { gh: r.gh }).stale, true);
  const marked = await refusal(reviewed(second), 409, 'DRAFT_STALE', 'a draft marked stale');
  assert.match(marked.error, /the issue was edited/);
  assert.equal((await page.state()).work.plans.find((plan) => plan.id === second.request_id).code, 'DRAFT_STALE');
});

test('no dashboard path registers what the CLI start would refuse, case by case', { skip }, async (t) => {
  /** The dashboard refuses with the CLI's reason, the CLI refuses the same plan, and neither registers it. */
  const parity = async (r, page, cliArgs, expected, message) => {
    const draft = intake.latestDraft(r.store, r.requestId);
    const response = await page.approve(reviewed(draft));
    const value = await response.json();
    assert.equal(response.status, 409, `${message}: ${JSON.stringify(value)}`);
    assert.equal(value.code, 'START_REFUSED', message);
    assert.ok(String(value.detail).startsWith(`${expected.dashboard}:`), `${message}: ${value.detail}`);
    assert.match(value.error, /^AIWorks didn't start this work: .+\.$/, message);
    nothingRegistered(r.store, `${message} (dashboard)`);
    const file = join(r.env.tmp, 'plan.json'), approvalFile = join(r.env.tmp, 'plan-approval.json');
    writeFileSync(file, JSON.stringify(draft.declaration));
    writeFileSync(approvalFile, JSON.stringify({ schema: 'aiworks-envelope-approval/1', approvalId: 'cli-approval-1', campaignId: draft.declaration.campaignId,
      authorityDigest: draft.authority_digest, approvedBy: 'owner', approvedAt: '2026-10-20T09:00:00Z' }));
    const cli = runCli(cliArgs.cli, ['start', file, '--approval', approvalFile, '--data', r.env.dataDir, ...cliArgs.extra]);
    assert.equal(cli.status, 1, `${message}: the CLI refuses too (${cli.stdout}${cli.stderr})`);
    assert.match(cli.stderr, expected.cli, message);
    nothingRegistered(r.store, `${message} (CLI)`);
  };
  const setup = async (t, options = {}) => {
    const r = await rig(t, options);
    r.requestId = drafted(r).request_id;
    return r;
  };

  // 1. Runtime code that is not merged into origin/main (AW-005).
  const unmerged = await setup(t, { runtime: { unmerged: true } });
  await parity(unmerged, await unmerged.serve(), { cli: unmerged.runtime.cli, extra: [] }, { dashboard: 'RUNTIME_NOT_MERGED', cli: /^RUNTIME_NOT_MERGED:/m }, 'unmerged runtime');

  // 2. A project the project rules do not list.
  const unlisted = await setup(t);
  const rules = join(unlisted.env.tmp, 'governance-without-sampleapp');
  cpSync(GOVERNANCE, rules, { recursive: true });
  rmSync(join(rules, 'registry', 'projects', 'sampleapp.json'));
  await parity(unlisted, await unlisted.serve({ work: { governanceRoot: rules } }), { cli: unlisted.runtime.cli, extra: ['--governance', rules] },
    { dashboard: 'NOT_REGISTERED', cli: /is not a registered project/ }, 'unregistered project');

  // 3. No project rules configured at all.
  const unruled = await setup(t, { config: { governanceRoot: undefined } });
  await parity(unruled, await unruled.serve(), { cli: unruled.runtime.cli, extra: [] }, { dashboard: 'GOVERNANCE_ROOT_REQUIRED', cli: /^GOVERNANCE_ROOT_REQUIRED:/m }, 'no project rules');

  // 4. The same step already belongs to other work (aiworks#5).
  const duplicate = await setup(t);
  const task = intake.latestDraft(duplicate.store, duplicate.requestId).declaration.tasks[0];
  campaignStart(duplicate.store, declaration({ campaignId: 'earlier-work', tasks: [{ id: 'E1', issue: task.issue, title: 'earlier', deliverable: 'commit', goal: task.goal,
    dependsOn: [], acceptance: task.acceptance, references: ['AGENTS.md'] }] }));
  await parity(duplicate, await duplicate.serve(), { cli: duplicate.runtime.cli, extra: [] }, { dashboard: 'WORK_ALREADY_ASSIGNED', cli: /^WORK_ALREADY_ASSIGNED:/m }, 'duplicate work');
  assert.deepEqual(duplicate.store.all('SELECT id FROM campaigns').map((row) => row.id), ['earlier-work']);

  // 5. A declaration the registration rules refuse, stored as the draft the owner reviewed: the reviewed digest matches
  // these bytes, so only the CLI's own validation stops it.
  const invalid = await setup(t);
  const bad = intake.latestDraft(invalid.store, invalid.requestId);
  const refusedDeclaration = { ...bad.declaration, envelope: { ...bad.declaration.envelope, release: { mode: 'auto-release' } } };
  invalid.store.run('UPDATE work_drafts SET declaration = ?, authority_digest = ?, scope_digest = ? WHERE request_id = ?', refusedDeclaration,
    authorityDigest(refusedDeclaration), scopeDigest(refusedDeclaration), invalid.requestId);
  await parity(invalid, await invalid.serve(), { cli: invalid.runtime.cli, extra: [] }, { dashboard: 'INVALID_DECLARATION', cli: /RELEASE_MODE_UNAVAILABLE/ }, 'Auto Release');
});

test('a project without GitHub is never started from Review and never reads gh', { skip }, async (t) => {
  const r = await rig(t);
  const root = join(r.env.tmp, 'Notes');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'notes\n');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '-m', 'notes');
  const connected = connectLocalGitProject({ path: root, id: 'notes', name: 'Notes' }, { store: r.store, dataDir: r.env.dataDir, governanceRoot: GOVERNANCE,
    gitEnv: { GIT_CEILING_DIRECTORIES: r.env.tmp } });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  const requestId = randomUUID();
  intake.submitWorkRequest(r.store, { requestId, projectId: 'notes', route: 'goal', text: 'Tidy the notes.' });
  const request = intake.workRequest(r.store, requestId);
  const pin = intake.pinRequest(r.store, request, { gh: r.gh });
  const local = intake.recordDraft(r.store, { request, proposal: PROPOSAL, pinned: pin.pinned });
  const calls = r.ghCalls().length;
  const page = await r.serve();
  const response = await page.approve(reviewed(local));
  assert.deepEqual([response.status, (await response.json()).code], [409, 'LOCAL_START_OFF']);
  assert.equal(r.ghCalls().length, calls, 'no gh call for a project without GitHub');
  assert.equal(r.store.get('SELECT COUNT(*) AS n FROM campaigns').n, 0);
  assert.equal((await page.state()).work.plans.some((plan) => plan.id === requestId), false, 'its plans start through slice UI17, not here');
  assert.equal(typeof work.approvePlan, 'function');
});

test('Review shows the plan in owner words; a changed plan is refused in place; Approve and start opens Work', { skip }, async (t) => {
  const { openPage, visibleText, internalWords } = await import('./fixtures/page.mjs');
  const r = await rig(t, { config: { coordinator: { repositories: [REPO], timeoutMinutes: 1, intake: true } } });
  const first = drafted(r);
  const page = await openPage(t, { store: 'empty', server: { dataDir: r.env.dataDir, provenanceRoot: r.runtime.root } });
  const address = `#/p/${encodeURIComponent(REPO)}/review/${first.request_id}`;
  await page.go(address);
  const content = page.$('#content');
  const text = visibleText(content);
  for (const words of ['People can search the text of their chats.', 'How it is checked', 'Searching a word shows every chat message containing it',
    'Main steps', 'Build the index · checked by: index tests pass', 'Overlaps with other work None found.', 'What it may change src/search/ tests/search/',
    'No limits. You can pause or cancel it at any time.', 'Release: Review only. AIWorks stops when a result passes the check and is published. You merge and release.']) {
    assert.ok(text.includes(words), `${words} in ${text}`);
  }
  assert.deepEqual(internalWords(text), [], 'owner words only outside Details');
  const approve = () => content.querySelectorAll('button').find((node) => /^(Approve and start|Starting…)$/.test(node.textContent));
  assert.deepEqual([approve().getAttribute('type'), approve().disabled], ['button', false], 'a real button, reachable by keyboard');
  assert.ok(content.querySelectorAll('details').some((node) => node.textContent.includes(`Plan fingerprint ${first.authority_digest.slice(0, 12)} · version 1`)));
  // Narrow screens: long paths and the plan text wrap instead of scrolling sideways (UX-001, 320px).
  const css = readFileSync(new URL('../../src/dashboard/public/dashboard.css', import.meta.url), 'utf8');
  assert.match(css, /\.review-part ul,\.review-part ol,\.plan-list\{[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.review \.plan-text\{white-space:pre-wrap;overflow-wrap:anywhere/);

  // A new version is drafted while the owner reads version 1: pressing Approve and start is refused and the place is kept.
  const second = drafted(r, { requestId: first.request_id, proposal: { ...PROPOSAL, declaration: { ...PROPOSAL.declaration, outcome: 'People can search chats by word.' } } });
  approve().click();
  await page.settle();
  assert.equal(page.location.hash, address, 'the owner stays on Review');
  assert.match(visibleText(page.$('#notice')), /^This plan changed since you opened it\. Review it again\./);
  nothingRegistered(r.store, 'a changed plan from the page');
  await page.refresh();
  assert.match(visibleText(page.$('#content')), /^People can search chats by word\./, 'the new version is shown');

  approve().click();
  await page.settle();
  assert.equal(page.location.hash, `#/p/${encodeURIComponent(REPO)}/work`);
  assert.match(visibleText(page.$('#notice')), /^Approved at \d{2}:\d{2} · waiting for AIWorks to pick it up/);
  const campaign = r.store.campaign(second.declaration.campaignId);
  assert.equal(canonicalJson(campaign.declaration), canonicalJson(second.declaration), 'the version on screen is the one registered');
  await page.go(address);
  assert.match(visibleText(page.$('#content')), /Approved at \d{2}:\d{2} · waiting for AIWorks to pick it up · Open Work/);
  assert.equal(page.$('#content').querySelectorAll('button').some((node) => node.textContent === 'Approve and start'), false, 'no second approval is offered');
});

test('Start work offers Plan and do only for a connected GitHub project with drafting on, and sends a work request', { skip }, async (t) => {
  const { openPage, visibleText } = await import('./fixtures/page.mjs');
  const r = await rig(t, { config: { coordinator: { repositories: [REPO], timeoutMinutes: 1, intake: true } } });
  const page = await openPage(t, { store: 'empty', server: { dataDir: r.env.dataDir, provenanceRoot: r.runtime.root } });
  await page.go(`#/p/${encodeURIComponent(REPO)}/start`);
  const radios = () => page.$('#content').querySelectorAll('input').filter((node) => node.getAttribute('name') === 'start-mode');
  assert.deepEqual(radios().map((node) => [node.getAttribute('value'), node.checked]), [['plan-only', true], ['plan-and-do', false]]);
  const form = page.$('form[data-start-form]');
  page.$('#start-goal').value = 'Search inside chats.';
  // A radio choice as a browser makes it: the others of its group are unchecked, then the chosen one reports a change.
  const choose = (name, value) => {
    const group = form.querySelectorAll('input').filter((item) => item.getAttribute('name') === name);
    for (const item of group) item.checked = item.getAttribute('value') === value;
    group.find((item) => item.checked).dispatchEvent({ type: 'change', preventDefault() {} });
  };
  choose('start-from', 'issue');
  page.$('#start-number').value = '512';
  choose('start-mode', 'plan-and-do');
  assert.match(visibleText(form), /AIWorks drafts a plan and shows it to you on Review\. Nothing starts until you press Approve and start\./);
  form.dispatchEvent({ type: 'submit', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  await page.settle();
  const rows = r.store.all('SELECT * FROM work_requests');
  assert.deepEqual(rows.map((row) => [row.project_id, row.route, row.reference, row.plan_only, row.state]), [['sampleapp', 'issue', '512', 0, 'received']]);
  assert.match(visibleText(page.$('#content')), /Sent · AIWorks is drafting a plan\. Nothing changes yet\./);
  assert.equal(r.store.get('SELECT COUNT(*) AS n FROM campaigns').n, 0, 'asking for a plan starts nothing');
  // Once drafted, the receipt and the plan list lead to Review.
  drafted(r, { requestId: rows[0].request_id });
  await page.refresh();
  const links = page.$('#content').querySelectorAll('a').map((node) => node.getAttribute('href'));
  assert.ok(links.includes(`#/p/${encodeURIComponent(REPO)}/review/${rows[0].request_id}`), links.join(' '));
  // Drafting off: Plan and do is not offered, and Start work is as before.
  writeFileSync(join(r.env.dataDir, 'config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(r.env.dataDir, 'config.json'), 'utf8')), coordinator: { repositories: [REPO], timeoutMinutes: 1 } }));
  await page.refresh();
  assert.equal(radios().length, 0, 'the open form is built again without Plan and do');
  await page.go('#/projects');
  await page.go(`#/p/${encodeURIComponent(REPO)}/start`);
  assert.equal(radios().length, 0);
  assert.match(visibleText(page.$('#content')), /AIWorks looks and proposes a plan\. Nothing in your project changes\./);
});
