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
