// Check the site now (docs/design/OWNER_UI_V2.md WP9, docs/design/AUTO_RELEASE.md sections 4.4 and 9): the owner asks
// for one read-only `check` of a release that already settled, and sees whether the destination is healthy now. It is
// not a release step and adds no authority: it runs only the `check` command the destination's grant already names,
// only through the release runner (release/runner.mjs, its own clean process), and only while every one of these holds:
// - the release settled with something live: accepted, rolled back, or a failed rollback (an incident the owner reads);
//   an unknown release is reconciled by the release role itself, and a running step is never raced;
// - `release.enabled` is exactly true and RELEASE-STOP is absent (a stop that cannot be read stops);
// - the grant, read again at the ref and path the release recorded, is valid now and names this destination with a
//   `check` command. An expired, revoked, missing or changed-to-invalid grant refuses;
// - no other check of this release is running.
// The answer is passed, failed or unknown; unknown is never shown as healthy. It is kept on the release row
// (`health_check`) and journalled. It never changes the release's state or lock and never rolls back: a failed check
// tells the owner, who decides. Built switched off: with release.enabled false (every install today) it always refuses.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAuthorization } from './authorization.mjs';
import { DEPLOY_RECORD, deployAdapter } from './deploy.mjs';
import { RELEASE_STOP, release } from './state.mjs';

/** The states in which something known is live, so a check can say how it is doing. */
export const HEALTH_SETTLED = Object.freeze(['accepted', 'rolled-back', 'rollback-failed']);
export const HEALTH_OUTCOMES = Object.freeze(['passed', 'failed', 'unknown']);
const DEPLOY_KINDS = new Set(['deploy', 'merge-then-deploy']);
/** How long one check may take; a check older than this plus a minute no longer holds the release. */
export const HEALTH_TIMEOUT_MS = 120_000;

/** Whether `<dataDir>/RELEASE-STOP` exists: true, false, or null when that cannot be read. */
export function releaseStopped(dataDir, exists = existsSync) {
  try { return typeof dataDir === 'string' && dataDir ? exists(join(dataDir, RELEASE_STOP)) === true : null; } catch { return null; }
}

/**
 * Why Check the site now cannot run for this release now, or null when it may be asked. Cheap and read-only: no Git, no
 * command; the grant is read again only when the check is asked for. `stop` is releaseStopped's answer.
 */
export function healthCheckBlocker({ release: r, config, stop, now = Date.now() }) {
  if (!r) return 'There is no such release.';
  if (r.state === 'unknown') return 'The outcome of this release is unknown. AIWorks is reading the destination itself and runs no separate check until it knows.';
  if (r.state === 'refused') return 'Nothing was released, so there is nothing to check.';
  if (!HEALTH_SETTLED.includes(r.state)) return 'A release step is still running.';
  if (config?.release?.enabled !== true) return 'Auto Release is switched off on this computer, so AIWorks runs no release command.';
  if (stop !== false) return stop === true ? 'Stop all releases is on, so no release command runs.' : 'Whether Stop all releases is on cannot be read.';
  const destination = r.eligibility?.inputs?.destination;
  if (!destination) return 'This release was recorded before AIWorks kept its destination details, so it cannot be checked from here.';
  if (!DEPLOY_KINDS.has(destination.kind)) return 'This destination has no deployed site to check.';
  if (!destination.commands?.includes('check')) return 'This destination names no check command, so its health cannot be checked.';
  const running = r.health_check;
  if (running?.state === 'checking' && Number.isFinite(running.startedAt) && now - running.startedAt < HEALTH_TIMEOUT_MS + 60_000) return 'A check of this release is already running.';
  return null;
}

const refused = (reason) => ({ checked: false, reason });

/**
 * Run one owner-requested check of release `id`. `config` is config.json; `dataDir` the supervisor data directory.
 * Returns { checked: true, outcome, checkedAt } or { checked: false, reason } when it may not run. `git` and
 * `runCommand` are as release/authorization.mjs and release/deploy.mjs take them.
 */
export async function checkReleaseNow({ store, dataDir, config, id, now = Date.now, git = ['git'], timeoutMs = HEALTH_TIMEOUT_MS, exists = existsSync, runCommand }) {
  const before = release(store, id);
  const blocker = healthCheckBlocker({ release: before, config, stop: releaseStopped(dataDir, exists), now: now() });
  if (blocker) return refused(blocker);
  let record = null;
  try { record = JSON.parse(readFileSync(join(dataDir, 'releases', before.id, DEPLOY_RECORD), 'utf8')); } catch { /* refused below */ }
  if (typeof record?.repo !== 'string' || !record.repo) return refused('This release kept no release clone, so it cannot be checked from here.');
  const source = before.eligibility?.inputs?.grantSource;
  if (!source) return refused('Where this release’s grant was read is not recorded, so the grant cannot be checked again.');
  const grant = loadAuthorization({ git, repoPath: record.repo, ref: source.ref, path: source.path, project: before.project, now: now() });
  if (!grant.valid) return refused(`The release grant is not valid now: ${grant.reasons[0] ?? 'unknown reason'}.`);
  let destination;
  try { destination = JSON.parse(grant.bytes.toString('utf8')).destinations.find((item) => item.id === before.destination); } catch { destination = null; }
  if (!destination) return refused('The release grant no longer names this destination.');
  if (!DEPLOY_KINDS.has(destination.kind) || !destination.commands?.check) return refused('The release grant names no check command for this destination.');

  // Intent before effect: a second request while this one runs is refused, and a crash leaves a check that times out.
  const startedAt = now();
  const claimed = store.tx(() => {
    const r = release(store, id);
    const again = healthCheckBlocker({ release: r, config, stop: false, now: startedAt });
    if (again) return again;
    const n = (Number.isSafeInteger(r.health_check?.n) ? r.health_check.n : 0) + 1;
    store.run('UPDATE releases SET health_check = ? WHERE id = ?', { state: 'checking', n, startedAt, checkedAt: null, outcome: null, grantDigest: grant.digest }, id);
    store.journal(r.campaign_id, 'release-health-check-started', { release: id, n, grantDigest: grant.digest }, startedAt);
    return { n };
  });
  if (typeof claimed === 'string') return refused(claimed);

  const adapter = deployAdapter({ destination, repo: record.repo, config, dataDir, store, timeoutMs, clock: now, ...(runCommand ? { runCommand } : {}) });
  let outcome = await adapter.health(before, `${before.id}.health.${claimed.n}`);
  if (!HEALTH_OUTCOMES.includes(outcome)) outcome = 'unknown';
  const checkedAt = now();
  store.tx(() => {
    store.run('UPDATE releases SET health_check = ? WHERE id = ?', { state: 'done', n: claimed.n, startedAt, checkedAt, outcome, grantDigest: grant.digest }, id);
    store.journal(before.campaign_id, 'release-health-checked', { release: id, n: claimed.n, outcome }, checkedAt);
  });
  return { checked: true, outcome, checkedAt };
}
