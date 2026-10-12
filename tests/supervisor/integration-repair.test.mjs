// RUN1 (aiworks#27): a published, unmerged PR that conflicts with its base after a sibling merge is repaired by the
// supervisor itself. Two campaigns publish sibling PRs that change one file; the first merges; the second becomes an
// integration repair round. The workers are played by the test through the controller's own result path (applyOutcome),
// so these tests need no Windows runner and run on Linux CI too. No model, network or GitHub call: a disposable git origin
// and the synthetic gh of helpers.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { branchName } from '../../src/supervisor/adapters/git.mjs';
import { declaration, environment } from './helpers.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const tryGit = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

const task = (id, issue, title) => ({ id, issue, title, deliverable: 'commit', goal: `Change shared.txt for ${title}.`,
  dependsOn: [], acceptance: ['shared.txt changed'], references: ['AGENTS.md'] });
const A = 'camp-a', B = 'camp-b';

/** Two registered campaigns, one commit task each, over a base that already holds shared.txt. Workers are played by hand. */
function rig(t, { repair = true, limits = {} } = {}) {
  const env = environment({ config: repair ? { integrationRepair: { enabled: true } } : {} });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  writeFileSync(join(env.repo, 'shared.txt'), 'line one\nshared line\nline three\n');
  writeFileSync(join(env.repo, 'other.txt'), 'other\n');
  git(env.repo, 'add', '-A'); git(env.repo, 'commit', '-qm', 'shared file'); git(env.repo, 'push', '-q', 'origin', 'main');
  campaignStart(store, declaration({ campaignId: A, tasks: [task('A1', 501, 'sibling A')], limits }));
  campaignStart(store, declaration({ campaignId: B, tasks: [task('B1', 502, 'sibling B')], limits }));
  let now = Date.now();
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, now: () => now, fault: null });
  controller.launch = async () => {}; // the test plays the worker; nothing is spawned
  const ctx = (id) => ({ id, generation: controller.held.get(id) });
  const open = (id, kind) => {
    const [op] = store.openOperations(id);
    assert.equal(op?.kind, kind, `${id}: expected an open ${kind} operation, found ${op?.kind ?? 'none'}`);
    return op;
  };
  const r = {
    env, store, controller,
    advance: (ms) => { now += ms; },
    tick: () => controller.tick(),
    open,
    /** Play the implementer: `edit` changes the worktree; the commit is reported as resolved. */
    implement(id, edit, { commit = true } = {}) {
      const op = open(id, 'implement');
      edit(op.workspace);
      if (commit) { git(op.workspace, 'add', '-A'); git(op.workspace, 'commit', '-qm', `work for ${id}`); }
      const headSha = git(op.workspace, 'rev-parse', 'HEAD');
      controller.applyOutcome(ctx(id), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { result: 'resolved', summary: 'implemented', headSha, report: `# Report for ${id}` } });
      return { op, headSha };
    },
    /** Play the independent verifier of the exact target. */
    verify(id) {
      const op = open(id, 'verify');
      controller.applyOutcome(ctx(id), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { verdict: 'accepted', summary: 'checked', targetSha: op.target_sha, findings: [], checks: [{ command: 'npm run check', result: 'pass' }] } });
      return op;
    },
    journal: (id, kind) => store.all('SELECT detail FROM journal WHERE campaign_id = ? AND kind = ? ORDER BY seq', id, kind).map((row) => row.detail),
  };
  return r;
}

/** Both campaigns publish a PR that changes the same line of shared.txt; then A's PR merges into main. */
async function siblingsPublishedThenAMerged(r, { lineA = 'shared line from A', lineB = 'shared line from B', fileB = 'shared.txt' } = {}) {
  await r.tick(); // dispatch both implementers
  const a = r.implement(A, (dir) => writeFileSync(join(dir, 'shared.txt'), `line one\n${lineA}\nline three\n`));
  const b = r.implement(B, (dir) => writeFileSync(join(dir, fileB), fileB === 'shared.txt' ? `line one\n${lineB}\nline three\n` : `${lineB}\n`));
  await r.tick(); // dispatch both verifiers
  r.verify(A); r.verify(B);
  await r.tick(); // publish both
  await r.tick(); // drain the outbox notes
  for (const id of [A, B]) assert.equal(r.store.campaign(id).control, 'finished', `${id} published and finished`);
  assert.equal(r.env.prs().length, 2);
  // The owner merges A: main moves to a merge commit containing A's verified head.
  const { repo } = r.env;
  git(repo, 'fetch', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '--detach', 'FETCH_HEAD');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge pull request A', a.headSha);
  const merged = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', '-q', 'origin', `${merged}:refs/heads/main`);
  git(repo, 'checkout', '-q', 'main');
  r.env.markMerged(branchName(A, 'A1'), merged);
  return { a: a.headSha, b: b.headSha, merged };
}

test('after a sibling merge the conflicting PR is repaired, verified and pushed to the same branch and PR', async (t) => {
  const r = rig(t);
  const { a, b, merged } = await siblingsPublishedThenAMerged(r);
  const prB = r.store.task(B, 'B1').pr_url;
  const ghBefore = r.env.ghCalls().length;

  r.advance(r.controller.config.integrationPollMs + 1);
  await r.tick();

  // Detection is local: the check made no GitHub call at all.
  assert.equal(r.env.ghCalls().length, ghBefore, 'conflict detection must not call GitHub');
  const [conflict] = r.journal(B, 'integration-conflict');
  assert.deepEqual({ task: conflict.task, sha: conflict.sha, base: conflict.base, paths: conflict.paths },
    { task: 'B1', sha: b, base: merged, paths: ['shared.txt'] });
  assert.ok(conflict.commits.includes(a), 'the sibling commit that conflicts is named');
  assert.equal(r.journal(A, 'integration-conflict').length, 0, 'the merged sibling is not touched');
  assert.equal(r.store.campaign(A).control, 'finished');
  assert.equal(r.store.campaign(B).control, 'registered', 'the finished campaign reopens for the repair round');

  // The repair implementer continues the published branch and is told what to merge.
  const op = r.open(B, 'implement');
  assert.equal(op.base_sha, b, 'the repair round starts at the verified head');
  assert.ok(op.packet.constraints.some((line) => line.startsWith('Blocking integration finding integration-conflict') &&
    line.includes(merged) && line.includes('shared.txt') && line.includes(a.slice(0, 12))));
  const repaired = r.implement(B, (dir) => {
    assert.notEqual(tryGit(dir, 'merge', '-q', merged).status, 0, 'the base really conflicts');
    writeFileSync(join(dir, 'shared.txt'), 'line one\nshared line from A\nshared line from B\nline three\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--no-edit');
  }, { commit: false }).headSha;

  // No resolution reaches the PR without a fresh verification of the exact repaired head.
  await r.tick();
  const verifyOp = r.open(B, 'verify');
  assert.equal(verifyOp.target_sha, repaired);
  assert.match(readFileSync(join(verifyOp.run_dir, 'prompt.txt'), 'utf8'), new RegExp(`integration repair round: it must merge ${merged}.*remerge-diff ${repaired}`));
  assert.equal(r.env.remoteHead(branchName(B, 'B1')), b, 'nothing is pushed before verification');
  r.verify(B);
  await r.tick();

  // Same branch, same PR, fast-forward push, still mergeable.
  assert.equal(r.env.remoteHead(branchName(B, 'B1')), repaired);
  assert.equal(r.env.prs().length, 2, 'no duplicate PR');
  assert.equal(r.store.task(B, 'B1').pr_url, prB);
  assert.equal(r.store.task(B, 'B1').verified_sha, repaired);
  assert.equal(tryGit(r.env.repo, 'merge-base', '--is-ancestor', b, repaired).status, 0, 'the earlier verified head stays an ancestor');
  git(r.env.repo, 'fetch', '-q', 'origin', 'main');
  assert.equal(tryGit(r.env.repo, 'merge-tree', '--write-tree', 'FETCH_HEAD', repaired).status, 0, 'the repaired PR merges cleanly');
  const [done] = r.journal(B, 'integration-repaired');
  assert.deepEqual(done, { task: 'B1', from: b, base: merged, sha: repaired, url: prB });
  assert.equal(r.store.task(B, 'B1').findings, null);
  assert.ok(r.env.comments().some((comment) => comment.issue === prB.split('/').pop() &&
    comment.body.includes(`integration:${repaired}`) && comment.body.includes('fast-forward')), 'the PR carries the fresh verification');
  assert.equal(r.store.campaign(B).control, 'finished');

  // Once repaired, the next check finds nothing to do.
  r.advance(r.controller.config.integrationPollMs + 1);
  await r.tick();
  assert.equal(r.journal(B, 'integration-conflict').length, 1);
});

test('a repair head that rewrites the verified commit or skips the base is refused, and nothing is pushed', async (t) => {
  const r = rig(t);
  const { b, merged } = await siblingsPublishedThenAMerged(r);
  r.advance(r.controller.config.integrationPollMs + 1);
  await r.tick();

  // A commit on top that never merges the base is not an integration repair.
  r.implement(B, (dir) => writeFileSync(join(dir, 'note.txt'), 'no merge\n'));
  let task = r.store.task(B, 'B1');
  assert.equal(task.state, 'pending');
  assert.match(task.last_error, /does not contain the base/);
  assert.equal(r.env.remoteHead(branchName(B, 'B1')), b);

  // Rewritten history: the verified head is no longer an ancestor (what a force-push would publish).
  r.advance(1000);
  await r.tick();
  r.implement(B, (dir) => {
    git(dir, 'reset', '-q', '--hard', merged);
    writeFileSync(join(dir, 'shared.txt'), 'line one\nrewritten\nline three\n');
  });
  task = r.store.task(B, 'B1');
  assert.equal(task.state, 'pending');
  assert.match(task.last_error, /not a descendant of base/);
  assert.equal(r.env.remoteHead(branchName(B, 'B1')), b);

  // A worktree that lost the verified head gets no further repair worker until it is reconciled.
  r.advance(1000);
  await r.tick();
  assert.equal(r.store.openOperations(B).length, 0);
  assert.match(r.store.task(B, 'B1').blocked.reason, /does not contain the published verified head/);
  assert.equal(r.journal(B, 'integration-repaired').length, 0);
});

test('a branch moved by someone else is never force-pushed over', async (t) => {
  const r = rig(t);
  const { b, merged } = await siblingsPublishedThenAMerged(r);
  r.advance(r.controller.config.integrationPollMs + 1);
  await r.tick();
  const repaired = r.implement(B, (dir) => {
    tryGit(dir, 'merge', '-q', merged);
    writeFileSync(join(dir, 'shared.txt'), 'line one\nresolved\nline three\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--no-edit');
  }, { commit: false }).headSha;
  await r.tick();
  r.verify(B);
  // Meanwhile someone pushes another commit onto the PR branch.
  const { repo } = r.env;
  git(repo, 'checkout', '-q', '--detach', b);
  writeFileSync(join(repo, 'foreign.txt'), 'pushed by someone else\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'foreign');
  const foreign = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', '-q', 'origin', `${foreign}:refs/heads/${branchName(B, 'B1')}`);
  git(repo, 'checkout', '-q', 'main');
  await r.tick();
  assert.equal(r.env.remoteHead(branchName(B, 'B1')), foreign, 'the foreign commit is not overwritten');
  const task = r.store.task(B, 'B1');
  assert.equal(task.state, 'verified');
  assert.equal(task.verified_sha, repaired);
  assert.match(task.last_error, /^publish: push verified commit failed/);
  assert.equal(r.journal(B, 'integration-repaired').length, 0);
});

test('without an open PR the repaired head is neither pushed nor opened as a new PR', async (t) => {
  const r = rig(t);
  const { b, merged } = await siblingsPublishedThenAMerged(r);
  r.advance(r.controller.config.integrationPollMs + 1);
  await r.tick();
  r.implement(B, (dir) => {
    tryGit(dir, 'merge', '-q', merged);
    writeFileSync(join(dir, 'shared.txt'), 'line one\nresolved\nline three\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--no-edit');
  }, { commit: false });
  await r.tick();
  r.verify(B);
  // The PR is no longer open (the synthetic gh models that by marking it merged).
  r.env.markMerged(branchName(B, 'B1'));
  await r.tick();
  assert.equal(r.env.remoteHead(branchName(B, 'B1')), b);
  assert.equal(r.env.prs().length, 2, 'no new PR');
  assert.match(r.store.task(B, 'B1').blocked.reason, /no open PR; nothing was pushed or opened/);
  assert.equal(r.journal(B, 'integration-repair-unpublished').length, 1);
});

test('integration repair is bounded by maxRepairRounds', async (t) => {
  const r = rig(t, { limits: { maxRepairRounds: 0 } });
  await siblingsPublishedThenAMerged(r);
  r.advance(r.controller.config.integrationPollMs + 1);
  await r.tick();
  const [conflict] = r.journal(B, 'integration-conflict');
  assert.equal(conflict.stalled, true);
  assert.match(r.store.task(B, 'B1').blocked.reason, /integration conflict with main after 0 repair rounds/);
  assert.equal(r.store.openOperations(B).length, 0, 'no worker is dispatched past the bound');
});

test('a sibling merge without a conflict changes nothing', async (t) => {
  const r = rig(t);
  const { b } = await siblingsPublishedThenAMerged(r, { fileB: 'other.txt' });
  r.advance(r.controller.config.integrationPollMs + 1);
  await r.tick();
  assert.equal(r.journal(B, 'integration-conflict').length, 0);
  assert.equal(r.store.task(B, 'B1').state, 'done');
  assert.equal(r.store.campaign(B).control, 'finished');
  assert.equal(r.env.remoteHead(branchName(B, 'B1')), b);
});

test('switched off (the default), a conflicting published PR is left as today', async (t) => {
  const r = rig(t, { repair: false });
  const { b } = await siblingsPublishedThenAMerged(r);
  r.advance(r.controller.config.integrationPollMs + 1);
  await r.tick();
  assert.equal(r.journal(B, 'integration-conflict').length, 0);
  assert.equal(r.store.task(B, 'B1').state, 'done');
  assert.equal(r.store.campaign(B).control, 'finished');
  assert.equal(r.store.openOperations(B).length, 0);
  assert.equal(r.env.remoteHead(branchName(B, 'B1')), b);
});
