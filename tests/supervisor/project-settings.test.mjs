// OWNER_UI_V2 WP5: standing project settings. Protected areas hold every new or re-authorized plan and every commit, and
// removing one never loosens work registered under it; a project budget stops paid work before it starts, counts a run
// with no reported cost at the declared price (never zero), and no budget stays uncapped; settings cannot carry authority,
// never rewrite a registered campaign, and a stale or repeated save changes nothing. Planning reads share the budget of
// their project, never another's, and an uncovered read never starts. Synthetic store and repository only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { admissionBudget, campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { coordinatorTick, postOwnerMessage } from '../../src/supervisor/coordinator.mjs';
import { intakeState } from '../../src/supervisor/intake.mjs';
import { monthStart, projectBudget, protectedAreasFor, saveSettings, unallocatedPlanning } from '../../src/supervisor/project-settings.mjs';
import { createProject } from '../../src/supervisor/projects.mjs';
import { declaration, environment } from './helpers.mjs';

const PROJECT = 'example-org/sampleapp';
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const task = (id, issue, extra = {}) => ({ id, issue, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`,
  dependsOn: [], acceptance: [`${id} exists`], references: ['AGENTS.md'], ...extra });
let requests = 0;
const settings = (store, version, value, now = Date.now()) =>
  saveSettings(store, { project: PROJECT, expectedVersion: version, requestId: `request-${++requests}`, settings: value }, now);

function rig(t) {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  controller.launch = async () => {};
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  return { env, store, controller };
}

test('protected areas refuse new and re-authorized plans and hold every commit; removing one never loosens registered work', async (t) => {
  const { store, controller } = rig(t);
  settings(store, 0, { protectedAreas: ['docs/legal'] }, Date.now() - 1000);
  const inside = declaration({ campaignId: 'inside', tasks: [task('T1', 930, { writes: ['Docs/Legal/terms.md'] })] });
  assert.throws(() => campaignStart(store, inside), (error) => error.code === 'PROTECTED_AREA');
  assert.equal(store.campaign('inside'), null, 'nothing registered');

  const d = declaration({ campaignId: 'whole', tasks: [task('T1', 931)] });
  campaignStart(store, d);
  const registered = store.campaign('whole');
  // A stale or new approval that reaches into the area is refused; resuming the same declaration is not a new authorization.
  const widened = { ...declaration({ campaignId: 'whole', version: 2, tasks: [task('T1', 931, { writes: ['docs/legal/'] })] }) };
  assert.throws(() => campaignStart(store, widened), (error) => error.code === 'PROTECTED_AREA');
  campaignStart(store, d);
  // Saving settings never rewrites the campaign's authority; removing the area keeps it binding for this campaign.
  settings(store, 1, { protectedAreas: [] });
  const after = store.campaign('whole');
  assert.deepEqual([after.authorization_version, after.scope_digest, after.declaration], [registered.authorization_version, registered.scope_digest, registered.declaration]);
  assert.deepEqual(protectedAreasFor(store, after), ['docs/legal']);

  await controller.tick();
  const op = store.openOperations('whole')[0];
  for (const file of ['src/ok.txt', 'docs/legal/terms.md']) { mkdirSync(join(op.workspace, file, '..'), { recursive: true }); writeFileSync(join(op.workspace, file), `${file}\n`); }
  git(op.workspace, 'add', '-A'); git(op.workspace, 'commit', '-qm', 'work');
  controller.applyOutcome({ id: 'whole', generation: controller.held.get('whole') }, op, { class: 'result', receipt: { sessionId: op.session_id },
    value: { result: 'resolved', summary: 'done', headSha: git(op.workspace, 'rev-parse', 'HEAD'), report: '# r' } });
  const held = store.task('whole', 'T1');
  assert.equal(held.blocked?.class, 'B3', 'a commit inside a protected area is held for the owner');
  assert.match(held.blocked.reason, /protected areas \(docs\/legal\): docs\/legal\/terms\.md$/);
});

/** One finished or open worker run of a campaign, with its reported cost (null: not reported). */
function run(store, campaignId, n, { costUsd = null, open = false, at = Date.now() } = {}) {
  store.run(`INSERT INTO operations (id, campaign_id, task_id, kind, seq, idempotency_key, lease_generation, state, session_id, run_dir, workspace,
    packet, packet_digest, outcome, created_at, updated_at) VALUES (?, ?, 'T1', 'implement', ?, ?, 1, ?, 's', 'r', 'w', '{}', 'd', ?, ?, ?)`,
  `${campaignId}-${n}`, campaignId, n, `${campaignId}-${n}`, open ? 'dispatched' : 'finished',
  open ? null : JSON.stringify({ class: 'result', receipt: { costUsd } }), at, at);
}

test('a project budget stops paid work before it starts, counts unreported cost at the declared price, and no budget stays uncapped', async (t) => {
  const { store, controller } = rig(t);
  const limits = { maxWorkerRuns: null };
  campaignStart(store, declaration({ campaignId: 'one', limits, tasks: [task('T1', 940)] }));
  campaignStart(store, declaration({ campaignId: 'two', limits, tasks: [task('T1', 941)] }));
  run(store, 'one', 1, { costUsd: 4 });
  run(store, 'two', 1);
  const budget = (id) => admissionBudget(store, store.campaign(id));
  assert.equal(budget('two').exhausted, null, 'no budget: uncapped');
  assert.equal(budget('two').project.total, null, 'nothing is shown as $0 when nothing was counted');

  settings(store, 0, { budget: { totalUsd: 10, unknownRunCostUsd: 3 } });
  assert.equal(budget('two').project.total.chargedUsd, 7, 'reported $4 plus the unreported run at $3, never $0');
  assert.equal(budget('two').exhausted, null, '$3 left covers one more run');
  run(store, 'one', 2, { open: true });
  assert.match(budget('two').exhausted, /^project budget reached/, 'a running step of another goal is reserved at the declared price');

  // This month only: runs of an earlier month do not count against the monthly budget.
  const lastMonth = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) - 86_400_000;
  store.run('UPDATE operations SET created_at = ?', lastMonth);
  settings(store, 1, { budget: { monthlyUsd: 5, unknownRunCostUsd: 3 } });
  assert.equal(budget('two').project.month.chargedUsd, 0);
  run(store, 'two', 2);
  assert.match(budget('two').exhausted, /^monthly project budget reached/, '$3 counted this month leaves less than one run');

  // Admission: no worker starts, and the owner is asked; a budget the owner removes lets the work continue by itself.
  store.run("UPDATE operations SET state = 'finished', outcome = ? WHERE state = 'dispatched'", JSON.stringify({ class: 'result', receipt: { costUsd: 1 } }));
  const recorded = () => store.get("SELECT COUNT(*) AS n FROM operations WHERE campaign_id = 'two'").n;
  const before = recorded();
  await controller.tick();
  assert.equal(recorded(), before, 'nothing paid was started');
  assert.equal(store.campaign('two').blocker?.kind, 'budget');
  settings(store, 2, {});
  await controller.tick();
  await controller.tick();
  assert.equal(store.campaign('two').blocker, null);
  assert.ok(recorded() > before, 'work continues once the budget allows it');
});

test('planning and implementation share a capped project budget: no uncovered read starts, across retries, a restart and months', async (t) => {
  const { env, store, controller } = rig(t);
  const now = Date.now(), lastMonth = monthStart(now) - 86_400_000;
  campaignStart(store, declaration({ campaignId: 'one', limits: { maxWorkerRuns: null }, tasks: [task('T1', 950)] }));
  createProject(store, { id: 'sample', tenant_id: 'example', name: 'Sample app', source_kind: 'github', root_path: join(env.tmp, 'sample'), github_repository: PROJECT, base_branch: 'main' }, now);
  createProject(store, { id: 'other', tenant_id: 'example', name: 'Other app', source_kind: 'folder', root_path: join(env.tmp, 'other') }, now);
  const ask = (requestId, projectId, state = 'received') => store.run(`INSERT INTO work_requests (request_id, project_id, route, text, plan_only, state, received_at, updated_at)
    VALUES (?, ?, 'note', 'Plan a page.', 0, ?, ?, ?)`, requestId, projectId, state, now, now);
  const planned = (id, { requestId = null, messageIds = [], state = 'failed', cls = 'error', costUsd = null, at = now } = {}) => store.insert('coordinator_runs', { id, state,
    session_id: 's', run_dir: 'r', workspace: 'w', message_ids: messageIds, outcome: ['failed', 'answered'].includes(state) ? { class: cls, requestId } : null, cost_usd: costUsd, created_at: at, updated_at: at });
  const request = (id) => store.get('SELECT * FROM work_requests WHERE request_id = ?', id);
  const runs = () => store.get('SELECT COUNT(*) AS n FROM coordinator_runs').n;

  settings(store, 0, { budget: { totalUsd: 10, unknownRunCostUsd: 3 } });
  run(store, 'one', 1, { costUsd: 2 });
  ask('req-a', 'sample');
  planned('intake.0', { requestId: 'req-a', cls: 'spawn-failed' }); // never started: costs nothing
  planned('intake.1', { requestId: 'req-a' }); // first draft, cost not reported
  planned('intake.2', { state: 'dispatched' }); // its retry, still open
  store.run("UPDATE work_requests SET state = 'drafting', run_id = 'intake.2' WHERE request_id = 'req-a'");
  ask('req-b', 'other', 'drafted');
  planned('intake.3', { requestId: 'req-b', state: 'answered', cls: 'result', costUsd: 5 });
  const { id: unnamed } = postOwnerMessage(store, { text: 'Plan the next wave.', requestId: '00000000-0000-4000-8000-000000000001' });
  store.run("UPDATE owner_messages SET state = 'answered' WHERE id = ?", unnamed);
  planned('coordinator.4', { messageIds: [unnamed], state: 'answered', cls: 'result', costUsd: 1 });

  const spend = admissionBudget(store, store.campaign('one'), now);
  assert.equal(spend.project.total.chargedUsd, 8, '$2 implementation plus the unreported and the open planning run at $3 each');
  assert.deepEqual(spend.project.total.planning, { reportedUsd: 0, unknownCostRuns: 1, openRuns: 1 });
  assert.match(spend.exhausted, /^project budget reached/, 'planning leaves less than one run: no implementation step starts');
  assert.deepEqual(projectBudget(store, 'lp-other', now, { detail: true }).total.planning, { reportedUsd: 5, unknownCostRuns: 0, openRuns: 0 }, 'another project pays its own planning');
  assert.deepEqual(unallocatedPlanning(store, now).total, { reportedUsd: 1, unknownCostRuns: 0, openRuns: 0 }, 'a message naming no project is charged to none');

  // The retry settles without a reported cost; a new request of the capped project waits, the uncapped project still plans.
  store.run("UPDATE coordinator_runs SET state = 'failed', outcome = ? WHERE id = 'intake.2'", JSON.stringify({ class: 'error', requestId: 'req-a' }));
  store.run("UPDATE work_requests SET state = 'received', failure = 'error' WHERE request_id = 'req-a'");
  ask('req-c', 'sample');
  ask('req-d', 'other');
  controller.config.coordinator = { repositories: [PROJECT], intake: true, worktreeRoot: join(env.tmp, 'planning') };
  const before = runs();
  await coordinatorTick(controller);
  controller.release();
  const restarted = new Controller({ store, config: controller.config, dataDir: env.dataDir, fault: null });
  await coordinatorTick(restarted);
  assert.equal(runs(), before, 'no planning read is recorded for the capped project, before or after a restart');
  for (const id of ['req-a', 'req-c']) {
    assert.equal(request(id).state, 'received');
    assert.match(intakeState(request(id), null).budgetWait, /^project budget reached/);
  }
  assert.equal(request('req-d').failure, 'BASE_UNKNOWN', 'the uncapped project was not held up: its request went on to pinning');

  // Months: last month's runs do not count against a monthly budget, this month's planning does.
  store.run('UPDATE coordinator_runs SET created_at = ?', lastMonth);
  store.run('UPDATE operations SET created_at = ?', lastMonth);
  settings(store, 1, { budget: { monthlyUsd: 5, unknownRunCostUsd: 3 } });
  assert.equal(projectBudget(store, PROJECT, now).exhausted, null);
  planned('intake.5', { requestId: 'req-a' });
  assert.match(projectBudget(store, PROJECT, now).exhausted, /^monthly project budget reached/);
  // Without a budget the project is uncapped again, and the held request is read by itself.
  settings(store, 2, {});
  await coordinatorTick(restarted);
  assert.doesNotMatch(request('req-a').failure ?? '', /^project-budget/);
  assert.equal(store.all('SELECT kind FROM journal WHERE kind = ?', 'planning-budget-cleared').length, 1);
  restarted.release();
});

test('settings carry no authority, and a stale, repeated or edited save changes nothing', (t) => {
  const { store } = rig(t);
  for (const [value, code] of [[{ release: { mode: 'auto' } }, 'SETTINGS_FIELD'], [{ writes: ['src/'] }, 'SETTINGS_FIELD'],
    [{ budget: { totalUsd: 10 } }, 'SETTINGS_UNKNOWN_COST'], [{ budget: { maxWorkerRuns: 5 } }, 'SETTINGS_FIELD'],
    [{ protectedAreas: ['../outside'] }, 'SETTINGS_PROTECTED']]) {
    assert.throws(() => settings(store, 0, value), (error) => error.code === code, code);
  }
  const first = saveSettings(store, { project: PROJECT, expectedVersion: 0, requestId: 'same-request', settings: { notes: 'Prefer small steps.' } }, 1);
  const again = saveSettings(store, { project: PROJECT, expectedVersion: 0, requestId: 'same-request', settings: { notes: 'Prefer small steps.' } }, 2);
  assert.deepEqual([first.version, again.version, again.duplicate], [1, 1, true]);
  assert.throws(() => saveSettings(store, { project: PROJECT, expectedVersion: 1, requestId: 'same-request', settings: { notes: 'Other.' } }, 3),
    (error) => error.code === 'SETTINGS_REQUEST_REUSED');
  assert.throws(() => settings(store, 0, { notes: 'From a stale page.' }), (error) => error.code === 'SETTINGS_CHANGED');
  assert.throws(() => store.run("UPDATE project_settings SET settings = '{}'"), /append-only/);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM project_settings').n, 1);
});
