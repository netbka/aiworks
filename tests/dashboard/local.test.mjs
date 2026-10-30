// A project without GitHub, planned, approved, reviewed and applied from the dashboard (docs/design/OWNER_WORKSPACE.md
// S12 and §5.3; plan slice UI17). Through the dashboard's own routes: the owner confirms a plain folder's rules, asks
// for a plan, approves exactly that plan, and applies its checked result to the folder, then undoes it. An approval,
// Apply or Undo apply from a program AIWorks started is refused with nothing written; Apply on a folder changed since
// AIWorks copied it is refused with nothing written; Undo apply restores the folder byte for byte; no pull request is
// ever shown. Disposable folders and Git repositories, a synthetic process lookup and a synthetic drafted plan: no gh,
// network or model call. The caller check names its platform, so every test runs on Windows and Linux.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { Store } from '../../src/supervisor/store.mjs';
import { SNAPSHOT_DIR } from '../../src/supervisor/adapters/mirror.mjs';
import { pinRequest, recordDraft, workRequest } from '../../src/supervisor/intake.mjs';
import { recordCandidate } from '../../src/supervisor/local-candidates.mjs';
import { connectFolderProject } from '../../src/supervisor/project-connect.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { declaration as githubDeclaration, GOVERNANCE } from '../supervisor/helpers.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Nothing a project without GitHub is shown names a pull request, a merge or GitHub.
const NO_PR = /[Pp]ull|[Mm]erge|"pr[A-Z_"]|[Gg]it[Hh]ub/;
const git = (cwd, args, { input, env = {} } = {}) => {
  const result = spawnSync('git', ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', ...args], { cwd, input, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

/** Every file under `root` with its hash. */
function snapshot(root) {
  const seen = {};
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), key);
      else seen[key] = sha256(readFileSync(join(dir, entry.name)));
    }
  };
  walk(root, '');
  return seen;
}

/** The verified commit on top of the baseline in AIWorks's copy, written with a temporary index (nothing checked out). */
function verifiedCommit(repo, parent, files, tmp) {
  const env = { GIT_INDEX_FILE: join(tmp, `index-${process.hrtime.bigint()}`) };
  git(repo, ['read-tree', parent], { env });
  for (const [path, bytes] of Object.entries(files)) {
    if (bytes === null) { git(repo, ['update-index', '--force-remove', path], { env }); continue; }
    const blob = git(repo, ['hash-object', '-w', '--stdin'], { input: bytes });
    git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
  }
  const sha = git(repo, ['commit-tree', git(repo, ['write-tree'], { env }), '-p', parent, '-m', 'the verified result']);
  git(repo, ['update-ref', `refs/heads/aiworks/task/${sha.slice(0, 12)}`, sha]);
  return sha;
}

const FILES = { 'AGENTS.md': '# Notes rules\n', 'README.md': '# Notes\nBuy milk.\n', 'old.txt': 'to be deleted\n' };
const RESULT = { 'README.md': '# Notes\nBuy milk.\nSearch: type a word.\n', 'src/search.js': 'export const search = () => [];\n', 'old.txt': null };

/**
 * A plain folder connected with project connection and Plan and do on, a merged AIWorks checkout, and two dashboards:
 * one whose caller check places the request in the owner's browser, one in a program AIWorks started.
 */
async function rig(t) {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiworks-local-ui-')));
  const folder = join(tmp, 'Notes'), dataDir = join(tmp, 'data'), runtime = join(tmp, 'runtime');
  for (const [name, content] of Object.entries(FILES)) { mkdirSync(dirname(join(folder, name)), { recursive: true }); writeFileSync(join(folder, name), content); }
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ projectConnection: { enabled: true }, governanceRoot: GOVERNANCE, coordinator: { intake: true } }));
  // The AIWorks code a local approval names: a checkout whose HEAD is merged into its origin/main (AW-005).
  mkdirSync(runtime);
  git(runtime, ['init', '-q', '-b', 'main']);
  git(runtime, ['commit', '-q', '--allow-empty', '-m', 'merged runtime']);
  git(runtime, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const gitEnv = { GIT_CEILING_DIRECTORIES: tmp };
  const store = new Store(join(dataDir, 'supervisor.db'));
  const servers = [];
  t.after(async () => {
    for (const server of servers) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    store.close();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const connected = connectFolderProject({ path: folder, name: 'Notes', id: 'notes' }, { store, dataDir, governanceRoot: GOVERNANCE, gitEnv });
  assert.equal(connected.ok, true, connected.message);
  const roadmap = { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) };
  const serve = async (ancestors) => {
    const server = createDashboardServer({ dataDir, roadmap, provenanceRoot: runtime, work: { governanceRoot: GOVERNANCE, gitEnv },
      callerCheck: { platform: 'win32', lookup: async () => ({ pid: 999_991, ancestors, jobs: [] }) } });
    servers.push(server);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
    const post = async (path, body) => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    return { post, state: async () => (await fetch(`${base}/api/state`)).json() };
  };
  // The owner's browser, and a program whose parent is the process the dashboard runs in.
  const owner = await serve([999_990]), aiworks = await serve([process.pid]);
  return { tmp, folder, dataDir, store, project: connected.project, owner, aiworks };
}

/** The owner confirms the rules and asks for a plan; AIWorks's planner drafts it (here: recorded as the coordinator would). */
async function planned(r) {
  const rules = await r.owner.post('/api/projects/rules/confirm', { projectId: 'notes', capabilities: [], lifecycle: 'active', months: 12, typedName: 'Notes', current: null });
  assert.equal(rules.status, 200, rules.body.error);
  const asked = await r.owner.post('/api/work/requests', { requestId: randomUUID(), project: 'notes', goal: 'Let me search my notes.', from: 'description' });
  assert.equal(asked.status, 202, asked.body.error);
  const request = workRequest(r.store, asked.body.requestId);
  const proposal = { summary: 'Add a search to the notes.', plan: 'One step: add search.', steps: ['Add search'], questions: [],
    declaration: { outcome: 'People can search their notes.', acceptance: ['Searching a word finds the note'], writes: ['src/', 'README.md', 'old.txt'],
      deliverables: ['commit'], constraints: githubDeclaration().constraints,
      tasks: [{ id: 'T1', title: 'search', deliverable: 'commit', goal: 'Add search.', dependsOn: [], acceptance: ['search works'], references: ['AGENTS.md'], writes: ['src/', 'README.md', 'old.txt'] }] } };
  const draft = recordDraft(r.store, { request, proposal, pinned: pinRequest(r.store, request).pinned });
  const plan = (await r.owner.state()).work.plans.find((item) => item.id === request.request_id);
  assert.equal(plan.startable, true);
  return { plan, campaignId: draft.declaration.campaignId,
    approval: () => ({ requestId: randomUUID(), plan: plan.id, version: plan.version, authorityDigest: plan.authorityDigest }) };
}

const approvals = (store) => { try { return store.all('SELECT * FROM local_approvals'); } catch { return []; } };

test('OW S12: Approve and start registers exactly the reviewed local plan; one from a program AIWorks started records nothing; no pull request is shown', async (t) => {
  const r = await rig(t);
  const { plan, campaignId, approval } = await planned(r);
  assert.doesNotMatch(JSON.stringify(plan), NO_PR);

  const refused = await r.aiworks.post('/api/work/approve', approval());
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'APPROVAL_FROM_AIWORKS');
  assert.equal(r.store.campaign(campaignId), null, 'nothing registered');
  assert.deepEqual(approvals(r.store), [], 'no approval recorded');

  const approved = await r.owner.post('/api/work/approve', approval());
  assert.equal(approved.status, 200, approved.body.error);
  assert.equal(r.store.campaign(campaignId).control, 'registered');
  assert.equal(r.store.campaign(campaignId).declaration.target.source, 'folder');
  assert.equal(approvals(r.store).length, 1);
  const work = (await r.owner.state()).work;
  assert.equal(work.plans.find((item) => item.id === plan.id).code, 'APPROVED');
  assert.equal(work.local.notes[0].id, campaignId);
  assert.doesNotMatch(JSON.stringify(work), NO_PR);
});

test('OW S12: Apply is refused on a changed folder with nothing written, refused from a program AIWorks started, and Undo apply restores the folder', async (t) => {
  const r = await rig(t);
  const { campaignId, approval } = await planned(r);
  assert.equal((await r.owner.post('/api/work/approve', approval())).status, 200);
  // The independent checker accepted T1 at this commit in AIWorks's copy (as the controller records it).
  const project = r.store.all('SELECT * FROM projects')[0];
  const sha = verifiedCommit(join(project.mirror_root, SNAPSHOT_DIR), r.project.current_baseline.commit, RESULT, r.tmp);
  recordCandidate(r.store, { declaration: r.store.campaign(campaignId).declaration, deliverable: 'commit', now: Date.now(),
    task: { task_id: 'T1', verified_sha: sha, verification: { verdict: 'accepted', summary: 'Independent verification.', checks: [], findings: [] } } });
  const result = (await r.owner.state()).work.local.notes[0].results[0];
  assert.equal(result.action, 'apply');
  assert.doesNotMatch(JSON.stringify((await r.owner.state()).work.local), NO_PR);
  const apply = () => ({ requestId: randomUUID(), campaignId, taskId: 'T1', seq: result.seq });
  const before = snapshot(r.folder);

  // A program AIWorks started cannot apply.
  const fromAiworks = await r.aiworks.post('/api/work/apply', apply());
  assert.equal(fromAiworks.status, 403);
  assert.equal(fromAiworks.body.code, 'APPLY_FROM_AIWORKS');
  assert.deepEqual(snapshot(r.folder), before);

  // The owner changed a file the result touches since AIWorks copied the folder: refused, nothing written.
  writeFileSync(join(r.folder, 'README.md'), '# Notes\nBuy milk and eggs.\n');
  const changed = snapshot(r.folder);
  const refused = await r.owner.post('/api/work/apply', apply());
  assert.equal(refused.status, 200);
  assert.equal(refused.body.outcome, 'refused');
  assert.equal(refused.body.code, 'APPLY_FOLDER_CHANGED');
  assert.deepEqual(snapshot(r.folder), changed, 'nothing was written');

  // Put back, then Apply writes exactly the result.
  writeFileSync(join(r.folder, 'README.md'), FILES['README.md']);
  const applied = await r.owner.post('/api/work/apply', apply());
  assert.equal(applied.status, 200, applied.body.error);
  assert.equal(applied.body.outcome, 'applied');
  assert.equal(readFileSync(join(r.folder, 'README.md'), 'utf8'), RESULT['README.md']);
  assert.equal(readFileSync(join(r.folder, 'src', 'search.js'), 'utf8'), RESULT['src/search.js']);
  const shown = (await r.owner.state()).work.local.notes[0].results[0];
  assert.equal(shown.action, 'undo');
  assert.doesNotMatch(JSON.stringify(shown), NO_PR);

  // Undo apply: refused from a program AIWorks started, and from the owner the folder is back byte for byte.
  const after = snapshot(r.folder);
  const undoFromAiworks = await r.aiworks.post('/api/work/undo', { requestId: randomUUID(), applyId: applied.body.applyId });
  assert.equal(undoFromAiworks.status, 403);
  assert.deepEqual(snapshot(r.folder), after);
  const undone = await r.owner.post('/api/work/undo', { requestId: randomUUID(), applyId: applied.body.applyId });
  assert.equal(undone.status, 200, undone.body.error);
  assert.equal(undone.body.outcome, 'rolled-back');
  assert.deepEqual(snapshot(r.folder), before);
});

test('WP3: an edited plan is a new version; only that exact version starts, once, with its scope, protected paths and unknown estimate kept', async (t) => {
  const r = await rig(t);
  const { plan, campaignId, approval } = await planned(r);
  const v1 = r.store.get('SELECT * FROM work_drafts WHERE request_id = ? AND version = 1', plan.id);
  assert.equal(plan.estimate, null, 'no estimate stays unknown');
  const edits = { outcome: 'People can search and filter their notes.', horizon: 'next', priority: 'high', estimate: null,
    criteria: [{ text: 'Searching a word finds the note', check: 'An automated test' }, { text: 'Filtering by a tag shows only its notes', check: null }],
    included: ['A search box'], later: ['Search history'] };
  const edit = (requestId, version, more = {}) => r.owner.post('/api/work/edit', { requestId, plan: plan.id, version, authorityDigest: plan.authorityDigest, edits: { ...edits, ...more } });

  const widened = await edit(randomUUID(), 1, { writes: ['src/', 'secrets/'] });
  assert.equal(widened.status, 400);
  assert.equal(widened.body.code, 'SCOPE_NOT_EDITABLE');
  const editId = randomUUID();
  const saved = await edit(editId, 1);
  assert.equal(saved.status, 200, saved.body.error);
  assert.equal(saved.body.version, 2);
  const again = await edit(editId, 1);
  assert.equal(again.body.duplicate, true, 'a repeated save is saved once');
  assert.equal((await edit(randomUUID(), 1)).body.code, 'PLAN_CHANGED', 'an edit of an older version is refused');
  assert.equal(r.store.get('SELECT COUNT(*) AS n FROM work_drafts WHERE request_id = ?', plan.id).n, 2);

  const v2 = r.store.get('SELECT * FROM work_drafts WHERE request_id = ? AND version = 2', plan.id);
  const power = (d) => ({ ...d.declaration, authorization: { ...d.declaration.authorization, text: null }, envelope: { ...d.declaration.envelope, outcome: null, acceptance: null } });
  assert.deepEqual(power(v2), power(v1), 'scope, protected paths, providers, limits, release and target are kept');
  assert.deepEqual(v2.pinned, v1.pinned);
  const shown = (await r.owner.state()).work.plans.find((item) => item.id === plan.id);
  assert.equal(shown.version, 2);
  assert.equal(shown.estimate, null);
  assert.ok(shown.changes.length && shown.changes.every((change) => !change.scope));

  // Approving the version reviewed before the edit starts nothing; the shown version starts once.
  const old = await r.owner.post('/api/work/approve', approval());
  assert.equal(old.body.code, 'PLAN_CHANGED');
  assert.equal(r.store.campaign(campaignId), null);
  const approved = await r.owner.post('/api/work/approve', { requestId: randomUUID(), plan: plan.id, version: 2, authorityDigest: saved.body.authorityDigest });
  assert.equal(approved.status, 200, approved.body.error);
  assert.deepEqual(r.store.campaign(campaignId).declaration, v2.declaration);
  assert.equal((await r.owner.post('/api/work/approve', { requestId: randomUUID(), plan: plan.id, version: 2, authorityDigest: saved.body.authorityDigest })).body.code, 'ALREADY_STARTED');
  const late = await r.owner.post('/api/work/edit', { requestId: randomUUID(), plan: plan.id, version: 2, authorityDigest: saved.body.authorityDigest, edits });
  assert.equal(late.body.code, 'ALREADY_APPROVED', 'registered work is never edited in place');
});

test('WP2, AW-017: a local step stopped for a decision is listed, not counted; the owner may answer it first, once, never a program AIWorks started', async (t) => {
  const r = await rig(t);
  const { campaignId, approval } = await planned(r);
  assert.equal((await r.owner.post('/api/work/approve', approval())).status, 200);
  // The builder's owner-reserved stop, as the controller records it.
  const task = r.store.task(campaignId, 'T1');
  r.store.patch('tasks', { campaign_id: campaignId, task_id: 'T1' }, task.version, { blocked: { class: 'B3', reason: 'owner-reserved: synthetic paid spend question', at: 1000 } }, Date.now());

  const state = await r.owner.state();
  const item = state.owner.items.find((entry) => entry.kind === 'decision');
  assert.deepEqual(item?.local, { project: 'notes', campaignId, taskId: 'T1' }, 'listed with its step');
  assert.equal(state.owner.count, 0, 'AIWorks answers it: not counted for the owner');
  const c = state.work.local.notes.find((plan) => plan.id === campaignId), step = c.steps.find((entry) => entry.id === 'T1');
  assert.equal(step.decision.asked, 'synthetic paid spend question');
  const answer = () => ({ requestId: randomUUID(), campaignId, taskId: 'T1', taskVersion: step.version, version: c.version,
    authorizationVersion: c.authorizationVersion, scopeDigest: c.scopeDigest, decision: step.decision.id, text: 'Stay on the free plan.' });
  const answers = () => r.store.all("SELECT kind FROM events WHERE campaign_id = ? AND kind = 'decision-answer'", campaignId);

  const refused = await r.aiworks.post('/api/v2/decisions/answer', answer());
  assert.equal(refused.status, 403);
  assert.deepEqual(answers(), [], 'nothing recorded');
  const answered = await r.owner.post('/api/v2/decisions/answer', answer());
  assert.equal(answered.status, 202, answered.body.error);
  assert.equal(answers().length, 1);
  assert.equal((await r.owner.post('/api/v2/decisions/answer', answer())).status, 409, 'answered once');
  assert.equal((await r.owner.state()).owner.count, 0);
});
