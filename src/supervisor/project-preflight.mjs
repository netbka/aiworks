// AIWorks project preflight (aiworks#7, docs/design/PROJECT_CONNECTION.md section 4, slice S2). It looks at a folder the
// owner names and says what it is: a GitHub checkout, a local Git repository or a plain folder, or the one code that
// stops it. Preflight only reads. It never writes in the folder, never runs a Git command outside READ_ONLY_GIT, never
// writes Git configuration and never calls GitHub, gh or a model. It saves nothing: connecting is a later slice.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, realpathSync, statfsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_LIKE_PATH_PATTERN } from '../../scripts/lib/worker-context.mjs';
import { githubRepository, rootKey } from './projects.mjs';

/** Every code preflight can stop with, and the status the design gives it (sections 8.1 to 8.4). */
export const PREFLIGHT_CODES = Object.freeze({
  PATH_NOT_ABSOLUTE: 'not-saved', PATH_NOT_FOUND: 'not-saved', PATH_NOT_DIRECTORY: 'not-saved', PATH_NETWORK: 'not-saved',
  PATH_PROTECTED: 'not-saved', PATH_OVERLAP: 'not-saved', PATH_UNREADABLE: 'not-saved', ALREADY_CONNECTED: 'opens',
  ROOT_MISSING: 'unavailable', ROOT_REPLACED: 'needs-setup', IDENTITY_CHANGED: 'needs-setup',
  GOVERNANCE_ROOT_MISSING: 'needs-setup', GIT_CLI_MISSING: 'needs-setup',
  GIT_SUBFOLDER: 'not-saved', GIT_WORKTREE: 'not-saved', GIT_BARE: 'not-saved', GIT_UNTRUSTED: 'needs-setup', GIT_NO_COMMITS: 'not-saved',
  TOO_LARGE: 'not-saved', FILE_TOO_LARGE: 'not-saved', SCAN_TIMEOUT: 'not-saved', UNREADABLE_FILES: 'not-saved',
  CASE_COLLISION: 'not-saved', MIRROR_SPACE: 'not-saved',
});
/** Plain-folder scan limits (design section 4.5). Tests pass smaller ones. */
export const SCAN_LIMITS = Object.freeze({ maxFiles: 200_000, maxBytes: 2 * 1024 ** 3, maxFileBytes: 100 * 1024 ** 2, timeoutMs: 120_000 });
/**
 * The only Git subcommands preflight runs. Each reads; with GIT_OPTIONAL_LOCKS=0 and --no-optional-locks not even
 * `status` refreshes the index. `remote` is allowed only as `remote -v` and `symbolic-ref` only as a read of HEAD.
 */
export const READ_ONLY_GIT = Object.freeze(['rev-parse', 'rev-list', 'remote', 'symbolic-ref', 'status', 'ls-files']);
const GIT_PREFIX = Object.freeze(['--no-optional-locks', '-c', 'core.fsmonitor=false']);
const MAX_PATH_INPUT = 1024;
const EXAMPLES = 10;
const SECRET_LIKE_PATH = new RegExp(SECRET_LIKE_PATH_PATTERN, 'u');
const AIWORKS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export class PreflightError extends Error {
  constructor(code, message) { super(message); this.name = 'PreflightError'; this.code = code; }
}

const NODE_IO = Object.freeze({
  realpath: (path) => realpathSync.native(path),
  stat: (path) => statSync(path, { bigint: true }),
  lstat: (path) => lstatSync(path, { bigint: true }),
  readdir: (path) => readdirSync(path),
  // Opening for reading (and closing at once) proves a file can be copied later without reading or changing it.
  canRead: (path) => { try { closeSync(openSync(path, 'r')); return true; } catch { return false; } },
  statfs: (path) => statfsSync(path, { bigint: true }),
});

const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
const related = (a, b) => inside(a, b) || inside(b, a);
const fileId = (stat) => createHash('sha256').update(`${stat.dev}:${stat.ino}`).digest('hex');
const sample = () => ({ count: 0, examples: [] });
const note = (bucket, path) => { bucket.count += 1; if (bucket.examples.length < EXAMPLES) bucket.examples.push(path); };

function canonical(io, path, platform) {
  try { return rootKey(io.realpath(path), platform); } catch { return rootKey(resolve(path), platform); }
}

/** Absolute paths only: no relative, root-relative, empty, over-long or control-character input. */
function absoluteInput(input, platform) {
  if (typeof input !== 'string' || input.trim() === '' || input.length > MAX_PATH_INPUT || /[\u0000-\u001f\u007f]/.test(input)) return false;
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(input) : isAbsolute(input);
}

/**
 * Folders AIWorks must never treat as a project: a drive root, the user profile root, system and program folders and
 * everything inside them, and AIWorks's own places (its checkout, data, governance, worktrees and mirrors) together with
 * anything inside or around them, so a scan can never copy AIWorks's own state.
 */
function protectedRoot(key, io, options, platform) {
  const env = options.env ?? process.env;
  const own = [AIWORKS_ROOT, options.governanceRoot, ...(options.protectedRoots ?? [])];
  for (const project of options.projects ?? []) own.push(project.mirror_root, project.worktree_root);
  if (own.some((path) => typeof path === 'string' && path !== '' && related(key, canonical(io, path, platform)))) return true;
  const system = [env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)']];
  if (system.some((path) => typeof path === 'string' && path !== '' && inside(key, canonical(io, path, platform)))) return true;
  const home = options.home ?? homedir();
  return (home && key === canonical(io, home, platform)) || rootKey(parse(key).root, platform) === key;
}

function governanceReadable(root, io) {
  if (typeof root !== 'string' || !isAbsolute(root)) return false;
  try { return io.stat(join(root, 'registry', 'projects')).isDirectory(); } catch { return false; }
}

/** One read-only Git command in `root`, or a PreflightError. Write commands are refused before anything runs. */
function runGit(options, root, args) {
  const [sub, ...rest] = args;
  if (!READ_ONLY_GIT.includes(sub) || (sub === 'remote' && (rest.length !== 1 || rest[0] !== '-v')) ||
      (sub === 'symbolic-ref' && rest.at(-1) !== 'HEAD')) {
    throw new PreflightError('GIT_NOT_READ_ONLY', `preflight refuses git ${sub}: it only reads`);
  }
  const [command, ...prefix] = options.git ?? ['git'];
  // Inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE ...) could point Git at another repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const result = spawnSync(command, [...prefix, ...GIT_PREFIX, '-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...env, ...options.gitEnv, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error?.code === 'ENOENT') throw new PreflightError('GIT_CLI_MISSING', 'git was not found');
  if (result.error) throw new PreflightError('GIT_FAILED', `git ${sub} did not finish: ${result.error.message}`);
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** `owner/name` when `url` is a github.com remote (https or ssh); null for any other host. User info is dropped. */
export function githubRemote(url) {
  let host = null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) { try { host = new URL(url).hostname.toLowerCase(); } catch { return null; } }
  else host = /^(?:[^@/\s]+@)?([^:/\s]+):/.exec(url)?.[1]?.toLowerCase() ?? null;
  if (host !== 'github.com') return null;
  try { return githubRepository(url); } catch { return null; }
}

/** Git detection (design section 4.2). Returns the facts, or `{ code, detail }` for a refusal. */
function detectGit(options, root, platform, io) {
  const head = runGit(options, root, ['rev-parse', '--path-format=absolute', '--is-bare-repository', '--is-inside-git-dir', '--git-dir', '--git-common-dir']);
  if (!head.ok) {
    if (/dubious ownership/i.test(head.stderr)) return { code: 'GIT_UNTRUSTED' };
    if (/not a git repository/i.test(head.stderr)) return { repository: false };
    throw new PreflightError('GIT_FAILED', 'git rev-parse failed while reading the folder');
  }
  const [bare, inGitDir, gitDir, commonDir] = head.stdout.split(/\r?\n/);
  if (bare === 'true') return { code: 'GIT_BARE' };
  const key = (path) => canonical(io, path, platform);
  if (inGitDir === 'true') return { code: 'GIT_SUBFOLDER', detail: { top: dirname(commonDir) } };
  const top = runGit(options, root, ['rev-parse', '--show-toplevel']);
  const topPath = top.stdout.trim();
  if (!top.ok || !topPath) throw new PreflightError('GIT_FAILED', 'git rev-parse --show-toplevel failed while reading the folder');
  if (key(topPath) !== key(root)) return { code: 'GIT_SUBFOLDER', detail: { top: resolve(topPath) } };
  if (key(gitDir) !== key(commonDir)) return { code: 'GIT_WORKTREE', detail: { main: resolve(dirname(commonDir)) } };

  const origin = runGit(options, root, ['remote', '-v']).stdout.split(/\r?\n/)
    .map((line) => /^origin\s+(\S+)\s+\(fetch\)$/.exec(line)?.[1]).find(Boolean);
  const repository = origin ? githubRemote(origin) : null;
  const branchRead = runGit(options, root, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const branch = branchRead.ok ? branchRead.stdout.trim() || null : null;
  const commit = runGit(options, root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (!commit.ok) return { repository: true, github: repository, branch, head: null };
  const roots = runGit(options, root, ['rev-list', '--max-parents=0', 'HEAD']).stdout.split(/\s+/).filter(Boolean).sort();
  return { repository: true, github: repository, branch, head: commit.stdout.trim(), roots };
}

/** Notices for a Git project: uncommitted changes, and committed files that look like secrets (design 4.4, 8.2, 8.3). */
function gitNotices(options, root, git, kind) {
  const notices = [];
  if (kind === 'local-git') {
    const status = runGit(options, root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    if (status.ok && status.stdout !== '') notices.push({ code: 'UNCOMMITTED_NOTICE', sha7: git.head.slice(0, 7) });
  }
  const tracked = sample();
  const files = runGit(options, root, ['ls-files', '-z']);
  for (const path of files.ok ? files.stdout.split('\0').filter(Boolean) : []) if (SECRET_LIKE_PATH.test(path)) note(tracked, path);
  if (tracked.count) notices.push({ code: 'SECRET_TRACKED', ...tracked });
  return notices;
}

/**
 * Plain-folder scan (design sections 4.3 to 4.5). It uses lstat and never follows a link or junction. It reads names and
 * sizes and opens files to prove they are readable; it never reads, copies or changes their content.
 */
function scanFolder(root, io, options, platform) {
  const limits = { ...SCAN_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const deadline = now() + limits.timeoutMs;
  const exclusions = (options.exclusions ?? []).map((path) => path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''));
  const excluded = { secrets: sample(), links: sample(), repos: sample(), modules: sample(), owner: sample(), other: sample() };
  const tooLarge = sample();
  const unreadable = sample();
  let files = 0;
  let bytes = 0n;
  let hardLinks = 0;
  const pending = [''];
  while (pending.length) {
    const rel = pending.pop();
    const path = rel === '' ? root : join(root, rel);
    let names;
    try { names = io.readdir(path); } catch { note(unreadable, rel); continue; }
    const included = [];
    for (const name of names) {
      if (now() > deadline) return { code: 'SCAN_TIMEOUT' };
      const child = rel === '' ? name : `${rel}/${name}`;
      if (exclusions.some((excludedPath) => inside(child, excludedPath))) { note(excluded.owner, child); continue; }
      if (SECRET_LIKE_PATH.test(child)) { note(excluded.secrets, child); continue; }
      let stat;
      try { stat = io.lstat(join(root, child)); } catch (error) { if (error.code !== 'ENOENT') note(unreadable, child); continue; }
      // On Windows Node reports a junction as a symbolic link, so this covers both.
      if (stat.isSymbolicLink()) { note(excluded.links, child); continue; }
      if (stat.isDirectory()) {
        if (name === 'node_modules' && !options.includeNodeModules) { note(excluded.modules, child); continue; }
        let nested = false;
        try { io.lstat(join(root, child, '.git')); nested = true; } catch { /* no nested repository */ }
        if (nested) { note(excluded.repos, child); continue; }
        included.push({ name, child, directory: true });
      } else if (stat.isFile()) {
        included.push({ name, child, directory: false, stat });
      } else {
        note(excluded.other, child);
      }
    }
    const folded = new Map();
    for (const entry of included) {
      const key = entry.name.normalize('NFC').toLowerCase();
      if (folded.has(key)) return { code: 'CASE_COLLISION', detail: { a: folded.get(key), b: entry.child } };
      folded.set(key, entry.child);
    }
    for (const entry of included) {
      if (entry.directory) { pending.push(entry.child); continue; }
      files += 1;
      bytes += entry.stat.size;
      if (entry.stat.nlink > 1n) hardLinks += 1;
      if (entry.stat.size > BigInt(limits.maxFileBytes)) note(tooLarge, entry.child);
      else if (!io.canRead(join(root, entry.child))) note(unreadable, entry.child);
      if (files > limits.maxFiles || bytes > BigInt(limits.maxBytes)) {
        return { code: 'TOO_LARGE', detail: { files, bytes: Number(bytes) } };
      }
    }
  }
  if (unreadable.count) return { code: 'UNREADABLE_FILES', detail: unreadable };
  if (tooLarge.count) return { code: 'FILE_TOO_LARGE', detail: tooLarge };
  const scan = { files, bytes: Number(bytes), hardLinks, excluded };
  if (options.mirrorParent) {
    const space = io.statfs(options.mirrorParent);
    const free = space.bavail * space.bsize;
    const need = (bytes * 22n + 9n) / 10n;
    if (free < need) return { code: 'MIRROR_SPACE', detail: { need: Number(need), free: Number(free) } };
  }
  return { scan };
}

/** The live project at the same root: same identity opens it; anything else is never switched silently (section 4.6). */
function sameRoot(project, facts) {
  const detail = { projectId: project.id, name: project.name };
  const same = (a, b) => (facts.kind === 'github' ? (a ?? '').toLowerCase() === (b ?? '').toLowerCase() : (a ?? null) === (b ?? null));
  if (project.source_kind !== facts.kind || !same(project.fingerprint, facts.fingerprint)) {
    return { code: 'IDENTITY_CHANGED', detail: { ...detail, was: project.fingerprint ?? project.source_kind, now: facts.fingerprint ?? facts.kind } };
  }
  if (project.root_file_id && project.root_file_id !== facts.rootFileId) return { code: 'ROOT_REPLACED', detail };
  return { code: 'ALREADY_CONNECTED', detail };
}

/**
 * Read-only preflight of the folder at `input`. The result says what was found, or the one code that stops it:
 *   { ok, code, status, detail, input, root, rootKey, rootFileId, proposedKind, kind, repository, branch, head,
 *     fingerprint, confirm, notices, scan }
 * Options: projects (live project records), governanceRoot, protectedRoots, exclusions, includeNodeModules, kind (the
 * owner's switch: a GitHub checkout to 'local-git', or a repository without commits to 'folder'), mirrorParent (where
 * the copy would go, for MIRROR_SPACE), limits, git (the Git command line), and for tests gitEnv (for example
 * GIT_CEILING_DIRECTORIES, so a host whose profile folder is a repository cannot decide a test), env, home, now and io.
 */
export function preflight(input, options = {}) {
  const platform = options.platform ?? process.platform;
  const io = { ...NODE_IO, ...options.io };
  const result = { ok: false, code: null, status: null, detail: {}, input, root: null, rootKey: null, rootFileId: null,
    proposedKind: null, kind: null, repository: null, branch: null, head: null, fingerprint: null, confirm: null, notices: [], scan: null };
  const stop = (code, detail = {}) => Object.assign(result, { code, status: PREFLIGHT_CODES[code], detail });

  // Path checks (design section 4.1). Network and device paths are refused before anything touches them.
  if (typeof input === 'string' && /^[\\/]{2}[?.][\\/]/.test(input)) return stop('PATH_PROTECTED');
  if (typeof input === 'string' && /^[\\/]{2}[^\\/]/.test(input)) return stop('PATH_NETWORK');
  if (!absoluteInput(input, platform)) return stop('PATH_NOT_ABSOLUTE');
  let stat;
  try { stat = io.stat(input); } catch (error) {
    return stop(['EACCES', 'EPERM'].includes(error.code) ? 'PATH_UNREADABLE' : 'PATH_NOT_FOUND');
  }
  if (!stat.isDirectory()) return stop('PATH_NOT_DIRECTORY');
  let root;
  try { root = io.realpath(input); } catch { return stop('PATH_NOT_FOUND'); }
  if (/^[\\/]{2}/.test(root)) return stop('PATH_NETWORK');
  result.root = root;
  result.rootKey = rootKey(root, platform);
  result.rootFileId = fileId(stat);
  if (rootKey(resolve(input), platform) !== result.rootKey) result.confirm = { code: 'PATH_IS_LINK', canonical: root };
  if (protectedRoot(result.rootKey, io, options, platform)) return stop('PATH_PROTECTED');
  const live = (options.projects ?? []).filter((project) => project.disconnected_at == null);
  const overlap = live.find((project) => project.root_key !== result.rootKey && related(result.rootKey, project.root_key));
  if (overlap) return stop('PATH_OVERLAP', { projectId: overlap.id, name: overlap.name });
  try { io.readdir(root); } catch { return stop('PATH_UNREADABLE'); }
  if (!governanceReadable(options.governanceRoot, io)) return stop('GOVERNANCE_ROOT_MISSING');

  // Kind (design section 4.2).
  let git;
  try { git = detectGit(options, root, platform, io); } catch (error) {
    if (error.code === 'GIT_CLI_MISSING') return stop('GIT_CLI_MISSING');
    throw error;
  }
  if (git.code) return stop(git.code, git.detail);
  result.proposedKind = !git.repository ? 'folder' : git.github && git.head ? 'github' : 'local-git';
  const switched = (options.kind === 'local-git' && result.proposedKind === 'github') ||
    (options.kind === 'folder' && git.repository && !git.head);
  result.kind = switched ? options.kind : result.proposedKind;
  if (result.kind === 'github') Object.assign(result, { repository: git.github, fingerprint: git.github });
  if (result.kind !== 'folder') Object.assign(result, { branch: git.branch, head: git.head });
  if (result.kind === 'local-git' && git.head) result.fingerprint = git.roots.join(',');

  const same = live.find((project) => project.root_key === result.rootKey);
  if (same) {
    const verdict = sameRoot(same, result);
    return stop(verdict.code, verdict.detail);
  }
  if (result.kind === 'local-git' && !git.head) return stop('GIT_NO_COMMITS', { alternative: 'folder' });
  if (result.kind !== 'folder') {
    result.notices.push(...gitNotices(options, root, git, result.kind));
  } else {
    const scanned = scanFolder(root, io, options, platform);
    if (scanned.code) return stop(scanned.code, scanned.detail);
    result.scan = scanned.scan;
    const excluded = Object.fromEntries(Object.entries(scanned.scan.excluded).map(([key, bucket]) => [key, bucket.count]));
    if (Object.values(excluded).some(Boolean)) result.notices.push({ code: 'EXCLUDED_NOTICE', ...excluded });
  }
  result.ok = true;
  return result;
}

/**
 * Light check of a connected project (design section 3.3): its root is reachable and still holds the same project.
 * `ROOT_MISSING` when the root cannot be reached; otherwise the preflight verdict, where an unchanged identity is ok.
 */
export function checkProject(project, options = {}) {
  const io = { ...NODE_IO, ...options.io };
  let reachable = false;
  try { reachable = io.stat(project.root_path).isDirectory(); } catch { /* reported below */ }
  if (!reachable) {
    return { ok: false, code: 'ROOT_MISSING', status: PREFLIGHT_CODES.ROOT_MISSING, detail: { projectId: project.id, path: project.root_path } };
  }
  const others = (options.projects ?? []).filter((other) => other.id !== project.id);
  const result = preflight(project.root_path, { ...options, projects: [project, ...others], kind: project.source_kind, exclusions: project.exclusions });
  if (result.code !== 'ALREADY_CONNECTED') return result;
  return { ...result, ok: true, code: null, status: null };
}
