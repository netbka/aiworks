// Screenshots of a checked version (docs/design/OWNER_UI_V2.md WP7): the browser AIWorks starts reaches only the preview's
// own pages, and cancellation or the deadline stops its whole process tree and nothing else. These run the installed
// Chrome under the real Windows job containment; synthetic pages and folders only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturePreview } from '../../src/supervisor/preview-capture.mjs';

const CHROME = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)
  .map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((path) => existsSync(path));
const skip = process.platform !== 'win32' ? 'Windows job containment only' : !CHROME ? 'no installed Chrome' : false;
const SHA = 'c'.repeat(40);
const html = (body) => ({ status: 200, body: `<!doctype html><meta name="viewport" content="width=device-width"><title>Synthetic shop</title>${body}`, type: 'text/html; charset=utf-8' });
const missing = { status: 404, body: 'Not in this preview.', type: 'text/plain; charset=utf-8' };

/** Processes whose command line names `dir`: the capture's browser and its children all carry its profile folder. */
const processesIn = (dir) => {
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${dir.replaceAll("'", "''")}') }).Count`],
  { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return Number(out.stdout.trim());
};

async function sentinel(t) {
  // Stands in for the dashboard and every other address: it must never be asked for anything.
  const hits = [];
  const server = createServer((req, res) => { hits.push(req.url); res.end('dashboard data'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { hits, url: `http://127.0.0.1:${server.address().port}` };
}

test('a capture shows the checked page at desktop and phone width and reaches nothing else', { skip, timeout: 240_000 }, async (t) => {
  const other = await sentinel(t);
  const requested = [];
  const page = (path) => {
    requested.push(path);
    return path === 'index.html' ? html(`<h1>Find a product</h1><img src="${other.url}/api/state"><iframe src="${other.url}/frame"></iframe>
      <img src="http://example.invalid/pixel.png"><script>fetch('${other.url}/api/session').catch(() => {});
      try { new WebSocket('${other.url.replace('http', 'ws')}/socket'); } catch {} new Image().src = '${other.url}/beacon';</script>`) : missing;
  };
  const workDir = mkdtempSync(join(tmpdir(), 'aiworks-capture-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const captured = await capturePreview({ chrome: [CHROME], workDir, page, entry: 'index.html', sha: SHA });
  assert.equal(captured.sha, SHA);
  assert.deepEqual(captured.shots.map((shot) => [shot.size, shot.viewport.width]), [['desktop', 1366], ['phone', 390]], 'the page laid out at the stated widths');
  for (const shot of captured.shots) assert.equal(shot.png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.deepEqual(other.hits, [], 'the browser asked nothing of any other address');
  assert.ok(requested.includes('index.html'));
  assert.equal(existsSync(workDir), false, 'the browser profile is removed');

  // A page that navigates away is never captured as if it were the checked version.
  const leaving = (path) => path === 'index.html' ? html(`<script>location.href = '${other.url}/api/state';</script>`) : missing;
  const away = mkdtempSync(join(tmpdir(), 'aiworks-capture-'));
  t.after(() => rmSync(away, { recursive: true, force: true }));
  await assert.rejects(capturePreview({ chrome: [CHROME], workDir: away, page: leaving, entry: 'index.html', sha: SHA }), { code: 'PREVIEW_CAPTURE_LEFT' });
  assert.deepEqual(other.hits, []);
});

test('cancellation and the deadline stop the browser with its whole process tree and leave other processes running', { skip, timeout: 240_000 }, async (t) => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => unrelated.kill());
  for (const [label, run] of [
    ['cancelled', (workDir, seen) => {
      const controller = new AbortController();
      const page = (path) => { seen.count = processesIn(workDir); controller.abort(); return path === 'index.html' ? html('<h1>Synthetic</h1>') : missing; };
      return { code: 'PREVIEW_CAPTURE_CANCELLED', promise: capturePreview({ chrome: [CHROME], workDir, page, entry: 'index.html', sha: SHA, signal: controller.signal }) };
    }],
    ['timed out', (workDir, seen) => {
      // A page that never finishes loading holds the capture until its deadline.
      const page = (path) => { seen.count = processesIn(workDir); return path === 'index.html' ? html('<script>for (;;) {}</script>') : missing; };
      return { code: 'PREVIEW_CAPTURE_TIMEOUT', promise: capturePreview({ chrome: [CHROME], workDir, page, entry: 'index.html', sha: SHA, timeoutMs: 12_000 }) };
    }],
  ]) {
    const workDir = mkdtempSync(join(tmpdir(), 'aiworks-capture-')), seen = { count: 0 };
    t.after(() => rmSync(workDir, { recursive: true, force: true }));
    const { code, promise } = run(workDir, seen);
    await assert.rejects(promise, { code }, label);
    assert.ok(seen.count > 0, `${label}: the browser was running`);
    assert.equal(processesIn(workDir), 0, `${label}: no process of the capture is left`);
    assert.equal(unrelated.exitCode, null, `${label}: an unrelated process is untouched`);
  }
});
