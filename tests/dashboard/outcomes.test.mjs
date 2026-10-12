// Operator visibility of worker verdicts, blocker reasons and the cost ceiling (no worker text leaks).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { declaration } from '../supervisor/helpers.mjs';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';

test('task outcomes, blocker reasons and the cost ceiling are visible without worker text', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-dashboard-'));
  const store = new Store(join(dataDir, 'supervisor.db'));
  const d = declaration({ limits: { maxCostUsd: 50, unknownRunCostUsd: 3 } });
  campaignStart(store, d);
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const now = Date.now();
  const op = (id, kind, outcome, offset) => store.insert('operations', { id, campaign_id: d.campaignId, task_id: 'T1', kind, seq: 1, idempotency_key: id,
    lease_generation: 1, state: 'finished', session_id: 's', run_dir: join(dataDir, 'runs', id), workspace: 'w', packet: {}, packet_digest: 'p',
    outcome, created_at: now + offset, updated_at: now, executor_kind: 'codex-cli' });
  op('op-impl', 'implement', { class: 'result', value: { result: 'resolved', summary: 'secret-marker', report: 'secret-marker' }, receipt: { costUsd: null } }, 0);
  op('op-verify', 'verify', { class: 'result', value: { verdict: 'rejected', summary: 'secret-marker',
    findings: [{ id: 'F1', severity: 'blocking', description: 'secret-marker' }, { id: 'F2', severity: 'non-blocking', description: 'x' }] }, receipt: { costUsd: null } }, 1);
  op('op-unavailable', 'implement', { class: 'unavailable', detail: 'secret-marker', refunded: true }, -5);
  store.journal(d.campaignId, 'operation-finished', { op: 'op-verify', executor: 'codex-cli', class: 'result', terminal: 'rejected', blocking: 1, detail: 'secret-marker' }, now);
  const c = store.campaign(d.campaignId);
  store.patch('campaigns', { id: d.campaignId }, c.version, { blocker: { kind: 'budget', class: 'B3', reason: 'worker-run cap reached (12/12)', requestedAction: 'Raise limits.maxWorkerRuns', at: now } }, now);
  const state = supervisorSnapshot(dataDir), campaign = state.campaigns[0], task = campaign.tasks.find((item) => item.id === 'T1');
  assert.deepEqual([task.lastOutcome.role, task.lastOutcome.outcome, task.lastOutcome.terminal, task.lastOutcome.blockingFindings], ['Verifier', 'result', 'rejected', 1]);
  assert.equal(campaign.blockerClass, 'B3');
  assert.match(campaign.blockerReason, /cap reached/);
  assert.match(campaign.blockerAction, /maxWorkerRuns/);
  assert.equal(state.activity[0].terminal, 'rejected');
  assert.equal(state.activity[0].blocking, 1);
  assert.equal(campaign.budget.unknownCostRuns, 2, 'the refunded unavailable run is not priced');
  assert.equal(campaign.budget.maxCostUsd, 50);
  assert.ok(!JSON.stringify(state).includes('secret-marker'));
});
