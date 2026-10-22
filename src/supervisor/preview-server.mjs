// Preview of a checked version that runs its own server (docs/design/OWNER_UI_V2.md WP7, aiworks#39). The smallest
// server runtime AIWorks supports: one Node script of exactly the verified commit, named for its project by the operator,
// run on this computer for a bounded time. Containment, on top of everything preview.mjs binds:
// - authority: a project has a server preview only when the operator's config.json names its script under
//   `previews.servers` (a repository-relative `.mjs`, `.cjs` or `.js` path, and optionally the page to open). Nothing in
//   a request names a command, an argument, a path or a revision, and no shell is used: the argv is AIWorks's own Node,
//   fixed flags and that script. A version whose package.json declares dependencies is refused, because installing them
//   runs their scripts; nothing is ever installed or built;
// - identity: the files are written from Git objects of exactly the verified commit into a new folder this preview owns
//   (hidden files and secret-like names are left out, and an unsafe or colliding name refuses the version), never from a
//   working copy, and the preview ends as soon as that commit stops being the step's checked version;
// - process: the script runs under runner.mjs inside a Windows Job Object that kills it with its whole process tree at the
//   preview's deadline, on stop, or when the runner dies, with no environment beyond what Windows needs to start a process
//   and HOST and PORT; Node's permission model limits its file reads and writes to its own folder and refuses child
//   processes, worker threads and native addons;
// - network: AIWorks gives it a free loopback port of its own, separate from the dashboard's and the capture's; it is
//   ready once that port answers, and while it runs every port it or a descendant listens on must be a loopback address,
//   or it is stopped. The owner's browser never reaches it: the dashboard (or the capture's own server) relays GET
//   requests to it, keeps each answer in the preview's opaque-origin sandbox (PREVIEW_POLICY), and serves only known
//   types, bounded in size, without credential-looking text;
// - what is not contained: its outgoing connections. Nothing on this platform keeps a program's own requests to loopback
//   without a firewall rule or an AppContainer, which AIWorks does not create; that is why each project needs the
//   operator's declaration, and why the script it runs is the one the independent check already ran under the same
//   containment.
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containsSecret } from './coordinator.mjs';
import { POWERSHELL } from './proc.mjs';
import { reclaim } from './preview-capture.mjs';
import { commitTree, PREVIEW_TYPES, PreviewError, readGit, SECRET_NAME } from './preview.mjs';
import { projectKey } from './project-settings.mjs';

const RUNNER = fileURLToPath(new URL('./runner.mjs', import.meta.url));
/** A server preview ends after this, and its job kills the server at this deadline even if AIWorks has died. */
export const SERVER_PREVIEW_TTL_MS = 10 * 60_000;
/** How long the server has to answer on its port before it is stopped. */
export const SERVER_READY_MS = 30_000;
/** Servers running at once (an open preview and a capture); starting another stops the oldest. */
export const MAX_SERVER_PREVIEWS = 2;
/** How often a running server's listening addresses are checked again. */
const WATCH_MS = 10_000;
const REQUEST_MS = 10_000;
const MAX_FILES = 5000;
const MAX_TREE_BYTES = 256 * 1024 * 1024;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const TEXT = /^(?:text\/|application\/json|image\/svg)/;
const SCRIPT = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*\.(?:mjs|cjs|js)$/;
const READY = /^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/?)*$/;
// Names Windows cannot hold as written: reserved devices, trailing dots or spaces, and characters a path cannot carry.
const WINDOWS_UNSAFE = /[<>:"\\|?*\u0000-\u001f]|[. ]$|^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
const hidden = (path) => path.split('/').some((part) => part.startsWith('.'));
const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const answer = (status, body) => ({ status, body, type: 'text/plain; charset=utf-8' });
const NOT_SERVED = answer(404, 'Not in this preview.');
const ENDED = answer(410, 'This preview has ended. Open it again from Review.');
const LEFT = answer(502, 'The checked version’s server sent this page somewhere else, so it is not shown.');
const UNAVAILABLE = answer(502, 'The checked version’s server did not answer.');

/** Whether this computer can run a server preview, with the reason in the owner's words when it cannot. */
export function serverPreviewSupport() {
  if (process.platform !== 'win32' || !POWERSHELL) return { available: false, reason: 'A server preview needs the Windows process containment AIWorks runs workers in, which this computer does not have.' };
  if (!process.allowedNodeEnvironmentFlags.has('--permission')) return { available: false, reason: 'A server preview needs a Node.js with its permission model (22.13 or later).' };
  return { available: true, reason: null };
}

/**
 * The operator's server preview declaration for `project` (config.json `previews.servers`, keyed by the project's
 * repository or lp- id, case folded): null when there is none, { error } when it is malformed, else { script, ready }.
 */
export function serverPreviewDeclaration(config, project) {
  const key = projectKey(project), servers = config?.previews?.servers;
  if (!key || !plainObject(servers)) return null;
  const found = Object.entries(servers).find(([name]) => projectKey(name) === key);
  if (!found) return null;
  const entry = found[1];
  const valid = plainObject(entry) && Object.keys(entry).every((name) => ['script', 'ready'].includes(name)) &&
    typeof entry.script === 'string' && entry.script.length <= 200 && SCRIPT.test(entry.script) && !entry.script.split('/').some((part) => WINDOWS_UNSAFE.test(part)) &&
    (entry.ready === undefined || typeof entry.ready === 'string' && entry.ready.length <= 200 && READY.test(entry.ready));
  if (!valid) return { error: 'The preview script named for this project in AIWorks’s settings is not a plain repository-relative .mjs, .cjs or .js path, so nothing is started.' };
  return { script: entry.script, ready: entry.ready ?? '/' };
}

/**
 * What a server preview of commit `sha` would run, from its Git objects only: the declared script, the page to open and
 * every file to write. Throws PreviewError when the version cannot be run as declared.
 */
export function serverPreviewPlan({ git = ['git'], repoPath, sha, declaration }) {
  const tree = commitTree({ git, repoPath, sha });
  const { script, ready } = declaration;
  if (!tree.has(script) || hidden(script) || SECRET_NAME.test(script)) {
    throw new PreviewError('PREVIEW_SERVER_SCRIPT_MISSING', `This checked version has no ${script}, the preview script named for its project, so nothing was started.`);
  }
  // Every package.json from the repository root down to the script's folder: one that declares dependencies needs an install.
  const parts = script.split('/');
  for (let depth = 0; depth < parts.length; depth++) {
    const manifest = tree.get([...parts.slice(0, depth), 'package.json'].join('/'));
    if (!manifest) continue;
    let declared = null;
    const read = readGit(git, repoPath, ['cat-file', 'blob', manifest.blob]);
    try { declared = read.ok ? JSON.parse(read.stdout) : null; } catch { declared = null; }
    if (!plainObject(declared)) throw new PreviewError('PREVIEW_SERVER_NEEDS_INSTALL', 'This checked version’s package.json could not be read, so nothing was started.');
    if (['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'].some((name) => Object.keys(plainObject(declared[name]) ? declared[name] : Array.isArray(declared[name]) ? declared[name] : {}).length > 0)) {
      throw new PreviewError('PREVIEW_SERVER_NEEDS_INSTALL', 'This checked version declares dependencies, and AIWorks never installs them for a preview (installing runs their scripts), so nothing was started.');
    }
  }
  const files = [];
  let bytes = 0;
  for (const [path, file] of tree) {
    if (hidden(path) || SECRET_NAME.test(path)) continue;
    if (path.split('/').some((part) => !part || WINDOWS_UNSAFE.test(part))) throw new PreviewError('PREVIEW_SERVER_UNSAFE_PATH', 'This checked version has a file name this computer cannot hold as written, so it was not started.');
    files.push({ path, blob: file.blob, size: file.size });
    bytes += file.size;
    if (files.length > MAX_FILES || bytes > MAX_TREE_BYTES) throw new PreviewError('PREVIEW_SERVER_TOO_LARGE', 'This checked version is too large for a preview, so it was not started.');
  }
  return { sha, script, ready, entry: ready.slice(1), files };
}

/** Write the plan's files from Git objects into `appDir`, each exactly once and inside it. */
function materialize({ git, repoPath, plan, appDir }) {
  const read = readGit(git, repoPath, ['cat-file', '--batch'], { bytes: true, input: Buffer.from(`${plan.files.map((file) => file.blob).join('\n')}\n`),
    maxBuffer: MAX_TREE_BYTES + plan.files.length * 128 + 1024 });
  if (!read.ok) throw new PreviewError('PREVIEW_COMMIT_MISSING', 'AIWorks could not read this checked version.');
  const out = read.stdout, root = resolve(appDir);
  let at = 0;
  for (const file of plan.files) {
    const end = out.indexOf(0x0a, at);
    const header = end < 0 ? null : /^([0-9a-f]{40,64}) blob (\d+)$/.exec(out.subarray(at, end).toString('latin1'));
    const size = Number(header?.[2] ?? -1);
    if (!header || header[1] !== file.blob || size !== file.size || out[end + 1 + size] !== 0x0a) throw new PreviewError('PREVIEW_COMMIT_MISSING', 'AIWorks could not read this checked version.');
    const target = resolve(root, ...file.path.split('/'));
    if (!target.startsWith(root + sep)) throw new PreviewError('PREVIEW_SERVER_UNSAFE_PATH', 'This checked version has a file name this computer cannot hold as written, so it was not started.');
    mkdirSync(dirname(target), { recursive: true });
    // `wx`: two names that are one file on Windows (case) refuse the version rather than keep either.
    try { writeFileSync(target, out.subarray(end + 1, end + 1 + size), { flag: 'wx' }); }
    catch { throw new PreviewError('PREVIEW_SERVER_UNSAFE_PATH', 'This checked version has two file names this computer holds as one, so it was not started.'); }
    at = end + 2 + size;
  }
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

const LOOPBACK = (address) => /^127\./.test(address) || address === '::1';

/**
 * The addresses the processes under `pid` (the runner, its helper and the server) listen on, TCP and UDP: { proved,
 * exposed }. `proved` is true only when the lookup worked and the server is seen listening on its loopback `port`.
 */
export async function serverListeners(pid, port) {
  if (!POWERSHELL || !Number.isSafeInteger(pid) || pid <= 0) return { proved: false, exposed: [] };
  const script = `$ErrorActionPreference = 'Stop'
$ids = @{}; $ids[${pid}] = $true
$all = @(Get-CimInstance Win32_Process | ForEach-Object { ,@([int]$_.ProcessId, [int]$_.ParentProcessId) })
do { $added = $false; foreach ($p in $all) { if (-not $ids.ContainsKey($p[0]) -and $ids.ContainsKey($p[1])) { $ids[$p[0]] = $true; $added = $true } } } while ($added)
$tcp = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids.ContainsKey([int]$_.OwningProcess) } | ForEach-Object { [string]$_.LocalAddress + ' ' + $_.LocalPort })
$udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $ids.ContainsKey([int]$_.OwningProcess) } | ForEach-Object { [string]$_.LocalAddress + ' ' + $_.LocalPort })
ConvertTo-Json -Compress -InputObject @{ tcp = $tcp; udp = $udp }`;
  const out = await new Promise((done) => execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 }, (error, stdout) => done(error ? null : stdout.trim())));
  let seen = null;
  try { seen = JSON.parse(out ?? ''); } catch { return { proved: false, exposed: [] }; }
  const list = (value) => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).map((entry) => String(entry).split(' '));
  const all = [...list(seen?.tcp), ...list(seen?.udp)];
  return { proved: list(seen?.tcp).some(([address, at]) => LOOPBACK(address) && Number(at) === port), exposed: all.filter(([address]) => !LOOPBACK(address)).map(([address]) => address) };
}

/** A request path relayed to the server: each segment decoded once and a plain name, re-encoded; null otherwise. */
export function relayPath(requestPath) {
  const parts = String(requestPath ?? '').split('/'), names = [];
  for (const [index, part] of parts.entries()) {
    let name;
    try { name = decodeURIComponent(part); } catch { return null; }
    if (name === '' && index === parts.length - 1) { names.push(''); continue; }
    if (!name || name === '.' || name === '..' || /[/\\:\u0000-\u001f\u007f]/.test(name)) return null;
    names.push(encodeURIComponent(name));
  }
  return names.join('/');
}

function relayType(header) {
  const mime = String(header ?? '').split(';')[0].trim().toLowerCase();
  return mime ? Object.values(PREVIEW_TYPES).find((type) => type.split(';')[0] === mime) ?? null : null;
}

async function boundedBody(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { await response.body.cancel().catch(() => {}); return null; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** One GET relayed to the server at `origin`: { status, body, type }. Redirects are followed only within that server. */
async function relay(origin, requestPath, running) {
  const path = relayPath(requestPath);
  if (path === null) return NOT_SERVED;
  if (!running()) return ENDED;
  let url = `${origin}/${path}`;
  try {
    for (let hop = 0; hop <= 3; hop++) {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_MS), headers: { accept: '*/*' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        const next = new URL(response.headers.get('location') ?? '', url);
        if (next.origin !== origin) return LEFT;
        url = next.href;
        continue;
      }
      const type = relayType(response.headers.get('content-type')), body = await boundedBody(response);
      if (!type || body === null || TEXT.test(type) && containsSecret(body.toString('utf8'))) return NOT_SERVED;
      return { status: response.status, body, type };
    }
    return LEFT;
  } catch { return running() ? UNAVAILABLE : ENDED; }
}

const removeFolder = (dir) => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* the next start removes it */ } };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Start the server of one checked version as `plan` (serverPreviewPlan) says, in `workDir`, a new folder it owns and
 * removes. Resolves a running server { sha, entry, port, expiresAt, workDir, running(), request(path), stop() } once its
 * port answers and it is proved to listen on loopback only; rejects with a PreviewError otherwise, and never leaves a
 * process it started running. `stop()` resolves 'stopped' once the job is proved empty, or 'unproved'.
 */
export async function startServerPreview({ git = ['git'], repoPath, plan, workDir, ttlMs = SERVER_PREVIEW_TTL_MS, readyMs = SERVER_READY_MS, signal = null }) {
  if (!/^[0-9a-f]{40}$/.test(plan?.sha ?? '')) throw new PreviewError('PREVIEW_COMMIT_MISSING', 'Only a checked commit can be previewed.');
  const support = serverPreviewSupport();
  if (!support.available) throw new PreviewError('PREVIEW_SERVER_UNAVAILABLE', support.reason);
  let runner = null;
  const startedAt = Date.now();
  const dirs = { app: join(workDir, 'app'), home: join(workDir, 'home'), temp: join(workDir, 'temp') };
  try {
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    materialize({ git, repoPath, plan, appDir: dirs.app });
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    const access = (dir) => [dir, join(dir, '*')];
    writeFileSync(join(workDir, 'prompt.txt'), '');
    writeFileSync(join(workDir, 'spec.json'), JSON.stringify({ cwd: dirs.app, timeoutMs: ttlMs, heartbeatMs: 1000, env: { HOST: '127.0.0.1', PORT: String(port) },
      argv: [process.execPath, '--permission', ...[...access(dirs.app), ...access(dirs.temp)].flatMap((dir) => [`--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`]),
        join(dirs.app, ...plan.script.split('/'))] }));
    const root = process.env.SystemRoot || 'C:\\Windows';
    runner = spawn(process.execPath, [RUNNER, workDir], { windowsHide: true, stdio: 'ignore', env: { SystemRoot: root, windir: root,
      PATH: `${root}\\System32;${root}`, TEMP: dirs.temp, TMP: dirs.temp, USERPROFILE: dirs.home, HOME: dirs.home,
      APPDATA: join(dirs.home, 'AppData', 'Roaming'), LOCALAPPDATA: join(dirs.home, 'AppData', 'Local') } });
    let spawnFailed = false;
    runner.on('error', () => { spawnFailed = true; });
    const deadline = startedAt + readyMs;
    for (;;) {
      if (signal?.aborted) throw new PreviewError('PREVIEW_SERVER_CANCELLED', 'The preview was cancelled, so its server was stopped.');
      if (spawnFailed || runner.exitCode !== null) throw new PreviewError('PREVIEW_SERVER_STOPPED', 'The checked version’s server stopped before it answered.');
      if (Date.now() > deadline) throw new PreviewError('PREVIEW_SERVER_TIMEOUT', `The checked version’s server did not answer within ${Math.round(readyMs / 1000)} seconds, so it was stopped.`);
      try {
        const response = await fetch(`${origin}${plan.ready}`, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
        await response.body?.cancel().catch(() => {});
        break;
      } catch { await pause(200); }
    }
    const seen = await serverListeners(runner.pid, port);
    if (seen.exposed.length) throw new PreviewError('PREVIEW_SERVER_EXPOSED', 'The checked version’s server listened beyond this computer, so it was stopped.');
    if (!seen.proved) throw new PreviewError('PREVIEW_SERVER_UNPROVED', 'AIWorks could not prove that the checked version’s server listens only on this computer, so it was stopped.');
    let stopping = null, watch = null;
    const child = runner;
    const server = {
      sha: plan.sha, entry: plan.entry, port, workDir, expiresAt: startedAt + ttlMs,
      running: () => !stopping && child.exitCode === null,
      request: (path) => relay(origin, path, server.running),
      stop: () => stopping ??= (async () => {
        clearInterval(watch);
        const proof = await reclaim(child, workDir, true);
        removeFolder(workDir);
        return proof;
      })(),
    };
    // A server that stops by itself (its deadline, or a crash) is cleaned up at once; one that starts listening beyond
    // loopback is stopped.
    child.once('exit', () => void server.stop());
    watch = setInterval(async () => {
      if (!server.running()) return;
      const again = await serverListeners(child.pid, port);
      if (server.running() && (again.exposed.length || !again.proved)) void server.stop();
    }, WATCH_MS);
    watch.unref?.();
    return server;
  } catch (error) {
    const proof = runner ? await reclaim(runner, workDir, true) : 'stopped';
    removeFolder(workDir);
    if (proof !== 'stopped') throw new PreviewError('PREVIEW_SERVER_UNCONTAINED', 'AIWorks could not prove that the server it started has stopped.');
    throw error instanceof PreviewError ? error : new PreviewError('PREVIEW_SERVER_STOPPED', 'The checked version’s server could not be started.');
  }
}

/**
 * The dashboard's running server previews: one start at a time, at most MAX_SERVER_PREVIEWS running (starting another
 * stops the oldest first), each in a new folder under `root` (installation data). Folders no running server holds are
 * removed before the next start. close() stops every one; if the dashboard dies instead, each job kills its server at
 * that server's deadline.
 */
export class ServerPreviews {
  constructor({ root, start = startServerPreview }) { this.root = root; this.startServer = start; this.servers = []; this.starting = false; this.closed = false; }

  async start(options) {
    if (this.closed) throw new PreviewError('PREVIEW_SERVER_CANCELLED', 'The dashboard is stopping, so nothing was started.');
    if (this.starting) throw new PreviewError('PREVIEW_SERVER_BUSY', 'Another preview server is starting. Try again when it has.');
    this.starting = true;
    try {
      this.servers = this.servers.filter((server) => server.running());
      while (this.servers.length >= MAX_SERVER_PREVIEWS) await this.servers.shift().stop();
      mkdirSync(this.root, { recursive: true });
      const held = new Set(this.servers.map((server) => resolve(server.workDir)));
      for (const name of readdirSync(this.root)) if (!held.has(resolve(this.root, name))) removeFolder(join(this.root, name));
      const server = await this.startServer({ ...options, workDir: mkdtempSync(join(this.root, 'server-')) });
      if (this.closed) { await server.stop(); throw new PreviewError('PREVIEW_SERVER_CANCELLED', 'The dashboard is stopping, so nothing was started.'); }
      this.servers.push(server);
      return server;
    } finally { this.starting = false; }
  }

  close() { this.closed = true; const servers = this.servers; this.servers = []; return Promise.all(servers.map((server) => server.stop())); }
}
