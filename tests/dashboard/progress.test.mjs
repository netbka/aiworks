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
  // One open operation per task (the store refuses a second): each open operation below has its own task.
  const op = (id, executor, session, task = 'T1') => {
    const runDir = join(dataDir, 'runs', id); mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'heartbeat'), String(now));
    store.insert('operations', { id, campaign_id: d.campaignId, task_id: task, kind: 'implement', seq: 1, idempotency_key: id, lease_generation: 1,
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
  const runDir = op('codex-op', 'codex-cli', 'codex-session', 'T2');
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
  // No record yet: progress is null, not an error. The Claude run on T1 has finished, so T1 takes a new operation.
  store.run("UPDATE operations SET state = 'finished' WHERE id = 'claude-op'");
  op('silent-op', 'claude-cli', '99999999-2222-4333-8444-555555555555');
  assert.equal(supervisorSnapshot(dataDir).campaigns[0].agents.find((item) => item.id === 'silent-op').progress, null);
});
