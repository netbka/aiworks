// Closing finished work (close-finished.mjs): an issue closes only when its campaign declared closeWhenDone and every task
// is done, once, never while another unfinished campaign names it; AIWorks closes only its own pull requests of a campaign
// that ended. The pass runs directly against a real store and a synthetic gh (fixtures/fake-gh.mjs); no model, network
// or GitHub call. Campaign and task outcomes are written to the store as the controller records them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { closeFinishedPass } from '../../src/supervisor/close-finished.mjs';
import { branchName } from '../../src/supervisor/adapters/git.mjs';
import { declaration, environment } from './helpers.mjs';

const REPOSITORY = 'example-org/sampleapp';
const sha = (n) => String(n).padStart(40, 'a');
const commitTask = (id, issue, of = 'work') => ({ id, issue, title: `change ${of} ${id}`, deliverable: 'commit', goal: `Change ${of} ${id}.`, dependsOn: [],
  acceptance: [`${of} ${id} changed`], references: ['AGENTS.md'] });

function rig(t) {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  let now = Date.now();
  const r = {
    env, store, controller: null,
    /** As after a restart: a new controller; the previous one releases its leases. */
    start() {
      r.controller?.release();
      r.controller = new Controller({ store, config: { ...env.config, closeFinished: { enabled: true } }, dataDir: env.dataDir, now: () => now, fault: null });
    },
    pass: async () => { now += r.controller.config.integrationPollMs + 1; return closeFinishedPass(r.controller); },
    register(campaignId, { tracking = 443, closeWhenDone, tasks = [commitTask('T1', tracking, campaignId)] } = {}) {
      const decl = declaration({ campaignId, tasks });
      decl.target.trackingIssue = tracking;
      if (closeWhenDone !== undefined) decl.target.closeWhenDone = closeWhenDone;
      campaignStart(store, decl, now);
    },
    /** The task published at `head` as AIWorks's PR `number`; merged records the merge gate's `merged` entry too. */
    done(campaignId, taskId, { number, head, merged = false }) {
      const url = `https://github.com/${REPOSITORY}/pull/${number}`;
      store.run("UPDATE tasks SET state = 'done', verified_sha = ?, pr_url = ? WHERE campaign_id = ? AND task_id = ?", head, url, campaignId, taskId);
      store.journal(campaignId, 'published', { task: taskId, sha: head, url }, now);
      if (merged) store.journal(campaignId, 'merged', { task: taskId, sha: head, url, mergeCommit: sha(9000 + number), reconciled: false, requested: true }, now);
      return url;
    },
    control: (campaignId, control) => store.run('UPDATE campaigns SET control = ? WHERE id = ?', control, campaignId),
    prs: (list) => writeFileSync(join(env.env.FAKE_GH_STATE, 'prs.json'), JSON.stringify(list.map((pr) => ({ base: 'main', ...pr })))),
    patches: (number) => env.ghCalls().filter((call) => call.args.includes('PATCH') && call.args.includes(`repos/${REPOSITORY}/issues/${number}`)),
    comments: (number) => env.comments().filter((comment) => comment.issue === String(number)),
    journal: (id, kind) => store.all('SELECT seq, detail FROM journal WHERE campaign_id = ? AND kind = ? ORDER BY seq', id, kind),
  };
  t.after(() => { r.controller?.release(); store.close(); env.cleanup(); });
  r.start();
  return r;
}

test('an issue closes once as completed, only when closeWhenDone is declared and every task is done, and not again after a crash', async (t) => {
  const r = rig(t);
  r.register('asked', { tracking: 443, closeWhenDone: true, tasks: [commitTask('T1', 443), commitTask('T2', 443)] });
  r.register('roadmap', { tracking: 444 });
  r.done('asked', 'T1', { number: 1001, head: sha(1), merged: true });
  r.done('asked', 'T2', { number: 1002, head: sha(2) });
  r.done('roadmap', 'T1', { number: 1003, head: sha(3), merged: true });
  r.control('asked', 'finished');
  r.control('roadmap', 'finished');

  await r.pass();
  assert.equal(r.patches(443).length, 0, 'T2 is published but not merged: the issue stays open');
  assert.equal(r.comments(443).length, 0);

  r.done('asked', 'T2', { number: 1002, head: sha(2), merged: true });
  await r.pass();
  await r.pass();
  assert.equal(r.patches(443).length, 1, 'closed once');
  assert.ok(r.patches(443)[0].args.includes('state_reason=completed'));
  assert.equal(r.comments(443).length, 1, 'one comment');
  assert.equal(r.patches(444).length, 0, 'an issue whose campaign did not declare closeWhenDone never closes');

  // A crash after the close and before its record: a restart settles it from the issue's state and acts on nothing.
  const [finished] = r.journal('asked', 'source-closed');
  r.store.run('DELETE FROM journal WHERE seq = ?', finished.seq);
  r.start();
  await r.pass();
  await r.pass();
  assert.equal(r.patches(443).length, 1, 'not closed twice');
  assert.equal(r.comments(443).length, 1, 'not commented twice');
  const settled = r.journal('asked', 'source-closed').map((row) => row.detail);
  assert.deepEqual(settled.map((detail) => [detail.outcome, detail.reconciled]), [['closed', true]]);
});

test('an issue another unfinished campaign still names is not closed until that campaign ends', async (t) => {
  const r = rig(t);
  r.register('asked', { tracking: 443, closeWhenDone: true });
  r.register('other', { tracking: 443 });
  r.done('asked', 'T1', { number: 1001, head: sha(1), merged: true });
  r.control('asked', 'finished');

  await r.pass();
  assert.equal(r.patches(443).length, 0, 'the other campaign still runs on the issue');
  assert.equal(r.comments(443).length, 0);

  r.control('other', 'cancelled');
  await r.pass();
  assert.equal(r.patches(443).length, 1);
});

test('AIWorks closes only its own unmerged pull requests of a campaign that ended', async (t) => {
  const r = rig(t);
  for (const id of ['waiting', 'dropped', 'owners', 'merged']) r.register(id, { tracking: 450 });
  r.done('waiting', 'T1', { number: 1001, head: sha(1) });
  r.done('dropped', 'T1', { number: 1002, head: sha(2) });
  r.done('owners', 'T1', { number: 1003, head: sha(3) });
  r.done('merged', 'T1', { number: 1004, head: sha(4) });
  r.prs([
    { url: `https://github.com/${REPOSITORY}/pull/1001`, head: branchName('waiting', 'T1'), headSha: sha(1) },
    { url: `https://github.com/${REPOSITORY}/pull/1002`, head: branchName('dropped', 'T1'), headSha: sha(2) },
    { url: `https://github.com/${REPOSITORY}/pull/1003`, head: 'feature/owner-work', headSha: sha(3) },
    { url: `https://github.com/${REPOSITORY}/pull/1004`, head: branchName('merged', 'T1'), headSha: sha(4), merged: true },
  ]);
  r.control('waiting', 'finished');

  await r.pass();
  assert.equal(r.patches(1002).length, 0, 'a running campaign keeps its pull request');
  assert.equal(r.patches(1001).length, 0, 'a finished campaign\'s verified PR still waits for its merge');

  for (const id of ['dropped', 'owners', 'merged']) r.control(id, 'cancelled');
  await r.pass();
  await r.pass();
  assert.equal(r.patches(1002).length, 1, 'the cancelled campaign\'s own PR is closed once');
  assert.ok(!r.patches(1002)[0].args.some((arg) => arg.startsWith('state_reason=')), 'a pull request takes no state reason');
  assert.equal(r.comments(1002).length, 1, 'with one comment');
  assert.equal(r.patches(1003).length, 0, 'a PR whose branch is not AIWorks\'s own is never closed');
  assert.equal(r.patches(1004).length, 0, 'a merged PR is never closed');
  assert.equal(r.patches(1001).length, 0);
  assert.equal(r.env.ghCalls().filter((call) => call.args.some((arg) => /\/git\/refs|DELETE/.test(arg))).length, 0, 'no branch is deleted');
});
