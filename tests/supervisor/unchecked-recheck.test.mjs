// AW-016: a published result without an independent check on record goes back to the checker by itself, once per head,
// and never costs more GitHub reads than the poll interval allows. The real uncheckedGone and recheckUnchecked run against
// a disposable git repository and the synthetic gh of helpers.mjs; nothing else is stubbed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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

/** One campaign whose T1 was published at a head outside the base, with no check on record. */
function rig(t) {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration(); campaignStart(store, d);
  const inBase = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'update-ref', 'refs/aiworks/base/main', inBase);
  git(env.repo, 'checkout', '-qb', 'side');
  writeFileSync(join(env.repo, 'work.txt'), 'published work\n');
  git(env.repo, 'add', '-A'); git(env.repo, 'commit', '-qm', 'published work');
  const head = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'checkout', '-q', 'main');
  const task = store.task(d.campaignId, 'T1');
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, task.version,
    { state: 'done', head_sha: head, verified_sha: null, verification: null, pr_url: 'https://github.com/example-org/sampleapp/pull/9' }, Date.now());
  let now = Date.now();
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, now: () => now, fault: null });
  controller.log = () => {};
  const branch = branchName(d.campaignId, 'T1');
  return {
    env, store, controller, d, head, inBase, branch,
    advance: (ms) => { now += ms; },
    at: () => now,
    ctx: () => ({ id: d.campaignId, generation: store.acquireLease(d.campaignId, controller.instanceId, now, 60_000).generation }),
    prs: (list) => writeFileSync(join(env.env.FAKE_GH_STATE, 'prs.json'), JSON.stringify(list)),
    // The synthetic gh logs the call, then fails on an unreadable state file: a read that fails without a rate limit.
    failReads: () => writeFileSync(join(env.env.FAKE_GH_STATE, 'rate-limit.json'), '{ unreadable'),
    reads: () => env.ghCalls().filter((call) => call.args.includes('repos/example-org/sampleapp/pulls')).length,
    task: () => store.task(d.campaignId, 'T1'),
  };
}

test('AW-016: the real uncheckedGone tells a head still to check from one merged, pushed or closed by someone else', (t) => {
  const r = rig(t), decl = r.store.campaign(r.d.campaignId).declaration, poll = r.env.config.pollMs;
  const gone = (head = r.head) => { r.advance(poll); return r.controller.uncheckedGone(r.ctx(), decl, { ...r.task(), head_sha: head }); };
  const pr = (headSha) => ({ url: 'https://github.com/example-org/sampleapp/pull/9', head: r.branch, base: 'main', headSha });

  assert.equal(gone(r.inBase), 'already in the base branch');
  assert.equal(r.reads(), 0, 'a head in the base needs no GitHub read');
  r.prs([pr(r.head)]);
  assert.equal(gone(), null, 'still open at the published head: AIWorks checks it');
  r.prs([pr('d'.repeat(40))]);
  assert.equal(gone(), 'its pull request now has another head');
  r.prs([]);
  assert.equal(gone(), 'its pull request is no longer open');
  r.failReads();
  assert.equal(gone(), undefined, 'a failed read decides nothing: the caller waits');
});

test('AW-016: an unchecked head costs at most one GitHub read per poll interval, none before a rate limit resets, none once settled', (t) => {
  const r = rig(t), poll = r.env.config.pollMs;
  const recheck = () => r.controller.recheckUnchecked(r.ctx());

  // A failed read waits a poll interval before the next one.
  r.prs([{ url: 'https://github.com/example-org/sampleapp/pull/9', head: r.branch, base: 'main', headSha: r.head }]);
  r.failReads();
  recheck(); recheck(); recheck();
  assert.equal(r.reads(), 1, 'one read per poll interval');
  assert.equal(r.task().state, 'done');

  // A rate-limit refusal waits for GitHub's reset, not just the poll interval.
  const reset = Math.ceil(r.at() / 1000) + 600;
  r.env.rateLimit({ route: 'GET pulls', times: 1, reset });
  r.advance(poll);
  recheck();
  assert.equal(r.reads(), 2);
  for (let i = 0; i < 5; i++) { r.advance(poll); recheck(); }
  assert.equal(r.reads(), 2, 'no read before the rate limit resets');
  r.advance(reset * 1000 - r.at() + r.controller.config.rateLimitMarginMs);
  recheck();
  assert.equal(r.reads(), 3);
  const reopened = r.task();
  assert.deepEqual([reopened.state, reopened.head_sha, reopened.verified_sha], ['implemented', r.head, null], 'the next run is a check of the same head, nothing is rebuilt');

  // The check is lost again at the same head: no second check, and no further read.
  r.store.patch('tasks', { campaign_id: r.d.campaignId, task_id: 'T1' }, reopened.version, { state: 'done' }, r.at());
  for (let i = 0; i < 3; i++) { r.advance(poll); recheck(); }
  assert.equal(r.task().state, 'done', 'one check per head, never a loop of paid runs');
  assert.equal(r.reads(), 3, 'a head already sent back to the checker is never read again');
  assert.equal(r.store.get("SELECT COUNT(*) AS n FROM events WHERE kind = 'unchecked-recheck'").n, 1);
});

test('AW-016: a head closed by someone else is left for the owner once, and never read again', (t) => {
  const r = rig(t), poll = r.env.config.pollMs;
  const recheck = () => r.controller.recheckUnchecked(r.ctx());
  r.prs([]);
  recheck();
  assert.equal(r.task().state, 'done', 'a closed pull request is never checked and published again');
  assert.equal(r.store.get("SELECT COUNT(*) AS n FROM events WHERE kind = 'unchecked-recheck-skipped'").n, 1);
  r.prs([{ url: 'https://github.com/example-org/sampleapp/pull/9', head: r.branch, base: 'main', headSha: r.head }]);
  for (let i = 0; i < 3; i++) { r.advance(poll); recheck(); }
  assert.equal(r.task().state, 'done', 'a head left for the owner stays left');
  assert.equal(r.reads(), 1);
});
