// Child admission is idempotent across crash and retry (docs/design/WORK_ENVELOPE.md section 6.4, slice E3; plan STA8).
// A controller process settles a planning operation and is killed by the fault hook (AIWORKS_FAULT, process.exit 86)
// before and after the settling transaction commits; a replacement with a new lease generation settles it again. A
// controller whose lease generation is stale writes nothing. Disposable stores and a real child process only: no worker,
// model, network or GitHub call.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { authorityDigest, scopeDigest, validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { declaration, FAST, GOVERNANCE, ROOT, SQLITE } from './helpers.mjs';
const { Store, FencedError } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { campaignStart } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const { PLAN_TASK, planHead, settleAmendment } = SQLITE ? await import('../../src/supervisor/plan.mjs') : {};
// Settling starts no worker and needs no Windows containment, so this runs on Windows and on Linux CI alike.
const needsSqlite = SQLITE ? false : 'node:sqlite requires Node >= 22.5';

const CAMPAIGN = 'plan-crash';
const SESSION = 'plan-session-1';
const OP = `${CAMPAIGN}.${PLAN_TASK}.plan.1`;
const child = (id, extra = {}) => ({ id, issue: 512, title: `child ${id}`, deliverable: 'commit', goal: `Child ${id}.`,
  dependsOn: ['T1'], acceptance: [`${id} works`], references: ['AGENTS.md'], writes: [`src/search/${id.toLowerCase()}/`], ...extra });

function approved() {
  const v1 = declaration({ campaignId: CAMPAIGN, tasks: [{ id: 'T1', issue: 512, title: 'first task', deliverable: 'commit', goal: 'Produce T1.',
    dependsOn: [], acceptance: ['T1 exists'], references: ['AGENTS.md'], writes: ['src/chat/ui/'] }] });
  return validateDeclaration({ ...v1, version: 2, envelope: {
    scopeVersion: 1, request: { route: 'goal', pinned: { base: 'a'.repeat(40) } },
    outcome: 'People can search the text of their chats.', acceptance: ['Searching a word finds the message'],
    writes: ['src/chat/', 'src/search/'], deliverables: ['commit'], issues: [512], web: null, release: { mode: 'review-only' }, planning: 'adaptive',
  } });
}

/**
 * A data directory with a registered envelope campaign and one open planning operation, as slice E5 will dispatch it,
 * plus the structured result its worker returned. The verdict is what reconcile reads from result.json and classifies.
 */
function prepared(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-plan-crash-'));
  const config = { ...FAST, governanceRoot: GOVERNANCE };
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
  const store = new Store(join(dataDir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const decl = approved();
  campaignStart(store, decl);
  store.recordOperation({ id: OP, campaign_id: CAMPAIGN, task_id: PLAN_TASK, kind: 'plan', seq: 1, idempotency_key: OP, lease_generation: 1,
    state: 'dispatched', session_id: SESSION, run_dir: join(dataDir, 'runs', OP), workspace: join(dataDir, 'workspace'),
    packet: { tenantId: 'example-org', projectId: 'sampleapp', environment: 'research', taskId: PLAN_TASK, stageId: 'plan', runId: OP,
      revision: '0'.repeat(40), authorityDigest: authorityDigest(decl) },
    packet_digest: 'd'.repeat(64), created_at: 1, updated_at: 1 });
  const verdict = { class: 'result', receipt: { sessionId: SESSION, costUsd: 0.25 }, value: { result: 'resolved', summary: 'Two steps are missing.',
    amendment: { basis: scopeDigest(decl), rationale: 'Search needs an index before the box.', ops: [{ op: 'add', task: child('C1') }, { op: 'add', task: child('C2', { dependsOn: ['C1'] }) }] } } };
  writeFileSync(join(dataDir, 'verdict.json'), JSON.stringify(verdict));
  return { dataDir, config, store, decl, verdict };
}

// One controller process: take the lease under a new instance, settle the planning operation, exit. AIWORKS_FAULT kills it
// at the named point exactly as a crash would: process.exit(86), inside or after the settling transaction.
const SCRIPT = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [dataDir, campaignId, opId] = process.argv.slice(2);
const { Store } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/supervisor/store.mjs')).href)});
const { Controller } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/supervisor/controller.mjs')).href)});
const store = new Store(join(dataDir, 'supervisor.db'));
const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
const controller = new Controller({ store, config, dataDir });
const lease = store.acquireLease(campaignId, controller.instanceId, Date.now(), config.leaseMs);
if (!lease) { console.log(JSON.stringify({ noLease: true })); process.exit(3); }
const op = store.get('SELECT * FROM operations WHERE id = ?', opId);
const settled = controller.applyOutcome({ id: campaignId, generation: lease.generation }, op, JSON.parse(readFileSync(join(dataDir, 'verdict.json'), 'utf8')));
controller.release();
store.close();
console.log(JSON.stringify({ settled, generation: lease.generation }));
`;

function controllerProcess(t, dataDir, fault = null) {
  const dir = join(dataDir, 'script');
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'settle.mjs');
  writeFileSync(script, SCRIPT);
  const env = { ...process.env };
  delete env.AIWORKS_FAULT;
  if (fault) env.AIWORKS_FAULT = fault;
  const run = spawnSync(process.execPath, ['--no-warnings', script, dataDir, CAMPAIGN, OP], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const last = run.stdout.trim().split(/\r?\n/).at(-1);
  return { status: run.status, stderr: run.stderr, output: run.status === 0 ? JSON.parse(last) : null };
}

const count = (store, table) => store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE campaign_id = ?`, CAMPAIGN).n;
const journal = (store, kind) => store.all('SELECT detail FROM journal WHERE campaign_id = ? AND kind = ?', CAMPAIGN, kind).map((row) => row.detail);
// A crashed holder's lease is suspected dead only after it expires; the test lets that time pass at once.
const expireLease = (store) => store.run('UPDATE leases SET expires_at = 0 WHERE campaign_id = ?', CAMPAIGN);

test('crash at before-plan-settle: nothing is written, the operation stays open, and the replacement admits it once', { skip: needsSqlite }, (t) => {
  const { dataDir, store } = prepared(t);
  const crashed = controllerProcess(t, dataDir, 'before-plan-settle');
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(store.get('SELECT state FROM operations WHERE id = ?', OP).state, 'dispatched', 'the settle rolled back: the operation is still open');
  assert.equal(count(store, 'plan_amendments'), 0);
  assert.equal(count(store, 'task_specs'), 0);
  assert.equal(count(store, 'tasks'), 1, 'no child task row');
  assert.equal(store.campaign(CAMPAIGN).cost_usd, 0, 'not charged either');
  assert.deepEqual(journal(store, 'amendment-admitted'), []);

  expireLease(store);
  const replacement = controllerProcess(t, dataDir);
  assert.equal(replacement.status, 0, replacement.stderr);
  assert.equal(replacement.output.generation, 2, 'a new lease generation');
  assert.equal(replacement.output.settled.outcome, 'admitted');
  assert.equal(store.get('SELECT state FROM operations WHERE id = ?', OP).state, 'finished');
  const amendment = store.get('SELECT * FROM plan_amendments WHERE campaign_id = ?', CAMPAIGN);
  assert.deepEqual([amendment.seq, amendment.lease_generation, amendment.source_operation], [1, 2, OP], 'recorded under the generation that settled it');
  assert.deepEqual(store.tasks(CAMPAIGN).map((row) => row.task_id), ['T1', 'C1', 'C2']);
  assert.equal(store.campaign(CAMPAIGN).cost_usd, 0.25);
  assert.equal(journal(store, 'amendment-admitted').length, 1);
});

test('crash at after-plan-settle: the amendment is committed once and the replacement applies nothing twice', { skip: needsSqlite }, (t) => {
  const { dataDir, store, verdict } = prepared(t);
  const crashed = controllerProcess(t, dataDir, 'after-plan-settle');
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(store.get('SELECT state FROM operations WHERE id = ?', OP).state, 'finished');
  assert.equal(count(store, 'plan_amendments'), 1);
  assert.equal(count(store, 'task_specs'), 2);
  const before = { amendment: store.get('SELECT * FROM plan_amendments WHERE campaign_id = ?', CAMPAIGN), tasks: store.tasks(CAMPAIGN), head: planHead(store, CAMPAIGN) };

  expireLease(store);
  const replacement = controllerProcess(t, dataDir);
  assert.equal(replacement.status, 0, replacement.stderr);
  assert.equal(replacement.output.settled, null, 'the operation was already settled');
  assert.deepEqual(store.get('SELECT * FROM plan_amendments WHERE campaign_id = ?', CAMPAIGN), before.amendment);
  assert.deepEqual(store.tasks(CAMPAIGN), before.tasks);
  assert.equal(planHead(store, CAMPAIGN), before.head);
  assert.equal(store.campaign(CAMPAIGN).cost_usd, 0.25, 'charged once');
  assert.equal(journal(store, 'amendment-admitted').length, 1);
  // The same idempotency key returns the earlier amendment unchanged, though it has moved the plan head since.
  const operation = store.get('SELECT * FROM operations WHERE id = ?', OP);
  const again = store.tx(() => settleAmendment(store, { campaign: store.campaign(CAMPAIGN), operation, amendment: verdict.value.amendment, leaseGeneration: 3, now: 5 }));
  assert.deepEqual(again, { outcome: 'repeated', seq: 1, digest: before.amendment.digest });
  assert.equal(count(store, 'plan_amendments'), 1);
});

test('a controller whose lease generation is stale settles nothing; the current holder settles it', { skip: needsSqlite }, (t) => {
  const { dataDir, config, store, verdict } = prepared(t);
  let now = 1_000_000;
  const clock = () => now;
  const first = new Controller({ store, config, dataDir, fault: null, now: clock, instanceId: 'first' });
  const second = new Controller({ store, config, dataDir, fault: null, now: clock, instanceId: 'second' });
  const old = store.acquireLease(CAMPAIGN, 'first', now, config.leaseMs);
  now += config.leaseMs + 1; // the first holder stalls past its lease
  const current = store.acquireLease(CAMPAIGN, 'second', now, config.leaseMs);
  assert.deepEqual([old.generation, current.generation], [1, 2]);
  const op = store.get('SELECT * FROM operations WHERE id = ?', OP);
  assert.throws(() => first.applyOutcome({ id: CAMPAIGN, generation: old.generation }, op, verdict), FencedError);
  assert.equal(store.get('SELECT state FROM operations WHERE id = ?', OP).state, 'dispatched');
  assert.equal(count(store, 'plan_amendments'), 0, 'the stale generation wrote nothing');
  assert.equal(count(store, 'task_specs'), 0);
  assert.deepEqual(journal(store, 'operation-finished'), []);
  const settled = second.applyOutcome({ id: CAMPAIGN, generation: current.generation }, op, verdict);
  assert.equal(settled.outcome, 'admitted');
  assert.equal(store.get('SELECT lease_generation FROM plan_amendments WHERE campaign_id = ?', CAMPAIGN).lease_generation, 2);
  assert.equal(second.applyOutcome({ id: CAMPAIGN, generation: current.generation }, op, verdict), null, 'a retry of the settle applies nothing');
  assert.equal(count(store, 'plan_amendments'), 1);
});

test('a refused amendment finishes the planning operation and writes no child; a result from another session is not admitted', { skip: needsSqlite }, (t) => {
  const { dataDir, config, store, verdict } = prepared(t);
  const controller = new Controller({ store, config, dataDir, fault: null, instanceId: 'only' });
  const lease = store.acquireLease(CAMPAIGN, 'only', Date.now(), config.leaseMs);
  const op = store.get('SELECT * FROM operations WHERE id = ?', OP);
  const forged = { ...verdict, receipt: { sessionId: 'another-session' } };
  assert.equal(controller.applyOutcome({ id: CAMPAIGN, generation: lease.generation }, op, forged), null);
  assert.equal(store.get('SELECT outcome FROM operations WHERE id = ?', OP).outcome.class, 'invalid-result');
  assert.equal(count(store, 'plan_amendments'), 0);
  // A widening proposed by a fresh planning operation is refused with its code and recorded for the owner.
  const second = { ...op, id: `${CAMPAIGN}.${PLAN_TASK}.plan.2`, seq: 2, idempotency_key: `${CAMPAIGN}.${PLAN_TASK}.plan.2`, state: 'dispatched' };
  store.insert('operations', { ...second, packet: op.packet, outcome: null });
  const widening = { ...verdict, value: { ...verdict.value, amendment: { ...verdict.value.amendment, ops: [{ op: 'add', task: child('C1', { writes: ['src/billing/'] }) }] } } };
  const refused = controller.applyOutcome({ id: CAMPAIGN, generation: lease.generation }, store.get('SELECT * FROM operations WHERE id = ?', second.id), widening);
  assert.deepEqual([refused.outcome, refused.code, refused.kind, refused.index], ['refused', 'WIDEN_FILES', 'owner', 0]);
  assert.equal(store.get('SELECT state FROM operations WHERE id = ?', second.id).state, 'finished');
  assert.equal(count(store, 'task_specs'), 0);
  assert.deepEqual(journal(store, 'amendment-refused').map((detail) => [detail.code, detail.kind, detail.op]), [['WIDEN_FILES', 'owner', second.id]]);
  controller.release();
});
