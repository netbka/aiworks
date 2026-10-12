// AIWorks continuous-execution fixes (2026-10-09 Dyk campaign stall): executor unavailability
// versus task failure, no account connectors for Codex workers, provider rotation after a failed
// attempt, report-repair handoff, and the owner's cost ceiling. No model, network or GitHub calls.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { campaignBudget, campaignStart } from '../../src/supervisor/api.mjs';
import { classify, prepare, codexExecutorSetupFailure, codexSandboxProbe, CODEX_DISABLED_FEATURES, runNotCounted } from '../../src/supervisor/adapters/executors.mjs';
import { validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { declaration, environment, runUntil, SQLITE, skipWithoutSqlite } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const chain = { kind: 'cli-chain', providers: [{ kind: 'codex-cli' }, { kind: 'claude-cli', model: 'opus', permissionMode: 'auto' }, { kind: 'cursor-cli' }],
  implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
const digest = 'a'.repeat(64);
const expect = { deliverable: 'report', sessionId: 'bound-run', packetDigest: digest };
const envelope = (value) => ({ runId: expect.sessionId, packetDigest: digest, result: value });
const codex = (value) => [{ type: 'thread.started', thread_id: 'native-thread' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
  { type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 5, output_tokens: 3 } }].map(JSON.stringify).join('\n');
const classifyRun = (stdoutText) => classify({ executorKind: 'codex-cli', role: 'implementer', run: { exitCode: 0 }, stdoutText, stderrText: '', expect, now: 1000 });

function fixture(t) {
  const env = environment();
  const oldHomes = { CODEX_HOME: process.env.CODEX_HOME, CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR };
  for (const key of Object.keys(oldHomes)) process.env[key] = join(env.tmp, key);
  env.config.commands.codex = ['synthetic-codex'];
  env.config.commands.cursor = ['synthetic-cursor'];
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = declaration({ tasks: [{ ...declaration().tasks[0], deliverable: 'report' }] });
  d.executor = structuredClone(chain);
  campaignStart(store, d);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir });
  controller.launch = async () => {};
  t.after(() => {
    controller.release(); store.close(); env.cleanup();
    for (const [key, value] of Object.entries(oldHomes)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  return { env, store, d, controller, id: d.campaignId };
}

test('a Codex sandbox that cannot start any process is executor unavailability, never a task failure', () => {
  const setupFailed = { type: 'item.completed', item: { type: 'command_execution', status: 'failed', exit_code: -1,
    aggregated_output: 'Failed to create unified exec process: helper_unknown_error: setup refresh had errors' } };
  const ran = { type: 'item.completed', item: { type: 'command_execution', status: 'completed', exit_code: 0, aggregated_output: 'ok' } };
  const unavailable = envelope({ result: 'evidence-unavailable', summary: 'local execution failed before any command ran', tried: 'git status' });
  const verdict = classifyRun([JSON.stringify(setupFailed), codex(unavailable)].join('\n'));
  assert.equal(verdict.class, 'unavailable', 'the worker never had a shell: this is the host, not the task');
  assert.ok(verdict.retryAt > 1000, 'the provider is retried after a bounded wait');
  assert.equal(runNotCounted(verdict), true, 'no task attempt took place, so the run is not charged');
  // A command that did run keeps the worker's verdict: evidence-unavailable stays a task outcome.
  assert.equal(classifyRun([JSON.stringify(setupFailed), JSON.stringify(ran), codex(unavailable)].join('\n')).class, 'result');
  assert.equal(codexExecutorSetupFailure([setupFailed, ran]), null);
  // A denied or failed command that ran never becomes unavailability: nothing routes around a denial.
  const denied = { type: 'item.completed', item: { type: 'command_execution', status: 'failed', exit_code: 1, aggregated_output: 'permission denied' } };
  assert.equal(classifyRun([JSON.stringify(denied), codex(unavailable)].join('\n')).class, 'error');
  // The pre-dispatch probe recognises the Windows runtime lock and generic failures; a passing probe returns null.
  const spawn = (result) => () => result;
  assert.equal(codexSandboxProbe(['codex'], { platform: 'win32', spawn: spawn({ status: 0, stdout: 'AIWORKS_CODEX_SANDBOX_OK\n', stderr: '' }) }), null);
  assert.match(codexSandboxProbe(['codex'], { platform: 'win32', spawn: spawn({ status: 1, stdout: '', stderr: 'setup refresh had errors (os error 32)' }) }), /locked by another Codex process/);
  assert.match(codexSandboxProbe(['codex'], { platform: 'win32', spawn: spawn({ status: 3, stdout: '', stderr: 'boom' }) }), /probe failed/);
  assert.equal(codexSandboxProbe(['codex'], { platform: 'linux', spawn: () => { throw new Error('must not spawn'); } }), null);
});

test('Codex workers run without account connectors, multi-agent, browser or computer tools', { skip: skipWithoutSqlite }, (t) => {
  const { env } = fixture(t);
  const runDir = join(env.dataDir, 'apps-off'); mkdirSync(runDir);
  const invocation = prepare({ executor: chain.providers[0], command: ['native-cli'], role: 'implementer', deliverable: 'report',
    sessionId: 'bound-run', digest, runDir, workspace: env.repo, prompt: 'synthetic', repository: 'owner/example', ghCommand: [process.execPath, 'gh.mjs'] });
  const disabled = invocation.argv.flatMap((arg, index) => arg === '--disable' ? [invocation.argv[index + 1]] : []);
  assert.ok(CODEX_DISABLED_FEATURES.includes('apps'));
  for (const feature of ['apps', 'multi_agent', 'computer_use', 'browser_use']) assert.ok(disabled.includes(feature), `--disable ${feature}`);
  assert.ok(invocation.argv.indexOf('--disable') > invocation.argv.indexOf('exec'), 'feature flags are exec options');
  const servers = invocation.argv.filter((arg) => /^mcp_servers\.[^.]+\./.test(arg)).map((arg) => arg.split('.')[1]);
  assert.deepEqual([...new Set(servers)], ['aiworks_repository'], 'aiworks_repository is the only configured MCP server');
});

test('a failed attempt moves the task to the next eligible provider before retrying the same one', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id, d } = fixture(t);
  await controller.tick();
  const first = store.openOperations(id)[0];
  assert.equal(first.executor_kind, 'codex-cli');
  controller.applyOutcome({ id, generation: controller.held.get(id) }, first,
    { class: 'result', value: { result: 'evidence-unavailable', summary: 'no shell', tried: 'git' }, receipt: { sessionId: first.session_id }, exitCode: 0 });
  assert.equal(controller.executorChoice(d, store.task(id, 'T1')).executor.kind, 'claude-cli', 'the next provider gets the retry first');
  store.run("INSERT OR REPLACE INTO executor_waits (campaign_id, executor_kind, retry_at, reason) VALUES (?, 'claude-cli', NULL, 'auth: synthetic')", id);
  store.run("INSERT OR REPLACE INTO executor_waits (campaign_id, executor_kind, retry_at, reason) VALUES (?, 'cursor-cli', NULL, 'unavailable: synthetic')", id);
  assert.equal(controller.executorChoice(d, store.task(id, 'T1')).executor.kind, 'codex-cli', 'the failed provider remains the fallback');
});

test('a permission denial retains provider priority rather than routing around the denial', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id, d } = fixture(t);
  await controller.tick();
  const op = store.openOperations(id)[0];
  controller.applyOutcome({ id, generation: controller.held.get(id) }, op,
    { class: 'error', detail: 'native command permission denied; no provider fallback', receipt: {} });
  assert.equal(controller.executorChoice(d, store.task(id, 'T1')).executor.kind, 'codex-cli');
});

test('an unavailable executor is refunded, waits out a bounded cooldown and hands the task to the next provider', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id } = fixture(t);
  await controller.tick();
  const op = store.openOperations(id)[0];
  controller.applyOutcome({ id, generation: controller.held.get(id) }, op,
    { class: 'unavailable', retryAt: Date.now() + 60_000, detail: 'codex sandbox helper could not start any local process (setup refresh failed)', receipt: {} });
  assert.equal(store.campaign(id).runs_used, 0, 'no task attempt happened, so the run is refunded');
  const wait = store.get("SELECT * FROM executor_waits WHERE campaign_id = ? AND executor_kind = 'codex-cli'", id);
  assert.ok(wait.retry_at > Date.now(), 'a host sandbox failure is a timed wait, not a permanent one');
  await controller.tick();
  assert.equal(store.openOperations(id)[0].executor_kind, 'claude-cli');
  assert.ok(store.all('SELECT kind, detail FROM journal WHERE campaign_id = ?', id).some((row) => row.kind === 'run-refunded' && /unavailable/.test(row.detail.reason)));
});

test('the cost ceiling binds with unreported costs priced conservatively and must be declared explicitly', () => {
  const d = declaration();
  assert.throws(() => validateDeclaration({ ...d, limits: { ...d.limits, maxCostUsd: 100 } }), /unknownRunCostUsd/);
  assert.throws(() => validateDeclaration({ ...d, limits: { ...d.limits, unknownRunCostUsd: 2 } }), /requires maxCostUsd/);
  assert.throws(() => validateDeclaration({ ...d, limits: { ...d.limits, maxCostUsd: 100, unknownRunCostUsd: 0 } }), /never treated as zero/);
  const ok = validateDeclaration({ ...d, limits: { ...d.limits, maxCostUsd: 10, unknownRunCostUsd: 3 } });
  const fakeStore = (ops, open = []) => ({ all: () => ops, openOperations: () => open });
  const campaign = { id: 'c', cost_usd: 4, runs_used: 3, declaration: ok };
  const measured = { class: 'result', receipt: { costUsd: 4 } };
  const unknown = { class: 'result', receipt: { costUsd: null } };
  assert.equal(campaignBudget(fakeStore([{ outcome: measured }, { outcome: unknown }]), campaign).exhausted, null, '4 + 3 < 10');
  assert.match(campaignBudget(fakeStore([{ outcome: measured }, { outcome: unknown }, { outcome: unknown }]), campaign).exhausted, /cost ceiling/);
  assert.equal(campaignBudget(fakeStore([{ outcome: unknown }, { outcome: { class: 'unavailable' } }, { outcome: { class: 'admission-blocked' } }]), campaign).unknownCostRuns, 1, 'refunded runs are not priced');
  assert.match(campaignBudget(fakeStore([]), { ...campaign, runs_used: 12 }).exhausted, /worker-run cap/);
  const uncapped = { ...campaign, runs_used: 100, declaration: { ...ok, limits: { ...ok.limits, maxWorkerRuns: null } } };
  assert.equal(campaignBudget(fakeStore([]), uncapped).exhausted, null, 'uncapped Wiki execution survives the new budget check');
  const live = JSON.parse(readFileSync(new URL('../../campaigns/dyk-443-waves.json', import.meta.url)));
  validateDeclaration(live);
  assert.deepEqual(live.executor.providers.map((p) => p.kind), ['claude-cli', 'codex-cli', 'cursor-cli']);
  assert.equal(live.limits.maxWorkerRuns, null, "owner removed the run cap (authorization v4)");
});

test('a rejected report repair receives the rejected report and a report-only instruction', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [{ id: 'R1', issue: 437, title: 'research', deliverable: 'report', goal: 'Research only.', dependsOn: [], acceptance: ['findings posted'], references: ['AGENTS.md'] }] });
  const env = environment({ scenario: { implement: ['report', 'report'], verify: ['reject', 'accept'] } });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  campaignStart(store, decl);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  const id = decl.campaignId;
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.deepEqual(env.calls().map((c) => c.role), ['implement', 'verify', 'implement', 'verify']);
  const prompt = readFileSync(join(env.dataDir, 'runs', `${id}.R1.implement.3`, 'prompt.txt'), 'utf8');
  const firstSession = env.calls()[0].sessionId;
  assert.ok(prompt.includes('<rejected-report>') && prompt.includes(`session ${firstSession}`), 'the rejected report travels with the repair');
  assert.ok(prompt.includes('Blocking verifier finding F1'), 'findings travel in the packet constraints');
  assert.match(prompt, /corrected COMPLETE report/);
  assert.ok(!/commit, and return resolved with the new headSha/.test(prompt), 'no commit instruction for a report deliverable');
  const first = readFileSync(join(env.dataDir, 'runs', `${id}.R1.implement.1`, 'prompt.txt'), 'utf8');
  assert.ok(!first.includes('<rejected-report>'), 'a first attempt carries no rejected report');
});
