// OWNER_UI_V2 WP5: standing project settings. Protected areas hold every new or re-authorized plan and every commit, and
// removing one never loosens work registered under it; a project budget stops paid work before it starts, counts a run
// with no reported cost at the declared price (never zero), and no budget stays uncapped; settings cannot carry authority,
// never rewrite a registered campaign, and a stale or repeated save changes nothing. Synthetic store and repository only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { admissionBudget, campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { protectedAreasFor, saveSettings } from '../../src/supervisor/project-settings.mjs';
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
