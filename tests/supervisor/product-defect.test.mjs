// Owner decision "independent failure analyst", routing 2: a product defect the independent verifier finds outside its
// task's write scope becomes one linked work item. A repeated verdict and a restarted supervisor record it exactly once,
// linked to the exact SHA that first reported it. No git, network or worker run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { comments } from '../../src/supervisor/work-list.mjs';
import { declaration, environment, skipWithoutSqlite } from './helpers.mjs';

const DEFECT = { title: 'Status page drops the retry timer', component: 'src/dashboard/status.mjs', evidence: 'The retry column is empty while a timer is set.',
  reproduction: 'Start a campaign whose step waits on a retry, open the status page.', proposedScope: 'src/dashboard/status.mjs only.',
  acceptance: 'The retry column shows the timer of a waiting step.' };

test('a repeated or restarted product-defect finding is recorded exactly once, linked to the exact SHA', { skip: skipWithoutSqlite }, (t) => {
  const env = environment();
  const config = { ...env.config, selfHosting: { repository: 'example-org/sampleapp', trustedMain: 'local' } };
  const path = join(env.dataDir, 'supervisor.db');
  let store = new Store(path);
  t.after(() => { try { store.close(); } catch { /* closed */ } env.cleanup(); });
  const d = declaration(); campaignStart(store, d);
  const first = 'a'.repeat(40), later = 'b'.repeat(40);
  const settle = (s, opId, sha, defects) => {
    const controller = new Controller({ store: s, config, dataDir: env.dataDir, fault: null });
    const lease = s.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
    const ctx = { id: d.campaignId, generation: lease.generation };
    controller.fenced(ctx, () => controller.recordProductDefects(ctx, { id: opId, task_id: 'T1', target_sha: sha },
      { verdict: 'accepted', findings: [], checks: [], productDefects: defects }, Date.now()));
    s.releaseLease(d.campaignId, controller.instanceId, lease.generation, Date.now() - 1);
  };
  const defects = () => store.all("SELECT * FROM work_items WHERE EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'product-defect')");

  settle(store, 'op-1', first, [DEFECT]);
  settle(store, 'op-1', first, [DEFECT]); // the same verdict settled again
  store.close();
  store = new Store(path); // a restart, then another verdict naming the same defect in other words and spacing
  settle(store, 'op-2', later, [{ ...DEFECT, title: '  status PAGE drops the retry-timer ', evidence: 'Seen again.' }]);

  const recorded = defects();
  assert.equal(recorded.length, 1, 'one item for one defect');
  assert.equal(recorded[0].kind, 'finding');
  assert.equal(recorded[0].campaign_id, d.campaignId);
  assert.equal(recorded[0].task_id, 'T1');
  assert.equal(recorded[0].verified_sha, first, 'linked to the exact SHA that first reported it');
  assert.equal(store.task(d.campaignId, 'T1').state, 'pending', 'the task itself is untouched');
  assert.deepEqual(comments(store, recorded[0].number).map((c) => c.body), [`Reported again by the independent verifier of ${d.campaignId}/T1 at \`${later}\`.`]);
});
