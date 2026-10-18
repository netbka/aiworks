// The owner's Apply (docs/design/WORK_ENVELOPE.md section 8.6, slice E13; plan STA18). A verified local candidate
// (local-candidates.mjs) is written to the owner's local Git repository or plain folder only when the owner presses
// Apply, and Undo apply is the way back. An owner action under Review only, never Auto Release: it needs no release
// grant, creates no release record (the `releases` and `release_locks` tables are never touched) and never runs by
// itself. Auto Release for a local project stays off until example-org/aiworks#33.
//
// Every Apply and Undo apply passes the dashboard's caller check first (section 8.2): the route passes it in as
// `caller(store)`, checkCaller of local admission bound to the request's connection, and it must answer `owner-browser`.
// A request from a process AIWorks started is refused, and so is one without a check or one the check cannot place.
// The check is passed in, not imported, so local admission keeps no runtime caller until STA17 switches it on. Then:
// 1. bind: the candidate's project, its recorded baseline (`project_baselines`) and, for a plain folder, that baseline's
//    manifest of paths and hashes (adapters/mirror.mjs folderManifest);
// 2. rescan, backup, apply, confirm: REL8's adapters (local-apply.mjs). Local Git: the branch head must equal the
//    baseline commit and the tree be clean, then fast-forward only. Plain folder: every path the result writes or
//    deletes must still have the manifest's hash, else APPLY_FOLDER_CHANGED and nothing is written;
// 3. crash: an apply left open is reconciled by reading the folder, never run again blindly.
// The backup lives under AIWorks's data directory, `<dataDir>/applies/<projectId>/<applyId>`. This module reads the
// managed mirror and writes only through the adapters. It makes no network or GitHub call: Git runs on local paths only.
//
// The dashboard's Apply and Undo apply buttons call it (slice UI17, src/dashboard/work.mjs) on candidates of plans local
// admission registered (slice STA17).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { folderManifest, MIRROR_REPO, SNAPSHOT_DIR } from '../adapters/mirror.mjs';
import { candidates } from '../local-candidates.mjs';
import { project as projectRow } from '../projects.mjs';
import { LOCAL_FOLDER_APPLY, LOCAL_GIT_APPLY, localFolderApply, localGitApply, reconcileLocalFolderApply, reconcileLocalGitApply,
  undoLocalFolderApply, undoLocalGitApply } from './local-apply.mjs';

const SHA = /^[0-9a-f]{40}$/;
/** The caller check's answer for a request that did not come from AIWorks's own processes (local admission). */
export const OWNER_CALLER = 'owner-browser';
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// The adapters' record states that end an apply. Anything else is open and is reconciled, never repeated.
const FINAL = Object.freeze(['applied', 'rolled-back', 'stopped']);
const KINDS = Object.freeze({ 'local-git': LOCAL_GIT_APPLY, folder: LOCAL_FOLDER_APPLY });
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export class OwnerApplyError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'OwnerApplyError'; this.code = code; this.detail = detail; }
}
const refuse = (code, message, detail) => { throw new OwnerApplyError(code, message, detail); };

// Created on the first Apply, because this slice does not own store.mjs. Additive: a store that never applied anything
// has neither table and behaves exactly as before. `local_applies` names each attempt and where its backup is; the
// adapter's `<backupDir>/apply.json` is the record of what happened to the folder. `local_apply_receipts` holds one row
// per owner request with the caller check's result, so a repeated request is answered, never acted on twice.
const DDL = `CREATE TABLE IF NOT EXISTS local_applies (
  apply_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, task_id TEXT NOT NULL, seq INTEGER NOT NULL, attempt INTEGER NOT NULL,
  project_id TEXT NOT NULL, kind TEXT NOT NULL, sha TEXT NOT NULL, baseline_commit TEXT NOT NULL, backup_dir TEXT NOT NULL,
  last_outcome TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (campaign_id, task_id, seq, attempt));
CREATE TABLE IF NOT EXISTS local_apply_receipts (
  request_id TEXT PRIMARY KEY, apply_id TEXT NOT NULL, action TEXT NOT NULL, caller TEXT NOT NULL, received_at INTEGER NOT NULL)`;
const hasTables = (store) => Boolean(store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'local_applies'"));

/** The adapter's record of one attempt, or null when nothing was backed up (a refusal writes no record). */
const recordOf = (row) => {
  const path = join(row.backup_dir, 'apply.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};

/** An attempt that may have written the folder and is not settled. A backup cut short never wrote it (REL8, step 3). */
const isOpen = (row) => { const record = recordOf(row); return Boolean(record) && !FINAL.includes(record.state) && record.state !== 'backing-up'; };

/** The caller check of an approval, with Apply's own words. It fails closed: no check, a throw or any other answer refuses. */
async function ownerCaller(store, caller, action) {
  let answer = null;
  let code = null;
  try { answer = typeof caller === 'function' ? await caller(store) : null; } catch (error) { code = error?.code ?? null; }
  if (code === 'APPROVAL_FROM_AIWORKS') refuse('APPLY_FROM_AIWORKS', `this ${action} came from a program AIWorks started, not from you, so nothing was written. Press it yourself in the dashboard`);
  if (answer !== OWNER_CALLER) refuse('APPLY_UNCHECKED', `AIWorks could not check that this ${action} came from you, so nothing was written. Try again from your browser`);
  return answer;
}

/** A repeated owner request: the attempt it already named, or a refusal when the id was used for something else. */
function earlierReceipt(store, requestId, action, matches) {
  if (!REQUEST_ID.test(String(requestId ?? ''))) refuse('APPLY_INVALID', `the ${action} request has no valid request id`);
  if (!hasTables(store)) return null;
  const receipt = store.get('SELECT * FROM local_apply_receipts WHERE request_id = ?', requestId);
  if (!receipt) return null;
  const row = store.get('SELECT * FROM local_applies WHERE apply_id = ?', receipt.apply_id);
  if (receipt.action !== action || !row || !matches(row)) refuse('APPLY_REQUEST_REUSED', `request ${requestId} was already used for something else`);
  return row;
}

/** One read-only Git command in AIWorks's managed mirror. Inherited GIT_* variables could point Git elsewhere. */
function mirrorGit(git, gitEnv, repo, args, { bytes = false } = {}) {
  const [command, ...prefix] = git;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const result = spawnSync(command, [...prefix, '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repo, ...args], {
    encoding: bytes ? 'buffer' : 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 256 * 1024 * 1024,
    env: { ...env, ...gitEnv, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error?.code === 'ENOENT') refuse('GIT_CLI_MISSING', 'git was not found');
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? (bytes ? Buffer.alloc(0) : '') };
}

/**
 * What a folder result writes and deletes, from the managed copy (the commit the verifier checked, against the
 * baseline commit), with each path's `before` taken from the baseline's manifest, not from the folder. A link or a
 * nested repository in the result is refused. A change of the executable bit only writes nothing in a plain folder.
 */
function folderChanges(candidate, mirrorRoot, baseline, { git, gitEnv }) {
  const repo = join(mirrorRoot, SNAPSHOT_DIR);
  const manifest = folderManifest({ mirrorRoot, commit: baseline.commit_sha, digest: baseline.manifest_digest });
  if (!manifest) refuse('APPLY_BASELINE_UNKNOWN', 'AIWorks no longer has the list of files it started from, so it cannot check your folder; nothing was written');
  const hashes = new Map(manifest.map(([path, , hash]) => [path, hash]));
  if (!mirrorGit(git, gitEnv, repo, ['cat-file', '-e', `${candidate.sha}^{commit}`]).ok) refuse('APPLY_CANDIDATE_MISSING', 'the verified result is no longer in AIWorks\'s copy; nothing was written');
  if (!mirrorGit(git, gitEnv, repo, ['merge-base', '--is-ancestor', baseline.commit_sha, candidate.sha]).ok) {
    refuse('APPLY_NOT_FAST_FORWARD', 'the result does not build on the files AIWorks started from; nothing was written');
  }
  const listed = mirrorGit(git, gitEnv, repo, ['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', baseline.commit_sha, candidate.sha]);
  if (!listed.ok) refuse('APPLY_CANDIDATE_MISSING', 'AIWorks could not read what the result changes; nothing was written');
  const fields = listed.stdout.split('\0');
  const changes = [];
  const refusedPaths = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode, newMode, , newBlob, status] = fields[index].replace(/^:/, '').split(' ');
    const path = fields[index + 1];
    if (!status) continue;
    if (status[0] !== 'D' && newMode !== '100644' && newMode !== '100755') { refusedPaths.push({ path, reason: 'a link or nested repository' }); continue; }
    const before = status[0] === 'A' ? null : hashes.get(path) ?? refuse('APPLY_BASELINE_UNKNOWN', `${path} is not in the list of files AIWorks started from; nothing was written`);
    if (status[0] !== 'A' && oldMode !== '100644' && oldMode !== '100755') { refusedPaths.push({ path, reason: 'a link or nested repository' }); continue; }
    let after = null;
    if (status[0] !== 'D') {
      const read = mirrorGit(git, gitEnv, repo, ['cat-file', 'blob', newBlob], { bytes: true });
      if (!read.ok) refuse('APPLY_CANDIDATE_MISSING', `AIWorks could not read ${path} from the result; nothing was written`);
      after = read.stdout;
    }
    if (after !== null && before === sha256(after)) continue;
    changes.push({ path, before, after });
  }
  if (refusedPaths.length) return { refusedPaths };
  if (!changes.length) refuse('APPLY_NOTHING', 'the result changes no file in your folder; nothing was written');
  return { changes };
}

/**
 * A registered local plan names its project by the `lp-` id of the rules the owner confirmed (local admission, STA17),
 * so its candidates carry that id: the project is the one those rules belong to. A store without rules has none.
 */
function projectOfRules(store, rulesId) {
  let row = null;
  try { row = store.get('SELECT project_id FROM project_overlays WHERE id = ?', rulesId); } catch { row = null; }
  return row ? projectRow(store, row.project_id) : null;
}

/** The candidate, its project and its baseline as recorded, each checked against the others. */
function bound(store, { campaignId, taskId, seq }) {
  const found = candidates(store, campaignId, taskId);
  const candidate = seq === undefined || seq === null ? found.at(-1) : found.find((row) => row.seq === seq);
  if (!candidate) refuse('APPLY_NO_CANDIDATE', `there is no verified result of ${taskId} to apply`);
  if (candidate.deliverable !== 'commit') refuse('APPLY_NOTHING', 'this result is a report; there is nothing to apply to your folder');
  if (candidate.verification?.verdict !== 'accepted' || !SHA.test(candidate.sha ?? '')) refuse('APPLY_NOT_VERIFIED', 'only an independently verified result can be applied');
  const kind = KINDS[candidate.source];
  if (!kind) refuse('APPLY_NOT_LOCAL', 'only a result for a project without GitHub is applied here');
  const project = projectRow(store, candidate.projectId) ?? projectOfRules(store, candidate.projectId);
  if (!project || project.disconnected_at !== null) refuse('APPLY_NO_PROJECT', `the project ${candidate.projectId} is not connected`);
  if (project.source_kind !== candidate.source) refuse('APPLY_NOT_LOCAL', `the project ${project.id} is not a ${candidate.source} project`);
  const commit = candidate.baseline?.commit;
  const baseline = store.get('SELECT * FROM project_baselines WHERE project_id = ? AND seq = ?', project.id, candidate.baseline?.seq ?? -1);
  if (!SHA.test(commit ?? '') || !baseline || baseline.commit_sha !== commit) refuse('APPLY_BASELINE_UNKNOWN', 'the result names a starting point AIWorks has no record of; nothing was written');
  return { candidate, project, baseline, kind };
}

const applyIdOf = (candidate, attempt) => `apply-${attempt}-${sha256(JSON.stringify([candidate.campaignId, candidate.taskId, candidate.seq, attempt])).slice(0, 16)}`;

/** What the dashboard shows for one attempt. Never a pull request or merge field: a local project has neither. */
const shown = (row, result) => ({ applyId: row.apply_id, campaignId: row.campaign_id, taskId: row.task_id, seq: row.seq, projectId: row.project_id,
  kind: row.kind, sha: row.sha, outcome: result.outcome, state: result.state ?? null, code: result.code ?? null, files: result.files ?? [],
  reason: result.reason ?? null, undo: result.outcome === 'applied' });

function settle(store, row, result, kind, now) {
  store.tx(() => {
    store.run('UPDATE local_applies SET last_outcome = ?, updated_at = ? WHERE apply_id = ?', result.outcome, now, row.apply_id);
    store.journal(row.campaign_id, kind, { applyId: row.apply_id, task: row.task_id, seq: row.seq, outcome: result.outcome, code: result.code ?? null }, now);
  });
  return shown({ ...row, last_outcome: result.outcome }, result);
}

const reconcileAdapter = (row, options) => (row.kind === LOCAL_GIT_APPLY
  ? reconcileLocalGitApply({ backupDir: row.backup_dir, git: options.git, gitEnv: options.gitEnv })
  : reconcileLocalFolderApply({ backupDir: row.backup_dir, hooks: options.hooks }));

/**
 * The owner pressed Apply on a task's verified local candidate (the newest, or `seq`). The caller check runs first.
 * An earlier attempt left open by a crash is reconciled first, and an applied one is only reported: Apply is never
 * repeated. Otherwise the folder is rescanned, backed up and written through REL8's adapter. Returns
 * { applyId, outcome: applied | refused | rolled-back | stopped | unknown | not-done, code, files, reason, undo, ... }.
 * `caller(store)` is the dashboard route's caller check. Throws OwnerApplyError for a request it will not act on (APPLY_FROM_AIWORKS, APPLY_UNCHECKED, APPLY_REQUEST_REUSED,
 * APPLY_BUSY and the candidate checks). `hooks` reach the adapter so tests can stop the process at a chosen point.
 */
export async function ownerApply(store, { campaignId, taskId, seq = null, requestId, caller = null, dataDir, git = ['git'], gitEnv, hooks = {}, now = Date.now() } = {}) {
  const callerResult = await ownerCaller(store, caller, 'Apply');
  const { candidate, project, baseline, kind } = bound(store, { campaignId, taskId, seq });
  const repeated = earlierReceipt(store, requestId, 'apply', (row) => row.campaign_id === campaignId && row.task_id === taskId && row.seq === candidate.seq);
  if (repeated) {
    const record = recordOf(repeated);
    return shown(repeated, { outcome: record?.state && FINAL.includes(record.state) ? record.state : repeated.last_outcome, state: record?.state ?? null,
      reason: 'this request was already received; nothing was written again' });
  }
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('the owner\'s Apply needs AIWorks\'s data directory');
  store.db.exec(DDL);
  const options = { git, gitEnv, hooks };
  const open = store.all('SELECT * FROM local_applies WHERE project_id = ? ORDER BY created_at, attempt', project.id).filter(isOpen);
  const other = open.find((row) => row.campaign_id !== candidate.campaignId || row.task_id !== candidate.taskId || row.seq !== candidate.seq);
  if (other) refuse('APPLY_BUSY', `another Apply in ${project.id} (${other.apply_id}) was left open; AIWorks reconciles it before it applies anything else`);
  const attempts = store.all('SELECT * FROM local_applies WHERE campaign_id = ? AND task_id = ? AND seq = ? ORDER BY attempt',
    candidate.campaignId, candidate.taskId, candidate.seq);
  // The newest attempt goes on only while it has no backup yet (it was refused) or a reconcile proves it not done.
  // An applied one is only reported. Rolled back or stopped, a new press is a new attempt with its own backup.
  let row = attempts.at(-1) ?? null;
  const last = row && recordOf(row);
  if (last?.state === 'applied') {
    return shown(row, { outcome: 'applied', state: 'applied', reason: 'this result is already applied; nothing was written again' });
  }
  if (last && !FINAL.includes(last.state)) {
    const settled = reconcileAdapter(row, options);
    if (settled.outcome !== 'not-done') return settle(store, row, settled, 'owner-apply-reconciled', now);
    // A backup cut short by a crash never wrote the folder; it is left as it is and a fresh attempt backs up again.
    if (recordOf(row).state === 'backing-up') row = null;
  } else if (last) {
    row = null;
  }
  if (!row) {
    const attempt = (attempts.at(-1)?.attempt ?? 0) + 1;
    const applyId = applyIdOf(candidate, attempt);
    row = { apply_id: applyId, campaign_id: candidate.campaignId, task_id: candidate.taskId, seq: candidate.seq, attempt, project_id: project.id,
      kind, sha: candidate.sha, baseline_commit: baseline.commit_sha, backup_dir: join(dataDir, 'applies', project.id, applyId), last_outcome: null,
      created_at: now, updated_at: now };
  }
  const plan = kind === LOCAL_FOLDER_APPLY ? folderChanges(candidate, project.mirror_root, baseline, options) : null;
  // The attempt and the owner's receipt are recorded before the adapter writes its backup, so a crash leaves a row that
  // names the backup directory to reconcile.
  store.tx(() => {
    if (!store.get('SELECT 1 AS present FROM local_applies WHERE apply_id = ?', row.apply_id)) store.insert('local_applies', row);
    store.insert('local_apply_receipts', { request_id: requestId, apply_id: row.apply_id, action: 'apply', caller: callerResult, received_at: now });
    store.journal(row.campaign_id, 'owner-apply-pressed', { applyId: row.apply_id, task: row.task_id, seq: row.seq, sha: row.sha, caller: callerResult }, now);
  });
  if (plan?.refusedPaths) return settle(store, row, { outcome: 'refused', code: 'APPLY_PATH_REFUSED', files: plan.refusedPaths, reason: 'AIWorks does not write these paths' }, 'owner-apply-finished', now);
  const result = kind === LOCAL_GIT_APPLY
    ? localGitApply({ id: row.apply_id, repoRoot: project.root_path, branch: project.local_branch, baseline: baseline.commit_sha, verifiedSha: candidate.sha,
      source: join(project.mirror_root, MIRROR_REPO), backupDir: row.backup_dir, git, gitEnv, hooks })
    : localFolderApply({ id: row.apply_id, targetRoot: project.root_path, backupDir: row.backup_dir, changes: plan.changes, hooks });
  return settle(store, row, result, 'owner-apply-finished', now);
}

/**
 * The owner pressed Undo apply on an applied attempt. The same caller check. The backup is put back only where the
 * folder still holds what Apply wrote; over a file changed since, it is refused with the files named and nothing written.
 */
export async function undoOwnerApply(store, { applyId, requestId, caller = null, git = ['git'], gitEnv, hooks = {}, now = Date.now() } = {}) {
  const callerResult = await ownerCaller(store, caller, 'Undo apply');
  const row = hasTables(store) ? store.get('SELECT * FROM local_applies WHERE apply_id = ?', applyId) : null;
  if (!row) refuse('APPLY_NOT_FOUND', `there is no Apply ${applyId} to undo`);
  const repeated = earlierReceipt(store, requestId, 'undo', (earlier) => earlier.apply_id === applyId);
  if (repeated) return shown(repeated, { outcome: recordOf(repeated)?.state ?? repeated.last_outcome, reason: 'this request was already received; nothing was written again' });
  const record = recordOf(row);
  if (record?.state !== 'applied') refuse('UNDO_NOT_APPLIED', `Apply ${applyId} is ${record?.state ?? 'not recorded'}; only an applied result can be undone`);
  store.tx(() => {
    store.insert('local_apply_receipts', { request_id: requestId, apply_id: row.apply_id, action: 'undo', caller: callerResult, received_at: now });
    store.journal(row.campaign_id, 'owner-undo-pressed', { applyId: row.apply_id, caller: callerResult }, now);
  });
  const result = row.kind === LOCAL_GIT_APPLY
    ? undoLocalGitApply({ backupDir: row.backup_dir, git, gitEnv })
    : undoLocalFolderApply({ backupDir: row.backup_dir, hooks });
  return settle(store, row, result, 'owner-undo-finished', now);
}

/**
 * Settle every Apply left open by a crash, by reading the folder (AUTO_RELEASE.md section 8, local rows). It is not an
 * owner press and starts nothing new: an apply proven not done stays not done until the owner presses Apply again; one
 * caught midway is finished from its staged bytes or rolled back exactly as REL8's reconcile says. Returns each result.
 */
export function reconcileOwnerApplies(store, { git = ['git'], gitEnv, hooks = {}, now = Date.now() } = {}) {
  if (!hasTables(store)) return [];
  return store.all('SELECT * FROM local_applies ORDER BY created_at, attempt').filter(isOpen)
    .map((row) => settle(store, row, reconcileAdapter(row, { git, gitEnv, hooks }), 'owner-apply-reconciled', now));
}

/** Every Apply attempt of a campaign, oldest first, as the dashboard shows it. Read-only. */
export function ownerApplies(store, campaignId) {
  if (!hasTables(store)) return [];
  return store.all('SELECT * FROM local_applies WHERE campaign_id = ? ORDER BY task_id, seq, attempt', campaignId).map((row) => {
    const record = recordOf(row);
    return shown(row, { outcome: record?.state && FINAL.includes(record.state) ? record.state : row.last_outcome, state: record?.state ?? null });
  });
}

