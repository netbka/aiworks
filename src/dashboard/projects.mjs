// Projects from today's data (docs/design/OWNER_WORKSPACE.md slice S2, build slice UI3): one row per GitHub repository
// that has work on this computer or is listed in the supervisor's config.json, each with one state and one next action.
// The list joins the campaigns' target repositories with the configured ones, grouped case-insensitively. The state is
// built from the owner view, so a project never reads calmer than its Needs me items; no campaign id is used at the
// primary level.
// Add project (PROJECT_CONNECTION slice S6 with OWNER_WORKSPACE slice S11, build slice UI13): the owner connects a GitHub
// checkout, a local Git repository or a plain folder through the supervisor's project connection API
// (src/supervisor/project-connect.mjs). Connecting only reads the owner's folder. It is off unless the data directory's
// config.json says "projectConnection": { "enabled": true }; off, the page and the routes are exactly as before.
// Starting work on a project without GitHub stays off (LOCAL_START_OFF) until the owner decides #24 and #32; the page says
// so in owner words, and names those decisions only in Settings › Diagnostics (aiworks#11 review 5 G3).
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { Store } from '../supervisor/store.mjs';
import { registryEntriesFor } from '../supervisor/campaign.mjs';
import { configuredGovernanceRoot } from '../supervisor/governance.mjs';
import { checkFolderProject, checkGithubProject, checkLocalGitProject, connectCopy, connectFolderProject, connectGithubProject,
  connectLocalGitProject, folderMatches, MirrorError, ProjectError, relocateFolderProject, relocateLocalGitProject } from '../supervisor/project-connect.mjs';
import { preflight } from '../supervisor/project-preflight.mjs';
import { disconnectProject, PROJECT_ID, projects as projectRecords, SOURCE_KINDS } from '../supervisor/projects.mjs';
import { nowView } from './copy.mjs';

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/;
const ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/;
const TERMINAL = ['finished', 'cancelled'];
/** Display order: projects that need the owner, then those with work running, then the rest by last activity. */
const RANK = { 'needs-you': 0, 'needs-setup': 0, checking: 0, running: 1, 'possibly-stuck': 1, stopped: 1, fault: 1 };
/** A project's state key from the Now state it shows; every other Now state of active work is running. */
const KEYS = { paused: 'paused', 'possibly-stuck': 'possibly-stuck', 'supervisor-stopped': 'stopped', 'paused-stopped': 'stopped', 'supervisor-fault': 'fault' };

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

/**
 * A merge check that can still come shortly leaves results unknown (OWNER_WORKSPACE §7.4 "Never loaded"): any of them may
 * be waiting for the owner, so a state built without them is partial, never final (§1 rule 3; aiworks#11 review 4 F3).
 */
const checkingText = (n) => `Checking GitHub… The state of ${n} result${n === 1 ? '' : 's'} is not known yet.`;

const lastActivity = (campaigns) => Math.max(0, ...campaigns.map((c) => Date.parse(c.lastProgressAt ?? '') || c.registeredAt || 0)) || null;

/** The one next action for a project whose Needs me items are `items`: the item's own link when there is one item. */
function needsAction(items) {
  const [item] = items, url = items.length === 1 ? item.link?.url ?? '' : '';
  const pr = PR_URL.exec(url);
  if (pr) return { label: `Review pull request #${pr[1]}`, url };
  if (ISSUE_URL.test(url)) return { label: 'Open the step issue', url };
  return { label: items.length === 1 ? 'See what needs you' : `See all ${items.length} in Needs me`, route: { screen: 'needs' } };
}

/**
 * One state, in plain words, for a project with active (not finished or cancelled) work and nothing for the owner: the
 * sentence its Now screen leads with (copy.mjs nowView), so Projects and Now agree, also after Pause and Resume, and a
 * worker whose record stopped moving reads "Possibly stuck" here too (aiworks#11 review 4 F10, F14). With several
 * pieces of active work it names the one the sentence is about, by its purpose, as Now's goal does.
 */
function activeState(repository, active, supervisor, owner, now) {
  const { state, details } = nowView(repository, { supervisor, owner: { available: true, items: [], campaigns: {}, ...owner } }, { now });
  // AIWorks stopped on this computer is about all of it, so no one piece of work is named.
  const work = active.length > 1 && state.key !== 'supervisor-stopped' ? owner?.campaigns?.[details.workId]?.purpose?.text : null;
  return { key: KEYS[state.key] ?? 'running', text: work ? `${work} · ${state.title}` : state.title };
}

/**
 * The Projects screen. `supervisor` is supervisorSnapshot, `owner` is ownerView of it, `repositories` the configured
 * repository names (configuredRepositories). Each project: `id` (the repository, its address on the page), a short
 * `name`, `kind`, one `state` ({ key, text }) and one `action` ({ label, url } for a GitHub link or { label, route }
 * for a screen of this page). Repository owner and the number of pieces of work are details.
 * `records` are the connected project records (connectedProjects) when Add project is on: a GitHub project joins its
 * repository's row, and a local Git project or plain folder is a row of its own, addressed by its project id. A row
 * with a record carries `connection` (connectionView, without the folder's path). `addProject` says whether the page
 * offers Add project. `now` is the time the active work's state is read at (Now's possibly-stuck rule).
 */
export function projectsView(supervisor, owner, { repositories = [], records = [], addProject = false, now = Date.now() } = {}) {
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
    // Results whose merge is still being checked: until the check ends, the state says it is partial.
    const checking = campaigns.reduce((n, c) => n + (owner?.campaigns?.[c.id]?.counts?.checking ?? 0), 0);
    let state, action;
    if (mine.length) {
      const needs = mine.length === 1 ? 'One thing needs you' : `${mine.length} things need you`;
      state = { key: 'needs-you', text: checking ? `${needs} so far. ${checkingText(checking)}` : `${needs}.` };
      action = needsAction(mine);
    } else if (connection && connection.status !== 'ready') {
      // The connection needs the owner, or is away for now: its one sentence, and the project where Check again is.
      state = { key: connection.status, text: connection.message };
      action = { label: 'Open project', route: route('now') };
    } else if (active.length) {
      state = activeState(repository, active, supervisor, owner, now);
      // "Running" is never said while a result that may need the owner is unknown; a state that says more keeps its word.
      if (checking) state = { key: state.key === 'running' ? 'checking' : state.key, text: `${state.text} · ${checkingText(checking)}` };
      action = { label: 'Open current work', route: route('work') };
    } else if (checking) {
      state = { key: 'checking', text: checkingText(checking) };
      action = { label: 'See results', route: route('results') };
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
      details: { owner: repository.split('/')[0], work: campaigns.length, configured, needsYou: mine.length, checking }, ...(connection ? { connection } : {}) };
  });
  // Two repositories with the same name under different owners keep their owner in the name.
  const shared = projects.filter((project) => projects.some((other) => other !== project && other.name.toLowerCase() === project.name.toLowerCase()));
  for (const project of shared) project.name = project.repository;
  // Local Git projects and plain folders: no work can start there yet, so their state is their connection's.
  for (const record of records.filter((item) => item.source_kind !== 'github')) {
    const connection = connectionView(record, { path: false });
    projects.push({ id: record.id, name: record.name, repository: null, kind: connection.kind,
      state: connection.status === 'ready' ? { key: 'cannot-start', text: connection.startWork.text } : { key: connection.status, text: connection.message },
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
 * are placeholders. The codes connect adds (§8.2 to §8.4) are worded by the supervisor's connectCopy, except RULES_COPY's.
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
  // The fix for these three is outside AIWorks (OWNER_WORKSPACE §5.2 step 6): Settings only shows what the machine has
  // (§4.3) and has no control for them, so they name the fix and offer Check again, never "Open Settings" (aiworks#11 F1).
  GOVERNANCE_ROOT_MISSING: "AIWorks can't find the project rules on this computer, so it can't add a project yet. The fix is outside AIWorks: the AIWorks configuration file on this computer must name the folder that holds the project rules. Then choose Check again.",
  GIT_CLI_MISSING: "AIWorks can't find Git on this computer, so it can't check this folder. The fix is outside AIWorks: install Git, or name where it is in the AIWorks configuration file on this computer. Then choose Check again.",
  CONFIG_CONFLICT: "The AIWorks configuration file on this computer puts {repository} at {configPath}, but this project is at {root}. AIWorks won't guess which one is right. Correct that entry in the configuration file, which is outside AIWorks, or disconnect this project. Then choose Check again.",
  GIT_SUBFOLDER: 'This folder is inside the Git repository {top}. Connect {top} instead.',
  GIT_WORKTREE: 'This folder is a Git worktree. Connect the main checkout at {main} instead.',
  GIT_BARE: 'This is a bare Git repository with no files. Connect a normal checkout.',
  GIT_UNTRUSTED: "Git doesn't trust this folder because another Windows account owns it. Fix the owner, or add it to Git's safe.directory yourself; AIWorks won't change Git settings.",
  // The design names these outcomes but gives no copy; they follow its style.
  NOT_GITHUB: 'This folder has no GitHub remote. Connect it as a local Git project or a plain folder.',
  NOT_SAME_PROJECT: `This folder doesn't hold "{name}". Choose the folder it moved to.`,
});
/**
 * The project-rules rows of PROJECT_CONNECTION §8.2, worded here: the owner calls that place "your project rules", never
 * by the platform's name (OWNER_WORKSPACE §2.1; aiworks#11 review 4 F4). `repo` and `ids` as connectCopy fills them.
 */
const RULES_COPY = Object.freeze({
  REGISTRY_MISSING: (repo) => `${repo} isn't listed in your project rules, so AIWorks can't start work on it. ${LISTING}`,
  REGISTRY_AMBIGUOUS: (repo, ids) => `Your project rules list ${repo} more than once (${ids}). AIWorks won't guess which rules apply.`,
  REGISTRY_INVALID: (repo) => `The entry for ${repo} in your project rules has an error, so AIWorks can't read its rules.`,
  GITHUB_REGISTERED: (repo) => `${repo} is listed in your project rules, so connect it as a GitHub project.`,
});
/** What the connect codes need filled before connectCopy can say them; without it the status sentence stands in. */
const NEEDS = Object.freeze({ BRANCH_MISSING: ['branch'], REGISTRY_AMBIGUOUS: ['ids'], CONFIG_CONFLICT: ['configPath', 'root'], UNCOMMITTED_NOTICE: ['sha7'],
  MIRROR_SPACE: ['need', 'free', 'drive'], SECRET_TRACKED: ['count'], LOCAL_BRANCH_MISSING: ['branch'], PROJECT_MOVED: ['was'], TOO_LARGE: ['files', 'bytes'],
  FILE_TOO_LARGE: ['count'], UNREADABLE_FILES: ['count'], CASE_COLLISION: ['a', 'b'] });
/**
 * When a saved project's code cannot be said in full here (its detail is only known during a check): on its Now screen,
 * which has Check again. Add project has Check again only for a code that offers it, so there the sentence names Check
 * folder, its own button (aiworks#11 review 5 G8).
 */
const STATUS_FALLBACK = Object.freeze({ 'needs-setup': 'Needs setup. Choose Check again to see what to do.',
  unavailable: 'Temporarily unavailable. Choose Check again when it should be back.' });
const ADD_FALLBACK = Object.freeze({ 'needs-setup': "AIWorks can't use this folder as it is now. Check the path, then choose Check folder again.",
  unavailable: "AIWorks can't reach this folder right now. Choose Check folder again when it should be back." });
/**
 * OWNER_WORKSPACE §5.2, step 5: a GitHub project the project rules do not list, with who decides, what it allows and
 * where to act. No button: the fix is outside AIWorks. The code is said only in Diagnostics (aiworks#11 review 5 G3).
 */
const LISTING = 'You decide which projects AIWorks may work on: listing it in your project rules lets AIWorks start work on it. Your project rules are kept outside AIWorks, in a folder on this computer that the AIWorks configuration file names. Then check again.';
export const UNREGISTERED = `This project is not listed in your project rules yet, so AIWorks cannot start work on it. ${LISTING}`;
/**
 * OWNER_WORKSPACE §5.3: what a connected project without GitHub says, and (in details) who decides what it waits for,
 * what each decision allows and where to act. Planning waits too (§5.3 step 4), so neither is claimed (review 5 G2, G3).
 * The decision codes and issue numbers are said only in Diagnostics (LOCAL_START_DIAGNOSTIC).
 */
export const LOCAL_START = Object.freeze(["Connected. AIWorks can't plan or start work in a project without GitHub yet.",
  'Two decisions come first, and neither is made on this page. Your project rules on this computer must accept a project without GitHub; that lets AIWorks know which rules this project follows, and it is changed in the project rules, outside AIWorks. And you decide whether work here may be approved on this computer instead of on GitHub; that lets you approve a plan here so AIWorks can start it. Settings › Diagnostics says where both decisions are tracked. Until both are made and built, you can check this project again or disconnect it here.']);
/** The state word of a project that is connected but where work cannot start: never a green Ready (review 5 G9). */
export const CANNOT_START = "Can't start work yet";
/** Settings › Diagnostics: what a connected project waits for, in machine words (OWNER_WORKSPACE §2.2). */
export const LOCAL_START_DIAGNOSTIC = 'starting work is off (LOCAL_START_OFF). It waits for D2, a local project identity in the project rules (AIWorks issue #24), and D4, owner question Q2, a local approval route without a GitHub plan (AIWorks issue #32).';
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
  if (Object.hasOwn(RULES_COPY, code)) return RULES_COPY[code](detail.repository ?? 'this repository', (detail.ids ?? []).join(', '));
  return connectCopy(code, detail);
}

/**
 * The one action a code offers on this page (the Action column of §8), or null: the others (Review, Choose branch, Edit
 * exclusions, Rebuild copy) are not part of this slice, so no button leads nowhere. `do` says what the page does.
 */
export function projectAction(code, detail = {}) {
  switch (code) {
    // A folder at a connected project's place that no longer holds it (§4.6): that project's Now says what to do, with
    // its Check again and Disconnect (aiworks#11 review 5 G8).
    case 'PATH_OVERLAP': case 'ALREADY_CONNECTED': case 'IDENTITY_CHANGED': case 'ROOT_REPLACED':
      return detail.route ? { do: 'open', label: `Open "${detail.name}"`, project: detail.route } : null;
    case 'PATH_IS_LINK': return detail.canonical ? { do: 'use-path', label: 'Use this folder', path: detail.canonical } : null;
    case 'GIT_SUBFOLDER': return detail.top ? { do: 'use-path', label: `Use ${detail.top}`, path: detail.top } : null;
    case 'GIT_WORKTREE': return detail.main ? { do: 'use-path', label: `Use ${detail.main}`, path: detail.main } : null;
    case 'GIT_NO_COMMITS': return { do: 'kind', label: 'Connect as plain folder', kind: 'folder' };
    case 'PROJECT_MOVED': return detail.projectId ? { do: 'move', label: `Move "${detail.name}" here`, projectId: detail.projectId } : null;
    case 'GOVERNANCE_ROOT_MISSING': case 'GIT_CLI_MISSING': case 'CONFIG_CONFLICT':
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
  // A Ready record where work cannot start reads "Can't start work yet", so its word matches its sentence (review 5 G9).
  const statusWords = record.status === 'ready' && !startWork.allowed ? CANNOT_START : STATUS_WORDS[record.status];
  // Machine words for Settings › Diagnostics only: why work cannot start here, with its code.
  const diagnostic = startWork.allowed ? null : local && record.status === 'ready' ? LOCAL_START_DIAGNOSTIC
    : record.reason ? `${(STATUS_WORDS[record.status] ?? record.status).toLowerCase()} (${record.reason})${record.reason === 'REGISTRY_MISSING' ? `: the project rules do not list ${record.github_repository}` : ''}.` : null;
  return { id: record.id, route: routeOf(record), name: record.name, kind: KIND_WORDS[record.source_kind], sourceKind: record.source_kind,
    version: record.version, status: record.status, statusWords, reason: record.reason ?? null, message, diagnostic,
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
  // Each with its repository, so a connected GitHub project's own worktrees inside its folder do not protect that folder.
  const worktreeRoots = Object.entries(config.repositories ?? {}).filter(([, entry]) => typeof entry?.worktreeRoot === 'string' && entry.worktreeRoot)
    .map(([repository, entry]) => ({ repository, path: entry.worktreeRoot }));
  const git = Array.isArray(config.commands?.git) && config.commands.git.length ? config.commands.git : ['git'];
  return { config, dataDir, governanceRoot: configuredGovernanceRoot(dataDir), git, ...inject,
    protectedRoots: [dataDir, join(home, 'mirrors'), join(home, 'worktrees'), ...(inject.protectedRoots ?? [])],
    worktreeRoots: [...worktreeRoots, ...(inject.worktreeRoots ?? [])] };
}

/** Open the supervisor store for one request; the routes never create a missing one. */
function withStore(dataDir, work, { readOnly = false } = {}) {
  const path = join(dataDir, 'supervisor.db');
  if (!existsSync(path)) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
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

/**
 * A refusal or problem, in the page's words: { ok: false, code, status, message, action }. `fallback` is the sentence
 * set for a code that cannot be said in full: it names only a control of the screen that shows it, unless the code's
 * own action is Check again. A connected project is named by its folder, never its full path.
 */
function outcome(code, status, detail, records, fallback = STATUS_FALLBACK) {
  const route = detail?.projectId ? records.find((record) => record.id === detail.projectId) : null;
  const filled = { ...shown(detail), ...(route ? { route: routeOf(route), name: route.name, path: detail.path ?? basename(route.root_path) } : {}) };
  const action = projectAction(code, filled), said = action?.do === 'check' ? STATUS_FALLBACK : fallback;
  return { ok: false, code, status: status ?? null, message: projectMessage(code, filled) ?? said[status] ?? said['needs-setup'], action };
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
    const check = (as) => preflight(path, { ...options, projects: records, kind: as, mirrorParent: home, io: inject.statfs ? { statfs: inject.statfs } : undefined });
    let found = check(kind);
    // Without a kind, preflight proposes one from the folder, and a connected project is the same project only as the kind
    // it was connected as: a GitHub checkout connected as Local Git read as a changed identity (aiworks#11 review 5 G8).
    // Checked as its own kind, an unchanged folder is already connected and opens; a changed one still says so.
    const connected = !kind && found.code === 'IDENTITY_CHANGED' ? records.find((record) => record.id === found.detail?.projectId) : null;
    if (connected && connected.source_kind !== found.kind) found = check(connected.source_kind);
    if (!found.ok) return outcome(found.code, found.status, found.code === 'MIRROR_SPACE' ? { ...found.detail, drive: parse(home).root } : found.detail, records, ADD_FALLBACK);
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
      if (!found.ok && found.code !== 'ALREADY_CONNECTED') return outcome(found.code, found.status, found.detail, records, ADD_FALLBACK);
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
      const said = outcome(result.code, result.status, detail, after, ADD_FALLBACK);
      return { ...said, message: result.code === 'REGISTRY_AMBIGUOUS' ? result.message : said.message, notices: [], project: connectionView(result.project) };
    }
    return { ...outcome(result.code, result.status, result.detail ?? result.preflight?.detail ?? {}, after, ADD_FALLBACK), notices: [], project: null };
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
