// governance provider's roadmap definitions, read from the governance checkout. The dashboard does not read its work
// state from GitHub: progress of these items is tracked on GitHub, and each item links its source.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { containsCredentialMaterial } from '../shared/credential-metadata.mjs';
import { requireGovernanceRoot } from '../supervisor/governance.mjs';

export const safeText = (value, max = 300) => {
  const text = String(value ?? '').slice(0, max);
  return containsCredentialMaterial(text) || /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})/.test(text) ? '[sensitive content omitted]' : text;
};
/**
 * Standing deploy authorizations recorded in governance provider's project registry (`governance.releaseAuthorization`,
 * EP-029) under the governance root, by lowercased GitHub repository. Without a valid root nothing is recorded. A project without one is absent: its release follows its own policy, and the
 * dashboard does not say who releases.
 */
export function readReleaseAuthorizations(root) {
  const releases = {};
  let dir = null, files = [];
  try { dir = join(requireGovernanceRoot(root), 'registry/projects'); } catch { return releases; }
  try { files = readdirSync(dir).filter((file) => file.endsWith('.json')); } catch { /* no registry: nothing recorded */ }
  for (const file of files) {
    try {
      const contract = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const grant = contract.governance?.releaseAuthorization, repository = contract.repository?.github;
      if (grant && typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository)) {
        releases[repository.toLowerCase()] = { source: safeText(grant.source, 200), approval: safeText(grant.approval, 200) };
      }
    } catch { /* an unreadable entry records nothing */ }
  }
  return releases;
}

const repositoryName = /^[\w.-]+\/[\w.-]+$/;
const sourceUrl = (repo, path) => repo ? `https://github.com/${repo}/blob/main/${path}` : null;
// Resolve labels only from operator-supplied registry data. Ambiguous or unknown aliases stay unknown.
function repositoryAliases(root) {
  const aliases = new Map();
  for (const file of readdirSync(join(root, 'registry/projects')).filter(name => name.endsWith('.json'))) {
    try {
      const entry = JSON.parse(readFileSync(join(root, 'registry/projects', file), 'utf8'));
      const repository = entry.repository?.github;
      if (!repositoryName.test(repository ?? '')) continue;
      for (const name of new Set([entry.id, entry.name, repository].filter(value => typeof value === 'string'))) {
        const key = name.toLowerCase();
        aliases.set(key, aliases.has(key) && aliases.get(key) !== repository ? null : repository);
      }
    } catch { /* An unreadable registry entry supplies no aliases. */ }
  }
  return aliases;
}
// A plain directory has no repository identity. Do not inherit the enclosing source checkout's remote.
function governanceRepository(root) {
  if (!existsSync(join(root, '.git'))) return null;
  const out = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (out.error || out.status !== 0) return null;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(out.stdout.trim());
  return match?.[1] ?? null;
}

/** governance provider's roadmap, read from the governance root; throws GOVERNANCE_ROOT_REQUIRED / _INVALID without one. */
export function readRoadmap(governanceRoot) {
  const root = requireGovernanceRoot(governanceRoot);
  const repo = governanceRepository(root);
  const aliases = repositoryAliases(root);
  const product = readFileSync(join(root, 'docs/PRODUCT_ROADMAP.md'), 'utf8');
  const rollout = readFileSync(join(root, 'docs/AUTONOMOUS_ROLLOUT.md'), 'utf8');
  const assignments = JSON.parse(readFileSync(join(root, 'registry/agents.json'), 'utf8'))
    .programs.find((item) => item.id === 'product-control-plane')?.assignments ?? [];
  const entries = [];
  for (const match of product.matchAll(/^### ([PR]\d+) - (.+)$/gm)) {
    const phase = match[1], isMvp = phase.startsWith('P'), index = Number(phase.slice(1));
    const assignment = assignments.find((item) => item.package.startsWith(`${phase}/`));
    entries.push({ id: isMvp ? `PCTRL-${String(index + 1).padStart(2, '0')}` : phase,
      phase, title: match[2], track: isMvp ? 'Product control plane' : 'Product · next', repository: repo,
      owner: assignment?.responsible ?? null, source: sourceUrl(repo, 'docs/PRODUCT_ROADMAP.md'), dependencies: [] });
  }
  // The PR program is the rollout's explicit package-to-repository mapping.
  const program = rollout.split('## 19. PR program')[1]?.split('\n## ')[0] ?? '';
  for (const line of program.split('\n')) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (!/^GOV-\d+$/.test(cells[0] ?? '')) continue;
    const name = cells[1].split(' + ')[0];
    entries.push({ id: cells[0], phase: cells[0], title: cells[2], track: 'Autonomous governance',
      repository: aliases.get(name.toLowerCase()) ?? null, owner: null, source: sourceUrl(repo, 'docs/AUTONOMOUS_ROLLOUT.md'),
      dependencies: cells[3].match(/GOV-\d+/g) ?? [] });
  }
  return entries;
}

export class RoadmapSource {
  // root: the governance root (governance provider checkout). Without a valid one the roadmap is empty and the snapshot
  // says so (`governance.configured: false`); the dashboard and its campaign views keep working. It is read once at start.
  // repositories: the configured project repositories, listed only; nothing is fetched for them.
  constructor({ root, repositories = [] }) {
    this.repositories = [...repositories];
    this.governance = { configured: true, code: null, reason: null };
    try { this.entries = readRoadmap(root); }
    catch (error) {
      this.entries = [];
      const missing = error.code === 'GOVERNANCE_ROOT_REQUIRED';
      this.governance = { configured: false, code: error.code ?? 'GOVERNANCE_ROOT_UNREADABLE',
        reason: missing ? 'governance checkout not configured: set governanceRoot in the supervisor config.json or start the dashboard with --governance <path>'
          : `governance checkout not usable: ${safeText(error.message, 200)}` };
    }
  }

  snapshot() {
    return { governance: this.governance, entries: this.entries };
  }
}
