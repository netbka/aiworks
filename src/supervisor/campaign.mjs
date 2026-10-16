// AIWorks campaign declarations: an explicit owner assignment with immutable scope
// and a simple declared DAG. Limits and authorization may change only with a higher
// authorization version; executor-only amendments also require an idle, paused campaign. Version 2 adds an approval
// `envelope` (docs/design/WORK_ENVELOPE.md section 4, slice E2) that bounds every task; version 1 is unchanged.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { SECRET_LIKE_PATH_PATTERN, validGovernance } from '../../scripts/lib/worker-context.mjs';
import { safeResearchPath } from './adapters/research-context.mjs';
import { parseReference } from './reading.mjs';
import { requireGovernanceRoot, roleCatalog } from './governance.mjs';
// local-overlay.mjs imports canonicalJson from here; each module calls the other's functions only at run time.
import { OverlayError, validateOverlayEntry } from './local-overlay.mjs';

// The registry's own schema (governance provider's schemas/project-contract.schema.json, read from the governance root),
// compiled once per root on first use: it alone decides which registry fields are legal.
const projectContracts = new Map();
const contractSchemaErrors = (contract, root) => {
  if (!projectContracts.has(root)) {
    projectContracts.set(root, new Ajv2020({ allErrors: true })
      .compile(JSON.parse(readFileSync(join(root, 'schemas', 'project-contract.schema.json'), 'utf8'))));
  }
  const validate = projectContracts.get(root);
  return validate(contract) ? null : validate.errors;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PERMISSION_MODES = ['auto', 'dontAsk', 'acceptEdits', 'plan']; // never bypassPermissions
const EXECUTOR_KINDS = ['codex-cli', 'cursor-cli', 'claude-cli', 'agy-cli'];
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const int = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
// A page the browser worker may open: http(s), no embedded credentials, no characters that change a URL pattern.
const webUrl = (url) => {
  if (!text(url, 500) || /[\s*{}()\\]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch { return false; }
};
// The owner's own control planes on this host: the supervisor dashboard and local control service. A browser worker that could
// load them could pause or cancel campaigns, or message the coordinator as the owner, so no web task may name their
// ports on any host: loopback has too many spellings (localhost., foo.localhost., [::ffff:127.0.0.1]) to list safely.
const CONTROL_PLANE_PORTS = ['4318', '17321'];
const controlPlane = (url) => CONTROL_PLANE_PORTS.includes(new URL(url).port);
const safePath = (path) => text(path, 512) && !path.startsWith('/') && !/[\\:%\u0000-\u001f\u007f]/.test(path) &&
  !path.split('/').some((part) => !part || part === '.' || part === '..');

// A write-domain entry: a safe path prefix (a trailing slash marks a directory) or a named exclusive resource.
const writeEntry = (entry) => typeof entry === 'string' && (/^resource:[a-z0-9][a-z0-9._-]{0,63}$/.test(entry) ||
  safePath(entry.endsWith('/') ? entry.slice(0, -1) : entry));
const pathPrefix = (entry) => typeof entry === 'string' && safePath(entry.endsWith('/') ? entry.slice(0, -1) : entry);
// An governance provider role id (registry/agents.json); whether it exists is checked against the catalog at registration.
const ROLE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TASK_KEYS = ['id', 'issue', 'title', 'outcome', 'workKey', 'writes', 'deliverable', 'goal', 'dependsOn', 'requiresMergedDependencies',
  'constraints', 'acceptance', 'references', 'web', 'role', 'routing'];
const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const sha256 = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

/**
 * Digest of the immutable scope (everything except authorization, limits and the owner-facing `purpose`/task
 * `outcome` wording, which never reaches a worker packet). Changing that wording needs a higher authorization version.
 */
export const scopeDigest = (declaration) => sha256({ ...declaration, authorization: undefined, limits: undefined, purpose: undefined,
  tasks: Array.isArray(declaration?.tasks) ? declaration.tasks.map((task) => task && typeof task === 'object' ? { ...task, outcome: undefined } : task) : declaration?.tasks });
/** Digest of the whole current authority; bound into every worker packet. */
export const authorityDigest = (declaration) => sha256(declaration);

/**
 * Effective limits. Every limit is optional and defaults to no limit: an omitted or null limit never
 * stops work; only provider subscription/usage limits (which the supervisor waits out) do. Parallel
 * slots default to 1; `limits.slots` may be 1..8 or "auto", which the scheduler (slice RUN5) honours once it is enabled.
 */
export function campaignLimits(declaration) {
  const l = declaration?.limits ?? {};
  return {
    slots: l.slots ?? 1,
    maxWorkerRuns: l.maxWorkerRuns ?? null,
    maxRepairRounds: l.maxRepairRounds ?? null,
    maxRetriesPerTask: l.maxRetriesPerTask ?? null,
    maxCostUsd: l.maxCostUsd ?? null,
    unknownRunCostUsd: l.unknownRunCostUsd ?? null,
  };
}

export const executorOrder = (executor) => executor.kind === 'cli-chain' ? executor.providers : [executor];

export function validateDeclaration(declaration) {
  const errors = [];
  const bad = (message) => errors.push(message);
  const d = declaration;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new TypeError('campaign declaration must be an object');
  // Only a version 2 declaration may carry `envelope`; on version 1 it stays an unknown key, as before.
  const allowed = ['version', 'campaignId', 'purpose', 'authorization', 'target', 'limits', 'executor', 'routing', 'constraints', 'tasks',
    ...(d.version === 2 ? ['envelope'] : [])];
  for (const key of Object.keys(d)) if (!allowed.includes(key)) bad(`unknown key ${key}`);
  if (d.version !== 1 && d.version !== 2) bad('version must be 1, or 2 with an envelope');
  if (!ID.test(d.campaignId ?? '')) bad('campaignId must match [A-Za-z0-9._-], max 64');
  // Optional plain-language wording for the owner's dashboard; never part of a worker packet.
  if (d.purpose !== undefined && !text(d.purpose, 300)) bad('purpose must be a non-empty string (max 300)');

  const a = d.authorization ?? {};
  if (!int(a.version, 1, 10000)) bad('authorization.version must be a positive integer');
  if (!text(a.grantedBy, 80)) bad('authorization.grantedBy required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.grantedAt ?? '')) bad('authorization.grantedAt must be YYYY-MM-DD');
  if (!/^https:\/\/github\.com\//.test(a.reference ?? '')) bad('authorization.reference must be a GitHub URL');
  if (!text(a.text, 2000)) bad('authorization.text required (max 2000)');
  if (a.readSources !== undefined && (!Array.isArray(a.readSources) || a.readSources.length > 4 ||
      !a.readSources.every((s) => s && REPO.test(s.repository ?? '') && Array.isArray(s.paths) &&
        s.paths.length > 0 && s.paths.length <= 16 && s.paths.every(safeResearchPath) &&
        Object.keys(s).every((k) => ['repository', 'paths'].includes(k))))) bad('authorization.readSources must declare bounded safe repository paths');

  const t = d.target ?? {};
  for (const key of ['tenantId', 'projectId', 'environment']) if (!text(t[key], 160)) bad(`target.${key} required`);
  if (!REPO.test(t.repository ?? '')) bad('target.repository must be owner/name');
  if (!ID.test(t.baseBranch ?? '')) bad('target.baseBranch required');
  if (!int(t.trackingIssue, 1, 1e9)) bad('target.trackingIssue must be an issue number');

  if (d.limits !== undefined && (d.limits === null || typeof d.limits !== 'object' || Array.isArray(d.limits))) bad('limits must be an object when present');
  const l = d.limits && typeof d.limits === 'object' ? d.limits : {};
  // Every limit is optional. Omitted or null means no limit (the default): work then stops only on provider
  // subscription/usage limits, which the supervisor waits out. A budget is set only when the owner declares one.
  if (l.maxWorkerRuns != null && !int(l.maxWorkerRuns, 1, 100)) bad('limits.maxWorkerRuns must be 1..100, or omitted/null for no limit');
  if (l.slots != null && !(l.slots === 'auto' || int(l.slots, 1, 8))) bad('limits.slots must be 1..8 or "auto"');
  if (l.maxRepairRounds != null && !int(l.maxRepairRounds, 0, 5)) bad('limits.maxRepairRounds must be 0..5, or omitted/null for no limit');
  if (l.maxRetriesPerTask != null && !int(l.maxRetriesPerTask, 0, 5)) bad('limits.maxRetriesPerTask must be 0..5, or omitted/null for no limit');
  for (const key of Object.keys(l)) if (!['maxWorkerRuns', 'slots', 'maxRepairRounds', 'maxRetriesPerTask', 'maxCostUsd', 'unknownRunCostUsd'].includes(key)) bad(`unknown limits key ${key}`);
  // Optional cost ceiling in USD; runs whose provider reports no cost are priced at a declared conservative value.
  if (l.maxCostUsd != null && !(Number.isFinite(l.maxCostUsd) && l.maxCostUsd >= 1 && l.maxCostUsd <= 10000)) bad('limits.maxCostUsd must be 1..10000, or omitted/null for no ceiling');
  if (l.maxCostUsd != null && !(Number.isFinite(l.unknownRunCostUsd) && l.unknownRunCostUsd >= 0.5 && l.unknownRunCostUsd <= 100)) {
    bad('limits.unknownRunCostUsd (0.5..100) is required with maxCostUsd: unreported provider cost is never treated as zero');
  }
  if (l.unknownRunCostUsd != null && l.maxCostUsd == null) bad('limits.unknownRunCostUsd requires maxCostUsd');

  const e = d.executor ?? {};
  if (e.kind === 'cli-chain') for (const key of Object.keys(e)) {
    if (!['kind', 'providers', 'implementerTimeoutMinutes', 'verifierTimeoutMinutes'].includes(key)) bad(`unknown executor key ${key}`);
  }
  if (e.kind === 'cli-chain' && (!Array.isArray(e.providers) || e.providers.length < 1 || e.providers.length > 4)) {
    bad('executor.providers must contain 1..4 CLI providers');
  }
  const providers = e.kind === 'cli-chain' && Array.isArray(e.providers) ? Array.from(e.providers) : [e];
  const kinds = new Set();
  for (const provider of providers) {
    if (!provider || !EXECUTOR_KINDS.includes(provider.kind)) { bad('invalid executor kind'); continue; }
    if (kinds.has(provider.kind)) bad('executor providers must be unique');
    kinds.add(provider.kind);
    if (provider.model !== undefined && !text(provider.model, 80)) bad('executor.model invalid');
    if (provider.researchOnly !== undefined && provider.researchOnly !== true) bad('executor.researchOnly must be true when specified');
    // agy is pinned to one model: an unknown model fails the run instead of falling back to a default.
    if (provider.kind === 'agy-cli') {
      if (!text(provider.model, 80)) bad('executor.model required');
      if (provider.researchOnly !== undefined) bad('researchOnly does not apply to agy-cli');
    }
    if (provider.kind === 'claude-cli') {
      if (!text(provider.model, 80)) bad('executor.model required');
      if (!PERMISSION_MODES.includes(provider.permissionMode)) bad(`executor.permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
    } else if (provider.permissionMode !== undefined) bad('permissionMode applies only to claude-cli');
    for (const key of Object.keys(provider)) {
      if (!['kind', 'model', 'permissionMode', 'researchOnly', ...(e.kind === 'cli-chain' ? [] : ['implementerTimeoutMinutes', 'verifierTimeoutMinutes'])].includes(key)) bad(`unknown executor provider key ${key}`);
    }
  }
  if (!int(e.implementerTimeoutMinutes, 1, 720)) bad('executor.implementerTimeoutMinutes must be 1..720');
  if (!int(e.verifierTimeoutMinutes, 1, 360)) bad('executor.verifierTimeoutMinutes must be 1..360');
  if (d.routing !== undefined) validateRouting(d.routing, kinds, bad);

  const constraints = d.constraints;
  if (!Array.isArray(constraints) || constraints.length < 1 || constraints.length > 12 || !constraints.every((c) => text(c, 2000))) {
    bad('constraints must be 1..12 non-empty strings');
  }

  const tasks = d.tasks;
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 32) bad('tasks must be 1..32 items');
  const seen = new Set();
  for (const [index, task] of (Array.isArray(tasks) ? tasks : []).entries()) validateTask(task, `tasks[${index}]`, { seen, constraints, bad });
  if (d.version === 2) validateEnvelope(d, bad);
  // A version 1 declaration may not hide a secret-like path behind an anchor either; version 2 checks every reference in
  // its envelope (A5). A whole-path version 1 reference keeps today's rule.
  else for (const [index, task] of (Array.isArray(tasks) ? tasks : []).entries()) {
    const anchored = Array.isArray(task?.references) ? task.references.filter((reference) => parseReference(reference)?.anchor) : [];
    if (anchored.some(secretReference)) bad(`tasks[${index}].references name a secret-like path`);
  }
  if (Array.isArray(tasks) && tasks.some((task) => task?.web !== undefined) &&
      !providers.some((provider) => provider?.kind === 'agy-cli' || (provider?.kind === 'claude-cli' && !provider.researchOnly))) {
    bad('a task with web needs a browser worker: agy-cli, or claude-cli without researchOnly');
  }
  if (Array.isArray(tasks) && tasks.some((task) => task && task.web === undefined) && providers.every((provider) => provider?.kind === 'agy-cli')) {
    bad('a task without web needs an executor other than agy-cli, which runs only web acceptance tasks');
  }
  if (errors.length) throw new TypeError(`invalid campaign declaration: ${errors.join('; ')}`);
  return d;
}

/**
 * One task's rules, the same for every declaration version (WORK_ENVELOPE 4.3: extracted unchanged). `seen` holds the ids
 * declared earlier; `constraints` are the campaign's. A version 2 declaration then checks the task against its envelope.
 */
export function validateTask(task, where, { seen, constraints, bad }) {
  if (!task || typeof task !== 'object') { bad(`${where} must be an object`); return; }
  for (const key of Object.keys(task)) {
    if (!TASK_KEYS.includes(key)) bad(`${where} unknown key ${key}`);
  }
  if (!ID.test(task.id ?? '')) bad(`${where}.id invalid`);
  // commit: a verified commit is published as a PR. report: a verified report is posted to the task issue.
  if (!['commit', 'report'].includes(task.deliverable)) bad(`${where}.deliverable must be commit or report`);
  if (seen.has(task.id)) bad(`${where}.id duplicate ${task.id}`);
  if (!int(task.issue, 1, 1e9)) bad(`${where}.issue must be an issue number`);
  if (!text(task.title, 200)) bad(`${where}.title required`);
  if (task.outcome !== undefined && !text(task.outcome, 300)) bad(`${where}.outcome must be a non-empty string (max 300)`);
  // An optional logical repair identity (aiworks#5), not a file lock or a parent-issue-wide lock. It stays in
  // scopeDigest, so an admitted assignment cannot silently switch keys; an absent key leaves both digests unchanged.
  if (task.workKey !== undefined && (task.deliverable !== 'commit' || typeof task.workKey !== 'string' ||
      !/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(task.workKey))) {
    bad(`${where}.workKey must be a lowercase repair key (max 96) on a commit task`);
  }
  // The part of the repository this commit task may change (ADAPTIVE_SCHEDULER 4.3): path prefixes and named exclusive
  // resources. Absent means the whole repository. It is part of scopeDigest, like workKey; an absent list changes no digest.
  if (task.writes !== undefined && (task.deliverable !== 'commit' || !Array.isArray(task.writes) || task.writes.length < 1 ||
      task.writes.length > 32 || !task.writes.every(writeEntry) || new Set(task.writes.map((w) => w.toLowerCase())).size !== task.writes.length)) {
    bad(`${where}.writes must be 1..32 unique repository-relative path prefixes or resource:<name> entries on a commit task`);
  }
  if (!text(task.goal, 1500)) bad(`${where}.goal required (max 1500)`);
  if (!Array.isArray(task.dependsOn)) bad(`${where}.dependsOn must be an array`);
  if (task.requiresMergedDependencies !== undefined && task.requiresMergedDependencies !== true) bad(`${where}.requiresMergedDependencies must be true when specified`);
  // Dependencies must be declared earlier: the declared order is a topological order, so no cycles.
  for (const dep of task.dependsOn ?? []) if (!seen.has(dep)) bad(`${where}.dependsOn ${dep} must name an earlier task`);
  const own = task.constraints ?? [];
  if (!Array.isArray(own) || own.length > 12 || !own.every((c) => text(c, 2000))) bad(`${where}.constraints must be 0..12 strings`);
  if ((constraints?.length ?? 0) + own.length > 24) bad(`${where}: campaign + task constraints exceed 24 (packet room is kept for findings)`);
  if (!Array.isArray(task.acceptance) || task.acceptance.length < 1 || task.acceptance.length > 16 || !task.acceptance.every((c) => text(c, 2000))) {
    bad(`${where}.acceptance must be 1..16 strings`);
  }
  // A reference is a path, or `path#anchor` for one section of a Markdown document (SCOPED_READING section 3).
  if (!Array.isArray(task.references) || task.references.length < 1 || task.references.length > 24 ||
      !task.references.every((reference) => text(reference, 512) && parseReference(reference))) {
    bad(`${where}.references must be 1..24 repository-relative paths`);
  }
  // A web acceptance task: the AGY browser worker reviews these pages and reports. The pages' origins, plus any declared
  // resource origins (fonts, CDNs), are all its browser can reach, so they belong to the owner's immutable scope.
  if (task.web !== undefined) {
    validateWeb(task.web, `${where}.web`, bad);
    if (task.deliverable !== 'report') bad(`${where}.web requires deliverable report`);
  }
  // Routing indicators (MODEL_ROUTING 3.1-3.3). They are part of scopeDigest; absent keys change no digest.
  if (task.role !== undefined && !(typeof task.role === 'string' && ROLE.test(task.role))) bad(`${where}.role must be a role id from registry/agents.json`);
  if (task.routing !== undefined) {
    const r = task.routing;
    // A declaration may only raise a computed level, never lower it, so "high" is the one value.
    if (!plainObject(r) || !Object.keys(r).length || Object.keys(r).some((key) => !['risk', 'complexity'].includes(key)) ||
        Object.values(r).some((value) => value !== 'high')) bad(`${where}.routing must be { risk?: "high", complexity?: "high" } with at least one key`);
  }
  seen.add(task.id);
}

/** Pages a browser worker may open: a task's `web`, or the version 2 `envelope.web` that bounds every task's. */
function validateWeb(w, where, bad) {
  if (!w || typeof w !== 'object' || Array.isArray(w) || Object.keys(w).some((key) => !['urls', 'resourceOrigins'].includes(key))) {
    bad(`${where} must be { urls, resourceOrigins? }`);
  } else {
    if (!Array.isArray(w.urls) || w.urls.length < 1 || w.urls.length > 8 || !w.urls.every(webUrl)) bad(`${where}.urls must be 1..8 http(s) URLs without credentials`);
    if (w.resourceOrigins !== undefined && (!Array.isArray(w.resourceOrigins) || w.resourceOrigins.length > 16 ||
        !w.resourceOrigins.every((url) => webUrl(url) && new URL(url).origin === url))) bad(`${where}.resourceOrigins must be 0..16 http(s) origins`);
    else if ([...w.urls, ...(w.resourceOrigins ?? [])].some((url) => webUrl(url) && controlPlane(url))) {
      bad(`${where} must not name port 4318 (supervisor dashboard) or 17321 (local control service) on any host`);
    }
  }
}

// Version 2 (WORK_ENVELOPE 4.1). Task ids reserved for the envelope's generated closing check and planning steps (section 6).
const RESERVED_TASK_IDS = ['ACCEPT', 'PLAN'];
const ENVELOPE_KEYS = ['scopeVersion', 'supersedes', 'request', 'outcome', 'acceptance', 'writes', 'denyWrites', 'deliverables',
  'issues', 'web', 'release', 'planning'];
// Intake routes (WORK_ENVELOPE 3.1) and the revisions each pins besides the base. Plan only is a switch, not a route.
const REQUEST_ROUTES = { goal: [], issue: ['issueUpdatedAt'], pr: ['headSha'], 'plan-file': ['path', 'blob'] };
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const secretLike = new RegExp(SECRET_LIKE_PATH_PATTERN, 'u');
// A secret-like reference, tested on the whole string and on its path without the anchor (SCOPED_READING section 3).
const secretReference = (reference) => typeof reference === 'string' &&
  (secretLike.test(reference) || secretLike.test(parseReference(reference)?.path ?? ''));
// A write entry compared as WORK_ENVELOPE 6.3 A4 says: `\` read as `/`, no trailing `/`, case folded (Windows).
const folded = (entry) => entry.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const covers = (outer, inner) => inner === outer || inner.startsWith(`${outer}/`);
const writeList = (value, min) => Array.isArray(value) && value.length >= min && value.length <= 32 && value.every(writeEntry) &&
  !value.some((entry) => secretLike.test(folded(entry))) && new Set(value.map(folded)).size === value.length;

/**
 * The version 2 `envelope` block and the initial tasks inside it: every field rule of WORK_ENVELOPE 4.1, and the boundary
 * checks of 6.3 that apply to an approved task (A4 files, A5 capabilities, A7 destination, A11 constraints), with the
 * refusal code in the message. Release is review-only until the owner decides Auto Release (#33).
 */
function validateEnvelope(d, bad) {
  const v = d.envelope;
  if (!plainObject(v)) { bad('version 2 needs an envelope object'); return; }
  for (const key of Object.keys(v)) if (!ENVELOPE_KEYS.includes(key)) bad(`unknown envelope key ${key}`);
  if (!text(v.outcome, 300)) bad('envelope.outcome must be a non-empty string (max 300)');
  if (!Array.isArray(v.acceptance) || v.acceptance.length < 1 || v.acceptance.length > 16 || !v.acceptance.every((c) => text(c, 2000))) {
    bad('envelope.acceptance must be 1..16 strings');
  }
  // Empty `writes` means report-only work. A secret-like path is never in scope.
  const writes = writeList(v.writes, 0) ? v.writes.map(folded) : null;
  if (!writes) bad('envelope.writes must be 0..32 unique repository-relative path prefixes or resource:<name> entries, none secret-like');
  const deny = v.denyWrites === undefined ? [] : writeList(v.denyWrites, 1) ? v.denyWrites.map(folded) : null;
  if (!deny) bad('envelope.denyWrites must be 1..32 unique repository-relative path prefixes when present');
  else if (writes) for (const entry of deny) if (!writes.some((prefix) => covers(prefix, entry))) bad(`envelope.denyWrites ${entry} must lie inside envelope.writes`);
  const deliverables = Array.isArray(v.deliverables) ? v.deliverables : [];
  if (!deliverables.length || new Set(deliverables).size !== deliverables.length || !deliverables.every((kind) => ['commit', 'report'].includes(kind))) {
    bad('envelope.deliverables must be commit, report or both');
  }
  const issues = Array.isArray(v.issues) ? v.issues : [];
  if (!Array.isArray(v.issues) || issues.length > 32 || !issues.every((issue) => int(issue, 1, 1e9)) || new Set(issues).size !== issues.length) {
    bad('envelope.issues must be 0..32 unique issue numbers');
  }
  if (v.web !== null) validateWeb(v.web, 'envelope.web', bad);
  // Auto Release is a separate, separately approved mode (#13). Until the owner decides #33 it is refused by name.
  if (!plainObject(v.release) || Object.keys(v.release).some((key) => key !== 'mode')) bad('envelope.release must be { mode }');
  else if (v.release.mode === 'auto-release') bad('envelope.release.mode auto-release is refused (RELEASE_MODE_UNAVAILABLE): Auto Release waits for the owner decision on #33; use review-only');
  else if (v.release.mode !== 'review-only') bad('envelope.release.mode must be review-only');
  if (!['adaptive', 'fixed'].includes(v.planning)) bad('envelope.planning must be adaptive or fixed');
  if (!int(v.scopeVersion, 1, 10000)) bad('envelope.scopeVersion must be a positive integer');
  // A wider scope is a new envelope that names the campaign and the scope it replaces (WORK_ENVELOPE 6.7).
  if (v.scopeVersion !== 1 || v.supersedes !== undefined) {
    const s = v.supersedes;
    if (!(int(v.scopeVersion, 2, 10000) && plainObject(s) && Object.keys(s).sort().join(',') === 'campaignId,scopeDigest' &&
        ID.test(s.campaignId ?? '') && s.campaignId !== d.campaignId && /^[0-9a-f]{64}$/.test(s.scopeDigest ?? ''))) {
      bad('envelope.supersedes must be { campaignId, scopeDigest } of another campaign, exactly when scopeVersion is above 1');
    }
  }
  const r = v.request;
  if (!plainObject(r) || Object.keys(r).some((key) => !['route', 'reference', 'pinned'].includes(key))) bad('envelope.request must be { route, reference?, pinned }');
  else {
    const pins = Object.hasOwn(REQUEST_ROUTES, r.route) ? REQUEST_ROUTES[r.route] : null;
    if (!pins) bad(`envelope.request.route must be one of ${Object.keys(REQUEST_ROUTES).join(', ')}`);
    if (r.route === 'goal' ? r.reference !== undefined && !text(r.reference, 500) : !text(r.reference, 500)) {
      bad('envelope.request.reference must name the issue, PR or plan file (max 500)');
    }
    const p = r.pinned;
    if (!plainObject(p) || !COMMIT_ID.test(p.base ?? '')) bad('envelope.request.pinned.base must be the pinned commit id');
    else {
      for (const key of pins ?? []) if (p[key] === undefined) bad(`envelope.request.pinned.${key} is required for route ${r.route}`);
      for (const key of Object.keys(p)) if (key !== 'base' && !(pins ?? []).includes(key)) bad(`envelope.request.pinned.${key} does not belong to route ${r.route}`);
      if (p.issueUpdatedAt !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(p.issueUpdatedAt)) bad('envelope.request.pinned.issueUpdatedAt must be a UTC timestamp');
      if (p.headSha !== undefined && !COMMIT_ID.test(p.headSha)) bad('envelope.request.pinned.headSha must be a commit id');
      if (p.path !== undefined && !(safePath(p.path) && !secretLike.test(p.path))) bad('envelope.request.pinned.path must be a repository-relative path that is not secret-like');
      if (p.blob !== undefined && !COMMIT_ID.test(p.blob)) bad('envelope.request.pinned.blob must be a blob id');
    }
  }
  // A project without GitHub starts work only through local admission (D4), which is not built: no local target or reference.
  if (d.target?.source !== undefined || String(d.authorization?.reference ?? '').startsWith('aiworks-local:')) {
    bad('a local target is refused (LOCAL_START_OFF): starting work on a project without GitHub waits for the owner decisions on #24 and #32');
  }
  // The approved plan obeys the same boundary as the steps added later (WORK_ENVELOPE 4.1 and 6.3).
  for (const [index, task] of (Array.isArray(d.tasks) ? d.tasks : []).entries()) {
    if (!plainObject(task)) continue;
    const where = `tasks[${index}]`;
    if (RESERVED_TASK_IDS.includes(task.id)) bad(`${where}.id ${task.id} is reserved for the envelope`);
    if (writes && deny && task.deliverable === 'commit') {
      if (!Array.isArray(task.writes)) bad(`${where} is a commit task without writes (WIDEN_FILES): it must declare writes within envelope.writes`);
      else for (const entry of task.writes.filter((item) => typeof item === 'string')) {
        const path = folded(entry);
        if (secretLike.test(path)) bad(`${where}.writes ${entry} is a secret-like path (WIDEN_FILES)`);
        else if (!writes.some((prefix) => covers(prefix, path))) bad(`${where}.writes ${entry} is outside envelope.writes (WIDEN_FILES)`);
        // A prefix that contains a denied one would let a commit reach it, so overlap in either direction is refused.
        else if (deny.some((prefix) => covers(prefix, path) || covers(path, prefix))) bad(`${where}.writes ${entry} reaches into envelope.denyWrites (WIDEN_FILES)`);
      }
    }
    if (!deliverables.includes(task.deliverable)) bad(`${where}.deliverable ${task.deliverable} is not in envelope.deliverables (WIDEN_CAPABILITY)`);
    if (Array.isArray(task.references) && task.references.some(secretReference)) {
      bad(`${where}.references name a secret-like path (WIDEN_CAPABILITY)`);
    }
    if (task.web !== undefined) {
      const pages = plainObject(v.web) && Array.isArray(v.web.urls) ? v.web.urls.filter(webUrl).map((url) => new URL(url).origin) : [];
      const origins = [...pages, ...(plainObject(v.web) && Array.isArray(v.web.resourceOrigins) ? v.web.resourceOrigins : [])];
      const urls = Array.isArray(task.web?.urls) ? task.web.urls.filter(webUrl) : [];
      const resources = Array.isArray(task.web?.resourceOrigins) ? task.web.resourceOrigins : [];
      if (urls.some((url) => !pages.includes(new URL(url).origin)) || resources.some((origin) => !origins.includes(origin))) {
        bad(`${where}.web reaches an origin outside envelope.web (WIDEN_CAPABILITY)`);
      }
    }
    if (task.issue !== undefined && !issues.includes(task.issue)) bad(`${where}.issue ${task.issue} is not in envelope.issues (WIDEN_DESTINATION)`);
    // The envelope adds one constraint to every packet (WORK_ENVELOPE 6.5), so it counts against the limit of 24.
    const own = Array.isArray(task.constraints) ? task.constraints.length : 0;
    if ((Array.isArray(d.constraints) ? d.constraints.length : 0) + own + 1 > 24) bad(`${where}: campaign + task + envelope constraints exceed 24`);
  }
}

/**
 * The optional campaign `routing` (MODEL_ROUTING 4.1 and 6): the models the owner authorizes per declared provider, with a
 * tier each, sensitive path prefixes and an optional pin. It is part of scopeDigest, like `executor`. Validated only;
 * nothing routes on it yet (slice R5).
 */
function validateRouting(routing, kinds, bad) {
  if (!plainObject(routing)) { bad('routing must be an object'); return; }
  for (const key of Object.keys(routing)) if (!['mode', 'candidates', 'sensitivePaths', 'pin'].includes(key)) bad(`unknown routing key ${key}`);
  if (routing.mode !== 'auto') bad('routing.mode must be "auto"');
  const candidates = Array.isArray(routing.candidates) ? routing.candidates : [];
  if (!Array.isArray(routing.candidates) || candidates.length < 1 || candidates.length > 16) bad('routing.candidates must contain 1..16 candidates');
  const declared = new Set();
  const tiers = new Set();
  for (const [index, candidate] of candidates.entries()) {
    const where = `routing.candidates[${index}]`;
    if (!plainObject(candidate) || Object.keys(candidate).some((key) => !['kind', 'model', 'tier'].includes(key))) { bad(`${where} must be { kind, model, tier }`); continue; }
    // A candidate adds a model, never a provider: its kind must already be an authorized executor provider.
    if (!kinds.has(candidate.kind)) bad(`${where}.kind ${candidate.kind} is not a declared executor provider`);
    if (!text(candidate.model, 80)) bad(`${where}.model required (max 80)`);
    if (!int(candidate.tier, 1, 3)) bad(`${where}.tier must be 1, 2 or 3`);
    const key = JSON.stringify([candidate.kind, candidate.model]);
    if (declared.has(key)) bad(`${where} duplicates ${candidate.kind} ${candidate.model}`);
    declared.add(key);
    tiers.add(candidate.tier);
  }
  if (routing.sensitivePaths !== undefined && (!Array.isArray(routing.sensitivePaths) || routing.sensitivePaths.length > 32 ||
      !routing.sensitivePaths.every(pathPrefix))) bad('routing.sensitivePaths must be 0..32 repository-relative path prefixes');
  const pin = routing.pin;
  if (pin === undefined || pin === null) return;
  if (!plainObject(pin) || !Object.keys(pin).length || Object.keys(pin).some((key) => !['implementer', 'verifier'].includes(key))) {
    bad('routing.pin must be null or { implementer?, verifier? }');
    return;
  }
  // A pin names one declared candidate or one declared tier; it never adds a model, a provider or a permission.
  for (const [stage, value] of Object.entries(pin)) {
    const keys = plainObject(value) ? Object.keys(value).sort().join(',') : '';
    if (keys === 'kind,model') {
      if (!declared.has(JSON.stringify([value.kind, value.model]))) bad(`routing.pin.${stage} ${value.kind} ${value.model} is not a declared candidate`);
    } else if (keys === 'tier') {
      if (!tiers.has(value.tier)) bad(`routing.pin.${stage} tier ${value.tier} has no declared candidate`);
    } else bad(`routing.pin.${stage} must be { kind, model } or { tier }`);
  }
}

/**
 * A new campaign may target only a registered portfolio project: registry membership is the governance
 * inheritance (governance provider's docs/GOVERNANCE_INHERITANCE.md section 1). Checked when a campaign is first
 * registered; a campaign already in the store keeps resuming and running unaffected. The registry is Engineering
 * Platform's, read from `governanceRoot`; a missing or invalid root throws GOVERNANCE_ROOT_REQUIRED / GOVERNANCE_ROOT_INVALID.
 */
export function assertRegisteredTarget(declaration, governanceRoot) {
  const registryDir = join(requireGovernanceRoot(governanceRoot), 'registry', 'projects');
  const repository = String(declaration?.target?.repository ?? '');
  if (!registryEntries(registryDir, repository).length) {
    throw new TypeError(`campaign target ${repository || '(none)'} is not a registered project: add registry/projects/<id>.json to the governance checkout before registering a campaign`);
  }
  assertKnownRoles(declaration, governanceRoot);
}

/**
 * Every task `role` must be a role id in governance provider's catalog (registry/agents.json in the governance root),
 * checked when the campaign is first registered. A missing or malformed catalog, or an unknown id, throws: registration
 * fails closed. Tasks without `role` do not read the catalog.
 */
export function assertKnownRoles(declaration, governanceRoot) {
  const declared = (Array.isArray(declaration?.tasks) ? declaration.tasks : []).filter((task) => task?.role !== undefined);
  if (!declared.length) return;
  const known = new Set(roleCatalog(governanceRoot).roles.map((role) => role.id));
  const unknown = declared.filter((task) => !known.has(task.role));
  if (unknown.length) {
    throw new TypeError(`task role ${unknown.map((task) => `${task.id}: ${task.role}`).join(', ')} is not in the governance checkout's registry/agents.json`);
  }
}

/** Registry entries whose repository.github equals `repository`, ignoring case: the registration gate's match. */
function registryEntries(registryDir, repository) {
  return readdirSync(registryDir).filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(registryDir, name), 'utf8')))
    .filter((contract) => String(contract?.repository?.github ?? '').toLowerCase() === repository.toLowerCase());
}

// A policy conditioned on change boundaries can be ruled out for a project only where a boundary is also a project
// capability (schemas: policy selector boundaries and project capabilities share only `ui`). Every other condition
// depends on the change itself and keeps the policy: missing context is never a reason to skip a gate.
const CAPABILITY_BOUNDARIES = new Set(['ui']);

/**
 * The target project's inherited governance for a worker packet (governance provider's docs/GOVERNANCE_INHERITANCE.md sections 1 and 9),
 * as values only: the registry id; the IDs of the portfolio policies in the governance root's policies/catalog.json that can apply to the
 * project under its contract; the project's declared authority pointers (role, repository-relative path); and its
 * declared exceptions and gaps as id and rule. The project is the single registry entry whose repository.github equals
 * `repository`, as the registration gate matches, and that entry must satisfy the registry schema: a field the schema
 * leaves optional may be absent (an empty list), a malformed one is never read as empty. Anything else throws: the
 * caller fails closed and never falls back to another project's rules.
 */
export function projectGovernance(repository, governanceRoot) {
  const root = requireGovernanceRoot(governanceRoot);
  const target = String(repository ?? '');
  const entries = registryEntries(join(root, 'registry', 'projects'), target);
  if (!entries.length) throw new TypeError(`target ${target || '(none)'} is not a registered project: no registry/projects entry has that repository.github`);
  if (entries.length > 1) throw new TypeError(`target ${target} matches ${entries.length} registry entries (${entries.map((entry) => entry.id).join(', ')}); refusing to choose one`);
  return governanceForContract(entries[0], root, target);
}

/** The registry entries whose repository.github equals `repository` (the registration gate's match), for project connect. */
export function registryEntriesFor(repository, governanceRoot) {
  return registryEntries(join(requireGovernanceRoot(governanceRoot), 'registry', 'projects'), String(repository ?? ''));
}

/**
 * One project contract's governance values (PROJECT_CONNECTION section 6.2): the registry schema check, then the policy
 * derivation that the overlay path (overlayGovernance) shares. Throws on anything malformed.
 */
export function governanceForContract(contract, governanceRoot, target = contract?.repository?.github ?? '') {
  const root = requireGovernanceRoot(governanceRoot);
  const schemaErrors = contractSchemaErrors(contract, root);
  if (schemaErrors) {
    const first = schemaErrors.slice(0, 3).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
    throw new TypeError(`registry entry ${contract?.id ?? target} does not satisfy schemas/project-contract.schema.json: ${first}`);
  }
  return derivedGovernance(contract, root, `registry entry ${contract.id ?? target}`);
}

/**
 * The governance values of a project without GitHub (PROJECT_CONNECTION section 7.4): the overlay entry passes
 * validateOverlayEntry (local-overlay.mjs, which throws an OverlayError with its RULES_* code), then gets every portfolio
 * policy from the governance root by the same derivation as a registry entry. Its exceptions are always empty. Only
 * reads; local admission, which would let this start work, stays off (LOCAL_START_OFF).
 */
export function overlayGovernance(entry, governanceRoot, options = {}) {
  const { root } = validateOverlayEntry(entry, governanceRoot, options);
  const { authorities = [], gaps = [] } = entry.governance;
  let values;
  try {
    values = derivedGovernance({ id: entry.id, capabilities: entry.capabilities, governance: { authorities, gaps } }, root, `local project entry ${entry.id}`);
  } catch (error) {
    throw new OverlayError('RULES_INVALID', error.message);
  }
  return { ...values, exceptions: [] };
}

// The policy derivation shared by both paths: the portfolio policies in the root's policies/catalog.json that can apply
// to the contract's capabilities, its authority pointers, and its exceptions and gaps as id and rule. `label` names the
// contract in errors.
function derivedGovernance(contract, root, label) {
  // Absent (optional in the schema) is an empty list; any other non-array is malformed and fails closed.
  const listed = (value, field) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new TypeError(`${label} has a malformed ${field}: not a list`);
    return value;
  };
  const capabilities = new Set(listed(contract.capabilities, 'capabilities'));
  const catalog = JSON.parse(readFileSync(join(root, 'policies', 'catalog.json'), 'utf8'));
  if (!Array.isArray(catalog?.policies)) throw new TypeError('policies/catalog.json lists no policies');
  const policies = catalog.policies.map((path) => JSON.parse(readFileSync(join(root, path), 'utf8')))
    .filter((policy) => policy?.scope === 'portfolio')
    .filter((policy) => {
      const boundaries = policy.applies_when?.boundaries;
      if (!Array.isArray(boundaries) || !boundaries.length || boundaries.some((item) => !CAPABILITY_BOUNDARIES.has(item))) return true;
      return boundaries.some((item) => capabilities.has(item));
    })
    .map((policy) => policy.id);
  const governance = contract.governance ?? {};
  const declared = (field) => listed(governance[field], `governance.${field}`).map((item) => ({ id: item?.id, rule: item?.rule }));
  const values = {
    project: contract.id,
    policies,
    authorities: listed(governance.authorities, 'governance.authorities').map((item) => ({ role: item?.role, path: item?.path })),
    exceptions: declared('exceptions'),
    gaps: declared('gaps'),
  };
  if (!validGovernance(values)) throw new TypeError(`${label} declares governance values a worker packet cannot carry`);
  return values;
}
