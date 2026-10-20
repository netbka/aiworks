// Local admission (docs/design/WORK_ENVELOPE.md section 8, decision D4; slice E11, plan STA16). A project without GitHub
// starts work when the owner approves its plan in the local dashboard. There is no signing key. What binds an approval:
//   - the approval record (schemas/local-approval.schema.json): the exact plan by its authorityDigest, the project, the
//     digest of its confirmed rules (local-overlay.mjs), the code revision, a start-by date and a single-use nonce;
//   - a request receipt the dashboard route writes, with the caller check's result;
//   - an append-only, hash-chained ledger of approvals and revocations, re-read before every admission and dispatch.
// The caller check refuses an approval from a process AIWorks started (a worker, verifier or coordinator run), and
// refuses when it cannot tell.
//
// Switched on by slice STA17 (owner decision D4, docs/DECISIONS.md AW-012). registerLocalPlan registers exactly the plan
// an approval admits, in the same transaction that uses its nonce; the controller runs checkLocalDispatch before every
// dispatch of a local campaign. This module never dispatches work, runs a process, calls git or GitHub, or opens a
// network connection.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { campaignStart } from './api.mjs';
import { authorityDigest, canonicalJson, validateDeclaration } from './campaign.mjs';
import { isLocalTarget } from './local-candidates.mjs';
import { OverlayError, overlayDigest, validateOverlayEntry } from './local-overlay.mjs';
import { runnerIdentified } from './proc.mjs';
import { resolveLocalProject } from './project-connect.mjs';

/** Local admission is on since slice STA17 (owner decision D4, #32, answered 2026-10-16). */
export const LOCAL_ADMISSION_ON = true;
export const LOCAL_APPROVAL_SCHEMA = 'aiworks-local-approval/1';
/** The caller check's result for a request that did not come from AIWorks's own processes. */
export const OWNER_CALLER = 'owner-browser';
export const MAX_START_DAYS = 30;
export const LEDGER_KINDS = Object.freeze(['approval', 'amendment', 'revocation']);

const validateShape = new Ajv2020({ allErrors: true })
  .compile(JSON.parse(readFileSync(new URL('../../schemas/local-approval.schema.json', import.meta.url), 'utf8')));
const DAY_MS = 86_400_000;
const GENESIS = '0'.repeat(64);
const REFERENCE = /^aiworks-local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REVISION = /^[0-9a-f]{40}$/;
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const chainHash = (prev, kind, payloadDigest) => sha256(`${prev}${kind}${payloadDigest}`);
const short = (digest) => String(digest).replace(/^sha256:/, '').slice(0, 12);

export class LocalAdmissionError extends Error {
  constructor(code, message) { super(message); this.name = 'LocalAdmissionError'; this.code = code; }
}
const refuse = (code, message) => { throw new LocalAdmissionError(code, message); };

// Created on the first recorded approval, because this slice does not own store.mjs. They are additive: a store that
// never recorded a local approval has none of them and behaves exactly as before. Rows are only inserted, except that
// an approval row gains its revocation time, which the ledger also records.
const DDL = `CREATE TABLE IF NOT EXISTS local_approvals (
  approval_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, record_text TEXT NOT NULL, record_digest TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL UNIQUE, recorded_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS local_receipts (
  request_id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, action TEXT NOT NULL, caller TEXT NOT NULL,
  record_digest TEXT NOT NULL, received_at INTEGER NOT NULL, UNIQUE (approval_id, action));
CREATE TABLE IF NOT EXISTS local_nonces (
  nonce TEXT PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE, campaign_id TEXT NOT NULL, used_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS local_ledger (
  seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, campaign_id TEXT NOT NULL, payload TEXT NOT NULL, payload_digest TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL)`;
const TABLES = ['local_approvals', 'local_receipts', 'local_nonces', 'local_ledger'];
const hasTables = (store) => TABLES.every((name) => store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", name));
// The store decodes a `payload` column as JSON; the ledger needs its exact text, so it is read without decoding.
const ledgerRows = (store) => store.db.prepare('SELECT * FROM local_ledger ORDER BY seq').all();

/** The shape of an approval record; throws APPROVAL_INVALID naming the fields, never their contents. */
export function validateLocalApproval(record) {
  const approvedAt = Date.parse(record?.approvedAt);
  const startBy = Date.parse(record?.startBy);
  if (!validateShape(record)) {
    const fields = [...new Set(validateShape.errors.map((error) => error.instancePath || error.params?.missingProperty || error.params?.additionalProperty || '/'))];
    refuse('APPROVAL_INVALID', `the approval is not a valid ${LOCAL_APPROVAL_SCHEMA} record (check ${fields.slice(0, 5).join(', ')})`);
  }
  if (Number.isNaN(approvedAt) || Number.isNaN(startBy) || startBy <= approvedAt || startBy - approvedAt > MAX_START_DAYS * DAY_MS) {
    refuse('APPROVAL_INVALID', `an approval's start-by date is after its approval and at most ${MAX_START_DAYS} days later`);
  }
  return record;
}

/**
 * The open runs of AIWorks's own processes: every worker or verifier operation and every coordinator run still recorded
 * or dispatched (coordinator and planning runs alike), with the runner's pid, creation time and Windows job from its
 * runner.json. `known` is false for a launched run until runner.json names its complete custody identity
 * (proc.mjs runnerIdentified): its first `{ pid, startedAt }`, or any missing or malformed field, leaves processes that
 * cannot be named, so the caller check cannot tell. A run that was never launched has no processes.
 */
export function aiworksRuns(store) {
  const rows = [
    ...store.all("SELECT 'operation' AS kind, id, run_dir FROM operations WHERE state IN ('recorded', 'dispatched')"),
    ...store.all("SELECT 'coordinator' AS kind, id, run_dir FROM coordinator_runs WHERE state IN ('recorded', 'dispatched')"),
  ];
  return rows.map(({ kind, id, run_dir: runDir }) => {
    const metadata = join(runDir, 'runner.json');
    let runner = null;
    try { runner = JSON.parse(readFileSync(metadata, 'utf8')); } catch { runner = null; }
    const launched = existsSync(metadata) || existsSync(join(runDir, 'launch.json')) || existsSync(join(runDir, 'run.lock'));
    if (!runnerIdentified(runner)) return { kind, id, pid: null, jobName: null, creationTime: null, known: !launched };
    return { kind, id, pid: runner.pid, jobName: runner.jobName, creationTime: runner.creationTime, known: true };
  });
}

/**
 * The caller check (section 8.2). `lookup(connection, { jobNames, runners })` finds the process at the other end of the
 * dashboard's loopback connection and returns `{ pid, ancestors, jobs }`: its pid, its parent chain, and which of
 * `jobNames` (the job objects of AIWorks's open runs; `runners` gives each run's runner pid and creation time) it belongs
 * to. On Windows every worker and coordinator run is inside a job its descendants cannot leave, so `jobs` names it even
 * after its parent exits. The dashboard's production lookup is caller-lookup.mjs windowsCallerLookup. Refuses with:
 *   APPROVAL_FROM_AIWORKS  the caller, or a process above it, is an open run's runner, is in an open run's job, or is one
 *                          of `aiworksPids` (by default this process: the dashboard itself);
 *   APPROVAL_UNCHECKED     no lookup, another platform than Windows, a lookup that fails or answers malformed, or an open
 *                          launched run whose runner has not reported its complete identity yet. It fails closed.
 * Returns OWNER_CALLER, the result the request receipt records.
 */
export async function checkCaller(store, { lookup, connection = null, aiworksPids = [process.pid], platform = process.platform } = {}) {
  const unchecked = (why) => refuse('APPROVAL_UNCHECKED', `AIWorks could not check that this request came from you, so it was refused (${why}). Try again from your browser`);
  if (platform !== 'win32') unchecked('the caller check runs on Windows only');
  if (typeof lookup !== 'function') unchecked('no process lookup is available');
  const runs = aiworksRuns(store);
  if (runs.some((run) => !run.known)) unchecked('an AIWorks run is starting or cannot be identified');
  const jobNames = runs.map((run) => run.jobName).filter(Boolean);
  let found;
  const runners = runs.filter((run) => run.jobName).map(({ jobName, pid, creationTime }) => ({ jobName, pid, creationTime }));
  try { found = await lookup(connection, { jobNames, runners }); } catch (error) { unchecked(`the process lookup failed: ${error?.code ?? error?.name ?? 'error'}`); }
  const pidOk = (value) => Number.isSafeInteger(value) && value > 0;
  if (!found || !pidOk(found.pid) || !Array.isArray(found.ancestors) || !found.ancestors.every(pidOk)
      || !Array.isArray(found.jobs) || !found.jobs.every((name) => typeof name === 'string')) {
    unchecked('the process lookup gave no answer');
  }
  const ours = new Set([...runs.map((run) => run.pid).filter(Boolean), ...aiworksPids]);
  const chain = [found.pid, ...found.ancestors];
  if (chain.some((pid) => ours.has(pid)) || found.jobs.some((name) => jobNames.includes(name))) {
    refuse('APPROVAL_FROM_AIWORKS', 'this request came from a program AIWorks started, not from you, so it was refused. Approve the plan yourself in the dashboard');
  }
  return OWNER_CALLER;
}

/**
 * The plan, project and rules an approval binds, checked now. Refuses a GitHub project (LOCAL_PATH_NOT_FOR_GITHUB), a
 * declaration without an `aiworks-local:<approvalId>` reference (APPROVAL_INVALID), rules that are not admissible (their
 * RULES_* code from local-overlay.mjs) and rules for another project (APPROVAL_PROJECT_MISMATCH).
 */
function boundPlan({ declaration, overlay, project, governanceRoot, takenIds = [], now }) {
  if (project?.source_kind === 'github' || !isLocalTarget(declaration) || declaration.target.repository !== undefined) {
    refuse('LOCAL_PATH_NOT_FOR_GITHUB', 'a project with GitHub starts work through its GitHub approval, never through a local approval');
  }
  const approvalId = REFERENCE.exec(String(declaration.authorization?.reference ?? ''))?.[1];
  if (!approvalId) refuse('APPROVAL_INVALID', 'a local plan names its approval as authorization.reference aiworks-local:<approval id>');
  try {
    validateOverlayEntry(overlay, governanceRoot, { takenIds, now: new Date(now) });
  } catch (error) {
    if (error instanceof OverlayError) refuse(error.code, error.message);
    throw error;
  }
  if (overlay.id !== declaration.target.projectId || overlay.source.kind !== declaration.target.source || (project && project.source_kind !== declaration.target.source)) {
    refuse('APPROVAL_PROJECT_MISMATCH', `the confirmed rules are for ${overlay.id}, not for this plan's project ${declaration.target.projectId}`);
  }
  return { approvalId, campaignId: declaration.campaignId, projectId: overlay.id, overlayDigest: overlayDigest(overlay), declarationDigest: authorityDigest(declaration) };
}

/**
 * Re-reads the whole ledger and checks it against the approval rows. Throws LEDGER_BROKEN when an entry was edited,
 * removed or reordered, when an approval row has no matching ledger entry (or the reverse), or when a revocation is in
 * one and not the other. A store without local approvals has an empty ledger. Returns `{ length, head }`.
 */
export function verifyLedger(store) {
  if (!hasTables(store)) return { length: 0, head: GENESIS };
  const broken = (why) => refuse('LEDGER_BROKEN', `AIWorks's record of local approvals doesn't add up (${why}), so it starts nothing from it`);
  const approvals = new Map();
  const revocations = new Set();
  let prev = GENESIS;
  ledgerRows(store).forEach((row, index) => {
    if (row.seq !== index + 1) broken(`entry ${index + 1} is missing`);
    if (!LEDGER_KINDS.includes(row.kind)) broken(`entry ${row.seq} has an unknown kind`);
    if (sha256(row.payload) !== row.payload_digest) broken(`entry ${row.seq} was changed`);
    if (row.prev_hash !== prev) broken(`entry ${row.seq} is out of order`);
    if (chainHash(prev, row.kind, row.payload_digest) !== row.hash) broken(`entry ${row.seq} does not chain`);
    let payload;
    try { payload = JSON.parse(row.payload); } catch { broken(`entry ${row.seq} cannot be read`); }
    if (payload?.campaignId !== row.campaign_id) broken(`entry ${row.seq} names another campaign`);
    if (row.kind === 'approval') {
      if (approvals.has(payload.approvalId)) broken(`approval ${payload.approvalId} is recorded twice`);
      approvals.set(payload.approvalId, row.payload);
    }
    if (row.kind === 'revocation') revocations.add(payload.approvalId);
    prev = row.hash;
  });
  const rows = store.all('SELECT approval_id, record_text, revoked_at FROM local_approvals');
  for (const row of rows) {
    if (approvals.get(row.approval_id) !== row.record_text) broken(`approval ${row.approval_id} has no matching entry`);
    if ((row.revoked_at !== null) !== revocations.has(row.approval_id)) broken(`the revocation of ${row.approval_id} is incomplete`);
  }
  if (approvals.size !== rows.length) broken('an entry has no approval');
  if ([...revocations].some((id) => !approvals.has(id))) broken('a revocation names no approval');
  return { length: ledgerRows(store).length, head: prev };
}

function append(store, kind, campaignId, payload, now) {
  const text = canonicalJson(payload);
  const last = store.get('SELECT seq, hash FROM local_ledger ORDER BY seq DESC LIMIT 1');
  const prev = last?.hash ?? GENESIS;
  const digest = sha256(text);
  const hash = chainHash(prev, kind, digest);
  store.run('INSERT INTO local_ledger (seq, kind, campaign_id, payload, payload_digest, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    (last?.seq ?? 0) + 1, kind, campaignId, text, digest, prev, hash, now);
  return hash;
}

/**
 * The dashboard route's write when the owner presses Approve and start (section 8.4). The caller check runs first; then
 * the plan, project and rules are bound, and the approval record, its request receipt and its ledger entry are written
 * in one transaction. The declaration's authorization.reference names the approval id (`aiworks-local:<uuid>`), so the
 * approved digest covers it. Repeating the same request returns the approval recorded before. This records an approval;
 * it registers nothing and starts nothing (admitLocalApproval is the registration check).
 */
export async function recordLocalApproval(store, { declaration, overlay, project = null, governanceRoot, takenIds = [], codeRevision,
  requestId, caller = {}, startByDays = MAX_START_DAYS, now = Date.now() } = {}) {
  const callerResult = await checkCaller(store, caller);
  const bound = boundPlan({ declaration, overlay, project, governanceRoot, takenIds, now });
  if (!REQUEST_ID.test(String(requestId ?? ''))) refuse('APPROVAL_INVALID', 'the approval request has no valid request id');
  if (!REVISION.test(String(codeRevision ?? ''))) refuse('APPROVAL_INVALID', 'the approval names the running code revision as 40 hex characters');
  const record = validateLocalApproval({
    schema: LOCAL_APPROVAL_SCHEMA, approvalId: bound.approvalId, campaignId: bound.campaignId, projectId: bound.projectId,
    overlayDigest: bound.overlayDigest, declarationDigest: bound.declarationDigest, codeRevision,
    approvedAt: new Date(now).toISOString(), startBy: new Date(now + Math.min(startByDays, MAX_START_DAYS) * DAY_MS).toISOString(),
    nonce: randomBytes(32).toString('hex'), method: 'owner-local-ui',
  });
  const text = canonicalJson(record);
  const recordDigest = sha256(text);
  store.db.exec(DDL);
  return store.tx(() => {
    const earlier = store.get('SELECT * FROM local_receipts WHERE request_id = ?', requestId);
    if (earlier) {
      const row = store.get('SELECT * FROM local_approvals WHERE approval_id = ?', earlier.approval_id);
      const same = earlier.action === 'approve' && row && JSON.parse(row.record_text).declarationDigest === bound.declarationDigest;
      if (!same) refuse('APPROVAL_REQUEST_REUSED', `request ${requestId} was already used for another approval`);
      return { record: JSON.parse(row.record_text), recordDigest: row.record_digest, ledgerHead: verifyLedger(store).head, recorded: false };
    }
    verifyLedger(store);
    if (store.get('SELECT 1 AS present FROM local_approvals WHERE approval_id = ?', bound.approvalId)) {
      refuse('APPROVAL_INVALID', `approval id ${bound.approvalId} is already recorded; an approval id names one approval`);
    }
    store.run('INSERT INTO local_approvals (approval_id, campaign_id, record_text, record_digest, nonce, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
      record.approvalId, record.campaignId, text, recordDigest, record.nonce, now);
    store.run('INSERT INTO local_receipts (request_id, approval_id, action, caller, record_digest, received_at) VALUES (?, ?, ?, ?, ?, ?)',
      requestId, record.approvalId, 'approve', callerResult, recordDigest, now);
    const ledgerHead = append(store, 'approval', record.campaignId, record, now);
    store.journal(record.campaignId, 'local-approval-recorded', { approvalId: record.approvalId, recordDigest, ledgerHead }, now);
    return { record, recordDigest, ledgerHead, recorded: true };
  });
}

// The approval this plan names, checked against everything it binds. Shared by admission and the dispatch check.
function boundApproval(store, input) {
  const bound = boundPlan(input);
  if (!hasTables(store)) refuse('APPROVAL_NOT_FOUND', 'no local approval is recorded for this plan; approve it in the dashboard');
  verifyLedger(store);
  const row = store.get('SELECT * FROM local_approvals WHERE approval_id = ?', bound.approvalId);
  if (!row) refuse('APPROVAL_NOT_FOUND', `no local approval ${bound.approvalId} is recorded; approve the plan in the dashboard`);
  let record;
  try { record = JSON.parse(row.record_text); } catch { refuse('APPROVAL_INVALID', `approval ${bound.approvalId} cannot be read`); }
  validateLocalApproval(record);
  if (sha256(row.record_text) !== row.record_digest || record.approvalId !== row.approval_id || record.campaignId !== row.campaign_id || record.nonce !== row.nonce) {
    refuse('APPROVAL_INVALID', `approval ${bound.approvalId} does not match its own record`);
  }
  const receipt = store.get("SELECT * FROM local_receipts WHERE approval_id = ? AND action = 'approve'", bound.approvalId);
  if (!receipt || receipt.caller !== OWNER_CALLER || receipt.record_digest !== row.record_digest) {
    refuse('APPROVAL_NO_RECEIPT', `approval ${bound.approvalId} did not come through your dashboard, so it admits nothing`);
  }
  if (row.revoked_at !== null) refuse('APPROVAL_REVOKED', `approval ${bound.approvalId} was revoked at ${new Date(row.revoked_at).toISOString()}`);
  if (record.campaignId !== bound.campaignId || record.projectId !== bound.projectId) {
    refuse('APPROVAL_PROJECT_MISMATCH', `approval ${bound.approvalId} is for ${record.campaignId} in ${record.projectId}, not this plan`);
  }
  if (record.declarationDigest !== bound.declarationDigest) {
    refuse('DECLARATION_DIFFERS_FROM_APPROVAL', `this plan's fingerprint ${short(bound.declarationDigest)} differs from the approved ${short(record.declarationDigest)}; nothing was started. Approve the changed plan again`);
  }
  if (record.overlayDigest !== bound.overlayDigest) {
    refuse('OVERLAY_DIFFERS_FROM_APPROVAL', `the project's rules changed after you approved this plan (${short(bound.overlayDigest)}, approved ${short(record.overlayDigest)}); approve it again`);
  }
  return { record, row };
}

/**
 * The registration check (section 8.3 point 1 to 5): the plan as approved, by the owner's dashboard, not revoked, before
 * its start-by date, on the code revision it was approved on, and its nonce never used before. Admitting consumes the
 * nonce, so one approval admits one registration. Returns the admitted record; it registers nothing itself
 * (registerLocalPlan calls it inside the registration transaction).
 */
export function admitLocalApproval(store, { declaration, overlay, project = null, governanceRoot, takenIds = [], codeRevision,
  now = Date.now() } = {}) {
  return store.tx(() => {
    const { record } = boundApproval(store, { declaration, overlay, project, governanceRoot, takenIds, now });
    if (now > Date.parse(record.startBy)) refuse('APPROVAL_EXPIRED', `approval ${record.approvalId} had to start by ${record.startBy}; approve the plan again`);
    if (record.codeRevision !== codeRevision) {
      refuse('CODE_DIFFERS_FROM_APPROVAL', `the plan was approved on AIWorks ${record.codeRevision.slice(0, 7)}, and this is ${String(codeRevision).slice(0, 7)}; approve it again`);
    }
    if (store.get('SELECT 1 AS present FROM local_nonces WHERE nonce = ?', record.nonce)) {
      refuse('APPROVAL_NONCE_USED', `approval ${record.approvalId} was already used once; one approval starts one plan once`);
    }
    store.run('INSERT INTO local_nonces (nonce, approval_id, campaign_id, used_at) VALUES (?, ?, ?, ?)', record.nonce, record.approvalId, record.campaignId, now);
    store.journal(record.campaignId, 'local-approval-admitted', { approvalId: record.approvalId, declarationDigest: record.declarationDigest }, now);
    return { admitted: true, record };
  });
}

/**
 * Registers a plan for a project without GitHub (section 8.3, slice E12): the owner's approval in the dashboard is the
 * registration. In one transaction it reads the project's confirmed rules and AIWorks's copy from the store
 * (project-connect.mjs resolveLocalProject: no rules, revoked rules or an unknown baseline are refused), admits the
 * approval the plan names (admitLocalApproval: expired rules, a changed plan, another code revision or a used approval
 * are refused), then registers exactly that plan with the same gates as every campaign (api.mjs campaignStart). A refusal
 * leaves nothing behind, the approval unused included. Returns campaignStart's result and the admitted approval.
 */
export function registerLocalPlan(store, { declaration, governanceRoot, codeRevision, now = Date.now() } = {}) {
  validateDeclaration(declaration);
  return store.tx(() => {
    const { project, overlay, takenIds } = resolveLocalProject(store, declaration);
    const { record } = admitLocalApproval(store, { declaration, overlay, project, governanceRoot, takenIds, codeRevision, now });
    return { ...campaignStart(store, declaration, now), approvalId: record.approvalId };
  });
}

/**
 * The check before every dispatch (section 8.3): the ledger still adds up, and the campaign's approval is still the one
 * admitted, unrevoked, for this exact plan and these exact rules. Read-only. A refusal stops new dispatches only.
 */
export function checkLocalDispatch(store, { declaration, overlay, project = null, governanceRoot, takenIds = [], now = Date.now() } = {}) {
  const { record } = boundApproval(store, { declaration, overlay, project, governanceRoot, takenIds, now });
  const used = store.get('SELECT * FROM local_nonces WHERE nonce = ?', record.nonce);
  if (!used || used.approval_id !== record.approvalId || used.campaign_id !== record.campaignId) {
    refuse('APPROVAL_NOT_ADMITTED', `approval ${record.approvalId} has not started this plan`);
  }
  return { approvalId: record.approvalId, declarationDigest: record.declarationDigest, ledgerHead: verifyLedger(store).head };
}

/**
 * The owner's Revoke in the dashboard: the same caller check as an approval, then a revocation entry in the ledger. Nothing
 * starts or dispatches under the approval again; running operations finish and are recorded, as with a pause.
 */
export async function revokeLocalApproval(store, { approvalId, reason = null, requestId, caller = {}, now = Date.now() } = {}) {
  const callerResult = await checkCaller(store, caller);
  if (!REQUEST_ID.test(String(requestId ?? ''))) refuse('APPROVAL_INVALID', 'the revoke request has no valid request id');
  if (!hasTables(store)) refuse('APPROVAL_NOT_FOUND', `no local approval ${approvalId} is recorded`);
  return store.tx(() => {
    verifyLedger(store);
    const row = store.get('SELECT * FROM local_approvals WHERE approval_id = ?', approvalId);
    if (!row) refuse('APPROVAL_NOT_FOUND', `no local approval ${approvalId} is recorded`);
    if (row.revoked_at !== null) return { approvalId, revoked: false, revokedAt: new Date(row.revoked_at).toISOString() };
    if (store.get('SELECT 1 AS present FROM local_receipts WHERE request_id = ?', requestId)) refuse('APPROVAL_REQUEST_REUSED', `request ${requestId} was already used`);
    store.run('UPDATE local_approvals SET revoked_at = ? WHERE approval_id = ?', now, approvalId);
    store.run('INSERT INTO local_receipts (request_id, approval_id, action, caller, record_digest, received_at) VALUES (?, ?, ?, ?, ?, ?)',
      requestId, approvalId, 'revoke', callerResult, row.record_digest, now);
    const ledgerHead = append(store, 'revocation', row.campaign_id, { approvalId, campaignId: row.campaign_id, reason, revokedAt: new Date(now).toISOString() }, now);
    store.journal(row.campaign_id, 'local-approval-revoked', { approvalId, reason, ledgerHead }, now);
    return { approvalId, revoked: true, revokedAt: new Date(now).toISOString() };
  });
}

/** The project history's view of a campaign's local approvals, oldest first: date, plan fingerprint, used, revoked. */
export function localApprovals(store, campaignId) {
  if (!hasTables(store)) return [];
  return store.all('SELECT a.*, n.used_at FROM local_approvals a LEFT JOIN local_nonces n ON n.approval_id = a.approval_id WHERE a.campaign_id = ? ORDER BY a.recorded_at, a.approval_id', campaignId)
    .map((row) => {
      const record = JSON.parse(row.record_text);
      return { approvalId: row.approval_id, approvedAt: record.approvedAt, startBy: record.startBy, fingerprint: short(record.declarationDigest),
        admittedAt: row.used_at === null ? null : new Date(row.used_at).toISOString(),
        revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString() };
    });
}
