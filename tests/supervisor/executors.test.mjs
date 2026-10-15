import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { campaignPause, campaignRecheck, campaignStart, campaignStatus } from '../../src/supervisor/api.mjs';
import { buildPrompt, classify, GATE_RULES, prepare, refusedBeforeWork, unavailableReason, roleUnavailableReason, VERIFIER_TALLY_RULE } from '../../src/supervisor/adapters/executors.mjs';
import * as agy from '../../src/supervisor/adapters/agy.mjs';
import { CaamError, caamProfileEnv, ensureShallowProfile, shallowHomeOf } from '../../src/supervisor/adapters/caam.mjs';
import * as claude from '../../src/supervisor/adapters/claude.mjs';
import { scopeDigest, validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { route } from '../../src/supervisor/router.mjs';
import { declaration, environment, SQLITE, skipWithoutSqlite } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const chain = { kind: 'cli-chain', providers: [{ kind: 'codex-cli' }, { kind: 'claude-cli', model: 'opus', permissionMode: 'auto' }, { kind: 'cursor-cli' }],
  implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
const digest = 'a'.repeat(64);
const expect = { deliverable: 'report', sessionId: 'bound-run', packetDigest: digest };
const terminal = { result: 'resolved', summary: 'synthetic', report: 'synthetic report' };
const envelope = (value = terminal, changes = {}) => ({ runId: expect.sessionId, packetDigest: digest, result: value, ...changes });
const codex = (value) => [{ type: 'thread.started', thread_id: 'native-thread' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
  { type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 5, output_tokens: 3 } }].map(JSON.stringify).join('\n');
const cursor = (value) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-cursor', result: JSON.stringify(value) });
const classifyRun = (executorKind, stdoutText, options = {}) => classify({ executorKind, role: 'implementer', run: { exitCode: 0 },
  stdoutText, stderrText: '', expect, now: 1000, ...options });

test('a policy probe reporting absence with a nonterminating error cannot admit Claude research', { skip: process.platform !== 'win32' }, () => {
  const original = childProcess.spawnSync;
  try {
    childProcess.spawnSync = (_command, argv) => {
      const script = Buffer.from(argv.at(-1), 'base64').toString('utf16le');
      assert.match(script, /ErrorActionPreference = 'Stop'/);
      assert.match(script, /-ErrorAction Stop/);
      return { status: 0, stdout: 'False\r\n', stderr: 'Registry provider access failed' };
    };
    syncBuiltinESMExports();
    assert.match(unavailableReason({ kind: 'claude-cli', researchOnly: true }, '.'), /Managed Claude/);
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
});

test('native results require terminal completion, fresh identity and exact nonce/packet binding', () => {
  for (const [kind, output] of [['codex-cli', codex], ['cursor-cli', cursor]]) {
    const result = classifyRun(kind, output(envelope()));
    assert.equal(result.class, 'result');
    assert.equal(result.receipt.sessionId, 'bound-run');
    assert.ok(result.receipt.nativeSessionId.startsWith('native-'));
    assert.equal(result.receipt.costUsd, null, 'unreported cost stays unknown');
    for (const changed of [{ runId: 'stale' }, { packetDigest: 'b'.repeat(64) }, { extra: true }]) {
      assert.equal(classifyRun(kind, output(envelope(terminal, changed))).class, 'invalid-result');
    }
    assert.equal(classifyRun(kind, output(envelope({ ...terminal, report: undefined }))).class, 'invalid-result');
    assert.equal(classifyRun(kind, output(envelope({ ...terminal, extra: null }))).class, 'invalid-result');
    assert.equal(classifyRun(kind, output(envelope({ ...terminal, summary: null }))).class, 'invalid-result');
    assert.equal(classifyRun(kind, output(envelope({ ...terminal, headSha: null }))).class, 'result');
    assert.equal(classifyRun(kind, output(envelope()), { stderrText: 'rate limit; retry recovered' }).class, 'result');
    assert.equal(classifyRun(kind, output(envelope()), { run: { exitCode: 1 } }).class, 'error');
  }
  assert.equal(classifyRun('codex-cli', codex(envelope()).split('\n').slice(0, -1).join('\n')).class, 'exit-without-result');
  assert.equal(classifyRun('codex-cli', codex(envelope()) + '\n' + JSON.stringify({ type: 'thread.started', thread_id: 'other' })).class, 'exit-without-result');
});

test('quota and authentication may trigger fallback; denied actions may not', () => {
  const quota = { class: 'quota', receipt: { measured: true, costUsd: 0, numTurns: 1 } };
  assert.equal(refusedBeforeWork(quota), true, 'legacy Claude refund remains supported');
  for (const kind of ['codex-cli', 'cursor-cli']) {
    assert.equal(refusedBeforeWork({ ...quota, executorKind: kind, receipt: { measured: true, costUsd: null } }), false);
  }
  for (const kind of ['codex-cli', 'claude-cli', 'cursor-cli']) {
    assert.equal(classifyRun(kind, '', { run: { spawnError: 'EACCES' } }).class, 'error');
  }
  for (const kind of ['codex-cli', 'cursor-cli']) {
    const failure = (message) => classifyRun(kind, '', { run: { exitCode: 1 }, stderrText: message });
    assert.equal(failure('You have hit your session limit').class, 'quota');
    assert.equal(failure('not logged in; please login').class, 'auth');
    assert.equal(failure('permission denied; authentication required').class, 'error');
    assert.equal(failure('sandbox command blocked').class, 'error');
    assert.equal(failure('CreateProcess rejected: blocked by policy\nYou have hit your session limit').class, 'error');
    assert.equal(failure('failed tests').class, 'error');
  }
  assert.equal(classifyRun('cursor-cli', '', { run: { exitCode: 1 }, stderrText:
    'Error: Sandbox mode is enabled but not available on this system. Sandbox requires macOS or Linux.' }).class, 'unavailable');
});

test('executor declarations reject duplicate, sparse and bypass choices', () => {
  const d = declaration();
  assert.equal(validateDeclaration({ ...d, executor: chain }).executor, chain);
  for (const providers of [[{ kind: 'codex-cli' }, { kind: 'codex-cli' }], new Array(1), [{ kind: 'cursor-cli', permissionMode: 'bypassPermissions' }]]) {
    assert.throws(() => validateDeclaration({ ...d, executor: { ...chain, providers } }), /invalid campaign/);
  }
});

test('credit exhaustion falls back for each provider; permission denial and recovered warnings do not', () => {
  for (const kind of ['codex-cli', 'claude-cli', 'cursor-cli']) {
    for (const message of ['Your credit balance is too low', 'insufficient credits', 'billing_hard_limit_reached']) {
      const error = { run: { exitCode: 1 }, stderrText: message };
      const verdict = classifyRun(kind, '', error);
      assert.equal(verdict.class, 'quota'); assert.match(verdict.detail, /credits\/billing/);
      assert.equal(classifyRun(kind, '', { ...error, stderrText: `permission denied; ${message}` }).class, 'error');
    }
  }
  const success = JSON.stringify({ is_error: false, structured_output: terminal, session_id: 'bound-run' });
  assert.equal(classifyRun('claude-cli', success, { stderrText: 'rate limit warning recovered' }).class, 'result');
  assert.equal(classifyRun('claude-cli', JSON.stringify({ is_error: true, api_error_status: 403, result: 'quota exceeded' })).class, 'error');
  assert.equal(classifyRun('claude-cli', JSON.stringify({ is_error: true, permission_denials: [{}], result: 'insufficient credits' })).class, 'error');
});

test('owner campaign priority and role support are explicit', () => {
  const campaign = JSON.parse(readFileSync(new URL('../../tests/fixtures/campaigns/sample-chain.json', import.meta.url)));
  validateDeclaration(campaign);
  assert.deepEqual(campaign.executor.providers.map((p) => p.kind), ['claude-cli', 'codex-cli', 'cursor-cli']);
  assert.match(roleUnavailableReason({ kind: 'codex-cli' }, 'implementer', 'commit', 'win32'), /shared Git/);
  assert.equal(roleUnavailableReason({ kind: 'codex-cli' }, 'implementer', 'report', 'win32'), null);
});

test('Codex never verifies a commit task on Windows; report tasks and other platforms are unchanged (#113)', () => {
  const codex = { kind: 'codex-cli' };
  const reason = roleUnavailableReason(codex, 'verification', 'commit', 'win32');
  assert.equal(reason, "Codex cannot run the repository's tests in its read-only sandbox on Windows");
  assert.doesNotMatch(reason, /codex-cli|[a-z]+[A-Z]\w*|_/, 'owner-readable: no internal identifier');
  assert.equal(roleUnavailableReason(codex, 'verification', 'report', 'win32'), null);
  for (const platform of ['linux', 'darwin']) {
    assert.equal(roleUnavailableReason(codex, 'verification', 'commit', platform), null, platform);
    assert.equal(roleUnavailableReason(codex, 'implementer', 'commit', platform), null, platform);
  }
  for (const kind of ['claude-cli', 'cursor-cli']) assert.equal(roleUnavailableReason({ kind }, 'verification', 'commit', 'win32'), null, kind);
  const chain = (deliverable, platform) => route({ stage: 'verify', chain: true, task: { deliverable, web: false }, platform,
    candidates: [{ kind: 'codex-cli', model: null }, { kind: 'claude-cli', model: 'opus' }],
    hostFacts: ['codex-cli', 'claude-cli'].map((kind) => ({ kind, cliConfigured: true, hostUnavailable: false, wait: null })),
    escalation: { priorAttempts: [] } });
  assert.equal(chain('commit', 'win32').chosen.kind, 'claude-cli', 'the chain skips Codex for a commit verification on Windows');
  assert.ok(chain('commit', 'win32').eligibility.some((e) => e.kind === 'codex-cli' && e.role === 'verification' && e.reasons.includes('role-unsupported')));
  assert.equal(chain('report', 'win32').chosen.kind, 'codex-cli');
  assert.equal(chain('commit', 'linux').chosen.kind, 'codex-cli');
  assert.equal(chain('commit', 'darwin').chosen.kind, 'codex-cli');
});

test('native tool refusals before quota or completion cannot trigger provider fallback', () => {
  for (const item of [
    { type: 'mcp_tool_call', server: 'aiworks_repository', tool: 'read', status: 'failed', error: { message: 'HTTP 403' } },
    { type: 'command_execution', status: 'declined', aggregated_output: '' },
    { type: 'command_execution', status: 'completed', exit_code: 128, aggregated_output: 'index.lock: Permission denied' },
  ]) {
    const tool = JSON.stringify({ type: 'item.completed', item }) + '\n';
    assert.equal(classifyRun('codex-cli', tool + JSON.stringify({ type: 'turn.failed', error: { message: 'session limit' } })).class, 'error');
    assert.equal(classifyRun('codex-cli', tool + codex(envelope())).class, 'error');
  }
  assert.match(unavailableReason({ kind: 'codex-cli' }, '.', ['gh']), /absolute/);
});

test('Codex gets one required repository reader with immutable scope and no global configuration', { skip: skipWithoutSqlite }, (t) => {
  const { env } = fixture(t);
  const runDir = join(env.dataDir, 'reader'); mkdirSync(runDir);
  const invocation = prepare({ executor: chain.providers[0], command: ['native-cli'], role: 'verification', deliverable: 'report',
    sessionId: 'd0e4fd84-a8ea-4400-842e-e80cf6c4a130', digest, runDir, workspace: env.repo, prompt: 'synthetic',
    repository: 'owner/example', ghCommand: [process.execPath, 'synthetic-gh.mjs'] });
  assert.ok(invocation.argv.includes('mcp_servers.aiworks_repository.required=true'));
  assert.ok(invocation.argv.includes('mcp_servers.aiworks_repository.enabled_tools=["read"]'));
  const args = JSON.parse(invocation.argv.find((v) => v.startsWith('mcp_servers.aiworks_repository.args=')).split('=').slice(1).join('='));
  assert.match(args[0], /github-reader.mjs$/);
  assert.equal(JSON.parse(args[1]).repository, 'owner/example');
  assert.match(invocation.prompt, /identity|verify scope/);
  const research = prepare({ executor: { ...chain.providers[0], researchOnly: true }, command: ['native-cli'],
    role: 'implementer', deliverable: 'report', sessionId: 'd0e4fd84-a8ea-4400-842e-e80cf6c4a130', digest,
    runDir, workspace: env.repo, prompt: 'synthetic', repository: 'owner/example', ghCommand: [process.execPath, 'synthetic-gh.mjs'] });
  assert.ok(research.argv.includes('features.apps=false'));
  assert.ok(research.argv.includes('mcp_servers.aiworks_repository.enabled_tools=["read"]'));
  assert.notEqual(research.cwd, env.repo);
  const claudeResearch = prepare({ executor: { ...chain.providers[1], researchOnly: true }, command: ['native-cli'],
    role: 'implementer', deliverable: 'report', sessionId: 'd0e4fd84-a8ea-4400-842e-e80cf6c4a130', digest,
    runDir, workspace: env.repo, prompt: 'synthetic', repository: 'owner/example', ghCommand: [process.execPath, 'synthetic-gh.mjs'] });
  const servers = JSON.parse(claudeResearch.argv[claudeResearch.argv.indexOf('--mcp-config') + 1]).mcpServers;
  assert.deepEqual(Object.keys(servers), []);
  assert.ok(claudeResearch.argv.includes('--safe-mode'));
});

function fixture(t, maxWorkerRuns = 12, tasks, repository = 'example-org/sampleapp') {
  const env = environment();
  const oldHomes = { CODEX_HOME: process.env.CODEX_HOME, CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR };
  for (const key of Object.keys(oldHomes)) process.env[key] = join(env.tmp, key);
  t.after(() => { for (const [key, value] of Object.entries(oldHomes)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  env.config.commands.codex = ['synthetic-codex'];
  env.config.commands.cursor = ['synthetic-cursor'];
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = declaration({ tasks: tasks ?? [{ ...declaration().tasks[0], deliverable: 'report' }], limits: { maxWorkerRuns } });
  d.target.repository = repository;
  env.config.repositories[repository] = env.config.repositories['example-org/sampleapp'];
  d.executor = structuredClone(chain);
  campaignStart(store, d);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir });
  controller.launch = async () => {}; // Exercise durable dispatch without an external model process.
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  return { env, store, d, controller, id: d.campaignId };
}

test('fallback is ordered, durable across restart and charges each recorded operation', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, d, controller, id } = fixture(t);
  await controller.tick();
  for (const kind of ['codex-cli', 'claude-cli', 'cursor-cli']) {
    const op = store.openOperations(id)[0];
    assert.equal(op.executor_kind, kind);
    const ctx = { id, generation: controller.held.get(id) };
    controller.applyOutcome(ctx, op, { class: 'quota', retryAt: Date.now() + 60_000, detail: 'synthetic quota', receipt: {} });
    const replacement = new Controller({ store, config: env.config, dataDir: env.dataDir });
    assert.equal(replacement.executorChoice(d, store.task(id, 'T1')).executor?.kind ?? null,
      kind === 'codex-cli' ? 'claude-cli' : kind === 'claude-cli' ? 'cursor-cli' : null);
    await controller.tick();
  }
  assert.equal(store.campaign(id).runs_used, 3);
  assert.equal(store.openOperations(id).length, 0);
  assert.ok(store.task(id, 'T1').retry_at > Date.now());
  assert.equal(store.campaign(id).liveness_defect, 0);
  campaignRecheck(store, id);
  await controller.tick();
  assert.equal(store.openOperations(id)[0].executor_kind, 'codex-cli', 'explicit recheck clears provider waits');
});

test('extension preflight stops at checkout boundary and rejects local/global execution settings', { skip: skipWithoutSqlite }, (t) => {
  const { env } = fixture(t);
  mkdirSync(join(env.tmp, '.codex'));
  writeFileSync(join(env.tmp, '.codex/config.toml'), 'synthetic ancestor config');
  assert.equal(unavailableReason(chain.providers[0], env.repo), null);
  mkdirSync(join(env.repo, '.codex'));
  writeFileSync(join(env.repo, '.codex/hooks.json'), '{}');
  assert.match(unavailableReason(chain.providers[0], env.repo), /project/);
  mkdirSync(process.env.CURSOR_CONFIG_DIR);
  writeFileSync(join(process.env.CURSOR_CONFIG_DIR, 'cli-config.json'), '{}');
  assert.match(unavailableReason(chain.providers[2], env.repo), /global Cursor/);
});

test('recheck releases every independent task held by provider cooldowns', { skip: skipWithoutSqlite }, async (t) => {
  const tasks = declaration().tasks.map((task) => ({ ...task, deliverable: 'report', dependsOn: [] }));
  const { store, controller, id } = fixture(t, 12, tasks);
  await controller.tick();
  for (let attempt = 0; attempt < 3; attempt++) {
    const op = store.openOperations(id)[0];
    controller.applyOutcome({ id, generation: controller.held.get(id) }, op,
      { class: 'quota', retryAt: Date.now() + 60_000, detail: 'synthetic quota', receipt: {} });
    await controller.tick();
  }
  assert.ok(store.tasks(id).every((task) => task.retry_at > Date.now()));
  campaignRecheck(store, id);
  await controller.tick();
  assert.equal(store.openOperations(id)[0].executor_kind, 'codex-cli');
  assert.equal(store.task(id, 'T2').retry_at, null);
});

test('exhausted budget prevents fallback from launching the second provider', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id } = fixture(t, 1);
  await controller.tick();
  const op = store.openOperations(id)[0];
  controller.applyOutcome({ id, generation: controller.held.get(id) }, op,
    { class: 'quota', retryAt: Date.now() + 60_000, detail: 'synthetic quota', receipt: {} });
  await controller.tick();
  assert.equal(store.campaign(id).blocker.kind, 'budget');
  assert.equal(store.campaign(id).runs_used, 1);
  assert.equal(store.openOperations(id).length, 0);
});

test('a paused campaign with an outstanding operation cannot change executors', { skip: skipWithoutSqlite }, async (t) => {
  const { store, d, controller, id } = fixture(t);
  await controller.tick();
  campaignPause(store, id);
  const amended = structuredClone(d);
  amended.authorization.version++;
  amended.executor.providers.reverse();
  assert.throws(() => campaignStart(store, amended), /no open operations/);
  assert.equal(store.campaign(id).authorization_version, 1);
});

test('legacy operations acquire Claude identity without losing historical state', { skip: !SQLITE }, (t) => {
  const env = environment();
  const path = join(env.dataDir, 'legacy.db');
  const oldStore = new Store(path);
  campaignStart(oldStore, declaration());
  oldStore.run('UPDATE campaigns SET runs_used = 12, cost_usd = 7.342');
  oldStore.db.exec('ALTER TABLE operations DROP COLUMN executor_kind');
  oldStore.db.exec('DROP TABLE executor_waits');
  oldStore.insert('operations', { id: 'old-run', campaign_id: 'test-campaign', task_id: 'T1', kind: 'implement',
    seq: 1, idempotency_key: 'old-run', lease_generation: 1, state: 'finished', session_id: 'old-session',
    run_dir: 'synthetic', workspace: 'synthetic', packet: {}, packet_digest: digest, created_at: 1, updated_at: 1 });
  oldStore.close();
  const reader = new Store(path, { readOnly: true });
  try {
    assert.deepEqual(campaignStatus(reader, 'test-campaign').executorWaits, []);
    assert.equal(reader.get("SELECT name FROM sqlite_master WHERE name = 'executor_waits'"), null);
    assert.ok(!reader.all('PRAGMA table_info(operations)').some((column) => column.name === 'executor_kind'));
  } finally { reader.close(); }
  const migrated = new Store(path);
  t.after(() => { migrated.close(); env.cleanup(); });
  assert.equal(migrated.get('SELECT * FROM operations').executor_kind, 'claude-cli');
  assert.equal(migrated.campaign('test-campaign').runs_used, 12);
  assert.equal(migrated.campaign('test-campaign').cost_usd, 7.342);
});

test('executor amendment is idle, versioned, scope-preserving and keeps the spent budget', { skip: !SQLITE }, (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const d = declaration();
  campaignStart(store, d);
  for (let i = 0; i < 12; i++) store.insert('operations', { id: `spent-${i}`, campaign_id: d.campaignId,
    task_id: 'T1', kind: 'implement', seq: i, idempotency_key: `spent-${i}`, lease_generation: 1,
    state: 'finished', session_id: `spent-session-${i}`, run_dir: 'synthetic', workspace: 'synthetic',
    packet: {}, packet_digest: digest, created_at: 1, updated_at: 1 });
  store.run('UPDATE campaigns SET runs_used = 12, cost_usd = 7.342 WHERE id = ?', d.campaignId);
  const amended = { ...d, authorization: { ...d.authorization, version: 2 }, executor: chain };
  assert.throws(() => campaignStart(store, amended), /paused campaign/);
  campaignPause(store, d.campaignId);
  assert.throws(() => campaignStart(store, { ...amended, authorization: d.authorization }), /increase authorization/);
  assert.throws(() => campaignStart(store, { ...amended, constraints: ['different work scope'] }), /immutable scope/);
  const status = campaignStart(store, amended);
  assert.equal(status.runsUsed, 12);
  assert.equal(status.costUsd, 7.342);
  assert.equal(status.scopeDigest, scopeDigest(amended));
  assert.deepEqual(status.executorOrder, ['codex-cli', 'claude-cli', 'cursor-cli']);
  assert.equal(store.all("SELECT * FROM journal WHERE kind = 'executor-amended'").length, 1);
});

test('prepared invocations preserve read-only verifier mode and never resume or bypass', { skip: skipWithoutSqlite }, (t) => {
  const { env } = fixture(t);
  const runDir = join(env.dataDir, 'probe'); mkdirSync(runDir);
  for (const provider of chain.providers.filter((p) => p.kind !== 'claude-cli')) {
    const invocation = prepare({ executor: provider, command: ['native-cli'], role: 'verification', deliverable: 'commit',
      sessionId: 'bound-run', digest, runDir, workspace: env.repo, prompt: 'synthetic' });
    assert.ok(!invocation.argv.some((arg) => /bypass|--force|--yolo|--resume|--continue|--approve-mcps/.test(arg)));
    assert.ok(invocation.argv.includes(provider.kind === 'codex-cli' ? 'read-only' : 'ask'));
    if (provider.kind === 'codex-cli') {
      assert.ok(invocation.argv.includes('--no-daemon'));
      assert.ok(invocation.argv.includes('--ignore-user-config'));
      assert.equal(invocation.argv[invocation.argv.indexOf('-a') + 1], 'never');
      assert.equal(invocation.argv.includes('windows.sandbox="elevated"'), process.platform === 'win32');
      if (process.platform === 'win32') {
        const trustArgs = JSON.parse(invocation.prompt.match(/prepend these exact arguments after git: (\[[^\n]+\])/)[1]);
        assert.deepEqual(trustArgs, ['-c', 'safe.directory=', '-c',
          `safe.directory=${realpathSync(env.repo).replaceAll('\\', '/')}`]);
      }
      assert.ok(!invocation.argv.some((arg) => arg.startsWith('shell_environment_policy.')));
    }
    assert.equal(JSON.parse(readFileSync(join(runDir, 'output-schema.json'))).properties.runId.const, 'bound-run');
  }
});

test('native quota preserves explicit reset and Retry-After evidence', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  for (const kind of ['codex-cli', 'cursor-cli']) {
    const fail = (stderrText) => classifyRun(kind, '', { run: { exitCode: 1 }, now, stderrText });
    assert.equal(fail('usage limit; resets at 2026-10-09T15:00:00Z').retryAt, Date.parse('2026-10-09T15:01:00Z'));
    assert.equal(fail('rate limit; Retry-After: 120').retryAt, now + 180000);
  }
});


test('research providers restrict capabilities, isolate scratch space and cannot implement commit tasks', { skip: skipWithoutSqlite }, (t) => {
  const { env } = fixture(t);
  for (const kind of ['codex-cli', 'claude-cli', 'cursor-cli']) {
    const executor = { ...chain.providers.find((p) => p.kind === kind), researchOnly: true };
    const runDir = join(env.tmp, kind); mkdirSync(runDir);
    const args = { executor, command: ['synthetic'], role: 'implementer', deliverable: 'report', sessionId: expect.sessionId,
      digest, runDir, workspace: env.repo, prompt: 'brokered evidence only' };
    const invocation = prepare(args);
    assert.notEqual(invocation.cwd, env.repo);
    if (kind === 'codex-cli') for (const flag of ['--ephemeral', 'features.shell_tool=false', 'features.hooks=false', 'features.plugins=false', 'features.apps=false', 'features.skill_mcp_dependency_install=false', 'features.skill_search=false', 'features.multi_agent=false', 'features.goals=false', 'features.image_generation=false', 'features.view_image=false', 'features.browser_use=false', 'features.computer_use=false', 'features.sleep_tool=false', 'web_search="disabled"']) {
      assert.ok(invocation.argv.includes(flag));
    }
    if (kind === 'claude-cli') {
      assert.equal(invocation.argv[invocation.argv.indexOf('--tools') + 1], ''); assert.ok(invocation.argv.includes('--strict-mcp-config'));
      assert.ok(invocation.argv.includes('--safe-mode')); assert.ok(invocation.argv.includes('{"disableAllHooks":true}'));
      assert.equal(invocation.argv[invocation.argv.indexOf('--setting-sources') + 1], '');
    }
    if (kind === 'cursor-cli') assert.deepEqual(JSON.parse(readFileSync(join(invocation.cwd, '.cursor', 'cli.json'))).permissions.deny,
      ['Shell(*)', 'Write(**)', 'Read(**)', 'WebFetch(*)', 'Mcp(*:*)']);
    assert.throws(() => prepare({ ...args, deliverable: 'commit' }), /report deliverable/);
  }
});

test('research terminal output cannot hide an unexpected native tool invocation', () => {
  for (const type of ['mcp_tool_call', 'command_execution', 'file_change', 'web_search', 'collab_tool_call', 'custom_tool_call', 'future_tool_call']) {
    const stdout = JSON.stringify({ type: 'item.completed', item: { type, server: 'codex_apps', status: 'completed' } }) + '\n' + codex(envelope());
    const outcome = classifyRun('codex-cli', stdout, { researchOnly: true });
    assert.equal(outcome.class, 'error');
    assert.match(outcome.detail, /unexpected tool; no provider fallback/);
  }
  assert.equal(classifyRun('codex-cli', codex(envelope()), { researchOnly: true }).class, 'result');
  const read = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'aiworks_repository', tool: 'read', status: 'completed' } }) + '\n';
  assert.equal(classifyRun('codex-cli', read + codex(envelope()), { researchOnly: true }).class, 'result');
  const failed = read.replace('completed"}', 'failed","error":{"message":"HTTP 403"}}');
  assert.equal(classifyRun('codex-cli', failed + codex(envelope()), { researchOnly: true }).class, 'error');
});

test('missing local CLI is recorded and fallback resumes the preferred provider after reset', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, d, controller, id } = fixture(t);
  delete controller.cmd.cursor;
  await controller.tick();
  const missing = store.get('SELECT * FROM executor_waits WHERE campaign_id = ? AND executor_kind = ?', id, 'cursor-cli');
  assert.match(missing.reason, /not configured/);
  assert.ok(missing.retry_at > Date.now());
  const op = store.openOperations(id)[0];
  const reset = Date.now() + 60000;
  controller.applyOutcome({ id, generation: controller.held.get(id) }, op,
    { class: 'quota', retryAt: reset, detail: 'synthetic', receipt: {} });
  assert.equal(controller.executorChoice(d, store.task(id, 'T1'), reset - 1).executor.kind, 'claude-cli');
  const reopened = new Controller({ store, config: env.config, dataDir: env.dataDir });
  assert.equal(reopened.executorChoice(d, store.task(id, 'T1'), reset + 1).executor.kind, 'codex-cli');
});


test('explicit uncapped authorization permits runs above numeric caps without losing accounting', { skip: skipWithoutSqlite }, async (t) => {
  const { store, d, controller, id } = fixture(t, null);
  store.run('UPDATE campaigns SET runs_used = 101 WHERE id = ?', id);
  await controller.tick();
  assert.equal(store.openOperations(id)[0].executor_kind, 'codex-cli');
  assert.equal(store.campaign(id).runs_used, 102);
  assert.equal(store.campaign(id).blocker, null);
  // Since historical regression an omitted cap also means no run cap; out-of-range values still fail.
  assert.doesNotThrow(() => validateDeclaration({ ...d, limits: { ...d.limits, maxWorkerRuns: undefined } }));
  assert.throws(() => validateDeclaration({ ...d, limits: { ...d.limits, maxWorkerRuns: 0 } }), /maxWorkerRuns/);
});

test('report limits are enforced before verification and publication preserves accepted text', { skip: skipWithoutSqlite }, (t) => {
  const { d, controller } = fixture(t);
  assert.equal(classifyRun('codex-cli', codex(envelope({ ...terminal, report: 'x'.repeat(52001) }))).class, 'invalid-result');
  const report = 'x'.repeat(52000) + '\nLEGACY-ACCEPTED-CONCLUSION';
  const body = controller.reportBody(d, d.tasks[0], { verified_sha: 'a'.repeat(40), result: { report } }, digest);
  assert.ok(body.includes(report), 'legacy verified reports are preserved too');
  assert.ok(controller.prBody(d, d.tasks[0], { verified_sha: 'a'.repeat(40), result: { report } }).includes(report), 'PR reports preserve verified text too');
});

test('completed planning campaigns name their actual target without claiming PR delivery', { skip: skipWithoutSqlite }, async (t) => {
  const { d, store, controller, id } = fixture(t, 12, undefined, 'test/wiki');
  store.run("UPDATE tasks SET state = 'done' WHERE campaign_id = ?", id);
  await controller.tick();
  const c = store.campaign(id);
  assert.equal(c.control, 'finished');
  assert.match(c.next_action, /Planning reports published in test\/wiki/);
  assert.doesNotMatch(c.next_action, /sampleapp|merge the campaign PRs/);
});

const promptArgs = (role, deliverable, changes = {}) => ({ executorKind: 'claude-cli', web: null, role, deliverable,
  packet: { taskId: 'T1', goal: 'synthetic', governance: { project: 'demo', policies: [], authorities: [], exceptions: [], gaps: [] } },
  packetDigest: digest, repository: 'owner/demo', issue: 7, branch: 'campaign/c/T1', baseSha: 'b'.repeat(40), targetSha: 'c'.repeat(40),
  report: role === 'verification' ? 'Report: # tests 3, # pass 3' : null, reportDigest: 'd'.repeat(64), note: null, instructions: [], ...changes });

test('commit and report prompts tell workers CI runs on Linux and to copy tallies; verifiers block a mismatched tally (#42, #43)', () => {
  for (const deliverable of ['commit', 'report']) {
    for (const role of ['implementer', 'verification']) {
      const args = promptArgs(role, deliverable);
      const prompt = buildPrompt(args);
      assert.match(prompt, /CI runs npm run check on ubuntu-latest/);
      assert.match(prompt, /guard itself with a skip that names the reason.*without weakening what it checks on Windows/);
      assert.match(prompt, /Copy test summary lines verbatim.*# tests, # pass, # fail, # skipped.*never retype/);
      assert.equal(prompt.includes(VERIFIER_TALLY_RULE), role === 'verification', `${role} ${deliverable}`);
      if (role === 'verification') assert.match(prompt, /does not match your own re-run of the same gate at the same head is a blocking finding/);
      // Every existing line stays, in order: removing the added rules gives the unchanged base prompt.
      const added = [...GATE_RULES, ...(role === 'verification' ? [VERIFIER_TALLY_RULE] : [])];
      assert.equal(prompt.split('\n').filter((line) => !added.includes(line)).join('\n'), claude.buildPrompt(args));
      assert.ok(prompt.indexOf(GATE_RULES[0]) < prompt.indexOf('Task packet (sha256 '), 'the rules precede the packet');
    }
  }
});

test('web-task prompts are the unchanged browser prompt and carry no gate rules', () => {
  for (const role of ['implementer', 'verification']) {
    const args = promptArgs(role, 'report', { web: { urls: ['https://example.test/'] } });
    const prompt = buildPrompt(args);
    assert.equal(prompt, agy.buildPrompt(args));
    for (const rule of [...GATE_RULES, VERIFIER_TALLY_RULE]) assert.ok(!prompt.includes(rule));
  }
});

test('commit prompts tell implementers and verifiers how to get a completed full gate; report prompts do not (#102, #135)', () => {
  const ruleLine = (prompt) => prompt.split('\n').find((line) => line.startsWith('The repository\'s full gate (npm run check)'));
  for (const role of ['implementer', 'verification']) {
    const args = promptArgs(role, 'commit');
    const prompt = buildPrompt(args);
    const rule = ruleLine(prompt);
    assert.ok(rule, `${role} commit prompt carries the full-gate rule`);
    assert.match(rule, /can take 20 to 30 minutes on this PC while other work runs, longer than one foreground command may wait/);
    // The gate helper by its absolute path, so a gate that ended without an exit code is reported at once, never waited out.
    const helper = `node "${fileURLToPath(new URL('../../src/supervisor/gate.mjs', import.meta.url)).replaceAll('\\', '/')}"`;
    assert.ok(rule.includes(`Run it only through the gate helper, from this run's working directory: ${helper} start starts it as a separate process, then ${helper} wait, run in the foreground,`));
    assert.match(rule, /prints died when it ended without an exit code: then start it once more and name both runs in the report\. Never wait on a log line or a file yourself\./);
    // #135: every gate file is git-ignored, so a verifier's checkout stays clean.
    assert.match(rule, /Every file the gate writes ends in \.log, which git ignores: gate\.log for the output, gate-exit\.log for the exit code, gate-pid\.log for the process, gate-previous\.log for the run before, never committed\./);
    assert.match(rule, /A verifier's checkout must stay clean: any other new or changed file in it makes the verification result invalid\./);
    assert.doesNotMatch(rule, /gate\.exit/);
    assert.match(rule, /copy the final summary block it shows verbatim.*scripts\/run-tests\.mjs, the block after "# all test files"/);
    assert.match(rule, /Never shorten the suite, skip files or weaken a test to make it finish\./);
    assert.ok(prompt.indexOf(rule) < prompt.indexOf('Task packet (sha256 '), 'the rule precedes the packet');
    // Only the gate rules are added to the base prompt, the new one among them.
    const added = [...GATE_RULES, ...(role === 'verification' ? [VERIFIER_TALLY_RULE] : [])];
    assert.ok(added.includes(rule));
    assert.equal(prompt.split('\n').filter((line) => !added.includes(line)).join('\n'), claude.buildPrompt(args));
    // Report tasks (research-only workers run only these) keep exactly the two #42/#43 rules and no full-gate rule.
    const reportArgs = promptArgs(role, 'report');
    const report = buildPrompt(reportArgs);
    assert.equal(ruleLine(report), undefined, `${role} report prompt`);
    const reportAdded = [GATE_RULES[0], GATE_RULES[1], ...(role === 'verification' ? [VERIFIER_TALLY_RULE] : [])];
    const base = claude.buildPrompt(reportArgs);
    const at = base.indexOf('\n\nTask packet (sha256 ');
    assert.equal(report, `${base.slice(0, at)}\n${reportAdded.join('\n')}${base.slice(at)}`);
    // Web tasks keep the unchanged browser prompt.
    const webArgs = promptArgs(role, 'report', { web: { urls: ['https://example.test/'] } });
    assert.equal(buildPrompt(webArgs), agy.buildPrompt(webArgs));
    assert.equal(ruleLine(buildPrompt(webArgs)), undefined);
  }
});

// CAAM4-LAUNCH (docs/design/ACCOUNT_ADAPTER_CAAM.md section 3.4): a run bound to a CAAM profile launches with that
// profile's shallow home and nothing else changes. Synthetic homes and a synthetic caam only; no real CAAM or login.
const runnerPath = fileURLToPath(new URL('../../src/supervisor/runner.mjs', import.meta.url));
const CLAUDE_PROFILE_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CODE_DISABLE_AGENT_VIEW', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'];
function profileDirs(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'aiworks-caam-launch-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = join(tmp, 'shallow-homes');
  const home = join(root, 'work-a');
  const workspace = join(tmp, 'workspace');
  const runDir = join(tmp, 'run');
  // The .git marks the checkout boundary, so the extension preflight never climbs into the host's own folders.
  for (const dir of [join(home, '.codex'), join(workspace, '.git'), runDir]) mkdirSync(dir, { recursive: true });
  return { tmp, root, home, workspace, runDir };
}
const launchArgs = (executor, dirs, extra = {}) => ({ executor, command: ['native-cli'], role: 'implementer', deliverable: 'commit',
  sessionId: expect.sessionId, digest, runDir: dirs.runDir, workspace: dirs.workspace, prompt: 'synthetic', ...extra });

test('a Claude run bound to a CAAM profile gets the shallow home and keeps every isolation flag', (t) => {
  const dirs = profileDirs(t);
  const executor = chain.providers.find((p) => p.kind === 'claude-cli');
  const settings = JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', HOME: 'C:/elsewhere' } });
  const hostRun = prepare(launchArgs(executor, dirs, { projectSettings: settings }));
  const run = prepare(launchArgs(executor, dirs, { projectSettings: settings, profileHome: dirs.home }));
  assert.equal(run.env.HOME, dirs.home);
  assert.equal(run.env.USERPROFILE, dirs.home);
  assert.equal(run.env.CLAUDE_CODE_DISABLE_AGENT_VIEW, '1');
  assert.equal(run.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  assert.equal(run.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(run.env.CODEX_HOME, undefined);
  // Exactly the host-run environment plus the profile: no host variable, project HOME or personal setting leaks in.
  assert.deepEqual(Object.keys(run.env).sort(), [...new Set([...Object.keys(hostRun.env), ...CLAUDE_PROFILE_KEYS])].sort());
  for (const [key, value] of Object.entries(hostRun.env)) if (!CLAUDE_PROFILE_KEYS.includes(key)) assert.equal(run.env[key], value);
  assert.equal(hostRun.env.HOME, undefined, 'a run without a profile keeps the host login');
  // The argv, prompt and working directory are unchanged: the profile changes the environment only.
  assert.deepEqual(run.argv, hostRun.argv);
  assert.equal(run.prompt, hostRun.prompt);
  assert.equal(run.cwd, hostRun.cwd);
  assert.equal(run.argv[run.argv.indexOf('--setting-sources') + 1], '');
  assert.ok(run.argv.includes('--strict-mcp-config'));
  assert.ok(run.argv.includes('{"disableAllHooks":true}'));
  assert.ok(!run.argv.some((arg) => /bypass|--resume|--continue|--mcp-config/.test(arg)));
  // Research-only Claude keeps its tool-free safe mode under a profile.
  const research = prepare(launchArgs({ ...executor, researchOnly: true }, dirs, { deliverable: 'report', profileHome: dirs.home }));
  assert.equal(research.env.HOME, dirs.home);
  assert.ok(research.argv.includes('--safe-mode'));
  assert.equal(research.argv[research.argv.indexOf('--tools') + 1], '');
  assert.equal(research.argv[research.argv.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
});

test('a Codex run bound to a CAAM profile gets HOME, USERPROFILE and CODEX_HOME and keeps apps disabled and the sandbox', (t) => {
  const dirs = profileDirs(t);
  const executor = chain.providers.find((p) => p.kind === 'codex-cli');
  for (const role of ['implementer', 'verification']) {
    const hostRun = prepare(launchArgs(executor, dirs, { role }));
    const run = prepare(launchArgs(executor, dirs, { role, profileHome: dirs.home }));
    assert.equal(hostRun.env, undefined, 'a Codex run without a profile adds no environment');
    assert.deepEqual(run.env, { HOME: dirs.home, USERPROFILE: dirs.home, CODEX_HOME: join(dirs.home, '.codex') });
    assert.deepEqual(run.argv, hostRun.argv);
    assert.equal(run.prompt, hostRun.prompt);
    assert.equal(run.argv[run.argv.indexOf('--disable') + 1], 'apps');
    assert.ok(run.argv.includes('--ignore-user-config'));
    assert.equal(run.argv[run.argv.indexOf('--sandbox') + 1], role === 'verification' ? 'read-only' : 'workspace-write');
    assert.equal(run.argv[run.argv.indexOf('-a') + 1], 'never');
  }
  // The hooks preflight reads the profile's CODEX_HOME, which is the one the worker will load.
  assert.equal(unavailableReason(executor, dirs.workspace, null, { profileHome: dirs.home }), null);
  writeFileSync(join(dirs.home, '.codex', 'hooks.json'), '{}');
  assert.match(unavailableReason(executor, dirs.workspace, null, { profileHome: dirs.home }), /user Codex hooks/);
});

test('a CAAM profile cannot launch agy or Cursor, or point at a relative home or the host home', (t) => {
  const dirs = profileDirs(t);
  assert.throws(() => prepare(launchArgs({ kind: 'agy-cli' }, dirs, { deliverable: 'report', web: { urls: ['https://example.test/'] }, profileHome: dirs.home })),
    (error) => error instanceof CaamError && error.code === 'consumer-agy-excluded');
  assert.throws(() => prepare(launchArgs({ kind: 'cursor-cli' }, dirs, { role: 'verification', profileHome: dirs.home })),
    (error) => error instanceof CaamError && error.code === 'unsupported-executor');
  const claudeExecutor = chain.providers.find((p) => p.kind === 'claude-cli');
  for (const profileHome of ['relative/home', homedir(), dirname(homedir())]) {
    assert.throws(() => prepare(launchArgs(claudeExecutor, dirs, { profileHome })), (error) => error.code === 'invalid-profile-home', profileHome);
  }
  // A home under the host home, CAAM's default ~/.caam/shallow-homes/<name>, is allowed.
  const underHost = join(homedir(), '.caam', 'shallow-homes', 'work-a');
  assert.equal(caamProfileEnv(underHost, 'claude').HOME, underHost);
  for (const name of ['../escape', 'a/b', '', '-flag']) {
    assert.throws(() => shallowHomeOf(dirs.root, name), (error) => error.code === 'invalid-profile-home', name);
  }
  assert.throws(() => shallowHomeOf('relative', 'work-a'), (error) => error.code === 'invalid-profile-home');
  assert.equal(shallowHomeOf(dirs.root, 'work-a'), dirs.home);
});

test('ensureShallowProfile uses an existing home, creates a missing one through caam once and fails closed', (t) => {
  const dirs = profileDirs(t);
  const calls = [];
  const spawnWith = (create) => (command, args, options) => { calls.push({ command, args, options }); return create(); };
  const never = spawnWith(() => assert.fail('an existing home must not call caam'));
  assert.equal(ensureShallowProfile({ command: ['caam'], kind: 'claude-cli', name: 'work-a', root: dirs.root, spawn: never }), dirs.home);
  assert.equal(calls.length, 0);
  // Missing: one create call with the exact argv, then the home must exist.
  const made = spawnWith(() => { mkdirSync(join(dirs.root, 'work-b')); return { status: 0, stdout: '{"success":true}\n', stderr: '' }; });
  assert.equal(ensureShallowProfile({ command: ['node', 'caam.mjs'], kind: 'codex-cli', name: 'work-b', root: dirs.root, spawn: made }), join(dirs.root, 'work-b'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'node');
  assert.deepEqual(calls[0].args, ['caam.mjs', 'shallow-profile', 'create', 'work-b', '--from-vault', 'codex/work-b', '--json']);
  assert.equal(calls[0].options.windowsHide, true);
  const fails = (create, code, pattern) => assert.throws(
    () => ensureShallowProfile({ command: ['caam'], kind: 'claude-cli', name: 'work-c', root: dirs.root, spawn: spawnWith(create) }),
    (error) => error instanceof CaamError && error.code === code && pattern.test(error.message) && !/secret/.test(error.message));
  fails(() => ({ status: 0, stdout: '{"success":true}', stderr: 'secret' }), 'shallow-profile-missing', /no shallow home/);
  fails(() => ({ status: 1, stdout: '{"success":false,"error":{"code":"VAULT_MISSING","message":"no vault entry"}}', stderr: 'secret' }),
    'cli-error', /VAULT_MISSING: no vault entry/);
  fails(() => ({ status: 2, stdout: 'not json secret', stderr: 'secret' }), 'cli-error', /exited 2/);
  fails(() => ({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }), 'missing-executable', /caam was not found/);
  fails(() => ({ error: Object.assign(new Error('slow'), { code: 'ETIMEDOUT' }) }), 'timeout', /longer than/);
  assert.throws(() => ensureShallowProfile({ command: [], kind: 'claude-cli', name: 'work-c', root: dirs.root, spawn: never }),
    (error) => error.code === 'missing-executable');
  assert.throws(() => ensureShallowProfile({ command: ['caam'], kind: 'agy-cli', name: 'work-c', root: dirs.root, spawn: never }),
    (error) => error.code === 'consumer-agy-excluded');
  assert.equal(existsSync(join(dirs.root, 'work-c')), false);
});

test('a profile run under Job Object containment reads its prompt, writes stdout and returns its exit code with the shallow home',
  { skip: process.platform !== 'win32' && 'Windows Job Object containment (runner.mjs, windows-process.ps1) runs only on Windows' }, async (t) => {
    const dirs = profileDirs(t);
    const invocation = prepare(launchArgs(chain.providers.find((p) => p.kind === 'claude-cli'), dirs, { profileHome: dirs.home }));
    const worker = join(dirs.runDir, 'worker.mjs');
    writeFileSync(worker, [
      "import { readFileSync } from 'node:fs';",
      "import { homedir } from 'node:os';",
      'const pick = (key) => process.env[key] ?? null;',
      "process.stdout.write(JSON.stringify({ prompt: readFileSync(0, 'utf8'), homedir: homedir(), HOME: pick('HOME'),",
      "  USERPROFILE: pick('USERPROFILE'), CODEX_HOME: pick('CODEX_HOME'), view: pick('CLAUDE_CODE_DISABLE_AGENT_VIEW'),",
      "  background: pick('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'), memory: pick('CLAUDE_CODE_DISABLE_AUTO_MEMORY'),",
      "  session: pick('CLAUDE_CODE_SESSION_PROBE') }));",
      'process.exit(7);',
    ].join('\n'));
    writeFileSync(join(dirs.runDir, 'prompt.txt'), invocation.prompt);
    // The spec as controller.mjs writes it, with the synthetic worker in place of the native CLI.
    writeFileSync(join(dirs.runDir, 'spec.json'), JSON.stringify({ argv: [process.execPath, worker], env: invocation.env,
      cwd: invocation.cwd, timeoutMs: 60_000, heartbeatMs: 50 }));
    // A host Claude Code session variable must not reach the worker (proc.mjs workerEnv).
    const child = spawn(process.execPath, [runnerPath, dirs.runDir], { windowsHide: true, stdio: 'ignore',
      env: { ...process.env, CLAUDE_CODE_SESSION_PROBE: 'host-session' } });
    const exited = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
    await exited;
    const result = JSON.parse(readFileSync(join(dirs.runDir, 'result.json'), 'utf8'));
    assert.equal(result.exitCode, 7, JSON.stringify(result));
    assert.equal(result.timedOut, false);
    assert.equal(result.containment, 'windows-job-v1');
    assert.equal(result.containmentStopped, true);
    assert.deepEqual(JSON.parse(readFileSync(join(dirs.runDir, 'stdout.json'), 'utf8')), { prompt: invocation.prompt, homedir: dirs.home,
      HOME: dirs.home, USERPROFILE: dirs.home, CODEX_HOME: null, view: '1', background: '1', memory: '1', session: null });
  });

test('commit and report verifier prompts report a check that behaved as intended as pass; implementer and web prompts do not carry it (#59)', () => {
  const ruleLine = (prompt) => prompt.split('\n').find((line) => line.includes('A check that behaves as intended is reported as pass'));
  for (const deliverable of ['commit', 'report']) {
    for (const role of ['implementer', 'verification']) {
      const args = promptArgs(role, deliverable);
      const prompt = buildPrompt(args);
      const rule = ruleLine(prompt);
      if (role !== 'verification') { assert.equal(rule, undefined, `${role} ${deliverable}`); continue; }
      assert.ok(rule, `verifier ${deliverable} prompt carries the rule`);
      assert.match(rule, /including a mutation or base comparison whose expected failure was observed/);
      assert.match(rule, /a full-suite run whose only failure is an unrelated timing test that passes on a re-run \(name the test, the run and the re-run summary in its detail\)/);
      assert.match(rule, /Report fail only for an outcome that shows a defect in the change\./);
      assert.match(rule, /Never return accepted with a check marked fail\./);
      assert.ok(prompt.indexOf(rule) < prompt.indexOf('Task packet (sha256 '), 'the rule precedes the packet');
      // The base prompt is otherwise unchanged: removing the added rule lines gives it back.
      const added = [...GATE_RULES, VERIFIER_TALLY_RULE];
      assert.equal(prompt.split('\n').filter((line) => !added.includes(line)).join('\n'), claude.buildPrompt(args));
    }
  }
  for (const role of ['implementer', 'verification']) {
    const webArgs = promptArgs(role, 'report', { web: { urls: ['https://example.test/'] } });
    assert.equal(buildPrompt(webArgs), agy.buildPrompt(webArgs));
    assert.equal(ruleLine(buildPrompt(webArgs)), undefined, `${role} web prompt`);
  }
});
