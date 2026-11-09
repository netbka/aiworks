// Owner decision "independent failure analyst", routing 2: a product defect the independent verifier finds outside its
// task's write scope becomes one linked work item. The same verify result settled again, also by a restarted
// supervisor, records it exactly once, linked to the exact SHA that first reported it. No network or worker run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
  const d = declaration({ tasks: [{ id: 'R1', issue: 437, title: 'review', deliverable: 'report', goal: 'Review only.', dependsOn: [], acceptance: ['recorded'], references: ['AGENTS.md'] }] });
  campaignStart(store, d);
  const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.repo, encoding: 'utf8' }).trim();
  const commit = (name) => {
    writeFileSync(join(env.repo, name), `${name}\n`);
    for (const args of [['add', '-A'], ['commit', '-q', '-m', name]]) execFileSync('git', args, { cwd: env.repo, stdio: 'pipe' });
  };
  let seq = 0;
  // A verify operation of R1 at the checkout's current head, its run finished with `defects` and not yet consumed.
  const verifyOp = (defects) => {
    const sha = head(), id = `synthetic.verify.${++seq}`, row = store.task(d.campaignId, 'R1');
    store.patch('tasks', { campaign_id: d.campaignId, task_id: 'R1' }, row.version, { state: 'implemented', head_sha: sha, base_sha: sha }, Date.now());
    store.insert('operations', { id, campaign_id: d.campaignId, task_id: 'R1', kind: 'verify', seq, idempotency_key: id, lease_generation: 1, state: 'dispatched',
      session_id: `session-${seq}`, executor_kind: 'claude-cli', run_dir: env.dataDir, workspace: env.repo, target_sha: sha, packet_digest: 'd',
      packet: { tenantId: 'example-org', projectId: 'sampleapp', environment: 'research', taskId: 'R1', stageId: 'verify', runId: id, revision: sha, authorityDigest: 'c'.repeat(64) },
      created_at: Date.now(), updated_at: Date.now() });
    const outcome = { class: 'result', receipt: { sessionId: `session-${seq}` },
      value: { verdict: 'accepted', targetSha: sha, reportDigest: '0'.repeat(64), summary: 'ok', findings: [], checks: [], productDefects: defects } };
    return { id, sha, outcome };
  };
  // Settle through the real path; each call is a supervisor instance that holds the campaign's lease.
  const settle = ({ id, outcome }) => {
    const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
    const lease = store.acquireLease(d.campaignId, controller.instanceId, Date.now(), 60_000);
    controller.applyOutcome({ id: d.campaignId, generation: lease.generation }, store.get('SELECT * FROM operations WHERE id = ?', id), outcome);
    store.releaseLease(d.campaignId, controller.instanceId, lease.generation, Date.now() - 1);
  };
  const defects = () => store.all("SELECT * FROM work_items WHERE EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'product-defect') ORDER BY number");

  const first = verifyOp([DEFECT]);
  settle(first);
  assert.equal(store.get('SELECT state FROM operations WHERE id = ?', first.id).state, 'finished');
  assert.equal(store.task(d.campaignId, 'R1').state, 'verified', 'the defect does not change the task\'s own verdict');
  settle(first); // the same result consumed again
  store.close();
  store = new Store(path); // a restart replays it once more
  settle(first);
  assert.equal(defects().length, 1, 'one item, however often the result is settled');
  assert.equal(store.all("SELECT seq FROM journal WHERE campaign_id = ? AND kind = 'product-defect'", d.campaignId).length, 1,
    'a finished operation is never settled again, so its defects are not even looked up again');

  // A later verification at another SHA names the same defect in other case and spacing: no second item, one comment.
  commit('later.txt');
  const later = verifyOp([{ ...DEFECT, title: '  status PAGE drops the retry-timer ', evidence: 'Seen again.' }]);
  settle(later);

  const recorded = defects();
  assert.equal(recorded.length, 1, 'one item for one defect');
  assert.deepEqual([recorded[0].kind, recorded[0].campaign_id, recorded[0].task_id, recorded[0].verified_sha], ['finding', d.campaignId, 'R1', first.sha],
    'linked to the exact SHA that first reported it');
  assert.deepEqual(comments(store, recorded[0].number).map((c) => c.body), [`Reported again by the independent verifier of ${d.campaignId}/R1 at \`${later.sha}\`.`]);

  // Two different defects in Cyrillic in the same component are two items, never merged into one.
  commit('third.txt');
  settle(verifyOp([{ ...DEFECT, title: 'Страница статуса теряет таймер' }, { ...DEFECT, title: 'Журнал не показывает ошибку' }]));
  assert.equal(defects().length, 3);
});
