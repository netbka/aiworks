// A step AIWorks ended as not done (AW-017) whose head is merged outside AIWorks later settles its follow-up item; one
// whose head is not merged keeps it open. Workers are played by the test through the controller's own result path
// (applyOutcome). No model, network or GitHub call: a disposable git origin and the synthetic gh of helpers.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { item } from '../../src/supervisor/work-list.mjs';
import { declaration, environment } from './helpers.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const step = (id, issue) => ({ id, issue, title: `step ${id}`, deliverable: 'commit', goal: `Add ${id}.txt.`,
  dependsOn: [], acceptance: [`${id}.txt exists`], references: ['AGENTS.md'] });

test('a not-done step whose head is merged later closes its follow-up; an unmerged one keeps it open', async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  let now = Date.now();
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, now: () => now, fault: null });
  controller.launch = async () => {}; // the test plays the worker; nothing is spawned
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  const camps = { M: 'camp-merged', K: 'camp-kept' };
  campaignStart(store, declaration({ campaignId: camps.M, tasks: [step('M1', 601)] }));
  campaignStart(store, declaration({ campaignId: camps.K, tasks: [step('K1', 602)] }));
  await controller.tick();

  const heads = {};
  for (const [key, id] of Object.entries(camps)) {
    const ctx = { id, generation: controller.held.get(id) };
    const [op] = store.openOperations(id);
    assert.equal(op?.kind, 'implement');
    writeFileSync(join(op.workspace, `${key}.txt`), `${key}\n`);
    git(op.workspace, 'add', '-A'); git(op.workspace, 'commit', '-qm', `work for ${key}`);
    heads[key] = git(op.workspace, 'rev-parse', 'HEAD');
    controller.applyOutcome(ctx, op, { class: 'result', receipt: { sessionId: op.session_id },
      value: { result: 'resolved', summary: 'implemented', headSha: heads[key], report: `# Report for ${key}` } });
    // AIWorks gives up on the step before it is verified: it ends as not done with a follow-up item.
    controller.fenced(ctx, () => controller.settleStopped(ctx, store.task(id, `${key}1`), 'stalled', now));
    assert.equal(store.task(id, `${key}1`).state, 'cancelled');
    assert.equal(store.task(id, `${key}1`).head_sha, heads[key]);
  }
  const itemOf = (id) => store.all("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'step-not-done'", id)[0].detail.item;
  const items = { M: itemOf(camps.M), K: itemOf(camps.K) };
  now += controller.config.integrationPollMs + 1;
  await controller.tick();
  assert.equal(store.campaign(camps.M).control, 'finished');
  assert.equal(item(store, items.M).state, 'open', 'nothing was merged yet');

  // Someone publishes M's branch by hand and merges it into main outside AIWorks.
  git(env.repo, 'fetch', '-q', 'origin', 'main');
  git(env.repo, 'checkout', '-q', '--detach', 'FETCH_HEAD');
  git(env.repo, 'merge', '-q', '--no-ff', '-m', 'Merge step M1 by hand', heads.M);
  git(env.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(env.repo, 'checkout', '-q', 'main');

  for (let i = 0; i < 2; i++) { now += controller.config.integrationPollMs + 1; await controller.tick(); }
  assert.equal(item(store, items.M).state, 'closed', 'the merged step settles its follow-up');
  assert.deepEqual(store.all("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'not-done-merged'", camps.M).map((row) => row.detail.sha), [heads.M], 'recorded once');
  assert.equal(store.task(camps.M, 'M1').state, 'cancelled', 'the step itself is not rewritten');
  assert.equal(item(store, items.K).state, 'open', 'the unmerged step keeps its follow-up');
});
