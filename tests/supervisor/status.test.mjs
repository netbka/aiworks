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

// ---- RUN9 (ADAPTIVE_SCHEDULER slice S8, supervisor half): one plain wait reason and the next automatic action per step. ----

const CODES = ['running', 'paused', 'cancelled', 'owner', 'recheck', 'dependency', 'integration', 'retry-backoff', 'publishing', 'provider-cooldown',
  'campaign-fanout', 'host-capacity', 'host-pressure', 'write-domain', 'provider-concurrency', 'ready'];

function openOperation(store, campaignId, taskId, now, { kind = 'implement', id = `${campaignId}-${taskId}` } = {}) {
  store.insert('operations', { id, campaign_id: campaignId, task_id: taskId, kind, seq: 1, idempotency_key: id, lease_generation: 1, state: 'recorded',
    session_id: 'synthetic', run_dir: 'synthetic', workspace: 'synthetic', packet: {}, packet_digest: 'digest', created_at: now, updated_at: now });
}

const patchTask = (store, campaignId, taskId, changes, now) =>
  store.patch('tasks', { campaign_id: campaignId, task_id: taskId }, store.task(campaignId, taskId).version, changes, now);

/** Every unfinished task has exactly one wait with a known code, owner text and a next action; a done task has none. */
function waits(store, campaignId, now, options) {
  const status = campaignStatus(store, campaignId, now, options);
  for (const task of status.tasks) {
    if (task.state === 'done') { assert.equal(task.wait, null, `${task.id} is done`); continue; }
    assert.ok(CODES.includes(task.wait?.code), `${task.id} has one known reason: ${JSON.stringify(task.wait)}`);
    assert.ok(task.wait.text && task.wait.next, `${task.id} has owner text and a next action`);
  }
  return Object.fromEntries(status.tasks.map((task) => [task.id, task.wait]));
}

const commitTask = (id, extra = {}) => ({ id, issue: 1, title: `Task ${id}`, deliverable: 'commit', goal: 'g', dependsOn: [], acceptance: ['a'], references: ['AGENTS.md'], ...extra });

function waitStore(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const store = new Store(join(root, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
}

test('status gives every waiting step one plain reason and the next automatic action', { skip: !SQLITE }, (t) => {
  const store = waitStore(t, 'aiworks-status-wait-');
  const id = 'waits';
  campaignStart(store, declaration({ campaignId: id, tasks: [
    commitTask('A', { title: 'Login page' }), commitTask('B', { dependsOn: ['A'] }), commitTask('C'),
    commitTask('D', { dependsOn: ['A'], requiresMergedDependencies: true }),
  ] }));
  const now = Date.now();
  let wait = waits(store, id, now);
  assert.equal(wait.A.code, 'ready');
  assert.equal(wait.A.next, 'Starts on the next turn');
  assert.deepEqual([wait.B.code, wait.B.text, wait.B.next], ['dependency', 'Waiting for "Login page" to finish', 'Starts when that step is done']);
  assert.equal(wait.C.code, 'campaign-fanout', 'with the scheduler off one step runs at a time, the first one first');
  openOperation(store, id, 'A', now);
  wait = waits(store, id, now);
  assert.deepEqual([wait.A.code, wait.A.text, wait.A.next], ['running', 'Being implemented', 'The result is recorded when the run ends']);
  assert.deepEqual([wait.C.code, wait.C.text, wait.C.next], ['campaign-fanout', 'Waiting for a free worker in this work program', 'Starts when a running step finishes']);
  store.run("UPDATE operations SET state = 'finished'");
  patchTask(store, id, 'A', { state: 'done', verified_sha: 'a'.repeat(40) }, now);
  patchTask(store, id, 'B', { retry_at: now + 60_000, last_error: 'timeout: the run took too long' }, now);
  patchTask(store, id, 'C', { retry_at: now + 30_000, last_error: 'quota: provider usage/rate limit' }, now);
  patchTask(store, id, 'D', { retry_at: now + 60_000, last_error: 'dependency-integration: waiting for A in main' }, now);
  wait = waits(store, id, now);
  assert.equal(wait.A, null);
  assert.deepEqual([wait.B.code, wait.B.until], ['retry-backoff', new Date(now + 60_000).toISOString()]);
  assert.equal(wait.B.next, `Tries again at ${new Date(now + 60_000).toISOString()}`);
  assert.deepEqual([wait.C.code, wait.C.until], ['provider-cooldown', new Date(now + 30_000).toISOString()]);
  assert.deepEqual([wait.D.code, wait.D.text], ['integration', 'Waiting for "Login page" to be merged into main']);
  assert.deepEqual(wait.D.holder, { campaignId: id, taskId: 'A', reason: 'dependency-integration', prUrl: null, verifiedSha: 'a'.repeat(40) });
  patchTask(store, id, 'A', { pr_url: 'https://github.com/netbka/elma_wiki/pull/113' }, now);
  wait = waits(store, id, now);
  assert.match(wait.D.text, /PR #113/);
  assert.equal(wait.D.holder.prUrl, 'https://github.com/netbka/elma_wiki/pull/113');
  patchTask(store, id, 'D', { last_error: 'dependency-integration: waiting for A in main (remote refresh unavailable)' }, now);
  wait = waits(store, id, now);
  assert.equal(wait.D.text, 'Cannot check whether "Login page" is merged into main');
  assert.equal(wait.D.holder.verifiedSha, 'a'.repeat(40));
  assert.match(wait.D.next, /automatically/);
  patchTask(store, id, 'B', { state: 'verified', retry_at: null, last_error: null }, now);
  assert.equal(waits(store, id, now).B.code, 'publishing', 'publication needs no provider');
  patchTask(store, id, 'C', { blocked: { class: 'B3', reason: 'owner-reserved' } }, now);
  wait = waits(store, id, now);
  assert.deepEqual([wait.C.code, wait.C.next], ['owner', 'None; listed in Needs me']);
  store.patch('campaigns', { id }, store.campaign(id).version, { control: 'paused' }, now);
  wait = waits(store, id, now);
  assert.deepEqual([wait.B.code, wait.C.code, wait.D.code], ['paused', 'paused', 'paused']);
  assert.equal(wait.D.next, 'None until you resume it');
});

test('with the scheduler on, status names the admission check that refuses each step', { skip: !SQLITE }, async (t) => {
  const { admissionCheck, hostCeiling } = await import('../../src/supervisor/scheduler.mjs');
  const store = waitStore(t, 'aiworks-status-admit-');
  campaignStart(store, declaration({ campaignId: 'wide', tasks: [commitTask('W', { issue: 2, title: 'Dashboard', writes: ['src/'] })] }));
  campaignStart(store, declaration({ campaignId: 'narrow', limits: { slots: 'auto' }, tasks: [commitTask('N', { issue: 3, writes: ['src/ui/'] }), commitTask('M', { issue: 4, writes: ['docs/'] })] }));
  const now = Date.now();
  const config = { scheduler: { enabled: true, maxWorkers: 4 } };
  // The reason status shows is the scheduler's own predicate over the same rows.
  const decided = (taskId) => admissionCheck(store, { campaignId: 'narrow', taskId, kind: 'implement', declaration: store.campaign('narrow').declaration },
    { ceiling: hostCeiling(config) })?.reason ?? 'ready';
  openOperation(store, 'wide', 'W', now);
  let wait = waits(store, 'narrow', now, { config });
  assert.deepEqual([wait.N.code, wait.N.text, wait.N.next], ['write-domain', 'Another step ("Dashboard") is changing src/', 'Starts when that change is merged or dropped']);
  assert.deepEqual(wait.N.holder, { campaignId: 'wide', taskId: 'W', reason: 'writing', prUrl: null });
  assert.equal(wait.N.code, decided('N'));
  assert.equal(wait.M.code, 'ready', 'a disjoint domain is not held');
  assert.equal(wait.M.code, decided('M'));
  assert.equal(waits(store, 'narrow', now).N.code, 'ready', 'off means today: no write domains without the scheduler');
  store.run("UPDATE operations SET state = 'finished'");
  patchTask(store, 'wide', 'W', { state: 'done', verified_sha: 'b'.repeat(40), pr_url: 'https://github.com/netbka/Dyk/pull/41' }, now);
  wait = waits(store, 'narrow', now, { config });
  assert.equal(wait.N.text, 'Another step ("Dashboard") is changing src/ (PR #41 not merged yet)');
  assert.equal(wait.N.holder.reason, 'published-unmerged');
  openOperation(store, 'narrow', 'M', now);
  wait = waits(store, 'narrow', now, { config });
  assert.equal(wait.N.code, 'campaign-fanout', 'the learned fan-out starts at one');
  assert.equal(wait.N.code, decided('N'));
  store.run("INSERT INTO capacity (scope, id, value, reason, updated_at) VALUES ('campaign', 'narrow', 2, 'synthetic', ?)", now);
  assert.equal(waits(store, 'narrow', now, { config }).N.code, 'write-domain', 'a raised fan-out lets the next check decide');
  openOperation(store, 'elsewhere', 'X', now);
  assert.equal(waits(store, 'narrow', now, { config: { scheduler: { enabled: true, maxWorkers: 2 } } }).N.code, 'host-capacity');
  store.run("INSERT INTO capacity (scope, id, value, reason, updated_at) VALUES ('host', 'pressure', 1, 'memory', ?)", now);
  wait = waits(store, 'narrow', now, { config });
  assert.deepEqual([wait.N.code, wait.N.text], ['host-pressure', 'This computer is low on memory']);
  store.run("UPDATE capacity SET value = 0 WHERE scope = 'host'");
  store.run("INSERT INTO capacity (scope, id, value, reason, updated_at) VALUES ('account', 'claude-cli', 1, 'synthetic', ?)", now);
  patchTask(store, 'wide', 'W', { pr_url: null, verified_sha: null }, now);
  wait = waits(store, 'narrow', now, { config });
  assert.deepEqual([wait.N.code, wait.N.text], ['provider-concurrency', 'The AI provider asked to slow down']);
});

test('a wait reason never carries worker output or a recorded error text', { skip: !SQLITE }, (t) => {
  const store = waitStore(t, 'aiworks-status-text-');
  const id = 'texts';
  const marker = 'SECRET-WORKER-TEXT';
  campaignStart(store, declaration({ campaignId: id, tasks: [commitTask('A'), commitTask('B'), commitTask('C'), commitTask('D')] }));
  const now = Date.now();
  patchTask(store, id, 'A', { blocked: { class: 'B3', reason: `owner-reserved: ${marker}` }, result: { summary: marker } }, now);
  patchTask(store, id, 'B', { blocked: { class: 'stalled', reason: `3 failed attempts: ${marker}` } }, now);
  patchTask(store, id, 'C', { retry_at: now + 5_000, last_error: `timeout: ${marker}` }, now);
  patchTask(store, id, 'D', { retry_at: now + 5_000, last_error: `quota: ${marker}` }, now);
  const seen = [waits(store, id, now)];
  store.patch('campaigns', { id }, store.campaign(id).version, { blocker: { kind: 'auth', class: 'B2', reason: marker, requestedAction: marker } }, now);
  patchTask(store, id, 'C', { retry_at: null }, now);
  seen.push(waits(store, id, now));
  store.patch('campaigns', { id }, store.campaign(id).version, { blocker: { kind: marker, class: 'B2', reason: marker } }, now);
  seen.push(waits(store, id, now));
  assert.deepEqual(seen.map((wait) => wait.C.code), ['retry-backoff', 'owner', 'owner']);
  assert.equal(seen[1].C.text, 'Needs you: an AI provider login failed');
  for (const wait of seen) assert.ok(!JSON.stringify(wait).includes(marker), JSON.stringify(wait));
});
