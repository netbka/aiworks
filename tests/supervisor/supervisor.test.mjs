// AIWorks slice A: durable campaign supervisor behaviour with synthetic workers.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, runUntil, skipWithoutSqlite, sleep } from './helpers.mjs';

const load = async () => ({
  ...(await import('../../src/supervisor/api.mjs')),
  ...(await import('../../src/supervisor/campaign.mjs')),
  ...(await import('../../src/supervisor/controller.mjs')),
  ...(await import('../../src/supervisor/store.mjs')),
  claude: await import('../../src/supervisor/adapters/claude.mjs'),
});

async function setup(t, { scenario, config, decl } = {}) {
  const m = await load();
  const env = environment({ scenario, config });
  const store = new m.Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = decl ?? declaration();
  m.campaignStart(store, d);
  const controller = new m.Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  return { m, env, store, controller, d, id: d.campaignId };
}

test('declarations: DAG order, never bypassPermissions, stable scope digest', { skip: skipWithoutSqlite }, async () => {
  const m = await load();
  const d = declaration();
  assert.equal(m.validateDeclaration(d), d);
  const reorder = (value) => Object.fromEntries(Object.entries(value).reverse());
  assert.equal(m.scopeDigest(d), m.scopeDigest({ ...reorder(d), target: reorder(d.target), tasks: d.tasks.map(reorder) }));
  assert.equal(m.scopeDigest(d), m.scopeDigest({ ...d, limits: { ...d.limits, maxWorkerRuns: 99 } }), 'limits are not scope');
  assert.notEqual(m.scopeDigest(d), m.scopeDigest({ ...d, tasks: d.tasks.slice(0, 1) }));
  const forward = declaration();
  forward.tasks[0].dependsOn = ['T2'];
  assert.throws(() => m.validateDeclaration(forward), /must name an earlier task/);
  assert.throws(() => m.validateDeclaration({ ...d, executor: { ...d.executor, permissionMode: 'bypassPermissions' } }), /permissionMode/);
  assert.throws(() => m.validateDeclaration({ ...d, limits: { ...d.limits, slots: 9 } }), /slots must be 1\.\.8 or "auto"/);
  const badPath = declaration();
  badPath.tasks[0].references = ['../secrets'];
  assert.throws(() => m.validateDeclaration(badPath), /references/);
});

test('start is idempotent, scope is immutable, amendments need a higher authorization version', { skip: skipWithoutSqlite }, async (t) => {
  const { m, store, d, id } = await setup(t);
  const again = m.campaignStart(store, d);
  assert.equal(again.tasks.length, 2, 'duplicate start creates no duplicate tasks');
  assert.equal(store.all('SELECT * FROM tasks WHERE campaign_id = ?', id).length, 2);
  assert.throws(() => m.campaignStart(store, { ...d, tasks: d.tasks.slice(0, 1) }), (e) => e.code === 'SCOPE_CONFLICT');
  assert.throws(() => m.campaignStart(store, { ...d, limits: { ...d.limits, maxWorkerRuns: 20 } }), (e) => e.code === 'AUTHORIZATION_VERSION_REQUIRED');
  const amended = m.campaignStart(store, { ...d, authorization: { ...d.authorization, version: 2 }, limits: { ...d.limits, maxWorkerRuns: 20 } });
  assert.equal(amended.authorizationVersion, 2);
  assert.equal(amended.maxWorkerRuns, 20);
  assert.throws(() => m.campaignStart(store, d), (e) => e.code === 'STALE_AUTHORIZATION');
});

test('registration without a live controller is BOOTSTRAP_REQUIRED, never ACTIVE', { skip: skipWithoutSqlite }, async (t) => {
  const { m, store, controller, id } = await setup(t, { scenario: { implement: ['sleep:400:commit'] } });
  const registered = m.campaignStatus(store, id);
  assert.equal(registered.readiness, 'BOOTSTRAP_REQUIRED');
  assert.equal(registered.controller.live, false);
  await controller.tick();
  const live = m.campaignStatus(store, id);
  assert.equal(live.readiness, 'ACTIVE');
  assert.equal(live.controller.instanceId, controller.instanceId);
  assert.equal(live.controller.generation, 1);
  controller.release();
  assert.equal(m.campaignStatus(store, id).readiness, 'CONTROLLER_OFFLINE', 'a released lease is not a running controller');
  // let the dispatched synthetic worker finish before cleanup
  await sleep(800);
});

test('competing controllers: one holder, takeover only after expiry, stale writer fenced', { skip: skipWithoutSqlite }, async (t) => {
  const { m, store, env, id } = await setup(t);
  let clock = 1_000_000;
  const now = () => clock;
  const a = new m.Controller({ store, config: env.config, dataDir: env.dataDir, now, fault: null });
  const b = new m.Controller({ store, config: env.config, dataDir: env.dataDir, now, fault: null });
  const leaseA = store.acquireLease(id, a.instanceId, now(), 1000);
  assert.equal(leaseA.generation, 1);
  assert.equal(store.acquireLease(id, b.instanceId, now(), 1000), null, 'live lease is never shared');
  clock += 999;
  assert.equal(store.acquireLease(id, b.instanceId, now(), 1000), null, 'not before expiry');
  clock += 2;
  const leaseB = store.acquireLease(id, b.instanceId, now(), 1000);
  assert.deepEqual([leaseB.generation, leaseB.takeover], [2, true]);
  assert.throws(() => a.fenced({ id, generation: 1 }, () => store.journal(id, 'stale-write', null, now())), m.FencedError);
  assert.equal(store.all("SELECT * FROM journal WHERE kind = 'stale-write'").length, 0, 'fenced write left no effect');
  b.fenced({ id, generation: 2 }, () => store.journal(id, 'current-write', null, now()));
  assert.equal(store.all("SELECT * FROM journal WHERE kind = 'current-write'").length, 1);
});

test('serial DAG: implement, independent verify of the exact SHA, publish that SHA', { skip: skipWithoutSqlite }, async (t) => {
  const { m, store, controller, env, id } = await setup(t);
  const campaign = await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.equal(campaign.status, 'ready');
  assert.equal(campaign.runs_used, 4);
  assert.equal(m.campaignStatus(store, id).readiness, 'COMPLETE');
  const calls = env.calls();
  assert.deepEqual(calls.map((c) => c.role), ['implement', 'verify', 'implement', 'verify'], 'T2 waited for T1');
  for (let i = 0; i < calls.length; i += 2) {
    assert.notEqual(calls[i].sessionId, calls[i + 1].sessionId, 'verifier is a different session');
    assert.notEqual(calls[i].cwd, calls[i + 1].cwd, 'verifier uses its own checkout');
    assert.ok(calls[i + 1].args.includes('Edit') && calls[i + 1].args.includes('Write'), 'verifier cannot edit');
    assert.ok(!calls[i].args.includes('bypassPermissions') && calls[i].args.includes('none'), 'prompts denied, no bypass');
  }
  const tasks = store.tasks(id);
  const prs = env.prs();
  assert.equal(prs.length, 2);
  for (const task of tasks) {
    assert.equal(task.state, 'done');
    assert.equal(task.verified_sha, task.head_sha);
    assert.equal(env.remoteHead(`campaign/${id}/${task.task_id}`), task.verified_sha, 'pushed exactly the verified SHA');
    const pr = prs.find((p) => p.url === task.pr_url);
    assert.ok(pr.body.includes(task.verified_sha) && pr.body.includes('Not merged and not deployed'));
  }
  const ops = store.all('SELECT * FROM operations WHERE campaign_id = ?', id);
  assert.equal(new Set(ops.map((op) => op.idempotency_key)).size, 4);
  assert.ok(ops.every((op) => op.outcome.receipt.measured && op.outcome.receipt.costUsd === 0.01));
  assert.equal(Math.round(store.campaign(id).cost_usd * 100), 4);
  await runUntil(controller, store, id, () => store.all("SELECT * FROM outbox WHERE state = 'pending'").length === 0).catch(() => {});
  const notes = env.comments().filter((c) => c.issue === '443');
  assert.ok(notes.some((c) => c.body.includes('aiworks:test-campaign:ready')), 'ready note posted to the tracking issue');
});

test('report deliverable: verified report is posted to the task issue once, bound by digest', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [{ id: 'R1', issue: 437, title: 'research', deliverable: 'report', goal: 'Research only.', dependsOn: [], acceptance: ['findings posted'], references: ['AGENTS.md'] }] });
  const { store, controller, env, id } = await setup(t, { decl, scenario: { implement: ['report'] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const posted = env.comments().filter((c) => c.issue === '437');
  assert.equal(posted.length, 1);
  assert.ok(posted[0].body.includes('# Findings') && posted[0].body.includes('independently verified report'));
  assert.equal(env.prs().length, 0, 'no PR for a report deliverable');
  const verify = env.calls().find((c) => c.role === 'verify');
  assert.ok(verify.args.includes('Write') && verify.args.includes('Edit'), 'verifier cannot edit');
  const implement = env.calls().find((c) => c.role === 'implement');
  assert.ok(implement.args.includes('Bash(git commit:*)') && !implement.args.includes('Write'), 'report implementer cannot commit but may write scratch files');
  assert.ok(env.calls().every((call) => call.autoMemoryDisabled === true), 'every campaign worker starts with the target project auto-memory disabled');
});

test('verifier rejection becomes a bounded repair round on the same branch', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]] });
  const { store, controller, env, id } = await setup(t, { decl, scenario: { verify: ['reject', 'accept'] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.deepEqual(env.calls().map((c) => c.role), ['implement', 'verify', 'implement', 'verify']);
  const task = store.task(id, 'T1');
  assert.equal(task.repair_rounds, 1);
  const repairPrompt = store.get("SELECT packet FROM operations WHERE id = ?", `${id}.T1.implement.3`).packet;
  assert.ok(repairPrompt.constraints.some((c) => c.includes('Blocking verifier finding F1')));
});

test('exit without a structured result retries, then stalls with an explicit blocker until recheck', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: { maxRetriesPerTask: 1 } });
  const { m, store, controller, env, id } = await setup(t, { decl, scenario: { implement: ['no-result', 'no-result', 'commit'] } });
  const blocked = await runUntil(controller, store, id, (c) => c.status === 'blocked-child');
  assert.match(blocked.next_action, /2 failed attempts/);
  const runs = blocked.runs_used;
  for (let i = 0; i < 5; i++) { await controller.tick(); await sleep(30); }
  assert.equal(store.campaign(id).runs_used, runs, 'no dispatch while blocked');
  m.campaignRecheck(store, id, { note: 'investigated' });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 3);
});

test('auth failure raises one B2 blocker and is not retried until recheck', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]] });
  const { m, store, controller, env, id } = await setup(t, { decl, scenario: { implement: ['auth', 'commit'] } });
  const blocked = await runUntil(controller, store, id, (c) => c.status === 'blocked-owner-action');
  assert.equal(blocked.blocker.class, 'B2');
  for (let i = 0; i < 5; i++) { await controller.tick(); await sleep(30); }
  assert.equal(env.calls().length, 1, 'authentication denial is not a retry loop');
  await runUntil(controller, store, id, () => env.comments().some((c) => c.body.includes('Re-authenticate')));
  m.campaignRecheck(store, id);
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.equal(env.comments().filter((c) => c.body.includes('Re-authenticate')).length, 1, 'one deduplicated notification');
});

test('budget cap raises a B3 decision; an authorization amendment resumes without reset', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: { maxWorkerRuns: 1 } });
  const { m, store, controller, env, id } = await setup(t, { decl });
  const blocked = await runUntil(controller, store, id, (c) => c.status === 'blocked-owner-decision');
  assert.equal(blocked.blocker.kind, 'budget');
  assert.equal(blocked.runs_used, 1);
  assert.equal(store.task(id, 'T1').state, 'implemented', `completed work is kept: ${JSON.stringify(store.all('SELECT outcome FROM operations WHERE campaign_id = ?', id))}`);
  m.campaignStart(store, { ...decl, authorization: { ...decl.authorization, version: 2 }, limits: { ...decl.limits, maxWorkerRuns: 2 } });
  const done = await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.equal(done.runs_used, 2);
  assert.deepEqual(env.calls().map((c) => c.role), ['implement', 'verify']);
});

test('a usage limit holds every dispatch campaign-wide and refunds the refused run', { skip: skipWithoutSqlite }, async (t) => {
  const first = declaration().tasks[0];
  const decl = declaration({ tasks: [first, { ...first, id: 'T2', issue: 438, title: 'independent task' }] });
  const { m, store, controller, env, id } = await setup(t, { decl, scenario: { implement: ['quota'] } });
  const waiting = await runUntil(controller, store, id, (c) => /provider usage reset/.test(c.next_action ?? ''));
  assert.equal(waiting.runs_used, 0, 'a refusal that did no work is not a worker run');
  for (let i = 0; i < 5; i++) { await controller.tick(); await sleep(30); }
  assert.equal(env.calls().length, 1, 'the independent task is not dispatched into the same account limit');
  assert.ok(store.all('SELECT kind FROM journal WHERE campaign_id = ?', id).some((row) => row.kind === 'run-refunded'));
  m.campaignRecheck(store, id);
  const done = await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.equal(done.runs_used, 4, 'two implementations and two verifications');
  assert.deepEqual(env.calls().map((c) => c.mode), ['quota', 'commit', 'accept', 'commit', 'accept']);
});

test('an authorization amendment recounts runs from the stored operations, never twice', { skip: skipWithoutSqlite }, async (t) => {
  const m = await load();
  const env = environment();
  const store = new m.Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const decl = declaration({ limits: { maxWorkerRuns: 3 } });
  m.campaignStart(store, decl, 1000);
  const refused = { class: 'quota', detail: 'provider usage/rate limit', receipt: { sessionId: 's', costUsd: 0, usage: null, numTurns: 1, permissionDenials: 0, measured: true } };
  const worked = { ...refused, receipt: { ...refused.receipt, costUsd: 2.26, numTurns: 41 } };
  // Refusals recorded without a refund marker, a run cut off mid-work, an admission-blocked record and a run still in flight.
  [[refused, 'finished'], [refused, 'finished'], [worked, 'finished'], [{ class: 'admission-blocked', detail: 'x' }, 'abandoned'], [null, 'dispatched']]
    .forEach(([outcome, state], i) => store.insert('operations', {
      id: `op${i}`, campaign_id: decl.campaignId, task_id: 'T1', kind: 'implement', seq: i + 1, idempotency_key: `op${i}`, lease_generation: 1,
      state, session_id: `s${i}`, run_dir: 'x', workspace: 'x', packet: {}, packet_digest: 'd', outcome, created_at: 1000, updated_at: 1000,
    }));
  const setRuns = (n) => store.patch('campaigns', { id: decl.campaignId }, store.campaign(decl.campaignId).version, { runs_used: n }, 1000);
  setRuns(2); // already corrected by another recount (no markers): must not be reduced again
  m.campaignStart(store, { ...decl, authorization: { ...decl.authorization, version: 2 } }, 2000);
  assert.equal(store.campaign(decl.campaignId).runs_used, 2, 'the worked run and the in-flight run count; nothing is subtracted twice');
  setRuns(4); // recorded before refunds existed
  m.campaignStart(store, { ...decl, authorization: { ...decl.authorization, version: 3 } }, 3000);
  assert.equal(store.campaign(decl.campaignId).runs_used, 2, 'refusals and the admission-blocked record stop counting');
});

test('usage-limit wording and wall-clock reset times are parsed', { skip: skipWithoutSqlite }, async () => {
  const { claude } = await load();
  const expect = { deliverable: 'report', targetSha: 'a'.repeat(40), reportDigest: 'b'.repeat(64) };
  const refusal = (result, now, extra = {}) => claude.classify({ role: 'implementer', run: { exitCode: 1 }, expect, now, stderrText: '',
    stdoutText: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, session_id: 's', num_turns: 1, total_cost_usd: 0, result, ...extra }) });
  const text = "You've hit your session limit · resets 1:50pm (Asia/Jerusalem)";
  const morning = Date.UTC(2026, 9, 9, 8, 23); // 11:23 in Jerusalem (UTC+3)
  const v = refusal(text, morning);
  assert.equal(v.class, 'quota');
  assert.equal(v.retryAt, Date.UTC(2026, 9, 9, 10, 50) + 60_000, 'the reported reset, not a fixed 30 minutes');
  assert.equal(refusal(text, Date.UTC(2026, 9, 9, 11, 0)).retryAt, Date.UTC(2026, 9, 10, 10, 50) + 60_000, 'a passed reset means the next day');
  assert.equal(refusal("You've hit your session limit · resets 9am (Europe/London)", Date.UTC(2026, 0, 15, 12, 0)).retryAt, Date.UTC(2026, 0, 16, 9, 0) + 60_000);
  assert.equal(refusal("You've hit your session limit · resets 1:50pm (Nowhere/Zone)", morning).retryAt, morning + 30 * 60_000, 'unknown zone keeps the default wait');
  assert.equal(claude.refusedBeforeWork(v), true);
  assert.equal(claude.refusedBeforeWork(refusal(text, morning, { num_turns: 41, total_cost_usd: 2.26 })), false, 'a run that worked before the limit still counts');
  const unmeasured = claude.classify({ role: 'implementer', run: { exitCode: 1 }, expect, now: morning, stdoutText: '', stderrText: 'usage limit' });
  assert.deepEqual([unmeasured.class, claude.refusedBeforeWork(unmeasured)], ['quota', false], 'no measured receipt, no refund');
});

test('a verifier result for another target is never accepted', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]] });
  const { store, controller, id } = await setup(t, { decl, scenario: { verify: ['wrong-target', 'accept'] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const first = store.get('SELECT outcome FROM operations WHERE id = ?', `${id}.T1.verify.2`).outcome;
  assert.equal(first.class, 'invalid-result');
  assert.match(first.detail, /not target/);
});

test('uncommitted work is not accepted as a resolved commit deliverable', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]] });
  const { store, controller, id } = await setup(t, { decl, scenario: { implement: ['dirty', 'commit'] } });
  await runUntil(controller, store, id, (c) => store.task(id, 'T1').attempts >= 2);
  const first = store.get('SELECT outcome FROM operations WHERE id = ?', `${id}.T1.implement.1`).outcome;
  assert.equal(first.class, 'invalid-result');
  assert.match(first.detail, /uncommitted/);
});

test('owner-reserved result blocks only that task and waits for an explicit per-task recheck', { skip: skipWithoutSqlite }, async (t) => {
  const tasks = declaration().tasks;
  const decl = declaration({ tasks: [tasks[0], { ...tasks[1], id: 'T3', dependsOn: [] }] });
  const { m, store, controller, env, id } = await setup(t, { decl, scenario: { implement: ['owner', 'commit', 'commit'] } });
  const blocked = await runUntil(controller, store, id, (c) => c.status === 'blocked-owner-decision');
  assert.equal(store.task(id, 'T3').state, 'done', 'independent work continued');
  assert.equal(store.task(id, 'T1').blocked.class, 'B3');
  m.campaignRecheck(store, id);
  for (let i = 0; i < 5; i++) { await controller.tick(); await sleep(30); }
  assert.equal(store.task(id, 'T1').blocked.class, 'B3', 'a generic recheck does not clear an owner decision');
  m.campaignRecheck(store, id, { task: 'T1', note: 'owner decided on #437' });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.ok(blocked.next_action.includes('owner-reserved'));
  assert.equal(env.calls().filter((c) => c.role === 'implement').length, 3);
});

test('pause stops new dispatch; start resumes', { skip: skipWithoutSqlite }, async (t) => {
  const { m, store, controller, env, id, d } = await setup(t);
  await runUntil(controller, store, id, () => store.task(id, 'T1').state === 'done');
  m.campaignPause(store, id, 'owner pause');
  // A run dispatched in the tick that finished T1 may still be starting, and a slow machine may record its call after any
  // fixed wait. Wait for the event instead: the controller has seen the pause and every run started before it has settled.
  const operations = () => store.all('SELECT id FROM operations WHERE campaign_id = ? ORDER BY id', id).map((op) => op.id);
  const atPause = operations();
  await runUntil(controller, store, id, (c) => c.next_action === 'Paused by the owner; start the campaign again to resume.' ||
    operations().length !== atPause.length);
  assert.deepEqual(operations(), atPause, 'no dispatch while paused');
  const before = env.calls().length;
  for (let i = 0; i < 8; i++) { await controller.tick(); await sleep(40); }
  assert.deepEqual(operations(), atPause, 'no dispatch while paused');
  assert.equal(env.calls().length, before, 'no dispatch while paused');
  assert.equal(m.campaignStatus(store, id).readiness, 'PAUSED');
  m.campaignStart(store, d);
  await runUntil(controller, store, id, (c) => c.control === 'finished');
});

test('cancel terminates the exact owned in-flight run and records it', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]] });
  const { m, store, controller, env, id } = await setup(t, { decl, scenario: { implement: ['hang'] } });
  await runUntil(controller, store, id, () => env.calls().length === 1);
  m.campaignCancel(store, id, 'owner cancel');
  const cancelled = await runUntil(controller, store, id, (c) => c.control === 'cancelled');
  assert.equal(cancelled.next_action, null);
  const op = store.get('SELECT * FROM operations WHERE campaign_id = ?', id);
  assert.equal(op.state, 'abandoned');
  assert.equal(m.campaignStatus(store, id).readiness, 'CANCELLED');
});

test('claude output classification covers the failure classes', { skip: skipWithoutSqlite }, async () => {
  const { claude } = await load();
  const now = 1_700_000_000_000;
  const expect = { deliverable: 'commit', targetSha: 'a'.repeat(40), reportDigest: 'b'.repeat(64) };
  const run = { exitCode: 0 };
  const cls = (stdout, stderr = '', r = run) => claude.classify({ role: 'implementer', run: r, stdoutText: stdout, stderrText: stderr, expect, now }).class;
  assert.equal(cls(''), 'exit-without-result');
  assert.equal(cls('', '', { exitCode: 1 }), 'error');
  assert.equal(cls('', '', { timedOut: true }), 'timeout');
  assert.equal(cls('', '', { spawnError: 'ENOENT' }), 'spawn-failed');
  assert.equal(cls(JSON.stringify({ is_error: true, api_error_status: 401, result: 'x' })), 'auth');
  const quota = claude.classify({ role: 'implementer', run, stdoutText: JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached|1700003600' }), stderrText: '', expect, now });
  assert.deepEqual([quota.class, quota.retryAt], ['quota', 1700003600 * 1000 + 60_000]);
  assert.equal(cls(JSON.stringify({ is_error: false, structured_output: { result: 'resolved', summary: 's', report: 'r' } })), 'invalid-result', 'commit deliverable needs headSha');
  const verify = claude.classify({ role: 'verification', run, expect, now, stderrText: '',
    stdoutText: JSON.stringify({ is_error: false, session_id: 's', structured_output: { verdict: 'accepted', targetSha: 'a'.repeat(40), reportDigest: 'c'.repeat(64), summary: 's', findings: [], checks: [] } }) });
  assert.equal(verify.class, 'invalid-result', 'report digest must match');
  const argv = claude.buildArgv({ command: ['claude'], executor: { model: 'opus', permissionMode: 'auto' }, role: 'implementer', deliverable: 'commit', sessionId: 'u' });
  assert.ok(!argv.includes('--resume') && !argv.includes('--continue') && !argv.includes('bypassPermissions'));
  assert.equal(argv[argv.indexOf('--permission-prompts') + 1], 'none');
});

test('a worker cannot steer later workers through the project settings it commits', { skip: skipWithoutSqlite }, async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const decl = declaration({ tasks: [declaration().tasks[0]] });
  const { store, controller, env, id } = await setup(t, { decl, scenario: { implement: ['commit-settings'] } });
  // The base commit carries Dyk-style tuning; the implementer then commits different values and an executable path.
  mkdirSync(join(env.repo, '.claude'));
  writeFileSync(join(env.repo, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } }));
  execFileSync('git', ['-C', env.repo, 'add', '-A']);
  execFileSync('git', ['-C', env.repo, 'commit', '-q', '-m', 'project tuning']);
  execFileSync('git', ['-C', env.repo, 'push', '-q', 'origin', 'main']);
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const [implement, verify] = env.calls();
  assert.deepEqual([implement.role, implement.subagentModel], ['implement', 'haiku'], 'tuning comes from the base commit');
  assert.deepEqual([verify.role, verify.subagentModel, verify.gitBashPath], ['verify', 'haiku', null],
    'the verifier ignores what the implementer committed: no changed model, no injected executable path');
});

test('a report too long for one GitHub comment is published as report + verification comments, never truncated or blocked', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [{ id: 'R1', issue: 437, title: 'research', deliverable: 'report', goal: 'Research only.', dependsOn: [], acceptance: ['findings posted'], references: ['AGENTS.md'] }] });
  const { store, controller, env, id } = await setup(t, { decl, scenario: { implement: ['report-big'], verify: ['accept-big'] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const posted = env.comments().filter((c) => c.issue === '437');
  assert.equal(posted.length, 2, 'report comment + verification comment');
  assert.ok(posted.every((c) => c.body.length <= 65536));
  assert.ok(posted[0].body.includes('r'.repeat(50000)), 'the full report is preserved');
  assert.ok(posted[0].body.includes('separate supervisor comment on this issue'));
  assert.equal(posted[0].body.includes('VERIFIED-SUMMARY'), false);
  assert.ok(posted[1].body.includes('VERIFIED-SUMMARY') && posted[1].body.includes('check-11'), 'the full verification is preserved');
  assert.equal(store.campaign(id).blocker, null);
  assert.equal(store.task(id, 'R1').pr_url, posted[0].url);
  for (let i = 0; i < 3; i++) await controller.tick();
  assert.equal(env.comments().filter((c) => c.issue === '437').length, 2, 'nothing is posted twice');
});

test('a PR body too long with its verification moves the verification to the first PR comment', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]] });
  const { store, controller, env, id } = await setup(t, { decl, scenario: { implement: ['commit-big'], verify: ['accept-big'] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const [pr] = env.prs();
  assert.ok(pr.body.length <= 65536 && pr.body.includes('r'.repeat(50000)), 'the full report stays in the PR body');
  assert.ok(pr.body.includes('separate supervisor comment on this PR'));
  assert.equal(pr.body.includes('VERIFIED-SUMMARY'), false);
  const prNumber = /\/pull\/(\d+)/.exec(pr.url)[1];
  const onPr = env.comments().filter((c) => c.issue === prNumber);
  assert.equal(onPr.length, 1);
  assert.ok(onPr[0].body.includes('VERIFIED-SUMMARY') && onPr[0].body.includes('check-11') && onPr[0].body.length <= 65536);
  assert.equal(store.campaign(id).blocker, null);
});
