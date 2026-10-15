// AIWorks task specs from one accessor (docs/design/WORK_ENVELOPE.md section 6.4, slice E1). A task's spec is the one
// in the stored declaration, or else the live revision of an admitted child task in `task_specs`. Child admission
// (sections 6.3 and 6.4, slice E3) writes those rows: an amendment proposed by a planning step is admitted by the code
// below, never by a model, chained to the envelope digest and idempotent across crash and retry.
// The declared spec always wins, without a query, so the controller's hot paths read exactly what they read before.
import { createHash } from 'node:crypto';
import { SECRET_LIKE_PATH_PATTERN } from '../../scripts/lib/worker-context.mjs';
import { canonicalJson, scopeDigest, validateTask } from './campaign.mjs';
import { containsSecret } from './coordinator.mjs';
import { findWorkConflict, workFingerprint } from './work-ownership.mjs';

const hasTable = (store, name) => Boolean(store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name));

/**
 * Live child specs of a campaign, keyed by task id: the newest revision of each child that is not cancelled. A store
 * opened read-only that predates the tables has none (status never migrates a store).
 */
function childSpecs(store, campaignId, taskId = null) {
  if (!hasTable(store, 'task_specs')) return [];
  const rows = store.all(`SELECT task_id, spec FROM task_specs s WHERE campaign_id = ?${taskId === null ? '' : ' AND task_id = ?'}
    AND cancelled_at IS NULL AND revision = (SELECT MAX(revision) FROM task_specs r WHERE r.campaign_id = s.campaign_id AND r.task_id = s.task_id)
    ORDER BY task_id`, campaignId, ...(taskId === null ? [] : [taskId]));
  return rows.map((row) => [row.task_id, row.spec]);
}

/** The spec of one task: declared, or the live child revision; undefined when there is neither. */
export function specOf(store, campaignId, taskId, declaration = store.campaign(campaignId)?.declaration) {
  const declared = declaration?.tasks?.find((task) => task.id === taskId);
  if (declared) return declared;
  return childSpecs(store, campaignId, taskId)[0]?.[1];
}

/** Every spec of a campaign as a Map by task id: declared tasks in declaration order, then live children. */
export function specsOf(store, campaignId, declaration = store.campaign(campaignId)?.declaration) {
  const specs = new Map((declaration?.tasks ?? []).map((task) => [task.id, task]));
  for (const [id, spec] of childSpecs(store, campaignId)) if (!specs.has(id)) specs.set(id, spec);
  return specs;
}

// ---- Child admission (WORK_ENVELOPE 6.3 and 6.4, slice E3). ----

/** Reserved task ids: the planning step and the generated closing check (WORK_ENVELOPE 6.2 and 6.6). */
export const PLAN_TASK = 'PLAN';
export const ACCEPT_TASK = 'ACCEPT';
/** The structural maximum of tasks per campaign, declared and children together. Not a budget (WORK_ENVELOPE 10). */
export const MAX_CAMPAIGN_TASKS = 128;
export const MAX_AMENDMENT_OPS = 16;

/**
 * What follows each refusal (WORK_ENVELOPE 6.3): `replan` refuses the amendment and leaves it to a later planning step;
 * `owner` is a widening, never retried and never admitted in part; `drop` drops that one operation and keeps the rest.
 */
export const REFUSALS = {
  NOT_A_PLAN_RESULT: 'replan', STALE_PLAN: 'replan', INVALID_TASK: 'replan', UNSAFE_TEXT: 'replan',
  SCOPE_GROWTH: 'owner', WIDEN_FILES: 'owner', WIDEN_CAPABILITY: 'owner', WIDEN_PERMISSION: 'owner', WIDEN_DESTINATION: 'owner',
  WIDEN_RELEASE: 'owner', WIDEN_LIMITS: 'owner', WIDEN_ACCEPTANCE: 'owner',
  DUPLICATE_WORK: 'drop',
};

// Keys a child may never carry, refused by name (A6 to A9). A6 also refuses any other key that is not a task key.
const PERMISSION_KEYS = ['executor', 'providers', 'model', 'permissionMode', 'researchOnly', 'role', 'access'];
const DESTINATION_KEYS = ['target', 'repository', 'baseBranch', 'projectId', 'environment', 'tenantId'];
// Key names to refuse, not release calls: written as one string so the release-boundary scan (AUTO_RELEASE R5), which
// looks for a quoted merge argument, keeps meaning "no merge call outside src/supervisor/release/".
const RELEASE_KEYS = 'release merge deploy apply publish'.split(' ');
const LIMIT_KEYS = ['limits', 'slots', 'maxCostUsd', 'unknownRunCostUsd', 'maxWorkerRuns', 'maxRepairRounds', 'maxRetriesPerTask', 'budget'];
const OP_KEYS = { add: ['op', 'task'], revise: ['op', 'taskId', 'task'], cancel: ['op', 'taskId', 'reason'] };

const sha256 = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const secretLike = new RegExp(SECRET_LIKE_PATH_PATTERN, 'u');
// A4: `\` read as `/`, no trailing `/`, case folded (Windows file systems fold case).
const folded = (entry) => entry.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const covers = (outer, inner) => inner === outer || inner.startsWith(`${outer}/`);
// A13: control characters other than tab and line breaks.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const unsafe = (value) => CONTROL.test(value) || containsSecret(value);

/** sha256 over the canonical amendment (WORK_ENVELOPE 6.4). The parent of seq 1 is the envelope digest. */
export const amendmentDigest = ({ campaignId, seq, parent, scopeDigest: scope, authorizationVersion, sourceOperation, sourcePacketDigest, ops }) =>
  sha256({ campaignId, seq, parent, scopeDigest: scope, authorizationVersion, sourceOperation, sourcePacketDigest, ops });
/** One key per planning operation and proposal: settling the same result again finds the amendment it admitted. */
export const amendmentKey = (campaignId, sourceOperation, ops) => sha256([campaignId, sourceOperation, canonicalJson(ops)]);
export const specDigest = (spec) => sha256(spec);

/** The text fields of one operation that a worker wrote, for A13. */
function texts(op) {
  const task = plainObject(op.task) ? op.task : {};
  return [task.title, task.goal, task.outcome, ...(Array.isArray(task.acceptance) ? task.acceptance : []),
    ...(Array.isArray(task.constraints) ? task.constraints : [])].filter((value) => typeof value === 'string');
}

/** Does any id reachable from `id` through dependsOn lead back to it? */
function cyclic(specs, id) {
  const seen = new Set();
  const walk = (current) => (specs.get(current)?.dependsOn ?? []).some((dep) => dep === id || (!seen.has(dep) && (seen.add(dep), walk(dep))));
  return walk(id);
}

/**
 * Admission of one proposed amendment: a pure function of the approved declaration and the campaign's current plan
 * (WORK_ENVELOPE 6.3). It refuses with the first failing check and the operation index, or returns the operations to
 * admit; a duplicate (A12) drops only its own operation. Nothing here reads or writes the store.
 *
 * - `declaration`: the stored version 2 declaration. Its `envelope` is the boundary and is never widened.
 * - `stored`: `{ scopeDigest, authorizationVersion }` of the campaign row. `head`: the current plan head digest, or null
 *   when the chain does not verify. `merged`: whether the running code is merged (F1).
 * - `specs`: live specs by id (declared, then live children). `retired`: cancelled child ids. `started`: ids of tasks that
 *   have begun work. `childIds`: every child id ever admitted, which counts toward the 128-task maximum and is never reused.
 * - `conflict(task)`: another active campaign's ownership of the task (`findWorkConflict`), or null.
 */
export function admitAmendment({ declaration, stored, head, merged = true, specs, retired = new Set(), started = new Set(),
  childIds = new Set(), amendment, conflict = () => null }) {
  const refuse = (code, index, detail) => ({ admitted: false, code, kind: REFUSALS[code], index, detail });
  const envelope = declaration?.envelope;
  // A0: a structured planning result inside an approved envelope. That it came from a finished `plan` operation of this
  // campaign under the current lease is the caller's half: settleAmendment, inside the controller's fenced settle.
  if (!plainObject(envelope)) return refuse('NOT_A_PLAN_RESULT', null, 'the campaign has no approved envelope to plan inside');
  if (!plainObject(amendment) || Object.keys(amendment).some((key) => !['basis', 'ops', 'rationale'].includes(key)) ||
      typeof amendment.basis !== 'string' || !/^[0-9a-f]{64}$/.test(amendment.basis) || !Array.isArray(amendment.ops) ||
      amendment.ops.length < 1 || amendment.ops.length > MAX_AMENDMENT_OPS ||
      (amendment.rationale !== undefined && !(typeof amendment.rationale === 'string' && amendment.rationale.length <= 2000))) {
    return refuse('NOT_A_PLAN_RESULT', null, `an amendment is { basis, ops (1..${MAX_AMENDMENT_OPS}), rationale? (max 2000) }`);
  }
  if (typeof amendment.rationale === 'string' && unsafe(amendment.rationale)) {
    return refuse('UNSAFE_TEXT', null, 'the rationale holds control characters or credential-like text');
  }
  // A1: the planner saw the current plan of the current approval, and the code that admits it is merged.
  if (head === null) return refuse('STALE_PLAN', null, 'the plan chain does not verify, so there is no current plan head');
  if (amendment.basis !== head) return refuse('STALE_PLAN', null, `basis ${amendment.basis.slice(0, 12)} is not the plan head ${head.slice(0, 12)}`);
  if (scopeDigest(declaration) !== stored.scopeDigest) return refuse('STALE_PLAN', null, 'the envelope digest is not the registered scope');
  if (declaration.authorization?.version !== stored.authorizationVersion) return refuse('STALE_PLAN', null, 'the authorization version changed');
  if (!merged) return refuse('STALE_PLAN', null, 'the running supervisor code is not merged (AW-005)');
  if (envelope.planning !== 'adaptive') return refuse('SCOPE_GROWTH', 0, 'the approved plan is fixed: it takes no added steps');

  const declared = new Set((declaration.tasks ?? []).map((task) => task.id));
  const live = new Map(specs);
  const writes = (envelope.writes ?? []).map(folded);
  const deny = (envelope.denyWrites ?? []).map(folded);
  const pages = plainObject(envelope.web) ? envelope.web.urls.map((url) => new URL(url).origin) : [];
  const origins = [...pages, ...(plainObject(envelope.web) ? envelope.web.resourceOrigins ?? [] : [])];
  const fingerprints = new Map([...live].map(([id, spec]) => [id, workFingerprint(spec)]));
  let total = declared.size + childIds.size;
  const kept = [], dropped = [];

  for (const [index, op] of amendment.ops.entries()) {
    const at = (code, detail) => refuse(code, index, detail);
    if (!plainObject(op) || !Object.hasOwn(OP_KEYS, op.op)) return at('INVALID_TASK', 'op must be add, revise or cancel');
    if (Object.keys(op).some((key) => !OP_KEYS[op.op].includes(key))) return at('INVALID_TASK', `${op.op} takes only ${OP_KEYS[op.op].join(', ')}`);
    const id = op.op === 'add' ? op.task?.id : op.taskId;
    // A10: the closing check and the approved plan stay as the owner approved them.
    if (id === ACCEPT_TASK || declared.has(id)) return at('WIDEN_ACCEPTANCE', `${op.op} names ${id}, which only the owner's approval sets`);
    if (id === PLAN_TASK) return at('INVALID_TASK', `${PLAN_TASK} is reserved for planning steps`);
    if (op.op !== 'add') {
      if (typeof id !== 'string' || !live.has(id)) return at('INVALID_TASK', `${op.op} of ${id}: no live child has that id`);
      if (started.has(id)) return at('INVALID_TASK', `${op.op} of ${id}: the child has already started`);
    }
    if (op.op === 'cancel') {
      if (!(typeof op.reason === 'string' && op.reason.trim() && op.reason.length <= 500)) return at('INVALID_TASK', 'cancel needs a reason (max 500)');
      if (unsafe(op.reason)) return at('UNSAFE_TEXT', 'the cancel reason holds control characters or credential-like text');
      const dependent = [...live].find(([other, spec]) => other !== id && spec.dependsOn?.includes(id));
      if (dependent) return at('INVALID_TASK', `cancel of ${id}: ${dependent[0]} depends on it`);
      live.delete(id);
      fingerprints.delete(id);
      kept.push(op);
      continue;
    }
    const task = op.task;
    if (!plainObject(task)) return at('INVALID_TASK', `${op.op} needs a task object`);
    if (op.op === 'revise' && task.id !== id) return at('INVALID_TASK', `revise of ${id} must keep its id`);
    const named = (list) => Object.keys(task).filter((key) => list.includes(key));
    // A6 to A9 by name, before the generic task rules, so a widening is always named as one.
    if (named(PERMISSION_KEYS).length) return at('WIDEN_PERMISSION', `${id} may not set ${named(PERMISSION_KEYS).join(', ')}`);
    if (named(DESTINATION_KEYS).length) return at('WIDEN_DESTINATION', `${id} may not set ${named(DESTINATION_KEYS).join(', ')}`);
    if (named(RELEASE_KEYS).length) return at('WIDEN_RELEASE', `${id} may not set ${named(RELEASE_KEYS).join(', ')}`);
    if (named(LIMIT_KEYS).length) return at('WIDEN_LIMITS', `${id} may not set ${named(LIMIT_KEYS).join(', ')}`);
    // A13 before the length rules: credential-like or control text is named as unsafe, whatever its length.
    if (texts(op).some(unsafe)) return at('UNSAFE_TEXT', `${id}: a text field holds control characters or credential-like text`);
    // A3, and A6's "only task keys": today's per-task rules. Dependencies must be live tasks, so never a cancelled one.
    const errors = [];
    validateTask(task, `child ${id}`, { seen: new Set([...live.keys()].filter((other) => other !== id)), constraints: declaration.constraints,
      bad: (message) => errors.push(message) });
    const unknown = errors.find((message) => / unknown key /.test(message));
    if (unknown) return at('WIDEN_PERMISSION', `${unknown}: a child has only task keys`);
    if (errors.length) return at('INVALID_TASK', errors.slice(0, 3).join('; '));
    if (op.op === 'add') {
      if (live.has(id) || retired.has(id) || childIds.has(id)) return at('INVALID_TASK', `add of ${id}: the id is already used in this campaign`);
      if (total + 1 > MAX_CAMPAIGN_TASKS) return at('SCOPE_GROWTH', `a campaign holds at most ${MAX_CAMPAIGN_TASKS} tasks: the work grew beyond its plan`);
    }
    // A4: files.
    if (task.deliverable === 'commit') {
      if (!Array.isArray(task.writes)) return at('WIDEN_FILES', `${id} is a commit task without writes`);
      for (const entry of task.writes) {
        const path = folded(entry);
        if (secretLike.test(path)) return at('WIDEN_FILES', `${id} wants to change the secret-like path ${entry}`);
        if (!writes.some((prefix) => covers(prefix, path))) return at('WIDEN_FILES', `${id} wants to change ${entry}, outside the approved files`);
        // A prefix that contains a denied one would let a commit reach it, so overlap in either direction is refused.
        if (deny.some((prefix) => covers(prefix, path) || covers(path, prefix))) return at('WIDEN_FILES', `${id} wants to change ${entry}, which the approval keeps off limits`);
      }
    }
    // A5: capabilities.
    if (!envelope.deliverables.includes(task.deliverable)) return at('WIDEN_CAPABILITY', `${id} wants a ${task.deliverable} deliverable, which the approval does not allow`);
    if (task.references.some((path) => secretLike.test(path))) return at('WIDEN_CAPABILITY', `${id} names a secret-like reference`);
    if (task.web !== undefined && (task.web.urls.some((url) => !pages.includes(new URL(url).origin)) ||
        (task.web.resourceOrigins ?? []).some((origin) => !origins.includes(origin)))) {
      return at('WIDEN_CAPABILITY', `${id} wants a browser origin outside the approved pages`);
    }
    // A7: destination.
    if (!(envelope.issues ?? []).includes(task.issue)) return at('WIDEN_DESTINATION', `${id} reports to issue ${task.issue}, which the approval does not list`);
    // A11: the envelope adds one constraint to every child packet (WORK_ENVELOPE 6.5).
    if (declaration.constraints.length + (task.constraints?.length ?? 0) + 1 > 24) return at('INVALID_TASK', `${id}: campaign + task + envelope constraints exceed 24`);
    if (cyclic(new Map(live).set(id, task), id)) return at('INVALID_TASK', `${id}: dependsOn makes a cycle`);
    // A12: duplicate work, in this campaign or owned by another active one. Only this operation is dropped.
    const fingerprint = workFingerprint(task);
    const twin = [...fingerprints].find(([other, value]) => other !== id && (value === fingerprint ||
      (task.workKey !== undefined && live.get(other)?.workKey === task.workKey)));
    const elsewhere = twin ? null : conflict(task);
    if (twin || elsewhere) {
      dropped.push({ index, code: 'DUPLICATE_WORK', kind: REFUSALS.DUPLICATE_WORK, taskId: id,
        detail: twin ? `${id} repeats ${twin[0]} of this campaign` : `${id} is already owned by ${elsewhere.campaignId}/${elsewhere.ownerTaskId}` });
      continue;
    }
    live.set(id, task);
    fingerprints.set(id, fingerprint);
    if (op.op === 'add') total++;
    kept.push(op);
  }
  if (!kept.length) return { ...refuse('DUPLICATE_WORK', dropped[0].index, 'every operation repeats work that is already owned'), dropped };
  return { admitted: true, ops: kept, dropped };
}

/** The amendment rows of a campaign in seq order; none on a store that predates the tables. */
const amendments = (store, campaignId) => hasTable(store, 'plan_amendments')
  ? store.all('SELECT * FROM plan_amendments WHERE campaign_id = ? ORDER BY seq', campaignId) : [];

/**
 * Recompute the chain from the rows (WORK_ENVELOPE 6.4 and 6.5): seq 1, 2, ... without a gap, each digest recomputed and
 * linked to its parent, seq 1 to the envelope digest; every spec row equal to the task its amendment admitted, every add
 * or revise present as a spec row, every cancelled child cancelled. Returns `{ ok: true, head }` (the envelope digest when
 * there is no amendment) or `{ ok: false, problem }`. Checking it before every dispatch is slice E4.
 */
export function verifyChain(store, campaignId) {
  const campaign = store.campaign(campaignId);
  if (!campaign) return { ok: false, problem: `no campaign ${campaignId}` };
  const rows = amendments(store, campaignId);
  let parent = campaign.scope_digest;
  const admitted = new Map();
  for (const [index, row] of rows.entries()) {
    if (row.seq !== index + 1) return { ok: false, problem: `amendment ${index + 1} is missing` };
    if (row.parent_digest !== parent) return { ok: false, problem: `amendment ${row.seq} does not follow ${parent.slice(0, 12)}` };
    const digest = amendmentDigest({ campaignId, seq: row.seq, parent, scopeDigest: row.scope_digest, authorizationVersion: row.authorization_version,
      sourceOperation: row.source_operation, sourcePacketDigest: row.source_packet_digest, ops: row.ops });
    if (digest !== row.digest) return { ok: false, problem: `amendment ${row.seq} does not match its digest` };
    for (const op of row.ops) if (op.op !== 'cancel') admitted.set(`${op.task.id}\u0000${row.seq}`, op.task);
    parent = digest;
  }
  const specRows = hasTable(store, 'task_specs') ? store.all('SELECT * FROM task_specs WHERE campaign_id = ? ORDER BY task_id, revision', campaignId) : [];
  for (const row of specRows) {
    const key = `${row.task_id}\u0000${row.amendment_seq}`;
    if (!admitted.has(key) || specDigest(row.spec) !== row.spec_digest || specDigest(admitted.get(key)) !== row.spec_digest) {
      return { ok: false, problem: `child ${row.task_id} revision ${row.revision} is not the spec its amendment admitted` };
    }
    admitted.delete(key);
  }
  if (admitted.size) return { ok: false, problem: `child ${[...admitted.keys()][0].split('\u0000')[0]} was admitted without its spec row` };
  for (const row of rows) for (const op of row.ops) {
    if (op.op === 'cancel' && !specRows.some((spec) => spec.task_id === op.taskId && spec.cancelled_at !== null)) {
      return { ok: false, problem: `child ${op.taskId} was cancelled by amendment ${row.seq} but is live` };
    }
  }
  return { ok: true, head: parent };
}

/** The current plan head: the latest amendment digest, or the envelope digest; null when the chain does not verify. */
export function planHead(store, campaignId) {
  const chain = verifyChain(store, campaignId);
  return chain.ok ? chain.head : null;
}

/** The amendment admitted under an idempotency key, or null. */
export const amendmentByKey = (store, key) => store.get('SELECT * FROM plan_amendments WHERE idempotency_key = ?', key);

/**
 * Settle a planning result: admit its amendment and write its rows, or refuse it (WORK_ENVELOPE 6.3 and 6.4). The caller
 * runs this inside the fenced transaction that finishes the planning operation, so both commit or neither does. Settling
 * the same operation and proposal again returns the amendment admitted earlier, unchanged (A2).
 *
 * Returns `{ outcome: 'admitted', seq, digest, ops, dropped }`, `{ outcome: 'repeated', seq, digest }`, `{ outcome: 'none' }`
 * for a result that proposes nothing, or `{ outcome: 'refused', code, kind, index, detail, dropped? }`.
 */
export function settleAmendment(store, { campaign, operation, amendment, merged = true, leaseGeneration, codeRevision = null, now }) {
  if (amendment === undefined || amendment === null) return { outcome: 'none' };
  const id = campaign.id;
  const declaration = campaign.declaration;
  // A0, the caller's half: a planning operation of this campaign.
  if (operation.kind !== 'plan' || operation.task_id !== PLAN_TASK || operation.campaign_id !== id) {
    return { outcome: 'refused', code: 'NOT_A_PLAN_RESULT', kind: REFUSALS.NOT_A_PLAN_RESULT, index: null, detail: `${operation.id} is not a planning operation of ${id}` };
  }
  // A2 before A1: a repeat after a crash finds its own amendment, although that amendment moved the plan head.
  if (plainObject(amendment) && Array.isArray(amendment.ops)) {
    const earlier = amendmentByKey(store, amendmentKey(id, operation.id, amendment.ops));
    if (earlier) return { outcome: 'repeated', seq: earlier.seq, digest: earlier.digest };
  }
  const rows = store.tasks(id);
  const childRows = store.all('SELECT task_id, cancelled_at FROM task_specs WHERE campaign_id = ?', id);
  const { admitted, ...decision } = admitAmendment({
    declaration, amendment, merged,
    stored: { scopeDigest: campaign.scope_digest, authorizationVersion: campaign.authorization_version },
    head: planHead(store, id),
    specs: specsOf(store, id, declaration),
    retired: new Set(childRows.filter((row) => row.cancelled_at !== null).map((row) => row.task_id)),
    started: new Set(rows.filter((row) => row.state !== 'pending' || row.attempts > 0).map((row) => row.task_id)),
    childIds: new Set(childRows.map((row) => row.task_id)),
    conflict: (task) => findWorkConflict(store, { campaignId: id, target: declaration.target, tasks: [task] }),
  });
  if (!admitted) return { outcome: 'refused', ...decision };

  const previous = amendments(store, id).at(-1);
  const seq = (previous?.seq ?? 0) + 1;
  const parent = previous?.digest ?? campaign.scope_digest;
  const ops = decision.ops;
  const digest = amendmentDigest({ campaignId: id, seq, parent, scopeDigest: campaign.scope_digest, authorizationVersion: campaign.authorization_version,
    sourceOperation: operation.id, sourcePacketDigest: operation.packet_digest, ops });
  store.insert('plan_amendments', { campaign_id: id, seq, parent_digest: parent, digest, idempotency_key: amendmentKey(id, operation.id, amendment.ops),
    scope_digest: campaign.scope_digest, authorization_version: campaign.authorization_version, source_operation: operation.id,
    source_packet_digest: operation.packet_digest, lease_generation: leaseGeneration, code_revision: codeRevision, ops, created_at: now });
  let ord = Math.max(0, ...rows.map((row) => row.ord));
  for (const op of ops) {
    if (op.op === 'cancel') {
      // Nothing is deleted: the live revision is marked cancelled and the task row leaves the runnable states.
      store.run(`UPDATE task_specs SET cancelled_at = ? WHERE campaign_id = ? AND task_id = ? AND cancelled_at IS NULL
        AND revision = (SELECT MAX(revision) FROM task_specs WHERE campaign_id = ? AND task_id = ?)`, now, id, op.taskId, id, op.taskId);
      const row = store.task(id, op.taskId);
      if (row) store.patch('tasks', { campaign_id: id, task_id: op.taskId }, row.version, { state: 'cancelled' }, now);
      continue;
    }
    const revision = (store.get('SELECT MAX(revision) AS n FROM task_specs WHERE campaign_id = ? AND task_id = ?', id, op.task.id)?.n ?? 0) + 1;
    store.insert('task_specs', { campaign_id: id, task_id: op.task.id, revision, amendment_seq: seq, spec: op.task,
      spec_digest: specDigest(op.task), fingerprint: workFingerprint(op.task), cancelled_at: null, created_at: now });
    if (op.op === 'add') store.insert('tasks', { campaign_id: id, task_id: op.task.id, ord: ++ord, state: 'pending', version: 1, updated_at: now });
  }
  return { outcome: 'admitted', seq, digest, ops, dropped: decision.dropped };
}
