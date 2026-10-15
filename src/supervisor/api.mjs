// AIWorks campaign interface: start, status, pause, cancel, recheck. These are owner
// actions: they change durable state with compare-and-swap and never dispatch work
// themselves. Readiness is derived from a live controller lease, never from registration.
import { runNotCounted } from './adapters/executors.mjs';
import { authorityDigest, campaignLimits, canonicalJson, executorOrder, scopeDigest, validateDeclaration } from './campaign.mjs';
import { findWorkConflict } from './work-ownership.mjs';
import { specOf, specsOf } from './plan.mjs';
import { accountFull, laterWait } from './accounts.mjs';
import { admissionCheck, hostCeiling, schedulerEnabled } from './scheduler.mjs';
import { releaseStatus } from './release/eligibility.mjs';
import { releaseNarrowings } from './release/state.mjs';
import { candidateStatus } from './local-candidates.mjs';

export class CampaignError extends Error {
  constructor(code, message) { super(message); this.name = 'CampaignError'; this.code = code; }
}

export function campaignStart(store, declaration, now = Date.now()) {
  const decl = validateDeclaration(declaration);
  const scope = scopeDigest(decl);
  store.tx(() => {
    const existing = store.campaign(decl.campaignId);
    if (!existing) {
      // Registration and admission share BEGIN IMMEDIATE: another connection cannot register
      // the same repair between this ownership check and the campaign insert (aiworks#5 A).
      const conflict = findWorkConflict(store, decl);
      if (conflict) throw Object.assign(new CampaignError('WORK_ALREADY_ASSIGNED',
        `task ${conflict.taskId} is already assigned to ${conflict.campaignId}/${conflict.ownerTaskId} (${conflict.reason}); reuse that campaign or finish or cancel it before registering another`), { conflict });
      store.insert('campaigns', {
        id: decl.campaignId, controller_id: `aiworks-supervisor/${decl.campaignId}`, scope_digest: scope,
        authorization_version: decl.authorization.version, declaration: decl, control: 'registered', status: 'active',
        next_action: 'waiting for a live controller lease', next_wakeup_at: null, blocker: null,
        version: 1, created_at: now, updated_at: now,
      });
      decl.tasks.forEach((task, ord) => store.insert('tasks', {
        campaign_id: decl.campaignId, task_id: task.id, ord, state: 'pending', version: 1, updated_at: now,
      }));
      store.journal(decl.campaignId, 'registered', { scopeDigest: scope, authorizationVersion: decl.authorization.version, authority: authorityDigest(decl) }, now);
      return;
    }
    const executorChanged = canonicalJson(existing.declaration.executor) !== canonicalJson(decl.executor);
    // `routing` (MODEL_ROUTING 4.1) is amended like `executor`: the only scope fields an amendment may change.
    const routingChanged = canonicalJson(existing.declaration.routing ?? null) !== canonicalJson(decl.routing ?? null);
    if (existing.scope_digest !== scope &&
        scopeDigest({ ...decl, executor: existing.declaration.executor, routing: existing.declaration.routing }) !== existing.scope_digest) {
      throw new CampaignError('SCOPE_CONFLICT', `campaign ${decl.campaignId} exists with a different immutable scope; register a new campaign id`);
    }
    if (executorChanged && (existing.control !== 'paused' || store.openOperations(decl.campaignId).length)) {
      throw new CampaignError('EXECUTOR_HANDOVER_REQUIRED', 'executor amendment requires a paused campaign with no open operations');
    }
    if (routingChanged && (existing.control !== 'paused' || store.openOperations(decl.campaignId).length)) {
      throw new CampaignError('ROUTING_HANDOVER_REQUIRED', 'routing amendment requires a paused campaign with no open operations');
    }
    if (decl.authorization.version < existing.authorization_version) {
      throw new CampaignError('STALE_AUTHORIZATION', `authorization v${decl.authorization.version} is older than recorded v${existing.authorization_version}`);
    }
    const changes = {};
    if (decl.authorization.version > existing.authorization_version) {
      Object.assign(changes, { declaration: decl, authorization_version: decl.authorization.version, scope_digest: scope });
      store.journal(decl.campaignId, 'authorization-amended', { from: existing.authorization_version, to: decl.authorization.version, limits: decl.limits }, now);
      if (executorChanged) store.journal(decl.campaignId, 'executor-amended', {
        from: existing.declaration.executor, to: decl.executor, previousScopeDigest: existing.scope_digest, scopeDigest: scope,
      }, now);
      if (routingChanged) store.journal(decl.campaignId, 'routing-amended', {
        from: existing.declaration.routing ?? null, to: decl.routing ?? null, previousScopeDigest: existing.scope_digest, scopeDigest: scope,
      }, now);
      if (executorChanged && decl.executor.kind === 'cli-chain' && existing.declaration.executor.kind !== 'cli-chain') {
        // A former single-account hold must not prevent a newly authorized provider
        // from starting, nor discard the old account's known reset evidence.
        for (const task of store.tasks(decl.campaignId)) {
          if (task.blocked || !String(task.last_error ?? '').startsWith('quota:') || !task.retry_at) continue;
          store.run('INSERT OR REPLACE INTO executor_waits (campaign_id, executor_kind, retry_at, reason) VALUES (?, ?, ?, ?)',
            decl.campaignId, existing.declaration.executor.kind, task.retry_at, task.last_error);
          store.patch('tasks', { campaign_id: decl.campaignId, task_id: task.task_id }, task.version,
            { retry_at: null, last_error: null }, now);
        }
      }
      // Recount from the stored operations, so runs recorded before refunds existed stop counting and a
      // count already corrected elsewhere is not reduced twice. Every recorded operation consumed a run
      // except the ones the controller refunds: admission-blocked, refused before work, executor unavailable.
      const counted = store.all('SELECT outcome FROM operations WHERE campaign_id = ?', decl.campaignId)
        .filter((op) => !runNotCounted(op.outcome)).length;
      if (counted !== existing.runs_used) {
        changes.runs_used = counted;
        store.journal(decl.campaignId, 'runs-recounted', { from: existing.runs_used, to: counted }, now);
      }
      // A stall that only existed because of a limit the owner has now raised or removed is released, so the
      // amendment itself resumes that work. Owner-reserved (B3) and admission stalls are never released here.
      const allows = (limit, used) => limit === null || used < limit;
      for (const task of store.tasks(decl.campaignId)) {
        if (task.blocked?.class !== 'stalled' || task.state === 'done') continue;
        const reason = String(task.blocked.reason ?? '');
        const failed = /^(\d+) failed attempts/.exec(reason);
        const released = /^verifier still rejects/.test(reason) ? allows(campaignLimits(decl).maxRepairRounds, task.repair_rounds)
          : failed ? allows(campaignLimits(decl).maxRetriesPerTask, Number(failed[1]) - 1) : false;
        if (!released) continue;
        store.patch('tasks', { campaign_id: decl.campaignId, task_id: task.task_id }, task.version, { blocked: null, retry_at: null }, now);
        store.journal(decl.campaignId, 'stall-released', { task: task.task_id, reason: reason.slice(0, 120), limits: decl.limits }, now);
      }
    } else if (canonicalJson(decl) !== canonicalJson(existing.declaration)) {
      throw new CampaignError('AUTHORIZATION_VERSION_REQUIRED', 'limits or authorization changed: increase authorization.version');
    }
    if (existing.control === 'paused') {
      changes.control = 'registered';
      store.journal(decl.campaignId, 'resumed', null, now);
    }
    if (Object.keys(changes).length) store.patch('campaigns', { id: decl.campaignId }, existing.version, changes, now);
  });
  return campaignStatus(store, decl.campaignId, now);
}

/**
 * The owner's budget, evaluated from durable state. `maxWorkerRuns` binds unless the owner declared it null
 * (no run cap). When the declaration also sets `maxCostUsd`, measured cost plus a declared conservative price
 * for every counted run whose provider reported no dollar cost (`unknownRunCostUsd`, never zero) must stay
 * below that ceiling. With neither, only provider subscription/usage limits stop work.
 */
export function campaignBudget(store, c) {
  const limits = campaignLimits(c.declaration);
  const measured = Math.round(c.cost_usd * 10000) / 10000;
  const rows = store.all("SELECT state, outcome FROM operations WHERE campaign_id = ? AND state IN ('finished', 'recorded', 'dispatched')", c.id);
  const open = (op) => op.state === 'recorded' || op.state === 'dispatched';
  const unknownRuns = rows.filter((op) => !open(op) && !runNotCounted(op.outcome) && !(op.outcome?.receipt?.costUsd > 0)).length;
  const maxCostUsd = limits.maxCostUsd ?? null;
  const unknownRunCostUsd = limits.unknownRunCostUsd ?? null;
  // Under a declared ceiling every open run is reserved at the declared unknown-run price until it finishes, so runs
  // that overlap cannot together overshoot it (ADAPTIVE_SCHEDULER row 13). Without a ceiling nothing is reserved.
  const reservedRuns = maxCostUsd !== null ? rows.filter(open).length : 0;
  const charged = maxCostUsd !== null ? Math.round((measured + (unknownRuns + reservedRuns) * (unknownRunCostUsd ?? 0)) * 10000) / 10000 : null;
  const exhausted = limits.maxWorkerRuns !== null && c.runs_used >= limits.maxWorkerRuns ? `worker-run cap reached (${c.runs_used}/${limits.maxWorkerRuns})`
    : maxCostUsd !== null && charged >= maxCostUsd ? `cost ceiling reached ($${charged.toFixed(2)} charged of $${maxCostUsd.toFixed(2)}; ${unknownRuns} run(s) with unreported cost and ${reservedRuns} open run(s) priced at $${(unknownRunCostUsd ?? 0).toFixed(2)})`
      : null;
  return { runsUsed: c.runs_used, maxWorkerRuns: limits.maxWorkerRuns, measuredCostUsd: measured, unknownCostRuns: unknownRuns,
    reservedRuns, unknownRunCostUsd, chargedCostUsd: charged, maxCostUsd, exhausted };
}

const hasTable = (store, name) => Boolean(store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name));

/**
 * This campaign's provider waits: its own rows and the account rows of the executor kinds it uses (accounts.mjs), the later
 * one per kind. Status has no config.json, so an account row is matched by executor kind. Read-only: an unmigrated store
 * simply has no account rows.
 */
function executorWaitsView(store, c) {
  const own = hasTable(store, 'executor_waits') ? store.all('SELECT executor_kind, retry_at, reason FROM executor_waits WHERE campaign_id = ?', c.id) : [];
  const kinds = new Set(executorOrder(c.declaration.executor).map((provider) => provider.kind));
  const shared = hasTable(store, 'provider_waits') ? store.all('SELECT account, executor_kind, retry_at, reason FROM provider_waits')
    .filter((row) => kinds.has(row.executor_kind)) : [];
  const byKind = new Map();
  for (const row of [...own, ...shared]) byKind.set(row.executor_kind, laterWait(byKind.get(row.executor_kind), row));
  return [...byKind.values()];
}

/** Status `release`: the report-only eligibility, plus `stopped` and `narrowed` only once the owner has used them. */
function releaseView(store, project, tasks, releaseStop) {
  const narrowed = releaseNarrowings(store, project);
  return { ...releaseStatus({ project, tasks }), ...(releaseStop === true ? { stopped: 'RELEASE-STOP is set: every release is stopped' } : {}),
    ...(narrowed.length ? { narrowed } : {}) };
}

/**
 * `config` (optional) is the supervisor's config.json: with `scheduler.enabled` the `wait` of each task names the
 * scheduler's admission reason; without it, waits follow the one-worker-per-campaign rule the controller uses when off.
 */
export function campaignStatus(store, id, now = Date.now(), { releaseStop = false, config = null } = {}) {
  const c = store.campaign(id);
  if (!c) throw new CampaignError('CAMPAIGN_NOT_FOUND', `campaign ${id} is not registered in the selected store; check the installed task --data argument`);
  const lease = store.lease(id);
  const live = Boolean(lease && lease.expires_at > now);
  const readiness = c.control === 'finished' ? 'COMPLETE' : c.control === 'cancelled' ? 'CANCELLED'
    : c.control === 'paused' ? 'PAUSED' : c.control === 'cancel-requested' ? 'CANCELLING'
      : live ? 'ACTIVE' : lease ? 'CONTROLLER_OFFLINE' : 'BOOTSTRAP_REQUIRED';
  const tasks = store.tasks(id);
  const operations = store.openOperations(id);
  const lastEvent = store.get('SELECT seq, kind, at FROM journal WHERE campaign_id = ? ORDER BY seq DESC LIMIT 1', id);
  const progress = store.get("SELECT MAX(at) AS at FROM journal WHERE campaign_id = ? AND kind != 'lease-acquired'", id);
  const legacyWaitUntil = Math.max(0, ...tasks
    .filter((t) => !t.blocked && String(t.last_error ?? '').startsWith('quota:') && t.retry_at > now)
    .map((t) => t.retry_at));
  const done = new Set(tasks.filter((t) => t.state === 'done').map((t) => t.task_id));
  const specs = specsOf(store, id, c.declaration);
  // A task row with no spec (neither declared nor a live child) is shown but never counted as runnable.
  const runnable = tasks.filter((t) => !t.blocked && ['pending', 'implemented', 'verified'].includes(t.state) &&
    specs.get(t.task_id)?.dependsOn.every((dep) => done.has(dep)));
  const chainWaiting = !operations.length && runnable.length && runnable.every((t) => t.state !== 'verified' && t.retry_at > now &&
    /^(quota:|waiting for executor availability:)/.test(String(t.last_error ?? '')));
  const providerWaitUntil = c.declaration.executor.kind === 'cli-chain'
    ? chainWaiting ? Math.min(...runnable.map((t) => t.retry_at)) : 0 : legacyWaitUntil;
  const ownerBlockers = ownerBlockerView(store, id);
  const ci = ciView(store, c, tasks);
  const waits = { store, campaign: c, tasks, open: operations, held: heldTasks(store, id), now, config };
  const routed = routingView(store, id);
  return {
    campaignId: c.id,
    store: store.identity,
    observedAt: new Date(now).toISOString(),
    // With several open operations the phase reads `verify` only while every one of them verifies.
    phase: !live ? readiness : c.control !== 'registered' ? readiness
      : c.blocker ? c.status : operations.length ? (operations.find((op) => op.kind !== 'verify') ?? operations[0]).kind
        : providerWaitUntil ? 'provider-wait' : c.status,
    providerWaitUntil: providerWaitUntil ? new Date(providerWaitUntil).toISOString() : null,
    lastProgressAt: progress?.at ? new Date(progress.at).toISOString() : null,
    lastJournalEvent: lastEvent ? { sequence: lastEvent.seq, kind: lastEvent.kind, at: new Date(lastEvent.at).toISOString() } : null,
    authorizationVersion: c.authorization_version,
    scopeDigest: c.scope_digest,
    readiness,
    controller: {
      id: c.controller_id,
      instanceId: lease?.instance_id ?? null,
      generation: lease?.generation ?? null,
      codeRevision: lease?.code_revision ?? null,
      leaseExpiresAt: lease ? new Date(lease.expires_at).toISOString() : null,
      live,
      livenessEvidence: lease ? (live ? 'unexpired-lease' : 'expired-lease') : 'no-lease',
      leaseAcquiredAt: lease ? new Date(lease.acquired_at).toISOString() : null,
    },
    control: c.control,
    status: live || ['finished', 'cancelled', 'paused', 'cancel-requested'].includes(c.control) ? c.status : 'controller-offline',
    recordedStatus: c.status,
    nextAction: c.next_action,
    nextWakeupAt: c.next_wakeup_at ? new Date(c.next_wakeup_at).toISOString() : null,
    blocker: c.blocker,
    livenessDefect: Boolean(c.liveness_defect),
    runsUsed: c.runs_used,
    maxWorkerRuns: campaignLimits(c.declaration).maxWorkerRuns,
    maxCostUsd: campaignLimits(c.declaration).maxCostUsd,
    budget: campaignBudget(store, c),
    executorOrder: executorOrder(c.declaration.executor).map((executor) => executor.kind),
    executorWaits: executorWaitsView(store, c),
    costUsd: Math.round(c.cost_usd * 10000) / 10000,
    costByUnit: routed.cost,
    ci: ci.summary,
    // Auto Release is built switched off (AUTO_RELEASE.md slice R2): report only, per done task. It never acts. The
    // owner's stops (slice R4) show only once used: RELEASE-STOP when the caller saw the file, and narrowed destinations.
    release: releaseView(store, c.declaration.target.projectId, tasks, releaseStop),
    tasks: tasks.map((t) => ({
      id: t.task_id, state: t.state, attempts: t.attempts, repairRounds: t.repair_rounds,
      headSha: t.head_sha, verifiedSha: t.verified_sha, prUrl: t.pr_url,
      retryAt: t.retry_at ? new Date(t.retry_at).toISOString() : null, blocked: t.blocked, lastError: t.last_error,
      ci: ci.tasks.get(t.task_id) ?? null,
      wait: waitReason(t, waits),
      routing: routed.tasks.get(t.task_id)?.routing ?? { implement: null, verify: null, escalation: null, sameProvider: null },
      costByUnit: routed.tasks.get(t.task_id)?.cost ?? emptyCost(),
      // A project without GitHub shows its verified local candidate (WORK_ENVELOPE slice E10), never a PR; only once one exists.
      ...withCandidate(store, c.id, t.task_id),
    })),
    openOperations: operations.map((op) => ({ id: op.id, taskId: op.task_id, kind: op.kind, executor: op.executor_kind ?? 'claude-cli', state: op.state,
      createdAt: new Date(op.created_at).toISOString(), updatedAt: new Date(op.updated_at).toISOString() })),
    ...(ownerBlockers.length ? { ownerBlockers } : {}),
  };
}

const withCandidate = (store, campaignId, taskId) => {
  const candidate = candidateStatus(store, campaignId, taskId);
  return candidate ? { candidate } : {};
};

// ---- "Why is this step waiting?" (ADAPTIVE_SCHEDULER section 6, slice S8 supervisor half: RUN9). ----

const RUNNABLE = ['pending', 'implemented', 'verified'];
const OWNER_NEXT = 'None; listed in Needs me';
const BLOCKER_TEXT = {
  budget: 'Needs your decision: this work program used its budget',
  auth: 'Needs you: an AI provider login failed',
  executors: 'Needs you: no allowed AI provider can run this work',
  'process-ownership': 'Needs you: a worker process could not be confirmed stopped',
  'project-governance': 'Needs you: the project rules could not be read',
  'publication-size': 'Needs you: a result is too large to publish',
  'research-context': 'Needs you: the research material is missing',
  'runtime-not-merged': 'Needs you: the supervisor code running here is not on main',
};
const PRESSURE_TEXT = { cpu: 'processor time', disk: 'disk space', heartbeats: 'headroom: workers report late' };
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const reason = (code, text, next, until = null, holder = null) => ({ code, text, next, until: iso(until), holder });

/** Tasks held by an open owner-intervention blocker (aiworks#1), as the controller's heldTasks: task id -> blocker class. */
function heldTasks(store, campaignId) {
  if (!hasTable(store, 'blocker_parents')) return new Map();
  const rows = store.all(`SELECT p.task_id, b.class, b.status, b.probe, b.next_recheck_at FROM blocker_parents p JOIN blockers b ON b.fingerprint = p.fingerprint
    WHERE p.campaign_id = ? AND p.released_at IS NULL AND b.status IN ('open', 'rechecking')`, campaignId);
  const probing = new Set(rows.filter((row) => row.status === 'rechecking' && row.probe?.campaignId === campaignId).map((row) => row.probe.taskId));
  return new Map(rows.filter((row) => !probing.has(row.task_id)).map((row) => [row.task_id, row]));
}

/** When every provider the campaign may use is waiting: the earliest timed reset, or null for an untimed wait; else undefined. */
function providersWaiting(store, c, tasks, now) {
  const waits = executorWaitsView(store, c).filter((row) => row.retry_at === null || row.retry_at > now);
  const kinds = executorOrder(c.declaration.executor).map((provider) => provider.kind);
  const quota = c.declaration.executor.kind === 'cli-chain' ? 0 : Math.max(0, ...tasks
    .filter((t) => t.retry_at > now && String(t.last_error ?? '').startsWith('quota:')).map((t) => t.retry_at));
  if (quota) return quota;
  if (!kinds.every((kind) => waits.some((row) => row.executor_kind === kind))) return undefined;
  const timed = waits.filter((row) => row.retry_at !== null).map((row) => row.retry_at);
  return timed.length === waits.length ? Math.min(...timed) : null;
}

/** The plain wait for a scheduler refusal (scheduler.mjs WAIT_REASONS); a write-domain holder is named from its declaration. */
function admissionReason(store, refusal) {
  switch (refusal.reason) {
    case 'campaign-fanout': return reason('campaign-fanout', 'Waiting for a free worker in this work program', 'Starts when a running step finishes');
    case 'host-capacity': return reason('host-capacity', 'This computer is running its maximum number of workers', 'Starts when one finishes');
    case 'host-pressure': return reason('host-pressure', `This computer is low on ${PRESSURE_TEXT[refusal.detail?.signal] ?? 'memory'}`, 'Starts when the computer has room again');
    case 'provider-concurrency': return reason('provider-concurrency', 'The AI provider asked to slow down', 'Starts when a run on that provider account finishes');
    case 'write-domain': {
      const first = refusal.detail.holders[0];
      const owner = store.campaign(first.campaignId);
      const spec = owner ? specOf(store, first.campaignId, first.taskId, owner.declaration) : undefined;
      const prUrl = store.task(first.campaignId, first.taskId)?.pr_url ?? null;
      const pr = first.reason === 'published-unmerged' && /\/pull\/(\d+)$/.exec(prUrl ?? '');
      const where = Array.isArray(spec?.writes) ? spec.writes.join(', ') : 'the same repository';
      return reason('write-domain', `Another step ("${spec?.title ?? first.taskId}") is changing ${where}${pr ? ` (PR #${pr[1]} not merged yet)` : ''}`,
        'Starts when that change is merged or dropped', null, { campaignId: first.campaignId, taskId: first.taskId, reason: first.reason, prUrl });
    }
    default: return reason('ready', 'Ready to start', 'Starts on the next turn');
  }
}

/**
 * Why one task is not finished, and what happens next without the owner: { code, text, next, until, holder }, or null
 * for a done task. The first check that applies, in a fixed order (ADAPTIVE_SCHEDULER section 6). With the scheduler on,
 * the admission part is scheduler.mjs admissionCheck itself, over the same rows, so status names the predicate that
 * refuses the step. Built only from supervisor fields (states, times, declaration titles and write domains, PR numbers):
 * never from worker output, a blocker's reason or an error text, so no report or owner-trigger text reaches a reason.
 * `snapshot` = { store, campaign, tasks, open (the campaign's open operations), held, now, config }.
 */
export function waitReason(task, { store, campaign: c, tasks, open, held = new Map(), now, config = null }) {
  if (task.state === 'done') return null;
  const running = open.find((op) => op.task_id === task.task_id);
  if (running) return reason('running', running.kind === 'verify' ? 'Being checked' : 'Being implemented', 'The result is recorded when the run ends');
  if (c.control === 'paused') return reason('paused', 'Paused by you', 'None until you resume it');
  if (c.control === 'cancel-requested' || c.control === 'cancelled') return reason('cancelled', 'Cancelled by you', 'None');
  if (task.blocked) {
    return reason('owner', task.blocked.class === 'B3' ? 'Needs your decision' : 'Stopped after repeated problems; needs your decision', OWNER_NEXT);
  }
  const hold = held.get(task.task_id);
  if (hold) {
    return hold.class === 'B3' ? reason('owner', 'Needs your decision', OWNER_NEXT)
      : reason('recheck', 'Held until a recorded problem clears', hold.next_recheck_at ? `Checked again at ${iso(hold.next_recheck_at)}` : 'Checked again automatically', hold.next_recheck_at);
  }
  if (c.blocker) return reason('owner', BLOCKER_TEXT[c.blocker.kind] ?? 'Needs you: this work program is stopped', OWNER_NEXT);
  const decl = c.declaration;
  const specs = specsOf(store, c.id, decl);
  const spec = specs.get(task.task_id) ?? { dependsOn: [] };
  const title = (id) => specs.get(id)?.title ?? id;
  const state = (id) => tasks.find((row) => row.task_id === id)?.state;
  const unfinished = spec.dependsOn.filter((id) => state(id) !== 'done');
  if (unfinished.length) return reason('dependency', `Waiting for "${title(unfinished[0])}" to finish`, 'Starts when that step is done');
  const error = String(task.last_error ?? '');
  if (error.startsWith('dependency-integration:')) {
    const missing = spec.dependsOn.find((id) => new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(error)) ?? spec.dependsOn[0];
    const dependency = tasks.find((row) => row.task_id === missing);
    const holder = { campaignId: c.id, taskId: missing, reason: 'dependency-integration',
      prUrl: dependency?.pr_url ?? null, verifiedSha: dependency?.verified_sha ?? null };
    const refreshFailed = error.endsWith(' (remote refresh unavailable)');
    const pr = /\/pull\/(\d+)$/.exec(holder.prUrl ?? '');
    return reason('integration', refreshFailed
      ? `Cannot check whether "${title(missing)}" is merged into ${decl.target.baseBranch}`
      : `Waiting for "${title(missing)}" to be merged into ${decl.target.baseBranch}${pr ? ` (PR #${pr[1]})` : ''}`,
    `Checks the base branch again automatically; starts after "${title(missing)}" is merged`, task.retry_at, holder);
  }
  if (task.retry_at > now) {
    return /^(quota:|waiting for executor availability)/.test(error)
      ? reason('provider-cooldown', `AI provider usage limit; resets at ${iso(task.retry_at)}`, `Tries again at ${iso(task.retry_at)}`, task.retry_at)
      : reason('retry-backoff', `Retrying after a failed attempt at ${iso(task.retry_at)}`, `Tries again at ${iso(task.retry_at)}`, task.retry_at);
  }
  if (task.state === 'verified') return reason('publishing', 'Checked; being published', 'Published on the next turn');
  const providerReset = providersWaiting(store, c, tasks, now);
  if (providerReset !== undefined) {
    return providerReset ? reason('provider-cooldown', `AI provider usage limit; resets at ${iso(providerReset)}`, `Tries again at ${iso(providerReset)}`, providerReset)
      : reason('provider-cooldown', 'The AI provider is unavailable', 'Tries again after a recheck succeeds');
  }
  const budget = campaignBudget(store, c);
  if (budget.exhausted && !open.length) return reason('owner', BLOCKER_TEXT.budget, OWNER_NEXT);
  if (!schedulerEnabled(config) || !hasTable(store, 'capacity')) {
    // Scheduler off: one worker at a time per campaign, the first runnable task in declaration order first.
    const first = tasks.find((row) => RUNNABLE.includes(row.state) && row.state !== 'verified' && !row.blocked && !held.has(row.task_id) &&
      !(row.retry_at > now) && specs.get(row.task_id)?.dependsOn.every((id) => state(id) === 'done'));
    return open.length || first?.task_id !== task.task_id ? admissionReason(store, { reason: 'campaign-fanout' }) : admissionReason(store, { reason: null });
  }
  if (budget.exhausted) return admissionReason(store, { reason: 'campaign-fanout' });
  const pressure = store.get("SELECT reason FROM capacity WHERE scope = 'host' AND id = 'pressure' AND value = 1");
  const waiting = new Set(executorWaitsView(store, c).filter((row) => row.retry_at === null || row.retry_at > now).map((row) => row.executor_kind));
  const kind = executorOrder(decl.executor).map((provider) => provider.kind).find((item) => !waiting.has(item));
  // Status cannot read the fetched base, so published work counts as unmerged until the controller sees it merged.
  const refusal = admissionCheck(store, { campaignId: c.id, taskId: task.task_id, kind: task.state === 'pending' ? 'implement' : 'verify', declaration: decl },
    { ceiling: hostCeiling(config), pressure: pressure ? { signal: pressure.reason } : null, accountFull: () => (kind ? accountFull(store, config, kind) : null) });
  return admissionReason(store, refusal ?? { reason: null });
}

// ---- Model, tier, cost by unit and the reason a step moved up (MODEL_ROUTING section 9 "What the owner sees", slice R6
// supervisor half: MOD6). Built from operation rows and their routing receipts only. Costs stay in the unit each provider
// reports: reported dollars, tokens per provider, and a count of runs whose dollars are unknown. Units are never added
// together, and unknown is never shown as zero. ----

export const TIER_NAMES = { 1: 'economy', 2: 'standard', 3: 'strongest' };
const STAGES = ['implement', 'verify'];
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
// The poor-quality outcomes that move a step up (MODEL_ROUTING 5.4), by stage, as owner words. Only these fixed labels
// enter a reason: never worker output, an error detail or the router's own reason text.
const POOR = {
  implement: { rejected: 'rejected', 'evidence-unavailable': 'without evidence', 'invalid-result': 'unusable', 'exit-without-result': 'unusable', timeout: 'timed-out' },
  verify: { 'invalid-result': 'unusable', 'exit-without-result': 'unusable', timeout: 'timed-out' },
};

function emptyCost() {
  return { usd: { reported: null, reportedRuns: 0 }, tokens: {}, unknownCostRuns: 0 };
}

/** One counted run into a cost record. Dollars count as reported only when above zero, the rule campaignBudget uses. */
function addCost(cost, op) {
  const receipt = op.outcome?.receipt;
  if (receipt?.costUsd > 0) {
    cost.usd.reported = Math.round(((cost.usd.reported ?? 0) + receipt.costUsd) * 10000) / 10000;
    cost.usd.reportedRuns += 1;
  } else cost.unknownCostRuns += 1;
  const usage = receipt?.usage;
  if (!usage) return;
  const tokens = cost.tokens[op.executor_kind ?? 'claude-cli'] ??= { runs: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, inputIncludesCacheReadRuns: 0 };
  tokens.runs += 1;
  for (const key of ['input', 'output', 'cacheRead', 'cacheCreation']) if (Number.isFinite(usage[key])) tokens[key] += usage[key];
  if (usage.inputIncludesCacheRead) tokens.inputIncludesCacheReadRuns += 1;
}

/** The model of one run, from its own receipt. A run recorded before receipts, or a provider with no declared model, is null: unknown. */
function modelView(op) {
  const chosen = op.routing?.decision?.chosen ?? null;
  const tier = Number.isInteger(chosen?.tier) ? chosen.tier : null;
  return { operationId: op.id, executor: op.executor_kind ?? 'claude-cli', model: chosen?.model ?? null, tier, tierName: TIER_NAMES[tier] ?? null,
    routed: op.routing?.mode === 'auto' };
}

/**
 * The newest move up of one step: a routed run whose receipt says it escalated to a higher tier than the attempt before it.
 * The reason counts that attempt's tier's poor-quality outcomes from the receipt's own priorAttempts.
 */
function escalationView(ops) {
  for (const op of [...ops].reverse()) {
    const decision = op.routing?.mode === 'auto' ? op.routing.decision : null;
    const to = decision?.escalation?.escalated ? decision.chosen?.tier : null;
    const attempts = op.routing?.inputs?.escalation?.priorAttempts ?? [];
    const from = attempts[0]?.tier ?? null;
    if (!Number.isInteger(to) || !Number.isInteger(from) || to <= from) continue;
    const labels = POOR[op.kind] ?? {};
    const counts = new Map();
    for (const attempt of attempts) {
      const label = attempt.tier !== from ? null : attempt.class === 'result' ? labels[attempt.terminal] : labels[attempt.class];
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const noun = op.kind === 'verify' ? 'review' : 'attempt';
    const parts = [...counts].map(([label, n]) => `${WORDS[n] ?? n} ${label} ${noun}${n === 1 ? '' : 's'}`);
    const after = parts.length ? parts.join(' and ') : 'poor-quality results';
    return { stage: op.kind, operationId: op.id, fromTier: from, toTier: to, toTierName: TIER_NAMES[to] ?? null,
      reason: `Moved to the ${TIER_NAMES[to] ?? `tier ${to}`} model after ${after}` };
  }
  return null;
}

// Owner words for the static router's exclusion filters and for the failure a retry follows. Fixed labels only.
const PROVIDER_NAMES = { 'claude-cli': 'Claude', 'codex-cli': 'Codex', 'cursor-cli': 'Cursor', 'agy-cli': 'AGY' };
const EXCLUDED = { 'research-only': 'may only research', 'web-mismatch': 'does not take this kind of step', 'cli-not-configured': 'is not set up here',
  'role-unsupported': 'may not take this step on this computer', 'host-unavailable': 'is unavailable on this computer', 'account-wait': 'is waiting for its account' };
const FAILED = { timeout: 'timed out', 'invalid-result': 'returned an unusable result', 'exit-without-result': 'ended without a result',
  'evidence-unavailable': 'returned no evidence', error: 'failed', lost: 'was lost' };

/**
 * Why the newest run stayed on the provider that failed the attempt before it (static receipt basis "failed-provider-only"):
 * each other declared provider and the first filter that excluded it. Null when the newest run moved to another provider
 * or followed no failure. Fixed labels only, as escalationView.
 */
function sameProviderView(ops) {
  const op = ops.at(-1);
  const decision = op?.routing?.mode === 'static' ? op.routing.decision : null;
  if (decision?.basis !== 'failed-provider-only') return null;
  const name = (kind) => PROVIDER_NAMES[kind] ?? 'another provider';
  const role = op.kind === 'verify' ? 'verification' : 'implementer';
  const others = (decision.eligibility ?? []).filter((item) => item.role === role && item.kind !== decision.chosen.kind && item.reasons?.length)
    .map((item) => `${name(item.kind)} ${EXCLUDED[item.reasons[0]] ?? 'may not take it'}`);
  const last = op.routing.inputs?.escalation?.priorAttempts?.[0] ?? null;
  const failed = (last?.class === 'result' ? FAILED[last.terminal] : FAILED[last?.class]) ?? 'failed';
  return { stage: op.kind, operationId: op.id, provider: decision.chosen.kind,
    reason: `${name(decision.chosen.kind)} again: the last ${op.kind === 'verify' ? 'review' : 'attempt'} ${failed}, and ${others.length ? others.join(', ') : 'no other provider is declared'}` };
}

/**
 * Per task: the model and tier of its newest implement and verify run, the newest move up and its cost by unit; and the
 * campaign's cost by unit. Counted runs only (runNotCounted, as campaignBudget): open runs have no cost yet.
 */
function routingView(store, campaignId) {
  const ops = store.all("SELECT * FROM operations WHERE campaign_id = ? ORDER BY created_at, seq", campaignId);
  const cost = emptyCost();
  const tasks = new Map();
  for (const op of ops) {
    const item = tasks.get(op.task_id) ?? { routing: { implement: null, verify: null, escalation: null, sameProvider: null }, cost: emptyCost(), steps: [] };
    tasks.set(op.task_id, item);
    const finished = op.state === 'finished';
    if (finished && runNotCounted(op.outcome)) continue;
    if (STAGES.includes(op.kind)) {
      item.routing[op.kind] = modelView(op);
      item.steps.push(op);
    }
    if (finished) { addCost(cost, op); addCost(item.cost, op); }
  }
  for (const item of tasks.values()) {
    item.routing.escalation = escalationView(item.steps);
    item.routing.sameProvider = sameProviderView(item.steps);
  }
  return { cost, tasks };
}

const CI_STATE = { 'ci-pending': 'pending', 'ci-passed': 'success', 'ci-failed': 'failure', 'ci-inconclusive': 'inconclusive', 'ci-none': 'none' };

/**
 * CI of each published commit head, from the controller's journal only (aiworks#42): status never calls GitHub. A head
 * whose CI was never read is `unknown`, also while CI repair is switched off. Only `success` means CI passed; the
 * campaign summary is `success` only when every published head passed, and `failure` when any failed.
 */
function ciView(store, c, tasks) {
  const specs = specsOf(store, c.id, c.declaration);
  const latest = new Map();
  for (const row of store.all(`SELECT kind, detail, at FROM journal WHERE campaign_id = ? AND kind IN (${Object.keys(CI_STATE).map(() => '?').join(', ')}) ORDER BY seq`, c.id, ...Object.keys(CI_STATE))) {
    latest.set(`${row.detail?.task}:${row.detail?.sha}`, row);
  }
  const view = new Map();
  for (const t of tasks) {
    if (specs.get(t.task_id)?.deliverable !== 'commit' || !t.pr_url || !t.verified_sha) continue;
    const row = latest.get(`${t.task_id}:${t.verified_sha}`);
    view.set(t.task_id, row ? { state: CI_STATE[row.kind], sha: t.verified_sha, checkedAt: new Date(row.at).toISOString(), checks: row.detail.checks ?? [] }
      : { state: 'unknown', sha: t.verified_sha, checkedAt: null, checks: [] });
  }
  const states = [...view.values()].map((item) => item.state);
  const summary = !states.length ? null : states.includes('failure') ? 'failure' : states.every((state) => state === 'success') ? 'success'
    : states.includes('pending') ? 'pending' : 'unknown';
  return { tasks: view, summary };
}

/**
 * A restart takes over expired leases on its first tick (tickMs, 5 s by default), and keep restarts serve within about
 * 10 s. Leases must have been expired this long before the supervisor reads as stopped, so a handover never does.
 */
export const STOPPED_AFTER_MS = 60_000;

/**
 * Whether the supervisor is running, from the store's leases alone (aiworks#18). A running controller renews the lease
 * of every campaign that is registered, paused or cancelling (or has a pending outbox) on every tick, so with such a
 * campaign present and every lease expired for STOPPED_AFTER_MS, no controller is running: state 'stopped'. A
 * controller that renews its leases is never reported stopped.
 * lastLeaseRenewalAt is derived as expiry minus leaseMs (the controller's lease length, from config.json): exact when
 * the supervisor died, up to leaseMs early after a graceful stop, which expires its leases at once. leaseEndedAt is
 * exact in both cases. Without such a campaign a running controller may hold no lease, so nothing is claimed ('idle');
 * with one but no lease ever recorded, no controller has run against this store ('not-started').
 * stopRequested: the caller saw <data>/STOP, written by `cli.mjs stop` and by deploy.ps1 during an upgrade.
 */
export function supervisorLiveness(store, { now = Date.now(), leaseMs, stopRequested = false } = {}) {
  const iso = (ms) => new Date(ms).toISOString();
  const leases = store.all('SELECT campaign_id, acquired_at, expires_at FROM leases');
  const expected = store.get(`SELECT COUNT(*) AS n FROM campaigns WHERE control IN ('registered', 'paused', 'cancel-requested')
    OR EXISTS (SELECT 1 FROM outbox WHERE campaign_id = campaigns.id AND state = 'pending')`).n;
  const live = leases.filter((lease) => lease.expires_at > now);
  const ended = leases.length ? Math.max(...leases.map((lease) => lease.expires_at)) : null;
  const renewed = leases.length ? Math.max(...leases.map((lease) => Math.max(lease.acquired_at, lease.expires_at - leaseMs))) : null;
  const state = live.length ? 'running' : !expected ? 'idle' : !leases.length ? 'not-started'
    : now - ended >= STOPPED_AFTER_MS ? 'stopped' : 'restarting';
  const stop = stopRequested ? '; a STOP file is present (an upgrade or an operator stop is in progress)' : '';
  const message = state === 'stopped' ? `supervisor stopped; last lease renewal at ${iso(renewed)}${stop}`
    : state === 'not-started' ? `supervisor not started: no controller has run against this store${stop}`
      : state === 'restarting' ? `supervisor leases expired at ${iso(ended)}; waiting for a restart to take over${stop}`
        : state === 'idle' ? `no campaign needs a controller, so liveness is not known from leases${stop}` : `supervisor running${stop}`;
  return { state, stopped: state === 'stopped', liveLeases: live.length, lastLeaseRenewalAt: renewed === null ? null : iso(renewed),
    leaseEndedAt: ended === null ? null : iso(ended), stopRequested, message };
}

/** aiworks#1 blocker records this campaign references. An unmigrated store read-only, or the feature off, yields none. */
function ownerBlockerView(store, campaignId) {
  if (!store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'blocker_parents'")) return [];
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  return store.all(`SELECT DISTINCT b.* FROM blockers b JOIN blocker_parents p ON p.fingerprint = b.fingerprint
    WHERE p.campaign_id = ? ORDER BY b.first_detected_at`, campaignId).map((b) => ({
    fingerprint: b.fingerprint, class: b.class, dependency: b.dependency, status: b.status, episode: b.episode,
    summary: b.summary, requestedAction: b.requested_action, recheck: b.recheck_procedure, probe: b.probe,
    firstDetectedAt: iso(b.first_detected_at), occurrences: b.occurrences, recheckAttempts: b.recheck_attempts,
    nextRecheckAt: iso(b.next_recheck_at), acknowledgedAt: iso(b.acknowledged_at), lastEvidence: b.last_evidence,
    resolution: b.resolution, resolvedAt: iso(b.resolved_at),
    parents: store.all('SELECT campaign_id, task_id, phase, released_at FROM blocker_parents WHERE fingerprint = ? ORDER BY campaign_id, task_id', b.fingerprint)
      .map((p) => ({ campaignId: p.campaign_id, taskId: p.task_id, phase: p.phase, releasedAt: iso(p.released_at) })),
    notifications: store.all('SELECT key, kind, state, attempts, last_error FROM owner_notifications WHERE fingerprint = ? ORDER BY created_at', b.fingerprint)
      .map((n) => ({ key: n.key, kind: n.kind, state: n.state, attempts: n.attempts, lastError: n.last_error })),
  }));
}

/**
 * Owner Acknowledge (OWNER_INTERVENTION §9): records that the owner saw the blocker. It is a trigger for nothing:
 * it never rechecks, resolves or resumes anything. Use recheck after acting.
 */
export function blockerAcknowledge(store, fingerprint, now = Date.now()) {
  return store.tx(() => {
    const record = store.blocker(fingerprint);
    if (!record) throw new CampaignError('NOT_FOUND', `no blocker ${fingerprint}`);
    if (record.status !== 'resolved' && !record.acknowledged_at) store.run('UPDATE blockers SET acknowledged_at = ?, updated_at = ? WHERE fingerprint = ?', now, now, fingerprint);
    store.journal(null, 'blocker-acknowledged', { fingerprint }, now);
    return store.blocker(fingerprint);
  });
}

function setControl(store, id, allowed, control, kind, detail, now) {
  store.tx(() => {
    const c = store.campaign(id);
    if (!c) throw new CampaignError('NOT_FOUND', `campaign ${id} is not registered`);
    if (!allowed.includes(c.control)) throw new CampaignError('INVALID_STATE', `cannot ${kind} a campaign in control state ${c.control}`);
    store.patch('campaigns', { id }, c.version, { control }, now);
    store.journal(id, kind, detail, now);
  });
  return campaignStatus(store, id, now);
}

/** Stop new dispatch; in-flight operations finish and their results are still recorded. */
export const campaignPause = (store, id, reason = null, now = Date.now()) =>
  setControl(store, id, ['registered'], 'paused', 'paused', { reason }, now);

/** Stop new dispatch and terminate owned in-flight runs; the controller records the effects. */
export const campaignCancel = (store, id, reason = null, now = Date.now()) =>
  setControl(store, id, ['registered', 'paused'], 'cancel-requested', 'cancel-requested', { reason }, now);

/** Durable owner/recovery event: the controller re-evaluates blockers on its next tick. */
export function campaignRecheck(store, id, { task = null, note = null } = {}, now = Date.now()) {
  if (!store.campaign(id)) throw new CampaignError('NOT_FOUND', `campaign ${id} is not registered`);
  store.tx(() => store.addEvent(id, 'recheck', { task, note }, null, now));
  return campaignStatus(store, id, now);
}
