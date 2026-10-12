// MOD1 (docs/design/MODEL_ROUTING.md slice R1): `supervisor baseline` reports cost and outcomes from any store, read-only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLI, ROOT, SQLITE, declaration } from './helpers.mjs';
const Store = SQLITE ? (await import('../../src/supervisor/store.mjs')).Store : null;
const { DatabaseSync } = SQLITE ? await import('node:sqlite') : {};

const T0 = Date.parse('2026-10-12T08:00:00Z');
const at = (minutes) => T0 + minutes * 60_000;
const BEFORE = { kind: 'claude-cli', model: 'sonnet', permissionMode: 'auto', implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
const CHAIN = { kind: 'cli-chain', implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1, providers: [
  { kind: 'codex-cli' }, { kind: 'claude-cli', model: 'opus', permissionMode: 'auto' }, { kind: 'cursor-cli' }, { kind: 'agy-cli', model: 'gemini-3-pro' }] };
const usage = (input, output, extra = {}) => ({ input, output, cacheRead: 10, cacheCreation: null, ...extra });

/** A synthetic store: Claude, Codex, Cursor and AGY runs, one refunded run, and an executor amendment between runs. */
function syntheticStore(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-baseline-'));
  const data = join(root, 'data');
  const store = new Store(join(data, 'supervisor.db'));
  const decl = { ...declaration({ tasks: [
    { id: 'T1', issue: 1, title: 'code', deliverable: 'commit', goal: 'g', dependsOn: [], acceptance: ['a'], references: ['AGENTS.md'] },
    { id: 'T2', issue: 2, title: 'report', deliverable: 'report', goal: 'g', dependsOn: [], acceptance: ['a'], references: ['AGENTS.md'] },
    { id: 'T3', issue: 3, title: 'browser', deliverable: 'report', goal: 'g', dependsOn: [], acceptance: ['a'], references: ['AGENTS.md'], web: { urls: ['http://127.0.0.1/'] } },
  ] }), executor: CHAIN };
  store.insert('campaigns', { id: decl.campaignId, controller_id: 'c', scope_digest: 'd', authorization_version: 2, declaration: decl,
    control: 'running', status: 'complete', runs_used: 9, cost_usd: 0.875, version: 1, created_at: at(0), updated_at: at(60) });
  for (const [ord, id, rounds] of [[0, 'T1', 1], [1, 'T2', 0], [2, 'T3', 0]]) {
    store.insert('tasks', { campaign_id: decl.campaignId, task_id: id, ord, state: 'verified', repair_rounds: rounds, version: 1, updated_at: at(60) });
  }
  let seq = 0;
  const op = (task, kind, executor, minute, outcome, { target = null, base = 'base0', state = 'finished' } = {}) => {
    seq += 1;
    store.insert('operations', { id: `op${seq}`, campaign_id: decl.campaignId, task_id: task, kind, seq, idempotency_key: `k${seq}`,
      lease_generation: 1, state, session_id: `s${seq}`, run_dir: 'r', workspace: 'w', base_sha: base, target_sha: target,
      packet: {}, packet_digest: 'p', outcome, created_at: at(minute), updated_at: at(minute + 2), executor_kind: executor });
  };
  const resolved = (headSha, receipt) => ({ class: 'result', value: { result: 'resolved', headSha }, receipt });
  const verdict = (value, receipt) => ({ class: 'result', value: { verdict: value, findings: value === 'rejected' ? [{ severity: 'blocking' }] : [] }, receipt });
  // Before the amendment the campaign ran Claude on sonnet.
  op('T1', 'implement', 'claude-cli', 1, resolved('a1', { costUsd: 0.5, usage: usage(100, 20), measured: true }));
  op('T1', 'verify', 'claude-cli', 3, verdict('rejected', { costUsd: 0.25, usage: usage(50, 5), measured: true }), { target: 'a1' });
  store.journal(decl.campaignId, 'executor-amended', { from: BEFORE, to: CHAIN }, at(5));
  // A usage limit refused this run before any work: refunded, and excluded from every class.
  op('T1', 'implement', 'claude-cli', 6, { class: 'quota', refunded: true, detail: 'limit', receipt: { costUsd: 7, usage: null, measured: true } });
  store.journal(decl.campaignId, 'run-refunded', { op: 'op3' }, at(8));
  store.journal(decl.campaignId, 'executor-fallback', { task: 'T1', from: 'claude-cli', executor: 'codex-cli', reason: 'quota' }, at(8));
  op('T1', 'implement', 'codex-cli', 10, resolved('a2', { costUsd: null, usage: usage(400, 40, { inputIncludesCacheRead: true }), measured: true }));
  op('T1', 'verify', 'claude-cli', 13, verdict('accepted', { costUsd: 0.125, usage: usage(60, 6), measured: true }), { target: 'a2' });
  op('T2', 'implement', 'cursor-cli', 20, resolved(null, { costUsd: null, usage: null, measured: false }), { base: 'b2' });
  op('T2', 'verify', 'codex-cli', 23, verdict('accepted', { costUsd: null, usage: usage(30, 3, { inputIncludesCacheRead: true }), measured: true }), { target: 'b2' });
  op('T3', 'implement', 'agy-cli', 30, resolved(null, { costUsd: null, usage: usage(700, 70), measured: true }), { base: 'b3' });
  op('T3', 'verify', 'agy-cli', 33, verdict('accepted', { costUsd: null, usage: usage(200, 20), measured: true }), { target: 'b3' });
  store.insert('coordinator_runs', { id: 'k1', state: 'finished', session_id: 's', run_dir: 'r', workspace: 'w', message_ids: [], cost_usd: 1, created_at: at(40), updated_at: at(41) });
  store.insert('coordinator_runs', { id: 'k2', state: 'failed', session_id: 's', run_dir: 'r', workspace: 'w', message_ids: [], cost_usd: null, created_at: at(42), updated_at: at(43) });
  store.close();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { data, db: join(data, 'supervisor.db') };
}

function baseline(data, ...extra) {
  const env = { ...process.env };
  delete env.AIWORKS_DATA;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--no-warnings', CLI, 'baseline', '--data', data, ...extra], { env, windowsHide: true, encoding: 'utf8' });
}
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const group = (report, stage, executor) => report.classes.filter((item) => item.stage === stage && item.executor === executor);

test('baseline reports each provider in its own unit, counts unknown cost as unknown and excludes refunded runs', { skip: !SQLITE }, (t) => {
  const { data, db } = syntheticStore(t);
  const before = digest(db);
  const run = baseline(data, '--json');
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(digest(db), before, 'the store file is byte-identical after the run');

  // Unknown cost is unknown, never zero: Cursor and AGY report no dollars.
  const cursor = group(report, 'implement', 'cursor-cli');
  assert.deepEqual(cursor.map((item) => item.usd), [{ reported: null, reportedRuns: 0, unknownRuns: 1 }]);
  assert.deepEqual(cursor[0].tokens, {}, 'Cursor reports no usage at all');
  assert.deepEqual(group(report, 'implement', 'agy-cli')[0].usd, { reported: null, reportedRuns: 0, unknownRuns: 1 });
  assert.equal(group(report, 'implement', 'agy-cli')[0].tokens['agy-cli'].input, 700);
  // Refunded runs are excluded: 9 operations, 1 refunded; its reported $7 is not in the totals.
  assert.equal(report.operations.counted, 8);
  assert.equal(report.refunded.runs, 1);
  assert.equal(report.refunded.usd.reported, 7);
  assert.deepEqual(report.totals.usd, { reported: 0.875, reportedRuns: 3, unknownRuns: 5 });
  // Units are never summed: dollars stand apart from tokens, and tokens stay per provider.
  assert.deepEqual(Object.keys(report.totals).sort(), ['tokens', 'usd']);
  assert.deepEqual(Object.keys(report.totals.tokens).sort(), ['agy-cli', 'claude-cli', 'codex-cli']);
  assert.equal(report.totals.tokens['claude-cli'].input, 210);
  assert.equal(report.totals.tokens['codex-cli'].input, 430);
  assert.equal(report.totals.tokens['codex-cli'].inputIncludesCacheReadRuns, 2);
  assert.equal(report.totals.tokens['agy-cli'].input, 900);
  assert.deepEqual(report.coordinator, { runs: 2, usd: { reported: 1, reportedRuns: 1, unknownRuns: 1 } });
  assert.equal(report.waits.refundedRuns, 1);
  assert.deepEqual(report.waits.fallbacks, { 'claude-cli -> codex-cli (quota)': 1 });
  assert.equal(report.store.schemaVersion, 1);
});

test('baseline infers the model across an executor-amended entry and attributes accepted outcomes', { skip: !SQLITE }, (t) => {
  const { data } = syntheticStore(t);
  const report = JSON.parse(baseline(data, '--json').stdout);
  // Claude ran sonnet before the amendment and opus after it; Codex has no declared model, so it is the unknown CLI default.
  assert.deepEqual(group(report, 'implement', 'claude-cli').map((item) => [item.model, item.runs, item.rejected]), [['sonnet', 1, 1]]);
  assert.deepEqual(group(report, 'verify', 'claude-cli').map((item) => [item.model, item.runs]).sort(), [['opus', 1], ['sonnet', 1]]);
  assert.deepEqual(group(report, 'implement', 'codex-cli').map((item) => [item.model, item.modelKnown, item.accepted]), [['cli-default (unknown)', false, 1]]);
  assert.deepEqual(group(report, 'implement', 'agy-cli').map((item) => [item.risk, item.complexity, item.model]), [['R1', 'C1', 'gemini-3-pro']]);
  assert.deepEqual(group(report, 'implement', 'cursor-cli').map((item) => [item.risk, item.complexity]), [['R0', 'C1']]);

  const t1 = report.tasks.find((item) => item.taskId === 'T1');
  assert.deepEqual({ implementer: t1.implementer, implementAttempts: t1.implementAttempts, verifyRuns: t1.verifyRuns, firstPass: t1.firstPass, repairRounds: t1.repairRounds },
    { implementer: 'codex-cli', implementAttempts: 2, verifyRuns: 2, firstPass: false, repairRounds: 1 });
  assert.deepEqual(t1.usd, { reported: 0.875, reportedRuns: 3, unknownRuns: 1 });
  assert.equal(t1.msToVerified, 14 * 60_000);
  assert.equal(report.tasks.find((item) => item.taskId === 'T2').firstPass, true);
  assert.equal(report.acceptedOutcomes.reduce((sum, item) => sum + item.accepted, 0), 3);

  const text = baseline(data);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Baseline all time to /);
  assert.match(text.stdout, /implement\s+R0\s+C1\s+cursor-cli\s+cli-default \(unknown\)\s+1\s+1\s+0\s+0\s+unknown/);
  assert.match(text.stdout, /Reported, never spent\./);
  const since = JSON.parse(baseline(data, '--json', '--since', '2026-10-12T08:25:00Z').stdout);
  assert.equal(since.operations.counted, 2);
  assert.equal(since.coordinator.runs, 2);
  const badSince = baseline(data, '--since', 'yesterday-ish');
  assert.equal(badSince.status, 1);
  assert.match(badSince.stderr, /BASELINE_SINCE_INVALID/);
});

test('baseline refuses another store version and a missing store, and changes neither', { skip: !SQLITE }, (t) => {
  const { data, db } = syntheticStore(t);
  const raw = new DatabaseSync(db);
  raw.exec("UPDATE meta SET value = '2' WHERE key = 'store_version'");
  raw.close();
  const before = digest(db);
  const refused = baseline(data, '--json');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Unsupported store version/);
  assert.equal(refused.stdout, '');
  assert.equal(digest(db), before);
  const missing = baseline(join(data, 'missing'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /STORE_NOT_FOUND/);
});

test('baseline.mjs imports no process, network or provider module', () => {
  const source = readFileSync(join(ROOT, 'src', 'supervisor', 'baseline.mjs'), 'utf8');
  assert.deepEqual([...source.matchAll(/^import .*$/gm)], [], 'baseline.mjs reads the store it is given and imports nothing');
  assert.doesNotMatch(source, /\b(fetch|spawn|exec(File)?Sync|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/);
});
