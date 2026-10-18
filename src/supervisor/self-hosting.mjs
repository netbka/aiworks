// AIWorks self-hosting (docs/design/LOCAL_OPERATION.md sections 4.1 and 4.2, slice SELF2): the `selfHosting` setting of
// config.json and the main ledger, the record of every commit AIWorks trusts on local main. Off by default: with no
// selfHosting block every setting reads as today's ("origin"). Nothing reads the trusted tip yet (SELF3 does). Every Git
// command here is read-only: it never moves, fetches or pushes a ref and never talks to a remote.
import * as gitA from './adapters/git.mjs';

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
// A remote name or branch name the backup may name: plain path segments, never an option, a refspec or a `..` range.
const REF_NAME = /^(?!-)(?!.*\.\.)[\w.-]+(?:\/[\w.-]+)*$/;
const MAIN = 'refs/heads/main';
const ORIGIN_MAIN = 'refs/remotes/origin/main';
const KINDS = new Set(['anchor', 'gate-merge', 'owner']);
// At most this many unrecorded commits are listed; the count is always exact.
const UNRECORDED_LIST = 50;

const OFF = Object.freeze({ repository: null, trustedMain: 'origin', local: false,
  backup: Object.freeze({ enabled: false, remote: 'origin', branch: 'main' }), problem: null });

/**
 * Self-hosting settings from config.json `selfHosting`. Absent: off. Malformed: off, and `problem` says what is
 * malformed and is passed to `log`, as the merge settings are (merge.mjs). `local` is true only for a valid block with
 * `"trustedMain": "local"`; it applies to `repository` only.
 */
export function selfHostingSettings(config, { log } = {}) {
  const block = config?.selfHosting;
  if (block === undefined || block === null) return OFF;
  const off = (problem) => {
    const settings = Object.freeze({ ...OFF, problem: `self-hosting stays off: ${problem}` });
    log?.(settings.problem);
    return settings;
  };
  if (typeof block !== 'object' || Array.isArray(block)) return off('selfHosting must be an object');
  if (typeof block.repository !== 'string' || !REPOSITORY.test(block.repository)) {
    return off('selfHosting.repository must name the owner/name repository of AIWorks itself');
  }
  const trustedMain = block.trustedMain ?? 'origin';
  if (trustedMain !== 'origin' && trustedMain !== 'local') return off('selfHosting.trustedMain must be "origin" or "local"');
  const backup = block.backup ?? {};
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) return off('selfHosting.backup must be an object');
  if (backup.enabled !== undefined && typeof backup.enabled !== 'boolean') return off('selfHosting.backup.enabled must be true or false');
  for (const key of ['remote', 'branch']) {
    if (backup[key] !== undefined && (typeof backup[key] !== 'string' || !REF_NAME.test(backup[key]))) {
      return off(`selfHosting.backup.${key} must be a plain Git name`);
    }
  }
  return Object.freeze({ repository: block.repository.toLowerCase(), trustedMain, local: trustedMain === 'local',
    backup: Object.freeze({ enabled: backup.enabled === true, remote: backup.remote ?? 'origin', branch: backup.branch ?? 'main' }),
    problem: null });
}

/** Whether `repository` is AIWorks's own repository with local main trusted. Every other repository: false. */
export const trustsLocalMain = (settings, repository) =>
  Boolean(settings?.local) && String(repository ?? '').toLowerCase() === settings.repository;

/** The ledger rows of one repository, oldest first. A read-only open of a store older than the ledger has none. */
export function mainLedger(store, repository) {
  if (!store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'main_ledger'")) return [];
  return store.all('SELECT * FROM main_ledger WHERE repository = ? ORDER BY seq', String(repository).toLowerCase());
}

const resolve = (git, repoPath, ref) => {
  const out = gitA.exec(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoPath, timeoutMs: 30_000 });
  return out.ok && SHA.test(out.stdout) ? out.stdout : null;
};
const refused = (reason) => ({ recorded: false, reason });

/**
 * Record the anchor: the first ledger row, once per repository (the switch-on step, SELF13, calls it after its fetch;
 * this never fetches). `sha` is accepted only when it equals `refs/remotes/origin/main` and local `main`, so trust passes
 * from GitHub's main as it is at that moment, with no new root of trust.
 */
export function recordAnchor(store, { git = ['git'], repoPath, repository, sha, now }) {
  if (!REPOSITORY.test(String(repository ?? ''))) return refused('the repository must be owner/name');
  if (!SHA.test(String(sha ?? ''))) return refused('the anchor must be a full commit SHA');
  const origin = resolve(git, repoPath, ORIGIN_MAIN), main = resolve(git, repoPath, MAIN);
  if (origin !== sha) return refused(`the anchor ${sha.slice(0, 12)} is not origin/main (${origin?.slice(0, 12) ?? 'absent'})`);
  if (main !== sha) return refused(`the anchor ${sha.slice(0, 12)} is not local main (${main?.slice(0, 12) ?? 'absent'})`);
  return store.tx(() => {
    if (mainLedger(store, repository).length) return refused('the main ledger of this repository already has its anchor');
    return { recorded: true, seq: append(store, { repository, kind: 'anchor', oldTip: null, newTip: sha, now }) };
  });
}

/**
 * Append a `gate-merge` row (the local merge gate, SELF8, inside its fenced merge transaction) or an `owner` row (the
 * owner route). Refused before the anchor. Only checks the row's form; the caller owns the conditions of its kind.
 */
export function recordMainCommit(store, { repository, kind, oldTip, newTip, campaignId = null, taskId = null, verifiedSha = null, now }) {
  if (kind !== 'gate-merge' && kind !== 'owner') return refused('only gate-merge and owner rows follow the anchor');
  if (!REPOSITORY.test(String(repository ?? ''))) return refused('the repository must be owner/name');
  if (!SHA.test(String(newTip ?? '')) || (oldTip !== null && oldTip !== undefined && !SHA.test(String(oldTip)))) {
    return refused('ledger tips must be full commit SHAs');
  }
  if (kind === 'gate-merge' && (!campaignId || !taskId || !SHA.test(String(verifiedSha ?? '')))) {
    return refused('a gate-merge row names its campaign, task and verified SHA');
  }
  return store.tx(() => {
    if (!mainLedger(store, repository).length) return refused('the main ledger of this repository has no anchor');
    return { recorded: true, seq: append(store, { repository, kind, oldTip: oldTip ?? null, newTip, campaignId, taskId, verifiedSha, now }) };
  });
}

function append(store, { repository, kind, oldTip, newTip, campaignId = null, taskId = null, verifiedSha = null, now }) {
  if (!KINDS.has(kind)) throw new TypeError(`unknown main ledger kind ${kind}`);
  return Number(store.run(`INSERT INTO main_ledger (repository, old_tip, new_tip, kind, campaign_id, task_id, verified_sha, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, repository.toLowerCase(), oldTip, newTip, kind, campaignId, taskId, verifiedSha, now).lastInsertRowid);
}

/**
 * The trusted tip of local main: the newest ledger commit that is still an ancestor of, or equal to, local `main`.
 * Read-only. Returns one of
 * - { state: 'TRUSTED', tip, seq, main, unrecorded, unrecordedCount }: `unrecorded` lists the commits on main after the
 *   tip (newest first, at most 50), which are not trusted until a recorded commit contains them;
 * - { state: 'MAIN_REWRITTEN', main, reason }: no ledger commit is on main any more (main was rewound or rewritten);
 * - { state: 'NO_ANCHOR', reason } or { state: 'UNREADABLE', reason }.
 */
export function trustedTip(store, { git = ['git'], repoPath, repository }) {
  const rows = mainLedger(store, repository);
  if (!rows.length) return { state: 'NO_ANCHOR', reason: 'the main ledger of this repository has no anchor' };
  const main = resolve(git, repoPath, MAIN);
  if (!main) return { state: 'UNREADABLE', reason: 'local main cannot be resolved in the checkout' };
  for (const row of rows.reverse()) {
    if (!resolve(git, repoPath, row.new_tip)) continue; // the commit is gone: it cannot be on main
    const ancestor = gitA.exec(git, ['merge-base', '--is-ancestor', row.new_tip, main], { cwd: repoPath, timeoutMs: 30_000 });
    if (ancestor.status === 1) continue;
    if (!ancestor.ok) return { state: 'UNREADABLE', reason: `main cannot be compared with the ledger: ${ancestor.stderr.slice(0, 200) || `exit ${ancestor.status}`}` };
    const count = gitA.exec(git, ['rev-list', '--count', `${row.new_tip}..${main}`], { cwd: repoPath, timeoutMs: 30_000 });
    const list = gitA.exec(git, ['rev-list', `--max-count=${UNRECORDED_LIST}`, `${row.new_tip}..${main}`], { cwd: repoPath, timeoutMs: 30_000 });
    if (!count.ok || !list.ok) return { state: 'UNREADABLE', reason: 'the commits after the trusted tip cannot be listed' };
    return { state: 'TRUSTED', tip: row.new_tip, seq: row.seq, main, unrecordedCount: Number(count.stdout),
      unrecorded: list.stdout.split('\n').filter(Boolean) };
  }
  return { state: 'MAIN_REWRITTEN', main, reason: `no recorded commit is on local main ${main.slice(0, 12)}: main was rewound or rewritten` };
}
