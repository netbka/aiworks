import { MOVED_DRAFTS, adoptDrafts, formatRoute, globalOf, resolveRoute, tabOf, tabRoute, TABS } from '/router.mjs';
// The state copy of OWNER_WORKSPACE §7 and the Now screen (slice S4); the server serves src/dashboard/copy.mjs here.
import { COMMANDS, DELEGATED, DIALOGS, NEEDS, NOT_READ, busyOnCommand, costRunsLine, nowView, readingLines, resultMeaning, stateCopy, workLine, DASHBOARD_VERSION, DASHBOARD_VERSION_NAME, DASHBOARD_VERSIONS } from '/copy.mjs';

const $ = (selector) => document.querySelector(selector);
const names = { done: 'Done', blocked: 'Blocked', unknown: 'Unknown',
  pending: 'Not started', implementing: 'Being built', implemented: 'Waiting for the independent check', verifying: 'Being checked', verified: 'Checked; publishing',
  recent: 'Working', stale: 'No recent sign of life' };
const provider = (kind) => ({ 'claude-cli': 'Claude', 'codex-cli': 'Codex', 'cursor-cli': 'Cursor Agent', 'agy-cli': 'AGY (Antigravity) browser' })[kind] ?? 'Unknown AI worker';
// Owner-facing role names: the agent that builds a step, and the separate agent that checks it.
const roleName = (role) => ({ Verifier: 'Independent checker', Implementer: 'Builder', verify: 'independent checker', implement: 'builder' })[role] ?? role;
// What a finished step means for the owner: merged into the project (seen in local git), published with its merge
// not seen yet, or passed the check and merged for the owner when merging is delegated (#97). The line under it (what
// it means for the owner, why the merge is not seen, or why it is held) is `delivery.note`.
const deliveryNames = { merged: ['done', 'Merged'], published: ['attention', 'Published, merge not seen yet'], delegated: ['in_progress', DELEGATED.word(true)],
  'report-posted': ['done', 'Report posted'], unknown: ['unknown', 'Result not known'] };
const CHURN_ATTEMPTS = 5;
const STUCK_MINUTES = 15;
const ownerCampaign = (c) => state.owner?.campaigns?.[c.id] ?? null;
const deliveryOf = (c, task) => ownerCampaign(c)?.deliveries?.[task.id] ?? null;
const shortRepo = (repository) => repository?.split('/')[1] ?? repository ?? '';
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const usd = (value) => `$${value.toFixed(2)}`;
const campaignTitle = (c, { inProject = false } = {}) => {
  const purpose = ownerCampaign(c)?.purpose;
  const text = `${purpose?.text ?? 'Work without a name'}${purpose?.variant ? ` (${purpose.variant})` : ''}`;
  return inProject ? text : `${shortRepo(c.repository)}: ${text}`;
};

// "Since you last looked": the last visit is a per-viewer convenience in this browser only. Reads and writes may
// fail (private window, blocked storage), so the first or failed visit falls back to the last 24 hours.
const LAST_SEEN_KEY = 'aiworks-dashboard:last-seen';
const readLastSeen = () => { try { const value = Number(localStorage.getItem(LAST_SEEN_KEY)); return Number.isSafeInteger(value) && value > 0 ? value : null; } catch { return null; } };
const writeLastSeen = () => { try { localStorage.setItem(LAST_SEEN_KEY, String(Date.now())); } catch { /* convenience only */ } };
const previousVisit = readLastSeen();
const since = previousVisit ?? Date.now() - 86_400_000;
let state, csrf, offline = false, sending = false, pendingCancel, instructionCampaign, workLimit = 80;
// The address is the state (OWNER_WORKSPACE §3.3): `current` is what the address bar names, already canonical.
let current = resolveRoute(location.hash);
const opened = new Set();

// The last opened project, offered first on Projects; a per-browser convenience like "since you last looked".
const LAST_PROJECT_KEY = 'aiworks-dashboard:last-project';
const readLastProject = () => { try { return localStorage.getItem(LAST_PROJECT_KEY); } catch { return null; } };
const writeLastProject = (project) => { try { localStorage.setItem(LAST_PROJECT_KEY, project); } catch { /* convenience only */ } };

// Unsent drafts are kept per address in sessionStorage, so they survive the 5-second refresh, a reload and Back. They
// are cleared only after the server returns an accepted receipt. Blocked storage falls back to this page's memory.
const DRAFTS_KEY = 'aiworks-dashboard:drafts';
let draftMemory = null;
const readDrafts = () => { if (draftMemory) return draftMemory; try { return JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? '{}') ?? {}; } catch { return (draftMemory = {}); } };
const writeDrafts = (all) => { if (draftMemory) { draftMemory = all; return; } try { sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(all)); } catch { draftMemory = all; } };
// Writing a draft also drops the one its address kept before it moved (router.mjs adoptDrafts), so that text never returns.
const drafts = {
  get: (address, key) => readDrafts()[`${address} ${key}`] ?? null,
  set(address, key, value) { const all = readDrafts(); all[`${address} ${key}`] = value; delete all[MOVED_DRAFTS[`${address} ${key}`]]; writeDrafts(all); },
  delete(address, key) { const all = readDrafts(); delete all[`${address} ${key}`]; delete all[MOVED_DRAFTS[`${address} ${key}`]]; writeDrafts(all); },
  // A draft typed before its address moved (Messages to Chats) is taken up by the new address when it is next read.
  adopt() { const adopted = adoptDrafts(readDrafts()); if (adopted) writeDrafts(adopted); },
  // An old project tab address (#/p/<id>/work, results, cost or now) redirects to the tab its content moved to; what was
  // typed there moves with it, and a draft already kept at the new address wins.
  carry(from, to) {
    if (from === to || !/^#\/p\/[^/]+\/(?:now|work|results|cost)$/.test(from)) return;
    const all = readDrafts();
    for (const key of Object.keys(all).filter((item) => item.startsWith(`${from} `))) {
      const moved = `${to}${key.slice(from.length)}`;
      if (!Object.hasOwn(all, moved)) all[moved] = all[key];
      delete all[key];
    }
    writeDrafts(all);
  },
};

// Elements that act when used (a click or submit handler): the refresh keeps one only while it shows exactly the same.
const acting = new WeakSet();
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) { node.addEventListener(key.slice(2), value); acting.add(node); }
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value === true ? '' : String(value));
  }
  // A list of children is its items, never one text: an array appended whole printed as "a,b" and lost its links (aiworks#11 review 4 F11).
  node.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined));
  return node;
}
const link = (text, url, cls = '') => el('a', { href: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\//.test(url ?? '') ? url : '#',
  target: '_blank', rel: 'noopener noreferrer', class: cls }, text);
const badge = (status, label) => el('span', { class: `badge ${status}` }, label ?? names[status] ?? status);
const empty = (title, detail) => el('div', { class: 'empty-state' }, el('strong', {}, title), detail ?? '');
const button = (text, action, cls = 'secondary', disabled = false) => el('button', { class: `button ${cls}`, onclick: action, disabled }, text);
const timeAgo = (value) => {
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta)) return 'unknown';
  const minutes = Math.max(0, Math.floor(delta / 60_000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
};
// Locale-neutral English dates ("10 Oct 12:23"), whatever the computer's own locale.
const dateTime = (value) => value ? new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '') : '—';
const timeOnly = (value) => value ? new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
/** "12:31" today, "13 Oct 12:31" on another day: a receipt's time (OWNER_WORKSPACE §5.4). */
const clock = (value) => value && new Date(value).toDateString() === new Date().toDateString() ? timeOnly(value) : dateTime(value);
// The supervisor's sentences carry exact UTC times ("resets at 2026-10-13T14:05:00.000Z"): shown as a clock time, with the date when not today.
const clockTimes = (text) => String(text ?? '').replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, (at) =>
  new Date(at).toDateString() === new Date().toDateString() ? timeOnly(at) : dateTime(at));
const panel = (title, description, body, action) => el('section', { class: 'panel' },
  el('div', { class: 'panel-header' }, el('div', {}, el('h2', {}, title), description ? el('p', {}, description) : null), action ?? null), body);
const table = (headers, rows) => el('div', { class: 'table-scroll' }, el('table', {},
  el('thead', {}, el('tr', {}, ...headers.map((text) => el('th', { scope: 'col' }, text)))), el('tbody', {}, ...rows)));
const cell = (...children) => el('td', {}, ...children);
// A notice belongs to the screen of the action it acknowledges: it is shown only at that address, so it never follows the
// owner to another project (aiworks#11 review F20). Back to that address shows it again. A null address is page-wide.
let noticeAddress = null;
const notice = (text, retry, detail = null, address = current.address) => {
  const node = $('#notice'); noticeAddress = address; node.hidden = false;
  node.replaceChildren(document.createTextNode(text));
  if (retry) node.append(button(COMMANDS.retry, retry, 'secondary small'));
  if (detail) node.append(el('details', {}, el('summary', {}, COMMANDS.details), el('p', { class: 'subtext' }, detail)));
};

/** Product forms own required/number errors; native selects retain platform keyboard and popup behavior. */
function validateForm(form) {
  let first = null;
  for (const field of form.querySelectorAll('input, textarea, select')) {
    if (field.disabled || field.closest('[hidden]') || field.type === 'radio') continue;
    const required = field.hasAttribute('required'), value = field.value.trim();
    const min = field.getAttribute('min');
    const message = required && !value ? 'Fill in this field before continuing.'
      : value && field.getAttribute('type') === 'number' && (!Number.isSafeInteger(Number(value)) || min !== null && Number(value) < Number(min))
        ? 'Enter a whole number of 1 or more.'
        // A dollar amount (data-amount): up to two decimals, inside the field's data-min and data-max.
        : value && field.dataset.amount !== undefined && !(/^\d+(?:\.\d{1,2})?$/.test(value) && Number(value) >= Number(field.dataset.min) && Number(value) <= Number(field.dataset.max))
          ? `Enter an amount from $${field.dataset.min} to $${Number(field.dataset.max).toLocaleString('en-US')}, such as 25 or 12.50.` : null;
    const id = `${field.id}-validation`;
    let error = form.querySelector(`#${id}`);
    if (message) {
      if (!error) { error = el('span', { id, class: 'validation-error', role: 'alert' }); field.closest('label')?.append(error); }
      error.textContent = message; error.hidden = false;
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', [...new Set(`${field.getAttribute('aria-describedby') ?? ''} ${id}`.trim().split(/\s+/))].join(' '));
      first ??= field;
    } else { if (error) error.hidden = true; field.removeAttribute('aria-invalid'); }
  }
  first?.focus();
  return !first;
}

/** A link to another screen of this page: a real link, so it opens in a new tab and Back works. */
const routeLink = (text, route, cls = '') => el('a', { href: typeof route === 'string' ? route : formatRoute(route), class: cls }, text);
// A connected project without GitHub is addressed by its project id and named by its own name.
const projectName = (project) => state?.projects?.projects?.find((item) => !item.repository && item.id === project)?.name ?? (shortRepo(project) || project);
// Each screen's heading and the one question it answers (OWNER_WORKSPACE §3.1).
const screenText = { home: ['Home', 'What needs me, and what changed?'], projects: ['Projects', 'Which project should I open?'], needs: ['Needs you', 'What is waiting for me, across projects?'],
  settings: ['Settings', 'What can AIWorks use on this computer?'], accounts: ['Worker accounts', 'Which AI worker logins and accounts are on this computer?'],
  version: ['Version and roadmap', 'Which capabilities are turned on in this version?'],
  instructions: ['Model instructions', 'Which AI models should handle what kind of work?'],
  chats: ['Chats', 'What did I ask AIWorks, and what did it answer?'],
  messages: ['Messages', 'What did I ask AIWorks, and what did it answer?'],
  diagnostics: ['Diagnostics', 'What exactly did the machine record?'], overview: ['Overview', 'Where is the current goal?'], now: ['Overview', 'Where is the current goal?'],
  connections: ['Connections', 'What does AIWorks use on this computer, and can it reach it?'],
  alerts: ['Alerts', 'When does AIWorks tell me that something needs me?'],
  results: ['Review', 'Does the result do what was promised?'], step: ['Step', 'What is happening on this step?'], start: ['Plan work', 'Describe the result. AIWorks proposes the steps.'],
  review: ['Review', 'Is this the right goal and limits?'], plan: ['Plan', 'What will be true when this is done?'], 'add-project': ['Add project', 'Which folder should AIWorks work on?'],
  worklist: ['Work list', 'What is on AIWorks’s own work list?'], 'worklist-item': ['Work item', 'What does this item say, and what happened to it?'],
  'worklist-import': ['Imported issues', 'Which imported GitHub issues should be closed there?'],
  'project-settings': ['Project settings', 'What must AIWorks never change here, and what may it spend?'],
  knowledge: ['Knowledge', 'What does AIWorks know about this product?'], releases: ['Releases', 'What reached users, and what can be undone?'], usage: ['Usage', 'What has AIWorks used, and what is not known?'] };
// The Review tab is keyed apart from a plan's Review, which asks another question.
const screenKey = (route) => route.screen === 'settings' ? route.section ?? 'settings' : route.screen === 'project' ? route.tab === 'review' ? 'results' : 'overview' : route.screen;
const tabLabels = { overview: 'Overview', plan: 'Plan', review: 'Review', releases: 'Releases', knowledge: 'Knowledge' };
// A project's release is configured once a release is recorded for it (AW-010): only then is Releases a tab.
const releaseConfigured = (project) => (state?.supervisor?.releases ?? []).some((r) => sameProject(r.project ?? '', project)
  || projectCampaigns(project).some((c) => c.id === r.campaignId));
// A step whose result the owner reviews belongs to Review; any other step to Overview, whose details hold running work.
const pageTab = (route) => route.screen === 'step' && Object.values(state?.owner?.results ?? {}).some((entry) => entry.groups.some((group) =>
  group.rows.some((row) => row.review && row.campaignId === route.work && row.taskId === route.step))) ? 'review' : tabOf(route);

/** The frame for the current address: heading, page title, aria-current in the global bar and the project tabs. */
function showRoute() {
  const route = current.route, [title, question] = screenText[screenKey(route)];
  const project = route.project ?? null;
  $('#view-eyebrow').textContent = project ? `PROJECT · ${projectName(project).toUpperCase()}` : route.screen === 'settings' && route.section ? 'SETTINGS' : 'AIWORKS';
  $('#view-title').textContent = project && route.screen === 'project' && route.tab === 'overview' ? projectName(project) : route.screen === 'worklist-item' ? `${title} #${route.number}` : title;
  $('#view-description').textContent = question;
  $('#project-back').hidden = !project;
  document.title = [title, project ? projectName(project) : null, 'AIWorks'].filter(Boolean).join(' · ');
  const place = globalOf(route);
  for (const node of document.querySelectorAll('[data-global]')) {
    node.classList.toggle('active', node.dataset.global === place);
    if (node.dataset.global === place) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  }
  const messages = $('#messages-link');
  if (route.screen === 'chats') messages.setAttribute('aria-current', 'page'); else messages.removeAttribute('aria-current');
  // Project tabs are links, not an ARIA tablist: each has its own address.
  showTabs();
  if (project && route.screen === 'project') writeLastProject(project);
  // The screen this project was left on, so coming back to the project opens it again (go(); aiworks#11 review F5).
  if (project) projectMemory.set(project.toLowerCase(), current.address);
  $('#notice').hidden = !$('#notice').childNodes.length || noticeAddress !== null && noticeAddress !== current.address;
  $('#filters').hidden = !(route.screen === 'settings' && route.section === 'diagnostics');
  if (state) render();
}

/**
 * The project tabs (OWNER_UI_V2 section 2). Releases is a tab only where a release is configured, or while it is the open
 * screen. They depend on the state too, so each refresh checks them; unchanged tabs are kept, with their focus.
 */
function showTabs() {
  const route = current.route, project = route.project ?? null, tabs = $('#project-tabs'), tab = project ? pageTab(route) : null;
  const shown = project ? TABS.filter((id) => id !== 'releases' || tab === 'releases' || releaseConfigured(project)) : [];
  const key = JSON.stringify([current.address, tab, shown]);
  tabs.hidden = !project;
  if (tabs.dataset.shown === key) return;
  tabs.dataset.shown = key;
  tabs.replaceChildren(...shown.map((id) => {
    const href = formatRoute(tabRoute(project, id));
    return el('a', { href, class: `tab${id === tab ? ' active' : ''}`, 'aria-current': href === current.address ? 'page' : null }, tabLabels[id]);
  }));
}

// Today's summary cards, each on the screen that now answers it (OWNER_WORKSPACE §9): roadmap items on Diagnostics,
// Needs you on Needs you, agents working on a project's Work. Cost so far is the headline of a project's Cost tab (S7).
function renderMetrics(campaigns = state.supervisor.campaigns, shown = []) {
  const entries = state.roadmap.entries;
  const agents = campaigns.flatMap((c) => c.agents);
  // The owner actions under "Needs you": reviews, decisions, stopped work and a stopped supervisor. A supervisor fault and an
  // unreadable inbox are listed but not counted: they are not the owner's to do. A pause by itself is not listed.
  // A published step whose merge is still being checked is never counted as nothing.
  // Needs you counts and names only what the owner must do (owner, 2026-10-13: "only notifications where I am really
  // needed"); reports to read and work ready for release are on Results, not here.
  const owner = state.owner ?? { count: 0, unknownResults: 0, also: null }, attention = owner.count, unknown = owner.unknownResults;
  const available = state.supervisor.available;
  const verdicts = agents.map((agent) => agentVerdict(agent)[0]);
  const metrics = [
    ['Platform roadmap items', entries.length, null, 'Definitions from the governance checkout; progress is tracked on GitHub', '☷'],
    ['AI workers working', available ? agents.length : '—', null, !available ? 'Not known right now'
      : agents.length ? `${verdicts.filter((v) => v === 'recent').length} working normally${verdicts.some((v) => v === 'stale') ? ` · ${verdicts.filter((v) => v === 'stale').length} possibly stuck or not started` : ''}` : 'None right now', '◎'],
    ['Needs you', !available ? '—' : unknown && !attention ? '?' : attention, available && unknown && attention ? '+ checking' : null,
      !available ? 'Execution state unknown'
        : `${attention ? `${plural(attention, 'item')} listed below` : unknown ? 'Nothing confirmed yet' : 'No work is blocked on you'}${unknown ? ` · merge of ${plural(unknown, 'published step')} being checked` : ''}`, '◈'],
  ];
  $('#metrics').replaceChildren(...metrics.filter(([title]) => shown.includes(title)).map(([title, value, total, foot, icon]) => el('div', { class: 'metric' },
    el('div', { class: 'metric-title' }, title, el('span', { class: 'metric-icon', 'aria-hidden': 'true' }, icon)),
    el('div', { class: 'metric-value number' }, String(value), total ? el('small', {}, total) : null), el('div', { class: 'metric-foot' }, foot))));
  $('#metrics').hidden = !shown.length;
  $('#metrics').classList.toggle('metrics-inline', shown.includes('AI workers working'));
  // The Needs you count in the global bar: never zero while the supervisor state is unknown, and never final while a merge
  // check runs: "7 + checking" until it ends (OWNER_WORKSPACE §1 rule 3, §7.4; aiworks#11 review 4 F3).
  $('#needs-count').textContent = !state.supervisor.available ? '?' : attention ? `${attention}${unknown ? ' + checking' : ''}` : unknown ? 'checking' : '';
}

// governance provider's own roadmap (read from the governance checkout), kept apart from project campaigns; display names replace internal track labels.
const trackNames = { 'Product control plane': 'Control plane: first release', 'Product · next': 'Control plane: after the first release',
  'Autonomous governance': 'Portfolio rules rollout', 'Tracked extensions': 'Other tracked platform work' };
function governanceMissing() {
  const governance = state.roadmap.governance;
  return governance && governance.configured === false ? empty('Governance checkout not configured', governance.reason ?? 'Set governanceRoot in the supervisor config.json or start the dashboard with --governance <path>.') : null;
}
function trackOverview() {
  const missing = governanceMissing();
  if (missing) return panel('governance provider roadmap', 'Read from the governance provider governance checkout.', missing);
  // Definitions only: the dashboard does not read GitHub, so it shows no progress for these items.
  const rows = [...new Set(state.roadmap.entries.map((entry) => entry.track))].map((track) => {
    const list = state.roadmap.entries.filter((item) => item.track === track);
    return el('div', { class: 'track-row' }, el('div', { class: 'row-line' }, el('span', { class: 'track-name' }, trackNames[track] ?? track), el('span', { class: 'track-count number' }, plural(list.length, 'item'))));
  });
  return panel('governance provider roadmap', 'The platform’s own work toward its product, the project control plane. This is separate from your projects. Its progress is tracked on GitHub, not read here.',
    el('div', { class: 'panel-body' }, ...rows));
}

/** A plain verdict per running agent: working normally, possibly stuck, starting or not started. */
function agentVerdict(agent) {
  const last = agent.progress?.lastActivityAt ?? agent.outputAt ?? null;
  const minutes = last ? Math.max(0, Math.floor((Date.now() - last) / 60_000)) : null;
  if (minutes !== null && minutes >= STUCK_MINUTES) {
    const busy = busyOnCommand(agent, Date.now());
    if (busy !== null) return ['recent', `Working: running a command for ${busy} min (usually its tests)`];
  }
  if (minutes !== null) return minutes < STUCK_MINUTES ? ['recent', 'Working normally'] : ['stale', `Possibly stuck: no progress for ${minutes} min`];
  if (agent.heartbeatState === 'recent') return ['recent', 'Working normally'];
  return Date.now() - agent.startedAt < 5 * 60_000 ? ['pending', 'Starting'] : ['stale', 'Not started'];
}

/** Who is on a step now, in the owner's words: "Builder (Claude) · working normally · last activity 2m ago". */
function whoIsOn(c, task) {
  const agent = c.agents.find((item) => item.taskId === task.id);
  if (!agent) return null;
  const [, verdict] = agentVerdict(agent), last = agent.progress?.lastActivityAt ?? agent.outputAt ?? null;
  return `${roleName(agent.role)} (${provider(agent.executor)}) · ${verdict.charAt(0).toLowerCase()}${verdict.slice(1)}${last ? ` · last activity ${timeAgo(last)}` : ''}`;
}

/**
 * How a step is named in a row (OWNER_WORKSPACE §4.7: by its outcome): a short outcome leads; a long one (a whole
 * sentence) gives way to the step's short title and becomes the line under it. The same words twice are shown once.
 */
const OUTCOME_LEAD_MAX = 100;
function stepLabels(task) {
  const outcome = task.outcome ?? null, title = task.title ?? null;
  const lead = outcome && (outcome.length <= OUTCOME_LEAD_MAX || !title) ? outcome : title ?? outcome ?? task.id;
  const other = lead === outcome ? title : outcome;
  return { lead, more: other && other.toLowerCase() !== lead.toLowerCase() ? other : null };
}

/** Who is on a step, without the verdict: "Independent checker (Claude) · last activity 24m ago". */
function whoLine(c, task) {
  const agent = c.agents.find((item) => item.taskId === task.id);
  if (!agent) return null;
  const last = agent.progress?.lastActivityAt ?? agent.outputAt ?? null;
  return `${roleName(agent.role)} (${provider(agent.executor)})${last ? ` · last activity ${timeAgo(last)}` : ''}`;
}
/** The verdict as its own label, placed under the text it describes ("Possibly stuck: no progress for 25 min"). */
function verdictLabel(c, task) {
  const agent = c.agents.find((item) => item.taskId === task.id);
  if (!agent) return null;
  const [cls, verdict] = agentVerdict(agent);
  return el('div', { class: 'cell-labels' }, badge(cls, verdict));
}

/** How the verdicts are decided, shown once rather than on every card. */
const verdictExplanation = () => el('details', { class: 'explain' }, el('summary', {}, 'How “working normally” is decided'),
  el('div', { class: 'notes' }, `Working normally: the agent's own record shows a turn or action in the last ${STUCK_MINUTES} minutes, or, for an agent that reports only at the end, its runner is still alive. `,
    `Running a command: the agent is waiting on one long command, such as its test suite, and its runner is alive (up to an hour). Possibly stuck: no progress for ${STUCK_MINUTES} minutes or more. Not started: no sign of life 5 minutes after it was scheduled. `,
    'Counts come from the agent’s own session record; its prompts and output are never shown here.'));

/** Shown once per page: what an AI worker's wait means and what it never does, in owner words (aiworks#11 review 5 G13). */
const providerNote = () => el('div', { class: 'notes' }, 'AIWorks does not read your AI workers’ account balances: a limit means an AI worker said it hit one, not a measured balance. ',
  'Switching to the next AI worker never overrides a permission denial',
  state.supervisor.campaigns.some((c) => c.maxWorkerRuns !== null) ? ' or raises the run limit of a piece of work.' : '.');

function providerStatus(c) {
  const labels = { running: 'In use now', idle: 'Not in use', cooldown: 'Waiting', unavailable: 'Unavailable',
    'retry-due': 'Retry due', 'not-configured': 'Not used by this work' };
  const host = state.host?.name ?? 'this computer';
  return el('div', { class: 'panel-body' },
    el('p', {}, `${plural(c.agents.length, 'AI worker')} working · ${c.slots} at a time allowed. AI workers are tried in this order.`),
    el('div', { class: 'agents-grid' }, ...(c.providers ?? []).map((p) => el('article', { class: 'agent-card' },
      // A provider that cannot run on this machine at all is not "waiting": say so instead of offering a retry.
      el('strong', {}, `${p.priority ? `${p.priority}. ` : ''}${provider(p.kind)} — ${p.priority && p.hostLimit ? `Not available on ${host}` : labels[p.state]}`),
      p.priority && p.hostLimit ? el('div', { class: 'subtext' }, `No action needed: this work runs without it on ${host}. ${p.hostLimit}.`)
        : p.retryAt ? el('div', { class: 'subtext' }, p.retryAt > Date.now() ? `No action needed — retries automatically at ${timeOnly(p.retryAt)}.`
          : `Overdue: the retry was due at ${timeOnly(p.retryAt)}; it happens at AIWorks' next check.`) : null,
      p.reason ? el('div', { class: 'subtext' }, p.credits ? 'Reported exhausted credits or a billing limit.'
        : p.reason === 'quota' ? 'Reported a usage or rate limit.' : `Last failure: ${p.reason}.`) : null,
      p.availabilityReason ? el('div', { class: 'subtext' }, p.availabilityReason) : null,
      p.priority && !p.hostLimit && p.roleLimit ? el('div', { class: 'subtext' }, `Can check and report on ${host}, but cannot build code there.`) : null))));
}

// What the worker actually returned. "result" only means a valid response arrived; the verdict inside decides.
// A run verdict, not the result's outcome: the result passed only when every criterion did (checkPassed).
const terminalLabels = { accepted: 'accepted by the checker', rejected: 'rejected', resolved: 'built, waiting for the independent check', 'evidence-unavailable': 'could not gather required evidence', 'blocked-owner-reserved': 'blocked on a decision reserved for you' };
const outcomeLabels = { unavailable: 'AI worker unavailable (run not counted)', quota: 'usage limit', auth: 'AI worker sign-in', timeout: 'timed out', lost: 'runner lost', 'invalid-result': 'invalid result', 'exit-without-result': 'exited without a result', 'spawn-failed': 'could not start', error: 'failed',
  'reply-withheld': 'reply withheld because it looked like it contained a credential (it was not posted)',
  'boundary-violation': 'the AI worker changed its checkout or the live runtime; nothing it produced was posted' };
function outcomeText(o) {
  if (!o) return null;
  const what = o.outcome === 'result' ? `${terminalLabels[o.terminal] ?? o.terminal ?? 'result'}${o.terminal === 'rejected' && o.blockingFindings ? ` · ${o.blockingFindings} blocking finding${o.blockingFindings === 1 ? '' : 's'}` : ''}`
    : outcomeLabels[o.outcome] ?? (o.outcome ?? 'unknown').replaceAll('-', ' ');
  return `${roleName(o.role)} (${provider(o.executor)}): ${what}`;
}

// Owner-facing state: a finished step shows whether its merge is seen (merged, published with the merge not seen yet, ...).
function stepBadge(c, task) {
  const delivery = deliveryOf(c, task);
  // Cancelled work never reads as running: its unfinished steps stop with it.
  if (c.control === 'cancelled' && task.state !== 'done') return badge('pending', 'Cancelled');
  if (!delivery && !task.blocked && task.waitingReason && task.state !== 'done') return badge('pending', /dependencies in main/.test(task.waitingReason) ? 'Waiting for merges' : 'Waiting');
  if (!delivery) return badge(task.blocked ? 'blocked' : task.state);
  const [cls, text] = deliveryNames[delivery.state] ?? ['unknown', delivery.state];
  // Delegated merging merges a verified version whatever its criteria say: "passed" only when every criterion passed.
  return badge(cls, delivery.state === 'delegated' ? DELEGATED.word(task.checkPassed === true) : text);
}

const watchChip = (task) => task.attempts >= CHURN_ATTEMPTS || task.verifierRejections > 0
  ? el('span', { class: 'badge watch', title: 'Information only: this step took many tries. It does not limit work.' },
    `Took ${plural(task.attempts, 'try', 'tries')}${task.verifierRejections ? ` · rejected ${task.verifierRejections}×` : ''}`) : null;

/** A remembered open/closed disclosure (survives the 5-second refresh). Its toggle is heard once, on the document. */
const disclosure = (key, summary, body, openByDefault = false) => el('details', { 'data-disclosure': key, open: opened.has(key) || openByDefault && !opened.has(`${key}:closed`) },
  el('summary', {}, summary), body);
document.addEventListener('toggle', (event) => {
  const key = event.target.dataset?.disclosure;
  if (!key) return;
  if (event.target.open) { opened.add(key); opened.delete(`${key}:closed`); } else { opened.delete(key); opened.add(`${key}:closed`); }
}, true);

/** Formats a compact model signature string for task rows, results, and previews. */
function formatTaskSignatureBrief(sig) {
  if (!sig || typeof sig !== 'object') return null;
  const parts = [];
  if (sig.name) {
    const tokens = sig.tokens?.total ? ` · ${sig.tokens.total.toLocaleString()} tokens` : '';
    parts.push(`Signed: ${sig.name} (${sig.type ?? 'model'} · ${sig.effort ?? 'standard'} effort${tokens})`);
  }
  if (sig.verifier?.name) {
    const vTokens = sig.verifier.tokens?.total ? ` · ${sig.verifier.tokens.total.toLocaleString()} tokens` : '';
    parts.push(`Verified: ${sig.verifier.name} (${sig.verifier.type ?? 'model'} · ${sig.verifier.effort ?? 'standard'} effort${vTokens})`);
  }
  return parts.length ? parts.join(' | ') : null;
}

// Step rows: on a phone, CSS turns each row into a stacked card (name, where it stands, link) with no clipped columns.
/**
 * The supervisor's own sentences name a goal's steps by identifier ("Verify T1"). On owner screens each of that goal's
 * step identifiers reads as what the step delivers; the sentence is otherwise unchanged and the record keeps it as written.
 */
const stepWords = (c, text) => {
  if (!c || !text) return text;
  return c.tasks.reduce((out, t) => out.replace(new RegExp(`(^|[^\\w.-])${t.id.replace(/[.]/g, '\\.')}(?![\\w-])`, 'g'), (m, pre) => `${pre}${stepName(c.id, t.id)}`), String(text));
};
// A step is named by its place in the work and by what it delivers, never by its identifier.
const stepNumber = (c, id) => c.tasks.findIndex((item) => item.id === id) + 1;
const stepNames = (c, ids) => ids.map((id) => stepName(c.id, id)).join(', ');
function taskRow(c, task) {
  const canRecheck = !sending && !offline && state.supervisor.available && ['registered', 'paused'].includes(c.control) && Boolean(task.blocked || task.retryAt || task.errorClass) && task.state !== 'done';
  const last = task.state === 'done' ? null : outcomeText(task.lastOutcome);
  const delivery = deliveryOf(c, task);
  const td = (cls, ...children) => el('td', { class: cls }, ...children);
  return el('tr', { 'data-focus-scope': `${c.id}/${task.id}` }, td('c-id', el('span', { class: 'package-id' }, String(stepNumber(c, task.id)))),
    td('c-work', link(task.outcome ?? task.title, task.issueUrl, 'task-name'), task.outcome ? el('div', { class: 'subtext' }, task.title) : null,
      el('div', { class: 'subtext' }, task.dependsOn.length ? `After ${stepNames(c, task.dependsOn)}` : 'Independent step')),
    td('c-state', stepBadge(c, task),
      delivery?.state === 'merged' && delivery.mergedAt ? el('div', { class: 'subtext' }, `Merged ${dateTime(delivery.mergedAt)}`)
        : delivery?.note ? el('div', { class: 'subtext' }, delivery.note) : null,
      delivery?.asOf ? el('div', { class: 'subtext' }, mergeAsOf(delivery.asOf)) : null,
      task.signature ? el('div', { class: 'subtext task-signature' }, formatTaskSignatureBrief(task.signature)) : null,
      // Supervisor-authored wait (for example, dependencies that must be merged first); never worker text.
      task.waitingReason && !task.blocked && task.state !== 'done' ? el('div', { class: 'subtext' }, stepWords(c, task.waitingReason)) : null,
      task.retryAt ? el('div', { class: 'subtext' }, `Next check ${timeOnly(task.retryAt)}`) : null,
      task.blockedReason ? el('div', { class: 'subtext' }, `Stopped: ${task.blockedReason}`) : null,
      !task.blocked && !task.waitingReason && task.state === 'pending' && task.dependsOn.some((dep) => c.tasks.find((item) => item.id === dep)?.state !== 'done')
        ? el('div', { class: 'subtext' }, `Waiting for ${stepNames(c, task.dependsOn.filter((dep) => c.tasks.find((item) => item.id === dep)?.state !== 'done'))}`) : null,
      last ? el('div', { class: 'subtext' }, `Last: ${last}`) : null),
    td('c-tries', el('span', { class: 'number tries' }, plural(task.attempts, 'try', 'tries')), watchChip(task)),
    el('td', { class: 'table-actions c-action' }, delivery?.route ? routeLink(delivery.route.label, delivery.route.address)
      : task.resultUrl ? link(delivery?.number ? `Open PR #${delivery.number} ↗` : 'View result ↗', delivery?.url ?? task.resultUrl)
      : button('Check again', () => command(c, 'recheck', task), 'secondary small', !canRecheck)));
}
const stepsTable = (c) => el('div', { class: 'steps' }, table(['Step', 'What it delivers', 'Where it stands', 'Tries', ''], c.tasks.map((task) => taskRow(c, task))));

/** "8 of 9 steps delivered · 5 merged · 3 waiting for your review": progress in the owner's terms, plus a phone-length form. */
function deliverySummary(c) {
  const counts = ownerCampaign(c)?.counts;
  const delivered = counts?.delivered ?? c.tasks.filter((task) => task.state === 'done').length;
  const parts = [`${delivered} of ${plural(c.tasks.length, 'step')} delivered`];
  if (counts?.merged) parts.push(`${counts.merged} merged`);
  if (counts?.awaiting) parts.push(`${counts.awaiting} waiting for your review`);
  if (counts?.delegated) parts.push(DELEGATED.progress(counts.delegated));
  if (counts?.reports) parts.push(`${plural(counts.reports, 'report')} for you to read`);
  if (counts?.checking) parts.push(`merge of ${counts.checking} being checked`);
  if (counts?.unknown) parts.push(`${counts.unknown} without a recorded result`);
  return { delivered, text: parts.join(' · '), short: `${delivered}/${c.tasks.length} done${counts?.awaiting ? ` · ${counts.awaiting} for you` : ''}` };
}

/** Why the campaign controls are off, so a disabled button is never silent. */
function controlsNote(c) {
  if (!state.supervisor.available) return 'Controls are off until AIWorks can read its work records again.';
  if (offline) return 'Controls are off: this page lost its connection to the dashboard.';
  if (sending) return 'Sending your command…';
  return { finished: 'Controls are off: every step of this work is finished.', cancelled: 'Controls are off: this work was cancelled.',
    'cancel-requested': 'Controls are off: cancellation is in progress.' }[c.control] ?? null;
}

/** The work's state in one sentence, in owner words (the copy module), with liveness reconciled with the agents' own records. */
const campaignNext = (c) => clockTimes(workLine(c, ownerCampaign(c), { time: timeOnly, dateTime }));

// In owner words on the Work card: "AIWorks", never "supervisor"; "work", never "campaign" (aiworks#11 review 5 G13).
const livenessNames = { running: 'AIWorks running', late: 'AIWorks checking in late', 'awaiting-pickup': 'Waiting for AIWorks',
  'agent-working-supervisor-silent': 'AI worker working · AIWorks silent', stopped: 'AIWorks not running',
  'work-lapsed': 'AIWorks running · not checking this work', 'work-not-picked-up': 'AIWorks running · not picked up yet' };
/** The supervisor's state for one campaign; a paused campaign reads neutral, whatever the supervisor is doing. */
function livenessBadge(c, liveness) {
  if (liveness === 'finished') return null;
  // Neutral while a supervisor holds it (or is only late); a paused campaign with no supervisor is not calm.
  if (c.control === 'paused') return badge(['running', 'late', 'awaiting-pickup'].includes(liveness) ? 'unknown' : 'stale', `${livenessNames[liveness] ?? 'AIWorks state unknown'} · work paused`);
  return badge(liveness === 'running' ? 'recent' : ['late', 'awaiting-pickup'].includes(liveness) ? 'pending' : 'stale', livenessNames[liveness]);
}

/** Runs, cost and the AI worker order of one campaign: detail on its card, and the body of the project's Cost tab. */
function costNotes(c) {
  // Unknown cost is "not reported", never $0.00.
  const budget = c.budget, unreported = (budget?.unknownCostRuns ?? 0) + c.agents.length;
  const cost = c.recordedCostUsd > 0 ? `${usd(c.recordedCostUsd)} reported${unreported ? ` + ${plural(unreported, 'run')} not reported yet` : ''}` : 'cost not reported yet';
  return { cost, body: el('div', { class: 'notes' }, `AI workers in order of preference: ${c.executors.map(provider).join(' → ')}. `,
    c.maxWorkerRuns === null ? `${plural(c.runsUsed, 'run')}; this work has no run limit. ` : `${c.runsUsed} of ${plural(c.maxWorkerRuns, 'run')} allowed. `,
    `Cost: ${cost}. `,
    budget?.maxCostUsd ? `${usd(budget.chargedCostUsd)} of the ${usd(budget.maxCostUsd)} ceiling is used, counting each unreported run at ${usd(budget.unknownRunCostUsd)}. `
      : 'This work has no cost ceiling of its own; its project’s budget, when one is set, still counts it. It also pauses when an AI worker reports its own subscription or usage limit, and resumes after the reset. ',
    'Pause stops new work from starting. Check again asks AIWorks to look again; it never skips the independent check.') };
}

function campaignCard(c, expanded = true) {
  // A finished or cancelled campaign has nothing to control: no disabled buttons and no "controls are off" note.
  const terminal = ['finished', 'cancelled'].includes(c.control);
  const controllable = state.supervisor.available && !offline && !sending && ['registered', 'paused'].includes(c.control);
  const note = controllable || terminal ? null : controlsNote(c);
  const unfinished = c.tasks.some((t) => !['done', 'verified'].includes(t.state));
  const controls = terminal ? null : el('div', { class: 'campaign-controls' },
    el('button', { class: 'button secondary small', onclick: () => openInstructions(c), disabled: !controllable || !unfinished, title: note ?? (unfinished ? null : 'Every step is finished; there is no next run to instruct.') }, 'Send instructions'),
    el('button', { class: 'button secondary small', onclick: () => command(c, c.control === 'paused' ? 'resume' : 'pause'), disabled: !controllable, title: note }, c.control === 'paused' ? '▶ Resume' : 'Ⅱ Pause'),
    el('button', { class: 'button secondary small', onclick: () => command(c, 'recheck'), disabled: !controllable, title: note }, '↻ Check again'),
    el('button', { class: 'button text-danger small', disabled: !controllable, title: note, onclick: () => askCancel(c) }, 'Cancel…'));
  const owner = ownerCampaign(c), summary = deliverySummary(c);
  const liveness = owner?.liveness ?? (c.controllerLive ? 'running' : 'stopped');
  const progress = el('progress', { max: c.tasks.length || 1, value: summary.delivered, 'aria-label': 'Steps delivered' });
  const title = el('div', { class: 'campaign-heading' }, el('div', { class: 'row-line' },
    el('div', {}, el('div', { class: 'campaign-title' }, el('h2', {}, campaignTitle(c)), livenessBadge(c, liveness)),
      el('div', { class: 'campaign-meta' }, `Known to AIWorks as ${c.id} · `, link(`tracking issue #${c.trackingIssue ?? ''}`, c.trackingUrl))),
    terminal ? null : el('div', {}, controls, note ? el('div', { class: 'controls-note' }, note) : null)));
  const card = el('section', { class: 'panel', 'data-focus-scope': c.id }, title, el('div', { class: 'campaign-banner' }, el('div', {}, el('strong', {}, campaignNext(c)),
    c.blocker && c.blockerAction ? el('div', { class: 'subtext' }, `What to do: ${c.blockerAction}`) : null),
  el('div', { class: 'campaign-progress' }, progress, el('span', { class: 'long' }, summary.text), el('span', { class: 'short' }, summary.short))));
  // Provider detail matters only while the campaign can still start agents.
  if (expanded) card.append(...(terminal ? [] : [providerStatus(c)]), disclosure(`${c.id}/agent-steps`, `See all ${plural(c.tasks.length, 'step')}`, stepsTable(c)));
  else card.append(disclosure(c.id, `See all ${plural(c.tasks.length, 'step')}`, stepsTable(c)));
  const { cost, body } = costNotes(c);
  card.append(disclosure(`${c.id}/costs`, `Runs, cost and AI workers · ${plural(c.runsUsed, 'run')} · ${cost}`, body));
  if (c.instructions?.length) card.append(disclosure(`${c.id}/instructions`, `Your guidance to AI workers (${c.instructions.length})`,
    el('div', { class: 'instruction-list' }, ...c.instructions.map((item) => instructionReceipt(item, c)))));
  return card;
}

/** A step named by what it delivers, for receipts and notices: never its ID. */
const stepName = (campaignId, taskId) => { const task = campaignById(campaignId)?.tasks.find((t) => t.id === taskId); return task ? `“${task.outcome ?? task.title}”` : 'this step'; };

function instructionReceipt(item, c) {
  const role = roleName(item.role), step = stepName(c.id, item.taskId);
  const steps = [
    receiptStep(true, 'Sent', `AIWorks received your guidance at ${clock(item.at)}`),
    item.status === 'attached' ? receiptStep(true, 'Read', `by the ${role} (${provider(item.executor)}) at ${clock(item.attachedAt)}; it is in that AI worker's instructions`)
      : item.status === 'queued' ? receiptStep(false, 'Waiting', `delivered to the next ${role} run of ${step}; a running AI worker is not interrupted`)
        : receiptStep(false, 'Not delivered', item.status === 'outdated' ? 'the approved goal or limits changed before an AI worker ran' : 'no further run of this step is scheduled', 'failed'),
    item.status === 'attached' ? receiptStep(item.runState === 'finished', item.runState === 'finished' ? 'AI worker finished' : 'AI worker working',
      item.runState === 'finished' ? `outcome: ${terminalLabels[item.runOutcome] ?? outcomeLabels[item.runOutcome] ?? item.runOutcome ?? 'unknown'}` : 'its result will appear here') : null,
  ];
  return el('article', { class: 'receipt' }, el('strong', {}, `${step} · ${role}`), el('p', {}, item.text), el('ol', { class: 'receipt-steps' }, ...steps));
}

function receiptStep(done, label, detail, tone) {
  return el('li', { class: `receipt-step ${tone ?? (done ? 'done' : 'pending')}` }, el('span', { class: 'receipt-mark', 'aria-hidden': 'true' }, tone === 'failed' ? '!' : done ? '✓' : '…'),
    el('span', {}, el('strong', {}, label), ` · ${detail}`));
}

/**
 * A message's receipt (OWNER_WORKSPACE §5.4): "Sent · AIWorks received your request at 12:31", then Read, then Answered.
 * While it waits, a time is promised only when the request reader is known to run (`coordinator.reading`); otherwise the
 * page says it cannot tell when, or that AIWorks has stopped (`aiworks`, the computer-wide state) (aiworks#11 review 4 F12).
 * It is headed by where the request came from, in owner words, with no message number: the page counts messages
 * differently, so a number would not match what the owner sees (aiworks#11 review 5 G16).
 */
function messageReceipt(m, coordinator, aiworks) {
  const from = { 'owner (Start work: Plan only)': 'Your plan request from Start work', 'owner (dashboard)': 'Your message from this dashboard' }[m.source] ?? `From ${m.source}`;
  return el('article', { class: 'receipt' }, el('strong', {}, from), el('p', {}, m.text), el('ol', { class: 'receipt-steps' }, ...receiptSteps(m, coordinator, aiworks)),
    m.replyBody ? disclosure(`message/${m.id}/reply`, 'Read the plan', el('pre', { class: 'coordinator-reply' }, m.replyBody)) : null);
}

function receiptSteps(m, coordinator, aiworks) {
  const steps = [receiptStep(true, 'Sent', `AIWorks received your request at ${clock(m.receivedAt)}`)];
  if (m.state === 'received') {
    steps.push(m.failure === 'project-budget' ? receiptStep(false, 'Waiting for budget', 'the project budget cannot cover reading it. Raise or remove the budget in the project’s settings, or wait for next month if the monthly budget ran out; AIWorks reads it by itself when it fits', 'failed')
      : m.failure ? receiptStep(false, 'Retrying', `the last read ended without an answer (${outcomeLabels[m.failure] ?? m.failure}); next attempt ${dateTime(m.retryAt)}`, 'failed')
      : !coordinator.configured ? receiptStep(false, 'Not read', NOT_READ.receipt, 'failed')
        : coordinator.blocked ? receiptStep(false, 'Not read yet', 'AIWorks cannot read requests right now; why is under Needs you', 'failed')
        : coordinator.maxRunsPerDay !== null && coordinator.runsToday >= coordinator.maxRunsPerDay ? receiptStep(false, 'Waiting', `AIWorks has read today's ${coordinator.maxRunsPerDay} requests; it reads this one when the 24 hours free up`)
          : receiptStep(false, 'Waiting', waitingWords(coordinator, aiworks)));
  } else if (m.readAt) {
    steps.push(receiptStep(true, 'Read', `AIWorks (Claude) started on it at ${clock(m.readAt)}`));
  }
  if (m.state === 'read') {
    steps.push(receiptStep(false, 'Working', m.progress ? `${m.progress.turns} turns · ${m.progress.toolCalls} tool calls · last activity ${timeAgo(m.progress.lastActivityAt)}${m.progress.lastTool ? ` (${m.progress.lastTool})` : ''}` : 'reviewing and planning'));
  } else if (m.state === 'answered') {
    steps.push(receiptStep(true, 'Answered', `${dateTime(m.answeredAt)} · ${m.replyBody ? 'the reply is below' : m.replyUrl ? '' : 'reply unavailable'}`));
    if (m.replyUrl) steps.at(-1).append(link('Open the reply ↗', m.replyUrl));
  } else if (m.state === 'failed') {
    steps.push(receiptStep(false, 'Not answered', `two reads ended without an answer (${outcomeLabels[m.failure] ?? m.failure}). Send it again, or see what AIWorks recorded in Settings › Diagnostics.`, 'failed'));
  }
  return steps;
}

/** What a waiting request is told: a time only when AIWorks is known to be reading requests on this computer right now. */
function waitingWords(coordinator, aiworks) {
  if (coordinator.reading === true) return 'AIWorks is running on this computer and usually starts on a request within a minute';
  if (aiworks?.state === 'stopped') return 'AIWorks has stopped on this computer; it reads your request when it runs again';
  return 'AIWorks reads it when it next runs on this computer; this page can’t tell when that will be';
}

// Whether anything reads requests: yes, no, or not with an invalid configuration.
const readsKey = (coordinator) => coordinator?.configured ? 'yes' : coordinator?.configError ? 'invalid' : 'no';
/**
 * When nothing reads requests, what Start work and Messages show in place of their send action: that nothing will read
 * it, and what the owner can do instead (aiworks#11 review F10). Null while something reads them.
 */
function notRead(coordinator) {
  if (!coordinator || coordinator.configured) return null;
  return el('div', { class: 'notes', 'data-not-read': '' },
    el('p', {}, el('strong', {}, NOT_READ.title), ` ${coordinator.configError ? NOT_READ.invalid : NOT_READ.text}`),
    el('p', {}, `${NOT_READ.instead} `, link(`${NOT_READ.setUp} ↗`, NOT_READ.setUpUrl)),
    coordinator.configError ? disclosure('not-read/details', COMMANDS.details, el('p', { class: 'subtext' }, coordinator.configError)) : null);
}

/** The chats in the latest messages, newest activity first: each is its first message and the follow-ups sent in it. */
function chatList() {
  const chats = new Map();
  for (const m of [...(state.supervisor.coordinator?.messages ?? [])].sort((a, b) => a.id - b.id)) {
    const id = m.threadId ?? m.id;
    if (!chats.has(id)) chats.set(id, []);
    chats.get(id).push(m);
  }
  return [...chats].map(([id, turns]) => ({ id, turns, last: turns.at(-1) })).sort((a, b) => b.last.id - a.last.id);
}
// A plan request is named by its goal; any other chat by the first line of its first message.
function chatTitle(m) {
  const goal = /\nGoal \(what should be true when this is finished\):\r?\n([^\r\n]+)/.exec(m.text)?.[1];
  const line = (goal ?? m.text).trim().split(/\r?\n/)[0];
  return `${goal ? 'Plan: ' : ''}${line.length > 90 ? `${line.slice(0, 89)}…` : line}`;
}
const chatStates = { received: 'Waiting', read: 'AIWorks is working', answered: 'Answered', failed: 'Not answered' };

function chatsScreen(chatId) {
  const coordinator = state.supervisor.coordinator;
  if (!coordinator) return [panel('Chats', 'Not known right now', empty('Chats unavailable', state.supervisor.message ?? ''))];
  const chats = chatList(), open = chatId ? chats.find((chat) => chat.id === chatId) ?? null : null;
  // Starting a chat is offered only while something reads messages; otherwise the panel says so and what to do instead.
  const list = panel('All chats', coordinator.configured
    ? `AIWorks reads them and changes nothing · replies stay in this dashboard · ${coordinator.runsToday}${coordinator.maxRunsPerDay === null ? '' : `/${coordinator.maxRunsPerDay}`} read in the last 24h${coordinator.blocked ? ' · not reading now; why is under Needs you' : ''}`
    : null,
  el('div', {}, notRead(coordinator), chats.length ? el('ul', { class: 'chat-list', 'data-focus-scope': 'chats/list' }, ...chats.map((chat) => el('li', { class: `chat-row${chat.id === open?.id ? ' active' : ''}` },
    routeLink(chatTitle(chat.turns[0]), { screen: 'chats', chat: chat.id }),
    el('div', { class: 'subtext' }, [chat.turns[0].repository, plural(chat.turns.length, 'message'), chatStates[chat.last.state] ?? chat.last.state, dateTime(chat.last.answeredAt ?? chat.last.receivedAt)].filter(Boolean).join(' · ')))))
    : empty('No chats yet', coordinator.configured ? 'Use “New chat” to ask for a review or a plan.' : '')),
  coordinator.configured ? button('✉ New chat', openMessage, 'link') : null);
  const shown = open ? chatView(open, coordinator)
    : chatId ? empty('This chat is not shown', 'Chats show the latest 50 messages on this computer.') : null;
  return [el('div', { class: `chats${shown ? ' open' : ''}` }, list, shown)];
}

function chatView(chat, coordinator) {
  const address = formatRoute({ screen: 'chats', chat: chat.id }), waiting = ['received', 'read'].includes(chat.last.state);
  const text = el('textarea', { id: 'chat-reply', rows: 3, maxlength: 4000, required: true, 'aria-label': 'Reply in this chat',
    placeholder: waiting ? 'AIWorks reads your reply after it answers the last message.' : 'Ask a follow-up. AIWorks sees the earlier messages of this chat.',
    oninput: () => { if (text.value) drafts.set(address, 'reply', text.value); else drafts.delete(address, 'reply'); } });
  text.value = drafts.get(address, 'reply') ?? '';
  // Checked by the page like every form, so an empty or blank reply says why it was not sent beside the field.
  const send = (event) => {
    event.preventDefault();
    if (!validateForm(event.currentTarget) || startBlocked()) return;
    void sendMessage(text.value, chat.id);
  };
  return panel(chatTitle(chat.turns[0]), chat.turns[0].repository ? `Project ${chat.turns[0].repository}` : null,
    el('div', { class: 'chat', 'data-focus-scope': `chats/${chat.id}` }, ...chat.turns.map((m) => el('div', { class: 'chat-turn' },
      el('div', { class: 'chat-bubble owner' }, el('div', { class: 'subtext' }, `You · ${dateTime(m.receivedAt)}`), el('p', {}, m.text)),
      m.replyBody ? el('div', { class: 'chat-bubble aiworks' }, el('div', { class: 'subtext' }, `AIWorks · ${dateTime(m.answeredAt)}`), el('pre', { class: 'coordinator-reply' }, m.replyBody),
        m.replyCampaign ? disclosure(`message/${m.id}/campaign`, 'Proposed campaign (draft, not registered)', m.replyCampaign === '[sensitive content omitted]'
          ? el('p', { class: 'subtext' }, 'Not shown here: the credential check flagged it. The full reply stays in the work records on this computer.')
          : el('pre', { class: 'coordinator-reply' }, m.replyCampaign)) : null)
        : el('ol', { class: 'receipt-steps' }, ...receiptSteps(m, coordinator, state.supervisor.controller)))),
    coordinator.configured ? el('form', { class: 'chat-composer', 'data-chat-form': chat.id, novalidate: true, onsubmit: send }, el('label', {}, text), el('button', { type: 'submit', class: 'button', disabled: startBlocked() }, 'Send')) : null));
}

// While the owner is typing a reply the refresh leaves the chat as it is, so focus, caret and a field message stay; Send
// still follows sending and the connection. The chat shows what changed once the owner leaves the box.
function refreshChat(content, chatId) {
  const form = content.querySelector(`form[data-chat-form="${chatId}"]`);
  if (!form || !form.contains(document.activeElement) || !document.activeElement.matches('textarea')) return false;
  form.querySelector('button[type="submit"]').disabled = startBlocked();
  return true;
}

// Receipt transitions become a notice here and a desktop notification, so the owner learns when work was read.
const seenReceipts = new Map();
let receiptsPrimed = false;
function announce(title, body) {
  notice(`${title} · ${body}`);
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, tag: `${title}:${body}`.slice(0, 120) }); } catch { /* notifications unavailable */ }
}
function trackReceipts() {
  const current = new Map();
  for (const m of state.supervisor.coordinator?.messages ?? []) current.set(`m${m.id}`, [m.state, m]);
  for (const c of state.supervisor.campaigns) for (const i of c.instructions ?? []) current.set(`i${c.id}:${i.id}`, [i.status === 'attached' ? `attached:${i.runState}` : i.status, { ...i, step: stepName(c.id, i.taskId) }]);
  if (receiptsPrimed) for (const [key, [now, item]] of current) {
    const before = seenReceipts.get(key);
    if (before === now) continue;
    if (key.startsWith('m')) {
      if (now === 'received' && !before) announce('Sent', `AIWorks received your request at ${clock(item.receivedAt)}.`);
      else if (now === 'read') announce('Read', 'AIWorks started working on your request.');
      else if (now === 'answered') announce('Answered', item.replyBody ? 'The reply is ready in Chats.' : item.replyUrl ? 'The reply is posted.' : 'Check Chats for the reply.');
      else if (now === 'failed') announce('Not answered', 'Two reads of your request ended without an answer.');
    } else if (now === 'attached:dispatched' || now === 'attached:recorded') announce(`Guidance for ${item.step} read`, `The ${roleName(item.role)} (${provider(item.executor)}) received it.`);
    else if (now === 'attached:finished') announce(`The AI worker that read your guidance for ${item.step} finished`, `Outcome: ${terminalLabels[item.runOutcome] ?? outcomeLabels[item.runOutcome] ?? item.runOutcome ?? 'unknown'}.`);
  }
  for (const [key, [value]] of current) seenReceipts.set(key, value);
  receiptsPrimed = true;
  const open = (state.supervisor.coordinator?.messages ?? []).filter((m) => ['received', 'read'].includes(m.state)).length;
  $('#message-count').textContent = open || '';
}
const askNotifications = () => { try { if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission(); } catch { /* unsupported */ } };

// The new-chat box opens from Chats, so its draft is kept under that address; one typed under Messages before is kept.
const MESSAGES_ADDRESS = formatRoute({ screen: 'chats' });
const messageDraft = {
  get text() { drafts.adopt(); return drafts.get(MESSAGES_ADDRESS, 'message') ?? ''; },
  set text(value) { if (value) drafts.set(MESSAGES_ADDRESS, 'message', value); else drafts.delete(MESSAGES_ADDRESS, 'message'); },
};
function openMessage() {
  const coordinator = state?.supervisor.coordinator;
  $('#message-target').textContent = coordinator?.configured ? 'Replies stay in this dashboard. Nothing is posted to GitHub.' : `${NOT_READ.title} ${NOT_READ.text}`;
  $('#message-text').value = messageDraft.text;
  $('#message-dialog').showModal();
  $('#message-text').focus();
}

// threadId: the chat a reply continues; without it the message starts a chat.
async function sendMessage(text, threadId = null) {
  sending = true; render();
  const requestId = crypto.randomUUID(), from = current.address;
  // An unconfirmed send keeps its Retry: it is said after the refresh, whose "Sent" for the same message would hide it.
  const unconfirmed = () => notice('Delivery could not be confirmed. Retry: the same message is never stored twice.', attempt, null, from);
  let first = true, lost = false;
  const attempt = async () => {
    try {
      const result = await post('/api/messages', { requestId, text, ...(threadId ? { threadId } : {}) });
      const chat = formatRoute({ screen: 'chats', chat: result.threadId ?? result.id });
      // Only the text that was sent is cleared: anything typed while it was on its way stays a draft.
      if (threadId) {
        if (drafts.get(chat, 'reply') === text) { drafts.delete(chat, 'reply'); if (current.address === chat && $('#chat-reply')) $('#chat-reply').value = ''; }
      } else if (messageDraft.text === text) messageDraft.text = '';
      notice(result.duplicate ? 'This message was already received; it was not stored twice.' : `Sent · AIWorks received your request at ${clock(Date.now())}. You will see "Read" when AIWorks starts on it.`, null, null, chat);
      if (current.address !== chat) go(chat);
    } catch (error) {
      if (error.known) notice(error.message, null, null, from);
      else if (first) lost = true;
      else unconfirmed();
    }
  };
  try { await attempt(); } finally { first = false; sending = false; await poll(); if (lost) unconfirmed(); }
}

/*
 * Start work (OWNER_WORKSPACE §4.5, slice S9; build slice UI10): the goal, where the work starts from, and Plan only.
 * "Ask for a plan" sends those parts; the supervisor module writes them into one coordinator message and stores it like
 * any owner message, so the receipt (Received, Read, Answered) shows here in place. Plan only never changes a project
 * file or registers work. Plan and do (slice UI14) is offered only for a connected GitHub project while drafting is
 * switched on: it stores a work request (work.mjs), and its draft plan comes back for Review, where the owner presses
 * Approve and start. Nothing starts before that press.
 */
const PLAN_AND_DO_OFF = ['Starting work from this page is not built yet.', 'Today, work starts when an authorized private plan is registered on this computer.'];
const START_FROM = [['description', 'Just my description'], ['issue', 'A GitHub issue'], ['pull', 'A GitHub pull request']];
const startBlocked = () => sending || offline || !state.supervisor.available;
// The unsent goal and source, kept per address like every draft, and the message id of the last request sent from here.
const startDraft = (address) => ({ goal: '', from: 'description', number: '', sent: null, ...(drafts.get(address, 'start') ?? {}) });

/** The receipt of the last plan request sent from this project's Start work, or null. */
function startReceipt(address) {
  // Plan and do: the request's own state, then Review once its plan is drafted (OWNER_WORKSPACE §5.4 step 4).
  const asked = startDraft(address).sentPlan;
  if (asked) {
    const plan = state.work?.plans?.find((item) => item.id === asked);
    if (plan?.budgetWait) return el('p', { class: 'notice warning' }, `Sent · Waiting for budget. ${BUDGET_WAIT_WORDS}`);
    if (plan?.code === 'RECEIVED') return el('p', { class: 'subtext' }, `Sent · ${receivedText(plan)} The plan appears here when it is ready.`);
    if (!plan || plan.code === 'DRAFTING') return el('p', { class: 'subtext' }, 'Sent · AIWorks is drafting a plan. Nothing changes yet. The plan appears here when it is ready.');
    if (plan.code === 'DRAFT_FAILED') return el('p', { class: 'subtext' }, 'AIWorks couldn’t draft a plan for this request. Ask again, or change the goal.');
    return el('p', { class: 'subtext' }, 'Your plan is ready. ', routeLink('Review the plan', { screen: 'review', project: plan.project, plan: plan.id }), '.');
  }
  const id = startDraft(address).sent, coordinator = state.supervisor.coordinator;
  if (!id || !coordinator) return null;
  const m = coordinator.messages.find((item) => item.id === id);
  return m ? messageReceipt(m, coordinator, state.supervisor.controller) : el('p', { class: 'subtext' }, 'Sent. Its receipt is under ', routeLink('Chats', MESSAGES_ADDRESS), '.');
}

function startScreen(project) {
  const address = formatRoute({ screen: 'start', project }), draft = startDraft(address), coordinator = state.supervisor.coordinator;
  // Plan and do is offered only where it can start: a connected GitHub project, or a project without GitHub whose rules
  // the owner confirmed, with drafting switched on (UI14, UI17).
  const doable = Boolean(state.work?.planAndDo && state.work.projects?.some((name) => sameProject(name, project)));
  // A project without GitHub plans through Plan and do only, from a description: it has no issues or pull requests.
  const local = Boolean(localProject(project));
  if (local && !doable) {
    return [empty('Confirm this project’s rules first.', state.work?.planAndDo ? 'You confirm them on its Overview. Then you can ask for a plan here and approve it.'
      : 'Planning here is switched off in the AIWorks configuration file on this computer.'), routeLink('Open Overview', { screen: 'project', project, tab: 'overview' }, 'button secondary')];
  }
  if (!local && !projectCampaigns(project).length && projectList().find((item) => sameProject(item.id, project))?.kind !== 'GitHub') {
    return [empty('Plan only is not available for this project yet.', 'Planning for projects without a GitHub repository is not available yet.')];
  }
  const doing = local || doable && draft.doing === true;
  const save = () => drafts.set(address, 'start', { goal: goal.value, from: form.elements['start-from'].value, number: number.value, sent: startDraft(address).sent,
    ...(doable ? { doing: local || form.elements['start-mode'].value === 'plan-and-do', report: report.value, sentPlan: startDraft(address).sentPlan } : {}) });
  const goal = el('textarea', { id: 'start-goal', rows: 5, maxlength: 2000, required: true, oninput: save });
  goal.value = draft.goal;
  const number = el('input', { id: 'start-number', type: 'number', min: 1, step: 1, inputmode: 'numeric', required: draft.from !== 'description', oninput: save });
  number.value = draft.number;
  const numberLabel = el('label', { class: 'field', hidden: draft.from === 'description' }, 'Number', number);
  // A described goal on GitHub names the issue AIWorks reports the work to (WORK_ENVELOPE 4.1).
  const report = el('input', { id: 'start-report', type: 'number', min: 1, step: 1, inputmode: 'numeric', required: doing && draft.from === 'description', oninput: save });
  report.value = draft.report ?? '';
  const reportLabel = doable && !local ? el('label',{ class: 'field', hidden: !(doing && draft.from === 'description') }, 'Issue AIWorks reports this work to', report) : null;
  const showReport = () => {
    if (!reportLabel) return;
    const on = form.elements['start-mode'].value === 'plan-and-do' && form.elements['start-from'].value === 'description';
    reportLabel.hidden = !on; report.required = on;
  };
  const from = ([value, label]) => el('label', { class: 'choice' }, el('input', { type: 'radio', name: 'start-from', value, checked: draft.from === value,
    onchange: () => { numberLabel.hidden = value === 'description'; number.required = value !== 'description'; showReport(); save(); } }), ` ${label}`);
  const MODE_TEXT = { 'plan-only': 'AIWorks looks and proposes a plan. Nothing in your project changes.',
    'plan-and-do': 'AIWorks drafts a plan and shows it to you on Review. Nothing starts until you press Approve and start.' };
  const modeText = el('p', {}, MODE_TEXT[doing ? 'plan-and-do' : 'plan-only']);
  const mode = ([value, label]) => el('label', { class: 'choice' }, el('input', { type: 'radio', name: 'start-mode', value, checked: (doing ? 'plan-and-do' : 'plan-only') === value,
    onchange: () => { modeText.textContent = MODE_TEXT[value]; showReport(); save(); } }), ` ${label}`);
  // The form wears the dialogs' styles: each box inside its label, and the choices in framed groups (aiworks#11 review F25).
  // When nothing reads requests, the form keeps the goal but offers no send: it says so and what to do instead (F10).
  const reads = Boolean(coordinator?.configured);
  const form = el('form', { novalidate: true, class: 'panel-body start-form', 'data-start-form': project, 'data-reads': readsKey(coordinator), 'data-doable': String(doable), 'data-focus-scope': `start/${project}`,
    onsubmit: (event) => {
      event.preventDefault(); save();
      if (reads && validateForm(form)) void (doable && (local || form.elements['start-mode'].value === 'plan-and-do') ? askForWork(project, address) : askForPlan(project, address));
    } },
    el('label', { class: 'field' }, el('strong', {}, 'What should be true when this is finished?'), goal),
    el('fieldset', {}, el('legend', {}, 'Start from'), ...START_FROM.slice(0, local ? 1 : undefined).map(from), numberLabel, reportLabel),
    local ? el('div', { class: 'planning-mode' }, el('strong', {}, 'Plan and do'),
      el('p', {}, 'AIWorks drafts a plan and shows it to you on Review. Nothing starts until you press Approve and start, and nothing in your folder changes until you press Apply on a checked result.'))
    : doable ? el('fieldset', { class: 'planning-mode' }, el('legend', {}, 'How far'), mode(['plan-only', 'Plan only']), mode(['plan-and-do', 'Plan and do']), modeText)
      : el('div', { class: 'planning-mode' }, el('strong', {}, 'Plan only'),
        el('p', {}, 'AIWorks looks and proposes a plan. Nothing in your project changes.'),
        el('details', {}, el('summary', {}, 'About starting work'), el('p', { class: 'subtext' }, PLAN_AND_DO_OFF.join(' ')))),
    reads ? el('p', { class: 'subtext' }, 'The plan appears here. Nothing is posted to GitHub. No secrets; up to 2,000 characters.') : notRead(coordinator),
    reads ? el('button', { class: 'button', type: 'submit', disabled: startBlocked() }, 'Ask for a plan') : null,
    el('div', { id: 'start-receipt', 'aria-live': 'polite' }, startReceipt(address)));
  return [el('section', { class: 'panel' }, form)];
}

/** The 5-second refresh keeps the Start work form as typed: only its receipt and button change. False when it must be built. */
function refreshStart(content, project) {
  const form = content.querySelector('form[data-start-form]');
  if (!form || form.dataset.startForm !== project || !state.supervisor.available) return false;
  // Whether anything reads requests changed: the form is built again from the saved draft, with or without its send.
  if (form.dataset.reads !== readsKey(state.supervisor.coordinator)) return false;
  // Plan and do became available or was switched off: built again, so a choice that cannot be sent is never offered.
  if (form.dataset.doable !== String(Boolean(state.work?.planAndDo && state.work.projects?.some((name) => sameProject(name, project))))) return false;
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = startBlocked();
  const receipt = startReceipt(formatRoute({ screen: 'start', project }));
  patch(form.querySelector('#start-receipt'), receipt ? [receipt] : []);
  // This project's plans under the form: kept in place, or the screen is built again when the first one appears.
  const plans = content.querySelector('#start-plans'), rows = planRows(project);
  if (plans) patch(plans, rows);
  else if (rows.length) return false;
  return true;
}

async function askForPlan(project, address) {
  const draft = startDraft(address);
  const plan = { mode: 'plan-only', project, goal: draft.goal, from: draft.from, ...(draft.from === 'description' ? {} : { number: Number(draft.number) }) };
  sending = true; render();
  const requestId = crypto.randomUUID();
  const attempt = async () => {
    try {
      const result = await post('/api/messages', { requestId, plan });
      // Accepted: an empty form for the next request, with this request's receipt under it.
      drafts.set(address, 'start', { sent: result.id });
      document.querySelector('form[data-start-form]')?.remove();
      notice(result.duplicate ? 'This request was already received; it was not stored twice.' : `Sent · AIWorks received your request at ${clock(Date.now())}. You will see "Read" when AIWorks starts on it.`, null, null, address);
    } catch (error) {
      notice(error.known ? error.message : 'Delivery could not be confirmed. Retry: the same request is never stored twice.', error.known ? null : attempt, null, address);
    }
  };
  try { await attempt(); } finally { sending = false; await poll(); }
}

// Plan and do (UI14): one work request; its plan comes back for Review. A retry reuses the request id, so it is stored once.
async function askForWork(project, address) {
  const draft = startDraft(address);
  // A project without GitHub has no issue to report to: its work is described, and its reports stay on this computer.
  const body = localProject(project) ? { project, goal: draft.goal, from: 'description' }
    : { project, goal: draft.goal, from: draft.from, ...(draft.from === 'description' ? { reportTo: Number(draft.report) } : { number: Number(draft.number) }) };
  sending = true; render();
  const requestId = crypto.randomUUID();
  const attempt = async () => {
    try {
      const result = await post('/api/work/requests', { requestId, ...body });
      drafts.set(address, 'start', { doing: true, sentPlan: result.requestId });
      document.querySelector('form[data-start-form]')?.remove();
      notice(result.duplicate ? 'This request was already received; it was not stored twice.' : `Sent · AIWorks received your request at ${clock(Date.now())}. The plan appears here when it is drafted.`, null, null, address);
    } catch (error) {
      notice(error.known ? error.message : 'Delivery could not be confirmed. Retry: the same request is never stored twice.', error.known ? null : attempt, null, address);
    }
  };
  try { await attempt(); } finally { sending = false; await poll(); }
}

/*
 * Review, then Approve and start (OWNER_WORKSPACE §5.5 and S10; WORK_ENVELOPE E8; slice UI14). Review shows the goal,
 * the checks, the steps, overlaps, what may change, the AI workers, limits and "Release: Review only". Approve and start
 * sends the version and digest that were shown; the server registers exactly that plan, or refuses and starts nothing.
 */
const BUDGET_WAIT_WORDS = 'The project budget cannot cover planning it, so AIWorks has not started. Raise or remove the budget in this project’s settings, or wait for next month if the monthly budget ran out; planning starts by itself when it fits.';
// A request with no planning run recorded yet is received, not drafting: queued, or waiting to read its project again.
const RETRY_WORDS = { GITHUB_UNKNOWN: 'GitHub could not be reached', BASE_UNKNOWN: 'the latest version of the project could not be read',
  CHECKOUT_UNAVAILABLE: 'AIWorks’s copy of the project could not be prepared', quota: 'the planning AI worker reached a usage limit',
  auth: 'the planning AI worker is not signed in', unavailable: 'the planning AI worker was not available' };
const receivedText = (plan) => plan.retryAt
  ? `Received. AIWorks has not drafted a plan yet: ${RETRY_WORDS[plan.retryCode] ?? 'its last try did not finish'}. It tries again after ${clock(plan.retryAt)}. Nothing changes yet.`
  : 'Received. AIWorks has not started drafting a plan yet; it starts when its planner is free. Nothing changes yet.';
const PLAN_WORDS = { RECEIVED: 'Received, not drafted yet', DRAFTING: 'Drafting a plan', DRAFT_READY: 'Plan ready', PLAN_ONLY_READY: 'Plan ready (plan only)', CONFLICT: 'Overlaps other work',
  DRAFT_STALE: 'Plan out of date', DRAFT_FAILED: 'Couldn’t draft a plan', APPROVED: 'Approved' };
const projectPlans = (project) => (state.work?.plans ?? []).filter((plan) => sameProject(plan.project, project));
// Only the approval: where the work stands now is on Overview, so this never goes stale.
const approvedText = (at) => `Approved at ${clock(at)}`;
let approving = null;

/** This project's plans, newest first, each with its state and a link to Review. */
function planRows(project) {
  const plans = projectPlans(project);
  if (!plans.length) return [];
  return [el('h2', {}, 'Plans for this project'), el('ul', { class: 'plan-list' }, ...plans.map((plan) => el('li', { 'data-focus-scope': `plan/${plan.id}` },
    routeLink(plan.outcome || 'A plan being drafted', { screen: 'review', project, plan: plan.id }),
    el('span', { class: 'subtext' }, ` · ${PLAN_WORDS[plan.code] ?? 'State unknown'}`))))];
}

/*
 * Plan (OWNER_UI_V2 screen 4, WP3): this project's plans grouped Now, Next and Later, each with its state, priority and
 * version, a link to Review where it is approved, and its version history from the stored drafts. It reads the same
 * plans as Review (work.mjs workView); nothing here plans, approves or starts. Edit plan opens Review with the edit
 * begun from the version shown, kept as a draft of Review's address, so an edit in progress is never lost or doubled.
 */
const HORIZON_ORDER = ['now', 'next', 'later'];
const planAddress = (project, plan) => formatRoute({ screen: 'review', project, plan: plan.id });
function editFromPlan(project, plan) {
  const address = planAddress(project, plan);
  if (!drafts.get(address, 'edit')) startEdit(project, plan, { open: false });
  go(address);
  document.querySelector('#edit-outcome')?.focus();
}
function versionHistory(plan) {
  const versions = plan.versions ?? [];
  if (!versions.length) return null;
  return disclosure(`plan/${plan.id}/versions`, `Versions (${versions.length})`, el('ol', { class: 'plan-versions', reversed: true },
    ...versions.map((v) => el('li', { 'data-version': String(v.version) },
      el('strong', {}, `Version ${v.version}${v.version === plan.version ? ' (shown on Review)' : ''}`),
      el('div', { class: 'subtext' }, [v.by === 'owner' ? `Your edit of version ${v.editedFrom}` : 'Drafted by AIWorks', clock(v.at),
        HORIZON_WORDS[v.horizon] ?? 'Now', v.changes === null ? null : v.changes ? `${plural(v.changes, 'change')} from version ${v.version - 1}` : 'No change from the version before',
        v.scopeChanged ? 'the scope changed' : null].filter(Boolean).join(' · ')),
      v.outcome ? el('div', { class: 'subtext' }, v.outcome) : null))));
}
function planItem(project, plan) {
  const address = planAddress(project, plan), editing = Boolean(drafts.get(address, 'edit'));
  const off = Boolean(approving) || sending || offline || !state.supervisor.available;
  const edit = plan.editable && state.work?.planAndDo
    ? el('button', { class: 'button secondary small', type: 'button', disabled: off, onclick: () => editFromPlan(project, plan) }, editing ? 'Continue editing' : 'Edit plan') : null;
  const word = plan.budgetWait ? 'Waiting for budget' : PLAN_WORDS[plan.code] ?? 'State unknown';
  return el('li', { class: 'result-row plan-row', 'data-focus-scope': `plan/${plan.id}`, 'data-state': plan.code },
    el('div', { class: 'needs-text' }, routeLink(plan.outcome || 'A plan being drafted', { screen: 'review', project, plan: plan.id }, 'task-name')),
    el('div', { class: 'result-state' }, [word, plan.version ? `${PRIORITY_WORDS[plan.priority] ?? 'Normal'} priority` : null, plan.version ? `version ${plan.version}` : null,
      plan.version ? estimateText(plan.estimate).replace(/\.$/, '') : null].filter(Boolean).join(' · ')),
    plan.code === 'DRAFT_STALE' ? el('p', { class: 'notice warning' }, `${projectName(project)} changed since this plan was drafted. Draft it again before approving.`) : null,
    editing ? el('p', { class: 'subtext' }, 'You have unsaved edits to this plan on Review.') : null,
    plan.approvedAt ? el('div', { class: 'subtext' }, approvedText(plan.approvedAt)) : null,
    edit ? el('div', { class: 'campaign-controls' }, edit) : null,
    versionHistory(plan),
    // Once approved and started: its approved versions and admitted amendments, from the goal's own record.
    plan.code === 'APPROVED' && plan.campaignId ? goalVersionList(campaignById(plan.campaignId)) : null);
}
/**
 * Whether Plan work offers a form for this project, as `startScreen` decides it and Overview offers it: Plan and do where
 * it can start, Plan only on a GitHub project whose connection allows work or that already has work.
 */
function planWorkOpen(project) {
  if (offline || !state.supervisor.available) return false;
  if (localProject(project)) return Boolean(state.work?.planAndDo && state.work.projects?.some((item) => sameProject(item, project)));
  if (projectCampaigns(project).length) return true;
  const row = projectList().find((item) => sameProject(item.id, project));
  return row?.kind === 'GitHub' && (!row.connection || Boolean(row.connection.startWork?.allowed));
}
function planScreen(project) {
  if (!state.supervisor.available) return [unavailable()];
  const plans = projectPlans(project), open = planWorkOpen(project);
  const doable = Boolean(state.work?.planAndDo && state.work.projects?.some((item) => sameProject(item, project)));
  const start = open ? routeLink('Plan work', { screen: 'start', project }, 'button secondary') : null;
  if (!plans.length) {
    const off = state.work?.planAndDo ? 'Plan and do, which drafts plans here for Review, is not available for this project.'
      : 'Plan and do, which drafts plans here for Review, is off on this computer.';
    return [el('section', { class: 'panel', 'data-focus-scope': `plan/${project}` }, empty('No plans yet', doable && open
      ? 'Describe a result under Plan work; AIWorks drafts a plan here for you to review. Nothing starts until you approve it.'
      : open ? `Ask under Plan work and AIWorks proposes a plan there, changing nothing in the project. ${off}`
        : offline ? 'Plan work opens again when this page is connected.'
          : localProject(project) && state.work?.planAndDo ? 'Confirm this project’s rules on its Overview first. Then you can ask for a plan under Plan work.'
            : `Plan work is not available for this project. ${off}`), start)];
  }
  const group = (key, title, list) => list.length ? el('section', { class: 'needs-group', 'aria-labelledby': `plan-group-${key}`, 'data-focus-scope': `plan-group/${key}` },
    el('h3', { id: `plan-group-${key}`, class: 'section-title' }, `${title} (${list.length})`),
    el('ul', { class: 'needs-list' }, ...list.map((plan) => planItem(project, plan)))) : null;
  const drafting = plans.filter((plan) => !plan.version);
  return [el('section', { class: 'panel', 'aria-labelledby': 'plan-title', 'data-focus-scope': `plan/${project}` },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', { id: 'plan-title' }, `${plural(plans.length, 'plan')}, by when`),
      el('p', {}, 'Now, Next and Later are yours to set with Edit plan. Approve and start is on Review, for exactly the version it shows.')), start),
    ...HORIZON_ORDER.map((key) => group(key, HORIZON_WORDS[key], plans.filter((plan) => plan.version && (plan.horizon ?? 'now') === key))),
    group('drafting', 'Not drafted yet', drafting))];
}

function reviewScreen(project, id) {
  const plan = projectPlans(project).find((item) => item.id === id);
  const back = routeLink('Start work', { screen: 'start', project }, 'button secondary');
  if (!plan) return [empty('This plan is not on this computer', 'It may belong to another project, or the address is mistyped.'), back, routeLink('All plans', { screen: 'plan', project }, 'button secondary')];
  if (!plan.version) {
    return [plan.code === 'DRAFT_FAILED' ? empty('AIWorks couldn’t draft a plan', 'Ask again from Start work, or change the goal.')
      : plan.budgetWait ? empty('Waiting for budget', BUDGET_WAIT_WORDS)
      : plan.code === 'RECEIVED' ? empty('Not drafted yet', ` ${receivedText(plan)} This page shows the plan when it is ready.`)
      : empty('AIWorks is drafting a plan', 'Nothing changes yet. This page shows the plan when it is ready.'), back];
  }
  const items = (values) => el('ul', {}, ...values.map((value) => el('li', {}, value)));
  const part = (title, ...body) => el('div', { class: 'review-part' }, el('h3', {}, title), ...body);
  // Each step of other work once (ownerTaskId is that step; taskId is this plan's), and none already merged.
  const overlaps = [...new Map(plan.conflicts.map((item) => [`${item.campaignId}/${item.ownerTaskId || item.taskId}`, item])).values()].map((item) => {
    const c = campaignById(item.campaignId), task = c?.tasks.find((t) => t.id === (item.ownerTaskId || item.taskId));
    return { item, c, task };
  }).filter(({ c, task }) => !(c && task && deliveryOf(c, task)?.state === 'merged'));
  const status = plan.code === 'APPROVED' ? el('p', { class: 'notice' }, approvedText(plan.approvedAt), ' · ', routeLink('Open Overview', { screen: 'project', project, tab: 'overview' }))
    : plan.code === 'DRAFT_STALE' ? el('p', { class: 'notice warning' }, `${projectName(project)} changed since this plan was drafted (${plan.staleWhat.join(', ') || 'its source changed'}). Draft it again before approving. `,
      routeLink('Plan again', { screen: 'start', project }))
      : plan.code === 'CONFLICT' ? el('p', { class: 'notice warning' }, 'This plan overlaps other work. Approve anyway and the overlapping step waits for it, or ask for a new plan without that step.')
        : el('p', {}, plan.planOnly ? 'This plan changes nothing yet. You can start it while the project stays as it is.' : 'Here’s what AIWorks would do, what it may change and how it will be checked.');
  const busy = approving === plan.id;
  const approve = el('button', { class: 'button', type: 'button', disabled: !plan.startable || Boolean(approving) || sending || offline || !state.supervisor.available,
    'aria-busy': busy ? 'true' : null, onclick: () => void approvePlan(project, plan) }, busy ? 'Starting…' : 'Approve and start');
  const limits = plan.limits && Object.keys(plan.limits).length ? `Limits: ${Object.entries(plan.limits).map(([key, value]) => `${key} ${value}`).join(', ')}.` : 'No limits. You can pause or cancel it at any time.';
  const address = formatRoute({ screen: 'review', project, plan: plan.id }), editing = drafts.get(address, 'edit');
  // While the owner edits, the form stays as typed (refreshReview) and nothing can be approved: Approve starts only a shown, saved version.
  if (editing) return [el('section', { class: 'panel review', 'data-focus-scope': `review/${plan.id}` }, el('div', { class: 'panel-body' },
    el('h2', {}, `Edit plan · version ${editing.baseVersion}`), editForm(project, plan, address)))];
  const criteria = plan.criteria?.length ? plan.criteria : (plan.acceptance ?? []).map((text) => ({ text, check: null }));
  const edit = plan.editable && state.work?.planAndDo ? button('Edit plan', () => startEdit(project, plan), 'secondary', Boolean(approving) || sending || offline || !state.supervisor.available) : null;
  return [el('section', { class: 'panel review', 'data-focus-scope': `review/${plan.id}` }, el('div', { class: 'panel-body' },
    el('h2', {}, plan.outcome || 'Review the plan'), status,
    plan.textCheck && plan.textCheck !== 'ready' ? el('p', { class: 'notice', role: 'status' }, plan.textCheck === 'checking'
      ? 'Checking the plan details before displaying them. Approval becomes available when the check finishes.'
      : 'The plan details could not be checked. The original is kept; approval stays unavailable while those details cannot be shown.') : null,
    plan.changes?.length ? planChanges(plan) : null,
    part('Goal', el('p', {}, plan.goal || 'Not stated.'), el('p', { class: 'subtext' }, `${HORIZON_WORDS[plan.horizon] ?? 'Now'} · ${PRIORITY_WORDS[plan.priority] ?? 'Normal'} priority`)),
    part('Done when', el('ul', {}, ...criteria.map((item) => el('li', {}, item.text,
      el('span', { class: 'subtext' }, item.check ? ` · checked by: ${item.check}` : ' · how it is checked is not stated'))))),
    part('Included', plan.included?.length ? items(plan.included) : el('p', {}, 'Not listed.')),
    part('Later', plan.later?.length ? items(plan.later) : el('p', {}, 'Nothing is left for later.')),
    part('Estimate', el('p', {}, estimateText(plan.estimate))),
    part('Main steps', plan.steps.length ? el('ol', {}, ...plan.steps.map((step) => el('li', {}, step.title, step.check ? el('span', { class: 'subtext' }, ` · checked by: ${step.check}`) : null)))
      : items(plan.tasks.map((task) => task.title))),
    part('Overlaps with other work', overlaps.length ? items(overlaps.map(({ item, c, task }) => [
      c && task ? routeLink(stepName(c.id, task.id).replace(/^“|”$/g, ''), { screen: 'step', project: c.repository, work: c.id, step: task.id }) : 'A step of other work',
      item.code === 'DUPLICATE_WORK' ? ' is already assigned. Starting is refused until that work finishes or is cancelled.' : ' is changing the same files. This step waits for it.'])) : el('p', {}, 'None found.')),
    part('What it may change', plan.writes.length ? items(plan.writes) : el('p', {}, 'No files: it only reports.'),
      plan.denyWrites.length ? el('p', { class: 'subtext' }, `Never: ${plan.denyWrites.join(', ')}`) : null),
    part('AI workers and limits', el('p', {}, plan.providers.length ? `Uses ${plan.providers.join(', ')}.` : 'AI workers: not stated.'), el('p', {}, limits)),
    part('Release', el('p', {}, plan.local ? 'Release: Review only. AIWorks stops when a result passes the check. Nothing in your folder changes until you press Apply on it, and Undo apply puts it back.'
      : 'Release: Review only. AIWorks stops when a result passes the check and is published. You merge and release.')),
    plan.questions.length ? part('Open questions', items(plan.questions)) : null,
    el('details', {}, el('summary', {}, 'Plan details'), el('p', { class: 'subtext' }, plan.summary),
      el('p', { class: 'subtext' }, `Plan version ${plan.version}`)),
    plan.code === 'APPROVED' ? null : el('div', { class: 'review-actions' }, approve, edit)))];
}

/*
 * Edit plan (OWNER_UI_V2 WP3). The owner edits the goal, done-when criteria and how each is checked, included and later,
 * Now, Next or Later, priority and the estimate; what the work may change, protected paths, AI workers, limits and
 * release are not edited here. Saving makes the next version, which is shown with its changes before it can be approved.
 * The unsent edit is a draft of this address: it survives the refresh, a reload and Back, and is cleared only by an
 * accepted save or Discard. A plan that changed meanwhile keeps the edit and says so; the save names the version it
 * was made on, so the server refuses it rather than overwrite another version.
 */
const HORIZON_WORDS = { now: 'Now', next: 'Next', later: 'Later' };
const PRIORITY_WORDS = { high: 'High', normal: 'Normal', low: 'Low' };
const UNIT_WORDS = { hours: ['hour', 'hours'], days: ['day', 'days'] };
const estimateText = (estimate) => estimate ? `About ${estimate.amount} ${UNIT_WORDS[estimate.unit]?.[estimate.amount === 1 ? 0 : 1] ?? estimate.unit} of AI work.` : 'No estimate.';
const SCOPE_WORDS = { writes: 'What it may change', denyWrites: 'Protected paths', deliverables: 'What it delivers', release: 'Release', providers: 'AI workers',
  limits: 'Limits', steps: 'Steps', source: 'The project version it starts from' };
const quoted = (text) => `“${text}”`;
let savingEdit = null;

/** One change from the version before, in a sentence. */
function changeText(item) {
  const check = (value) => value ?? 'not stated';
  const estimate = (value) => estimateText(value).replace(/\.$/, '');
  switch (`${item.field} ${item.change}`) {
    case 'outcome changed': return `Goal: ${quoted(item.before)} → ${quoted(item.after)}`;
    case 'criteria added': return `Done when, added: ${quoted(item.after)}${item.check ? ` · checked by: ${item.check}` : ''}`;
    case 'criteria removed': return `Done when, removed: ${quoted(item.before)}`;
    case 'check changed': return `How ${quoted(item.criterion)} is checked: ${check(item.before)} → ${check(item.after)}`;
    case 'included added': return `Included, added: ${quoted(item.after)}`;
    case 'included removed': return `Included, removed: ${quoted(item.before)}`;
    case 'later added': return `Later, added: ${quoted(item.after)}`;
    case 'later removed': return `Later, removed: ${quoted(item.before)}`;
    case 'horizon changed': return `Moved from ${HORIZON_WORDS[item.before] ?? item.before} to ${HORIZON_WORDS[item.after] ?? item.after}`;
    case 'priority changed': return `Priority: ${PRIORITY_WORDS[item.before] ?? item.before} → ${PRIORITY_WORDS[item.after] ?? item.after}`;
    case 'estimate changed': return `Estimate: ${estimate(item.before)} → ${estimate(item.after)}`;
    default: return `${SCOPE_WORDS[item.field] ?? item.field} changed.`;
  }
}

/** What changed from the version before, scope changes apart: they need the owner's eye before Approve and start. */
function planChanges(plan) {
  const scope = plan.changes.filter((item) => item.scope), own = plan.changes.filter((item) => !item.scope);
  return el('div', { class: 'review-part plan-changes' }, el('h3', {}, `Changes from version ${plan.previousVersion}`),
    own.length ? el('ul', {}, ...own.map((item) => el('li', {}, changeText(item)))) : null,
    scope.length ? el('div', { class: 'notice warning' }, el('strong', {}, 'The scope changed. '), 'Check these before you approve:',
      el('ul', {}, ...scope.map((item) => el('li', {}, changeText(item))))) : null);
}

/** The edit begins from the plan as shown: its version and fingerprint, and its current parts. */
function startEdit(project, plan, { open = true } = {}) {
  const address = formatRoute({ screen: 'review', project, plan: plan.id });
  const criteria = plan.criteria?.length ? plan.criteria : (plan.acceptance ?? []).map((text) => ({ text, check: null }));
  drafts.set(address, 'edit', { baseVersion: plan.version, baseDigest: plan.authorityDigest, outcome: plan.outcome ?? '', horizon: plan.horizon ?? 'now',
    priority: plan.priority ?? 'normal', criteria: criteria.map((item) => ({ text: item.text, check: item.check ?? '' })), included: (plan.included ?? []).join('\n'),
    later: (plan.later ?? []).join('\n'), estimated: Boolean(plan.estimate), amount: plan.estimate ? String(plan.estimate.amount) : '', unit: plan.estimate?.unit ?? 'days' });
  if (!open) return;
  render();
  document.querySelector('#edit-outcome')?.focus();
}

/** The note above the edit form: the plan changed, or can no longer be edited, since the edit began. Null when neither. */
function editStale(plan, edit) {
  if (!plan.editable) return el('p', { class: 'notice warning' }, 'This plan can no longer be edited: it was approved or is out of date. Your edits stay here until you discard them.');
  if (plan.version === edit.baseVersion && plan.authorityDigest === edit.baseDigest) return null;
  return el('p', { class: 'notice warning' }, `This plan changed since you started editing: it is now version ${plan.version}. Your edits are kept. `,
    button(`Use my edits on version ${plan.version}`, () => { drafts.set(current.address, 'edit', { ...edit, baseVersion: plan.version, baseDigest: plan.authorityDigest }); rebuildEdit(); }, 'secondary small'));
}

/** Build the edit form again from the saved draft (after Add, Remove or a rebase); focus goes to `focus` when given. */
function rebuildEdit(focus) {
  const form = document.querySelector('form[data-edit-form]');
  const plan = form && projectPlans(current.route.project).find((item) => item.id === form.dataset.editForm);
  if (!plan) return render();
  form.replaceWith(editForm(current.route.project, plan, current.address));
  document.querySelector(focus ?? '#edit-outcome')?.focus();
}

function editForm(project, plan, address) {
  const edit = drafts.get(address, 'edit');
  const save = () => {
    const criteria = [...form.querySelectorAll('[data-criterion]')].map((row) => ({ text: row.querySelector('.criterion-text').value, check: row.querySelector('.criterion-check').value }));
    drafts.set(address, 'edit', { ...drafts.get(address, 'edit'), outcome: outcome.value, horizon: form.elements['edit-horizon'].value, priority: priority.value, criteria,
      included: included.value, later: later.value, estimated: form.elements['edit-estimate'].value === 'yes', amount: amount.value, unit: unit.value });
  };
  const outcome = el('input', { id: 'edit-outcome', type: 'text', maxlength: 300, required: true, oninput: save });
  outcome.value = edit.outcome;
  const horizon = (value) => el('label', { class: 'choice' }, el('input', { type: 'radio', name: 'edit-horizon', value, checked: edit.horizon === value, onchange: save }), ` ${HORIZON_WORDS[value]}`);
  const priority = el('select', { id: 'edit-priority', onchange: save }, ...Object.entries(PRIORITY_WORDS).map(([value, label]) => el('option', { value, selected: edit.priority === value }, label)));
  const change = (update, focus) => { save(); const next = drafts.get(address, 'edit'); update(next.criteria); drafts.set(address, 'edit', next); rebuildEdit(focus(next.criteria)); };
  const criterion = (item, index) => {
    const text = el('input', { id: `edit-criterion-${index}`, class: 'criterion-text', type: 'text', maxlength: 300, required: true, oninput: save });
    text.value = item.text;
    const check = el('input', { id: `edit-check-${index}`, class: 'criterion-check', type: 'text', maxlength: 300, oninput: save });
    check.value = item.check ?? '';
    const remove = el('button', { class: 'button secondary small', type: 'button', disabled: edit.criteria.length < 2, 'aria-label': `Remove criterion ${index + 1}`,
      onclick: () => change((list) => list.splice(index, 1), () => '#edit-add-criterion') }, 'Remove');
    return el('div', { class: 'edit-criterion', 'data-criterion': String(index) },
      el('label', { class: 'field' }, `Criterion ${index + 1}`, text), el('label', { class: 'field' }, 'How it is checked (optional)', check), remove);
  };
  const add = el('button', { id: 'edit-add-criterion', class: 'button secondary small', type: 'button', disabled: edit.criteria.length >= 16,
    onclick: () => change((list) => list.push({ text: '', check: '' }), (list) => `#edit-criterion-${list.length - 1}`) }, 'Add a criterion');
  const included = el('textarea', { id: 'edit-included', rows: 3, oninput: save });
  included.value = edit.included;
  const later = el('textarea', { id: 'edit-later', rows: 3, oninput: save });
  later.value = edit.later;
  const amount = el('input', { id: 'edit-amount', type: 'number', min: 1, step: 1, inputmode: 'numeric', required: edit.estimated, oninput: save });
  amount.value = edit.amount;
  const unit = el('select', { id: 'edit-unit', onchange: save }, ...Object.entries(UNIT_WORDS).map(([value, words]) => el('option', { value, selected: edit.unit === value }, words[1])));
  const amountFields = el('div', { class: 'edit-estimate', hidden: !edit.estimated }, el('label', { class: 'field' }, 'Amount', amount), el('label', { class: 'field' }, 'Unit', unit));
  const estimate = (value, label) => el('label', { class: 'choice' }, el('input', { type: 'radio', name: 'edit-estimate', value, checked: edit.estimated === (value === 'yes'),
    onchange: () => { amountFields.hidden = value !== 'yes'; amount.required = value === 'yes'; save(); } }), ` ${label}`);
  const busy = savingEdit === plan.id;
  const form = el('form', { novalidate: true, class: 'start-form edit-form', 'data-edit-form': plan.id, 'data-focus-scope': `edit/${plan.id}`,
    onsubmit: (event) => { event.preventDefault(); save(); if (!savingEdit && validateForm(form)) void saveEdit(plan.id, address); } },
    el('div', { id: 'edit-stale', role: 'status', 'aria-live': 'polite' }, editStale(plan, edit)),
    el('label', { class: 'field' }, el('strong', {}, 'What should be true when this is finished?'), outcome),
    el('fieldset', {}, el('legend', {}, 'When'), ...['now', 'next', 'later'].map(horizon)),
    el('label', { class: 'field' }, 'Priority', priority),
    el('fieldset', {}, el('legend', {}, 'Done when'), ...edit.criteria.map(criterion), add),
    el('label', { class: 'field' }, 'Included, one per line', included),
    el('label', { class: 'field' }, 'Left for later, one per line', later),
    el('fieldset', {}, el('legend', {}, 'Estimate'), estimate('no', 'No estimate'), estimate('yes', 'Estimate'), amountFields),
    el('p', { class: 'subtext' }, 'What the work may change, protected paths, AI workers, limits and release stay as reviewed. To change them, ask for a new plan.'),
    el('div', { class: 'review-actions' },
      el('button', { class: 'button', type: 'submit', disabled: !plan.editable || offline || !state.supervisor.available || Boolean(savingEdit), 'aria-busy': busy ? 'true' : null },
        busy ? 'Saving…' : `Save as version ${plan.version + 1}`),
      el('button', { class: 'button secondary', type: 'button', onclick: () => { drafts.delete(address, 'edit'); render(); document.querySelector('.review-actions .button:not([disabled])')?.focus(); } }, 'Discard edits')));
  return form;
}

/** The 5-second refresh keeps the edit form as typed: only its note about a changed plan and its Save change. */
function refreshReview(content, project, id) {
  const form = content.querySelector('form[data-edit-form]'), plan = projectPlans(project).find((item) => item.id === id);
  const edit = drafts.get(current.address, 'edit');
  if (!form || !plan || !edit || form.dataset.editForm !== id) return false;
  patch(form.querySelector('#edit-stale'), [editStale(plan, edit)].filter(Boolean));
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = !plan.editable || offline || !state.supervisor.available || Boolean(savingEdit);
  if (savingEdit !== id) submit.textContent = `Save as version ${plan.version + 1}`;
  return true;
}

/** Save the edit as the next version. A retry reuses the edit's request id, kept with the draft, so it is saved once. */
async function saveEdit(id, address) {
  const edit = drafts.get(address, 'edit');
  const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
  const requestId = edit.requestId ?? crypto.randomUUID();
  drafts.set(address, 'edit', { ...edit, requestId });
  const body = { requestId, plan: id, version: edit.baseVersion, authorityDigest: edit.baseDigest, edits: { outcome: edit.outcome.trim(), horizon: edit.horizon,
    priority: edit.priority, criteria: edit.criteria.map((item) => ({ text: item.text.trim(), check: item.check.trim() || null })), included: lines(edit.included),
    later: lines(edit.later), estimate: edit.estimated ? { amount: Number(edit.amount), unit: edit.unit } : null } };
  savingEdit = id; rebuildEdit('form[data-edit-form] button[type="submit"]');
  const attempt = async () => {
    try {
      const result = await post('/api/work/edit', body);
      drafts.delete(address, 'edit');
      notice(`${result.duplicate ? 'Already saved' : 'Saved'} as version ${result.version}. Check the changes, then approve this version.`, null, null, address);
    } catch (error) {
      // Refused: nothing was saved, so the next save is a new request and the edit stays as typed.
      if (error.known) { const kept = drafts.get(address, 'edit'); if (kept) drafts.set(address, 'edit', { ...kept, requestId: undefined }); }
      notice(error.known ? error.message : 'Saving could not be confirmed. Retry: the same edit is never saved twice.', error.known ? null : attempt, error.known ? error.detail : null, address);
    }
  };
  try { await attempt(); } finally { savingEdit = null; await poll(); render(); }
}

async function approvePlan(project, plan) {
  const from = current.address, requestId = crypto.randomUUID();
  approving = plan.id; render();
  const attempt = async () => {
    try {
      const result = await post('/api/work/approve', { requestId, plan: plan.id, version: plan.version, authorityDigest: plan.authorityDigest });
      const work = formatRoute({ screen: 'project', project, tab: 'overview' });
      if (current.address === from) go(work);
      notice(approvedText(result.approvedAt), null, null, work);
    } catch (error) {
      // A changed plan is refused: the refresh below loads it again and the owner stays on Review; Details keeps the machine's reason.
      notice(error.known ? error.message : 'Approval could not be confirmed. Retry: the same approval never starts work twice.', error.known ? null : attempt, error.known ? error.detail : null, from);
    }
  };
  try { await attempt(); } finally { approving = null; await poll(); }
}

/*
 * A project without GitHub (OWNER_WORKSPACE S12 and §5.3; slice UI17). Its approved plans, their steps and their checked
 * results come from the work view (state.work.local), never from GitHub. A checked result changes the owner's folder
 * only when they press Apply, and Undo apply puts the folder back. No pull request is ever shown.
 */
const localProject = (project) => projectList().find((item) => !item.repository && item.id === project) ?? null;
const localWork = (project) => state.work?.local?.[project] ?? [];
const LOCAL_CONTROL = { registered: 'Approved. AIWorks works on its own copy of your folder; nothing in your folder changes until you press Apply.',
  paused: 'Paused. Nothing new starts until it is resumed.', finished: 'All steps are finished. The checked results are under Review.', cancelled: 'Cancelled.' };
let applying = null;
const sentenceOf = (text) => /[.!?…]$/.test(text) ? text : `${text}.`;

/**
 * The first open decision of a step of this project's running work (OWNER_UI_V2 WP2), as decisionPanel takes it: the goal's
 * versions and the step with its decision, answered through the same bound /api/v2/decisions route as a GitHub step's.
 */
function localDecision(project, match = () => true) {
  for (const c of localWork(project).filter((item) => ['registered', 'paused'].includes(item.control))) {
    const step = c.steps.find((item) => item.decision && !item.decision.answered && match(c, item));
    if (step) return { c: { id: c.id, version: c.version, authorizationVersion: c.authorizationVersion, scopeDigest: c.scopeDigest, outcome: c.outcome, tasks: c.steps }, task: step };
  }
  return null;
}

function localResultRow(row, c = null) {
  const busy = applying !== null || sending || offline || !state.supervisor.available, key = `${row.campaignId}/${row.taskId}`;
  const press = row.action === 'apply' ? button(applying === key ? 'Applying…' : 'Apply', () => void pressApply(row, 'apply'), '', busy)
    : row.action === 'undo' ? button(applying === key ? 'Undoing…' : 'Undo apply', () => void pressApply(row, 'undo'), 'secondary', busy) : null;
  return el('li', { class: 'result-row', 'data-focus-scope': `local-result/${key}` },
    el('div', { class: 'needs-text' }, el('span', {}, row.title)),
    el('div', { class: 'result-state' }, row.state),
    el('p', { class: 'subtext local-text' }, row.text),
    row.files.length ? el('ul', { class: 'subtext local-text', 'aria-label': 'Files' }, ...row.files.map((file) => el('li', {}, file))) : null,
    press ? el('div', { class: 'needs-actions' }, press) : null,
    // Criteria with their evidence and Request changes (OWNER_UI_V2 WP4); Apply stays this result's acceptance.
    c ? reviewPanel(row.review, { campaignId: row.campaignId, taskId: row.taskId, taskVersion: row.taskVersion, version: c.version,
      authorizationVersion: c.authorizationVersion, scopeDigest: c.scopeDigest }) : null);
}

/** Results of a project without GitHub: each step's checked result, with Apply or Undo apply. */
function localResultsScreen(project) {
  const rows = localWork(project).flatMap((c) => c.results.map((row) => [row, c]));
  if (!rows.length) return [el('section', { class: 'panel' }, empty('No results yet.', 'Checked results appear here. Nothing in your folder changes until you press Apply on one.'))];
  return [el('section', { class: 'panel', 'aria-labelledby': 'results-title', 'data-focus-scope': `results/${project}` },
    el('div', { class: 'panel-header' }, el('h2', { id: 'results-title' }, plural(rows.length, 'result'))),
    el('div', { class: 'panel-body' }, el('ul', { class: 'needs-list' }, ...rows.map(([row, c]) => localResultRow(row, c)))))];
}

/** Work of a project without GitHub: each approved plan with its steps, in the owner's words. */
function localWorkScreen(project) {
  const work = localWork(project);
  if (!work.length) return [empty('Nothing is running or waiting in this project', 'A plan you approve appears here.')];
  return work.map((c) => el('section', { class: 'panel', 'data-focus-scope': `local-work/${c.id}` }, el('div', { class: 'panel-body' },
    el('h2', {}, c.outcome), el('p', { class: 'subtext' }, LOCAL_CONTROL[c.control] ?? ''),
    el('ol', { class: 'local-steps' }, ...c.steps.map((step) => el('li', {}, el('span', {}, step.title), el('span', { class: 'subtext' }, ` · ${step.state}`)))))));
}

/** Now of a project without GitHub: checked results that wait for the owner first, then work in progress, then its connection. */
function localNowScreen(row) {
  const work = localWork(row.id), waiting = work.flatMap((c) => c.results).filter((item) => item.action === 'apply').length;
  const active = work.find((c) => !['finished', 'cancelled'].includes(c.control)), decision = localDecision(row.id);
  const doable = Boolean(state.work?.planAndDo && state.work.projects?.some((name) => sameProject(name, row.id)));
  const plan = doable && !offline && state.supervisor.available ? routeLink('Plan work', { screen: 'start', project: row.id }, waiting ? 'button secondary' : 'button') : null;
  const ready = !waiting ? '' : decision || active ? ` ${waiting === 1 ? 'A checked result waits' : `${waiting} checked results wait`} under Review.`
    : ` ${waiting === 1 ? 'A checked result is' : `${waiting} checked results are`} ready to apply. Nothing in your folder has changed yet.`;
  // A decision first, then running work, then results: "All steps are finished" only when no work is still running.
  const line = decision ? [el('strong', {}, `Needs your decision: ${decision.task.title}.`), ` ${sentenceOf(decision.c.outcome)} The step waits for your answer below; nothing in your folder changes.${ready}`]
    : active ? [el('strong', {}, `Working on: ${sentenceOf(active.outcome)}`), ` ${LOCAL_CONTROL[active.control] ?? ''}${ready}`]
      : waiting ? [el('strong', {}, 'All steps are finished.'), ready] : null;
  const head = line ? el('section', { class: 'panel', 'data-focus-scope': `now/${row.id}` }, el('div', { class: 'panel-body' },
    el('p', { role: 'status', 'aria-live': 'polite' }, ...line),
    decision ? decisionPanel(decision.c, decision.task) : null,
    waiting ? routeLink('See results', { screen: 'project', project: row.id, tab: 'review' }, decision ? 'button secondary' : 'button') : null, plan)) : null;
  return [head, overviewPanel(row.id), connectionPanel(row), line ? null : plan].filter(Boolean);
}

/** Apply or Undo apply, pressed by the owner. A retry reuses the request id, so the folder is never written twice. */
async function pressApply(row, action) {
  const from = current.address, requestId = crypto.randomUUID();
  applying = `${row.campaignId}/${row.taskId}`; render();
  const attempt = async () => {
    try {
      const result = await post(action === 'apply' ? '/api/work/apply' : '/api/work/undo',
        action === 'apply' ? { requestId, campaignId: row.campaignId, taskId: row.taskId, seq: row.seq } : { requestId, applyId: row.applyId });
      notice(result.message, null, null, from);
    } catch (error) {
      notice(error.known ? error.message : `${action === 'apply' ? 'Apply' : 'Undo apply'} could not be confirmed. Retry: the same press never writes your folder twice.`,
        error.known ? null : attempt, error.known ? error.detail : null, from);
    }
  };
  try { await attempt(); } finally { applying = null; await poll(); }
}

// An instruction draft belongs to the address its dialog was opened from, and to its campaign.
let instructionAddress = null;
function saveDraft() {
  if (instructionCampaign) drafts.set(instructionAddress, `instruction:${instructionCampaign.id}`, { taskId: $('#instruction-task').value, role: $('#instruction-role').value, text: $('#instruction-text').value });
}

function openInstructions(c, task = null) {
  c = campaignById(c.id) ?? c;
  instructionCampaign = c; instructionAddress = current.address;
  const draft = drafts.get(instructionAddress, `instruction:${c.id}`);
  $('#instruction-campaign').textContent = campaignTitle(c);
  $('#instruction-task').replaceChildren(...c.tasks.filter((t) => !['done', 'verified'].includes(t.state)).map((t) => el('option', { value: t.id }, t.outcome ?? t.title)));
  if (draft && c.tasks.some((t) => t.id === draft.taskId && !['done', 'verified'].includes(t.state))) $('#instruction-task').value = draft.taskId;
  else if (task) $('#instruction-task').value = task.id;
  $('#instruction-role').value = draft?.role ?? (c.tasks.find((t) => t.id === $('#instruction-task').value)?.state === 'implemented' ? 'verify' : 'implement');
  $('#instruction-text').value = draft?.text ?? '';
  $('#instruction-refusal').hidden = true; $('#instruction-refusal').textContent = ''; $('#instruction-text').removeAttribute('aria-invalid');
  $('#instruction-dialog').showModal();
  $('#instruction-text').focus();
}

function activityList(limit = 80, journal = state.supervisor.activity) {
  const descriptions = { 'operation-recorded': 'Agent scheduled', 'operation-finished': 'Agent finished', 'lease-acquired': 'Supervisor took over the campaign',
    'run-refunded': 'Unused run not counted', 'runs-recounted': 'Run count corrected', 'dashboard-command': 'Your dashboard command',
    paused: 'Campaign paused', resumed: 'Campaign resumed', 'cancel-requested': 'Cancellation requested', cancelled: 'Campaign cancelled',
    'event-recheck': 'Checked again', registered: 'Campaign registered' };
  descriptions['executor-fallback'] = 'Switched AI provider';
  descriptions['executor-unavailable'] = 'AI provider unavailable';
  descriptions['executor-amended'] = 'AI provider order updated';
  descriptions['operation-dispatched'] = 'Agent started';
  descriptions.published = 'Finished step published for your review';
  Object.assign(descriptions, { 'integration-wait': 'Waiting for merges before the next step', 'integration-ready': 'Merged work is in place; the next step can start',
    'blocker-raised': 'Stopped: needs a decision or action', 'blocker-cleared': 'Stop cleared; work continues', 'stall-released': 'Stopped step released to continue',
    'authorization-amended': 'Campaign authorization updated', 'message-received': 'Your message was received', 'message-read': 'The coordinator started reading your message',
    'message-answered': 'AIWorks answered', 'message-failed': 'Your message was not answered', 'instruction-attached': 'Your instruction reached a worker',
    'liveness-defect': 'Supervisor liveness problem', 'operation-abandoned': 'Worker run abandoned', 'step-error': 'Supervisor step failed and will retry' });
  const items = journal.slice(0, limit);
  if (!items.length) return empty('No recorded activity', 'Supervisor events will appear here.');
  return el('div', { class: 'timeline' }, ...items.map((item) => el('div', { class: 'timeline-item' },
    el('span', { class: 'timeline-mark', 'aria-hidden': 'true' }), el('div', {}, el('div', { class: 'timeline-text' },
      item.kind === 'executor-fallback' ? `${provider(item.fromExecutor)} → ${provider(item.executor)}: ${item.credits ? 'credits / billing limit' : item.reason ?? 'availability failure'}`
        : `${item.executor ? `${provider(item.executor)}: ` : ''}${descriptions[item.kind] ?? (item.kind ?? 'Event').replaceAll('-', ' ')}`,
      item.action ? ` · ${item.action}` : '',
      item.kind === 'operation-finished' ? ` · ${item.outcome === 'result' ? `${terminalLabels[item.terminal] ?? item.terminal ?? 'result'}${item.terminal === 'rejected' && item.blocking ? ` (${item.blocking} blocking)` : ''}` : outcomeLabels[item.outcome] ?? item.outcome ?? 'unknown'}`
        : item.outcome ? ` · ${item.outcome}` : '')),
    el('time', { class: 'timeline-time', datetime: new Date(item.at).toISOString(), title: dateTime(item.at) }, timeAgo(item.at)))));
}

/** "Since you last looked": merged, delivered, newly waiting for you, failed or rejected runs, and AIWorks' own problems apart. */
function sinceSummary() {
  const recent = state.owner?.recent;
  if (!recent) return null;
  const when = previousVisit ? `Since you last looked (${dateTime(previousVisit)})` : 'In the last 24 hours';
  // A pull request opens on GitHub; a local review opens its work-list item here.
  const prs = (list) => list.filter((item) => item.url || item.route)
    .map((item) => item.url ? link(`#${item.number} ↗`, item.url) : routeLink(`Work list #${item.number}`, item.route.address));
  const facts = [
    recent.merged.length ? el('li', {}, `${plural(recent.merged.length, 'step')} merged `, ...prs(recent.merged)) : null,
    recent.delivered.length ? el('li', {}, `${plural(recent.delivered.length, 'step')} delivered by AI workers`) : null,
    recent.waiting.length ? el('li', { class: 'attention' }, `${recent.waiting.length} newly waiting for your review `, ...prs(recent.waiting)) : null,
    recent.failures ? el('li', { class: 'warn' }, `${plural(recent.failures, 'AI worker run')} did not succeed${recent.rejected ? ` (${recent.rejected} rejected by the independent checker)` : ''}; AIWorks retries by itself`) : null,
    // AIWorks' own problems, never counted as AI worker runs: a failing step is recorded on every 5-second check.
    // Not an owner action, but actionable for whoever maintains AIWorks: where it is tracked, and when it happened.
    // Owner words only at this level (aiworks#11 review 4 F4 and F17); the machine's names are in Diagnostics.
    recent.supervisorErrors || recent.livenessProblems ? el('li', { class: 'warn' }, `AIWorks itself had problems (${[
      recent.supervisorErrors ? `its own check failed ${plural(recent.supervisorErrors, 'time')} and was retried` : null,
      recent.livenessProblems ? `it failed to check in on time ${plural(recent.livenessProblems, 'time')}` : null].filter(Boolean).join('; ')}). Not an owner action: these are faults in AIWorks for its maintainers. `,
    link('AIWorks issue #2 ↗', 'https://github.com/netbka/aiworks/issues/2'), ' · ', routeLink('When, in Diagnostics', '#/settings/diagnostics')) : null,
    // While a merge check runs, what merged is not known yet: never "Nothing changed" (aiworks#11 review 4 F3).
    state.owner?.unknownResults ? el('li', {}, `Checking GitHub… The state of ${plural(state.owner.unknownResults, 'result')} is not known yet.`) : null,
  ].filter(Boolean);
  return el('section', { class: 'since', 'aria-labelledby': 'since-title' }, el('h2', { id: 'since-title' }, when),
    facts.length ? el('ul', {}, ...facts) : el('p', {}, 'Nothing changed.'));
}

/** Diagnostics filters: search applies to both lists; the track filter to the platform roadmap, the status filter to campaign steps. */
function filtered(items, kind) {
  const query = $('#search').value.trim().toLowerCase(), status = $('#status').value, track = $('#track').value;
  return items.filter((item) => (!query || `${item.id ?? ''} ${item.number ?? ''} ${item.title} ${item.repository} ${item.campaignId ?? ''}`.toLowerCase().includes(query)) &&
    (kind !== 'steps' || !status || item.status === status) && (kind === 'steps' || !track || item.track === track));
}

function roadmapView() {
  const entries = filtered(state.roadmap.entries, 'roadmap');
  const rows = entries.map((entry) => el('tr', { 'data-focus-scope': entry.id }, cell(el('span', { class: 'package-id' }, entry.id)), cell(link(entry.title, entry.source, 'task-name'),
      el('div', { class: 'subtext' }, `${trackNames[entry.track] ?? entry.track} · ${entry.repository?.split('/')[1] ?? 'Repository unassigned'}`),
      entry.dependencies.length ? el('div', { class: 'subtext' }, `Depends on ${entry.dependencies.join(', ')}`) : null),
    cell(el('div', { class: 'subtext' }, entry.owner ? `Responsible role: ${entry.owner}` : 'No role assigned in the registry'))));
  const missingRoadmap = governanceMissing();
  if (missingRoadmap) return panel('governance provider roadmap items', 'Read from the governance provider governance checkout.', missingRoadmap);
  return panel('governance provider roadmap items', `${entries.length} of ${state.roadmap.entries.length} items · the platform’s own work toward the project control plane. Definitions only: progress is tracked on GitHub and not read here`,
    rows.length ? table(['Item', 'Outcome', 'Role'], rows) : empty('No matching items', 'Try another search or track filter.'));
}

const campaignById = (id) => state.supervisor.campaigns.find((c) => c.id === id);
/** "SampleApp: <purpose>": the work a row belongs to. Its ID is in the work's Details on Now and in Diagnostics. */
const campaignContext = (id) => { const c = campaignById(id); return c ? campaignTitle(c) : 'work no longer listed'; };
/** Campaign order from the owner view: cards for campaigns with something for the owner, then active ones; then finished ones. */
function campaignLayout() {
  const layout = state.owner?.layout;
  if (!layout) return { cards: state.supervisor.campaigns, finished: [] };
  const pick = (ids) => ids.map(campaignById).filter(Boolean);
  return { cards: pick(layout.cards), finished: pick(layout.finished) };
}

/** Finished and cancelled campaigns with nothing listed for the owner: one line each, their steps one click away. */
function finishedList(list) {
  if (!list.length) return null;
  // History, not a list to work through: folded until the owner opens it.
  return el('section', { class: 'panel' }, el('div', { class: 'panel-body' }, disclosure('finished-work', `Finished work (${list.length}): most recent first`,
    el('div', { class: 'finished-list' }, ...list.map((c) => el('div', { class: 'finished-row', 'data-focus-scope': c.id },
      el('div', { class: 'row-line' }, el('strong', { class: 'finished-title' }, campaignTitle(c)), link(`tracking issue #${c.trackingIssue ?? ''} ↗`, c.trackingUrl)),
      el('div', { class: 'subtext' }, ownerCampaign(c)?.outcome ?? (c.control === 'cancelled' ? 'Cancelled' : 'All steps are finished')),
      disclosure(`${c.id}/finished-steps`, `See all ${plural(c.tasks.length, 'step')}`, stepsTable(c))))))));
}

/** When the merge check behind a step is not current, or its last fetch failed: when it is from, and what happens next. */
const mergeAsOf = (check) => `Merge check from ${!check.at ? 'an unknown time' : new Date(check.at).toDateString() === new Date().toDateString() ? timeOnly(check.at) : dateTime(check.at)}; ${
  check.reason === 'fetch-failed' ? 'the last fetch failed, retrying within 5 minutes' : 'checking again'}`;

/** A brief business topic: the first sentence of a long name, cut at a word. Display only; the record keeps the full text. */
const brief = (text, max = 80) => {
  const value = String(text ?? ''), sentence = /^(.{20,}?[.!?])\s/.exec(value)?.[1] ?? value;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max), space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:·-]+$/, '')}…`;
};
/** The work an item belongs to, briefly, by its business name. A goal without a name is "this work", never its identifier. */
const workName = (c) => brief(ownerCampaign(c)?.purpose?.text ?? 'this work');

/** Stable per item: its goal and step, or what it is about. Names its drafts' scope and its focus scope across refreshes. */
const itemKey = (item) => item.local ? `local/${item.local.campaignId}/${item.local.taskId}`
  : item.taskId ? `${item.campaignId}/${item.taskId}` : `${item.kind}/${item.campaignId ?? item.about ?? item.text}`;

/** The binding of a step's result: the goal's and the step's versions, authorization and scope (applyResultReview). */
const resultBinding = (c, task) => ({ campaignId: c.id, taskId: task.id, taskVersion: task.version, version: c.version,
  authorizationVersion: c.authorizationVersion, scopeDigest: c.scopeDigest });

/*
 * Guidance and Check again for a step that stopped for good, on its Needs you card: the owner's words reach the next try
 * of this step (an instruction, OWNER_WORKSPACE §4.8) and Check again gives it that try, within the approved plan and
 * its limits. Both requests are kept in the draft as they were first sent, so a retry after an unconfirmed delivery
 * repeats exactly the same requests and the server applies each once; a refused one is dropped and nothing is applied.
 */
let guidanceBusy = null;
async function sendGuidance(c, task, address, key) {
  c = campaignById(c.id) ?? c; task = c.tasks.find((item) => item.id === task.id) ?? task;
  const draft = drafts.get(address, key) ?? { text: '' }, text = draft.text?.trim() ? draft.text : null;
  const bind = { campaignId: c.id, version: c.version, authorizationVersion: c.authorizationVersion, scopeDigest: c.scopeDigest, taskId: task.id, taskVersion: task.version };
  let pending = draft.pending && draft.pending.text === text ? draft.pending
    : { text, instruct: text ? { ...bind, action: 'instruct', role: task.state === 'implemented' ? 'verify' : 'implement', text, requestId: crypto.randomUUID() } : null, instructed: false, recheck: null };
  if (!pending.recheck) pending = { ...pending, recheck: { ...bind, action: 'recheck', requestId: crypto.randomUUID() } };
  const keep = (changes) => drafts.set(address, key, { ...(drafts.get(address, key) ?? {}), ...changes });
  keep({ pending });
  guidanceBusy = key; render();
  try {
    if (pending.instruct && !pending.instructed) { await post('/api/commands', pending.instruct); pending = { ...pending, instructed: true }; keep({ pending }); }
    const result = await post('/api/commands', pending.recheck);
    drafts.delete(address, key);
    notice(result.duplicate ? COMMANDS.duplicate : pending.instruct ? COMMANDS.accepted.guided : COMMANDS.accepted.recheck, null, null, address);
  } catch (error) {
    // A refusal applied nothing of that request: the next try binds what the page shows then. Guidance already
    // accepted stays accepted and is not sent again.
    if (error.known) keep({ pending: pending.instructed ? { ...pending, recheck: null } : null });
    notice(error.known ? error.message : COMMANDS.unconfirmed, error.known ? null : () => void sendGuidance(c, task, address, key), error.known ? error.detail : null, address);
  } finally { guidanceBusy = null; await poll(); }
}
function guidancePanel(c, task, { more } = {}) {
  if (!canCheckAgain(c, task)) return null;
  const address = current.address, key = `guidance:${c.id}/${task.id}`, ids = `${c.id}-${task.id}`;
  const off = guidanceBusy !== null || commandsOff(), draft = drafts.get(address, key) ?? { text: '' };
  const words = el('textarea', { id: `guidance-text-${ids}`, rows: 3, maxlength: 2000,
    oninput: () => drafts.set(address, key, { ...(drafts.get(address, key) ?? {}), text: words.value }) });
  words.value = draft.text ?? '';
  // A high-risk step's retry is decided on a computer, like its decision.
  const deferred = task.risk?.level === 'high' && onPhone();
  // What a retry does is an explanation, kept under the card's More (aiworks#39) when there is one.
  const rule = el('p', { class: 'subtext' }, 'AIWorks gives this step one more try with your words, within the approved plan and its limits; the independent check still applies. No secrets; up to 2,000 characters.');
  more?.push(rule);
  return el('form', { novalidate: true, class: 'start-form needs-resolve', 'data-focus-scope': `guidance/${c.id}/${task.id}`,
    onsubmit: (event) => { event.preventDefault(); if (!off && !deferred) void sendGuidance(c, task, address, key); } },
    el('label', { class: 'field' }, el('strong', {}, 'Your guidance for the next try (optional)'), words),
    more ? null : rule,
    deferred ? el('p', { class: 'notice warning', role: 'status' }, 'This step is high risk, so it is tried again from a computer, not a phone.')
      : el('div', { class: 'campaign-controls' }, el('button', { class: 'button', type: 'submit', disabled: off }, guidanceBusy === key ? 'Sending…' : 'Check again')));
}

/**
 * New scope is planned, never chatted: "Plan different work" opens this project's Plan work with the item as the start of
 * an unsent goal (kept if the owner already typed one), where the plan is drafted and only Approve and start on Review
 * starts anything (OWNER_WORKSPACE §5.4).
 */
function planFromItem(item, project, { primary = false } = {}) {
  if (!project || !planWorkOpen(project)) return null;
  // An item whose only way forward is planned work names it (`item.plan`); otherwise planning is the alternative.
  return button(item.plan?.label ?? 'Plan different work…', () => {
    const address = formatRoute({ screen: 'start', project }), draft = startDraft(address);
    if (!draft.goal.trim()) drafts.set(address, 'start', { ...draft, goal: item.plan?.goal ?? `Instead of “${item.text}”: ` });
    go(address);
  }, primary ? 'button' : 'secondary small');
}

/**
 * The one way to resolve an item on its card, by its kind, through the same bound requests as its step and Review. Its
 * explanations go into `more`, the card's one More, so the card itself shows only its action.
 */
function itemResolution(item, c, task, more) {
  if (['local-unrecorded', 'local-untrusted'].includes(item.kind) && sameProject(item.repository, state.connections?.trustedMain?.repository)) {
    return el('div', { class: 'needs-resolve' }, ...trustedMainLines(state.connections.trustedMain).filter(Boolean),
      state.connections.trustedMain.record ? null : primaryAction(item.command));
  }
  if (item.kind === 'decision') {
    const card = itemDecision(item);
    return card ? decisionPanel(card.c, card.task, { more }) : null;
  }
  if (['review', 'accept', 'merge-overdue'].includes(item.kind) && c && task?.review) {
    const box = el('div', { class: 'needs-resolve', 'data-focus-scope': `needs-review/${c.id}/${task.id}` },
      ...reviewActions(task.review, resultBinding(c, task), { more }));
    return box;
  }
  if (item.kind === 'stopped' && c && task) return guidancePanel(c, task, { more });
  if (item.plan) {
    const plan = planFromItem(item, item.repository ?? item.project ?? null, { primary: true });
    return el('div', { class: 'needs-actions' }, plan ?? el('p', { class: 'subtext', role: 'status' }, 'Plan work is not available for this project right now, so this cannot be planned from here.'));
  }
  return item.command ? el('div', { class: 'needs-actions' }, primaryAction(item.command)) : null;
}

/** A text's first sentence and the rest: a card shows the first and keeps the rest under its More. */
function splitSentence(text) {
  const match = /^(.+?[.!?])\s+(?=\S)/s.exec(text ?? '');
  return match ? [match[1], text.slice(match[0].length)] : [text ?? '', ''];
}

/** The one More of a card (aiworks#39): explanations, rules, feedback and secondary links, folded away. */
function moreBox(key, nodes) {
  const body = nodes.flat(Infinity).filter(Boolean);
  return body.length ? el('div', { class: 'card-more' }, disclosure(key, 'More', el('div', {}, ...body))) : null;
}

/**
 * One Needs you card (aiworks#39): the work it belongs to, what the owner decides in one sentence and the one action that
 * resolves it on the card itself. The rest of why, what follows, opening the step or its full Review, the pull request
 * and planning different work are under its one More. Identifiers, commits and recorded machine detail stay out of it.
 */
function needsItem(item) {
  const c = item.campaignId ? campaignById(item.campaignId) : null, task = c && item.taskId ? c.tasks.find((t) => t.id === item.taskId) : null;
  const project = item.repository ?? item.project ?? null;
  const when = `${item.at ? ` at about ${timeOnly(item.at)}` : ''}${item.since ? ` since ${timeOnly(item.since)}` : ''}`;
  const [why, rest] = splitSentence(item.why), more = [];
  const resolution = itemResolution(item, c, task, more);
  // Without an action on the card, opening its step or Review is its one action; otherwise that is a secondary link.
  const route = item.route ? routeLink(item.route.label, item.route.address, resolution ? 'needs-link' : 'button') : null;
  const secondary = [resolution ? route : null, item.reference ? link(`${item.reference.label} ↗`, item.reference.url, 'needs-link subtext') : null,
    item.system || !item.taskId || item.plan ? null : planFromItem(item, project)].filter(Boolean);
  return el('li', { class: `needs-item ${item.kind}`, 'data-focus-scope': `needs-item/${itemKey(item)}` },
    el('div', { class: 'needs-body' },
      el('div', { class: 'needs-context' }, [item.about ? `Project ${projectName(item.about)}` : null, c ? workName(c) : null].filter(Boolean).join(' · ')),
      item.action ? el('div', { class: 'needs-action' }, item.action) : null,
      el('div', { class: 'needs-text' }, el('span', {}, `${item.text}${when}`)),
      why ? el('p', { class: 'needs-why' }, why) : null),
    resolution ?? (route ? el('div', { class: 'needs-actions' }, route) : null),
    moreBox(`needs-more/${itemKey(item)}`, [
      rest ? el('p', { class: 'needs-why' }, rest) : null,
      item.evidence && !['review', 'accept', 'unchecked'].includes(item.kind) ? el('div', { class: 'evidence' }, item.evidence) : null,
      item.mergeCheck ? el('div', { class: 'needs-stale' }, mergeAsOf(item.mergeCheck)) : null,
      item.points.map((point) => el('div', { class: 'needs-point' },
        point.link ? link(`${point.link.label} ↗`, point.link.url, 'needs-link') : null, el('span', {}, point.text))),
      more,
      secondary.length ? el('div', { class: 'needs-actions needs-secondary' }, ...secondary) : null]));
}

/**
 * One Needs you group (OWNER_WORKSPACE S3): a project, named and linked to its own screen, or "AIWorks itself" (always
 * last), with its count and its items in today's order.
 */
const needsGroup = (group) => el('section', { class: 'needs-group', 'aria-labelledby': `needs-group-${group.key}`, 'data-focus-scope': `needs/${group.key}` },
  el('h3', { id: `needs-group-${group.key}`, class: 'section-title' }, group.project ? routeLink(group.name, { screen: 'project', project: group.project }) : group.name, NEEDS.groupCount(group.count, group.notCounted)),
  el('ul', { class: 'needs-list' }, ...group.items.map(needsItem)));

/**
 * What AIWorks is handling itself (owner.mjs `handling`): routine merge waits its gate or a repair round settles within
 * the authority already given, and answers or requested changes the owner already sent that AIWorks has yet to apply,
 * each with the recorded reason, or that none is recorded, and what happens next. Listed
 * so nothing stalled is hidden; never counted, because none needs the owner.
 */
function handlingList(handling) {
  if (!handling.length) return null;
  return el('section', { class: 'needs-group needs-handling', 'aria-labelledby': 'needs-handling-title', 'data-focus-scope': 'needs/handling' },
    el('h3', { id: 'needs-handling-title', class: 'section-title' }, `AIWorks is handling (${handling.length}) · not counted`),
    el('p', { class: 'subtext' }, 'What you already settled and routine waits, continued by AIWorks inside the authority you already gave it. Nothing here needs you.'),
    el('ul', { class: 'needs-list' }, ...handling.map((entry) => el('li', { class: 'needs-item handling', 'data-focus-scope': `needs-handling/${entry.campaignId}/${entry.taskId}` },
      el('div', { class: 'needs-body' },
        el('div', { class: 'needs-context' }, [`Project ${projectName(entry.repository)}`, campaignById(entry.campaignId) ? workName(campaignById(entry.campaignId)) : null].filter(Boolean).join(' · ')),
        el('div', { class: 'needs-text' }, el('span', {}, entry.text)),
        el('p', { class: 'needs-why' }, `${entry.reason}. ${entry.next}`),
        entry.since ? el('div', { class: 'subtext' }, `${entry.sinceWords ?? 'Passed the check'} ${dateTime(entry.since)}`) : null),
      el('div', { class: 'needs-actions needs-secondary' }, routeLink('Open the step', { screen: 'step', project: entry.repository, work: entry.campaignId, step: entry.taskId }, 'needs-link'))))));
}

/**
 * AW-016: the decisions AIWorks answered itself with the worker's reversible suggestion. One line each: what it chose
 * and why, with the step, where Send guidance changes it. Never counted: nothing waits for the owner here.
 */
function decidedList(decided) {
  if (!decided.length) return null;
  return el('section', { class: 'needs-group needs-decided', 'aria-labelledby': 'needs-decided-title', 'data-focus-scope': 'needs/decided' },
    el('h3', { id: 'needs-decided-title', class: 'section-title' }, `AIWorks decided for you (${decided.length})`),
    el('p', { class: 'subtext' }, 'Reversible choices, made with the suggested option so work kept going. You can change each one while its step is still being made.'),
    el('ul', { class: 'needs-list' }, ...decided.slice(0, 8).map((d) => el('li', { class: 'needs-item decided', 'data-focus-scope': `needs-decided/${d.campaignId}/${d.taskId}` },
      el('div', { class: 'needs-body' },
        el('div', { class: 'needs-context' }, [`Project ${projectName(d.project)}`, d.step].filter(Boolean).join(' · ')),
        el('div', { class: 'needs-text' }, el('span', {}, `${d.question} `), el('strong', {}, d.chosen)),
        d.reason ? el('p', { class: 'needs-why' }, d.reason) : null,
        d.others.length ? el('div', { class: 'subtext' }, `Other options: ${d.others.join(' · ')}`) : null),
      el('div', { class: 'needs-actions needs-secondary' }, routeLink('Change it', { screen: 'step', project: d.project, work: d.campaignId, step: d.taskId }, 'needs-link'))))));
}

/**
 * AW-016: AIWorks's own state, apart from what needs the owner and folded away: its problems with their Check again,
 * and the routine work it is continuing. Listed so nothing stalled is hidden; never counted.
 */
function ownStateList(group, handling) {
  const problems = group?.items ?? [], total = problems.length + handling.length;
  if (!total) return null;
  return el('section', { class: 'needs-own', 'data-focus-scope': 'needs/own' }, disclosure('needs/own',
    `AIWorks is handling ${plural(total, 'thing')} itself${problems.length ? ` · ${plural(problems.length, 'problem')} of its own` : ''}`,
    el('div', {}, problems.length ? el('ul', { class: 'needs-list' }, ...problems.map(needsItem)) : null, handlingList(handling))));
}

/** Needs you: what is waiting for the owner, grouped by project, in plain words, each resolved on its own card. */
function needsYou() {
  const owner = state.owner;
  if (!owner?.available) return null;
  const { headline, count, groups = [], handling = [], held = [], unknownResults: unknown, reply } = owner;
  // aiworks#18: a stopped supervisor leads, with the time it last renewed its leases, unless the one item for AIWorks
  // stopped already says it with its time (one fact, once; review 4 F2).
  const controller = state.supervisor.controller;
  const said = owner.items.some((item) => item.kind === 'controller' && !item.system);
  return el('section', { class: `needs${count || held.length ? '' : unknown ? ' checking' : ' calm'}`, 'aria-labelledby': 'needs-title' },
    controller?.stopped && !said ? el('p', { class: 'needs-stopped' }, NEEDS.banner(controller.lastLeaseRenewalAt, { dateTime }, controller.stopRequested)) : null,
    el('div', { class: 'needs-head' }, el('h2', { id: 'needs-title' }, headline),
      unknown ? el('span', { class: 'needs-unknown' }, `Merge of ${unknown} published step${unknown === 1 ? '' : 's'} being checked`) : null),
    // Only owner actions here (owner, 2026-10-13; AW-016): posted reports and merged work ready for release are on Results.
    ...groups.filter((group) => group.key !== 'aiworks-itself').map(needsGroup),
    decidedList(owner.decided ?? []),
    ownStateList(groups.find((group) => group.key === 'aiworks-itself'), handling),
    // Projects held up by the owner's decisions: no work is blocked, so they are not counted, but each is named with a
    // link to its Now, which says which decisions (aiworks#11 review 5 G7).
    held.length ? el('ul', { class: 'needs-list', 'data-focus-scope': 'needs/held' }, ...held.map((project) => el('li', {},
      el('strong', {}, project.name), ` · ${project.text} `, routeLink(`Open ${project.name}`, { screen: 'project', project: project.id })))) : null,
    reply && isRecent(reply.answeredAt) ? el('div', { class: 'needs-reply' }, `AIWorks answered your message (${dateTime(reply.answeredAt)}). `,
      reply.url ? link('Read its “What needs you” ↗', reply.url) : routeLink('Open the chat', { screen: 'chats', chat: reply.threadId ?? reply.messageId })) : null,
    // The local work list (UI20): its open decisions are counted above; the list itself is one link away.
    worklist()?.available ? el('p', { class: 'needs-reply' }, `AIWorks’s own work list: ${plural(worklistUnfinished().length, 'unfinished item')}. `,
      routeLink('Open the work list', WORKLIST_ADDRESS)) : null);
}

/**
 * Every campaign step with its issue and its pull request or report, from the supervisor store: issue numbers and
 * titles come from the declarations. Issues and pull requests not tied to a campaign are not shown.
 */
function campaignWork(campaigns = state.supervisor.campaigns) {
  return campaigns.flatMap((c) => c.tasks.map((task) => {
    const delivery = deliveryOf(c, task);
    const status = delivery ? delivery.state === 'published' ? 'review' : delivery.state === 'delegated' ? 'in_progress' : delivery.state === 'unknown' ? 'unknown' : 'done' : task.blocked ? 'blocked' : 'in_progress';
    return { c, task, delivery, status, id: task.id, campaignId: c.id, repository: c.repository, title: `${task.outcome ?? ''} ${task.title}`,
      number: /\/issues\/(\d+)$/.exec(task.issueUrl ?? '')?.[1] ?? null };
  }));
}

function workView(work = filtered(campaignWork(), 'steps')) {
  const rows = work.slice(0, workLimit).map(({ c, task, delivery, number }) => el('tr', { 'data-focus-scope': `${c.id}/${task.id}` },
    cell(link(number ? `Issue #${number}` : task.id, task.issueUrl, 'package-id')),
    cell(el('span', { class: 'task-name' }, task.outcome ?? task.title), el('div', { class: 'subtext' }, `${task.id} · ${campaignTitle(c)}`)),
    cell(stepBadge(c, task), delivery?.note ? el('div', { class: 'subtext' }, delivery.note) : null),
    cell(delivery?.route ? routeLink(`Work list #${delivery.number}`, delivery.route.address)
      : task.resultUrl ? link(delivery?.number ? `PR #${delivery.number} ↗` : 'Report ↗', delivery?.url ?? task.resultUrl) : el('span', { class: 'muted' }, 'Not published yet'))));
  const body = el('div', {}, rows.length ? table(['Step issue', 'What it delivers', 'Where it stands', 'Pull request or report'], rows)
    : empty('No matching work', current.route.screen === 'settings' ? 'Try clearing the filters.' : 'No step of this project is recorded yet.'));
  if (work.length > workLimit) body.append(el('div', { class: 'load-more' }, button(`Show more (${work.length - workLimit} remaining)`, () => { workLimit += 80; render(); }, 'secondary')));
  return panel('Campaign issues and pull requests', `${work.length} steps · from the supervisor's own records. Issues and pull requests that no campaign owns are not shown here; see them on GitHub`, body);
}

/** Projects from today's data (OWNER_WORKSPACE S2): built by the server, in its order, each with one state and one action. */
const projectList = () => state.projects?.projects ?? [];
// GitHub repository names are case-insensitive: an address in any spelling opens the same project.
const sameProject = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const projectCampaigns = (project) => state.supervisor.campaigns.filter((c) => sameProject(c.repository, project));
const unavailable = () => empty('Not known right now', state.supervisor.message ?? `${stateCopy('unreadable').title} This is not the same as nothing happening.`);
const stateTones = { 'needs-you': 'attention', checking: 'unknown', running: 'in_progress', paused: 'pending', finished: 'done', cancelled: 'pending', 'no-work': 'pending',
  ready: 'done', 'cannot-start': 'pending', 'needs-setup': 'attention', unavailable: 'pending', 'possibly-stuck': 'stale', stopped: 'stale', fault: 'stale' };
const stateWords = { 'needs-you': 'Needs you', checking: 'Checking', running: 'Running', paused: 'Paused', finished: 'Finished', cancelled: 'Cancelled', 'no-work': 'No work yet',
  ready: 'Ready', 'cannot-start': "Can't start work yet", 'needs-setup': 'Needs setup', unavailable: 'Temporarily unavailable', 'possibly-stuck': 'Possibly stuck', stopped: 'AIWorks stopped',
  fault: 'AIWorks problem' };
const projectAction = (action) => action.url ? link(`${action.label} ↗`, action.url, 'project-action') : routeLink(action.label, action.route, 'project-action');

// An unsent draft: a Start work goal or a step instruction typed and not yet accepted.
const unsentDraft = (key, value) => key.endsWith(' start') ? Boolean(value?.goal?.trim()) : key.includes(' instruction:') && Boolean(value?.text?.trim());
/**
 * The project "Continue with" offers (OWNER_WORKSPACE §3.3, aiworks#11 review 4 F19): one the owner left an unsent draft
 * in comes before the last one opened, unless that one has a draft too. Without drafts it is the last one opened.
 */
function continueWith(projects, saved, all) {
  const listed = (id) => projects.find((project) => sameProject(project.id, id))?.id;
  const drafted = Object.entries(all).filter(([key, value]) => unsentDraft(key, value))
    .map(([key]) => listed(resolveRoute(key.slice(0, key.indexOf(' '))).route.project)).filter(Boolean);
  const project = drafted.find((id) => sameProject(id, saved)) ?? drafted[0] ?? listed(saved);
  return project ? { project, draft: drafted.includes(project) } : null;
}

function attentionSummary() {
  const owner = state.owner;
  if (!owner?.available) return null;
  const waiting = owner.count > 0, checking = owner.unknownResults > 0;
  return el('section', { class: `attention-summary${waiting ? '' : checking ? ' checking' : ' calm'}`, 'aria-label': 'What needs you' },
    el('div', {}, el('h2', {}, owner.headline), checking ? el('p', {}, `Merge of ${plural(owner.unknownResults, 'published step')} being checked.`) : null),
    waiting || checking ? routeLink('Open Needs you →', { screen: 'needs' }, waiting ? 'button' : 'button secondary') : null);
}

function projectsScreen() {
  if (!state.supervisor.available) return [unavailable()];
  const projects = projectList(), resume = continueWith(projects, readLastProject(), readDrafts());
  // Add project (OWNER_WORKSPACE S11, build slice UI13) is the screen's one primary action once this computer turns it on.
  const adding = Boolean(state.projects?.addProject);
  // "Configuration file", never "settings": the Settings screen cannot list a repository (aiworks#11 review F18).
  if (!projects.length && !adding) return [empty('No projects yet.', 'Projects appear here when the AIWorks configuration file on this computer lists a repository. Adding a project from this page is not built yet.')];
  if (!projects.length) {
    const first = stateCopy('projects-empty', { addProject: true });
    return [el('section', { class: 'panel' }, el('div', { class: 'panel-body' }, el('p', {}, el('strong', {}, first.title), ` ${first.text}`), primaryAction(first.primary)))];
  }
  return [resume ? el('p', { class: 'continue' }, routeLink(`Continue with ${projectName(resume.project)} →`, { screen: 'project', project: resume.project }, 'continue-link'),
    resume.draft ? el('span', { class: 'subtext' }, ' Your unsent draft is kept there.') : null) : null,
    attentionSummary(),
    panel('Your projects', adding ? 'One row per project this computer works on. Those that need you come first, then those with work running.'
      : 'One row per repository this computer works on. Those that need you come first, then those with work running.',
      el('ul', { class: 'project-list' }, ...projects.map((project) => el('li', { class: 'project-row', 'data-focus-scope': project.id },
        el('div', { class: 'project-identity' }, el('span', { class: 'project-initial', 'aria-hidden': 'true' }, Array.from(project.name)[0]?.toUpperCase() ?? ''),
          el('div', {}, routeLink(project.name, { screen: 'project', project: project.id }, 'project-name'), el('div', { class: 'project-kind' }, project.kind))),
        el('div', { class: 'project-status' }, badge(stateTones[project.state.key] ?? 'unknown', stateWords[project.state.key] ?? 'Not known'),
          el('div', { class: 'subtext' }, project.state.text)),
        projectAction(project.action),
        disclosure(`project/${project.id}`, 'Details', el('div', {}, el('div', { class: 'subtext' }, (project.repository ? [`Repository ${project.repository}`, `owner ${project.details.owner}`,
          plural(project.details.work, 'piece of work', 'pieces of work'), project.details.configured ? 'listed in the AIWorks configuration file on this computer' : null]
          : [`${project.kind} project`]).concat(project.connection ? [`connected from the folder ${project.connection.folder}`] : []).filter(Boolean).join(' · ')),
          project.removable ? removeControl(project) : null))))),
      adding ? routeLink('Add project', { screen: 'add-project' }, 'button') : null), sinceSummary()].filter(Boolean);
}

// The project whose Remove from Projects waits for the owner's confirmation, and the project being removed or shown again.
let pendingRemove = null, removing = null;

/** Remove from Projects: only the row goes; its work and history stay, and Settings › Projects can show it again. */
function removeControl(project) {
  const busy = Boolean(removing) || offline || !state.supervisor.available;
  return pendingRemove === project.id
    ? el('div', {}, el('p', {}, `Remove "${project.name}" from Projects? AIWorks keeps its work and history, and changes nothing in the repository. New work there brings it back.`),
      button('Remove', () => void removeFromProjects(project), 'danger small', busy), button('Keep it', () => { pendingRemove = null; render(); }, 'secondary small'))
    : button('Remove from Projects…', () => { pendingRemove = project.id; render(); }, 'text-danger small', busy);
}

/** Remove (`restore` false) or Show again (true) one project, then say what happened on this screen. */
async function changeRemoval(repository, restore) {
  removing = repository; pendingRemove = null; render();
  try {
    const result = await post(restore ? '/api/projects/restore' : '/api/projects/remove', { repository, requestId: crypto.randomUUID() });
    notice(result.message, null, null, current.address);
  } catch (error) {
    notice(error.known ? error.message : 'This change could not be confirmed. Refresh before trying again.', null, null, current.address);
  } finally { removing = null; await poll(); }
}
const removeFromProjects = (project) => changeRemoval(project.repository, false);

/** Settings › Projects: the projects removed from Projects, each with Show again. */
function removedList() {
  const removed = state.projects?.removed ?? [], busy = Boolean(removing) || offline;
  return removed.length ? disclosure('settings/removed-projects', `Removed from Projects (${removed.length})`, el('ul', { class: 'settings-links' },
    ...removed.map((item) => el('li', { 'data-focus-scope': `removed/${item.repository}` }, el('strong', {}, item.name),
      el('div', { class: 'subtext' }, `${item.repository} · removed ${dateTime(item.removedAt)}. Its work and history are kept.`),
      button('Show again', () => void changeRemoval(item.repository, true), 'secondary small', busy))))) : null;
}

/**
 * Add project (OWNER_WORKSPACE §4.11, §5.2 and §5.3, slice S11; PROJECT_CONNECTION §8, slice S6; build slice UI13). The
 * owner types or pastes a folder path; the server checks it without changing anything and says what it found; "Connect
 * project" then connects it through the supervisor's project connection API. Connecting only reads the folder. The
 * draft is kept per address like every draft, so the 5-second refresh, a reload and Back keep it.
 */
const ADD_ADDRESS = '#/projects/add';
const addDraft = () => ({ path: '', kind: null, id: '', found: null, outcome: null, ...(drafts.get(ADD_ADDRESS, 'add') ?? {}) });
const saveAdd = (changes) => drafts.set(ADD_ADDRESS, 'add', { ...addDraft(), ...changes });
// Emptied only after the server accepted the connection or the move, like every draft.
const clearAdd = () => drafts.set(ADD_ADDRESS, 'add', {});
// What runs now: 'check' or 'connect' on Add project, or a project's id for its Check again, Move or Disconnect.
let addBusy = null, pendingDisconnect = null;
const ADD_OFF = ['Adding a project from this page is not built yet.', 'Projects appear on Projects when the AIWorks configuration file on this computer lists a repository.'];

/** The one action a code offers (PROJECT_CONNECTION §8, Action column): a screen link or a button. */
function connectAction(action, retry) {
  if (!action) return null;
  if (action.do === 'open') return routeLink(action.label, { screen: 'project', project: action.project }, 'button secondary');
  return button(action.label, () => {
    if (action.do === 'use-path') { saveAdd({ path: action.path, found: null, outcome: null, kind: null }); void checkFolder(); }
    else if (action.do === 'kind') { saveAdd({ kind: action.kind }); void checkFolder(); }
    else if (action.do === 'move') void moveProject(action.projectId, addDraft().path, ADD_ADDRESS);
    else void retry();
  }, 'secondary', Boolean(addBusy) || offline);
}
/** A refusal or problem: its sentence, then its one action. */
const outcomeLines = (outcome, retry) => [el('p', {}, outcome.message), connectAction(outcome.action, retry)];
const noticeLines = (notices) => notices?.length ? el('ul', { class: 'add-notes' }, ...notices.map((item) => el('li', {}, item.message))) : null;

function addProjectScreen() {
  if (!state.projects?.addProject) return [empty(...ADD_OFF)];
  if (!state.supervisor.available) return [unavailable()];
  const draft = addDraft(), result = draft.found, found = result?.found ?? null, busy = Boolean(addBusy) || offline;
  const area = el('div', { id: 'add-result', role: 'status', 'aria-live': 'polite', tabindex: '-1' });
  const path = el('input', { id: 'add-path', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: 1024, required: true, 'aria-describedby': 'add-path-hint',
    // A changed path has not been checked: what was found for the old one goes, and so does Connect project.
    oninput: () => { saveAdd({ path: path.value, found: null, outcome: null, kind: null }); area.replaceChildren(); form.querySelector('[data-connect]')?.remove(); } });
  path.value = draft.path;
  if (addBusy === 'check') area.append(el('p', {}, 'Checking the folder…'));
  else if (addBusy === 'connect') area.append(el('p', {}, 'Connecting… AIWorks only reads your folder.'));
  else if (draft.outcome) area.append(...outcomeLines(draft.outcome, checkFolder).filter(Boolean));
  else if (found) {
    const kinds = found.kinds.length > 1 ? el('fieldset', {}, el('legend', {}, 'Connect as'), ...found.kinds.map((kind) => el('label', { class: 'choice' },
      el('input', { type: 'radio', name: 'add-kind', value: kind, checked: (draft.kind ?? found.kind) === kind, onchange: () => saveAdd({ kind }) }),
      ` ${kind === 'github' ? 'GitHub project' : 'Local Git project (AIWorks ignores the GitHub remote and never pushes)'}`))) : null;
    const id = el('input', { id: 'add-id', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: 40, pattern: '[a-z0-9][a-z0-9\\-]{1,39}', 'aria-describedby': 'add-id-hint',
      oninput: () => saveAdd({ id: id.value }) });
    id.value = draft.id;
    // Node.append says null as the text "null", so what is not there is left out (aiworks#11 review 5 G14).
    area.append(...[el('p', {}, el('strong', {}, `${found.text}.`), ` Folder ${found.folder}.`),
      ...found.notes.map((text) => el('p', {}, text)), noticeLines(result.notices),
      result.confirm ? el('p', {}, result.confirm.message) : null, result.confirm ? connectAction(result.confirm.action, checkFolder) : null,
      kinds, result.confirm ? null : el('label', { class: 'field' }, el('strong', {}, 'Short name (optional)'), id,
        el('span', { class: 'subtext', id: 'add-id-hint' }, 'Lowercase letters, digits and hyphens. Without one, AIWorks uses the folder name.'))].filter(Boolean));
  }
  // One primary action at a time: Check folder until the folder is checked, then Connect project.
  const ready = Boolean(found && !result.confirm && !draft.outcome && !addBusy);
  const form = el('form', { novalidate: true, class: 'panel-body start-form add-form', 'data-add-form': 'add', 'data-focus-scope': 'add-project',
    onsubmit: (event) => { event.preventDefault(); if (validateForm(form)) void checkFolder(); } },
    el('label', { class: 'field' }, el('strong', {}, 'Folder path'), path,
      el('span', { class: 'subtext', id: 'add-path-hint' }, 'Type or paste the full path of a folder on this computer, for example D:\\Projects\\my-app. AIWorks only reads it to check what it is.')),
    el('button', { class: `button${ready ? ' secondary' : ''}`, type: 'submit', disabled: busy }, 'Check folder'),
    area,
    ready ? el('button', { class: 'button', type: 'button', 'data-connect': 'connect', disabled: busy, onclick: () => void connectFolder() }, 'Connect project') : null,
    draft.outcome?.code === 'PROJECT_MOVED' ? button('Connect as a new project', () => void connectFolder({ asNewProject: true }), 'secondary', busy) : null);
  // First run states what planning costs before anything is planned (OWNER_UI_V2 WP8).
  return [el('section', { class: 'panel' }, el('div', { class: 'panel-body' }, el('p', { class: 'subtext' }, planningText(state.planning)))),
    ideaPanel(), el('section', { class: 'panel' }, form), el('section', { class: 'panel' }, samplePanel())];
}

/*
 * Start from an idea (OWNER_UI_V2 screen 1, First run): the owner writes what they would like to build before any
 * project exists. The idea is only a draft of this page. It goes nowhere by itself: the owner chooses and connects a
 * folder below, confirms the project's rules on its Overview, then asks for a plan under Plan work, which starts with
 * the idea as its goal; nothing runs until Approve and start of exactly the plan shown on Review. AIWorks creates no
 * folder, repository or other project for an idea, and sends nothing until the owner asks for a plan.
 */
const ideaDraft = () => drafts.get(ADD_ADDRESS, 'idea') ?? { text: '' };
function ideaPanel() {
  const draft = ideaDraft();
  const text = el('textarea', { id: 'idea-text', rows: 3, maxlength: 2000, 'aria-describedby': 'idea-hint', oninput: () => {
    drafts.set(ADD_ADDRESS, 'idea', { text: text.value });
    const kept = document.querySelector('#idea-kept');
    if (kept) kept.textContent = text.value.trim() ? 'Kept on this page until you connect a folder.' : '';
  } });
  text.value = draft.text;
  const step = (label, detail) => el('li', {}, el('strong', {}, label), el('div', { class: 'subtext' }, detail));
  return el('section', { class: 'panel', 'aria-labelledby': 'idea-title', 'data-focus-scope': 'add-project/idea' }, el('div', { class: 'panel-body start-form' },
    el('h2', { id: 'idea-title' }, 'What would you like to build?'),
    el('label', { class: 'field' }, el('strong', {}, 'Your idea (optional)'), text,
      el('span', { class: 'subtext', id: 'idea-hint' }, 'In your own words. No secrets; up to 2,000 characters.')),
    el('p', { id: 'idea-kept', class: 'subtext', role: 'status', 'aria-live': 'polite' }, draft.text.trim() ? 'Kept on this page until you connect a folder.' : ''),
    el('ol', { class: 'idea-steps' },
      step('Choose a folder and connect it', 'Below. A new or empty folder is fine. Connecting only reads it; AIWorks creates no repository or other project.'),
      step('Confirm the project’s rules', 'On the project’s Overview: what AIWorks may do there.'),
      step('Ask for a plan, then approve exactly that plan', 'Plan work starts with your idea as its goal. Nothing runs until you press Approve and start on Review.'))));
}
/** After a folder is connected, the idea becomes that project's unsent Plan work goal, unless one is already typed there. */
function carryIdea(project) {
  const idea = ideaDraft().text.trim();
  if (!idea) return false;
  const address = formatRoute({ screen: 'start', project });
  if (!startDraft(address).goal.trim()) drafts.set(address, 'start', { ...startDraft(address), goal: idea, from: 'description' });
  drafts.delete(ADD_ADDRESS, 'idea');
  return true;
}

/*
 * The sample project (OWNER_UI_V2 WP8): a small fictional app written into a new or empty folder the owner names, then
 * checked and connected like any folder on this screen. It starts nothing: its rules and a plan wait for the owner.
 */
const sampleDraft = () => drafts.get(ADD_ADDRESS, 'sample') ?? { path: '', outcome: null };
function samplePanel() {
  const draft = sampleDraft(), busy = Boolean(addBusy) || offline;
  const path = el('input', { id: 'sample-path', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: 1024, required: true, 'aria-describedby': 'sample-path-hint',
    oninput: () => drafts.set(ADD_ADDRESS, 'sample', { path: path.value, outcome: null }) });
  path.value = draft.path;
  const area = el('div', { id: 'sample-result', role: 'status', 'aria-live': 'polite', tabindex: '-1' },
    addBusy === 'sample' ? el('p', {}, 'Writing the sample and connecting it…') : draft.outcome ? el('p', {}, draft.outcome) : null);
  const form = el('form', { novalidate: true, class: 'panel-body start-form', 'data-add-form': 'sample', 'data-focus-scope': 'add-project/sample',
    onsubmit: (event) => { event.preventDefault(); if (Boolean(addBusy) || offline || !validateForm(form)) return; void createSample(); } },
    el('p', {}, 'AIWorks writes a small fictional notes app (four files, made-up data) into a new or empty folder you choose, then checks and connects it like any folder. Nothing runs and nothing is paid for until you confirm its rules and approve a plan, as for any project.'),
    el('label', { class: 'field' }, el('strong', {}, 'New or empty folder'), path,
      el('span', { class: 'subtext', id: 'sample-path-hint' }, 'For example D:\\Practice\\sample-notes. A folder that holds anything else is left alone.')),
    el('button', { class: 'button secondary', type: 'submit', disabled: busy }, 'Create sample project'), area);
  return disclosure('add/sample', 'Practise on a sample project', form);
}

async function createSample() {
  const draft = sampleDraft();
  addBusy = 'sample'; rebuildAdd();
  try {
    const result = await post('/api/projects/sample', { path: draft.path, requestId: crypto.randomUUID() });
    if (result.project) {
      drafts.delete(ADD_ADDRESS, 'sample');
      addBusy = null;
      await poll();
      go(formatRoute({ screen: 'project', project: result.project.route }));
      notice(result.ok ? `Created and connected "${result.project.name}". Nothing runs until you confirm its rules and approve a plan.` : result.message, null, null, current.address);
      return;
    }
    drafts.set(ADD_ADDRESS, 'sample', { ...draft, outcome: result.message });
  } catch (error) {
    drafts.set(ADD_ADDRESS, 'sample', { ...draft, outcome: error.known ? error.message : 'Creating the sample could not be confirmed. Check Projects before trying again: the same folder is never connected twice.' });
  } finally { if (addBusy) { addBusy = null; rebuildAdd({ focus: '#sample-result' }); } }
}


/** The 5-second refresh keeps the Add project form as typed: only its buttons follow the connection. False when it must be built. */
function refreshAdd(content) {
  const forms = content.querySelectorAll('form[data-add-form]');
  if (!forms.length || !state.projects?.addProject || !state.supervisor.available) return false;
  for (const form of forms) for (const node of form.querySelectorAll('button')) node.disabled = Boolean(addBusy) || offline;
  return true;
}
/** Build the Add project form again from its draft, and keep the owner where the answer is. */
function rebuildAdd({ focus = false } = {}) {
  $('#content').replaceChildren();
  render();
  if (focus) $(focus === true ? '#add-result' : focus)?.focus({ preventScroll: true });
}

async function checkFolder() {
  const draft = addDraft();
  addBusy = 'check'; rebuildAdd();
  try {
    const result = await post('/api/projects/preflight', { path: draft.path, ...(draft.kind ? { kind: draft.kind } : {}) });
    saveAdd(result.ok ? { found: result, outcome: null, kind: result.found.kind } : { found: null, outcome: result });
  } catch (error) {
    saveAdd({ found: null, outcome: { message: error.known ? error.message : 'AIWorks could not check the folder. Check that this page is connected, then try again.', action: null } });
  } finally { addBusy = null; rebuildAdd({ focus: true }); }
}

async function connectFolder(extra = {}) {
  const draft = addDraft(), found = draft.found?.found;
  if (!found && !extra.asNewProject) return;
  addBusy = 'connect'; rebuildAdd();
  try {
    const result = await post('/api/projects/connect', { path: found?.root ?? draft.path, kind: draft.kind ?? found?.kind ?? 'local-git',
      ...(draft.id ? { id: draft.id } : {}), ...extra, requestId: crypto.randomUUID() });
    if (result.project) {
      // Saved: the project opens. A project saved with a problem says it there, with its Check again.
      clearAdd();
      const idea = carryIdea(result.project.route);
      addBusy = null;
      await poll();
      go(formatRoute({ screen: 'project', project: result.project.route }));
      // The project's Now leads with what it can do, so the notice does not say that a second time (review 5 G2).
      notice(result.ok ? [`Connected "${result.project.name}".`, ...(result.notices ?? []).filter((item) => item.code !== 'LOCAL_START_OFF').map((item) => item.message),
        idea ? 'Your idea waits in Plan work as its goal: confirm the rules here first, then ask for a plan.' : null].filter(Boolean).join(' ')
        : result.message, null, null, current.address);
      return;
    }
    saveAdd({ outcome: result });
  } catch (error) {
    saveAdd({ outcome: { message: error.known ? error.message : 'Connecting could not be confirmed. Check Projects before trying again: the same folder is never connected twice.', action: null } });
  } finally { if (addBusy) { addBusy = null; rebuildAdd({ focus: true }); } }
}

/** Move "{name}" here (design §4.6): a local Git project moves at once; a plain folder first shows how many files match. */
async function moveProject(projectId, path, from, confirm = false) {
  addBusy = projectId; render();
  try {
    const result = await post('/api/projects/relocate', { projectId, path, ...(confirm ? { confirm } : {}), requestId: crypto.randomUUID() });
    if (result.confirm) {
      moves.set(projectId, { path, ...result });
    } else if (result.ok) {
      moves.delete(projectId);
      if (from === ADD_ADDRESS) clearAdd();
      addBusy = null;
      await poll();
      go(formatRoute({ screen: 'project', project: result.project.route }));
      notice(`Moved "${result.project.name}" here.`, null, null, current.address);
      return;
    } else notice(result.message, null, null, from);
  } catch (error) {
    notice(error.known ? error.message : 'The move could not be confirmed. Refresh before trying again.', null, null, from);
  } finally { if (addBusy) { addBusy = null; render(); } }
}
// A plain folder's move waiting for the owner's confirmation, by project: the path and how many files match.
const moves = new Map();

/** Check again (design §3.3): the server checks the folder and saves what it found. */
async function checkConnection(connection) {
  addBusy = connection.id; render();
  try {
    const result = await post('/api/projects/check', { projectId: connection.id, requestId: crypto.randomUUID() });
    // "Ready" only where work can start; otherwise what the project can do, as its Now says (review 5 G9).
    notice(!result.ok ? result.message : result.project?.startWork?.allowed === false ? `Checked "${connection.name}". ${result.project.startWork.text}`
      : `"${connection.name}" is ready.`, null, null, current.address);
  } catch (error) {
    notice(error.known ? error.message : 'Check again could not be confirmed. It is safe to try again.', null, null, current.address);
  } finally { addBusy = null; await poll(); }
}

async function disconnectConnection(connection) {
  addBusy = connection.id; pendingDisconnect = null; render();
  try {
    const result = await post('/api/projects/disconnect', { projectId: connection.id, version: connection.version, requestId: crypto.randomUUID() });
    addBusy = null;
    await poll();
    go('#/projects');
    notice(result.message, null, null, current.address);
  } catch (error) {
    notice(error.known ? error.message : 'Disconnecting could not be confirmed. Refresh before trying again.', null, null, current.address);
  } finally { if (addBusy) { addBusy = null; await poll(); } }
}

/**
 * Project rules (PROJECT_CONNECTION §7.4, plan UI16): a project without GitHub's rules review, loaded when the owner opens
 * it and kept by project. The fields have no handlers, so the 5-second refresh keeps what the owner typed or chose.
 */
const rulesReviews = new Map();
let rulesBusy = null;
const rulesField = (c, name) => document.getElementById(`rules-${name}-${c.id}`);
const rulesCapabilities = (c) => [...document.querySelectorAll(`input[data-rules-capability="${c.id}"]:checked`)].map((box) => box.value);

async function openRules(c, capabilities) {
  rulesBusy = c.id; render();
  try {
    const lifecycle = rulesField(c, 'lifecycle')?.value;
    rulesReviews.set(c.id, await post('/api/projects/rules', { projectId: c.id, ...(capabilities ? { capabilities } : {}), ...(lifecycle ? { lifecycle } : {}) }));
  } catch (error) {
    notice(error.known ? error.message : 'The rules could not be loaded. It is safe to try again.', null, error.detail ?? null, current.address);
  } finally { rulesBusy = null; render(); }
}

async function sendRules(c, action) {
  const review = rulesReviews.get(c.id);
  if (!review) return;
  const typedName = rulesField(c, 'name')?.value ?? '';
  const body = action === 'revoke' ? { projectId: c.id, typedName, current: review.rules.current, requestId: crypto.randomUUID() }
    : { projectId: c.id, capabilities: rulesCapabilities(c), lifecycle: rulesField(c, 'lifecycle')?.value ?? 'active',
      months: Number(rulesField(c, 'months')?.value ?? review.maxMonths), typedName, current: review.rules.current, requestId: crypto.randomUUID() };
  rulesBusy = c.id; render();
  try {
    const result = await post(action === 'revoke' ? '/api/projects/rules/revoke' : '/api/projects/rules/confirm', body);
    rulesReviews.delete(c.id);
    notice(result.message, null, null, current.address);
  } catch (error) {
    notice(error.known ? error.message : 'Saving the rules could not be confirmed. Refresh before trying again.', null, error.detail ?? null, current.address);
  } finally { rulesBusy = null; await poll(); }
}

/** The rules of a project without GitHub: their state in one sentence, and the review the owner confirms by typing the name. */
function rulesPanel(c) {
  const rules = c.rules, review = rulesReviews.get(c.id), busy = Boolean(rulesBusy) || offline || !state.supervisor.available;
  if (!rules) return null;
  const tone = { confirmed: 'done', expired: 'attention', revoked: 'attention', none: 'pending' }[rules.state] ?? 'unknown';
  const head = el('p', { 'data-state': `rules-${rules.state}` }, badge(tone, { none: 'Not confirmed', confirmed: 'Confirmed', expired: 'Expired', revoked: 'Revoked' }[rules.state] ?? rules.state), ' ', rules.text);
  if (!review) {
    const label = rules.state === 'none' ? 'Review and confirm the rules…' : rules.state === 'expired' ? 'Review and renew the rules…' : 'Review the rules…';
    return el('div', { class: 'rules', 'data-focus-scope': `rules/${c.id}` }, el('h2', {}, 'Project rules'), head, button(label, () => void openRules(c), 'secondary small', busy));
  }
  const now = review.rules.state, live = now === 'confirmed' || now === 'expired' || now === 'invalid';
  const verb = now === 'none' || now === 'revoked' ? 'Confirm the rules' : 'Renew the rules';
  const chosen = new Set(review.chosen.capabilities);
  const capabilities = el('fieldset', {}, el('legend', {}, 'What this project has'),
    el('p', { class: 'subtext' }, 'Each one you tick can add rules. AIWorks can only add or tighten rules here, never remove one.'),
    el('div', { class: 'rules-capabilities' }, ...review.capabilityWords.map((word) => el('label', { class: 'choice' },
      el('input', { type: 'checkbox', value: word, 'data-rules-capability': c.id, checked: chosen.has(word) }), word))),
    button('Show the rules for these', () => void openRules(c, rulesCapabilities(c)), 'secondary small', busy));
  const policies = review.policies.length
    ? el('div', {}, el('p', {}, `AIWorks follows every rule your project rules apply to all projects. For "${review.project.name}" that is:`),
      el('ul', { class: 'rules-policies' }, ...review.policies.map((id) => el('li', {}, id))))
    : el('p', { role: 'status' }, review.message ?? 'No rules could be read for this project.');
  return el('div', { class: 'rules start-form', 'data-focus-scope': `rules/${c.id}` }, el('h2', {}, 'Project rules'), head,
    now === 'invalid' ? el('p', {}, review.rules.text) : null,
    policies, review.detail ?? review.rules.detail ? disclosure(`rules-detail/${c.id}`, 'Details', el('p', { class: 'subtext' }, review.detail ?? review.rules.detail)) : null, capabilities,
    el('label', { class: 'field' }, el('strong', {}, 'Stage'), el('select', { id: `rules-lifecycle-${c.id}` },
      ...review.lifecycles.map((value) => el('option', { value, selected: value === review.chosen.lifecycle }, { active: 'Active', experimental: 'Experimental', parked: 'Parked' }[value] ?? value)))),
    el('label', { class: 'field' }, el('strong', {}, 'Valid for'), el('select', { id: `rules-months-${c.id}` },
      ...Array.from({ length: review.maxMonths }, (_, i) => review.maxMonths - i).map((months) => el('option', { value: months }, months === 1 ? '1 month' : `${months} months`)))),
    el('label', { class: 'field' }, el('strong', {}, `Type the project's name, ${review.project.name}, to ${live ? 'renew or revoke' : 'confirm'}`),
      el('input', { id: `rules-name-${c.id}`, type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: 200 })),
    el('div', { class: 'needs-actions' }, button(verb, () => void sendRules(c, 'confirm'), '', busy || !review.ok),
      live ? button('Revoke the rules', () => void sendRules(c, 'revoke'), 'text-danger small', busy) : null,
      button('Close', () => { rulesReviews.delete(c.id); render(); }, 'secondary small')));
}

/**
 * A connected project's connection on its Now screen: its status in one sentence with Check again when it is not ready,
 * Move here when its folder is gone, and in details its kind, folder, copy and Disconnect. A project without GitHub says
 * that starting work is not available yet and what it waits for (OWNER_WORKSPACE §5.3; #24, #32).
 */
function connectionPanel(row) {
  const c = row.connection, local = !row.repository, busy = Boolean(addBusy) || offline || !state.supervisor.available;
  const ready = c.status === 'ready', move = moves.get(c.id);
  const sentence = local && ready ? c.startWork.text : ready ? null : c.message;
  const check = button('Check again', () => void checkConnection(c), ready || c.reason === 'REGISTRY_MISSING' ? 'secondary small' : '', busy);
  let moved = null;
  if (local && c.reason === 'ROOT_MISSING') {
    const where = el('input', { id: `move-${c.id}`, type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: 1024, value: move?.path ?? null });
    moved = el('form', { class: 'start-form', 'data-focus-scope': `move/${c.id}`, onsubmit: (event) => { event.preventDefault(); void moveProject(c.id, where.value, current.address); } },
      el('label', { class: 'field' }, el('strong', {}, `Moved it? The folder "${c.name}" is in now`), where),
      move ? el('p', {}, move.message) : null,
      move ? button(move.action.label, () => void moveProject(c.id, move.path, current.address, true), '', busy)
        : el('button', { class: 'button secondary', type: 'submit', disabled: busy }, c.sourceKind === 'folder' ? 'Compare this folder' : `Move "${c.name}" here`));
  }
  const facts = [`${c.kind} project`, `folder ${c.folder}`, c.repository ? `repository ${c.repository}` : null, c.branch ? `branch ${c.branch}` : null,
    c.baseline ? `AIWorks’s copy taken ${dateTime(c.baseline.at)}` : null, `${c.statusWords}`].filter(Boolean).join(' · ');
  const leaving = pendingDisconnect === c.id
    ? el('div', {}, el('p', {}, `Disconnect "${c.name}"? AIWorks keeps its history and its copy, and never touches your folder.`),
      button('Disconnect', () => void disconnectConnection(c), 'danger small', busy), button('Keep it', () => { pendingDisconnect = null; render(); }, 'secondary small'))
    : button('Disconnect…', () => { pendingDisconnect = c.id; render(); }, 'text-danger small', busy);
  return el('section', { class: 'panel', 'data-focus-scope': `connection/${c.id}` }, el('div', { class: 'panel-body' },
    sentence ? el('p', { role: 'status', 'aria-live': 'polite', 'data-state': c.status }, ...(ready ? [el('strong', {}, sentence)]
      : [badge(stateTones[c.status] ?? 'unknown', c.statusWords), ' ', sentence])) : null,
    !ready && c.reason !== 'REGISTRY_MISSING' ? check : null, moved, local ? rulesPanel(c) : null,
    disclosure(`connection/${c.id}`, local ? 'Details' : 'Connection', el('div', {}, el('p', { class: 'subtext' }, facts),
      local ? el('p', { class: 'subtext' }, c.startWork.detail) : null, ready || c.reason === 'REGISTRY_MISSING' ? check : null, leaving))));
}

/**
 * One AI worker of this computer in plain words (OWNER_WORKSPACE §4.3, slice S8): "Claude · ready", "Codex · not set up on
 * this computer", "Cursor · not available on Windows", with what it means in the lines under it.
 */
function workerLine(w) {
  const status = { ready: 'ready', running: 'in use now', 'not-set-up': 'not set up on this computer', 'host-unavailable': 'not available on Windows',
    unavailable: 'unavailable', waiting: w.overdue ? 'retry due' : 'waiting for its usage limit' }[w.state] ?? 'state not known';
  const notes = [
    w.state === 'waiting' ? w.overdue ? `The retry was due at ${timeOnly(w.retryAt)}; it happens at AIWorks' next check. No action needed.`
      : `${w.credits ? 'It reported exhausted credits or a billing limit. ' : ''}AIWorks tries it again at ${timeOnly(w.retryAt)}. No action needed.` : null,
    w.state === 'unavailable' ? `${w.availabilityReason ?? 'AIWorks recorded it as unavailable'}.` : null,
    w.state === 'host-unavailable' ? 'Its native sandbox does not support Windows. Work runs without it here; no action needed.' : null,
    w.state === 'not-set-up' ? 'The AIWorks configuration file on this computer sets no command for it, so no work runs on it here.' : null,
    w.setUp === 'default' && w.state !== 'host-unavailable' ? 'Uses the claude command on this computer’s PATH; the AIWorks configuration file sets none.' : null,
    w.buildLimit === 'checks-only' && !['host-unavailable', 'not-set-up'].includes(w.state) ? 'Can check and report here, but cannot build code here.' : null,
    w.buildLimit === 'web-only' ? 'Runs only browser checks of web pages.' : null,
    w.usedBy ? `Allowed in ${plural(w.usedBy, 'piece')} of work.` : 'No current work allows it.'].filter(Boolean);
  return { text: `${provider(w.kind)} · ${status}`, notes };
}

/**
 * Release mode per project (OWNER_WORKSPACE §10.3 and S13, AUTO_RELEASE.md section 9; slice UI15): Review only is on,
 * Auto Release is off and not available, with exactly what is missing. Text only: there is no switch and no disabled
 * control, because a switch needs a valid release grant and none can exist until #33. Stop all releases is below.
 */
function releasePanel(releases, stop) {
  return panel('Release mode', 'Per project. Merging and releasing follow separate permissions.', el('div', {}, releases.length
    ? el('ul', { class: 'settings-links' }, ...releases.map((r) => el('li', { 'data-focus-scope': `release/${r.repository ?? r.project}` }, el('strong', {}, r.repository ? projectName(r.repository) : r.name),
      // A project without GitHub: release does not apply to it yet (aiworks#11 review 5 G10).
      r.text ? el('div', { class: 'subtext' }, r.text) : null,
      ...r.modes.map((m) => el('div', {}, el('div', {}, `${m.label} · ${m.on ? 'On' : 'Off'}`), el('div', { class: 'subtext' }, m.text,
        m.waitsFor ? ' It waits for the release decision in ' : null, m.waitsFor ? link('issue #33 ↗', m.waitsFor) : null, m.waitsFor ? '.' : null),
        m.missing?.length ? el('ul', { class: 'subtext' }, ...m.missing.map((item) => el('li', {}, item.text))) : null)))))
    : empty('No projects yet.', 'Release mode is shown per project once this computer has one.'), releaseStopLine(stop)));
}

/**
 * Stop all releases (AUTO_RELEASE.md 4.5): on, off or unknown, never assumed off. While it is off, one button writes
 * RELEASE-STOP through the dashboard's command path; it needs no work record, so it stays on while those cannot be read.
 * Removing the stop is the owner's, by deleting the file; no button does it.
 */
function releaseStopLine(stop) {
  if (stop?.set === true) return el('div', { class: 'release-stop', 'data-focus-scope': 'release-stop' }, el('strong', {}, 'Stop all releases · On'),
    el('div', { class: 'subtext' }, `Since ${stop.since ? dateTime(stop.since) : 'an unknown time'}. No release runs on this computer. To allow releases again, delete the RELEASE-STOP file in AIWorks' data folder.`));
  return el('div', { class: 'release-stop', 'data-focus-scope': 'release-stop' },
    el('strong', {}, stop?.set === false ? 'Stop all releases · Off' : 'Stop all releases · Unknown'),
    el('div', { class: 'subtext' }, stop?.set === false ? 'Nothing is released in Review only. This stops every release on this computer at once, before its next step.'
      : 'AIWorks cannot tell whether releases are stopped on this computer. Pressing the button stops them.'),
    button('Stop all releases', stopReleases, 'secondary', sending || offline));
}

async function stopReleases() {
  const from = current.address;
  sending = true; render();
  try {
    const result = await post('/api/commands', { action: 'release-stop', requestId: crypto.randomUUID() });
    notice(result.duplicate ? 'Releases were already stopped on this computer.' : 'All releases are stopped on this computer. None starts its next step.', null, null, from);
  } catch (error) {
    notice(error.known ? error.message : 'The stop was not confirmed. Check Settings › Release mode, or run supervisor release-stop.', error.known ? null : stopReleases, error.known ? error.detail : null, from);
  } finally { sending = false; await poll(); }
}

/** A time today as "12:31", an older one with its date. */
const whenAt = (time) => new Date(time).toDateString() === new Date().toDateString() ? timeOnly(time) : dateTime(time);
/**
 * How fresh a project's merge check is (plan §6.12 C1, slice S8). Merges are read from the project's local checkout with
 * `git fetch`, at most once every 5 minutes while this page is open; the dashboard never calls GitHub, so there is no
 * "Refresh GitHub" button. `repo` is the merge watcher's row for the project, or undefined when it has nothing to check.
 */
function mergeFreshness(repo, now = Date.now()) {
  if (!repo) return 'No published step to check yet.';
  if (!repo.configured) return 'Merges are not checked: the AIWorks configuration file on this computer sets no local checkout for it.';
  if (repo.error) return repo.fetchedAt ? `Merge check from ${whenAt(repo.fetchedAt)}; the last fetch failed, retrying within 5 minutes.`
    : 'Merges not checked yet: the first fetch failed, retrying within 5 minutes.';
  if (!repo.fetchedAt) return 'Merges not checked yet; the first check is running.';
  return now - repo.fetchedAt < 5 * 60_000 ? `Merges checked at ${whenAt(repo.fetchedAt)}; next check after ${timeOnly(repo.fetchedAt + 5 * 60_000)}.`
    : `Merge check from ${whenAt(repo.fetchedAt)}; checking again.`;
}
const mergeRow = (repository) => (state.merges?.repositories ?? []).find((repo) => sameProject(repo.repository, repository));

/**
 * Diagnostics: what each connected project waits for before work can start there, with its code and the decisions and
 * issues it waits for. The project's own screens say this in owner words only (aiworks#11 review 5 G3).
 */
function projectWaitsPanel() {
  const waiting = projectList().filter((project) => project.connection?.diagnostic);
  return waiting.length ? panel('What connected projects wait for', 'Why work cannot start in a connected project yet, in the machine’s words.',
    el('ul', { class: 'settings-links' }, ...waiting.map((project) => el('li', { 'data-focus-scope': `waits/${project.id}` },
      el('div', { class: 'subtext' }, `${project.name}: ${project.connection.diagnostic}`))))) : null;
}

/** Diagnostics: how fresh each project's merge check is, in place of "Refresh GitHub" (plan §6.12 C1). */
function mergeChecksPanel() {
  // Merges are checked for GitHub projects only.
  const projects = projectList().filter((project) => project.repository);
  return panel('Merge checks', `Read from each project’s local checkout with git, at most every 5 minutes while this page is open. No GitHub API call is made, so there is no refresh button: the check runs by itself.${state.merges?.refreshing ? ' Checking now…' : ''}`,
    projects.length ? el('ul', { class: 'settings-links' }, ...projects.map((project) => el('li', { 'data-focus-scope': `merges/${project.id}` },
      el('strong', {}, project.name), el('div', { class: 'subtext' }, mergeFreshness(mergeRow(project.repository))))))
      : empty('No projects yet.', 'Merge checks appear here once this computer has a project.'));
}

let pendingRemoveAccount = null;

/** An account by its AI worker and login: "Claude · work-a", or this computer's own login when it has no name of its own. */
const accountName = (account) => `${provider(account.kind)} · ${account.name === account.kind ? 'this computer’s own login' : account.name}`;

/** One account's state in plain words. The server never sends the wait reason itself, only its kind (OWNER_WORKSPACE §10.1). */
function accountState(account) {
  const at = account.retryAt ? timeOnly(account.retryAt) : null;
  if (account.state === 'usage-limit') return { text: `Waiting for its usage limit${at ? ` · back at ${at}` : ''}`, tone: 'pill-waiting' };
  if (account.state === 'sign-in') return { text: `Sign-in failed${at ? ` · tries again at ${at}` : ''}`, tone: 'pill-waiting' };
  if (account.state === 'unavailable') return { text: `Not available right now${at ? ` · tries again at ${at}` : ''}`, tone: 'pill-waiting' };
  if (account.state === 'in-use') return { text: `In use · ${account.open} running`, tone: 'pill-running' };
  return { text: 'Ready', tone: 'pill-ready' };
}

/** What the account's finished runs came to, and the time they took. */
function accountRuns({ runs, runMinutes }) {
  if (!runs?.finished) return 'No finished runs yet.';
  const other = runs.finished - runs.withResult - runs.usageLimit;
  return `${plural(runs.finished, 'finished run')}: ${runs.withResult} with a result, ${runs.usageLimit} stopped by the usage limit, ${other} other · ${runMinutes} min in all.`;
}

/**
 * The worker accounts as rows: login, state, learned limit and runs. With `manage` (Settings › Worker accounts) a login
 * saved on this computer can be removed while it runs nothing. Settings itself only shows (OWNER_WORKSPACE §4.3).
 */
function accountRows(accounts, { manage = false } = {}) {
  if (!accounts.length) return empty('No worker accounts yet.', 'Logins are set up on this computer outside this page. Each one appears here with its usage.');
  return el('ul', { class: 'settings-links' }, ...accounts.map((account) => {
    const { text, tone } = accountState(account);
    return el('li', { 'data-focus-scope': `account/${account.id}` },
      el('div', { class: 'account-header' },
        el('strong', {}, accountName(account)),
        el('span', { class: `account-pill ${tone}` }, text),
        manage && account.hasLogin && !account.open ? button('Remove…', () => openRemoveAccount(account), 'secondary small') : null),
      account.limit ? el('div', { class: 'subtext' }, `Runs at most ${account.limit} at once: AIWorks learned this from its usage limit.`) : null,
      el('div', { class: 'subtext' }, accountRuns(account)),
      manage && !account.hasLogin ? el('div', { class: 'subtext' }, 'No saved login on this computer: listed from earlier runs.') : null,
      manage && account.hasLogin && account.open ? el('div', { class: 'subtext' }, 'Its login can be removed once its running work finishes.') : null);
  }));
}

function openRemoveAccount(account) {
  pendingRemoveAccount = { provider: account.provider, name: account.name, label: accountName(account) };
  $('#remove-account-description').textContent = `Remove the saved login for ${accountName(account)} from this computer?`;
  $('#remove-account-dialog').showModal();
}

// The two roles whose model order AIWorks reads, in owner words (OWNER_WORKSPACE §2.1).
const PREFERENCE_ROLES = [
  { key: 'implementer', title: 'Builder', text: 'Models for building each step’s change, best first.' },
  { key: 'verification', title: 'Independent checker', text: 'Models for checking each result, best first.' },
];
/** The usable entries of a role's order: model names, or objects naming a model and maybe its AI worker. */
const orderEntries = (order) => (Array.isArray(order) ? order : []).filter((entry) => typeof entry === 'string' || typeof entry?.model === 'string');
const orderEntry = (entry) => typeof entry === 'string' ? entry : `${entry.model}${entry.kind ? ` (${provider(entry.kind)})` : ''}`;

function openSetPreference(role, order) {
  const entries = orderEntries(order);
  $('#preference-role').value = role.key;
  $('#preference-title').textContent = `${role.title}: model order`;
  $('#preference-models').value = entries.map((entry) => typeof entry === 'string' ? entry : entry.model).join(', ');
  $('#preference-kind').value = entries.find((entry) => typeof entry === 'object')?.kind ?? '';
  $('#preference-dialog').showModal();
}

// `workers`: the AI workers listed below the logins. "No worker accounts yet" is said only when neither lists anything.
function accountsSection(accounts = [], workers = 0) {
  return el('div', { class: 'accounts-section' },
    el('div', { class: 'panel-header' }, el('h3', {}, 'Logins and usage'), routeLink('Manage on separate page →', '#/settings/accounts')),
    accounts.length || !workers ? accountRows(accounts) : null);
}

/**
 * Settings › Worker accounts: which AI worker logins are on this computer, whether each can take work now, and the model
 * order of Builder and Independent checker. No primary action. No control adds, connects, exports or imports a login:
 * any local process can read the dashboard's command token (aiworks#197).
 */
function accountsScreen() {
  const settings = state.supervisor.settings;
  const back = el('p', { class: 'breadcrumb' }, routeLink('← Back to Settings', '#/settings'));
  if (!state.supervisor.available || !settings) return [back, unavailable()];
  const logins = panel('Logins on this computer', 'Each login an AI worker uses here, and whether it can take work now.',
    accountRows(settings.accounts ?? [], { manage: true }));
  return [back, logins, modelPreferencesPanel(settings.modelPreferences ?? {})];
}

function modelPreferencesPanel(prefs = {}) {
  return panel('Saved model order', 'Kept here for later. Work does not use it yet: each piece of work uses the AI workers and models its approved plan names.', el('ul', { class: 'settings-links' },
    ...PREFERENCE_ROLES.map((role) => {
      const entries = orderEntries(prefs[role.key]);
      return el('li', { 'data-focus-scope': `preference/${role.key}` },
        el('div', { class: 'account-header' }, el('strong', {}, role.title), button('Configure…', () => openSetPreference(role, entries), 'secondary small')),
        el('div', { class: 'subtext' }, role.text),
        el('div', { class: 'subtext' }, entries.length ? `Saved: ${entries.map(orderEntry).join(', ')}` : 'Nothing saved'));
    })));
}

function versionScreen() {
  const host = state.host ?? {};
  const ver = host.version ?? DASHBOARD_VERSION;
  const verName = host.versionName ?? DASHBOARD_VERSION_NAME;
  const current = DASHBOARD_VERSIONS.find((v) => v.version === ver || v.status === 'current') ?? DASHBOARD_VERSIONS[DASHBOARD_VERSIONS.length - 2];
  const back = el('p', { class: 'breadcrumb' }, routeLink('← Back to Settings', '#/settings'));

  const currentPanel = panel('Active version', 'Which capabilities are turned on in this version.', el('div', {},
    el('div', { class: 'version-badge-row' },
      el('h3', {}, `v${current.version} — ${current.name}`),
      el('span', { class: 'account-pill pill-ready' }, 'Active')),
    el('p', { class: 'version-summary-text' }, current.description),
    el('div', { class: 'features-block' },
      el('strong', { class: 'features-heading' }, 'Features turned on in this version:'),
      el('ul', { class: 'version-features-bullets' },
        ...current.features.map((f) => el('li', {}, `✓ ${f}`))))));

  const milestonesPanel = panel('Version milestones and roadmap', 'All dashboard versions before 1.0.0, and the remaining roadmap.', el('div', {},
    el('ul', { class: 'settings-links' },
      ...DASHBOARD_VERSIONS.map((v) => {
        const isCurrent = v.version === current.version;
        const isRoadmap = v.status === 'roadmap';
        const statusLabel = isCurrent ? 'Active now' : isRoadmap ? 'Roadmap' : 'On';
        const pillClass = isCurrent ? 'pill-ready' : isRoadmap ? 'pill-waiting' : 'pill-done';
        return el('li', { 'data-version': v.version },
          el('div', { class: 'account-header' },
            el('strong', {}, `v${v.version} · ${v.name}`),
            el('span', { class: `account-pill ${pillClass}` }, statusLabel)),
          el('p', { class: 'subtext' }, v.description),
          el('ul', { class: 'subtext-list' },
            ...v.features.map((f) => el('li', {}, `${isRoadmap ? '○' : '✓'} ${f}`))));
      }))));

  return [back, currentPanel, milestonesPanel];
}

function modelInstructionsScreen() {
  const back = el('p', { class: 'breadcrumb' }, routeLink('← Back to Settings', '#/settings'));

  const overviewPanel = panel('Overview: findings from 140+ deliveries', 'Observed delivery patterns across core engine concurrency, web interfaces, verification gates, and multi-account security.', el('div', { class: 'panel-body' },
    el('p', {}, 'Review of 140+ recent delivery PRs (UI, account management, runtime, and verification slices) shows distinct strengths and failure modes across model families. Matching the right model family and reasoning effort to each role and work type directly prevents race conditions, test flakiness, confirmation bias, and quota exhaustion.'),
    el('ul', { class: 'subtext-list' },
      el('li', {}, el('strong', {}, 'State persistence and concurrency: '), 'Multi-file async boundaries and SQLite transactions require deep reasoning to avoid deadlocks and lock contention.'),
      el('li', {}, el('strong', {}, 'User interfaces and owner copy: '), 'Strict adherence to negative styling constraints and copy rules requires precision models that follow fine-grained guidelines.'),
      el('li', {}, el('strong', {}, 'Independent verification: '), 'Fresh worker sessions using a different model family than the builder eliminate confirmation bias.'),
      el('li', {}, el('strong', {}, 'Multi-account security: '), 'Boundary-checking for encrypted credentials and quota management needs defensive reasoning.'))));

  const rolePanel = panel('Recommended models by role', 'How to staff Builder, Independent Checker, and Planner roles.', el('div', {},
    el('ul', { class: 'settings-links' },
      el('li', {},
        el('div', { class: 'account-header' },
          el('strong', {}, 'Builder (Primary Implementer)'),
          el('span', { class: 'account-pill pill-ready' }, 'Core role')),
        el('p', { class: 'subtext' }, 'Responsible for writing code, fixing test failures, refactoring, and producing clean pull requests.'),
        el('p', {}, el('strong', {}, 'Recommended models: '), 'Claude 3.7 Sonnet (Thinking), Claude 3.5 Sonnet, OpenAI o1.'),
        el('p', { class: 'subtext' }, 'Why: Strongest code synthesis and refactoring performance across multi-file JavaScript and Node.js codebases. Thinking models excel when resolving complex test failures or tricky async loops.')),
      el('li', {},
        el('div', { class: 'account-header' },
          el('strong', {}, 'Independent Checker (Verifier)'),
          el('span', { class: 'account-pill pill-ready' }, 'Safety gate')),
        el('p', { class: 'subtext' }, 'Responsible for reviewing diffs, running checks, verifying invariant boundaries, and preventing regressions in a clean session.'),
        el('p', {}, el('strong', {}, 'Recommended models: '), 'OpenAI o1 / o3-mini (checking Claude changes), or Claude 3.7 Sonnet (checking OpenAI changes).'),
        el('p', { class: 'subtext' }, 'Why: Independent checks require an opposing model family to avoid shared blind spots. High reasoning models catch subtle security boundary leaks and unhandled edge cases.')),
      el('li', {},
        el('div', { class: 'account-header' },
          el('strong', {}, 'Planner / Assistant'),
          el('span', { class: 'account-pill pill-ready' }, 'Strategy')),
        el('p', { class: 'subtext' }, 'Responsible for breaking down goals into discrete steps, ordering dependencies, and specifying clear acceptance criteria.'),
        el('p', {}, el('strong', {}, 'Recommended models: '), 'Claude 3.7 Sonnet, OpenAI o1, GPT-4o.'),
        el('p', { class: 'subtext' }, 'Why: Broad architectural comprehension and ability to sequence multi-step work without circular dependencies.')))));

  const workTypePanel = panel('Recommended models by kind of work', 'Model assignments tailored to specific engineering domains.', el('div', {},
    el('ul', { class: 'settings-links' },
      el('li', {},
        el('div', { class: 'account-header' },
          el('strong', {}, 'Engine, Concurrency & State Persistence'),
          el('span', { class: 'account-pill pill-waiting' }, 'High reasoning')),
        el('p', {}, el('strong', {}, 'Recommended: '), 'Claude 3.7 Sonnet (Thinking), OpenAI o1 (High effort)'),
        el('p', { class: 'subtext' }, 'Deep reasoning is required to prevent race conditions in asynchronous file I/O, SQLite transaction serialization, and process lifecycle handling.')),
      el('li', {},
        el('div', { class: 'account-header' },
          el('strong', {}, 'Dashboard UI, Styling & Owner Experience'),
          el('span', { class: 'account-pill pill-done' }, 'Precision & copy')),
        el('p', {}, el('strong', {}, 'Recommended: '), 'Claude 3.5 Sonnet, Claude 3.7 Sonnet (Standard effort)'),
        el('p', { class: 'subtext' }, 'Excels at vanilla DOM patching, CSS flex/grid layouts, responsive typography, and strict compliance with owner-words copy rules.')),
      el('li', {},
        el('div', { class: 'account-header' },
          el('strong', {}, 'Verification & Independent Checks'),
          el('span', { class: 'account-pill pill-ready' }, 'Cross-check')),
        el('p', {}, el('strong', {}, 'Recommended: '), 'OpenAI o1, o3-mini, Claude 3.7 Sonnet'),
        el('p', { class: 'subtext' }, 'Adversarial testing mindset, spotting missing regression tests, mocking leaks, and edge conditions across clean environments.')),
      el('li', {},
        el('div', { class: 'account-header' },
          el('strong', {}, 'Multi-Account Security & Quota Boundaries'),
          el('span', { class: 'account-pill pill-waiting' }, 'Security-critical')),
        el('p', {}, el('strong', {}, 'Recommended: '), 'Claude 3.7 Sonnet, OpenAI o1'),
        el('p', { class: 'subtext' }, 'Cryptographic operations (AES-256-GCM), key rotation, sensitive token masking in logs, and rate-limit backoff logic.')),
      el('li', {},
        el('div', { class: 'account-header' },
          el('strong', {}, 'Test Suite Optimization & Fast Turnaround'),
          el('span', { class: 'account-pill pill-done' }, 'Fast cycle')),
        el('p', {}, el('strong', {}, 'Recommended: '), 'Claude 3.5 Sonnet, OpenAI Codex'),
        el('p', { class: 'subtext' }, 'Fast parallel test execution, mocking external dependencies, and isolating flaky tests without slowing the build.')),
      el('li', {},
        el('div', { class: 'account-header' },
          el('strong', {}, 'Documentation, Synthetics & Release Notes'),
          el('span', { class: 'account-pill pill-done' }, 'Economy')),
        el('p', {}, el('strong', {}, 'Recommended: '), 'Claude 3.5 Haiku, Gemini 1.5 Flash / Pro, GPT-4o-mini'),
        el('p', { class: 'subtext' }, 'Token-efficient, rapid summarization of PR diffs, clear release notes, and synthetic test fixtures.')))));

  const effortPanel = panel('Reasoning effort guidelines', 'When to use High, Standard, or Low reasoning effort.', el('div', {},
    el('ul', { class: 'settings-links' },
      el('li', {},
        el('div', { class: 'account-header' },
          el('strong', {}, 'High Effort / Deep Thinking'),
          el('span', { class: 'account-pill pill-waiting' }, 'Deep thinking')),
        el('p', { class: 'subtext' }, 'Use for core engine algorithms, cryptographic and multi-account boundaries, complex database migrations, and tricky asynchronous race conditions. Generates thorough chain-of-thought exploration before writing code.')),
      el('li', {},
        el('div', { class: 'account-header' },
          el('strong', {}, 'Standard Effort'),
          el('span', { class: 'account-pill pill-ready' }, 'Default')),
        el('p', { class: 'subtext' }, 'Use for standard feature development, DOM panels, API endpoints, bug fixes, and regular test additions. Balanced speed and reasoning depth.')),
      el('li', {},
        el('div', { class: 'account-header' },
          el('strong', {}, 'Low Effort / Economy'),
          el('span', { class: 'account-pill pill-done' }, 'Fast')),
        el('p', { class: 'subtext' }, 'Use for documentation, simple copy adjustments, synthetic fixtures, and routine reviews where deep reasoning is unnecessary.')))));

  const configurePanel = panel('How to configure model preferences', 'Setting up model order, roles, and accounts in AIWorks.', el('div', { class: 'panel-body' },
    el('ul', { class: 'settings-links' },
      el('li', {},
        el('div', { class: 'account-header' },
          el('strong', {}, 'In Worker Accounts'),
          routeLink('Open Worker accounts →', '#/settings/accounts', 'button secondary small')),
        el('p', { class: 'subtext' }, 'Open Worker accounts to configure and test worker logins, priority order, and view quota usage.')),
      el('li', {},
        el('strong', {}, 'In Local Configuration'),
        el('p', { class: 'subtext' }, 'Model selection and priority order can be set in the configuration file under commands and accounts.')),
      el('li', {},
        el('strong', {}, 'Per Step Signatures'),
        el('p', { class: 'subtext' }, 'Completed steps display model signatures (name, type, effort, and tokens) on the Step and Review screens.')))));

  return [back, overviewPanel, rolePanel, workTypePanel, effortPanel, configurePanel];
}

/**
 * Settings (OWNER_WORKSPACE §4.3, slice S8): this computer, its AI workers once, each project's kind and connection, and
 * release mode as text. No primary action: Settings only shows what the machine has. Messages and Diagnostics are linked.
 */
// ---------------------------------------------------------------------------------------------------------------------
// Home, a project's Overview and Settings -> Connections (OWNER_UI_V2 WP1, UI19): built from the allowlisted views the
// server sends (views.mjs). Typed events carry no text of their own, so every word here is the page's.

const EVENT_WORDS = { 'goal-started': 'Work started', paused: 'Paused', resumed: 'Resumed', cancelled: 'Cancel requested',
  'result-ready': 'Result ready for your review', accepted: 'You accepted a checked result', merged: 'Merged', built: 'Builder finished a run', checked: 'Checked by the independent checker',
  'check-rejected': 'The independent checker asked for changes', 'run-failed': 'An AI worker run did not finish; AIWorks retries by itself',
  'limit-wait': 'Waiting for an AI worker limit', 'wait-ended': 'An AI worker can take work again', 'needs-you': 'Needs you',
  'decision-cleared': 'A question for you was cleared', 'aiworks-problem': 'AIWorks had a problem of its own' };
// The order of the one-line summary: what the owner acts on first.
const EVENT_ORDER = ['needs-you', 'result-ready', 'accepted', 'merged', 'checked', 'check-rejected', 'paused', 'resumed', 'goal-started', 'cancelled',
  'limit-wait', 'wait-ended', 'run-failed', 'aiworks-problem', 'built', 'decision-cleared'];
const SUMMARY_WORDS = { 'needs-you': 'new for you', 'result-ready': 'ready for review', accepted: 'accepted by you', merged: 'recorded as merged by AIWorks', checked: 'checked by the independent checker',
  'check-rejected': 'sent back by the checker', paused: 'paused', resumed: 'resumed', 'goal-started': 'started', cancelled: 'cancelled',
  'limit-wait': 'limit waits', 'wait-ended': 'waits ended', 'run-failed': 'runs retried', 'aiworks-problem': 'AIWorks problems', built: 'builder runs',
  'decision-cleared': 'questions cleared' };

let scopedBusy = null, seenBusy = false;
const goalName = (id) => { const c = campaignById(id); return c ? campaignTitle(c, { inProject: true }) : 'work no longer listed'; };

/** Pause or resume all, a project or a goal: exactly the goals the view showed, at their versions (views.mjs pauseSummary). */
async function scopedControl(action, scope, goals, extra = {}) {
  const from = current.address, key = `${action}:${scope}:${extra.project ?? extra.campaignId ?? ''}`;
  scopedBusy = key; sending = true; render();
  try {
    const result = await post(`/api/v2/${action}`, { requestId: crypto.randomUUID(), scope, ...extra, goals });
    notice(result.duplicate ? COMMANDS.duplicate : COMMANDS.scoped[action](result.goals), null, null, from);
  } catch (error) {
    notice(error.known ? error.message : COMMANDS.unconfirmed, error.known ? null : () => scopedControl(action, scope, goals, extra), error.known ? error.detail : null, from);
  } finally { scopedBusy = null; sending = false; await poll(); }
}

/** Pause and Resume of one scope, with how many goals run, are stopping (a run still finishing) or are stopped. */
function pauseControls(summary, scope, extra = {}, { label }) {
  if (!summary) return null;
  const busy = scopedBusy === `pause:${scope}:${extra.project ?? extra.campaignId ?? ''}` || scopedBusy === `resume:${scope}:${extra.project ?? extra.campaignId ?? ''}`;
  const facts = [summary.running ? `${plural(summary.running, 'goal')} running` : null,
    summary.stopping ? `${summary.stopping} stopping: a step already running finishes and is recorded` : null,
    summary.stopped ? `${plural(summary.stopped, 'goal')} paused and stopped` : null].filter(Boolean);
  return el('div', { class: 'pause-controls', 'data-focus-scope': `pause/${scope}/${extra.project ?? extra.campaignId ?? ''}` },
    el('p', { class: 'subtext' }, facts.length ? `${facts.join(' · ')}.` : 'Nothing is running or paused here.',
      summary.otherPaused ? ` Of the paused, ${summary.otherPaused} ${summary.otherPaused === 1 ? 'was' : 'were'} paused another way and ${summary.otherPaused === 1 ? 'keeps its' : 'keep their'} own Resume.` : ''),
    el('div', { class: 'campaign-controls' },
      summary.pause.length ? button(busy ? 'Pausing…' : `Pause ${label}`, () => scopedControl('pause', scope, summary.pause, extra), 'secondary small', commandsOff()) : null,
      summary.resume.length ? button(busy ? 'Resuming…' : `Resume ${label}`, () => scopedControl('resume', scope, summary.resume, extra), 'small', commandsOff()) : null));
}

const eventProject = (event) => event.project ? projectName(event.project) : null;
function eventList(events) {
  return el('ul', { class: 'event-list' }, ...events.map((event) => el('li', { 'data-type': event.type },
    el('span', {}, EVENT_WORDS[event.type] ?? 'Recorded'),
    el('span', { class: 'subtext' }, [eventProject(event), event.campaignId ? goalName(event.campaignId) : null, event.taskId && event.campaignId ? stepName(event.campaignId, event.taskId) : null].filter(Boolean).join(' · ')),
    el('time', { class: 'timeline-time', datetime: new Date(event.at).toISOString(), title: dateTime(event.at) }, timeAgo(event.at)))));
}

async function markSeen() {
  const newest = state.home?.newest;
  if (!Number.isSafeInteger(newest)) return;
  seenBusy = true; render();
  try { await post('/api/v2/events/seen', { seq: newest, requestId: crypto.randomUUID() }); }
  catch (error) { notice(error.known ? error.message : 'Marking as seen could not be confirmed. Try again.', error.known ? null : markSeen); }
  finally { seenBusy = false; await poll(); }
}

/**
 * Results waiting for the owner's review (OWNER_UI_V2 WP4), read from the same Results rows as each project's Results
 * tab, so the result, its project and its Review are the same everywhere. `project` narrows to one project.
 */
const resultsToReview = (project = null) => Object.values(state.owner?.results ?? {}).filter((entry) => !project || sameProject(entry.project, project))
  .flatMap((entry) => entry.groups.flatMap((group) => group.rows.map((row) => ({ ...row, project: entry.project })))).filter((row) => row.review?.state === 'ready');
// Home and Needs you show only what is recent: older results, projects and replies stay on their own screens.
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const isRecent = (at) => { const time = at === null || at === undefined ? NaN : new Date(at).getTime(); return !Number.isFinite(time) || time >= Date.now() - RECENT_MS; };
/** When a result was finished: its step's verification, else its goal's last progress; unknown counts as recent. */
const recentResult = (row) => {
  const campaign = campaignById(row.campaignId), task = campaign?.tasks?.find((entry) => entry.id === row.taskId);
  return isRecent(task?.verifiedAt ?? campaign?.lastProgressAt ?? null);
};
function reviewList(rows, { scope, withProject = false }) {
  if (!rows.length) return null;
  // "Each passed" only when every listed result passed every criterion (owner.mjs row checkPassed); each row says what is missing.
  return panel('Results to review', `${rows.every((row) => row.checkPassed === true) ? 'Each passed the independent check. ' : 'Not every one passed the independent check; each says what it found. '}Review shows its criteria and evidence, then Accept result or Request changes.`,
    el('div', { class: 'panel-body', 'data-focus-scope': scope }, el('ul', { class: 'needs-list' }, ...rows.slice(0, 5).map((row) => el('li', { class: 'result-row', 'data-focus-scope': `${scope}/${row.campaignId}/${row.taskId}` },
      el('div', { class: 'needs-text' }, routeLink(row.review.label, row.review.address, 'needs-link'), el('span', {}, ` ${row.text}`)),
      el('div', { class: 'subtext' }, [withProject ? `Project ${projectName(row.project)}` : null, row.evidence].filter(Boolean).join(' · '))))),
    rows.length > 5 ? el('p', { class: 'subtext' }, `And ${rows.length - 5} more under each project’s Review.`) : null));
}

/** The structured decision of a Needs you item that opens a step (WP2), with its step, or null when it has none to answer. */
function itemDecision(item) {
  if (item?.kind === 'decision' && item.local) return localDecision(item.local.project, (c, step) => c.id === item.local.campaignId && step.id === item.local.taskId);
  const address = item?.kind === 'decision' ? item.route?.address : null;
  const c = address?.screen === 'step' ? campaignById(address.work) : null, task = c?.tasks.find((t) => t.id === address.step);
  return task?.decision && !task.decision.answered ? { c, task } : null;
}

/*
 * Home at a glance (live control room): what AIWorks is doing right now as a row of tiles, and each project as one dense
 * row with its steps as a strip. Everything is counted from the same state the rest of the page reads; a number that is
 * not known is said to be not known, never shown as zero.
 */
const isBuilderRole = (role) => /implement/i.test(String(role ?? ''));
const DAY_MS = 24 * 60 * 60 * 1000;
// What a step is doing now, in the colour language of OWNER_UI_V2 §5: amber for the owner, blue and violet while AIWorks
// works, grey while it waits under control, green once merged.
function stepTone(c, task) {
  const delivery = deliveryOf(c, task), agent = c.agents.find((item) => item.taskId === task.id);
  if (delivery?.state === 'merged') return ['merged', 'Merged'];
  // As in stepBadge: a delegated result reads as passed only when every criterion passed, and cancelled work never runs.
  if (delivery) return ['delivered', delivery.state === 'delegated' ? DELEGATED.word(task.checkPassed === true) : deliveryNames[delivery.state]?.[1] ?? 'Delivered'];
  if (c.control === 'cancelled' && task.state !== 'done') return ['todo', 'Cancelled'];
  if (task.blocked) return ['you', 'Waiting for you'];
  if (agent) return isBuilderRole(agent.role) ? ['building', 'Being built'] : ['checking', 'Being checked'];
  if (task.state === 'done') return ['merged', 'Done'];
  if (task.waitingReason || task.retryAt) return ['waiting', 'Waiting, nothing for you to do'];
  return ['todo', 'Not started'];
}
const openCampaigns = (list) => list.filter((c) => !['finished', 'cancelled'].includes(c.control));

function homeTiles(home) {
  const campaigns = state.supervisor.campaigns, open = openCampaigns(campaigns), now = Date.now();
  const agents = open.flatMap((c) => c.agents), builders = agents.filter((a) => isBuilderRole(a.role)).length;
  const waiting = open.flatMap((c) => c.tasks.filter((task) => stepTone(c, task)[0] === 'waiting')).length;
  // Merges the merge check finds in Git, by hand ones too; the change summary below counts only AIWorks's own merge
  // records, so each says where its number comes from.
  const merged = campaigns.flatMap((c) => c.tasks.filter((task) => {
    const delivery = deliveryOf(c, task);
    return delivery?.state === 'merged' && delivery.mergedAt && now - new Date(delivery.mergedAt).getTime() < DAY_MS;
  })).length;
  const reported = open.filter((c) => c.cost?.reportedUsd !== null && c.cost?.reportedUsd !== undefined);
  const unreported = open.reduce((n, c) => n + (c.cost?.unreportedRuns ?? 0), 0);
  const spent = reported.length ? usd(reported.reduce((n, c) => n + c.cost.reportedUsd, 0)) : '—';
  // Needs you reads the same count as the global bar and the Needs you page: never zero or calm while a merge check runs
  // (OPERATIONS_DASHBOARD: a step whose merge check is running is shown as "?", never as nothing).
  const attention = state.owner?.count ?? home.needsYou.count, unknown = state.owner?.unknownResults ?? 0;
  const needsValue = attention || (unknown ? '?' : 0), needsMore = attention && unknown ? '+ checking' : null;
  const needsFoot = `${attention ? 'Settle each one in Needs you' : unknown ? 'Nothing confirmed yet' : 'Nothing is blocked on you'}${unknown ? ` · merge of ${plural(unknown, 'published step')} being checked` : ''}`;
  const tiles = [
    ['building', 'Building', builders, builders ? `${plural(builders, 'builder')} working` : 'No builder running'],
    ['checking', 'Checking', agents.length - builders, 'A fresh session that did not write the code'],
    ['waiting', 'Waiting', waiting, 'Limits and order: AIWorks resumes by itself'],
    ['you', 'Needs you', needsValue, needsFoot, needsMore],
    ['merged', 'Merged in 24 h', merged, 'Found in Git, however it was merged · each checked first'],
    ['cost', 'Reported cost', spent, unreported ? `Running work · ${plural(unreported, 'run')} not reported yet` : 'Running work, as the AI workers reported it']
  ];
  return el('section', { class: 'live-tiles', 'aria-label': 'Right now' }, ...tiles.map(([tone, title, value, foot, more]) => {
    const body = [el('div', { class: 'live-tile-title' }, el('span', { class: `tone-dot ${tone}`, 'aria-hidden': 'true' }), title),
      el('div', { class: 'live-tile-value number' }, String(value), more ? el('small', {}, ` ${more}`) : null), el('div', { class: 'live-tile-foot' }, foot)];
    return tone === 'you' && (attention || unknown) ? el('a', { class: `live-tile ${tone}`, href: '#/needs' }, ...body) : el('div', { class: `live-tile ${tone}` }, ...body);
  }));
}

function homeProjectRow(project, badge) {
  const campaigns = projectCampaigns(project.id), open = openCampaigns(campaigns);
  const shown = open.length ? open : campaigns.slice(-1);
  const steps = shown.flatMap((c) => c.tasks.map((task) => [c, task]));
  const tones = steps.map(([c, task]) => stepTone(c, task));
  const merged = tones.filter(([tone]) => tone === 'merged').length, delivered = merged + tones.filter(([tone]) => tone === 'delivered').length;
  const agents = open.flatMap((c) => c.agents), builders = agents.filter((a) => isBuilderRole(a.role)).length, checkers = agents.length - builders;
  const goal = shown.length ? campaignTitle(shown[shown.length - 1], { inProject: true }) : null;
  return el('li', { class: 'live-row', 'data-focus-scope': `home/project/${project.id}`, 'data-state': project.state.key },
    el('div', { class: 'live-cell live-name' }, routeLink(project.name, { screen: 'project', project: project.id, tab: 'overview' }, 'task-name'),
      el('span', { class: 'subtext' }, goal ?? project.state.text ?? 'No work yet')),
    el('div', { class: 'live-cell live-progress' }, ...(steps.length
      ? [el('div', { class: 'step-strip', role: 'img', 'aria-label': `${delivered} of ${steps.length} steps delivered, ${merged} merged` },
        ...tones.map(([tone, words], index) => el('span', { class: `step-seg ${tone}`, title: `${stepLabels(steps[index][1]).lead}: ${words}` }))),
      el('span', { class: 'subtext number' }, `${delivered} of ${plural(steps.length, 'step')} delivered${delivered > merged ? ` · ${merged} merged` : ''}`)]
      : [el('span', { class: 'subtext' }, 'No steps yet')])),
    el('div', { class: 'live-cell live-agents' }, builders ? el('span', { class: 'role-chip building' }, el('span', { class: 'tone-dot building', 'aria-hidden': 'true' }), builders > 1 ? `${builders} builders` : 'Builder') : null,
      checkers ? el('span', { class: 'role-chip checking' }, el('span', { class: 'tone-dot checking', 'aria-hidden': 'true' }), checkers > 1 ? `${checkers} checkers` : 'Checker') : null,
      agents.length ? null : el('span', { class: 'subtext' }, 'No AI worker on it')),
    el('div', { class: 'live-cell live-state' }, badge ? el('span', { class: `badge ${badge[0]}` }, badge[1]) : el('span', { class: 'subtext' }, project.state.text ?? 'Calm')),
    el('div', { class: 'live-cell live-when subtext number' }, project.lastActivityAt
      ? el('time', { datetime: new Date(project.lastActivityAt).toISOString(), title: dateTime(project.lastActivityAt) }, timeAgo(project.lastActivityAt)) : '—'));
}

/**
 * Home (docs/design/OWNER_UI_V2.md §6 screen 2, previews/owner-ui-v2/02-home.html): one headline sentence states
 * whether anything needs you, the decision itself follows as one card, then what changed, then every project in one
 * sentence with a status badge. Results to review are not a separate panel: a project with one ready carries the
 * badge on its own row, exactly as the approved preview folds it in (02-home.html, "Client portal" row).
 */
function homeScreen() {
  const home = state.home;
  if (!state.supervisor.available || !home?.available) return [unavailable()];
  const { since, lastSeen } = home;
  // Only results finished in the last week are "new"; older ones wait on each project's Review.
  const reviews = resultsToReview().filter(recentResult);
  // The first item is resolved here on the same card as in Needs you: a decision with its options, a result with Accept
  // and Request changes, a stopped step with guidance and Check again.
  const first = state.owner?.items?.find((item) => !item.system);
  const heroText = home.needsYou.count && reviews.length
    ? `${plural(home.needsYou.count, 'thing')} need${home.needsYou.count === 1 ? 's' : ''} you. ${plural(reviews.length, 'new result')} ${reviews.length === 1 ? 'is' : 'are'} ready to try.`
    : home.needsYou.count ? `${plural(home.needsYou.count, 'thing')} need${home.needsYou.count === 1 ? 's' : ''} you.`
      : reviews.length ? `${plural(reviews.length, 'new result')} ${reviews.length === 1 ? 'is' : 'are'} ready to try.`
        : 'Nothing needs you right now.';
  // h2, not h1: index.html already carries the page's one h1 (#view-title) outside #content (showRoute()).
  const hero = el('div', { class: 'home-hero' },
    el('div', {}, el('h2', {}, 'Your work, at a glance'), el('p', { class: 'subtext' }, heroText),
      // The owner's whole part in one line: AIWorks builds, checks and merges; everything else is optional.
      el('p', { class: 'subtext' }, 'Your part: say what you want (Start work), answer decisions when asked, and try a result if you like. AIWorks builds, checks and merges the rest.')),
    pauseControls(home.pause, 'all', {}, { label: 'all work' }));
  // This count matches the nav badge and the Needs you screen exactly (owner.count): results to review carry their
  // own badge on the project row below, never folded into this number (owner, 2026-10-13).
  const decision = home.needsYou.count && first ? el('ul', { class: 'needs-list home-decision', 'data-focus-scope': 'home/needs' }, needsItem(first)) : null;
  const moreDecisions = home.needsYou.count > 1 ? routeLink(`All ${home.needsYou.count} in Needs you`, '#/needs', 'button secondary small') : null;
  const counts = EVENT_ORDER.filter((type) => since.counts[type]).map((type) => `${since.counts[type]} ${SUMMARY_WORDS[type]}`);
  const windowHours = since.window ? Math.round(since.window / 3600000) : null;
  const when = lastSeen.at && (!since.window || lastSeen.at >= Date.now() - since.window) ? `Since your last visit (${dateTime(lastSeen.at)})`
    : windowHours ? `In the last ${windowHours} hours` : 'Everything AIWorks recorded so far';
  const changed = el('section', { class: 'since', 'aria-labelledby': 'home-since-title', 'data-focus-scope': 'home/since' },
    el('h2', { id: 'home-since-title' }, when),
    el('p', { role: 'status', 'aria-live': 'polite' }, counts.length ? `${counts.join(' · ')}${since.more ? ', and more' : ''}.` : 'Nothing changed.'),
    since.events.length ? disclosure('home/events', `What changed (${since.more || since.count > since.events.length ? `latest ${since.events.length}` : since.events.length})`, eventList(since.events)) : null,
    since.count ? button(seenBusy ? 'Marking…' : 'Mark as seen', markSeen, 'secondary small', seenBusy || offline) : null);
  // Working reuses the same liveness codes Now already shows for this project (copy.mjs). A project with none of
  // these badges is calm, never "Live": OWNER_WORKSPACE §2.3 keeps "Live" for recorded release evidence only, which
  // this view does not have per project, so showing it here would be a false claim the approved preview's fictional
  // sample data does not have to respect.
  const WORKING = ['builder-working', 'checker-working', 'possibly-stuck', 'cancelling'];
  const badgeOf = (project) => project.needsYou ? ['attention', 'Needs you']
    : reviews.some((row) => sameProject(row.project, project.id)) ? ['done', 'Review ready']
      : WORKING.includes(project.state.key) ? ['in_progress', 'Working'] : null;
  // A project with nothing waiting and no activity in the last week is quiet: folded under the active ones.
  const quiet = (project) => !badgeOf(project) && project.lastActivityAt && !isRecent(project.lastActivityAt);
  const active = home.projects.filter((project) => !quiet(project)), quietOnes = home.projects.filter(quiet);
  const projectTable = (rows) => el('div', { class: 'live-table' },
    el('div', { class: 'live-head', 'aria-hidden': 'true' }, el('span', {}, 'Project · current goal'), el('span', {}, 'Steps'), el('span', {}, 'AI workers'), el('span', {}, 'State'), el('span', {}, 'Last activity')),
    el('ul', { class: 'live-rows home-projects' }, ...rows.map((project) => homeProjectRow(project, badgeOf(project)))));
  const projects = home.projects.length
    ? el('div', {}, active.length ? projectTable(active) : el('p', { class: 'panel-body subtext' }, 'No project had activity in the last week.'),
      quietOnes.length ? disclosure('home/quiet-projects', `Quiet projects (${quietOnes.length}): no activity in the last week`, projectTable(quietOnes)) : null)
    : state.projects?.addProject ? el('div', { class: 'empty-state' }, el('strong', {}, 'No projects yet.'), ' Start from an idea or a folder on this computer. ',
      routeLink('Add project', { screen: 'add-project' }))
      : empty('No projects yet.', 'Projects appear here when the AIWorks configuration file on this computer lists a repository.');
  return [hero, homeTiles(home), decision, moreDecisions, changed,
    panel('Projects', 'Needs you first, then running. Each step of the current goal is one segment.', home.projects.length ? projects : el('div', { class: 'panel-body' }, projects))].filter(Boolean);
}

const AVAILABLE_WORDS = { 'not-published': 'Not published: release is off', unknown: 'Not known', recorded: 'Recorded' };
/** One goal on Overview: its state with stopping or stopped, Built, Checked and Available to users apart, its budget and pause. */
function overviewGoal(goal) {
  const { pause, strip, budget } = goal;
  const where = pause ? pause.state === 'stopping' ? `Paused, stopping: ${plural(pause.openRuns, 'run')} still finishing` : 'Paused and stopped' : 'Running';
  const busy = scopedBusy?.endsWith(`:goal:${goal.id}`);
  return el('li', { 'data-focus-scope': `overview/${goal.id}`, 'data-state': pause?.state ?? 'running' },
    el('strong', {}, goal.purpose ?? goalName(goal.id)), el('div', { class: 'subtext' }, where),
    strip ? el('dl', { class: 'overview-strip' },
      el('div', {}, el('dt', {}, 'Built'), el('dd', {}, `${strip.built} of ${strip.steps}`)),
      el('div', {}, el('dt', {}, 'Checked'), el('dd', {}, `${strip.checked} of ${strip.steps}`)),
      el('div', {}, el('dt', {}, 'Available to users'), el('dd', {}, strip.available.state === 'recorded' ? `${strip.available.live} live` : AVAILABLE_WORDS[strip.available.state] ?? 'Not known'))) : null,
    budget ? el('div', { class: 'subtext' }, [budget.maxWorkerRuns ? `${budget.runsUsed ?? 0} of ${budget.maxWorkerRuns} AI worker runs used` : null,
      budget.reportedUsd !== null ? `${usd(budget.reportedUsd)} reported` : 'cost not reported', budget.unreportedRuns ? `${plural(budget.unreportedRuns, 'run')} without a reported cost` : null].filter(Boolean).join(' · ')) : null,
    goal.next ? el('div', { class: 'subtext' }, `Next: ${clockTimes(stepWords(campaignById(goal.id), goal.next))}`) : null,
    goalVersionList(campaignById(goal.id)),
    el('div', { class: 'campaign-controls' }, goal.control === 'registered'
      ? button(busy ? 'Pausing…' : 'Pause goal', () => scopedControl('pause', 'goal', [goal.binding], { campaignId: goal.id }), 'secondary small', commandsOff())
      : button(busy ? 'Resuming…' : 'Resume goal', () => scopedControl('resume', 'goal', [goal.binding], { campaignId: goal.id }), 'small', commandsOff())));
}

/*
 * A goal's approved versions and the plan amendments admitted into it (supervisor.mjs goalVersions), newest first, each
 * with what changed from the version before as recorded. Scope cannot change in an amendment, so only limits, AI
 * workers and routing can differ; limits a version did not record are said to be unknown, never guessed.
 */
const LIMIT_NAMES = { slots: 'steps at a time', maxWorkerRuns: 'AI worker runs', maxRepairRounds: 'repair rounds per step', maxRetriesPerTask: 'retries per step',
  maxCostUsd: 'reported dollars', unknownRunCostUsd: 'price of a run with no reported cost' };
const limitValue = (key, value) => value === null ? 'none' : ['maxCostUsd', 'unknownRunCostUsd'].includes(key) ? usd(value) : String(value);
function versionChanges(v) {
  if (v.kind === 'registered') return 'Approved and started.';
  const parts = [v.limitChanges === null ? 'what its limits were before is not recorded' : v.limitChanges.length
    ? v.limitChanges.map((item) => `${LIMIT_NAMES[item.key]} ${limitValue(item.key, item.from)} → ${limitValue(item.key, item.to)}`).join(', ') : 'limits unchanged',
  v.changed.includes('workers') ? 'AI workers changed' : null, v.changed.includes('routing') ? 'model routing changed' : null].filter(Boolean);
  return `New approval${v.from ? ` after version ${v.from}` : ''}: ${parts.join('; ')}. The scope stayed the same.`;
}
function goalVersionList(c) {
  const versions = c?.versions?.versions ?? [], amendments = c?.versions?.amendments ?? [];
  if (versions.length < 2 && !amendments.length) return null;
  const steps = (label, ids) => ids.length ? `${label} ${ids.map((id) => stepName(c.id, id)).join(', ')}` : null;
  return disclosure(`overview/${c.id}/versions`, `Approved versions (${versions.length})${amendments.length ? ` · ${plural(amendments.length, 'plan amendment')}` : ''}`,
    el('ol', { class: 'plan-versions', reversed: true },
      ...[...versions].reverse().map((v) => el('li', { 'data-version': String(v.version ?? '') },
        el('strong', {}, `Version ${v.version ?? 'not recorded'}${v.version === c.authorizationVersion ? ' (in force)' : ''}`),
        el('div', { class: 'subtext' }, `${dateTime(v.at)} · ${versionChanges(v)}`),
        v.limits ? el('div', { class: 'subtext' }, `Limits: ${limitsText(v.limits) || 'none set'}.`) : null)),
      ...[...amendments].reverse().map((a) => el('li', { 'data-amendment': String(a.seq) },
        el('strong', {}, `Plan amendment ${a.seq}`),
        el('div', { class: 'subtext' }, [dateTime(a.at), a.authorizationVersion ? `admitted under version ${a.authorizationVersion}` : null,
          steps('added', a.added), steps('revised', a.revised), steps('cancelled', a.cancelled)].filter(Boolean).join(' · '))))));
}

/** Overview: each goal of the project with its strip and pause, and the project's own Pause and Resume. */
function overviewPanel(project) {
  const view = state.overviews?.[project] ?? Object.values(state.overviews ?? {}).find((item) => sameProject(item?.project?.id, project));
  if (!view?.available || !view.goals.length) return null;
  return panel('Goals', 'Built, checked and available to users, each counted apart.', el('div', { class: 'panel-body', 'data-focus-scope': `overview/${project}` },
    el('ul', { class: 'settings-links overview-goals' }, ...view.goals.map(overviewGoal)),
    pauseControls(view.pause, 'project', { project: view.project.id }, { label: 'project' })));
}

const SUPERVISOR_WORDS = { running: 'Running', stopped: 'Stopped', restarting: 'Restarting', 'not-started': 'Not started', idle: 'Idle: nothing needs it right now' };
const ACCOUNT_WORDS = { ready: 'Ready', 'in-use': 'Working', unavailable: 'Not available' };
const TRUST_WORDS = { TRUSTED: 'Trusted', MAIN_REWRITTEN: 'The approved project history changed: new work is stopped until it is restored',
  NO_ANCHOR: 'No approved starting point is recorded yet', UNREADABLE: 'The project cannot be read on this computer' };
const BACKUP_WORDS = { off: 'Off', none: 'On, not tried yet', pushing: 'Sending now', pushed: 'Sent', refused: 'Refused by the backup', failed: 'Could not reach the backup' };

function trustedMainLines(trusted) {
  if (!trusted) return [el('p', {}, 'Not known right now: AIWorks could not read its records.')];
  if (trusted.mode === 'origin') return [el('p', {}, 'AIWorks uses the approved project version on GitHub before starting work.'),
    trusted.problem ? el('p', { class: 'subtext' }, 'The local trust setting is not valid, so the approved version on GitHub remains the starting point.') : null];
  const backup = trusted.backup;
  return [el('p', {}, `${trusted.repository}: the approved project version is kept on this computer. ${TRUST_WORDS[trusted.state] ?? 'Trust not known'}.`),
    Number.isSafeInteger(trusted.unrecordedCount) && trusted.unrecordedCount > 0
      ? el('p', { class: 'subtext' }, `${plural(trusted.unrecordedCount, 'saved change')} made outside AIWorks still ${trusted.unrecordedCount === 1 ? 'needs' : 'need'} your trust.`) : null,
    trusted.record ? el('div', { 'data-focus-scope': 'connections/trusted-main' },
      el('p', { class: 'subtext local-text' }, 'Trust these changes only if you know and approve the changes made outside AIWorks. This records your approval; it changes no files. Changes to AIWorks’s worker controls still require independent review.'),
      // Exact identities stay bound to the button so a refresh cannot retain approval for different changes.
      el('button', { class: 'button secondary', onclick: () => trustLocalMain(trusted.record), disabled: sending || offline,
        'data-tips': `${trusted.record.oldTip}..${trusted.record.newTip}` }, 'Trust these changes')) : null,
    el('p', { class: 'subtext' }, `Project backup: ${BACKUP_WORDS[backup.state] ?? 'Not known'}${backup.at ? ` (${clock(backup.at)})` : ''}${
      backup.enabled && backup.state === 'pushed' ? backup.current ? '; it is up to date' : '; it is behind the approved version' : ''}${
      backup.nextAttemptAfter && ['refused', 'failed', 'pushing'].includes(backup.state) ? `; next try after ${clock(backup.nextAttemptAfter)}` : ''}. Nothing waits for the backup.`)];
}

/** The owner route of the trusted main: records exactly the two tips the page showed, or nothing. */
async function trustLocalMain({ oldTip, newTip }) {
  const from = current.address;
  sending = true; render();
  try {
    const result = await post('/api/v2/settings/trusted-main', { requestId: crypto.randomUUID(), oldTip, newTip });
    notice(result.message, null, null, from);
  } catch (error) {
    notice(error.known ? error.message : 'Recording could not be confirmed. Read the page again before trying again.', null, null, from);
  } finally { sending = false; await poll(); }
}

/** Settings -> Connections: AIWorks itself, each AI worker account, each project's merge check and the trusted main. */
function connectionsScreen() {
  const view = state.connections;
  if (!state.supervisor.available || !view?.available) return [unavailable()];
  const merges = view.merges.length ? el('ul', { class: 'settings-links' }, ...view.merges.map((repo) => el('li', { 'data-focus-scope': `connections/merge/${repo.repository}` },
    el('strong', {}, repo.repository), el('div', { class: 'subtext' }, !repo.configured ? 'No checkout on this computer: merges are not seen here.'
      : repo.local ? `Read from local main on this computer${repo.checkedAt ? ` at ${clock(repo.checkedAt)}` : ''}; never fetched.`
        : `${repo.checkedAt ? `Merge check from GitHub’s main at ${clock(repo.checkedAt)}` : 'Not checked yet'}${repo.error ? '; the last check failed and is retried' : ''}.`))))
    : el('p', { class: 'subtext' }, 'No published result to check yet.');
  return [
    panel('AIWorks on this computer', null, el('div', { class: 'panel-body' },
      el('p', {}, `${SUPERVISOR_WORDS[view.supervisor.state] ?? 'Not known'}${view.supervisor.stopRequested ? '; a stop was requested (an upgrade or an operator stop)' : ''}.`))),
    panel('AI worker accounts', 'Whether each can take work now. Limits are what the AI worker reported, not a measured balance.', el('div', { class: 'panel-body' },
      view.accounts.length ? el('ul', { class: 'settings-links' }, ...view.accounts.map((account) => el('li', { 'data-focus-scope': `connections/account/${account.kind}/${account.name}` },
        el('strong', {}, `${provider(account.kind)} · ${account.name}`),
        el('div', { class: 'subtext' }, `${ACCOUNT_WORDS[account.state] ?? 'Waiting for a limit'}${account.retryAt ? ` until ${clock(account.retryAt)}` : ''}${account.limit ? ` · ${account.open} of ${account.limit} runs at once` : ''}`))))
        // The same readiness as Settings › AI workers: workers that run on the default login are set up, with no account here.
        : view.workers?.length ? el('p', {}, `No separate account is registered: ${view.workers.map((w) => provider(w.kind)).join(', ')} ${view.workers.length === 1 ? 'runs' : 'run'} on this computer’s default login. `,
          routeLink('See AI workers in Settings', '#/settings'), '.')
          : el('p', {}, 'No AI worker account is set up on this computer.'))),
    panel('Merge checks', 'Where each project’s merges are seen from. The dashboard never calls GitHub’s API.', el('div', { class: 'panel-body' }, merges)),
    panel('Project trust and backup', 'The approved starting point AIWorks checks before it starts or resumes work.', el('div', { class: 'panel-body' }, ...trustedMainLines(view.trustedMain).filter(Boolean)))];
}

function settingsScreen() {
  const host = state.host ?? {};
  const ver = host.version ?? DASHBOARD_VERSION;
  const verName = host.versionName ?? DASHBOARD_VERSION_NAME;
  const currentVer = DASHBOARD_VERSIONS.find((v) => v.version === ver || v.status === 'current') ?? DASHBOARD_VERSIONS[DASHBOARD_VERSIONS.length - 2];
  const computer = panel('This computer', 'Each computer runs its own AIWorks. This page shows only this one.', el('div', { class: 'panel-body' },
    el('p', {}, `${host.name ?? 'Unknown computer'} · Dashboard v${ver} (${verName})`),
    el('div', { class: 'version-card' },
      el('div', { class: 'version-card-header' },
        el('strong', {}, `Active version: v${ver} — ${verName}`),
        routeLink('See all versions & roadmap →', '#/settings/version', 'button secondary small')),
      el('p', { class: 'subtext' }, currentVer.description),
      el('strong', { class: 'features-heading' }, 'Features on in this version:'),
      el('ul', { class: 'version-features-list' },
        ...currentVer.features.map((feat) => el('li', {}, `✓ ${feat}`))))));
  const settings = state.supervisor.settings;
  if (!state.supervisor.available || !settings) return [computer, unavailable(), settingsLinks()];
  // Work in projects without GitHub counts too, named by its project and goal.
  const active = [...state.supervisor.campaigns, ...(state.supervisor.local ?? [])].filter((c) => !['finished', 'cancelled'].includes(c.control));
  const workers = panel('AI workers', `Once for ${host.name ?? 'this computer'}, whatever the work.`, el('div', {},
    accountsSection(settings.accounts ?? [], settings.workers.length),
    el('ul', { class: 'settings-links' }, ...settings.workers.map((w) => {
      const { text, notes } = workerLine(w);
      return el('li', { 'data-focus-scope': `worker/${w.kind}` }, el('strong', {}, text), ...notes.map((note) => el('div', { class: 'subtext' }, note)));
    })),
    // Provider order and current supervision, without internal version identifiers.
    active.length ? disclosure('settings/workers', 'Details', el('ul', { class: 'settings-links' }, ...active.map((c) => el('li', {}, el('strong', {}, c.projectName !== undefined ? `${c.projectName ?? 'Project without GitHub'}: ${c.title}` : campaignTitle(c)),
      el('div', { class: 'subtext' }, `Tried in this order: ${c.executors.map(provider).join(' → ')}`),
      el('div', { class: 'subtext' }, c.controllerLive ? 'AIWorks is supervising this work.' : 'AIWorks is not currently supervising this work.'))))) : null));
  const projects = projectList();
  const connections = panel('Projects', 'Each project’s kind and whether this computer is connected to it.', el('div', {}, projects.length
    ? el('ul', { class: 'settings-links' },...projects.map((project) => el('li', { 'data-focus-scope': `connection/${project.id}` },
      el('strong', {}, `${project.name} · ${project.kind}`),
      project.connection ? el('div', { class: 'subtext' }, `${project.connection.statusWords}. Connected from the folder ${project.connection.folder}.`) : null,
      project.repository ? el('div', { class: 'subtext' }, project.details.configured ? 'Listed in the AIWorks configuration file on this computer.' : project.connection ? 'The AIWorks configuration file does not list it.' : 'Has work on this computer, but the AIWorks configuration file does not list it.') : null,
      project.repository ? el('div', { class: 'subtext' }, mergeFreshness(mergeRow(project.repository))) : null)))
    // The same story as the Projects screen (OWNER_WORKSPACE §5.1 step 3, §7.1; aiworks#11 review F7). Add project is a
    // link here, not a primary action: Settings has none (§4.3).
    : state.projects?.addProject ? settingsEmpty(stateCopy('projects-empty', { addProject: true }))
      : empty('No projects yet.', 'Projects appear here when the AIWorks configuration file on this computer lists a repository.'), removedList()));
  // A project removed from Projects has no release mode to show.
  const removed = (repository) => (state.projects?.removed ?? []).some((item) => sameProject(item.repository, repository ?? ''));
  return [computer, workers, connections, releasePanel(settings.releases.filter((r) => !removed(r.repository)), settings.releaseStop), settingsLinks()];
}

const settingsEmpty = ({ title, text, primary }) => el('div', { class: 'empty-state' }, el('strong', {}, title), ` ${text} `, routeLink(primary.label, primary.route));

function settingsLinks() {
  return panel('More', null, el('ul', { class: 'settings-links' },
    el('li', {}, routeLink('Connections', '#/settings/connections'), el('div', { class: 'subtext' }, 'AIWorks itself, each AI worker account, where merges are seen from, and the trusted main with its backup.')),
    el('li', {}, routeLink('Usage', '#/settings/usage'), el('div', { class: 'subtext' }, 'What AI workers and planning used, by source and unit, with unknown cost kept unknown.')),
    el('li', {}, routeLink('Alerts', '#/settings/alerts'), el('div', { class: 'subtext' }, 'Which notices alert you, quiet hours, and whether an alert transport is set up.')),
    el('li', {}, routeLink('Worker accounts', '#/settings/accounts'), el('div', { class: 'subtext' }, 'Each AI worker login on this computer, and whether it can take work now.')),
    el('li', {}, routeLink('Model instructions', '#/settings/instructions'), el('div', { class: 'subtext' }, 'Which AI models should handle what kind of work, by role, domain and reasoning effort.')),
    el('li', {}, routeLink('Version and roadmap', '#/settings/version'), el('div', { class: 'subtext' }, `Dashboard v${DASHBOARD_VERSION} (${DASHBOARD_VERSION_NAME}), active features and pre-1.0 roadmap.`)),
    el('li', {}, routeLink('Chats', MESSAGES_ADDRESS), el('div', { class: 'subtext' }, 'What you asked AIWorks, and what it answered.')),
    el('li', {}, routeLink('Diagnostics', '#/settings/diagnostics'), el('div', { class: 'subtext' }, 'The full activity journal, every step with its issue and pull request, the roadmap of the platform that keeps your project rules, and how fresh each merge check is.'))));
}

/**
 * The one primary action of a state (OWNER_WORKSPACE §4.4), or nothing: a screen link, a GitHub link, Resume, or the
 * Check again of work a recorded blocker stopped, each only while the work allows it.
 */
function primaryAction(primary, cls = 'button') {
  if (!primary) return null;
  if (primary.route) return routeLink(primary.label, primary.route, cls);
  if (primary.url) return link(`${primary.label} ↗`, primary.url, cls);
  const c = campaignById(primary.campaignId);
  const allowed = primary.command === 'resume' ? c?.controls?.primary === 'resume' : primary.command === 'recheck' && (c?.controls?.more ?? []).includes('recheck');
  if (!allowed) return null;
  return button(primary.label, () => command(c, primary.command), '', sending || offline || !state.supervisor.available);
}

/**
 * Now (OWNER_WORKSPACE §4.4, slice S4): the project's goal, where it stands in one sentence with at most one primary
 * action, progress in the owner's terms and what changed for this project since the last visit. The sentence is a
 * polite live region, so a screen reader hears it only when its text changes.
 */
function nowScreen(project) {
  // A connected project (UI13): one without GitHub has its own Now (UI17); a GitHub project's connection follows its work.
  const row = projectList().find((item) => sameProject(item.id, project));
  if (row?.connection && !row.repository) return localNowScreen(row);
  // A GitHub project where work cannot start (one the project rules do not list) has no work yet either: its
  // connection is its Now, so the page never offers Start work there (aiworks#11 review 5 G2).
  if (row?.connection && (!row.repository || (!projectCampaigns(project).length && !row.connection.startWork.allowed))) return [connectionPanel(row)];
  // Start work exists since slice S9 (Plan only), so the no-work state offers it as its primary action.
  const view = nowView(project, { ...state, offline }, { now: Date.now(), startWork: true }), { state: now, details } = view;
  const startWork = now.primary?.route?.screen === 'start' || offline || !state.supervisor.available ? null : routeLink('Plan work', { screen: 'start', project }, 'button secondary');
  const goal = view.goal ? `${view.goal.text}${view.goal.variant ? ` (${view.goal.variant})` : ''}` : null;
  const since = view.since?.length ? el('section', { class: 'since', 'aria-labelledby': 'since-title' },
    el('h2', { id: 'since-title' }, previousVisit ? `Since you last looked (${dateTime(previousVisit)})` : 'In the last 24 hours'),
    el('ul', {}, ...view.since.map((line) => el('li', { class: line.tone ?? '' }, `${line.text} `, ...line.links.map((item) => item.url ? link(`${item.label} ↗`, item.url) : routeLink(item.label, item.route)))))) : null;
  // The work as AIWorks names it, in owner words: no "campaign" where "work" will do (aiworks#11 review 5 G13).
  const others = details.others.map((item) => item.purpose ?? 'work without a name');
  // What else goes on in the project stays in view, whatever leads (aiworks#11 review 5 G5): a pause carries its Resume.
  const also = view.also?.length ? el('section', { 'aria-labelledby': `now-also-${project}` },
    el('h3', { id: `now-also-${project}`, class: 'section-title' }, 'Also in this project'),
    el('ul', { class: 'settings-links' }, ...view.also.map((line) => {
      const c = line.primary ? campaignById(line.primary.campaignId) : null;
      return el('li', { 'data-state': line.kind }, line.text, ' ',
        c?.controls?.primary === 'resume' ? button(line.primary.label, () => command(c, 'resume'), 'secondary', commandsOff()) : null);
    }))) : null;
  return [el('section', { class: 'panel', 'data-focus-scope': `now/${project}` }, el('div', { class: 'panel-body' },
    // owner-ui-v2 03-overview: the goal in the owner's own words leads as the headline; the state sentence below it
    // (now.title/now.text) is the supporting line, not the other way around.
    goal ? el('p', { class: 'now-goal' }, goal) : null,
    el('p', { role: 'status', 'aria-live': 'polite', 'data-state': now.key }, el('strong', {}, now.title), now.text ? ` ${now.text}` : ''),
    primaryAction(now.primary), startWork, also,
    view.progress ? el('p', { class: 'subtext' }, view.progress) : null,
    view.note ? el('p', { class: 'subtext' }, `${view.note.title} ${view.note.text}`) : null,
    details.trackingUrl || others.length ? disclosure(`now/${project}/details`, 'Details', el('div', { class: 'subtext' }, [
      details.trackingUrl ? link(`tracking issue #${details.trackingIssue} ↗`, details.trackingUrl) : null,
      others.length ? `Other work in this project: ${others.join(', ')}` : null].filter(Boolean).flatMap((part, index) => index ? [' · ', part] : [part]))) : null)),
  overviewPanel(project), reviewList(resultsToReview(project), { scope: `overview/${project}/reviews` }), row?.connection ? connectionPanel(row) : null, since].filter(Boolean);
}

/** A piece of work's steps in the order they can run: each after the steps it depends on, otherwise as declared. */
function runOrder(c) {
  const placed = [], left = [...c.tasks];
  while (left.length) {
    const index = left.findIndex((task) => task.dependsOn.every((id) => placed.some((item) => item.id === id) || !c.tasks.some((item) => item.id === id)));
    placed.push(...left.splice(Math.max(index, 0), 1));
  }
  return placed;
}

// Why a step waits and what AIWorks does next by itself, both from the supervisor's status (UI11); its times read as local clock times.
const waitLine = (wait) => wait ? `${clockTimes(wait.text)} · ${clockTimes(wait.next)}` : null;
const commandsOff = () => sending || offline || !state.supervisor.available;
function askCancel(c) {
  pendingCancel = c; $('#cancel-description').textContent = campaignTitle(c); $('#cancel-dialog').showModal();
}
const resumeButton = (c) => c.controls?.primary === 'resume' ? button('Resume', () => command(c, 'resume'), '', commandsOff()) : null;

/**
 * The More menu (OWNER_WORKSPACE §4.7): Pause, Check again and Cancel work, as the supervisor allows them for this work
 * now. Finished and cancelled work allows none, so it has no menu. On a step, Check again rechecks that step only.
 */
const canCheckAgain = (c, task) => (c.controls?.more ?? []).includes('recheck') && task.state !== 'done' && Boolean(task.blocked || task.retryAt || task.errorClass);
function moreMenu(c, task = null) {
  const allowed = c.controls?.more ?? [];
  // A stopped step tells the owner to check it again, so its Check again is shown beside that sentence, not in More.
  const actions = task ? task.stopped || !canCheckAgain(c, task) ? [] : ['recheck'] : allowed;
  if (!actions.length) return null;
  const labels = { pause: 'Pause', recheck: 'Check again' };
  return disclosure(`${c.id}/${task?.id ?? ''}/more`, 'More', el('div', { class: 'campaign-controls' }, ...actions.map((action) => action === 'cancel'
    ? el('button', { class: 'button text-danger small', disabled: commandsOff(), onclick: () => askCancel(c) }, 'Cancel work…')
    : button(labels[action], () => command(c, action, task ?? undefined), 'secondary small', commandsOff()))));
}

/**
 * One piece of work on the Work screen (OWNER_WORKSPACE §4.7, slice S5): its steps in the order they can run, each with
 * its outcome, one state, who is on it and why it waits; Resume as the one primary action when it is paused, and Pause,
 * Check again and Cancel under More. Dependencies, attempts, AI workers and cost are in Details.
 */
const delegatedNote = (c, task) => { const delivery = deliveryOf(c, task); return delivery?.state === 'delegated' ? delivery.note : null; };
function workPanel(project, c) {
  const terminal = ['finished', 'cancelled'].includes(c.control), note = terminal ? null : controlsNote(c);
  const rows = runOrder(c).map((task) => el('tr', { 'data-focus-scope': `${c.id}/${task.id}` },
    el('td', { class: 'c-work' }, routeLink(stepLabels(task).lead, { screen: 'step', project, work: c.id, step: task.id }, 'task-name'),
      stepLabels(task).more ? el('div', { class: 'subtext' }, stepLabels(task).more) : null,
      // Why it now runs on a stronger model (MODEL_ROUTING R6): the model itself is in Details.
      movedUpText(task.routing) ? el('div', { class: 'subtext' }, movedUpText(task.routing)) : null),
    el('td', { class: 'c-state' }, el('div', { class: 'cell-labels' }, stepBadge(c, task)),
      ...[whoLine(c, task), task.stopped?.title, waitLine(task.wait)].filter(Boolean).map((text) => el('div', { class: 'subtext' }, text)),
      verdictLabel(c, task),
      // Merging delegated by the owner: merged for them, why it is held (#97), or how long nothing merged it (#139).
      delegatedNote(c, task) ? el('div', { class: 'subtext' }, delegatedNote(c, task)) : null)));
  const { cost, body } = costNotes(c);
  return el('section', { class: 'panel', 'data-focus-scope': `work/${c.id}` },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', {}, campaignTitle(c, { inProject: true })), el('p', {}, campaignNext(c)), note ? el('p', { class: 'controls-note' }, note) : null),
      el('div', {}, resumeButton(c), moreMenu(c))),
    el('div', { class: 'steps' }, table(['What it delivers', 'Where it stands'], rows)),
    disclosure(`${c.id}/work-details`, `Details · ${plural(c.tasks.length, 'step')} · ${plural(c.runsUsed, 'run')} · ${cost}`,
      el('div', {}, stepsTable(c), terminal ? null : providerStatus(c), body, modelNotes(c))));
}

/** Each step's models and tiers and its cost by unit, then the work's (MODEL_ROUTING R6): Details of the Work screen. */
function modelNotes(c) {
  const steps = runOrder(c).filter((task) => modelsText(task.routing) || unitCostText(task.costByUnit));
  if (!steps.length && !unitCostText(c.costByUnit)) return null;
  return el('div', { class: 'notes' }, el('h3', { class: 'section-title' }, 'Models and cost by unit'),
    steps.length ? el('ul', {}, ...steps.map((task) => el('li', {}, `${task.outcome ?? task.title}: `,
      [modelsText(task.routing), movedUpText(task.routing), unitCostText(task.costByUnit)].filter(Boolean).join('. ')))) : null,
    unitCostText(c.costByUnit) ? el('p', {}, `This work, by unit, never added together: ${unitCostText(c.costByUnit)}.`) : null);
}

/** One attempt of a step and how it ended, from the supervisor's records: "Builder (Claude): rejected · started … · ended …". */
const attemptText = (a) => `${a.outcome ? outcomeText(a) : `${roleName(a.role)} (${provider(a.executor)}): ${a.endedAt ? 'ended without a result' : 'running'}`} · started ${dateTime(a.startedAt)}${
  a.endedAt ? ` · ended ${dateTime(a.endedAt)}` : ''}${a.refunded ? ' · not counted as a run' : ''}`;

/**
 * A step's decision (OWNER_UI_V2 WP2): the question with each option and its consequence, AIWorks' suggestion and why,
 * what continues meanwhile and what happens without an answer, all from the validated decision record; a stop without
 * one asks for the owner's own words. Send answer, Remind me later and "This did not need me" are each bound to this one
 * decision. The choice and the words are a draft of this address until the server accepts them; a retry reuses its
 * request id, so it is never applied twice.
 */
let decisionBusy = false;
async function sendDecision(action, c, task, body, { address = current.address, done = null } = {}) {
  c = campaignById(c.id) ?? c; task = c.tasks.find((item) => item.id === task.id) ?? task;
  const payload = { requestId: crypto.randomUUID(), campaignId: c.id, taskId: task.id, taskVersion: task.version, version: c.version,
    authorizationVersion: c.authorizationVersion, scopeDigest: c.scopeDigest, decision: task.decision.id, ...body };
  decisionBusy = true; render();
  const attempt = async () => {
    try {
      const result = await post(`/api/v2/decisions/${action}`, payload);
      done?.();
      notice(result.duplicate ? COMMANDS.duplicate : action === 'snooze' ? COMMANDS.decision.snooze(result.until) : COMMANDS.decision[action], null, null, address);
    } catch (error) {
      if (error.code === 'INSTRUCTION_LOOKS_SENSITIVE') return notice(error.message, null, null, address);
      notice(error.known ? error.message : COMMANDS.unconfirmed, error.known ? null : attempt, error.known ? error.detail : null, address);
    }
  };
  try { await attempt(); } finally { decisionBusy = false; await poll(); }
}

/*
 * A step's risk (OWNER_UI_V2 section 4): a label from recorded evidence only (supervisor.mjs stepRisks), never a guess,
 * so a step with none says "not known". It decides what Review asks the owner to look at and keeps high-risk decisions
 * off the phone: on a touch screen at phone width such a decision is shown in full but answered on a computer. A
 * desktop at 320 px (zoomed) keeps every control, and Remind me later works everywhere.
 */
const RISK_WORDS = { low: ['planned', 'Low risk'], medium: ['attention', 'Medium risk'], high: ['blocked', 'High risk'] };
const riskLine = (risk) => risk ? el('p', { class: 'subtext', 'data-risk': risk.level }, badge(...RISK_WORDS[risk.level]), ' ',
  risk.source === 'declared' ? 'Marked high risk in the approved plan.' : 'From how AIWorks routed this step’s runs.')
  : el('p', { class: 'subtext', 'data-risk': 'unknown' }, 'Risk not known yet: no run of this step has recorded it.');
const PHONE = '(pointer: coarse) and (max-width: 640px)';
const onPhone = () => { try { return window.matchMedia(PHONE).matches; } catch { return false; } };
try { window.matchMedia(PHONE).addEventListener('change', () => { if (state && !document.querySelector('dialog[open]')) render(); }); } catch { /* no media queries */ }

function decisionPanel(c, task, { more } = {}) {
  const d = task.decision;
  if (!d) return null;
  // A high-risk decision on a phone: read here, answered on a computer (the server's rules are the same either way).
  const deferred = task.risk?.level === 'high' && onPhone();
  const address = current.address, key = `decision:${d.id}`, off = decisionBusy || commandsOff();
  if (d.answered) {
    const chosen = d.options.find((o) => o.id === d.answered.option);
    return el('div', { class: 'instruction-list', 'data-decision': d.id, 'data-focus-scope': `decision/${d.id}` },
      el('h3', { class: 'section-title' }, 'Your answer'),
      el('p', { role: 'status' }, `Answered at ${clock(d.answered.at)}${chosen ? `: ${chosen.label}` : ''}. AIWorks continues the step with your answer.`));
  }
  const draft = drafts.get(address, key) ?? { option: null, text: '', feedback: '' };
  // Every control is named for this decision: two decisions on one page (Needs you) never share an id, a radio group or a draft.
  const radios = `decision-option-${d.id}`;
  const save = () => drafts.set(address, key, { option: form.querySelector(`input[name="${radios}"]:checked`)?.value ?? null, text: words.value, feedback: feedback.value });
  const words = el('textarea', { id: `decision-text-${d.id}`, rows: 3, maxlength: 2000, required: !d.structured, oninput: save });
  words.value = draft.text ?? '';
  const feedback = el('textarea', { id: `decision-feedback-${d.id}`, rows: 2, maxlength: 2000, oninput: save });
  feedback.value = draft.feedback ?? '';
  const choice = el('span', { id: `decision-choice-error-${d.id}`, class: 'validation-error', role: 'alert', hidden: true }, COMMANDS.decision.notOption);
  const options = d.structured && deferred ? el('div', {}, el('p', {}, el('strong', {}, d.question)),
    el('ul', {}, ...d.options.map((o) => el('li', {}, `${o.label}${d.suggestion?.option === o.id ? ' (suggested)' : ''}`, el('div', { class: 'subtext' }, o.consequence)))))
    : d.structured ? el('fieldset', {}, el('legend', {}, d.question),
    ...d.options.map((o) => {
      const input = el('input', { type: 'radio', name: radios, value: o.id, 'aria-describedby': `${radios}-${o.id}`, onchange: save });
      input.checked = draft.option === o.id;
      return [el('label', { class: 'choice' }, input, el('span', {}, o.label, d.suggestion?.option === o.id ? ' (suggested)' : '')),
        el('p', { id: `${radios}-${o.id}`, class: 'subtext' }, o.consequence)];
    }), choice) : null;
  // The suggestion's reason, what goes on meanwhile, optional words and "This did not need me" are under one More
  // (aiworks#39): the card's own, or this panel's on the step. Each control keeps its id, draft and binding.
  const extra = [
    d.suggestion ? el('p', { class: 'subtext' }, `AIWorks suggests ${d.options.find((o) => o.id === d.suggestion.option)?.label ?? d.suggestion.option}: ${d.suggestion.reason}`) : null,
    d.continues ? el('p', { class: 'subtext' }, `Meanwhile: ${d.continues}`) : null,
    d.unanswered ? el('p', { class: 'subtext' }, `If you do not answer: ${d.unanswered}`) : null,
    deferred || !d.structured ? null : el('label', { class: 'field' }, el('strong', {}, 'Your own words (optional with a choice)'), words),
    deferred ? null : el('p', { class: 'subtext' }, 'Goes to the next AI worker on this step. It cannot widen the approved plan.'),
    d.notNeeded ? el('p', { class: 'subtext' }, 'You said this did not need you. The step still waits for an answer.')
      : deferred ? null : el('div', { class: 'not-needed', 'data-focus-scope': `decision/${d.id}/not-needed` },
        el('label', { class: 'field' }, el('strong', {}, 'This did not need me. What should AIWorks have done instead? (optional)'), feedback),
        el('div', { class: 'campaign-controls' }, button('Send feedback', () => sendDecision('not-needed', c, task, feedback.value.trim() ? { text: feedback.value } : {},
          { address, done: () => drafts.set(address, key, { ...(drafts.get(address, key) ?? {}), feedback: '' }) }), 'secondary', off)))];
  more?.push(...extra);
  const form = el('form', { novalidate: true, class: 'start-form', 'data-decision': d.id, 'data-focus-scope': `decision/${d.id}`,
    onsubmit: (event) => {
      event.preventDefault();
      if (off || !validateForm(form)) return;
      const option = form.querySelector(`input[name="${radios}"]:checked`)?.value;
      choice.hidden = Boolean(option || words.value.trim());
      if (!choice.hidden) { form.querySelector(`input[name="${radios}"]`)?.focus(); return; }
      void sendDecision('answer', c, task, { ...(option ? { option } : {}), ...(words.value.trim() ? { text: words.value } : {}) },
        { address, done: () => drafts.delete(address, key) });
    } },
    el('h3', { class: 'section-title' }, d.structured ? 'Your decision' : 'Your answer'),
    deferred ? el('p', { class: 'notice warning', role: 'status' }, 'This step is high risk, so this decision is answered on a computer, not on a phone. Open this page on your computer to answer; the step waits meanwhile.') : null,
    d.structured || deferred ? null : el('p', {}, d.asked ? `The AI worker asked: “${d.asked}” It described no options; answer in your own words.`
      : 'The AI worker described no options for this stop. Answer in your own words.'),
    options,
    // A required answer in the owner's own words is the action itself; optional words with a choice are under More.
    deferred || d.structured ? null : el('label', { class: 'field' }, el('strong', {}, 'Your answer'), words),
    deferred ? null : el('div', { class: 'campaign-controls' }, el('button', { class: 'button', type: 'submit', disabled: off }, 'Send answer')),
    more ? null : moreBox(`decision/${d.id}/more`, extra));
  return form;
}

/**
 * Review of a result (OWNER_UI_V2 WP4): the checker's verdict in a sentence, each done-when criterion with how it was
 * checked and what was seen ("Not checked" when the checker said nothing about it), open findings, where the owner's own
 * eyes matter, then Accept result and Request changes. Both are bound to the version that passed the check and its
 * report; a retry reuses its request id, so nothing is recorded twice. The request's words are a draft of this address
 * until the server accepts them. A local result is accepted with Apply, so it offers Request changes only.
 */
const CRITERION_WORDS = { pass: ['done', 'Passed'], fail: ['attention', 'Failed'], 'not-checked': ['unknown', 'Not checked'] };
let reviewBusy = false;
async function sendReview(action, binding, review, body, { address = current.address, done = null } = {}) {
  const payload = { requestId: crypto.randomUUID(), ...binding, verifiedSha: review.verifiedSha, reportDigest: review.reportDigest, ...body };
  reviewBusy = true; render();
  const attempt = async () => {
    try {
      const result = await post(`/api/v2/results/${action}`, payload);
      done?.();
      notice(result.duplicate ? COMMANDS.duplicate : action === 'accept' ? COMMANDS.result.accept(result.mergeGate) : COMMANDS.result[action], null, null, address);
    } catch (error) {
      if (error.code === 'INSTRUCTION_LOOKS_SENSITIVE') return notice(error.message, null, null, address);
      notice(error.known ? error.message : COMMANDS.unconfirmed, error.known ? null : attempt, error.known ? error.detail : null, address);
    }
  };
  try { await attempt(); } finally { reviewBusy = false; await poll(); }
}

/**
 * Try this version (OWNER_UI_V2 WP7): the static pages of exactly the commit that passed the check, or the pages its own
 * server answers where the operator declared one for the project (`runtime: 'server'`), in a sandboxed frame at desktop
 * or phone width. Opening is bound to the same version and report as Accept result; the frame cannot reach the
 * dashboard or the network, and the preview ends by itself after 30 minutes. Each preview is kept per version, so the
 * 5-second refresh keeps the frame as it is. A result without one says why. Capture screenshots asks AIWorks for desktop
 * and phone screenshots of the same version, taken in a browser it starts and stops (preview-capture.mjs); each names the
 * page width the browser measured, the version and when, and none is kept once the preview is closed or reopened.
 */
const previews = new Map();
// The button pressed is replaced by the next state's controls, so focus moves to that preview's first control.
const showPreview = (key, value) => {
  if (value) previews.set(key, value); else previews.delete(key);
  render();
  [...document.querySelectorAll('.preview-panel')].find((node) => node.dataset.focusScope === `preview/${key}`)?.querySelector('button')?.focus({ preventScroll: true });
};
// Each frame keeps its stated page width (desktop as the screenshots capture it, phone 390 px) and scales it down in a
// narrower window, so the page always lays out at that width and the note says how much smaller it is shown. Run after
// every render (the refresh resets the frame's style) and when the window changes size.
const PREVIEW_WIDTHS = { desktop: 1366, phone: 390 };
function fitPreviewFrames() {
  for (const frame of document.querySelectorAll('.preview-frame')) {
    const width = PREVIEW_WIDTHS[frame.classList.contains('phone') ? 'phone' : 'desktop'];
    const scale = Math.min(1, frame.clientWidth / width) || 1;
    frame.style.setProperty('--preview-scale', String(scale));
    const note = frame.closest('.preview-panel')?.querySelector('.preview-fit');
    if (note) note.textContent = scale < 1 ? ` This window is narrower, so it is shown at ${Math.round(scale * 100)}%; the page still lays out at ${width} px.` : '';
  }
}
window.addEventListener('resize', fitPreviewFrames);
async function captureShots(key, binding, review) {
  const shown = previews.get(key);
  if (!shown || shown.state !== 'open') return;
  previews.set(key, { ...shown, shots: { state: 'capturing' } });
  render();
  let shots;
  try {
    const captured = await post('/api/v2/results/preview/capture', { ...binding, verifiedSha: review.verifiedSha, reportDigest: review.reportDigest });
    shots = captured.verifiedSha === review.verifiedSha ? { state: 'captured', ...captured } : { state: 'failed', error: COMMANDS.unconfirmed };
  } catch (error) {
    shots = { state: 'failed', error: error.known ? error.message : COMMANDS.unconfirmed };
  }
  // A preview closed or replaced meanwhile keeps nothing of this capture.
  const now = previews.get(key);
  if (now?.state !== 'open' || now.url !== shown.url) return;
  previews.set(key, { ...now, shots });
  render();
  document.querySelector(`[data-capture="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}
function shotsBlock(key, shown, control, captureAction) {
  if (!shown.capture?.available) return el('p', { class: 'subtext' }, `Screenshots are not available here. ${shown.capture?.reason ?? ''}`);
  const shots = shown.shots;
  const capture = control(shots?.state === 'captured' ? 'Capture again' : 'Capture screenshots', captureAction, 'secondary',
    { disabled: shots?.state === 'capturing' || offline, 'data-capture': key });
  const status = shots?.state === 'capturing'
    ? el('p', { role: 'status', 'aria-live': 'polite' }, 'Capturing the checked version at desktop and phone width in a sealed browser on this computer… This can take a minute.')
    : shots?.state === 'failed' ? el('p', { class: 'notice warning', role: 'alert' }, `No screenshots were kept. ${shots.error}`)
      : shots?.state === 'captured' ? null
        : el('p', { class: 'subtext' }, 'Screenshots are taken by AIWorks in a browser it starts for this and stops afterwards. That browser reaches nothing but this version’s pages.');
  const figures = shots?.state === 'captured' ? el('div', { class: 'preview-shots' }, shots.shots.map((shot) => el('figure', { class: `preview-shot ${shot.size}` },
    el('img', { src: shot.image, alt: `Screenshot of the checked version at ${shot.size} width`, loading: 'lazy' }),
    el('figcaption', { class: 'subtext' }, `${shot.size === 'phone' ? 'Phone' : 'Desktop'}: ${shot.width} × ${shot.height} px screen, page laid out at ${shot.viewport.width} × ${shot.viewport.height} px as the browser measured it. `,
      `The checked version, captured at ${clock(shots.capturedAt)} on this computer.`)))) : null;
  return el('div', { class: 'preview-evidence' }, el('div', { class: 'campaign-controls' }, capture), status, figures);
}
// Closing a server preview asks AIWorks to end it, which stops its server; a static one simply goes away.
async function closePreview(key, shown) {
  showPreview(key, null);
  if (shown?.runtime === 'server' && shown.url) await post('/api/v2/results/preview/close', { url: shown.url }).catch(() => {});
}
async function openPreview(key, binding, review) {
  showPreview(key, { state: 'opening', size: previews.get(key)?.size ?? 'desktop' });
  try {
    const opened = await post('/api/v2/results/preview', { ...binding, verifiedSha: review.verifiedSha, reportDigest: review.reportDigest });
    showPreview(key, { state: 'open', size: previews.get(key)?.size ?? 'desktop', url: opened.url, sha: opened.verifiedSha, expiresAt: opened.expiresAt, runtime: opened.runtime ?? 'static', capture: opened.capture ?? null });
  } catch (error) {
    showPreview(key, { state: 'failed', size: previews.get(key)?.size ?? 'desktop', error: error.known ? error.message : COMMANDS.unconfirmed });
  }
}

function previewSection(review, binding) {
  if (!review.preview) return null;
  const key = `${binding.campaignId}/${binding.taskId}/${review.verifiedSha}`, shown = previews.get(key);
  const section = (...children) => el('div', { class: 'preview-panel', 'data-focus-scope': `preview/${key}` }, el('strong', {}, 'Try this version'), ...children);
  if (!review.preview.available) return section(el('p', { class: 'subtext' }, `Preview not available: ${review.preview.reason}`));
  const server = review.preview.runtime === 'server';
  const identity = el('p', { class: 'subtext' }, 'The checked version', server
    ? ', exactly as it was checked. Opening it starts that version’s own server on this computer, reachable only from here and stopped after 10 minutes or when the preview closes; nothing is built and no install script runs. Its pages run in a sealed frame that cannot reach this dashboard or the internet.'
    : ', exactly as it was checked. Its pages run in a sealed frame: they cannot reach this dashboard or the internet, and nothing of the project is built or started on this computer.');
  // Each control names its preview: the refresh keeps a button that shows exactly the same, with its own action, so two
  // results' identical buttons must never be mistaken for each other.
  const control = (label, action, cls = 'secondary', extra = {}) => el('button', { class: `button ${cls}`, type: 'button', 'data-preview': key, onclick: action, ...extra }, label);
  const open = (label) => control(label, () => void openPreview(key, binding, review), shown ? 'secondary' : '', { disabled: shown?.state === 'opening' || offline });
  if (!shown) return section(identity, el('div', { class: 'campaign-controls' }, open('Open preview')));
  if (shown.state === 'opening') return section(identity, el('p', { role: 'status', 'aria-live': 'polite' }, server ? 'Starting the checked version’s server… This can take half a minute.' : 'Opening the checked version…'));
  if (shown.state === 'failed') return section(identity, el('p', { class: 'notice warning', role: 'alert' }, `The preview did not open. ${shown.error}`), el('div', { class: 'campaign-controls' }, open('Try again')));
  const size = (name, label) => control(label, () => { previews.set(key, { ...shown, size: name }); render(); }, 'secondary', { 'aria-pressed': String(shown.size === name) });
  const frame = el('div', { class: `preview-frame ${shown.size}` }, el('iframe', { src: shown.url, title: `Preview of the checked version (${shown.size === 'phone' ? 'phone' : 'desktop'} width)`,
    sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', loading: 'lazy' }));
  return section(identity,
    el('div', { class: 'campaign-controls preview-controls', role: 'group', 'aria-label': 'Preview width' }, size('desktop', 'Desktop'), size('phone', 'Phone'),
      control('Close preview', () => void closePreview(key, shown))),
    el('p', { class: 'subtext' }, `Showing a ${shown.size === 'phone' ? 'phone' : 'desktop'}-width (${PREVIEW_WIDTHS[shown.size === 'phone' ? 'phone' : 'desktop']} px) view of the checked version.`,
      el('span', { class: 'preview-fit' }), ` The preview ends at ${clock(shown.expiresAt)}; open it again after that.`),
    frame,
    shotsBlock(key, shown, control, () => void captureShots(key, binding, review)));
}

function reviewPanel(review, binding, { merged = false } = {}) {
  if (!review) return null;
  // Merged outside the merge gate (seen in local git): nothing is left to accept or send back.
  if (merged && ['ready', 'accepted'].includes(review.state)) review = { ...review, state: 'merged', canAccept: false, canRequestChanges: false };
  const scope = `review/${binding.campaignId}/${binding.taskId}`;
  const box = (...children) => el('div', { class: 'instruction-list review-panel', 'data-review': review.state, 'data-focus-scope': scope }, ...children);
  if (review.state === 'changes-requested') return box(el('h3', { class: 'section-title' }, 'Changes requested'), ...reviewActions(review, binding), previewSection(review, binding));
  if (review.state === 'no-evidence') {
    return box(el('h3', { class: 'section-title' }, 'Review'), ...reviewActions(review, binding), previewSection(review, binding));
  }
  return box(
    el('h3', { class: 'section-title' }, 'Review of the checked version'),
    review.summary ? el('p', {}, `The independent checker: ${review.summary}`) : null,
    previewSection(review, binding),
    el('ol', { class: 'review-criteria', 'aria-label': 'Done-when criteria and their evidence' }, ...review.criteria.map((item) => el('li', {},
      el('span', {}, item.text), ' ', el('span', { class: `badge ${CRITERION_WORDS[item.result][0]}` }, CRITERION_WORDS[item.result][1]),
      el('div', { class: 'subtext' }, item.check ? `Checked: ${item.check}` : 'The checker reported no check for this criterion.'),
      item.evidence ? el('div', { class: 'subtext' }, `Evidence: ${item.evidence}`) : null))),
    review.findings.length ? el('div', {}, el('strong', {}, 'Findings'), el('ul', {}, ...review.findings.map((f) => el('li', {}, `${f.severity === 'blocking' ? 'Blocking' : 'Not blocking'}: ${f.description}`)))) : null,
    review.eyesOn.length ? el('div', {}, el('strong', {}, 'Where your eyes matter'), el('ul', {}, ...review.eyesOn.map((item) => el('li', {}, item)))) : null,
    ...reviewActions(review, binding));
}

/**
 * What the owner can do with a checked result, on its Review and on its Needs you card alike: where it stands, Accept
 * result and Request changes, each bound to exactly the version that passed the check and its report (sendReview). The
 * controls are named for the goal and step, so two results on one page never share an id or a draft. Request changes
 * reopens the step as a repair round of the approved plan; nothing is merged from here. On a Needs you card (`more`)
 * the explanations and the criterion choice go under the card's More: Request changes is one short field and its button.
 */
function reviewActions(review, binding, { more } = {}) {
  const aside = (node) => { if (!more || !node) return node; more.push(node); return null; };
  if (review.state === 'changes-requested') {
    // Only running work is repaired: paused work waits for Resume, and stopped work is never resumed.
    const control = campaignById(binding.campaignId)?.control;
    if (['paused', 'cancelled'].includes(control)) {
      return [el('p', { role: 'status' }, `You asked for changes to this checked version${review.requestedAt ? ` at ${clock(review.requestedAt)}` : ''}. ${control === 'paused'
        ? 'This work is paused, so nobody is making them until you resume it.' : 'This work was stopped, so AIWorks will not make them; plan this work again if you still want them.'} The earlier check stays on record.`)];
    }
    return [el('p', { role: 'status' }, review.stalled
      ? 'You asked for changes to this checked version, but this step has used all its repair rounds, so it stopped. Nothing of it was published or merged.'
      : `You asked for changes to this checked version${review.requestedAt ? ` at ${clock(review.requestedAt)}` : ''}. AIWorks repairs this step within the approved plan; a fresh independent check comes before anything is published or merged. The earlier check stays on record.`)];
  }
  if (review.state === 'no-evidence') return [el('p', {}, 'No independent check of this version is on record, so it can be neither accepted nor sent back here. Its Needs you card offers to plan this work again; nothing starts until you approve the plan.')];
  const off = reviewBusy || commandsOff(), address = current.address, key = `review:${binding.campaignId}/${binding.taskId}/${review.verifiedSha}`;
  const ids = `${binding.campaignId}-${binding.taskId}`;
  const u = review.unresolved, open = u.failed + u.notChecked + u.blocking;
  const draft = drafts.get(address, key) ?? { text: '', criterion: '' };
  const words = el('textarea', { id: `review-text-${ids}`, rows: more ? 2 : 3, maxlength: 2000, required: true,
    oninput: () => drafts.set(address, key, { text: words.value, criterion: which.value }) });
  words.value = draft.text ?? '';
  const which = el('select', { id: `review-criterion-${ids}`, onchange: () => drafts.set(address, key, { text: words.value, criterion: which.value }) },
    el('option', { value: '' }, 'The result as a whole'), ...review.criteria.map((item) => el('option', { value: String(item.criterion) }, `${item.criterion}. ${item.text}`)));
  which.value = draft.criterion ?? '';
  // AW-016: changes asked of paused work are settled when they are asked: the request offers to resume, so the owner
  // is not reminded later that nobody is making them.
  const goal = campaignById(binding.campaignId), resumable = goal?.control === 'paused' && goal.controls?.primary === 'resume';
  const resume = resumable ? el('input', { type: 'checkbox', id: `review-resume-${ids}` }) : null;
  const form = review.canRequestChanges ? el('form', { novalidate: true, class: 'start-form', 'data-focus-scope': `review/${binding.campaignId}/${binding.taskId}/changes`,
    onsubmit: (event) => {
      event.preventDefault();
      if (off || !validateForm(form)) return;
      const andResume = Boolean(resume?.checked);
      void sendReview('request-changes', binding, review, { text: words.value, ...(which.value ? { criterion: Number(which.value) } : {}) },
        { address, done: () => { drafts.delete(address, key); if (andResume) void command(goal, 'resume'); } });
    } },
    aside(el('label', { class: 'field' }, el('strong', {}, 'About'), which)),
    el('label', { class: 'field' }, el('strong', {}, 'What should change'), words),
    resume ? el('label', { class: 'choice' }, resume, el('span', {}, 'This work is paused. Resume it so the changes start now')) : null,
    aside(el('p', { class: 'subtext' }, `AIWorks reopens this step as a repair round within the approved plan${review.roundsLeft === null ? '' : ` (${plural(review.roundsLeft, 'round')} left)`}. A wider change needs a new plan. No secrets; up to 2,000 characters.`)),
    el('div', { class: 'campaign-controls' }, el('button', { class: 'button secondary', type: 'submit', disabled: off }, 'Request changes'))) : null;
  const accepted = review.state === 'accepted' ? `You accepted this version at ${clock(review.acceptedAt)}. ${review.mergeGate === 'on' ? 'AIWorks merges it when its merge conditions hold.' : 'Merging follows this project’s own rules: AIWorks merges only in projects where you allowed it.'}`
    : review.state === 'merged' ? 'This version is merged.' : null;
  // What is still open stays in sight beside Accept result; that everything passed is an explanation.
  const verdict = el('p', { role: 'status' }, open ? `Not complete: ${[u.failed ? `${plural(u.failed, 'criterion', 'criteria')} failed` : null, u.notChecked ? `${plural(u.notChecked, 'criterion', 'criteria')} not checked` : null,
      u.blocking ? `${plural(u.blocking, 'blocking finding')} open` : null].filter(Boolean).join(' · ')}.` : 'Every criterion passed the independent check.');
  return [
    open ? verdict : aside(verdict),
    accepted ? el('p', { role: 'status' }, accepted) : null,
    // You accept results yourself here (AW-015): the merge gate holds this version until you accept it or ask for changes.
    aside(review.awaitsAcceptance ? el('p', { role: 'status' }, 'Waiting for you: you accept results yourself in this project, so this version is not merged until you accept it.') : null),
    aside(!review.local && review.state === 'ready' && !review.canAccept && (u.failed || u.blocking) ? el('p', { class: 'subtext' }, COMMANDS.result.unresolved) : null),
    review.canAccept ? el('div', { class: 'campaign-controls' }, button('Accept result', () => sendReview('accept', binding, review, {}, { address }), '', off),
      aside(el('span', { class: 'subtext' }, review.mergeGate === 'on' ? 'Approves exactly this version; AIWorks merges it when its merge conditions hold.' : 'Approves exactly this version and takes it off Needs you. Merging follows this project’s own rules: AIWorks merges only in projects where you allowed it.'))) : null,
    form].filter(Boolean);
}

/**
 * Step (OWNER_WORKSPACE §4.8, slice S5): the outcome with its work's goal and project; one state and who is on it;
 * progress from the worker's own record; the last result; guidance sent, with receipts; one primary action by state;
 * and, in Details, every attempt with its end and the step's own events.
 */
function stepScreen(project, c, task) {
  const agent = c.agents.find((item) => item.taskId === task.id), p = agent?.progress;
  const delivery = deliveryOf(c, task), number = delivery?.number ?? /\/pull\/(\d+)$/.exec(task.resultUrl ?? '')?.[1];
  const unfinished = !['done', 'verified'].includes(task.state);
  // With a decision to answer on this screen, Send answer is the one primary action; the step issue is secondary.
  const primary = task.stopped ? primaryAction(task.stopped.primary, task.decision && !task.decision.answered ? 'button secondary' : 'button')
    : delivery?.route ? routeLink(delivery.route.label, delivery.route.address, 'button')
    // A checked result is resolved in its Review below; its pull request is supporting reference, never the primary action.
    : task.resultUrl ? link(number ? `Pull request #${number} ↗` : 'Open the result ↗', delivery?.url ?? task.resultUrl, task.review ? 'needs-link' : 'button')
      : unfinished && c.controls?.more.length ? button('Send guidance', () => openInstructions(c, task), '', commandsOff()) : null;
  // Passed only when the check passed every criterion (the server's checkPassed); otherwise what is still open.
  const u = task.review?.unresolved;
  const open = u ? [u.failed ? `${plural(u.failed, 'criterion', 'criteria')} failed` : null, u.notChecked ? `${plural(u.notChecked, 'criterion', 'criteria')} not checked` : null,
    u.blocking ? `${plural(u.blocking, 'blocking finding')} open` : null].filter(Boolean).join(' · ') : '';
  const last = !task.verifiedSha ? outcomeText(task.lastOutcome) : task.checkPassed ? 'Passed the independent check'
    : `Checked, not complete: ${open || 'not every criterion is recorded as passed'}`;
  const meaning = task.verifiedSha ? null : resultMeaning(task.lastOutcome, { stopped: Boolean(task.stopped), check: canCheckAgain(c, task) });
  const guidance = (c.instructions ?? []).filter((item) => item.taskId === task.id);
  const reading = readingLines(task.reading);
  const { attempts, events } = task.history ?? { attempts: [], events: [] };
  return [el('section', { class: 'panel', 'data-focus-scope': `step/${c.id}/${task.id}` },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', {}, task.outcome ?? task.title), el('p', {}, `${campaignTitle(c, { inProject: true })} · project ${projectName(project)}`)),
      moreMenu(c, task)),
    el('div', { class: 'panel-body' },
      el('p', { role: 'status', 'aria-live': 'polite' }, stepBadge(c, task), ' ', task.stopped ? el('strong', {}, task.stopped.title) : whoIsOn(c, task) ?? waitLine(task.wait) ?? ''),
      task.stopped ? el('p', {}, task.stopped.text) : null,
      riskLine(task.risk),
      stopChoices(project, c, task),
      decisionPanel(c, task),
      reviewPanel(task.review, { campaignId: c.id, taskId: task.id, taskVersion: task.version, version: c.version,
        authorizationVersion: c.authorizationVersion, scopeDigest: c.scopeDigest }, { merged: deliveryOf(c, task)?.state === 'merged' }),
      p ? el('p', { class: 'subtext' }, `From the worker’s own record: ${plural(p.turns, 'turn')} · ${plural(p.toolCalls, 'action')} · last activity ${timeAgo(p.lastActivityAt)}`) : null,
      last ? el('p', { class: 'subtext' }, `Last result: ${last}`) : null,
      task.signature ? el('div', { class: 'instruction-list', 'data-task-signature': '' },
        el('h3', { class: 'section-title' }, 'Model signature'),
        task.signature.name ? el('p', {}, el('strong', {}, 'Implementer: '), `${task.signature.name} (${task.signature.type ?? 'model'} · ${task.signature.effort ?? 'standard'} effort${task.signature.tokens ? ` · ${task.signature.tokens.total?.toLocaleString?.() ?? task.signature.tokens.total} tokens` : ' · tokens not reported'})`) : null,
        task.signature.verifier ? el('p', {}, el('strong', {}, 'Verifier: '), `${task.signature.verifier.name} (${task.signature.verifier.type ?? 'model'} · ${task.signature.verifier.effort ?? 'standard'} effort${task.signature.verifier.tokens ? ` · ${task.signature.verifier.tokens.total?.toLocaleString?.() ?? task.signature.verifier.tokens.total} tokens` : ' · tokens not reported'})`) : null
      ) : null,
      // What that result means and, when stopped, what fixing it involves, in place (aiworks#11 review 4 F13).
      meaning ? el('div', { class: 'instruction-list', 'data-result-meaning': '' }, el('p', {}, meaning.kind), el('p', {}, meaning.fix)) : null,
      // The rule a returned change broke and what the next attempt was given (SCOPED_READING, slice UI18): paths, sections and headings only.
      reading ? el('div', { class: 'instruction-list' }, el('h3', { class: 'section-title' }, reading.title), ...reading.lines.map((line) => el('p', {}, line))) : null,
      // The recovery the stop sentence names is shown beside its primary action, never only under More (aiworks#11 review F12).
      // A high-risk step's retry is decided on a computer, like its decision.
      task.stopped && canCheckAgain(c, task) && !(task.risk?.level === 'high' && onPhone())
        ? el('div', { class: 'campaign-controls' }, primary, button('Check again', () => command(c, 'recheck', task), 'secondary', commandsOff())) : primary,
      guidance.length ? el('div', { class: 'instruction-list' }, el('h3', { class: 'section-title' }, 'Guidance you sent'), ...guidance.map((item) => instructionReceipt(item, c))) : null,
      disclosure(`step/${c.id}/${task.id}/details`, `Details · ${plural(attempts.length, 'attempt')}`, el('div', {},
        attempts.length ? el('ol', { class: 'receipt-steps' }, ...attempts.map((a) => el('li', {}, attemptText(a))))
          : el('p', { class: 'subtext' }, 'No attempt has run yet.'),
        activityList(30, events),
        el('p', { class: 'subtext' }, link('Step issue on GitHub ↗', task.issueUrl))))))];
}

/*
 * What the owner can do about a stop, by its kind (supervisor.mjs stopKind), naming only what the existing authority
 * supports: an answer or Check again retries the step under the same plan and limits; a smaller step, another protected
 * scope or a wider limit is a new plan the owner compares and approves on Review. There is no "allow once": a result
 * that changed a protected area or left its plan stays held, and nothing on this page publishes it.
 */
const STOP_CHOICES = {
  'repair-limit': ['The independent checker still rejects this step, and its repair rounds are used up. The rejected version is not accepted or published.',
    'Answer the decision, or send guidance and press Check again: the step gets one more try within the same limit.',
    'A smaller step or more repair rounds changes the approved plan: plan it again under Plan work, compare it and approve it on Review. This goal keeps the limits it was approved with.'],
  'protected-area': ['The step changed a protected area of this project. Its result is held: it is not published, merged or offered for review.',
    'Answer the decision, or press Check again, to have the step redone without touching that area. The area stays protected for the new try.',
    'Work that must change a protected area needs a new plan that you approve after changing the area in Project settings; this goal keeps the areas it was approved with. There is no way to allow it once.'],
  boundary: ['The step changed something outside what its plan allows. Its result is held: it is not published, merged or offered for review.',
    'Answer the decision, or press Check again, to have the step redone within the plan.',
    'Work that needs more files or another scope is a new plan for you to compare and approve.'],
};
function stopChoices(project, c, task) {
  const lines = task.stopped ? STOP_CHOICES[task.stopped.kind] : null;
  if (!lines) return null;
  return el('div', { class: 'instruction-list', 'data-stop': task.stopped.kind, 'data-focus-scope': `step/${c.id}/${task.id}/choices` },
    el('h3', { class: 'section-title' }, 'What you can do'), el('p', {}, lines[0]), el('ul', {}, el('li', {}, lines[1]), el('li', {}, lines[2])),
    el('p', { class: 'subtext' }, routeLink('Plans of this project', { screen: 'plan', project }),
      task.stopped.kind === 'protected-area' ? [' · ', routeLink('Project settings', { screen: 'project-settings', project })] : null));
}

/** One Results row: what the step delivers, its state word, what follows, the link to the result and the check in details. */
const resultRow = (row) => el('li', { class: `result-row ${row.group}`, 'data-focus-scope': `${row.campaignId}/${row.taskId}` },
  el('div', { class: 'needs-text' }, el('span', {}, row.text), row.link ? link(`${row.link.label} ↗`, row.link.url, 'needs-link') : null,
    row.route ? routeLink(row.route.label, row.route.address, 'needs-link') : null,
    row.review ? routeLink(row.review.label, row.review.address, 'needs-link') : null),
  // A merged row says when, then the project's release rule: never released or live.
  el('div', { class: 'result-state' }, row.group === 'merged' ? [`Merged${row.mergedAt ? ` ${dateTime(row.mergedAt)}` : ''}.`, row.release].join(' ') : row.word),
  row.note ? el('div', { class: 'subtext' }, row.note) : null,
  row.review?.acceptedAt ? el('div', { class: 'subtext' }, `Accepted by you at ${clock(row.review.acceptedAt)}.`) : null,
  row.ladder ? releaseLadder(row.ladder) : null,
  row.asOf ? el('div', { class: 'needs-stale' }, mergeAsOf(row.asOf)) : null,
  row.evidence ? disclosure(`results/${row.campaignId}/${row.taskId}`, el('span', { class: 'evidence' }, row.evidence),
    el('p', { class: 'needs-detail' }, row.detail)) : null,
  row.signature ? el('div', { class: 'subtext task-signature' }, formatTaskSignatureBrief(row.signature)) : null,
  el('div', { class: 'subtext' }, campaignContext(row.campaignId)),
  row.canMarkRead ? el('div', { class: 'actions' }, button(readBusy.has(`${row.campaignId}/${row.taskId}`) ? 'Marking…' : 'Mark as read',
    () => void markRead(row), 'secondary small', readBusy.has(`${row.campaignId}/${row.taskId}`) || offline)) : null);

/** Mark one report as read: it leaves Reports to read for the project's History. */
const readBusy = new Set();
async function markRead(row) {
  const key = `${row.campaignId}/${row.taskId}`;
  readBusy.add(key); render();
  try { await post('/api/v2/results/read', { campaignId: row.campaignId, taskId: row.taskId, requestId: crypto.randomUUID() }); }
  catch (error) { notice(error.known ? error.message : 'Marking as read could not be confirmed. Try again.', error.known ? null : () => void markRead(row)); }
  finally { readBusy.delete(key); await poll(); }
}

/** The five release steps of one result, each Yes, No, In progress or Unknown, never one tick (AUTO_RELEASE.md section 1). */
const releaseLadder = (ladder) => el('div', { class: 'release-ladder' },
  el('ul', { 'aria-label': 'Release steps for this result' }, ...ladder.steps.map((step) => el('li', { class: `ladder-${step.answer}` }, step.text))),
  ladder.note ? el('div', { class: 'subtext' }, ladder.note) : null);

/**
 * Results (OWNER_WORKSPACE §4.9, slice S6): the project's finished steps grouped by state in the owner view's order,
 * with "Review pull request #N" for the oldest waiting review as the one primary action.
 */
const OWNER_GROUPS = ['review', 'changes', 'accepted', 'local-review', 'reports'];
function resultsScreen(project) {
  const results = state.owner?.results?.[String(project).toLowerCase()];
  if (!state.owner?.available) return unavailable();
  // The §7.1 empty copy, from the copy module through the owner view.
  if (!results?.groups.length) return el('section', { class: 'panel' }, empty(state.owner.noResults.title, state.owner.noResults.text));
  // Only what waits for the owner is open; merged, read and untraced results are history, folded below.
  const open = results.groups.filter((group) => OWNER_GROUPS.includes(group.key)), past = results.groups.filter((group) => !OWNER_GROUPS.includes(group.key));
  const waiting = open.reduce((n, group) => n + group.count, 0), history = past.reduce((n, group) => n + group.count, 0);
  const groupList = (group) => el('section', { class: 'needs-group', 'aria-labelledby': `results-group-${group.key}` },
    el('h3', { id: `results-group-${group.key}`, class: 'section-title' }, `${group.title} (${group.count})`),
    el('ul', { class: 'needs-list' }, ...group.rows.map(resultRow)));
  return el('section', { class: 'panel', 'aria-labelledby': 'results-title', 'data-focus-scope': `results/${project}` },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', { id: 'results-title' }, waiting ? `${plural(waiting, 'result')} for you` : 'Nothing here needs you')),
      results.primary?.route ? routeLink(results.primary.label, results.primary.route, 'button')
        : results.primary ? link(`${results.primary.label} ↗`, results.primary.url, 'button') : null),
    waiting ? null : el('p', { class: 'subtext' }, 'AIWorks checks and merges results itself. A result you can try, a decision or a new report appears here.'),
    ...open.map(groupList),
    history ? disclosure(`results/${project}/history`, `History (${history}): merged, read and untraced results`, el('div', {}, ...past.map(groupList))) : null,
    // Stop all releases is reachable from every project's Review (AUTO_RELEASE.md section 9).
    releaseStopLine(state.supervisor.settings?.releaseStop));
}

/**
 * What a step or a piece of work cost, in words. Unknown cost is "not reported", never $0.00: a run that reported no cost
 * is counted apart, and a run still in progress has no cost yet.
 */
function costText({ runs, reportedUsd, unreportedRuns, runningRuns }) {
  if (!runs && !runningRuns && !unreportedRuns && reportedUsd === null) return 'Nothing has run';
  const parts = [reportedUsd !== null ? `${usd(reportedUsd)} reported${unreportedRuns ? ` + ${plural(unreportedRuns, 'run')} not reported` : ''}`
    : unreportedRuns ? `not reported (${plural(unreportedRuns, 'run')})` : null, runningRuns ? `${plural(runningRuns, 'run')} still running` : null];
  return parts.filter(Boolean).join(' · ');
}
// A step's runs beside its cost: the finished ones and those still running, so "1 run still running" never sits beside 0 (aiworks#11 review 4 F18).
const stepRuns = ({ runs, runningRuns }) => runs + runningRuns;

/**
 * Model, tier and cost by unit (MODEL_ROUTING slice R6, build slice UI12), in words. Each unit stays apart: reported
 * dollars, then tokens per AI provider, then the runs whose cost is unknown. Nothing is added across units or providers,
 * and an unknown cost is counted in runs, never shown as $0.00.
 */
const tokenCount = (n) => n.toLocaleString('en-US');
const modelText = (used) => used ? `${provider(used.executor)} ${used.model ?? '(model not recorded)'}${used.tier ? ` (${used.tier})` : ''}` : null;
function modelsText(routing) {
  const parts = [routing?.implement ? `Model: ${modelText(routing.implement)}` : null, routing?.verify ? `checked by ${modelText(routing.verify)}` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
function unitCostText(cost) {
  if (!cost) return null;
  const parts = [cost.usd !== null ? `${usd(cost.usd)} reported (${plural(cost.usdRuns, 'run')})` : null,
    ...cost.tokens.map((t) => `${provider(t.executor)}: ${tokenCount(t.input)} input${t.cachedInInput && t.cacheRead ? ` (${tokenCount(t.cacheRead)} of them cached)` : ''}${
      !t.cachedInInput && t.cacheRead ? ` + ${tokenCount(t.cacheRead)} read from cache` : ''}${t.cacheCreation ? ` + ${tokenCount(t.cacheCreation)} written to cache` : ''} and ${tokenCount(t.output)} output tokens`),
    cost.unknownRuns ? `${plural(cost.unknownRuns, 'run')} with unknown cost` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
const movedUpText = (routing) => routing?.movedUp?.reason ?? null;

/**
 * The Cost headline and the lines under it (OWNER_WORKSPACE §4.10): finished work apart from work not finished yet, so the
 * first number answers "what did the finished work cost?" and never mixes in work still running (aiworks#11 review 5 G12).
 * Cancelled work has ended too, and is named when it ran. Unknown is never $0.00. `delivered` counts a work's steps with a result.
 */
function costSummary(all, delivered) {
  const ran = (c) => c.runsUsed > 0 || c.cost.reportedUsd !== null || c.cost.unreportedRuns > 0 || c.cost.runningRuns > 0;
  const group = (list) => ({ works: list.length, reportedUsd: list.some((c) => c.cost.reportedUsd !== null) ? list.reduce((n, c) => n + (c.cost.reportedUsd ?? 0), 0) : null,
    unreportedRuns: list.reduce((n, c) => n + c.cost.unreportedRuns, 0), runningRuns: list.reduce((n, c) => n + c.cost.runningRuns, 0), delivered: list.reduce((n, c) => n + delivered(c), 0) });
  const ended = (c) => ['finished', 'cancelled'].includes(c.control), mine = all.filter(ran);
  const done = group(mine.filter(ended)), open = group(mine.filter((c) => !ended(c)));
  const running = (n) => n ? `${plural(n, 'run')} still running; ${n === 1 ? 'its' : 'their'} cost is not known yet.` : null;
  if (!done.works) {
    return { headline: open.reportedUsd !== null ? `${usd(open.reportedUsd)} reported so far · this project's work is not finished yet` : 'No cost reported for this project yet',
      lines: [open.unreportedRuns ? `${plural(open.unreportedRuns, 'run')} did not report a cost, so the real total is ${open.reportedUsd !== null ? 'higher' : 'not known'}.` : null,
        running(open.runningRuns)].filter(Boolean) };
  }
  const name = mine.some((c) => c.control === 'cancelled') ? 'finished or cancelled work' : 'finished work';
  const headline = done.reportedUsd !== null ? `${usd(done.reportedUsd)} reported for ${name}${done.delivered ? ` · about ${usd(done.reportedUsd / done.delivered)} per step with a result` : ''}`
    : `No cost reported for ${name}`;
  const soFar = open.works ? [open.reportedUsd !== null ? `${usd(open.reportedUsd)} reported so far` : 'no cost reported yet',
    open.unreportedRuns ? `${plural(open.unreportedRuns, 'run')} did not report a cost` : null].filter(Boolean).join(' · ') : null;
  return { headline, lines: [done.unreportedRuns ? `${plural(done.unreportedRuns, 'run')} of the ${name} did not report a cost, so its real total is ${done.reportedUsd !== null ? 'higher' : 'not known'}.` : null,
    soFar ? `Work not finished yet, counted apart: ${soFar}.` : null, running(open.runningRuns)].filter(Boolean) };
}

/**
 * What this project spent, on Overview's budget line (OWNER_UI_V2 screen 3; formerly the Cost tab, OWNER_WORKSPACE
 * §4.10). First what finished work reported, with work not finished yet counted apart (costSummary) and the runs that
 * reported no cost counted apart; then "See the breakdown": per piece of work and per step, its runs, reported cost,
 * unreported runs, retries and checker rejections. No primary action.
 */
function spending(project) {
  // A project without GitHub: its goals' runs come apart from the campaigns (state.supervisor.local), built the same way;
  // a step has a result once it is done, and it has no step screen of its own.
  const local = Boolean(localProject(project));
  const total = !state.supervisor.available ? null : local ? state.supervisor.localCosts?.find((item) => item.project === project)
    : state.supervisor.costs?.find((item) => sameProject(item.repository, project));
  const all = local ? (state.supervisor.local ?? []).filter((c) => c.project === project) : projectCampaigns(project);
  if (!total) return [];
  // Nothing has run: the §7.1 copy, which the server takes from the state copy module.
  if (total.empty) return [el('p', {}, el('strong', {}, total.empty.title), ` ${total.empty.text}`)];
  const { headline, lines } = costSummary(all, local ? (c) => c.tasks.filter((task) => task.state === 'done').length : (c) => ownerCampaign(c)?.counts.delivered ?? 0);
  if (costRunsLine(total)) lines.push(costRunsLine(total));
  const stepName = (c, task) => local ? el('span', { class: 'task-name' }, task.outcome ?? task.title)
    : routeLink(task.outcome ?? task.title, { screen: 'step', project, work: c.id, step: task.id }, 'task-name');
  const work = (c) => el('section', { class: 'panel', 'data-focus-scope': `cost/${c.id}` },
    el('div', { class: 'panel-header' }, el('div', {}, el('h4', {}, local ? c.title : campaignTitle(c)),
      el('p', {}, `${plural(c.runsUsed, 'run')} · ${costText({ runs: c.runsUsed, ...c.cost })}`),
      unitCostText(c.costByUnit) ? el('p', { class: 'subtext' }, `Tokens and dollars, each counted on its own: ${unitCostText(c.costByUnit)}`) : null)),
    el('div', { class: 'steps' }, table(['Step', 'Runs', 'Cost', 'Retries', 'Checker rejections'], runOrder(c).map((task) => el('tr', { 'data-focus-scope': `cost/${c.id}/${task.id}` },
      el('td', { class: 'c-work' }, stepName(c, task),
        ...[modelsText(task.routing), movedUpText(task.routing)].filter(Boolean).map((text) => el('div', { class: 'subtext' }, text))),
      cell(String(stepRuns(task.cost))), cell(costText(task.cost), unitCostText(task.costByUnit) ? el('div', { class: 'subtext' }, unitCostText(task.costByUnit)) : null),
      cell(String(task.cost.retries)), cell(String(task.cost.checkerRejections)))))),
    costNotes(c).body);
  return [el('h3', {}, headline), ...lines.map((line) => el('p', {}, line)),
    disclosure(`cost/${project}`, 'See the breakdown', el('div', {}, ...all.map(work)))];
}

/*
 * Project settings (OWNER_UI_V2 WP5): protected areas, notes for the AI and optional project and monthly budgets, read
 * on their own (GET /api/v2/projects/<id>/settings) when opened and again at every refresh while shown. The form is kept
 * as typed across the refresh and a failed save, per address, and binds the version it was started from: a version saved
 * meanwhile is said, and the owner keeps their entries or takes the newest. A save shows the version it applied.
 */
const settingsViews = new Map();
let settingsBusy = false;
const settingsOff = () => settingsBusy || offline;
const settingsAddress = (project) => formatRoute({ screen: 'project-settings', project });
async function loadProjectSettings(project) {
  const entry = settingsViews.get(project) ?? {};
  settingsViews.set(project, entry);
  if (entry.loading) return;
  entry.loading = true;
  try {
    const response = await fetch(`/api/v2/projects/${encodeURIComponent(project)}/settings`, { signal: AbortSignal.timeout(6000) });
    const value = await response.json();
    if (response.ok) { entry.view = value; entry.error = null; entry.readAt = Date.now(); }
    else { entry.error = { status: response.status, message: value.error }; if ([404, 409].includes(response.status)) entry.view = null; }
  } catch { entry.error = { status: 0, message: 'These settings could not be read just now. The page tries again.' }; }
  finally {
    entry.loading = false;
    // Project settings and the project's Overview, whose budget panel reads the same view.
    const shown = current.route.screen === 'project-settings' || current.route.screen === 'project' && current.route.tab === 'overview';
    if (shown && current.route.project === project && state && !document.querySelector('dialog[open]')) render();
  }
}
/** The settings view of a project, read once, or again when `maxAge` ms passed since it was read (Overview's budget). */
const settingsEntry = (project, { maxAge = null } = {}) => {
  const entry = settingsViews.get(project);
  if (!entry || maxAge !== null && !entry.loading && Date.now() - (entry.readAt ?? 0) > maxAge) void loadProjectSettings(project);
  return settingsViews.get(project) ?? {};
};
const amountText = (value) => (value === null || value === undefined ? '' : String(value));
/** The form as the owner left it, or the saved settings with the version they came from. */
function settingsDraft(project, view) {
  const saved = drafts.get(settingsAddress(project), 'settings');
  if (saved) return saved;
  const { settings } = view;
  return { base: view.version, areas: settings.protectedAreas.join('\n'), notes: settings.notes, totalUsd: amountText(settings.budget.totalUsd),
    monthlyUsd: amountText(settings.budget.monthlyUsd), unknownRunCostUsd: amountText(settings.budget.unknownRunCostUsd), acceptance: settings.acceptance ?? 'automatic' };
}

/** One budget period in words: charged against the cap and what is left, or the reported spend without a cap. Unknown is never $0. */
function spendLine(label, period, price) {
  if (!period) return el('p', {}, `${label}: not known right now.`);
  const unpriced = period.unknownCostRuns + period.openRuns;
  if (period.capUsd === null) {
    return el('p', {}, `${label}: no limit. Reported ${usd(period.reportedUsd)}${period.unknownCostRuns ? `, plus ${plural(period.unknownCostRuns, 'run')} whose cost was not reported (not known)` : ''}.`);
  }
  return el('p', { 'data-state': period.exhausted ? 'exhausted' : 'available' }, `${label}: ${usd(period.chargedUsd)} counted of ${usd(period.capUsd)}; ${usd(Math.max(0, period.remainingUsd))} left.`,
    unpriced ? el('span', { class: 'subtext' }, ` Includes ${[period.unknownCostRuns ? `${plural(period.unknownCostRuns, 'run')} with no reported cost` : null,
      period.openRuns ? `${plural(period.openRuns, 'running step')}` : null].filter(Boolean).join(' and ')}, each counted at ${usd(price)}.`) : null);
}

/** The changing part: the applied version, what the budget has left, and a version saved since this form was started. */
function settingsParts(project) {
  const entry = settingsEntry(project), v = entry.view;
  if (!v) return [];
  const draft = settingsDraft(project, v), spend = v.spend;
  return [
    el('p', { class: 'subtext', role: 'status' }, v.version ? `Applied: version ${v.version}, saved ${clock(v.savedAt)}.` : 'Nothing saved yet: no protected areas, no notes and no budget.'),
    v.local ? null : el('p', {}, v.settings.acceptance === 'owner'
      ? 'Accepting results: you accept them yourself. A checked result is merged only after you accept exactly that version.'
      : 'Accepting results: automatic. A checked result is merged under the merge gate without waiting for you.'),
    entry.error || offline ? el('p', { class: 'needs-stale', role: 'status' }, `Shown as read at ${clock(entry.readAt)}. ${offline
      ? 'The page is disconnected; it reads these settings again when it reconnects.' : entry.error.message}`) : null,
    spend.exhausted ? el('p', { class: 'notice warning' }, `The ${spend.exhausted === 'month' ? 'monthly budget' : 'project budget'} cannot cover another step, so no new step starts here${spend.exhausted === 'month' ? ' until next month' : ''}. Running steps finish. Raise or remove the budget to continue.`) : null,
    spendLine('All time', spend.total, spend.unknownRunCostUsd),
    spendLine(`This month (since ${new Date(spend.monthStart).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}, UTC)`, spend.month, spend.unknownRunCostUsd),
    el('p', { class: 'subtext' }, `Counts the AI worker runs of this project’s work, and planning its goals${spend.total?.planning ? ` (planning so far: ${usd(spend.total.planning.reportedUsd)} reported, ${plural(spend.total.planning.unknownCostRuns, 'run')} with no reported cost, ${plural(spend.total.planning.openRuns, 'running read')})` : ''}. Planning that names no single project is not counted against any project${spend.unallocated && (spend.unallocated.unknownCostRuns || spend.unallocated.openRuns || spend.unallocated.reportedUsd) ? `: so far ${usd(spend.unallocated.reportedUsd)} reported, ${plural(spend.unallocated.unknownCostRuns, 'run')} with no reported cost and ${plural(spend.unallocated.openRuns, 'running read')}` : ''}.`),
    draft.base !== v.version ? el('div', { class: 'notice warning', 'data-focus-scope': `settings/${project}/stale` },
      el('p', {}, `Version ${v.version} was saved after you started editing version ${draft.base}. Saving now is refused, so nothing is overwritten by accident.`),
      button('Keep my entries', () => { drafts.set(settingsAddress(project), 'settings', { ...draft, base: v.version }); rebuildSettings(); }, 'secondary small', settingsOff()),
      ' ', button('Show the newest version', () => { drafts.delete(settingsAddress(project), 'settings'); rebuildSettings(); }, 'secondary small', settingsOff())) : null,
  ].filter(Boolean);
}
const rebuildSettings = () => { $('#content').replaceChildren(); render(); };

/**
 * Overview's budget (OWNER_UI_V2 screen 3, WP5): the project's all-time and monthly budget with what is counted and left,
 * from the same view Project settings reads, read again every 30 seconds. Unknown cost is never $0, and no budget set
 * says so. It is changed only in Project settings.
 */
function budgetPanel(project) {
  const entry = settingsEntry(project, { maxAge: 30_000 }), v = entry.view;
  const where = routeLink('Project settings', { screen: 'project-settings', project });
  let body;
  if (!v) {
    body = [entry.error?.status === 409 ? el('p', {}, 'No project budget yet: confirm this project’s rules first, then set one in ', where, '.')
      : entry.error ? el('p', { class: 'needs-stale', role: 'status' }, `Not known right now. ${entry.error.message}`)
        : el('p', { class: 'subtext' }, 'Reading this project’s budget…')];
  } else {
    const spend = v.spend, set = spend.total?.capUsd != null || spend.month?.capUsd != null;
    body = [entry.error || offline ? el('p', { class: 'needs-stale', role: 'status' }, `Shown as read at ${clock(entry.readAt)}.`) : null,
      spend.exhausted ? el('p', { class: 'notice warning' }, `The ${spend.exhausted === 'month' ? 'monthly budget' : 'project budget'} cannot cover another step, so no new step or planning read starts here${spend.exhausted === 'month' ? ' until next month' : ''}. Running steps finish.`) : null,
      spendLine('Project budget, all time', spend.total, spend.unknownRunCostUsd),
      spendLine('This month (UTC)', spend.month, spend.unknownRunCostUsd),
      el('p', { class: 'subtext' }, set ? 'Counts this project’s AI worker runs and the planning of its goals. Change it in ' : 'No budget is set, so no dollar limit stops a step here; each goal still keeps its own limits. Set one in ', where, '.')];
  }
  // What was spent sits on the budget line; what AIWorks used across all projects is in Settings › Usage.
  body.push(...spending(project), el('p', { class: 'subtext' }, 'Everything AIWorks used on this computer, in all projects: ',
    routeLink('Settings › Usage', { screen: 'settings', section: 'usage' }), '.'));
  return panel('Budget', 'What this project has counted, spent and has left.', el('div', { class: 'panel-body', 'data-focus-scope': `overview/${project}/budget` }, ...body.filter(Boolean)));
}

/**
 * Running work and its steps, under Details on Overview (OWNER_UI_V2 section 2: technical detail opens in place; formerly
 * the Work tab, OWNER_WORKSPACE §4.7). Each step opens its own screen. Null when nothing runs or waits here.
 */
function workDetails(project) {
  if (!state.supervisor.available) return null;
  let body = [];
  if (localProject(project)) body = localWork(project).length ? localWorkScreen(project) : [];
  else {
    const cards = campaignLayout().cards.filter((c) => sameProject(c.repository, project));
    if (cards.length) body = [...cards.map((c) => workPanel(project, c)), cards.some((c) => c.agents.length) ? verdictExplanation() : null,
      cards.some((c) => !['finished', 'cancelled'].includes(c.control)) ? providerNote() : null].filter(Boolean);
  }
  if (!body.length) return null;
  const agents = projectCampaigns(project).reduce((n, c) => n + c.agents.length, 0);
  return el('section', { class: 'panel', 'aria-labelledby': `work-title-${project}` },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', { id: `work-title-${project}` }, 'Running work'),
      // Local work lists its steps and their state only; its runs and checks are not shown per step yet.
      el('p', {}, localProject(project) ? 'Each approved goal and the state of its steps are under Details.'
        : agents ? `${plural(agents, 'AI worker')} working now. Each step, its runs and its checks are under Details.` : 'Steps, their runs and their checks are under Details.'))),
    el('div', { class: 'panel-body' }, disclosure(`overview/${project}/work`, 'Details', el('div', {}, ...body))));
}
const settingsLink = (project) => el('p', { class: 'subtext' }, routeLink('Project settings', { screen: 'project-settings', project }),
  ': how work runs, what AIWorks never does, protected areas, notes for the AI and budget.');

function projectSettingsScreen(project) {
  const entry = settingsEntry(project), v = entry.view;
  if (!v) {
    if (!entry.error) return [empty('Reading this project’s settings…', '')];
    return [empty(entry.error.status === 404 ? 'This project is not on this computer' : entry.error.status === 409 ? 'No settings yet' : 'Not known right now', ` ${entry.error.message}`),
      routeLink('Back to the overview', { screen: 'project', project, tab: 'overview' }, 'button secondary')];
  }
  const address = settingsAddress(project), draft = settingsDraft(project, v), limits = v.limits;
  const areas = el('textarea', { id: 'settings-areas', rows: 4, 'aria-describedby': 'settings-areas-help', oninput: () => save() });
  areas.value = draft.areas;
  const notes = el('textarea', { id: 'settings-notes', rows: 4, maxlength: limits.notes, 'aria-describedby': 'settings-notes-help', oninput: () => save() });
  notes.value = draft.notes;
  const amount = (id, value, { min, max }) => {
    const input = el('input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', 'data-amount': true, 'data-min': min, 'data-max': max, oninput: () => save() });
    input.value = value;
    return input;
  };
  const total = amount('settings-total', draft.totalUsd, limits.budget), monthly = amount('settings-monthly', draft.monthlyUsd, limits.budget);
  const price = amount('settings-price', draft.unknownRunCostUsd, limits.unknownRun);
  // Who accepts results (AW-015): automatic, or the owner, in which case nothing merges before they accept that version.
  const modes = [['automatic', 'Automatic', 'A result that passed the independent check is merged under the merge gate without waiting for you.'],
    ['owner', 'I accept results myself', 'A checked result is merged only after you accept exactly that version. It waits in Needs you with Accept and Request changes.']];
  const choices = modes.map(([value]) => el('input', { type: 'radio', name: `settings-acceptance-${project}`, value, checked: (draft.acceptance ?? 'automatic') === value, onchange: () => save() }));
  const acceptance = () => choices.find((input) => input.checked)?.value ?? draft.acceptance ?? 'automatic';
  const fields = () => ({ areas: areas.value, notes: notes.value, totalUsd: total.value, monthlyUsd: monthly.value, unknownRunCostUsd: price.value, acceptance: acceptance() });
  function save() { drafts.set(address, 'settings', { ...settingsDraft(project, settingsEntry(project).view ?? v), ...fields() }); }
  const money = (text) => (text.trim() ? Number(text.trim()) : null);
  const form = el('form', { novalidate: true, class: 'panel-body start-form', 'data-settings-form': project, 'data-focus-scope': `settings/${project}/form`,
    onsubmit: (event) => {
      event.preventDefault(); save();
      // The price of a run with no reported cost is required with either budget: unknown cost is never counted as zero.
      price.required = Boolean(total.value.trim() || monthly.value.trim());
      if (settingsOff() || !validateForm(form)) return;
      const lines = areas.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      void saveSettings(project, { version: settingsDraft(project, v).base, protectedAreas: lines, notes: notes.value,
        budget: { totalUsd: money(total.value), monthlyUsd: money(monthly.value), unknownRunCostUsd: money(price.value) }, acceptance: acceptance() });
    } },
    el('label', { class: 'field' }, el('strong', {}, 'Protected areas'), areas,
      el('span', { id: 'settings-areas-help', class: 'subtext' }, `Folders or files AIWorks must never change, one per line, such as docs/legal or config/production.json. Up to ${limits.protected}. A plan that changes one is refused; a step that changes one stops for you.`)),
    el('label', { class: 'field' }, el('strong', {}, 'Notes for the AI'), notes,
      el('span', { id: 'settings-notes-help', class: 'subtext' }, `Given to every step as guidance; they never add permission. No secrets; up to ${limits.notes.toLocaleString('en-US')} characters.`)),
    el('fieldset', {}, el('legend', {}, 'Budget (optional)'),
      el('p', { class: 'subtext' }, 'Empty means no limit. A step starts only when the budget left covers it.'),
      el('label', { class: 'field' }, el('strong', {}, 'Project budget, all time ($)'), total),
      el('label', { class: 'field' }, el('strong', {}, 'Monthly budget ($)'), monthly),
      el('label', { class: 'field' }, el('strong', {}, 'Count a run with no reported cost as ($)'), price,
        el('span', { class: 'subtext' }, 'Needed with a budget: some AI workers do not report what a run cost, and that is never counted as $0.'))),
    // A project without GitHub is accepted by Apply, so it has no merge to wait for.
    v.local ? null : el('fieldset', {}, el('legend', {}, 'Accepting results'),
      ...modes.map(([, label, help], i) => el('div', {}, el('label', { class: 'choice' }, choices[i], ` ${label}`), el('p', { class: 'subtext' }, help))),
      el('p', { class: 'subtext' }, 'Switching to “I accept results myself” holds every checked result that is not merged yet until you accept it. Switching back lets the merge gate go on.')),
    el('p', { class: 'subtext' }, 'Saving applies to the next step AIWorks starts here. Work already approved keeps its own limits, and these settings never widen what it may change.'),
    el('button', { class: 'button', type: 'submit', disabled: settingsOff() }, 'Save settings'));
  return [howWorkRuns(project), el('section', { class: 'panel', 'aria-labelledby': 'settings-title' },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', { id: 'settings-title' }, 'Standing rules and budget'),
      el('p', {}, 'They apply to every goal in this project.'))),
    el('div', { class: 'panel-body', id: 'settings-dynamic' }, ...settingsParts(project)), form)];
}

/*
 * How work runs (OWNER_UI_V2 screen 9 and section 4): what AIWorks does after Approve and start, the limits each goal of
 * this project was approved with, and what AIWorks never does. Read-only: it explains the existing authority and offers
 * no control of its own. Limits come from the goals' approved declarations (supervisor.mjs `limits`), never a default.
 */
const LIMIT_WORDS = { slots: (n) => `${plural(n, 'step')} at a time`, maxWorkerRuns: (n) => `at most ${plural(n, 'AI worker run')}`,
  maxRepairRounds: (n) => `at most ${plural(n, 'repair round')} per step`, maxRetriesPerTask: (n) => `at most ${plural(n, 'retry', 'retries')} per step`,
  maxCostUsd: (n) => `at most ${usd(n)} reported`, unknownRunCostUsd: (n) => `a run with no reported cost counts as ${usd(n)}` };
const limitsText = (limits) => Object.entries(limits ?? {}).filter(([key, value]) => value !== null && LIMIT_WORDS[key]).map(([key, value]) => LIMIT_WORDS[key](value)).join(' · ');
const NEVER = [
  'Changes a protected area, or anything outside what the approved plan allows. Such a result is held and never published, and there is no “allow once”.',
  'Widens a goal’s files, protected areas, limits or budget by itself or from your answer to a decision. That is a new plan version for you to compare and approve.',
  'Merges a result that was not independently checked at its exact version, or outside the merge gate you set.',
  'Releases or deploys anything from this page: release is not built here, and needs its own grant for this project.',
  'Reads your secret files or shows secret values. Notes and facts that look like a password or key are refused.',
  'Uses another AI provider to get around a permission an AI worker was refused, or buys or adds an AI account.',
  'Uses GitHub Actions or paid GitHub features: builds and tests run on this computer.',
  'Opens this dashboard to other computers: it answers only on this computer.',
];
function howWorkRuns(project) {
  const goals = projectCampaigns(project).filter((c) => !['finished', 'cancelled'].includes(c.control));
  return el('section', { class: 'panel', 'aria-labelledby': 'how-title', 'data-focus-scope': `settings/${project}/how` },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', { id: 'how-title' }, 'How work runs'),
      el('p', {}, 'The same for every goal in this project.'))),
    el('div', { class: 'panel-body' },
      el('p', {}, 'After you approve a plan, AIWorks splits it into steps and gives each to an AI worker in its own copy of the project. A different AI worker then checks exactly that version on its own. AIWorks repairs what the check finds, within the goal’s repair rounds, and continues after crashes, restarts and usage limits.'),
      el('p', {}, 'When a step needs you, it stops and asks with a decision on that step. Your answer guides the next try under the same plan. Anything wider is a new plan version, shown with its differences, that you approve before it runs.'),
      el('p', {}, localProject(project) ? 'Release: review only. A checked result changes your folder only when you press Apply on it, and Undo apply puts it back; nothing is published or merged.'
        : 'Release: review only. A checked result is published for your review; merging follows the merge gate you set.'),
      el('h3', {}, 'Limits of the goals here'),
      goals.length ? el('ul', { class: 'settings-links' }, ...goals.map((c) => el('li', {}, el('strong', {}, campaignTitle(c, { inProject: true })),
        el('div', { class: 'subtext' }, `${limitsText(c.limits) || 'No limits were set for this goal'}. Approved version ${c.authorizationVersion}.`))))
        : el('p', { class: 'subtext' }, localProject(project) && localWork(project).length ? 'Each goal here keeps the limits its plan showed on Review when you approved it.'
          : 'No goal is running here, so no goal limits apply yet. Each plan states its limits on Review before you approve it.'),
      el('h3', {}, 'AIWorks never'),
      el('ul', {}, ...NEVER.map((line) => el('li', {}, line)))));
}

/** The 5-second refresh keeps the form as typed: only the applied version, the spend and the button change. */
function refreshProjectSettings(content, project) {
  const form = content.querySelector('form[data-settings-form]');
  if (!form || form.dataset.settingsForm !== project || !settingsViews.get(project)?.view) return false;
  patch(content.querySelector('#settings-dynamic'), settingsParts(project));
  form.querySelector('button[type="submit"]').disabled = settingsOff();
  return true;
}

/** Save the settings. A retry reuses its request id, so the server saves them once; a refusal keeps every entry. */
async function saveSettings(project, body) {
  settingsBusy = true; render();
  const requestId = crypto.randomUUID(), address = settingsAddress(project);
  const attempt = async () => {
    try {
      const result = await post('/api/v2/projects/settings', { requestId, project, ...body });
      const entry = settingsViews.get(project) ?? {};
      Object.assign(entry, { view: result.view, error: null, readAt: Date.now() });
      settingsViews.set(project, entry);
      drafts.delete(address, 'settings');
      notice(result.message, null, null, address);
      if (current.address === address) rebuildSettings();
    } catch (error) {
      notice(error.known ? error.message : 'Saving could not be confirmed. Retry: the same request is never saved twice.', error.known ? null : attempt, error.known ? error.detail : null, address);
      if (error.code === 'SETTINGS_CHANGED') void loadProjectSettings(project);
    }
  };
  try { await attempt(); } finally { settingsBusy = false; await poll(); }
}

/**
 * Settings -> Alerts (OWNER_UI_V2 WP6): the owner's alert rules and quiet hours, the transport's state as the operator set
 * it, and what the rehearsal transport recorded. Read on their own (GET /api/v2/settings/alerts) when opened and at every
 * refresh while shown; the form is kept as typed and binds the version it was started from. An alert never answers a
 * decision: its buttons open this dashboard, where Needs you asks with the same checks as always.
 */
const alertsEntry = { view: null, error: null, loading: false, readAt: null };
let alertsBusy = false;
const alertsOff = () => alertsBusy || offline;
const ALERTS_ADDRESS = '#/settings/alerts';
const ALERT_CLASS_WORDS = { B2: ['Action required', 'Something only you can do, such as signing in again.'], B3: ['Decision required', 'A step waits for your choice.'],
  B4: ['External wait', 'A provider or service is unavailable; AIWorks rechecks by itself.'], B5: ['Incident', 'Something went wrong that AIWorks will not retry on its own.'] };
const TRANSPORT_WORDS = {
  unconfigured: 'Delivery unavailable: no alert transport is set up on this computer. Alerts wait in Needs you; nothing is sent.',
  rehearsal: 'Rehearsal only: alerts are recorded on this computer as they would be sent. Nothing leaves this computer, and nothing is reported as delivered.',
  unavailable: 'Delivery unavailable: this version of AIWorks has no adapter for the transport in the configuration file, so nothing is sent.',
  incomplete: 'Delivery unavailable: Telegram needs both a credential reference and a recipient reference, each in a secret store AIWorks can read. Nothing is sent.',
  ready: 'Telegram is set up, but sending is switched off in the configuration file. Nothing is sent.',
  sending: 'Alerts are sent to Telegram. A reply there does nothing: answer in Needs you on this computer. An alert whose arrival is unknown is not sent again.',
  invalid: 'Delivery unavailable: the transport setting in the configuration file is not valid (it must name secret store references, never a credential). Nothing is sent.' };
const DECISION_WORDS = { send: 'would be sent now', hold: 'would wait until quiet hours end', mute: 'would not be sent: its kind is off' };
async function loadAlerts() {
  if (alertsEntry.loading) return;
  alertsEntry.loading = true;
  try {
    const response = await fetch('/api/v2/settings/alerts', { signal: AbortSignal.timeout(6000) });
    const value = await response.json();
    if (response.ok) Object.assign(alertsEntry, { view: value, error: null, readAt: Date.now() });
    else alertsEntry.error = { status: response.status, message: value.error };
  } catch { alertsEntry.error = { status: 0, message: 'The alert settings could not be read just now. The page tries again.' }; }
  finally {
    alertsEntry.loading = false;
    if (current.route.screen === 'settings' && current.route.section === 'alerts' && state && !document.querySelector('dialog[open]')) render();
  }
}
/** The form as the owner left it, or the saved rules with the version they came from. */
function alertsDraft(v) {
  const saved = drafts.get(ALERTS_ADDRESS, 'alerts');
  if (saved) return saved;
  const q = v.rules.quietHours;
  return { base: v.version, classes: { ...v.rules.classes }, reminders: v.rules.reminders, quiet: Boolean(q), start: q?.start ?? '22:00', end: q?.end ?? '07:00',
    timeZone: q?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC', incidents: q?.incidents ?? false };
}

/** The changing part: transport state, applied version, outbox counts, what was rehearsed, and a version saved meanwhile. */
function alertsParts() {
  const v = alertsEntry.view;
  if (!v) return [];
  const draft = alertsDraft(v), out = v.outbox, d = v.delivery, sample = v.sample.alert;
  return [
    el('p', { class: d.transport === 'rehearsal' || d.sending ? 'notice' : 'notice warning', role: 'status' },
      TRANSPORT_WORDS[d.sending ? 'sending' : d.transport] ?? TRANSPORT_WORDS.unconfigured),
    d.recording ? null : el('p', { class: 'subtext' }, 'Owner alerts are not recorded on this computer yet: the owner-intervention setting is off. What needs you still shows in Needs you.'),
    el('p', { class: 'subtext', role: 'status' }, v.version ? `Applied: version ${v.version}, saved ${clock(v.savedAt)}.${v.quietNow ? ' Quiet hours now.' : ''}` : 'Nothing saved yet: the default rules apply.'),
    alertsEntry.error || offline ? el('p', { class: 'needs-stale', role: 'status' }, `Shown as read at ${clock(alertsEntry.readAt)}. ${offline
      ? 'The page is disconnected; it reads these settings again when it reconnects.' : alertsEntry.error.message}`) : null,
    el('p', {}, `Waiting: ${out.pending + (out.sending ?? 0)} · Rehearsed: ${out.rehearsed} · Delivered: ${out.delivered ?? 0} · Arrival unknown: ${out.unknown ?? 0} · Not sent (gave up): ${out.failed} · Off by your rules: ${out.muted} · No longer needed: ${out.obsolete ?? 0}`),
    disclosure('alerts/sample', 'What an alert says (fictional example)', el('div', { class: 'panel-body' },
      el('strong', {}, sample.title), ...sample.lines.map((text) => el('p', { class: 'subtext' }, text)),
      el('p', { class: 'subtext' }, `Buttons: ${sample.buttons.map((b) => b.label).join(', ')}. They open this dashboard on this computer; an answer is given only here.`),
      el('p', { class: 'subtext' }, `With the rules applied now, this alert ${DECISION_WORDS[v.sample.now]}.`))),
    v.rehearsals.length ? disclosure('alerts/rehearsals', `Last ${plural(v.rehearsals.length, 'rehearsed alert')}`, el('ul', { class: 'settings-links' },
      ...v.rehearsals.map((r) => el('li', {}, el('strong', {}, r.alert.title), el('div', { class: 'subtext' }, `${clock(r.at)} · recorded on this computer, not sent`))))) : null,
    draft.base !== v.version ? el('div', { class: 'notice warning', 'data-focus-scope': 'alerts/stale' },
      el('p', {}, `Version ${v.version} was saved after you started editing version ${draft.base}. Saving now is refused, so nothing is overwritten by accident.`),
      button('Keep my entries', () => { drafts.set(ALERTS_ADDRESS, 'alerts', { ...draft, base: v.version }); rebuildSettings(); }, 'secondary small', alertsOff()),
      ' ', button('Show the newest version', () => { drafts.delete(ALERTS_ADDRESS, 'alerts'); rebuildSettings(); }, 'secondary small', alertsOff())) : null,
  ].filter(Boolean);
}

function alertsScreen() {
  if (!alertsEntry.view && !alertsEntry.loading && !alertsEntry.error) void loadAlerts();
  const v = alertsEntry.view;
  if (!v) return [alertsEntry.error ? empty('Not known right now', ` ${alertsEntry.error.message}`) : empty('Reading the alert settings…', '')];
  const draft = alertsDraft(v);
  const check = (id, checked) => el('input', { id, type: 'checkbox', checked, onchange: () => save() });
  const classes = Object.fromEntries(v.classes.map((cls) => [cls, check(`alerts-${cls}`, draft.classes[cls] === true)]));
  const reminders = check('alerts-reminders', draft.reminders), quiet = check('alerts-quiet', draft.quiet), incidents = check('alerts-incidents', draft.incidents);
  const text = (id, value, type = 'text') => { const input = el('input', { id, type, autocomplete: 'off', oninput: () => save() }); input.value = value; return input; };
  const start = text('alerts-start', draft.start, 'time'), end = text('alerts-end', draft.end, 'time'), zone = text('alerts-zone', draft.timeZone);
  const fields = () => ({ classes: Object.fromEntries(v.classes.map((cls) => [cls, classes[cls].checked])), reminders: reminders.checked, quiet: quiet.checked,
    start: start.value, end: end.value, timeZone: zone.value.trim(), incidents: incidents.checked });
  function save() { drafts.set(ALERTS_ADDRESS, 'alerts', { ...alertsDraft(alertsEntry.view ?? v), ...fields() }); }
  const form = el('form', { novalidate: true, class: 'panel-body start-form', 'data-alerts-form': true, 'data-focus-scope': 'alerts/form',
    onsubmit: (event) => {
      event.preventDefault(); save();
      for (const input of [start, end, zone]) input.required = quiet.checked;
      if (alertsOff() || !validateForm(form)) return;
      const f = fields();
      void saveAlertRules({ version: alertsDraft(v).base, rules: { classes: f.classes, reminders: f.reminders,
        quietHours: f.quiet ? { start: f.start, end: f.end, timeZone: f.timeZone, incidents: f.incidents } : null } });
    } },
    el('fieldset', {}, el('legend', {}, 'Alert me about'),
      ...v.classes.map((cls) => [el('label', { class: 'choice' }, classes[cls], ALERT_CLASS_WORDS[cls][0]), el('p', { class: 'subtext' }, ALERT_CLASS_WORDS[cls][1])]),
      el('label', { class: 'choice' }, reminders, 'Reminders'), el('p', { class: 'subtext' }, 'One after an hour, then at most one a day, while it still waits for you.')),
    el('fieldset', {}, el('legend', {}, 'Quiet hours'),
      el('label', { class: 'choice' }, quiet, 'Hold alerts during quiet hours'),
      el('label', { class: 'field' }, el('strong', {}, 'From'), start),
      el('label', { class: 'field' }, el('strong', {}, 'Until'), end),
      el('label', { class: 'field' }, el('strong', {}, 'Time zone'), zone, el('span', { class: 'subtext' }, 'Such as Europe/Berlin or UTC.')),
      el('label', { class: 'choice' }, incidents, 'Incidents may still alert me during quiet hours')),
    el('p', { class: 'subtext' }, 'An alert held by quiet hours is sent when they end. An alert whose kind is off is not sent later. Needs you always shows everything.'),
    el('button', { class: 'button', type: 'submit', disabled: alertsOff() }, 'Save alert rules'));
  return [el('section', { class: 'panel', 'aria-labelledby': 'alerts-title' },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', { id: 'alerts-title' }, 'Alerts'), el('p', {}, 'When AIWorks tells you that something needs you.'))),
    el('div', { class: 'panel-body', id: 'alerts-dynamic' }, ...alertsParts()), form)];
}

/** The 5-second refresh keeps the form as typed: only the state lines and the button change. The poll reads the settings again. */
function refreshAlerts(content) {
  const form = content.querySelector('form[data-alerts-form]');
  if (!form || !alertsEntry.view) return false;
  patch(content.querySelector('#alerts-dynamic'), alertsParts());
  form.querySelector('button[type="submit"]').disabled = alertsOff();
  return true;
}

/** Save the rules. A retry reuses its request id, so the server saves them once; a refusal keeps every entry. */
async function saveAlertRules(body) {
  alertsBusy = true; render();
  const requestId = crypto.randomUUID();
  const attempt = async () => {
    try {
      const result = await post('/api/v2/settings/alerts', { requestId, ...body });
      Object.assign(alertsEntry, { view: result.view, error: null, readAt: Date.now() });
      drafts.delete(ALERTS_ADDRESS, 'alerts');
      notice(result.message, null, null, ALERTS_ADDRESS);
      if (current.address === ALERTS_ADDRESS) rebuildSettings();
    } catch (error) {
      notice(error.known ? error.message : 'Saving could not be confirmed. Retry: the same request is never saved twice.', error.known ? null : attempt, error.known ? error.detail : null, ALERTS_ADDRESS);
      if (error.code === 'ALERTS_CHANGED') void loadAlerts();
    }
  };
  try { await attempt(); } finally { alertsBusy = false; await poll(); }
}

/*
 * Knowledge (OWNER_UI_V2 WP8): the product facts the owner confirmed, and what AIWorks suggests from this project's own
 * README and plans, each with where it came from. Read on their own (GET /api/v2/projects/<id>/knowledge) when opened
 * and at every refresh while shown, except while the owner types. A suggestion is never shown as true: it says "Not
 * confirmed" until the owner confirms it, edits it into their own words or sets it aside. What is typed is kept per
 * address as a draft, so a refresh, a reload or a refused save keeps it.
 */
const knowledgeViews = new Map();
let knowledgeBusy = false;
const knowledgeOff = () => knowledgeBusy || offline;
const knowledgeAddress = (project) => formatRoute({ screen: 'knowledge', project });
async function loadKnowledge(project) {
  const entry = knowledgeViews.get(project) ?? {};
  knowledgeViews.set(project, entry);
  if (entry.loading) return;
  entry.loading = true;
  try {
    const response = await fetch(`/api/v2/projects/${encodeURIComponent(project)}/knowledge`, { signal: AbortSignal.timeout(6000) });
    const value = await response.json();
    if (response.ok) { entry.view = value; entry.error = null; entry.readAt = Date.now(); }
    else { entry.error = { status: response.status, message: value.error }; if (response.status === 404) entry.view = null; }
  } catch { entry.error = { status: 0, message: 'What AIWorks knows about this project could not be read just now. The page tries again.' }; }
  finally {
    entry.loading = false;
    if (current.route.screen === 'knowledge' && current.route.project === project && state && !document.querySelector('dialog[open]')) render();
  }
}
const knowledgeEntry = (project) => { if (!knowledgeViews.has(project)) void loadKnowledge(project); return knowledgeViews.get(project) ?? {}; };
const SOURCE_WORDS = { owner: ['done', 'Confirmed by you'], material: ['review', 'Found in material'], ai: ['planned', 'Suggested by AI'] };
/** Where a suggestion, or the fact made from one, came from. */
function originText(source, origin) {
  if (source === 'material') return `${origin.path} · saved project material`;
  return `${origin.goal ? `the plan for “${origin.goal}”` : 'a plan'}, version ${origin.version}`;
}
const KNOWLEDGE_ACTS = { written: 'Written by you', confirmed: 'Confirmed by you', edited: 'Edited by you', 'set-aside': 'Set aside by you', restored: 'Brought back by you' };
// Which fact or suggestion is open for editing on this page, by its id or key.
let knowledgeEditing = null;

/** An edit form for one fact or suggestion: its words, kept as a draft until saved. */
function factEditor(project, id, text, onSave) {
  const address = knowledgeAddress(project), key = `fact:${id}`;
  const area = el('textarea', { id: `fact-${id}`, rows: 2, maxlength: 400, required: true, oninput: () => drafts.set(address, key, area.value) });
  area.value = drafts.get(address, key) ?? text;
  const form = el('form', { novalidate: true, class: 'start-form', 'data-focus-scope': `knowledge/${id}/edit`,
    onsubmit: (event) => { event.preventDefault(); if (knowledgeOff() || !validateForm(form)) return; void onSave(area.value, () => drafts.delete(address, key)); } },
    el('label', { class: 'field' }, el('strong', {}, 'In your words'), area, el('span', { class: 'subtext' }, 'One line, up to 400 characters. No secrets.')),
    el('button', { class: 'button small', type: 'submit', disabled: knowledgeOff() }, 'Save as confirmed'), ' ',
    button('Cancel', () => { knowledgeEditing = null; drafts.delete(address, key); rebuildKnowledge(); }, 'secondary small'));
  return form;
}

function factItem(project, fact) {
  const [tone, words] = SOURCE_WORDS.owner, retired = fact.state === 'retired';
  const came = fact.basis ? `First ${fact.basis.source === 'material' ? 'found in' : 'suggested by AI from'} ${originText(fact.basis.source, fact.basis.origin)}.${fact.edited ? ' Edited in your words since.' : ''}` : 'Written by you.';
  const act = (action, text) => saveFact(project, { action, fact: fact.id, version: fact.version, ...(text !== undefined ? { text } : {}) });
  return el('li', { 'data-focus-scope': `knowledge/${fact.id}` },
    el('p', {}, el('strong', {}, fact.text), ' ', retired ? badge('planned', 'Set aside') : badge(tone, words)),
    el('div', { class: 'subtext' }, `${came} Version ${fact.version}, ${clock(fact.updatedAt)}.`),
    knowledgeEditing === fact.id ? factEditor(project, fact.id, fact.text, (text, done) => act('edit', text).then((ok) => ok && done()))
      : el('div', {}, retired ? button('Bring back', () => void act('edit', fact.text), 'secondary small', knowledgeOff())
        : [button('Edit', () => { knowledgeEditing = fact.id; rebuildKnowledge(); }, 'secondary small', knowledgeOff()), ' ',
          button('Set aside', () => void act('retire'), 'secondary small', knowledgeOff())]),
    disclosure(`knowledge/${project}/${fact.id}`, `History (${plural(fact.history.length, 'version')})`, el('ol', { class: 'settings-links' },
      ...fact.history.map((entry) => el('li', {}, el('strong', {}, `${KNOWLEDGE_ACTS[entry.act] ?? 'Changed'}, ${dateTime(entry.at)}`),
        el('div', { class: 'subtext' }, entry.text))))));
}

function suggestionItem(project, item) {
  const [tone, words] = SOURCE_WORDS[item.source] ?? ['unknown', 'Not known'];
  const act = (action, text) => saveFact(project, { action, suggestion: item.key, version: 0, ...(text !== undefined ? { text } : {}) });
  return el('li', { 'data-focus-scope': `knowledge/${item.key}` },
    el('p', {}, el('span', {}, item.text), ' ', badge(tone, words)),
    el('div', { class: 'subtext' }, `From ${originText(item.source, item.origin)}. Not confirmed: AIWorks does not treat it as true.`),
    knowledgeEditing === item.key ? factEditor(project, item.key, item.text, (text, done) => act('edit', text).then((ok) => ok && done()))
      : el('div', {}, button('Confirm', () => void act('confirm'), 'secondary small', knowledgeOff()), ' ',
        button('Edit and confirm', () => { knowledgeEditing = item.key; rebuildKnowledge(); }, 'secondary small', knowledgeOff()), ' ',
        button('Not right', () => void act('retire'), 'secondary small', knowledgeOff())));
}

function knowledgeScreen(project) {
  const entry = knowledgeEntry(project), v = entry.view;
  if (!v) {
    if (!entry.error) return [empty('Reading what AIWorks knows about this project…', '')];
    return [empty(entry.error.status === 404 ? 'This project is not on this computer' : 'Not known right now', ` ${entry.error.message}`),
      routeLink('Back to the overview', { screen: 'project', project, tab: 'overview' }, 'button secondary')];
  }
  const address = knowledgeAddress(project), active = v.facts.filter((fact) => fact.state !== 'retired'), retired = v.facts.filter((fact) => fact.state === 'retired');
  const text = el('textarea', { id: 'fact-new', rows: 2, maxlength: v.limits.text, required: true, 'aria-describedby': 'fact-new-help', oninput: () => drafts.set(address, 'add', text.value) });
  text.value = drafts.get(address, 'add') ?? '';
  const form = el('form', { novalidate: true, class: 'panel-body start-form', 'data-focus-scope': `knowledge/${project}/add`,
    onsubmit: (event) => {
      event.preventDefault();
      if (knowledgeOff() || !validateForm(form)) return;
      void saveFact(project, { action: 'add', version: 0, text: text.value }).then((ok) => { if (ok) { drafts.delete(address, 'add'); rebuildKnowledge(); } });
    } },
    el('label', { class: 'field' }, el('strong', {}, 'Add a fact'), text,
      el('span', { id: 'fact-new-help', class: 'subtext' }, `Something true about this product, such as who it is for. One line, up to ${v.limits.text} characters. No secrets.`)),
    el('button', { class: 'button', type: 'submit', disabled: knowledgeOff() }, 'Save fact'));
  const stale = entry.error || offline ? el('p', { class: 'needs-stale', role: 'status' }, `Shown as read at ${clock(entry.readAt)}. ${offline
    ? 'The page is disconnected; it reads this again when it reconnects.' : entry.error.message}`) : null;
  return [el('section', { class: 'panel', 'data-knowledge': project, 'aria-labelledby': 'knowledge-title' },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', { id: 'knowledge-title' }, 'What AIWorks knows about this product'),
      el('p', {}, 'Each fact says whether you confirmed it, it was found in the project’s material, or AI suggested it. Facts are for you: they never give AIWorks permission to change anything.'))),
    el('div', { class: 'panel-body' }, stale,
      el('h3', {}, `Confirmed by you (${active.length})`),
      active.length ? el('ul', { class: 'settings-links' }, ...active.map((fact) => factItem(project, fact))) : el('p', { class: 'subtext' }, 'Nothing confirmed yet. Confirm a suggestion below, or add a fact.'),
      el('h3', {}, `Suggestions (${v.suggestions.length})`),
      v.suggestions.length ? el('ul', { class: 'settings-links' }, ...v.suggestions.map((item) => suggestionItem(project, item)))
        : el('p', { class: 'subtext' }, v.materials.readme ? 'No suggestions now. AIWorks reads the first paragraph of the README and what each plan delivers.'
          : 'No suggestions now. AIWorks found no README in this project’s latest version to read, and no plan suggests one.'),
      retired.length ? disclosure(`knowledge/${project}/retired`, `Set aside (${retired.length})`, el('ul', { class: 'settings-links' }, ...retired.map((fact) => factItem(project, fact)))) : null,
      ...knowledgeEvidence(project, v)),
    form)];
}

/*
 * What the project's approved goals already record (knowledge.mjs projectEvidence) and its event history, each with
 * where it came from. None is a fact: an approved plan's criteria say "In an approved plan", never "Confirmed by you",
 * and become facts only through Confirm or Add a fact above. Materials are named, never opened or read for this page.
 */
const EVIDENCE_STATE = { registered: 'running', paused: 'paused', finished: 'finished', cancelled: 'cancelled', 'cancel-requested': 'cancelling' };
function knowledgeEvidence(project, v) {
  const evidence = v.evidence ?? { requirements: [], decisions: [], references: [], withheldReferences: 0 };
  const goalWords = (item) => `${item.goal ? `“${item.goal}”` : 'Recorded goal'}, approved version ${item.authorizationVersion}`;
  const answer = (item) => item.option ? `you chose “${item.option}”` : item.ownWords ? 'you answered in your own words' : 'you answered';
  return [
    el('h3', {}, 'Requirements and decisions'),
    evidence.requirements.length ? el('ul', { class: 'settings-links' }, ...evidence.requirements.map((item) => el('li', { 'data-focus-scope': `knowledge/${project}/goal/${item.campaignId}` },
      el('p', {}, el('strong', {}, 'Done when'), ' ', badge('planned', 'In an approved plan')),
      el('ul', {}, ...item.criteria.map((text) => el('li', {}, text))),
      el('div', { class: 'subtext' }, `From ${goalWords(item)}, ${dateTime(item.approvedAt)} · ${EVIDENCE_STATE[item.control] ?? 'state not known'}. Not a fact you confirmed here: add it above if it stays true.`))))
      : el('p', { class: 'subtext' }, 'No approved goal of this project states done-when criteria yet.'),
    evidence.decisions.length ? el('ul', { class: 'settings-links' }, ...evidence.decisions.map((item) => el('li', {},
      el('p', {}, `${capital(answer(item))} on ${item.step ? `“${item.step}”` : 'the recorded step'}`, ' ', badge('done', 'Your answer')),
      el('div', { class: 'subtext' }, `${dateTime(item.at)} · ${item.goal ? `“${item.goal}”` : 'Recorded goal'}. It guided that step only; it is not a standing rule.`))))
      : el('p', { class: 'subtext' }, 'You have not answered a decision in this project yet.'),
    el('h3', {}, 'Materials'),
    el('ul', { class: 'settings-links' },
      el('li', {}, v.materials.readme ? 'README: its saved first paragraph is used for the suggestions above.' : 'README: none found in this project’s latest version.'),
      ...evidence.references.map((item) => el('li', {}, el('code', {}, item.reference),
        el('div', { class: 'subtext' }, `Named by ${plural(item.goals.length, 'approved goal')}; given to its AI workers. Not opened for this page.`)))),
    evidence.withheldReferences ? el('p', { class: 'subtext' }, `${plural(evidence.withheldReferences, 'other named document')} not listed: not a plain project path, or the name looks like a secret.`) : null,
    el('h3', {}, 'History'),
    v.history?.events?.length ? eventList(v.history.events) : el('p', { class: 'subtext' }, 'Nothing recorded for this project yet.'),
    v.history?.next ? el('p', { class: 'subtext' }, 'Older events are in Settings › Diagnostics.') : null,
  ];
}
const rebuildKnowledge = () => { $('#content').replaceChildren(); render(); };
/** The 5-second refresh leaves the screen as it is while the owner types in it; only its submit buttons follow the connection. */
function refreshKnowledge(content, project) {
  const screen = content.querySelector('[data-knowledge]');
  if (!screen || screen.dataset.knowledge !== project || !screen.contains(document.activeElement) || !document.activeElement.matches('textarea, input')) return false;
  for (const node of screen.querySelectorAll('button[type="submit"]')) node.disabled = knowledgeOff();
  return true;
}

/*
 * Releases (OWNER_UI_V2 WP9): what reached users and what can be undone, read on their own (GET /api/v2/projects/<id>/
 * releases) when opened and at every refresh while shown. Checked, merged, live and accepted are answered apart; unknown
 * health is said, never shown as healthy. Manual Publish is not built: the screen says what it is missing. Check the site
 * now runs one read-only check through the release role, only where the server says it may.
 */
const releaseViews = new Map();
let releaseBusy = false;
async function loadReleases(project) {
  const entry = releaseViews.get(project) ?? {};
  releaseViews.set(project, entry);
  if (entry.loading) return;
  entry.loading = true;
  try {
    const response = await fetch(`/api/v2/projects/${encodeURIComponent(project)}/releases`, { signal: AbortSignal.timeout(6000) });
    const value = await response.json();
    if (response.ok) { entry.view = value; entry.error = null; entry.readAt = Date.now(); }
    else { entry.error = { status: response.status, message: value.error }; if (response.status === 404) entry.view = null; }
  } catch { entry.error = { status: 0, message: 'The releases of this project could not be read just now. The page tries again.' }; }
  finally {
    entry.loading = false;
    if (current.route.screen === 'releases' && current.route.project === project && state && !document.querySelector('dialog[open]')) render();
  }
}
const releaseEntry = (project) => { if (!releaseViews.has(project)) void loadReleases(project); return releaseViews.get(project) ?? {}; };
const RELEASE_LINE_WORDS = { live: ['done', 'Live'], publishing: ['verifying', 'Publishing'], 'rolled-back': ['pending', 'Rolled back'], failed: ['blocked', 'Failed'],
  unknown: ['unknown', 'Status unknown'], 'not-released': ['pending', 'Not released'] };
const HEALTH_WORDS = { passed: ['done', 'Healthy at the last check'], failed: ['blocked', 'The last check failed'], unknown: ['unknown', 'Health unknown: the last check gave no clear answer'],
  checking: ['verifying', 'Checking now'], 'not-checked': ['pending', 'Not checked yet'] };
const HEALTH_BY = { release: 'the check after release', rollback: 'the check after the rollback, of the restored version', owner: 'your Check the site now' };
const KIND_WORDS = { deploy: 'deployed after the merge', 'merge-then-deploy': 'merged, then deployed', merge: 'merged only', 'local-git-apply': 'applied to a local branch', 'local-folder-apply': 'applied to a local folder' };
function restoreWords(restore) {
  return {
    'previous-version': 'Can be restored: AIWorks puts back the recorded previous version, then checks it again.',
    'previous-unknown': 'The previous version is not recorded yet, so whether it can be restored is not known.',
    'report-only': 'Not restored automatically: this destination’s grant asks for report-only rollback, so you restore it yourself.',
    'no-rollback-command': 'Cannot be restored by AIWorks: this destination names no rollback command.',
    'revert-pull-request': 'A merge is undone by a revert pull request, which is checked like any other change before it is merged.',
    'backup-branch': 'The branch is moved back to the backup made before applying, only while nobody has changed it since.',
    'backup-files': 'Files are put back from the backup made before applying, only where nobody has changed them since.',
    'nothing-changed': 'Nothing was changed, so there is nothing to restore.',
    'unknown-destination': 'Restore scope unknown: this release was recorded before AIWorks kept its destination details.',
  }[restore.scope] ?? 'Restore scope unknown.';
}
const PUBLISH_MISSING = { 'no-grant': 'No valid release grant is recorded for this project.', 'switched-off': 'Auto Release is switched off on this computer.',
  'release-stop': 'Stop all releases is on.', 'release-stop-unknown': 'Whether Stop all releases is on cannot be read.',
  'no-github': 'Release does not apply to a project without GitHub: you apply a checked result yourself.',
  'publish-not-built': 'A manual Publish button is not built: which destinations it may reach is your decision, and it could only use a destination an existing valid grant names.' };
const STEP_KEYS = [['checked', 'Checked'], ['merged', 'Merged'], ['deployed', 'Live'], ['release-checked', 'Release checked']];

function releaseItem(project, r) {
  const [lineBadge, lineWord] = RELEASE_LINE_WORDS[r.line] ?? RELEASE_LINE_WORDS.unknown, [healthBadge, healthWord] = HEALTH_WORDS[r.health.outcome] ?? HEALTH_WORDS.unknown;
  const where = r.destination.kind ? `${r.destination.id}${r.destination.environment ? ` (${r.destination.environment})` : ''}, ${KIND_WORDS[r.destination.kind]}` : `${r.destination.id}, details not recorded`;
  const change = r.change ? `${plural(r.change.files, 'file')} changed, ${r.change.classes.length ? r.change.classes.join(', ') : 'no class recorded'}` : 'Which kinds of file changed is not recorded.';
  const v = r.version;
  return el('li', { 'data-focus-scope': `releases/${r.id}` },
    el('p', {}, el('strong', {}, r.text ?? 'Released result'), ' ', badge(lineBadge, lineWord)),
    el('dl', { class: 'release-facts' },
      el('dt', {}, 'Destination'), el('dd', {}, where),
      el('dt', {}, 'What changes for users'), el('dd', {}, `${r.text ?? 'Not described'}. ${change}`),
      el('dt', {}, 'Result record'), el('dd', {}, v.verifiedSha ? 'The checked result is recorded.' : 'The checked result is not known.',
        v.mergeCommit ? ' Its integration into the project is recorded.' : '', v.deployedDigest ? ' The released version is recorded.' : '',
        v.grantVersion ? ` Release permission version ${v.grantVersion}.` : ''),
      el('dt', {}, 'Restore'), el('dd', {}, restoreWords(r.restore), ' Only the released version is restored: data the site stored, and anything its deploy does not manage, are not.'),
      el('dt', {}, 'Health'), el('dd', {}, badge(healthBadge, healthWord), r.health.at ? ` · ${whenAt(r.health.at)}, by ${HEALTH_BY[r.health.by] ?? 'a check'}` : '')),
    r.checkNow.available ? button('Check the site now', () => void checkSite(project, r.id), 'secondary small', releaseBusy || offline)
      : r.checkNow.reason ? el('p', { class: 'subtext' }, `Check the site now is not available: ${r.checkNow.reason}`) : null);
}

function releasesScreen(project) {
  const entry = releaseEntry(project), v = entry.view;
  // A project without GitHub releases nothing: its checked results are the local work's, applied from Review.
  const applied = localProject(project) ? localWork(project).flatMap((c) => c.results).length : null;
  if (!v) {
    if (!entry.error) return [empty('Reading the releases of this project…', '')];
    return [empty(entry.error.status === 404 ? 'This project is not on this computer' : 'Not known right now', ` ${entry.error.message}`),
      routeLink('Back to Review', { screen: 'project', project, tab: 'review' }, 'button secondary')];
  }
  if (!v.available) return [unavailable()];
  const stale = entry.error || offline ? el('p', { class: 'needs-stale', role: 'status' }, `Shown as read at ${clock(entry.readAt)}. ${offline
    ? 'The page is disconnected; it reads this again when it reconnects.' : entry.error.message}`) : null;
  return [el('section', { class: 'panel', 'data-releases': project, 'aria-labelledby': 'releases-title' },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', { id: 'releases-title' }, 'What reaches users, and what can be undone'),
      el('p', {}, 'Checked, merged, live and accepted are separate answers. Live means the check after release passed; unknown is never shown as healthy.'))),
    el('div', { class: 'panel-body' }, stale,
      el('h3', {}, 'Publish a checked version'),
      el('p', {}, badge('pending', 'Not available'), ' Nothing is released from this page.'),
      el('ul', {}, ...v.publish.missing.map((code) => el('li', {}, PUBLISH_MISSING[code] ?? 'A condition is missing.'))),
      el('h3', {}, `Releases (${v.releases.length})`),
      v.releases.length ? el('ul', { class: 'settings-links' }, ...v.releases.map((r) => releaseItem(project, r)))
        : el('p', { class: 'subtext' }, 'No release is recorded for this project. In Review only, AIWorks deploys nothing; whether a merged result is live is not known here.'),
      // Not "Checked results": a result here may have failed its check, and its release may not be checked at all.
      el('h3', {}, `${applied ? 'Checked results' : 'Results'} (${applied ?? v.results.length})`),
      applied ? el('p', { class: 'subtext' }, 'They are never released: you apply each one to your folder, and undo it, on ',
        routeLink('Review', { screen: 'project', project, tab: 'review' }), '.')
      : v.results.length ? el('ul', { class: 'settings-links' }, ...v.results.map((item) => el('li', {}, el('strong', {}, item.text),
        el('div', { class: 'subtext' }, [...STEP_KEYS.map(([key, word]) => [word, item.steps.find((step) => step.key === key)?.answer]).filter(([, answer]) => answer)
          .map(([word, answer]) => `${word}: ${LADDER_WORDS[answer] ?? 'Not known'}`), `Accepted by you: ${LADDER_WORDS[item.accepted] ?? 'Not known'}`].join(' · ')),
        item.liveFrom ? el('div', { class: 'subtext' }, `Live: Yes comes from AIWorks’s recorded release to ${item.liveFrom}, listed under Releases above.`) : null,
        item.note ? el('div', { class: 'subtext' }, item.note) : null)))
        : el('p', { class: 'subtext' }, 'No result yet.')),
    el('div', { class: 'panel-body' }, releaseStopLine(state.supervisor.settings?.releaseStop)))];
}
const LADDER_WORDS = { yes: 'Yes', no: 'No', 'in-progress': 'In progress', unknown: 'Not known' };

/** Check the site now: one read-only check through the release role. The answer is said as it came; unknown is unknown. */
async function checkSite(project, releaseId) {
  const from = current.address;
  releaseBusy = true; render();
  try {
    const result = await post('/api/v2/releases/check', { requestId: crypto.randomUUID(), releaseId });
    notice({ passed: 'The site passed its check just now.', failed: 'The site failed its check just now. Nothing was rolled back: decide what to do, or restore it with the project’s own rollback.',
      unknown: 'The check gave no clear answer, so the site’s health is unknown.' }[result.outcome] ?? 'The check gave no clear answer.', null, null, from);
  } catch (error) {
    notice(error.known ? error.message : 'The check was not confirmed. Its answer shows here once AIWorks records it.', null, error.known ? error.detail : null, from);
  } finally { releaseBusy = false; await loadReleases(project); }
}

/** One act on a fact. A retry reuses its request id, so the server saves it once; a refusal keeps what was typed. True when saved. */
async function saveFact(project, body) {
  knowledgeBusy = true; render();
  const requestId = crypto.randomUUID(), address = knowledgeAddress(project);
  let saved = false;
  const attempt = async () => {
    try {
      const result = await post('/api/v2/projects/knowledge', { requestId, project, ...body });
      const entry = knowledgeViews.get(project) ?? {};
      Object.assign(entry, { view: result.view, error: null, readAt: Date.now() });
      knowledgeViews.set(project, entry);
      knowledgeEditing = null; saved = true;
      notice(result.message, null, null, address);
    } catch (error) {
      notice(error.known ? error.message : 'Saving could not be confirmed. Retry: the same request is never saved twice.', error.known ? null : attempt, error.known ? error.detail : null, address);
      if (['FACT_CHANGED', 'FACT_SUGGESTION_GONE'].includes(error.code)) void loadKnowledge(project);
    }
  };
  try { await attempt(); } finally { knowledgeBusy = false; if (current.address === address) rebuildKnowledge(); await poll(); }
  return saved;
}

/*
 * Settings -> Usage (OWNER_UI_V2 WP8): what AIWorks used, by source and unit, read on its own when opened and at every
 * refresh while shown. Each unit stands apart (dollars as reported, tokens per provider); a run that reported no cost is
 * counted, never priced at $0; hosting and subscriptions are not tracked and say so, with no amount.
 */
const usageEntry = { view: null, error: null, loading: false, readAt: null };
async function loadUsage() {
  if (usageEntry.loading) return;
  usageEntry.loading = true;
  try {
    const response = await fetch('/api/v2/settings/usage', { signal: AbortSignal.timeout(6000) });
    const value = await response.json();
    if (response.ok) Object.assign(usageEntry, { view: value, error: null, readAt: Date.now() });
    else usageEntry.error = { status: response.status, message: value.error };
  } catch { usageEntry.error = { status: 0, message: 'Usage could not be read just now. The page tries again.' }; }
  finally {
    usageEntry.loading = false;
    if (current.route.screen === 'settings' && current.route.section === 'usage' && state && !document.querySelector('dialog[open]')) render();
  }
}
/** What planning a goal costs: from this computer's earlier plans, or unavailable. Never $0 and never a price. */
function planningText(p) {
  if (!p) return 'Planning cost: not known right now.';
  if (!p.available) return `Planning cost: unavailable. ${p.runs ? `${plural(p.runs, 'earlier plan')} on this computer reported no cost` : 'No goal has been planned on this computer yet'}, so AIWorks cannot estimate it. Planning a goal is one AI run; it starts only when you send a goal.`;
  const range = p.lowUsd === p.highUsd ? `about ${usd(p.lowUsd)}` : `${usd(p.lowUsd)} to ${usd(p.highUsd)} (typically ${usd(p.medianUsd)})`;
  return `Planning a goal has cost ${range} on this computer, from ${plural(p.reportedRuns, 'earlier plan')} that reported a cost${p.unknownRuns ? `; ${plural(p.unknownRuns, 'other')} reported none` : ''}. An estimate from history, not a price.`;
}
function usageScreen() {
  if (!usageEntry.view && !usageEntry.loading && !usageEntry.error) void loadUsage();
  const v = usageEntry.view;
  if (!v) return [usageEntry.error ? empty('Not known right now', ` ${usageEntry.error.message}`) : empty('Reading usage…', '')];
  if (!v.available) return [unavailable()];
  const w = v.workers, c = v.coordinator;
  // Each total names its runs, and every subset says which of them it counts, so the numbers add up on the page.
  const dollars = (amount, runs, all) => !all ? 'No finished runs yet.' : amount === null ? `${plural(all, 'finished run')}. None reported a dollar cost.`
    : `${plural(all, 'finished run')}. ${usd(amount)} reported by ${runs} of them.`;
  const unknown = (runs, amount) => runs && amount !== null ? el('p', {}, `${runs} of them reported no cost: unknown, not $0.`) : null;
  const tokenRuns = w.tokens.reduce((sum, t) => sum + t.runs, 0), workerRuns = w.usdRuns + w.unknownRuns;
  const stale = usageEntry.error || offline ? el('p', { class: 'needs-stale', role: 'status' }, `Shown as read at ${clock(usageEntry.readAt)}.`) : null;
  return [
    panel('AI worker runs', 'Every finished step’s runs, in all work on this computer. Running steps are counted when they finish.', el('div', { class: 'panel-body' }, stale,
      el('p', {}, dollars(w.usd, w.usdRuns, workerRuns)), unknown(w.unknownRuns, w.usd),
      w.tokens.length ? el('p', {}, `Tokens by AI worker, from the ${tokenRuns} of them that reported tokens${workerRuns > tokenRuns ? `; ${workerRuns - tokenRuns} reported none` : ''}:`) : null,
      w.tokens.length ? el('ul', { class: 'settings-links' }, ...w.tokens.map((t) => el('li', {}, el('strong', {}, provider(t.executor)),
        el('div', { class: 'subtext' }, `${plural(t.runs, 'run')} · ${tokenCount(t.input)} input and ${tokenCount(t.output)} output tokens`)))) : null)),
    panel('AI coordinator', 'Planning goals and answering your messages.', el('div', { class: 'panel-body' },
      el('p', {}, dollars(c.usd, c.reportedRuns, c.reportedRuns + c.unknownRuns)), unknown(c.unknownRuns, c.usd), c.openRuns ? el('p', { class: 'subtext' }, `${plural(c.openRuns, 'run')} still running.`) : null,
      el('p', {}, planningText(v.planning)))),
    panel('Hosting and subscriptions', null, el('div', { class: 'panel-body' },
      el('p', {}, 'Not tracked. AIWorks does not know what hosting or AI subscriptions cost you, so it shows no amount for them.'))),
    el('p', { class: 'subtext' }, 'Dollars are as each AI worker reported them. Tokens and dollars are counted apart and never added together.')];
}

/** One project's screens. Campaign cards, step tables and costs are today's, limited to this project. */
function projectScreen(route) {
  const project = route.project, all = projectCampaigns(project);
  // Now from the state copy module, for a project this computer knows (or while its state cannot be read).
  // Overview (OWNER_UI_V2 screen 3): the goal, then the budget with what was spent, then running work under Details.
  if (route.screen === 'project' && route.tab === 'overview' && (offline || !state.supervisor.available || all.length ||
    projectList().some((item) => sameProject(item.id, project)))) return [...nowScreen(project), budgetPanel(project), workDetails(project), settingsLink(project)].filter(Boolean);
  // Project settings are read on their own, so they show whatever the supervisor's snapshot says (WP5).
  if (route.screen === 'project-settings') return projectSettingsScreen(project);
  // Knowledge is read on its own too (WP8).
  if (route.screen === 'knowledge') return knowledgeScreen(project);
  // Releases are read on their own too (WP9).
  if (route.screen === 'releases') return releasesScreen(project);
  if (!state.supervisor.available) return [unavailable()];
  if (route.screen === 'start' && (all.length || projectList().some((item) => sameProject(item.id, project)))) {
    const plans = planRows(project);
    return plans.length ? [...startScreen(project), el('section', { class: 'panel' }, el('div', { class: 'panel-body', id: 'start-plans' }, ...plans))] : startScreen(project);
  }
  if (route.screen === 'review') return [...reviewScreen(project, route.plan), el('p', { class: 'subtext' }, routeLink('All plans for this project', { screen: 'plan', project }))];
  if (route.screen === 'plan') return planScreen(project);
  // A project without GitHub: its work and results come from the work view; never a pull request (UI17). Earlier work and
  // results stay reachable after its rules are revoked, so an applied result can still be undone.
  const local = localProject(project);
  if (local && route.screen === 'project') {
    if (!localWork(project).length && !local.connection?.startWork.allowed) return [empty('No work yet.', local.connection?.startWork.text ?? '')];
    return route.tab === 'review' ? localResultsScreen(project) : localWorkScreen(project);
  }
  // A connected project where work cannot start says what its Now says, never a reason that is not its own (review 5 G2).
  const cannot = !all.length ? projectList().find((item) => sameProject(item.id, project) && item.connection && !item.connection.startWork.allowed) : null;
  if (cannot) return [empty('No work yet.', cannot.connection.startWork.text)];
  // A repository this computer's settings list, with no work yet (OWNER_WORKSPACE §7.1). Starting work here is not built yet.
  if (!all.length && projectList().some((item) => sameProject(item.id, project))) return [empty('No work yet.', `Work in ${projectName(project)} appears here once it is registered on this computer. Starting work from this page is not built yet.`)];
  if (!all.length) return [empty('This project has no work on this computer', 'The address may be mistyped, or its work was removed.'), routeLink('All projects', '#/projects', 'button secondary')];
  const layout = campaignLayout(), mine = (list) => list.filter((c) => sameProject(c.repository, project));
  // Campaigns with something for the owner and active ones get cards; finished ones are one line each, under Review.
  const cards = mine(layout.cards), finished = mine(layout.finished);
  if (route.screen === 'step') {
    const c = all.find((item) => item.id === route.work), task = c?.tasks.find((item) => item.id === route.step);
    if (!task) return [empty('This step is not recorded for this project', 'It may belong to another project, or the address is mistyped.'), routeLink('All work in this project', { screen: 'project', project, tab: 'overview' }, 'button secondary')];
    return stepScreen(project, c, task);
  }
  if (route.tab === 'review') return [resultsScreen(project), finishedList(finished)].filter(Boolean);
  return cards.length ? [...cards.map((c) => campaignCard(c, false))] : [empty('No work is running in this project', 'Finished work and its results are under Review.')];
}

/*
 * The local work list (LOCAL_OPERATION section 5, slice UI20): the list, one item with its comments, and the imported
 * issues' read-only preview with the typed confirmation of the exact list to close on GitHub. Every text is set as text,
 * never as markup. Each change carries a request id, kept across a retry, and the version of what this page showed: the
 * server refuses a stale one and saves nothing. Forms are kept as typed across the 5-second refresh, like Start work.
 */
const WORKLIST_ADDRESS = '#/worklist', IMPORT_ADDRESS = '#/worklist/import';
const worklist = () => state?.worklist ?? null;
const WORK_KINDS = [['task', 'Task'], ['note', 'Note'], ['finding', 'Finding'], ['decision', 'Decision']];
const WORK_TEXT_MAX = 4000;
let worklistBusy = false, pendingClose = null;
const worklistOff = () => worklistBusy || offline;
const capital = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** One work list change. A retry reuses its request id, so the server answers it once and never applies it twice. */
async function sendWorklist(path, body, { address = current.address, done = null, number = null } = {}) {
  worklistBusy = true; render();
  const requestId = crypto.randomUUID();
  const attempt = async () => {
    try {
      const result = await post(path, { requestId, ...body });
      done?.(result);
      notice(result.duplicate ? `${result.message} It was already received, so nothing was done twice.` : result.message, null, null, address);
    } catch (error) {
      notice(error.known ? error.message : 'Delivery could not be confirmed. Retry: the same request is never applied twice.', error.known ? null : attempt, error.known ? error.detail : null, address);
    } finally { if (number) void loadItem(number); }
  };
  try { await attempt(); } finally { worklistBusy = false; await poll(); }
}

/** Why the work list cannot be shown, or null. Unknown is never shown as empty. */
function worklistBlocked() {
  const wl = worklist();
  if (!wl || !wl.readable) return empty('Not known right now', ' AIWorks can’t read its work list on this computer right now. This is not the same as an empty list.');
  if (!wl.available) return empty('No work list on this computer', ' The work list is used for AIWorks’s own repository once the AIWorks configuration file on this computer names it.');
  return null;
}

/**
 * Where an item stands for the owner: a decision waiting for them, unfinished work, a result merged into local main
 * (kept open as history) or a decision already recorded that stays in force. Grouping only: every item stays listed.
 */
const worklistBucket = (entry) => entry.state !== 'open' ? 'closed' : entry.kind === 'decision' ? entry.needsOwner ? 'owner' : 'standing'
  : entry.kind === 'review' && entry.merged ? 'merged' : 'outstanding';
/** The unfinished items: what Needs you counts and the Work list's "Not finished" lists, from this one place. */
const worklistUnfinished = () => (worklist()?.items ?? []).filter((entry) => worklistBucket(entry) === 'outstanding');
const worklistMeta = (entry) => [entry.kindWord, entry.state === 'open' ? 'Open' : 'Closed', entry.needsOwner && entry.state === 'open' ? 'Needs you' : null,
  entry.kind === 'review' ? entry.merged ? 'merged into local main' : 'not merged yet' : null,
  `from ${entry.author}`, entry.updatedAt ? `updated ${clock(entry.updatedAt)}` : null].filter(Boolean).join(' · ');
const worklistRow = (entry) => el('li', { class: 'result-row worklist-row', 'data-focus-scope': `worklist/${entry.number}` },
  el('div', { class: 'needs-text' }, routeLink(`#${entry.number} ${entry.title}`, { screen: 'worklist-item', number: entry.number })),
  el('div', { class: 'result-state' }, worklistMeta(entry)));

/**
 * The list's changing part: imported issues to review, decisions waiting for the owner, unfinished work, then merged
 * results, standing decisions and closed items behind disclosures, kept as history.
 */
function worklistParts() {
  const wl = worklist(), of = (bucket) => wl.items.filter((entry) => worklistBucket(entry) === bucket);
  const owner = of('owner'), open = worklistUnfinished(), merged = of('merged'), standing = of('standing'), closed = of('closed');
  const waiting = wl.imported.candidates.length;
  const history = (key, title, note, rows) => rows.length ? el('section', { class: 'panel', 'data-focus-scope': `worklist/${key}` },
    disclosure(`worklist/${key}`, `${title} (${rows.length})`,
      el('div', {}, note ? el('p', { class: 'subtext' }, note) : null, el('ul', { class: 'needs-list' }, ...rows.map(worklistRow))))) : null;
  return [
    waiting ? el('p', { class: 'notice' }, `${plural(waiting, 'imported issue')} still open on GitHub. `, routeLink('Review the imported issues', IMPORT_ADDRESS)) : null,
    owner.length ? el('section', { class: 'panel', 'aria-labelledby': 'worklist-owner-title', 'data-focus-scope': 'worklist/owner' },
      el('div', { class: 'panel-header' }, el('div', {}, el('h2', { id: 'worklist-owner-title' }, `Decisions for you (${owner.length})`),
        el('p', {}, 'Also on Needs you.'))),
      el('ul', { class: 'needs-list' }, ...owner.map(worklistRow))) : null,
    el('section', { class: 'panel', 'aria-labelledby': 'worklist-open-title', 'data-focus-scope': 'worklist/open' },
      el('div', { class: 'panel-header' }, el('div', {}, el('h2', { id: 'worklist-open-title' }, `Not finished (${open.length})`),
        el('p', {}, 'On this computer only: tasks, findings and notes, and checked results not merged yet.'))),
      open.length ? el('ul', { class: 'needs-list' }, ...open.map(worklistRow)) : empty('Nothing unfinished.', ' Add an item below.')),
    history('merged', 'Merged results', 'Merged into local main and kept for reference. Merged is not accepted.', merged),
    history('standing', 'Standing decisions', 'Decisions already recorded; they stay in force and need nothing from you.', standing),
    history('closed', 'Closed', null, closed),
    wl.total > wl.items.length ? el('p', { class: 'subtext' }, `Showing the newest ${wl.items.length} of ${wl.total} items.`) : null,
  ].filter(Boolean);
}

/** Add an item: the draft is kept per address until the server confirms it. */
function worklistAddPanel() {
  const draft = { kind: 'task', title: '', body: '', ...(drafts.get(WORKLIST_ADDRESS, 'add') ?? {}) };
  const save = () => drafts.set(WORKLIST_ADDRESS, 'add', { kind: kind.value, title: title.value, body: body.value });
  const kind = el('select', { id: 'worklist-kind', onchange: save }, ...WORK_KINDS.map(([value, label]) => el('option', { value, selected: draft.kind === value }, label)));
  const title = el('input', { id: 'worklist-title', type: 'text', maxlength: 256, required: true, autocomplete: 'off', oninput: save });
  title.value = draft.title;
  const body = el('textarea', { id: 'worklist-body', rows: 4, maxlength: WORK_TEXT_MAX, oninput: save });
  body.value = draft.body;
  const form = el('form', { novalidate: true, class: 'panel-body start-form', 'data-worklist-form': 'add', 'data-focus-scope': 'worklist/add',
    onsubmit: (event) => {
      event.preventDefault(); save();
      if (worklistOff() || !validateForm(form)) return;
      void sendWorklist('/api/work-list/items', { kind: kind.value, title: title.value, body: body.value }, { address: WORKLIST_ADDRESS,
        done: () => { drafts.delete(WORKLIST_ADDRESS, 'add'); title.value = ''; body.value = ''; } });
    } },
    el('label', { class: 'field' }, el('strong', {}, 'Kind'), kind),
    el('label', { class: 'field' }, el('strong', {}, 'Title'), title),
    el('label', { class: 'field' }, el('strong', {}, 'Details (optional)'), body),
    el('p', { class: 'subtext' }, 'Saved on this computer only; nothing is posted to GitHub. No secrets; up to 4,000 characters.'),
    el('button', { class: 'button', type: 'submit', disabled: worklistOff() }, 'Add to the work list'));
  return el('section', { class: 'panel', 'aria-labelledby': 'worklist-add-title' },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', { id: 'worklist-add-title' }, 'Add an item'))), form);
}

function workListScreen() {
  const blocked = worklistBlocked();
  return blocked ? [blocked] : [el('div', { id: 'worklist-dynamic' }, ...worklistParts()), worklistAddPanel()];
}

/** The 5-second refresh keeps the add form as typed: only the list and the button change. False when it must be built. */
function refreshWorklist(content) {
  const form = content.querySelector('form[data-worklist-form="add"]');
  if (!form || worklistBlocked()) return false;
  patch(content.querySelector('#worklist-dynamic'), worklistParts());
  form.querySelector('button[type="submit"]').disabled = worklistOff();
  return true;
}

// One item, read on its own (GET /api/v2/worklist/<n>) when opened and again at every refresh while it is shown.
const itemViews = new Map();
async function loadItem(number) {
  const entry = itemViews.get(number) ?? {};
  itemViews.set(number, entry);
  if (entry.loading) return;
  entry.loading = true;
  try {
    const response = await fetch(`/api/v2/worklist/${number}`, { signal: AbortSignal.timeout(6000) });
    const value = await response.json();
    if (response.ok) { entry.view = value; entry.error = null; entry.readAt = Date.now(); }
    else { entry.error = { status: response.status, message: value.error }; if (response.status === 404) entry.view = null; }
  } catch { entry.error = { status: 0, message: 'This item could not be read just now. The page tries again.' }; }
  finally {
    entry.loading = false;
    if (current.route.screen === 'worklist-item' && current.route.number === number && state && !document.querySelector('dialog[open]')) render();
  }
}
const itemEntry = (number) => { if (!itemViews.has(number)) void loadItem(number); return itemViews.get(number) ?? {}; };
const commentDraft = (address) => ({ text: '', base: null, ...(drafts.get(address, 'comment') ?? {}) });

/** The item's changing part: what it is, its text, its links, its comments and Close or Reopen. */
function itemParts(number) {
  const entry = itemEntry(number), v = entry.view;
  if (!v) {
    if (!entry.error) return [empty('Reading this item…', '')];
    return entry.error.status === 404 ? [empty('This item is not in the work list on this computer', ' The address may be mistyped.'), routeLink('All work list items', WORKLIST_ADDRESS, 'button secondary')]
      : [empty('Not known right now', ` ${entry.error.message}`)];
  }
  const review = v.kind === 'review' ? (worklist()?.reviews ?? []).find((row) => row.number === v.number) : null;
  const c = v.campaignId ? campaignById(v.campaignId) : null, task = c?.tasks.find((t) => t.id === v.taskId);
  const other = v.state === 'open' ? 'closed' : 'open';
  return [el('section', { class: 'panel', 'aria-labelledby': 'worklist-item-title', 'data-focus-scope': `worklist/item/${number}` },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', { id: 'worklist-item-title', class: 'work-text' }, v.title), el('p', {}, worklistMeta(v))),
      button(v.state === 'open' ? 'Close item' : 'Reopen item', () => void sendWorklist('/api/work-list/state', { number, version: v.version, state: other }, { number }), 'secondary', worklistOff())),
    el('div', { class: 'panel-body' },
      entry.error || offline ? el('p', { class: 'needs-stale', role: 'status' }, `Shown as read at ${clock(entry.readAt)}. ${offline
        ? 'The page is disconnected; it reads this item again when it reconnects.' : entry.error.message}`) : null,
      // A local review is checked, never merged or accepted by itself (OWNER_WORKSPACE §2.3). "Passed" only when its step's
      // check passed every criterion (owner.mjs checkPassed); a review alone never means passed.
      v.kind === 'review' ? el('p', { class: 'notice warning local-review' }, `Local review: ${task?.checkPassed === true
        ? 'passed the independent check' : task ? 'checked, not every criterion passed' : 'checked; its criteria are on its step'}${review?.mergedAt
        ? ` and merged into local main ${clock(review.mergedAt)}. Merged is not accepted.` : ' on this computer. Not merged and not accepted.'}`) : null,
      v.source ? el('p', { class: 'subtext' }, 'Imported from ', link(`GitHub issue #${v.number} ↗`, v.source.url), ` as it was at ${dateTime(v.source.updatedAt)}.`) : null,
      task ? el('p', { class: 'subtext' }, 'Step: ', routeLink(task.outcome ?? task.title ?? task.id, { screen: 'step', project: c.repository, work: c.id, step: task.id }), ` · ${campaignTitle(c)}`) : null,
      el('div', { class: 'work-text' }, v.body || 'No details.'),
      v.shortened ? el('p', { class: 'subtext' }, 'Shortened here: the full text is kept on this computer.') : null,
      el('h3', { class: 'section-title' }, `Comments (${v.commentCount})`),
      v.commentCount > v.comments.length ? el('p', { class: 'subtext' }, `Showing the newest ${v.comments.length}.`) : null,
      v.comments.length ? el('ol', { class: 'work-comments' }, ...v.comments.map((comment) => el('li', { class: 'work-comment' },
        el('div', { class: 'subtext' }, `${capital(comment.author)} · ${clock(comment.createdAt)}`), el('div', { class: 'work-text' }, comment.body)))) : el('p', { class: 'subtext' }, 'No comments yet.')))];
}

/** Whether the item changed after the owner started writing: the comment is sent against what is shown now. */
function commentStale(number, address) {
  const draft = commentDraft(address), now = itemViews.get(number)?.view?.version;
  return Boolean(draft.base && now && draft.base !== now && draft.text.trim());
}

function commentPanel(number) {
  const address = formatRoute({ screen: 'worklist-item', number }), draft = commentDraft(address);
  const text = el('textarea', { id: 'worklist-comment', rows: 4, maxlength: WORK_TEXT_MAX, required: true,
    oninput: () => { drafts.set(address, 'comment', { text: text.value, base: commentDraft(address).base ?? itemViews.get(number)?.view?.version ?? null }); } });
  text.value = draft.text;
  const form = el('form', { novalidate: true, class: 'panel-body start-form', 'data-worklist-form': `comment-${number}`, 'data-focus-scope': `worklist/comment/${number}`,
    onsubmit: (event) => {
      event.preventDefault();
      const v = itemViews.get(number)?.view;
      if (!v || worklistOff() || !validateForm(form)) return;
      void sendWorklist('/api/work-list/comment', { number, version: v.version, body: text.value }, { address, number,
        done: () => { drafts.delete(address, 'comment'); text.value = ''; } });
    } },
    el('label', { class: 'field' }, el('strong', {}, 'Add a comment'), text),
    el('p', { id: 'worklist-comment-stale', class: 'needs-stale', role: 'status', hidden: !commentStale(number, address) },
      'This item changed since you started writing. Read it again above; your comment is sent against what is shown now.'),
    el('p', { class: 'subtext' }, 'Saved on this computer only; nothing is posted to GitHub. No secrets; up to 4,000 characters.'),
    el('button', { class: 'button', type: 'submit', disabled: worklistOff() || !itemViews.get(number)?.view }, 'Add comment'));
  return el('section', { class: 'panel' }, form);
}

function workItemScreen(number) {
  return [routeLink('← Work list', WORKLIST_ADDRESS, 'project-back'), el('div', { id: 'worklist-item' }, ...itemParts(number)), commentPanel(number)];
}

/** The 5-second refresh keeps the comment as typed: only the item and the button change. */
function refreshItem(content, number) {
  const form = content.querySelector(`form[data-worklist-form="comment-${number}"]`);
  if (!form) return false;
  patch(content.querySelector('#worklist-item'), itemParts(number));
  form.querySelector('button[type="submit"]').disabled = worklistOff() || !itemViews.get(number)?.view;
  form.querySelector('#worklist-comment-stale').hidden = !commentStale(number, formatRoute({ screen: 'worklist-item', number }));
  return true;
}

/** The issues the owner keeps checked, as the preview shows them now. */
const importChoice = (form) => {
  const numbers = new Set([...form.querySelectorAll('input[data-import-number]:checked')].map((box) => Number(box.value)));
  return worklist().imported.candidates.filter((entry) => numbers.has(entry.number));
};
const importSignature = (candidates) => candidates.map((entry) => `${entry.number}:${entry.version}`).join(',');
const importLabel = (n) => n ? `Close ${plural(n, 'issue')} on GitHub…` : 'Choose at least one issue';

/**
 * The read-only preview of the imported issues still open on GitHub, with a choice of which to close. Nothing is sent
 * from here: the confirmation dialog names the exact list and asks for the repository's name.
 */
function importScreen() {
  const blocked = worklistBlocked();
  if (blocked) return [blocked];
  const wl = worklist(), { candidates, closeOn, max } = wl.imported;
  if (!wl.repository) return [empty('No repository is set for the work list', ' The AIWorks configuration file on this computer names the repository whose issues were imported.')];
  if (!candidates.length) {
    return [empty('No imported issue is open on GitHub', ' As far as AIWorks recorded, every imported issue is closed on GitHub, or none was imported. The import itself runs from the command line on this computer.'),
      routeLink('Work list', WORKLIST_ADDRESS, 'button secondary')];
  }
  const unchecked = new Set(drafts.get(IMPORT_ADDRESS, 'unchecked') ?? []);
  const update = () => {
    const chosen = importChoice(form).length, submit = form.querySelector('button[type="submit"]');
    submit.textContent = chosen > max ? `Choose at most ${max} at a time` : importLabel(chosen);
    submit.disabled = !closeOn || worklistOff() || !chosen || chosen > max;
  };
  const form = el('form', { novalidate: true, class: 'panel-body start-form', 'data-worklist-form': 'import', 'data-signature': importSignature(candidates), 'data-focus-scope': 'worklist/import',
    onchange: () => { drafts.set(IMPORT_ADDRESS, 'unchecked', [...form.querySelectorAll('input[data-import-number]')].filter((box) => !box.checked).map((box) => Number(box.value))); update(); },
    onsubmit: (event) => { event.preventDefault(); openCloseImported(form); } },
    el('p', {}, `${plural(candidates.length, 'issue')} imported from ${wl.repository} into the work list ${candidates.length === 1 ? 'is' : 'are'} still open on GitHub, as far as AIWorks recorded. Nothing changes until you confirm.`),
    el('fieldset', {}, el('legend', {}, 'Close on GitHub'), ...candidates.map((entry) => el('label', { class: 'choice' },
      el('input', { type: 'checkbox', value: String(entry.number), 'data-import-number': String(entry.number), checked: !unchecked.has(entry.number) }),
      el('span', { class: 'work-text' }, `#${entry.number} ${entry.title} `, el('span', { class: 'subtext' }, `· imported as of ${dateTime(entry.updatedAt)}`))))),
    el('p', { class: 'subtext' }, 'For each issue you confirm, AIWorks posts one comment on GitHub, “Moved to the AIWorks local work list as #N on <date>. Continue there.”, and closes the issue as not planned. An issue changed on GitHub since the import is skipped. Labels and every other issue are left as they are.'),
    closeOn ? null : el('p', { class: 'notice warning' }, 'Preview only: closing on GitHub is not switched on in this version of AIWorks, so nothing can be sent from here.'),
    el('button', { class: 'button danger', type: 'submit' }, importLabel(0)));
  update();
  return [routeLink('← Work list', WORKLIST_ADDRESS, 'project-back'), el('section', { class: 'panel' }, form)];
}

/** The refresh keeps the choices while the list is the same; a changed list is shown again with the choices kept. */
function refreshImport(content) {
  const form = content.querySelector('form[data-worklist-form="import"]');
  if (!form || worklistBlocked() || form.dataset.signature !== importSignature(worklist().imported.candidates)) return false;
  form.dispatchEvent(new Event('change'));
  return true;
}

/** Opens the confirmation for exactly the issues chosen and shown now; the dialog's list is what is sent. */
function openCloseImported(form) {
  const wl = worklist(), chosen = importChoice(form);
  if (!wl.imported.closeOn || !chosen.length || chosen.length > wl.imported.max || worklistOff()) return;
  pendingClose = { selection: chosen.map(({ number, version }) => ({ number, version })), repository: wl.repository };
  const named = chosen.slice(0, 20).map((entry) => `#${entry.number}`).join(', ') + (chosen.length > 20 ? ` and ${chosen.length - 20} more` : '');
  $('#close-imported-title').textContent = `Close ${plural(chosen.length, 'issue')} on GitHub?`;
  $('#close-imported-description').textContent = `${named} in ${wl.repository}: each gets one pointer comment and is closed as not planned. AIWorks cannot reopen them for you.`;
  $('#close-imported-label').textContent = `Type ${wl.repository} to confirm`;
  $('#close-imported-typed').value = '';
  $('#confirm-close-imported').textContent = `Close ${plural(chosen.length, 'issue')}`;
  $('#close-imported-dialog').showModal();
  checkCloseStale();
}

/** While the dialog is open, a change to any issue it names makes it stale: it can only be cancelled and reviewed again. */
function checkCloseStale() {
  if (!pendingClose || !$('#close-imported-dialog').open) return;
  const now = new Map((worklist()?.imported.candidates ?? []).map((entry) => [entry.number, entry.version]));
  const stale = offline || pendingClose.selection.some((entry) => now.get(entry.number) !== entry.version);
  $('#close-imported-stale').hidden = !stale;
  $('#close-imported-stale').textContent = offline ? 'The page is disconnected. Cancel, and confirm again when it reconnects.' : 'The list changed since you opened this. Cancel and review it again; nothing was sent.';
  $('#confirm-close-imported').disabled = stale || worklistOff();
}

/** What a node shows: its tag, attributes and text, all the way down. */
const shows = (node) => node.nodeType !== 1 ? `#${node.data ?? ''}`
  : `<${node.tagName}${node.getAttributeNames().sort().map((name) => ` ${name}="${node.getAttribute(name)}"`).join('')}>${[...node.childNodes].map(shows).join('')}</>`;
/**
 * The 5-second refresh changes only what changed (aiworks#11 review F21): a node that shows the same stays the same node,
 * so a pointer on it, focus, scroll and an open disclosure are kept. Text and attributes are updated in place; an element
 * that acts (a button) is kept only while it shows exactly the same, otherwise the new one with its new action replaces it.
 */
function patch(parent, next) {
  const before = [...parent.childNodes];
  next.forEach((node, index) => {
    const old = before[index];
    if (!old) parent.append(node);
    else if (!reuse(old, node)) parent.replaceChild(node, old);
  });
  for (const old of before.slice(next.length)) old.remove();
}
function reuse(old, node) {
  if (old.nodeType !== 1 && node.nodeType !== 1) { if (old.data !== node.data) old.data = node.data; return true; }
  if (old.nodeType !== 1 || node.nodeType !== 1 || old.tagName !== node.tagName) return false;
  if (acting.has(old) || acting.has(node)) return shows(old) === shows(node);
  for (const name of old.getAttributeNames()) if (!node.hasAttribute(name)) old.removeAttribute(name);
  for (const name of node.getAttributeNames()) if (old.getAttribute(name) !== node.getAttribute(name)) old.setAttribute(name, node.getAttribute(name));
  patch(old, [...node.childNodes]);
  return true;
}

function render() {
  if (!state) return;
  showTabs();
  const content = $('#content'), route = current.route;
  const focusKey = (node) => JSON.stringify([node.closest('[data-focus-scope]')?.dataset.focusScope, node.tagName, node.getAttribute('href'), node.textContent]);
  const focused = content.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  const diagnostics = route.screen === 'settings' && route.section === 'diagnostics';
  renderMetrics(route.project ? projectCampaigns(route.project) : state.supervisor.campaigns, diagnostics ? ['Platform roadmap items'] : []);
  if (route.screen === 'home') patch(content, homeScreen());
  else if (route.screen === 'needs') patch(content, [needsYou() ?? unavailable()]);
  else if (route.screen === 'settings' && route.section === 'connections') patch(content, connectionsScreen());
  else if (route.screen === 'settings' && route.section === 'alerts' && refreshAlerts(content)) { /* the form stays as the owner typed it */ }
  else if (route.screen === 'settings' && route.section === 'alerts') patch(content, alertsScreen());
  else if (route.screen === 'settings' && route.section === 'usage') patch(content, usageScreen());
  else if (route.screen === 'chats' && refreshChat(content, route.chat)) { /* the reply stays as the owner typed it */ }
  else if (route.screen === 'chats') patch(content, chatsScreen(route.chat ?? null));
  else if (route.screen === 'settings' && route.section === 'accounts') patch(content, accountsScreen());
  else if (route.screen === 'settings' && route.section === 'version') patch(content, versionScreen());
  else if (route.screen === 'settings' && route.section === 'instructions') patch(content, modelInstructionsScreen());
  else if (diagnostics) patch(content, [trackOverview(), roadmapView(), workView(), mergeChecksPanel(), projectWaitsPanel(),
    panel('Execution journal', 'Latest 80 events · raw agent transcripts and secrets are never shown', activityList())].filter(Boolean));
  else if (route.screen === 'settings') patch(content, settingsScreen());
  else if (route.screen === 'add-project' && refreshAdd(content)) { /* the form stays as the owner typed it */ }
  else if (route.screen === 'add-project') patch(content, addProjectScreen());
  else if (route.screen === 'start' && refreshStart(content, route.project)) { /* the form stays as the owner typed it */ }
  else if (route.screen === 'review' && refreshReview(content, route.project, route.plan)) { /* the edit stays as the owner typed it */ }
  else if (route.screen === 'worklist' && refreshWorklist(content)) { /* the form stays as the owner typed it */ }
  else if (route.screen === 'worklist') patch(content, workListScreen());
  else if (route.screen === 'worklist-item' && refreshItem(content, route.number)) { /* the comment stays as the owner typed it */ }
  else if (route.screen === 'worklist-item') patch(content, workItemScreen(route.number));
  else if (route.screen === 'worklist-import' && refreshImport(content)) { /* the choices stay as the owner left them */ }
  else if (route.screen === 'worklist-import') patch(content, importScreen());
  else if (route.screen === 'project-settings' && refreshProjectSettings(content, route.project)) { /* the form stays as the owner typed it */ }
  else if (route.screen === 'knowledge' && refreshKnowledge(content, route.project)) { /* the words stay as the owner typed them */ }
  else if (route.project) patch(content, projectScreen(route));
  else patch(content, projectsScreen());
  // Focus stays where it was; only when its element was replaced does it move to the one that took its place.
  if (focused && !content.contains(document.activeElement)) [...content.querySelectorAll('a, button, summary')].find((node) => focusKey(node) === focused)?.focus({ preventScroll: true });
  // How fresh a merge check is, and whether its last fetch failed, is said on the row that uses it (a step, a result, a
  // Needs you item, Settings and Diagnostics), never page-wide (OWNER_WORKSPACE §7.4; aiworks#11 review F8).
  const warning = $('#source-warning');
  warning.hidden = state.supervisor.available;
  warning.textContent = state.supervisor.available ? '' : state.supervisor.message ?? '';
  $('#updated').textContent = `${state.host?.name ? `${state.host.name} · ` : ''}Checked ${timeOnly(state.observedAt)}`;
  // Which machine this is: each computer runs its own supervisor and campaigns.
  if (state.host) {
    // The page starts with a neutral "…" so it never names the wrong computer before the first answer.
    $('#host-name').textContent = `${state.host.name ?? 'Unknown computer'} · this computer`;
    $('#host-name').removeAttribute('aria-busy');
    const ver = state.host.version ?? DASHBOARD_VERSION;
    const verName = state.host.versionName ?? DASHBOARD_VERSION_NAME;
    const versionLabel = `v${ver} · ${verName}`;
    $('#host-detail').replaceChildren(routeLink(versionLabel, '#/settings/version', 'host-version-link'));
    // The revision stays in the host state for version checks, never in this human-facing tooltip.
    $('#host-detail').title = `Dashboard v${ver} "${verName}"`;
  }
  fitPreviewFrames();
}

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error), { known: true, detail: value.detail ?? null, code: value.code ?? null });
  return value;
}

async function deliver(payload, draftAddress = null, from = current.address) {
  sending = true; render();
  try {
    const result = await post('/api/commands', payload);
    notice(result.duplicate ? COMMANDS.duplicate : COMMANDS.accepted[payload.action], null, null, from);
    if (payload.action === 'instruct' && draftAddress) drafts.delete(draftAddress, `instruction:${payload.campaignId}`);
  } catch (error) {
    if (error.code === 'INSTRUCTION_LOOKS_SENSITIVE' && payload.action === 'instruct') return refuseInstruction(payload, error.message, draftAddress, from);
    // A refusal says what happened and what to do; the machine's reason is behind Details.
    notice(error.known ? error.message : COMMANDS.unconfirmed, error.known ? null : () => deliver(payload, draftAddress, from), error.known ? error.detail : null, from);
  } finally { sending = false; await poll(); }
}

// An instruction the credential filter refused: nothing was sent and the draft is kept. The dialog opens again with the
// draft and the reason beside the text; if the owner has moved on meanwhile, the reason is a notice instead (aiworks#61).
function refuseInstruction(payload, message, draftAddress, from) {
  const c = campaignById(payload.campaignId);
  if (!c || current.address !== draftAddress || document.querySelector('dialog[open]')) return notice(message, null, null, from);
  openInstructions(c);
  $('#instruction-refusal').textContent = message; $('#instruction-refusal').hidden = false;
  $('#instruction-text').setAttribute('aria-invalid', 'true');
}

function command(c, action, task, extra = {}, draftAddress = null) {
  // The refresh keeps a button that still shows the same, so the versions come from the state it shows now.
  c = campaignById(c.id) ?? c; task = task ? c.tasks.find((item) => item.id === task.id) ?? task : task;
  return deliver({ campaignId: c.id, action, requestId: crypto.randomUUID(), version: c.version,
    authorizationVersion: c.authorizationVersion, scopeDigest: c.scopeDigest,
    ...(task ? { taskId: task.id, taskVersion: task.version } : {}), ...extra }, draftAddress);
}

// How fresh this page's picture is: "Page connected · updated 4s ago", ticking every second, so a running AIWorks reads
// as running. It stays about this page (OWNER_WORKSPACE §3.4): a refresh that has not arrived for a while says so
// rather than going on looking current. "Live" stays reserved for release evidence (§2.3).
const STALE_MS = 20_000;
let freshAt = null;
function showFreshness() {
  const node = $('#connection');
  if (offline || freshAt === null) return;
  const seconds = Math.max(0, Math.round((Date.now() - freshAt) / 1000)), stale = Date.now() - freshAt > STALE_MS;
  const ago = seconds < 60 ? `${seconds}s ago` : timeAgo(freshAt);
  // The node is a status region: its words change only when the meaning does; the ticking age is hidden from it.
  const words = stale ? 'Page connected, but no update for a while' : 'Page connected';
  if (node.dataset.words !== words) {
    node.dataset.words = words;
    node.replaceChildren(el('span', {}, stale ? 'Page connected' : words), el('span', { class: 'fresh-age', 'aria-hidden': 'true' }));
    if (stale) node.firstChild.append(el('span', { class: 'sr-only' }, ', but no update for a while'));
  }
  node.querySelector('.fresh-age').textContent = ` · ${stale ? 'last update' : 'updated'} ${ago}`;
  node.className = `connection online${stale ? ' stale' : ' fresh'}`;
}
setInterval(showFreshness, 1000);

async function poll() {
  try {
    const response = await fetch(`/api/state?since=${since}`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error('state unavailable');
    // A dashboard that restarted while this page was offline has a new command session: take it before any command.
    if (offline) await refreshSession();
    state = await response.json(); offline = false;
    // The header keeps only "Page connected" or the disconnected text (OWNER_WORKSPACE §3.4, §7.4; aiworks#11 review F8):
    // it is about this page, never read as "AIWorks is running" (review 4 F6).
    freshAt = Date.now(); showFreshness();
    trackReceipts();
    // An open work list item is read again with every refresh, so a change shows and a stale draft says so.
    if (current.route.screen === 'worklist-item') void loadItem(current.route.number);
    if (current.route.screen === 'project-settings') void loadProjectSettings(current.route.project);
    if (current.route.screen === 'settings' && current.route.section === 'alerts') void loadAlerts();
    if (current.route.screen === 'knowledge') void loadKnowledge(current.route.project);
    if (current.route.screen === 'releases') void loadReleases(current.route.project);
    if (current.route.screen === 'settings' && current.route.section === 'usage') void loadUsage();
    checkCloseStale();
    if (!document.querySelector('dialog[open]')) render();
    $('#confirm-cancel').disabled = $('#send-instruction').disabled = $('#send-message').disabled = sending;
  } catch {
    offline = true; delete $('#connection').dataset.words; $('#connection').textContent = 'Disconnected · retrying · controls off'; $('#connection').className = 'connection offline';
    $('#confirm-cancel').disabled = $('#send-instruction').disabled = $('#send-message').disabled = true;
    checkCloseStale();
    if (state && !document.querySelector('dialog[open]')) render();
    else if (!state) $('#content').replaceChildren(empty('Dashboard connection unavailable', 'The page will retry automatically.'));
  }
}

// Moving never loses the owner's place (OWNER_WORKSPACE §3.3 and §13.3 T10; aiworks#11 review F5; UX-001 §8, preserve
// context). Opening a project from outside it returns to the screen that project was left on; its Now tab still opens
// Now. Every address, reached by a link, Back or Forward, returns to where it was left; one not opened yet starts at its
// top. The page keeps both for this tab itself, so the browser's own restoration is switched off.
const scrollMemory = new Map(), projectMemory = new Map();
try { history.scrollRestoration = 'manual'; } catch { /* the browser restores by itself */ }
function go(address, { restore = false } = {}) {
  scrollMemory.set(current.address, window.scrollY);
  let next = resolveRoute(address);
  if (next.replace) drafts.carry(address, next.address);
  const left = !restore && next.route.screen === 'project' && next.route.tab === 'overview' && !sameProject(next.route.project, current.route.project)
    ? projectMemory.get(next.route.project.toLowerCase()) : null;
  if (left) next = resolveRoute(left);
  if (!restore) history.pushState(null, '', next.address);
  else if (next.replace) history.replaceState(null, '', next.address);
  current = next;
  showRoute();
  window.scrollTo(0, scrollMemory.get(current.address) ?? 0);
  // Focus moves to the new screen's heading, so a screen reader starts there.
  $('#view-title').focus({ preventScroll: true });
}
// At narrow widths navigation is a bar fixed to the bottom of the window. Keyboard focus is kept above it, never under it
// (OWNER_WORKSPACE §6.2; aiworks#11 review F4); the stylesheet's scroll-padding does the same where the browser applies it.
// On wide screens the sidebar starts below the header; only a bar in the lower half of the viewport needs clearance.
const FOCUS_GAP = 8;
document.addEventListener('focusin', (event) => {
  const bar = $('.sidebar'), target = event.target;
  if (!bar || !target?.getBoundingClientRect || bar.contains(target) || target.closest?.('dialog')) return;
  const edge = bar.getBoundingClientRect().top, bottom = target.getBoundingClientRect().bottom;
  if (edge > window.innerHeight / 2 && bottom > edge - FOCUS_GAP) window.scrollBy(0, bottom - edge + FOCUS_GAP);
});
// Destinations are links. A plain click opens the address here; a click that asks for a new tab or window is left to the browser.
document.addEventListener('click', (event) => {
  const anchor = event.target.closest?.('a[href^="#/"]');
  if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (resolveRoute(anchor.getAttribute('href')).address !== current.address) go(anchor.getAttribute('href'));
});
// The Cancel and guidance dialogs, worded in the copy module.
$('#cancel-title').textContent = DIALOGS.cancelTitle; $('#cancel-text').textContent = DIALOGS.cancelText;
$('#keep-work').textContent = DIALOGS.cancelKeep; $('#confirm-cancel').textContent = DIALOGS.cancelConfirm;
$('#instruction-step-label').textContent = DIALOGS.guidanceStep;
// Why the last instruction was refused, beside the text it is about (aiworks#61).
$('#instruction-text').closest('label').append(el('span', { id: 'instruction-refusal', class: 'notice warning', role: 'alert', hidden: true }));
// The skip link moves focus to the content without changing the address.
$('.skip-link').addEventListener('click', (event) => { event.preventDefault(); $('#main').focus(); });
for (const selector of ['#search', '#track', '#status']) $(selector).addEventListener('input', () => { workLimit = 80; $('#clear-search').hidden = !$('#search').value; render(); });
$('#clear-search').addEventListener('click', () => { $('#search').value = ''; $('#clear-search').hidden = true; workLimit = 80; render(); $('#search').focus(); });
$('#confirm-cancel').addEventListener('click', () => { $('#cancel-dialog').close(); if (pendingCancel) void command(pendingCancel, 'cancel'); pendingCancel = null; });
$('#close-instruction').addEventListener('click', () => { saveDraft(); $('#instruction-dialog').close(); });
$('#instruction-dialog').addEventListener('cancel', saveDraft);
$('#instruction-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!validateForm($('#instruction-form'))) return;
  if (offline || sending) return;
  saveDraft();
  const task = instructionCampaign.tasks.find((t) => t.id === $('#instruction-task').value);
  $('#instruction-dialog').close();
  askNotifications();
  void command(instructionCampaign, 'instruct', task, { role: $('#instruction-role').value, text: $('#instruction-text').value }, instructionAddress);
});
// Drafts are saved as they are typed, so a reload never loses them.
for (const selector of ['#instruction-task', '#instruction-role', '#instruction-text']) $(selector).addEventListener('input', saveDraft);
$('#message-text').addEventListener('input', () => { messageDraft.text = $('#message-text').value; });
$('#close-message').addEventListener('click', () => { messageDraft.text = $('#message-text').value; $('#message-dialog').close(); });
$('#message-dialog').addEventListener('cancel', () => { messageDraft.text = $('#message-text').value; });
$('#message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!validateForm($('#message-form'))) return;
  if (offline || sending) return;
  const text = $('#message-text').value;
  messageDraft.text = text;
  $('#message-dialog').close();
  askNotifications();
  void sendMessage(text);
});

// The typed confirmation of the imported issues to close (UI20): Escape or Keep them open sends nothing.
$('#keep-imported').addEventListener('click', () => { pendingClose = null; $('#close-imported-dialog').close(); });
$('#close-imported-dialog').addEventListener('cancel', () => { pendingClose = null; });
$('#close-imported-form').addEventListener('submit', (event) => {
  event.preventDefault();
  checkCloseStale();
  const typed = $('#close-imported-typed');
  if (!pendingClose || $('#confirm-close-imported').disabled || !validateForm($('#close-imported-form'))) return;
  if (typed.value.trim().toLowerCase() !== pendingClose.repository) {
    $('#close-imported-stale').hidden = false;
    $('#close-imported-stale').textContent = `Type ${pendingClose.repository} exactly to confirm. Nothing was sent.`;
    typed.focus();
    return;
  }
  const { selection } = pendingClose;
  pendingClose = null;
  $('#close-imported-dialog').close();
  void sendWorklist('/api/work-list/close-imported', { typed: typed.value, selection }, { address: IMPORT_ADDRESS,
    done: () => drafts.delete(IMPORT_ADDRESS, 'unchecked') });
});
$('#close-remove-account').addEventListener('click', () => { pendingRemoveAccount = null; $('#remove-account-dialog').close(); });
$('#confirm-remove-account').addEventListener('click', async () => {
  const target = pendingRemoveAccount;
  pendingRemoveAccount = null;
  $('#remove-account-dialog').close();
  if (!target) return;
  try {
    await post('/api/accounts/remove', { provider: target.provider, name: target.name });
    notice(`Removed the saved login for ${target.label}.`);
    await poll();
  } catch (err) {
    notice(err.message ?? 'Could not remove the login.');
  }
});
/** Save one role's model order; an empty list clears it. */
async function saveModelOrder(key, models, kind) {
  const role = PREFERENCE_ROLES.find((item) => item.key === key);
  if (!role) return;
  try {
    await post('/api/accounts/preferences', { role: role.key, models, kind: models.length && kind ? kind : null });
    notice(models.length ? `Saved the model order for ${role.title}.` : `Cleared the saved order for ${role.title}.`);
    await poll();
  } catch (err) {
    notice(err.message ?? 'Could not save the model order.');
  }
}
$('#close-preference').addEventListener('click', () => $('#preference-dialog').close());
$('#clear-preference-button').addEventListener('click', () => {
  $('#preference-dialog').close();
  void saveModelOrder($('#preference-role').value, [], null);
});
$('#preference-form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('#preference-dialog').close();
  void saveModelOrder($('#preference-role').value, $('#preference-models').value.split(/[\s,]+/).filter(Boolean), $('#preference-kind').value);
});
// Our own navigation already set the address; any other change (Back, Forward, an edited address) restores that address's position.
window.addEventListener('hashchange', () => { if (location.hash !== current.address) go(location.hash, { restore: true }); });
// The visit ends when the page is hidden or closed; the next visit summarizes what changed after this point.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeLastSeen(); });
window.addEventListener('pagehide', writeLastSeen);
// An empty, legacy or unknown address is rewritten once, without a new history entry.
if (current.replace) { drafts.carry(location.hash, current.address); history.replaceState(null, '', current.address); }
showRoute();
async function refreshSession() { csrf = (await (await fetch('/api/session')).json()).csrf; }
try { await refreshSession(); } catch { notice('Command session unavailable. Reload when the dashboard reconnects.', null, null, null); }
await poll();
// One timed refresh at a time: while an answer is still on its way the next one is not asked for, so slow answers never
// queue up on the dashboard behind each other (aiworks#49). After a command the page still reads the state at once.
let refreshing = false;
setInterval(() => {
  if (sending || refreshing) return;
  refreshing = true;
  void poll().finally(() => { refreshing = false; });
}, 5000);
