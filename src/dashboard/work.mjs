// Plan and do, Review and Approve and start for a GitHub project (docs/design/OWNER_WORKSPACE.md S10 and
// docs/design/WORK_ENVELOPE.md E8; plan slice UI14). The owner asks for a plan, reviews the draft AIWorks proposes and
// presses Approve and start. Approving registers exactly the reviewed plan, bound to its authority digest, through the
// same checks as the CLI `approve` and `start --approved` (approved-declarations.mjs, approvals.mjs): merged runtime code
// (AW-005), the project rules, the duplicate-work check and the private store. The dashboard never writes a campaign
// itself; it calls those supervisor APIs. A project without GitHub cannot start here (LOCAL_START_OFF, slice UI17).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../supervisor/store.mjs';
import { CampaignError } from '../supervisor/api.mjs';
import { APPROVAL_SCHEMA } from '../supervisor/approvals.mjs';
import { approvedDeclarations, persistApproved, registerApproved } from '../supervisor/approved-declarations.mjs';
import { assertRegisteredTarget, authorityDigest, scopeDigest } from '../supervisor/campaign.mjs';
import { configuredGovernanceRoot } from '../supervisor/governance.mjs';
import { INTAKE_COPY, intakeState, IntakeError, latestDraft, pinRequest, submitWorkRequest, workRequest } from '../supervisor/intake.mjs';
import { project as readProject, projects as readProjects } from '../supervisor/projects.mjs';
import { CODE_ROOT, revisionNotMerged } from '../supervisor/provenance.mjs';
import { configuredGitCommand } from './merges.mjs';
import { safeText } from './roadmap.mjs';

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
  ALREADY_STARTED: 'This plan has already started. Its work is under Work.',
  NOT_FOUND: 'This plan is not on this computer. It may belong to another project, or the address is mistyped.',
  NOT_READY: 'This plan is not ready to approve yet.',
  LOCAL_START_OFF: 'You can plan work here. Starting work on projects without GitHub isn’t built yet.',
  BASE_UNKNOWN: "AIWorks couldn't read the latest version of {project}, so nothing started. Try again in a minute.",
  START_REFUSED: "AIWorks didn't start this work: {reason}.",
  APPROVED: 'Approved at {time} · waiting for AIWorks to pick it up',
  PLAN_AND_DO_OFF: 'Plan and do is not available for this project. Its plans are drafted only when the AIWorks configuration file on this computer switches planning on, for a connected GitHub project.',
  RELEASE: 'Release: Review only. AIWorks stops when a result passes the check and is published. You merge and release.',
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
});

const refused = (code, detail) => fail(409, WORK_COPY.START_REFUSED.replace('{reason}', REFUSAL_WORDS[code] ?? 'it did not pass the checks a start from the command line makes'),
  { detail: `${code}: ${safeText(detail, 600)}`, code: 'START_REFUSED' });

/** Plan and do is on when config.json switches drafting on ("coordinator": { "intake": true }). Read on every request. */
export const planAndDoEnabled = (dataDir) => readConfig(dataDir).coordinator?.intake === true;

const startable = (record) => record.source_kind === 'github' && record.disconnected_at == null && record.status === 'ready' && record.capabilities?.startWork?.allowed === true;

/** One draft as Review shows it: only allowlisted fields, every text through safeText. Never a path or raw output. */
function planView(store, record, request, draft) {
  const base = { id: request.request_id, project: record.github_repository, receivedAt: request.received_at };
  const campaignId = draft?.declaration?.campaignId;
  const approved = campaignId ? approvedDeclarations(store, campaignId).find((row) => row.authorityDigest === draft.authority_digest) : null;
  const started = campaignId ? store.campaign(campaignId) : null;
  const state = approved && started ? { code: 'APPROVED' } : intakeState(request, draft);
  const view = { ...base, code: state.code, startable: ['DRAFT_READY', 'PLAN_ONLY_READY', 'CONFLICT'].includes(state.code), approvedAt: approved?.persistedAt ?? null,
    failure: state.code === 'DRAFT_FAILED' ? safeText(state.reason, 80) : null, staleWhat: state.code === 'DRAFT_STALE' ? list(state.what, 120, 8) : [] };
  if (!draft) return view;
  const d = draft.declaration, envelope = d.envelope ?? {};
  const providers = (d.executor?.kind === 'cli-chain' ? d.executor.providers : [d.executor]).filter(Boolean)
    .map((provider) => safeText([provider.kind, provider.model].filter(Boolean).join(' '), 80));
  return { ...view, version: draft.version, planOnly: Boolean(draft.plan_only), authorityDigest: draft.authority_digest, fingerprint: draft.authority_digest.slice(0, 12),
    campaignId: safeText(campaignId, 64), summary: safeText(draft.summary, 2000), plan: safeText(draft.plan, 8000), outcome: safeText(envelope.outcome, 300),
    acceptance: list(envelope.acceptance), writes: list(envelope.writes, 200, 64), denyWrites: list(envelope.denyWrites, 200, 64),
    deliverables: list(envelope.deliverables, 20, 4), providers, limits: d.limits ? Object.fromEntries(Object.entries(d.limits).filter(([, value]) => Number.isFinite(value))) : null,
    release: 'review-only', steps: (Array.isArray(draft.steps) ? draft.steps : []).slice(0, 32).map((step) => typeof step === 'string' ? { title: safeText(step), check: null }
      : { title: safeText(step?.title ?? step?.outcome ?? ''), check: step?.check ? safeText(step.check) : null }),
    tasks: (Array.isArray(d.tasks) ? d.tasks : []).slice(0, 32).map((task) => ({ id: safeText(task.id, 64), title: safeText(task.outcome ?? task.title ?? task.id), deliverable: safeText(task.deliverable, 20),
      writes: list(task.writes, 200, 32) })),
    questions: list(draft.questions, 1000, 16),
    conflicts: (Array.isArray(draft.conflicts) ? draft.conflicts : []).slice(0, 16).map((item) => ({ code: safeText(item.code, 40), campaignId: safeText(item.campaignId, 64),
      taskId: safeText(item.taskId, 64), ownerTaskId: safeText(item.ownerTaskId, 64) })),
    notes: list(draft.notes, 300, 16) };
}

/**
 * Read-only: whether Plan and do is on, the connected GitHub projects it can start in, and each of their requests with
 * its newest draft, newest first. A store without intake tables, or none at all, shows no plans. A project without
 * GitHub is not listed: its plans start through slice UI17.
 */
export function workView(dataDir) {
  const enabled = planAndDoEnabled(dataDir), empty = { planAndDo: enabled, projects: [], plans: [] };
  const path = join(dataDir, 'supervisor.db');
  if (!existsSync(path)) return empty;
  let store;
  try {
    store = new Store(path, { readOnly: true });
    const records = readProjects(store).filter((record) => record.source_kind === 'github');
    const plans = records.flatMap((record) => store.all('SELECT * FROM work_requests WHERE project_id = ? ORDER BY id DESC LIMIT 20', record.id)
      .map((request) => planView(store, record, request, latestDraft(store, request.request_id))));
    return { planAndDo: enabled, projects: enabled ? records.filter(startable).map((record) => record.github_repository) : [], plans };
  } catch { return empty; } finally { store?.close(); }
}

const withStore = (dataDir, work) => {
  if (!existsSync(join(dataDir, 'supervisor.db'))) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  const store = new Store(join(dataDir, 'supervisor.db'));
  try { return work(store); } finally { store.close(); }
};

const PLAN_FROM = Object.freeze({ description: 'goal', issue: 'issue', pull: 'pr' });

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
  if (input.from === 'description' ? input.number !== undefined || !number(input.reportTo) : !number(input.number) || input.reportTo !== undefined) {
    throw bad(input.from === 'description' ? 'Give the GitHub issue AIWorks reports this work to.' : `Give the ${input.from === 'issue' ? 'issue' : 'pull request'} number.`);
  }
  if (!planAndDoEnabled(dataDir)) throw fail(409, WORK_COPY.PLAN_AND_DO_OFF);
  return withStore(dataDir, (store) => {
    const record = readProjects(store).find((item) => item.source_kind === 'github' && item.github_repository.toLowerCase() === input.project.toLowerCase());
    if (!record || !startable(record)) throw fail(409, WORK_COPY.PLAN_AND_DO_OFF);
    try {
      const receipt = submitWorkRequest(store, { requestId: input.requestId, projectId: record.id, route: PLAN_FROM[input.from], text: goal,
        ...(input.from === 'description' ? { trackingIssue: input.reportTo } : { reference: input.number }), planOnly: false }, now);
      return { ...receipt, project: record.github_repository };
    } catch (error) {
      if (error instanceof IntakeError) throw fail(error.code === 'CONFLICT' ? 409 : 400, error.message);
      throw error;
    }
  });
}

/**
 * Approve and start (OWNER_WORKSPACE 5.5, WORK_ENVELOPE E8). input: { requestId, plan, version, authorityDigest }: the
 * command's own request id, the work request the plan answers, and the draft version and authority digest the owner
 * reviewed. Refused with nothing persisted or registered when the plan changed after review (another version, another
 * digest, or stored bytes whose digest is no longer the reviewed one), is stale, is not a GitHub project's, or fails any
 * check the CLI `start` makes. A repeat with the same request id is acknowledged once.
 * Options are for tests only: provenanceRoot (the checkout whose origin/main is trusted), governanceRoot and git.
 */
export function approvePlan(dataDir, input, now = Date.now(), options = {}) {
  const keys = ['requestId', 'plan', 'version', 'authorityDigest'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key)) || !UUID.test(input.requestId ?? '') ||
      !UUID.test(input.plan ?? '') || !Number.isSafeInteger(input.version) || input.version < 1 || !DIGEST.test(input.authorityDigest ?? '')) {
    throw fail(400, 'Invalid approval.');
  }
  const { provenanceRoot = CODE_ROOT, governanceRoot = configuredGovernanceRoot(dataDir) } = options;
  let git = options.git;
  try { git ??= configuredGitCommand(dataDir); } catch { git = null; }
  return withStore(dataDir, (store) => {
    const request = workRequest(store, input.plan), draft = request ? latestDraft(store, input.plan) : null;
    const record = request ? readProject(store, request.project_id) : null;
    if (!draft || !record) throw fail(404, WORK_COPY.NOT_FOUND);
    const declaration = draft.declaration, campaignId = declaration?.campaignId;
    const approvalId = `dashboard-${input.requestId.toLowerCase()}`;
    // A repeat of an approval already kept: acknowledged once, never registered twice.
    const kept = approvedDeclarations(store, campaignId).find((row) => row.approvalId === approvalId);
    if (kept) {
      if (kept.authorityDigest !== input.authorityDigest) throw fail(409, 'That approval identifier was already used for a different plan.');
      return { accepted: true, duplicate: true, campaignId, project: record.github_repository, approvedAt: kept.persistedAt };
    }
    if (record.source_kind !== 'github') throw fail(409, WORK_COPY.LOCAL_START_OFF, { code: 'LOCAL_START_OFF' });
    if (record.disconnected_at != null) throw fail(404, WORK_COPY.NOT_FOUND);
    // The exact plan the owner reviewed: same version, same digest, and stored bytes that still hash to it.
    if (draft.version !== input.version || draft.authority_digest !== input.authorityDigest || authorityDigest(declaration) !== input.authorityDigest ||
        scopeDigest(declaration) !== draft.scope_digest) throw fail(409, WORK_COPY.PLAN_CHANGED, { code: 'PLAN_CHANGED' });
    if (store.campaign(campaignId)) throw fail(409, WORK_COPY.ALREADY_STARTED, { code: 'ALREADY_STARTED' });
    if (draft.state === 'stale') throw stale(record, draft.stale_what);
    if (draft.state !== 'draft') throw fail(409, WORK_COPY.NOT_READY);
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
