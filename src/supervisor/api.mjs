// AIWorks campaign interface: start, status, pause, cancel, recheck. These are owner
// actions: they change durable state with compare-and-swap and never dispatch work
// themselves. Readiness is derived from a live controller lease, never from registration.
import { runNotCounted } from './adapters/executors.mjs';
import { authorityDigest, campaignLimits, canonicalJson, executorOrder, scopeDigest, validateDeclaration } from './campaign.mjs';
import { findWorkConflict } from './work-ownership.mjs';

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
    if (existing.scope_digest !== scope &&
        scopeDigest({ ...decl, executor: existing.declaration.executor }) !== existing.scope_digest) {
      throw new CampaignError('SCOPE_CONFLICT', `campaign ${decl.campaignId} exists with a different immutable scope; register a new campaign id`);
    }
    if (executorChanged && (existing.control !== 'paused' || store.openOperations(decl.campaignId).length)) {
      throw new CampaignError('EXECUTOR_HANDOVER_REQUIRED', 'executor amendment requires a paused campaign with no open operations');
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
  const unknownRuns = store.all("SELECT outcome FROM operations WHERE campaign_id = ? AND state = 'finished'", c.id)
    .filter((op) => !runNotCounted(op.outcome) && !(op.outcome?.receipt?.costUsd > 0)).length;
  const maxCostUsd = limits.maxCostUsd ?? null;
  const unknownRunCostUsd = limits.unknownRunCostUsd ?? null;
  const charged = maxCostUsd !== null ? Math.round((measured + unknownRuns * (unknownRunCostUsd ?? 0)) * 10000) / 10000 : null;
  const exhausted = limits.maxWorkerRuns !== null && c.runs_used >= limits.maxWorkerRuns ? `worker-run cap reached (${c.runs_used}/${limits.maxWorkerRuns})`
    : maxCostUsd !== null && charged >= maxCostUsd ? `cost ceiling reached ($${charged.toFixed(2)} charged of $${maxCostUsd.toFixed(2)}; ${unknownRuns} run(s) with unreported cost priced at $${(unknownRunCostUsd ?? 0).toFixed(2)})`
      : null;
  return { runsUsed: c.runs_used, maxWorkerRuns: limits.maxWorkerRuns, measuredCostUsd: measured, unknownCostRuns: unknownRuns,
    unknownRunCostUsd, chargedCostUsd: charged, maxCostUsd, exhausted };
}

export function campaignStatus(store, id, now = Date.now()) {
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
  const runnable = tasks.filter((t) => !t.blocked && ['pending', 'implemented', 'verified'].includes(t.state) &&
    c.declaration.tasks.find((spec) => spec.id === t.task_id).dependsOn.every((dep) => done.has(dep)));
  const chainWaiting = !operations.length && runnable.length && runnable.every((t) => t.state !== 'verified' && t.retry_at > now &&
    /^(quota:|waiting for executor availability:)/.test(String(t.last_error ?? '')));
  const providerWaitUntil = c.declaration.executor.kind === 'cli-chain'
    ? chainWaiting ? Math.min(...runnable.map((t) => t.retry_at)) : 0 : legacyWaitUntil;
  const ownerBlockers = ownerBlockerView(store, id);
  return {
    campaignId: c.id,
    store: store.identity,
    observedAt: new Date(now).toISOString(),
    phase: !live ? readiness : c.control !== 'registered' ? readiness
      : c.blocker ? c.status : operations.length ? operations[0].kind
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
    executorWaits: store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'executor_waits'")
      ? store.all('SELECT executor_kind, retry_at, reason FROM executor_waits WHERE campaign_id = ?', id) : [],
    costUsd: Math.round(c.cost_usd * 10000) / 10000,
    tasks: tasks.map((t) => ({
      id: t.task_id, state: t.state, attempts: t.attempts, repairRounds: t.repair_rounds,
      headSha: t.head_sha, verifiedSha: t.verified_sha, prUrl: t.pr_url,
      retryAt: t.retry_at ? new Date(t.retry_at).toISOString() : null, blocked: t.blocked, lastError: t.last_error,
    })),
    openOperations: operations.map((op) => ({ id: op.id, taskId: op.task_id, kind: op.kind, executor: op.executor_kind ?? 'claude-cli', state: op.state,
      createdAt: new Date(op.created_at).toISOString(), updatedAt: new Date(op.updated_at).toISOString() })),
    ...(ownerBlockers.length ? { ownerBlockers } : {}),
  };
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
