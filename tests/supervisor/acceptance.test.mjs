import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { campaignCancel, campaignPause, campaignStart } from '../../src/supervisor/api.mjs';
import { classify } from '../../src/supervisor/adapters/claude.mjs';
import * as git from '../../src/supervisor/adapters/git.mjs';
import { declaration, environment, SQLITE, skipWithoutSqlite } from './helpers.mjs';

const { Store, FencedError } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};

function fixture(t) {
  const env = environment();
  mkdirSync(join(env.dataDir, 'runs'));
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const decl = declaration({ tasks: [declaration().tasks[0]] });
  let time = Date.now();
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, now: () => time });
  const id = decl.campaignId;
  campaignStart(store, decl, time);
  const lease = store.acquireLease(id, controller.instanceId, time, 1000);
  const ctx = { id, generation: lease.generation };
  controller.held.set(id, lease.generation);
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  return { env, store, controller, id, ctx, advance: (ms) => { time += ms; }, expire: () => { time += 1001; store.acquireLease(id, 'replacement', time, 1000); } };
}

test('stale controllers cannot prepare worktrees, launch, publish or post outbox notes', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id, ctx, expire } = fixture(t);
  const campaign = store.campaign(id);
  const task = store.task(id, 'T1');
  const head = git.currentHead({ git: ['git'], path: env.repo });
  controller.enqueue(id, 'stale-note', campaign.declaration, 'synthetic note', Date.now());
  expire();
  await assert.rejects(controller.dispatch(ctx, campaign, task, 'implement'), FencedError);
  await assert.rejects(controller.launch(ctx, { id: 'unrecorded', run_dir: join(env.dataDir, 'unrecorded') }), FencedError);
  await assert.rejects(controller.publish(ctx, campaign, { ...task, state: 'verified', head_sha: head, verified_sha: head }), FencedError);
  await controller.drainOutbox();
  assert.equal(existsSync(env.config.repositories['netbka/Dyk'].worktreeRoot), false);
  assert.equal(env.remoteHead(`campaign/${id}/T1`), null);
  assert.equal(env.calls().length, 0);
  assert.equal(env.prs().length, 0);
  assert.equal(env.comments().length, 0);
  assert.equal(store.get('SELECT attempts FROM outbox WHERE key = ?', 'stale-note').attempts, 0);
});

test('pause between checkpoint and launch prevents a new process', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id, ctx } = fixture(t);
  campaignPause(store, id);
  await controller.launch(ctx, { id: 'unrecorded', run_dir: join(env.dataDir, 'unrecorded') });
  assert.equal(env.calls().length, 0);
  assert.equal(existsSync(join(env.dataDir, 'unrecorded')), false);
});

test('outbox reconciles a posted note even when its transaction was rolled back', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id } = fixture(t);
  controller.enqueue(id, 'response-lost', store.campaign(id).declaration, 'synthetic note', Date.now());
  const run = store.run.bind(store);
  let fail = true;
  store.run = (sql, ...args) => {
    if (fail && sql.includes("SET state = 'posted', posted = ?,")) { fail = false; throw new Error('synthetic lost response'); }
    return run(sql, ...args);
  };
  await controller.drainOutbox();
  assert.equal(env.comments().length, 1);
  assert.equal(store.get('SELECT attempts FROM outbox WHERE key = ?', 'response-lost').attempts, 1);
  store.run('UPDATE outbox SET attempts = 0 WHERE key = ?', 'response-lost'); // Simulate a crash before failure bookkeeping.
  await controller.drainOutbox();
  assert.equal(env.comments().length, 1, 'reconciliation must happen even at attempt zero');
  assert.equal(store.get('SELECT state FROM outbox WHERE key = ?', 'response-lost').state, 'posted');
});

test('worker results reject malformed schemas, failed checks and unsuccessful exits', () => {
  const targetSha = 'a'.repeat(40);
  const reportDigest = 'b'.repeat(64);
  const accepted = { verdict: 'accepted', targetSha, reportDigest, summary: 'verified', findings: [], checks: [] };
  const result = (value, run = { exitCode: 0 }) => classify({ role: 'verification', run,
    stdoutText: JSON.stringify({ session_id: 'synthetic', structured_output: value }), stderrText: '',
    expect: { deliverable: 'commit', targetSha, reportDigest }, now: Date.now() });
  for (const value of [
    { ...accepted, findings: [null] }, { ...accepted, summary: undefined },
    { ...accepted, checks: [{ command: 'test', result: 'fail' }] },
    { ...accepted, checks: [{ command: 'test', result: 'unknown' }] },
    { ...accepted, findings: [{ id: 'x', severity: 'blocking', description: 'failed invariant' }] },
  ]) assert.equal(result(value).class, 'invalid-result');
  assert.equal(result(accepted, { exitCode: 1 }).class, 'error');
  assert.equal(result(accepted, { exitCode: null, signal: 'SIGTERM' }).class, 'error');
  assert.equal(result(accepted).class, 'result');
});

test('a replacement controller drains terminal campaign notes after lease expiry', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id, expire } = fixture(t);
  const campaign = store.campaign(id);
  store.patch('campaigns', { id }, campaign.version, { control: 'finished', status: 'ready' }, Date.now());
  controller.enqueue(id, 'completion-note', campaign.declaration, 'synthetic completed campaign', Date.now());
  expire();
  store.releaseLease(id, 'replacement', 2, 0);
  await controller.tick();
  assert.equal(env.comments().length, 1);
  assert.equal(store.campaign(id).control, 'finished');
  assert.equal(env.calls().length, 0);
});

test('verification cannot accept a dirty checkout or a different HEAD', { skip: skipWithoutSqlite }, (t) => {
  const { env } = fixture(t);
  const targetSha = git.currentHead({ git: ['git'], path: env.repo });
  const options = { git: ['git'], path: env.repo, targetSha };
  assert.equal(git.checkVerification(options), null);
  assert.match(git.checkVerification({ ...options, targetSha: 'a'.repeat(40) }), /target SHA/);
  writeFileSync(join(env.repo, 'AGENTS.md'), 'modified while verifying');
  assert.match(git.checkVerification(options), /not clean/);
});

test('a verifier retry preserves the rejected checkout and starts clean', { skip: skipWithoutSqlite }, (t) => {
  const { env, id } = fixture(t);
  const options = { git: ['git'], repoPath: env.repo, worktreeRoot: env.config.repositories['netbka/Dyk'].worktreeRoot,
    campaignId: id, taskId: 'T1', targetSha: git.currentHead({ git: ['git'], path: env.repo }) };
  const first = git.prepareVerifyWorkspace({ ...options, attempt: 1 });
  writeFileSync(join(first.path, 'AGENTS.md'), 'changed during rejected review');
  const second = git.prepareVerifyWorkspace({ ...options, attempt: 2 });
  assert.notEqual(first.path, second.path);
  assert.equal(git.checkVerification({ ...options, path: second.path }), null);
  assert.match(git.checkVerification({ ...options, path: first.path }), /not clean/);
});

test('publication completes when the lease expires while its write lock excludes takeover', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id, ctx, advance } = fixture(t);
  const task = store.task(id, 'T1');
  const head = git.currentHead({ git: ['git'], path: env.repo });
  store.patch('tasks', { campaign_id: id, task_id: 'T1' }, task.version,
    { state: 'verified', head_sha: head, verified_sha: head, result: { report: 'synthetic' }, verification: { summary: 'accepted', checks: [], findings: [] } }, Date.now());
  controller.injectFault = (point) => { if (point === 'after-push') advance(1001); };
  await controller.publish(ctx, store.campaign(id), store.task(id, 'T1'));
  assert.equal(store.task(id, 'T1').state, 'done');
  assert.equal(env.prs().length, 1);
  assert.ok(store.lease(id).expires_at > controller.now());
});

test('checkpoint preparation completes across lease expiry while holding the write lock', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id, ctx, advance } = fixture(t);
  const repo = controller.repo.bind(controller);
  controller.repo = (decl) => { advance(1001); return repo(decl); };
  controller.launch = async () => {};
  await controller.dispatch(ctx, store.campaign(id), store.task(id, 'T1'), 'implement');
  assert.equal(store.openOperations(id).length, 1);
  assert.ok(store.lease(id).expires_at > controller.now());
});

test('an unknown spawn receipt blocks replay and cancellation instead of assuming no process', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id, ctx } = fixture(t);
  controller.launch = async () => {};
  await controller.dispatch(ctx, store.campaign(id), store.task(id, 'T1'), 'implement');
  const op = store.openOperations(id)[0];
  writeFileSync(join(op.run_dir, 'launch.json'), JSON.stringify({ operationId: op.id }));
  controller.launch = Controller.prototype.launch;
  controller.config.startGraceMs = 0;
  await controller.reconcile(ctx, op);
  controller.refreshStatus(ctx);
  assert.equal(store.campaign(id).blocker.kind, 'process-ownership');
  assert.equal(store.campaign(id).status, 'blocked-external');
  assert.equal(store.campaign(id).runs_used, 1);
  campaignCancel(store, id);
  await controller.reconcile(ctx, op);
  assert.equal(store.openOperations(id).length, 1, 'unknown effects cannot be declared cancelled');
  assert.equal(env.calls().length, 0);
});
