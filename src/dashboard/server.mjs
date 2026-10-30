import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { supervisorSnapshot, applyCommand, applyDecision, applyResultReview, captureResultPreview, checkRelease, openResultPreview, previewStillChecked, applyScopedControl, postMessage, dashboardAccounts, removeDashboardAccount, configuredModelPreferences, saveDashboardModelPreferences } from './supervisor.mjs';
import { Store } from '../supervisor/store.mjs';
import { configuredGovernanceRoot } from '../supervisor/governance.mjs';
import { RELEASE_STOP } from '../supervisor/release/state.mjs';
import { campaignApiAuthorized, campaignApiScope, campaignApiSettings, campaignReports, registerRemoteCampaign, remoteCampaignStatus } from '../supervisor/remote-campaigns.mjs';
import { PREVIEW_POLICY, PreviewSessions } from '../supervisor/preview.mjs';
import { PreviewCaptures } from '../supervisor/preview-capture.mjs';
import { ServerPreviews } from '../supervisor/preview-server.mjs';
import { ownerView } from './owner.mjs';
import { configuredMergeDelegation } from './merges.mjs';
import { checkConnectedProject, configuredRepositories, confirmProjectRules, connectedProjects, connectProject, createSampleProject, disconnectConnectedProject, listConnectedProjects,
  previewProject, projectConnectionEnabled, projectRulesView, projectsView, relocateConnectedProject, removedProjects, removeProject, restoreProject,
  revokeProjectRules } from './projects.mjs';
import { checkCaller } from '../supervisor/local-admission.mjs';
import { safeText } from './roadmap.mjs';
import { DisplayTextChecks } from './display-text.mjs';
import { applyResult, approvePlan, editPlan, requestPlanAndDo, undoApply, workView } from './work.mjs';
import { projectSettingsView, saveProjectSettings } from './project-settings.mjs';
import { alertsView, saveAlerts } from './alerts.mjs';
import { knowledgeView, planningCost, saveKnowledge, usageView } from './knowledge.mjs';
import { closeImportedIssues, commentWorkItem, createWorkItem, ownerOnly, recordTrustedMain, setWorkItemState, workItemView, workListView } from './work-list.mjs';
import { connectionsView, EVENT_TYPES, homeView, markReportRead, markSeen, overviewView, readLastSeen, readReports, releasesView, trustedMainView, typedEvents, withReadOnlyStore } from './views.mjs';

/**
 * The caller check of a protected owner action that writes through a synchronous store transaction (Review of a result):
 * run on its own read-only store before anything is written, and refused as the other owner routes refuse it.
 */
async function ownerCaller(dataDir, caller) {
  let store;
  try { store = new Store(join(dataDir, 'supervisor.db'), { readOnly: true }); }
  catch { throw Object.assign(new Error('AIWorks can’t read its work records on this computer right now.'), { status: 503 }); }
  try { await ownerOnly(store, caller); } finally { store.close(); }
}

/** The request body limit of pause and resume (WP1): the largest valid scoped request, 200 goal bindings, fits. */
export const SCOPED_CONTROL_BYTES = 65_536;

// The external campaign API (off by default, docs/SUPERVISOR.md section 16): the same 1 MiB a private declaration file
// may be (provenance.mjs privateJson), since the body is the same declaration shape, just sent over HTTP.
export const CAMPAIGN_API_BYTES = 1024 * 1024;
const SLOW_STATE_MS = 3000, STATE_KEPT_MS = 15_000;
const CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Home's "what changed" never reaches further back than this, even when the owner has not marked anything as seen.
const HOME_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The external campaign API's routes, by exact method and path. */
function campaignApiRoute(method, path) {
  if (method === 'POST' && path === '/api/campaigns') return { register: true };
  const read = method === 'GET' ? /^\/api\/campaigns\/([^/]+)\/(status|report)$/.exec(path) : null;
  return read ? { id: read[1], kind: read[2] } : null;
}

const readConfig = (dataDir) => {
  try { const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); return config && typeof config === 'object' && !Array.isArray(config) ? config : {}; }
  catch { return {}; }
};

const TOKEN_REQUIRED = 'A valid campaign API token is required (Authorization: Bearer <token>).';
const RECORDS_UNREADABLE = 'AIWorks can’t read its work records on this computer right now.';

/**
 * One request to the external campaign API while it is on: [status, body]. Its caller is not the dashboard's browser
 * session, so it is authenticated by its own bearer token (remote-campaigns.mjs campaignApiAuthorized), never by the
 * session's CSRF secret. Registration, status and verified reports are limited to a project-named token's own project.
 */
async function answerCampaignApi(req, route, { dataDir, settings, config, provenanceRoot }) {
  if (!campaignApiAuthorized(settings, req.headers.authorization)) return [401, { error: TOKEN_REQUIRED }];
  const governanceRoot = configuredGovernanceRoot(dataDir);
  if (route.register) {
    const declaration = await readJsonBody(req, CAMPAIGN_API_BYTES);
    if (!existsSync(join(dataDir, 'supervisor.db'))) return [503, { error: RECORDS_UNREADABLE }];
    const scope = campaignApiScope(settings, governanceRoot);
    const store = new Store(join(dataDir, 'supervisor.db'));
    try {
      const { status, created } = registerRemoteCampaign(store, declaration, { provenanceRoot, governanceRoot, config, scope });
      return [created ? 201 : 200, status];
    } finally { store.close(); }
  }
  let id = null;
  try { id = decodeURIComponent(route.id); } catch { /* refused below */ }
  if (!CAMPAIGN_ID.test(id ?? '')) return [404, { error: 'Not found.' }];
  if (!existsSync(join(dataDir, 'supervisor.db'))) return [503, { error: RECORDS_UNREADABLE }];
  const scope = campaignApiScope(settings, governanceRoot);
  const store = new Store(join(dataDir, 'supervisor.db'), { readOnly: true });
  try {
    if (route.kind === 'report') return [200, campaignReports(store, id, { scope })];
    return [200, remoteCampaignStatus(store, id, { scope, config, releaseStop: existsSync(join(dataDir, RELEASE_STOP)) })];
  } finally { store.close(); }
}

/** Optional loopback listener for campaign routes alone. It shares bearer authentication and project scope with
 * the dashboard listener, but exposes no browser session, dashboard data or owner controls. */
export function createCampaignApiServer({ dataDir, provenanceRoot = undefined }) {
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      const value = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(value),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(value);
    };
    let path = null;
    try { path = new URL(req.url, 'http://127.0.0.1').pathname; } catch { /* refused below */ }
    const route = path === null ? null : campaignApiRoute(req.method, path);
    const config = readConfig(dataDir), settings = campaignApiSettings(config);
    if (!route || !settings.enabled || !settings.port) return send(404, { error: 'Not found.' });
    try {
      const [status, body] = await answerCampaignApi(req, route, { dataDir, settings, config, provenanceRoot });
      return send(status, body);
    } catch (error) {
      if (error.status) return send(error.status, { error: error.message, ...(typeof error.code === 'string' ? { code: error.code } : {}) });
      return send(503, { error: 'The supervisor is busy or unavailable. Try again later.' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

/** Read a JSON request body up to `limit` bytes, or throw a `{ status }` error the route's catch can send as-is. */
async function readJsonBody(req, limit) {
  if (req.headers['content-type'] !== 'application/json') throw Object.assign(new Error('The request body must be JSON.'), { status: 415 });
  if (Number(req.headers['content-length']) > limit) throw Object.assign(new Error('The request body is too large.'), { status: 413 });
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('The request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

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
// `callerCheck`: the caller check's process lookup and platform (local-admission.mjs checkCaller). main.mjs gives the native
// Windows lookup (caller-lookup.mjs); tests give a synthetic one. Without a lookup every protected owner action (project
// rules, a local project's Approve and start, Apply and Undo apply, settings, alerts, Knowledge, the work list, trusting local main) refuses
// with APPROVAL_UNCHECKED; so do Accept result, Request changes and answering, snoozing or dismissing a decision.
// `workList` is for tests only: the work list's close switched on and a synthetic GitHub command (work-list.mjs closeImportedIssues).
export function createDashboardServer({ dataDir, roadmap, merges = null, host = {}, releases = {}, projectConnection = {}, provenanceRoot = undefined, work = {},
  callerCheck = {}, workList = {} }) {
  const csrf = randomBytes(32).toString('hex');
  // Previews of checked versions (WP7): in this process's memory only, each bound to one verified commit, ending as soon
  // as that commit is no longer the step's checked version. Screenshots of one run one at a time and stop with the server.
  const previews = new PreviewSessions({ stillValid: (binding) => previewStillChecked(dataDir, binding) });
  const captures = new PreviewCaptures({ root: join(dataDir, 'preview-captures') });
  // The servers of checked versions whose project has an operator-declared server preview (preview-server.mjs).
  const servers = new ServerPreviews({ root: join(dataDir, 'preview-servers') });
  const textChecks = new DisplayTextChecks();
  // Which machine and dashboard version this is, so a screenshot identifies its supervisor.
  const machine = { name: safeText(host.name ?? hostname(), 64) || null, revision: /^[0-9a-f]{7,40}$/.test(host.revision ?? '') ? host.revision : null,
    ...(host.version !== undefined ? { version: safeText(host.version, 32) } : {}),
    ...(host.versionName !== undefined ? { versionName: safeText(host.versionName, 64) } : {}) };
  // What /api/state and the /api/v2 views read: the supervisor snapshot, the merge check, Needs you, the work of
  // projects without GitHub and Projects. Merge checks run while someone looks at the page; the answer never waits for them.
  const readState = (now, since) => {
    const supervisor = supervisorSnapshot(dataDir, now, { since, textChecks });
    if (merges) void merges.refresh();
    const merged = merges?.snapshot() ?? { refreshing: false, repositories: [], steps: {} };
    // The owner's merge delegation is read on every request, so a change to config.json shows without a restart.
    // Add project is read on every request too; off, the Projects screen is exactly as before. Its records also let
    // Needs you name a project held up by the owner's decisions (aiworks#11 review 5 G7).
    const addProject = projectConnectionEnabled(dataDir), records = addProject ? connectedProjects(dataDir) : [];
    // The local work list (UI20): its open decisions join Needs you and its checked reviews join Results.
    const worklist = workListView(dataDir, { closeOn: workList.available });
    // Plan and do and Review (UI14, UI17): requests and draft plans of connected projects, and the local work and
    // checked results of projects without GitHub, allowlisted fields only. Its open decisions join Needs you.
    const work = workView(dataDir, { textChecks });
    const owner = ownerView(supervisor, merged, { host: machine.name, now, releases, delegation: configuredMergeDelegation(dataDir), connected: records, workList: worklist,
      localWork: work.local, readReports: readReports(dataDir) });
    // Projects: campaign repositories, the repositories config.json lists and connected projects, by name only (never a path).
    const projects = projectsView(supervisor, owner, { repositories: configuredRepositories(dataDir), removed: removedProjects(dataDir),
      ...(addProject ? { records, addProject, localWork: work.local } : {}) });
    return { supervisor, merged, owner, work, projects, worklist };
  };
  // Home: what changed after the owner's last-seen marker and in the last day, read from the journal; never worker text.
  const home = (supervisor, owner, projects) => {
    const lastSeen = readLastSeen(dataDir), window = HOME_WINDOW_MS;
    const events = withReadOnlyStore(dataDir, (store) => typedEvents(store, { after: lastSeen.seq, since: Date.now() - window, limit: 100 }), { events: [], next: null });
    return homeView({ supervisor, owner, projects, events, lastSeen, newest: supervisor.newestEvent ?? 0, window });
  };
  // Settings -> Connections, with the trusted main and its backup read locally (never fetched).
  const connections = (supervisor, merged) => connectionsView({ supervisor, merges: merged,
    trustedMain: withReadOnlyStore(dataDir, (store, config) => trustedMainView(store, config), null) });
  // The page's poll gives up after 6 s and comes back 5 s later. When building the state takes longer, the finished answer
  // is kept for that next poll, or no poll would ever be answered. A change made here drops it at once.
  let keptState = null;
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET') { keptState = null; res.once('finish', () => { keptState = null; }); }
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      const value = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(value), 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        // A page opened from another site gets its own browsing context group: neither window can reach the other.
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(value);
    };
    let path = null;
    try { path = new URL(req.url, origin).pathname; } catch { /* rejected below */ }
    // A preview of a checked version (WP7): a sandboxed document with an opaque origin, so its own requests arrive as
    // cross-site with Origin "null" or none. It answers only GET, only on this host, and only with that preview's files.
    const preview = path === null ? null : /^\/preview\/([^/]*)\/(.*)$/s.exec(path);
    if (preview) {
      if (req.headers.host !== new URL(origin).host || req.headers.origin && !['null', origin].includes(req.headers.origin)) return send(403, { error: 'Only the local dashboard origin is allowed.' });
      if (req.method !== 'GET') return send(405, { error: 'Method not allowed.' });
      const answer = await previews.serve(preview[1], preview[2]);
      if (res.destroyed) return;
      res.writeHead(answer.status, { 'Content-Type': answer.type, 'Content-Length': Buffer.byteLength(answer.body), 'Cache-Control': 'no-store',
        'Content-Security-Policy': PREVIEW_POLICY, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      return res.end(answer.body);
    }
    // The external campaign API (docs/SUPERVISOR.md section 16): only while config.json switches it on, only its exact
    // method and path pairs, and answered here in full, so an exempt request never reaches another route. Its caller is
    // not a browser (one cannot send the bearer token cross-origin without a CORS answer this server never gives), so
    // the loopback Host/Origin gate below does not apply to it; off, these requests meet that gate exactly as before.
    const apiRoute = path === null ? null : campaignApiRoute(req.method, path);
    if (apiRoute) {
      const config = readConfig(dataDir);
      const settings = campaignApiSettings(config);
      if (settings.enabled) {
        if (settings.port) return send(404, { error: 'Not found.' });
        try {
          const [status, body] = await answerCampaignApi(req, apiRoute, { dataDir, settings, config, provenanceRoot });
          return send(status, body);
        } catch (error) {
          if (error.status) return send(error.status, { error: error.message, ...(typeof error.code === 'string' ? { code: error.code } : {}) });
          return send(503, { error: 'The supervisor is busy or unavailable. Try again later.' });
        }
      }
    }
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
          // A poll that gave up while waiting in the queue is not worked on: it would only delay the next one.
          if (req.socket.destroyed) return undefined;
          // `since`: the viewer's last visit (ms), for "since you last looked"; bounded to the last 30 days.
          const now = Date.now(), raw = Number(new URL(req.url, origin).searchParams.get('since'));
          if (keptState?.raw === raw && now - keptState.at < STATE_KEPT_MS) return send(200, keptState.body);
          const since = Number.isSafeInteger(raw) && raw > 0 ? Math.min(now, Math.max(raw, now - 30 * 86_400_000)) : undefined;
          const { supervisor, merged, owner, work, projects, worklist } = readState(now, since);
          // Home, Settings -> Connections (OWNER_UI_V2 WP1): the same allowlisted views /api/v2 serves, in the one poll.
          const body = JSON.stringify({ observedAt: new Date(now).toISOString(), host: machine, supervisor, roadmap: roadmap.snapshot(),
            merges: { refreshing: merged.refreshing, repositories: merged.repositories }, owner, projects, work, worklist,
            home: home(supervisor, owner, projects), connections: connections(supervisor, merged),
            // First run states what planning costs before anything is planned (WP8): from history, or unavailable.
            ...(projects.addProject ? { planning: planningCost(dataDir) } : {}),
            overviews: Object.fromEntries((projects.projects ?? []).map((row) => [row.id, overviewView(row.id, { supervisor, projects })])) });
          keptState = Date.now() - now >= SLOW_STATE_MS ? { raw, at: Date.now(), body } : null;
          return send(200, body);
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
        // Settings -> Alerts (WP6): the owner's alert rules and the transport's state, never a secret store reference.
        if (path === '/api/v2/settings/alerts') return send(200, alertsView(dataDir));
        // Settings -> Usage (WP8): usage by source, each unit apart, with unknown kept unknown and untracked costs said.
        if (path === '/api/v2/settings/usage') return send(200, usageView(dataDir, readState(Date.now()).supervisor));
        // Knowledge (WP8): the owner's facts and this project's own suggestions, each with where it came from.
        const knowledge = /^\/api\/v2\/projects\/([^/]+)\/knowledge$/.exec(path);
        if (knowledge) {
          let project = null;
          try { project = decodeURIComponent(knowledge[1]); } catch { /* refused below */ }
          return send(200, knowledgeView(dataDir, project));
        }
        // Project settings (WP5): the project id is one encoded segment, so `owner%2Fname/settings` is never an Overview.
        const settings = /^\/api\/v2\/projects\/([^/]+)\/settings$/.exec(path);
        if (settings) {
          let project = null;
          try { project = decodeURIComponent(settings[1]); } catch { /* refused below */ }
          return send(200, projectSettingsView(dataDir, project));
        }
        // Releases (WP9): what reaches users and what can be undone, from the recorded releases; read-only.
        const releasesRoute = /^\/api\/v2\/projects\/([^/]+)\/releases$/.exec(path);
        if (releasesRoute) {
          let project = null;
          try { project = decodeURIComponent(releasesRoute[1]); } catch { /* refused below */ }
          if (!/^(?:[\w.-]+\/[\w.-]+|[\w-]{1,64})$/.test(project ?? '')) return send(404, { error: 'Not found.' });
          const { supervisor, owner, projects } = readState(Date.now());
          const view = releasesView(project, { supervisor, owner, projects });
          return view ? send(200, view) : send(404, { error: 'Not found.' });
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
          return /^[1-9]\d{0,8}$/.test(number) ? send(200, workItemView(dataDir, Number(number), { textChecks })) : send(404, { error: 'Not found.' });
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
      // most about 240 bytes each, so their limit fits the largest valid selection instead of refusing it unread. An
      // edited plan (WP3) holds up to 48 texts of 300 characters, up to 4 bytes each, so it gets the same limit, and so do
      // project settings (WP5): 32 protected areas of 200 characters and 2,000 characters of notes.
      const limit = ['/api/v2/pause', '/api/v2/resume', '/api/work/edit', '/api/v2/projects/settings'].includes(path) ? SCOPED_CONTROL_BYTES : 16_384;
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
      // The caller check's lookup on this request's connection: protected owner actions refuse without it (APPROVAL_UNCHECKED).
      const callerOptions = { ...callerCheck, connection: req.socket };
      const caller = (store) => checkCaller(store, callerOptions);
      // A structured decision (WP2): answer, snooze or "this did not need me", bound to one decision; the action is the address.
      // The caller check runs first, so a program AIWorks started cannot answer, snooze or dismiss an owner decision.
      if (/^\/api\/v2\/decisions\/(?:answer|snooze|not-needed)$/.test(path)) {
        await ownerCaller(dataDir, caller);
        return send(202, applyDecision(dataDir, path.slice('/api/v2/decisions/'.length), value, Date.now()));
      }
      // Review of a result (WP4): accept, or request changes, bound to one verified head and its report; the action is the address.
      // The caller check runs first, so a program AIWorks started can neither accept a result nor send it back for changes.
      if (/^\/api\/v2\/results\/(?:accept|request-changes)$/.test(path)) {
        await ownerCaller(dataDir, caller);
        return send(202, applyResultReview(dataDir, path.slice('/api/v2/results/'.length), value, Date.now()));
      }
      // Mark a report as read: it moves from Reports to read to its project's History. Only the owner reads a report.
      if (path === '/api/v2/results/read') {
        await ownerCaller(dataDir, caller);
        return send(200, markReportRead(dataDir, value));
      }
      // Preview of a checked version (WP7): bound to the same verified head and report as accept. Static pages build and
      // start nothing; a server preview starts the version's own server, so for it the caller check runs first.
      if (path === '/api/v2/results/preview') return send(200, await openResultPreview(dataDir, value, previews, { servers, ownerCheck: () => ownerCaller(dataDir, caller) }));
      // Close a preview: it ends at once, and a server preview's server is stopped. Ending one widens nothing.
      if (path === '/api/v2/results/preview/close') {
        const token = /^\/preview\/([0-9a-f]{32})\//.exec(typeof value?.url === 'string' ? value.url : '')?.[1];
        if (!token) return send(400, { error: 'Invalid dashboard command.' });
        previews.end(token);
        return send(200, { closed: true });
      }
      // Check the site now (WP9): one read-only check of a settled release through the release role (release/health.mjs).
      // It runs a project command, so the caller check runs first: a program AIWorks started cannot make it run one.
      if (path === '/api/v2/releases/check') {
        await ownerCaller(dataDir, caller);
        return send(200, await checkRelease(dataDir, value));
      }
      // Desktop and phone screenshots of that checked version, bound the same way. It starts the installation's Chrome, so the
      // caller check runs first: a program AIWorks started cannot make it start a browser.
      if (path === '/api/v2/results/preview/capture') {
        await ownerCaller(dataDir, caller);
        // A page that goes away before the answer cancels the capture, which stops its browser.
        const gone = new AbortController();
        res.once('close', () => { if (!res.writableEnded) gone.abort(); });
        return send(200, await captureResultPreview(dataDir, value, captures, { signal: gone.signal, servers }));
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
      if (path === '/api/work/requests') return send(202, requestPlanAndDo(dataDir, value));
      // Edit plan (OWNER_UI_V2 WP3): the edited plan becomes the next draft version; nothing is approved or started.
      if (path === '/api/work/edit') return send(200, editPlan(dataDir, value));
      if (path === '/api/work/approve') return send(200, await approvePlan(dataDir, value, Date.now(), { provenanceRoot, ...work, caller: callerOptions }));
      if (path === '/api/work/apply') return send(200, await applyResult(dataDir, value, { ...work, caller: callerOptions }));
      if (path === '/api/work/undo') return send(200, await undoApply(dataDir, value, { ...work, caller: callerOptions }));
      // No route adds, connects, exports or imports a login: any local process can read the CSRF token (aiworks#197).
      if (path === '/api/accounts/remove') return send(200, removeDashboardAccount(dataDir, value));
      if (path === '/api/accounts/preferences') return send(200, saveDashboardModelPreferences(dataDir, value));
      // Add project (UI13): each answers 404 while it is off, as before it existed.
      if (path === '/api/projects/preflight') return send(200, previewProject(dataDir, value, projectConnection));
      if (path === '/api/projects/connect') return send(200, connectProject(dataDir, value, projectConnection));
      // The sample project of First run (WP8): written into the owner's new or empty folder, then connected like any folder.
      if (path === '/api/projects/sample') return send(200, createSampleProject(dataDir, value, projectConnection));
      if (path === '/api/projects/check') return send(200, checkConnectedProject(dataDir, value, projectConnection));
      if (path === '/api/projects/relocate') return send(200, relocateConnectedProject(dataDir, value, projectConnection));
      if (path === '/api/projects/disconnect') return send(200, disconnectConnectedProject(dataDir, value));
      // Remove from Projects decides from the Projects screen as it reads now, with no removal applied.
      if (path === '/api/projects/remove') {
        const now = Date.now(), supervisor = supervisorSnapshot(dataDir, now, { textChecks });
        const merged = merges?.snapshot() ?? { refreshing: false, repositories: [], steps: {} };
        const records = projectConnectionEnabled(dataDir) ? connectedProjects(dataDir) : [];
        const owner = ownerView(supervisor, merged, { host: machine.name, now, releases, delegation: configuredMergeDelegation(dataDir), connected: records,
          workList: workListView(dataDir, { closeOn: workList.available }), readReports: readReports(dataDir) });
        return send(200, removeProject(dataDir, value, projectsView(supervisor, owner, { repositories: configuredRepositories(dataDir), records, now }), now));
      }
      if (path === '/api/projects/restore') return send(200, restoreProject(dataDir, value));
      // Project rules (UI16): the review only reads; confirm, renew and revoke run the caller check on this request's
      // connection first, so a program AIWorks started cannot write them (PROJECT_CONNECTION §7.4).
      if (path === '/api/projects/rules') return send(200, projectRulesView(dataDir, value));
      if (path === '/api/projects/rules/confirm') return send(200, await confirmProjectRules(dataDir, value, { caller }));
      if (path === '/api/projects/rules/revoke') return send(200, await revokeProjectRules(dataDir, value, { caller }));
      // Project settings (WP5): the caller check runs first; the save binds the version the page showed and a request id.
      if (path === '/api/v2/projects/settings') return send(200, await saveProjectSettings(dataDir, value, { caller }));
      // Alert rules (WP6): the caller check runs first, so no program AIWorks started can mute the owner's alerts.
      if (path === '/api/v2/settings/alerts') return send(200, await saveAlerts(dataDir, value, { caller }));
      // Knowledge (WP8): the caller check runs first, so only the owner confirms, edits or sets aside a fact.
      if (path === '/api/v2/projects/knowledge') return send(200, await saveKnowledge(dataDir, value, { caller }));
      // The local work list (UI20): every change runs the caller check first and binds the version and request id it was sent with.
      if (path === '/api/work-list/items') return send(200, await createWorkItem(dataDir, value, { caller }));
      if (path === '/api/work-list/comment') return send(200, await commentWorkItem(dataDir, value, { caller }));
      if (path === '/api/work-list/state') return send(200, await setWorkItemState(dataDir, value, { caller }));
      // Trust the commits the owner put on local main by hand (AW-005): the caller check runs first; it binds both tips the page showed.
      if (path === '/api/v2/settings/trusted-main') return send(200, await recordTrustedMain(dataDir, value, { caller }));
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
  server.once('close', () => { void textChecks.close(); captures.close(); void previews.close(); void servers.close(); });
  return server;
}
