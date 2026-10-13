// RUN1B (aiworks#42): after publication the supervisor reads the PR head's CI through REST
// (GET repos/{repo}/commits/{sha}/check-runs). A failure reopens the task as a repair round on the same branch and PR,
// carrying the failing check names, and status never shows a published head as passed while CI is red or unknown.
// The workers are played by the test through the controller's own result path (applyOutcome), as in
// integration-repair.test.mjs, so these tests need no Windows runner and run on Linux CI too. No model, network or GitHub
// call: a disposable git origin and the synthetic gh of helpers.mjs, whose check runs come from check-runs.json.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart, campaignStatus } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { branchName } from '../../src/supervisor/adapters/git.mjs';
import { ciState } from '../../src/supervisor/adapters/github.mjs';
import { declaration, environment } from './helpers.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const tryGit = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

const C = 'camp-ci';
const BRANCH = branchName(C, 'T1');
const MINUTE = 60_000;
const run = (name, conclusion) => ({ name, status: 'completed', conclusion });

/** One registered campaign with one commit task. Workers are played by hand. */
function rig(t, { ci = true, limits = {} } = {}) {
  const env = environment({ config: ci ? { ciRepair: { enabled: true } } : {} });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  campaignStart(store, declaration({ campaignId: C, limits, tasks: [{ id: 'T1', issue: 601, title: 'ci task', deliverable: 'commit',
    goal: 'Change work.txt.', dependsOn: [], acceptance: ['work.txt changed'], references: ['AGENTS.md'] }] }));
  let now = Date.now();
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, now: () => now, fault: null });
  controller.launch = async () => {}; // the test plays the worker; nothing is spawned
  const ctx = () => ({ id: C, generation: controller.held.get(C) });
  const open = (kind) => {
    const [op] = store.openOperations(C);
    assert.equal(op?.kind, kind, `expected an open ${kind} operation, found ${op?.kind ?? 'none'}`);
    return op;
  };
  const r = {
    env, store, controller, open,
    advance: (ms) => { now += ms; },
    tick: () => controller.tick(),
    /** Play the implementer: `edit` changes the worktree; the commit is reported as resolved. */
    implement(edit, { commit = true } = {}) {
      const op = open('implement');
      edit(op.workspace);
      if (commit) { git(op.workspace, 'add', '-A'); git(op.workspace, 'commit', '-qm', 'work'); }
      const headSha = git(op.workspace, 'rev-parse', 'HEAD');
      controller.applyOutcome(ctx(), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { result: 'resolved', summary: 'implemented', headSha, report: '# Report' } });
      return headSha;
    },
    /** Play the independent verifier of the exact target. */
    verify() {
      const op = open('verify');
      controller.applyOutcome(ctx(), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { verdict: 'accepted', summary: 'checked', targetSha: op.target_sha, findings: [], checks: [{ command: 'npm run check', result: 'pass' }] } });
      return op;
    },
    /** The check runs GitHub reports for each commit. */
    checkRuns: (bySha) => writeFileSync(join(env.env.FAKE_GH_STATE, 'check-runs.json'), JSON.stringify(bySha)),
    /** GitHub reports the PR's head commit; the synthetic gh learns it from the test after each push. */
    prHead: (sha) => writeFileSync(join(env.env.FAKE_GH_STATE, 'prs.json'), JSON.stringify(env.prs().map((pr) => (pr.head === BRANCH ? { ...pr, headSha: sha } : pr)))),
    ciReads: () => env.ghCalls().filter((call) => call.args.some((arg) => /\/commits\/[0-9a-f]{40}\/check-runs$/.test(arg))),
    journal: (kind) => store.all('SELECT detail FROM journal WHERE campaign_id = ? AND kind = ? ORDER BY seq', C, kind).map((row) => row.detail),
    status: () => campaignStatus(store, C, now),
  };
  return r;
}

/** Implement, verify and publish T1; returns the published head. */
async function published(r) {
  await r.tick();
  const sha = r.implement((dir) => writeFileSync(join(dir, 'work.txt'), 'first\n'));
  await r.tick();
  r.verify();
  await r.tick(); // publish
  await r.tick(); // drain the outbox notes
  assert.equal(r.store.campaign(C).control, 'finished');
  assert.equal(r.env.remoteHead(BRANCH), sha);
  r.prHead(sha);
  return sha;
}

test('a failing CI run reopens the published task as a repair round carrying the failing check names, and the verified fix goes to the same PR', async (t) => {
  const r = rig(t);
  const sha = await published(r);
  const pr = r.store.task(C, 'T1').pr_url;
  assert.equal(r.status().tasks[0].ci.state, 'unknown', 'a head whose CI was never read is unknown, not passed');
  assert.equal(r.status().ci, 'unknown');

  r.checkRuns({ [sha]: [run('check', 'failure'), run('lint', 'success')] });
  r.advance(MINUTE);
  await r.tick();

  const reads = r.ciReads();
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].args.slice(0, 4), ['api', '--include', '--method', 'GET'], 'CI is read through REST');
  assert.ok(reads[0].args.includes(`repos/example-org/sampleapp/commits/${sha}/check-runs`));
  assert.deepEqual(r.journal('ci-failed'), [{ task: 'T1', sha, checks: ['check'], url: pr, repair: true, stalled: false }]);
  assert.equal(r.status().tasks[0].ci.state, 'failure');
  assert.equal(r.status().ci, 'failure');
  assert.equal(r.store.campaign(C).control, 'registered', 'the finished campaign reopens for the repair round');
  const task = r.store.task(C, 'T1');
  assert.equal(task.state, 'implementing', 'reopened, and its repair dispatched in the same tick');
  assert.equal(task.repair_rounds, 1);
  assert.deepEqual(task.findings.map((finding) => [finding.id, finding.checks.map((check) => check.name)]), [['ci-failure', ['check']]]);

  // The repair implementer continues the published branch and is told which checks failed.
  const op = r.open('implement');
  assert.equal(op.base_sha, sha, 'the repair round starts at the verified head');
  const line = op.packet.constraints.find((item) => item.startsWith('Blocking CI finding ci-failure'));
  assert.ok(line && line.includes(sha) && line.includes('check (failure') && !line.includes('lint'), line);
  assert.match(readFileSync(join(op.run_dir, 'prompt.txt'), 'utf8'), /a CI repair: repository CI failed on the verified, published commit/);
  const fixed = r.implement((dir) => writeFileSync(join(dir, 'work.txt'), 'fixed\n'));

  // No fix reaches the PR without a fresh verification of the exact repaired head.
  await r.tick();
  const verifyOp = r.open('verify');
  assert.equal(verifyOp.target_sha, fixed);
  assert.match(readFileSync(join(verifyOp.run_dir, 'prompt.txt'), 'utf8'), new RegExp(`CI repair round: repository CI failed on the previously verified ${sha} in check\\.`));
  assert.equal(r.env.remoteHead(BRANCH), sha, 'nothing is pushed before verification');
  r.verify();
  await r.tick();
  await r.tick();

  // Same branch, same PR, fast-forward push.
  assert.equal(r.env.remoteHead(BRANCH), fixed);
  assert.equal(r.env.prs().length, 1, 'no duplicate PR');
  assert.equal(r.store.task(C, 'T1').pr_url, pr);
  assert.equal(tryGit(r.env.repo, 'merge-base', '--is-ancestor', sha, fixed).status, 0, 'the earlier verified head stays an ancestor');
  assert.deepEqual(r.journal('ci-repaired'), [{ task: 'T1', from: sha, checks: ['check'], sha: fixed, url: pr }]);
  assert.equal(r.store.task(C, 'T1').findings, null);
  assert.ok(r.env.comments().some((comment) => comment.issue === pr.split('/').pop() &&
    comment.body.includes(`ci:${fixed}`) && comment.body.includes('fast-forward')), 'the PR carries the fresh verification');
  assert.equal(r.store.campaign(C).control, 'finished');
  assert.equal(r.status().tasks[0].ci.state, 'unknown', 'the repaired head is not shown as passed before its own CI');

  // The repaired head's CI is read in turn; it passes.
  r.checkRuns({ [sha]: [run('check', 'failure')], [fixed]: [run('check', 'success'), run('lint', 'skipped')] });
  r.advance(MINUTE);
  await r.tick();
  assert.deepEqual(r.journal('ci-passed'), [{ task: 'T1', sha: fixed, checks: ['check: success', 'lint: skipped'] }]);
  assert.equal(r.status().tasks[0].ci.state, 'success');
  assert.equal(r.status().ci, 'success');
  assert.equal(r.journal('ci-failed').length, 1);
});

test('CI is read at most once a minute per published task, and not at all once it completes', async (t) => {
  const r = rig(t);
  const sha = await published(r);
  r.checkRuns({ [sha]: [{ name: 'check', status: 'in_progress', conclusion: null }] });
  const reads = () => r.ciReads().length;

  for (let i = 0; i < 3; i++) await r.tick();
  assert.equal(reads(), 0, 'no read within the first minute after publication');
  r.advance(MINUTE);
  await r.tick();
  await r.tick();
  assert.equal(reads(), 1);
  assert.deepEqual(r.journal('ci-pending'), [{ task: 'T1', sha, checks: ['check'] }]);
  assert.equal(r.status().tasks[0].ci.state, 'pending');
  assert.equal(r.status().ci, 'pending', 'running CI is not shown as passed');
  r.advance(MINUTE / 2);
  await r.tick();
  assert.equal(reads(), 1, 'half a minute later: no second read');
  r.advance(MINUTE / 2);
  await r.tick();
  assert.equal(reads(), 2);
  assert.equal(r.journal('ci-pending').length, 1, 'a still running CI is journaled once');

  r.checkRuns({ [sha]: [run('check', 'success')] });
  r.advance(MINUTE);
  await r.tick();
  assert.equal(reads(), 3);
  assert.equal(r.status().tasks[0].ci.state, 'success');
  for (let i = 0; i < 5; i++) { r.advance(MINUTE); await r.tick(); }
  assert.equal(reads(), 3, 'polling stops once CI completed');
});

test('switched off (the default), a published PR is never read for CI and status says its CI is unknown', async (t) => {
  const r = rig(t, { ci: false });
  const sha = await published(r);
  r.checkRuns({ [sha]: [run('check', 'failure')] });
  for (let i = 0; i < 3; i++) { r.advance(MINUTE); await r.tick(); }
  assert.equal(r.ciReads().length, 0);
  assert.equal(r.journal('ci-failed').length, 0);
  assert.equal(r.store.task(C, 'T1').state, 'done');
  assert.equal(r.store.campaign(C).control, 'finished');
  assert.equal(r.store.openOperations(C).length, 0);
  assert.equal(r.env.remoteHead(BRANCH), sha);
  assert.deepEqual(r.status().tasks[0].ci, { state: 'unknown', sha, checkedAt: null, checks: [] });
  assert.equal(r.status().ci, 'unknown');
});

test('a CI failure on a PR that is no longer open at that head is recorded as red but not repaired', async (t) => {
  const r = rig(t);
  const sha = await published(r);
  r.env.markMerged(BRANCH);
  r.checkRuns({ [sha]: [run('check', 'timed_out')] });
  r.advance(MINUTE);
  await r.tick();
  assert.deepEqual(r.journal('ci-failed'), [{ task: 'T1', sha, checks: ['check'], url: r.store.task(C, 'T1').pr_url, repair: false, stalled: false, reason: 'no open PR' }]);
  assert.equal(r.store.task(C, 'T1').state, 'done');
  assert.equal(r.store.campaign(C).control, 'finished');
  assert.equal(r.store.openOperations(C).length, 0, 'no worker is dispatched');
  assert.equal(r.status().ci, 'failure', 'still shown red');
  const before = r.ciReads().length;
  r.advance(MINUTE);
  await r.tick();
  assert.equal(r.ciReads().length, before, 'a settled failure is not read again');
});

test('CI repair is bounded by maxRepairRounds', async (t) => {
  const r = rig(t, { limits: { maxRepairRounds: 0 } });
  const sha = await published(r);
  r.checkRuns({ [sha]: [run('check', 'failure')] });
  r.advance(MINUTE);
  await r.tick();
  assert.equal(r.journal('ci-failed')[0].stalled, true);
  assert.match(r.store.task(C, 'T1').blocked.reason, /CI failure on [0-9a-f]{40} after 0 repair rounds/);
  assert.equal(r.store.openOperations(C).length, 0, 'no worker is dispatched past the bound');
  assert.equal(r.env.remoteHead(BRANCH), sha);
});

test('a CI repair that rewrites the verified commit is refused, and nothing is pushed', async (t) => {
  const r = rig(t);
  const sha = await published(r);
  r.checkRuns({ [sha]: [run('check', 'failure')] });
  r.advance(MINUTE);
  await r.tick();
  r.implement((dir) => {
    git(dir, 'reset', '-q', '--hard', `${sha}~1`);
    writeFileSync(join(dir, 'work.txt'), 'rewritten\n');
  });
  const task = r.store.task(C, 'T1');
  assert.equal(task.state, 'pending');
  assert.match(task.last_error, /not a descendant of base/);
  assert.equal(r.env.remoteHead(BRANCH), sha);
  assert.equal(r.journal('ci-repaired').length, 0);
});

test('a rate-limited CI read waits for the reset, and CI stays unknown meanwhile', async (t) => {
  const r = rig(t);
  const sha = await published(r);
  r.checkRuns({ [sha]: [run('check', 'success')] });
  r.env.rateLimit({ route: 'GET check-runs', times: 1, retryAfter: 120 });
  r.advance(MINUTE);
  await r.tick();
  assert.equal(r.ciReads().length, 1);
  assert.equal(r.status().tasks[0].ci.state, 'unknown');
  r.advance(MINUTE);
  await r.tick();
  assert.equal(r.ciReads().length, 1, 'no read before the reported reset');
  r.advance(MINUTE);
  await r.tick();
  assert.equal(r.ciReads().length, 2);
  assert.equal(r.status().tasks[0].ci.state, 'success');
});

test('a head with no check run is recorded as having no CI after ciNoChecksMs, and its polling stops', async (t) => {
  const r = rig(t);
  await published(r);
  r.advance(MINUTE);
  await r.tick();
  assert.equal(r.status().tasks[0].ci.state, 'pending');
  r.advance(r.controller.config.ciNoChecksMs);
  await r.tick();
  assert.equal(r.journal('ci-none').length, 1);
  assert.equal(r.status().tasks[0].ci.state, 'none');
  assert.equal(r.status().ci, 'unknown', 'no CI is not a pass');
  const before = r.ciReads().length;
  for (let i = 0; i < 3; i++) { r.advance(MINUTE); await r.tick(); }
  assert.equal(r.ciReads().length, before);
});

test('check runs are classified conservatively: only completed passing runs are success', () => {
  const body = (runs, total = runs.length) => ({ total_count: total, check_runs: runs });
  assert.equal(ciState(body([])).state, 'pending', 'no run yet');
  assert.equal(ciState(body([run('a', 'failure'), { name: 'b', status: 'queued', conclusion: null }])).state, 'pending', 'wait until every run completes');
  for (const conclusion of ['failure', 'timed_out', 'startup_failure']) assert.equal(ciState(body([run('a', 'success'), run('b', conclusion)])).state, 'failure', conclusion);
  assert.equal(ciState(body([run('a', 'success'), run('b', 'neutral'), run('c', 'skipped')])).state, 'success');
  assert.equal(ciState(body([run('a', 'success'), run('b', 'cancelled')])).state, 'inconclusive');
  assert.equal(ciState(body([run('a', 'success'), run('b', 'action_required')])).state, 'inconclusive');
  assert.equal(ciState(body([run('a', 'success')], 101)).state, 'inconclusive', 'runs beyond the page are not assumed to pass');
  assert.deepEqual(ciState(body([{ name: 'a', status: 'completed', conclusion: 'failure', html_url: 'https://example.invalid/1' }])).checks,
    [{ name: 'a', status: 'completed', conclusion: 'failure', url: 'https://example.invalid/1' }]);
  assert.throws(() => ciState({ message: 'Not Found' }), /no check_runs/);
});
