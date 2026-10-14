// Local candidates (docs/design/WORK_ENVELOPE.md slice E10; plan STA14). A project without GitHub never gets a pull
// request, a pushed branch or an issue comment. Its verified result is recorded here instead: the exact verified
// revision, the independent verifier's evidence and the project baseline it was built from. A candidate is never applied
// to the owner's folder; applying it is separately governed (#13).
//
// Inert until local admission is on: validateDeclaration refuses every local target (LOCAL_START_OFF) until the owner
// decisions on #24 (D2) and #32 (D4) and slice STA17, so no registered campaign reaches this ledger yet.
import { createHash } from 'node:crypto';

/** The local project kinds (PROJECT_CONNECTION D1). A GitHub project has no `target.source`. */
export const LOCAL_SOURCES = Object.freeze(['local-git', 'folder']);

/** Whether a declaration targets a project without GitHub (WORK_ENVELOPE 4.1: `target.source`). */
export const isLocalTarget = (declaration) => LOCAL_SOURCES.includes(declaration?.target?.source);

/** The owner-facing state of a recorded candidate (WORK_ENVELOPE 7.2, CANDIDATE_READY). */
export const CANDIDATE_READY = Object.freeze({
  code: 'CANDIDATE_READY', state: 'Ready for your review', action: 'Review result',
  copy: (sha) => `Verified at ${String(sha).slice(0, 7)}. It's not applied to your folder.`,
});

// Created on the first recorded candidate, because this slice does not own store.mjs. It is additive: a store that never
// recorded a candidate has no table and behaves exactly as before. Append-only: a row is only inserted. A task gets a
// new seq for each newly verified revision or report, and the same one again is recorded once.
const DDL = `CREATE TABLE IF NOT EXISTS local_candidates (
  campaign_id TEXT NOT NULL, task_id TEXT NOT NULL, seq INTEGER NOT NULL, project_id TEXT NOT NULL, source TEXT NOT NULL,
  deliverable TEXT NOT NULL, sha TEXT NOT NULL, base_sha TEXT, baseline TEXT NOT NULL, verification TEXT NOT NULL,
  report TEXT, report_digest TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, task_id, seq), UNIQUE (campaign_id, task_id, sha, report_digest))`;
const hasTable = (store) => Boolean(store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'local_candidates'"));
// The store decodes `verification` itself (a JSON column); `baseline` is this table's own and is parsed here.
const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value ?? null);

function view(row) {
  return {
    campaignId: row.campaign_id, taskId: row.task_id, seq: row.seq, projectId: row.project_id, source: row.source,
    deliverable: row.deliverable, sha: row.sha, baseSha: row.base_sha, baseline: parse(row.baseline),
    verification: parse(row.verification), report: row.report, reportDigest: row.report_digest,
    recordedAt: new Date(row.recorded_at).toISOString(),
  };
}

/**
 * Records one verified local task as a candidate: `{ sha, verification, baseline }` plus the report for a report task.
 * Call it inside the controller's fenced transaction. Idempotent: the same task, revision and report return the row
 * recorded before, so a crash between this write and the task update never records it twice. Refuses a declaration
 * that is not a local target, and a candidate without a verified revision, verifier evidence or baseline.
 */
export function recordCandidate(store, { declaration, task, deliverable, now }) {
  if (!isLocalTarget(declaration)) throw new Error(`campaign ${declaration?.campaignId} is not a local project: its results are published, not recorded as local candidates`);
  const baseline = declaration.target.baseline;
  if (!/^[0-9a-f]{40}$/.test(task?.verified_sha ?? '')) throw new Error(`task ${task?.task_id} has no verified revision to record`);
  if (!task.verification || typeof task.verification !== 'object') throw new Error(`task ${task.task_id} has no verifier evidence to record`);
  if (!baseline || typeof baseline !== 'object') throw new Error(`campaign ${declaration.campaignId} has no project baseline to record`);
  const report = deliverable === 'report' ? String(task.result?.report ?? '') : null;
  const reportDigest = createHash('sha256').update(report ?? '', 'utf8').digest('hex');
  store.db.exec(DDL);
  const key = [declaration.campaignId, task.task_id, task.verified_sha, reportDigest];
  const existing = store.get('SELECT * FROM local_candidates WHERE campaign_id = ? AND task_id = ? AND sha = ? AND report_digest = ?', ...key);
  if (existing) return { ...view(existing), recorded: false };
  const seq = (store.get('SELECT MAX(seq) AS seq FROM local_candidates WHERE campaign_id = ? AND task_id = ?', declaration.campaignId, task.task_id)?.seq ?? 0) + 1;
  store.run(`INSERT INTO local_candidates (campaign_id, task_id, seq, project_id, source, deliverable, sha, base_sha, baseline,
    verification, report, report_digest, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  declaration.campaignId, task.task_id, seq, declaration.target.projectId, declaration.target.source, deliverable,
  task.verified_sha, task.base_sha ?? null, JSON.stringify(baseline), task.verification, report, reportDigest, now);
  return { ...view(store.get('SELECT * FROM local_candidates WHERE campaign_id = ? AND task_id = ? AND seq = ?', declaration.campaignId, task.task_id, seq)), recorded: true };
}

/** Every candidate of a campaign (or of one task), oldest first. Read-only; a store without candidates has none. */
export function candidates(store, campaignId, taskId = null) {
  if (!hasTable(store)) return [];
  return (taskId === null
    ? store.all('SELECT * FROM local_candidates WHERE campaign_id = ? ORDER BY task_id, seq', campaignId)
    : store.all('SELECT * FROM local_candidates WHERE campaign_id = ? AND task_id = ? ORDER BY seq', campaignId, taskId)).map(view);
}

/** What status shows for a task's newest candidate: Ready for your review, at its verified revision. Null without one. */
export function candidateStatus(store, campaignId, taskId) {
  const latest = candidates(store, campaignId, taskId).at(-1);
  if (!latest) return null;
  return { code: CANDIDATE_READY.code, state: CANDIDATE_READY.state, copy: CANDIDATE_READY.copy(latest.sha), action: CANDIDATE_READY.action,
    seq: latest.seq, sha: latest.sha, baseline: latest.baseline, recordedAt: latest.recordedAt };
}
