// Local admission, built and switched off (docs/design/WORK_ENVELOPE.md section 8 and slice E11; plan STA16). The owner's
// dashboard approval admits exactly one plan, by its digest, once; an approval that did not come from the owner's
// dashboard is refused. Every tampering and forgery case of section 9, the caller check against synthetic AIWorks
// processes, and the switch: with local admission off everything is refused and nothing calls the module. Disposable
// stores and real synthetic node processes; no worker, signing key, git, gh or network call.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { authorityDigest, canonicalJson, validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { overlayDigest } from '../../src/supervisor/local-overlay.mjs';
import {
  LOCAL_ADMISSION_ON, LocalAdmissionError, OWNER_CALLER, admitLocalApproval, checkCaller, checkLocalDispatch, localApprovals,
  recordLocalApproval, revokeLocalApproval, verifyLedger,
} from '../../src/supervisor/local-admission.mjs';
import { declaration as v1Declaration, GOVERNANCE, ROOT, SQLITE } from './helpers.mjs';
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const needsSqlite = SQLITE ? false : 'node:sqlite requires Node >= 22.5';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const DAY = 86_400_000;
const REVISION = 'c'.repeat(40);
const APPROVAL_ID = '6f1c2a4e-1b2c-4d3e-8f90-0a1b2c3d4e5f';
const tmp = mkdtempSync(join(tmpdir(), 'aiworks-local-admission-'));
const children = [];
const createHashHex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
after(() => {
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may hold files briefly */ }
});

/** The owner's confirmed rules for a plain folder (PROJECT_CONNECTION 7.3), as in tests/supervisor/local-overlay.test.mjs. */
function overlay(change = () => {}) {
  const value = {
    id: 'lp-sample-notes', name: 'Sample notes', source: { kind: 'folder' }, lifecycle: 'active', capabilities: ['ui'], environments: ['local'],
    governance: { observedAt: `local:lp-sample-notes@sha256:${'a'.repeat(64)}`, authorities: [{ role: 'agent-contract', path: 'AGENTS.md' }],
      independentVerificationGate: 'enabled' },
    approval: { by: 'owner', at: '2026-10-16', method: 'owner-local-ui', digest: '' },
    reviewBy: '2027-10-16',
  };
  change(value);
  value.approval.digest = overlayDigest(value);
  return value;
}

/** A version 2 plan for that folder (WORK_ENVELOPE 4.1, local target), naming its approval id. */
function plan({ campaignId = 'local-notes', approvalId = APPROVAL_ID } = {}) {
  const v1 = v1Declaration({ campaignId, tasks: [
    { id: 'T1', title: 'search', deliverable: 'commit', goal: 'Add search.', dependsOn: [], acceptance: ['search works'], references: ['AGENTS.md'], writes: ['src/'] },
  ] });
  return { ...v1, version: 2,
    authorization: { ...v1.authorization, reference: `aiworks-local:${approvalId}`, text: 'Approved in the AIWorks dashboard.' },
    target: { tenantId: 'example-org', projectId: 'lp-sample-notes', environment: 'research', source: 'folder', baseline: { seq: 1, commit: 'b'.repeat(40) } },
    envelope: { scopeVersion: 1, request: { route: 'goal', pinned: { base: 'b'.repeat(40) } }, outcome: 'People can search their notes.',
      acceptance: ['Searching a word finds the note'], writes: ['src/'], denyWrites: [], deliverables: ['commit'], issues: [],
      web: null, release: { mode: 'review-only' }, planning: 'fixed' } };
}

// The owner's browser: a process AIWorks did not start, in no AIWorks job.
let lookups = 0;
const ownerLookup = async () => { lookups += 1; return { pid: 4242, ancestors: [4100, 4], jobs: [] }; };
const owner = { lookup: ownerLookup, connection: { remotePort: 50001 }, platform: 'win32' };
const on = { enabled: true };
let stores = 0;
const freshStore = () => new Store(join(tmp, `store-${stores += 1}`, 'supervisor.db'));
const bind = (extra = {}) => ({ declaration: plan(), overlay: overlay(), governanceRoot: GOVERNANCE, now: NOW, ...on, ...extra });
const approve = (store, extra = {}) => recordLocalApproval(store, { ...bind(), codeRevision: REVISION, requestId: 'req-1', caller: owner, ...extra });
const admit = (store, extra = {}) => admitLocalApproval(store, { ...bind(), codeRevision: REVISION, now: NOW + 1000, ...extra });
const tables = (store) => store.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'local_%' ORDER BY name").map((row) => row.name);
const counts = (store) => Object.fromEntries(['campaigns', 'tasks', 'operations'].map((table) => [table, store.get(`SELECT COUNT(*) AS n FROM ${table}`).n]));

async function refused(promiseOrFn, code) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (error) {
    assert.ok(error instanceof LocalAdmissionError, `expected a LocalAdmissionError, got ${error?.stack ?? error}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected a refusal with ${code}`);
}

/** A synthetic AIWorks run: a runner process that starts a worker process, recorded as an open operation or coordinator run. */
async function syntheticRun(store, { kind = 'operation', id = 'op-1', reportRunner = true } = {}) {
  const runDir = join(tmp, `run-${id}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(runDir, { recursive: true });
  const runner = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write(String(worker.pid) + '\\n');
    process.on('SIGTERM', () => { worker.kill(); process.exit(0); });
    setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  children.push(runner);
  const workerPid = await new Promise((done, fail) => {
    runner.stdout.once('data', (data) => done(Number(String(data).trim())));
    runner.once('error', fail);
  });
  children.push({ kill: () => { try { process.kill(workerPid); } catch { /* already gone */ } } });
  const jobName = `Local\\aiworks-supervisor-synthetic-${id}`;
  writeFileSync(join(runDir, 'launch.json'), JSON.stringify({ operationId: id, at: NOW }));
  if (reportRunner) writeFileSync(join(runDir, 'runner.json'), JSON.stringify({ pid: runner.pid, startedAt: NOW, jobName, containment: 'windows-job-v1' }));
  if (kind === 'operation') {
    store.insert('operations', { id, campaign_id: 'other-campaign', task_id: 'T1', kind: 'implement', seq: 1, idempotency_key: `key-${id}`,
      lease_generation: 1, state: 'dispatched', session_id: 'session', run_dir: runDir, workspace: runDir, packet: {}, packet_digest: 'd'.repeat(64),
      created_at: NOW, updated_at: NOW });
  } else {
    store.insert('coordinator_runs', { id, state: 'dispatched', session_id: 'session', run_dir: runDir, workspace: runDir, message_ids: [], created_at: NOW, updated_at: NOW });
  }
  // The injectable lookup, as the Windows one would answer for the worker: its real parent chain, and its job.
  const lookup = async (_connection, { jobNames }) => ({ pid: workerPid, ancestors: [runner.pid, process.pid], jobs: jobNames.filter((name) => name === jobName) });
  return { runner, workerPid, jobName, lookup };
}

test('switched off: every approval, admission, dispatch check and revoke is refused, and nothing is written', { skip: needsSqlite }, async () => {
  assert.equal(LOCAL_ADMISSION_ON, false);
  const store = freshStore();
  lookups = 0;
  const off = { enabled: undefined };
  await refused(recordLocalApproval(store, { ...bind(off), codeRevision: REVISION, requestId: 'req-1', caller: owner }), 'LOCAL_ADMISSION_OFF');
  await refused(() => admitLocalApproval(store, { ...bind(off), codeRevision: REVISION }), 'LOCAL_ADMISSION_OFF');
  await refused(() => checkLocalDispatch(store, bind(off)), 'LOCAL_ADMISSION_OFF');
  await refused(revokeLocalApproval(store, { approvalId: APPROVAL_ID, requestId: 'req-2', caller: owner }), 'LOCAL_ADMISSION_OFF');
  // Explicitly false is off too: only `true` turns the checks on, and nothing in AIWorks passes it.
  await refused(recordLocalApproval(store, { ...bind({ enabled: false }), codeRevision: REVISION, requestId: 'req-1', caller: owner }), 'LOCAL_ADMISSION_OFF');
  assert.equal(lookups, 0, 'the caller is not even looked up while it is off');
  assert.deepEqual(tables(store), [], 'no store table exists until the first approval');
  assert.deepEqual(counts(store), { campaigns: 0, tasks: 0, operations: 0 });
  store.close();
});

test('switched off: nothing registers or dispatches through it, and it needs no key, process, git, gh or network', () => {
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|js|cjs|ps1)$/.test(entry.name)) sources.push(full);
    }
  };
  for (const dir of ['src', 'scripts']) walk(join(ROOT, dir));
  const callers = sources.filter((file) => !file.endsWith('local-admission.mjs') && readFileSync(file, 'utf8').includes('local-admission'));
  assert.deepEqual(callers.map((file) => relative(ROOT, file)), [], 'no runtime module imports local admission before STA17');
  // A local target is still refused at registration.
  assert.throws(() => validateDeclaration(plan()), /LOCAL_START_OFF/);
  const text = readFileSync(join(ROOT, 'src', 'supervisor', 'local-admission.mjs'), 'utf8');
  const imports = [...text.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ['./campaign.mjs', './local-candidates.mjs', './local-overlay.mjs', 'ajv/dist/2020.js', 'node:crypto', 'node:fs', 'node:path']);
  for (const word of ['ssh-keygen', 'child_process', 'createSign', 'privateKey', 'fetch(', "'gh'", 'node:net', 'node:http']) {
    assert.equal(text.includes(word), false, `local-admission.mjs uses no ${word}`);
  }
});

test('an owner approval admits exactly that plan once, and starts nothing by itself', { skip: needsSqlite }, async () => {
  const store = freshStore();
  const recorded = await approve(store);
  assert.equal(recorded.recorded, true);
  const { record } = recorded;
  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'local-approval.schema.json'), 'utf8'));
  assert.equal(new Ajv2020().validate(schema, record), true, 'the record passes schemas/local-approval.schema.json');
  assert.equal(record.approvalId, APPROVAL_ID);
  assert.equal(record.declarationDigest, authorityDigest(plan()));
  assert.equal(record.overlayDigest, overlayDigest(overlay()));
  assert.equal(record.codeRevision, REVISION);
  assert.equal(record.method, 'owner-local-ui');
  assert.match(record.nonce, /^[0-9a-f]{64}$/);
  assert.equal(Date.parse(record.startBy) - Date.parse(record.approvedAt), 30 * DAY);
  const receipt = store.get('SELECT * FROM local_receipts WHERE approval_id = ?', APPROVAL_ID);
  assert.deepEqual({ request: receipt.request_id, caller: receipt.caller, digest: receipt.record_digest }, { request: 'req-1', caller: OWNER_CALLER, digest: recorded.recordDigest });
  assert.deepEqual(verifyLedger(store), { length: 1, head: recorded.ledgerHead });
  // The same request again records nothing new.
  const again = await approve(store);
  assert.equal(again.recorded, false);
  assert.equal(again.record.nonce, record.nonce);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM local_approvals').n, 1);

  await refused(() => checkLocalDispatch(store, bind()), 'APPROVAL_NOT_ADMITTED');
  assert.deepEqual(admit(store), { admitted: true, record });
  assert.equal(checkLocalDispatch(store, bind()).approvalId, APPROVAL_ID);
  await refused(() => admit(store), 'APPROVAL_NONCE_USED');
  assert.deepEqual(localApprovals(store, 'local-notes').map(({ fingerprint, admittedAt, revokedAt }) => ({ fingerprint, admittedAt, revokedAt })),
    [{ fingerprint: record.declarationDigest.slice(0, 12), admittedAt: new Date(NOW + 1000).toISOString(), revokedAt: null }]);
  assert.deepEqual(store.all("SELECT kind FROM journal WHERE campaign_id = 'local-notes' ORDER BY seq").map((row) => row.kind),
    ['local-approval-recorded', 'local-approval-admitted']);
  assert.deepEqual(counts(store), { campaigns: 0, tasks: 0, operations: 0 }, 'admission registers and dispatches nothing');
  store.close();
});

test('a changed plan, changed rules, a late start or new code is refused with its code', { skip: needsSqlite }, async () => {
  const store = freshStore();
  await approve(store);
  const changed = plan();
  changed.constraints = ['Synthetic test constraint: no network, no production!'];
  await refused(() => admit(store, { declaration: changed }), 'DECLARATION_DIFFERS_FROM_APPROVAL');
  const wider = plan();
  wider.envelope.writes = ['src/', 'tests/'];
  await refused(() => admit(store, { declaration: wider }), 'DECLARATION_DIFFERS_FROM_APPROVAL');
  const rules = overlay((value) => { value.governance.stricter = [{ id: 'tests-always', rule: 'baseline:tests-always', note: 'every change runs the tests' }]; });
  await refused(() => admit(store, { overlay: rules }), 'OVERLAY_DIFFERS_FROM_APPROVAL');
  const edited = overlay();
  edited.name = 'Edited after confirmation';
  await refused(() => admit(store, { overlay: edited }), 'RULES_DIGEST_MISMATCH');
  await refused(() => admit(store, { now: NOW + 30 * DAY + 1 }), 'APPROVAL_EXPIRED');
  await refused(() => admit(store, { codeRevision: 'd'.repeat(40) }), 'CODE_DIFFERS_FROM_APPROVAL');
  // None of them used the nonce: the plan exactly as approved is still admitted once.
  assert.equal(admit(store).admitted, true);
  await refused(() => checkLocalDispatch(store, bind({ declaration: changed })), 'DECLARATION_DIFFERS_FROM_APPROVAL');
  await refused(() => checkLocalDispatch(store, bind({ overlay: rules })), 'OVERLAY_DIFFERS_FROM_APPROVAL');
  store.close();
});

test('a reused nonce is refused, even under another approval id', { skip: needsSqlite }, async () => {
  const store = freshStore();
  const { record } = await approve(store);
  assert.equal(admit(store).admitted, true);
  await refused(() => admit(store), 'APPROVAL_NONCE_USED');
  // A copy of the record under a new id, written straight into the store with a correct receipt and ledger entry.
  const otherId = '7f1c2a4e-1b2c-4d3e-8f90-0a1b2c3d4e5f';
  const copy = { ...record, approvalId: otherId, declarationDigest: authorityDigest(plan({ approvalId: otherId })) };
  assert.throws(() => store.run('INSERT INTO local_approvals (approval_id, campaign_id, record_text, record_digest, nonce, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
    otherId, copy.campaignId, canonicalJson(copy), 'e'.repeat(64), copy.nonce, NOW), /UNIQUE/);
  store.close();
});

test('an approval row with no request receipt is refused', { skip: needsSqlite }, async () => {
  const store = freshStore();
  await approve(store);
  store.run('DELETE FROM local_receipts');
  await refused(() => admit(store), 'APPROVAL_NO_RECEIPT');

  // An approval written straight into supervisor.db, with a correct ledger entry, but not through the dashboard route.
  const forged = freshStore();
  await approve(forged, { requestId: 'req-seed', declaration: plan({ campaignId: 'seed', approvalId: '8f1c2a4e-1b2c-4d3e-8f90-0a1b2c3d4e5f' }) });
  const record = { schema: 'aiworks-local-approval/1', approvalId: APPROVAL_ID, campaignId: 'local-notes', projectId: 'lp-sample-notes',
    overlayDigest: overlayDigest(overlay()), declarationDigest: authorityDigest(plan()), codeRevision: REVISION,
    approvedAt: new Date(NOW).toISOString(), startBy: new Date(NOW + DAY).toISOString(), nonce: 'f'.repeat(64), method: 'owner-local-ui' };
  const text = canonicalJson(record);
  const last = forged.get('SELECT seq, hash FROM local_ledger ORDER BY seq DESC LIMIT 1');
  forged.run('INSERT INTO local_approvals (approval_id, campaign_id, record_text, record_digest, nonce, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
    APPROVAL_ID, 'local-notes', text, createHashHex(text), record.nonce, NOW);
  forged.run('INSERT INTO local_ledger (seq, kind, campaign_id, payload, payload_digest, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    last.seq + 1, 'approval', 'local-notes', text, createHashHex(text), last.hash, createHashHex(`${last.hash}approval${createHashHex(text)}`), NOW);
  assert.equal(verifyLedger(forged).length, 2, 'the forged entry chains correctly');
  await refused(() => admit(forged), 'APPROVAL_NO_RECEIPT');
  // A receipt from a refused caller does not count either.
  forged.run('INSERT INTO local_receipts (request_id, approval_id, action, caller, record_digest, received_at) VALUES (?, ?, ?, ?, ?, ?)',
    'req-forged', APPROVAL_ID, 'approve', 'aiworks-worker', createHashHex(text), NOW);
  await refused(() => admit(forged), 'APPROVAL_NO_RECEIPT');
  store.close();
  forged.close();
});

test('an edited, removed or reordered ledger entry blocks admission and dispatch', { skip: needsSqlite }, async () => {
  const twoApprovals = async () => {
    const store = freshStore();
    await approve(store, { requestId: 'req-a', declaration: plan({ campaignId: 'notes-a', approvalId: 'aaaaaaaa-1b2c-4d3e-8f90-0a1b2c3d4e5f' }) });
    await approve(store);
    return store;
  };

  const edited = await twoApprovals();
  assert.equal(admit(edited).admitted, true);
  edited.db.prepare("UPDATE local_ledger SET payload = replace(payload, 'owner-local-ui', 'owner-local-UI') WHERE seq = 2").run();
  await refused(() => checkLocalDispatch(edited, bind()), 'LEDGER_BROKEN');
  await refused(() => admit(edited), 'LEDGER_BROKEN');
  // Recomputing the entry's own digest does not help: the chain no longer matches the next hash.
  const row = edited.db.prepare('SELECT payload FROM local_ledger WHERE seq = 2').get();
  edited.db.prepare('UPDATE local_ledger SET payload_digest = ? WHERE seq = 2').run(createHashHex(row.payload));
  await refused(() => checkLocalDispatch(edited, bind()), 'LEDGER_BROKEN');
  edited.close();

  const removed = await twoApprovals();
  removed.run('DELETE FROM local_ledger WHERE seq = 1');
  await refused(() => admit(removed), 'LEDGER_BROKEN');
  removed.close();

  const lastRemoved = await twoApprovals();
  lastRemoved.run('DELETE FROM local_ledger WHERE seq = 2');
  await refused(() => admit(lastRemoved), 'LEDGER_BROKEN');
  lastRemoved.close();

  const reordered = await twoApprovals();
  reordered.run('UPDATE local_ledger SET seq = 3 WHERE seq = 1');
  reordered.run('UPDATE local_ledger SET seq = 1 WHERE seq = 2');
  reordered.run('UPDATE local_ledger SET seq = 2 WHERE seq = 3');
  await refused(() => admit(reordered), 'LEDGER_BROKEN');
  // A broken ledger takes no new approval either.
  await refused(approve(reordered, { requestId: 'req-c', declaration: plan({ campaignId: 'notes-c', approvalId: 'cccccccc-1b2c-4d3e-8f90-0a1b2c3d4e5f' }) }), 'LEDGER_BROKEN');
  reordered.close();
});

test('a request from a synthetic AIWorks worker, verifier or coordinator process is refused, and so is one AIWorks cannot check', { skip: needsSqlite }, async () => {
  const store = freshStore();
  const worker = await syntheticRun(store, { id: 'op-worker' });
  const caller = { lookup: worker.lookup, connection: { remotePort: 50002 }, platform: 'win32' };
  await refused(approve(store, { caller }), 'APPROVAL_FROM_AIWORKS');
  // Its parent exited: the job it cannot leave still names it.
  await refused(approve(store, { caller: { ...caller, lookup: async (_c, { jobNames }) => ({ pid: worker.workerPid, ancestors: [1], jobs: jobNames }) } }), 'APPROVAL_FROM_AIWORKS');
  assert.deepEqual(tables(store), [], 'a refused request writes nothing');

  const coordinatorStore = freshStore();
  const coordinator = await syntheticRun(coordinatorStore, { kind: 'coordinator', id: 'coord-1' });
  await refused(approve(coordinatorStore, { caller: { lookup: coordinator.lookup, platform: 'win32' } }), 'APPROVAL_FROM_AIWORKS');
  // A process the dashboard itself started.
  await refused(approve(freshStore(), { caller: { lookup: async () => ({ pid: 9999, ancestors: [process.pid], jobs: [] }), platform: 'win32' } }), 'APPROVAL_FROM_AIWORKS');
  // Revoke goes through the same check.
  await approve(coordinatorStore, { caller: owner, requestId: 'req-owner' });
  await refused(revokeLocalApproval(coordinatorStore, { approvalId: APPROVAL_ID, requestId: 'req-revoke', caller: { lookup: coordinator.lookup, platform: 'win32' }, ...on }), 'APPROVAL_FROM_AIWORKS');

  const unchecked = freshStore();
  await refused(approve(unchecked, { caller: { platform: 'win32' } }), 'APPROVAL_UNCHECKED');
  await refused(approve(unchecked, { caller: { ...owner, lookup: async () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); } } }), 'APPROVAL_UNCHECKED');
  await refused(approve(unchecked, { caller: { ...owner, lookup: async () => ({ pid: 'browser' }) } }), 'APPROVAL_UNCHECKED');
  await refused(approve(unchecked, { caller: { ...owner, platform: 'linux' } }), 'APPROVAL_UNCHECKED');
  await syntheticRun(unchecked, { id: 'op-starting', reportRunner: false });
  await refused(approve(unchecked, { caller: owner }), 'APPROVAL_UNCHECKED');
  assert.deepEqual(tables(unchecked), []);
  assert.equal(await checkCaller(freshStore(), owner), OWNER_CALLER);
  store.close();
  coordinatorStore.close();
  unchecked.close();
});

test('a GitHub project never uses the local path', { skip: needsSqlite }, async () => {
  const store = freshStore();
  await refused(approve(store, { declaration: v1Declaration() }), 'LOCAL_PATH_NOT_FOR_GITHUB');
  const withRepository = plan();
  withRepository.target.repository = 'example-org/sampleapp';
  await refused(approve(store, { declaration: withRepository }), 'LOCAL_PATH_NOT_FOR_GITHUB');
  await refused(approve(store, { project: { id: 'sampleapp', source_kind: 'github' } }), 'LOCAL_PATH_NOT_FOR_GITHUB');
  await refused(approve(store, { overlay: overlay((value) => { value.id = 'lp-other-notes'; value.governance.observedAt = `local:lp-other-notes@sha256:${'a'.repeat(64)}`; }) }), 'APPROVAL_PROJECT_MISMATCH');
  assert.deepEqual(tables(store), []);
  store.close();
});

test('a revoked approval admits nothing, and removing the revocation breaks the ledger', { skip: needsSqlite }, async () => {
  const store = freshStore();
  await approve(store);
  assert.equal(admit(store).admitted, true);
  const revoked = await revokeLocalApproval(store, { approvalId: APPROVAL_ID, reason: 'changed my mind', requestId: 'req-revoke', caller: owner, now: NOW + 2000, ...on });
  assert.equal(revoked.revoked, true);
  await refused(() => checkLocalDispatch(store, bind()), 'APPROVAL_REVOKED');
  await refused(() => admit(store), 'APPROVAL_REVOKED');
  assert.equal(verifyLedger(store).length, 2);
  store.run("DELETE FROM local_ledger WHERE kind = 'revocation'");
  await refused(() => checkLocalDispatch(store, bind()), 'LEDGER_BROKEN');
  store.close();

  const unrevoked = freshStore();
  await approve(unrevoked);
  await revokeLocalApproval(unrevoked, { approvalId: APPROVAL_ID, requestId: 'req-revoke', caller: owner, now: NOW + 2000, ...on });
  unrevoked.run('UPDATE local_approvals SET revoked_at = NULL');
  await refused(() => admit(unrevoked), 'LEDGER_BROKEN');
  unrevoked.close();
});
