// Release state, the destination lock and reconciliation (docs/design/AUTO_RELEASE.md sections 7.1 and 8, slice REL3).
// Built switched off: nothing outside the tests calls this module until the owner decides example-org/aiworks#33. The rules:
// - one release per destination: the lock is taken in the same fenced transaction that re-checks eligibility and moves
//   the release to `locked`. It is freed only at accepted, rolled-back or refused; `unknown` and `rollback-failed` keep it;
// - intent before effect: a step is recorded started, with its key and no outcome, and committed before the adapter acts;
// - reconcile, never repeat: a started step with no outcome is `unknown` after a restart or a takeover until a read-only
//   look at the destination proves where it is. A read failure is never evidence. A step runs again only when every
//   earlier run of it was proven not done;
// - fencing as today: every write asserts the campaign lease, and a release last acted on under an older lease
//   generation is reconciled before the new holder may act on it.
// The adapter is injected (REL6 to REL8 supply real ones; tests use a fake):
//   run(release, step)     -> { outcome: 'done' | 'failed' | 'refused', mergeCommit?, deployedDigest?, previousDigest?, backupPath? }
//   observe(release, step) -> { outcome: 'done' | 'failed' | 'not-done' | 'unknown', ...the same optional fields }
// A plain outcome string is accepted for either. A throw, or any other answer, is an unknown outcome.
// The switches (slice REL4, AUTO_RELEASE.md sections 3 and 4.5) are checked before every step: release.enabled in
// config.json, the RELEASE-STOP file, a valid grant and the destination's mode. A stop prevents the next step, never
// recovery: a check after a forward step, and a rollback, still run.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const FORWARD_STEPS = Object.freeze(['merge', 'deploy', 'apply', 'check']);
export const TERMINAL = Object.freeze(['accepted', 'rolled-back', 'refused']);
const RUNNING = { merge: 'merging', deploy: 'deploying', apply: 'applying', check: 'checking', rollback: 'rolling-back' };
const DONE = { merge: 'merged', deploy: 'deployed', apply: 'applied', check: 'accepted', rollback: 'rolled-back' };
const RECORDED = { mergeCommit: 'merge_commit', deployedDigest: 'deployed_digest', previousDigest: 'previous_digest', backupPath: 'backup_path' };
const SHA = /^[0-9a-f]{40}$/;

/** The lock key of one destination: `<project>.<destination>` (AUTO_RELEASE.md 7.1). */
export const destinationKey = (project, destination) => `${project}.${destination}`;

export const release = (store, id) => store.get('SELECT * FROM releases WHERE id = ?', id);

/** Who holds a destination, for E11: { free, releaseId, state }. An unknown or rollback-failed holder keeps it taken. */
export function destinationState(store, project, destination) {
  const lock = store.get('SELECT release_id FROM release_locks WHERE destination = ?', destinationKey(project, destination));
  return lock ? { free: false, releaseId: lock.release_id, state: release(store, lock.release_id)?.state ?? null } : { free: true, releaseId: null, state: null };
}

const fenced = (store, campaignId, lease, now) => store.assertLease(campaignId, lease?.instanceId, lease?.generation, now);

function validSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0 || new Set(steps).size !== steps.length || steps.some((step) => !FORWARD_STEPS.includes(step))) {
    throw new Error(`release steps must be distinct names from ${FORWARD_STEPS.join(', ')}`);
  }
  if (steps.at(-1) !== 'check') throw new Error('a release ends with its check step');
  return steps;
}

/**
 * Record a release attempt of one exact verified revision to one destination, state `eligible`, no lock yet. Its id is
 * the unique idempotency key `<project>.<destination>.<verified_sha>.<attempt>`; a later attempt gets the next number.
 */
export function createRelease(store, { project, destination, campaignId, taskId, verifiedSha, grantVersion = null, grantDigest = null,
  steps, lease, now }) {
  if (!SHA.test(verifiedSha ?? '')) throw new Error('a release needs the exact 40-character verified SHA');
  validSteps(steps);
  return store.tx(() => {
    fenced(store, campaignId, lease, now);
    const last = store.get('SELECT MAX(attempt) AS attempt FROM releases WHERE project = ? AND destination = ? AND verified_sha = ?', project, destination, verifiedSha);
    const attempt = (last?.attempt ?? 0) + 1;
    const id = `${destinationKey(project, destination)}.${verifiedSha}.${attempt}`;
    store.insert('releases', { id, idempotency_key: id, project, destination, campaign_id: campaignId, task_id: taskId, verified_sha: verifiedSha,
      attempt, grant_version: grantVersion, grant_digest: grantDigest, steps, state: 'eligible', history: [],
      instance_id: lease.instanceId, generation: lease.generation, created_at: now, updated_at: now });
    store.journal(campaignId, 'release-created', { release: id, task: taskId }, now);
    return release(store, id);
  });
}

const update = (store, id, changes, now) => {
  const keys = Object.keys(changes);
  store.run(`UPDATE releases SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((key) => changes[key]), now, id);
  return release(store, id);
};

/**
 * Take the destination's lock. Inside one fenced transaction: wait (not an error) when another release holds it, else
 * run `recheck()` (the synchronous eligibility evaluator of release/eligibility.mjs) and either move to `locked` with the
 * lock, or to `refused` without it. A missing, throwing or asynchronous re-check, or a grant digest other than the one
 * the release was created with, refuses. Returns { locked, refused, waitingFor, release }.
 */
export function acquireLock(store, id, { lease, now, recheck }) {
  return store.tx(() => {
    const r = release(store, id);
    if (!r) throw new Error(`no release ${id}`);
    fenced(store, r.campaign_id, lease, now);
    const key = destinationKey(r.project, r.destination);
    const held = store.get('SELECT release_id FROM release_locks WHERE destination = ?', key);
    if (held?.release_id === id) return { locked: true, refused: false, waitingFor: null, release: r };
    if (r.state !== 'eligible') throw new Error(`release ${id} is ${r.state}; only an eligible release takes the lock`);
    if (held) return { locked: false, refused: false, waitingFor: held.release_id, release: r };
    let result;
    try { result = typeof recheck === 'function' ? recheck() : undefined; } catch (error) { result = { eligible: false, failed: [{ reason: `the re-check failed: ${error.message}` }] }; }
    let reason = null;
    if (result?.eligible !== true || typeof result?.then === 'function') reason = result?.failed?.[0]?.reason ?? 'not eligible at the last moment: the re-check gave no positive answer';
    else if (r.grant_digest && result.inputs?.grantDigest !== r.grant_digest) reason = 'the grant changed since the release was planned';
    const eligibility = result && typeof result.then !== 'function' ? result : null;
    if (reason) {
      store.journal(r.campaign_id, 'release-refused', { release: id, reason }, now);
      return { locked: false, refused: true, waitingFor: null, release: update(store, id, { state: 'refused', reason, eligibility }, now) };
    }
    store.insert('release_locks', { destination: key, release_id: id, instance_id: lease.instanceId, generation: lease.generation, acquired_at: now });
    store.journal(r.campaign_id, 'release-locked', { release: id, destination: key }, now);
    return { locked: true, refused: false, waitingFor: null, release: update(store, id, { state: 'locked', eligibility, instance_id: lease.instanceId, generation: lease.generation }, now) };
  });
}

/** The step a release would run next, or null: none while a step is open, unknown, failed to roll back or finished. */
export function nextStep(r) {
  if (TERMINAL.includes(r.state) || r.state === 'unknown' || r.state === 'rollback-failed' || r.state === 'eligible') return null;
  if (!r.step) return r.steps[0];
  if (r.step_outcome === 'not-done') return r.step;
  if (r.step_outcome === 'failed') return r.step === 'rollback' ? null : 'rollback';
  if (r.step_outcome !== 'done' || r.step === 'rollback') return null;
  return r.steps[r.steps.indexOf(r.step) + 1] ?? null;
}

/** A rollback, or a check after a forward step finished: recovery, which a stop never prevents (AUTO_RELEASE.md 4.5). */
const isRecovery = (r, step) => step === 'rollback' || (step === 'check' && r.history.some((entry) => entry.step !== 'check' && entry.outcome === 'done'));

/** Where a release stands after a step's known outcome. A failed forward step or check is recovered by `rollback`. */
const settled = (step, outcome) => (outcome === 'done' ? DONE[step] : outcome === 'refused' ? 'refused' : step === 'rollback' ? 'rollback-failed' : RUNNING[step]);

const answer = (value, allowed) => {
  const result = typeof value === 'string' ? { outcome: value } : value;
  return result && typeof result === 'object' && allowed.includes(result.outcome) ? result : { outcome: 'unknown' };
};

/** Record a known outcome of the open step (inside a transaction): history, state, recorded digests, and the lock. */
function finish(store, r, result, now, how) {
  const history = r.history.map((entry) => (entry.key === r.step_key ? { ...entry, endedAt: now, outcome: result.outcome, how } : entry));
  const changes = { state: settled(r.step, result.outcome), step_outcome: result.outcome, history };
  if (result.outcome === 'refused') changes.reason = `the destination refused ${r.step}`;
  for (const [field, column] of Object.entries(RECORDED)) if (typeof result[field] === 'string') changes[column] = result[field];
  const after = update(store, r.id, changes, now);
  if (TERMINAL.includes(after.state)) store.run('DELETE FROM release_locks WHERE release_id = ?', r.id);
  store.journal(r.campaign_id, 'release-step-finished', { release: r.id, step: r.step, key: r.step_key, outcome: result.outcome, how, state: after.state }, now);
  return after;
}

/**
 * Run the next step under the lock. Refuses an unknown release, one last acted on under another lease generation
 * (reconcile it first), one without the lock, and a step that ran before unless every earlier run was proven not done.
 * The intent (state, step, its key `<release id>.<step>.<n>`, a history entry with no outcome) is committed before the
 * adapter acts. A throw or an unreadable answer makes the release `unknown`. Returns the release afterwards.
 * `gate(release, step)` (releaseGate bound to the destination) is asked in that transaction before every step except
 * recovery. A reason, a throw or any answer other than null stops it: nothing runs, the release keeps its state and its
 * lock, and `reason` says why. The caller that will drive releases (slice REL5) always passes it.
 */
export async function runStep(store, adapter, id, { lease, now, gate = null }) {
  if (gate !== null && typeof gate !== 'function') throw new TypeError('the runStep gate must be a function (release, step) -> reason or null');
  const started = store.tx(() => {
    const r = release(store, id);
    if (!r) throw new Error(`no release ${id}`);
    fenced(store, r.campaign_id, lease, now);
    if (r.state === 'unknown') throw new Error(`release ${id} is unknown: reconcile it before any action`);
    if (r.generation !== lease.generation) throw new Error(`release ${id} was last acted on under generation ${r.generation}: reconcile it after the takeover first`);
    const lock = store.get('SELECT release_id, generation FROM release_locks WHERE destination = ?', destinationKey(r.project, r.destination));
    if (lock?.release_id !== id || lock.generation !== lease.generation) throw new Error(`release ${id} does not hold the lock of ${r.destination}`);
    const step = nextStep(r);
    if (!step) throw new Error(`release ${id} has no step to run in state ${r.state}`);
    const earlier = r.history.filter((entry) => entry.step === step);
    if (earlier.some((entry) => entry.outcome !== 'not-done')) throw new Error(`step ${step} of release ${id} ran before and was not proven not done`);
    // The switches, before every step. A stop leaves the release where it is, with its lock, and runs nothing.
    if (gate && !isRecovery(r, step)) {
      let reason;
      try { reason = gate(r, step); } catch (error) { reason = `the release switches could not be read: ${error.message}`; }
      if (reason !== null) {
        reason = typeof reason === 'string' && reason ? reason : 'the release switches gave no clear answer';
        store.journal(r.campaign_id, 'release-stopped', { release: id, step, reason }, now);
        return { stopped: update(store, id, { reason }, now) };
      }
    }
    const key = `${id}.${step}.${earlier.length + 1}`;
    store.journal(r.campaign_id, 'release-step-started', { release: id, step, key }, now);
    return update(store, id, { state: RUNNING[step], step, step_key: key, step_started_at: now, step_outcome: null, reason: null,
      history: [...r.history, { key, step, startedAt: now, endedAt: null, outcome: null }] }, now);
  });
  if (started.stopped) return started.stopped;
  let result;
  try { result = answer(await adapter.run(started, started.step), ['done', 'failed', ...(started.step === 'check' || started.step === 'rollback' ? [] : ['refused'])]); }
  catch { result = { outcome: 'unknown' }; }
  return store.tx(() => {
    fenced(store, started.campaign_id, lease, now);
    const r = release(store, id);
    if (r.step_key !== started.step_key || r.step_outcome !== null) return r;
    if (result.outcome !== 'unknown') return finish(store, r, result, now, 'ran');
    store.journal(r.campaign_id, 'release-unknown', { release: id, step: r.step, key: r.step_key }, now);
    return update(store, id, { state: 'unknown' }, now);
  });
}

/** After a restart: every release of the campaign with a started step and no outcome is unknown. Returns their ids. */
export function markUnknownAfterRestart(store, campaignId, { lease, now }) {
  return store.tx(() => {
    fenced(store, campaignId, lease, now);
    const open = store.all(`SELECT id, step, step_key FROM releases WHERE campaign_id = ? AND step IS NOT NULL AND step_outcome IS NULL
      AND state NOT IN ('unknown', 'rollback-failed', ${TERMINAL.map(() => '?').join(', ')})`, campaignId, ...TERMINAL);
    for (const row of open) {
      update(store, row.id, { state: 'unknown' }, now);
      store.journal(campaignId, 'release-unknown', { release: row.id, step: row.step, key: row.step_key, after: 'restart' }, now);
    }
    return open.map((row) => row.id);
  });
}

/** Where a release stood before a step proven not done: the outcome of the last step that finished, else `locked`. */
function before(r) {
  const last = r.history.filter((entry) => entry.outcome && entry.outcome !== 'not-done' && entry.key !== r.step_key).at(-1);
  return last ? settled(last.step, last.outcome) : 'locked';
}

/**
 * Reconcile a release before acting on it. A release with an open step (after a restart, a crash or a takeover) is
 * made `unknown` and adopted by this lease generation, then one read-only `observe` decides: done or failed records the
 * outcome (the step is never run again), not-done lets the same step run again, and unknown, a throw or any other
 * answer leaves it `unknown` with its lock, to be read again later. A settled release from an older generation is only
 * adopted. Returns the release afterwards.
 */
export async function reconcile(store, adapter, id, { lease, now }) {
  const looking = store.tx(() => {
    const r = release(store, id);
    if (!r) throw new Error(`no release ${id}`);
    fenced(store, r.campaign_id, lease, now);
    const open = r.state === 'unknown' || (r.step && r.step_outcome === null && !TERMINAL.includes(r.state) && r.state !== 'rollback-failed');
    if (!open && r.generation === lease.generation) return null;
    const adopted = { instance_id: lease.instanceId, generation: lease.generation };
    store.run('UPDATE release_locks SET instance_id = ?, generation = ? WHERE release_id = ?', lease.instanceId, lease.generation, id);
    if (!open) {
      store.journal(r.campaign_id, 'release-adopted', { release: id, from: r.generation, to: lease.generation }, now);
      return update(store, id, adopted, now);
    }
    if (r.state !== 'unknown') store.journal(r.campaign_id, 'release-unknown', { release: id, step: r.step, key: r.step_key, after: 'takeover' }, now);
    return update(store, id, { ...adopted, state: 'unknown' }, now);
  });
  if (!looking || looking.state !== 'unknown') return looking ?? release(store, id);
  let seen;
  try { seen = answer(await adapter.observe(looking, looking.step), ['done', 'failed', 'not-done', 'unknown']); } // a read failure is never evidence
  catch { seen = { outcome: 'unknown' }; }
  return store.tx(() => {
    fenced(store, looking.campaign_id, lease, now);
    const r = release(store, id);
    if (r.state !== 'unknown' || r.step_key !== looking.step_key) return r;
    if (seen.outcome === 'done' || seen.outcome === 'failed') return finish(store, r, seen, now, 'observed');
    if (seen.outcome === 'not-done') {
      const history = r.history.map((entry) => (entry.key === r.step_key ? { ...entry, endedAt: now, outcome: 'not-done', how: 'observed' } : entry));
      store.journal(r.campaign_id, 'release-step-finished', { release: id, step: r.step, key: r.step_key, outcome: 'not-done', how: 'observed' }, now);
      return update(store, id, { state: before(r), step_outcome: 'not-done', history }, now);
    }
    store.journal(r.campaign_id, 'release-still-unknown', { release: id, step: r.step, key: r.step_key }, now);
    return r;
  });
}

// ---- The switches and the mode (AUTO_RELEASE.md sections 3 and 4.5, slice REL4). Built switched off (#33). ----

/** The file in the supervisor data directory that stops every release on the machine. Removing it is the owner's. */
export const RELEASE_STOP = 'RELEASE-STOP';
export const REVIEW_ONLY = 'review-only';
export const AUTO_RELEASE = 'auto-release';

// The owner's narrowings, one row per project and destination; no row means never narrowed. The table is created here,
// on the first narrowing, because slice REL4 does not own store.mjs. It is additive like every release table.
const MODES_DDL = `CREATE TABLE IF NOT EXISTS release_modes (
  project TEXT NOT NULL, destination TEXT NOT NULL, mode TEXT NOT NULL, grant_version INTEGER, narrowed_at INTEGER NOT NULL,
  source TEXT NOT NULL, PRIMARY KEY (project, destination))`;
const hasModes = (store) => Boolean(store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'release_modes'"));

const named = (value, what) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${what} must be a non-empty name`);
  return value;
};

/**
 * Narrow one destination of one project to Review only. Always allowed: it needs no grant and nobody's approval, and it
 * takes effect before the next step (AUTO_RELEASE.md section 3). Nothing here widens: only a newer grant makes Auto
 * Release available again. `grantVersion` is the version of the grant in force when the caller knows it; without it,
 * only a grant granted after this narrowing widens. Returns the stored narrowing.
 */
export function setReviewOnly(store, { project, destination, grantVersion = null, source = 'owner', now }) {
  named(project, 'project'); named(destination, 'destination');
  if (grantVersion !== null && !(Number.isInteger(grantVersion) && grantVersion > 0)) throw new TypeError('grantVersion must be a positive integer or null');
  if (!Number.isFinite(now)) throw new TypeError('setReviewOnly needs the time');
  store.db.exec(MODES_DDL);
  return store.tx(() => {
    store.run(`INSERT INTO release_modes (project, destination, mode, grant_version, narrowed_at, source) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (project, destination) DO UPDATE SET mode = excluded.mode, grant_version = excluded.grant_version,
      narrowed_at = excluded.narrowed_at, source = excluded.source`, project, destination, REVIEW_ONLY, grantVersion, now, source);
    store.journal(null, 'release-mode-narrowed', { project, destination, mode: REVIEW_ONLY, grantVersion, source }, now);
    return store.get('SELECT * FROM release_modes WHERE project = ? AND destination = ?', project, destination);
  });
}

/** The narrowings recorded for a project, for status. Read-only; a store never narrowed has none. */
export function releaseNarrowings(store, project) {
  if (!hasModes(store)) return [];
  return store.all('SELECT destination, mode, grant_version, narrowed_at, source FROM release_modes WHERE project = ? ORDER BY destination', project)
    .map((row) => ({ destination: row.destination, mode: row.mode, grantVersion: row.grant_version, narrowedAt: new Date(row.narrowed_at).toISOString(), source: row.source }));
}

/**
 * The effective mode of one destination. `auto-release` only with a valid grant that names the destination and is newer
 * than the owner's last narrowing of it (a higher version, or granted after it when the narrowed version is unknown);
 * `review-only` otherwise, the default for every project. `grant` is one already validated by release/authorization.mjs,
 * as eligibility.mjs holds it: { record, digest } when valid, { reason } when not.
 */
export function releaseMode(store, { project, destination, grant }) {
  const record = grant && !grant.reason ? grant.record : null;
  if (!record || !Array.isArray(record.destinations) || !record.destinations.some((item) => item?.id === destination)) return REVIEW_ONLY;
  const narrowed = hasModes(store) ? store.get('SELECT grant_version, narrowed_at FROM release_modes WHERE project = ? AND destination = ?', project, destination) : null;
  if (!narrowed) return AUTO_RELEASE;
  const newer = narrowed.grant_version !== null
    ? Number.isInteger(record.version) && record.version > narrowed.grant_version
    : Date.parse(record.grantedAt) > narrowed.narrowed_at;
  return newer ? AUTO_RELEASE : REVIEW_ONLY;
}

/**
 * The switches of one destination, in the shape eligibility check E1 reads: { enabled, stop, mode }. `enabled` is true
 * only when config.json says `"release": { "enabled": true }`; absent or anything else is off. `stop` is whether
 * `<dataDir>/RELEASE-STOP` exists, null when that cannot be read. `mode` is releaseMode's answer, null when unread.
 */
export function releaseSwitches({ dataDir, config, store, project, destination, grant, exists = existsSync }) {
  let stop = null, mode = null;
  try { stop = typeof dataDir === 'string' && dataDir ? exists(join(dataDir, RELEASE_STOP)) === true : null; } catch { stop = null; }
  try { mode = releaseMode(store, { project, destination, grant }); } catch { mode = null; }
  return { enabled: config?.release?.enabled === true, stop, mode };
}

/**
 * Why no release step may start now, or null when every switch allows it: runStep's gate. A switch that cannot be read
 * stops: a stop is never assumed absent.
 */
export function releaseGate(input) {
  let switches;
  try { switches = releaseSwitches(input); } catch (error) { return `the release switches could not be read: ${error.message}`; }
  if (switches.enabled !== true) return 'Auto Release is switched off (release.enabled is not true)';
  if (switches.stop !== false) return switches.stop === true ? 'RELEASE-STOP is set: every release is stopped' : 'whether RELEASE-STOP is set is unknown';
  if (switches.mode === AUTO_RELEASE) return null;
  return switches.mode === REVIEW_ONLY ? 'the destination is in Review only' : 'the mode of the destination is unknown';
}
