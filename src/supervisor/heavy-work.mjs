// Heavy work (config.json `heavyWork`), after the host crash of 2026-10-31: up to ten workers ran at once on one PC, each
// bringing up its own Docker stack (database, mail) and test fan-out, with merge-refresh gates running outside the worker
// count; the gate-slot rule in worker prompts was skipped in most runs. TCP ports ran out and the PC crashed. This module
// is the part AIWorks enforces itself, whatever a worker does:
//
// - One limit for everything heavy: open worker operations of a heavy repository and its running merge-refresh gates
//   share `slots` (scheduler admission waits with 'heavy-capacity', a refresh waits before its gate starts).
// - Stack cleanup: Docker Compose stacks whose working directory lies inside a heavy repository's worktree root and that
//   no open operation or running refresh still uses are taken down with their volumes. The supervisor finds them by the
//   labels Docker Compose itself sets and runs only the configured docker command: never a script from a worktree, which
//   a worker could have changed.
//
// `heavyWork`: { "slots": 2, "repositories": ["owner/repo"] }. Absent or listing no repository: off, as before.
import { execFile } from 'node:child_process';
import { resolve, sep } from 'node:path';

const DEFAULT_SLOTS = 2;
const REFRESH_KINDS = ['merge-refresh-passed', 'merge-refresh-failed'];

/** `heavyWork` from config.json: { slots, repositories: Set (lower case) }, or null when off. */
export function heavySettings(config) {
  const value = config?.heavyWork;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const list = Array.isArray(value.repositories) ? value.repositories.filter((name) => typeof name === 'string' && name.trim()) : [];
  if (!list.length) return null;
  const slots = Number.isSafeInteger(value.slots) && value.slots >= 1 && value.slots <= 8 ? value.slots : DEFAULT_SLOTS;
  return { slots, repositories: new Set(list.map((name) => name.trim().toLowerCase())) };
}

export const isHeavy = (settings, decl) => Boolean(settings && typeof decl?.target?.repository === 'string'
  && settings.repositories.has(decl.target.repository.toLowerCase()));

/**
 * Refresh gates of heavy repositories that started within `windowMs` and have no pass or failure yet: { campaignId, path }.
 * A gate past its bound fails at its next merge pass (merge-refresh.mjs), so the window only bounds the read.
 */
export function runningRefreshes(store, settings, { now, windowMs }) {
  if (!settings) return [];
  const started = store.all(`SELECT j.seq, j.campaign_id, j.detail, c.declaration FROM journal j JOIN campaigns c ON c.id = j.campaign_id
    WHERE j.kind = 'merge-refresh-started' AND j.at >= ?`, now - windowMs);
  return started.filter((row) => isHeavy(settings, row.declaration) && !store.get(`SELECT 1 AS done FROM journal WHERE campaign_id = ?
    AND kind IN (${REFRESH_KINDS.map(() => '?').join(', ')}) AND seq > ? AND json_extract(detail, '$.task') = ?
    AND json_extract(detail, '$.sha') = ? AND json_extract(detail, '$.base') = ?`,
  row.campaign_id, ...REFRESH_KINDS, row.seq, row.detail?.task, row.detail?.sha, row.detail?.base))
    .map((row) => ({ campaignId: row.campaign_id, path: row.detail?.path ?? null }));
}

/** Open worker operations of heavy repositories: { campaignId, workspace }. */
export function openHeavyOperations(store, settings) {
  if (!settings) return [];
  return store.all(`SELECT o.campaign_id, o.workspace, c.declaration FROM operations o JOIN campaigns c ON c.id = o.campaign_id
    WHERE o.state IN ('recorded', 'dispatched')`)
    .filter((row) => isHeavy(settings, row.declaration)).map((row) => ({ campaignId: row.campaign_id, workspace: row.workspace }));
}

/** Heavy slots in use: open heavy worker operations plus running heavy refresh gates. */
export function heavyInUse(store, settings, { now, windowMs }) {
  return openHeavyOperations(store, settings).length + runningRefreshes(store, settings, { now, windowMs }).length;
}

// ---- Stack cleanup ----

const fold = (path) => {
  const full = resolve(path);
  return process.platform === 'win32' ? full.toLowerCase() : full;
};
/** Whether `path` is `root` or lies inside it. */
export const inside = (root, path) => {
  const a = fold(root), b = fold(path);
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
};

const run = (command, args, timeoutMs) => new Promise((done) => {
  const [cmd, ...prefix] = command;
  execFile(cmd, [...prefix, ...args], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout) => done({ ok: !error, stdout: stdout ?? '', error: error ? (error.killed ? 'timed out' : error.code ?? error.message) : null }));
});

/**
 * Compose projects that may go: their working directory lies inside one of `roots` and inside none of `keep`.
 * `listing` is `docker ps -a` output in the format "<project>\t<working dir>" per container.
 */
export function strayProjects(listing, { roots, keep }) {
  const projects = new Map();
  for (const line of listing.split(/\r?\n/)) {
    const [project, dir] = line.split('\t').map((part) => part?.trim());
    if (!project || !/^[a-z0-9][a-z0-9_-]*$/.test(project)) continue;
    // A project with any container outside the roots (a fixed project name shared with another checkout), in a kept
    // directory or without a working directory stays whole: `down` acts on the project name, not on one directory.
    if (!dir || !roots.some((root) => inside(root, dir)) || keep.some((path) => inside(path, dir))) { projects.set(project, null); continue; }
    if (!projects.has(project)) projects.set(project, dir);
  }
  return [...projects].filter(([, dir]) => dir !== null).map(([project, dir]) => ({ project, dir }));
}

/**
 * One cleanup pass: list compose containers, read what is still in use (`keep()`, after the listing, so a run recorded
 * meanwhile is kept), and take every stray project down with its volumes. At most one pass at a time; every docker call
 * is bounded, and a docker that does not answer ends the pass. Resolves to the projects taken down.
 */
export function createStackSweeper({ docker = ['docker'], roots, keep, log = () => {}, exec = run, timeoutMs = 120_000 }) {
  let running = null;
  const pass = async () => {
    const listed = await exec(docker, ['ps', '-a', '--filter', 'label=com.docker.compose.project', '--format',
      '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}'], timeoutMs);
    if (!listed.ok) { log(`stack cleanup skipped: docker ps ${listed.error}`); return []; }
    const stray = strayProjects(listed.stdout, { roots: roots(), keep: keep() });
    const removed = [];
    for (const { project, dir } of stray) {
      const down = await exec(docker, ['compose', '-p', project, 'down', '-v', '--remove-orphans'], timeoutMs);
      log(down.ok ? `stack cleanup: removed compose project ${project} (${dir})` : `stack cleanup: ${project} not removed: ${down.error}`);
      if (down.ok) removed.push(project);
      else break;
    }
    return removed;
  };
  return {
    sweep() {
      if (!running) running = pass().catch((error) => { log(`stack cleanup failed: ${error.message}`); return []; }).finally(() => { running = null; });
      return running;
    },
  };
}

// ---- Worker job limits ----

const GiB = 1024 ** 3;
/**
 * The caps on one worker's Windows job (windows-process.ps1): committed memory of the whole worker tree and live process
 * count. `workerJob` in config.json: { "memoryBytes": n, "processes": n }, 0 switches a cap off. Defaults: a quarter of
 * the computer's memory (at least 4 GiB) and 512 processes. A worker that reaches a cap fails its own allocation or
 * process start; the computer keeps running. Returns the spec.json fields to set.
 */
export function workerJobLimits(config, totalMemory) {
  const set = config?.workerJob ?? {};
  const pick = (value, fallback) => (value === 0 ? 0 : Number.isSafeInteger(value) && value > 0 ? value : fallback);
  const memory = pick(set.memoryBytes, Math.max(4 * GiB, Math.floor(totalMemory / 4)));
  const processes = pick(set.processes, 512);
  return { ...(memory ? { jobMemoryBytes: memory } : {}), ...(processes ? { activeProcesses: processes } : {}) };
}
