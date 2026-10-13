// AIWorks campaign declarations: an explicit owner assignment with immutable scope
// and a simple declared DAG. Limits and authorization may change only with a higher
// authorization version; executor-only amendments also require an idle, paused campaign.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { validGovernance } from '../../scripts/lib/worker-context.mjs';
import { safeResearchPath } from './adapters/research-context.mjs';
import { requireGovernanceRoot, roleCatalog } from './governance.mjs';

// The registry's own schema (Engineering Platform's schemas/project-contract.schema.json, read from the governance root),
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
// The owner's own control planes on this host: the supervisor dashboard and Local Commander. A browser worker that could
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
// An Engineering Platform role id (registry/agents.json); whether it exists is checked against the catalog at registration.
const ROLE = /^[a-z0-9][a-z0-9-]{0,63}$/;
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
  const allowed = ['version', 'campaignId', 'purpose', 'authorization', 'target', 'limits', 'executor', 'routing', 'constraints', 'tasks'];
  for (const key of Object.keys(d)) if (!allowed.includes(key)) bad(`unknown key ${key}`);
  if (d.version !== 1) bad('version must be 1');
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
  for (const [index, task] of (Array.isArray(tasks) ? tasks : []).entries()) {
    const where = `tasks[${index}]`;
    if (!task || typeof task !== 'object') { bad(`${where} must be an object`); continue; }
    for (const key of Object.keys(task)) {
      if (!['id', 'issue', 'title', 'outcome', 'workKey', 'writes', 'deliverable', 'goal', 'dependsOn', 'requiresMergedDependencies', 'constraints', 'acceptance', 'references', 'web', 'role', 'routing'].includes(key)) bad(`${where} unknown key ${key}`);
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
    if (!Array.isArray(task.references) || task.references.length < 1 || task.references.length > 24 || !task.references.every(safePath)) {
      bad(`${where}.references must be 1..24 repository-relative paths`);
    }
    // A web acceptance task: the AGY browser worker reviews these pages and reports. The pages' origins, plus any declared
    // resource origins (fonts, CDNs), are all its browser can reach, so they belong to the owner's immutable scope.
    if (task.web !== undefined) {
      const w = task.web;
      if (!w || typeof w !== 'object' || Array.isArray(w) || Object.keys(w).some((key) => !['urls', 'resourceOrigins'].includes(key))) {
        bad(`${where}.web must be { urls, resourceOrigins? }`);
      } else {
        if (!Array.isArray(w.urls) || w.urls.length < 1 || w.urls.length > 8 || !w.urls.every(webUrl)) bad(`${where}.web.urls must be 1..8 http(s) URLs without credentials`);
        if (w.resourceOrigins !== undefined && (!Array.isArray(w.resourceOrigins) || w.resourceOrigins.length > 16 ||
            !w.resourceOrigins.every((url) => webUrl(url) && new URL(url).origin === url))) bad(`${where}.web.resourceOrigins must be 0..16 http(s) origins`);
        else if ([...w.urls, ...(w.resourceOrigins ?? [])].some((url) => webUrl(url) && controlPlane(url))) {
          bad(`${where}.web must not name port 4318 (supervisor dashboard) or 17321 (Local Commander) on any host`);
        }
      }
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
 * inheritance (Engineering Platform's docs/GOVERNANCE_INHERITANCE.md section 1). Checked when a campaign is first
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
 * Every task `role` must be a role id in Engineering Platform's catalog (registry/agents.json in the governance root),
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
 * The target project's inherited governance for a worker packet (Engineering Platform's docs/GOVERNANCE_INHERITANCE.md sections 1 and 9),
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
 * One project contract's governance values (PROJECT_CONNECTION section 6.2): schema validation and policy derivation,
 * shared by the registry path (projectGovernance) and, later, the overlay path. Throws on anything malformed.
 */
export function governanceForContract(contract, governanceRoot, target = contract?.repository?.github ?? '') {
  const root = requireGovernanceRoot(governanceRoot);
  const schemaErrors = contractSchemaErrors(contract, root);
  if (schemaErrors) {
    const first = schemaErrors.slice(0, 3).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
    throw new TypeError(`registry entry ${contract?.id ?? target} does not satisfy schemas/project-contract.schema.json: ${first}`);
  }
  // Absent (optional in the schema) is an empty list; any other non-array is malformed and fails closed.
  const listed = (value, field) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new TypeError(`registry entry ${contract.id} has a malformed ${field}: not a list`);
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
  if (!validGovernance(values)) throw new TypeError(`registry entry ${contract.id ?? target} declares governance values a worker packet cannot carry`);
  return values;
}
