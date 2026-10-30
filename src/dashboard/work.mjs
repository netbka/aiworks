// Plan and do, Review and Approve and start for a GitHub project (docs/design/OWNER_WORKSPACE.md S10 and
// docs/design/WORK_ENVELOPE.md E8; plan slice UI14). The owner asks for a plan, reviews the draft AIWorks proposes and
// presses Approve and start. Approving registers exactly the reviewed plan, bound to its authority digest, through the
// same checks as the CLI `approve` and `start --approved` (approved-declarations.mjs, approvals.mjs): merged runtime code
// (AW-005), the project rules, the duplicate-work check and the private store. The dashboard never writes a campaign
// itself; it calls those supervisor APIs.
// A project without GitHub (OWNER_WORKSPACE S12 and §5.3; plan slice UI17) follows the same Plan and do and Review, once
// the owner has confirmed its rules. Approve and start runs the caller check, records the owner's approval of exactly the
// reviewed plan and registers it (local-admission.mjs, decision D4). Its checked results are applied to the owner's folder
// only when the owner presses Apply, and Undo apply is the way back (release/owner-apply.mjs, under Review only, never
// Auto Release). No pull request exists for such a project, and nothing here reaches GitHub or a network service.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../supervisor/store.mjs';
import { CampaignError } from '../supervisor/api.mjs';
import { APPROVAL_SCHEMA } from '../supervisor/approvals.mjs';
import { approvedDeclarations, persistApproved, registerApproved } from '../supervisor/approved-declarations.mjs';
import { assertRegisteredTarget, authorityDigest, scopeDigest } from '../supervisor/campaign.mjs';
import { configuredGovernanceRoot } from '../supervisor/governance.mjs';
import { draftChanges, draftCriteria, draftOutline, INTAKE_COPY, intakeState, IntakeError, latestDraft, pinRequest, reviseDraft, submitWorkRequest,
  workRequest } from '../supervisor/intake.mjs';
import { candidates, isLocalTarget } from '../supervisor/local-candidates.mjs';
import { passedCheck } from '../supervisor/result-review.mjs';
import { checkCaller, localApprovals, recordLocalApproval, registerLocalPlan } from '../supervisor/local-admission.mjs';
import { localStartWork, resolveLocalProject } from '../supervisor/project-connect.mjs';
import { project as readProject, projects as readProjects } from '../supervisor/projects.mjs';
import { ownerApplies, ownerApply, undoOwnerApply } from '../supervisor/release/owner-apply.mjs';
import { CODE_ROOT, revisionNotMerged } from '../supervisor/provenance.mjs';
import { configuredGitCommand } from './merges.mjs';
import { safeText } from './roadmap.mjs';
import { decisionFeedback, decisionView, resultReview } from './supervisor.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const fail = (status, message, { detail = null, code = null } = {}) => Object.assign(new Error(message), { status, ...(detail ? { detail } : {}), ...(code ? { code } : {}) });
const readConfig = (dataDir) => {
  try { const value = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
};
const list = (value, max = 300, items = 32) => (Array.isArray(value) ? value : []).slice(0, items).map((item) => safeText(item, max));

/** The owner's words for Review and Approve and start (WORK_ENVELOPE 7.1, OWNER_WORKSPACE 5.5). `{…}` are filled in. */
export const WORK_COPY = Object.freeze({
  PLAN_CHANGED: 'This plan changed since you opened it. Review it again.',
  DRAFT_STALE: INTAKE_COPY.DRAFT_STALE,
  ALREADY_STARTED: 'This plan has already started. Its work is on Overview.',
  NOT_FOUND: 'This plan is not on this computer. It may belong to another project, or the address is mistyped.',
  NOT_READY: 'This plan is not ready to approve yet.',
  RULES_FIRST: 'Confirm this project’s rules on its Overview first. Then AIWorks can plan and start work here.',
  BASE_UNKNOWN: "AIWorks couldn't read the latest version of {project}, so nothing started. Try again in a minute.",
  START_REFUSED: "AIWorks didn't start this work: {reason}.",
  APPROVED: 'Approved at {time} · waiting for AIWorks to pick it up',
  PLAN_AND_DO_OFF: 'Plan and do is not available for this project. Its plans are drafted only when the AIWorks configuration file on this computer switches planning on, for a connected GitHub project.',
  RELEASE: 'Release: Review only. AIWorks stops when a result passes the check and is published. Merging and release follow this project’s own rules.',
  ALREADY_APPROVED: 'This plan was already approved, so it is not edited. Ask for a new plan to change it.',
  SCOPE_NOT_EDITABLE: 'What the work may change, protected areas, limits and release are not edited here. Ask for a new plan to change them.',
});

/** Why the CLI start refuses, in the owner's words; the machine's reason stays in Details. */
const REFUSAL_WORDS = Object.freeze({
  RUNTIME_NOT_MERGED: 'the AIWorks code on this computer is not merged into its main branch',
  WORK_ALREADY_ASSIGNED: 'another piece of work on this computer already does one of its steps',
  DECLARATION_DIFFERS_FROM_APPROVAL: 'the plan no longer matches what you approved',
  APPROVAL_REVOKED: 'its approval was withdrawn',
  APPROVAL_INVALID: 'its approval record is not valid',
  SCOPE_CONFLICT: 'work with the same name already exists with a different scope',
  PRIVATE_STORE_NOT_IGNORED: 'AIWorks keeps approved plans private, and its work records are in a folder Git would publish',
  PRIVATE_STORE_UNCHECKED: 'AIWorks could not check that its work records stay private',
  GOVERNANCE_ROOT_REQUIRED: 'no project rules are set up on this computer',
  GOVERNANCE_ROOT_INVALID: 'the project rules on this computer cannot be read',
  ROLE_CATALOG_INVALID: 'the project rules on this computer cannot be read',
  NOT_REGISTERED: 'this project is not listed in your project rules',
  INVALID_DECLARATION: 'the plan does not meet the rules every started plan must meet',
  RULES_NONE: 'you haven’t confirmed this project’s rules',
  RULES_REVOKED: 'you revoked this project’s rules',
  RULES_EXPIRED: 'this project’s rules expired; renew them on its Overview',
  BASELINE_UNKNOWN: 'AIWorks no longer has the copy of the project this plan starts from',
  PROJECT_NOT_FOUND: 'the project is not connected',
  OVERLAY_DIFFERS_FROM_APPROVAL: 'the project’s rules changed after you approved this plan',
  CODE_DIFFERS_FROM_APPROVAL: 'AIWorks was updated after you approved this plan',
  APPROVAL_EXPIRED: 'its approval is too old',
  APPROVAL_NONCE_USED: 'its approval was already used once',
  LEDGER_BROKEN: 'AIWorks’s record of your approvals doesn’t add up',
  CODE_REVISION_UNKNOWN: 'AIWorks could not read which version of its code is running',
});

const refused = (code, detail) => fail(409, WORK_COPY.START_REFUSED.replace('{reason}', REFUSAL_WORDS[code] ?? 'it did not pass the checks a start from the command line makes'),
  { detail: `${code}: ${safeText(detail, 600)}`, code: 'START_REFUSED' });

/** Plan and do is on when config.json switches drafting on ("coordinator": { "intake": true }). Read on every request. */
export const planAndDoEnabled = (dataDir) => readConfig(dataDir).coordinator?.intake === true;

const startable = (record) => record.source_kind === 'github' && record.disconnected_at == null && record.status === 'ready' && record.capabilities?.startWork?.allowed === true;
const isLocal = (record) => record.source_kind !== 'github';
/** A project without GitHub can start work once its rules are confirmed and still valid (D2, project-connect.mjs). */
const localStartable = (store, record, governanceRoot) => isLocal(record) && record.disconnected_at == null && record.status === 'ready' &&
  localStartWork(store, record.id, { governanceRoot }).allowed === true;
/** The page addresses a GitHub project by its repository and a project without GitHub by its project id. */
const routeOf = (record) => (isLocal(record) ? record.id : record.github_repository);

/** One draft as Review shows it: only allowlisted fields, every text through safeText. Never a path or raw output. */
function planView(store, record, request, draft, textChecks) {
  const local = isLocal(record);
  const base = { id: request.request_id, project: routeOf(record), local, receivedAt: request.received_at };
  const campaignId = draft?.declaration?.campaignId;
  // A GitHub plan's approval is kept in the private store; a local plan's in the local approval ledger, once admitted.
  const approvedAt = !campaignId ? null : local ? localApprovals(store, campaignId).find((row) => row.admittedAt)?.approvedAt ?? null
    : approvedDeclarations(store, campaignId).find((row) => row.authorityDigest === draft.authority_digest)?.persistedAt ?? null;
  const started = campaignId ? store.campaign(campaignId) : null;
  const state = approvedAt && started ? { code: 'APPROVED' } : intakeState(request, draft);
  const checkText = (value, max) => textChecks?.read(value, max) ?? { state: 'ready', text: safeText(value, max) };
  const planText = draft ? checkText(draft.plan, 8000) : null;
  const summary = draft ? checkText(draft.summary, 2000) : null, goal = draft ? checkText(request.text, 2000) : null;
  const states = [planText, summary, goal].filter(Boolean).map(item => item.state);
  const textCheck = states.includes('unavailable') ? 'unavailable' : states.includes('checking') ? 'checking' : 'ready';
  const startable = ['DRAFT_READY', 'PLAN_ONLY_READY', 'CONFLICT'].includes(state.code) && textCheck === 'ready';
  const view = { ...base, code: state.code, startable, approvedAt,
    failure: state.code === 'DRAFT_FAILED' ? safeText(state.reason, 80) : null, budgetWait: state.budgetWait ? safeText(state.budgetWait, 300) : null, retryAt: Number.isSafeInteger(state.retryAt) ? state.retryAt : null,
    retryCode: /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(state.retryCode ?? '') ? state.retryCode : null, staleWhat: state.code === 'DRAFT_STALE' ? list(state.what, 120, 8) : [] };
  if (!draft) return view;
  const d = draft.declaration, envelope = d.envelope ?? {};
  const providers = (d.executor?.kind === 'cli-chain' ? d.executor.providers : [d.executor]).filter(Boolean)
    .map((provider) => safeText([provider.kind, provider.model].filter(Boolean).join(' '), 80));
  // The model choice beside the providers (intake.mjs draftRouting): automatic among these models, checks on the strongest.
  const routing = d.routing?.mode === 'auto' ? { models: (d.routing.candidates ?? []).slice(0, 16).map((candidate) => safeText(candidate.model, 80)),
    checkTier: Number.isSafeInteger(d.routing.pin?.verifier?.tier) ? d.routing.pin.verifier.tier : null } : null;
  return { ...view, version: draft.version, planOnly: Boolean(draft.plan_only), authorityDigest: draft.authority_digest, fingerprint: draft.authority_digest.slice(0, 12),
    campaignId: safeText(campaignId, 64), summary: summary.text, plan: planText.text, textCheck, outcome: safeText(envelope.outcome, 300),
    acceptance: list(envelope.acceptance), writes: list(envelope.writes, 200, 64), denyWrites: list(envelope.denyWrites, 200, 64),
    deliverables: list(envelope.deliverables, 20, 4), providers, routing, limits: d.limits ? Object.fromEntries(Object.entries(d.limits).filter(([, value]) => Number.isFinite(value))) : null,
    release: 'review-only', steps: (Array.isArray(draft.steps) ? draft.steps : []).slice(0, 32).map((step) => typeof step === 'string' ? { title: safeText(step), check: null }
      : { title: safeText(step?.title ?? step?.outcome ?? ''), check: step?.check ? safeText(step.check) : null }),
    tasks: (Array.isArray(d.tasks) ? d.tasks : []).slice(0, 32).map((task) => ({ id: safeText(task.id, 64), title: safeText(task.outcome ?? task.title ?? task.id), deliverable: safeText(task.deliverable, 20),
      writes: list(task.writes, 200, 32) })),
    questions: list(draft.questions, 1000, 16),
    conflicts: (Array.isArray(draft.conflicts) ? draft.conflicts : []).slice(0, 16).map((item) => ({ code: safeText(item.code, 40), campaignId: safeText(item.campaignId, 64),
      taskId: safeText(item.taskId, 64), ownerTaskId: safeText(item.ownerTaskId, 64) })),
    notes: list(draft.notes, 300, 16),
    // Edit plan is offered on a ready draft only while no approval of it is recorded (intake.mjs reviseDraft refuses it then).
    ...planOutline(store, request, draft, startable && !approvedDeclarations(store, campaignId).length && !localApprovals(store, campaignId).length, goal.text) };
}

const ESTIMATE = (value) => value ? { amount: value.amount, unit: value.unit } : null;
const changeValue = (field, value) => value === null || value === undefined ? null : field === 'estimate' ? ESTIMATE(value) : safeText(value, 300);

/**
 * The plan in the owner's terms (OWNER_UI_V2 WP3): the goal as asked, Now, Next or Later, priority, done-when criteria
 * with how each is checked, included and later, the estimate (null: "No estimate"), and what changed from the version
 * before. `editable` is the server's: a ready draft nobody approved yet.
 */
function planOutline(store, request, draft, editable, goal) {
  const outline = draftOutline(draft);
  const previous = draft.version > 1 ? store.get('SELECT * FROM work_drafts WHERE request_id = ? AND version = ?', request.request_id, draft.version - 1) : null;
  return { goal, horizon: outline.horizon, priority: outline.priority, estimate: ESTIMATE(outline.estimate),
    criteria: draftCriteria(draft).slice(0, 16).map((item) => ({ text: safeText(item.text, 300), check: item.check === null ? null : safeText(item.check, 300) })),
    included: list(outline.included, 300, 16), later: list(outline.later, 300, 16), editable, editedFrom: draft.edited_from ?? null,
    previousVersion: previous ? previous.version : null, versions: planVersions(store, request),
    changes: previous ? draftChanges(previous, draft).slice(0, 48).map((item) => ({ field: item.field, change: item.change, scope: item.scope,
      ...(item.criterion !== undefined ? { criterion: safeText(item.criterion, 300) } : {}), ...(item.check !== undefined ? { check: changeValue('check', item.check) } : {}),
      before: changeValue(item.field, item.before), after: changeValue(item.field, item.after) })) : [] };
}

/**
 * The plan's version history (OWNER_UI_V2 WP3, Plan): every stored draft version of the request, newest first, read from
 * work_drafts and nothing else. Each names who made it (AIWorks drafted it, or the owner's edit of an earlier version),
 * when, its goal and Now, Next or Later, and how many parts changed from the version before.
 */
function planVersions(store, request) {
  const rows = store.all('SELECT * FROM work_drafts WHERE request_id = ? ORDER BY version DESC LIMIT 20', request.request_id);
  return rows.map((row, index) => {
    const before = rows[index + 1]?.version === row.version - 1 ? rows[index + 1] : null, changes = before ? draftChanges(before, row) : null;
    return { version: row.version, at: row.created_at, by: row.edited_from ? 'owner' : 'aiworks', editedFrom: row.edited_from ?? null,
      outcome: safeText(row.declaration?.envelope?.outcome ?? '', 300), horizon: draftOutline(row).horizon,
      changes: changes ? changes.length : null, scopeChanged: Boolean(changes?.some((item) => item.scope)) };
  });
}

/** A step of local work in the owner's words (OWNER_WORKSPACE §2.3): never a pull request or merge state. */
const STEP_WORDS = Object.freeze({ pending: 'Not finished yet', implemented: 'Being checked by an independent checker', verified: 'Passed the check',
  done: 'Passed the check' });

/** One local result as the page shows it, with the owner's next action on it: Apply, Undo apply or none. */
function localResult(candidate, attempt, title, textChecks) {
  const sha7 = candidate.sha.slice(0, 7), outcome = attempt?.outcome ?? null;
  const files = (attempt?.files ?? []).slice(0, 32).map((file) => safeText(typeof file === 'string' ? file : file?.path ?? '', 300));
  const row = { campaignId: candidate.campaignId, taskId: candidate.taskId, seq: candidate.seq, title, deliverable: candidate.deliverable, sha7,
    recordedAt: candidate.recordedAt, applyId: attempt?.applyId ?? null, outcome, files, action: null };
  if (candidate.deliverable !== 'commit') return { ...row, state: 'Report to read', text: textChecks?.read(candidate.report, 4000).text ?? safeText(candidate.report, 4000) };
  if (outcome === 'applied') return { ...row, state: 'Applied to your folder', text: `Your folder now holds the result checked at ${sha7}. Undo apply puts back what was there before.`, action: 'undo' };
  if (outcome === 'stopped') return { ...row, state: 'Stopped midway', text: 'Files changed while AIWorks wrote your folder, so it stopped and kept its backup. Check the files below before you press anything.' };
  if (outcome === 'unknown') return { ...row, state: 'Not known yet', text: 'AIWorks has not settled what happened to your folder yet. It reads the folder again before anything else is written.' };
  const before = outcome === 'rolled-back' ? 'Undone: your folder is back as it was. '
    : outcome === 'refused' ? `Not applied: ${safeText(attempt.reason ?? 'your folder changed', 300)}. ` : '';
  return { ...row, state: 'Ready for your review', text: `${before}Checked at ${sha7}. Nothing in your folder changes until you press Apply.`, action: 'apply' };
}

/**
 * The local work of a project without GitHub: each registered plan, newest first, with its steps and checked results.
 * Read from the store only; a store that never ran local work has none. Never a pull request, issue or merge field.
 */
function localWork(store, record, textChecks, config) {
  let rulesId = null;
  try { rulesId = store.get('SELECT id FROM project_overlays WHERE project_id = ?', record.id)?.id ?? null; } catch { rulesId = null; }
  if (!rulesId) return [];
  return store.all('SELECT id FROM campaigns ORDER BY created_at DESC, id').map(({ id }) => store.campaign(id))
    .filter((c) => isLocalTarget(c.declaration) && c.declaration.target.projectId === rulesId).slice(0, 10).map((c) => {
      const titles = new Map(c.declaration.tasks.map((task) => [task.id, safeText(task.outcome ?? task.title ?? task.id, 300)]));
      const attempts = ownerApplies(store, c.id), found = candidates(store, c.id);
      const results = [...new Set(found.map((row) => row.taskId))].map((taskId) => {
        const latest = found.filter((row) => row.taskId === taskId).at(-1), task = store.task(c.id, taskId);
        // Its criteria with their evidence and Request changes (OWNER_UI_V2 WP4), about this candidate's head only; Apply is its acceptance.
        // The config says whether its preview starts the version's own server (the operator's `previews.servers`).
        const review = task ? resultReview(store, c, task, c.declaration.tasks.find((item) => item.id === taskId), config) : null;
        return { ...localResult(latest, attempts.filter((row) => row.taskId === taskId && row.seq === latest.seq).at(-1), titles.get(taskId) ?? safeText(taskId, 64), textChecks),
          taskVersion: task?.version ?? null, review: review && (review.verifiedSha === latest.sha || review.state === 'changes-requested') ? review : null };
      });
      // A step's open decision (OWNER_UI_V2 WP2) is the same record a GitHub step serves: answered, snoozed or marked as not
      // needed through /api/v2/decisions, bound to this goal's and step's versions. A stop that is no decision says so.
      const feedback = decisionFeedback(store, c.id), now = Date.now();
      return { id: c.id, outcome: safeText(c.declaration.envelope?.outcome ?? c.id, 300), control: c.control,
        version: c.version, authorizationVersion: c.authorization_version, scopeDigest: c.scope_digest,
        steps: store.tasks(c.id).map((task) => {
          const decision = ['registered', 'paused'].includes(c.control) ? decisionView(c.id, task, feedback, now) : null;
          return { id: safeText(task.task_id, 64), title: titles.get(task.task_id) ?? safeText(task.task_id, 64), version: task.version, decision,
            state: decision ? 'Stopped: needs your decision' : c.control === 'cancelled' && task.state !== 'done' ? 'Cancelled'
              : task.blocked ? 'Stopped; it will not retry by itself'
                // Checked, yet not every criterion passed: never "Passed the check" (result-review.mjs passedCheck).
                : ['verified', 'done'].includes(task.state) && !passedCheck(task, c.declaration.tasks.find((item) => item.id === task.task_id)?.acceptance)
                  ? 'Checked; not every criterion passed' : STEP_WORDS[task.state] ?? 'Not known yet' };
        }),
        results };
    });
}

/**
 * Read-only: whether Plan and do is on, the connected projects it can start in (a GitHub project by its repository, a
 * project without GitHub by its id once its rules are confirmed), each of their requests with its newest draft, newest
 * first, and the local work of each project without GitHub. A store without intake tables, or none at all, shows none.
 */
export function workView(dataDir, { textChecks } = {}) {
  const enabled = planAndDoEnabled(dataDir), empty = { planAndDo: enabled, projects: [], plans: [], local: {} };
  const path = join(dataDir, 'supervisor.db');
  if (!existsSync(path)) return empty;
  let store;
  try {
    store = new Store(path, { readOnly: true });
    const governanceRoot = configuredGovernanceRoot(dataDir), config = readConfig(dataDir);
    const records = readProjects(store).filter((record) => !isLocal(record) || record.disconnected_at == null);
    const plans = records.flatMap((record) => store.all('SELECT * FROM work_requests WHERE project_id = ? ORDER BY id DESC LIMIT 20', record.id)
      .map((request) => planView(store, record, request, latestDraft(store, request.request_id), textChecks)));
    const ready = enabled ? records.filter((record) => startable(record) || localStartable(store, record, governanceRoot)).map(routeOf) : [];
    const local = Object.fromEntries(records.filter(isLocal).map((record) => [record.id, localWork(store, record, textChecks, config)]));
    return { planAndDo: enabled, projects: ready, plans, local };
  } catch { return empty; } finally { store?.close(); }
}

const withStore = (dataDir, work) => {
  if (!existsSync(join(dataDir, 'supervisor.db'))) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  const store = new Store(join(dataDir, 'supervisor.db'));
  try { return work(store); } finally { store.close(); }
};
const withStoreAsync = async (dataDir, work) => {
  if (!existsSync(join(dataDir, 'supervisor.db'))) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  const store = new Store(join(dataDir, 'supervisor.db'));
  try { return await work(store); } finally { store.close(); }
};

const PLAN_FROM = Object.freeze({ description: 'goal', issue: 'issue', pull: 'pr' });
const sameRoute = (record, route) => (isLocal(record) ? record.id === route : record.github_repository.toLowerCase() === route.toLowerCase());

/**
 * Start work: Plan and do. Stores one work request for a connected GitHub project through intake.mjs (exactly as
 * submitWorkRequest stores it; an exact retry is acknowledged once). Nothing is registered or dispatched: a plan comes
 * back as a draft for Review. input: { requestId, project, goal, from, number?, reportTo? }.
 */
export function requestPlanAndDo(dataDir, input, now = Date.now()) {
  const keys = ['requestId', 'project', 'goal', 'from', 'number', 'reportTo'];
  const bad = (message = 'Invalid plan request.') => fail(400, message);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key)) || !UUID.test(input.requestId ?? '') ||
      typeof input.project !== 'string' || !Object.hasOwn(PLAN_FROM, input.from)) throw bad();
  const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
  if (!goal || goal.length > 2000 || CONTROL.test(goal)) throw bad('Describe the goal in 1 to 2,000 characters.');
  if (safeText(goal, 2000) !== goal) throw bad('The goal looks like it contains a secret. Remove it and send again.');
  const number = (value) => Number.isSafeInteger(value) && value > 0;
  if (!planAndDoEnabled(dataDir)) throw fail(409, WORK_COPY.PLAN_AND_DO_OFF);
  return withStore(dataDir, (store) => {
    const record = readProjects(store).find((item) => item.disconnected_at == null && sameRoute(item, input.project));
    if (record && isLocal(record)) {
      // A project without GitHub has no issues or pull requests: its work is described, and nothing reports to GitHub.
      if (input.from !== 'description' || input.number !== undefined || input.reportTo !== undefined) throw bad('Describe the result: a project without GitHub has no issues or pull requests.');
      if (!localStartable(store, record, configuredGovernanceRoot(dataDir))) throw fail(409, WORK_COPY.RULES_FIRST, { code: 'RULES_FIRST' });
    } else if (input.from === 'description' ? input.number !== undefined || !number(input.reportTo) : !number(input.number) || input.reportTo !== undefined) {
      throw bad(input.from === 'description' ? 'Give the GitHub issue AIWorks reports this work to.' : `Give the ${input.from === 'issue' ? 'issue' : 'pull request'} number.`);
    }
    if (!record || !(isLocal(record) || startable(record))) throw fail(409, WORK_COPY.PLAN_AND_DO_OFF);
    try {
      const receipt = submitWorkRequest(store, { requestId: input.requestId, projectId: record.id, route: PLAN_FROM[input.from], text: goal,
        ...(isLocal(record) ? {} : input.from === 'description' ? { trackingIssue: input.reportTo } : { reference: input.number }), planOnly: false }, now);
      return { ...receipt, project: routeOf(record) };
    } catch (error) {
      if (error instanceof IntakeError) throw fail(error.code === 'CONFLICT' ? 409 : 400, error.message);
      throw error;
    }
  });
}

const EDIT_STATUS = Object.freeze({ INVALID_REQUEST: 400, INVALID_EDIT: 400, SCOPE_NOT_EDITABLE: 400, DRAFT_INVALID: 400, DRAFT_WITHHELD: 400,
  NOT_FOUND: 404, PROJECT_NOT_FOUND: 404 });
const EDIT_WORDS = Object.freeze({ PLAN_CHANGED: WORK_COPY.PLAN_CHANGED, ALREADY_APPROVED: WORK_COPY.ALREADY_APPROVED, SCOPE_NOT_EDITABLE: WORK_COPY.SCOPE_NOT_EDITABLE,
  NOT_FOUND: WORK_COPY.NOT_FOUND, PROJECT_NOT_FOUND: WORK_COPY.NOT_FOUND, NOT_READY: WORK_COPY.NOT_READY });

/**
 * Edit plan (OWNER_UI_V2 WP3): save the owner's edit as the plan's next draft version (intake.mjs reviseDraft). Only the
 * goal, done-when criteria and their checks, included and later, Now, Next or Later, priority and estimate change; the
 * scope, protected paths, providers, limits and release stay the reviewed plan's. Plan and do must be on, as for asking.
 * Nothing is approved or started: the new version waits for Approve and start of exactly that version.
 * input: { requestId, plan, version, authorityDigest, edits }; a repeat with the same request id is saved once.
 */
export function editPlan(dataDir, input, now = Date.now()) {
  const keys = ['requestId', 'plan', 'version', 'authorityDigest', 'edits'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key)) || !UUID.test(input.requestId ?? '') ||
      !UUID.test(input.plan ?? '') || !Number.isSafeInteger(input.version) || input.version < 1 || !DIGEST.test(input.authorityDigest ?? '')) {
    throw fail(400, 'Invalid plan edit.');
  }
  if (!planAndDoEnabled(dataDir)) throw fail(409, WORK_COPY.PLAN_AND_DO_OFF);
  return withStore(dataDir, (store) => {
    const request = workRequest(store, input.plan), record = request ? readProject(store, request.project_id) : null;
    if (!record || record.disconnected_at != null) throw fail(404, WORK_COPY.NOT_FOUND);
    try {
      const { draft, duplicate } = reviseDraft(store, { requestId: input.plan, version: input.version, authorityDigest: input.authorityDigest, editId: input.requestId,
        edits: input.edits }, now);
      return { accepted: true, duplicate, plan: input.plan, project: routeOf(record), version: draft.version, authorityDigest: draft.authority_digest };
    } catch (error) {
      if (!(error instanceof IntakeError)) throw error;
      if (error.code === 'DRAFT_STALE') throw stale(record, latestDraft(store, input.plan)?.stale_what);
      throw fail(EDIT_STATUS[error.code] ?? 409, EDIT_WORDS[error.code] ?? sentence(error.message), { code: error.code });
    }
  });
}

/**
 * Approve and start (OWNER_WORKSPACE 5.5, WORK_ENVELOPE E8). input: { requestId, plan, version, authorityDigest }: the
 * command's own request id, the work request the plan answers, and the draft version and authority digest the owner
 * reviewed. Refused with nothing persisted or registered when the plan changed after review (another version, another
 * digest, or stored bytes whose digest is no longer the reviewed one), is stale, or fails any check the CLI `start`
 * makes. A plan for a project without GitHub goes through approveLocal. A repeat with the same request id is
 * acknowledged once. `caller` is the caller check's options for this request (server.mjs: its connection; tests: a
 * synthetic process lookup). Other options are for tests only: provenanceRoot (the checkout whose origin/main is
 * trusted), governanceRoot and git.
 */
export async function approvePlan(dataDir, input, now = Date.now(), options = {}) {
  const keys = ['requestId', 'plan', 'version', 'authorityDigest'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key)) || !UUID.test(input.requestId ?? '') ||
      !UUID.test(input.plan ?? '') || !Number.isSafeInteger(input.version) || input.version < 1 || !DIGEST.test(input.authorityDigest ?? '')) {
    throw fail(400, 'Invalid approval.');
  }
  const { provenanceRoot = CODE_ROOT, governanceRoot = configuredGovernanceRoot(dataDir), caller = {} } = options;
  let git = options.git;
  try { git ??= configuredGitCommand(dataDir); } catch { git = null; }
  return withStoreAsync(dataDir, async (store) => {
    const request = workRequest(store, input.plan), draft = request ? latestDraft(store, input.plan) : null;
    const record = request ? readProject(store, request.project_id) : null;
    if (!draft || !record) throw fail(404, WORK_COPY.NOT_FOUND);
    if (isLocal(record)) return approveLocal(store, { input, request, draft, record, now, provenanceRoot, governanceRoot, git, caller });
    const declaration = draft.declaration, campaignId = declaration?.campaignId;
    const approvalId = `dashboard-${input.requestId.toLowerCase()}`;
    // A repeat of an approval already kept: acknowledged once, never registered twice.
    const kept = approvedDeclarations(store, campaignId).find((row) => row.approvalId === approvalId);
    if (kept) {
      if (kept.authorityDigest !== input.authorityDigest) throw fail(409, 'That approval identifier was already used for a different plan.');
      return { accepted: true, duplicate: true, campaignId, project: record.github_repository, approvedAt: kept.persistedAt };
    }
    assertReviewed(store, input, record, draft);
    // The checks of the CLI start, in its order: merged runtime code (AW-005), then the project rules for a new campaign.
    const notMerged = revisionNotMerged({ root: provenanceRoot });
    if (notMerged) throw refused('RUNTIME_NOT_MERGED', notMerged);
    // The project must still be at the revision the plan was drafted from (WORK_ENVELOPE 3.2 step 8); unknown is never
    // fresh. The dashboard runs git only, never gh: the base branch is fetched again, and an edited issue or a moved pull
    // request head is not re-read here (docs/OPERATIONS_DASHBOARD.md, Review and Approve and start).
    const current = git ? pinRequest(store, { ...request, route: 'goal', reference: null }, { git }) : { ok: false, code: 'GIT_COMMAND_INVALID' };
    if (!current.ok) throw fail(503, WORK_COPY.BASE_UNKNOWN.replace('{project}', record.name ?? record.github_repository), { detail: safeText(current.code, 40), code: 'BASE_UNKNOWN' });
    if (current.pinned.base !== draft.pinned?.base) throw stale(record, ['a new version of the project']);
    try { assertRegisteredTarget(declaration, governanceRoot); }
    catch (error) { throw refused(error.code ?? 'NOT_REGISTERED', error.message); }
    const approval = { schema: APPROVAL_SCHEMA, approvalId, campaignId, authorityDigest: input.authorityDigest, approvedBy: 'owner (dashboard)',
      approvedAt: new Date(now).toISOString(), draftVersion: draft.version, request: `${declaration.envelope?.request?.route ?? 'goal'} ${request.request_id}` };
    try {
      // Persist and register share one transaction: a refused start keeps no approval and registers nothing.
      return store.tx(() => {
        if (store.campaign(campaignId)) throw fail(409, WORK_COPY.ALREADY_STARTED, { code: 'ALREADY_STARTED' });
        assertStillLatest(store, input);
        persistApproved(store, declaration, approval, { now });
        const started = registerApproved(store, campaignId, { now });
        if (!started.registered) throw fail(409, WORK_COPY.ALREADY_STARTED, { code: 'ALREADY_STARTED' });
        store.journal(campaignId, 'dashboard-command', { action: 'approve-start', requestId: input.requestId, plan: input.plan, version: draft.version,
          authorityDigest: input.authorityDigest }, now);
        return { accepted: true, duplicate: false, campaignId, project: record.github_repository, approvedAt: approval.approvedAt };
      });
    } catch (error) {
      if (error.status) throw error;
      if (error instanceof CampaignError) throw refused(error.code, error.message);
      if (error instanceof TypeError || error?.name === 'TypeError') throw refused('INVALID_DECLARATION', error.message);
      throw error;
    }
  });
}

const stale = (record, what) => fail(409, WORK_COPY.DRAFT_STALE.replace('{project}', record.name ?? record.github_repository)
  .replace('{what}', (Array.isArray(what) ? what : []).map((item) => safeText(item, 120)).join(', ') || 'its source changed'), { code: 'DRAFT_STALE' });

/** The plan the owner reviewed is still as reviewed: connected, same version and digest, not started, fresh and ready. */
function assertReviewed(store, input, record, draft) {
  const declaration = draft.declaration;
  if (record.disconnected_at != null) throw fail(404, WORK_COPY.NOT_FOUND);
  // The exact plan the owner reviewed: same version, same digest, and stored bytes that still hash to it.
  if (draft.version !== input.version || draft.authority_digest !== input.authorityDigest || authorityDigest(declaration) !== input.authorityDigest ||
      scopeDigest(declaration) !== draft.scope_digest) throw fail(409, WORK_COPY.PLAN_CHANGED, { code: 'PLAN_CHANGED' });
  if (store.campaign(declaration?.campaignId)) throw fail(409, WORK_COPY.ALREADY_STARTED, { code: 'ALREADY_STARTED' });
  if (draft.state === 'stale') throw stale(record, draft.stale_what);
  if (draft.state !== 'draft') throw fail(409, WORK_COPY.NOT_READY);
}

/** In the transaction that starts it: the approved version is still the newest, so an edit saved meanwhile is never skipped. */
function assertStillLatest(store, input) {
  const newest = latestDraft(store, input.plan);
  if (newest?.version !== input.version || newest.authority_digest !== input.authorityDigest) throw fail(409, WORK_COPY.PLAN_CHANGED, { code: 'PLAN_CHANGED' });
}

/** A supervisor refusal's own clause as one sentence for the page: first letter capital, full stop. */
const sentence = (text) => { const value = safeText(text, 600); return `${value.charAt(0).toUpperCase()}${value.slice(1)}${/[.!?]$/.test(value) ? '' : '.'}`; };
const CALLER_REFUSALS = ['APPROVAL_FROM_AIWORKS', 'APPROVAL_UNCHECKED', 'APPLY_FROM_AIWORKS', 'APPLY_UNCHECKED'];

/** The commit of the AIWorks code this dashboard runs from, which a local approval names (local-admission.mjs). */
function headRevision(root) {
  const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const sha = String(head.stdout ?? '').trim();
  return !head.error && head.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** The receipt an earlier press with this request id left in the local approval ledger, or null. */
function localReceipt(store, requestId) {
  try { return store.get("SELECT * FROM local_receipts WHERE request_id = ? AND action = 'approve'", requestId) ?? null; } catch { return null; }
}

/**
 * Approve and start for a project without GitHub (OWNER_WORKSPACE S12, WORK_ENVELOPE section 8, decision D4). The same
 * review checks as a GitHub plan and merged runtime code (AW-005); then the copy of the project the plan was drafted from
 * must still be AIWorks's current one, read from the store only. The caller check runs before anything is written: a
 * press from a program AIWorks started, or one the check cannot place, records nothing. The owner's approval of exactly
 * this plan is recorded in the local ledger, and registerLocalPlan admits it once and registers the plan in one
 * transaction; a refused registration starts nothing. No signing key, and no GitHub or network call.
 */
async function approveLocal(store, { input, request, draft, record, now, provenanceRoot, governanceRoot, git, caller }) {
  const declaration = draft.declaration, campaignId = declaration?.campaignId;
  // A repeat of a press that already started this plan: acknowledged once, never registered twice.
  const earlier = localReceipt(store, input.requestId);
  if (earlier && store.campaign(campaignId)) {
    const approval = localApprovals(store, campaignId).find((row) => row.approvalId === earlier.approval_id);
    if (!approval) throw fail(409, 'That approval identifier was already used for a different plan.');
    return { accepted: true, duplicate: true, campaignId, project: record.id, approvedAt: approval.approvedAt };
  }
  assertReviewed(store, input, record, draft);
  const notMerged = revisionNotMerged({ root: provenanceRoot });
  if (notMerged) throw refused('RUNTIME_NOT_MERGED', notMerged);
  const current = pinRequest(store, { ...request, route: 'goal', reference: null }, { git: git ?? ['git'] });
  if (!current.ok) throw fail(503, WORK_COPY.BASE_UNKNOWN.replace('{project}', record.name ?? record.id), { detail: safeText(current.code, 40), code: 'BASE_UNKNOWN' });
  if (current.pinned.base !== draft.pinned?.base || current.pinned.baselineSeq !== draft.pinned?.baselineSeq) throw stale(record, ['a new copy of the project']);
  const codeRevision = headRevision(provenanceRoot);
  if (!codeRevision) throw refused('CODE_REVISION_UNKNOWN', 'git rev-parse HEAD failed in the AIWorks checkout');
  try {
    const { project, overlay, takenIds } = resolveLocalProject(store, declaration);
    const approvalId = /^aiworks-local:(.+)$/.exec(String(declaration.authorization?.reference ?? ''))?.[1];
    const kept = localApprovals(store, campaignId).find((row) => row.approvalId === approvalId);
    let approvedAt;
    if (kept && !earlier) {
      // This plan's approval was recorded by an earlier press whose registration was refused. It is used as it is (the
      // admission checks it again); this press must still come from the owner.
      await checkCaller(store, caller);
      approvedAt = kept.approvedAt;
    } else {
      ({ record: { approvedAt } } = await recordLocalApproval(store, { declaration, overlay, project, governanceRoot, takenIds, codeRevision,
        requestId: input.requestId, caller, now }));
    }
    store.tx(() => {
      assertStillLatest(store, input);
      registerLocalPlan(store, { declaration, governanceRoot, codeRevision, now });
      if (!store.campaign(campaignId)) throw fail(409, WORK_COPY.ALREADY_STARTED, { code: 'ALREADY_STARTED' });
      store.journal(campaignId, 'dashboard-command', { action: 'approve-start', requestId: input.requestId, plan: input.plan, version: draft.version,
        authorityDigest: input.authorityDigest, local: true }, now);
    });
    return { accepted: true, duplicate: false, campaignId, project: record.id, approvedAt };
  } catch (error) {
    if (error.status) throw error;
    if (CALLER_REFUSALS.includes(error.code)) throw fail(403, sentence(error.message), { code: error.code });
    if (error instanceof TypeError || error?.name === 'TypeError') throw refused('INVALID_DECLARATION', error.message);
    if (typeof error.code === 'string' && /^[A-Z][A-Z_]+$/.test(error.code)) throw refused(error.code, error.message);
    throw error;
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const APPLY_ID = /^apply-\d{1,6}-[0-9a-f]{16}$/;
const NOT_THERE = 'This result is not on this computer. It may belong to another project, or the address is mistyped.';

/** What happened to the owner's folder, in one or two sentences, with the files that decided it. */
function applyMessage(result, undo) {
  const files = (result.files ?? []).slice(0, 8).map((file) => safeText(typeof file === 'string' ? file : file?.path ?? '', 200)).filter(Boolean);
  const named = files.length ? ` Files: ${files.join(', ')}.` : '';
  const reason = result.reason ? safeText(result.reason, 300) : null;
  if (/already received|already applied/.test(reason ?? '')) return sentence(reason);
  switch (result.outcome) {
    case 'applied': return 'Applied. Your folder now holds the checked result. Undo apply puts back what was there before.';
    case 'rolled-back': return undo ? 'Undone. Your folder is back as it was before Apply.' : 'Not applied. AIWorks put your folder back as it was.';
    case 'refused': return `Not ${undo ? 'undone' : 'applied'}: ${reason ?? 'your folder changed'}.${reason && /nothing was/.test(reason) ? '' : ' Nothing was written.'}${named}`;
    case 'stopped': return `Stopped: ${reason ?? 'a file changed meanwhile'}. AIWorks kept its backup.${named}`;
    default: return 'AIWorks can’t tell yet what happened to your folder. It reads the folder again before it writes anything else.';
  }
}

/** An Apply or Undo apply AIWorks will not act on: the caller check's refusals are 403, a missing result 404. */
function applyRefusal(error) {
  if (error.status || typeof error.code !== 'string' || error.name !== 'OwnerApplyError') return error;
  const status = CALLER_REFUSALS.includes(error.code) ? 403 : ['APPLY_NO_CANDIDATE', 'APPLY_NOT_FOUND', 'APPLY_NO_PROJECT'].includes(error.code) ? 404 : 409;
  return fail(status, sentence(error.message), { code: error.code });
}

const applyGit = (dataDir, options) => {
  try { return options.git ?? configuredGitCommand(dataDir); } catch { throw fail(503, 'AIWorks’s git command is not set up correctly on this computer, so nothing was written.'); }
};

/**
 * Apply (OWNER_WORKSPACE S12, WORK_ENVELOPE 8.6): write a checked local result to the owner's folder. Only an owner press
 * through this route does it, after the caller check, under Review only: no release record or grant. The folder is
 * rescanned first, and a change to any file the result touches refuses it with nothing written; a backup is kept first.
 * input: { requestId, campaignId, taskId, seq }. A repeat with the same request id is answered, never acted on twice.
 */
export async function applyResult(dataDir, input, options = {}) {
  const keys = ['requestId', 'campaignId', 'taskId', 'seq'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key)) || !UUID.test(input.requestId ?? '') ||
      !NAME.test(input.campaignId ?? '') || !NAME.test(input.taskId ?? '') || !Number.isSafeInteger(input.seq) || input.seq < 1) throw fail(400, 'Invalid apply.');
  const { caller = {}, gitEnv, now = Date.now() } = options, git = applyGit(dataDir, options);
  return withStoreAsync(dataDir, async (store) => {
    const c = store.campaign(input.campaignId);
    if (!c || !isLocalTarget(c.declaration)) throw fail(404, NOT_THERE);
    try {
      const result = await ownerApply(store, { campaignId: input.campaignId, taskId: input.taskId, seq: input.seq, requestId: input.requestId,
        caller: (s) => checkCaller(s, caller), dataDir, git, gitEnv, now });
      return { ...result, message: applyMessage(result, false) };
    } catch (error) { throw applyRefusal(error); }
  });
}

/**
 * Undo apply: put back what the owner's folder held before an Apply, from its backup, after the same caller check.
 * Refused with nothing written over a file changed since the Apply. input: { requestId, applyId }.
 */
export async function undoApply(dataDir, input, options = {}) {
  const keys = ['requestId', 'applyId'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key)) || !UUID.test(input.requestId ?? '') ||
      !APPLY_ID.test(input.applyId ?? '')) throw fail(400, 'Invalid undo.');
  const { caller = {}, gitEnv, now = Date.now() } = options, git = applyGit(dataDir, options);
  return withStoreAsync(dataDir, async (store) => {
    try {
      const result = await undoOwnerApply(store, { applyId: input.applyId, requestId: input.requestId, caller: (s) => checkCaller(s, caller), git, gitEnv, now });
      return { ...result, message: applyMessage(result, true) };
    } catch (error) { throw applyRefusal(error); }
  });
}
