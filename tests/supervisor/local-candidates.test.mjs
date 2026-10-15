// Local projects get verified candidates, never a fake PR (docs/design/WORK_ENVELOPE.md slice E10; plan STA14). A verified
// task of a project without GitHub is recorded in the local ledger as { sha, verifier evidence, baseline }; nothing is
// pushed, no pull request is opened, gh is never called, and status shows Ready for your review. Inert: a local target
// still cannot be registered (LOCAL_START_OFF), so the tests place the campaign in the store as local admission (STA17)
// would. Disposable stores and git repositories, the synthetic gh; no worker runs, so no Windows containment is needed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { join } from 'node:path';
import { validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { declaration, environment, runUntil, SQLITE } from './helpers.mjs';
import { CANDIDATE_READY, candidates, candidateStatus, isLocalTarget, recordCandidate } from '../../src/supervisor/local-candidates.mjs';
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const { campaignStart, campaignStatus } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const needsSqlite = SQLITE ? false : 'node:sqlite requires Node >= 22.5';

const CAMPAIGN = 'local-candidates';
const BASELINE_COMMIT = 'b'.repeat(40);
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const verification = (sha) => ({ verdict: 'accepted', summary: `Independent verification of ${sha}.`,
  checks: [{ command: 'npm run check', result: 'pass', detail: '# fail 0' }], findings: [] });

/** A version 2 plan for a plain folder (WORK_ENVELOPE 4.1, local target): no repository, base branch or issues. */
function localPlan({ source = 'folder' } = {}) {
  const v1 = declaration({ campaignId: CAMPAIGN, tasks: [
    { id: 'T1', title: 'search', deliverable: 'commit', goal: 'Add search.', dependsOn: [], acceptance: ['search works'], references: ['AGENTS.md'], writes: ['src/'] },
    { id: 'T2', title: 'notes', deliverable: 'report', goal: 'Report on search.', dependsOn: [], acceptance: ['report exists'], references: ['AGENTS.md'] },
  ] });
  return { ...v1, version: 2,
    authorization: { ...v1.authorization, reference: 'aiworks-local:approval-1' },
    target: { tenantId: 'example-org', projectId: 'lp-sampleapp', environment: 'research', source, baseline: { seq: 1, commit: BASELINE_COMMIT } },
    envelope: { scopeVersion: 1, request: { route: 'goal', pinned: { base: BASELINE_COMMIT } }, outcome: 'People can search their notes.',
      acceptance: ['Searching a word finds the note'], writes: ['src/'], denyWrites: [], deliverables: ['commit', 'report'], issues: [],
      web: null, release: { mode: 'review-only' }, planning: 'fixed' } };
}

/** The store as local admission would leave it once both tasks are verified: the commit at `sha`, the report at the baseline. */
function setup(t, { decl = localPlan() } = {}) {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const sha = git(env.repo, 'rev-parse', 'HEAD');
  const now = Date.now();
  store.insert('campaigns', { id: decl.campaignId, controller_id: `aiworks-supervisor/${decl.campaignId}`, scope_digest: 'c'.repeat(64),
    authorization_version: 1, declaration: decl, control: 'registered', status: 'active', next_action: null, next_wakeup_at: null,
    blocker: null, version: 1, created_at: now, updated_at: now });
  store.insert('tasks', { campaign_id: decl.campaignId, task_id: 'T1', ord: 0, state: 'verified', base_sha: BASELINE_COMMIT, head_sha: sha,
    verified_sha: sha, verification: verification(sha), result: { summary: 'Search added.' }, version: 1, updated_at: now });
  store.insert('tasks', { campaign_id: decl.campaignId, task_id: 'T2', ord: 1, state: 'verified', base_sha: BASELINE_COMMIT, head_sha: BASELINE_COMMIT,
    verified_sha: BASELINE_COMMIT, verification: verification(BASELINE_COMMIT), result: { report: 'Search covers titles and bodies.' }, version: 1, updated_at: now });
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  return { env, store, controller, sha };
}

test('a local target is still refused at registration (LOCAL_START_OFF): the ledger stays inert', { skip: needsSqlite }, (t) => {
  assert.throws(() => validateDeclaration(localPlan()), /LOCAL_START_OFF/);
  assert.throws(() => validateDeclaration(localPlan({ source: 'local-git' })), /LOCAL_START_OFF/);
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  assert.throws(() => campaignStart(store, localPlan()), /LOCAL_START_OFF/);
  assert.equal(store.campaign(CAMPAIGN), null, 'nothing registered');
  assert.deepEqual(candidates(store, CAMPAIGN), [], 'a store that never recorded a candidate has none');
  assert.equal(isLocalTarget(localPlan()), true);
  assert.equal(isLocalTarget(localPlan({ source: 'local-git' })), true);
  assert.equal(isLocalTarget(declaration()), false, 'a GitHub project keeps the publish path');
});

test('a verified local task records { sha, verifier evidence, baseline }; nothing is pushed and gh is never called', { skip: needsSqlite }, async (t) => {
  const { env, store, controller, sha } = setup(t);
  await runUntil(controller, store, CAMPAIGN, (c) => c.control === 'finished');
  assert.deepEqual(env.ghCalls(), [], 'gh is never called for a local project');
  assert.deepEqual(env.prs(), [], 'no pull request');
  assert.deepEqual(env.comments(), [], 'no issue comment');
  for (const id of ['T1', 'T2']) assert.equal(env.remoteHead(`campaign/${CAMPAIGN}/${id}`), null, `pushVerified never ran for ${id}`);
  assert.deepEqual(store.all('SELECT key FROM outbox WHERE campaign_id = ?', CAMPAIGN), [], 'nothing is queued for GitHub');

  const [commit, report] = candidates(store, CAMPAIGN);
  assert.equal(commit.taskId, 'T1');
  assert.equal(commit.seq, 1);
  assert.equal(commit.sha, sha);
  assert.deepEqual(commit.verification, verification(sha));
  assert.deepEqual(commit.baseline, { seq: 1, commit: BASELINE_COMMIT });
  assert.equal(commit.projectId, 'lp-sampleapp');
  assert.equal(commit.source, 'folder');
  assert.equal(commit.report, null);
  assert.equal(report.taskId, 'T2');
  assert.equal(report.report, 'Search covers titles and bodies.', 'a report goes to the ledger, not to an issue');
  assert.deepEqual(report.verification, verification(BASELINE_COMMIT));

  for (const id of ['T1', 'T2']) {
    const task = store.task(CAMPAIGN, id);
    assert.equal(task.state, 'done');
    assert.equal(task.pr_url, null, 'never a fake PR');
  }
  const journal = store.all("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'candidate-recorded' ORDER BY seq", CAMPAIGN).map((row) => row.detail);
  assert.deepEqual(journal.map((d) => [d.task, d.sha, d.seq]), [['T1', sha, 1], ['T2', BASELINE_COMMIT, 1]]);
  assert.equal(store.all("SELECT 1 FROM journal WHERE campaign_id = ? AND kind = 'published'", CAMPAIGN).length, 0);
});

test('status shows Ready for your review at the verified revision, with no PR', { skip: needsSqlite }, async (t) => {
  const { store, controller, sha } = setup(t);
  await runUntil(controller, store, CAMPAIGN, (c) => c.control === 'finished');
  const status = campaignStatus(store, CAMPAIGN);
  const task = status.tasks.find((item) => item.id === 'T1');
  assert.equal(task.prUrl, null);
  assert.equal(task.candidate.code, 'CANDIDATE_READY');
  assert.equal(task.candidate.state, 'Ready for your review');
  assert.equal(task.candidate.copy, `Verified at ${sha.slice(0, 7)}. It's not applied to your folder.`);
  assert.equal(task.candidate.action, 'Review result');
  assert.equal(task.candidate.sha, sha);
  assert.deepEqual(task.candidate.baseline, { seq: 1, commit: BASELINE_COMMIT });
  assert.deepEqual(candidateStatus(store, CAMPAIGN, 'T1'), task.candidate);
  assert.equal(CANDIDATE_READY.state, 'Ready for your review');
});

test('a GitHub campaign\'s status has no candidate field', { skip: needsSqlite }, (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const decl = declaration();
  campaignStart(store, decl);
  for (const task of campaignStatus(store, decl.campaignId).tasks) assert.equal(Object.hasOwn(task, 'candidate'), false);
});

test('the ledger is append-only and idempotent: the same revision once, a new revision as the next seq', { skip: needsSqlite }, (t) => {
  const { store } = setup(t);
  const decl = store.campaign(CAMPAIGN).declaration;
  const task = store.task(CAMPAIGN, 'T1');
  const first = store.tx(() => recordCandidate(store, { declaration: decl, task, deliverable: 'commit', now: 1 }));
  assert.equal(first.recorded, true);
  const again = store.tx(() => recordCandidate(store, { declaration: decl, task, deliverable: 'commit', now: 2 }));
  assert.equal(again.recorded, false, 'a retry after a crash records nothing new');
  assert.equal(again.seq, first.seq);
  const repaired = store.tx(() => recordCandidate(store, { declaration: decl, task: { ...task, verified_sha: 'd'.repeat(40) }, deliverable: 'commit', now: 3 }));
  assert.equal(repaired.seq, 2, 'a newly verified revision is a new candidate version');
  assert.deepEqual(candidates(store, CAMPAIGN, 'T1').map((c) => [c.seq, c.sha]), [[1, task.verified_sha], [2, 'd'.repeat(40)]]);
  assert.equal(candidateStatus(store, CAMPAIGN, 'T1').sha, 'd'.repeat(40), 'status shows the newest candidate');
});

test('recordCandidate refuses a GitHub project and a candidate without evidence', { skip: needsSqlite }, (t) => {
  const { store } = setup(t);
  const decl = store.campaign(CAMPAIGN).declaration;
  const task = store.task(CAMPAIGN, 'T1');
  assert.throws(() => recordCandidate(store, { declaration: declaration(), task, deliverable: 'commit', now: 1 }), /not a local project/);
  assert.throws(() => recordCandidate(store, { declaration: decl, task: { ...task, verified_sha: null }, deliverable: 'commit', now: 1 }), /no verified revision/);
  assert.throws(() => recordCandidate(store, { declaration: decl, task: { ...task, verification: null }, deliverable: 'commit', now: 1 }), /no verifier evidence/);
  const noBaseline = { ...decl, target: { ...decl.target, baseline: undefined } };
  assert.throws(() => recordCandidate(store, { declaration: noBaseline, task, deliverable: 'commit', now: 1 }), /no project baseline/);
  assert.deepEqual(candidates(store, CAMPAIGN), []);
});
