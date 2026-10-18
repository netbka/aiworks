// The scheduler's admission rules (docs/design/ADAPTIVE_SCHEDULER.md sections 4.1, 4.2, 4.4, 4.5 and 4.6; slices RUN5, RUN7 and RUN8), as
// functions over the store's rows. Behind config.scheduler.enabled (default off) the controller settles each campaign,
// collects its candidates, orders them with orderCandidates and admits at most one per tick: the first candidate whose
// admissionCheck returns null, checked again inside the transaction that records its operation. Nothing here keeps
// authoritative state in memory: open operations, task states, write-domain holders, account waits and the learned
// fan-out are all rows, so a restarted or second controller sees exactly what this one saw.
import { availableParallelism } from 'node:os';
import { campaignLimits } from './campaign.mjs';
import { domainHolders, domainOf } from './work-ownership.mjs';
import { runNotCounted } from './adapters/executors.mjs';
import { openRunBeats } from './host.mjs';

/**
 * The wait reasons, in the order they are checked. A waiting step always has exactly one: the first that applies.
 * 'launch-turn' is the controller's, after the checks: admissible, but this tick already started one operation.
 */
export const WAIT_REASONS = Object.freeze(['already-running', 'campaign-fanout', 'host-capacity', 'host-pressure', 'write-domain', 'provider-cooldown', 'provider-concurrency', 'launch-turn']);

export const schedulerEnabled = (config) => config?.scheduler?.enabled === true;

/**
 * At most this many worker operations at once across all campaigns on this host: config.scheduler.maxWorkers (1..32),
 * or clamp(floor(cores / 4), 1, 4), because workers run full test suites. This is host safety, not an AW-002 limit: it
 * never stops a campaign, counts runs or money, or notifies the owner. It only says "not now".
 */
export function hostCeiling(config, cores = availableParallelism()) {
  const set = config?.scheduler?.maxWorkers;
  if (Number.isSafeInteger(set) && set >= 1 && set <= 32) return set;
  return Math.min(4, Math.max(1, Math.floor(cores / 4)));
}

/** The campaign's own upper bound on parallel operations: declared slots 1..8, or the host ceiling for "auto". */
export function fanoutBound(declaration, ceiling) {
  const slots = campaignLimits(declaration).slots;
  return slots === 'auto' ? ceiling : slots;
}

/** The campaign's learned fan-out (section 4.4): starts at 1, never above its bound, kept in the `capacity` table. */
export function currentFanout(store, campaignId, bound) {
  const row = store.get("SELECT value FROM capacity WHERE scope = 'campaign' AND id = ?", campaignId);
  return Math.max(1, Math.min(bound, row?.value ?? 1));
}

const FAILED = new Set(['lost', 'timeout', 'exit-without-result', 'invalid-result', 'spawn-failed', 'error']);

/**
 * How a finished run counts for fan-out: 'useful' (an implementer resolved and passed the commit checks, or a verifier
 * accepted, or rejected with a blocking finding: it found a real problem), 'failed' (lost, timed out, no or invalid
 * result, failed launch, error, or evidence-unavailable), or 'neutral' (refunded runs, provider waits, everything else).
 */
export function classifyRun(kind, outcome) {
  if (!outcome || runNotCounted(outcome)) return 'neutral';
  if (FAILED.has(outcome.class)) return 'failed';
  if (outcome.class !== 'result') return 'neutral';
  const value = outcome.value ?? {};
  if (value.result === 'evidence-unavailable' || value.verdict === 'evidence-unavailable') return 'failed';
  if (kind === 'implement') return value.result === 'resolved' ? 'useful' : 'neutral';
  if (value.verdict === 'accepted') return 'useful';
  return value.verdict === 'rejected' && (value.findings ?? []).some((finding) => finding.severity === 'blocking') ? 'useful' : 'neutral';
}

/** Two failed runs of the campaign within one window: thrash, which drops fan-out to 1. */
export function thrashing(store, campaignId, now, windowMs) {
  const recent = store.all("SELECT kind, outcome FROM operations WHERE campaign_id = ? AND state = 'finished' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 8",
    campaignId, now - windowMs);
  return recent.filter((op) => classifyRun(op.kind, op.outcome) === 'failed').length >= 2;
}

/**
 * Adjust the learned fan-out after a run finished (section 4.4): +1 for a useful result while another candidate of the
 * campaign waited only for fan-out; -1 (minimum 1) for a failed run; back to 1 on thrash. Every change is journalled.
 */
export function adjustFanout(store, { campaignId, bound, run, waited = false, thrash = false, now }) {
  const before = currentFanout(store, campaignId, bound);
  let after = before, reason = null;
  if (thrash && before > 1) { after = 1; reason = 'thrash: two failed runs within one backoff window'; }
  else if (run === 'failed' && before > 1) { after = before - 1; reason = 'a run failed'; }
  else if (run === 'useful' && waited && before < bound) { after = before + 1; reason = 'a useful result while work waited for fan-out'; }
  if (after === before) return before;
  store.run(`INSERT INTO capacity (scope, id, value, reason, updated_at) VALUES ('campaign', ?, ?, ?, ?)
    ON CONFLICT (scope, id) DO UPDATE SET value = excluded.value, reason = excluded.reason, updated_at = excluded.updated_at`, campaignId, after, reason, now);
  store.journal(campaignId, after > before ? 'fanout-raised' : 'fanout-lowered', { from: before, to: after, reason }, now);
  return after;
}

/**
 * The host pressure gate (section 4.6, slice RUN7): one sample per admission pass from `sampler` (host.mjs), over the
 * heartbeats of every open run. Returns null or { signal, detail }, which admissionCheck turns into a 'host-pressure'
 * wait for every candidate; open operations are never touched. An episode is one row, capacity ('host', 'pressure'):
 * the pass that starts it journals 'host-pressure' with the signal, the pass that ends it 'host-pressure-cleared'. Each
 * is a conditional write, so a restarted or second controller never journals the same episode twice.
 */
export function hostPressure(store, sampler, now) {
  const pressure = sampler.sample({ now, beats: openRunBeats(store) });
  if (pressure) {
    const started = store.run(`INSERT INTO capacity (scope, id, value, reason, updated_at) VALUES ('host', 'pressure', 1, ?, ?)
      ON CONFLICT (scope, id) DO UPDATE SET value = 1, reason = excluded.reason, updated_at = excluded.updated_at WHERE capacity.value = 0`,
    pressure.signal, now);
    if (started.changes === 1) store.journal(null, 'host-pressure', pressure, now);
  } else {
    const row = store.get("SELECT reason FROM capacity WHERE scope = 'host' AND id = 'pressure' AND value = 1");
    const ended = store.run("UPDATE capacity SET value = 0, updated_at = ? WHERE scope = 'host' AND id = 'pressure' AND value = 1", now);
    if (ended.changes === 1) store.journal(null, 'host-pressure-cleared', { signal: row?.reason ?? null }, now);
  }
  return pressure;
}

/**
 * Fair order (section 4.2): the project whose most recent admitted operation is oldest first (never served first),
 * then the least recently served campaign in it, then campaign age and id; within a campaign verify before implement,
 * then declaration order. "Served" is MAX(operations.created_at), derived from rows: there is no fairness state to lose.
 * A candidate is { campaignId, taskId, kind: 'implement' | 'verify', ord, declaration, createdAt }.
 */
export function orderCandidates(store, candidates) {
  const served = new Map(store.all('SELECT campaign_id, MAX(created_at) AS at FROM operations GROUP BY campaign_id').map((row) => [row.campaign_id, row.at]));
  const project = (c) => `${c.declaration.target.tenantId}\u0000${c.declaration.target.projectId}`;
  const projectServed = new Map();
  for (const c of candidates) {
    const at = served.get(c.campaignId) ?? -Infinity;
    projectServed.set(project(c), Math.max(projectServed.get(project(c)) ?? -Infinity, at));
  }
  // A project's other campaigns count too, even when they have no candidate now.
  for (const row of store.all('SELECT id, declaration FROM campaigns')) {
    const key = row.declaration?.target ? `${row.declaration.target.tenantId}\u0000${row.declaration.target.projectId}` : null;
    if (key && projectServed.has(key)) projectServed.set(key, Math.max(projectServed.get(key), served.get(row.id) ?? -Infinity));
  }
  return [...candidates].sort((a, b) =>
    (projectServed.get(project(a)) - projectServed.get(project(b))) ||
    ((served.get(a.campaignId) ?? -Infinity) - (served.get(b.campaignId) ?? -Infinity)) ||
    ((a.createdAt ?? 0) - (b.createdAt ?? 0)) || a.campaignId.localeCompare(b.campaignId) ||
    ((a.kind === 'verify' ? 0 : 1) - (b.kind === 'verify' ? 0 : 1)) || (a.ord - b.ord));
}

/**
 * The one reason this candidate waits, or null when it may start now (section 4.1). Checked in WAIT_REASONS order, from
 * rows only, so the controller can call it again inside the recording transaction. `providerWaiting(candidate)` tells
 * whether every authorized provider for it is waiting (the controller's executorChoice); `pressure` is this pass's
 * hostPressure sample (null: none), which can only refuse; `integrated(campaignId, taskRow, declaration)` releases a published domain once it is in its base.
 * `accountFull(candidate)` returns null, or the account of the provider the candidate would get when that account
 * throttled earlier and is at its learned limit (accounts.mjs accountFull, slice RUN8).
 */
export function admissionCheck(store, candidate, { ceiling, pressure = null, providerWaiting = () => false, accountFull = () => null, integrated = () => false }) {
  const open = store.all("SELECT campaign_id, task_id FROM operations WHERE state IN ('recorded', 'dispatched')");
  if (open.some((op) => op.campaign_id === candidate.campaignId && op.task_id === candidate.taskId)) return { reason: 'already-running' };
  const bound = fanoutBound(candidate.declaration, ceiling);
  const fanout = currentFanout(store, candidate.campaignId, bound);
  if (open.filter((op) => op.campaign_id === candidate.campaignId).length >= fanout) return { reason: 'campaign-fanout', detail: { fanout } };
  if (open.length >= ceiling) return { reason: 'host-capacity', detail: { ceiling } };
  if (pressure) return { reason: 'host-pressure', detail: pressure };
  if (candidate.kind === 'implement') {
    const spec = candidate.declaration.tasks.find((task) => task.id === candidate.taskId);
    const holders = domainHolders(store, { campaignId: candidate.campaignId, taskId: candidate.taskId, domain: domainOf(candidate.declaration, spec) }, { integrated });
    if (holders.length) return { reason: 'write-domain', detail: { holders } };
  }
  if (providerWaiting(candidate)) return { reason: 'provider-cooldown' };
  const full = accountFull(candidate);
  if (full) return { reason: 'provider-concurrency', detail: full };
  return null;
}
