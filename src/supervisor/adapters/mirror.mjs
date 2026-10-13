// AIWorks's managed mirror of a project without GitHub (aiworks#7, docs/design/PROJECT_CONNECTION.md section 5, slice S4:
// the local-Git part). The mirror is a bare repository AIWorks owns, outside the owner's folder. Every write lands in the
// mirror: the owner's repository is only read, by `git fetch` from its path (the fetch runs upload-pack there, which
// reads) and by `count-objects` for the space check. Nothing here writes Git configuration in the owner's repository,
// adds a worktree record, branch or remote there, or contacts any remote: the source is fetched by its path, never by a
// remote name. Workers never get the mirror's path; task worktrees come from it through adapters/git.mjs with a baseSha.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statfsSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

export const MIRROR_REPO = 'repo.git';
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])(?<!\.lock)$/;
// Per-command settings: no fsmonitor, no automatic gc or maintenance, no hooks. They write no configuration anywhere.
const GIT_PREFIX = Object.freeze(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']);
/** Free space the mirror needs, as a multiple of the source's object bytes (the design's copy-plus-objects factor, 4.5). */
export const SPACE_FACTOR = 2.2;

export class MirrorError extends Error {
  constructor(code, message) { super(message); this.name = 'MirrorError'; this.code = code; }
}

const key = (path, platform = process.platform) => {
  let real;
  try { real = realpathSync.native(path); } catch { real = resolve(path); }
  const slashed = real.replaceAll('\\', '/');
  return platform === 'win32' ? slashed.toLowerCase() : slashed;
};
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
