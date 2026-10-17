// AIWorks local project overlay entries (aiworks#7, docs/design/PROJECT_CONNECTION.md section 7, slice S7): the rules
// the owner confirmed for one project without GitHub. An entry passes the schema AIWorks ships
// (schemas/local-project-overlay.schema.json) and then rules 2 to 7 of section 7.3(b), which the schema cannot express.
// An entry can only add or tighten rules. This module only reads: it never writes an entry, the store or the governance
// directory, and it starts nothing. Policies come from campaign.mjs overlayGovernance, by the registry derivation.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { SECRET_LIKE_PATH_PATTERN } from '../../scripts/lib/worker-context.mjs';
import { canonicalJson } from './campaign.mjs';
import { requireGovernanceRoot } from './governance.mjs';

const validateShape = new Ajv2020({ allErrors: true })
  .compile(JSON.parse(readFileSync(new URL('../../schemas/local-project-overlay.schema.json', import.meta.url), 'utf8')));
const SECRET_LIKE_PATH = new RegExp(SECRET_LIKE_PATH_PATTERN, 'u');
const DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const MAX_REVIEW_DAYS = 365;

export class OverlayError extends Error {
  constructor(code, message) { super(message); this.name = 'OverlayError'; this.code = code; }
}
const refuse = (code, message) => { throw new OverlayError(code, message); };
const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** `sha256:` and the SHA-256 of the canonical JSON of the entry without `approval` (rule 6): any later edit changes it. */
export function overlayDigest(entry) {
  return `sha256:${createHash('sha256').update(canonicalJson({ ...entry, approval: undefined }), 'utf8').digest('hex')}`;
}

// A calendar day as UTC milliseconds, or null when the text is not a real date (2026-02-30 is not).
const dayMs = (text) => {
  const match = DAY.exec(String(text));
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms).toISOString().slice(0, 10) === text ? ms : null;
};

/**
 * What the governance directory gives every overlay entry (rules 2 and 3): its registry ids and the capability words of
 * its schemas/project-contract.schema.json, read now and read-only. A missing or unreadable root, registry, contract
 * schema or policy catalog makes every entry inert: RULES_UNAVAILABLE, with no fallback rule set.
 */
function governanceFacts(governanceRoot) {
  try {
    const root = requireGovernanceRoot(governanceRoot);
    const registryDir = join(root, 'registry', 'projects');
    const registryIds = new Set(readdirSync(registryDir).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(registryDir, name), 'utf8'))?.id).filter((id) => typeof id === 'string'));
    const schema = JSON.parse(readFileSync(join(root, 'schemas', 'project-contract.schema.json'), 'utf8'));
    const words = schema?.properties?.capabilities?.items?.enum;
    if (!Array.isArray(words) || !words.every((word) => typeof word === 'string')) throw new TypeError('the contract schema lists no capabilities');
    const catalog = JSON.parse(readFileSync(join(root, 'policies', 'catalog.json'), 'utf8'));
    if (!Array.isArray(catalog?.policies)) throw new TypeError('policies/catalog.json lists no policies');
    for (const path of catalog.policies) JSON.parse(readFileSync(join(root, path), 'utf8'));
    return { root, registryIds, capabilities: new Set(words) };
  } catch (error) {
    refuse('RULES_UNAVAILABLE', `the governance directory cannot be read, so no local project's rules apply (${error.code ?? error.message})`);
  }
}

/**
 * Validates one overlay entry at admission or before dispatch (section 7.4) and returns it with the governance root it
 * was checked against. Refusals carry a code:
 *   RULES_UNAVAILABLE             the governance directory is missing or unreadable (rule 2);
 *   RULES_REPOSITORY              the entry names a repository, resources or secrets (only a registry entry may);
 *   RULES_EXCEPTION               the entry declares an exception (rule 5);
 *   RULES_RELEASE_AUTHORIZATION   the entry declares a release authorization (rule 5);
 *   RULES_ENVIRONMENT             `environments` is anything but ["local"] (rule 5);
 *   RULES_VERIFICATION_OFF        the independent verification gate is not `enabled` (rule 5);
 *   RULES_ID_PREFIX               the id does not start with `lp-` (rule 4);
 *   RULES_INVALID                 any other departure from schemas/local-project-overlay.schema.json;
 *   RULES_PATH                    an authority path that is not repository-relative, or is secret-like (rule 5);
 *   RULES_UNKNOWN_CAPABILITY      a capability the governance contract schema does not list (rule 3);
 *   RULES_ID_REGISTERED           the id is a registry id in the governance directory (rule 4);
 *   RULES_ID_REUSED               the id is held by another overlay entry, live or revoked (rule 4);
 *   RULES_DIGEST_MISMATCH         `approval.digest` is not the digest of this exact entry (rule 6);
 *   RULES_REVIEW_TOO_FAR          `reviewBy` is more than 365 days after `approval.at`, or before it (rule 7);
 *   RULES_EXPIRED                 today is after `reviewBy` (rule 7).
 * `takenIds` are the ids of every other overlay entry this installation has stored, revoked ones included; `now` is
 * the time of the check.
 */
export function validateOverlayEntry(entry, governanceRoot, { takenIds = [], now = new Date() } = {}) {
  const facts = governanceFacts(governanceRoot);
  if (!plainObject(entry)) refuse('RULES_INVALID', 'a local project entry must be a JSON object');
  // The loosening fields get their own code before the schema check, so the owner sees which rule an entry broke.
  const loosening = ['repository', 'resources', 'secrets'].filter((key) => Object.hasOwn(entry, key));
  if (loosening.length) refuse('RULES_REPOSITORY', `a local project entry cannot name ${loosening.join(', ')}: register a GitHub project in governance instead`);
  const governance = plainObject(entry.governance) ? entry.governance : {};
  if (Object.hasOwn(governance, 'exceptions')) refuse('RULES_EXCEPTION', 'a local project entry cannot declare an exception: it can only add or tighten rules');
  if (Object.hasOwn(governance, 'releaseAuthorization')) refuse('RULES_RELEASE_AUTHORIZATION', 'a local project entry cannot declare a release authorization');
  if (canonicalJson(entry.environments) !== '["local"]') refuse('RULES_ENVIRONMENT', 'a local project entry is for the local environment only: environments must be ["local"]');
  if (governance.independentVerificationGate !== 'enabled') refuse('RULES_VERIFICATION_OFF', 'a local project entry keeps independent verification on: independentVerificationGate must be "enabled"');
  if (typeof entry.id !== 'string' || !entry.id.startsWith('lp-')) refuse('RULES_ID_PREFIX', 'a local project entry id starts with lp-');
  if (!validateShape(entry)) {
    const first = validateShape.errors.slice(0, 3).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
    refuse('RULES_INVALID', `local project entry ${entry.id} does not satisfy schemas/local-project-overlay.schema.json: ${first}`);
  }
  for (const { path } of entry.governance.authorities ?? []) {
    if (path.startsWith('/') || /[\\:%\u0000-\u001f\u007f]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
      refuse('RULES_PATH', `authority path ${path} is not a path inside the project`);
    }
    if (SECRET_LIKE_PATH.test(path)) refuse('RULES_PATH', `authority path ${path} looks like a secret file, which no worker may be told to read`);
  }
  const unknown = entry.capabilities.filter((word) => !facts.capabilities.has(word));
  if (unknown.length) refuse('RULES_UNKNOWN_CAPABILITY', `capability ${unknown.join(', ')} is not in the governance directory's capability list`);
  if (facts.registryIds.has(entry.id)) refuse('RULES_ID_REGISTERED', `${entry.id} is already a registered project id in the governance directory`);
  if (Array.from(takenIds).includes(entry.id)) refuse('RULES_ID_REUSED', `${entry.id} was already used by another local project; ids are never reused`);
  if (entry.approval.digest !== overlayDigest(entry)) refuse('RULES_DIGEST_MISMATCH', `the owner's confirmation does not match local project entry ${entry.id}: it changed after it was confirmed`);
  const approvedAt = dayMs(entry.approval.at);
  const reviewBy = dayMs(entry.reviewBy);
  if (approvedAt === null || reviewBy === null) refuse('RULES_INVALID', 'approval.at and reviewBy must be real calendar days');
  if (reviewBy < approvedAt || reviewBy - approvedAt > MAX_REVIEW_DAYS * 86400000) {
    refuse('RULES_REVIEW_TOO_FAR', `reviewBy must be at most ${MAX_REVIEW_DAYS} days after the owner's confirmation`);
  }
  const today = dayMs(new Date(now).toISOString().slice(0, 10));
  if (today > reviewBy) refuse('RULES_EXPIRED', `the rules for ${entry.id} expired on ${entry.reviewBy}: the owner must renew them`);
  return { entry, root: facts.root };
}
