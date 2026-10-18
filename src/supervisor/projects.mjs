// AIWorks project records (aiworks#7, docs/design/PROJECT_CONNECTION.md section 3, slice S1). A project is a row in
// the supervisor store; it holds no credentials. This module only creates, reads, updates and disconnects records:
// it never reads the project's folder, runs git or gh, or starts work. Detection and connect flows are later slices.
import { isAbsolute } from 'node:path';
import { ConflictError } from './store.mjs';

export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const SOURCE_KINDS = Object.freeze(['github', 'local-git', 'folder']);
/** "Not connected" is the absence of a live record, so it is never stored. */
export const PROJECT_STATUSES = Object.freeze(['needs-setup', 'ready', 'unavailable']);
export const CAPABILITIES = Object.freeze(['plan', 'startWork', 'publish', 'apply']);
const GOVERNANCE_KINDS = Object.freeze(['registry', 'overlay', 'none']);
const JSON_FIELDS = ['exclusions', 'governance', 'capabilities', 'last_preflight', 'current_baseline'];
/** Fields an owner action or a later check may change. Identity (id, tenant, kind, root, fingerprint, repository) never
 * changes here: relocation and Change connection type are their own explicit actions (design section 4.6). */
const MUTABLE = new Set(['name', 'status', 'reason', 'capabilities', 'last_preflight', 'governance', 'base_branch',
  'local_branch', 'worktree_root', 'mirror_root', 'current_baseline', 'root_file_id', 'exclusions']);
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export class ProjectError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'ProjectError'; this.code = code; Object.assign(this, detail); }
}
const invalid = (message) => { throw new ProjectError('PROJECT_INVALID', message); };
const text = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max;

/** The comparison key for overlap and duplicate checks: `\` becomes `/`, and on Windows the key is lowercased. */
export function rootKey(rootPath, platform = process.platform) {
  const key = rootPath.replaceAll('\\', '/');
  return platform === 'win32' ? key.toLowerCase() : key;
}

/**
 * `owner/name` from a GitHub remote or name. User info, tokens, ports, query and the `.git` suffix are dropped; the
 * input is never echoed in an error, because a remote URL can carry a credential.
 */
export function githubRepository(value) {
  if (typeof value !== 'string' || value.trim() === '') invalid('github_repository is required for a GitHub project');
  const raw = value.trim();
  let path = null;
  const scp = /^(?:[^@/\s]+@)?github\.com:(.+)$/i.exec(raw);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { invalid('github_repository is not a valid GitHub remote'); }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com') {
      invalid('github_repository must be a github.com remote');
    }
    path = url.pathname.replace(/^\/+/, '');
  } else if (scp) {
    path = scp[1];
  } else {
    path = raw;
  }
  const parts = path.replace(/\/+$/, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2 || !OWNER.test(parts[0]) || !NAME.test(parts[1]) || parts[1] === '.' || parts[1] === '..') {
    invalid('github_repository must name owner/name on github.com');
  }
  return `${parts[0]}/${parts[1]}`;
}

function checkCapabilities(capabilities, kind, governance) {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) invalid('capabilities must be an object');
  for (const [key, value] of Object.entries(capabilities)) {
    if (!CAPABILITIES.includes(key)) invalid(`unknown capability ${key}`);
    if (!value || typeof value.allowed !== 'boolean') invalid(`capability ${key} needs allowed true or false`);
    if (!value.allowed && !text(value.reason, 80)) invalid(`capability ${key} needs a reason when it is false`);
  }
  // A project without GitHub starts work under rules the owner confirmed (D2) and a plan the owner approved (D4). Its
  // record may say so only when it is bound to those rules; each start is still admitted by local-admission.mjs.
  if (kind !== 'github' && capabilities.startWork?.allowed && governance?.kind !== 'overlay') {
    throw new ProjectError('RULES_NOT_CONFIRMED', "Work can start on a project without GitHub only after you confirm its rules");
  }
  if (kind !== 'github' && capabilities.publish?.allowed) invalid('only a GitHub project can publish a pull request');
}

function checkGovernance(governance) {
  if (!governance || !GOVERNANCE_KINDS.includes(governance.kind)) invalid('governance.kind must be registry, overlay or none');
  if (governance.kind === 'registry' && !text(governance.entryId, 160)) invalid('a registry binding needs entryId');
  if (governance.kind === 'overlay' && !text(governance.overlayId, 160)) invalid('an overlay binding needs overlayId');
}

function checkExclusions(exclusions, kind) {
  if (!Array.isArray(exclusions) || !exclusions.every((path) => text(path, 400) && !isAbsolute(path) && !/^[A-Za-z]:/.test(path))) {
    invalid('exclusions must be relative paths');
  }
  if (kind !== 'folder' && exclusions.length) invalid('only a plain folder has exclusions');
}

function checkStatus(status) {
  if (!PROJECT_STATUSES.includes(status)) invalid(`status must be one of ${PROJECT_STATUSES.join(', ')}`);
}

function decodeProject(row) {
  if (!row) return null;
  const out = { ...row };
  for (const key of JSON_FIELDS) if (typeof out[key] === 'string') out[key] = JSON.parse(out[key]);
  return out;
}

/** The live project that already holds this root or this GitHub repository, and which of the two it holds. */
function liveConflict(store, key, repository) {
  const byRoot = store.get('SELECT id, name FROM projects WHERE root_key = ? AND disconnected_at IS NULL', key);
  if (byRoot) return { ...byRoot, what: 'folder' };
  const byRepository = repository
    ? store.get('SELECT id, name FROM projects WHERE lower(github_repository) = lower(?) AND disconnected_at IS NULL', repository) : null;
  return byRepository ? { ...byRepository, what: 'repository' } : null;
}

/** Read one project, including a disconnected tombstone; null when the id was never used. */
export function project(store, id) {
  return decodeProject(store.get('SELECT * FROM projects WHERE id = ?', id));
}

/** Live projects by name; tombstones only when asked. */
export function projects(store, { includeDisconnected = false } = {}) {
  const where = includeDisconnected ? '' : ' WHERE disconnected_at IS NULL';
  return store.all(`SELECT * FROM projects${where} ORDER BY name, id`).map(decodeProject);
}

/**
 * Create a project record and journal `project-connected`. The caller has already checked the folder (later slices);
 * this only enforces the record's own rules: id format, ids are never reused, and one live record per root and per
 * GitHub repository.
 */
export function createProject(store, input, now) {
  const kind = input.source_kind;
  if (!SOURCE_KINDS.includes(kind)) invalid(`source_kind must be one of ${SOURCE_KINDS.join(', ')}`);
  if (typeof input.id !== 'string' || !PROJECT_ID.test(input.id)) {
    throw new ProjectError('PROJECT_ID_INVALID', 'Project ids use 2 to 40 lowercase letters, digits and hyphens, starting with a letter or digit');
  }
  if (!text(input.tenant_id, 160)) invalid('tenant_id is required');
  if (!text(input.name, 80)) invalid('name is required, at most 80 characters');
  if (typeof input.root_path !== 'string' || !isAbsolute(input.root_path)) invalid('root_path must be an absolute path');
  const github = kind === 'github' ? githubRepository(input.github_repository) : null;
  if (kind !== 'github' && (input.github_repository != null || input.base_branch != null)) invalid('only a GitHub project has a repository and base branch');
  if (kind !== 'local-git' && input.local_branch != null) invalid('only a local Git project has local_branch');
  if (kind === 'github' && input.mirror_root != null) invalid('a GitHub project has no managed mirror');
  if (kind === 'folder' && input.fingerprint != null) invalid('a plain folder has no fingerprint');
  const exclusions = input.exclusions ?? [];
  checkExclusions(exclusions, kind);
  const governance = input.governance ?? { kind: 'none' };
  checkGovernance(governance);
  const status = input.status ?? 'needs-setup';
  checkStatus(status);
  const capabilities = input.capabilities ?? Object.fromEntries(CAPABILITIES.map((key) => [key, { allowed: false, reason: 'NOT_CHECKED' }]));
  checkCapabilities(capabilities, kind, governance);
  const key = rootKey(input.root_path);
  const row = {
    id: input.id, tenant_id: input.tenant_id, name: input.name.trim(), source_kind: kind,
    root_path: input.root_path, root_key: key, root_file_id: input.root_file_id ?? null,
    fingerprint: kind === 'github' ? github : input.fingerprint ?? null,
    github_repository: github, base_branch: input.base_branch ?? null, local_branch: input.local_branch ?? null,
    mirror_root: input.mirror_root ?? null, worktree_root: input.worktree_root ?? null,
    exclusions: JSON.stringify(exclusions), governance: JSON.stringify(governance), status, reason: input.reason ?? null,
    capabilities: JSON.stringify(capabilities), current_baseline: input.current_baseline == null ? null : JSON.stringify(input.current_baseline),
    last_preflight: input.last_preflight == null ? null : JSON.stringify(input.last_preflight),
    version: 1, created_at: now, updated_at: now, disconnected_at: null,
  };
  return store.tx(() => {
    const used = store.get('SELECT id, disconnected_at FROM projects WHERE id = ?', row.id);
    if (used) {
      throw new ProjectError('PROJECT_ID_TAKEN', used.disconnected_at == null
        ? `The project id "${row.id}" is already in use. Choose another.`
        : `The project id "${row.id}" belonged to a disconnected project and is never reused. Choose another.`, { projectId: row.id });
    }
    const existing = liveConflict(store, key, github);
    if (existing) {
      throw new ProjectError('ALREADY_CONNECTED', `This ${existing.what} is already connected as "${existing.name}".`, { projectId: existing.id });
    }
    store.insert('projects', row);
    store.journal(null, 'project-connected', { projectId: row.id, tenantId: row.tenant_id, sourceKind: kind, githubRepository: github }, now);
    return project(store, row.id);
  });
}

/** Compare-and-swap update of a live project's mutable fields. */
export function updateProject(store, id, expectedVersion, changes, now) {
  for (const key of Object.keys(changes)) if (!MUTABLE.has(key)) invalid(`${key} cannot be changed here`);
  return store.tx(() => {
    const current = project(store, id);
    if (!current) throw new ProjectError('PROJECT_NOT_FOUND', `No project "${id}"`, { projectId: id });
    if (current.disconnected_at != null) throw new ProjectError('PROJECT_DISCONNECTED', `Project "${id}" is disconnected`, { projectId: id });
    const kind = current.source_kind;
    if ('name' in changes && !text(changes.name, 80)) invalid('name is required, at most 80 characters');
    if ('status' in changes) checkStatus(changes.status);
    if ('capabilities' in changes || 'governance' in changes) checkCapabilities(changes.capabilities ?? current.capabilities, kind, changes.governance ?? current.governance);
    if ('governance' in changes) checkGovernance(changes.governance);
    if ('exclusions' in changes) checkExclusions(changes.exclusions, kind);
    if ('base_branch' in changes && kind !== 'github' && changes.base_branch != null) invalid('only a GitHub project has a base branch');
    if ('local_branch' in changes && kind !== 'local-git' && changes.local_branch != null) invalid('only a local Git project has local_branch');
    if ('mirror_root' in changes && kind === 'github' && changes.mirror_root != null) invalid('a GitHub project has no managed mirror');
    const encoded = Object.fromEntries(Object.entries(changes).map(([key, value]) => [key,
      key === 'name' ? value.trim() : JSON_FIELDS.includes(key) && value != null ? JSON.stringify(value) : value]));
    store.patch('projects', { id }, expectedVersion, encoded, now);
    return project(store, id);
  });
}

/**
 * Disconnect keeps the row as a tombstone: the id is never reused and history stays attached. No mirror, worktree or
 * history is deleted (design section 4.6).
 */
export function disconnectProject(store, id, expectedVersion, now) {
  return store.tx(() => {
    const current = project(store, id);
    if (!current) throw new ProjectError('PROJECT_NOT_FOUND', `No project "${id}"`, { projectId: id });
    if (current.disconnected_at != null) return current;
    store.patch('projects', { id }, expectedVersion, { disconnected_at: now }, now);
    store.journal(null, 'project-disconnected', { projectId: id }, now);
    return project(store, id);
  });
}

export { ConflictError };
