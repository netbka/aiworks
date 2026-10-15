// Projects from today's data (docs/design/OWNER_WORKSPACE.md slice S2, build slice UI3): one row per GitHub repository
// that has work on this computer or is listed in the supervisor's config.json, each with one state and one next action.
// The list joins the campaigns' target repositories with the configured ones, grouped case-insensitively. The state is
// built from the owner view, so a project never reads calmer than its Needs me items; no campaign id is used at the
// primary level.
// Add project (PROJECT_CONNECTION slice S6 with OWNER_WORKSPACE slice S11, build slice UI13): the owner connects a GitHub
// checkout, a local Git repository or a plain folder through the supervisor's project connection API
// (src/supervisor/project-connect.mjs). Connecting only reads the owner's folder. It is off unless the data directory's
// config.json says "projectConnection": { "enabled": true }; off, the page and the routes are exactly as before.
// Starting work on a project without GitHub stays off (LOCAL_START_OFF) until the owner decides #24 and #32.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { Store } from '../supervisor/store.mjs';
import { registryEntriesFor } from '../supervisor/campaign.mjs';
import { configuredGovernanceRoot } from '../supervisor/governance.mjs';
import { checkFolderProject, checkGithubProject, checkLocalGitProject, connectCopy, connectFolderProject, connectGithubProject,
  connectLocalGitProject, folderMatches, MirrorError, ProjectError, relocateFolderProject, relocateLocalGitProject } from '../supervisor/project-connect.mjs';
import { preflight } from '../supervisor/project-preflight.mjs';
import { disconnectProject, PROJECT_ID, projects as projectRecords, SOURCE_KINDS } from '../supervisor/projects.mjs';

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/;
const ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/;
const TERMINAL = ['finished', 'cancelled'];
/** Display order: projects that need the owner, then those with work running, then the rest by last activity. */
const RANK = { 'needs-you': 0, 'needs-setup': 0, running: 1 };

/**
 * The repositories the supervisor's config.json lists for this computer (`repositories.<owner/name>`). Names only:
 * the configured checkout path is never read out or served.
 */
export function configuredRepositories(dataDir) {
  let config;
  try { config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { return []; }
  const listed = config?.repositories;
  return listed && typeof listed === 'object' && !Array.isArray(listed) ? Object.keys(listed).filter((name) => REPOSITORY.test(name)) : [];
}

const label = (task) => task?.outcome ?? task?.title ?? 'a step';
const lastActivity = (campaigns) => Math.max(0, ...campaigns.map((c) => Date.parse(c.lastProgressAt ?? '') || c.registeredAt || 0)) || null;

/** The one next action for a project whose Needs me items are `items`: the item's own link when there is one item. */
function needsAction(items) {
  const [item] = items, url = items.length === 1 ? item.link?.url ?? '' : '';
  const pr = PR_URL.exec(url);
  if (pr) return { label: `Review pull request #${pr[1]}`, url };
  if (ISSUE_URL.test(url)) return { label: 'Open the step issue', url };
  return { label: items.length === 1 ? 'See what needs you' : `See all ${items.length} in Needs me`, route: { screen: 'needs' } };
}

/** One state, in plain words, for a project with active (not finished or cancelled) work and nothing for the owner. */
function activeState(active) {
  const agents = active.flatMap((c) => c.agents.map((agent) => ({ agent, task: c.tasks.find((task) => task.id === agent.taskId) })));
  const building = agents.find(({ agent }) => agent.role === 'Implementer'), checking = agents.find(({ agent }) => agent.role === 'Verifier');
  if (building) return { key: 'running', text: `Working on: ${label(building.task)}.` };
  if (checking) return { key: 'running', text: `Checking: ${label(checking.task)}.` };
  const going = active.filter((c) => c.control !== 'paused');
  if (!going.length) return { key: 'paused', text: 'Paused. No new step starts.' };
  if (going.some((c) => c.waitingReason === 'provider-availability')) return { key: 'running', text: 'Waiting for an AI worker to be free. Work continues by itself.' };
  if (going.every((c) => c.control === 'cancel-requested')) return { key: 'running', text: 'Cancelling: waiting for running workers to stop.' };
  return { key: 'running', text: 'No AI worker is busy on this project right now.' };
}

/**
 * The Projects screen. `supervisor` is supervisorSnapshot, `owner` is ownerView of it, `repositories` the configured
 * repository names (configuredRepositories). Each project: `id` (the repository, its address on the page), a short
 * `name`, `kind`, one `state` ({ key, text }) and one `action` ({ label, url } for a GitHub link or { label, route }
 * for a screen of this page). Repository owner and the number of pieces of work are details.
 * `records` are the connected project records (connectedProjects) when Add project is on: a GitHub project joins its
 * repository's row, and a local Git project or plain folder is a row of its own, addressed by its project id. A row
 * with a record carries `connection` (connectionView, without the folder's path). `addProject` says whether the page
 * offers Add project.
 */
export function projectsView(supervisor, owner, { repositories = [], records = [], addProject = false } = {}) {
  if (!supervisor?.available) return { available: false, ...(addProject ? { addProject } : {}), projects: [] };
  const groups = new Map();
  const group = (repository) => {
    const key = repository.toLowerCase();
    if (!groups.has(key)) groups.set(key, { repository, configured: false, campaigns: [], record: null });
    return groups.get(key);
  };
  // The configured spelling names the project when there is one; otherwise the first campaign's.
  for (const repository of repositories) if (REPOSITORY.test(repository)) group(repository).configured = true;
  for (const c of supervisor.campaigns) if (REPOSITORY.test(c.repository ?? '')) group(c.repository).campaigns.push(c);
  for (const record of records) if (record.source_kind === 'github' && REPOSITORY.test(record.github_repository ?? '')) group(record.github_repository).record = record;
  const items = owner?.items ?? [];
  const projects = [...groups.values()].map(({ repository, configured, campaigns, record }) => {
    const route = (tab) => ({ screen: 'project', project: repository, tab });
    const mine = items.filter((item) => item.repository?.toLowerCase() === repository.toLowerCase());
    const active = campaigns.filter((c) => !TERMINAL.includes(c.control));
    const connection = record ? connectionView(record, { path: false }) : null;
    let state, action;
    if (mine.length) {
      state = { key: 'needs-you', text: mine.length === 1 ? 'One thing needs you.' : `${mine.length} things need you.` };
      action = needsAction(mine);
    } else if (connection && connection.status !== 'ready') {
      // The connection needs the owner, or is away for now: its one sentence, and the project where Check again is.
      state = { key: connection.status, text: connection.message };
      action = { label: 'Open project', route: route('now') };
    } else if (active.length) {
      state = activeState(active);
      action = { label: 'Open current work', route: route('work') };
    } else if (campaigns.length) {
      // The most recent finished or cancelled piece of work, in the owner view's own words.
      const latest = [...campaigns].sort((a, b) => lastActivity([b]) - lastActivity([a]))[0], view = owner?.campaigns?.[latest.id];
      const text = latest.control === 'cancelled' ? view?.outcome ?? 'Cancelled' : view?.finished ?? 'All steps are finished';
      state = { key: latest.control === 'cancelled' ? 'cancelled' : 'finished', text: /[.!?]$/.test(text) ? text : `${text}.` };
      action = { label: 'See results', route: route('results') };
    } else {
      state = { key: 'no-work', text: 'No work yet.' };
      action = { label: 'Open project', route: route('now') };
    }
    return { id: repository, name: repository.split('/')[1], repository, kind: 'GitHub', state, action, lastActivityAt: lastActivity(campaigns),
      details: { owner: repository.split('/')[0], work: campaigns.length, configured, needsYou: mine.length }, ...(connection ? { connection } : {}) };
  });
  // Two repositories with the same name under different owners keep their owner in the name.
  const shared = projects.filter((project) => projects.some((other) => other !== project && other.name.toLowerCase() === project.name.toLowerCase()));
  for (const project of shared) project.name = project.repository;
  // Local Git projects and plain folders: no work can start there yet, so their state is their connection's.
  for (const record of records.filter((item) => item.source_kind !== 'github')) {
    const connection = connectionView(record, { path: false });
    projects.push({ id: record.id, name: record.name, repository: null, kind: connection.kind,
      state: connection.status === 'ready' ? { key: 'ready', text: connection.startWork.text } : { key: connection.status, text: connection.message },
      action: { label: 'Open project', route: { screen: 'project', project: record.id, tab: 'now' } }, lastActivityAt: record.updated_at ?? null,
      details: { owner: null, work: 0, configured: false, needsYou: 0 }, connection });
  }
  projects.sort((a, b) => (RANK[a.state.key] ?? 2) - (RANK[b.state.key] ?? 2) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.name.localeCompare(b.name));
  return { available: true, ...(addProject ? { addProject } : {}), projects };
}

// ---------------------------------------------------------------------------------------------------------------------
// Add project (build slice UI13).

const KIND_WORDS = Object.freeze({ github: 'GitHub', 'local-git': 'Local Git', folder: 'Folder' });
const STATUS_WORDS = Object.freeze({ ready: 'Ready', 'needs-setup': 'Needs setup', unavailable: 'Temporarily unavailable' });

/**
 * The owner-facing copy of PROJECT_CONNECTION §8.1 and the Git detection rows of §8.2, exactly as written there. `{…}`
 * are placeholders. The codes connect adds (§8.2 to §8.4) are worded by the supervisor's connectCopy.
 */
export const PROJECT_COPY = Object.freeze({
  PATH_NOT_ABSOLUTE: 'Enter the full folder path, for example D:\\Projects\\my-app.',
  PATH_NOT_FOUND: "AIWorks can't find this folder. Check the path and try again.",
  PATH_NOT_DIRECTORY: "This is a file, not a folder. Choose the project's folder.",
  PATH_NETWORK: "Network folders aren't supported. Copy the project to a drive on this computer and connect it there.",
  PATH_PROTECTED: "AIWorks can't use this folder: it's a drive, a system folder or part of AIWorks itself. Choose a project folder.",
  PATH_OVERLAP: `This folder overlaps the project "{name}". Projects can't be inside each other.`,
  PATH_UNREADABLE: "AIWorks can't read this folder. Check that your Windows account can open it.",
  PATH_IS_LINK: 'This path leads to {canonical}. AIWorks will use that folder.',
  ALREADY_CONNECTED: 'This folder is already connected as "{name}".',
  ROOT_MISSING: "AIWorks can't reach {path}. If it's on a removable drive, plug it in.",
  ROOT_REPLACED: `The folder at {path} was replaced. Confirm it's still "{name}" before work continues.`,
  IDENTITY_CHANGED: '{path} now holds a different project ({was} → {now}). AIWorks stopped work here.',
  GOVERNANCE_ROOT_MISSING: "AIWorks can't read the project rules from governance provider. Set up the rules folder in Settings.",
  GIT_CLI_MISSING: "AIWorks can't find Git on this computer. Set the Git path in Settings.",
  GIT_SUBFOLDER: 'This folder is inside the Git repository {top}. Connect {top} instead.',
  GIT_WORKTREE: 'This folder is a Git worktree. Connect the main checkout at {main} instead.',
  GIT_BARE: 'This is a bare Git repository with no files. Connect a normal checkout.',
  GIT_UNTRUSTED: "Git doesn't trust this folder because another Windows account owns it. Fix the owner, or add it to Git's safe.directory yourself; AIWorks won't change Git settings.",
  // The design names these outcomes but gives no copy; they follow its style.
  NOT_GITHUB: 'This folder has no GitHub remote. Connect it as a local Git project or a plain folder.',
  NOT_SAME_PROJECT: `This folder doesn't hold "{name}". Choose the folder it moved to.`,
});
/** What the connect codes need filled before connectCopy can say them; without it the status sentence stands in. */
const NEEDS = Object.freeze({ BRANCH_MISSING: ['branch'], REGISTRY_AMBIGUOUS: ['ids'], CONFIG_CONFLICT: ['configPath', 'root'], UNCOMMITTED_NOTICE: ['sha7'],
  MIRROR_SPACE: ['need', 'free', 'drive'], SECRET_TRACKED: ['count'], LOCAL_BRANCH_MISSING: ['branch'], PROJECT_MOVED: ['was'], TOO_LARGE: ['files', 'bytes'],
  FILE_TOO_LARGE: ['count'], UNREADABLE_FILES: ['count'], CASE_COLLISION: ['a', 'b'] });
/** When a saved project's code cannot be said in full here (its detail is only known during a check). */
const STATUS_FALLBACK = Object.freeze({ 'needs-setup': 'Needs setup. Choose Check again to see what to do.',
  unavailable: 'Temporarily unavailable. Choose Check again when it should be back.' });
/** OWNER_WORKSPACE §5.2, step 5: a GitHub project that governance provider does not list. No button: the fix is there. */
export const UNREGISTERED = 'This project is not registered with governance provider yet, so AIWorks cannot start work on it. Registering it is done in governance provider.';
/** OWNER_WORKSPACE §5.3: what a connected project without GitHub says, and (in details) what it waits for. */
export const LOCAL_START = Object.freeze(['Connected. Starting work in a folder without GitHub is not available yet.',
  'It waits for a local project identity in governance provider (D2, #24) and a local approval route (D4, #32).']);
/** OWNER_WORKSPACE §5.3, step 2: what AIWorks promises before a project without GitHub is connected. */
export const OWN_COPY = 'AIWorks will never change this folder directly. It works on its own copy and asks you before applying a checked result.';

/** The sentence for `code`, or null when the code has no copy or the detail it needs is missing. */
export function projectMessage(code, detail = {}) {
  if (Object.hasOwn(PROJECT_COPY, code)) {
    let missing = false;
    const text = PROJECT_COPY[code].replace(/\{(\w+)\}/g, (_, key) => {
      if (detail[key] === undefined || detail[key] === null || detail[key] === '') missing = true;
      return String(detail[key]);
    });
    return missing ? null : text;
  }
  if ((NEEDS[code] ?? []).some((key) => detail[key] === undefined || detail[key] === null)) return null;
  return connectCopy(code, detail);
}

/**
 * The one action a code offers on this page (the Action column of §8), or null: the others (Review, Choose branch, Edit
 * exclusions, Rebuild copy) are not part of this slice, so no button leads nowhere. `do` says what the page does.
 */
export function projectAction(code, detail = {}) {
  switch (code) {
    case 'PATH_OVERLAP': case 'ALREADY_CONNECTED':
      return detail.route ? { do: 'open', label: `Open "${detail.name}"`, project: detail.route } : null;
    case 'PATH_IS_LINK': return detail.canonical ? { do: 'use-path', label: 'Use this folder', path: detail.canonical } : null;
    case 'GIT_SUBFOLDER': return detail.top ? { do: 'use-path', label: `Use ${detail.top}`, path: detail.top } : null;
    case 'GIT_WORKTREE': return detail.main ? { do: 'use-path', label: `Use ${detail.main}`, path: detail.main } : null;
    case 'GIT_NO_COMMITS': return { do: 'kind', label: 'Connect as plain folder', kind: 'folder' };
    case 'GOVERNANCE_ROOT_MISSING': case 'GIT_CLI_MISSING': case 'CONFIG_CONFLICT': return { do: 'settings', label: 'Open Settings' };
    case 'PROJECT_MOVED': return detail.projectId ? { do: 'move', label: `Move "${detail.name}" here`, projectId: detail.projectId } : null;
    case 'PATH_UNREADABLE': case 'ROOT_MISSING': case 'GH_MISSING': case 'GH_SIGNED_OUT': case 'GH_NO_ACCESS': case 'GH_UNREACHABLE':
    case 'REGISTRY_MISSING': case 'REGISTRY_AMBIGUOUS': case 'REGISTRY_INVALID': case 'GIT_UNTRUSTED': case 'MIRROR_SPACE': case 'CHANGED_DURING_COPY':
      return { do: 'check', label: 'Check again' };
    default: return null;
  }
}

/** The page address of a connected project: its repository for GitHub (where its work is), else its project id. */
const routeOf = (record) => (record.source_kind === 'github' ? record.github_repository : record.id);
/** A path the owner configured for another place is said by its folder name only; the owner's own project root is whole. */
const shown = (detail = {}) => ({ ...detail, ...(detail.configPath ? { configPath: basename(String(detail.configPath)) } : {}) });

/**
 * A connected project as the page shows it. `path: true` adds the owner's own project root, the one absolute path a
 * response may carry (plan §6.7, UI13); /api/state never carries it. Mirror, worktree and data paths are never included.
 */
export function connectionView(record, { path = true } = {}) {
  const local = record.source_kind !== 'github';
  const detail = { name: record.name, path: record.root_path, root: record.root_path, repository: record.github_repository, branch: record.base_branch ?? record.local_branch };
  const message = record.status === 'ready' ? null : record.reason === 'REGISTRY_MISSING' ? UNREGISTERED
    : (path ? projectMessage(record.reason, detail) : projectMessage(record.reason, { ...detail, path: record.name, root: record.name })) ?? STATUS_FALLBACK[record.status];
  const startWork = record.capabilities?.startWork?.allowed ? { allowed: true, text: null, detail: null }
    : local ? { allowed: false, text: LOCAL_START[0], detail: LOCAL_START[1] }
      : { allowed: false, text: record.reason === 'REGISTRY_MISSING' ? UNREGISTERED : 'Work can’t start here until this project is ready.', detail: null };
  return { id: record.id, route: routeOf(record), name: record.name, kind: KIND_WORDS[record.source_kind], sourceKind: record.source_kind,
    version: record.version, status: record.status, statusWords: STATUS_WORDS[record.status], reason: record.reason ?? null, message,
    ...(path ? { root: record.root_path } : {}), folder: basename(record.root_path), repository: record.github_repository ?? null,
    branch: record.base_branch ?? record.local_branch ?? null,
    baseline: record.current_baseline ? { seq: record.current_baseline.seq, at: record.current_baseline.at } : null,
    startWork, connectedAt: record.created_at };
}

const readConfig = (dataDir) => {
  try { const value = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
};
/** The switch: Add project is on only when config.json says "projectConnection": { "enabled": true }. Read on every request. */
export const projectConnectionEnabled = (dataDir) => readConfig(dataDir).projectConnection?.enabled === true;

/** Live project records, read-only; none when the store or its project tables cannot be read. */
export function connectedProjects(dataDir) {
  const path = join(dataDir, 'supervisor.db');
  if (!existsSync(path)) return [];
  let store;
  try { store = new Store(path, { readOnly: true }); return projectRecords(store); } catch { return []; } finally { store?.close(); }
}

const fail = (status, message) => Object.assign(new Error(message), { status });
const notFound = () => fail(404, 'Not found.');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUTS = Object.freeze({
  preflight: ['path', 'kind'], connect: ['path', 'kind', 'name', 'id', 'asNewProject', 'requestId'], check: ['projectId', 'requestId'],
  relocate: ['projectId', 'path', 'confirm', 'requestId'], disconnect: ['projectId', 'version', 'requestId'],
});

/** The request's own fields only, each of its kind; anything else is refused before the store is opened. */
function readInput(action, input) {
  const bad = () => fail(400, 'Invalid request.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !INPUTS[action].includes(key))) throw bad();
  if (INPUTS[action].includes('path') && (typeof input.path !== 'string' || input.path.length > 1024)) throw bad();
  if (input.kind !== undefined && !SOURCE_KINDS.includes(input.kind)) throw bad();
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\u0000-\u001f\u007f]/.test(input.name))) throw bad();
  if (input.id !== undefined && (typeof input.id !== 'string' || !PROJECT_ID.test(input.id))) throw bad();
  for (const flag of ['asNewProject', 'confirm']) if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw bad();
  if (INPUTS[action].includes('projectId') && (typeof input.projectId !== 'string' || !PROJECT_ID.test(input.projectId))) throw bad();
  if (action === 'disconnect' && (!Number.isSafeInteger(input.version) || input.version < 1)) throw bad();
  if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !UUID.test(input.requestId))) throw bad();
  return input;
}

/**
 * The options every connect call gets: the governance checkout and Git command from config.json, and the places a
 * project can never be: the data directory, AIWorks's mirrors and worktrees, and every configured worktree root (design
 * §4.1). `inject` is for tests only (synthetic gh, branch reads, gitEnv, statfs); the HTTP server is given none live.
 */
function connectOptions(dataDir, inject) {
  const config = readConfig(dataDir);
  const home = dirname(resolve(dataDir));
  const worktreeRoots = Object.values(config.repositories ?? {}).map((entry) => entry?.worktreeRoot).filter((path) => typeof path === 'string' && path);
  const git = Array.isArray(config.commands?.git) && config.commands.git.length ? config.commands.git : ['git'];
  return { config, dataDir, governanceRoot: configuredGovernanceRoot(dataDir), git, ...inject,
    protectedRoots: [dataDir, join(home, 'mirrors'), join(home, 'worktrees'), ...worktreeRoots, ...(inject.protectedRoots ?? [])] };
}

/** Open the supervisor store for one request; the routes never create a missing one. */
function withStore(dataDir, work, { readOnly = false } = {}) {
  const path = join(dataDir, 'supervisor.db');
  if (!existsSync(path)) throw fail(503, 'Supervisor is unavailable.');
  const store = new Store(path, readOnly ? { readOnly: true } : undefined);
  try { return work(store); } catch (error) {
    if (error instanceof ProjectError) {
      if (error.code === 'PROJECT_NOT_FOUND' || error.code === 'PROJECT_DISCONNECTED') throw fail(404, 'This project is not connected. Refresh the page.');
      throw fail(409, error.message);
    }
    if (error?.name === 'ConflictError') throw fail(409, 'This project changed since this view was loaded. Refresh and try again.');
    // A copy that could not be made never names a path: the owner's folder is only read, so it is unchanged.
    if (error instanceof MirrorError) throw fail(503, "AIWorks couldn't finish its copy of this folder. Your folder is unchanged. Try again.");
    throw error;
  } finally { store.close(); }
}

/** A refusal or problem, in the page's words: { ok: false, code, status, message, action }. */
function outcome(code, status, detail, records) {
  const route = detail?.projectId ? records.find((record) => record.id === detail.projectId) : null;
  const filled = { ...shown(detail), ...(route ? { route: routeOf(route), name: route.name } : {}) };
  return { ok: false, code, status: status ?? null, message: projectMessage(code, filled) ?? STATUS_FALLBACK[status] ?? STATUS_FALLBACK['needs-setup'],
    action: projectAction(code, filled) };
}
const noticesOf = (notices = []) => notices.map((notice) => ({ code: notice.code, message: projectMessage(notice.code, notice) })).filter((notice) => notice.message);

/** What preflight found, in the words of OWNER_WORKSPACE §4.11. */
function foundText(found) {
  if (found.proposedKind === 'github') return `Git repository with GitHub remote ${found.repository ?? ''}${found.branch ? `, main branch ${found.branch}` : ''}`.replace(/ ,/, ',');
  return found.proposedKind === 'folder' ? 'Ordinary folder, no Git' : 'Git repository, no GitHub remote';
}

/**
 * POST /api/projects/preflight: what the folder is, read-only (design §4). Nothing is saved and nothing is copied.
 * Returns { ok, found: { kind, kinds, text, folder, root, repository, branch, registered, notes }, notices, confirm } or
 * a refusal with its copy and action.
 */
export function previewProject(dataDir, input, inject = {}) {
  if (!projectConnectionEnabled(dataDir)) throw notFound();
  const { path, kind } = readInput('preflight', input);
  const options = connectOptions(dataDir, inject);
  return withStore(dataDir, (store) => {
    const records = projectRecords(store);
    const home = dirname(resolve(dataDir));
    const found = preflight(path, { ...options, projects: records, kind, mirrorParent: home, io: inject.statfs ? { statfs: inject.statfs } : undefined });
    if (!found.ok) return outcome(found.code, found.status, found.code === 'MIRROR_SPACE' ? { ...found.detail, drive: parse(home).root } : found.detail, records);
    let registered = null;
    if (found.kind === 'github') { try { registered = registryEntriesFor(found.repository, options.governanceRoot).length > 0; } catch { registered = false; } }
    const notes = [found.kind === 'github' && registered === false ? UNREGISTERED : null,
      found.kind !== 'github' ? OWN_COPY : null, found.kind !== 'github' ? LOCAL_START[0] : null].filter(Boolean);
    return { ok: true, code: null, found: { kind: found.kind, kindWords: KIND_WORDS[found.kind],
      kinds: found.proposedKind === 'github' ? ['github', 'local-git'] : [found.kind], text: foundText(found), folder: basename(found.root), root: found.root,
      repository: found.repository ?? null, branch: found.branch ?? null, registered, notes },
      confirm: found.confirm ? { code: found.confirm.code, message: projectMessage(found.confirm.code, found.confirm), action: projectAction(found.confirm.code, found.confirm) } : null,
      notices: noticesOf(found.notices) };
  }, { readOnly: true });
}

/**
 * POST /api/projects/connect: connect the folder through the supervisor's project connection API as `kind` (else as
 * preflight proposes). The folder is only read. The same folder again opens the same project, so a repeat is safe.
 * Returns { ok, code, status, message, action, notices, project } where project is connectionView (with the root).
 */
export function connectProject(dataDir, input, inject = {}) {
  if (!projectConnectionEnabled(dataDir)) throw notFound();
  const { path, name, id, asNewProject } = readInput('connect', input);
  const options = connectOptions(dataDir, inject);
  return withStore(dataDir, (store) => {
    let kind = input.kind;
    const records = projectRecords(store);
    if (!kind) {
      const found = preflight(path, { ...options, projects: records });
      if (!found.ok && found.code !== 'ALREADY_CONNECTED') return outcome(found.code, found.status, found.detail, records);
      kind = found.kind;
    }
    const request = { path, ...(name ? { name: name.trim() } : {}), ...(id ? { id } : {}), ...(asNewProject ? { asNewProject } : {}) };
    const result = kind === 'github' ? connectGithubProject(request, { store, ...options })
      : kind === 'local-git' ? connectLocalGitProject(request, { store, ...options })
        : connectFolderProject(request, { store, ...options });
    const after = projectRecords(store);
    if (result.ok) {
      return { ok: true, code: null, status: result.project.status, message: null, action: null,
        notices: [...noticesOf(result.notices ?? []), ...(result.preflight?.code === 'ALREADY_CONNECTED' ? [{ code: 'ALREADY_CONNECTED', message: projectMessage('ALREADY_CONNECTED', { name: result.project.name }) }] : [])],
        project: connectionView(result.project) };
    }
    if (result.project) {
      // Saved with a problem (a GitHub project that needs setup): the project exists and says what to do.
      const configured = Object.entries(options.config.repositories ?? {}).find(([key]) => key.toLowerCase() === String(result.project.github_repository).toLowerCase())?.[1];
      const detail = { repository: result.project.github_repository, branch: result.project.base_branch, configPath: configured?.path, root: result.project.root_path };
      const said = outcome(result.code, result.status, detail, after);
      return { ...said, message: result.code === 'REGISTRY_AMBIGUOUS' ? result.message : said.message, notices: [], project: connectionView(result.project) };
    }
    return { ...outcome(result.code, result.status, result.detail ?? result.preflight?.detail ?? {}, after), notices: [], project: null };
  });
}

/** The supervisor's Check again for this project's kind. */
function checkByKind(store, record, options) {
  if (record.source_kind === 'github') return checkGithubProject(store, record.id, options);
  return record.source_kind === 'local-git' ? checkLocalGitProject(store, record.id, options) : checkFolderProject(store, record.id, options);
}

/** A live record by id, or 404. */
function liveRecord(store, projectId) {
  const record = projectRecords(store).find((item) => item.id === projectId);
  if (!record) throw fail(404, 'This project is not connected. Refresh the page.');
  return record;
}

/** POST /api/projects/check: Check again (design §3.3). The status is saved; the folder is only read. */
export function checkConnectedProject(dataDir, input, inject = {}) {
  if (!projectConnectionEnabled(dataDir)) throw notFound();
  const { projectId } = readInput('check', input);
  const options = connectOptions(dataDir, inject);
  return withStore(dataDir, (store) => {
    const record = liveRecord(store, projectId);
    const result = checkByKind(store, record, options);
    const project = connectionView(result.project);
    if (result.ok) return { ok: true, code: null, status: result.status, message: null, action: null, notices: noticesOf(result.notices ?? []), project };
    const detail = { name: record.name, path: record.root_path, root: record.root_path, repository: record.github_repository, branch: record.base_branch ?? record.local_branch, ...result.detail };
    return { ...outcome(result.code, result.status, detail, projectRecords(store)), notices: [], project };
  });
}

/**
 * POST /api/projects/relocate: Move "{name}" here (design §4.6). A local Git project moves when the folder holds the
 * same repository. A plain folder has nothing to prove that, so the first request returns how many files match the
 * last copy, and only `confirm: true` moves it. A GitHub project is not moved here.
 */
export function relocateConnectedProject(dataDir, input, inject = {}) {
  if (!projectConnectionEnabled(dataDir)) throw notFound();
  const { projectId, path, confirm } = readInput('relocate', input);
  const options = connectOptions(dataDir, inject);
  return withStore(dataDir, (store) => {
    const record = liveRecord(store, projectId);
    if (record.source_kind === 'github') throw fail(409, 'Moving a GitHub project is not available here. Disconnect it, then add its new folder.');
    if (record.source_kind === 'folder' && !confirm) {
      const others = projectRecords(store).filter((item) => item.id !== projectId);
      const found = preflight(path, { ...options, projects: others, kind: 'folder', exclusions: record.exclusions, protectedRoots: [...options.protectedRoots, record.mirror_root] });
      if (!found.ok) return { ...outcome(found.code, found.status, found.detail, others), match: null };
      if (found.kind !== 'folder') return { ...outcome('NOT_SAME_PROJECT', 'not-saved', { name: record.name }, others), match: null };
      const match = folderMatches(store, projectId, found.root);
      return { ok: true, confirm: true, code: null, match, action: { do: 'move', label: `Move "${record.name}" here`, projectId },
        message: match ? `${match.matches} of ${match.files} files here match AIWorks's last copy of "${record.name}".` : `AIWorks can't compare this folder with its copy of "${record.name}".` };
    }
    const result = record.source_kind === 'folder' ? relocateFolderProject(store, projectId, path, options) : relocateLocalGitProject(store, projectId, path, options);
    if (result.ok) return { ok: true, code: null, message: null, action: null, project: connectionView(result.project) };
    const code = result.code === 'IDENTITY_CHANGED' || result.code === 'NOT_FOLDER' ? 'NOT_SAME_PROJECT' : result.code;
    return { ...outcome(code, result.status, { ...result.detail, name: record.name }, projectRecords(store)), project: connectionView(result.project) };
  });
}

/** POST /api/projects/disconnect: keeps the record as a tombstone; deletes no history, copy or worktree (design §4.6). */
export function disconnectConnectedProject(dataDir, input, now = Date.now()) {
  if (!projectConnectionEnabled(dataDir)) throw notFound();
  const { projectId, version } = readInput('disconnect', input);
  return withStore(dataDir, (store) => {
    const record = liveRecord(store, projectId);
    disconnectProject(store, record.id, version, now);
    return { ok: true, code: null, message: `Disconnected "${record.name}". AIWorks kept its history and its copy; your folder was not touched.`, action: null };
  });
}

/** GET /api/projects: the connected projects, each with the owner's own project root. */
export function listConnectedProjects(dataDir) {
  if (!projectConnectionEnabled(dataDir)) throw notFound();
  return { available: existsSync(join(dataDir, 'supervisor.db')), projects: connectedProjects(dataDir).map((record) => connectionView(record)) };
}
