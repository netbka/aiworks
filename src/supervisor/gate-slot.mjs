// One host-wide full-check owner. SQLite serializes transitions; custody, never time, releases capacity.
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { POWERSHELL, gateProcessIdentity, stopOwnedRunAsync } from './proc.mjs';

export const GATE_CONTEXT = 'AIWORKS_GATE_OWNER';
let configured = null;
let used = false;
let hostFailure = null, retryTimer = null;
const hostArgs = ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)'];
function retryHost() {
  if (retryTimer || !POWERSHELL) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    execFile(POWERSHELL, hostArgs, { encoding: 'utf8', windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      if (!error && stdout.trim()) { configured = join(stdout.trim(), 'AIWorks', '.local', 'gate-slot'); hostFailure = null; }
      else retryHost();
    });
  }, 30_000);
  retryTimer.unref();
}
/** Explicit dependency injection for synthetic process fixtures, before the first host lookup. */
export function configureGateHost({ root }) {
  const next = resolve(root);
  if (used && configured && configured !== next) throw new Error('gate host already selected');
  configured = next;
  hostFailure = null;
}
export function gateHost() {
  used = true;
  if (hostFailure) throw hostFailure;
  if (!configured) {
    if (!POWERSHELL) throw new Error('managed gate custody requires Windows Job Objects');
    const result = spawnSync(POWERSHELL, hostArgs,
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (result.status !== 0 || !result.stdout?.trim()) {
      hostFailure = new Error('host gate directory unavailable'); retryHost(); throw hostFailure;
    }
    configured = join(result.stdout.trim(), 'AIWorks', '.local', 'gate-slot');
  }
  return { root: configured, capacity: 1 };
}
export function gateCheckoutKey(cwd) {
  let path = resolve(cwd);
  try { path = realpathSync(path); } catch { /* an unreadable checkout cannot run, but still has a stable key */ }
  return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
}
export const gateHostKey = (root = gateHost().root) => createHash('sha256').update(resolve(root).toLowerCase()).digest('hex');
const decode = (value) => value ? JSON.parse(value) : null;
const same = (a, b) => a && b && a.requestId === b.requestId && a.generation === b.generation && a.token === b.token;
const identitySame = (a, b) => a?.pid === b?.pid && a?.creationTime === b?.creationTime;
// Presence is only a conservative reason to defer recovery. Only the native identity probe can prove an end.
const maybeAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

export class GateSlotStore {
  constructor(root = gateHost().root, { readOnly = false } = {}) {
    this.root = resolve(root);
    const file = join(this.root, 'slot.sqlite');
    let present = true;
    try { statSync(file); } catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
    if (readOnly && !present) { this.db = null; return; }
    if (!readOnly) mkdirSync(this.root, { recursive: true });
    this.db = new DatabaseSync(file, { readOnly });
    try {
    this.db.exec(`PRAGMA busy_timeout=${readOnly ? 0 : 1000}`);
    if (!readOnly) this.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS slot (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, owner TEXT);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, checkout_key TEXT NOT NULL, head TEXT NOT NULL,
        clean INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, launcher TEXT, identity TEXT,
        generation INTEGER, reason TEXT, exit TEXT, command_digest TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_checkout ON requests(checkout_key) WHERE state IN ('queued','running','held');`);
    if (!readOnly && !present) this.db.prepare('INSERT OR IGNORE INTO slot VALUES (1,0,NULL)').run();
    if (!this.db.prepare('SELECT generation FROM slot WHERE id=1').get()) throw new Error('gate ownership record missing');
    } catch (error) { this.db.close(); this.db = null; throw error; }
  }
  close() { this.db?.close(); }
  write(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  owner() {
    if (!this.db) return null;
    // One SQLite read snapshot: a legitimate concurrent claim/release must not look like contradictory custody.
    const row = this.db.prepare(`SELECT s.owner,s.generation,r.generation AS request_generation,r.state AS request_state,
      r.identity AS request_identity,CASE WHEN s.owner IS NULL THEN
        EXISTS(SELECT 1 FROM requests WHERE state IN ('running','held')) ELSE 0 END AS active_without_owner
      FROM slot s LEFT JOIN requests r ON r.id=json_extract(s.owner,'$.requestId') WHERE s.id=1`).get();
    if (!row || !Number.isSafeInteger(row.generation) || row.generation < 0) throw new Error('gate ownership record invalid');
    if (row.owner === null) {
      if (row.active_without_owner) throw new Error('gate owner missing for active custody');
      return null;
    }
    const owner = decode(row.owner);
    if (!owner || owner.generation !== row.generation || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
        !/^[1-9]\d*$/.test(owner.creationTime ?? '') || typeof owner.requestId !== 'string' || typeof owner.token !== 'string' ||
        !['reserved','attached','running','held'].includes(owner.phase) || typeof owner.attached !== 'boolean') throw new Error('gate custody record invalid');
    const requestIdentity = decode(row.request_identity);
    if (row.request_generation !== owner.generation || !['running','held'].includes(row.request_state) ||
        !identitySame(requestIdentity, owner) || requestIdentity.token !== owner.token || requestIdentity.jobName !== owner.jobName) {
      throw new Error('gate owner and request disagree');
    }
    return owner;
  }
  request(id) {
    const row = this.db?.prepare('SELECT * FROM requests WHERE id=?').get(id);
    return row ? { id: row.id, checkoutKey: row.checkout_key, head: row.head, clean: Boolean(row.clean), state: row.state,
      createdAt: row.created_at, launcher: decode(row.launcher), identity: decode(row.identity), generation: row.generation,
      reason: row.reason, exit: row.exit, commandDigest: row.command_digest, ...decode(row.identity) } : null;
  }
  snapshot({ activeOnly = false } = {}) {
    return { version: 1, generation: this.db?.prepare('SELECT generation FROM slot WHERE id=1').get()?.generation ?? 0,
      owner: this.owner(), requests: (this.db?.prepare("SELECT id FROM requests" + (activeOnly ? " WHERE state IN ('queued','running','held')" : '') + ' ORDER BY created_at,id').all() ?? []).map(({ id }) => this.request(id)) };
  }
  enqueue({ cwd, head, clean, launcher, commandDigest, id = randomUUID(), createdAt = Date.now() }) {
    return this.write(() => {
      const key = gateCheckoutKey(cwd);
      const existing = this.db.prepare("SELECT id FROM requests WHERE checkout_key=? AND state IN ('queued','running','held')").get(key);
      if (existing) return { created: false, request: this.request(existing.id) };
      this.db.prepare("INSERT INTO requests(id,checkout_key,head,clean,state,created_at,launcher,reason,command_digest) VALUES (?,?,?,?,'queued',?,?,'capacity',?)")
        .run(id, key, head, clean ? 1 : 0, createdAt, JSON.stringify(launcher), commandDigest);
      return { created: true, request: this.request(id) };
    });
  }
  bind(id, identity) {
    return this.write(() => {
      const request = this.request(id);
      if (!request || request.state !== 'queued' || request.identity && !identitySame(request.identity, identity)) return false;
      this.db.prepare('UPDATE requests SET identity=? WHERE id=?').run(JSON.stringify(identity), id);
      return true;
    });
  }
  claim(id, identity, jobName, parent = null) {
    return this.write(() => {
      const request = this.request(id), owner = this.owner();
      if (!request || request.state !== 'queued' || !identitySame(request.identity, identity)) return null;
      if (parent ? !same(parent, owner) || owner.attached !== true || owner.phase !== 'attached' : owner !== null) return null;
      let generation = owner?.generation;
      if (!parent) {
        generation = this.db.prepare('SELECT generation FROM slot WHERE id=1').get().generation + 1;
        this.db.prepare('UPDATE slot SET generation=? WHERE id=1').run(generation);
      }
      const lease = { requestId: id, generation, token: randomUUID(), ...identity, jobName, phase: 'reserved', attached: false,
        claimedAt: Date.now(), reason: null, ...(parent ? { parent: { requestId: parent.requestId, generation: parent.generation, token: parent.token } } : {}) };
      if (!parent) this.db.prepare('UPDATE slot SET owner=? WHERE id=1').run(JSON.stringify(lease));
      this.db.prepare("UPDATE requests SET state='running',generation=?,identity=?,reason='starting' WHERE id=?")
        .run(generation, JSON.stringify({ ...identity, jobName, token: lease.token }), id);
      return lease;
    });
  }
  owns(lease) {
    const request = this.request(lease.requestId);
    return same(lease.parent ?? lease, this.owner()) && request?.generation === lease.generation &&
      ['running','held'].includes(request.state) && identitySame(request.identity, lease) && request.identity.token === lease.token;
  }
  attached(lease) {
    return this.write(() => {
      if (!this.owns(lease)) return false;
      if (!lease.parent) {
        const owner = this.owner();
        if (owner.phase !== 'reserved') return false;
        this.db.prepare('UPDATE slot SET owner=? WHERE id=1').run(JSON.stringify({ ...owner, attached: true, phase: 'attached' }));
      }
      this.db.prepare("UPDATE requests SET reason='running' WHERE id=? AND generation=?").run(lease.requestId, lease.generation);
      return true;
    });
  }
  hold(lease, reason) {
    return this.write(() => {
      if (!this.owns(lease)) return false;
      if (!lease.parent) this.db.prepare('UPDATE slot SET owner=? WHERE id=1').run(JSON.stringify({ ...this.owner(), phase: 'held', reason }));
      this.db.prepare("UPDATE requests SET state='held',reason=? WHERE id=? AND generation=?").run(reason, lease.requestId, lease.generation);
      return true;
    });
  }
  finish(lease, exit, reason = null, persist = () => {}, expected = null) {
    return this.write(() => {
      if (!this.owns(lease)) return false;
      if (expected && (this.owner()?.attached !== expected.attached || this.owner()?.phase !== expected.phase)) return false;
      // Evidence is fenced by the very same transaction as release: a stale process cannot overwrite a successor.
      persist();
      this.db.prepare("UPDATE requests SET state=?,exit=?,reason=? WHERE id=? AND generation=?")
        .run(String(exit) === '0' ? 'finished' : 'failed', String(exit), reason, lease.requestId, lease.generation);
      if (!lease.parent) {
        this.db.prepare("UPDATE requests SET state='failed',exit='outer-ended',reason='custody-stopped' WHERE generation=? AND id<>? AND state IN ('running','held')")
          .run(lease.generation, lease.requestId);
        this.db.prepare('UPDATE slot SET owner=NULL WHERE id=1').run();
      }
      return true;
    });
  }
  failQueued(id, identity, reason, persist = () => {}) {
    return this.write(() => {
      const request = this.request(id);
      if (!request || request.state !== 'queued' || !identitySame(request.identity ?? request.launcher, identity)) return false;
      persist();
      this.db.prepare("UPDATE requests SET state='failed',exit=?,reason=? WHERE id=?").run(reason, reason, id);
      return true;
    });
  }
}

/** Never terminates a live owner to obtain capacity. A reserved intent has not been permitted to execute. */
export async function recoverGateOwner(store, snapshot = store.owner()) {
  if (!snapshot) return true;
  if (maybeAlive(snapshot.pid)) return false;
  const identity = await gateProcessIdentity(snapshot);
  if (identity !== 'not-running') return false;
  // Attachment may have committed while the process probe was pending. Never use pre-probe reserved state.
  const current = store.owner();
  if (!same(current, snapshot)) return false;
  if (current.attached) {
    const stopped = await stopOwnedRunAsync({ ...current, containment: 'windows-job-v1' });
    if (!['stopped', 'not-running'].includes(stopped)) return false;
  }
  // A reserved owner cannot have sent a permit: attached is durably committed before that write. Do not touch a job
  // named only in intent: Attach may have refused a pre-existing object with that name.
  return store.finish(current, 'owner-ended', current.attached ? 'custody-stopped' : 'not-permitted', () => {}, current);
}

/** Revoking an unclaimed dead request fences out even a child that starts late: bind/claim both check its state. */
export async function recoverQueuedRequests(store, { limit = Infinity } = {}) {
  let checked = 0;
  for (const request of store.snapshot({ activeOnly: true }).requests.filter((r) => r.state === 'queued')) {
    const identity = request.identity ?? request.launcher;
    if (maybeAlive(identity?.pid)) continue;
    if (await gateProcessIdentity(identity) === 'not-running') store.failQueued(request.id, identity, 'requester-ended');
    if (++checked >= limit) break;
  }
}

/** Supervisor maintenance, independent of paid admission. Read-only views never recover or wait on native probes. */
export function startGateRecovery({ intervalMs = 10_000, log = () => {} } = {}) {
  let pending = null, stopped = false, lastProblem = null;
  const poll = () => {
    if (pending || stopped) return pending;
    pending = (async () => {
      let store;
      try {
        const activity = gateActivity();
        if (!activity.available || !activity.owner && !activity.requests.some((r) => r.state === 'queued')) return;
        store = new GateSlotStore();
        await recoverGateOwner(store);
        await recoverQueuedRequests(store, { limit: 1 });
        lastProblem = null;
      } catch (error) {
        const problem = error.code ?? error.message;
        if (problem !== lastProblem) log(`full-check custody recovery deferred: ${problem}`);
        lastProblem = problem;
      } finally { store?.close(); }
    })().finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(poll, intervalMs);
  timer.unref();
  poll();
  return { poll, async stop() { stopped = true; clearInterval(timer); await pending; } };
}

/** Read-only pressure/status. Failure is unavailable, never a count of zero. */
export function gateActivity() {
  let store;
  try {
    store = new GateSlotStore(gateHost().root, { readOnly: true });
    const state = store.snapshot({ activeOnly: true });
    return { available: true, count: (state.owner ? 1 : 0) + state.requests.filter((r) => r.state === 'queued').length, ...state };
  } catch { return { available: false, count: null, owner: null, requests: [] }; }
  finally { store?.close(); }
}

/** Current-operation mapping only: an older same-head request never labels a later attempt. */
export function operationGateWait(operation, activity = null) {
  if (!operation?.workspace) return null;
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(operation.workspace, 'gate-request.log'), 'utf8')); } catch { return null; }
  if (!Number.isFinite(receipt.createdAt) || receipt.createdAt < operation.created_at) return null;
  activity ??= gateActivity();
  if (!activity.available) return { code: 'gate-unavailable', state: 'unavailable' };
  const request = activity.requests.find((r) => r.id === receipt.id && r.generation === receipt.generation &&
    r.createdAt === receipt.createdAt && r.createdAt >= operation.created_at && r.checkoutKey === gateCheckoutKey(operation.workspace) &&
    (!operation.target_sha || r.head === operation.target_sha));
  if (!request || !['queued', 'held'].includes(request.state)) return null;
  return { code: request.state === 'held' ? 'gate-custody' : 'gate-slot', state: request.state, since: request.createdAt };
}
