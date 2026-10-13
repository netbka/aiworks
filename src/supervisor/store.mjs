// AIWorks durable supervisor state. SQLite is the single mutation boundary:
// controller writes run inside BEGIN IMMEDIATE and are fenced by the campaign lease
// generation; owner actions use compare-and-swap on `version`. GitHub comments,
// assignees and log lines are never locks or state.
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const STORE_VERSION = 1;

export class FencedError extends Error {
  constructor(message) { super(message); this.name = 'FencedError'; }
}
export class ConflictError extends Error {
  constructor(message) { super(message); this.name = 'ConflictError'; }
}

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, controller_id TEXT NOT NULL, scope_digest TEXT NOT NULL,
  authorization_version INTEGER NOT NULL, declaration TEXT NOT NULL,
  control TEXT NOT NULL, status TEXT NOT NULL, next_action TEXT, next_wakeup_at INTEGER,
  blocker TEXT, liveness_defect INTEGER NOT NULL DEFAULT 0,
  runs_used INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS leases (
  campaign_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, generation INTEGER NOT NULL,
  code_revision TEXT, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  campaign_id TEXT NOT NULL, task_id TEXT NOT NULL, ord INTEGER NOT NULL, state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, repair_rounds INTEGER NOT NULL DEFAULT 0,
  failures TEXT NOT NULL DEFAULT '{}', base_sha TEXT, head_sha TEXT, verified_sha TEXT,
  findings TEXT, result TEXT, verification TEXT, pr_url TEXT, retry_at INTEGER, blocked TEXT,
  last_error TEXT, version INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, task_id));
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL,
  seq INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, lease_generation INTEGER NOT NULL,
  state TEXT NOT NULL, session_id TEXT NOT NULL, run_dir TEXT NOT NULL, workspace TEXT NOT NULL,
  base_sha TEXT, target_sha TEXT, report_digest TEXT, packet TEXT NOT NULL, packet_digest TEXT NOT NULL,
  outcome TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  executor_kind TEXT NOT NULL DEFAULT 'claude-cli', routing TEXT, account_identity TEXT);
CREATE TABLE IF NOT EXISTS executor_waits (
  campaign_id TEXT NOT NULL, executor_kind TEXT NOT NULL, retry_at INTEGER,
  reason TEXT NOT NULL, PRIMARY KEY (campaign_id, executor_kind));
-- One wait per real provider account (accounts.mjs): a usage limit, failed login or unavailable host holds every campaign
-- that uses the account. retry_at NULL is untimed. campaign_id names the campaign whose run found it (evidence only).
CREATE TABLE IF NOT EXISTS provider_waits (
  account TEXT NOT NULL, executor_kind TEXT NOT NULL, retry_at INTEGER, reason TEXT NOT NULL,
  campaign_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (account, executor_kind));
-- The scheduler's learned fan-out per campaign (scheduler.mjs): starts at 1, grows on useful results while work waited,
-- shrinks on failures. Survives restart and takeover; the host ceiling and pressure gate still apply.
CREATE TABLE IF NOT EXISTS capacity (
  scope TEXT NOT NULL, id TEXT NOT NULL, value INTEGER NOT NULL, reason TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, id));
-- Auto Release (release/state.mjs, slice REL3; built switched off until netbka/aiworks#33). One row per release attempt
-- of one exact verified revision to one destination. A step is recorded started, with no outcome, before it acts; such
-- a row is unknown after a restart until a read-only look proves where the destination is. history is the step log.
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, project TEXT NOT NULL, destination TEXT NOT NULL,
  campaign_id TEXT NOT NULL, task_id TEXT NOT NULL, verified_sha TEXT NOT NULL, attempt INTEGER NOT NULL,
  grant_version INTEGER, grant_digest TEXT, eligibility TEXT, steps TEXT NOT NULL, state TEXT NOT NULL,
  step TEXT, step_key TEXT, step_started_at INTEGER, step_outcome TEXT, history TEXT NOT NULL DEFAULT '[]',
  merge_commit TEXT, deployed_digest TEXT, previous_digest TEXT, backup_path TEXT, reason TEXT,
  instance_id TEXT NOT NULL, generation INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
-- One release per destination (<project>.<destination>) at a time. Freed only at accepted, rolled-back or refused:
-- an unknown or rollback-failed release keeps it, so nothing lands on top of an unknown destination.
CREATE TABLE IF NOT EXISTS release_locks (
  destination TEXT PRIMARY KEY, release_id TEXT NOT NULL UNIQUE, instance_id TEXT NOT NULL, generation INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL);
-- Child tasks inside an approved envelope (docs/design/WORK_ENVELOPE.md section 6.4; accessor plan.mjs). Additive like
-- every table above: CREATE IF NOT EXISTS migrates an older store and the store version stays 1. Append-only: an
-- amendment row is only inserted, a revised child is a new task_specs revision, a cancel only sets cancelled_at.
-- Nothing writes them until child admission (slice E3), so every spec is still the declared one.
CREATE TABLE IF NOT EXISTS plan_amendments (
  campaign_id TEXT NOT NULL, seq INTEGER NOT NULL, parent_digest TEXT NOT NULL, digest TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE, scope_digest TEXT NOT NULL, authorization_version INTEGER NOT NULL,
  source_operation TEXT NOT NULL, source_packet_digest TEXT NOT NULL, lease_generation INTEGER NOT NULL,
  code_revision TEXT, ops TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, seq));
CREATE TABLE IF NOT EXISTS task_specs (
  campaign_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL, amendment_seq INTEGER NOT NULL,
  spec TEXT NOT NULL, spec_digest TEXT NOT NULL, fingerprint TEXT NOT NULL, cancelled_at INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, task_id, revision));
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL, kind TEXT NOT NULL,
  dedup_key TEXT UNIQUE, payload TEXT, received_at INTEGER NOT NULL, processed_at INTEGER);
CREATE TABLE IF NOT EXISTS outbox (
  key TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, target TEXT NOT NULL, body TEXT NOT NULL,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, posted TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS owner_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, source TEXT NOT NULL,
  received_at INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, not_before INTEGER,
  run_id TEXT, read_at INTEGER, answered_at INTEGER, failure TEXT, response_key TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS coordinator_runs (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, session_id TEXT NOT NULL, run_dir TEXT NOT NULL, workspace TEXT NOT NULL,
  message_ids TEXT NOT NULL, outcome TEXT, cost_usd REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blockers (
  fingerprint TEXT PRIMARY KEY, project TEXT NOT NULL, environment TEXT NOT NULL, dependency TEXT NOT NULL,
  class TEXT NOT NULL, identity TEXT NOT NULL, subject TEXT, status TEXT NOT NULL, episode INTEGER NOT NULL DEFAULT 1,
  summary TEXT NOT NULL, requested_action TEXT, recheck_procedure TEXT NOT NULL, probe TEXT,
  first_detected_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, occurrences INTEGER NOT NULL DEFAULT 1,
  recheck_attempts INTEGER NOT NULL DEFAULT 0, next_recheck_at INTEGER, acknowledged_at INTEGER, last_evidence TEXT,
  resolution TEXT, resolved_at INTEGER, last_notified_at INTEGER, reminders INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blocker_parents (
  fingerprint TEXT NOT NULL, campaign_id TEXT NOT NULL, task_id TEXT NOT NULL, phase TEXT NOT NULL, scope TEXT NOT NULL,
  attached_at INTEGER NOT NULL, released_at INTEGER, PRIMARY KEY (fingerprint, campaign_id, task_id));
CREATE TABLE IF NOT EXISTS owner_notifications (
  key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, campaign_id TEXT NOT NULL, kind TEXT NOT NULL, class TEXT NOT NULL,
  message TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, delivered_at INTEGER);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, source_kind TEXT NOT NULL,
  root_path TEXT NOT NULL, root_key TEXT NOT NULL, root_file_id TEXT, fingerprint TEXT,
  github_repository TEXT, base_branch TEXT, local_branch TEXT, mirror_root TEXT, worktree_root TEXT,
  exclusions TEXT NOT NULL DEFAULT '[]', governance TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
  capabilities TEXT NOT NULL, current_baseline TEXT, last_preflight TEXT,
  version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, disconnected_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS projects_live_root ON projects (root_key) WHERE disconnected_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS projects_live_github ON projects (lower(github_repository))
  WHERE disconnected_at IS NULL AND github_repository IS NOT NULL;
CREATE TABLE IF NOT EXISTS project_baselines (
  project_id TEXT NOT NULL, seq INTEGER NOT NULL, commit_sha TEXT NOT NULL, manifest_digest TEXT NOT NULL,
  files INTEGER NOT NULL, bytes INTEGER NOT NULL, excluded TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, seq));
CREATE TABLE IF NOT EXISTS project_overlays (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, entry TEXT NOT NULL, digest TEXT NOT NULL,
  approved_at INTEGER NOT NULL, revoked_at INTEGER);
`;

const JSON_COLUMNS = new Set(['declaration', 'blocker', 'failures', 'findings', 'result', 'verification',
  'blocked', 'packet', 'outcome', 'payload', 'detail', 'message_ids', 'probe', 'last_evidence', 'resolution', 'message',
  'eligibility', 'steps', 'history', 'routing', 'ops', 'spec']);

function decode(row) {
  if (!row) return null;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = JSON_COLUMNS.has(key) && typeof value === 'string' ? JSON.parse(value) : value;
  }
  return out;
}
const encode = (value) => (value === undefined ? null : value !== null && typeof value === 'object' ? JSON.stringify(value) : value);

export class Store {
  constructor(path, { readOnly = false } = {}) {
    if (readOnly && !existsSync(path)) {
      throw Object.assign(new Error('no supervisor.db at the selected data directory; inspect the installed task --data argument'), { code: 'STORE_NOT_FOUND' });
    }
    if (!readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly });
    try {
      this.db.exec('PRAGMA busy_timeout = ' + (readOnly ? 1000 : 10000));
      if (!readOnly) {
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        this.db.exec(DDL);
      }
      const stored = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('store_version');
      if (!stored && !readOnly) this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('store_version', String(STORE_VERSION));
      else if (Number(stored?.value) !== STORE_VERSION) throw new Error(`Unsupported store version; expected ${STORE_VERSION}`);
      const canonicalPath = path === ':memory:' ? path : realpathSync(path);
      const stat = path === ':memory:' ? null : statSync(canonicalPath, { bigint: true });
      this.identity = {
        path: canonicalPath,
        // File identity remains stable across WAL writes; it is not a content checksum.
        id: stat ? createHash('sha256').update(`${stat.dev}:${stat.ino}:${canonicalPath}`).digest('hex') : null,
        schemaVersion: STORE_VERSION,
      };
      this.depth = 0;
      // Only a writer upgrades legacy operations; status/dashboard reads never migrate stores.
      if (!readOnly) this.tx(() => {
        const columns = this.db.prepare('PRAGMA table_info(operations)').all().map((column) => column.name);
        if (!columns.includes('executor_kind')) {
          this.db.exec("ALTER TABLE operations ADD COLUMN executor_kind TEXT NOT NULL DEFAULT 'claude-cli'");
        }
        // The routing receipt (router.mjs, docs/design/MODEL_ROUTING.md section 9) is additive in the same way: an
        // operation recorded before it reads routing as null, and the store version does not change.
        if (!columns.includes('routing')) this.db.exec('ALTER TABLE operations ADD COLUMN routing TEXT');
        // The provider account an operation ran under (docs/design/ACCOUNT_ADAPTER_CAAM.md section 3.1) is additive too:
        // a legacy operation reads account_identity as null, and the store version does not change.
        if (!columns.includes('account_identity')) this.db.exec('ALTER TABLE operations ADD COLUMN account_identity TEXT');
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  /** Synchronous IMMEDIATE transaction; nested calls join the outer transaction. */
  tx(fn) {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* connection already rolled back */ }
      throw error;
    } finally {
      this.depth--;
    }
  }

  get(sql, ...params) { return decode(this.db.prepare(sql).get(...params.map(encode))); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params.map(encode)).map(decode); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params.map(encode)); }

  insert(table, row) {
    const keys = Object.keys(row);
    this.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((key) => row[key]));
  }

  /**
   * Record an operation. One task has at most one open operation, whatever the campaign's parallelism: its implementer
   * and its verifier never overlap. Called inside the dispatch transaction, so the check and the insert commit together.
   * account_identity, when given, is the provider account bound at dispatch (ACCOUNT_ADAPTER_CAAM.md section 3.1); it
   * must be a non-empty string, and an operation recorded without one stores null.
   */
  recordOperation(row) {
    const account = row.account_identity;
    if (account !== undefined && account !== null && (typeof account !== 'string' || account === '')) {
      throw new TypeError('account_identity must be a non-empty string or null');
    }
    const open = this.get("SELECT id FROM operations WHERE campaign_id = ? AND task_id = ? AND state IN ('recorded', 'dispatched')", row.campaign_id, row.task_id);
    if (open) throw new ConflictError(`task ${row.task_id} of ${row.campaign_id} already has the open operation ${open.id}`);
    this.insert('operations', row);
  }

  /** Compare-and-swap update for versioned rows (campaigns, tasks). */
  patch(table, where, expectedVersion, changes, now) {
    const entries = Object.entries(changes);
    const whereKeys = Object.keys(where);
    const sets = [...entries.map(([key]) => `${key} = ?`), 'version = version + 1', 'updated_at = ?'];
    const info = this.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${whereKeys.map((key) => `${key} = ?`).join(' AND ')} AND version = ?`,
      ...entries.map(([, value]) => value), now, ...whereKeys.map((key) => where[key]), expectedVersion);
    if (info.changes !== 1) throw new ConflictError(`${table} ${JSON.stringify(where)} changed since version ${expectedVersion}`);
  }

  updateOperation(id, changes, now) {
    const entries = Object.entries(changes);
    this.run(`UPDATE operations SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      ...entries.map(([, value]) => value), now, id);
  }

  campaign(id) { return this.get('SELECT * FROM campaigns WHERE id = ?', id); }
  tasks(campaignId) { return this.all('SELECT * FROM tasks WHERE campaign_id = ? ORDER BY ord', campaignId); }
  task(campaignId, taskId) { return this.get('SELECT * FROM tasks WHERE campaign_id = ? AND task_id = ?', campaignId, taskId); }
  openOperations(campaignId) {
    return this.all("SELECT * FROM operations WHERE campaign_id = ? AND state IN ('recorded', 'dispatched') ORDER BY created_at", campaignId);
  }
  lease(campaignId) { return this.get('SELECT * FROM leases WHERE campaign_id = ?', campaignId); }
  /** aiworks#1 blocker record by fingerprint. The owner-intervention tables are additive: CREATE IF NOT EXISTS on every
   * writer open migrates an older store, and older code ignores them, so the store version does not change. */
  blocker(fingerprint) { return this.get('SELECT * FROM blockers WHERE fingerprint = ?', fingerprint); }
  // aiworks#7 project tables (projects, project_baselines, project_overlays) are additive in the same way; their rules
  // and JSON fields live in projects.mjs (docs/design/PROJECT_CONNECTION.md section 3).

  journal(campaignId, kind, detail, now) {
    this.run('INSERT INTO journal (campaign_id, at, kind, detail) VALUES (?, ?, ?, ?)', campaignId, now, kind, detail ?? null);
  }

  /** Durable event receipt; a repeated dedup key is acknowledged without a second event. */
  addEvent(campaignId, kind, payload, dedupKey, now) {
    const info = this.run('INSERT OR IGNORE INTO events (campaign_id, kind, dedup_key, payload, received_at) VALUES (?, ?, ?, ?, ?)',
      campaignId, kind, dedupKey ?? null, payload ?? null, now);
    return info.changes === 1;
  }

  /**
   * Acquire or renew the per-campaign controller lease. A live lease held by another
   * instance is never taken; an expired one is replaced with generation + 1. Expiry is
   * suspicion, not proof the old writer stopped: every later write by that writer is
   * rejected by assertLease inside its own transaction.
   */
  acquireLease(campaignId, instanceId, now, ttlMs, codeRevision = null) {
    return this.tx(() => {
      const current = this.lease(campaignId);
      if (current && current.instance_id === instanceId && current.expires_at > now) {
        this.run('UPDATE leases SET expires_at = ? WHERE campaign_id = ?', now + ttlMs, campaignId);
        return { generation: current.generation, renewed: true };
      }
      if (current && current.expires_at > now) return null;
      const generation = (current?.generation ?? 0) + 1;
      if (current) {
        this.run('UPDATE leases SET instance_id = ?, generation = ?, code_revision = ?, acquired_at = ?, expires_at = ? WHERE campaign_id = ?',
          instanceId, generation, codeRevision, now, now + ttlMs, campaignId);
      } else {
        this.insert('leases', { campaign_id: campaignId, instance_id: instanceId, generation, code_revision: codeRevision, acquired_at: now, expires_at: now + ttlMs });
      }
      this.journal(campaignId, 'lease-acquired', {
        instanceId, generation, codeRevision,
        previous: current ? { instanceId: current.instance_id, generation: current.generation, expiresAt: current.expires_at } : null,
      }, now);
      return { generation, renewed: false, takeover: Boolean(current) };
    });
  }

  assertLease(campaignId, instanceId, generation, now) {
    const current = this.lease(campaignId);
    if (!current || current.instance_id !== instanceId || current.generation !== generation || current.expires_at <= now) {
      throw new FencedError(`lease for ${campaignId} is no longer held by ${instanceId} generation ${generation}`);
    }
  }

  releaseLease(campaignId, instanceId, generation, now) {
    this.run('UPDATE leases SET expires_at = ? WHERE campaign_id = ? AND instance_id = ? AND generation = ?', now, campaignId, instanceId, generation);
  }
}
