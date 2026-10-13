import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { supervisorSnapshot, applyCommand, postMessage } from './supervisor.mjs';
import { ownerView } from './owner.mjs';
import { configuredMergeDelegation } from './merges.mjs';
import { configuredRepositories, projectsView } from './projects.mjs';
import { safeText } from './roadmap.mjs';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/router.mjs', ['router.mjs', 'text/javascript; charset=utf-8']],
  // The state copy module (OWNER_WORKSPACE S4): one file that both the page and Node load.
  ['/copy.mjs', ['../copy.mjs', 'text/javascript; charset=utf-8']],
]);

/**
 * A plain top-level page load, such as following a dashboard link from GitHub, Telegram or email. It returns only
 * the static page; data and commands still require same-origin requests.
 */
const pageNavigation = (req, path) => req.method === 'GET' && path === '/' && !req.headers.origin &&
  req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';

/**
 * roadmap: the governance roadmap (RoadmapSource). merges: the local merge check (MergeWatcher); without one, no step
 * reads as merged. No route calls GitHub: a state request only starts a local merge check, which fetches each
 * repository's base branch at most every 5 minutes.
 */
export function createDashboardServer({ dataDir, roadmap, merges = null, host = {}, releases = {} }) {
  const csrf = randomBytes(32).toString('hex');
  // Which machine and dashboard version this is, so a screenshot identifies its supervisor.
  const machine = { name: safeText(host.name ?? hostname(), 64) || null, revision: /^[0-9a-f]{7,40}$/.test(host.revision ?? '') ? host.revision : null };
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      const value = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(value), 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        // A page opened from another site gets its own browsing context group: neither window can reach the other.
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(value);
    };
    let path = null;
    try { path = new URL(req.url, origin).pathname; } catch { /* rejected below */ }
    if (path === null || req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin ||
        req.headers['sec-fetch-site'] === 'cross-site' && !pageNavigation(req, path)) return send(403, { error: 'Only the local dashboard origin is allowed.' });
    try {
      if (req.method === 'GET') {
        if (staticFiles.has(path)) {
          const [file, type] = staticFiles.get(path);
          return send(200, readFileSync(fileURLToPath(new URL(`./public/${file}`, import.meta.url))), type);
        }
        if (path === '/api/session') return send(200, { csrf });
        if (path === '/api/state') {
          // `since`: the viewer's last visit (ms), for "since you last looked"; bounded to the last 30 days.
          const now = Date.now(), raw = Number(new URL(req.url, origin).searchParams.get('since'));
          const since = Number.isSafeInteger(raw) && raw > 0 ? Math.min(now, Math.max(raw, now - 30 * 86_400_000)) : undefined;
          const supervisor = supervisorSnapshot(dataDir, now, { since });
          // Merge checks run while someone looks at the page; the answer never waits for them.
          if (merges) void merges.refresh();
          const merged = merges?.snapshot() ?? { refreshing: false, repositories: [], steps: {} };
          // The owner's merge delegation is read on every request, so a change to config.json shows without a restart.
          const owner = ownerView(supervisor, merged, { host: machine.name, now, releases, delegation: configuredMergeDelegation(dataDir) });
          return send(200, { observedAt: new Date(now).toISOString(), host: machine, supervisor, roadmap: roadmap.snapshot(),
            merges: { refreshing: merged.refreshing, repositories: merged.repositories }, owner,
            // Projects: campaign repositories and the repositories config.json lists, by name only (never a path).
            projects: projectsView(supervisor, owner, { repositories: configuredRepositories(dataDir) }) });
        }
        return send(404, { error: 'Not found.' });
      }
      if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
      const token = Buffer.from(String(req.headers['x-dashboard-csrf'] ?? ''));
      if (req.headers.origin !== origin || token.length !== csrf.length || !timingSafeEqual(token, Buffer.from(csrf))) {
        return send(403, { error: 'Refresh the dashboard before sending a command.' });
      }
      if (req.headers['content-type'] !== 'application/json') return send(415, { error: 'Commands require JSON.' });
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16_384) return send(413, { error: 'Command is too large.' });
        chunks.push(chunk);
      }
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { return send(400, { error: 'Invalid JSON.' }); }
      if (path === '/api/commands') return send(202, applyCommand(dataDir, value));
      if (path === '/api/messages') return send(202, postMessage(dataDir, value));
      return send(404, { error: 'Not found.' });
    } catch (error) {
      const status = error.status ?? (error.code === 'INVALID_STATE' || error.name === 'ConflictError' ? 409 : 503);
      // `detail`: the machine's reason behind a refusal, which the page keeps in a Details disclosure (aiworks#11 review F3).
      send(status, { error: error.status ? error.message : 'The supervisor is busy or unavailable. Refresh before trying again.', ...(error.status && error.detail ? { detail: error.detail } : {}) });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}
