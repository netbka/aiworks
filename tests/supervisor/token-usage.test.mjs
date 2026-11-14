// A resumed store must retain the attribution and counters of each real attempt, including retries and failed calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart, campaignStatus } from '../../src/supervisor/api.mjs';
import { baselineReport } from '../../src/supervisor/baseline.mjs';
import { launchMetadata, operationUsage, providerTokens } from '../../src/supervisor/token-usage.mjs';
import { declaration } from './helpers.mjs';

test('a restart preserves model attribution and partial counters without recharging retries or overlapping token categories', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-tokens-'));
  const path = join(dir, 'supervisor.db');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const partial = operationUsage({ executor_kind: 'codex-cli', outcome: { receipt: { models: [{ model: 'test[1m]',
    usage: { input: 100, output: 10, total: 110 }, partialFields: ['input', 'output', 'total'] }] } } });
  assert.deepEqual([partial.total, partial.partialRuns, partial.unknownRuns, partial.models[0].coverage.input, partial.models[0].model],
    [110, 1, 0, 0, 'test[1m]']);
  const decl = declaration();
  campaignStart(store, decl, 1000);
  let seq = 0;
  function record(kind, outcome, { role = 'implement', routing = null } = {}) {
    const id = `op-${++seq}`;
    store.insert('operations', { id, campaign_id: decl.campaignId, task_id: decl.tasks[0].id, kind: role, seq,
      idempotency_key: id, lease_generation: 1, state: 'finished', session_id: id, run_dir: 'synthetic', workspace: 'synthetic',
      packet: {}, packet_digest: 'd', executor_kind: kind, routing, outcome, created_at: 1000 + seq, updated_at: 1000 + seq });
  }
  const claude = 'claude-cli', codex = 'codex-cli';
  record(claude, { class: 'error', receipt: providerTokens({ total_cost_usd: 12.5, model: 'primary', modelUsage: {
    primary: { inputTokens: 40, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, outputTokens: 20 },
    secondary: { inputTokens: 3, cacheReadInputTokens: 1, cacheCreationInputTokens: 0, outputTokens: 1 },
  }, usage: { input_tokens: 43, cache_read_input_tokens: 11, cache_creation_input_tokens: 5, output_tokens: 21 } }, claude) },
  { routing: { decision: { chosen: { kind: claude, model: 'alias', tier: 2 } }, launch: launchMetadata(['cli', '--model', 'alias', '--effort', 'high'], claude) } });
  const retry = { class: 'invalid-result', receipt: providerTokens({ model: 'worker', usage: {
    input_tokens: 100, cached_input_tokens: 70, output_tokens: 15, reasoning_output_tokens: 10,
  } }, codex) };
  record(codex, retry, { routing: { decision: { chosen: { kind: codex, model: 'worker', tier: 1 } },
    launch: launchMetadata(['cli', '-c', 'model_reasoning_effort="low"'], codex) } });
  record(codex, { class: 'error', receipt: { model: 'worker', effort: 'high', usage: { total: 0 } } });
  record(codex, { class: 'error', receipt: { model: 'worker', usage: { input: 3 } } });
  record('cursor-cli', { class: 'timeout', receipt: { costUsd: 1.5 } }, { role: 'verify',
    routing: { launch: { executor: 'cursor-cli', model: 'auto' }, decision: { chosen: { kind: claude, model: 'wrong-provider', tier: 3 } } } });
  store.insert('coordinator_runs', { id: 'intake.1', state: 'answered', session_id: 'plan', run_dir: 'synthetic', workspace: 'synthetic',
    message_ids: [], outcome: { class: 'result', receipt: { executorKind: claude, model: 'planner', usage: { total: 7 } } }, created_at: 1500, updated_at: 1600 });

  const campaign = store.campaign(decl.campaignId);
  store.patch('campaigns', { id: campaign.id }, campaign.version, { blocker: { kind: 'budget', reason: 'cost cap reached ($9)' },
    status: 'blocked-owner', next_action: 'raise project budget' }, 1600);
  store.close();
  store = new Store(path);
  const status = campaignStatus(store, decl.campaignId);
  assert.equal(status.blocker, null);
  assert.equal(status.nextAction, null);
  const usage = status.usage;
  assert.deepEqual([usage.runs, usage.reportedRuns, usage.unknownRuns, usage.partialRuns, usage.total], [5, 4, 1, 1, 195]);
  assert.deepEqual(status.tasks[0].usage, usage);
  assert.deepEqual(usage.models.map((row) => [row.model, row.tier, row.effort, row.role, row.total]), [
    ['primary', 2, 'high', 'implement', 75], ['secondary', null, null, 'implement', 5],
    ['worker', 1, 'low', 'implement', 115], ['worker', null, 'high', 'implement', 0],
    ['worker', null, null, 'implement', null], [null, null, null, 'verify', null],
  ]);
  assert.deepEqual([usage.models[2].cacheRead, usage.models[2].reasoning, usage.models[2].output], [70, 10, 15]);
  assert.deepEqual([usage.models[4].input, usage.models[4].output, usage.models[4].coverage.output], [3, null, 0]);
  const report = baselineReport(store);
  assert.deepEqual(report.totals, usage);
  assert.deepEqual([report.coordinator.total, report.coordinator.models[0].role], [7, 'planning']);
  assert.doesNotMatch(JSON.stringify({ usage, report }), /costUsd|usd-reported|total_cost_usd/);
});
