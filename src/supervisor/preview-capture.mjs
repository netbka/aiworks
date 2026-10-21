// Desktop and phone screenshots of a checked version (docs/design/OWNER_UI_V2.md WP7). The pages are the same static
// files a preview serves (preview.mjs), read from Git objects of exactly the verified commit; this module only puts them
// in front of a browser AIWorks owns, for a bounded time, and keeps nothing of that browser afterwards. Containment:
// - the executable is the installation's commands.chrome, and every argument is fixed here: a request names neither, nor a
//   path or a revision. The browser runs under runner.mjs, inside a Windows Job Object that kills it with its whole
//   process tree at the deadline, on cancellation, or when the runner dies;
// - it starts with a fresh profile, home and temporary folder inside its own work folder and none of the dashboard's
//   environment beyond what Windows needs to start a process, so it holds no account, cookie, token or credential;
// - its pages are served by a server of their own on a random loopback port, which answers nothing but the preview's
//   files. That server is also the browser's only proxy, so every other address, the dashboard included, is refused
//   there; a DevTools request filter fails the same requests before they are sent, and WebRTC has no UDP path. Each
//   response keeps the preview's opaque-origin sandbox (PREVIEW_POLICY);
// - a screenshot is kept only while the page is still the preview's own, with the page's layout viewport as the
//   browser measured it (not as the page reports it), and only once the job that held the browser is proved empty.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POWERSHELL, readJsonIfExists, runnerIdentified, stopOwnedRun } from './proc.mjs';
import { PREVIEW_POLICY } from './preview.mjs';

const RUNNER = fileURLToPath(new URL('./runner.mjs', import.meta.url));
/** The two captures, in CSS pixels: a common laptop window and a common phone (touch, mobile viewport rules). */
export const CAPTURE_SIZES = Object.freeze([
  Object.freeze({ size: 'desktop', width: 1366, height: 900, deviceScaleFactor: 1, mobile: false }),
  Object.freeze({ size: 'phone', width: 390, height: 844, deviceScaleFactor: 2, mobile: true }),
]);
/** The whole capture, browser start to proved stop; the job kills the browser at this deadline even if AIWorks has died. */
export const CAPTURE_TIMEOUT_MS = 90_000;
const LOAD_WAIT_MS = 15_000;
const SETTLE_MS = 400;

export class CaptureError extends Error {
  constructor(code, message) { super(message); this.name = 'CaptureError'; this.code = code; }
}

/** Whether this installation can capture screenshots, with the reason in the owner's words when it cannot. */
export function captureSupport(chromeCommand) {
  if (process.platform !== 'win32' || !POWERSHELL) return { available: false, reason: 'Screenshots need the Windows process containment AIWorks runs workers in, which this computer does not have.' };
  if (!Array.isArray(chromeCommand) || chromeCommand.length !== 1 || typeof chromeCommand[0] !== 'string' || !isAbsolute(chromeCommand[0])) {
    return { available: false, reason: 'Screenshots need Chrome named in AIWorks’s settings (commands.chrome, one absolute path).' };
  }
  if (!existsSync(chromeCommand[0])) return { available: false, reason: 'The Chrome named in AIWorks’s settings is not on this computer.' };
  return { available: true, reason: null };
}

const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', stop, { once: true });
});

/**
 * The preview's own server on 127.0.0.1 and a random port: GET of the preview's files by their path, nothing else. As the
 * browser's proxy it also receives every request for another address, with that address as its Host, and refuses it.
 */
async function previewServer(page) {
  const server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    let url = null;
    try { url = new URL(req.url, origin); } catch { /* refused below */ }
    const answer = req.headers.host !== new URL(origin).host || url?.origin !== origin ? { status: 403, body: 'Not this preview.', type: 'text/plain; charset=utf-8' }
      : req.method !== 'GET' ? { status: 405, body: 'Method not allowed.', type: 'text/plain; charset=utf-8' } : page(url.pathname.slice(1));
    res.writeHead(answer.status, { 'Content-Type': answer.type, 'Content-Length': Buffer.byteLength(answer.body), 'Cache-Control': 'no-store',
      'Content-Security-Policy': PREVIEW_POLICY, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Connection: 'close' });
    res.end(answer.body);
  });
  // A tunnel (https or WebSocket through the proxy) is never opened.
  server.on('connect', (_req, socket) => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

/** A minimal DevTools protocol client over one WebSocket, with flattened target sessions. */
async function devtools(url, signal) {
  const socket = new WebSocket(url);
  const pending = new Map(), listeners = new Set();
  let next = 0, closed = null;
  const end = (error) => {
    if (closed) return;
    closed = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  socket.addEventListener('message', ({ data }) => {
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.reject(new CaptureError('PREVIEW_CAPTURE_FAILED', 'The browser refused a capture step.'));
      else waiting?.resolve(message.result ?? {});
    } else for (const listener of listeners) listener(message);
  });
  socket.addEventListener('close', () => end(signal.aborted ? signal.reason : new CaptureError('PREVIEW_CAPTURE_FAILED', 'The browser closed during the capture.')));
  const abort = () => { end(signal.reason); try { socket.close(); } catch { /* closing */ } };
  signal.addEventListener('abort', abort, { once: true });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(closed ?? new CaptureError('PREVIEW_CAPTURE_FAILED', 'AIWorks could not reach the browser it started.')), { once: true });
  });
  return {
    send(method, params = {}, sessionId = undefined) {
      if (closed) return Promise.reject(closed);
      const id = ++next;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, sessionId, listener) {
      const wrapped = (message) => { if (message.method === method && message.sessionId === sessionId) listener(message.params ?? {}); };
      listeners.add(wrapped);
      return () => listeners.delete(wrapped);
    },
    close() { signal.removeEventListener('abort', abort); end(new CaptureError('PREVIEW_CAPTURE_FAILED', 'The capture ended.')); try { socket.close(); } catch { /* closing */ } },
  };
}

/** Whether `child` exits within `ms`. */
const exits = (child, ms) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve(true)
  : new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', done); resolve(false); }, ms);
    const done = () => { clearTimeout(timer); resolve(true); };
    child.once('exit', done);
  });

/**
 * Stop the runner's job and prove it empty: the runner's own result after the browser exited, or the job's owned stop
 * by the runner's recorded identity. Only that job's processes are ever stopped. Answers 'stopped' or why not.
 */
async function reclaim(child, workDir, hurry) {
  const result = () => readJsonIfExists(join(workDir, 'result.json'));
  if (!hurry && await exits(child, 15_000)) return result()?.containmentStopped === true ? 'stopped' : 'unproved';
  // The runner records its job only after the helper reports it ready; wait briefly for that identity.
  for (let i = 0; i < 50 && child.exitCode === null && !runnerIdentified(readJsonIfExists(join(workDir, 'runner.json'))); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (child.exitCode !== null) return result()?.containmentStopped === true || result()?.attached === false ? 'stopped' : 'unproved';
  const identity = readJsonIfExists(join(workDir, 'runner.json'));
  if (runnerIdentified(identity)) {
    const stopped = stopOwnedRun(identity);
    await exits(child, 10_000);
    if (stopped === 'stopped') return 'stopped';
  }
  // Without its identity the runner's death still closes the only job handle, and the job kills what it holds; that
  // cannot be proved from here, so no screenshot is kept.
  child.kill();
  await exits(child, 10_000);
  return 'unproved';
}

/**
 * Screenshots of one checked version at CAPTURE_SIZES. `page(path)` answers one preview request as PreviewSessions.serve
 * does ({ status, body, type }); `entry` is the preview's entry page; `workDir` is a new folder this capture owns and
 * removes. `signal` cancels. Resolves { sha, capturedAt, shots: [{ size, width, height, deviceScaleFactor, viewport, png }] };
 * rejects with a CaptureError, and never leaves a process it started running.
 */
export async function capturePreview({ chrome, workDir, page, entry, sha, signal = null, timeoutMs = CAPTURE_TIMEOUT_MS }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new CaptureError('PREVIEW_CAPTURE_FAILED', 'Only a checked commit can be captured.');
  if (!captureSupport(chrome).available) throw new CaptureError('PREVIEW_CAPTURE_UNAVAILABLE', captureSupport(chrome).reason);
  const controller = new AbortController(), bounded = controller.signal;
  const timer = setTimeout(() => controller.abort(new CaptureError('PREVIEW_CAPTURE_TIMEOUT', 'The capture took too long, so it was stopped.')), timeoutMs);
  const cancel = () => controller.abort(new CaptureError('PREVIEW_CAPTURE_CANCELLED', 'The capture was cancelled.'));
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  let server = null, runner = null, client = null, shots = null, failure = null;
  try {
    if (bounded.aborted) throw bounded.reason;
    server = await previewServer(page);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const dirs = { profile: join(workDir, 'profile'), home: join(workDir, 'home'), temp: join(workDir, 'temp') };
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(workDir, 'prompt.txt'), '');
    writeFileSync(join(workDir, 'spec.json'), JSON.stringify({ cwd: workDir, timeoutMs, heartbeatMs: 1000, argv: [chrome[0], '--headless=new',
      '--remote-debugging-port=0', `--user-data-dir=${dirs.profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-sync', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--mute-audio', '--hide-scrollbars',
      // Every request goes to the preview server as a proxy, loopback included, and WebRTC gets no UDP path around it.
      `--proxy-server=${origin}`, '--proxy-bypass-list=<-loopback>', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--window-size=1366,900', 'about:blank'] }));
    const root = process.env.SystemRoot || 'C:\\Windows';
    runner = spawn(process.execPath, [RUNNER, workDir], { windowsHide: true, stdio: 'ignore', env: { SystemRoot: root, windir: root,
      PATH: `${root}\\System32;${root}`, TEMP: dirs.temp, TMP: dirs.temp, USERPROFILE: dirs.home, HOME: dirs.home,
      APPDATA: join(dirs.home, 'AppData', 'Roaming'), LOCALAPPDATA: join(dirs.home, 'AppData', 'Local') } });
    runner.on('error', () => controller.abort(new CaptureError('PREVIEW_CAPTURE_FAILED', 'AIWorks could not start its browser.')));
    // Chrome writes the port it chose once its DevTools endpoint listens.
    const portFile = join(dirs.profile, 'DevToolsActivePort');
    while (!existsSync(portFile) || !/^\d+\r?\n/.test(readFileSync(portFile, 'utf8'))) {
      if (runner.exitCode !== null) throw new CaptureError('PREVIEW_CAPTURE_FAILED', 'The browser stopped before the capture began.');
      await delay(100, bounded);
    }
    const port = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: bounded })).json();
    client = await devtools(version.webSocketDebuggerUrl, bounded);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    // Second lock: a request outside the preview's own address fails before the browser sends it.
    client.on('Fetch.requestPaused', sessionId, ({ requestId, request }) => {
      const inside = typeof request?.url === 'string' && request.url.startsWith(`${origin}/`);
      client.send(inside ? 'Fetch.continueRequest' : 'Fetch.failRequest', inside ? { requestId } : { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
    });
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
    await client.send('Page.enable', {}, sessionId);
    const ownPage = async () => {
      const { frameTree } = await client.send('Page.getFrameTree', {}, sessionId);
      return !frameTree?.frame?.unreachableUrl && String(frameTree?.frame?.url ?? '').startsWith(`${origin}/`);
    };
    const taken = [];
    for (const size of CAPTURE_SIZES) {
      await client.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.deviceScaleFactor, mobile: size.mobile }, sessionId);
      await client.send('Emulation.setTouchEmulationEnabled', size.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }, sessionId);
      let off = null;
      const loaded = new Promise((resolve) => { off = client.on('Page.loadEventFired', sessionId, resolve); });
      const navigated = await client.send('Page.navigate', { url: `${origin}/${entry.split('/').map(encodeURIComponent).join('/')}` }, sessionId);
      if (navigated.errorText) throw new CaptureError('PREVIEW_CAPTURE_FAILED', 'The checked page did not load in the browser.');
      // A page that never finishes loading is captured as it stands after LOAD_WAIT_MS.
      await Promise.race([loaded, delay(LOAD_WAIT_MS, bounded)]);
      off();
      await delay(SETTLE_MS, bounded);
      if (!await ownPage()) throw new CaptureError('PREVIEW_CAPTURE_LEFT', 'The checked page left its preview, so no screenshot of it was kept.');
      const { cssLayoutViewport: viewport } = await client.send('Page.getLayoutMetrics', {}, sessionId);
      const { data } = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
      if (!await ownPage()) throw new CaptureError('PREVIEW_CAPTURE_LEFT', 'The checked page left its preview, so no screenshot of it was kept.');
      taken.push({ size: size.size, width: size.width, height: size.height, deviceScaleFactor: size.deviceScaleFactor,
        viewport: { width: Math.round(viewport?.clientWidth ?? 0), height: Math.round(viewport?.clientHeight ?? 0) }, png: Buffer.from(data, 'base64') });
    }
    await client.send('Browser.close').catch(() => {});
    shots = taken;
  } catch (error) {
    failure = bounded.aborted ? bounded.reason : error instanceof CaptureError ? error : new CaptureError('PREVIEW_CAPTURE_FAILED', 'The capture failed.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    client?.close();
    const proof = runner ? await reclaim(runner, workDir, failure !== null) : 'stopped';
    if (server) { server.closeAllConnections(); server.close(); }
    try { rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* the next capture removes it */ }
    if (proof !== 'stopped') failure = new CaptureError('PREVIEW_CAPTURE_UNCONTAINED', 'AIWorks could not prove that the browser it started has stopped, so no screenshot is shown.');
  }
  if (failure) throw failure;
  return { sha, capturedAt: Date.now(), shots };
}

/**
 * The dashboard's captures: one at a time, each in a new work folder under `root` (installation data), cancelled by
 * its caller's `signal` and when the dashboard closes. A dashboard that dies instead leaves the browser at most until
 * the capture's deadline, when its job kills it. Work folders an earlier capture could not remove are removed before the next one starts.
 */
export class PreviewCaptures {
  constructor({ root }) { this.root = root; this.running = null; this.closed = false; }

  async run(options) {
    if (this.closed) throw new CaptureError('PREVIEW_CAPTURE_CANCELLED', 'The dashboard is stopping, so nothing was captured.');
    if (this.running) throw new CaptureError('PREVIEW_CAPTURE_BUSY', 'Another capture is running. Try again when it has finished.');
    const controller = new AbortController();
    this.running = controller;
    try {
      mkdirSync(this.root, { recursive: true });
      for (const name of readdirSync(this.root)) { try { rmSync(join(this.root, name), { recursive: true, force: true }); } catch { /* still in use */ } }
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      return await capturePreview({ ...options, workDir: mkdtempSync(join(this.root, 'capture-')), signal });
    } finally { this.running = null; }
  }

  close() { this.closed = true; this.running?.abort(); }
}
