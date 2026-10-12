// AIWorks reads Engineering Platform's portfolio governance (registry/projects, policies/catalog.json, registry/agents.json,
// schemas/project-contract.schema.json, docs/PRODUCT_ROADMAP.md, docs/AUTONOMOUS_ROLLOUT.md) from an explicit governance
// root: a read-only checkout of netbka/engineering-platform. There is no default and no fallback to AIWorks's own tree:
// without a valid root every code path that needs governance fails closed with a coded error.
import { existsSync, readFileSync, statSync } from 'node:fs';
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
      'no governance checkout is configured: set "governanceRoot" in the data directory config.json or pass --governance <path> (a read-only checkout of netbka/engineering-platform)');
  }
  if (!isAbsolute(candidate)) throw new GovernanceRootError('GOVERNANCE_ROOT_INVALID', `governanceRoot must be an absolute path, got ${candidate}`);
  const root = resolve(candidate);
  let directory = false;
  try { directory = statSync(join(root, 'registry', 'projects')).isDirectory(); } catch { /* reported below */ }
  if (!directory) throw new GovernanceRootError('GOVERNANCE_ROOT_INVALID', `governanceRoot ${root} has no registry/projects directory: it is not a checkout of netbka/engineering-platform`);
  return root;
}
