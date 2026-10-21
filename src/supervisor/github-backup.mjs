// The optional backup of AIWorks's own trusted local main (docs/design/LOCAL_OPERATION.md section 4.6, slice SELF9).
// With config.json `selfHosting.backup.enabled` and local main trusted, after a recorded local merge the supervisor
// pushes the trusted tip of the main ledger, and only that commit, to `<remote>` as `refs/heads/<branch>`: never a force,
// a `+` refspec, a mirror, tags or unrecorded commits; bounded to 60 seconds and to one attempt every 10 minutes. Nothing
// waits on it: a refused or unreachable remote is journaled and shown in status, and the next local merge goes ahead.
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { assertPushActionsDisabled, exec } from './adapters/git.mjs';
import { assertActionsDisabled } from './adapters/github.mjs';
import { redact } from './owner-intervention.mjs';
import { mainLedger, trustedTip, trustsLocalMain } from './self-hosting.mjs';

const SHA = /^[0-9a-f]{40}$/;
// The same plain Git names selfHostingSettings accepts: never an option, a refspec or a `..` range.
const REF_NAME = /^(?!-)(?!.*\.\.)[\w.-]+(?:\/[\w.-]+)*$/;
export const BACKUP_TIMEOUT_MS = 60_000;
export const BACKUP_INTERVAL_MS = 10 * 60_000;
const KINDS = ['backup-requested', 'backup-pushed', 'backup-refused', 'backup-failed'];

/**
 * Push `tip` to `<remote>` as `refs/heads/<branch>`. The arguments are fixed: no force, no `+`, no mirror (even when the
 * remote is configured as one), no tags. Returns { kind: 'backup-pushed' }, { kind: 'backup-refused', reason } when the
 * remote rejected the update (it is not a fast-forward there, or the remote's rules decline it), or
 * { kind: 'backup-failed', reason } when the remote could not be reached in time or the push could not run, as when its
 * local folder does not exist (yet): that is tried again after the interval, while a refusal waits for the next merge.
 */
export function pushTrustedTip({ git = ['git'], gh = ['gh'], repository, repoPath, remote, branch, tip }) {
  if (!SHA.test(tip ?? '') || !REF_NAME.test(remote ?? '') || !REF_NAME.test(branch ?? '')) {
    return { kind: 'backup-failed', reason: 'a backup needs a full commit SHA and plain remote and branch names' };
  }
  try {
    assertActionsDisabled({ gh, repository });
    assertPushActionsDisabled({ git, gh, repoPath, remote });
  }
  catch (error) {
    if (/push destination could not be verified/.test(error.message) && missingLocalDestination(git, repoPath, remote)) return { kind: 'backup-failed', reason: 'the backup folder does not exist on this computer' };
    return { kind: 'backup-refused', reason: redact(error.message, 300) };
  }
  const out = exec(git, ['-c', `remote.${remote}.mirror=false`, 'push', '--porcelain', '--no-follow-tags', remote, `${tip}:refs/heads/${branch}`],
    { cwd: repoPath, timeoutMs: BACKUP_TIMEOUT_MS });
  if (out.ok) return { kind: 'backup-pushed' };
  // --porcelain marks a rejected ref with `!`, followed by Git's reason, such as "[rejected] (non-fast-forward)".
  const rejected = out.stdout.split('\n').find((line) => line.startsWith('!'));
  if (rejected) return { kind: 'backup-refused', reason: redact(rejected.split('\t').slice(2).join(' ') || out.stderr || 'rejected', 300) };
  const reason = out.error === 'ETIMEDOUT' ? `the push did not finish within ${BACKUP_TIMEOUT_MS / 1000} seconds` : out.stderr || out.error || `exit ${out.status}`;
  return { kind: 'backup-failed', reason: redact(reason, 300) };
}

/** Whether every push URL of `remote` is an absolute local path that does not exist: unreachable, not a refusal. */
function missingLocalDestination(git, repoPath, remote) {
  const out = exec(git, ['remote', 'get-url', '--push', '--all', remote], { cwd: repoPath });
  const urls = out.ok ? out.stdout.split(/\r?\n/).filter(Boolean) : [];
  return urls.length > 0 && urls.every((url) => isAbsolute(url) && !/^[\\/]{2}/.test(url) && !url.includes('://') && !existsSync(url));
}

/**
 * The backup journal of one repository: { latest, requested, outcome, pushedTip }. `latest` is the newest entry of any
 * kind, `requested` and `outcome` the newest `backup-requested` and the newest result ({ kind, at, tip, reason });
 * `pushedTip` is the newest tip the remote accepted.
 */
export function backupHistory(store, repository) {
  const rows = store.all(`SELECT kind, at, detail FROM journal WHERE kind IN (${KINDS.map(() => '?').join(', ')})
    AND json_extract(detail, '$.repository') = ? ORDER BY seq DESC`, ...KINDS, String(repository).toLowerCase());
  const entry = (row) => (row ? { kind: row.kind, at: row.at, tip: row.detail?.tip ?? null, reason: row.detail?.reason ?? null } : null);
  return { latest: entry(rows[0]), requested: entry(rows.find((row) => row.kind === 'backup-requested')),
    outcome: entry(rows.find((row) => row.kind !== 'backup-requested')),
    pushedTip: rows.find((row) => row.kind === 'backup-pushed')?.detail?.tip ?? null };
}

/**
 * Whether `tip` should be pushed now: not yet accepted by the remote, not refused or in flight for this very tip (a
 * refusal is tried again after the next merge, never forced), and the last attempt is at least 10 minutes old.
 */
function due(history, tip, now) {
  if (history.pushedTip === tip) return false;
  if (history.requested && history.requested.at + BACKUP_INTERVAL_MS > now) return false;
  return !(history.outcome?.kind === 'backup-refused' && history.outcome.tip === tip);
}

/**
 * One backup step for the self-hosted repository, after the local merges of a merge pass. `write(campaignId, fn)` runs
 * fn in that campaign's fenced transaction and returns false without running it when this instance does not hold the
 * campaign's lease. Entries go to the campaign of the newest `gate-merge` ledger row. Returns the result kind, or null
 * when nothing was due. Never throws for a remote's answer; its result never decides a merge.
 */
export function backupStep({ store, settings, git = ['git'], gh = ['gh'], repoPath, repository, now, write, log = () => {} }) {
  if (!settings?.backup?.enabled || !trustsLocalMain(settings, repository)) return null;
  const merge = mainLedger(store, repository).reverse().find((row) => row.kind === 'gate-merge');
  if (!merge) return null;
  // Only the trusted tip, never local main itself: commits after it are not AIWorks's.
  const tip = trustedTip(store, { git, repoPath, repository });
  if (tip.state !== 'TRUSTED' || !due(backupHistory(store, repository), tip.tip, now)) return null;
  const { remote, branch } = settings.backup;
  const detail = { repository: String(repository).toLowerCase(), tip: tip.tip, remote, branch };
  // The request is committed before the push, so a crash or a restart still waits the full interval.
  if (!write(merge.campaign_id, () => store.journal(merge.campaign_id, 'backup-requested', detail, now))) return null;
  const result = pushTrustedTip({ git, gh, repository, repoPath, remote, branch, tip: tip.tip });
  write(merge.campaign_id, () => store.journal(merge.campaign_id, result.kind, { ...detail, ...(result.reason ? { reason: result.reason } : {}) }, now));
  log(result.kind === 'backup-pushed' ? `backed up ${tip.tip} to ${remote} ${branch}` : `backup of ${tip.tip} to ${remote} ${branch}: ${result.kind}: ${result.reason}`);
  return result.kind;
}

/**
 * The backup half of the `selfHosting` status (read-only): whether it is on, where it goes, and the newest outcome.
 * `state` is `off`, `none` (on, never tried), `pushing` (requested, no outcome recorded after it), `pushed`, `refused`
 * or `failed`; `current` is true only when the remote has the trusted tip `tip`.
 */
export function backupStatus(store, settings, repository, tip) {
  const { enabled, remote, branch } = settings.backup;
  const history = backupHistory(store, repository);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const latest = history.latest;
  return {
    enabled, remote, branch,
    state: !enabled ? 'off' : !latest ? 'none' : latest.kind === 'backup-requested' ? 'pushing' : latest.kind.slice('backup-'.length),
    tip: latest?.tip ?? null, reason: latest?.reason ?? null, at: iso(latest?.at),
    pushedTip: history.pushedTip, current: Boolean(tip) && history.pushedTip === tip,
    // A refused tip is tried again only after the next merge (due), so no time is promised for it.
    nextAttemptAfter: history.requested && !(history.outcome?.kind === 'backup-refused' && history.outcome.tip === tip)
      ? iso(history.requested.at + BACKUP_INTERVAL_MS) : null,
  };
}
