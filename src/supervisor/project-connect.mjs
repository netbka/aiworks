// Connecting a GitHub project (aiworks#7, docs/design/PROJECT_CONNECTION.md sections 6 and 8.2, slice S3), and resolving
// a campaign's checkout through it. Connect reads only: preflight, `gh auth status`, one REST read of the repository
// (never GraphQL: gh repo view is GraphQL-backed, #16 and #21), the governance registry, and `git ls-remote` for the base
// branch. Nothing is fetched or created at connect: no git fetch, no worktree, no branch, no config.json write.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { governanceForContract, registryEntriesFor } from './campaign.mjs';
import { preflight } from './project-preflight.mjs';
import { createProject, githubRepository, project, ProjectError, projects, rootKey } from './projects.mjs';

/** The codes connect adds to preflight's, with the project status each saves (design 8.2). */
export const CONNECT_CODES = Object.freeze({
  GH_MISSING: 'needs-setup', GH_SIGNED_OUT: 'needs-setup', GH_NO_ACCESS: 'needs-setup', GH_UNREACHABLE: 'unavailable',
  BRANCH_MISSING: 'needs-setup', REGISTRY_MISSING: 'needs-setup', REGISTRY_AMBIGUOUS: 'needs-setup', REGISTRY_INVALID: 'needs-setup',
  CONFIG_CONFLICT: 'needs-setup',
});
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const CAPS = ['plan', 'startWork', 'publish', 'apply'];

/** The owner-facing copy for a connect code (design 8.2); values are names and paths only, never a remote URL. */
export function connectCopy(code, detail = {}) {
  const repo = detail.repository ?? 'this repository';
  return {
    GH_MISSING: 'GitHub projects need the GitHub CLI (gh). Install it, sign in with gh auth login, then check again.',
    GH_SIGNED_OUT: "The GitHub CLI isn't signed in. Run gh auth login, then check again.",
    GH_NO_ACCESS: `Your GitHub account can't open ${repo}. Check the repository and your access.`,
    GH_UNREACHABLE: "GitHub can't be reached right now. Your project is unchanged; AIWorks will check again.",
    BRANCH_MISSING: `${repo} has no branch named ${detail.branch}. Choose the branch AIWorks should start from.`,
    REGISTRY_MISSING: `${repo} isn't in Engineering Platform's project list, so AIWorks can plan but not start work. Add it there, then check again.`,
    REGISTRY_AMBIGUOUS: `Engineering Platform lists ${repo} more than once (${(detail.ids ?? []).join(', ')}). AIWorks won't guess which rules apply.`,
    REGISTRY_INVALID: `Engineering Platform's entry for ${repo} has an error, so AIWorks can't read its rules.`,
    CONFIG_CONFLICT: `Settings point ${repo} to ${detail.configPath}, but this project is at ${detail.root}. Remove one so AIWorks doesn't guess.`,
  }[code] ?? null;
}

const canonicalKey = (path) => {
  if (typeof path !== 'string' || path === '') return null;
  try { return rootKey(realpathSync.native(path)); } catch { return rootKey(resolve(path)); }
};

/** The config.json repositories entry for `repository`: the exact key, else one matched ignoring case, as the registry match does. */
function configEntry(config, repository) {
  if (config?.repositories?.[repository]) return config.repositories[repository];
  const key = Object.keys(config?.repositories ?? {}).find((name) => name.toLowerCase() === String(repository).toLowerCase());
  return key ? config.repositories[key] : null;
}

/**
 * Where a campaign's checkout lives (design 6.1): the live GitHub project for target.repository, else config.json as
 * today. When both exist and their canonical paths or worktree roots differ it returns { conflict } and AIWorks picks
 * neither. Returns { path, worktreeRoot, source: 'project', projectId }, the config.json entry, { conflict }, or null.
 */
export function resolveCheckout(store, config, repository) {
  const live = store.get("SELECT id, root_path, worktree_root FROM projects WHERE source_kind = 'github' AND lower(github_repository) = lower(?) AND disconnected_at IS NULL", repository);
  // No project: config.json exactly as today (the same key lookup and the same entry).
  if (!live) return config?.repositories?.[repository] ?? null;
  const configured = configEntry(config, repository);
  if (configured && (canonicalKey(configured.path) !== canonicalKey(live.root_path) ||
      (configured.worktreeRoot && canonicalKey(configured.worktreeRoot) !== canonicalKey(live.worktree_root)))) {
    const detail = { repository, configPath: configured.path, root: live.root_path, projectId: live.id };
    return { conflict: { code: 'CONFIG_CONFLICT', ...detail, message: connectCopy('CONFIG_CONFLICT', detail) } };
  }
  if (!live.worktree_root) return null;
  return { path: live.root_path, worktreeRoot: live.worktree_root, source: 'project', projectId: live.id };
}

const run = (command, args, options) => {
  const [cmd, ...prefix] = command;
  const result = spawnSync(cmd, [...prefix, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000, ...options });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.code ?? null };
};
const unreachable = (text) => /could not resolve|timed? ?out|connection (refused|reset)|network|ECONN|ETIMEDOUT|EAI_AGAIN|HTTP 5\d\d/i.test(text);

/** The GitHub half of connect: gh present and signed in, and the repository readable over REST. */
function readGithub(gh, repository) {
  const auth = gh(['auth', 'status']);
  if (auth.error === 'ENOENT') return { code: 'GH_MISSING' };
  if (auth.status !== 0) return { code: unreachable(auth.stderr) ? 'GH_UNREACHABLE' : 'GH_SIGNED_OUT' };
  const read = gh(['api', `repos/${repository}`, '--jq', '{full_name: .full_name, default_branch: .default_branch}']);
  if (read.error === 'ENOENT') return { code: 'GH_MISSING' };
  if (read.status !== 0) {
    if (unreachable(read.stderr)) return { code: 'GH_UNREACHABLE' };
    return { code: /HTTP 401|gh auth login/i.test(read.stderr) ? 'GH_SIGNED_OUT' : 'GH_NO_ACCESS' };
  }
  try {
    const value = JSON.parse(read.stdout);
    return { repository: githubRepository(value.full_name), defaultBranch: value.default_branch };
  } catch { return { code: 'GH_UNREACHABLE' }; }
}

/** Exactly one registry entry, read by the registration gate's own code (design 6.2). */
function readRegistry(repository, governanceRoot) {
  const entries = registryEntriesFor(repository, governanceRoot);
  if (!entries.length) return { code: 'REGISTRY_MISSING' };
  if (entries.length > 1) return { code: 'REGISTRY_AMBIGUOUS', detail: { ids: entries.map((entry) => entry.id) } };
  try { governanceForContract(entries[0], governanceRoot, repository); } catch { return { code: 'REGISTRY_INVALID' }; }
  return { governance: { kind: 'registry', entryId: entries[0].id, entryDigest: createHash('sha256').update(JSON.stringify(entries[0])).digest('hex') } };
}

const capabilities = (ready, reason) => Object.fromEntries(CAPS.map((key) => [key,
  key === 'apply' ? { allowed: false, reason: 'GITHUB_PUBLISHES' }
    : key === 'plan' || ready ? { allowed: true } : { allowed: false, reason }]));

/**
 * Connect the GitHub checkout at `input.path` (design 8.2). Returns { ok, code, status, message, project, preflight }:
 * a preflight refusal is returned unsaved; the same folder already connected returns that project (idempotent); a
 * connect code saves the project with its status so the owner can check again; otherwise the project is saved Ready.
 * Options: store, config, dataDir, governanceRoot, tenantId, gh and lsRemote (runners, injected by tests), git (the Git
 * command line), and preflight options (gitEnv, protectedRoots ...).
 */
export function connectGithubProject(input, { store, config = {}, dataDir, governanceRoot, tenantId = 'netbka', gh, git = ['git'], lsRemote, now = Date.now(), ...options }) {
  const live = projects(store);
  const found = preflight(input.path, { ...options, git, governanceRoot, projects: live, kind: 'github' });
  if (found.code === 'ALREADY_CONNECTED') return { ok: true, code: null, status: project(store, found.detail.projectId).status, project: project(store, found.detail.projectId), preflight: found };
  if (!found.ok) return { ok: false, code: found.code, status: found.status, project: null, preflight: found };
  if (found.kind !== 'github') return { ok: false, code: 'NOT_GITHUB', status: 'not-saved', project: null, preflight: found };

  const ghRun = gh ?? ((args) => run(config.commands?.gh ?? ['gh'], args, {}));
  const name = input.name ?? basename(found.root);
  let repository = found.repository;
  let code = null;
  let detail = {};
  let governance = { kind: 'none' };
  let baseBranch = input.baseBranch ?? null;
  const github = readGithub(ghRun, repository);
  if (github.code) code = github.code;
  else {
    repository = github.repository;
    baseBranch ??= github.defaultBranch;
    const registry = readRegistry(repository, governanceRoot);
    if (registry.code) ({ code, detail = {} } = registry);
    else governance = registry.governance;
  }
  const branchExists = lsRemote ?? ((root, branch) => lsRemoteHas(git, root, branch));
  if (!code && (!BRANCH.test(baseBranch ?? '') || !branchExists(found.root, baseBranch))) code = 'BRANCH_MISSING';
  const configured = configEntry(config, repository);
  const sameConfig = configured && canonicalKey(configured.path) === found.rootKey;
  const worktreeRoot = input.worktreeRoot ?? (sameConfig ? configured.worktreeRoot : null) ?? join(dirname(dataDir), 'worktrees', name);
  if (!code && configured && (!sameConfig || (configured.worktreeRoot && canonicalKey(configured.worktreeRoot) !== canonicalKey(worktreeRoot)))) {
    code = 'CONFIG_CONFLICT';
    detail = { configPath: configured.path, root: found.root };
  }
  detail = { ...detail, repository, branch: baseBranch };
  const status = code ? CONNECT_CODES[code] : 'ready';
  const saved = createProject(store, {
    id: input.id ?? name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40),
    tenant_id: tenantId, name, source_kind: 'github', root_path: found.root, root_file_id: found.rootFileId,
    github_repository: repository, base_branch: BRANCH.test(baseBranch ?? '') ? baseBranch : null, worktree_root: worktreeRoot,
    governance, status, reason: code, capabilities: capabilities(!code, code),
    last_preflight: { at: now, code, notices: found.notices.map((notice) => notice.code) },
  }, now);
  return { ok: !code, code, status, message: code ? connectCopy(code, detail) : null, project: saved, preflight: found };
}

/** `git ls-remote --heads origin <branch>`: reads the remote's branch list only. */
function lsRemoteHas(git, root, branch) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const listed = run(git, ['-C', root, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
  return listed.status === 0 && listed.stdout.split(/\r?\n/).some((line) => line.endsWith(`\trefs/heads/${branch}`));
}

export { ProjectError };
