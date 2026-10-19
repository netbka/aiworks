import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { supervisorSnapshot, applyCommand, applyDecision, applyScopedControl, postMessage, dashboardAccounts, removeDashboardAccount, configuredModelPreferences, saveDashboardModelPreferences } from './supervisor.mjs';
import { Store } from '../supervisor/store.mjs';
import { ownerView } from './owner.mjs';
import { configuredMergeDelegation } from './merges.mjs';
import { checkConnectedProject, configuredRepositories, confirmProjectRules, connectedProjects, connectProject, disconnectConnectedProject, listConnectedProjects,
  previewProject, projectConnectionEnabled, projectRulesView, projectsView, relocateConnectedProject, removedProjects, removeProject, restoreProject,
  revokeProjectRules } from './projects.mjs';
import { checkCaller } from '../supervisor/local-admission.mjs';
import { safeText } from './roadmap.mjs';
import { applyResult, approvePlan, requestPlanAndDo, undoApply, workView } from './work.mjs';
import { closeImportedIssues, commentWorkItem, createWorkItem, setWorkItemState, workItemView, workListView } from './work-list.mjs';
import { connectionsView, EVENT_TYPES, homeView, markSeen, overviewView, readLastSeen, trustedMainView, typedEvents, withReadOnlyStore } from './views.mjs';

/** The request body limit of pause and resume (WP1): the largest valid scoped request, 200 goal bindings, fits. */
export const SCOPED_CONTROL_BYTES = 65_536;

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
 * repository's base branch at most every 5 minutes. Add project (UI13), when config.json switches it on, connects a
 * GitHub project with read-only gh calls; `projectConnection` is for tests only (synthetic gh and branch reads, gitEnv,
 * statfs) and is never given by main.mjs.
 */
// provenanceRoot: the checkout whose origin/main a Resume or an Approve and start is checked against (AW-005); by default
// the code this server runs from. Tests pass a disposable checkout so the check never reads this repository's own git
// state. `work` is for tests only (governanceRoot, synthetic git and gh for the plan's freshness check); main.mjs gives none.
// `callerCheck` is for tests only: the caller check's process lookup and platform (local-admission.mjs checkCaller). main.mjs
// gives none, so the project rules routes and a local project's Approve and start, Apply and Undo apply refuse every
// write with APPROVAL_UNCHECKED until a process lookup is wired in. `workList` is for tests only: the work list's close
// switched on and a synthetic GitHub command (work-list.mjs closeImportedIssues).
export function createDashboardServer({ dataDir, roadmap, merges = null, host = {}, releases = {}, projectConnection = {}, provenanceRoot = undefined, work = {},
  callerCheck = {}, workList = {} }) {
  const csrf = randomBytes(32).toString('hex');
  // Which machine and dashboard version this is, so a screenshot identifies its supervisor.
  const machine = { name: safeText(host.name ?? hostname(), 64) || null, revision: /^[0-9a-f]{7,40}$/.test(host.revision ?? '') ? host.revision : null,
    ...(host.version !== undefined ? { version: safeText(host.version, 32) } : {}),
    ...(host.versionName !== undefined ? { versionName: safeText(host.versionName, 64) } : {}) };
  // What /api/state and the /api/v2 views read: the supervisor snapshot, the merge check, Needs me, the work of
  // projects without GitHub and Projects. Merge checks run while someone looks at the page; the answer never waits for them.
  const readState = (now, since) => {
    const supervisor = supervisorSnapshot(dataDir, now, { since });
    if (merges) void merges.refresh();
    const merged = merges?.snapshot() ?? { refreshing: false, repositories: [], steps: {} };
    // The owner's merge delegation is read on every request, so a change to config.json shows without a restart.
    // Add project is read on every request too; off, the Projects screen is exactly as before. Its records also let
    // Needs me name a project held up by the owner's decisions (aiworks#11 review 5 G7).
    const addProject = projectConnectionEnabled(dataDir), records = addProject ? connectedProjects(dataDir) : [];
    // The local work list (UI20): its open decisions join Needs me and its checked reviews join Results.
    const worklist = workListView(dataDir, { closeOn: workList.available });
    const owner = ownerView(supervisor, merged, { host: machine.name, now, releases, delegation: configuredMergeDelegation(dataDir), connected: records, workList: worklist });
    // Plan and do and Review (UI14, UI17): requests and draft plans of connected projects, and the local work and
    // checked results of projects without GitHub, allowlisted fields only.
    const work = workView(dataDir);
    // Projects: campaign repositories, the repositories config.json lists and connected projects, by name only (never a path).
    const projects = projectsView(supervisor, owner, { repositories: configuredRepositories(dataDir), removed: removedProjects(dataDir),
      ...(addProject ? { records, addProject, localWork: work.local } : {}) });
    return { supervisor, merged, owner, work, projects, worklist };
  };
  // Home: what changed after the owner's last-seen marker, read from the journal; never worker text.
  const home = (supervisor, owner, projects) => {
    const lastSeen = readLastSeen(dataDir);
    const events = withReadOnlyStore(dataDir, (store) => typedEvents(store, { after: lastSeen.seq, limit: 100 }), { events: [], next: null });
    return homeView({ supervisor, owner, projects, events, lastSeen, newest: supervisor.newestEvent ?? 0 });
  };
  // Settings -> Connections, with the trusted main and its backup read locally (never fetched).
  const connections = (supervisor, merged) => connectionsView({ supervisor, merges: merged,
    trustedMain: withReadOnlyStore(dataDir, (store, config) => trustedMainView(store, config), null) });
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
          const { supervisor, merged, owner, work, projects, worklist } = readState(now, since);
          // Home, Settings -> Connections (OWNER_UI_V2 WP1): the same allowlisted views /api/v2 serves, in the one poll.
          return send(200, { observedAt: new Date(now).toISOString(), host: machine, supervisor, roadmap: roadmap.snapshot(),
            merges: { refreshing: merged.refreshing, repositories: merged.repositories }, owner, projects, work, worklist,
            home: home(supervisor, owner, projects), connections: connections(supervisor, merged),
            overviews: Object.fromEntries((projects.projects ?? []).map((row) => [row.id, overviewView(row.id, { supervisor, projects })])) });
        }
        // The view layer of the owner UI v2 (OWNER_UI_V2 section 8, WP1): one allowlisted view per screen, read-only.
        if (path === '/api/v2/home') {
          const { supervisor, owner, projects } = readState(Date.now());
          return send(200, home(supervisor, owner, projects));
        }
        if (path === '/api/v2/settings') {
          const { supervisor, merged } = readState(Date.now());
          return send(200, connections(supervisor, merged));
        }
        if (path.startsWith('/api/v2/projects/')) {
          let project = null;
          try { project = decodeURIComponent(path.slice('/api/v2/projects/'.length)); } catch { /* refused below */ }
          if (!/^(?:[\w.-]+\/[\w.-]+|[\w-]{1,64})$/.test(project ?? '')) return send(404, { error: 'Not found.' });
          const { supervisor, projects } = readState(Date.now());
          const view = overviewView(project, { supervisor, projects });
          return view ? send(200, view) : send(404, { error: 'Not found.' });
        }
        // One work list item with its comments (UI20), read-only.
        if (path.startsWith('/api/v2/worklist/')) {
          const number = path.slice('/api/v2/worklist/'.length);
          return /^[1-9]\d{0,8}$/.test(number) ? send(200, workItemView(dataDir, Number(number))) : send(404, { error: 'Not found.' });
        }
        if (path === '/api/v2/events') {
          const query = new URL(req.url, origin).searchParams;
          const number = (key) => query.has(key) ? Number(query.get(key)) : null;
          const after = number('since') ?? 0, cursor = number('cursor'), project = query.get('project'), type = query.get('type');
          if (!Number.isSafeInteger(after) || after < 0 || cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1) ||
              project !== null && !/^(?:[\w.-]+\/[\w.-]+|[\w-]{1,64})$/.test(project) || type !== null && !EVENT_TYPES.includes(type)) {
            return send(400, { error: 'Invalid event query.' });
          }
          const events = withReadOnlyStore(dataDir, (store) => typedEvents(store, { after, cursor, project, type }), null);
          return events ? send(200, { ...events, lastSeen: readLastSeen(dataDir) }) : send(503, { error: 'The supervisor is busy or unavailable. Refresh before trying again.' });
        }
        // The connected projects with each one's own folder, the one path a response may carry (404 while Add project is off).
        if (path === '/api/projects') return send(200, listConnectedProjects(dataDir));
        if (path === '/api/accounts') {
          let store;
          try {
            store = new Store(join(dataDir, 'supervisor.db'), { readOnly: true });
            let config = {};
            try { config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { /* ignore */ }
            return send(200, { accounts: dashboardAccounts(store, config, { dataDir }) });
          } finally {
            store?.close();
          }
        }
        if (path === '/api/accounts/preferences') {
          return send(200, { preferences: configuredModelPreferences(dataDir) });
        }
        return send(404, { error: 'Not found.' });
      }
      if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
      const token = Buffer.from(String(req.headers['x-dashboard-csrf'] ?? ''));
      if (req.headers.origin !== origin || token.length !== csrf.length || !timingSafeEqual(token, Buffer.from(csrf))) {
        return send(403, { error: 'Refresh the dashboard before sending a command.' });
      }
      if (req.headers['content-type'] !== 'application/json') return send(415, { error: 'Commands require JSON.' });
      // 16 KiB for every command, except pause and resume: they bind each goal of their scope, up to 200 goals of at
      // most about 240 bytes each, so their limit fits the largest valid selection instead of refusing it unread.
      const limit = path === '/api/v2/pause' || path === '/api/v2/resume' ? SCOPED_CONTROL_BYTES : 16_384;
      if (Number(req.headers['content-length']) > limit) return send(413, { error: 'Command is too large.' });
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) return send(413, { error: 'Command is too large.' });
        chunks.push(chunk);
      }
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { return send(400, { error: 'Invalid JSON.' }); }
      if (path === '/api/commands') return send(202, applyCommand(dataDir, value, Date.now(), { provenanceRoot }));
      // Pause and resume for all, a project or a goal (WP1): `action` comes from the address, never from the body.
      if (path === '/api/v2/pause' || path === '/api/v2/resume') {
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'action')) return send(400, { error: 'Invalid dashboard command.' });
        return send(202, applyScopedControl(dataDir, { ...value, action: path.slice('/api/v2/'.length) }, Date.now(), { provenanceRoot }));
      }
      // A structured decision (WP2): answer, snooze or "this did not need me", bound to one decision; the action is the address.
      if (/^\/api\/v2\/decisions\/(?:answer|snooze|not-needed)$/.test(path)) {
        return send(202, applyDecision(dataDir, path.slice('/api/v2/decisions/'.length), value, Date.now()));
      }
      // Mark the events up to a journal sequence as seen (the server-side last-seen marker, WP1).
      if (path === '/api/v2/events/seen') {
        const newest = withReadOnlyStore(dataDir, (store) => store.get('SELECT MAX(seq) AS seq FROM journal')?.seq ?? 0, null);
        if (newest === null) return send(503, { error: 'AIWorks can’t read its work records on this computer right now.' });
        return send(200, markSeen(dataDir, value, newest));
      }
      if (path === '/api/messages') return send(202, postMessage(dataDir, value));
      // Plan and do (UI14, UI17): store a work request; Approve and start: register exactly the reviewed plan (work.mjs).
      // For a project without GitHub, Approve and start, Apply and Undo apply run the caller check on this request's
      // connection before anything is written, so a program AIWorks started cannot approve or apply (WORK_ENVELOPE 8.2).
      const callerOptions = { ...callerCheck, connection: req.socket };
      if (path === '/api/work/requests') return send(202, requestPlanAndDo(dataDir, value));
      if (path === '/api/work/approve') return send(200, await approvePlan(dataDir, value, Date.now(), { provenanceRoot, ...work, caller: callerOptions }));
      if (path === '/api/work/apply') return send(200, await applyResult(dataDir, value, { ...work, caller: callerOptions }));
      if (path === '/api/work/undo') return send(200, await undoApply(dataDir, value, { ...work, caller: callerOptions }));
      // No route adds, connects, exports or imports a login: any local process can read the CSRF token (aiworks#197).
      if (path === '/api/accounts/remove') return send(200, removeDashboardAccount(dataDir, value));
      if (path === '/api/accounts/preferences') return send(200, saveDashboardModelPreferences(dataDir, value));
      // Add project (UI13): each answers 404 while it is off, as before it existed.
      if (path === '/api/projects/preflight') return send(200, previewProject(dataDir, value, projectConnection));
      if (path === '/api/projects/connect') return send(200, connectProject(dataDir, value, projectConnection));
      if (path === '/api/projects/check') return send(200, checkConnectedProject(dataDir, value, projectConnection));
      if (path === '/api/projects/relocate') return send(200, relocateConnectedProject(dataDir, value, projectConnection));
      if (path === '/api/projects/disconnect') return send(200, disconnectConnectedProject(dataDir, value));
      // Remove from Projects decides from the Projects screen as it reads now, with no removal applied.
      if (path === '/api/projects/remove') {
        const now = Date.now(), supervisor = supervisorSnapshot(dataDir, now);
        const merged = merges?.snapshot() ?? { refreshing: false, repositories: [], steps: {} };
        const records = projectConnectionEnabled(dataDir) ? connectedProjects(dataDir) : [];
        const owner = ownerView(supervisor, merged, { host: machine.name, now, releases, delegation: configuredMergeDelegation(dataDir), connected: records,
          workList: workListView(dataDir, { closeOn: workList.available }) });
        return send(200, removeProject(dataDir, value, projectsView(supervisor, owner, { repositories: configuredRepositories(dataDir), records, now }), now));
      }
      if (path === '/api/projects/restore') return send(200, restoreProject(dataDir, value));
      // Project rules (UI16): the review only reads; confirm, renew and revoke run the caller check on this request's
      // connection first, so a program AIWorks started cannot write them (PROJECT_CONNECTION §7.4).
      if (path === '/api/projects/rules') return send(200, projectRulesView(dataDir, value));
      const caller = (store) => checkCaller(store, callerOptions);
      if (path === '/api/projects/rules/confirm') return send(200, await confirmProjectRules(dataDir, value, { caller }));
      if (path === '/api/projects/rules/revoke') return send(200, await revokeProjectRules(dataDir, value, { caller }));
      // The local work list (UI20): every change runs the caller check first and binds the version and request id it was sent with.
      if (path === '/api/work-list/items') return send(200, await createWorkItem(dataDir, value, { caller }));
      if (path === '/api/work-list/comment') return send(200, await commentWorkItem(dataDir, value, { caller }));
      if (path === '/api/work-list/state') return send(200, await setWorkItemState(dataDir, value, { caller }));
      if (path === '/api/work-list/close-imported') return send(200, await closeImportedIssues(dataDir, value, { ...workList, caller }));
      return send(404, { error: 'Not found.' });
    } catch (error) {
      const status = error.status ?? (error.code === 'INVALID_STATE' || error.name === 'ConflictError' ? 409 : 503);
      // `detail`: the machine's reason behind a refusal, which the page keeps in a Details disclosure (aiworks#11 review F3).
      // `code`: a refusal the page answers in place, such as INSTRUCTION_LOOKS_SENSITIVE beside the instruction (aiworks#61).
      send(status, { error: error.status ? error.message : 'The supervisor is busy or unavailable. Refresh before trying again.', ...(error.status && error.detail ? { detail: error.detail } : {}),
        ...(error.status && typeof error.code === 'string' ? { code: error.code } : {}) });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}
