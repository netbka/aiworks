// Connecting a GitHub project (aiworks#7, docs/design/PROJECT_CONNECTION.md sections 6 and 8.2, slice S3), and resolving
// a campaign's checkout through it. Connect reads only: preflight, `gh auth status`, one REST read of the repository
// (never GraphQL: gh repo view is GraphQL-backed, #16 and #21), the governance registry, and `git ls-remote` for the base
// branch. Nothing is fetched or created at connect: no git fetch, no worktree, no branch, no config.json write.
// Connecting a local Git project (slice S4, design 8.3) reads the owner's repository and copies the chosen branch into
// AIWorks's managed mirror outside it (adapters/mirror.mjs). Starting work there stays off: LOCAL_START_OFF until the
// owner decides D2 (#24) and D4 (#32).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { governanceForContract, registryEntriesFor } from './campaign.mjs';
import { mirrorHead, mirrorRootFor, mirrorSpace, MirrorError, syncGitMirror, treeCounts, validBranch } from './adapters/mirror.mjs';
import { checkProject, githubRemote, preflight } from './project-preflight.mjs';
import { createProject, githubRepository, project, PROJECT_ID, ProjectError, projects, rootKey, updateProject } from './projects.mjs';

/** The codes connect adds to preflight's, with the project status each saves (design 8.2 and 8.3). */
export const CONNECT_CODES = Object.freeze({
  GH_MISSING: 'needs-setup', GH_SIGNED_OUT: 'needs-setup', GH_NO_ACCESS: 'needs-setup', GH_UNREACHABLE: 'unavailable',
  BRANCH_MISSING: 'needs-setup', REGISTRY_MISSING: 'needs-setup', REGISTRY_AMBIGUOUS: 'needs-setup', REGISTRY_INVALID: 'needs-setup',
  CONFIG_CONFLICT: 'needs-setup',
  MIRROR_SPACE: 'not-saved', MIRROR_CHANGED: 'needs-setup', LOCAL_BRANCH_MISSING: 'not-saved', GITHUB_REGISTERED: 'not-saved',
  PROJECT_MOVED: 'confirm', NOT_LOCAL_GIT: 'not-saved',
});
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const CAPS = ['plan', 'startWork', 'publish', 'apply'];

/** The owner-facing copy for a connect code (design 8.2); values are names and paths only, never a remote URL. */
export function connectCopy(code, detail = {}) {
  const repo = detail.repository ?? 'this repository';
  const name = detail.name ?? 'this project';
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
    GIT_NO_COMMITS: 'This Git repository has no commits yet. Make a first commit, or connect it as a plain folder.',
    UNCOMMITTED_NOTICE: `You have changes that aren't committed. AIWorks works from your last commit (${detail.sha7}) and never touches your files.`,
    MIRROR_SPACE: `There isn't enough free space for AIWorks's copy: ${size(detail.need)} needed, ${size(detail.free)} free on ${detail.drive}.`,
    MIRROR_CHANGED: "AIWorks's copy of this project changed unexpectedly, so AIWorks stopped using it.",
    LOCAL_START_OFF: "You can open and plan work here. Starting work on projects without GitHub isn't available yet: it waits for two approvals (D2 and D4).",
    SECRET_TRACKED: `${detail.count} committed files look like secrets, for example ${detail.examples?.[0]}. Workers will see them.`,
    // The design names these outcomes (4.2 point 4, 4.6) but gives no copy; these follow its style.
    LOCAL_BRANCH_MISSING: `This repository has no branch named ${detail.branch}. Choose the branch AIWorks should copy.`,
    GITHUB_REGISTERED: `${repo} is in Engineering Platform's project list, so connect it as a GitHub project.`,
    PROJECT_MOVED: `This is "${name}", connected before at ${detail.was}. Move "${name}" here to keep its history.`,
    NOT_LOCAL_GIT: 'This folder has no Git repository with commits. Connect it as a GitHub project or a plain folder.',
  }[code] ?? null;
}

/** Bytes as the owner reads them: 512 MB, 1.5 GB. */
function size(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
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
    id: input.id ?? idFrom(name),
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

/** The default project id: the folder name, lowercased, with other characters as hyphens. */
const idFrom = (name) => name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/**
 * What a local Git project may do (design 3.1 and 8.3). Starting work waits for D2 (#24) and D4 (#32): it is not a
 * setting, projects.mjs refuses startWork for every kind but github, and turning it on is a reviewed code change that
 * names both decisions (design 6.2). Publishing needs GitHub; applying a result belongs to #13.
 */
export const LOCAL_GIT_CAPABILITIES = Object.freeze({
  plan: Object.freeze({ allowed: true }),
  startWork: Object.freeze({ allowed: false, reason: 'LOCAL_START_OFF' }),
  publish: Object.freeze({ allowed: false, reason: 'NO_GITHUB' }),
  apply: Object.freeze({ allowed: false, reason: 'APPLY_NOT_BUILT' }),
});

/** One read of the owner's repository, with the same read-only settings as preflight. */
function readSource(git, root, args, gitEnv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return run(git, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args],
    { env: { ...env, ...gitEnv, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
}

/** `owner/name` of a github.com `origin`, read with `git remote -v`; null when there is none. */
function originRepository(git, root, gitEnv) {
  const url = readSource(git, root, ['remote', '-v']).stdout.split(/\r?\n/)
    .map((line) => /^origin\s+(\S+)\s+\(fetch\)$/.exec(line)?.[1]).find(Boolean);
  return url ? githubRemote(url) : null;
}

const withCopy = (notice) => ({ ...notice, message: connectCopy(notice.code, notice) });
/** The notices a Ready local Git project shows: LOCAL_START_OFF always, then preflight's (uncommitted, secret-like). */
const localNotices = (found) => [{ code: 'LOCAL_START_OFF' }, ...(found?.notices ?? [])].map(withCopy);
const refused = (found, code, detail = {}) => ({ ok: false, code, status: CONNECT_CODES[code] ?? found.status,
  message: connectCopy(code, detail), detail, project: null, preflight: found });
const asOwnerStatus = (status) => (['ready', 'needs-setup', 'unavailable'].includes(status) ? status : 'needs-setup');

/** Record baseline `seq` of a local Git project: its manifest is the commit's tree, so the digest is the commit SHA (5.3). */
function insertBaseline(store, projectId, seq, commit, counts, now) {
  store.insert('project_baselines', { project_id: projectId, seq, commit_sha: commit, manifest_digest: commit,
    files: counts.files, bytes: counts.bytes, excluded: '{}', created_at: now });
  store.journal(null, 'project-baseline-taken', { projectId, seq, commit }, now);
  return { seq, commit, at: now };
}

/**
 * Connect the local Git repository at `input.path` (design 8.3): path checks and Git detection (preflight), the branch
 * (default: the current one, which must have commits), the fingerprint (the root commits preflight reads), governance
 * `none` (D2 is not in force), the managed mirror and baseline 1, then save Ready with startWork false (LOCAL_START_OFF).
 * Returns { ok, code, status, message, notices, project, baseline, preflight }. Refusals save nothing and create no
 * mirror; the same folder already connected returns that project; a known repository at a new path returns
 * PROJECT_MOVED, which the owner confirms with relocateLocalGitProject (or input.asNewProject connects it as new).
 * input: path, and optionally name, id, branch, asNewProject. Options: store, dataDir, governanceRoot, tenantId, git,
 * now, statfs (for the space check) and preflight options (gitEnv, protectedRoots ...).
 */
export function connectLocalGitProject(input, { store, dataDir, governanceRoot, tenantId = 'netbka', git = ['git'], now = Date.now(), statfs, ...options }) {
  const live = projects(store);
  const home = dirname(resolve(dataDir));
  const found = preflight(input.path, { ...options, git, governanceRoot, projects: live, kind: 'local-git',
    protectedRoots: [...(options.protectedRoots ?? []), dataDir, join(home, 'mirrors')] });
  if (found.code === 'ALREADY_CONNECTED') {
    const existing = project(store, found.detail.projectId);
    return { ok: true, code: null, status: existing.status, message: null, notices: localNotices(found), project: existing, baseline: existing.current_baseline, preflight: found };
  }
  if (!found.ok) return refused(found, found.code, found.detail);
  if (found.kind !== 'local-git') return refused(found, 'NOT_LOCAL_GIT');
  const { gitEnv } = options;
  // An unregistered GitHub checkout may connect as local Git; a registered one must connect as GitHub, so one repository
  // never has two governance bindings (design 4.2, point 4).
  if (found.proposedKind === 'github') {
    const repository = originRepository(git, found.root, gitEnv);
    if (repository && registryEntriesFor(repository, governanceRoot).length) return refused(found, 'GITHUB_REGISTERED', { repository });
  }
  const branch = input.branch ?? found.branch;
  if (!validBranch(branch) || readSource(git, found.root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], gitEnv).status !== 0) {
    return refused(found, 'LOCAL_BRANCH_MISSING', { branch: branch ?? 'HEAD' });
  }
  const moved = live.find((other) => other.source_kind === 'local-git' && other.fingerprint === found.fingerprint && other.root_key !== found.rootKey);
  if (moved && !input.asNewProject) return refused(found, 'PROJECT_MOVED', { projectId: moved.id, name: moved.name, was: moved.root_path });

  const name = input.name ?? basename(found.root);
  const id = input.id ?? idFrom(name);
  // The id names the mirror's folder, so it is checked before anything is created.
  if (typeof id !== 'string' || !PROJECT_ID.test(id)) {
    throw new ProjectError('PROJECT_ID_INVALID', 'Project ids use 2 to 40 lowercase letters, digits and hyphens, starting with a letter or digit');
  }
  if (project(store, id)) throw new ProjectError('PROJECT_ID_TAKEN', `The project id "${id}" is already in use or was used before. Choose another.`, { projectId: id });
  const space = mirrorSpace({ git, sourceRoot: found.root, mirrorParent: home, statfs, gitEnv });
  if (!space.ok) return refused(found, 'MIRROR_SPACE', space);

  const mirrorRoot = mirrorRootFor(dataDir, id);
  const { head } = syncGitMirror({ git, mirrorRoot, sourceRoot: found.root, branch, gitEnv });
  const counts = treeCounts({ git, mirrorRoot, sha: head, gitEnv });
  const saved = store.tx(() => {
    createProject(store, {
      id, tenant_id: tenantId, name, source_kind: 'local-git', root_path: found.root, root_file_id: found.rootFileId,
      fingerprint: found.fingerprint, local_branch: branch, mirror_root: mirrorRoot, worktree_root: input.worktreeRoot ?? join(home, 'worktrees', id),
      governance: { kind: 'none' }, status: 'ready', reason: null, capabilities: LOCAL_GIT_CAPABILITIES,
      current_baseline: { seq: 1, commit: head, at: now },
      last_preflight: { at: now, code: null, notices: found.notices.map((notice) => notice.code) },
    }, now);
    insertBaseline(store, id, 1, head, counts, now);
    return project(store, id);
  });
  return { ok: true, code: null, status: 'ready', message: null, notices: localNotices(found), project: saved, baseline: saved.current_baseline, preflight: found };
}

function liveLocalGit(store, id) {
  const current = project(store, id);
  if (!current || current.disconnected_at != null) throw new ProjectError('PROJECT_NOT_FOUND', `No connected project "${id}"`, { projectId: id });
  if (current.source_kind !== 'local-git') throw new ProjectError('PROJECT_INVALID', `Project "${id}" is not a local Git project`, { projectId: id });
  return current;
}

/** Save a check's outcome when it changed the status; a passing check after MIRROR_CHANGED does not clear it (Rebuild copy does). */
function saveState(store, current, status, reason, now) {
  if (current.status === status && current.reason === reason) return current;
  return updateProject(store, current.id, current.version, { status, reason }, now);
}

/**
 * Light check of a local Git project (design 3.3): the folder is reachable and holds the same repository (preflight's
 * identity rules), and the mirror still holds the recorded baseline. MIRROR_CHANGED when it does not: AIWorks stops
 * using the copy until the owner chooses Rebuild copy. The status is saved. Returns { ok, code, status, message, project }.
 */
export function checkLocalGitProject(store, id, { governanceRoot, git = ['git'], now = Date.now(), ...options }) {
  const current = liveLocalGit(store, id);
  const source = checkProject(current, { ...options, git, governanceRoot, projects: projects(store) });
  let code = source.ok ? null : source.code;
  let detail = source.ok ? {} : source.detail;
  if (!code && (current.reason === 'MIRROR_CHANGED' ||
      mirrorHead({ git, mirrorRoot: current.mirror_root, branch: current.local_branch, gitEnv: options.gitEnv }) !== current.current_baseline?.commit)) {
    code = 'MIRROR_CHANGED';
    detail = {};
  }
  const status = code ? asOwnerStatus(CONNECT_CODES[code] ?? source.status) : 'ready';
  const saved = saveState(store, current, status, code, now);
  return { ok: !code, code, status, message: code ? connectCopy(code, { ...detail, name: current.name }) : null,
    notices: code ? [] : localNotices(source), project: saved };
}

/** Take the next baseline from the mirror's current head and make it current. */
function takeBaseline(store, current, head, counts, now) {
  return store.tx(() => {
    const seq = (store.get('SELECT max(seq) AS seq FROM project_baselines WHERE project_id = ?', current.id)?.seq ?? 0) + 1;
    const baseline = insertBaseline(store, current.id, seq, head, counts, now);
    updateProject(store, current.id, current.version, { current_baseline: baseline, status: 'ready', reason: null }, now);
    return project(store, current.id);
  });
}

/**
 * Refresh from folder (design 5.3): after a passing light check, fetch the branch into the mirror again. A new commit
 * becomes the next baseline; an unchanged branch takes none. Returns { ok, code, status, message, taken, project }.
 */
export function refreshLocalGitProject(store, id, { git = ['git'], now = Date.now(), ...options }) {
  const check = checkLocalGitProject(store, id, { ...options, git, now });
  if (!check.ok) return { ...check, taken: false };
  const current = check.project;
  const { head } = syncGitMirror({ git, mirrorRoot: current.mirror_root, sourceRoot: current.root_path, branch: current.local_branch, gitEnv: options.gitEnv });
  if (head === current.current_baseline?.commit) return { ...check, taken: false };
  const saved = takeBaseline(store, current, head, treeCounts({ git, mirrorRoot: current.mirror_root, sha: head, gitEnv: options.gitEnv }), now);
  return { ...check, project: saved, taken: true };
}

/**
 * Rebuild copy, the action for MIRROR_CHANGED (design 5.3): fetch the branch again with the forced refspec, which
 * replaces whatever the mirror's ref was changed to, and take a new baseline. The source must still pass the light
 * check. Old baselines, task worktrees and evidence are kept. Returns { ok, code, status, message, project }.
 */
export function rebuildLocalGitMirror(store, id, { governanceRoot, git = ['git'], now = Date.now(), ...options }) {
  const current = liveLocalGit(store, id);
  const source = checkProject(current, { ...options, git, governanceRoot, projects: projects(store) });
  if (!source.ok) {
    const status = asOwnerStatus(source.status);
    return { ok: false, code: source.code, status, message: connectCopy(source.code, source.detail), project: saveState(store, current, status, source.code, now) };
  }
  const { head } = syncGitMirror({ git, mirrorRoot: current.mirror_root, sourceRoot: current.root_path, branch: current.local_branch, gitEnv: options.gitEnv });
  const saved = takeBaseline(store, current, head, treeCounts({ git, mirrorRoot: current.mirror_root, sha: head, gitEnv: options.gitEnv }), now);
  return { ok: true, code: null, status: 'ready', message: null, project: saved };
}

/**
 * Move "{name}" here (design 4.6): the owner confirms that the repository at `path` is the moved project. Only the same
 * fingerprint is accepted. The id, history, mirror and baselines stay; the root changes and `project-relocated` is
 * journalled. Returns { ok, code, status, message, project }.
 */
export function relocateLocalGitProject(store, id, path, { governanceRoot, dataDir, git = ['git'], now = Date.now(), ...options }) {
  const current = liveLocalGit(store, id);
  const others = projects(store).filter((other) => other.id !== id);
  const protectedRoots = [...(options.protectedRoots ?? []), current.mirror_root, ...(dataDir ? [dataDir] : [])];
  const found = preflight(path, { ...options, git, governanceRoot, projects: others, kind: 'local-git', protectedRoots });
  if (!found.ok) return { ok: false, code: found.code, status: found.status, message: connectCopy(found.code, found.detail), project: current };
  if (found.kind !== 'local-git' || found.fingerprint !== current.fingerprint) {
    return { ok: false, code: 'IDENTITY_CHANGED', status: 'not-saved', message: null, project: current };
  }
  const saved = store.tx(() => {
    store.patch('projects', { id }, current.version, { root_path: found.root, root_key: found.rootKey, root_file_id: found.rootFileId }, now);
    store.journal(null, 'project-relocated', { projectId: id }, now);
    return project(store, id);
  });
  return { ok: true, code: null, status: saved.status, message: null, project: saved };
}

export { MirrorError, ProjectError };
