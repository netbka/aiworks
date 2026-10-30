#!/usr/bin/env node
// The browser worker's only MCP server: chrome-devtools-mcp attached to a headless Chrome this process owns.
// agy starts it from the run's mcp_config.json with the path of the run's browser.json:
//   { chrome, profileDir, filesDir, tempDir, allowedUrlPatterns }
// Chrome gets a fresh profile inside the run directory and a loopback debugging port, and may load only the declared
// origins. workstation probes (agy 1.3.3, chrome-devtools-mcp 1.10.1, Chrome 155, 2026-10-11) shaped this:
// - Puppeteer's own launch (--remote-debugging-pipe) never connected when agy was the MCP host, and every browser call
//   timed out after 3 minutes; connecting to a Chrome started here over its debugging port works, and that Chrome runs
//   under the run-local profile home, AppData and temporary folder agy was given;
// - chrome-devtools-mcp adds os.tmpdir() to the folders its file tools may read and write, so the temporary folder is
//   the run's own before the package loads; together with --workspace no file tool reaches outside the run directory.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MIN_CHROME } from './adapters/agy.mjs';
import { loginBrowser, loginTransport } from './browser-login.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const fail = (message) => { process.stderr.write(`browser worker: ${message}\n`); process.exit(1); };
for (const dir of [config.profileDir, config.filesDir, config.tempDir]) mkdirSync(dir, { recursive: true });
process.env.TEMP = config.tempDir;
process.env.TMP = config.tempDir;
process.env.TMPDIR = config.tempDir;
const entry = createRequire(import.meta.url).resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js');

// A port file left by an earlier Chrome in a reused profile would name the wrong port.
const portFile = join(config.profileDir, 'DevToolsActivePort');
rmSync(portFile, { force: true });
// URL patterns do not govern WebRTC: a page's STUN/TURN traffic would go out over UDP to any address (seen with a LAN
// host in a historical regression probe). With no proxy configured, this policy leaves WebRTC no UDP path at all.
const browser = spawn(config.chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${config.profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
  '--disable-component-update', '--disable-default-apps', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--window-size=1366,900', 'about:blank'],
{ stdio: 'ignore', windowsHide: true });
browser.on('error', (error) => fail(`Chrome did not start (${error.code ?? error.message})`));
// A clean exit stops Chrome here; a hard kill is covered by the runner's Job Object, which stops every descendant.
process.on('exit', () => {
  try { browser.kill(); } catch { /* already gone */ }
  try { rmSync(config.profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the run directory keeps it */ }
});

// Chrome writes the port it chose to DevToolsActivePort in the profile once its debugging endpoint is listening.
// On Windows the file is locked (EBUSY) while Chrome writes it, which stopped 29 runs: that is not yet the answer, not a failure.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readPort = () => {
  try { return Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0]); } catch (error) {
    if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code)) return NaN;
    throw error;
  }
};
const deadline = Date.now() + 30_000;
let port = readPort();
while ((!Number.isSafeInteger(port) || port <= 0) && Date.now() < deadline) { await sleep(100); port = readPort(); }
if (!Number.isSafeInteger(port) || port <= 0) fail('Chrome did not open its debugging port within 30 s');
// The URL allowlist depends on the running browser's version, whatever the install folder said before dispatch.
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json()).catch(() => null);
const major = Number(/\/(\d+)\./.exec(String(version?.Browser ?? ''))?.[1] ?? 0);
if (major < MIN_CHROME) fail(`Chrome ${MIN_CHROME} or newer is required for the URL allowlist (running ${version?.Browser ?? 'unknown'})`);

if (config.login) {
  // Restrict every target, including popups and workers, to this login's origin while credentials are present.
  // Service and shared workers are held for loginBrowser's own binding: the allowlist does not bind them reliably.
  // The complete task/resource allowlist is applied only by the MCP server after every login page is closed.
  const library = createRequire(import.meta.url).resolve('chrome-devtools-mcp/build/src/third_party/index.js');
  const { puppeteer } = await import(pathToFileURL(library).href);
  // Nothing reached the application in these, so one more try after a random pause is safe, and it spreads runs that
  // started together. Never after the form was submitted: repeated logins could lock the account.
  const RETRIED = ['Browser pre-login could not start', 'Browser pre-login could not connect to Chrome',
    'Browser pre-login failed while opening the login page', 'Browser pre-login failed while resolving credential references'];
  for (const profile of config.login.profiles) {
    for (let attempt = 1; ; attempt += 1) {
      let connection, failure = null;
      try {
        const transport = await loginTransport(version.webSocketDebuggerUrl);
        connection = await puppeteer.connect({ transport, allowlist: [`${profile.origin}/*`] });
        await loginBrowser(connection, { ...config.login, profiles: [profile] }, { transport });
      } catch (error) {
        // Only our own fixed messages pass: any other text can contain a request payload or a value.
        failure = error.message.startsWith('Browser pre-login ') ? error.message : 'Browser pre-login could not connect to Chrome';
      } finally { await connection?.disconnect(); }
      if (!failure) break;
      if (attempt > 1 || !RETRIED.includes(failure)) fail(failure);
      await sleep(5_000 + Math.random() * 10_000);
    }
  }
}

// The pinned server can discover global/ancestor config. Use only this run's empty config plus explicit options.
const mcpConfig = join(config.tempDir, 'mcp-settings.json');
writeFileSync(mcpConfig, '{}\n');
process.argv = [process.argv[0], entry, '--config', mcpConfig, '--no-watchConfig', '--browserUrl', `http://127.0.0.1:${port}`,
  '--no-usage-statistics', '--no-performance-crux', '--redactNetworkHeaders', '--no-category-memory', '--workspace', config.filesDir,
  ...config.allowedUrlPatterns.flatMap((pattern) => ['--allowedUrlPattern', pattern])];
await import(pathToFileURL(entry).href);
