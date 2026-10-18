// AIWorks worker-context reference helpers. No provider calls, durable store or dispatcher here.
// Inputs describing authority/leases/session provenance must come from the controller,
// not from a model or a browser page. Planning is NOT authorization to mutate a resource.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const POLICY_KEYS = ['version', 'cleanupTimeoutMs', 'maxCleanupAttempts',
  'maxReplacementAttempts', 'maxQuarantinedSessions', 'maxReaperAttempts',
  'maxPacketBytes', 'maxReferences', 'softOccupancy', 'hardOccupancy'];
const text = (value, max = 2000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b, keys) => keys.every((key) => a[key] === b[key]);
const BINDING = ['tenantId', 'projectId', 'environment', 'taskId', 'stageId', 'runId',
  'role', 'revision', 'authorityDigest'];
const result = (action, reason, extra = {}) => Object.freeze({ action, reason, ...extra });
const exactKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const matches = (value, pattern, max = 160) => typeof value === 'string' && value.length <= max && pattern.test(value);
const list = (value, max, item) => Array.isArray(value) && value.length <= max && Array.from(value).every(item);
// The project contract's own formats (schemas/project-contract.schema.json): registry id, authority role,
// repository-relative path with an optional #anchor, local id, and a baseline, Constitution or policy-clause rule.
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]*$/;
const POLICY_ID = /^[A-Z][A-Z0-9]*-[0-9]{3}$/;
const ROLE = /^[a-z][a-z0-9-]*$/;
const PROJECT_PATH = /^(?!(?:[^#]*\/)?\.{1,2}(?:[/#]|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*(?:#[A-Za-z0-9._-]+)?$/;
const LOCAL_ID = /^[a-z0-9][a-z0-9-]*$/;
const RULE = /^(?:constitution#(?:[1-9]|1[0-8])|baseline:[a-z][a-z0-9-]*|policy:[A-Z][A-Z0-9]*-[0-9]{3}#[a-z][a-z0-9-]*)$/;
/**
 * A secret-like repository path, which no authority pointer may name, since workers are told to read authorities. It
 * matches a segment starting `.env`; a `.git`, `.ssh` or `.gnupg` segment; a segment named `id_rsa*`, `id_ed25519*`,
 * `credential(s)` or `secret(s)`, with or without an extension; and a key, certificate or keystore file. Case is ignored
 * through character classes, because JSON schema patterns take no flags. The packet schema and the registry's
 * `projectPath` (schemas/project-contract.schema.json) carry this exact string, so a registry entry cannot declare one.
 */
export const SECRET_LIKE_PATH_PATTERN = '(?:^|/)(?:\\.[Ee][Nn][Vv][^/#]*|\\.[Gg][Ii][Tt]|\\.[Ss][Ss][Hh]|\\.[Gg][Nn][Uu][Pp][Gg]|' +
  '[Ii][Dd]_[Rr][Ss][Aa][^/#]*|[Ii][Dd]_[Ee][Dd]25519[^/#]*|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss]?(?:\\.[^/#]*)?|' +
  '[Ss][Ee][Cc][Rr][Ee][Tt][Ss]?(?:\\.[^/#]*)?)(?:[/#]|$)|\\.(?:[Pp][Ee][Mm]|[Kk][Ee][Yy]|[Pp]12|[Pp][Ff][Xx]|[Jj][Kk][Ss]|' +
  '[Kk][Ee][Yy][Ss][Tt][Oo][Rr][Ee]|[Cc][Rr][Tt]|[Cc][Ee][Rr]|[Dd][Ee][Rr])(?:#|$)';
const SECRET_LIKE_PATH = new RegExp(SECRET_LIKE_PATH_PATTERN, 'u');

/**
 * Optional packet `governance` (governance provider governance inheritance): the target project's inherited governance as values only. Its registry id, the
 * inherited portfolio policy IDs, its declared authority pointers (role and repository-relative path in the target
 * repository) and its declared exceptions and gaps as id and rule. No summaries, sources, approvals or file contents.
 */
export function validGovernance(governance) {
  return exactKeys(governance, ['project', 'policies', 'authorities', 'exceptions', 'gaps']) &&
    matches(governance.project, PROJECT_ID) &&
    list(governance.policies, 64, (id) => matches(id, POLICY_ID)) && new Set(governance.policies).size === governance.policies.length &&
    list(governance.authorities, 32, (item) => exactKeys(item, ['role', 'path']) && matches(item.role, ROLE, 64) &&
      matches(item.path, PROJECT_PATH, 512) && !SECRET_LIKE_PATH.test(item.path)) &&
    ['exceptions', 'gaps'].every((key) => list(governance[key], 32, (item) => exactKeys(item, ['id', 'rule']) &&
      matches(item.id, LOCAL_ID) && matches(item.rule, RULE)));
}

export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
      Object.keys(policy).length !== POLICY_KEYS.length ||
      !POLICY_KEYS.every((key) => Object.hasOwn(policy, key))) throw new TypeError('Invalid context policy keys');
  if (policy.version !== 1 || !integer(policy.cleanupTimeoutMs, 1) || policy.cleanupTimeoutMs > 60000 ||
      policy.maxCleanupAttempts !== 1 || !integer(policy.maxReplacementAttempts, 1) || policy.maxReplacementAttempts > 2 ||
      !integer(policy.maxQuarantinedSessions, 1) || policy.maxQuarantinedSessions > 16 ||
      !integer(policy.maxReaperAttempts, 1) || policy.maxReaperAttempts > 5 ||
      !integer(policy.maxPacketBytes, 1024) || policy.maxPacketBytes > 131072 ||
      !integer(policy.maxReferences, 1) || policy.maxReferences > 128 ||
      !Number.isFinite(policy.softOccupancy) || !Number.isFinite(policy.hardOccupancy) ||
      policy.softOccupancy <= 0 || policy.softOccupancy >= policy.hardOccupancy || policy.hardOccupancy > 0.95) {
    throw new TypeError('Invalid context policy bounds');
  }
  return policy;
}

export function validatePacket(packet, policy) {
  validatePolicy(policy);
  const required = [...BINDING, 'version', 'goal', 'constraints', 'acceptance', 'references', 'access'];
  // `governance` is optional: packets recorded before it existed stay valid with their original digest.
  if (!packet || typeof packet !== 'object' || Array.isArray(packet) || !required.every((key) => Object.hasOwn(packet, key)) ||
      Object.keys(packet).some((key) => !required.includes(key) && key !== 'governance')) {
    throw new TypeError('Invalid task packet keys');
  }
  if (Object.hasOwn(packet, 'governance') && !validGovernance(packet.governance)) throw new TypeError('Invalid task packet governance');
  if (packet.version !== 1 || !BINDING.every((key) => text(packet[key], 160)) ||
      !/^[a-f0-9]{40}$/.test(packet.revision) || !digest(packet.authorityDigest) ||
      !['implementer', 'verification', 'security-review', 'browser-review'].includes(packet.role) ||
      !['read-only', 'write'].includes(packet.access) || !text(packet.goal) ||
      !['constraints', 'acceptance'].every((key) => Array.isArray(packet[key]) && packet[key].length > 0 &&
        packet[key].length <= 32 && Array.from(packet[key]).every((item) => text(item))) ||
      !Array.isArray(packet.references) || packet.references.length === 0 || packet.references.length > policy.maxReferences ||
      !Array.from(packet.references).every((ref) => ref && Object.keys(ref).length === 2 && text(ref.path, 512) &&
        /^[a-f0-9]{40}$/.test(ref.revision) && !ref.path.startsWith('/') && !ref.path.includes('\\') &&
        !ref.path.includes(':') && !ref.path.includes('%') && !/[\u0000-\u001f\u007f]/.test(ref.path) && !ref.path.split('/').some((part) => !part || part === '.' || part === '..'))) {
    throw new TypeError('Invalid task packet fields');
  }
  if (Buffer.byteLength(JSON.stringify(packet), 'utf8') > policy.maxPacketBytes) throw new TypeError('Task packet byte budget exceeded');
  return packet;
}

// Stable over object key order; array order remains meaningful.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function packetDigest(packet, policy) {
  validatePacket(packet, policy);
  return createHash('sha256').update(canonical(packet), 'utf8').digest('hex');
}

/** Pure admission plan. Every action must be revalidated against durable state at execution. */
export function planContext(input, policy) {
  validatePolicy(policy);
  if (!input || typeof input !== 'object') throw new TypeError('Missing admission input');
  const packet = validatePacket(input.packet, policy);
  const { checkpoint, budget, session, capabilities } = input;
  if (packet.role !== 'implementer' && packet.access !== 'read-only') return result('block-branch', 'reviewer-must-be-read-only');
  if (input.authorityCurrent !== true) return result('block-branch', 'authority-unverified');
  if (!checkpoint || checkpoint.committed !== true || checkpoint.packetDigest !== packetDigest(packet, policy) ||
      !same(checkpoint, packet, ['tenantId', 'projectId', 'environment', 'taskId', 'stageId', 'revision', 'authorityDigest'])) {
    return result('block-branch', 'checkpoint-missing-or-stale');
  }
  // This covers already-dispatched external writes too. An expired local lease alone
  // is insufficient when the destination cannot fence or reconcile the old operation.
  if (input.predecessorSafe !== true) return result('block-branch', 'predecessor-not-fenced-or-stopped');
  if (!budget || !integer(budget.inputTokens) || !integer(budget.outputReserveTokens, 1) ||
      !integer(budget.safetyTokens, 1) || !integer(budget.windowTokens, 1)) {
    return result('block-branch', 'context-budget-unknown');
  }
  const used = budget.inputTokens + budget.outputReserveTokens + budget.safetyTokens;
  if (!Number.isSafeInteger(used) || used > Math.floor(budget.windowTokens * policy.hardOccupancy)) {
    return result('repack', 'hard-context-budget', { preserveConstraints: true });
  }
  if (!integer(input.replacementAttempts) || !integer(input.quarantinedSessions)) throw new TypeError('Invalid recovery counters');
  const replace = (reason) => {
    if (input.quarantinedSessions >= policy.maxQuarantinedSessions) return result('block-branch', 'adapter-quarantine-cap');
    if (packet.role === 'browser-review' && capabilities?.dedicatedBrowser !== 'verified') return result('block-branch', 'dedicated-browser-unsupported');
    if (!capabilities || capabilities.freshSession !== 'verified') return result('block-branch', 'fresh-session-unsupported');
    if (input.replacementAttempts >= policy.maxReplacementAttempts) return result('block-branch', 'replacement-budget-exhausted');
    if (input.capacityAvailable !== true) return result('block-branch', 'adapter-capacity-unavailable');
    return result('start-fresh', reason, { retirePrevious: Boolean(session), cleanupOnCriticalPath: false });
  };
  if (!session) return replace('task-boundary');
  if (session.state !== 'active' || session.resetOutstanding !== false) return replace('session-quarantined-or-reset-unsettled');
  if (session.isolation !== 'verified' || session.provenance !== 'fresh-task' ||
      !same(session, packet, BINDING) || session.loadedPacketDigest !== checkpoint.packetDigest ||
      session.access !== packet.access) return replace('session-binding-mismatch');
  if (packet.role === 'browser-review' && session.browserOwnership !== 'dedicated') return replace('shared-browser-context');
  if (packet.role !== 'implementer' && (session.independent !== true || packet.access !== 'read-only')) {
    return result('block-branch', 'reviewer-independence-unverified');
  }
  if (!['not-needed', 'succeeded', 'unsupported', 'failed', 'timed-out'].includes(session.cleanupResult)) {
    return replace('cleanup-result-unverified');
  }
  const degraded = ['failed', 'timed-out', 'unsupported'].includes(session.cleanupResult);
  return result(degraded ? 'continue-degraded' : 'continue', degraded ? 'optional-cleanup-unavailable' : 'current-task-session', {
    maintenance: used > Math.floor(budget.windowTokens * policy.softOccupancy) ? 'checkpoint-and-rotate-at-safe-boundary' : 'none',
  });
}

/** A predicate for an authoritative atomic commit/dispatch transaction, not a lock. */
export function acceptsLease(current, offered, nowMs) {
  const keys = ['tenantId', 'projectId', 'environment', 'taskId', 'stageId', 'runId', 'sessionId', 'revision', 'authorityDigest'];
  if (!current || !offered || !integer(nowMs) || !keys.every((key) => text(current[key], 160) && text(offered[key], 160)) ||
      !/^[a-f0-9]{40}$/.test(current.revision) || !digest(current.authorityDigest) ||
      !integer(current.generation, 1) || !integer(offered.generation, 1) || !integer(current.expiresAtMs, 1)) return false;
  return current.state === 'active' && current.expiresAtMs > nowMs && current.generation === offered.generation && same(current, offered, keys);
}

/** Bound waiting for async cleanup. Timeout DOES NOT prove remote cancellation or erasure.
 * Adapter callbacks must return promptly and must never block this process's event loop.
 * Late outcomes are consumed but cannot change the returned result. No payload is logged.
 */
export async function settleWithin(operation, timeoutMs) {
  if (typeof operation !== 'function' || !integer(timeoutMs, 1) || timeoutMs > 60000) throw new TypeError('Invalid cleanup deadline');
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve(Object.freeze({ status: 'timed-out', remoteSettlement: 'unknown' }));
      // Request cancellation, but do not await it or interpret it as confirmation.
      controller.abort();
    }, timeoutMs);
  });
  const operationResult = Promise.resolve().then(() => operation(controller.signal)).then(
    (value) => Object.freeze({ status: 'succeeded', value, remoteSettlement: 'unknown' }),
    () => Object.freeze({ status: 'failed', remoteSettlement: 'unknown' }),
  );
  try { return await Promise.race([operationResult, deadline]); }
  finally { clearTimeout(timer); }
}
