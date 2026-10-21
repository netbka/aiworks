// AIWorks intake (docs/design/WORK_ENVELOPE.md section 3, slice E6): the owner asks for work by goal, issue, pull
// request or plan file, or plan only, and gets a draft plan. Code stores the request, pins the exact source versions,
// builds and validates the draft declaration and finds conflicts. The coordinator only proposes the plan's wording,
// steps and file scope (coordinator.mjs, intake mode). A draft is never registered or scheduled: nothing that
// schedules reads work_requests or work_drafts, and turning a draft into work is the owner's approval (slices E7, E8).
import { SECRET_LIKE_PATH_PATTERN } from '../../scripts/lib/worker-context.mjs';
import { approvedDeclarations } from './approved-declarations.mjs';
import { authorityDigest, scopeDigest, validateDeclaration } from './campaign.mjs';
import { exec as gitExec } from './adapters/git.mjs';
import { trustedTip, trustsLocalMain } from './self-hosting.mjs';
import { item as workItem } from './work-list.mjs';
import { MIRROR_REPO, SNAPSHOT_DIR } from './adapters/mirror.mjs';
import { containsSecret } from './coordinator.mjs';
import { localApprovals } from './local-admission.mjs';
import { project as readProject } from './projects.mjs';
import { domainHolders, domainOf, findWorkConflict } from './work-ownership.mjs';
import { join } from 'node:path';

/** The four routes of WORK_ENVELOPE 3.1. Plan only is a switch on any of them, not a route. */
export const INTAKE_ROUTES = Object.freeze(['goal', 'issue', 'pr', 'plan-file']);
/** Issue and PR routes read GitHub, so only a GitHub project offers them. */
export const GITHUB_ROUTES = Object.freeze(['issue', 'pr']);
/**
 * The draft's providers until the owner changes them on Review (WORK_ENVELOPE 4.2): never what the coordinator or the
 * request text asks for. It is the design's example executor; permission modes never include bypassPermissions.
 */
export const DRAFT_EXECUTOR = Object.freeze({ kind: 'claude-cli', model: 'opus', permissionMode: 'auto',
  implementerTimeoutMinutes: 240, verifierTimeoutMinutes: 120 });
const MAX_WAITING = 10;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UUID = /^[0-9a-f-]{36}$/i;
const SHA = /^[0-9a-f]{40}$/;
const secretLike = new RegExp(SECRET_LIKE_PATH_PATTERN, 'u');
const safePath = (path) => typeof path === 'string' && path.length > 0 && path.length <= 512 && !path.startsWith('/') &&
  !/[\\:%\u0000-\u001f\u007f]/.test(path) && !path.split('/').some((part) => !part || part === '.' || part === '..');
const text = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !CONTROL.test(value);
const int = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 1e9;
const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export class IntakeError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'IntakeError'; this.code = code; Object.assign(this, detail); }
}
const refuse = (code, message) => { throw new IntakeError(code, message); };

/** Owner-facing copy for intake refusals and draft states (WORK_ENVELOPE 7.1 and 3.1). `{…}` are filled by the caller. */
export const INTAKE_COPY = Object.freeze({
  ROUTE_NEEDS_GITHUB: 'Issues and pull requests need a GitHub project. Describe the result or use a plan file instead.',
  TRACKING_ISSUE_NEEDED: 'Choose the GitHub issue where AIWorks reports this work.',
  PR_FROM_FORK: "This pull request comes from another repository. AIWorks never pushes to another repository, so it can't continue it.",
  PR_CLOSED: 'This pull request is closed, so there is nothing to continue.',
  NOT_AN_ISSUE: 'That number is a pull request. Use Continue a PR instead.',
  NOT_FOUND: "AIWorks couldn't find {what} in {project}.",
  PLAN_FILE_NOT_FOUND: "There's no file {path} in {project} at {sha7}.",
  GITHUB_UNKNOWN: "GitHub can't be reached, so AIWorks can't read {what} yet. It will try again.",
  BASE_UNKNOWN: "AIWorks couldn't read the latest version of {project}. It will try again.",
  RECEIVED: 'AIWorks has received this request and has not started drafting a plan yet. Nothing changes yet.',
  DRAFTING: 'AIWorks is reading {project} and drafting a plan. Nothing changes yet.',
  DRAFT_READY: "Here's what AIWorks would do, what it may change and how it will be checked.",
  PLAN_ONLY_READY: 'This plan changes nothing. You can start it while {project} stays at {sha7}.',
  DRAFT_FAILED: "AIWorks couldn't draft a plan: {reason}.",
  DRAFT_STALE: '{project} changed since this plan was drafted ({what}). Draft it again before approving.',
  CONFLICT: '"{campaign}" is already doing {task}. Approve anyway and this step will wait for it, or remove the step.',
  LOCAL_START_OFF: 'You can plan work here. Starting work on projects without GitHub waits for two approvals (D2 and D4).',
});

const liveProject = (store, projectId) => {
  const found = typeof projectId === 'string' ? readProject(store, projectId) : null;
  if (!found || found.disconnected_at != null) refuse('PROJECT_NOT_FOUND', 'That project is not connected.');
  return found;
};

/**
 * Owner action: store one work request with an idempotent request id (WORK_ENVELOPE 3.2 step 1), exactly as owner messages
 * are stored. Nothing is dispatched here. Returns the receipt; an exact retry returns the earlier one.
 * input: { projectId, route, text, reference, trackingIssue, planOnly, requestId }.
 */
export function submitWorkRequest(store, input, now = Date.now()) {
  const { projectId, route, requestId } = input ?? {};
  const planOnly = input?.planOnly ?? false;
  if (!UUID.test(requestId ?? '')) refuse('INVALID_REQUEST', 'requestId must be a UUID.');
  if (!INTAKE_ROUTES.includes(route)) refuse('INVALID_REQUEST', `route must be one of ${INTAKE_ROUTES.join(', ')}.`);
  if (typeof planOnly !== 'boolean') refuse('INVALID_REQUEST', 'planOnly must be true or false.');
  const note = input.text ?? null;
  if (route === 'goal' ? !text(note, 4000) : note !== null && !text(note, 4000)) {
    refuse('INVALID_REQUEST', route === 'goal' ? 'Describe the result in 1 to 4000 printable characters.' : 'A note needs 1 to 4000 printable characters.');
  }
  let reference = null;
  if (GITHUB_ROUTES.includes(route)) {
    if (!int(input.reference)) refuse('INVALID_REQUEST', `Choose the ${route === 'pr' ? 'pull request' : 'issue'} by its number.`);
    reference = String(input.reference);
  } else if (route === 'plan-file') {
    if (!safePath(input.reference) || secretLike.test(input.reference)) {
      refuse('INVALID_REQUEST', 'A plan file is a path inside the project, and never a secret file.');
    }
    reference = input.reference;
  } else if (input.reference != null) refuse('INVALID_REQUEST', 'A described result has no reference.');
  const target = liveProject(store, projectId);
  const github = target.source_kind === 'github';
  if (!github && GITHUB_ROUTES.includes(route)) refuse('ROUTE_NEEDS_GITHUB', INTAKE_COPY.ROUTE_NEEDS_GITHUB);
  // Every campaign and task still needs a GitHub issue to report to: campaign.mjs has not relaxed target.trackingIssue
  // for version 2 yet. An issue or PR request reports to itself; a goal or plan file on GitHub names its issue.
  let tracking = input.trackingIssue ?? null;
  if (!github && tracking !== null) refuse('INVALID_REQUEST', 'A project without GitHub has no issues.');
  if (github && tracking === null) tracking = GITHUB_ROUTES.includes(route) ? Number(reference) : null;
  if (github && !int(tracking)) refuse('TRACKING_ISSUE_NEEDED', INTAKE_COPY.TRACKING_ISSUE_NEEDED);
  return store.tx(() => {
    const previous = store.get('SELECT * FROM work_requests WHERE request_id = ?', requestId);
    if (previous) {
      const same = previous.project_id === projectId && previous.route === route && previous.text === note &&
        previous.reference === reference && previous.tracking_issue === tracking && Boolean(previous.plan_only) === planOnly;
      if (!same) refuse('CONFLICT', 'That request id was already used for a different request.');
      return { ...requestReceipt(previous), duplicate: true };
    }
    if (store.get("SELECT COUNT(*) AS n FROM work_requests WHERE state = 'received'").n >= MAX_WAITING) {
      refuse('CONFLICT', 'Ten requests are already waiting to be planned.');
    }
    store.run(`INSERT INTO work_requests (request_id, project_id, route, text, reference, tracking_issue, plan_only, state,
      received_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
    requestId, projectId, route, note, reference, tracking, planOnly ? 1 : 0, now, now);
    store.journal(null, 'work-request-received', { requestId, projectId, route, planOnly }, now);
    return { ...requestReceipt(store.get('SELECT * FROM work_requests WHERE request_id = ?', requestId)), duplicate: false };
  });
}

const requestReceipt = (row) => ({ requestId: row.request_id, projectId: row.project_id, route: row.route,
  planOnly: Boolean(row.plan_only), state: row.state, receivedAt: row.received_at });

/** One request by id, or null. */
export const workRequest = (store, requestId) => store.get('SELECT * FROM work_requests WHERE request_id = ?', requestId);

const run = (command, args, options) => gitExec(command, args, { timeoutMs: 60_000, ...options });
const ghRead = (gh, path) => {
  const out = run(gh, ['api', '--method', 'GET', path]);
  if (out.ok) {
    try { return { value: JSON.parse(out.stdout) }; } catch { return { unknown: true }; }
  }
  return /HTTP 404/.test(out.stderr) ? { missing: true } : { unknown: true };
};

/** Where a project's source is read for planning: its own checkout for GitHub, the managed mirror otherwise. */
export function sourceRepository(found) {
  if (found.source_kind === 'github') return found.root_path;
  if (!found.mirror_root) return null;
  return join(found.mirror_root, found.source_kind === 'folder' ? SNAPSHOT_DIR : MIRROR_REPO);
}

/**
 * The evidence code gathers before the coordinator runs (WORK_ENVELOPE 3.2 step 2): the base revision, and the issue,
 * PR or plan file pinned at it. Issue, PR and file text is untrusted data for the prompt. A project without GitHub is
 * never read through gh. Returns { ok, pinned, evidence, repository } or { ok: false, code, retry, detail }.
 * `git` and `gh` are command lines (arrays).
 * `selfHosting` is the config.json setting (self-hosting.mjs selfHostingSettings); absent, every base and issue is read
 * as today. With local main trusted, the self-hosted repository's issue route reads its item from the local work list.
 */
export function pinRequest(store, request, { git = ['git'], gh = ['gh'], selfHosting = null } = {}) {
  const found = readProject(store, request.project_id);
  if (!found || found.disconnected_at != null) return { ok: false, code: 'PROJECT_NOT_FOUND', retry: false };
  const repository = sourceRepository(found);
  let base = null;
  const pinned = {};
  if (found.source_kind === 'github' && trustsLocalMain(selfHosting, found.github_repository)) {
    // The self-hosted repository pins its base from local refs and the main ledger (LOCAL_OPERATION.md 4.2): no remote.
    const tip = found.base_branch === 'main' ? trustedTip(store, { git, repoPath: repository, repository: found.github_repository }) : null;
    base = tip ? (tip.state === 'TRUSTED' ? tip.tip : null)
      : run(git, ['rev-parse', '--verify', '--quiet', `refs/heads/${found.base_branch}^{commit}`], { cwd: repository }).stdout;
  } else if (found.source_kind === 'github') {
    const ref = `refs/aiworks/base/${found.base_branch}`;
    const fetched = run(git, ['fetch', '--quiet', 'origin', `+refs/heads/${found.base_branch}:${ref}`], { cwd: repository });
    base = fetched.ok ? run(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repository }).stdout : null;
  } else {
    const baseline = found.current_baseline;
    base = baseline?.commit ?? null;
    if (Number.isSafeInteger(baseline?.seq)) pinned.baselineSeq = baseline.seq;
  }
  if (!SHA.test(base ?? '')) return { ok: false, code: 'BASE_UNKNOWN', retry: true };
  pinned.base = base;
  const evidence = {};
  const repo = found.github_repository;
  if (request.route === 'issue' && found.source_kind === 'github' && trustsLocalMain(selfHosting, repo)) {
    // The self-hosted repository's issues are items of the local work list (LOCAL_OPERATION.md 5.1): read from the store.
    const listed = workItem(store, Number(request.reference));
    if (!listed) return { ok: false, code: 'NOT_FOUND', retry: false, detail: { what: `work item #${request.reference}` } };
    pinned.issueUpdatedAt = String(listed.updated_at);
    Object.assign(evidence, { title: listed.title, body: listed.body });
  } else if (request.route === 'issue') {
    const read = ghRead(gh, `repos/${repo}/issues/${request.reference}`);
    if (read.unknown) return { ok: false, code: 'GITHUB_UNKNOWN', retry: true, detail: { what: `issue #${request.reference}` } };
    if (read.missing) return { ok: false, code: 'NOT_FOUND', retry: false, detail: { what: `issue #${request.reference}` } };
    if (read.value.pull_request) return { ok: false, code: 'NOT_AN_ISSUE', retry: false };
    pinned.issueUpdatedAt = String(read.value.updated_at ?? '');
    Object.assign(evidence, { title: String(read.value.title ?? ''), body: String(read.value.body ?? '') });
  } else if (request.route === 'pr') {
    const read = ghRead(gh, `repos/${repo}/pulls/${request.reference}`);
    if (read.unknown) return { ok: false, code: 'GITHUB_UNKNOWN', retry: true, detail: { what: `pull request #${request.reference}` } };
    if (read.missing) return { ok: false, code: 'NOT_FOUND', retry: false, detail: { what: `pull request #${request.reference}` } };
    const pr = read.value;
    // AIWorks never pushes to another repository, so a PR whose head lives in a fork cannot be continued.
    if (String(pr.head?.repo?.full_name ?? '').toLowerCase() !== repo.toLowerCase()) return { ok: false, code: 'PR_FROM_FORK', retry: false };
    if (pr.state !== 'open') return { ok: false, code: 'PR_CLOSED', retry: false };
    if (!SHA.test(pr.head?.sha ?? '')) return { ok: false, code: 'GITHUB_UNKNOWN', retry: true, detail: { what: `pull request #${request.reference}` } };
    Object.assign(pinned, { headSha: pr.head.sha, headRef: String(pr.head.ref ?? '') });
    Object.assign(evidence, { title: String(pr.title ?? ''), body: String(pr.body ?? '') });
  } else if (request.route === 'plan-file') {
    const blob = run(git, ['rev-parse', '--verify', '--quiet', `${base}:${request.reference}`], { cwd: repository }).stdout;
    const kind = SHA.test(blob ?? '') ? run(git, ['cat-file', '-t', blob], { cwd: repository }).stdout : '';
    if (kind !== 'blob') return { ok: false, code: 'PLAN_FILE_NOT_FOUND', retry: false, detail: { path: request.reference, sha7: base.slice(0, 7) } };
    Object.assign(pinned, { path: request.reference, blob });
    evidence.file = run(git, ['cat-file', 'blob', blob], { cwd: repository }).stdout;
  }
  return { ok: true, pinned, evidence, repository };
}

const PIN_WHAT = [['base', 'a new version of the project'], ['baselineSeq', 'a new local baseline'],
  ['issueUpdatedAt', 'the issue was edited'], ['headSha', 'the pull request has new commits'], ['blob', 'the plan file changed']];

const GONE = { PR_CLOSED: 'the pull request was closed', PR_FROM_FORK: 'the pull request moved to another repository',
  PLAN_FILE_NOT_FOUND: 'the plan file was removed', NOT_FOUND: 'the issue or pull request was removed', PROJECT_NOT_FOUND: 'the project was disconnected' };

/** What changed between a draft's pinned versions and the current ones (WORK_ENVELOPE 3.2 step 8); [] when fresh. */
export function staleWhat(pinned, current) {
  return PIN_WHAT.filter(([key]) => pinned[key] !== undefined && pinned[key] !== current?.[key]).map(([, what]) => what);
}

/**
 * Pin the request again and mark its newest draft stale when any pinned version moved. A stale draft cannot be approved;
 * the owner gets Plan again. Returns { stale, what } or { stale: null, code } when the current versions are unknown.
 */
export function checkDraftFreshness(store, requestId, options = {}, now = Date.now()) {
  const draft = latestDraft(store, requestId);
  if (!draft) return { stale: null, code: 'NO_DRAFT' };
  if (draft.state === 'stale') return { stale: true, what: draft.stale_what };
  const current = pinRequest(store, workRequest(store, requestId), options);
  // A fork, a closed PR or a removed plan file is a change too; an unreachable GitHub is unknown, never fresh.
  if (!current.ok && current.retry) return { stale: null, code: current.code };
  const what = current.ok ? staleWhat(draft.pinned, current.pinned) : [GONE[current.code] ?? 'the source is no longer available'];
  if (!what.length) return { stale: false, what };
  store.tx(() => {
    store.run("UPDATE work_drafts SET state = 'stale', stale_what = ?, updated_at = ? WHERE request_id = ? AND version = ? AND state = 'draft'",
      what, now, requestId, draft.version);
    store.journal(null, 'work-draft-stale', { requestId, version: draft.version, what }, now);
  });
  return { stale: true, what };
}

const ROOTLIKE = /^(?:\.|\.\/|\/|)$/;
const WILDCARD = /[*?[\]{}]/;
const TASK_FIELDS = ['id', 'title', 'outcome', 'goal', 'acceptance', 'references', 'deliverable', 'writes', 'dependsOn',
  'requiresMergedDependencies', 'constraints', 'workKey'];
const PROPOSAL_FIELDS = ['purpose', 'outcome', 'acceptance', 'writes', 'denyWrites', 'deliverables', 'planning', 'constraints', 'tasks'];

/** Write entries a draft may hold: never the whole repository or a pattern, which issue text could ask for. */
function scopedWrites(list, where, notes) {
  if (!Array.isArray(list)) return list;
  const kept = [];
  for (const entry of list) {
    if (typeof entry === 'string' && (ROOTLIKE.test(entry.trim()) || WILDCARD.test(entry))) notes.push(`${where}: removed "${entry}"; a plan may change only named folders or files`);
    else kept.push(entry);
  }
  return kept;
}

/**
 * The draft declaration (WORK_ENVELOPE 3.2 step 4 and 4.1). The coordinator proposes only the outcome, checks, steps and
 * file scope. Code sets everything that decides power or destination: the target from the project record, the request
 * and its pinned versions, the providers (DRAFT_EXECUTOR, or the owner's), review-only release and the report issue.
 * Limits are left out (AW-002); the owner sets them on Review. Returns { declaration, notes }: notes name what the
 * proposal asked for and did not get.
 */
export function draftDeclaration({ request, project: found, pinned, proposal, executor = DRAFT_EXECUTOR, environment = 'development', now = Date.now() }) {
  const notes = [];
  const p = plainObject(proposal) ? proposal : {};
  const ignored = Object.keys(p).filter((key) => !PROPOSAL_FIELDS.includes(key));
  if (ignored.length) notes.push(`ignored ${ignored.sort().join(', ')}: providers, permissions, limits, release and destination are set only on Review`);
  const github = found.source_kind === 'github';
  const tracking = request.tracking_issue;
  const tasks = (Array.isArray(p.tasks) ? p.tasks : []).map((task, index) => {
    if (!plainObject(task)) return task;
    const dropped = Object.keys(task).filter((key) => !TASK_FIELDS.includes(key));
    if (dropped.length) notes.push(`tasks[${index}]: ignored ${dropped.sort().join(', ')}`);
    const kept = Object.fromEntries(TASK_FIELDS.filter((key) => task[key] !== undefined).map((key) => [key, task[key]]));
    if (kept.writes !== undefined) kept.writes = scopedWrites(kept.writes, `tasks[${index}].writes`, notes);
    return github ? { ...kept, issue: tracking } : kept;
  });
  const repo = found.github_repository;
  const reference = !github ? null
    : request.route === 'issue' ? `https://github.com/${repo}/issues/${request.reference}`
      : request.route === 'pr' ? `https://github.com/${repo}/pull/${request.reference}`
        : `https://github.com/${repo}/issues/${tracking}`;
  const target = github
    ? { tenantId: found.tenant_id, projectId: found.governance?.entryId ?? found.id, environment, repository: repo, baseBranch: found.base_branch, trackingIssue: tracking }
    // A local plan names its project by the `lp-` id of the rules the owner confirms for it (dashboard projects.mjs), is
    // for the local environment and is fixed (campaign.mjs validateLocalTarget): local admission binds those rules.
    : { tenantId: found.tenant_id, projectId: `lp-${found.id}`.slice(0, 42), environment: 'local', source: found.source_kind, baseline: { seq: pinned.baselineSeq, commit: pinned.base } };
  if (!github && p.planning !== undefined && p.planning !== 'fixed') notes.push('planning: a plan for a project without GitHub is fixed');
  const envelopePins = { base: pinned.base,
    ...(request.route === 'issue' ? { issueUpdatedAt: pinned.issueUpdatedAt } : {}),
    ...(request.route === 'pr' ? { headSha: pinned.headSha } : {}),
    ...(request.route === 'plan-file' ? { path: pinned.path, blob: pinned.blob } : {}) };
  const outcome = p.outcome;
  const declaration = {
    version: 2,
    campaignId: `${found.id}-intake-${request.request_id.slice(0, 8).toLowerCase()}`,
    ...(p.purpose !== undefined ? { purpose: p.purpose } : {}),
    authorization: { version: 1, grantedBy: 'owner', grantedAt: new Date(now).toISOString().slice(0, 10),
      reference: reference ?? `aiworks-local:${request.request_id}`,
      text: `Approved in the AIWorks dashboard: ${typeof outcome === 'string' ? outcome : ''}`.slice(0, 2000) },
    target,
    executor: structuredClone(executor),
    constraints: p.constraints,
    envelope: {
      scopeVersion: 1,
      request: { route: request.route, ...(request.reference !== null ? { reference: request.route === 'plan-file' ? request.reference : `${repo}#${request.reference}` } : {}), pinned: envelopePins },
      outcome,
      acceptance: p.acceptance,
      writes: scopedWrites(p.writes, 'writes', notes),
      ...(p.denyWrites !== undefined ? { denyWrites: p.denyWrites } : {}),
      deliverables: p.deliverables,
      issues: github ? [tracking] : [],
      web: null,
      release: { mode: 'review-only' },
      planning: github ? p.planning ?? 'adaptive' : 'fixed',
    },
    tasks,
  };
  return { declaration, notes };
}

/**
 * Validate a draft declaration with the registration rules. A plan for a project without GitHub is checked as the local
 * plan it is (local admission is on since STA17): the owner's approval in the dashboard registers exactly this plan.
 */
export function checkDraft(declaration) {
  validateDeclaration(declaration);
  return { startCode: null };
}

/**
 * Overlapping work, computed by code (WORK_ENVELOPE 3.2 step 6): the same commit task already owned (#5 scope A) and
 * write domains another campaign holds. The coordinator may explain a conflict; it never decides one. A project without
 * GitHub has no campaigns yet, so none.
 */
export function draftConflicts(store, declaration) {
  if (typeof declaration?.target?.repository !== 'string') return [];
  const conflicts = [];
  const duplicate = findWorkConflict(store, declaration);
  if (duplicate) conflicts.push({ code: 'DUPLICATE_WORK', taskId: duplicate.taskId, campaignId: duplicate.campaignId, ownerTaskId: duplicate.ownerTaskId });
  for (const task of declaration.tasks) {
    for (const holder of domainHolders(store, { campaignId: declaration.campaignId, taskId: task.id, domain: domainOf(declaration, task) })) {
      conflicts.push({ code: 'WRITE_OVERLAP', taskId: task.id, campaignId: holder.campaignId, ownerTaskId: holder.taskId, reason: holder.reason });
    }
  }
  return conflicts;
}

const stringList = (value, maxItems, max) => Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === 'string' && item.length <= max);

/**
 * Store a valid draft as the request's next version (WORK_ENVELOPE 3.2 step 5) and mark the request drafted. Throws
 * IntakeError DRAFT_INVALID (with the validation message) or DRAFT_WITHHELD (credential-like text); the caller retries
 * once and then reports AIWorks couldn't draft a plan. Writes only work_drafts, work_requests and the journal.
 */
export function recordDraft(store, { request, proposal, pinned, runId = null, executor, environment, now = Date.now() }) {
  const found = readProject(store, request.project_id);
  if (!found || found.disconnected_at != null) refuse('PROJECT_NOT_FOUND', 'That project is not connected.');
  if (!plainObject(proposal) || !text(proposal.summary, 2000) || typeof proposal.plan !== 'string' || proposal.plan.length > 20000 ||
      !Array.isArray(proposal.steps) || proposal.steps.length > 32 || !stringList(proposal.questions, 16, 1000)) {
    refuse('DRAFT_INVALID', 'the draft is missing its summary, plan, steps or questions');
  }
  const { declaration, notes } = draftDeclaration({ request, project: found, pinned, proposal: proposal.declaration, executor, environment, now });
  let startCode;
  try { ({ startCode } = checkDraft(declaration)); } catch (error) { refuse('DRAFT_INVALID', error.message); }
  const outline = proposedOutline(proposal.outline, declaration.envelope.acceptance.length, notes);
  if (containsSecret(JSON.stringify([declaration, proposal.summary, proposal.plan, proposal.steps, proposal.questions, outline]))) {
    refuse('DRAFT_WITHHELD', 'the draft contained something that looks like a credential, so it was not kept');
  }
  return store.tx(() => {
    const conflicts = draftConflicts(store, declaration);
    const version = (store.get('SELECT MAX(version) AS v FROM work_drafts WHERE request_id = ?', request.request_id).v ?? 0) + 1;
    store.insert('work_drafts', { request_id: request.request_id, version, project_id: request.project_id, plan_only: request.plan_only,
      state: 'draft', declaration, scope_digest: scopeDigest(declaration), authority_digest: authorityDigest(declaration), pinned,
      summary: proposal.summary, plan: proposal.plan, steps: proposal.steps, questions: proposal.questions, conflicts, notes,
      start_code: startCode, stale_what: null, run_id: runId, outline, created_at: now, updated_at: now });
    store.run("UPDATE work_requests SET state = 'drafted', failure = NULL, not_before = NULL, updated_at = ? WHERE request_id = ?", now, request.request_id);
    store.journal(null, 'work-draft-recorded', { requestId: request.request_id, version, planOnly: Boolean(request.plan_only),
      conflicts: conflicts.length, startCode }, now);
    return latestDraft(store, request.request_id);
  });
}

// The plan in the owner's terms (OWNER_UI_V2 sections 3 and 8, WP3). The outcome and the done-when criteria are the
// declaration's envelope.outcome and envelope.acceptance, so the authority digest covers them. The outline beside them
// holds what decides no power: Now, Next or Later, the priority, how each criterion is checked, what is included and
// what waits for later, and an estimate. An estimate nobody made stays null and reads "No estimate"; it is never zero.
export const HORIZONS = Object.freeze(['now', 'next', 'later']);
export const PRIORITIES = Object.freeze(['high', 'normal', 'low']);
export const ESTIMATE_UNITS = Object.freeze(['hours', 'days']);
const LIST_ITEMS = 16, ITEM_MAX = 300, CHECK_MAX = 300;
const textList = (value) => Array.isArray(value) && value.length <= LIST_ITEMS && value.every((item) => text(item, ITEM_MAX));
const estimateValue = (value) => value === null || plainObject(value) && Object.keys(value).sort().join(',') === 'amount,unit' &&
  typeof value.amount === 'number' && Number.isFinite(value.amount) && value.amount > 0 && value.amount <= 1000 && ESTIMATE_UNITS.includes(value.unit);
const checkValue = (value) => value === null || text(value, CHECK_MAX);

/** The outline a draft from before WP3 reads as: Now, normal priority, no check methods, nothing listed, no estimate. */
export const blankOutline = (criteria) => ({ horizon: 'now', priority: 'normal', checks: Array(criteria).fill(null), included: [], later: [], estimate: null });

/**
 * The outline of a new draft: the coordinator may propose how each criterion is checked, what is included and later,
 * and an estimate (coordinator.mjs INTAKE_SCHEMA `outline`). Now, Next or Later and the priority are the owner's, so a
 * draft starts in Now at normal priority. A part that does not fit is left out and named in the notes.
 */
function proposedOutline(proposal, criteria, notes) {
  const outline = blankOutline(criteria);
  if (proposal === undefined) return outline;
  if (!plainObject(proposal)) { notes.push('outline: ignored, it is not an object'); return outline; }
  if (proposal.checks !== undefined) {
    if (Array.isArray(proposal.checks) && proposal.checks.length === criteria && proposal.checks.every(checkValue)) outline.checks = [...proposal.checks];
    else notes.push('outline.checks: ignored, it needs one check method or null per criterion');
  }
  for (const key of ['included', 'later']) {
    if (proposal[key] === undefined) continue;
    if (textList(proposal[key])) outline[key] = [...proposal[key]];
    else notes.push(`outline.${key}: ignored, it needs up to ${LIST_ITEMS} short items`);
  }
  if (proposal.estimate !== undefined) {
    if (estimateValue(proposal.estimate)) outline.estimate = proposal.estimate && { amount: proposal.estimate.amount, unit: proposal.estimate.unit };
    else notes.push('outline.estimate: ignored, so this plan has no estimate');
  }
  const ignored = Object.keys(proposal).filter((key) => !['checks', 'included', 'later', 'estimate'].includes(key));
  if (ignored.length) notes.push(`outline: ignored ${ignored.sort().join(', ')}`);
  return outline;
}

/** A draft's outline; a draft recorded before outlines existed reads as blankOutline. */
export const draftOutline = (draft) => plainObject(draft?.outline) ? draft.outline : blankOutline(draft?.declaration?.envelope?.acceptance?.length ?? 0);

/** A draft's done-when criteria, each with how it is checked (null: not stated). */
export const draftCriteria = (draft) => {
  const checks = draftOutline(draft).checks ?? [];
  return (draft?.declaration?.envelope?.acceptance ?? []).map((criterion, index) => ({ text: criterion, check: checks[index] ?? null }));
};

const EDIT_KEYS = ['outcome', 'criteria', 'included', 'later', 'horizon', 'priority', 'estimate'];

/**
 * The owner's edit of a plan, validated whole: { outcome, criteria: [{ text, check }], included, later, horizon,
 * priority, estimate }. Only these parts are edited here. What the work may change, the protected paths, the providers,
 * limits, release mode and the target are the reviewed plan's, kept byte for byte: asking to change one is refused
 * (SCOPE_NOT_EDITABLE), never applied. A wider scope, more budget or another release needs a new plan.
 */
export function planEdit(edits) {
  if (!plainObject(edits)) refuse('INVALID_EDIT', 'An edit is an object.');
  const other = Object.keys(edits).filter((key) => !EDIT_KEYS.includes(key));
  if (other.length) refuse('SCOPE_NOT_EDITABLE', 'Only the goal, done-when criteria, included and later, Now, Next or Later, priority and estimate are edited here. What the work may change, protected areas, limits and release need a new plan.');
  const missing = EDIT_KEYS.filter((key) => edits[key] === undefined);
  if (missing.length) refuse('INVALID_EDIT', `The edit is missing ${missing.join(', ')}.`);
  const outcome = typeof edits.outcome === 'string' ? edits.outcome.trim() : null;
  if (!text(outcome, 300)) refuse('INVALID_EDIT', 'Describe the result in 1 to 300 characters.');
  const criteria = edits.criteria;
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > LIST_ITEMS) refuse('INVALID_EDIT', `A plan has 1 to ${LIST_ITEMS} done-when criteria.`);
  const cleaned = criteria.map((item) => {
    if (!plainObject(item) || Object.keys(item).some((key) => !['text', 'check'].includes(key))) refuse('INVALID_EDIT', 'Each criterion is { text, check }.');
    const criterion = typeof item.text === 'string' ? item.text.trim() : null, check = typeof item.check === 'string' ? item.check.trim() || null : item.check ?? null;
    if (!text(criterion, ITEM_MAX)) refuse('INVALID_EDIT', `Each criterion needs 1 to ${ITEM_MAX} characters.`);
    if (!checkValue(check)) refuse('INVALID_EDIT', `A check method has up to ${CHECK_MAX} characters.`);
    return { text: criterion, check };
  });
  if (new Set(cleaned.map((item) => item.text)).size !== cleaned.length) refuse('INVALID_EDIT', 'Two criteria say the same thing.');
  const lists = Object.fromEntries(['included', 'later'].map((key) => {
    const items = Array.isArray(edits[key]) ? edits[key].map((item) => (typeof item === 'string' ? item.trim() : item)) : null;
    if (!textList(items)) refuse('INVALID_EDIT', `${key === 'included' ? 'Included' : 'Later'} has up to ${LIST_ITEMS} items of 1 to ${ITEM_MAX} characters.`);
    return [key, items];
  }));
  if (!HORIZONS.includes(edits.horizon)) refuse('INVALID_EDIT', 'Choose Now, Next or Later.');
  if (!PRIORITIES.includes(edits.priority)) refuse('INVALID_EDIT', 'Choose high, normal or low priority.');
  if (!estimateValue(edits.estimate)) refuse('INVALID_EDIT', 'An estimate is a number of hours or days up to 1,000, or no estimate.');
  return { outcome, criteria: cleaned, outline: { horizon: edits.horizon, priority: edits.priority, checks: cleaned.map((item) => item.check),
    included: lists.included, later: lists.later, estimate: edits.estimate && { amount: edits.estimate.amount, unit: edits.estimate.unit } } };
}

/** Whether any approval of this plan was recorded: a GitHub plan's in the private store, a local plan's in its ledger. */
const approvalRecorded = (store, campaignId) => approvedDeclarations(store, campaignId).length > 0 || localApprovals(store, campaignId).length > 0;

/**
 * Owner action: save an edited plan as the request's next draft version (OWNER_UI_V2 WP3). Bound to the version and
 * authority digest the owner edited: a plan that changed meanwhile (PLAN_CHANGED), is out of date (DRAFT_STALE), or
 * was already approved or started (ALREADY_APPROVED) is refused with nothing written. The new version keeps the
 * reviewed plan's pins, scope, protected paths, providers, limits and release; it is a draft like any other, so only
 * Approve and start of exactly that version starts it, and an approval of an earlier version never does. `editId` makes
 * a repeat safe: the same edit sent twice is saved once and answered with the version it made.
 * input: { requestId, version, authorityDigest, editId, edits }. Returns { draft, duplicate }.
 */
export function reviseDraft(store, input, now = Date.now()) {
  const { requestId, version, authorityDigest: reviewed, editId } = input ?? {};
  if (!UUID.test(requestId ?? '') || !UUID.test(editId ?? '') || !Number.isSafeInteger(version) || version < 1 || !/^[0-9a-f]{64}$/.test(reviewed ?? '')) {
    refuse('INVALID_REQUEST', 'An edit names the plan, its version and fingerprint, and its own edit id.');
  }
  const edit = planEdit(input.edits);
  return store.tx(() => {
    const earlier = store.get('SELECT * FROM work_drafts WHERE edit_request_id = ?', editId);
    if (earlier) {
      const same = earlier.request_id === requestId && earlier.edited_from === version && earlier.declaration.envelope.outcome === edit.outcome &&
        JSON.stringify(earlier.declaration.envelope.acceptance) === JSON.stringify(edit.criteria.map((item) => item.text)) &&
        JSON.stringify(earlier.outline) === JSON.stringify(edit.outline);
      if (!same) refuse('CONFLICT', 'That edit id was already used for a different edit.');
      return { draft: earlier, duplicate: true };
    }
    const draft = latestDraft(store, requestId);
    if (!draft) refuse('NOT_FOUND', 'There is no such plan.');
    const found = readProject(store, draft.project_id);
    if (!found || found.disconnected_at != null) refuse('PROJECT_NOT_FOUND', 'That project is not connected.');
    if (draft.version !== version || draft.authority_digest !== reviewed || authorityDigest(draft.declaration) !== reviewed) {
      refuse('PLAN_CHANGED', 'This plan changed since you started editing it.');
    }
    const campaignId = draft.declaration?.campaignId;
    if (store.campaign(campaignId) || approvalRecorded(store, campaignId)) refuse('ALREADY_APPROVED', 'This plan was already approved, so it is not edited. Ask for a new plan to change it.');
    if (draft.state === 'stale') refuse('DRAFT_STALE', 'This plan is out of date. Draft it again before editing it.');
    if (draft.state !== 'draft') refuse('NOT_READY', 'This plan is not ready to edit.');
    const declaration = structuredClone(draft.declaration);
    declaration.envelope.outcome = edit.outcome;
    declaration.envelope.acceptance = edit.criteria.map((item) => item.text);
    declaration.authorization.text = `Approved in the AIWorks dashboard: ${edit.outcome}`.slice(0, 2000);
    try { checkDraft(declaration); } catch (error) { refuse('DRAFT_INVALID', error.message); }
    if (containsSecret(JSON.stringify([declaration.envelope.outcome, declaration.envelope.acceptance, edit.outline]))) {
      refuse('DRAFT_WITHHELD', 'The edit contains something that looks like a credential, so it was not kept.');
    }
    const next = draft.version + 1;
    store.insert('work_drafts', { request_id: requestId, version: next, project_id: draft.project_id, plan_only: draft.plan_only, state: 'draft',
      declaration, scope_digest: scopeDigest(declaration), authority_digest: authorityDigest(declaration), pinned: draft.pinned,
      summary: draft.summary, plan: draft.plan, steps: draft.steps, questions: draft.questions, conflicts: draftConflicts(store, declaration),
      notes: draft.notes, start_code: draft.start_code, stale_what: null, run_id: draft.run_id, outline: edit.outline, edit_request_id: editId,
      edited_from: draft.version, created_at: now, updated_at: now });
    store.journal(null, 'work-draft-edited', { requestId, version: next, from: draft.version }, now);
    return { draft: latestDraft(store, requestId), duplicate: false };
  });
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What changed from one draft version to another, for Review (OWNER_UI_V2 WP3): the goal, each criterion and how it is
 * checked, included and later items, Now, Next or Later, priority and estimate; and, flagged `scope`, anything that
 * decides power or destination (what may change, protected paths, providers, limits, release, steps and the pinned
 * version), which only a new plan from AIWorks can change. [] when nothing differs.
 */
export function draftChanges(before, after) {
  const changes = [];
  const add = (field, change, values = {}, scope = false) => changes.push({ field, change, ...values, scope });
  const a = before?.declaration?.envelope ?? {}, b = after?.declaration?.envelope ?? {};
  const oa = draftOutline(before), ob = draftOutline(after);
  if (a.outcome !== b.outcome) add('outcome', 'changed', { before: a.outcome ?? null, after: b.outcome ?? null });
  const ca = draftCriteria(before), cb = draftCriteria(after);
  for (const item of cb) {
    const was = ca.find((old) => old.text === item.text);
    if (!was) add('criteria', 'added', { after: item.text, check: item.check });
    else if (was.check !== item.check) add('check', 'changed', { criterion: item.text, before: was.check, after: item.check });
  }
  for (const item of ca) if (!cb.some((now) => now.text === item.text)) add('criteria', 'removed', { before: item.text });
  for (const key of ['included', 'later']) {
    for (const item of ob[key] ?? []) if (!(oa[key] ?? []).includes(item)) add(key, 'added', { after: item });
    for (const item of oa[key] ?? []) if (!(ob[key] ?? []).includes(item)) add(key, 'removed', { before: item });
  }
  for (const key of ['horizon', 'priority', 'estimate']) if (!sameJson(oa[key], ob[key])) add(key, 'changed', { before: oa[key] ?? null, after: ob[key] ?? null });
  const da = before?.declaration ?? {}, db = after?.declaration ?? {};
  const scoped = [['writes', a.writes], ['denyWrites', a.denyWrites], ['deliverables', a.deliverables], ['release', a.release]];
  for (const [key, value] of scoped) if (!sameJson(value, b[key])) add(key, 'changed', {}, true);
  if (!sameJson(da.executor, db.executor)) add('providers', 'changed', {}, true);
  if (!sameJson(da.limits, db.limits)) add('limits', 'changed', {}, true);
  if (!sameJson(da.tasks, db.tasks)) add('steps', 'changed', {}, true);
  if (!sameJson(before?.pinned, after?.pinned)) add('source', 'changed', {}, true);
  return changes;
}

/** A request that could not be drafted: retried later, or failed with its code. */
export function failRequest(store, requestId, { code, retryAt = null, attempts }, now = Date.now()) {
  store.tx(() => {
    store.run('UPDATE work_requests SET state = ?, failure = ?, not_before = ?, attempts = COALESCE(?, attempts), updated_at = ? WHERE request_id = ?',
      retryAt ? 'received' : 'failed', code, retryAt, attempts ?? null, now, requestId);
    store.journal(null, retryAt ? 'work-request-retry' : 'work-request-failed', { requestId, code }, now);
  });
}

/** The newest draft version of a request, or null. */
export const latestDraft = (store, requestId) =>
  store.get('SELECT * FROM work_drafts WHERE request_id = ? ORDER BY version DESC LIMIT 1', requestId);

/** One project's requests and drafts, newest first. A project never sees another project's rows. */
export function projectIntake(store, projectId) {
  return store.all('SELECT * FROM work_requests WHERE project_id = ? ORDER BY id DESC', projectId).map((request) => {
    const draft = latestDraft(store, request.request_id);
    return { request, draft: draft && draft.project_id === projectId ? draft : null, state: intakeState(request, draft) };
  });
}

/** The owner-facing state code of WORK_ENVELOPE 7.1 for a request and its newest draft. */
export function intakeState(request, draft) {
  if (!draft) {
    if (request.state === 'failed') return { code: 'DRAFT_FAILED', reason: request.failure };
    // Waiting for its project budget (coordinator.mjs budgetHold): still to be drafted, with the budget's reason.
    const wait = request.state === 'received' && /^project-budget: /.test(request.failure ?? '') ? request.failure.slice('project-budget: '.length) : null;
    if (wait) return { code: 'RECEIVED', budgetWait: wait };
    // Received, no planning run recorded yet: queued, or waiting to try again after a read that could not draft it
    // (failRequest), by the code of that read and never its reason. Only a recorded coordinator run (state 'drafting') is drafting.
    if (request.state === 'received') return request.not_before ? { code: 'RECEIVED', retryAt: request.not_before, retryCode: String(request.failure ?? '').split(':')[0] || null } : { code: 'RECEIVED' };
    return { code: 'DRAFTING' };
  }
  if (draft.state === 'stale') return { code: 'DRAFT_STALE', what: draft.stale_what };
  if (draft.conflicts?.length) return { code: 'CONFLICT', conflicts: draft.conflicts, startCode: draft.start_code };
  return { code: draft.plan_only ? 'PLAN_ONLY_READY' : 'DRAFT_READY', startCode: draft.start_code };
}
