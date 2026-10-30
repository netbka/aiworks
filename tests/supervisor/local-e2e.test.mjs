// Work starts on a project without GitHub (docs/design/WORK_ENVELOPE.md section 8 and slice E12; plan STA17, decision
// D4). A plain folder is connected, the owner confirms its rules and approves a plan through the dashboard's own code with
// a synthetic owner caller, and the plan runs on AIWorks's copy to verified local candidates, across a restart. No gh call
// at any step; no worker runs in the owner's folder, which receives only the checked results, each with a backup (AW-018).
// Without confirmed rules, with revoked or expired rules, or without
// the owner's approval of exactly this plan, nothing starts. Synthetic executables and disposable folders only.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { declaration as githubDeclaration, environment, GOVERNANCE, runUntil, skipWithoutSqlite, SQLITE } from './helpers.mjs';

const m = SQLITE ? {
  ...await import('../../src/supervisor/store.mjs'),
  ...await import('../../src/supervisor/controller.mjs'),
  ...await import('../../src/supervisor/api.mjs'),
  ...await import('../../src/supervisor/campaign.mjs'),
  ...await import('../../src/supervisor/local-admission.mjs'),
  ...await import('../../src/supervisor/project-connect.mjs'),
  ...await import('../../src/supervisor/local-candidates.mjs'),
  dashboard: await import('../../src/dashboard/projects.mjs'),
} : {};

const REVISION = 'c'.repeat(40);
// The owner's browser: a process AIWorks did not start, in no AIWorks job. The real lookup is Windows-only, so the platform
// is given; checkCaller itself is the code under test.
const owner = { lookup: async () => ({ pid: 4242, ancestors: [4100, 4], jobs: [] }), connection: { remotePort: 50001 }, platform: 'win32' };
const ownerCaller = (store) => m.checkCaller(store, owner);

/** Every file under `root` with its bytes, to show the owner's folder is never written. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return out;
}

/** A disposable folder connected as a plain folder project, in a store with project connection on. */
function setup(t) {
  const env = environment({ scenario: { commitDir: 'src' }, config: { projectConnection: { enabled: true } } });
  const store = new m.Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const folder = join(env.tmp, 'notes');
  mkdirSync(folder);
  writeFileSync(join(folder, 'AGENTS.md'), '# Notes rules\n');
  writeFileSync(join(folder, 'notes.md'), 'Buy milk.\n');
  const connected = m.connectFolderProject({ path: folder, name: 'Notes', id: 'notes' }, { store, dataDir: env.dataDir, governanceRoot: GOVERNANCE,
    // A host whose profile folder is a Git repository must not decide the test.
    gitEnv: { GIT_CEILING_DIRECTORIES: env.tmp } });
  assert.equal(connected.ok, true, connected.message);
  return { env, store, folder, project: connected.project };
}

/** The owner confirms the project's rules on its Now screen: the dashboard's route code with the owner's caller. */
async function confirmRules(env, project, current = null) {
  const result = await m.dashboard.confirmProjectRules(env.dataDir, { projectId: project.id, capabilities: [], lifecycle: 'active', months: 12,
    typedName: project.name, current, requestId: randomUUID() }, { caller: ownerCaller });
  assert.equal(result.ok, true);
  return result.rules.current;
}

/** A plan for the folder (WORK_ENVELOPE 4.1 with a local target) naming its approval. */
function plan(project, approvalId, { campaignId = 'local-notes', goal = 'Add search.' } = {}) {
  const base = project.current_baseline.commit;
  const github = githubDeclaration({ campaignId });
  return {
    version: 2, campaignId,
    authorization: { version: 1, grantedBy: 'owner', grantedAt: '2026-10-16', reference: `aiworks-local:${approvalId}`, text: 'Approved in the AIWorks dashboard.' },
    target: { tenantId: 'local', projectId: `lp-${project.id}`, environment: 'local', source: 'folder', baseline: { seq: 1, commit: base } },
    limits: github.limits, executor: github.executor, constraints: github.constraints,
    tasks: [
      { id: 'T1', title: 'search', deliverable: 'commit', goal, dependsOn: [], acceptance: ['search works'], references: ['AGENTS.md'], writes: ['src/'] },
      { id: 'T2', title: 'index', deliverable: 'commit', goal: `Add an index. ${goal}`, dependsOn: ['T1'], acceptance: ['index works'], references: ['AGENTS.md'], writes: ['src/'] },
    ],
    envelope: { scopeVersion: 1, request: { route: 'goal', pinned: { base } }, outcome: 'People can search their notes.',
      acceptance: ['Searching a word finds the note'], writes: ['src/'], deliverables: ['commit'], issues: [], web: null,
      release: { mode: 'review-only' }, planning: 'fixed' },
  };
}

/** Approve and start in the dashboard: record the owner's approval of exactly this plan, then register it. */
async function approve(store, declaration, { requestId = randomUUID(), caller = owner } = {}) {
  const { project, overlay, takenIds } = m.resolveLocalProject(store, declaration);
  return m.recordLocalApproval(store, { declaration, overlay, project, governanceRoot: GOVERNANCE, takenIds, codeRevision: REVISION, requestId, caller });
}
const register = (store, declaration, now = Date.now()) => m.registerLocalPlan(store, { declaration, governanceRoot: GOVERNANCE, codeRevision: REVISION, now });

function refused(fn, code) {
  assert.throws(fn, (error) => { assert.equal(error.code, code, error.message); return true; });
}

test('WE E12: connect, confirm rules, approve, run on AIWorks\'s copy, verify, local candidates, restart; no gh, only checked results applied',{ skip: skipWithoutSqlite }, async (t) => {
  const { env, store, folder, project } = setup(t);
  const before = snapshot(folder);
  await confirmRules(env, project);
  const declaration = plan(project, randomUUID());
  const approved = await approve(store, declaration);
  assert.equal(approved.recorded, true);
  register(store, declaration);
  const id = declaration.campaignId;
  assert.equal(store.campaign(id).control, 'registered');

  // Run until the first result is a local candidate, then restart the supervisor and finish.
  const first = new m.Controller({ store, config: env.config, dataDir: env.dataDir, fault: null, codeRevision: REVISION });
  await runUntil(first, store, id, () => store.task(id, 'T1').state === 'done');
  first.release();
  const second = new m.Controller({ store, config: env.config, dataDir: env.dataDir, fault: null, codeRevision: REVISION });
  const campaign = await runUntil(second, store, id, (c) => c.control === 'finished');
  assert.equal(campaign.status, 'ready');

  const calls = env.calls();
  assert.deepEqual(calls.map((call) => call.role), ['implement', 'verify', 'implement', 'verify']);
  const worktrees = relative(project.worktree_root, calls[0].cwd);
  for (const call of calls) {
    assert.ok(!relative(project.worktree_root, call.cwd).startsWith('..'), `worker ran in AIWorks's copy, not ${call.cwd}`);
    assert.ok(relative(folder, call.cwd).startsWith('..'), 'no worker ran in the owner\'s folder');
  }
  assert.ok(worktrees);
  const candidates = store.all('SELECT * FROM local_candidates WHERE campaign_id = ? ORDER BY task_id', id);
  assert.deepEqual(candidates.map((row) => row.task_id), ['T1', 'T2']);
  for (const task of store.tasks(id).filter((row) => ['T1', 'T2'].includes(row.task_id))) {
    assert.equal(task.state, 'done');
    assert.equal(task.pr_url, null, 'never a pull request');
    assert.equal(candidates.find((row) => row.task_id === task.task_id).sha, task.verified_sha, 'the candidate is exactly the verified revision');
  }
  assert.deepEqual(env.ghCalls(), [], 'gh is never called for a project without GitHub');
  assert.equal(store.all("SELECT * FROM outbox WHERE state <> 'local'").length, 0, 'nothing is queued for GitHub');
  assert.ok(store.get("SELECT * FROM outbox WHERE key = ? AND state = 'local'", `${id}:ready`), 'the ready note stays in this computer\'s store');
  // AW-018: AIWorks applied each checked result itself, after a backup; the owner's own files are as they were.
  const applies = store.all('SELECT * FROM local_applies WHERE campaign_id = ? ORDER BY task_id', id);
  assert.deepEqual(applies.map((row) => [row.task_id, row.sha, row.last_outcome]), candidates.map((row) => [row.task_id, row.sha, 'applied']));
  const after = snapshot(folder);
  for (const [path, bytes] of Object.entries(before)) assert.equal(after[path], bytes, `${path} is untouched`);
  assert.equal(Object.keys(after).length, Object.keys(before).length + 2, 'only the two checked results were added');
});

test('no confirmed rules, revoked rules or expired rules: nothing starts, and revoking stops new dispatches', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, project } = setup(t);
  // No rules confirmed: no approval can bind them and nothing registers.
  refused(() => register(store, plan(project, randomUUID())), 'RULES_NONE');

  // Revoked after the approval: the registration is refused and the approval stays unused.
  const current = await confirmRules(env, project);
  const declaration = plan(project, randomUUID());
  await approve(store, declaration);
  await m.dashboard.revokeProjectRules(env.dataDir, { projectId: project.id, typedName: project.name, current, requestId: randomUUID() }, { caller: ownerCaller });
  refused(() => register(store, declaration), 'RULES_REVOKED');
  assert.equal(store.campaign(declaration.campaignId), null);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM local_nonces').n, 0, 'a refused registration uses no approval');

  // Expired: rules confirmed again, a new approval, but the rules' review date has passed.
  await confirmRules(env, project, current);
  const renewed = plan(project, randomUUID());
  await approve(store, renewed);
  refused(() => register(store, renewed, Date.now() + 400 * 86_400_000), 'RULES_EXPIRED');
  assert.equal(store.campaign(renewed.campaignId), null);

  // Registered while the rules hold; revoked before the first dispatch: no worker starts, the campaign waits for the owner.
  register(store, renewed);
  const rules = store.get('SELECT digest FROM project_overlays WHERE project_id = ?', project.id).digest;
  await m.dashboard.revokeProjectRules(env.dataDir, { projectId: project.id, typedName: project.name, current: rules, requestId: randomUUID() }, { caller: ownerCaller });
  const controller = new m.Controller({ store, config: env.config, dataDir: env.dataDir, fault: null, codeRevision: REVISION });
  const blocked = await runUntil(controller, store, renewed.campaignId, (c) => c.blocker?.kind === 'local-admission');
  assert.equal(blocked.blocker.code, 'RULES_REVOKED');
  assert.deepEqual(env.calls(), [], 'no worker started under revoked rules');
  assert.deepEqual(env.ghCalls(), []);
});

test('only the owner\'s approval of exactly this plan starts it, once', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, project } = setup(t);
  await confirmRules(env, project);

  // A plan file through the CLI or a program never registers a local plan.
  refused(() => { try { m.assertRegisteredTarget(plan(project, randomUUID()), GOVERNANCE); } catch (error) { throw Object.assign(error, { code: error.message.split(':')[0] }); } }, 'LOCAL_APPROVAL_REQUIRED');

  // An approval request from a program AIWorks started is refused, and nothing is recorded.
  const declaration = plan(project, randomUUID());
  const fromAiworks = { ...owner, lookup: async () => ({ pid: 5151, ancestors: [process.pid], jobs: [] }) };
  await assert.rejects(approve(store, declaration, { caller: fromAiworks }), (error) => error.code === 'APPROVAL_FROM_AIWORKS');

  // The plan changed after the owner approved it: refused. The approved plan registers once; the approval is then used.
  await approve(store, declaration);
  refused(() => register(store, { ...declaration, tasks: [{ ...declaration.tasks[0], goal: 'Add search and delete every note.' }, declaration.tasks[1]] }),
    'DECLARATION_DIFFERS_FROM_APPROVAL');
  register(store, declaration);
  refused(() => register(store, declaration), 'APPROVAL_NONCE_USED');

  // A local plan put in the store by any other path, with no admitted approval, never dispatches a worker.
  const bypass = plan(project, randomUUID(), { campaignId: 'local-bypass', goal: 'Add tags.' });
  m.campaignStart(store, bypass);
  store.run("UPDATE campaigns SET control = 'paused' WHERE id = ?", declaration.campaignId);
  const controller = new m.Controller({ store, config: env.config, dataDir: env.dataDir, fault: null, codeRevision: REVISION });
  const blocked = await runUntil(controller, store, bypass.campaignId, (c) => c.blocker?.kind === 'local-admission');
  assert.equal(blocked.blocker.code, 'APPROVAL_NOT_FOUND');
  assert.deepEqual(env.calls(), []);
  assert.deepEqual(env.ghCalls(), []);
});
