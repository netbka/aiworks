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
