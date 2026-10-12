// Owner -> coordinator inbox: durable receipt, read by one bounded read-only agent, answered by a
// supervisor-posted comment. Synthetic claude/gh only; no model, network or GitHub access.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { environment, runUntil, SQLITE, skipWithoutSqlite } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const coordinator = SQLITE ? await import('../../src/supervisor/coordinator.mjs') : {};
const COORDINATOR = { repositories: ['netbka/Dyk', 'netbka/aiworks'], reportTo: 'netbka/aiworks#3', timeoutMinutes: 1, maxRunsPerDay: 6 };

function setup(t, scenario = {}, { codeRevision = null, coordinator = {} } = {}) {
  const env = environment({ scenario });
  // The coordinator's private checkout comes from a disposable repository here, never the AIWorks checkout.
  env.config.coordinator = { ...COORDINATOR, sourceRepo: env.repo, worktreeRoot: join(env.tmp, 'coordinator-worktrees'), ...coordinator };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null, codeRevision });
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  return { env, store, controller };
}
// The same budget as runUntil: each coordinator read is a real contained runner, whose start-up and drain take seconds under load (engineering-platform-archive#58).
const until = async (controller, store, predicate, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await controller.tick();
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 40));
  }
  throw new Error(`timed out: ${JSON.stringify(store.all('SELECT * FROM owner_messages'))} ${JSON.stringify(store.all('SELECT id, state, outcome FROM coordinator_runs'))}`);
};

test('a message is stored once per request id and rejects empty, oversized and control text', { skip: !SQLITE }, (t) => {
  const { store } = setup(t);
  const requestId = randomUUID();
  const first = coordinator.postOwnerMessage(store, { text: 'Review new PRs.', requestId, source: 'owner (test)' });
  assert.equal(first.state, 'received');
  assert.equal(first.duplicate, false);
  assert.equal(coordinator.postOwnerMessage(store, { text: 'Review new PRs.', requestId }).duplicate, true, 'an exact retry is acknowledged, not duplicated');
  assert.throws(() => coordinator.postOwnerMessage(store, { text: 'Something else', requestId }), /different message/);
  for (const text of ['', '   ', 'x'.repeat(4001), 'bell\u0007']) assert.throws(() => coordinator.postOwnerMessage(store, { text, requestId: randomUUID() }), /printable/);
  assert.equal(store.all('SELECT * FROM owner_messages').length, 1);
  assert.ok(store.all("SELECT kind FROM journal WHERE kind = 'message-received'").length === 1);
});

test('the coordinator reads the message read-only and the supervisor posts its answer with receipts', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller } = setup(t);
  const { id } = coordinator.postOwnerMessage(store, { text: 'Review new PR and issues and plan their execution.', requestId: randomUUID(), source: 'owner (test)' });
  await until(controller, store, () => store.get('SELECT state FROM owner_messages WHERE id = ?', id).state === 'answered' &&
    env.comments().some((c) => c.url.includes('aiworks/issues/3')));
  const message = store.get('SELECT * FROM owner_messages WHERE id = ?', id);
  assert.ok(message.received_at <= message.read_at && message.read_at <= message.answered_at, 'received, then read, then answered');
  const call = env.calls().find((c) => c.role === 'coordinate');
  assert.equal(call?.autoMemoryDisabled, true, 'the coordinator process starts with auto-memory disabled (through the contained runner)');
  assert.ok(call, 'one coordinator agent ran');
  for (const denied of ['Edit', 'Write', 'Bash(gh issue comment:*)', 'Bash(gh api:*)', 'Bash(git push:*)', 'Bash(ssh:*)', 'Bash(curl:*)', 'SendMessage', 'Read(**/.env)']) {
    assert.ok(call.args.includes(denied), `coordinator denies ${denied}`);
  }
  // Isolation: no settings files, no inherited MCP servers or connectors, and only allowlisted tools.
  const flag = (name) => call.args[call.args.indexOf(name) + 1];
  assert.equal(flag('--setting-sources'), '');
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.equal(flag('--permission-mode'), 'dontAsk');
  const allowed = call.args.slice(call.args.indexOf('--allowedTools') + 1, call.args.indexOf('--disallowedTools'));
  assert.ok(allowed.includes('Bash(gh issue view:*)') && allowed.includes('Read(./**)') && allowed.includes('Grep(./**)'));
  assert.ok(!allowed.some((tool) => ['Read', 'Grep', 'Glob'].includes(tool)), 'reads are confined to the checkout, never unscoped');
  assert.ok(!allowed.some((tool) => /git (log|show|diff|grep)/.test(tool)), 'no git command with output-file or external-program options');
  assert.ok(!allowed.some((tool) => /gh api|Write|Edit|push|comment|curl|node/.test(tool)), `allowlist stays read-only: ${allowed}`);
  const run = store.get('SELECT * FROM coordinator_runs');
  assert.notEqual(realpathSync(run.workspace), realpathSync(join(import.meta.dirname, '..', '..')), 'never the platform or live runtime checkout');
  assert.equal(realpathSync(call.cwd), realpathSync(run.workspace));
  assert.equal(execFileSync('git', ['-C', run.workspace, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'the private checkout is left clean');
  const prompt = readFileSync(join(run.run_dir, 'prompt.txt'), 'utf8');
  assert.ok(prompt.includes('Review new PR and issues and plan their execution.'), 'the owner text reaches the agent');
  assert.match(prompt, /read-only/);
  const reply = env.comments().find((c) => c.url.includes('aiworks/issues/3'));
  assert.match(reply.body, /Coordinator reply/);
  assert.match(reply.body, /netbka\/Dyk#455 \| issue \| Telegram ingestion SQL contract \| new-campaign-candidate/);
  assert.match(reply.body, /Proposed campaign \(draft, not registered\)/);
  const kinds = store.all("SELECT kind FROM journal WHERE campaign_id = '_coordinator'").map((row) => row.kind);
  for (const kind of ['message-received', 'message-read', 'message-answered']) assert.ok(kinds.includes(kind), kind);
  const view = coordinator.coordinatorView(store, env.config);
  assert.equal(view.messages[0].state, 'answered');
  assert.match(view.messages[0].replyUrl, /issues\/3#issuecomment-/);
  assert.equal(store.all('SELECT * FROM campaigns').length, 0, 'the coordinator never registers a campaign');
});

test('a read that ends without an answer retries once with a fresh session, then reports failure', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller } = setup(t, { coordinate: ['no-result', 'no-result'] });
  controller.config.retryBackoffMs = [50];
  const { id } = coordinator.postOwnerMessage(store, { text: 'Plan the next wave.', requestId: randomUUID() });
  await until(controller, store, () => {
    const row = store.get('SELECT * FROM owner_messages WHERE id = ?', id);
    if (row.state === 'received' && row.not_before) store.run('UPDATE owner_messages SET not_before = 0 WHERE id = ?', id); // skip the 2-minute wait
    return row.state === 'failed';
  });
  const message = store.get('SELECT * FROM owner_messages WHERE id = ?', id);
  assert.equal(message.attempts, 2);
  assert.equal(message.failure, 'invalid-result');
  const sessions = env.calls().filter((c) => c.role === 'coordinate').map((c) => c.sessionId);
  assert.equal(new Set(sessions).size, 2, 'each attempt is a fresh session');
  assert.equal(env.comments().length, 0, 'nothing is posted without an answer');
});

test('without coordinator configuration messages stay received and nothing is dispatched', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  coordinator.postOwnerMessage(store, { text: 'Hello', requestId: randomUUID() });
  for (let i = 0; i < 5; i++) await controller.tick();
  assert.equal(store.get('SELECT state FROM owner_messages').state, 'received');
  assert.equal(env.calls().length, 0);
  assert.equal(coordinator.coordinatorView(store, env.config).configured, false);
});

test('an agent that changes its checkout is never published and blocks the lane until the checkout is restored', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller } = setup(t, { coordinate: ['tamper', 'coordinate'] });
  const first = coordinator.postOwnerMessage(store, { text: 'First request.', requestId: randomUUID() });
  await until(controller, store, () => store.get('SELECT state FROM owner_messages WHERE id = ?', first.id).state === 'failed');
  const message = store.get('SELECT * FROM owner_messages WHERE id = ?', first.id);
  assert.equal(message.failure, 'boundary-violation');
  assert.equal(env.comments().length, 0, 'nothing from a boundary-violating run is posted');
  assert.ok(store.all("SELECT kind FROM journal WHERE kind = 'coordinator-boundary-violation'").length === 1);
  const second = coordinator.postOwnerMessage(store, { text: 'Second request.', requestId: randomUUID() });
  for (let i = 0; i < 5; i++) await controller.tick();
  assert.equal(store.get('SELECT state FROM owner_messages WHERE id = ?', second.id).state, 'received', 'the lane refuses to read while the checkout is dirty');
  assert.match(coordinator.coordinatorView(store, env.config).blocked, /changed its checkout/);
  const run = store.get('SELECT workspace FROM coordinator_runs');
  execFileSync('git', ['-C', run.workspace, 'clean', '-fdq']);
  for (let i = 0; i < 5; i++) await controller.tick();
  assert.equal(store.get('SELECT state FROM owner_messages WHERE id = ?', second.id).state, 'received', 'a restored checkout alone does not reopen the lane');
  assert.match(coordinator.coordinatorView(store, env.config).blocked, /coordinator-clear/);
  assert.equal(coordinator.clearCoordinatorViolation(store).cleared, true);
  await until(controller, store, () => store.get('SELECT state FROM owner_messages WHERE id = ?', second.id).state === 'answered');
  assert.equal(coordinator.coordinatorView(store, env.config).blocked, null);
});

test('a pinned controller does not read messages while the live runtime checkout is modified', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller } = setup(t);
  // The disposable repository plays the live runtime: the controller is pinned to its commit, then it is modified.
  env.config.coordinator.runtimeRoot = env.repo;
  controller.codeRevision = execFileSync('git', ['-C', env.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(env.repo, 'AGENTS.md'), 'changed outside review\n');
  const { id } = coordinator.postOwnerMessage(store, { text: 'Plan please.', requestId: randomUUID() });
  for (let i = 0; i < 5; i++) await controller.tick();
  assert.equal(store.get('SELECT state FROM owner_messages WHERE id = ?', id).state, 'received');
  assert.equal(env.calls().length, 0);
  assert.match(coordinator.coordinatorView(store, env.config).blocked, /live runtime checkout is not clean/);
});

test('invalid coordinator configuration keeps the lane idle and is reported', { skip: !SQLITE }, async (t) => {
  for (const bad of [{ permissionMode: 'bypassPermissions' }, { permissionMode: 'auto' }, { model: 'opus --dangerously-skip-permissions' },
    { timeoutMinutes: 0 }, { workspace: '/tmp/anywhere' }, { reportTo: 'not-a-target' }, { repositories: [] }, { sourceRepo: 'relative/path' }]) {
    assert.ok(coordinator.coordinatorConfigError({ ...COORDINATOR, ...bad }), JSON.stringify(bad));
  }
  assert.equal(coordinator.coordinatorConfigError(COORDINATOR), null);
  assert.equal(coordinator.coordinatorConfigError({ ...COORDINATOR, permissionMode: 'dontAsk' }), null);
  const { env, store, controller } = setup(t, {}, { coordinator: { permissionMode: 'bypassPermissions' } });
  coordinator.postOwnerMessage(store, { text: 'Hello', requestId: randomUUID() });
  for (let i = 0; i < 3; i++) await controller.tick();
  assert.equal(env.calls().length, 0);
  const view = coordinator.coordinatorView(store, env.config);
  assert.equal(view.configured, false);
  assert.match(view.configError, /dontAsk/);
});

test('campaign Claude workers run without host settings, MCP servers, remote shells or cross-session tools', async () => {
  const { buildArgv } = await import('../../src/supervisor/adapters/claude.mjs');
  for (const [role, deliverable] of [['implementer', 'commit'], ['implementer', 'report'], ['verification', 'commit']]) {
    const argv = buildArgv({ command: ['claude'], executor: { model: 'opus', permissionMode: 'auto' }, role, deliverable, sessionId: 's' });
    assert.equal(argv[argv.indexOf('--setting-sources') + 1], '', 'Dyk project settings (ssh netcup, push main) never load');
    assert.ok(argv.includes('--strict-mcp-config'), 'no inherited MCP servers or claude.ai connectors such as Local Commander');
    for (const denied of ['Bash(ssh:*)', 'Bash(scp:*)', 'Bash(git push:*)', 'SendMessage', 'Workflow', 'RemoteTrigger']) assert.ok(argv.includes(denied), denied);
    assert.ok(!argv.some((arg) => /bypass/i.test(arg)));
  }
});

test('a reply that contains credential-like text is withheld, never posted', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller } = setup(t, { coordinate: ['leak'] });
  const { id } = coordinator.postOwnerMessage(store, { text: 'Summarize the config.', requestId: randomUUID() });
  await until(controller, store, () => store.get('SELECT state FROM owner_messages WHERE id = ?', id).state === 'failed');
  assert.equal(store.get('SELECT failure FROM owner_messages WHERE id = ?', id).failure, 'reply-withheld');
  assert.equal(env.comments().length, 0);
  assert.equal(store.all("SELECT * FROM outbox WHERE campaign_id = '_coordinator'").length, 0);
  assert.ok(store.all("SELECT kind FROM journal WHERE kind = 'coordinator-reply-withheld'").length === 1);
  assert.equal(coordinator.containsSecret('rotate the deploy token next week'), false, 'prose about tokens is not withheld');
});

test('workers inherit only exact, validated project tuning names, never paths, providers, credentials or permissions', async () => {
  const { projectEnv } = await import('../../src/supervisor/adapters/claude.mjs');
  const { prepare } = await import('../../src/supervisor/adapters/executors.mjs');
  const settings = JSON.stringify({ permissions: { allow: ['Bash(ssh netcup:*)'] }, env: {
    CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '3', CLAUDE_CODE_GIT_BASH_PATH: 'C:/evil/bash.exe',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'https://evil.example', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' } });
  assert.deepEqual(projectEnv(settings), { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '3' });
  assert.deepEqual(projectEnv(JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku; rm -rf', CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '999' } })), {}, 'invalid values are dropped');
  assert.deepEqual(projectEnv(null), {});
  assert.deepEqual(projectEnv('not json'), {});
  const invocation = prepare({ executor: { kind: 'claude-cli', model: 'opus', permissionMode: 'auto' }, command: ['claude'], role: 'implementer',
    deliverable: 'report', sessionId: 's', workspace: '.', prompt: 'p', projectSettings: settings });
  assert.deepEqual(invocation.env, { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '3', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', BASH_DEFAULT_TIMEOUT_MS: '1800000', BASH_MAX_TIMEOUT_MS: '3600000' });
  assert.ok(!invocation.argv.some((arg) => /netcup/.test(arg)), 'the project allow rules are not carried over');
});
