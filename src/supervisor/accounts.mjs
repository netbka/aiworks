// Provider accounts (docs/design/ADAPTIVE_SCHEDULER.md section 4.5, slice RUN3). A usage limit, a failed login or an
// unavailable host belongs to the real account behind a CLI on this host, not to one campaign: every campaign that uses
// the account waits on one row and one success or recheck ends it once. config.json may name the account of an executor
// kind ("providerAccounts": { "claude-cli": "claude-main" }); without a name the account is the executor kind itself, so
// every campaign using that CLI here shares it. Only a name the owner chooses is stored, never a credential.

/** Outcome classes that describe the account (or this host's CLI), not the task: they hold every campaign on the account. */
export const ACCOUNT_SCOPED = new Set(['quota', 'auth', 'unavailable']);

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The account an executor kind uses on this host. A missing or malformed name falls back to the kind. */
export function accountOf(config, kind) {
  const name = config?.providerAccounts?.[kind];
  return typeof name === 'string' && NAME.test(name) ? name : kind;
}

/** The account's current wait row, or null. */
export function accountWait(store, config, kind) {
  return store.get('SELECT * FROM provider_waits WHERE account = ? AND executor_kind = ?', accountOf(config, kind), kind) ?? null;
}

/** Record a wait on the account behind `kind`. `retryAt` null is untimed: only a success or a recheck ends it. */
export function setAccountWait(store, config, { kind, retryAt, reason, campaignId, now }) {
  store.run(`INSERT OR REPLACE INTO provider_waits (account, executor_kind, retry_at, reason, campaign_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`, accountOf(config, kind), kind, retryAt ?? null, reason, campaignId, now);
}

/** End the account's wait; returns whether there was one. */
export function clearAccountWait(store, config, kind) {
  return store.run('DELETE FROM provider_waits WHERE account = ? AND executor_kind = ?', accountOf(config, kind), kind).changes > 0;
}

/**
 * The later of two waits (a campaign row and an account row). Untimed beats any time. During migration a wait recorded
 * in the old per-campaign table before the upgrade is still honoured this way.
 */
export function laterWait(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  if (a.retry_at === null) return a;
  if (b.retry_at === null) return b;
  return a.retry_at >= b.retry_at ? a : b;
}

// ---- Concurrency per account (section 4.5, slice RUN8). No limit until the provider throttles. ----

/** Open worker operations whose executor uses the account behind `kind`, in any campaign; `alsoId` counts that one too. */
export function openOnAccount(store, config, kind, alsoId = null) {
  const account = accountOf(config, kind);
  return store.all("SELECT executor_kind FROM operations WHERE state IN ('recorded', 'dispatched') OR id = ?", alsoId)
    .filter((op) => accountOf(config, op.executor_kind) === account).length;
}

/** The account's concurrency limit, or null: an account that never throttled has no limit at all. */
export function accountLimit(store, config, kind) {
  return store.get("SELECT value FROM capacity WHERE scope = 'account' AND id = ?", accountOf(config, kind))?.value ?? null;
}

function setLimit(store, config, kind, { from, to, reason, campaignId, now }) {
  const account = accountOf(config, kind);
  store.run(`INSERT INTO capacity (scope, id, value, reason, updated_at) VALUES ('account', ?, ?, ?, ?)
    ON CONFLICT (scope, id) DO UPDATE SET value = excluded.value, reason = excluded.reason, updated_at = excluded.updated_at`, account, to, reason, now);
  store.journal(campaignId, to < (from ?? Infinity) ? 'account-concurrency-lowered' : 'account-concurrency-raised',
    { account, executor: kind, from, to, reason }, now);
  return to;
}

/**
 * Is the account behind `kind` at its learned limit? Returns null, or { account, limit, open } for a
 * 'provider-concurrency' wait. Only an account that throttled earlier can be full. A refusal adds the account to
 * `waited`, so its next useful result may raise the limit.
 */
export function accountFull(store, config, kind, waited = null) {
  const limit = accountLimit(store, config, kind);
  if (limit === null) return null;
  const open = openOnAccount(store, config, kind);
  if (open < limit) return null;
  const account = accountOf(config, kind);
  waited?.add(account);
  return { account, limit, open };
}

/**
 * After run `opId` on `kind` finished (scheduler on). A quota outcome sets the account's limit to half of the runs open
 * on it at that moment, this one included, minimum 1; a repeat halves again from what is open then, and a throttle never
 * raises a limit, so repeated refusals converge on one run instead of a retry storm. A useful result while another
 * candidate waited for the account (`waited`) raises its limit by 1. Every change is journalled. Returns the limit.
 */
export function accountAfterRun(store, config, { kind, opId, quota = false, run = 'neutral', waited = null, campaignId, now }) {
  const account = accountOf(config, kind);
  const before = accountLimit(store, config, kind);
  if (quota) {
    const open = openOnAccount(store, config, kind, opId);
    const to = Math.max(1, Math.floor(open / 2));
    if (before !== null && before <= to) return before;
    return setLimit(store, config, kind, { from: before, to, reason: `the provider refused a run for its usage limit with ${open} run(s) open`, campaignId, now });
  }
  if (run !== 'useful') return before;
  const wasWaiting = waited?.delete(account) ?? false;
  if (before === null || !wasWaiting) return before;
  return setLimit(store, config, kind, { from: before, to: before + 1, reason: 'a useful result while work waited for this account', campaignId, now });
}

// ---- Profile selection (docs/design/ACCOUNT_ADAPTER_CAAM.md section 3.3, slice CAAM3). ----
// With the adapter on, an executor kind runs under one of several CAAM profiles, each its own account: its id
// ("claude/work-a") keys its provider_waits row, its capacity row and operations.account_identity. AIWorks chooses the
// profile itself before launch and never wraps a worker in `caam run` (section 1.2 rule 1).

// A profile that is unhealthy, expired or has an untimed wait gives no reset time: the kind is read again after this.
export const PROFILE_RECHECK_MS = 15 * 60_000;

/**
 * Is profile selection on? Only when config.json says "caam": { "enabled": true } and the controller was given a CAAM
 * inventory. Off, every operation keeps the one static account of accountOf and records no account_identity.
 */
export const profilesEnabled = (config, inventory) => config?.caam?.enabled === true && typeof inventory === 'function';

/** Open worker operations bound to this profile, in any campaign. */
export function openOnProfile(store, account) {
  return store.get("SELECT COUNT(*) AS n FROM operations WHERE account_identity = ? AND state IN ('recorded', 'dispatched')", account).n;
}

/**
 * Choose the profile for the next run on `kind` from CAAM's `profiles` (caam.mjs caamRobotStatus records: id, eligible,
 * cooldown). A profile is skipped when CAAM marks it not eligible, when its provider_waits row is untimed or not yet due,
 * or when it is at a learned concurrency limit. Among the rest the least recently used wins: the one whose newest
 * operation is oldest, a never-used one first, ties in CAAM's order. So consecutive dispatches rotate A, B, A, B.
 * Returns { account } or, when no profile may run, { account: null, retryAt, reason }: the earliest reset among the
 * cooling-down profiles, else a re-read after PROFILE_RECHECK_MS. Reads rows only; it records nothing.
 */
export function selectProfile(store, kind, profiles, now) {
  const resets = [];
  const skipped = [];
  const eligible = [];
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const id = profile?.id;
    if (typeof id !== 'string' || id === '') continue;
    if (profile.eligible !== true) {
      const until = profile.cooldown?.until;
      if (Number.isFinite(until) && until > now) resets.push(until);
      skipped.push(`${id}: ${profile.reasons?.join(', ') || 'not eligible in CAAM'}`);
      continue;
    }
    const wait = store.get('SELECT * FROM provider_waits WHERE account = ? AND executor_kind = ?', id, kind);
    if (wait && (wait.retry_at === null || wait.retry_at > now)) {
      if (wait.retry_at !== null) resets.push(wait.retry_at);
      skipped.push(`${id}: ${wait.reason}`);
      continue;
    }
    const limit = store.get("SELECT value FROM capacity WHERE scope = 'account' AND id = ?", id)?.value ?? null;
    if (limit !== null && openOnProfile(store, id) >= limit) {
      skipped.push(`${id}: ${limit} run(s) open, its limit`);
      continue;
    }
    eligible.push({ id, order: eligible.length });
  }
  if (eligible.length) {
    const last = new Map(store.all(`SELECT account_identity AS id, MAX(created_at) AS at, MAX(rowid) AS seq FROM operations
      WHERE account_identity IS NOT NULL GROUP BY account_identity`).map((row) => [row.id, row]));
    const used = (id) => last.get(id) ?? { at: -Infinity, seq: -Infinity };
    eligible.sort((a, b) => used(a.id).at - used(b.id).at || used(a.id).seq - used(b.id).seq || a.order - b.order);
    return { account: eligible[0].id };
  }
  const reason = skipped.length ? `every ${kind} profile waits (${skipped.join('; ')})`.slice(0, 500) : `CAAM lists no ${kind} profile`;
  return { account: null, retryAt: resets.length ? Math.min(...resets) : now + PROFILE_RECHECK_MS, reason };
}
