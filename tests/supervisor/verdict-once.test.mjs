// A text-only correction cannot publish a head or report under somebody else's old code verdict.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, runUntil, skipWithoutSqlite } from './helpers.mjs';

test('publication-text recovery retains one code gate and refuses stale head, base, report or proof', { skip: skipWithoutSqlite }, async (t) => {
  const { Store } = await import('../../src/supervisor/store.mjs');
  const { Controller } = await import('../../src/supervisor/controller.mjs');
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const env = environment({ scenario: { implement: ['commit-leak', 'commit-same'], verify: ['accept-leak', 'accept'], gate: [null, false] } });
  let store = new Store(join(env.dataDir, 'supervisor.db'));
  let controller = new Controller({ store, config: env.config, dataDir: env.dataDir });
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  const decl = declaration({ tasks: [declaration().tasks[0]] }), id = decl.campaignId;
  campaignStart(store, decl);
  await runUntil(controller, store, id, () => store.task(id, 'T1').findings?.some((f) => f.codeEvidence));
  const original = store.task(id, 'T1').verification;
  const originalHead = store.task(id, 'T1').head_sha;
  const refused = store.task(id, 'T1');
  const realFetch = controller.fetchBase.bind(controller);
  controller.fetchBase = async () => ({ ok: true, sha: 'a'.repeat(40) });
  await controller.dispatch({ id, generation: controller.held.get(id) }, store.campaign(id), refused, 'implement');
  assert.equal(store.task(id, 'T1').state, 'pending', 'an unsafe report still needs ordinary correction when its base moved');
  assert.ok(store.task(id, 'T1').findings.every((finding) => !finding.codeEvidence));
  assert.equal(env.calls().length, 2, 'stale proof starts no worker');
  store.patch('tasks', { campaign_id: id, task_id: 'T1' }, store.task(id, 'T1').version,
    { findings: refused.findings, verification: refused.verification, verified_sha: refused.verified_sha }, Date.now());
  controller.fetchBase = realFetch;
  // Recover from only persisted state, with no original controller cache or full-gate files in the new checkout.
  controller.release(); store.close();
  store = new Store(join(env.dataDir, 'supervisor.db'));
  controller = new Controller({ store, config: env.config, dataDir: env.dataDir });
  const publish = controller.publish.bind(controller);
  controller.publish = async () => {};
  await runUntil(controller, store, id, () => Boolean(store.task(id, 'T1').verification?.publicationText));
  const accepted = store.task(id, 'T1');
  assert.equal(accepted.head_sha, originalHead);
  assert.notEqual(accepted.verification.reportDigest, original.reportDigest, 'independent text verifier checked the new digest');
  assert.deepEqual(accepted.verification.gate, original.gate, 'the original gate is retained, never invented or rerun');
  assert.deepEqual(accepted.verification.criteria, original.criteria, 'original code criteria remain separate');
  const ops = store.all('SELECT * FROM operations WHERE campaign_id = ? ORDER BY seq', id);
  assert.equal(ops.length, 4, 'one implementation, one full verification, one text rewrite, one independent text verification');
  assert.ok(ops.slice(2).every((op) => op.publication_rewrite && op.packet.access === 'read-only'));
  assert.throws(() => readFileSync(join(ops[3].workspace, 'gate.log')), { code: 'ENOENT' });
  assert.deepEqual(store.get('SELECT outcome FROM operations WHERE id = ?', ops[1].id).outcome.value, original);
  const ctx = { id, generation: controller.held.get(id) };
  const patch = (changes) => store.patch('tasks', { campaign_id: id, task_id: 'T1' }, store.task(id, 'T1').version, changes, Date.now());
  const restore = () => patch({ state: accepted.state, head_sha: accepted.head_sha, verified_sha: accepted.verified_sha,
    verification: accepted.verification, findings: accepted.findings, result: accepted.result, retry_at: null });
  const ordinaryFetch = controller.fetchBase.bind(controller);
  for (const stale of ['head', 'base', 'report', 'proof', 'packet']) {
    restore();
    if (stale === 'head') patch({ head_sha: accepted.base_sha });
    if (stale === 'base') controller.fetchBase = async () => ({ ok: true, sha: 'a'.repeat(40) });
    if (stale === 'report') patch({ result: { ...accepted.result, report: 'An unchecked replacement report.' } });
    if (stale === 'proof') patch({ verification: { ...accepted.verification, codeEvidence: { ...accepted.verification.codeEvidence, outcome: '0'.repeat(64) } } });
    if (stale === 'packet') store.updateOperation(ops[1].id, { packet: {} }, Date.now());
    await publish(ctx, store.campaign(id), store.task(id, 'T1'));
    assert.equal(store.task(id, 'T1').state, 'implemented', `${stale} requires normal independent verification`);
    assert.equal(store.task(id, 'T1').verification, null);
    assert.ok(store.task(id, 'T1').findings.every((finding) => !finding.codeEvidence));
    assert.equal(env.prs().length, 0, `${stale} published nothing`);
    controller.fetchBase = ordinaryFetch;
    if (stale === 'packet') store.updateOperation(ops[1].id, { packet: ops[1].packet }, Date.now());
  }
  restore();
  await publish(ctx, store.campaign(id), store.task(id, 'T1'));
  await publish(ctx, store.campaign(id), store.task(id, 'T1'));
  assert.equal(env.prs().length, 1, 'exact unchanged evidence publishes once after recovery');
  assert.equal(env.remoteHead(`campaign/${id}/T1`), originalHead);
  assert.equal(env.calls().length, 4, 'publication and recovery spent no additional worker calls');
  assert.doesNotMatch(JSON.stringify([env.prs(), env.comments()]), /synthetic-owner/);
  assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ops[2].workspace, encoding: 'utf8', windowsHide: true }).stdout.trim(), originalHead);
});

test('a refused verification text is rewritten by a fresh verifier even at the repair limit, and the head publishes', { skip: skipWithoutSqlite }, async (t) => {
  const { Store } = await import('../../src/supervisor/store.mjs');
  const { Controller } = await import('../../src/supervisor/controller.mjs');
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const env = environment({ scenario: { implement: ['commit'], verify: ['accept-leak', 'accept'] } });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir });
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: { maxRepairRounds: 0 } }), id = decl.campaignId;
  campaignStart(store, decl);
  await runUntil(controller, store, id, () => ['done', 'cancelled'].includes(store.task(id, 'T1').state) || store.task(id, 'T1').blocked);
  const task = store.task(id, 'T1');
  assert.equal(task.state, 'done', `published, not stopped: ${task.last_error}`);
  assert.ok(task.pr_url);
  const runs = store.all("SELECT kind FROM operations WHERE campaign_id = ? ORDER BY created_at", id).map((op) => op.kind);
  assert.deepEqual(runs, ['implement', 'verify', 'verify'], 'one fresh verifier, no implementer run');
});
