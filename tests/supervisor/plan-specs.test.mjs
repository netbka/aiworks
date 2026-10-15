// Task specs come from one accessor (docs/design/WORK_ENVELOPE.md section 6.4, slice E1): plan.mjs specOf returns the
// declared spec, or the live revision of a child task. The child tables are additive (store version 1), nothing writes
// them yet, and no packet of any committed campaign changes.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packetDigest } from '../../scripts/lib/worker-context.mjs';
import { campaignStart, campaignStatus } from '../../src/supervisor/api.mjs';
import { authorityDigest, projectGovernance } from '../../src/supervisor/campaign.mjs';
import { writeDomainConstraint } from '../../src/supervisor/work-ownership.mjs';
import { declaration, environment, GOVERNANCE, ROOT, skipWithoutSqlite, SQLITE } from './helpers.mjs';
const { Store, STORE_VERSION } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const { specOf, specsOf } = SQLITE ? await import('../../src/supervisor/plan.mjs') : {};

const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const POLICY = read('registry/worker-context-policy.json');
const COMMITTED = readdirSync(join(ROOT, 'tests/fixtures/campaigns')).filter((name) => name.endsWith('.json')).sort();
const CHILD_TABLES = ['plan_amendments', 'task_specs'];
const tables = (store) => store.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
const columns = (store, table) => store.all(`PRAGMA table_info(${table})`).map((column) => column.name);

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-plan-specs-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return root;
}

/** A writable store in a disposable directory, closed before the directory is removed. */
function opened(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-plan-specs-'));
  const store = new Store(join(root, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  return store;
}

/** A child spec row as slice E3 will write it; the accessor only reads it. */
function child(store, campaignId, spec, { revision = 1, cancelledAt = null } = {}) {
  store.insert('task_specs', { campaign_id: campaignId, task_id: spec.id, revision, amendment_seq: revision, spec,
    spec_digest: 'a'.repeat(64), fingerprint: 'b'.repeat(64), cancelled_at: cancelledAt, created_at: 1 });
}
const childTask = (id, title, extra = {}) => ({ id, issue: 439, title, deliverable: 'commit', goal: `Child ${id}.`, dependsOn: ['T1'],
  acceptance: ['child artifact exists'], references: ['AGENTS.md'], ...extra });
const taskRow = (campaignId, taskId, ord) => ({ campaign_id: campaignId, task_id: taskId, ord, state: 'pending', version: 1, updated_at: 1 });

test('an old store gains task_specs and plan_amendments on a writer open, with store version 1; status never migrates', { skip: skipWithoutSqlite }, (t) => {
  const path = join(temp(t), 'data', 'supervisor.db');
  const decl = declaration();
  // A store from before the child tables: everything else as today, the two tables absent.
  let store = new Store(path);
  campaignStart(store, decl);
  for (const table of CHILD_TABLES) store.run(`DROP TABLE ${table}`);
  const before = store.campaign(decl.campaignId);
  store.close();

  const reader = new Store(path, { readOnly: true });
  try {
    assert.ok(CHILD_TABLES.every((table) => !tables(reader).includes(table)), 'a read-only open adds no table');
    assert.deepEqual(specOf(reader, decl.campaignId, 'T1'), decl.tasks[0], 'declared specs read without the tables');
    assert.equal(specOf(reader, decl.campaignId, 'C1'), undefined);
    assert.deepEqual([...specsOf(reader, decl.campaignId).keys()], ['T1', 'T2']);
    assert.deepEqual(campaignStatus(reader, decl.campaignId).tasks.map((task) => task.id), ['T1', 'T2'], 'status reads an old store');
  } finally { reader.close(); }

  store = new Store(path);
  try {
    assert.equal(STORE_VERSION, 1);
    assert.equal(store.get("SELECT value FROM meta WHERE key = 'store_version'").value, '1', 'the store version does not change');
    assert.deepEqual(columns(store, 'plan_amendments'), ['campaign_id', 'seq', 'parent_digest', 'digest', 'idempotency_key', 'scope_digest',
      'authorization_version', 'source_operation', 'source_packet_digest', 'lease_generation', 'code_revision', 'ops', 'created_at']);
    assert.deepEqual(columns(store, 'task_specs'), ['campaign_id', 'task_id', 'revision', 'amendment_seq', 'spec', 'spec_digest',
      'fingerprint', 'cancelled_at', 'created_at']);
    assert.deepEqual(store.campaign(decl.campaignId), before, 'the campaign row is untouched');
    assert.equal(store.get('SELECT COUNT(*) AS n FROM task_specs').n, 0, 'nothing writes child specs yet');
    assert.equal(store.get('SELECT COUNT(*) AS n FROM plan_amendments').n, 0);
  } finally { store.close(); }
});

test('specOf returns the declared spec of every task of every committed campaign; a declared id always wins', { skip: skipWithoutSqlite }, (t) => {
  const root = temp(t);
  assert.ok(COMMITTED.length > 0);
  for (const name of COMMITTED) {
    const store = new Store(join(root, name.replace(/\.json$/, ''), 'supervisor.db'));
    try {
      const file = read(`tests/fixtures/campaigns/${name}`);
      campaignStart(store, file);
      for (const task of file.tasks) {
        assert.deepEqual(specOf(store, file.campaignId, task.id), task, `${name} ${task.id}`);
        assert.deepEqual(specOf(store, file.campaignId, task.id, store.campaign(file.campaignId).declaration), task, `${name} ${task.id} with its declaration`);
      }
      assert.deepEqual([...specsOf(store, file.campaignId).entries()], file.tasks.map((task) => [task.id, task]), `${name}: declaration order`);
      // A child row under a declared id (admission will refuse it, A3) never replaces the approved spec.
      const first = file.tasks[0];
      child(store, file.campaignId, { ...first, goal: 'Something else.' });
      assert.deepEqual(specOf(store, file.campaignId, first.id), first, `${name}: the declared ${first.id} wins`);
      assert.deepEqual(specsOf(store, file.campaignId).get(first.id), first);
    } finally { store.close(); }
  }
});

test('a child spec is read from its live revision; a cancelled one is not live', { skip: skipWithoutSqlite }, (t) => {
  const store = opened(t);
  const decl = declaration();
  campaignStart(store, decl);
  child(store, decl.campaignId, childTask('C1', 'first draft'));
  child(store, decl.campaignId, childTask('C1', 'revised child'), { revision: 2 });
  child(store, decl.campaignId, childTask('C2', 'cancelled child'), { cancelledAt: 5 });
  assert.equal(specOf(store, decl.campaignId, 'C1').title, 'revised child');
  assert.equal(specOf(store, decl.campaignId, 'C2'), undefined);
  assert.equal(specOf(store, decl.campaignId, 'C1', decl).title, 'revised child', 'a given declaration still falls back to children');
  assert.deepEqual([...specsOf(store, decl.campaignId).keys()], ['T1', 'T2', 'C1']);
  assert.equal(specOf(store, 'other-campaign', 'C1'), undefined, 'children belong to their own campaign');
});

test('status works for a task row absent from the declaration', { skip: skipWithoutSqlite }, (t) => {
  const store = opened(t);
  const decl = declaration();
  campaignStart(store, decl);
  // A live child that waits for T1, and a row with no spec at all.
  child(store, decl.campaignId, childTask('C1', 'child step'));
  store.insert('tasks', taskRow(decl.campaignId, 'C1', 2));
  store.insert('tasks', taskRow(decl.campaignId, 'X9', 3));
  const status = campaignStatus(store, decl.campaignId);
  assert.deepEqual(status.tasks.map((task) => task.id), ['T1', 'T2', 'C1', 'X9']);
  const c1 = status.tasks.find((task) => task.id === 'C1');
  assert.equal(c1.state, 'pending');
  assert.equal(c1.wait.code, 'dependency');
  assert.equal(c1.wait.text, 'Waiting for "first task" to finish', 'its dependency is named from the declared title');
  const x9 = status.tasks.find((task) => task.id === 'X9');
  assert.equal(x9.state, 'pending');
  assert.ok(x9.wait, 'a row without a spec still gets a wait reason');
  assert.equal(status.tasks.find((task) => task.id === 'T1').wait.code, 'ready', 'T1 stays the next step');
});

// The packet the controller builds for a declared task, written out from the dispatch code: what goes into it
// comes from the task's spec, so the same spec gives the same digest.
const packetFor = (decl, spec, { taskId = spec.id, kind = 'implement', runId = `${decl.campaignId}.${spec.id}.${kind}.1`, revision = '0'.repeat(40), governance } = {}) => ({
  version: 1, tenantId: decl.target.tenantId, projectId: decl.target.projectId, environment: decl.target.environment,
  taskId, stageId: kind, runId, role: kind === 'verify' ? 'verification' : 'implementer', revision,
  authorityDigest: authorityDigest(decl),
  access: kind === 'verify' || spec.deliverable === 'report' ? 'read-only' : 'write',
  goal: `${spec.title} (${decl.target.repository}#${spec.issue}). ${spec.goal}`.slice(0, 2000),
  constraints: [...decl.constraints, ...(spec.constraints ?? []), ...(spec.writes ? [writeDomainConstraint(spec.writes)] : [])],
  acceptance: spec.acceptance,
  references: spec.references.map((path) => ({ path, revision })),
  ...(governance ? { governance } : {}),
});

test('no packet digest of any committed campaign changes when specs come from the accessor', { skip: skipWithoutSqlite }, (t) => {
  const root = temp(t);
  let packets = 0;
  for (const name of COMMITTED) {
    const store = new Store(join(root, name.replace(/\.json$/, ''), 'supervisor.db'));
    try {
      const file = read(`tests/fixtures/campaigns/${name}`);
      campaignStart(store, file);
      const stored = store.campaign(file.campaignId).declaration;
      assert.equal(authorityDigest(stored), authorityDigest(file), `${name}: the packet authority digest`);
      for (const task of file.tasks) {
        const spec = specOf(store, file.campaignId, task.id, stored);
        for (const kind of ['implement', 'verify']) {
          assert.equal(packetDigest(packetFor(stored, spec, { kind }), POLICY), packetDigest(packetFor(file, task, { kind }), POLICY), `${name} ${task.id} ${kind}`);
          packets++;
        }
      }
    } finally { store.close(); }
  }
  assert.ok(packets >= 2 * COMMITTED.length);
});

test('a dispatched packet is the one built from the declared spec, digest included', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const decl = declaration({ campaignId: 'plan-specs-dispatch', tasks: [{ ...declaration().tasks[0], constraints: ['Task constraint.'], writes: ['src/'] }] });
  campaignStart(store, decl);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  controller.launch = async () => {}; // the recorded packet is what is under test
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  await controller.tick();
  const op = store.get('SELECT * FROM operations WHERE campaign_id = ?', decl.campaignId);
  assert.ok(op, 'a worker operation was recorded');
  const expected = packetFor(decl, decl.tasks[0], { runId: op.id, revision: op.packet.revision, governance: projectGovernance('example-org/sampleapp', GOVERNANCE) });
  assert.deepEqual(op.packet, expected);
  assert.equal(op.packet_digest, packetDigest(expected, POLICY));
});
