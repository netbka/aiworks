// RUN2 (ADAPTIVE_SCHEDULER slice S2): the controller stays correct when more than one operation is open, before the
// scheduler (RUN5) admits a second worker. Publication runs while a worker runs, the base comes from an explicit ref,
// a process-ownership blocker belongs to its own operation, status names every open operation, the store refuses a
// second open operation for one task, and a declared cost ceiling reserves open runs. Workers are played by the test
// through the controller's own result path (applyOutcome), so nothing is spawned and the tests run on Linux CI too.
// No model, network or GitHub call: a disposable git origin and the synthetic gh of helpers.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignBudget, campaignStart } from '../../src/supervisor/api.mjs';
import { validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { branchName } from '../../src/supervisor/adapters/git.mjs';
import { declaration, environment } from './helpers.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

const commitTask = (id, issue, extra = {}) => ({ id, issue, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`,
  dependsOn: [], acceptance: [`${id} exists`], references: ['AGENTS.md'], ...extra });

/** One registered campaign whose workers the test plays by hand; `gitCommand` replaces the git executable. */
function rig(t, { tasks, limits = {}, gitCommand = null, config = {} } = {}) {
  const env = environment();
  if (gitCommand) env.config.commands.git = gitCommand;
  Object.assign(env.config, config);
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const decl = declaration({ tasks, limits });
  campaignStart(store, decl);
  const id = decl.campaignId;
  let now = Date.now();
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, now: () => now, fault: null });
  controller.launch = async () => {}; // the test plays the worker; nothing is spawned
  const ctx = () => ({ id, generation: controller.held.get(id) });
  const openOp = (taskId, kind) => {
    const op = store.openOperations(id).find((item) => item.task_id === taskId);
    assert.equal(op?.kind, kind, `${taskId}: expected an open ${kind} operation, found ${op?.kind ?? 'none'}`);
    return op;
  };
  return {
    env, store, controller, id, ctx, openOp,
    advance: (ms) => { now += ms; },
    tick: () => controller.tick(),
    implement(taskId) {
      const op = openOp(taskId, 'implement');
      writeFileSync(join(op.workspace, `${taskId}.txt`), `${taskId}\n`);
      git(op.workspace, 'add', '-A'); git(op.workspace, 'commit', '-qm', `work for ${taskId}`);
      const headSha = git(op.workspace, 'rev-parse', 'HEAD');
      controller.applyOutcome(ctx(), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { result: 'resolved', summary: 'implemented', headSha, report: `# Report for ${taskId}` } });
      return { op, headSha };
    },
    verify(taskId) {
      const op = openOp(taskId, 'verify');
      controller.applyOutcome(ctx(), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { verdict: 'accepted', summary: 'checked', targetSha: op.target_sha, findings: [], checks: [{ command: 'npm run check', result: 'pass' }] } });
      return op;
    },
  };
}

test('a verified task publishes while another task of the same campaign runs', async (t) => {
  // The stubbed T2 worker writes no runner receipt; a long start grace keeps that from raising an ownership blocker
  // while the clock jumps past GitHub's reset.
  const r = rig(t, { tasks: [commitTask('T1', 701), commitTask('T2', 702)], config: { startGraceMs: 60 * 60_000, staleMs: 60 * 60_000 } });
  await r.tick();
  r.implement('T1');
  await r.tick();
  r.verify('T1');
  assert.equal(r.store.task(r.id, 'T1').state, 'verified');
  // GitHub refuses the first publication for two minutes: T1 stays verified, and T2's worker starts meanwhile.
  r.env.rateLimit({ route: 'GET pulls', times: 1, retryAfter: 120 });
  await r.tick();
  assert.equal(r.store.task(r.id, 'T1').state, 'verified', 'the refused publication left T1 verified');
  await r.tick();
  const running = r.openOp('T2', 'implement');

  r.advance(200_000); // past the reset (computed from the real clock) and its margin
  await r.tick();
  const published = r.store.task(r.id, 'T1');
  assert.equal(published.state, 'done', 'T1 published although T2 is still running');
  assert.match(published.pr_url ?? '', /\/pull\/\d+$/);
  assert.equal(r.store.openOperations(r.id).map((op) => op.id).join(), running.id, 'T2 keeps running, untouched');
  assert.equal(r.env.prs().filter((pr) => pr.head === branchName(r.id, 'T1')).length, 1, 'exactly one PR for T1');
});

test('a base is read from its own ref, never from FETCH_HEAD that another fetch overwrote', async (t) => {
  // A git wrapper that, after every fetch, fetches a decoy branch as a concurrent fetch in the same checkout would:
  // that leaves FETCH_HEAD at the decoy's tip.
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-git-wrapper-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wrapper = join(dir, 'git-with-concurrent-fetch.mjs');
  writeFileSync(wrapper, [
    "import { spawnSync } from 'node:child_process';",
    'const args = process.argv.slice(2);',
    "const run = (a) => spawnSync('git', a, { stdio: 'inherit', windowsHide: true });",
    'const result = run(args);',
    "if (args[0] === 'fetch' && !args.includes('decoy')) run(['fetch', '-q', 'origin', 'decoy']);",
    'process.exit(result.status ?? 1);',
  ].join('\n'));
  const r = rig(t, {
    tasks: [commitTask('T1', 711), commitTask('T2', 712, { dependsOn: ['T1'], requiresMergedDependencies: true })],
    gitCommand: [process.execPath, wrapper],
  });
  const { repo } = r.env;
  // The decoy branch is an unrelated line of work that never contains T1.
  git(repo, 'checkout', '-q', '-b', 'decoy');
  writeFileSync(join(repo, 'decoy.txt'), 'decoy\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'decoy'); git(repo, 'push', '-q', 'origin', 'decoy');
  git(repo, 'checkout', '-q', 'main');

  await r.tick();
  const { headSha } = r.implement('T1');
  await r.tick();
  r.verify('T1');
  await r.tick(); // publish T1
  assert.equal(r.store.task(r.id, 'T1').state, 'done');
  // The owner merges T1's PR with a merge commit.
  git(repo, 'fetch', '-q', 'origin', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge T1', headSha);
  const merged = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', '-q', 'origin', 'main');
  r.env.markMerged(branchName(r.id, 'T1'), merged);

  r.advance(r.controller.config.integrationPollMs + 1);
  await r.tick();
  await r.tick();
  const op = r.openOp('T2', 'implement');
  assert.equal(op.base_sha, merged, 'T2 starts from main with T1 merged, not from the decoy FETCH_HEAD');
  assert.equal(git(op.workspace, 'rev-parse', 'HEAD'), merged);
});

test('a process-ownership blocker is cleared only by the operation it names', async (t) => {
  const r = rig(t, { tasks: [commitTask('T1', 721)] });
  await r.tick();
  const block = (operation) => {
    const c = r.store.campaign(r.id);
    r.store.patch('campaigns', { id: r.id }, c.version, { blocker: { kind: 'process-ownership', class: 'B4', operation,
      reason: `process ownership is unresolved for ${operation}`, requestedAction: 'reconcile', at: Date.now() } }, Date.now());
  };
  block('another-operation');
  r.implement('T1');
  assert.equal(r.store.campaign(r.id).blocker?.operation, 'another-operation', 'a different operation finishing proves nothing about it');

  const c = r.store.campaign(r.id);
  r.store.patch('campaigns', { id: r.id }, c.version, { blocker: null }, Date.now());
  await r.tick();
  const verify = r.openOp('T1', 'verify');
  block(verify.id);
  r.verify('T1');
  assert.equal(r.store.campaign(r.id).blocker, null, 'its own operation settling clears it');
});

/** An open operation row as dispatch records it, for a task the one-slot controller would not start yet. */
const openRow = (store, campaignId, taskId, kind, seq = 1) => {
  const now = Date.now(), id = `${campaignId}.${taskId}.${kind}.${seq}`;
  store.run(`INSERT INTO operations (id, campaign_id, task_id, kind, seq, idempotency_key, lease_generation, state, session_id,
    run_dir, workspace, packet, packet_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'dispatched', ?, ?, ?, '{}', 'digest', ?, ?)`,
  id, campaignId, taskId, kind, seq, id, `session-${taskId}-${seq}`, `run-${id}`, `ws-${id}`, now, now);
  return id;
};

test('status names every open operation and reads verifying only while all of them verify', async (t) => {
  const r = rig(t, { tasks: [commitTask('T1', 731), commitTask('T2', 732)] });
  await r.tick();
  const first = r.openOp('T1', 'implement');
  const second = openRow(r.store, r.id, 'T2', 'verify');
  r.controller.refreshStatus(r.ctx());
  let c = r.store.campaign(r.id);
  assert.equal(c.status, 'active', 'one implementer still runs');
  assert.match(c.next_action, new RegExp(`operation ${first.id}`));
  assert.match(c.next_action, new RegExp(`operation ${second}`));

  r.implement('T1');
  r.controller.refreshStatus(r.ctx());
  c = r.store.campaign(r.id);
  assert.equal(c.status, 'verifying', 'the only open operation verifies');
  assert.match(c.next_action, /^verify T2 running/);
});

test('the store refuses a second open operation for one task', async (t) => {
  const r = rig(t, { tasks: [commitTask('T1', 741)] });
  await r.tick();
  r.openOp('T1', 'implement');
  assert.throws(() => openRow(r.store, r.id, 'T1', 'verify', 2), /UNIQUE constraint failed/);
  // A finished operation does not count: the next attempt of the same task is admitted.
  r.implement('T1');
  assert.doesNotThrow(() => openRow(r.store, r.id, 'T1', 'verify', 2));
});

test('a declared cost ceiling reserves every open run at the unknown-run price', () => {
  const d = declaration();
  const ceiling = validateDeclaration({ ...d, limits: { ...d.limits, maxCostUsd: 10, unknownRunCostUsd: 3 } });
  const fake = (finished, open) => ({ all: () => finished, openOperations: () => open });
  const campaign = { id: 'c', cost_usd: 4, runs_used: 3, declaration: ceiling };
  const measured = { outcome: { class: 'result', receipt: { costUsd: 4 } } };
  const unknown = { outcome: { class: 'result', receipt: { costUsd: null } } };
  assert.equal(campaignBudget(fake([measured, unknown], []), campaign).exhausted, null, '4 + 3 < 10');
  const reserving = campaignBudget(fake([measured, unknown], [{ id: 'open-1' }]), campaign);
  assert.equal(reserving.reservedRuns, 1);
  assert.equal(reserving.chargedCostUsd, 10, '4 measured + 3 unknown + 3 reserved');
  assert.match(reserving.exhausted, /cost ceiling reached .*1 open run/);
  const noCeiling = { ...campaign, declaration: { ...ceiling, limits: { maxWorkerRuns: null } } };
  const free = campaignBudget(fake([], [{ id: 'open-1' }, { id: 'open-2' }]), noCeiling);
  assert.deepEqual([free.reservedRuns, free.chargedCostUsd, free.exhausted], [0, null, null], 'nothing is reserved without a declared ceiling');
});
