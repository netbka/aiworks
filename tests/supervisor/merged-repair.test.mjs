// MERGED-REPAIR (aiworks#207): an integration repair round ends when its pull request was merged by someone else. Two
// campaigns publish sibling PRs that change one line; A merges, so B becomes a repair round; then B's PR is merged out of
// band while the round is open. Workers are played by the test through the controller's own result path (applyOutcome),
// so these tests need no Windows runner and run on Linux too. No model, network or GitHub call: a disposable git origin
// and the synthetic gh of helpers.mjs (fixtures/fake-gh.mjs), which logs every call and refuses a merge call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { branchName } from '../../src/supervisor/adapters/git.mjs';
import { declaration, environment, passedGate } from './helpers.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const tryGit = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

const task = (id, issue, title) => ({ id, issue, title, deliverable: 'commit', goal: `Change shared.txt for ${title}.`,
  dependsOn: [], acceptance: ['shared.txt changed'], references: ['AGENTS.md'] });
const A = 'camp-a', B = 'camp-b';
const RESOLVED = 'line one\nshared line from A\nshared line from B\nline three\n';

/** Two registered campaigns over a base that holds shared.txt, integration repair on. Workers are played by hand. */
function rig(t) {
  const env = environment({ config: { integrationRepair: { enabled: true } } });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { r.controller.release(); store.close(); env.cleanup(); });
  writeFileSync(join(env.repo, 'shared.txt'), 'line one\nshared line\nline three\n');
  git(env.repo, 'add', '-A'); git(env.repo, 'commit', '-qm', 'shared file'); git(env.repo, 'push', '-q', 'origin', 'main');
  campaignStart(store, declaration({ campaignId: A, tasks: [task('A1', 501, 'sibling A')] }));
  campaignStart(store, declaration({ campaignId: B, tasks: [task('B1', 502, 'sibling B')] }));
  let now = Date.now();
  const ctx = (id) => ({ id, generation: r.controller.held.get(id) });
  const open = (id, kind) => {
    const [op] = store.openOperations(id);
    assert.equal(op?.kind, kind, `${id}: expected an open ${kind} operation, found ${op?.kind ?? 'none'}`);
    return op;
  };
  const prsFile = join(env.env.FAKE_GH_STATE, 'prs.json');
  const r = {
    env, store, controller: null,
    /** A new controller, as after a restart: the previous one releases its leases. */
    start() {
      r.controller?.release();
      r.controller = new Controller({ store, config: env.config, dataDir: env.dataDir, now: () => now, fault: null });
      r.controller.launch = async () => {}; // the test plays the worker; nothing is spawned
    },
    /** Past the integration poll and every retry backoff. */
    advance: () => { now += Math.max(r.controller.config.integrationPollMs, ...r.controller.config.retryBackoffMs) + 1; },
    tick: () => r.controller.tick(),
    open,
    implement(id, edit, { commit = true } = {}) {
      const op = open(id, 'implement');
      edit(op.workspace);
      if (commit) { git(op.workspace, 'add', '-A'); git(op.workspace, 'commit', '-qm', `work for ${id}`); }
      const headSha = git(op.workspace, 'rev-parse', 'HEAD');
      r.controller.applyOutcome(ctx(id), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { result: 'resolved', summary: 'implemented', headSha, report: `# Report for ${id}` } });
      return headSha;
    },
    /** The repair implementer cannot finish, as with the load-sensitive gate failures of aiworks#207. */
    unavailable(id) {
      const op = open(id, 'implement');
      r.controller.applyOutcome(ctx(id), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { result: 'evidence-unavailable', summary: 'the full gate failed under load', tried: 'npm run check' } });
    },
    verify(id) {
      const op = open(id, 'verify');
      passedGate(op.workspace); // the verifier's full gate, as the gate helper leaves it
      r.controller.applyOutcome(ctx(id), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { verdict: 'accepted', summary: 'checked', targetSha: op.target_sha, findings: [], checks: [{ command: 'npm run check', result: 'pass' }] } });
    },
    /** The owner merges into main outside the supervisor: `build` makes the new main in a detached checkout of it. */
    ownerMerge(build) {
      git(env.repo, 'fetch', '-q', 'origin', 'main');
      git(env.repo, 'checkout', '-q', '--detach', 'FETCH_HEAD');
      build(env.repo);
      const sha = git(env.repo, 'rev-parse', 'HEAD');
      git(env.repo, 'push', '-q', 'origin', `${sha}:refs/heads/main`);
      git(env.repo, 'checkout', '-q', 'main');
      return sha;
    },
    /** The synthetic GitHub reports B's PR merged at `headSha` as `mergeCommit`. */
    markMergedAt: (headSha, mergeCommit) => writeFileSync(prsFile, JSON.stringify(JSON.parse(readFileSync(prsFile, 'utf8'))
      .map((pr) => (pr.head === branchName(B, 'B1') ? { ...pr, merged: true, mergeCommit, headSha } : pr)))),
    implementRuns: (id) => store.all("SELECT id FROM operations WHERE campaign_id = ? AND kind = 'implement'", id).length,
    journal: (id, kind) => store.all('SELECT detail FROM journal WHERE campaign_id = ? AND kind = ? ORDER BY seq', id, kind).map((row) => row.detail),
    mergeCalls: () => env.ghCalls().filter((call) => call.args.some((arg) => /\/pulls\/\d+\/merge$/.test(arg))),
    pullReads: (url) => env.ghCalls().filter((call) => call.args.includes(`repos/example-org/sampleapp/pulls/${/\/pull\/(\d+)$/.exec(url)[1]}`)).length,
  };
  r.start();
  return r;
}

/** Both campaigns publish; A merges into main; B's next integration check opens a repair round with its implementer running. */
async function repairRoundOpen(r) {
  await r.tick();
  const a = r.implement(A, (dir) => writeFileSync(join(dir, 'shared.txt'), 'line one\nshared line from A\nline three\n'));
  const b = r.implement(B, (dir) => writeFileSync(join(dir, 'shared.txt'), 'line one\nshared line from B\nline three\n'));
  await r.tick();
  r.verify(A); r.verify(B);
  await r.tick(); // publish both
  await r.tick(); // drain the notes
  const mergedA = r.ownerMerge((dir) => git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge pull request A', a));
  r.env.markMerged(branchName(A, 'A1'), mergedA);
  r.advance();
  await r.tick();
  assert.equal(r.journal(B, 'integration-conflict').length, 1, 'B is in an integration repair round');
  assert.equal(r.open(B, 'implement').base_sha, b);
  return { a, b, mergedA, url: r.store.task(B, 'B1').pr_url };
}

/** The owner merges B's verified head itself, resolving the conflict by hand: a merge commit that contains it. */
const mergeB = (b) => (dir) => {
  assert.notEqual(tryGit(dir, 'merge', '-q', '--no-ff', '-m', 'Merge pull request B', b).status, 0, 'the merge really conflicts');
  writeFileSync(join(dir, 'shared.txt'), RESOLVED);
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--no-edit');
};

test('a PR merged out of band during an open repair round ends the round once, also across restarts, with no merge call', async (t) => {
  const r = rig(t);
  const { b, url } = await repairRoundOpen(r);
  const merged = r.ownerMerge(mergeB(b));
  r.markMergedAt(b, merged);
  r.unavailable(B);
  const runs = r.implementRuns(B);

  r.start(); // a restart while the round is open
  r.advance();
  await r.tick();
  assert.deepEqual(r.journal(B, 'merged'), [{ task: 'B1', sha: b, url, mergeCommit: merged, reconciled: true, requested: false }]);
  const done = r.store.task(B, 'B1');
  assert.equal(done.state, 'done');
  assert.deepEqual(done.findings, [], 'the integration finding is closed');
  assert.equal(done.verified_sha, b);
  assert.equal(r.store.openOperations(B).length, 0, 'no further repair run');
  assert.equal(r.implementRuns(B), runs);

  for (let i = 0; i < 2; i++) { r.advance(); await r.tick(); }
  r.start(); // and another restart after it is recorded
  for (let i = 0; i < 2; i++) { r.advance(); await r.tick(); }
  assert.equal(r.journal(B, 'merged').length, 1, 'recorded once');
  assert.equal(r.journal(B, 'integration-conflict').length, 1, 'never reopened');
  assert.equal(r.implementRuns(B), runs);
  assert.equal(r.store.campaign(B).control, 'finished');
  assert.equal(r.env.remoteHead(branchName(B, 'B1')), b, 'the branch is left as it was');
  assert.deepEqual(r.mergeCalls(), [], 'the synthetic gh saw no merge call');
});

test('a PR GitHub reports merged at the verified head ends the round even when the base holds only its squash', async (t) => {
  const r = rig(t);
  const { b, url } = await repairRoundOpen(r);
  const squash = r.ownerMerge((dir) => { writeFileSync(join(dir, 'shared.txt'), RESOLVED); git(dir, 'commit', '-qam', 'Squash of pull request B'); });
  assert.notEqual(tryGit(r.env.repo, 'merge-base', '--is-ancestor', b, squash).status, 0, 'the verified head is not in the base');
  r.markMergedAt(b, squash);
  r.unavailable(B);
  const runs = r.implementRuns(B);

  r.advance();
  await r.tick();
  assert.deepEqual(r.journal(B, 'merged'), [{ task: 'B1', sha: b, url, mergeCommit: squash, reconciled: true, requested: false }]);
  assert.equal(r.store.task(B, 'B1').state, 'done');
  for (let i = 0; i < 3; i++) { r.advance(); await r.tick(); }
  assert.equal(r.journal(B, 'merged').length, 1, 'recorded once');
  assert.equal(r.journal(B, 'integration-conflict').length, 1, 'a recorded merge is not reopened as a conflict');
  assert.equal(r.implementRuns(B), runs, 'no further repair run');
  assert.deepEqual(r.mergeCalls(), [], 'the synthetic gh saw no merge call');
});

test('a newer head after an out-of-band merge of an older one keeps its repair round', async (t) => {
  const r = rig(t);
  const { b, mergedA, url } = await repairRoundOpen(r);
  // The first round completes: the repaired head is verified and pushed to the same PR.
  const repaired = r.implement(B, (dir) => {
    assert.notEqual(tryGit(dir, 'merge', '-q', mergedA).status, 0);
    writeFileSync(join(dir, 'shared.txt'), RESOLVED);
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--no-edit');
  }, { commit: false });
  await r.tick();
  r.verify(B);
  await r.tick();
  assert.equal(r.env.remoteHead(branchName(B, 'B1')), repaired);
  assert.equal(r.store.task(B, 'B1').verified_sha, repaired);

  // The owner merges the older head b, with a different resolution, and GitHub reports the PR merged at b.
  const merged = r.ownerMerge((dir) => {
    assert.notEqual(tryGit(dir, 'merge', '-q', '--no-ff', '-m', 'Merge pull request B at its older head', b).status, 0);
    writeFileSync(join(dir, 'shared.txt'), 'line one\nthe owner resolution\nline three\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--no-edit');
  });
  r.markMergedAt(b, merged);
  r.advance();
  await r.tick();
  assert.equal(r.journal(B, 'integration-conflict').length, 2, 'the newer head conflicts with the new base: a second round');
  assert.equal(r.open(B, 'implement').base_sha, repaired);
  const runs = r.implementRuns(B), reads = r.pullReads(url);
  r.unavailable(B);

  r.advance();
  await r.tick();
  assert.ok(r.pullReads(url) > reads, 'the round was checked against GitHub');
  assert.equal(r.journal(B, 'merged').length, 0, 'the newer head is not merged');
  assert.equal(r.open(B, 'implement').base_sha, repaired, 'the round goes on');
  assert.equal(r.implementRuns(B), runs + 1);
  assert.deepEqual(r.mergeCalls(), [], 'the synthetic gh saw no merge call');
});
