// Project rules (docs/design/PROJECT_CONNECTION.md §7.4, slice S8; plan UI16): the owner confirms, renews and revokes the
// rules of a project without GitHub in the dashboard, typing its name; an expired entry reads expired; only the owner's
// dashboard routes write `project_overlays`, and a request from a process AIWorks started is refused. Synthetic store,
// governance fixture and process lookup only: no git, gh, network or model call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Store } from '../../src/supervisor/store.mjs';
import { createProject } from '../../src/supervisor/projects.mjs';
import { overlayGovernance } from '../../src/supervisor/campaign.mjs';
import { checkCaller } from '../../src/supervisor/local-admission.mjs';
import { validateOverlayEntry } from '../../src/supervisor/local-overlay.mjs';
import { confirmProjectRules, connectedProjects, projectRulesView, revokeProjectRules } from '../../src/dashboard/projects.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { GOVERNANCE, ROOT } from '../supervisor/helpers.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-17T09:00:00.000Z');
// The caller check with a synthetic process lookup: the owner's browser, or a process whose parent is this process.
const lookupAs = (ancestors) => async () => ({ pid: 999_991, ancestors, jobs: [] });
const ownerCaller = (store) => checkCaller(store, { platform: 'win32', lookup: lookupAs([999_990]) });

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-rules-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ projectConnection: { enabled: true }, governanceRoot: GOVERNANCE }));
  const store = new Store(join(dataDir, 'supervisor.db'));
  createProject(store, { id: 'notes', tenant_id: 'example', name: 'Notes', source_kind: 'folder', root_path: join(dataDir, 'notes'),
    status: 'ready', current_baseline: { seq: 1, commit: 'a'.repeat(40), at: NOW } }, NOW);
  store.close();
  const rows = () => { const s = new Store(join(dataDir, 'supervisor.db'), { readOnly: true }); try { return s.all('SELECT * FROM project_overlays'); } finally { s.close(); } };
  return { dataDir, rows };
}

test('the owner confirms, renews and revokes a project\'s rules with the typed name; an expired entry reads expired', async (t) => {
  const { dataDir, rows } = fixture(t);
  const confirm = (input, now = NOW) => confirmProjectRules(dataDir, { projectId: 'notes', capabilities: ['ui'], lifecycle: 'active', months: 12, ...input }, { caller: ownerCaller, now });

  // The review lists every policy the project inherits, by the registry derivation, before anything is saved.
  const review = projectRulesView(dataDir, { projectId: 'notes', capabilities: ['ui'] }, NOW);
  assert.equal(review.rules.state, 'none');
  assert.ok(review.policies.length > 0);

  // A name typed wrong saves nothing; so does a validity beyond 12 months.
  await assert.rejects(confirm({ typedName: 'notes', current: null }), { status: 409, code: 'RULES_NAME_MISMATCH' });
  await assert.rejects(confirm({ typedName: 'Notes', current: null, months: 13 }), { status: 400 });
  assert.deepEqual(rows(), []);

  const confirmed = await confirm({ typedName: 'Notes', current: null });
  assert.equal(confirmed.rules.state, 'confirmed');
  const [first] = rows();
  const entry = JSON.parse(first.entry);
  assert.equal(entry.id, 'lp-notes');
  assert.equal(entry.approval.at, '2026-10-17');
  assert.equal(entry.reviewBy, '2027-10-17');
  assert.equal(first.digest, entry.approval.digest);
  // The saved entry passes local-overlay.mjs, and the review listed exactly the policies it inherits.
  validateOverlayEntry(entry, GOVERNANCE, { now: new Date(NOW) });
  assert.deepEqual(review.policies, overlayGovernance(entry, GOVERNANCE, { now: new Date(NOW) }).policies);

  // A day after reviewBy the entry is shown as expired, on the review and on /api/state's connection.
  const late = Date.parse('2027-10-18T09:00:00.000Z');
  const expired = projectRulesView(dataDir, { projectId: 'notes' }, late);
  assert.equal(expired.rules.state, 'expired');
  assert.equal(expired.rules.code, 'RULES_EXPIRED');

  // Renewing needs the rules the owner reviewed and the typed name; it moves reviewBy and changes the digest.
  await assert.rejects(confirm({ typedName: 'Notes', current: null }, late), { status: 409, code: 'RULES_CHANGED' });
  const renewed = await confirm({ typedName: ' Notes ', current: first.digest }, late);
  assert.equal(renewed.rules.state, 'confirmed');
  const [second] = rows();
  assert.equal(second.id, first.id);
  assert.notEqual(second.digest, first.digest);
  assert.equal(JSON.parse(second.entry).reviewBy, '2028-10-17', 'at most 365 days, across a leap day');
  assert.ok(Date.parse(JSON.parse(second.entry).reviewBy) - Date.parse(JSON.parse(second.entry).approval.at) <= 365 * DAY);

  // Revoking needs the typed name too; the entry stays saved, so its id is never reused, and reads revoked.
  await assert.rejects(revokeProjectRules(dataDir, { projectId: 'notes', typedName: 'Note', current: second.digest }, { caller: ownerCaller, now: late }), { code: 'RULES_NAME_MISMATCH' });
  const revoked = await revokeProjectRules(dataDir, { projectId: 'notes', typedName: 'Notes', current: second.digest }, { caller: ownerCaller, now: late + DAY });
  assert.equal(revoked.rules.state, 'revoked');
  assert.equal(rows()[0].revoked_at, late + DAY);
  assert.equal(projectRulesView(dataDir, { projectId: 'notes' }, late + DAY).rules.state, 'revoked');
  assert.equal(connectedProjects(dataDir).find((record) => record.id === 'notes').overlay.revoked_at, late + DAY);
});

test('a rules request from a process AIWorks started, or one the caller check cannot place, is refused and saves nothing', async (t) => {
  const { dataDir, rows } = fixture(t);
  const roadmap = { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) };
  const serve = async (callerCheck) => {
    const server = createDashboardServer({ dataDir, roadmap, callerCheck });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
    return (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf }, body: JSON.stringify(body) });
  };
  const body = { projectId: 'notes', capabilities: [], lifecycle: 'active', months: 12, typedName: 'Notes', current: null };
  // A synthetic AIWorks process: its parent is the process the dashboard runs in.
  const fromAiworks = await serve({ platform: 'win32', lookup: lookupAs([process.pid]) });
  const refused = await fromAiworks('/api/projects/rules/confirm', body);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'APPROVAL_FROM_AIWORKS');
  // Without a process lookup (as main.mjs starts it today) the check cannot tell, so it fails closed.
  const unchecked = await (await serve({}))('/api/projects/rules/confirm', body);
  assert.equal(unchecked.status, 403);
  assert.equal((await unchecked.json()).code, 'APPROVAL_UNCHECKED');
  assert.deepEqual(rows(), []);
  // The owner's browser is let through the same route.
  const owner = await serve({ platform: 'win32', lookup: lookupAs([999_990]) });
  assert.equal((await owner('/api/projects/rules/confirm', body)).status, 200);
  assert.equal(rows().length, 1);
  const revoke = await fromAiworks('/api/projects/rules/revoke', { projectId: 'notes', typedName: 'Notes', current: rows()[0].digest });
  assert.equal(revoke.status, 403);
  assert.equal(rows()[0].revoked_at, null);
});

test('no worker, verifier or coordinator code path writes project rules: only the dashboard owner routes do', () => {
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(join(dir, entry.name)) : /\.(mjs|js|cjs|ps1)$/.test(entry.name) ? [join(dir, entry.name)] : []);
  const sources = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'scripts'))].map((path) => [relative(ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8')]);
  const writes = /(INSERT(\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+project_overlays\b|\.insert\(\s*['"`]project_overlays/i;
  assert.deepEqual(sources.filter(([, text]) => writes.test(text)).map(([path]) => path), ['src/dashboard/projects.mjs']);
  // No supervisor, worker-context or script module reaches the dashboard's writer.
  const reaches = /dashboard\/projects\.mjs/;
  assert.deepEqual(sources.filter(([path, text]) => !path.startsWith('src/dashboard/') && reaches.test(text)).map(([path]) => path), []);
});
