// Projects from today's data (docs/design/OWNER_WORKSPACE.md slice S2, build slice UI3): one row per GitHub repository
// that has work on this computer or is listed in the supervisor's config.json, each with one state and one next action.
// The list joins the campaigns' target repositories with the configured ones, grouped case-insensitively. The state is
// built from the owner view, so a project never reads calmer than its Needs you items; no campaign id is used at the
// primary level.
// Add project (PROJECT_CONNECTION slice S6 with OWNER_WORKSPACE slice S11, build slice UI13): the owner connects a GitHub
// checkout, a local Git repository or a plain folder through the supervisor's project connection API
// (src/supervisor/project-connect.mjs). Connecting only reads the owner's folder. It is off unless the data directory's
// config.json says "projectConnection": { "enabled": true }; off, the page and the routes are exactly as before.
// Starting work on a project without GitHub waits for its confirmed rules; then the owner plans, approves and applies
// there (plan slices STA17 and UI17, work.mjs). The page says so in owner words, and names the codes only in Settings ›
// Diagnostics (aiworks#11 review 5 G3).
// Project rules (PROJECT_CONNECTION §7, slice S8, build slice UI16): the owner confirms, renews or revokes the rules of a
// project without GitHub on its Now screen, typing the project's name, for up to 12 months. Each entry passes
// local-overlay.mjs (through campaign.mjs overlayGovernance) before it is saved, and only these owner routes write the
// `project_overlays` table, each after the dashboard's caller check (local-admission.mjs checkCaller, given by server.mjs).
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { Store } from '../supervisor/store.mjs';
import { canonicalJson, overlayGovernance, registryEntriesFor } from '../supervisor/campaign.mjs';
import { configuredGovernanceRoot } from '../supervisor/governance.mjs';
import { OWNER_CALLER } from '../supervisor/local-admission.mjs';
import { OverlayError, overlayDigest, validateOverlayEntry } from '../supervisor/local-overlay.mjs';
import { checkFolderProject, checkGithubProject, checkLocalGitProject, connectCopy, connectFolderProject, connectGithubProject,
  connectLocalGitProject, folderMatches, MirrorError, ProjectError, relocateFolderProject, relocateLocalGitProject } from '../supervisor/project-connect.mjs';
import { preflight } from '../supervisor/project-preflight.mjs';
import { disconnectProject, PROJECT_ID, projects as projectRecords, SOURCE_KINDS } from '../supervisor/projects.mjs';
import { writeAtomic } from '../supervisor/proc.mjs';
import { prepareSampleFolder, SAMPLE_PROJECT, SampleError, writeSampleFiles } from '../supervisor/sample-project.mjs';
import { alsoSummary, nowView } from './copy.mjs';

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

/** The one next action for a project whose Needs you items are `items`: the item's own link when there is one item. */
function needsAction(items) {
  const [item] = items, url = items.length === 1 ? item.link?.url ?? '' : '';
  const pr = PR_URL.exec(url);
  if (pr) return { label: `Review pull request #${pr[1]}`, url };
  if (ISSUE_URL.test(url)) return { label: 'Open the step issue', url };
  return { label: items.length === 1 ? 'See what needs you' : `See all ${items.length} in Needs you`, route: { screen: 'needs' } };
}

/**
 * One state, in plain words, for a project with active (not finished or cancelled) work and nothing for the owner: the
 * sentence its Now screen leads with (copy.mjs nowView), so Projects and Now agree, also after Pause and Resume, and a
 * worker whose record stopped moving reads "Possibly stuck" here too (aiworks#11 review 4 F10, F14). With several
 * pieces of active work it names the one the sentence is about, by its purpose, as Now's goal does. What else Now
 * keeps in view follows in short (review 5 G5): "· Also: 1 AI worker possibly stuck · 1 piece of work paused, …".
 */
function activeState(repository, active, supervisor, owner, now) {
  const { state, details, also } = nowView(repository, { supervisor, owner: { available: true, items: [], campaigns: {}, ...owner } }, { now });
  // AIWorks stopped on this computer is about all of it, so no one piece of work is named.
  const work = active.length > 1 && state.key !== 'supervisor-stopped' ? owner?.campaigns?.[details.workId]?.purpose?.text : null;
  const more = alsoSummary(also);
  return { key: KEYS[state.key] ?? 'running', text: [work ? `${work} · ${state.title}` : state.title, more].filter(Boolean).join(' · ') };
}

/**
 * Now's other lines, in short, for a project whose Needs you items lead its row: running, possibly stuck and paused work
 * stay in view beside them (aiworks#11 review 5 G5, review 4 F14).
 */
const alsoOf = (repository, supervisor, owner, now) =>
  alsoSummary(nowView(repository, { supervisor, owner: { available: true, items: [], campaigns: {}, ...owner } }, { now }).also);

/**
 * The Projects screen. `supervisor` is supervisorSnapshot, `owner` is ownerView of it, `repositories` the configured
 * repository names (configuredRepositories). Each project: `id` (the repository, its address on the page), a short
 * `name`, `kind`, one `state` ({ key, text }) and one `action` ({ label, url } for a GitHub link or { label, route }
 * for a screen of this page). Repository owner and the number of pieces of work are details.
 * `records` are the connected project records (connectedProjects) when Add project is on: a GitHub project joins its
 * repository's row, and a local Git project or plain folder is a row of its own, addressed by its project id. A row
 * with a record carries `connection` (connectionView, without the folder's path). `addProject` says whether the page
 * offers Add project. `now` is the time the active work's state is read at (Now's possibly-stuck rule).
 * `removed` are the projects the owner removed from this list (removedProjects): such a row is left out, and listed under
 * `removed`, while it can still be removed and no work was registered in it since. A row that can be removed says
 * `removable`.
 */
export function projectsView(supervisor, owner, { repositories = [], records = [], removed = {}, addProject = false, localWork = {}, now = Date.now() } = {}) {
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
  const items = owner?.items ?? [], hidden = [];
  const projects = [...groups.values()].map(({ repository, configured, campaigns, record }) => {
    const route = (tab) => ({ screen: 'project', project: repository, tab });
    const mine = items.filter((item) => item.repository?.toLowerCase() === repository.toLowerCase());
    const active = campaigns.filter((c) => !TERMINAL.includes(c.control));
    const connection = record ? connectionView(record, { path: false }) : null;
    // Results whose merge is still being checked: until the check ends, the state says it is partial.
    const checking = campaigns.reduce((n, c) => n + (owner?.campaigns?.[c.id]?.counts?.checking ?? 0), 0);
    let state, action;
    if (mine.length) {
      const needs = mine.length === 1 ? 'One thing needs you' : `${mine.length} things need you`, more = alsoOf(repository, supervisor, owner, now);
      const text = checking ? `${needs} so far.` : `${needs}.`;
      state = { key: 'needs-you', text: [text, more ? `${more}.` : null, checking ? checkingText(checking) : null].filter(Boolean).join(' ') };
      action = needsAction(mine);
    } else if (connection && connection.status !== 'ready') {
      // The connection needs the owner, or is away for now: its one sentence, and the project where Check again is.
      state = { key: connection.status, text: connection.message };
      action = { label: 'Open project', route: route('overview') };
    } else if (active.length) {
      state = activeState(repository, active, supervisor, owner, now);
      // "Running" is never said while a result that may need the owner is unknown; a state that says more keeps its word.
      if (checking) state = { key: state.key === 'running' ? 'checking' : state.key, text: `${state.text} · ${checkingText(checking)}` };
      action = { label: 'Open current work', route: route('overview') };
    } else if (checking) {
      state = { key: 'checking', text: checkingText(checking) };
      action = { label: 'See results', route: route('review') };
    } else if (campaigns.length) {
      // The most recent finished or cancelled piece of work, in the owner view's own words.
      const latest = [...campaigns].sort((a, b) => lastActivity([b]) - lastActivity([a]))[0], view = owner?.campaigns?.[latest.id];
      const text = latest.control === 'cancelled' ? view?.outcome ?? 'Cancelled' : view?.finished ?? 'All steps are finished';
      state = { key: latest.control === 'cancelled' ? 'cancelled' : 'finished', text: /[.!?]$/.test(text) ? text : `${text}.` };
      action = { label: 'See results', route: route('review') };
    } else {
      state = { key: 'no-work', text: 'No work yet.' };
      action = { label: 'Open project', route: route('overview') };
    }
    const removable = REMOVABLE.includes(state.key) && !connection, gone = removed[repository.toLowerCase()];
    if (removable && gone && campaigns.every((c) => (c.registeredAt ?? 0) <= gone.removedAt)) {
      hidden.push({ repository, name: repository.split('/')[1], removedAt: gone.removedAt });
      return null;
    }
    return { id: repository, name: repository.split('/')[1], repository, kind: 'GitHub', state, action, lastActivityAt: lastActivity(campaigns),
      details: { owner: repository.split('/')[0], work: campaigns.length, configured, needsYou: mine.length, checking }, ...(connection ? { connection } : {}),
      ...(removable ? { removable } : {}) };
  }).filter(Boolean);
  // Two repositories with the same name under different owners keep their owner in the name.
  const shared = projects.filter((project) => projects.some((other) => other !== project && other.name.toLowerCase() === project.name.toLowerCase()));
  for (const project of shared) project.name = project.repository;
  // Local Git projects and plain folders: their connection's state until work can start there, then their local work's
  // (work.mjs workView `local`): checked results that wait for the owner first, then work in progress.
  for (const record of records.filter((item) => item.source_kind !== 'github')) {
    const connection = connectionView(record, { path: false });
    const work = localWork[record.id] ?? [], waiting = work.flatMap((c) => c.results).filter((row) => row.action === 'apply').length;
    const active = work.find((c) => !['finished', 'cancelled'].includes(c.control));
    // Open decisions of its work first: they hold a step until the owner answers (work.mjs localWork).
    const decisions = work.filter((c) => !['finished', 'cancelled'].includes(c.control)).flatMap((c) => c.steps).filter((step) => step.decision && !step.decision.answered).length;
    projects.push({ id: record.id, name: record.name, repository: null, kind: connection.kind,
      state: connection.status !== 'ready' ? { key: connection.status, text: connection.message }
        : decisions ? { key: 'needs-you', text: decisions === 1 ? 'A step waits for your decision.' : `${decisions} steps wait for your decision.` }
        : waiting ? { key: 'needs-you', text: waiting === 1 ? 'A checked result waits for your review.' : `${waiting} checked results wait for your review.` }
          : active ? { key: 'running', text: `Working on: ${/[.!?…]$/.test(active.outcome) ? active.outcome : `${active.outcome}.`}` }
            : connection.startWork.allowed ? { key: 'no-work', text: 'No work yet.' } : { key: 'cannot-start', text: connection.startWork.text },
      action: { label: 'Open project', route: { screen: 'project', project: record.id, tab: 'overview' } }, lastActivityAt: record.updated_at ?? null,
      details: { owner: null, work: 0, configured: false, needsYou: decisions }, connection });
  }
  projects.sort((a, b) => (RANK[a.state.key] ?? 2) - (RANK[b.state.key] ?? 2) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.name.localeCompare(b.name));
  return { available: true, ...(addProject ? { addProject } : {}), projects, removed: hidden.sort((a, b) => a.name.localeCompare(b.name)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Remove a project from Projects.

/** The owner's removals, beside config.json in the data directory: never in the work records, which keep every campaign. */
const REMOVED_FILE = 'removed-projects.json';
/** A project can be removed only when nothing runs or waits in it, nothing needs the owner and no result is being checked. */
const REMOVABLE = ['finished', 'cancelled', 'no-work'];

/** The projects removed from Projects, by lower-case repository: { repository, removedAt }. None when the file is unreadable. */
export function removedProjects(dataDir) {
  let listed;
  try { listed = JSON.parse(readFileSync(join(dataDir, REMOVED_FILE), 'utf8'))?.projects; } catch { return {}; }
  if (!listed || typeof listed !== 'object' || Array.isArray(listed)) return {};
  return Object.fromEntries(Object.entries(listed).filter(([key, entry]) => REPOSITORY.test(entry?.repository ?? '') &&
    entry.repository.toLowerCase() === key && Number.isSafeInteger(entry.removedAt)));
}

function readRepository(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['repository', 'requestId'].includes(key)) ||
    typeof input.repository !== 'string' || !REPOSITORY.test(input.repository) ||
    input.requestId !== undefined && (typeof input.requestId !== 'string' || !UUID.test(input.requestId))) throw fail(400, 'Invalid request.');
  return input.repository;
}
const saveRemoved = (dataDir, removed) => writeAtomic(join(dataDir, REMOVED_FILE), `${JSON.stringify({ version: 1, projects: removed }, null, 2)}\n`);

/**
 * POST /api/projects/remove: take a GitHub project off Projects. Only its row goes: its work, results and history stay
 * in the work records, and config.json, the repository and its folder are not touched. Work registered in it later brings
 * it back. `view` is projectsView as the page sees it now, without removals: a project with work that is not finished,
 * something for the owner, a result being checked or a connected folder (which has Disconnect) is refused.
 */
export function removeProject(dataDir, input, view, now = Date.now()) {
  const repository = readRepository(input);
  if (!view?.available) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  const row = view.projects.find((project) => project.repository?.toLowerCase() === repository.toLowerCase());
  if (!row) throw fail(404, 'This project is not on Projects. Refresh the page.');
  if (!row.removable) {
    throw fail(409, row.connection ? `"${row.name}" is connected from a folder. Disconnect it on its Overview instead.`
      : `"${row.name}" has work that is not finished, or something that needs you. Remove it once that is done.`);
  }
  saveRemoved(dataDir, { ...removedProjects(dataDir), [row.repository.toLowerCase()]: { repository: row.repository, removedAt: now } });
  return { ok: true, message: `Removed "${row.name}" from Projects. AIWorks kept its work and history. Settings › Projects can show it again.` };
}

/** POST /api/projects/restore: Show again, for a project removed from Projects. */
export function restoreProject(dataDir, input) {
  const repository = readRepository(input), removed = removedProjects(dataDir), key = repository.toLowerCase();
  if (!removed[key]) throw fail(404, 'This project is not removed. Refresh the page.');
  const { [key]: entry, ...rest } = removed;
  saveRemoved(dataDir, rest);
  return { ok: true, message: `"${entry.repository.split('/')[1]}" is on Projects again.` };
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
 * OWNER_WORKSPACE §5.3: what a connected project without GitHub says, and (in details) how work goes there. Before its
 * rules are confirmed, no planning or start is claimed (review 5 G2, G3); once they are, the owner plans, approves and
 * applies here (slice UI17). The decision codes and issue numbers are said only in Diagnostics (LOCAL_START_DIAGNOSTIC).
 */
const LOCAL_HOW = 'You ask for a plan and approve it here; AIWorks then works on its own copy, and an independent checker checks each result. Nothing in your folder changes until you press Apply on a checked result, and Undo apply puts it back.';
export const LOCAL_START = Object.freeze(["Connected. Confirm this project's rules on this page before AIWorks plans or starts work here.",
  `The rules say which rules AIWorks follows in this folder; you confirm them once, for up to 12 months. ${LOCAL_HOW}`]);
/** OWNER_WORKSPACE §5.3, step 2: what comes after connecting, said before the owner connects. */
const LOCAL_AFTER_CONNECT = "After you connect it, confirm its rules on its Overview. Then you can plan work here and approve it.";
export const LOCAL_READY = Object.freeze(["Ready. Plan work here: nothing in your folder changes until you press Apply.", LOCAL_HOW]);
/** The state word of a project that is connected but where work cannot start: never a green Ready (review 5 G9). */
export const CANNOT_START = "Can't start work yet";
/** Settings › Diagnostics: what a connected project waits for, in machine words (OWNER_WORKSPACE §2.2). */
export const LOCAL_START_DIAGNOSTIC = 'starting work waits for the project rules (D2, AIWorks issue #24), confirmed on the project’s Overview; each plan then starts on the owner’s approval in the dashboard (D4, AIWorks issue #32).';
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
  // A project without GitHub can start work once its rules are confirmed and still valid (D2); each plan then needs the
  // owner's approval (D4). The full check runs again on every request and approval (work.mjs, local-admission.mjs).
  const rulesOk = local && record.overlay !== undefined && rulesSummary(record.overlay).state === 'confirmed';
  const startWork = record.capabilities?.startWork?.allowed ? { allowed: true, text: null, detail: null }
    : rulesOk ? { allowed: true, text: LOCAL_READY[0], detail: LOCAL_READY[1] }
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
    startWork, rules: local && record.overlay !== undefined ? rulesSummary(record.overlay) : null, connectedAt: record.created_at };
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
  try {
    store = new Store(path, { readOnly: true });
    // A store that never saved project rules may have no project_overlays table: then no project has rules.
    let overlays = [];
    try { overlays = store.all('SELECT * FROM project_overlays'); } catch { overlays = []; }
    return projectRecords(store).map((record) => ({ ...record, overlay: overlays.find((row) => row.project_id === record.id) ?? null }));
  } catch { return []; } finally { store?.close(); }
}

const fail = (status, message) => Object.assign(new Error(message), { status });
const notFound = () => fail(404, 'Not found.');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUTS = Object.freeze({
  preflight: ['path', 'kind'], connect: ['path', 'kind', 'name', 'id', 'asNewProject', 'requestId'], check: ['projectId', 'requestId'],
  relocate: ['projectId', 'path', 'confirm', 'requestId'], sample: ['path', 'requestId'], disconnect: ['projectId', 'version', 'requestId'],
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
      found.kind !== 'github' ? OWN_COPY : null, found.kind !== 'github' ? LOCAL_AFTER_CONNECT : null].filter(Boolean);
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

const SAMPLE_WORDS = Object.freeze({
  SAMPLE_FOLDER_NOT_EMPTY: 'This folder is not empty, so AIWorks wrote nothing into it. Choose a new folder, or an empty one.',
  SAMPLE_FOLDER_UNWRITABLE: 'AIWorks could not create this folder. Check that the folder it goes in exists, then try again.',
});

/**
 * POST /api/projects/sample (OWNER_UI_V2 WP8): the sample project of First run. The owner names a new or empty folder;
 * AIWorks checks it like any folder on Add project before writing anything, writes the sample's fictional files into it
 * (sample-project.mjs) and connects it through connectProject, exactly as Connect project does. The sample then needs
 * its rules confirmed and a plan approved like any project: nothing starts and nothing is paid for here. A folder that
 * already holds the sample opens the same project, so a repeat is safe. Returns what connectProject returns.
 */
export function createSampleProject(dataDir, input, inject = {}) {
  if (!projectConnectionEnabled(dataDir)) throw notFound();
  const { path } = readInput('sample', input);
  const platform = inject.platform ?? process.platform;
  // Only a full local path: a relative one would be created where the dashboard runs, a network one is never touched.
  if (/^[\\/]{2}/.test(path) || !(platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(path) : isAbsolute(path))) {
    return { ...outcome('PATH_NOT_ABSOLUTE', 'not-saved', {}, [], ADD_FALLBACK), notices: [], project: null };
  }
  const options = connectOptions(dataDir, inject);
  const said = (code) => ({ ok: false, code, status: 'not-saved', message: SAMPLE_WORDS[code], action: null, notices: [], project: null });
  const refused = withStore(dataDir, (store) => {
    const records = projectRecords(store);
    let prepared;
    try { prepared = prepareSampleFolder(path); } catch (error) { if (error instanceof SampleError) return said(error.code); throw error; }
    const found = preflight(path, { ...options, projects: records, kind: 'folder', mirrorParent: dirname(resolve(dataDir)),
      io: inject.statfs ? { statfs: inject.statfs } : undefined });
    if (found.ok || found.code === 'ALREADY_CONNECTED') return null;
    prepared.undo();
    return { ...outcome(found.code, found.status, found.detail, records, ADD_FALLBACK), notices: [], project: null };
  }, { readOnly: true });
  if (refused) return refused;
  try { writeSampleFiles(path); } catch (error) { return said(error instanceof SampleError ? error.code : 'SAMPLE_FOLDER_UNWRITABLE'); }
  return connectProject(dataDir, { path, kind: 'folder', name: SAMPLE_PROJECT.name, id: SAMPLE_PROJECT.id }, inject);
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

// Project rules (PROJECT_CONNECTION §7.3 and §7.4, slice S8). One entry per project without GitHub, in `project_overlays`.
const DAY_MS = 86_400_000;
const RULES_MONTHS = 12;
const LIFECYCLES = Object.freeze(['active', 'experimental', 'parked']);
const CAPABILITY = /^[a-z][a-z0-9-]{0,39}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const RULES_INPUTS = Object.freeze({
  review: ['projectId', 'capabilities', 'lifecycle'],
  confirm: ['projectId', 'capabilities', 'lifecycle', 'months', 'typedName', 'current', 'requestId'],
  revoke: ['projectId', 'typedName', 'current', 'requestId'],
});
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (day) => Date.parse(`${day}T00:00:00.000Z`);
const coded = (status, code, message, detail) => Object.assign(fail(status, message), { code, ...(detail ? { detail } : {}) });

/** The request's own fields only, each of its kind (as readInput), before the store is opened. */
function readRulesInput(action, input) {
  const bad = () => fail(400, 'Invalid request.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !RULES_INPUTS[action].includes(key))) throw bad();
  if (typeof input.projectId !== 'string' || !PROJECT_ID.test(input.projectId)) throw bad();
  if (input.capabilities !== undefined && (!Array.isArray(input.capabilities) || input.capabilities.length > 16
    || !input.capabilities.every((word) => typeof word === 'string' && CAPABILITY.test(word)) || new Set(input.capabilities).size !== input.capabilities.length)) throw bad();
  if (input.lifecycle !== undefined && !LIFECYCLES.includes(input.lifecycle)) throw bad();
  if (action !== 'review') {
    if (typeof input.typedName !== 'string' || input.typedName.length > 200) throw bad();
    if (input.current !== null && (typeof input.current !== 'string' || !DIGEST.test(input.current))) throw bad();
  }
  if (action === 'confirm' && (!Number.isSafeInteger(input.months) || input.months < 1 || input.months > RULES_MONTHS)) throw bad();
  if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !UUID.test(input.requestId))) throw bad();
  return input;
}

/**
 * The state of a project's rules from its saved row alone, for /api/state: none, confirmed, expired (the day after
 * reviewBy, rule 7) or revoked, with the owner's sentence. The rules review checks the entry in full.
 */
export function rulesSummary(row, now = Date.now()) {
  if (!row) return { state: 'none', text: "You haven't confirmed this project's rules yet.", reviewBy: null, approvedAt: null, current: null };
  let entry = null;
  try { entry = JSON.parse(row.entry); } catch { entry = null; }
  const reviewBy = typeof entry?.reviewBy === 'string' ? entry.reviewBy : null;
  const base = { reviewBy, approvedAt: entry?.approval?.at ?? null, current: row.digest };
  if (row.revoked_at != null) return { ...base, state: 'revoked', text: "You revoked this project's rules. AIWorks won't work here until you confirm them again." };
  if (!reviewBy || utcDay(now) > reviewBy) return { ...base, state: 'expired', text: `This project's rules expired${reviewBy ? ` on ${reviewBy}` : ''}. Renew them before AIWorks works here.` };
  return { ...base, state: 'confirmed', text: `You confirmed this project's rules. They are valid until ${reviewBy}.` };
}

/** A project without GitHub, live, by id: 404 when it is not connected, 409 for a GitHub project. */
function localRecord(store, projectId) {
  const record = liveRecord(store, projectId);
  if (record.source_kind === 'github') throw fail(409, 'A GitHub project follows the rules your project rules list for its repository. There is nothing to confirm here.');
  return record;
}
const overlayRow = (store, projectId) => store.get('SELECT * FROM project_overlays WHERE project_id = ?', projectId);
/** The ids of every other project's entry, revoked ones included: ids are never reused (rule 4). */
const takenIds = (store, projectId) => store.all('SELECT id FROM project_overlays WHERE project_id <> ?', projectId).map((row) => row.id);
/** A project's entry id: the one it already has, else `lp-` and its project id, within the schema's 42 characters. */
const overlayIdOf = (record, row) => row?.id ?? `lp-${record.id}`.slice(0, 42);

/** The capability words of the governance root's project contract schema (rule 3), or none when it cannot be read. */
function capabilityWords(root) {
  try {
    const words = JSON.parse(readFileSync(join(root, 'schemas', 'project-contract.schema.json'), 'utf8'))?.properties?.capabilities?.items?.enum;
    return Array.isArray(words) ? words.filter((word) => typeof word === 'string') : [];
  } catch { return []; }
}

/**
 * The entry the owner confirms (§7.3(a)): the project's name and kind, the chosen lifecycle and capabilities, `local` only,
 * independent verification on, bound to AIWorks's current copy of the folder, and valid for `months` months but never more
 * than 365 days (rule 7). `approval.digest` binds every other field (rule 6).
 */
function draftEntry(record, overlayId, { capabilities = [], lifecycle = 'active', months = RULES_MONTHS }, now) {
  const commit = record.current_baseline?.commit;
  if (!COMMIT.test(String(commit ?? ''))) throw coded(409, 'RULES_NO_COPY', 'AIWorks has no copy of this folder yet, so there are no rules to confirm. Choose Check again first.');
  const at = utcDay(now), start = new Date(dayStart(at));
  const year = start.getUTCFullYear(), month = start.getUTCMonth() + months;
  const sameDay = Math.min(start.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  const reviewBy = utcDay(Math.min(Date.UTC(year, month, sameDay), dayStart(at) + 365 * DAY_MS));
  const entry = { id: overlayId, name: record.name, source: { kind: record.source_kind }, lifecycle, capabilities, environments: ['local'],
    governance: { observedAt: `local:${overlayId}@${commit}`, independentVerificationGate: 'enabled' },
    approval: { by: 'owner', at, method: 'owner-local-ui', digest: '' }, reviewBy };
  entry.approval.digest = overlayDigest(entry);
  return entry;
}

/** The entry's governance values (campaign.mjs overlayGovernance, which runs local-overlay.mjs first), or its RULES_* refusal. */
function checkedValues(store, record, entry, governanceRoot, now) {
  let taken = [];
  try { taken = takenIds(store, record.id); } catch { taken = []; } // no table yet: no id is taken
  try {
    return overlayGovernance(entry, governanceRoot, { takenIds: taken, now: new Date(now) });
  } catch (error) {
    if (error instanceof OverlayError) throw coded(409, error.code, "These rules can't be confirmed, so nothing was saved.", error.message);
    throw error;
  }
}

/** The saved row, read without failing on a store that never saved project rules (no table yet). */
const savedRow = (store, projectId) => { try { return overlayRow(store, projectId); } catch { return null; } };

/**
 * POST /api/projects/rules: the rules review, read-only. The project's saved rules and their state, checked in full
 * against the governance directory now (an expired entry reads `expired`); and, for the capabilities and lifecycle asked
 * (else the saved ones), every portfolio policy the project inherits (§7.3(b) rule 1), the capability words to choose
 * from and the longest validity. Nothing is saved.
 */
export function projectRulesView(dataDir, input, now = Date.now()) {
  if (!projectConnectionEnabled(dataDir)) throw notFound();
  const { projectId } = readRulesInput('review', input);
  const root = configuredGovernanceRoot(dataDir);
  return withStore(dataDir, (store) => {
    const record = localRecord(store, projectId);
    const row = savedRow(store, projectId);
    const rules = { code: null, ...rulesSummary(row, now) };
    let saved = null;
    try { saved = row ? JSON.parse(row.entry) : null; } catch { saved = null; }
    if (row && rules.state !== 'revoked') {
      try {
        validateOverlayEntry(saved, root, { takenIds: takenIds(store, projectId), now: new Date(now) });
      } catch (error) {
        if (!(error instanceof OverlayError)) throw error;
        Object.assign(rules, error.code === 'RULES_EXPIRED' ? { state: 'expired', code: error.code }
          : { state: 'invalid', code: error.code, text: "These rules can't be used now. Review them and confirm them again.", detail: error.message });
      }
    }
    const chosen = { capabilities: input.capabilities ?? saved?.capabilities ?? [], lifecycle: input.lifecycle ?? saved?.lifecycle ?? 'active' };
    const view = { ok: true, code: null, message: null, detail: null, project: { id: record.id, name: record.name }, rules, chosen,
      policies: [], capabilityWords: root ? capabilityWords(root) : [], lifecycles: LIFECYCLES, maxMonths: RULES_MONTHS };
    try {
      view.policies = checkedValues(store, record, draftEntry(record, overlayIdOf(record, row), chosen, now), root, now).policies;
    } catch (error) {
      if (!error.status || !error.code) throw error;
      Object.assign(view, { ok: false, code: error.code, message: error.code === 'RULES_NO_COPY' ? error.message : "These rules can't be confirmed as they are.", detail: error.detail ?? null });
    }
    return view;
  }, { readOnly: true });
}

/**
 * The dashboard's caller check, given by server.mjs as `caller(store)` (local-admission.mjs checkCaller bound to the
 * request's connection). It must answer owner-browser; a request from a process AIWorks started, one without a check and
 * one the check cannot place are refused with nothing saved (WORK_ENVELOPE §8.2).
 */
async function ownerOnly(store, caller) {
  const unchecked = (detail) => coded(403, 'APPROVAL_UNCHECKED', 'AIWorks could not check that this request came from you, so nothing was saved.', detail);
  let result = null;
  try { result = typeof caller === 'function' ? await caller(store) : null; } catch (error) {
    if (error?.name !== 'LocalAdmissionError') throw error;
    if (error.code === 'APPROVAL_FROM_AIWORKS') {
      throw coded(403, error.code, 'This request came from a program AIWorks started, not from you, so nothing was saved. Confirm the rules yourself on this page.');
    }
    throw unchecked(error.message);
  }
  if (result !== OWNER_CALLER) throw unchecked('no caller check is available on this computer');
}

/** The owner typed the project's name exactly (§7.4): anything else saves nothing. */
function typedNameMatches(record, typedName) {
  if (typedName.trim() !== record.name) throw coded(409, 'RULES_NAME_MISMATCH', `Type the project's name exactly as shown, "${record.name}", to confirm. Nothing was saved.`);
}

/** The saved rules must still be the ones the owner reviewed (`current`, null for none): else nothing is saved. */
function sameRules(row, current) {
  if ((row?.digest ?? null) !== current) throw coded(409, 'RULES_CHANGED', "This project's rules changed since this view was loaded. Review them again. Nothing was saved.");
}

/** Opens the writable store for one owner command and runs the caller check before anything else. */
async function ownerCommand(dataDir, caller, work) {
  const path = join(dataDir, 'supervisor.db');
  if (!existsSync(path)) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  const store = new Store(path);
  try {
    await ownerOnly(store, caller);
    return store.tx(() => work(store));
  } catch (error) {
    if (error instanceof ProjectError) throw fail(error.code === 'PROJECT_NOT_FOUND' || error.code === 'PROJECT_DISCONNECTED' ? 404 : 409, error.message);
    throw error;
  } finally { store.close(); }
}

/**
 * POST /api/projects/rules/confirm: confirm or renew a project's rules. The caller check runs first; then the typed name,
 * the rules the owner reviewed, and the new entry, which must pass local-overlay.mjs and get its policies by the
 * registry derivation (campaign.mjs overlayGovernance). Renewing, or confirming again after a revoke, keeps the entry's
 * id with a new approval day, reviewBy and digest. With revoke, the only writer of `project_overlays`.
 */
export async function confirmProjectRules(dataDir, input, { caller, now = Date.now() } = {}) {
  if (!projectConnectionEnabled(dataDir)) throw notFound();
  const { projectId, capabilities = [], lifecycle = 'active', months, typedName, current } = readRulesInput('confirm', input);
  const governanceRoot = configuredGovernanceRoot(dataDir);
  return ownerCommand(dataDir, caller, (store) => {
    const record = localRecord(store, projectId);
    typedNameMatches(record, typedName);
    const row = overlayRow(store, projectId);
    sameRules(row, current);
    const entry = draftEntry(record, overlayIdOf(record, row), { capabilities, lifecycle, months }, now);
    const values = checkedValues(store, record, entry, governanceRoot, now);
    const text = canonicalJson(entry);
    if (row) store.run('UPDATE project_overlays SET entry = ?, digest = ?, approved_at = ?, revoked_at = NULL WHERE id = ?', text, entry.approval.digest, now, row.id);
    else store.run('INSERT INTO project_overlays (id, project_id, entry, digest, approved_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)', entry.id, projectId, text, entry.approval.digest, now);
    const kind = !row ? 'confirmed' : row.revoked_at == null ? 'renewed' : 'confirmed again';
    store.journal(null, 'project-rules-confirmed', { projectId, overlayId: entry.id, digest: entry.approval.digest, reviewBy: entry.reviewBy, kind, policies: values.policies }, now);
    return { ok: true, code: null, message: `${kind === 'renewed' ? 'Renewed' : 'Confirmed'} the rules for "${record.name}". They are valid until ${entry.reviewBy}.`,
      rules: rulesSummary(overlayRow(store, projectId), now), policies: values.policies };
  });
}

/**
 * POST /api/projects/rules/revoke: the owner revokes a project's rules, typing its name. The caller check runs first. The
 * entry stays saved with its revocation time, so its id is never reused; it is not admissible from now on (§7.4).
 */
export async function revokeProjectRules(dataDir, input, { caller, now = Date.now() } = {}) {
  if (!projectConnectionEnabled(dataDir)) throw notFound();
  const { projectId, typedName, current } = readRulesInput('revoke', input);
  return ownerCommand(dataDir, caller, (store) => {
    const record = localRecord(store, projectId);
    typedNameMatches(record, typedName);
    const row = overlayRow(store, projectId);
    if (!row || row.revoked_at != null) throw coded(409, 'RULES_NONE', 'This project has no rules to revoke. Refresh the page.');
    sameRules(row, current);
    store.run('UPDATE project_overlays SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now, row.id);
    store.journal(null, 'project-rules-revoked', { projectId, overlayId: row.id, digest: row.digest }, now);
    return { ok: true, code: null, message: `Revoked the rules for "${record.name}". AIWorks won't work there until you confirm them again.`, rules: rulesSummary(overlayRow(store, projectId), now) };
  });
}
