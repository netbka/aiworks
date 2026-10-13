// Standing release authorization records (docs/design/AUTO_RELEASE.md section 4, slice R1).
// AIWorks reads a project's release record and says whether it is valid and, if not, why. Nothing here acts on a
// record: no release code exists yet, and Auto Release stays off until the owner decides example-org/aiworks#33. Every
// function is pure except loadAuthorization, which only reads one file at one commit of an already fetched ref.
import Ajv2020 from 'ajv/dist/2020.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const RECORD_SCHEMA = 'aiworks-release-authorization/1';
export const MAX_GRANT_DAYS = 90;
// AUTO_RELEASE.md 4.3: no AIWorks grant may accept these in this version, whatever the record says. Widening the
// list is an AW decision, not a record change.
export const FORBIDDEN_CLASSES = Object.freeze(['migration', 'infrastructure', 'permissions']);
const DEPLOYS = new Set(['merge-then-deploy']);
const DAY = 86_400_000;

const validateShape = new Ajv2020({ allErrors: true })
  .compile(JSON.parse(readFileSync(new URL('../../../schemas/release-authorization.schema.json', import.meta.url), 'utf8')));

/** sha256 hex of the record's exact bytes; every later release step binds to this digest. */
export const recordDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A YYYY-MM-DD string that names a real calendar day, as UTC midnight; null otherwise.
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value ? null : time;
}

function shapeReason(error) {
  const where = error.instancePath || 'the record';
  if (error.keyword === 'required') return `${where} is missing ${error.params.missingProperty}`;
  if (error.keyword === 'additionalProperties') return `${where} has unknown field ${error.params.additionalProperty}`;
  if (error.keyword === 'type') return `${where} must be ${error.params.type}`;
  if (error.keyword === 'not' && error.schemaPath.includes('/allOf/0/else/')) return `${where} names baseBranch or mergeMethod, which only merge destinations take`;
  if (error.keyword === 'not') return `${where} is not a plain path inside the project`;
  return `${where} ${error.message}`;
}

/**
 * Validates one parsed record against the schema and the rules of AUTO_RELEASE.md section 4.
 * `project` is the governance registry id the record must name; `now` (a Date or epoch ms) decides expiry.
 * Returns { valid, reasons, destinations }: `reasons` is one plain sentence per problem, empty when valid;
 * `destinations` lists the destination ids of a valid record and is empty otherwise.
 */
export function validateAuthorization(record, { project, now } = {}) {
  const at = now instanceof Date ? now.getTime() : now;
  if (typeof project !== 'string' || !project) throw new TypeError('validateAuthorization needs the expected project id');
  if (!Number.isFinite(at)) throw new TypeError('validateAuthorization needs the evaluation time');
  if (!validateShape(record)) {
    // An if/then branch reports itself as well as the property it found missing; the property is the reason.
    const reasons = validateShape.errors.filter((error) => error.keyword !== 'if').map(shapeReason);
    return { valid: false, reasons: [...new Set(reasons)], destinations: [] };
  }
  const reasons = [];
  if (record.project !== project) reasons.push(`the record is for project ${record.project}, not ${project}`);
  const granted = day(record.grantedAt), expires = day(record.expiresAt);
  if (granted === null) reasons.push(`grantedAt ${record.grantedAt} is not a real date`);
  if (expires === null) reasons.push(`expiresAt ${record.expiresAt} is not a real date`);
  if (granted !== null && expires !== null) {
    if (expires <= granted) reasons.push(`expiresAt ${record.expiresAt} is not after grantedAt ${record.grantedAt}`);
    else if (expires - granted > MAX_GRANT_DAYS * DAY) reasons.push(`expiresAt ${record.expiresAt} is more than ${MAX_GRANT_DAYS} days after grantedAt ${record.grantedAt}`);
  }
  if (granted !== null && granted > at) reasons.push(`the grant starts on ${record.grantedAt}, which is still to come`);
  // The grant counts only while expiresAt is still in the future: it ends at the start of that day (UTC).
  if (expires !== null && expires <= at) reasons.push(`the grant expired on ${record.expiresAt}`);
  if (record.revoked) reasons.push(`grant version ${record.version} is revoked`);
  const seen = new Set();
  for (const destination of record.destinations) {
    const name = `destination ${destination.id}`;
    if (seen.has(destination.id)) reasons.push(`${name} is listed more than once`);
    seen.add(destination.id);
    const forbidden = destination.changeClasses.filter((value) => FORBIDDEN_CLASSES.includes(value));
    if (forbidden.length) reasons.push(`${name} accepts ${forbidden.join(', ')}, which no AIWorks grant may release`);
    const commands = destination.commands ?? {};
    if (DEPLOYS.has(destination.kind) && !commands.deploy) reasons.push(`${name} deploys but names no deploy command`);
    if (DEPLOYS.has(destination.kind) && !commands.observe) reasons.push(`${name} deploys but names no read-only observe command, so a restart could not see what is live`);
    // A merge is rolled back by a revert (AUTO_RELEASE.md 7.3); every other kind needs the project's own rollback.
    if (destination.rollback === 'automatic' && destination.kind !== 'merge' && !commands.rollback) {
      reasons.push(`${name} asks for automatic rollback but names no rollback command`);
    }
  }
  return { valid: reasons.length === 0, reasons, destinations: reasons.length ? [] : record.destinations.map((d) => d.id) };
}

/**
 * Parses and validates a record from its exact bytes (a Buffer or string). Returns the validation result plus the
 * sha256 `digest` of those bytes, so a caller can bind to exactly what it read.
 */
export function parseAuthorization(bytes, options) {
  const digest = recordDigest(bytes);
  let record;
  try { record = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes); } catch {
    return { valid: false, reasons: ['the record is not valid JSON'], destinations: [], digest };
  }
  return { ...validateAuthorization(record, options), digest };
}

/**
 * Reads `path` at the commit `ref` resolves to in `repoPath` and validates it. `ref` is a base ref the caller already
 * fetched (for example `origin/main`); this function never fetches, pushes or writes. `git` is the command array, as
 * in adapters/git.mjs. A ref or file that cannot be read makes the record invalid, never assumed present.
 * Returns the parseAuthorization result plus `commit` (the exact SHA read, or null) and `path`.
 */
export function loadAuthorization({ git = ['git'], repoPath, ref, path, ...options }) {
  const run = (args) => spawnSync(git[0], [...git.slice(1), ...args], { cwd: repoPath, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
  const invalid = (reason, commit = null) => ({ valid: false, reasons: [reason], destinations: [], digest: null, commit, path });
  if (typeof path !== 'string' || !path || path.startsWith('/') || /[\\:\u0000-\u001f]/.test(path) || /(^|\/)\.\.?(\/|$)/.test(path)) {
    return invalid(`record path ${path} is not a plain path inside the project`);
  }
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) return invalid(`base ref ${ref} is not a ref name`);
  const resolved = run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const commit = resolved.status === 0 ? resolved.stdout.toString('utf8').trim() : '';
  if (!/^[0-9a-f]{40}$/.test(commit)) return invalid(`base ref ${ref} cannot be read`);
  const blob = run(['cat-file', 'blob', `${commit}:${path}`]);
  if (blob.status !== 0 || blob.error) return invalid(`there is no release record at ${path} on ${ref} (${commit})`, commit);
  return { ...parseAuthorization(blob.stdout, options), commit, path };
}
