// AIWorks workspace and publication adapter. Every function is idempotent: it inspects
// existing state before creating anything, so a controller restarted at any point can call
// it again. Removal is only the non-forced worktree remove and branch -d below; which ones may go is cleanup.mjs's rule.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_FILES } from '../gate.mjs';
import { DEVELOPMENT_ENV } from '../development-policy.mjs';
import { githubRemote } from '../project-preflight.mjs';
import { environmentExamplePath, safeEnvironmentExample } from '../environment-example.mjs';
import { POWERSHELL, readJsonIfExists, runnerIdentified, stopOwnedRunAsync } from '../proc.mjs';

const SHA = /^[0-9a-f]{40}$/;
// The supervisor's own git reads and checkouts see the real objects of a commit, never local replace refs: the
// worktree a worker gets and the digests of the test result cache (test-cache.mjs) both come from them. Workers' own
// environment (proc.mjs workerEnv) is not changed.
const SUPERVISOR_GIT_ENV = Object.freeze({ GIT_NO_REPLACE_OBJECTS: '1' });

export function exec(command, args, { cwd, input, timeoutMs = 180_000, env = {} } = {}) {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd, input, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env, ...DEVELOPMENT_ENV, ...SUPERVISOR_GIT_ENV },
  });
  return { ok: !result.error && result.status === 0, status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim(), error: result.error?.code };
}

/**
 * A slow Git read that must not stall the controller (aiworks#140): unlike exec it never blocks the event loop, so the
 * lease timer and the release job keep running while it waits. On the deadline its whole process tree is stopped before
 * it settles, so no helper it started (a fetch's remote helper, say) outlives the read and writes refs afterwards: on
 * Windows `taskkill /T /F` runs while the child is still alive to name its descendants, and the read waits for it; on
 * other systems the child leads its own process group, which is killed as one. The result is then the failure ETIMEDOUT,
 * with `contained: false` only when that tree stop could not be shown to finish within `killMs`. It never throws. Only
 * for reads: publication and other effects stay synchronous inside the controller's fence.
 */
export function execBounded(command, args, { cwd, timeoutMs = 30_000, killMs = 10_000, maxBytes = 16 * 1024 * 1024, onSpawn = null } = {}) {
  return new Promise((resolve) => {
    let settled = false, stopping = false, timer = null, child = null, stdout = '', stderr = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const failed = (error, contained = true) => ({ ok: false, status: null, stdout: '', stderr: '', error, ...(contained ? {} : { contained: false }) });
    // Stops the child's whole tree, then settles. The child is killed only after the tree stop has finished, so its
    // process identity stays valid while its descendants are found.
    const stop = (error) => {
      if (stopping || settled) return;
      stopping = true;
      clearTimeout(timer);
      treeKill(child, killMs).then((contained) => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish(failed(error, contained));
      });
    };
    try {
      child = spawn(command[0], [...command.slice(1), ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', env: { ...process.env, ...DEVELOPMENT_ENV, ...SUPERVISOR_GIT_ENV } });
    } catch (error) { finish(failed(error?.code ?? 'ESPAWN')); return; }
    if (child.pid) { try { onSpawn?.(child.pid); } catch { /* the caller's record of the start is its own */ } }
    timer = setTimeout(() => stop('ETIMEDOUT'), timeoutMs);
    const collect = (append) => (chunk) => {
      if (stopping) return;
      if (stdout.length + stderr.length + chunk.length > maxBytes) { stop('ENOBUFS'); return; }
      append(chunk);
    };
    child.stdout.setEncoding('utf8').on('data', collect((chunk) => { stdout += chunk; }));
    child.stderr.setEncoding('utf8').on('data', collect((chunk) => { stderr += chunk; }));
    child.on('error', (error) => { if (!stopping) finish(failed(error?.code ?? 'ESPAWN')); });
    child.on('close', (status) => { if (!stopping) finish({ ok: status === 0, status, stdout: stdout.trim(), stderr: stderr.trim(), error: undefined }); });
  });
}

/**
 * Stops `child` with every process it started, and resolves true once that is shown done, false when it was not within
 * `killMs`. Only this child's own tree is targeted: its pid on Windows, its own process group elsewhere. Exported for
 * its test only.
 */
export function treeKill(child, killMs) {
  return new Promise((done) => {
    if (!child?.pid) { done(true); return; }
    if (process.platform !== 'win32') {
      // The group outlives its leader, so it is found whether or not the child already exited, and shown gone.
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') { done(false); return; } }
      groupGone(child.pid, killMs).then(done);
      return;
    }
    // The child already exited: on Windows its orphans can no longer be found by its pid.
    if (child.exitCode !== null || child.signalCode !== null) { done(false); return; }
    let ended = false;
    const end = (value) => { if (!ended) { ended = true; clearTimeout(bound); done(value); } };
    const bound = setTimeout(() => { try { killer.kill(); } catch { /* gone */ } end(false); }, killMs);
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => end(false));
    // Only exit 0 shows the tree terminated. 128 says the child was already gone when taskkill looked for it: its helpers
    // could then no longer be found by its pid, so it shows nothing about them (as for the child that exited above).
    killer.on('exit', (code) => end(code === 0));
  });
}

/** Whether no process of the group `group` is left within `ms` (POSIX). */
async function groupGone(group, ms) {
  for (const deadline = Date.now() + ms; ;) {
    try { process.kill(-group, 0); } catch (error) { return error?.code === 'ESRCH'; }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const RUNNER = fileURLToPath(new URL('../runner.mjs', import.meta.url));
// Runs as the job's command: the command itself with no output at all, so nothing it or a helper prints reaches the
// runner's files, which have no size limit. Its exit status is the command's.
const QUIET = "const r=require('node:child_process').spawnSync(process.argv[1],process.argv.slice(2),{stdio:'ignore',windowsHide:true});process.exit(r.status===null?1:r.status)";

/** Whether `child` exits within `ms`. */
const exits = (child, ms) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve(true)
  : new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', done); resolve(false); }, ms);
    const done = () => { clearTimeout(timer); resolve(true); };
    child.once('exit', done);
  });

const removeRun = (runDir) => { try { rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* a later settle removes it */ } };

/**
 * A slow read that writes shared refs (the base fetch, aiworks#140), run where the end of every process it starts can be
 * shown. Each run gets its own folder under `runRoot`, which stays as its receipt until that end is shown.
 *
 * On Windows the command runs under runner.mjs, in a kill-on-close Windows job that holds every process it starts: the
 * job waits `timeoutMs` for it, then stops the whole job and shows it empty before the runner writes its result. That
 * result, with containmentStopped, is the only proof taken. The runner's own start and drain get `overheadMs` beside the
 * command's deadline; past that, the job is stopped by the runner's recorded identity, asynchronously. Elsewhere the
 * command leads its own process group, which is killed and shown gone (execBounded).
 *
 * Resolves { ok, status, error } without output: the command's exit status is all that is read. When the end of what it
 * started was not shown, the result is a failure with `contained: false` and its folder stays: settleContained shows that
 * end later, and the caller reads nothing more there until it does. Never throws.
 */
export async function execContained(command, args, { cwd, runRoot, timeoutMs = 30_000, overheadMs = 120_000, killMs = 10_000, active = new Set() } = {}) {
  const failed = (error, contained = true) => ({ ok: false, status: null, stdout: '', stderr: '', error, ...(contained ? {} : { contained: false }) });
  let runDir;
  try { mkdirSync(runRoot, { recursive: true }); runDir = mkdtempSync(join(runRoot, 'read-')); } catch { return failed('ESPAWN'); }
  active.add(runDir);
  try {
    // Elsewhere the group's id is recorded as soon as it exists, so a controller that dies mid-read still leaves its receipt.
    const result = POWERSHELL ? await underJob(command, args, { cwd, runDir, timeoutMs, overheadMs, killMs, failed })
      : await execBounded(command, args, { cwd, timeoutMs, killMs, maxBytes: 1024 * 1024,
        onSpawn: (pid) => writeFileSync(join(runDir, 'receipt.json'), JSON.stringify({ group: pid })) });
    if (result.contained !== false) removeRun(runDir);
    return { ...result, stdout: '', stderr: '' };
  } finally { active.delete(runDir); }
}

async function underJob(command, args, { cwd, runDir, timeoutMs, overheadMs, killMs, failed }) {
  let runner = null;
  try {
    writeFileSync(join(runDir, 'prompt.txt'), '');
    writeFileSync(join(runDir, 'spec.json'), JSON.stringify({ cwd, timeoutMs, heartbeatMs: 1000,
      argv: [process.execPath, '-e', QUIET, command[0], ...command.slice(1), ...args] }));
    runner = spawn(process.execPath, [RUNNER, runDir], { cwd: runDir, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...DEVELOPMENT_ENV } });
  } catch { return failed('ESPAWN', runner === null); }
  runner.on('error', () => { /* shown by its exit, or by its missing result */ });
  // A spawn that failed outright never got a process id: that is the one start shown not to have happened.
  if (runner.pid === undefined) return failed('ESPAWN');
  if (await exits(runner, timeoutMs + overheadMs)) {
    const proof = jobResult(runDir);
    if (!proof) return failed('ECONTAINMENT', false);
    if (proof.spawnError) return failed('ESPAWN');
    if (proof.timedOut) return failed('ETIMEDOUT');
    return { ok: proof.exitCode === 0, status: proof.exitCode, error: undefined };
  }
  // The runner itself is past its bound: stop its job by the identity it recorded, which also ends the runner.
  const stopped = await stopRun(runDir);
  if (!stopped) { try { runner.kill(); } catch { /* gone */ } } // closing its job handle kills the job, but that is not shown
  await exits(runner, killMs);
  return failed('ETIMEDOUT', stopped);
}

/** The runner's result when it shows its job stopped empty, else null. */
function jobResult(runDir) {
  const result = readJsonIfExists(join(runDir, 'result.json'));
  return result?.containment === 'windows-job-v1' && result.containmentStopped === true ? result : null;
}

/** Stops a run's job by the runner identity it recorded; true when the job is shown stopped or no longer running. */
async function stopRun(runDir) {
  const identity = readJsonIfExists(join(runDir, 'runner.json'));
  if (!runnerIdentified(identity)) return false;
  return ['stopped', 'not-running'].includes(await stopOwnedRunAsync(identity));
}

/**
 * Whether every process of the run at `runDir` (execContained) is shown ended now. Only proof counts: a run with no
 * runner identity, no result and no group is never taken as ended, however old it is or whether `run.lock` exists, since
 * a runner already spawned may still take its lock and start the command.
 */
async function runEnded(runDir) {
  const receipt = readJsonIfExists(join(runDir, 'receipt.json'));
  if (Number.isSafeInteger(receipt?.group) && receipt.group > 0) return groupGone(receipt.group, 0);
  if (jobResult(runDir)) return true;
  if (runnerIdentified(readJsonIfExists(join(runDir, 'runner.json')))) return stopRun(runDir);
  // A runner that records itself but never its job started no command: its result says so (`attached: false`).
  return readJsonIfExists(join(runDir, 'result.json'))?.attached === false;
}

/**
 * Shows the end of earlier execContained runs under `runRoot` that were not shown ended, removing each folder once it is,
 * and answers how many still are not. Runs in `active` (still running in this process) are left alone. Never throws.
 */
export async function settleContained(runRoot, active = new Set()) {
  let names;
  try { names = readdirSync(runRoot); } catch (error) { return error?.code === 'ENOENT' ? 0 : 1; }
  let open = 0;
  for (const name of names) {
    const runDir = join(runRoot, name);
    if (active.has(runDir)) continue;
    let ended = false;
    try { ended = await runEnded(runDir); } catch { ended = false; }
    if (ended) removeRun(runDir); else open += 1;
  }
  return open;
}

/**
 * The receipts under `runRoot` that settleContained left, as { since, identified }: when each was made, and whether a group or
 * runner identity was ever recorded for it (one that was not has no automatic proof: only a recorded identity or a result
 * can show its end). Read-only; the proof itself stays in runEnded. Never throws.
 */
export function heldContained(runRoot, active = new Set()) {
  try {
    return readdirSync(runRoot).map((name) => join(runRoot, name)).filter((dir) => !active.has(dir)).map((dir) => {
      const receipt = readJsonIfExists(join(dir, 'receipt.json'));
      const stat = statSync(dir);
      return { since: Math.round(stat.birthtimeMs || stat.mtimeMs),
        identified: Number.isSafeInteger(receipt?.group) && receipt.group > 0 || runnerIdentified(readJsonIfExists(join(dir, 'runner.json'))) };
    });
  } catch { return []; }
}

/** Where a checkout's unresolved base-read custody is recorded for the dashboard: beside its receipt folder, never inside it. */
export const heldMarkerPath = (runRoot) => join(dirname(runRoot), `${basename(runRoot)}.held.json`);

/** Records, or with `runs` empty removes, the marker of a checkout whose base read is refused as uncontained. The first time is kept. Never throws. */
function markHeld(runRoot, repoPath, base, runs) {
  const path = heldMarkerPath(runRoot);
  try {
    if (!runs.length) { rmSync(path, { force: true }); return; }
    const kept = readJsonIfExists(path);
    const since = Math.min(Number.isFinite(kept?.since) ? kept.since : Infinity, ...runs.map((run) => run.since));
    writeFileSync(path, JSON.stringify({ repo: resolve(repoPath), base, since, runs: runs.length, unidentified: runs.filter((run) => !run.identified).length, at: Date.now() }));
  } catch { /* the refusal itself stands; the marker only shows it */ }
}

/**
 * The checkouts whose base reads are refused as uncontained now, from the markers under `<dataDir>/base-reads*`: one is
 * listed only while its receipt folder still holds a receipt, so a marker left after the receipts settled shows nothing.
 * Resolves [{ repo, base, since, runs, unidentified }]; never throws.
 */
export function heldBaseReads(dataDir) {
  const held = [];
  for (const folder of ['base-reads', 'base-reads-dashboard']) {
    let names = [];
    try { names = readdirSync(join(dataDir, folder)).filter((name) => name.endsWith('.held.json')); } catch { continue; }
    for (const name of names) {
      const mark = readJsonIfExists(join(dataDir, folder, name));
      if (!mark || typeof mark.repo !== 'string' || !Number.isFinite(mark.since)) continue;
      const runs = heldContained(join(dataDir, folder, name.slice(0, -'.held.json'.length)));
      if (runs.length) held.push({ repo: mark.repo, base: String(mark.base ?? ''), since: mark.since, runs: runs.length, unidentified: runs.filter((run) => !run.identified).length });
    }
  }
  return held;
}

/** The folder of a checkout's base fetches and their receipts (execContained): installation data, one per checkout. */
export function baseReadRoot(dataDir, repoPath, name = 'base-reads') {
  const key = resolve(repoPath);
  const id = createHash('sha256').update(process.platform === 'win32' ? key.toLowerCase() : key).digest('hex').slice(0, 24);
  return join(dataDir ?? join(tmpdir(), 'aiworks-supervisor'), name, id);
}

/**
 * One bounded fetch of `base` into refs/aiworks/base/<base> and its read (aiworks#140, #143), shared by the supervisor's
 * base reads and the intake pin. A fetch whose processes were not all shown ended may still move this checkout's refs:
 * until they are (its receipt under `runRoot`), nothing more is fetched or read there. Resolves { ok, sha } or
 * { ok: false, sha: null, failure }, the failure being the stage that failed. `onFetched` runs once the fetch ended.
 */
export async function readBaseContained(git, repoPath, base, { runRoot, active, readMs, overheadMs, onFetched } = {}) {
  const ref = `refs/aiworks/base/${base}`;
  const failed = (failure) => ({ ok: false, sha: null, failure });
  if (await settleContained(runRoot, active) > 0) { markHeld(runRoot, repoPath, base, heldContained(runRoot, active)); return failed('uncontained'); }
  markHeld(runRoot, repoPath, base, []);
  // origin/<base> follows in the same fetch: a worktree branch started from the read base tracks it (dispatch).
  const fetched = await execContained(git, ['fetch', 'origin', `+refs/heads/${base}:${ref}`, `+refs/heads/${base}:refs/remotes/origin/${base}`],
    { cwd: repoPath, runRoot, timeoutMs: readMs, overheadMs, active });
  if (fetched.contained === false) { markHeld(runRoot, repoPath, base, heldContained(runRoot, active)); return failed('uncontained'); }
  // Whether it succeeded or not, the ref may have moved.
  onFetched?.();
  if (!fetched.ok) return failed(fetched.error === 'ETIMEDOUT' ? 'fetch-timeout' : 'fetch-failed');
  const read = await execBounded(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoPath, timeoutMs: readMs });
  if (read.error === 'ETIMEDOUT') return failed('read-timeout');
  return /^[0-9a-f]{40}$/.test(read.ok ? read.stdout : '') ? { ok: true, sha: read.stdout } : failed('unreadable');
}

function must(result, what) {
  if (!result.ok) throw new Error(`${what} failed: ${result.error || result.stderr || result.stdout || `exit ${result.status}`}`.slice(0, 1000));
  return result.stdout;
}

export const branchName = (campaignId, taskId) => `campaign/${campaignId}/${taskId}`;

// Legal IDs reach 64 characters each, and a worktree folder named after both leaves too little of the 260-character Windows
// path for Git and a worker's own tools. A longer pair keeps a readable prefix and a digest of the whole pair; '+' is no ID
// character, so the result is never another pair's full name. Shorter pairs keep their names.
const NAME_LIMIT = 64;
export function workspaceName(campaignId, taskId) {
  const full = `${campaignId}-${taskId}`;
  if (full.length <= NAME_LIMIT) return full;
  const digest = createHash('sha256').update(`${campaignId}/${taskId}`).digest('hex').slice(0, 16);
  return `${full.slice(0, NAME_LIMIT - digest.length - 1)}+${digest}`;
}

/** The folder for `suffix` of this task: one a supervisor already made under the full name is reused. */
function workspacePath(worktreeRoot, campaignId, taskId, suffix = '') {
  const legacy = join(worktreeRoot, `${campaignId}-${taskId}${suffix}`);
  return existsSync(legacy) ? legacy : join(worktreeRoot, `${workspaceName(campaignId, taskId)}${suffix}`);
}

const outsideRoot = (message) => Object.assign(new Error(message), { code: 'WORKTREE_ROOT' });
const folded = (path) => {
  const text = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? text.toLowerCase() : text;
};
/** The real path of the nearest existing ancestor of `path` with the missing rest appended; links and junctions resolved. */
function canonicalPath(path) {
  const missing = [];
  let current = resolve(path);
  for (;;) {
    try { return join(realpathSync.native(current), ...missing); } catch (error) {
      const parent = dirname(current);
      if (error?.code !== 'ENOENT' || parent === current) throw outsideRoot(`worktree path ${path} cannot be resolved`);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Throws (code WORKTREE_ROOT) unless `path` is a folder strictly inside the configured worktree root `root`, compared
 * after links and junctions are resolved, and no existing folder between the root and `path` (`path` included) is a link
 * or junction. Called before any managed worktree is created or reused, so nothing is written outside the root. The root
 * is the installation's own configuration (config.json `worktreeRoot`); no path is built in here. Creates nothing.
 */
export function assertManagedWorktree(root, path) {
  if (typeof root !== 'string' || !isAbsolute(root) || typeof path !== 'string' || !isAbsolute(path)) {
    throw outsideRoot('a managed worktree needs an absolute worktree root and destination');
  }
  const base = canonicalPath(root), target = canonicalPath(path);
  if (!folded(target).startsWith(`${folded(base)}/`)) throw outsideRoot(`worktree ${path} is outside the configured worktree root ${root}`);
  // The lexical path under the root must not pass through a link: one inside the root could be redirected later.
  const rest = relative(resolve(root), resolve(path));
  if (!rest || /^\.\.(?:[\\/]|$)/.test(rest) || isAbsolute(rest)) throw outsideRoot(`worktree ${path} is outside the configured worktree root ${root}`);
  let at = resolve(root);
  for (const part of rest.split(/[\\/]+/)) {
    at = join(at, part);
    let stat;
    try { stat = lstatSync(at); } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw outsideRoot(`worktree path ${at} cannot be inspected`);
    }
    // On Windows Node reports a junction as a symbolic link, so this covers both.
    if (stat.isSymbolicLink()) throw outsideRoot(`worktree path ${at} is a link or junction`);
  }
}

// The helper owns these root-level artifacts even when a target does not ignore *.log.
// Tracked changes, other untracked files, directories and linked files remain dirty.
function verificationCheckoutClean(git, path) {
  const status = exec(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: path });
  if (!status.ok) return false;
  const artifacts = new Set(Object.values(GATE_FILES));
  return status.stdout.split('\0').filter(Boolean).every((entry) => {
    if (!entry.startsWith('?? ') || !artifacts.has(entry.slice(3))) return false;
    try {
      const file = lstatSync(join(path, entry.slice(3)));
      return file.isFile() && !file.isSymbolicLink() && file.nlink === 1;
    } catch { return false; }
  });
}

/**
 * Isolated implementer worktree on the task branch; created from origin/<base> once, then reused. With `baseSha` it is
 * created from that commit without a fetch; `track` then gives a new branch origin/<base> as its upstream, as a branch
 * started from origin/<base> gets (git branch -d judges a merged branch against it).
 */
export function prepareImplementWorkspace({ git, repoPath, worktreeRoot, campaignId, taskId, baseBranch, baseSha, track = false }) {
  if (baseSha !== undefined && !SHA.test(baseSha)) throw new Error('implementation base must be a full SHA');
  const path = workspacePath(worktreeRoot, campaignId, taskId);
  const branch = branchName(campaignId, taskId);
  assertManagedWorktree(worktreeRoot, path);
  if (existsSync(path)) {
    const current = must(exec(git, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path }), 'inspect worktree branch');
    if (current !== branch) throw new Error(`worktree ${path} is on ${current}, expected ${branch}`);
  } else {
    if (!baseSha) must(exec(git, ['fetch', 'origin', baseBranch], { cwd: repoPath }), 'fetch base');
    const hasBranch = exec(git, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath }).ok;
    must(exec(git, hasBranch ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, baseSha ?? `origin/${baseBranch}`], { cwd: repoPath }), 'create worktree');
    // Only a local configuration write: a missing origin/<base> leaves the branch without an upstream, nothing more.
    if (!hasBranch && baseSha && track) exec(git, ['branch', `--set-upstream-to=origin/${baseBranch}`, branch], { cwd: repoPath });
  }
  const head = must(exec(git, ['rev-parse', 'HEAD'], { cwd: path }), 'read worktree head');
  return { path, branch, head };
}

/** Fresh detached checkout of the exact target for the independent verifier. */
export function prepareVerifyWorkspace({ git, repoPath, worktreeRoot, campaignId, taskId, targetSha, attempt }) {
  if (!SHA.test(targetSha)) throw new Error('verify target must be a full SHA');
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('verify attempt must be a positive integer');
  const path = workspacePath(worktreeRoot, campaignId, taskId, `-verify-${targetSha.slice(0, 12)}-${attempt}`);
  assertManagedWorktree(worktreeRoot, path);
  if (existsSync(path)) {
    const head = must(exec(git, ['rev-parse', 'HEAD'], { cwd: path }), 'read verify head');
    if (head !== targetSha || !verificationCheckoutClean(git, path)) throw new Error(`verify worktree ${path} is not a clean checkout of ${targetSha}`);
  } else {
    must(exec(git, ['worktree', 'add', '--detach', path, targetSha], { cwd: repoPath }), 'create verify worktree');
  }
  return { path };
}

/** Deterministic acceptance of an implementer's claim: exact head, clean tree, new descendant commit. */
export function checkImplementation({ git, path, baseSha, headSha }) {
  const head = exec(git, ['rev-parse', 'HEAD'], { cwd: path }).stdout;
  if (head !== headSha) return `worktree HEAD ${head || 'unknown'} does not match reported headSha ${headSha}`;
  if (head === baseSha) return 'no new commit on the task branch';
  const status = exec(git, ['status', '--porcelain'], { cwd: path });
  if (!status.ok) return 'cannot read worktree status';
  if (status.stdout) return `uncommitted changes remain: ${status.stdout.split('\n').slice(0, 5).join(', ')}`;
  if (!exec(git, ['merge-base', '--is-ancestor', baseSha, headSha], { cwd: path }).ok) return `headSha is not a descendant of base ${baseSha}`;
  return null;
}

/**
 * Paths a commit changed since it left `from` (three-dot: since their merge base), renames as delete + add; null if git
 * fails. NUL-separated, so a path with spaces or non-ASCII characters arrives as written, never quoted.
 */
export function changedPaths({ git, path, from, to }) {
  const out = exec(git, ['diff', '--name-only', '-z', '--no-renames', `${from}...${to}`], { cwd: path });
  return out.ok ? out.stdout.split('\0').filter(Boolean) : null;
}

/** Inspect only small regular source-template blobs at the exact reported commit. */
export function safeEnvironmentExamples({ git, path, sha, paths }) {
  if (!SHA.test(sha ?? '')) return [];
  return paths.filter(environmentExamplePath).filter((file) => {
    const entry = exec(git, ['ls-tree', sha, '--', file], { cwd: path });
    if (!entry.ok || !/^100644 blob [0-9a-f]{40}\t/.test(entry.stdout)) return false;
    const blob = entry.stdout.split(/\s+/)[2];
    const size = exec(git, ['cat-file', '-s', blob], { cwd: path });
    if (!size.ok || !/^\d+$/.test(size.stdout) || Number(size.stdout) > 65536) return false;
    const source = exec(git, ['cat-file', 'blob', blob], { cwd: path });
    return source.ok && safeEnvironmentExample(file, source.stdout);
  });
}

export function currentHead({ git, path }) {
  return exec(git, ['rev-parse', 'HEAD'], { cwd: path }).stdout;
}

/**
 * The root gate artifacts the target itself tracks (aiworks#1), matched case-insensitively because a case-insensitive
 * file system reads GATE.LOG as gate.log; null when git fails. A committed artifact is worker-controlled and clean, so it
 * could pass as the verifier's own gate run.
 */
function trackedGateFiles(git, path) {
  const specs = Object.values(GATE_FILES).map((name) => `:(top,icase,literal)${name}`);
  const out = exec(git, ['ls-files', '-z', '--full-name', '--', ...specs], { cwd: path });
  return out.ok ? out.stdout.split('\0').filter(Boolean) : null;
}

/** A verifier may only accept the unchanged checkout it was dispatched to inspect. */
export function checkVerification({ git, path, targetSha }) {
  if (currentHead({ git, path }) !== targetSha) return 'verifier checkout no longer matches the target SHA';
  const tracked = trackedGateFiles(git, path);
  if (tracked === null) return 'verifier checkout is not clean: cannot read the files it tracks';
  if (tracked.length) return `verifier checkout is not clean: the target tracks reserved gate evidence: ${tracked.slice(0, 5).join(', ')}`;
  if (!verificationCheckoutClean(git, path)) return 'verifier checkout is not clean';
  return null;
}

/** Git's empty tree: the base when nothing was published before, so every workflow file counts as added. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * AIWorks never uses GitHub Actions (owner directive, 2 November 2026) and does not read the repository's Actions setting
 * from GitHub. A push, backup push, pull request or merge that adds, changes, deletes or renames a path under
 * .github/workflows could start a hosted run, so it is refused. Workflow files already in the base do not block (they are
 * the owner's repository matter). It judges the head's own change, locally: `base...head`, the head's changes since its
 * merge-base with the base, so a workflow change the base gained after the head forked is not counted against the head.
 * With `tree` (the gated merge result of a refresh, a tree and not a commit) it compares the base with that result
 * instead, which is exactly what the merge puts on the base. The empty tree as `base` (a first backup to a repository
 * with no tip) is compared directly, so any workflow file counts. No rename detection, so both sides of a rename show;
 * paths match case-insensitively, as a Windows checkout would. Fails closed: an unreadable diff, or no base or head, is
 * a refusal.
 */
export function assertNoWorkflowChange({ git, repoPath, base, head, tree = null }) {
  const refuse = (why) => { throw Object.assign(new Error(`LOCAL_DEVELOPMENT_ONLY: ${why}`), { code: 'LOCAL_DEVELOPMENT_ONLY' }); };
  if (!git || !repoPath || !base || !head) refuse('the base and head of this GitHub push or merge are not known, so it cannot be checked for GitHub Actions workflow changes; AIWorks never publishes workflow changes');
  const out = exec(git, ['diff', '--name-only', '--no-renames', '-z', ...(tree ? [base, tree] : base === EMPTY_TREE ? [base, head] : [`${base}...${head}`])], { cwd: repoPath });
  if (!out.ok) refuse(`the change from ${base} to ${head} could not be read to check it for GitHub Actions workflow changes; nothing was published`);
  const changed = out.stdout.split('\0').find((path) => /^\.github\/workflows(\/|$)/i.test(path));
  if (changed) refuse(`the change adds or edits a GitHub Actions workflow file (${changed}); AIWorks never publishes workflow changes: remove the change from .github/workflows`);
}

/** A push goes only to a GitHub remote or an offline local folder. A push to a GitHub remote also must not change workflow files between `base` and `head`; an offline folder cannot run Actions. */
export function assertPushDestination({ git, repoPath, remote, expectedRepository = null, base, head }) {
  const out = exec(git, ['remote', 'get-url', '--push', '--all', remote], { cwd: repoPath });
  const refuse = () => { throw Object.assign(new Error('LOCAL_DEVELOPMENT_ONLY: push destination could not be verified'), { code: 'LOCAL_DEVELOPMENT_ONLY' }); };
  if (!out.ok || !out.stdout) refuse();
  const repositories = new Set();
  for (const url of out.stdout.split(/\r?\n/)) {
    const repository = githubRemote(url);
    if (repository) {
      if (expectedRepository && repository.toLowerCase() !== expectedRepository.toLowerCase()) refuse();
      repositories.add(repository);
    } else {
      // Helper and network transports stay refused; an offline local folder is allowed.
      if (!isAbsolute(url) || /^[\\/]{2}/.test(url) || url.includes('://') || !existsSync(url) || !lstatSync(url).isDirectory()) refuse();
    }
  }
  if (repositories.size) assertNoWorkflowChange({ git, repoPath, base, head });
}

/** Push exactly the verified SHA (not a moving HEAD) to the campaign branch. `base` is the commit the task started from. */
export function pushVerified({ git, repository, repoPath, branch, sha, base }) {
  assertPushDestination({ git, repoPath, remote: 'origin', expectedRepository: repository, base, head: sha });
  must(exec(git, ['push', 'origin', `${sha}:refs/heads/${branch}`], { cwd: repoPath }), 'push verified commit');
  const remote = must(exec(git, ['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: repoPath }), 'read remote branch');
  if (!remote.startsWith(sha)) throw new Error(`remote ${branch} is not at verified ${sha}`);
}

/** Whether `ancestor` is reachable from `descendant`. Read-only. */
export function isAncestor({ git, path, ancestor, descendant }) {
  return exec(git, ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: path }).ok;
}

/** The commits on the first-parent line of `to` after `from`, newest first; null when unreadable. Local, never fetches. */
export function firstParentSince({ git, path, from, to }) {
  const result = exec(git, ['rev-list', '--first-parent', `${from}..${to}`], { cwd: path });
  return result.ok ? result.stdout.split(/\s+/).filter(Boolean) : null;
}

/**
 * Heads of the remote branches matching `pattern` (for example `refs/heads/campaign/<id>/*`), or null when unreadable or
 * not read within `timeoutMs`. A network read, so asynchronous and bounded (execBounded): await it before the fence.
 */
export async function remoteBranches({ git, repoPath, pattern, timeoutMs = 30_000 }) {
  const out = await execBounded(git, ['ls-remote', 'origin', pattern], { cwd: repoPath, timeoutMs });
  if (!out.ok) return null;
  return new Map(out.stdout.split('\n').filter(Boolean).map((line) => line.split(/\s+/)).map(([sha, ref]) => [ref, sha]));
}

/**
 * Heads of the local branches matching `pattern`, as remoteBranches returns them, or null when unreadable. The
 * self-hosted repository (LOCAL_OPERATION.md section 4, slice SELF4) keeps its campaign branches here: no remote is read.
 */
export function localBranches({ git, repoPath, pattern }) {
  const out = exec(git, ['for-each-ref', '--format=%(objectname) %(refname)', pattern.replace(/\/\*$/, '/')], { cwd: repoPath, timeoutMs: 30_000 });
  if (!out.ok) return null;
  return new Map(out.stdout.split('\n').filter(Boolean).map((line) => line.split(/\s+/)).map(([sha, ref]) => [ref, sha]));
}

/**
 * Local integration check (aiworks#27): would `sha` merge cleanly into `baseSha`? `git merge-tree --write-tree` (Git 2.38+)
 * only writes objects: it never touches a worktree, the index or a ref, and makes no network or GitHub call.
 * Returns { clean, tree, baseTree, paths }: `paths` are the conflicting files.
 */
export function mergeCheck({ git, repoPath, baseSha, sha }) {
  if (!SHA.test(baseSha) || !SHA.test(sha)) throw new Error('merge check needs full SHAs');
  const out = exec(git, ['merge-tree', '--write-tree', '--name-only', '--no-messages', baseSha, sha], { cwd: repoPath, timeoutMs: 60_000 });
  if (out.status !== 0 && out.status !== 1) must(out, 'merge-tree');
  const [tree, ...paths] = out.stdout.split('\n').map((line) => line.trim());
  if (!SHA.test(tree ?? '')) throw new Error(`merge-tree returned no tree: ${out.stdout.slice(0, 200)}`);
  const baseTree = must(exec(git, ['rev-parse', `${baseSha}^{tree}`], { cwd: repoPath }), 'read base tree');
  return { clean: out.status === 0, tree, baseTree, paths: out.status === 0 ? [] : [...new Set(paths.filter(Boolean))] };
}

/** The base commits, absent from `sha`, that changed any of `paths` (newest first, at most `limit`). */
export function siblingCommits({ git, repoPath, baseSha, sha, paths, limit = 10 }) {
  const out = exec(git, ['log', `--max-count=${limit}`, '--format=%H %s', baseSha, `^${sha}`, '--', ...paths], { cwd: repoPath });
  return out.ok ? out.stdout.split('\n').filter(Boolean).map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41, 200) })) : [];
}

/** The repository's registered worktrees ({ path, head, branch, locked }), the main checkout first; null when unreadable. */
export function worktreeList({ git, repoPath }) {
  const out = exec(git, ['worktree', 'list', '--porcelain', '-z'], { cwd: repoPath, timeoutMs: 30_000 });
  if (!out.ok) return null;
  const list = [];
  for (const field of out.stdout.split('\0')) {
    const [key, ...rest] = field.split(' '), value = rest.join(' ');
    if (key === 'worktree') list.push({ path: value, head: null, branch: null, locked: false });
    else if (!list.length) continue;
    else if (key === 'HEAD') list.at(-1).head = value;
    else if (key === 'branch') list.at(-1).branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'locked') list.at(-1).locked = true;
  }
  return list;
}

/**
 * Uncommitted, untracked (`?? `) and ignored (`!! `) entries of a checkout; null when git cannot read it. A non-forced
 * `git worktree remove` deletes ignored files, so they are listed too: an ignored directory as one `!! dir/` entry.
 */
export function worktreeChanges({ git, path }) {
  const out = exec(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], { cwd: path, timeoutMs: 60_000 });
  return out.ok ? out.stdout.split('\0').filter(Boolean) : null;
}

/** `git worktree remove` without --force: git itself refuses a checkout with changes, untracked files or a lock. */
export function removeWorktree({ git, repoPath, path }) {
  return exec(git, ['worktree', 'remove', path], { cwd: repoPath, timeoutMs: 120_000 });
}

/** `git branch -d`, never -D: git itself refuses a branch that is checked out or not merged. */
export function deleteMergedBranch({ git, repoPath, branch }) {
  return exec(git, ['branch', '-d', branch], { cwd: repoPath, timeoutMs: 30_000 });
}
