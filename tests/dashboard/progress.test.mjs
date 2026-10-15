// Live worker progress on the agent card: counts and timestamps from the provider's own record, never content.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { declaration } from '../supervisor/helpers.mjs';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';

test('agent cards show turns, tool calls and last activity from the worker transcript without leaking text', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-progress-'));
  const configDir = join(dataDir, 'claude-config');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const store = new Store(join(dataDir, 'supervisor.db'));
  const d = declaration();
  campaignStart(store, d);
  t.after(() => { store.close(); if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; rmSync(dataDir, { recursive: true, force: true }); });
  const now = Date.now();
  const workspace = join(dataDir, 'worktrees', 'task one');
  const op = (id, executor, session) => {
    const runDir = join(dataDir, 'runs', id); mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'heartbeat'), String(now));
    store.insert('operations', { id, campaign_id: d.campaignId, task_id: 'T1', kind: 'implement', seq: 1, idempotency_key: id, lease_generation: 1,
      state: 'dispatched', session_id: session, run_dir: runDir, workspace, packet: {}, packet_digest: 'p', created_at: now, updated_at: now, executor_kind: executor });
    return runDir;
  };
  // Claude: transcript under <config>/projects/<cwd slug>/<session>.jsonl.
  const session = '11111111-2222-4333-8444-555555555555';
  const slugDir = join(configDir, 'projects', workspace.replace(/[^A-Za-z0-9]/g, '-')); mkdirSync(slugDir, { recursive: true });
  const stamp = (offset) => new Date(now - offset).toISOString();
  writeFileSync(join(slugDir, `${session}.jsonl`), [
    { type: 'user', timestamp: stamp(90_000), message: { content: 'secret-marker prompt' } },
    { type: 'assistant', timestamp: stamp(80_000), message: { content: [{ type: 'text', text: 'secret-marker' }, { type: 'tool_use', name: 'Bash', input: { command: 'secret-marker' } }] } },
    { type: 'assistant', timestamp: stamp(20_000), message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'secret-marker' } }] } },
    'not json',
  ].map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n'));
  op('claude-op', 'claude-cli', session);
  let agent = supervisorSnapshot(dataDir).campaigns[0].agents.find((item) => item.id === 'claude-op');
  assert.deepEqual([agent.progress.source, agent.progress.turns, agent.progress.toolCalls, agent.progress.lastTool], ['session-transcript', 2, 2, 'Write']);
  assert.ok(Math.abs(agent.progress.lastActivityAt - (now - 20_000)) < 1000);
  // Codex: streamed JSONL in the run directory.
  const runDir = op('codex-op', 'codex-cli', 'codex-session');
  writeFileSync(join(runDir, 'stdout.json'), [
    { type: 'thread.started', thread_id: 'secret-marker' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'secret-marker' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'secret-marker', status: 'completed', exit_code: 0 } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'aiworks_repository', tool: 'read', arguments: { x: 'secret-marker' } } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  const state = supervisorSnapshot(dataDir);
  agent = state.campaigns[0].agents.find((item) => item.id === 'codex-op');
  assert.deepEqual([agent.progress.source, agent.progress.turns, agent.progress.toolCalls, agent.progress.lastTool], ['streamed-output', 1, 2, 'aiworks_repository.read']);
  assert.ok(!JSON.stringify(state).includes('secret-marker'));
  // No record yet: progress is null, not an error.
  op('silent-op', 'claude-cli', '99999999-2222-4333-8444-555555555555');
  assert.equal(supervisorSnapshot(dataDir).campaigns[0].agents.find((item) => item.id === 'silent-op').progress, null);
});

test('a live worker waiting on one long command reads as running a command, not possibly stuck (#102)', async (t) => {
  const { busyOnCommand, COMMAND_MAX_MS } = await import('../../src/dashboard/copy.mjs');
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-busy-'));
  const configDir = join(dataDir, 'claude-config');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const store = new Store(join(dataDir, 'supervisor.db'));
  const d = declaration();
  campaignStart(store, d);
  t.after(() => { store.close(); if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; rmSync(dataDir, { recursive: true, force: true }); });
  const now = Date.now();
  const M = 60_000;
  const workspace = join(dataDir, 'worktrees', 'busy');
  const session = '22222222-2222-4333-8444-555555555555';
  const slugDir = join(configDir, 'projects', workspace.replace(/[^A-Za-z0-9]/g, '-')); mkdirSync(slugDir, { recursive: true });
  const runDir = join(dataDir, 'runs', 'busy-op'); mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'heartbeat'), String(now));
  store.insert('operations', { id: 'busy-op', campaign_id: d.campaignId, task_id: 'T1', kind: 'implement', seq: 1, idempotency_key: 'busy-op', lease_generation: 1,
    state: 'dispatched', session_id: session, run_dir: runDir, workspace, packet: {}, packet_digest: 'p', created_at: now - 40 * M, updated_at: now, executor_kind: 'claude-cli' });
  const stamp = (offset) => new Date(now - offset).toISOString();
  const write = (events) => writeFileSync(join(slugDir, `${session}.jsonl`), events.map((line) => JSON.stringify(line)).join('\n'));
  const agent = () => supervisorSnapshot(dataDir).campaigns[0].agents.find((item) => item.id === 'busy-op');
  const toolUse = (id, at) => ({ type: 'assistant', timestamp: stamp(at), message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm run check' } }] } });
  const result = (id) => ({ type: 'user', timestamp: stamp(27 * M), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

  // The newest command has no result yet: it has been running for 26 minutes, so the worker is busy.
  write([toolUse('a', 30 * M), result('a'), toolUse('b', 26 * M)]);
  let busy = agent();
  assert.deepEqual([busy.progress.runningTool, Math.round((now - busy.progress.runningSince) / M)], ['Bash', 26]);
  assert.equal(busyOnCommand(busy, now), 26);
  // Every command has its result: an idle worker still reads as possibly stuck after 15 minutes.
  write([toolUse('a', 30 * M), result('a')]);
  busy = agent();
  assert.equal(busy.progress.runningTool, null);
  assert.equal(busyOnCommand(busy, now), null);
  // A dead runner, or a command running past the limit, is not busy either.
  write([toolUse('b', 26 * M)]);
  assert.equal(busyOnCommand({ ...agent(), heartbeatState: 'stale' }, now), null);
  write([toolUse('c', COMMAND_MAX_MS + 5 * M)]);
  assert.equal(busyOnCommand(agent(), now), null);
});
