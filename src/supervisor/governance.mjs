// AIWorks reads governance provider's portfolio governance (registry/projects, policies/catalog.json, registry/agents.json,
// schemas/project-contract.schema.json, docs/PRODUCT_ROADMAP.md, docs/AUTONOMOUS_ROLLOUT.md) from an explicit governance
// root: an operator-configured read-only directory. There is no default or fallback to AIWorks's own tree:
// without a valid root every code path that needs governance fails closed with a coded error.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export class GovernanceRootError extends Error {
  constructor(code, message) { super(message); this.name = 'GovernanceRootError'; this.code = code; }
}

/** The `governanceRoot` configured in <dataDir>/config.json, or null when the file or key is absent or unreadable. */
export function configuredGovernanceRoot(dataDir) {
  if (!dataDir) return null;
  const path = join(dataDir, 'config.json');
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')).governanceRoot;
    return typeof value === 'string' && value.trim() ? value : null;
  } catch { return null; }
}

/**
 * The absolute governance root, or a GovernanceRootError:
 *   GOVERNANCE_ROOT_REQUIRED  nothing configured (no `governanceRoot` in config.json, no --governance);
 *   GOVERNANCE_ROOT_INVALID   configured, but not an absolute path to a directory holding registry/projects.
 */
export function requireGovernanceRoot(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new GovernanceRootError('GOVERNANCE_ROOT_REQUIRED',
      'no governance checkout is configured: set "governanceRoot" in the data directory config.json or pass --governance <path> (a read-only governance directory)');
  }
  if (!isAbsolute(candidate)) throw new GovernanceRootError('GOVERNANCE_ROOT_INVALID', `governanceRoot must be an absolute path, got ${candidate}`);
  const root = resolve(candidate);
  let directory = false;
  try { directory = statSync(join(root, 'registry', 'projects')).isDirectory(); } catch { /* reported below */ }
  if (!directory) throw new GovernanceRootError('GOVERNANCE_ROOT_INVALID', `governanceRoot ${root} has no registry/projects directory: it is not a valid governance directory`);
  return root;
}

/**
 * governance provider's agent-role catalog (registry/agents.json in the governance root), read, never copied
 * (docs/design/MODEL_ROUTING.md section 7). Returns the role ids with their `independent_from` lists, and the file's git
 * blob id (of the bytes read; it equals the provider's blob id where the checkout keeps
 * LF line endings), so a routing receipt can show which catalog it read. The role catalog has no required external schema, so only the shape
 * read here is checked: `roles[]` with a string `id` and an optional string-array `independent_from`. A missing or
 * malformed catalog throws ROLE_CATALOG_INVALID: the caller fails closed.
 */
export function roleCatalog(governanceRoot) {
  const path = join(requireGovernanceRoot(governanceRoot), 'registry', 'agents.json');
  let bytes, catalog;
  try {
    bytes = readFileSync(path);
    catalog = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new GovernanceRootError('ROLE_CATALOG_INVALID', `the governance checkout has no readable registry/agents.json (${error.code ?? error.message})`);
  }
  const ids = new Set();
  const roles = Array.isArray(catalog?.roles) ? catalog.roles.map((role) => {
    const independentFrom = role?.independent_from ?? [];
    if (!role || typeof role.id !== 'string' || !role.id || ids.has(role.id) ||
        !Array.isArray(independentFrom) || !independentFrom.every((id) => typeof id === 'string')) return null;
    ids.add(role.id);
    return { id: role.id, independentFrom: [...independentFrom] };
  }) : null;
  if (!roles || roles.includes(null)) {
    throw new GovernanceRootError('ROLE_CATALOG_INVALID', 'registry/agents.json must list roles[] with a unique string id and an optional string-array independent_from');
  }
  const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return { digest, roles };
}

/**
 * The project contracts of the governance checkout (registry/projects/*.json), read, never copied or changed, in file
 * name order: { file, contract } for each readable JSON object, { file, problem } for one that is not. Used by the
 * read-only base compare inventory (cli.mjs base-compare-inventory).
 */
export function projectContracts(governanceRoot) {
  const dir = join(requireGovernanceRoot(governanceRoot), 'registry', 'projects');
  return readdirSync(dir).filter((name) => name.endsWith('.json')).sort().map((file) => {
    try {
      const contract = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      return contract && typeof contract === 'object' && !Array.isArray(contract) && typeof contract.id === 'string'
        ? { file, contract } : { file, problem: 'not a project contract object with a string id' };
    } catch (error) { return { file, problem: `unreadable (${error.code ?? 'invalid JSON'})` }; }
  });
}
