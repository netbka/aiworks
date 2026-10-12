import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLI, declaration, SQLITE } from './helpers.mjs';
import { campaignStart, campaignStatus } from '../../src/supervisor/api.mjs';
const Store = SQLITE ? (await import('../../src/supervisor/store.mjs')).Store : null;

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-status-'));
  const path = join(root, 'data', 'supervisor.db');
  const store = new Store(path);
  const decl = declaration();
  campaignStart(store, decl);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, id: decl.campaignId };
}

function cli(id, data, { cwd, environmentData = '' } = {}) {
  const env = { ...process.env, AIWORKS_DATA: environmentData };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--no-warnings', CLI, 'status', id, ...(data == null ? [] : ['--data', data])],
    { cwd, env, windowsHide: true, encoding: 'utf8' });
}

test('status never creates a missing directory/store; distinguishes empty store and conflicting selection', { skip: !SQLITE }, (t) => {
  const { root, id } = setup(t);
  const missing = join(root, 'missing');
  const absent = cli(id, missing);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /STORE_NOT_FOUND/);
  assert.equal(existsSync(missing), false);
  const empty = new Store(join(root, 'empty', 'supervisor.db'));
  empty.close();
  const notRegistered = cli(id, join(root, 'empty'));
  assert.equal(notRegistered.status, 1);
  assert.match(notRegistered.stderr, /CAMPAIGN_NOT_FOUND/);
  const mismatch = cli(id, missing, { environmentData: join(root, 'data') });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /DATA_DIR_MISMATCH/);
  assert.equal(existsSync(missing), false);
});

test('status from task cwd, a separate shell cwd, env and explicit current dir sees the same store without writes', { skip: !SQLITE }, (t) => {
  const { root, path, store, id } = setup(t);
  const before = store.all('SELECT * FROM journal');
  const data = join(root, 'data');
  const snapshots = [
    cli(id, data, { cwd: data }),
    cli(id, data, { cwd: tmpdir() }),
    cli(id, null, { cwd: tmpdir(), environmentData: data }),
    cli(id, '.', { cwd: data }),
    cli(id, data, { environmentData: data }),
  ].map((out) => {
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  });
  for (const s of snapshots) {
    assert.deepEqual(s.store, snapshots[0].store);
    assert.equal(s.campaignId, id);
    assert.equal(s.readiness, 'BOOTSTRAP_REQUIRED');
    assert.equal(s.status, 'controller-offline');
    assert.equal(s.controller.livenessEvidence, 'no-lease');
  }
  assert.deepEqual(store.all('SELECT * FROM journal'), before);
  assert.equal(store.campaign(id).runs_used, 0);
  assert.equal(snapshots[2].dataSource, 'AIWORKS_DATA');
  const readOnly = new Store(path, { readOnly: true });
  assert.throws(() => readOnly.run("DELETE FROM campaigns"), /readonly/i);
  readOnly.close();
  assert.equal(store.campaign(id).runs_used, 0);
});

test('expired lease is offline, restart changes holder/generation, and quota wait is visible without changing it', { skip: !SQLITE }, (t) => {
  const { store, id } = setup(t);
  const now = Date.now();
  store.acquireLease(id, 'first', now, 1000, 'a'.repeat(40));
  assert.equal(campaignStatus(store, id, now).readiness, 'ACTIVE');
  const stale = campaignStatus(store, id, now + 1000);
  assert.equal(stale.readiness, 'CONTROLLER_OFFLINE');
  assert.equal(stale.status, 'controller-offline');
  assert.equal(stale.recordedStatus, 'active');
  assert.equal(stale.controller.livenessEvidence, 'expired-lease');
  assert.equal(store.acquireLease(id, 'duplicate', now + 500, 1000), null);
  store.acquireLease(id, 'replacement', now + 1001, 5000, 'b'.repeat(40));
  const task = store.task(id, 'T1');
  store.patch('tasks', { campaign_id: id, task_id: 'T1' }, task.version,
    { retry_at: now + 60_000, last_error: 'quota: provider usage/rate limit' }, now + 1001);
  store.journal(id, 'outcome', { privatePayload: 'DO NOT PRINT' }, now + 1001);
  const waiting = campaignStatus(store, id, now + 1002);
  assert.equal(waiting.readiness, 'ACTIVE');
  assert.equal(waiting.phase, 'provider-wait');
  assert.equal(waiting.controller.instanceId, 'replacement');
  assert.equal(waiting.controller.generation, 2);
  assert.equal(waiting.controller.codeRevision, 'b'.repeat(40));
  assert.equal(waiting.providerWaitUntil, new Date(now + 60_000).toISOString());
  assert.equal(waiting.lastProgressAt, new Date(now + 1001).toISOString());
  assert.equal(waiting.lastJournalEvent.kind, 'outcome');
  assert.ok(!JSON.stringify(waiting).includes('DO NOT PRINT'));
  assert.equal(store.campaign(id).runs_used, 0);
  assert.equal(store.task(id, 'T1').retry_at, now + 60_000);
});

test('chain wait describes only dependency-ready tasks and yields to executable work', { skip: !SQLITE }, (t) => {
  const { store, id } = setup(t);
  const now = Date.now();
  const decl = structuredClone(store.campaign(id).declaration);
  decl.executor = { kind: 'cli-chain', providers: [{ kind: 'codex-cli' }], implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
  store.patch('campaigns', { id }, store.campaign(id).version, { declaration: decl }, now);
  store.acquireLease(id, 'controller', now, 60_000);
  const patchTask = (taskId, changes) => store.patch('tasks', { campaign_id: id, task_id: taskId },
    store.task(id, taskId).version, changes, now);
  patchTask('T1', { retry_at: now + 20_000, last_error: 'waiting for executor availability: quota' });
  patchTask('T2', { retry_at: now + 40_000, last_error: 'waiting for executor availability: quota' });
  const waiting = campaignStatus(store, id, now);
  assert.equal(waiting.phase, 'provider-wait');
  assert.equal(waiting.providerWaitUntil, new Date(now + 20_000).toISOString());
  patchTask('T1', { retry_at: now });
  assert.equal(campaignStatus(store, id, now).providerWaitUntil, null, 'ready work takes priority');
  patchTask('T1', { state: 'verified', retry_at: now + 20_000 });
  assert.equal(campaignStatus(store, id, now).providerWaitUntil, null, 'publication does not need a provider');
  patchTask('T1', { state: 'pending', blocked: { class: 'B2', reason: 'synthetic' } });
  assert.equal(campaignStatus(store, id, now).providerWaitUntil, null, 'no eligible task is not provider wait');
  patchTask('T1', { blocked: null });
  store.insert('operations', { id: 'running', campaign_id: id, task_id: 'T1', kind: 'implement', seq: 1,
    idempotency_key: 'running', lease_generation: 1, state: 'recorded', session_id: 'synthetic',
    run_dir: 'synthetic', workspace: 'synthetic', packet: {}, packet_digest: 'digest', created_at: now, updated_at: now });
  assert.equal(campaignStatus(store, id, now).phase, 'implement');
  assert.equal(campaignStatus(store, id, now).providerWaitUntil, null, 'running operation takes priority');
});

test('an interrupted operation stays recorded and is described without exposing packets or workspace', { skip: !SQLITE }, (t) => {
  const { store, id } = setup(t);
  const now = Date.now();
  store.insert('operations', {
    id: 'operation', campaign_id: id, task_id: 'T1', kind: 'implement', seq: 1,
    idempotency_key: 'once', lease_generation: 1, state: 'recorded', session_id: 'private-session',
    run_dir: 'private-run', workspace: 'private-workspace', packet: { private: true },
    packet_digest: 'digest', created_at: now, updated_at: now,
  });
  const before = store.openOperations(id);
  for (let n = 0; n < 2; n++) {
    const status = campaignStatus(store, id, now);
    assert.deepEqual(status.openOperations, [{
      id: 'operation', taskId: 'T1', kind: 'implement', executor: 'claude-cli', state: 'recorded',
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    }]);
    assert.equal(status.readiness, 'BOOTSTRAP_REQUIRED');
  }
  assert.deepEqual(store.openOperations(id), before);
});

test('closed database bytes and directory entries remain unchanged after status', { skip: !SQLITE }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-status-bytes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'supervisor.db');
  const store = new Store(path);
  campaignStart(store, declaration());
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');
  store.close();
  const before = readFileSync(path);
  const files = readdirSync(root);
  assert.equal(cli('test-campaign', root).status, 0);
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readdirSync(root), files);
});
