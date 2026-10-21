// AIWorks's managed mirror of a project without GitHub (aiworks#7, docs/design/PROJECT_CONNECTION.md section 5, slice S4:
// the local-Git part; slice S5, the plain-folder part, is further down). The mirror is a bare repository AIWorks owns, outside the owner's folder. Every write lands in the
// mirror: the owner's repository is only read, by `git fetch` from its path (the fetch runs upload-pack there, which
// reads) and by `count-objects` for the space check. Nothing here writes Git configuration in the owner's repository,
// adds a worktree record, branch or remote there, or contacts any remote: the source is fetched by its path, never by a
// remote name. Workers never get the mirror's path; task worktrees come from it through adapters/git.mjs with a baseSha.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync,
  statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { SECRET_LIKE_PATH_PATTERN } from '../../../scripts/lib/worker-context.mjs';
import { realKey } from '../projects.mjs';

export const MIRROR_REPO = 'repo.git';
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])(?<!\.lock)$/;
// Per-command settings: no fsmonitor, no automatic gc or maintenance, no hooks. They write no configuration anywhere.
const GIT_PREFIX = Object.freeze(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']);
/** Free space the mirror needs, as a multiple of the source's object bytes (the design's copy-plus-objects factor, 4.5). */
export const SPACE_FACTOR = 2.2;

export class MirrorError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'MirrorError'; this.code = code; this.detail = detail; }
}

const key = (path, platform = process.platform) => realKey(path, (at) => realpathSync.native(at), platform);
// Windows names are case-insensitive: Build is the excluded build, Node_Modules is node_modules.
const fold = (name) => (process.platform === 'win32' ? name.toLowerCase() : name);
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

/** `<dirname(dataDir)>/mirrors/<projectId>`: next to worktrees/, under the already-ignored .local/ (design 5.1). */
export function mirrorRootFor(dataDir, projectId) {
  return join(dirname(resolve(dataDir)), 'mirrors', projectId);
}

/** The mirror ref that holds the owner's branch (design 5.2). */
export const sourceRef = (branch) => `refs/heads/source/${branch}`;
export const validBranch = (branch) => typeof branch === 'string' && BRANCH.test(branch);

/** One Git command. Inherited GIT_* variables could point Git at another repository, so they are dropped. */
function runGit(git, args, { gitEnv, timeoutMs = 600_000 } = {}) {
  const [command, ...prefix] = git;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const result = spawnSync(command, [...prefix, ...GIT_PREFIX, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...env, ...gitEnv, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error?.code === 'ENOENT') throw new MirrorError('GIT_CLI_MISSING', 'git was not found');
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function mustGit(git, args, options, what) {
  const result = runGit(git, args, options);
  if (!result.ok) throw new MirrorError('MIRROR_FAILED', `${what} failed: ${result.stderr.trim().slice(0, 500) || 'git exited with an error'}`);
  return result.stdout;
}

/** The mirror is never inside the source root, and the source root is never inside it (design 5.1). */
function assertApart(mirrorRoot, sourceRoot) {
  const mirror = key(mirrorRoot);
  const source = key(sourceRoot);
  if (inside(mirror, source) || inside(source, mirror)) {
    throw new MirrorError('MIRROR_OVERLAP', 'the managed mirror and the project folder must not contain each other');
  }
}

/**
 * Is there room for the mirror? The need is the source's object bytes (`git count-objects -v`, which reads) times
 * SPACE_FACTOR; the free space is read with statfs at `mirrorParent`. Returns { ok, need, free, drive }.
 */
export function mirrorSpace({ git = ['git'], sourceRoot, mirrorParent, statfs = (path) => statfsSync(path, { bigint: true }), gitEnv }) {
  const counted = mustGit(git, ['-C', sourceRoot, 'count-objects', '-v'], { gitEnv }, 'count source objects');
  const kib = (name) => Number(new RegExp(`^${name}: (\\d+)$`, 'm').exec(counted)?.[1] ?? 0);
  const need = Math.ceil((kib('size') + kib('size-pack')) * 1024 * SPACE_FACTOR);
  const space = statfs(mirrorParent);
  const free = Number(BigInt(space.bavail) * BigInt(space.bsize));
  return { ok: free >= need, need, free, drive: parse(resolve(mirrorParent)).root };
}

/** The commit the mirror holds for `branch`, or null when it holds none. Reads the mirror only. */
export function mirrorHead({ git = ['git'], mirrorRoot, branch, gitEnv }) {
  const repo = join(mirrorRoot, MIRROR_REPO);
  if (!existsSync(repo)) return null;
  const read = runGit(git, ['-C', repo, 'rev-parse', '--verify', '-q', `${sourceRef(branch)}^{commit}`], { gitEnv });
  const sha = read.stdout.trim();
  return read.ok && SHA.test(sha) ? sha : null;
}

/**
 * Create the mirror when it is missing (`git init --bare` with no template, so it has no hooks), then copy the owner's
 * branch into it: `git fetch --no-tags <source path> +refs/heads/<branch>:refs/heads/source/<branch>`. The fetch reads
 * the owner's repository and writes only into the mirror; uncommitted changes are never part of it. Running it again is
 * Refresh: the forced refspec also replaces a mirror ref that was changed by hand. Returns { repoPath, head }.
 */
export function syncGitMirror({ git = ['git'], mirrorRoot, sourceRoot, branch, gitEnv }) {
  if (!validBranch(branch)) throw new MirrorError('MIRROR_FAILED', 'the branch name is not one AIWorks can mirror');
  assertApart(mirrorRoot, sourceRoot);
  const repo = join(mirrorRoot, MIRROR_REPO);
  if (!existsSync(repo)) {
    mkdirSync(mirrorRoot, { recursive: true });
    mustGit(git, ['init', '-q', '--bare', '--template=', repo], { gitEnv }, 'create the mirror');
    // The mirror's own configuration only: long paths on Windows (design 4.3).
    if (process.platform === 'win32') mustGit(git, ['-C', repo, 'config', 'core.longpaths', 'true'], { gitEnv }, 'configure the mirror');
  } else if (mustGit(git, ['-C', repo, 'rev-parse', '--is-bare-repository'], { gitEnv }, 'read the mirror').trim() !== 'true') {
    throw new MirrorError('MIRROR_FAILED', 'the managed mirror is not a bare repository');
  }
  const source = resolve(sourceRoot).replaceAll('\\', '/');
  mustGit(git, ['-C', repo, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--', source,
    `+refs/heads/${branch}:${sourceRef(branch)}`], { gitEnv }, 'copy the branch into the mirror');
  const head = mirrorHead({ git, mirrorRoot, branch, gitEnv });
  if (!head) throw new MirrorError('MIRROR_FAILED', 'the mirror holds no commit for the branch after the copy');
  return { repoPath: repo, head };
}

/** File and byte counts of a mirror commit's tree. For local Git the manifest is the commit's tree (design 5.3). */
export function treeCounts({ git = ['git'], mirrorRoot, sha, gitEnv }) {
  if (!SHA.test(sha)) throw new MirrorError('MIRROR_FAILED', 'a baseline needs a full commit SHA');
  const listed = mustGit(git, ['-C', join(mirrorRoot, MIRROR_REPO), 'ls-tree', '-r', '-l', '-z', sha], { gitEnv }, 'read the baseline tree');
  let files = 0;
  let bytes = 0;
  for (const entry of listed.split('\0').filter(Boolean)) {
    const [, type, , size] = entry.slice(0, entry.indexOf('\t')).split(/\s+/);
    if (type !== 'blob') continue;
    files += 1;
    bytes += Number(size) || 0;
  }
  return { files, bytes };
}

// Plain folders (slice S5, design 4.3 to 4.5 and 5.2). The copy is `<mirror_root>/snapshot/`, a normal Git repository
// AIWorks owns; its work tree is AIWorks's copy, never the source. Import reads the owner's folder (directory listings,
// lstat and file content) and writes only the copy: no Git command runs in the source or is given it as a work tree,
// and the folder's `.gitignore` files are matched inside the copy (`git check-ignore --no-index`). Commits use plumbing
// (`write-tree`, `commit-tree`), so no hook can run, and the repository is created with no template, so it has no hooks.
// The copy's HEAD names a branch that is never created, so `git branch -f` can move aiworks/baseline to each commit.
export const SNAPSHOT_DIR = 'snapshot';
export const BASELINE_BRANCH = 'aiworks/baseline';
const BASELINE_REF = `refs/heads/${BASELINE_BRANCH}`;
const IMPORT_HEAD = 'refs/heads/aiworks/import';
const MANIFESTS_DIR = 'manifests';
// The copy's own attributes win over any .gitattributes in the folder: content is stored byte for byte (design 5.2).
const SNAPSHOT_ATTRIBUTES = '* -text -eol -filter -ident\n';
const SECRET_LIKE_PATH = new RegExp(SECRET_LIKE_PATH_PATTERN, 'u');
const EXAMPLES = 10;
const BINARY_PROBE = 8 * 1024;
// Ignore rules come from the folder's own .gitignore files only, never the host's global excludes file.
const SNAPSHOT_GIT = Object.freeze(['-c', 'core.excludesFile=', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
  '-c', 'user.name=AIWorks', '-c', 'user.email=aiworks@localhost']);

const sample = () => ({ count: 0, examples: [] });
const note = (bucket, path) => { bucket.count += 1; if (bucket.examples.length < EXAMPLES) bucket.examples.push(path); };
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const isBinary = (buffer) => buffer.subarray(0, BINARY_PROBE).includes(0);
const exists = (path) => { try { lstatSync(path); return true; } catch { return false; } };

/**
 * The files of a plain folder that may be copied, by the rules of design 4.3 and 4.4 (the .gitignore rule is applied in
 * the copy, by syncFolderSnapshot). It uses lstat only, so links and junctions are never followed. Secret-like paths,
 * links, nested repositories, node_modules (unless includeNodeModules) and the owner's exclusions are left out and
 * counted. Preflight has already applied the limits and the case check. Returns { files: [relativePath], excluded,
 * identities }: `identities` maps each file to the device and file id it had when listed, so the copy reads that file only.
 */
export function folderFiles(sourceRoot, { exclusions = [], includeNodeModules = false } = {}) {
  const owner = exclusions.map((path) => fold(String(path).replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''))).filter(Boolean);
  const excluded = { secrets: sample(), links: sample(), repos: sample(), modules: sample(), owner: sample(), other: sample() };
  const files = [], identities = new Map();
  const pending = [''];
  while (pending.length) {
    const rel = pending.pop();
    for (const name of readdirSync(rel === '' ? sourceRoot : join(sourceRoot, rel))) {
      const child = rel === '' ? name : `${rel}/${name}`;
      if (owner.some((path) => inside(fold(child), path))) { note(excluded.owner, child); continue; }
      if (SECRET_LIKE_PATH.test(child)) { note(excluded.secrets, child); continue; }
      let stat;
      try { stat = lstatSync(join(sourceRoot, child), { bigint: true }); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw new MirrorError('UNREADABLE_FILES', `AIWorks can't read ${child}`, { count: 1, examples: [child] });
      }
      // On Windows Node reports a junction as a symbolic link, so this covers both.
      if (stat.isSymbolicLink()) { note(excluded.links, child); continue; }
      if (stat.isDirectory()) {
        if (fold(name) === 'node_modules' && !includeNodeModules) { note(excluded.modules, child); continue; }
        if (exists(join(sourceRoot, child, '.git'))) { note(excluded.repos, child); continue; }
        pending.push(child);
      } else if (stat.isFile()) { files.push(child); identities.set(child, `${stat.dev}:${stat.ino}`); }
      else note(excluded.other, child);
    }
  }
  return { files: files.sort(), excluded, identities };
}

/**
 * The bytes of a listed file, read through one handle that is checked to be the file listed: null when it is gone or is
 * another file now, as when a folder on its path was replaced by a link or junction after the listing.
 */
function readListed(path, identity) {
  let fd;
  try { fd = openSync(path, 'r'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== identity) return null;
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** The copy's repository, created when missing, with its own attributes and settings rewritten on every import. */
function ensureSnapshot(git, mirrorRoot, gitEnv) {
  const snapshot = join(mirrorRoot, SNAPSHOT_DIR);
  if (!existsSync(join(snapshot, '.git'))) {
    mkdirSync(snapshot, { recursive: true });
    mustGit(git, ['init', '-q', '--template=', snapshot], { gitEnv }, 'create the copy');
  } else if (mustGit(git, ['-C', snapshot, 'rev-parse', '--is-bare-repository'], { gitEnv }, 'read the copy').trim() !== 'false') {
    throw new MirrorError('MIRROR_FAILED', 'the managed copy is not a normal repository');
  }
  mustGit(git, ['-C', snapshot, 'symbolic-ref', 'HEAD', IMPORT_HEAD], { gitEnv }, 'point the copy HEAD away from aiworks/baseline');
  mkdirSync(join(snapshot, '.git', 'info'), { recursive: true });
  writeFileSync(join(snapshot, '.git', 'info', 'attributes'), SNAPSHOT_ATTRIBUTES);
  mustGit(git, ['-C', snapshot, 'config', 'core.autocrlf', 'false'], { gitEnv }, 'configure the copy');
  // The copy's own configuration only: long paths on Windows (design 4.3).
  if (process.platform === 'win32') mustGit(git, ['-C', snapshot, 'config', 'core.longpaths', 'true'], { gitEnv }, 'configure the copy');
  return snapshot;
}

/** Remove copies whose relative path is not in `keep`, then directories left empty. Only the copy is touched. */
function prune(snapshot, keep) {
  const walk = (rel) => {
    const dir = rel === '' ? snapshot : join(snapshot, rel);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (child === '.git') continue;
      if (!entry.isDirectory()) {
        if (!keep.has(child)) rmSync(join(snapshot, child), { force: true });
        continue;
      }
      walk(child);
      if (!readdirSync(join(snapshot, child)).length) rmdirSync(join(snapshot, child));
    }
  };
  walk('');
}

/** The paths the folder's .gitignore files ignore, matched in the copy, never in the source. */
function ignoredPaths(git, snapshot, paths, gitEnv) {
  if (!paths.length) return new Set();
  const [command, ...prefix] = git;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const result = spawnSync(command, [...prefix, ...GIT_PREFIX, ...SNAPSHOT_GIT, '-C', snapshot, 'check-ignore', '--no-index', '--stdin', '-z'], {
    input: `${paths.join('\0')}\0`, encoding: 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...env, ...gitEnv, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error?.code === 'ENOENT') throw new MirrorError('GIT_CLI_MISSING', 'git was not found');
  // check-ignore exits 1 when it ignores nothing.
  if (result.error || ![0, 1].includes(result.status)) {
    throw new MirrorError('MIRROR_FAILED', `matching .gitignore failed: ${(result.stderr ?? '').trim().slice(0, 500) || 'git exited with an error'}`);
  }
  return new Set((result.stdout ?? '').split('\0').filter(Boolean));
}

/**
 * One pass of the copy (design 4.5): hash each source file, copy it, then hash the copy. Returns the manifest rows, or
 * null when a copy differs from the hash taken before it or the file is gone: it changed during the copy.
 */
function copyPass(sourceRoot, snapshot, files, identities, hooks) {
  const rows = [];
  for (const rel of files) {
    const source = join(sourceRoot, rel);
    const target = join(snapshot, rel);
    let content;
    try {
      content = readListed(source, identities.get(rel));
      if (content === null) return null;
      hooks.afterHash?.(rel);
      // The bytes already read and hashed, never the path read again: it may lead somewhere else by now.
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new MirrorError('UNREADABLE_FILES', `AIWorks can't read ${rel}`, { count: 1, examples: [rel] });
    }
    const hash = sha256(content);
    if (sha256(readFileSync(target)) !== hash) return null;
    rows.push([rel, content.length, hash, isBinary(content)]);
  }
  return rows;
}

/** The SHA-256 of the canonical JSON of the sorted [relativePath, size, sha256, binary] list (design 5.3). */
export function manifestDigest(rows) {
  return sha256(JSON.stringify([...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** The commit on aiworks/baseline, or null when the copy holds none. Reads the copy only. */
export function folderHead({ git = ['git'], mirrorRoot, gitEnv }) {
  const snapshot = join(mirrorRoot, SNAPSHOT_DIR);
  if (!existsSync(join(snapshot, '.git'))) return null;
  const read = runGit(git, ['-C', snapshot, 'rev-parse', '--verify', '-q', `${BASELINE_REF}^{commit}`], { gitEnv });
  const sha = read.stdout.trim();
  return read.ok && SHA.test(sha) ? sha : null;
}

/** The manifest saved with a baseline commit, when it still matches the recorded digest; otherwise null. */
export function folderManifest({ mirrorRoot, commit, digest }) {
  if (!SHA.test(commit ?? '')) return null;
  try {
    const rows = JSON.parse(readFileSync(join(mirrorRoot, MANIFESTS_DIR, `${commit}.json`), 'utf8'));
    return Array.isArray(rows) && manifestDigest(rows) === digest ? rows : null;
  } catch { return null; }
}

/**
 * Import the folder at `sourceRoot` into the copy and commit it on aiworks/baseline (design 5.2): list the files that
 * may be copied; copy the folder's .gitignore files first and drop what they ignore; copy the rest with hash and
 * re-hash; remove copies of files that are gone; then stage from an empty index, `write-tree` and `commit-tree`.
 * `parent` is the recorded baseline commit (Refresh), or null for a new root commit (connect, and Rebuild copy). A tree
 * equal to the parent's takes no commit. A file that changes during the copy gives one retry, then CHANGED_DURING_COPY,
 * and aiworks/baseline stays where it was. `hooks.afterHash(relativePath)` lets a test change a file mid-copy.
 * Returns { snapshotPath, head, committed, manifestDigest, files, bytes, excluded }.
 */
export function syncFolderSnapshot({ git = ['git'], mirrorRoot, sourceRoot, parent = null, exclusions = [], includeNodeModules = false, hooks = {}, gitEnv }) {
  if (parent !== null && !SHA.test(parent)) throw new MirrorError('MIRROR_FAILED', 'a baseline parent needs a full commit SHA');
  assertApart(mirrorRoot, sourceRoot);
  const snapshot = ensureSnapshot(git, mirrorRoot, gitEnv);
  let rows = null;
  let excluded;
  for (let attempt = 0; attempt < 2 && !rows; attempt += 1) {
    const listed = folderFiles(sourceRoot, { exclusions, includeNodeModules });
    const ignoreFiles = listed.files.filter((rel) => rel === '.gitignore' || rel.endsWith('/.gitignore'));
    prune(snapshot, new Set(ignoreFiles));
    const rules = ignoreFiles.map((rel) => [rel, readListed(join(sourceRoot, rel), listed.identities.get(rel))]);
    if (rules.some(([, content]) => content === null)) continue;
    for (const [rel, content] of rules) {
      mkdirSync(dirname(join(snapshot, rel)), { recursive: true });
      writeFileSync(join(snapshot, rel), content);
    }
    const ignored = ignoredPaths(git, snapshot, listed.files, gitEnv);
    excluded = { ...listed.excluded, ignored: sample() };
    for (const rel of ignored) note(excluded.ignored, rel);
    const included = listed.files.filter((rel) => !ignored.has(rel));
    prune(snapshot, new Set(included));
    rows = copyPass(sourceRoot, snapshot, included, listed.identities, hooks);
  }
  if (!rows) throw new MirrorError('CHANGED_DURING_COPY', 'files changed while AIWorks was copying them');

  const repo = ['-C', snapshot];
  mustGit(git, [...repo, 'read-tree', '--empty'], { gitEnv }, 'start an empty index');
  mustGit(git, [...repo, ...SNAPSHOT_GIT, 'add', '-A', '--', '.'], { gitEnv }, 'stage the copy');
  const tree = mustGit(git, [...repo, 'write-tree'], { gitEnv }, 'write the copy tree').trim();
  const counts = { manifestDigest: manifestDigest(rows), files: rows.length, bytes: rows.reduce((sum, row) => sum + row[1], 0), excluded };
  if (parent !== null && mustGit(git, [...repo, 'rev-parse', `${parent}^{tree}`], { gitEnv }, 'read the baseline tree').trim() === tree) {
    return { snapshotPath: snapshot, head: parent, committed: false, ...counts };
  }
  const head = mustGit(git, [...repo, ...SNAPSHOT_GIT, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'AIWorks baseline'],
    { gitEnv }, 'commit the copy').trim();
  mkdirSync(join(mirrorRoot, MANIFESTS_DIR), { recursive: true });
  writeFileSync(join(mirrorRoot, MANIFESTS_DIR, `${head}.json`), JSON.stringify(rows));
  mustGit(git, [...repo, 'branch', '-f', BASELINE_BRANCH, head], { gitEnv }, 'move aiworks/baseline');
  return { snapshotPath: snapshot, head, committed: true, ...counts };
}
