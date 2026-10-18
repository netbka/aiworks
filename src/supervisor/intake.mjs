// AIWorks intake (docs/design/WORK_ENVELOPE.md section 3, slice E6): the owner asks for work by goal, issue, pull
// request or plan file, or plan only, and gets a draft plan. Code stores the request, pins the exact source versions,
// builds and validates the draft declaration and finds conflicts. The coordinator only proposes the plan's wording,
// steps and file scope (coordinator.mjs, intake mode). A draft is never registered or scheduled: nothing that
// schedules reads work_requests or work_drafts, and turning a draft into work is the owner's approval (slices E7, E8).
import { SECRET_LIKE_PATH_PATTERN } from '../../scripts/lib/worker-context.mjs';
import { authorityDigest, scopeDigest, validateDeclaration } from './campaign.mjs';
import { exec as gitExec } from './adapters/git.mjs';
import { trustedTip, trustsLocalMain } from './self-hosting.mjs';
import { item as workItem } from './work-list.mjs';
import { MIRROR_REPO, SNAPSHOT_DIR } from './adapters/mirror.mjs';
import { containsSecret } from './coordinator.mjs';
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

/** The oldest request ready to be drafted, or null. */
export const nextWorkRequest = (store, now) =>
  store.get("SELECT * FROM work_requests WHERE state = 'received' AND (not_before IS NULL OR not_before <= ?) ORDER BY id LIMIT 1", now);

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
  if (containsSecret(JSON.stringify([declaration, proposal.summary, proposal.plan, proposal.steps, proposal.questions]))) {
    refuse('DRAFT_WITHHELD', 'the draft contained something that looks like a credential, so it was not kept');
  }
  return store.tx(() => {
    const conflicts = draftConflicts(store, declaration);
    const version = (store.get('SELECT MAX(version) AS v FROM work_drafts WHERE request_id = ?', request.request_id).v ?? 0) + 1;
    store.insert('work_drafts', { request_id: request.request_id, version, project_id: request.project_id, plan_only: request.plan_only,
      state: 'draft', declaration, scope_digest: scopeDigest(declaration), authority_digest: authorityDigest(declaration), pinned,
      summary: proposal.summary, plan: proposal.plan, steps: proposal.steps, questions: proposal.questions, conflicts, notes,
      start_code: startCode, stale_what: null, run_id: runId, created_at: now, updated_at: now });
    store.run("UPDATE work_requests SET state = 'drafted', failure = NULL, not_before = NULL, updated_at = ? WHERE request_id = ?", now, request.request_id);
    store.journal(null, 'work-draft-recorded', { requestId: request.request_id, version, planOnly: Boolean(request.plan_only),
      conflicts: conflicts.length, startCode }, now);
    return latestDraft(store, request.request_id);
  });
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
  if (!draft) return request.state === 'failed' ? { code: 'DRAFT_FAILED', reason: request.failure } : { code: 'DRAFTING' };
  if (draft.state === 'stale') return { code: 'DRAFT_STALE', what: draft.stale_what };
  if (draft.conflicts?.length) return { code: 'CONFLICT', conflicts: draft.conflicts, startCode: draft.start_code };
  return { code: draft.plan_only ? 'PLAN_ONLY_READY' : 'DRAFT_READY', startCode: draft.start_code };
}
