// Definitions come from the accepted roadmap; work state comes from GitHub, never from a copied task database.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { containsCredentialMaterial } from '../shared/credential-metadata.mjs';
import { requireGovernanceRoot } from '../supervisor/governance.mjs';

const execute = promisify(execFile);
export function configuredGithubCommand(dataDir) {
  const path = join(dataDir, 'config.json');
  if (!existsSync(path)) return ['gh'];
  const configured = JSON.parse(readFileSync(path, 'utf8')).commands?.gh;
  if (configured === undefined) return ['gh'];
  if (!Array.isArray(configured) || !configured.length || !configured.every((s) => typeof s === 'string' && s.length && !/[\x00-\x1f]/.test(s))) {
    throw new Error('Supervisor commands.gh must be a non-empty command array');
  }
  return configured;
}
export const safeText = (value, max = 300) => {
  const text = String(value ?? '').slice(0, max);
  return containsCredentialMaterial(text) || /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})/.test(text) ? '[sensitive content omitted]' : text;
};
export function configuredRepositories(dataDir) {
  const path = join(dataDir, 'config.json');
  if (!existsSync(path)) return [];
  return Object.keys(JSON.parse(readFileSync(path, 'utf8')).repositories ?? {})
    .filter((name) => /^[\w.-]+\/[\w.-]+$/.test(name));
}
/**
 * Standing deploy authorizations recorded in Engineering Platform's project registry (`governance.releaseAuthorization`,
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

const repoNames = { 'engineering-platform': 'netbka/engineering-platform', Dyk: 'netbka/Dyk',
  'Local Commander': 'netbka/local-commander-mcp', EZRUN: 'netbka/ezrun_mono' };
const sourceUrl = (repo, path) => `https://github.com/${repo}/blob/main/${path}`;

/** Engineering Platform's roadmap, read from the governance root; throws GOVERNANCE_ROOT_REQUIRED / _INVALID without one. */
export function readRoadmap(governanceRoot) {
  const root = requireGovernanceRoot(governanceRoot);
  const repo = repoNames['engineering-platform'];
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
      repository: repoNames[name] ?? null, owner: null, source: sourceUrl(repo, 'docs/AUTONOMOUS_ROLLOUT.md'),
      // The baseline was adopted before package-specific tracking issues existed.
      completionPullRequest: cells[0] === 'GOV-01' ? 1 : null,
      dependencies: cells[3].match(/GOV-\d+/g) ?? [] });
  }
  return entries;
}

export function packageIds(title) {
  const found = new Set(title.match(/\b(?:PCTRL|GOV|FOUND)-\d+[A-Z]?\b/g) ?? []);
  for (const match of title.matchAll(/\b(PCTRL|GOV)-(\d+)\.\.(\d+)\b/g)) {
    if (Number(match[3]) - Number(match[2]) < 30) for (let i = Number(match[2]); i <= Number(match[3]); i++) found.add(`${match[1]}-${String(i).padStart(2, '0')}`);
  }
  return [...found];
}

function projectItem(raw, repository, kind) {
  return { key: `${repository}#${raw.number}`, repository, number: raw.number, kind,
    title: safeText(raw.title), state: raw.state, draft: Boolean(raw.isDraft),
    url: `https://github.com/${repository}/${kind === 'pr' ? 'pull' : 'issues'}/${raw.number}`,
    updatedAt: raw.updatedAt, closedAt: raw.closedAt ?? null, mergedAt: raw.mergedAt ?? null,
    labels: (raw.labels ?? []).map((label) => safeText(label.name, 60)),
    assignees: (raw.assignees ?? []).map((person) => safeText(person.login, 80)),
    closes: (raw.closingIssuesReferences ?? []).map((issue) => issue.url), packages: packageIds(raw.title ?? '') };
}

const CHECK_PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];
const CHECK_FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'];
/**
 * Merge readiness of an open pull request from `gh pr list --json number,headRefOid,mergeable,statusCheckRollup`:
 * its head commit, GitHub's conflict check and its CI results as counts. Check names and links are not kept. A
 * check that is neither passed nor failed (queued, running or unrecognised) counts as not passed yet.
 */
export function mergeState(raw) {
  const checks = Array.isArray(raw?.statusCheckRollup) ? raw.statusCheckRollup : [];
  let passed = 0, failed = 0;
  for (const check of checks) {
    // A commit status reports `state`; a check run reports `status` and, once completed, `conclusion`.
    const result = check?.__typename === 'StatusContext' ? check.state : check?.status === 'COMPLETED' ? check.conclusion : null;
    if (CHECK_PASSED.includes(result)) passed++;
    else if (CHECK_FAILED.includes(result)) failed++;
  }
  return { head: /^[0-9a-f]{40}$/.test(raw?.headRefOid ?? '') ? raw.headRefOid : null,
    mergeable: ['MERGEABLE', 'CONFLICTING'].includes(raw?.mergeable) ? raw.mergeable : 'UNKNOWN',
    checks: { total: checks.length, passed, failed, pending: checks.length - passed - failed } };
}

export function roadmapState(entries, sources) {
  return entries.map((entry) => {
    const source = sources.find((item) => item.repository === entry.repository);
    const hasBaseline = Number.isSafeInteger(entry.completionPullRequest);
    const items = (source?.items ?? []).filter((item) => item.packages.includes(entry.id) || hasBaseline && item.kind === 'pr' && item.number === entry.completionPullRequest);
    const issues = items.filter((item) => item.kind === 'issue' && packageIds(
      /^(?:PCTRL|GOV|FOUND)-\d+[A-Z]?(?:\.\.\d+)?(?=\s|:)/.exec(item.title)?.[0] ?? '').includes(entry.id));
    const prs = items.filter((item) => item.kind === 'pr');
    const openIssues = issues.filter((item) => item.state === 'OPEN');
    const baselineMerged = hasBaseline && prs.some((item) => item.number === entry.completionPullRequest && item.state === 'MERGED');
    const done = issues.length > 0 && openIssues.length === 0 || baselineMerged;
    const merged = prs.some((item) => item.state === 'MERGED');
    const inReview = prs.some((item) => item.state === 'OPEN' && !item.draft);
    const blocked = openIssues.some((item) => item.labels.some((label) => /^(blocked|waiting|owner-action|owner-decision)$/i.test(label)));
    const status = done ? 'done' : blocked ? 'blocked' : inReview ? 'review'
      : openIssues.length || prs.some((item) => item.state === 'OPEN') || merged ? 'in_progress'
        : source?.fetchedAt ? 'planned' : 'unknown';
    return { ...entry, status, items,
      evidence: baselineMerged ? 'Baseline adoption PR merged' : done ? 'Tracked issues closed' : merged ? 'Code merged; completion not recorded'
        : inReview ? 'Open pull request' : openIssues.length ? 'Tracked work; no live agent implied'
          : source?.fetchedAt ? 'No matching implementation evidence' : 'GitHub evidence unavailable',
      sourceStale: Boolean(source?.error || source?.cached) || !source?.fetchedAt || Date.now() - Date.parse(source.fetchedAt) > 120_000 };
  });
}

export function trackedEntries(entries, sources) {
  const all = [...entries], ids = new Set(entries.map((item) => item.id));
  const platform = sources.find((source) => source.repository === repoNames['engineering-platform']);
  for (const issue of (platform?.items ?? []).filter((item) => item.kind === 'issue').sort((a, b) => a.number - b.number)) {
    const match = /^((?:GOV|PCTRL|FOUND)-\d+[A-Z]?):\s*(.+)/.exec(issue.title);
    if (!match || ids.has(match[1])) continue;
    ids.add(match[1]);
    const parent = match[1].replace(/[A-Z]$/, '');
    all.push({ id: match[1], phase: match[1], title: match[2], track: 'Tracked extensions', repository: platform.repository,
      owner: null, source: issue.url, dependencies: [], parentPackage: parent !== match[1] && ids.has(parent) ? parent : null });
  }
  return all;
}

export class RoadmapSource {
  // root: the governance root (Engineering Platform checkout). Without a valid one the roadmap is empty and the snapshot
  // says so (`governance.configured: false`); the dashboard and its campaign views keep working.
  constructor({ root, cacheDir, gh = ['gh'], repositories = [] }) {
    this.governance = { configured: true, code: null, reason: null };
    try { this.entries = readRoadmap(root); }
    catch (error) {
      this.entries = [];
      const missing = error.code === 'GOVERNANCE_ROOT_REQUIRED';
      this.governance = { configured: false, code: error.code ?? 'GOVERNANCE_ROOT_UNREADABLE',
        reason: missing ? 'governance checkout not configured: set governanceRoot in the supervisor config.json or start the dashboard with --governance <path>'
          : `governance checkout not usable: ${safeText(error.message, 200)}` };
    }
    this.projectRepositories = repositories;
    this.repositories = [...new Set([...this.entries.map((entry) => entry.repository).filter(Boolean), ...repositories])];
    this.gh = gh; this.cachePath = join(cacheDir, 'roadmap-cache.json'); this.sources = []; this.cached = [];
    try {
      const cache = JSON.parse(readFileSync(this.cachePath, 'utf8'));
      // Marked as a startup cache until the first successful fetch replaces it: it is never fresh evidence.
      if (cache.version === 1) this.cached = cache.sources.filter((item) => typeof item.repository === 'string').map((item) => ({ ...item, cached: true }));
    } catch { /* A first launch has no cache; unknown remains unknown. */ }
    // Only configured repositories are served from the cache; a campaign target repository joins when it is tracked.
    this.restore(this.repositories);
    this.refreshing = null; this.lastAttempt = 0;
  }

  /** Serve the startup cache of these repositories until their first fetch; a source already present is kept. */
  restore(repositories) {
    const wanted = new Set(repositories.map((repository) => repository.toLowerCase()));
    const present = new Set(this.sources.map((source) => source.repository.toLowerCase()));
    for (const item of this.cached) {
      const key = item.repository.toLowerCase();
      if (wanted.has(key) && !present.has(key)) { present.add(key); this.sources.push(item); }
    }
  }

  /** Campaign target repositories are always fetched, so finished steps can be matched to their pull requests. */
  track(repositories) {
    const added = [...new Set(repositories)].filter((repository) => typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository) &&
      !this.repositories.some((known) => known.toLowerCase() === repository.toLowerCase()));
    if (!added.length) return false;
    this.repositories.push(...added);
    this.restore(added);
    // A refresh already in flight does not include them: fetch again as soon as it settles.
    const again = () => { this.lastAttempt = 0; void this.refresh(); };
    if (this.refreshing) void this.refreshing.then(again); else again();
    return true;
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    if (Date.now() - this.lastAttempt < 15_000) return;
    this.lastAttempt = Date.now();
    this.refreshing = this.fetch().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async fetch() {
    const sources = await Promise.all([...this.repositories].map(async (repository) => {
      try {
        const items = [];
        let partial = false;
        for (const kind of ['issue', 'pr']) {
          const fields = kind === 'issue' ? 'number,title,state,url,labels,assignees,updatedAt,closedAt'
            : 'number,title,state,url,isDraft,labels,assignees,updatedAt,closedAt,mergedAt,closingIssuesReferences';
          const { stdout } = await execute(this.gh[0], [...this.gh.slice(1), kind, 'list', '--repo', repository,
            '--state', 'all', '--limit', '1000', '--json', fields], { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
          const list = JSON.parse(stdout);
          if (!Array.isArray(list)) throw new Error('invalid list');
          partial ||= list.length >= 1000;
          items.push(...list.map((item) => projectItem(item, repository, kind)));
        }
        // Merge readiness of open pull requests, read-only and fetched separately: a failure here leaves readiness
        // unknown (the owner is told to check conflicts and CI on GitHub) without failing the repository's metadata.
        try {
          const { stdout } = await execute(this.gh[0], [...this.gh.slice(1), 'pr', 'list', '--repo', repository, '--state', 'open',
            '--limit', '200', '--json', 'number,headRefOid,mergeable,statusCheckRollup'], { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
          const open = new Map(JSON.parse(stdout).map((raw) => [raw.number, mergeState(raw)]));
          for (const item of items) if (item.kind === 'pr' && item.state === 'OPEN' && open.has(item.number)) item.merge = open.get(item.number);
        } catch { /* readiness stays unknown */ }
        return { repository, fetchedAt: new Date().toISOString(), partial, error: null, items };
      } catch {
        return { ...(this.sources.find((source) => source.repository === repository) ?? { repository, items: [], fetchedAt: null }),
          error: 'GitHub refresh failed. Check the local gh sign-in and repository access.' };
      }
    }));
    // Keep cached metadata of tracked repositories this fetch did not cover (added while it was in flight).
    this.sources = [...sources, ...this.sources.filter((old) => this.repositories.includes(old.repository) && !sources.some((item) => item.repository === old.repository))];
    try { mkdirSync(dirname(this.cachePath), { recursive: true }); writeFileSync(this.cachePath, JSON.stringify({ version: 1, sources: this.sources })); }
    catch { /* Monitoring continues in memory if its disposable metadata cache is unwritable. */ }
  }

  snapshot() {
    return { governance: this.governance, entries: roadmapState(trackedEntries(this.entries, this.sources), this.sources), refreshing: Boolean(this.refreshing),
      sources: this.sources.map(({ items, ...source }) => ({ ...source, count: items.length })),
      work: this.sources.flatMap((source) => source.items).filter((item) => item.repository === repoNames['engineering-platform'] || this.projectRepositories.includes(item.repository) || item.packages.length)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) };
  }
}
