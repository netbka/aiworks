// Provider accounts (docs/design/ADAPTIVE_SCHEDULER.md section 4.5, slice RUN3). A usage limit, a failed login or an
// unavailable host belongs to the real account behind a CLI on this host, not to one campaign: every campaign that uses
// the account waits on one row and one success or recheck ends it once. config.json may name the account of an executor
// kind ("providerAccounts": { "claude-cli": "claude-main" }); without a name the account is the executor kind itself, so
// every campaign using that CLI here shares it. Only a name the owner chooses is stored, never a credential.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from './proc.mjs';
import { Store } from './store.mjs';
import { exportProfileCredentials, importProfileCredentials, removeShallowProfile } from './adapters/caam.mjs';

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

/**
 * Record a wait on the account behind `kind`, or on `account` when the run was bound to a CAAM profile (its
 * operations.account_identity). `retryAt` null is untimed: only a success or a recheck ends it.
 */
export function setAccountWait(store, config, { kind, account = null, retryAt, reason, campaignId, now }) {
  store.run(`INSERT OR REPLACE INTO provider_waits (account, executor_kind, retry_at, reason, campaign_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`, account ?? accountOf(config, kind), kind, retryAt ?? null, reason, campaignId, now);
}

/** End the wait of the account behind `kind`, or of profile `account`; returns whether there was one. */
export function clearAccountWait(store, config, kind, account = null) {
  return store.run('DELETE FROM provider_waits WHERE account = ? AND executor_kind = ?', account ?? accountOf(config, kind), kind).changes > 0;
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

function setLimit(store, config, kind, { account = null, from, to, reason, campaignId, now }) {
  account ??= accountOf(config, kind);
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
 * After run `opId` on `kind` finished (scheduler on, or a run bound to CAAM profile `account`). A quota outcome sets the
 * account's limit to half of the runs open on it at that moment, this one included, minimum 1; a repeat halves again
 * from what is open then, and a throttle never raises a limit, so repeated refusals converge on one run instead of a
 * retry storm. A useful result while another candidate waited for the account (`waited`) raises its limit by 1. With
 * `account` only that profile's row and its runs count: sibling profiles keep their own limits. Every change is
 * journalled. Returns the limit.
 */
export function accountAfterRun(store, config, { kind, account = null, opId, quota = false, run = 'neutral', waited = null, campaignId, now }) {
  const id = account ?? accountOf(config, kind);
  const before = account ? profileLimit(store, account) : accountLimit(store, config, kind);
  if (quota) {
    const open = account ? openOnProfile(store, account, opId) : openOnAccount(store, config, kind, opId);
    const to = Math.max(1, Math.floor(open / 2));
    if (before !== null && before <= to) return before;
    return setLimit(store, config, kind, { account: id, from: before, to, reason: `the provider refused a run for its usage limit with ${open} run(s) open`, campaignId, now });
  }
  if (run !== 'useful') return before;
  const wasWaiting = waited?.delete(id) ?? false;
  if (before === null || !wasWaiting) return before;
  return setLimit(store, config, kind, { account: id, from: before, to: before + 1, reason: 'a useful result while work waited for this account', campaignId, now });
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

/** Open worker operations bound to this profile, in any campaign; `alsoId` counts that one too. */
export function openOnProfile(store, account, alsoId = null) {
  return store.get("SELECT COUNT(*) AS n FROM operations WHERE account_identity = ? AND (state IN ('recorded', 'dispatched') OR id = ?)", account, alsoId).n;
}

/** The profile's learned concurrency limit, or null: a profile that never throttled has none. */
export function profileLimit(store, account) {
  return store.get("SELECT value FROM capacity WHERE scope = 'account' AND id = ?", account)?.value ?? null;
}

/**
 * The profiles of `kind` that have a wait row: provider_waits rows keyed by an account some operation was bound to.
 * A recheck ends them with the static account's row, so a profile whose login failed is not parked for good.
 */
export function profileWaits(store, kind) {
  return store.all(`SELECT account FROM provider_waits WHERE executor_kind = ? AND account IN
    (SELECT account_identity FROM operations WHERE account_identity IS NOT NULL)`, kind).map((row) => row.account);
}

/**
 * Choose the profile for the next run on `kind` from CAAM's `profiles` (caam.mjs caamRobotStatus records: id, eligible,
 * cooldown). A profile is skipped when CAAM marks it not eligible, when its provider_waits row is untimed or not yet due,
 * or when it is at a learned concurrency limit. Among the rest the least recently used wins: the one whose newest
 * operation is oldest, a never-used one first, ties in CAAM's order. So consecutive dispatches rotate A, B, A, B.
 * Returns { account } or, when no profile may run, { account: null, retryAt, reason }: the earliest reset among the
 * cooling-down profiles, else a re-read after PROFILE_RECHECK_MS. Reads rows only; it records nothing. When no profile
 * may run, each one skipped for its concurrency limit is added to `waited`, so its next useful result may raise it.
 */
export function selectProfile(store, kind, profiles, now, waited = null) {
  const full = [];
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
    const limit = profileLimit(store, id);
    if (limit !== null && openOnProfile(store, id) >= limit) {
      full.push(id);
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
  for (const id of full) waited?.add(id);
  const reason = skipped.length ? `every ${kind} profile waits (${skipped.join('; ')})`.slice(0, 500) : `CAAM lists no ${kind} profile`;
  return { account: null, retryAt: resets.length ? Math.min(...resets) : now + PROFILE_RECHECK_MS, reason };
}

/**
 * Remove an account profile from active state: clears its wait row and capacity row in the store.
 */
export function removeAccount(store, config, { kind, account }) {
  const waitCleared = clearAccountWait(store, config, kind, account);
  const capChanges = store.run("DELETE FROM capacity WHERE scope = 'account' AND id = ?", account).changes > 0;
  return { removed: true, account, waitCleared, capCleared: capChanges };
}

/**
 * Detailed usage and workload metrics for an account or executor kind.
 * Aggregates live running operations, learned capacity limit, current cooldown reset timer,
 * and historical run counts (outcomes) and execution duration.
 */
export function accountUsageSummary(store, config, { kind, account = null, now = Date.now() }) {
  const accountId = account ?? accountOf(config, kind);
  const limit = account ? profileLimit(store, accountId) : accountLimit(store, config, kind);
  const open = account ? openOnProfile(store, accountId) : openOnAccount(store, config, kind);
  const wait = store.get('SELECT * FROM provider_waits WHERE account = ? AND executor_kind = ?', accountId, kind) ?? null;

  const ops = account
    ? store.all('SELECT outcome, created_at, updated_at FROM operations WHERE account_identity = ?', accountId)
    : store.all('SELECT outcome, created_at, updated_at FROM operations WHERE executor_kind = ?', kind);

  const outcomes = {};
  let totalDurationMs = 0;
  let lastUsedAt = null;

  for (const op of ops) {
    const outcomeObj = op.outcome;
    const outcome = typeof outcomeObj === 'object' && outcomeObj !== null
      ? (outcomeObj.class ?? 'unknown')
      : (typeof outcomeObj === 'string' ? outcomeObj : 'open');
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (op.updated_at && op.created_at && op.updated_at >= op.created_at) {
      totalDurationMs += (op.updated_at - op.created_at);
    }
    if (op.created_at && (lastUsedAt === null || op.created_at > lastUsedAt)) {
      lastUsedAt = op.created_at;
    }
  }

  const coolingDown = wait !== null && (wait.retry_at === null || wait.retry_at > now);
  const resetInMs = coolingDown && wait.retry_at !== null ? Math.max(0, wait.retry_at - now) : 0;

  return {
    account: accountId,
    executorKind: kind,
    open,
    limit,
    coolingDown,
    resetInMs,
    retryAt: wait?.retry_at ?? null,
    waitReason: wait?.reason ?? null,
    totalOperations: ops.length,
    outcomes,
    totalDurationMs,
    lastUsedAt,
  };
}

// ---- Task model signature and role model preferences ----

/**
 * Format raw usage tokens into a structured breakdown.
 * Returns null if no numeric tokens are reported.
 */
export function formatTokensUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number.isFinite(usage.input) ? usage.input : Number.isFinite(usage.input_tokens) ? usage.input_tokens : null;
  const output = Number.isFinite(usage.output) ? usage.output : Number.isFinite(usage.output_tokens) ? usage.output_tokens : null;
  const cacheRead = Number.isFinite(usage.cacheRead) ? usage.cacheRead : Number.isFinite(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : null;
  const cacheCreation = Number.isFinite(usage.cacheCreation) ? usage.cacheCreation : Number.isFinite(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : null;
  const total = (input ?? 0) + (output ?? 0) + (cacheCreation ?? 0);
  if (input === null && output === null && cacheRead === null && cacheCreation === null) return null;
  return { input, output, cacheRead, cacheCreation, total: total > 0 ? total : null };
}

/**
 * Format a human-readable tokens summary string.
 */
export function formatTokensSummary(tokens) {
  if (!tokens || typeof tokens !== 'object' || tokens.total == null) return 'unreported';
  const parts = [];
  if (tokens.input != null) parts.push(`${tokens.input.toLocaleString()} in`);
  if (tokens.output != null) parts.push(`${tokens.output.toLocaleString()} out`);
  if (tokens.cacheRead != null && tokens.cacheRead > 0) parts.push(`${tokens.cacheRead.toLocaleString()} cached`);
  return `${tokens.total.toLocaleString()} tokens (${parts.join(', ')})`;
}

/**
 * Build a model signature record for a task run.
 * Fields: Name, Type, Effort, Tokens consumed.
 */
export function buildTaskSignature({ model, executorKind, effort = 'standard', usage = null, verifier = null }) {
  const tokens = formatTokensUsage(usage);
  let verifierObj = null;
  if (verifier && typeof verifier === 'object') {
    if (verifier.name && verifier.type) {
      verifierObj = verifier;
    } else {
      verifierObj = buildTaskSignature({
        model: verifier.model,
        executorKind: verifier.executorKind,
        effort: verifier.effort,
        usage: verifier.usage,
      });
    }
  }
  return {
    name: model ?? 'unknown-model',
    type: executorKind ?? 'unknown-type',
    effort: effort ?? 'standard',
    tokens,
    ...(verifierObj ? { verifier: verifierObj } : {}),
  };
}

/**
 * Format markdown lines representing the task's model signature.
 */
export function formatSignatureLines(signature) {
  if (!signature) return [];
  const lines = ['### Model signature', ''];
  lines.push(`- **Implementer**: \`${signature.name}\` (${signature.type}) · Effort: ${signature.effort} · Tokens: ${formatTokensSummary(signature.tokens)}`);
  if (signature.verifier) {
    lines.push(`- **Verifier**: \`${signature.verifier.name}\` (${signature.verifier.type}) · Effort: ${signature.verifier.effort} · Tokens: ${formatTokensSummary(signature.verifier.tokens)}`);
  }
  return lines;
}

/**
 * A role's model order from config.json: its list, or an empty list when the value is missing or not a list. Dispatch
 * reads it on every choice, so a malformed config.json value must never throw there.
 */
export const roleModelOrder = (config, role) => Array.isArray(config?.modelPreferences?.[role]) ? config.modelPreferences[role] : [];

/** The model order of the two roles dispatch reads (executorChoice and routedChoice): implementer and verification. */
export function modelPreferences(config) {
  return { implementer: roleModelOrder(config, 'implementer'), verification: roleModelOrder(config, 'verification') };
}

/**
 * Save model preferences to <dataDir>/config.json.
 */
export function saveModelPreferences(dataDir, preferences) {
  const configFile = join(dataDir, 'config.json');
  let config = {};
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); } catch { config = {}; }
  config.modelPreferences = preferences;
  writeAtomic(configFile, JSON.stringify(config, null, 2));
  return { success: true, modelPreferences: preferences };
}

/**
 * Set model preferences for a single role.
 */
export function setRoleModelPreference(dataDir, role, modelList) {
  const configFile = join(dataDir, 'config.json');
  let config = {};
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); } catch { config = {}; }
  config.modelPreferences = config.modelPreferences ?? {};
  config.modelPreferences[role] = Array.isArray(modelList) ? modelList : [modelList];
  writeAtomic(configFile, JSON.stringify(config, null, 2));
  return { success: true, role, preferences: config.modelPreferences[role] };
}

/**
 * Clear model preferences for a role or all roles.
 */
export function clearRoleModelPreferences(dataDir, role = null) {
  const configFile = join(dataDir, 'config.json');
  let config = {};
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); } catch { config = {}; }
  if (role) {
    if (config.modelPreferences) delete config.modelPreferences[role];
  } else {
    delete config.modelPreferences;
  }
  writeAtomic(configFile, JSON.stringify(config, null, 2));
  return { success: true, cleared: role ?? 'all' };
}

/**
 * Apply model preferences to order candidates for a given role.
 * Candidates matching the preferred models for that role rank ahead of others.
 */
export function applyModelPreferences(candidates, role, config) {
  if (!Array.isArray(candidates) || !candidates.length) return candidates ?? [];
  const prefs = roleModelOrder(config, role);
  if (!prefs.length) return candidates;
  const rank = (c) => {
    const idx = prefs.findIndex((p) => {
      if (typeof p === 'string') return p === c.model || p === c.kind;
      if (p && typeof p === 'object') {
        const matchKind = !p.kind || p.kind === c.kind;
        const matchModel = !p.model || p.model === c.model;
        return matchKind && matchModel;
      }
      return false;
    });
    return idx >= 0 ? idx : Infinity;
  };
  return [...candidates].sort((a, b) => rank(a) - rank(b));
}

/** The role's preference entry for the chosen candidate: an object naming its model (and its kind, when set), or null. */
export const preferenceFor = (config, role, chosen) => roleModelOrder(config, role)
  .find((p) => typeof p === 'object' && p !== null && p.model === chosen?.model && (!p.kind || p.kind === chosen?.kind)) ?? null;

const readConfig = (dataDir) => {
  try { return JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { return {}; }
};

export const shallowHomesRoot = (config, dataDir) => config?.caam?.shallowHomes ?? (dataDir ? join(dataDir, 'profiles') : join(homedir(), '.caam', 'shallow-homes'));

/** Configured AI worker accounts from active operations, provider waits, and local shallow profiles. */
export function configuredAccounts(store, config, { now = Date.now(), dataDir = null } = {}) {
  if (!store) return [];
  const seen = new Set();
  const accounts = [];
  try {
    const opAccounts = store.all('SELECT DISTINCT account_identity, executor_kind FROM operations WHERE account_identity IS NOT NULL');
    for (const { account_identity: id, executor_kind: kind } of opAccounts) {
      if (seen.has(id)) continue;
      seen.add(id);
      const [provider, name] = id.includes('/') ? id.split('/', 2) : [kind.replace('-cli', ''), id];
      const usage = accountUsageSummary(store, config, { kind, account: id, now });
      accounts.push({ id, provider, kind, name, usage });
    }
  } catch { /* operations table may not have account_identity in review fixture */ }

  try {
    const waitAccounts = store.all('SELECT DISTINCT account, executor_kind FROM provider_waits WHERE account IS NOT NULL');
    for (const { account: id, executor_kind: kind } of waitAccounts) {
      if (seen.has(id)) continue;
      seen.add(id);
      const [provider, name] = id.includes('/') ? id.split('/', 2) : [kind.replace('-cli', ''), id];
      const usage = accountUsageSummary(store, config, { kind, account: id, now });
      accounts.push({ id, provider, kind, name, usage });
    }
  } catch { /* table may be empty or missing */ }

  if (dataDir) {
    const root = shallowHomesRoot(config, dataDir);
    if (existsSync(root)) {
      try {
        for (const dirent of readdirSync(root, { withFileTypes: true })) {
          if (dirent.isDirectory()) {
            const name = dirent.name;
            const hasClaude = existsSync(join(root, name, '.claude'));
            const hasCodex = existsSync(join(root, name, '.codex'));
            const hasAgy = existsSync(join(root, name, '.agy'));
            const hasCursor = existsSync(join(root, name, '.cursor'));
            const provider = hasClaude ? 'claude' : hasCodex ? 'codex' : hasAgy ? 'agy' : hasCursor ? 'cursor' : 'claude';
            const kind = `${provider}-cli`;
            const id = `${provider}/${name}`;
            if (!seen.has(id)) {
              seen.add(id);
              const usage = accountUsageSummary(store, config, { kind, account: id, now });
              accounts.push({ id, provider, kind, name, usage });
            }
          }
        }
      } catch { /* ignore directory read errors */ }
    }
  }

  return accounts.sort((a, b) => a.id.localeCompare(b.id));
}

export function addDashboardAccount(dataDir, { provider, name, token, apiKey } = {}) {
  if (!provider || !name) {
    const err = new Error('Provider and name are required.');
    err.status = 400;
    throw err;
  }
  if (!['claude', 'codex', 'agy', 'cursor'].includes(provider)) {
    const err = new Error('Provider must be claude, codex, agy, or cursor.');
    err.status = 400;
    throw err;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    const err = new Error('Account name must contain only letters, numbers, dots, dashes and underscores.');
    err.status = 400;
    throw err;
  }
  const config = readConfig(dataDir);
  const root = shallowHomesRoot(config, dataDir);
  const home = join(root, name);
  if (provider === 'claude') {
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    if (token) {
      writeFileSync(join(claudeDir, '.credentials.json'), JSON.stringify({ token }), { encoding: 'utf8', mode: 0o600 });
    }
  } else if (provider === 'codex') {
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    if (apiKey || token) {
      writeFileSync(join(codexDir, 'auth.json'), JSON.stringify({ api_key: apiKey || token }), { encoding: 'utf8', mode: 0o600 });
    }
  } else if (provider === 'agy') {
    const agyDir = join(home, '.agy');
    mkdirSync(agyDir, { recursive: true });
    if (token || apiKey) {
      writeFileSync(join(agyDir, 'credentials.json'), JSON.stringify({ token: token || apiKey }), { encoding: 'utf8', mode: 0o600 });
    }
  } else if (provider === 'cursor') {
    const cursorDir = join(home, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    if (token || apiKey) {
      writeFileSync(join(cursorDir, 'cli-config.json'), JSON.stringify({ token: token || apiKey }), { encoding: 'utf8', mode: 0o600 });
    }
  }
  return { success: true, account: `${provider}/${name}`, home };
}

export function removeDashboardAccount(dataDir, { provider, name } = {}) {
  if (!provider || !name) {
    const err = new Error('Provider and name are required.');
    err.status = 400;
    throw err;
  }
  const kind = `${provider}-cli`;
  const account = `${provider}/${name}`;
  const config = readConfig(dataDir);
  const root = shallowHomesRoot(config, dataDir);
  const store = new Store(join(dataDir, 'supervisor.db'));
  try {
    const res = removeAccount(store, config, { kind, account });
    const profileRes = removeShallowProfile({ kind, name, root });
    return { success: true, account, removed: res.removed, pathRemoved: profileRes.removed };
  } finally {
    store.close();
  }
}

export function exportDashboardAccounts(dataDir, { passphrase } = {}) {
  if (!passphrase || typeof passphrase !== 'string') {
    const err = new Error('Passphrase is required to encrypt the export bundle.');
    err.status = 400;
    throw err;
  }
  const config = readConfig(dataDir);
  const root = shallowHomesRoot(config, dataDir);
  const store = new Store(join(dataDir, 'supervisor.db'), { readOnly: true });
  try {
    const profiles = [];
    const accounts = configuredAccounts(store, config, { dataDir });
    for (const a of accounts) {
      profiles.push({ provider: a.provider, name: a.name });
    }
    const bundleBuffer = exportProfileCredentials({ root, profiles, passphrase });
    return { success: true, bundleBase64: bundleBuffer.toString('base64'), count: profiles.length };
  } finally {
    store.close();
  }
}

export function importDashboardAccounts(dataDir, { bundleBase64, passphrase } = {}) {
  if (!bundleBase64 || !passphrase) {
    const err = new Error('Export bundle and passphrase are required.');
    err.status = 400;
    throw err;
  }
  const config = readConfig(dataDir);
  const root = shallowHomesRoot(config, dataDir);
  let buffer;
  try {
    buffer = Buffer.from(bundleBase64, 'base64');
  } catch {
    const err = new Error('Invalid export bundle format.');
    err.status = 400;
    throw err;
  }
  try {
    return importProfileCredentials({ root, bundleBuffer: buffer, passphrase });
  } catch (e) {
    const err = new Error(e.message || 'Failed to import accounts.');
    err.status = 400;
    throw err;
  }
}


