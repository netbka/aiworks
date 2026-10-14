// AIWorks adds steps by itself and closes the outcome (docs/design/WORK_ENVELOPE.md sections 6.2, 6.6 and 9 row 2, slice
// E5; plan STA10; acceptance of #8: "one start, child, verify, restart, finish without the owner"). With adaptive planning
// on, one registered envelope campaign runs to `ready` with no owner action after start: its implementer names a
// follow-up, a planning step adds an in-scope child, the controller is killed right after that amendment commits
// (AIWORKS_FAULT=after-plan-settle) and a new controller finishes the child, and the generated closing check ACCEPT passes
// its own independent verification. Planning runs only on a trigger; a closing check that reports the same uncovered items
// twice with no task finished in between is a B3 owner decision; with the switch off nothing changes.
//
// Synthetic only: a disposable store, origin and clone (helpers.mjs environment), a synthetic worker executable written
// below, and the synthetic gh. No model, network or GitHub call. On Windows every run goes through the real runner and its
// Job Object containment. Elsewhere (Linux CI) runner.mjs refuses to start without that containment, so the same synthetic
// executable is run by a synchronous launch below that writes the runner's result files; everything the controller does
// with them is the same code on both platforms.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as claude from '../../src/supervisor/adapters/claude.mjs';
import { ACCEPT_RULE, classify, FOLLOW_UPS_RULE, PLAN_RULE, stageSchema } from '../../src/supervisor/adapters/executors.mjs';
import { authorityDigest, canonicalJson, validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { declaration, environment, ROOT, runUntil, SQLITE } from './helpers.mjs';
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { campaignStart } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const needsSqlite = SQLITE ? false : 'node:sqlite requires Node >= 22.5';

const CAMPAIGN = 'envelope-e2e';
const OUTCOME = 'People can search the text of their chats.';
const ACCEPTANCE = ['Searching a word finds the message'];
const CHILD = { id: 'C1', issue: 512, title: 'search index', deliverable: 'commit', goal: 'Build the search index the search box reads.',
  dependsOn: ['T1'], acceptance: ['The index finds a stored message by one of its words'], references: ['AGENTS.md'], writes: ['src/search/index/'] };
const sha256 = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

function approved() {
  const v1 = declaration({ campaignId: CAMPAIGN, tasks: [{ id: 'T1', issue: 512, title: 'search box', deliverable: 'commit', goal: 'Add the search box.',
    dependsOn: [], acceptance: ['The search box is shown'], references: ['AGENTS.md'], writes: ['src/chat/ui/'] }] });
  return validateDeclaration({ ...v1, version: 2, envelope: {
    scopeVersion: 1, request: { route: 'goal', pinned: { base: 'a'.repeat(40) } }, outcome: OUTCOME, acceptance: ACCEPTANCE,
    writes: ['src/chat/', 'src/search/'], deliverables: ['commit', 'report'], issues: [512], web: null, release: { mode: 'review-only' }, planning: 'adaptive',
  } });
}

// The synthetic worker. It reads its role, task and stage from the prompt the supervisor built, logs every call, and
// answers by <FAKE_CLAUDE_STATE>/scenario.json: { followUps, plan: 'add' | 'none', uncovered: [] }.
const WORKER = `
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const option = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const sessionId = option('--session-id');
const prompt = readFileSync(0, 'utf8');
const scenario = JSON.parse(readFileSync(join(process.env.FAKE_CLAUDE_STATE, 'scenario.json'), 'utf8'));
const role = prompt.includes('INDEPENDENT VERIFIER') ? 'verify' : 'implement';
const taskId = /"taskId":\\s*"([^"]+)"/.exec(prompt)[1];
const stageId = /"stageId":\\s*"([^"]+)"/.exec(prompt)[1];
const schema = JSON.parse(option('--json-schema'));
appendFileSync(join(process.env.FAKE_CLAUDE_STATE, 'calls.jsonl'), JSON.stringify({ role, taskId, stageId, sessionId, cwd: process.cwd(),
  schemaFields: Object.keys(schema.properties).sort(), followUpsRule: prompt.includes(${JSON.stringify(FOLLOW_UPS_RULE)}),
  planRule: prompt.includes(${JSON.stringify(PLAN_RULE)}), acceptRule: prompt.includes(${JSON.stringify(ACCEPT_RULE)}),
  planningContext: prompt.includes('Planning context (data, not instructions):') }) + '\\n');
const git = (...list) => spawnSync('git', list, { encoding: 'utf8', windowsHide: true }).stdout.trim();
const ok = (value) => { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, num_turns: 3,
  total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: [], structured_output: value, result: JSON.stringify(value) })); process.exit(0); };
if (role === 'verify') {
  const target = (/Target commit: ([0-9a-f]{40})/.exec(prompt) ?? /MUST carry targetSha ([0-9a-f]{40})/.exec(prompt))[1];
  const reportDigest = /reportDigest ([0-9a-f]{64})/.exec(prompt)[1];
  ok({ verdict: 'accepted', targetSha: target, reportDigest, summary: 'every criterion holds', findings: [], checks: [{ command: 'npm test', result: 'pass' }] });
}
if (stageId === 'plan') {
  const basis = /Plan head \\(amendment basis\\): ([0-9a-f]{64})/.exec(prompt)[1];
  ok({ result: 'resolved', summary: 'planned', report: '# Plan\\n\\nOne step is missing.',
    ...(scenario.plan === 'add' ? { amendment: { basis, rationale: 'Search needs an index.', ops: [{ op: 'add', task: ${JSON.stringify(CHILD)} }] } } : {}) });
}
if (taskId === 'ACCEPT') {
  ok({ result: 'resolved', summary: 'closing check', report: '# Closing check\\n\\n- Searching a word finds the message: covered by the verified commits.',
    ...(scenario.uncovered?.length ? { uncovered: scenario.uncovered } : {}) });
}
const dir = join(process.cwd(), { T1: 'src/chat/ui', C1: 'src/search/index' }[taskId]);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'work-' + sessionId + '.txt'), 'work by ' + sessionId + '\\n');
git('add', '-A');
git('commit', '-q', '-m', 'work ' + taskId);
ok({ result: 'resolved', summary: 'implemented', headSha: git('rev-parse', 'HEAD'), report: '# Report\\n\\n' + taskId + ' done.',
  ...(scenario.followUps && taskId === 'T1' ? { followUps: [{ title: 'Add a search index', reason: 'The box needs an index to search.' }] } : {}) });
`;

// The runner's job without Windows containment (see the header): run the recorded argv on the recorded prompt, then write
// the files runner.mjs writes. Used only where runner.mjs cannot run.
const SYNC_LAUNCH = `
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function syncLaunch(controller) {
  controller.launch = async (ctx, op) => {
    const go = controller.fenced(ctx, () => controller.store.get('SELECT state FROM operations WHERE id = ?', op.id)?.state === 'recorded');
    if (!go) return;
    const spec = JSON.parse(readFileSync(join(op.run_dir, 'spec.json'), 'utf8'));
    const startedAt = Date.now();
    writeFileSync(join(op.run_dir, 'launch.json'), JSON.stringify({ operationId: op.id, at: startedAt }));
    writeFileSync(join(op.run_dir, 'runner.json'), JSON.stringify({ pid: process.pid, startedAt }));
    const run = spawnSync(spec.argv[0], spec.argv.slice(1), { input: readFileSync(join(op.run_dir, 'prompt.txt')), cwd: spec.cwd,
      env: { ...process.env, ...(spec.env ?? {}) }, encoding: 'utf8', windowsHide: true, timeout: spec.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(join(op.run_dir, 'stdout.json'), run.stdout ?? '');
    writeFileSync(join(op.run_dir, 'stderr.log'), run.stderr ?? '');
    writeFileSync(join(op.run_dir, 'result.json'), JSON.stringify({ exitCode: run.status, timedOut: false, containment: 'windows-job-v1',
      containmentStopped: true, startedAt, endedAt: Date.now() }));
    controller.fenced(ctx, () => controller.store.updateOperation(op.id, { state: 'dispatched' }, controller.now()));
  };
}
`;

// One controller process, as \`cli.mjs serve\` runs it: tick until the fault hook ends it (process.exit 86) or time runs out.
const PROCESS = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [dataDir, launchModule] = process.argv.slice(2);
const { Store } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/supervisor/store.mjs')).href)});
const { Controller } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/supervisor/controller.mjs')).href)});
const store = new Store(join(dataDir, 'supervisor.db'));
const controller = new Controller({ store, config: JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')), dataDir });
if (launchModule !== '-') (await import(launchModule)).syncLaunch(controller);
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) { await controller.tick(); await new Promise((done) => setTimeout(done, 40)); }
process.exit(2);
`;

/** A registered envelope campaign with the synthetic worker, and helpers to read what happened. */
function rig(t, { scenario, planning = true }) {
  const tools = mkdtempSync(join(tmpdir(), 'aiworks-envelope-e2e-'));
  writeFileSync(join(tools, 'worker.mjs'), WORKER);
  writeFileSync(join(tools, 'sync-launch.mjs'), SYNC_LAUNCH);
  writeFileSync(join(tools, 'controller.mjs'), PROCESS);
  const env = environment({ scenario, config: {
    ...(planning ? { adaptivePlanning: { enabled: true } } : {}),
    commands: { claude: [process.execPath, join(tools, 'worker.mjs')], gh: [process.execPath, join(ROOT, 'tests', 'supervisor', 'fixtures', 'fake-gh.mjs')] },
  } });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); rmSync(tools, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const decl = approved();
  campaignStart(store, decl);
  const launchModule = process.platform === 'win32' ? null : pathToFileURL(join(tools, 'sync-launch.mjs')).href;
  const controller = async () => {
    const instance = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
    if (launchModule) (await import(launchModule)).syncLaunch(instance);
    return instance;
  };
  return {
    env, store, decl, controller,
    /** Run a separate controller process with AIWORKS_FAULT set; it returns when the fault ends it. */
    crashAt: (fault) => {
      const childEnv = { ...process.env, AIWORKS_FAULT: fault };
      delete childEnv.NODE_TEST_CONTEXT;
      return spawnSync(process.execPath, ['--no-warnings', join(tools, 'controller.mjs'), env.dataDir, launchModule ?? '-'],
        { env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    },
    operations: () => store.all('SELECT * FROM operations WHERE campaign_id = ? ORDER BY created_at, id', CAMPAIGN),
    journal: (kind) => store.all('SELECT detail FROM journal WHERE campaign_id = ? AND kind = ? ORDER BY seq', CAMPAIGN, kind).map((row) => row.detail),
    calls: () => readFileSync(join(env.tmp, 'claude', 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
}
const ownerActions = (store) => store.get('SELECT COUNT(*) AS n FROM events WHERE campaign_id = ?', CAMPAIGN).n;

test('#8 acceptance: one start, an in-scope child is planned, survives a restart, is verified, and the closing check passes without the owner', { skip: needsSqlite, timeout: 300_000 }, async (t) => {
  const r = rig(t, { scenario: { followUps: true, plan: 'add' } });

  // The first controller runs T1 (whose implementer names a follow-up), then the planning step, and is killed the moment
  // the planning operation and its amendment have committed together.
  const crashed = r.crashAt('after-plan-settle');
  assert.equal(crashed.status, 86, `the controller ended at the fault hook: ${crashed.stderr}`);
  const plans = r.operations().filter((op) => op.kind === 'plan');
  assert.equal(plans.length, 1, 'one planning step');
  assert.equal(plans[0].state, 'finished');
  assert.deepEqual([plans[0].task_id, plans[0].packet.stageId, plans[0].packet.role, plans[0].packet.access], ['PLAN', 'plan', 'implementer', 'read-only']);
  assert.deepEqual(r.journal('plan-triggered').map((entry) => [entry.trigger, entry.task]), [['follow-ups', 'T1']], 'triggered by the follow-up only');
  const amendment = r.store.get('SELECT * FROM plan_amendments WHERE campaign_id = ?', CAMPAIGN);
  assert.deepEqual([amendment.seq, amendment.source_operation, amendment.ops.map((op) => op.task.id)], [1, plans[0].id, ['C1']]);
  assert.equal(r.store.task(CAMPAIGN, 'C1').state, 'pending', 'the child is admitted and waits to run');
  assert.ok(!r.operations().some((op) => op.task_id === 'C1'), 'nothing of the child ran before the crash');
  assert.equal(r.store.task(CAMPAIGN, 'PLAN').state, 'done', 'the follow-up is settled with the amendment');

  // A new controller takes over once the dead holder's lease expires, and finishes the campaign on its own.
  r.store.run('UPDATE leases SET expires_at = 0 WHERE campaign_id = ?', CAMPAIGN);
  const controller = await r.controller();
  const finished = await runUntil(controller, r.store, CAMPAIGN, (c) => c.control === 'finished', { timeoutMs: 180_000 });
  controller.release();
  assert.equal(finished.status, 'ready');
  assert.deepEqual(r.store.tasks(CAMPAIGN).map((row) => [row.task_id, row.state]),
    [['T1', 'done'], ['ACCEPT', 'done'], ['PLAN', 'done'], ['C1', 'done']]);
  assert.equal(ownerActions(r.store), 0, 'zero owner actions after start');
  assert.deepEqual(r.journal('blocker-raised'), [], 'no blocker');
  assert.equal(r.store.all('SELECT COUNT(*) AS n FROM plan_amendments WHERE campaign_id = ?', CAMPAIGN)[0].n, 1, 'admitted once across the restart');
  assert.equal(r.journal('amendment-admitted').length, 1);
  assert.equal(r.operations().filter((op) => op.kind === 'plan').length, 1, 'no further planning without a further trigger');

  // The child ran with its own binding and an independent verifier of its exact head in a separate checkout.
  const ops = r.operations();
  const [childImplement] = ops.filter((op) => op.task_id === 'C1' && op.kind === 'implement');
  const [childVerify] = ops.filter((op) => op.task_id === 'C1' && op.kind === 'verify');
  assert.equal(childImplement.packet.authorityDigest, sha256({ authority: authorityDigest(r.decl), amendment: amendment.digest }));
  assert.equal(childVerify.target_sha, r.store.task(CAMPAIGN, 'C1').verified_sha);
  assert.equal(childVerify.target_sha, childImplement.outcome.value.headSha);
  assert.notEqual(childVerify.workspace, childImplement.workspace, 'the verifier reads a separate checkout');
  // The closing check reads the original acceptance verbatim and depends on every other step; its verifier is fresh.
  const [acceptImplement] = ops.filter((op) => op.task_id === 'ACCEPT' && op.kind === 'implement');
  const [acceptVerify] = ops.filter((op) => op.task_id === 'ACCEPT' && op.kind === 'verify');
  assert.deepEqual(acceptImplement.packet.acceptance, ACCEPTANCE);
  assert.ok(ops.indexOf(acceptImplement) > ops.indexOf(childVerify), 'the closing check ran after the child was verified');
  assert.equal(new Set(ops.map((op) => op.session_id)).size, ops.length, 'every run is a fresh session');
  assert.notEqual(acceptVerify.session_id, acceptImplement.session_id);
  // Each worker was told its stage and given its stage's schema; the planner got the planning context.
  const calls = r.calls();
  assert.deepEqual(calls.map((call) => `${call.role}:${call.taskId}`),
    ['implement:T1', 'verify:T1', 'implement:PLAN', 'implement:C1', 'verify:C1', 'implement:ACCEPT', 'verify:ACCEPT']);
  const call = (role, taskId) => calls.find((item) => item.role === role && item.taskId === taskId);
  assert.ok(call('implement', 'T1').followUpsRule && call('implement', 'T1').schemaFields.includes('followUps'));
  assert.ok(call('implement', 'PLAN').planRule && call('implement', 'PLAN').planningContext && call('implement', 'PLAN').schemaFields.includes('amendment'));
  assert.ok(call('implement', 'ACCEPT').acceptRule && call('implement', 'ACCEPT').schemaFields.includes('uncovered'));
  // Published for review, never merged: two PRs and the closing report on the tracking issue.
  assert.deepEqual(r.env.prs().map((pr) => pr.head).sort(), [`campaign/${CAMPAIGN}/C1`, `campaign/${CAMPAIGN}/T1`]);
  assert.ok(r.env.prs().every((pr) => !pr.merged));
  const closing = r.env.comments().filter((comment) => comment.body.includes('ACCEPT: Closing check'));
  assert.deepEqual(closing.map((comment) => comment.issue), [String(r.decl.target.trackingIssue)]);
});

test('no planning operation without a trigger: the closing check passes and the campaign finishes', { skip: needsSqlite, timeout: 300_000 }, async (t) => {
  const r = rig(t, { scenario: { followUps: false } });
  const controller = await r.controller();
  const finished = await runUntil(controller, r.store, CAMPAIGN, (c) => c.control === 'finished', { timeoutMs: 180_000 });
  controller.release();
  assert.equal(finished.status, 'ready');
  assert.deepEqual(r.operations().filter((op) => op.kind === 'plan'), [], 'no planning operation');
  assert.deepEqual(r.journal('plan-triggered'), []);
  assert.ok(!r.store.task(CAMPAIGN, 'PLAN'), 'no planning row either');
  assert.deepEqual(r.store.tasks(CAMPAIGN).map((row) => [row.task_id, row.state]), [['T1', 'done'], ['ACCEPT', 'done']]);
  assert.deepEqual(r.calls().map((call) => `${call.role}:${call.taskId}`), ['implement:T1', 'verify:T1', 'implement:ACCEPT', 'verify:ACCEPT']);
  assert.equal(ownerActions(r.store), 0);
});

test('two identical uncovered closing checks with no task finished in between raise one B3 owner decision', { skip: needsSqlite, timeout: 300_000 }, async (t) => {
  const r = rig(t, { scenario: { followUps: false, plan: 'none', uncovered: ACCEPTANCE } });
  const controller = await r.controller();
  await runUntil(controller, r.store, CAMPAIGN, () => Boolean(r.store.task(CAMPAIGN, 'ACCEPT')?.blocked), { timeoutMs: 180_000 });
  await controller.tick(); // the status of the held campaign is refreshed
  controller.release();
  const accept = r.store.task(CAMPAIGN, 'ACCEPT');
  assert.equal(accept.blocked.class, 'B3');
  assert.equal(accept.blocked.reason, `This can't be finished within what you approved: ${ACCEPTANCE[0]}`);
  assert.equal(accept.state, 'pending', 'an uncovered closing check does not pass');
  assert.deepEqual(r.journal('closing-uncovered').map((entry) => [entry.items, entry.done, entry.repeated]),
    [[ACCEPTANCE, 1, false], [ACCEPTANCE, 1, true]]);
  // The first report triggered exactly one planning step; it proposed nothing, so the check ran again and held.
  assert.deepEqual(r.journal('plan-triggered').map((entry) => [entry.trigger, entry.items]), [['uncovered', ACCEPTANCE]]);
  assert.deepEqual(r.operations().map((op) => `${op.kind}:${op.task_id}`),
    ['implement:T1', 'verify:T1', 'implement:ACCEPT', 'plan:PLAN', 'implement:ACCEPT']);
  assert.equal(r.journal('plan-no-change').length, 1);
  assert.equal(r.store.campaign(CAMPAIGN).status, 'blocked-owner-decision');
  assert.notEqual(r.store.campaign(CAMPAIGN).control, 'finished');
  assert.equal(ownerActions(r.store), 0);
});

test('with adaptive planning off an envelope campaign runs exactly as before: no closing check, today\'s schema and prompt', { skip: needsSqlite, timeout: 300_000 }, async (t) => {
  const r = rig(t, { scenario: { followUps: false }, planning: false });
  const controller = await r.controller();
  const finished = await runUntil(controller, r.store, CAMPAIGN, (c) => c.control === 'finished', { timeoutMs: 180_000 });
  controller.release();
  assert.equal(finished.status, 'ready');
  assert.deepEqual(r.store.tasks(CAMPAIGN).map((row) => [row.task_id, row.state]), [['T1', 'done']], 'no generated task');
  assert.deepEqual(r.operations().map((op) => `${op.kind}:${op.task_id}`), ['implement:T1', 'verify:T1']);
  for (const call of r.calls()) {
    assert.ok(!call.followUpsRule && !call.planRule && !call.acceptRule, 'no stage rule in the prompt');
    const base = call.role === 'verify' ? claude.VERIFIER_SCHEMA : claude.IMPLEMENTER_SCHEMA;
    assert.deepEqual(call.schemaFields, Object.keys(base.properties).sort(), 'today\'s terminal schema');
  }
  for (const op of r.operations()) {
    const spec = JSON.parse(readFileSync(join(op.run_dir, 'spec.json'), 'utf8'));
    const schema = spec.argv[spec.argv.indexOf('--json-schema') + 1];
    assert.equal(schema, JSON.stringify(op.kind === 'verify' ? claude.VERIFIER_SCHEMA : claude.IMPLEMENTER_SCHEMA));
  }
});

// ---- executors.mjs: the plan-stage schema and optional followUps (pure; no process). ----
const DIGEST = 'a'.repeat(64);
const EXPECT = { deliverable: 'report', sessionId: 'bound-run', packetDigest: DIGEST };
const claudeOut = (value) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'bound-run', num_turns: 2,
  total_cost_usd: 0.01, permission_denials: [], structured_output: value, result: JSON.stringify(value) });
const codexOut = (value) => [{ type: 'thread.started', thread_id: 'native-thread' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ runId: 'bound-run', packetDigest: DIGEST, result: value }) } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }].map(JSON.stringify).join('\n');
const run = (executorKind, stdoutText, stage, role = 'implementer') => classify({ executorKind, role, run: { exitCode: 0 }, stdoutText, stderrText: '',
  expect: role === 'verification' ? { ...EXPECT, targetSha: 'b'.repeat(40), reportDigest: DIGEST } : EXPECT, now: 1000, stage });
const RESOLVED = { result: 'resolved', summary: 'synthetic', report: 'synthetic report' };
const FOLLOW = [{ title: 'Add an index', reason: 'The search box needs one.' }];

test('without a stage the terminal schema and validation are today\'s: an extra field is still an invalid result', () => {
  assert.equal(stageSchema('implementer'), claude.IMPLEMENTER_SCHEMA);
  assert.equal(stageSchema('verification', null), claude.VERIFIER_SCHEMA);
  assert.equal(run('claude-cli', claudeOut({ ...RESOLVED, followUps: FOLLOW }), null).class, 'invalid-result');
  assert.equal(run('codex-cli', codexOut({ ...RESOLVED, amendment: { basis: DIGEST, ops: [{ op: 'cancel' }] } }), null).class, 'invalid-result');
  assert.equal(run('claude-cli', claudeOut(RESOLVED), null).class, 'result');
});

test('with a stage, followUps, amendment and uncovered are optional, validated, and returned with the result', () => {
  for (const kind of ['claude-cli', 'codex-cli']) {
    const out = kind === 'claude-cli' ? claudeOut : codexOut;
    const work = run(kind, out({ ...RESOLVED, followUps: FOLLOW }), 'work');
    assert.equal(work.class, 'result', work.detail);
    assert.deepEqual(work.value.followUps, FOLLOW);
    assert.equal(run(kind, out(RESOLVED), 'work').class, 'result', 'followUps stay optional');
    assert.equal(run(kind, out({ ...RESOLVED, followUps: [{ title: 'no reason' }] }), 'work').class, 'invalid-result');
    assert.equal(run(kind, out({ ...RESOLVED, amendment: { basis: DIGEST, ops: [{ op: 'add' }] } }), 'work').class, 'invalid-result', 'only a planning step proposes');
    const amendment = { basis: DIGEST, ops: [{ op: 'add', task: { id: 'C1', permissionMode: 'bypassPermissions' } }], rationale: 'why' };
    const plan = run(kind, out({ ...RESOLVED, amendment }), 'plan');
    assert.equal(plan.class, 'result', plan.detail);
    assert.deepEqual(plan.value.amendment, amendment, 'ops reach admission whole, so a widening is refused there by name');
    assert.equal(run(kind, out({ ...RESOLVED, amendment: { basis: 'stale', ops: [] } }), 'plan').class, 'invalid-result');
    const accept = run(kind, out({ ...RESOLVED, uncovered: ['item'] }), 'accept');
    assert.deepEqual(accept.value.uncovered, ['item']);
    const verify = run(kind, out({ verdict: 'accepted', targetSha: 'b'.repeat(40), reportDigest: DIGEST, summary: 'ok', findings: [], checks: [], followUps: FOLLOW }), 'work', 'verification');
    assert.equal(verify.class, 'result', verify.detail);
    assert.deepEqual(verify.value.followUps, FOLLOW, 'verifiers may name follow-ups too');
  }
  // Codex marks every optional field nullable; a null stage field is no field.
  const nulls = run('codex-cli', codexOut({ ...RESOLVED, headSha: null, evidence: null, ownerTrigger: null, tried: null, amendment: null }), 'plan');
  assert.equal(nulls.class, 'result', nulls.detail);
  assert.ok(!Object.hasOwn(nulls.value, 'amendment'));
});
