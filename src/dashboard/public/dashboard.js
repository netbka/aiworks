import { formatRoute, globalOf, resolveRoute, tabOf } from '/router.mjs';
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
const deliveryNames = { merged: ['done', 'Merged'], published: ['attention', 'Published, merge not seen yet'], delegated: ['in_progress', DELEGATED.word],
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
  const text = `${purpose?.text ?? c.id}${purpose?.variant ? ` (${purpose.variant})` : ''}`;
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
const drafts = {
  get: (address, key) => readDrafts()[`${address} ${key}`] ?? null,
  set(address, key, value) { const all = readDrafts(); all[`${address} ${key}`] = value; writeDrafts(all); },
  delete(address, key) { const all = readDrafts(); delete all[`${address} ${key}`]; writeDrafts(all); },
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
        ? 'Enter a whole number of 1 or more.' : null;
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
const screenText = { home: ['Home', 'What changed, and what needs me?'], projects: ['Projects', 'Which project should I open?'], needs: ['Needs me', 'What is waiting for me, across projects?'],
  settings: ['Settings', 'What can AIWorks use on this computer?'], accounts: ['Worker accounts', 'Which AI worker logins and accounts are on this computer?'],
  version: ['Version and roadmap', 'Which capabilities are turned on in this version?'],
  instructions: ['Model instructions', 'Which AI models should handle what kind of work?'],
  messages: ['Messages', 'What did I ask AIWorks, and what did it answer?'],
  diagnostics: ['Diagnostics', 'What exactly did the machine record?'], now: ['Overview', 'Where is the current goal?'],
  connections: ['Connections', 'What does AIWorks use on this computer, and can it reach it?'],
  work: ['Work', 'What is running or waiting, and why?'], results: ['Results', 'What has been delivered, and what remains?'],
  cost: ['Cost', 'What did this cost?'], step: ['Step', 'What is happening on this step?'], start: ['Plan work', 'Describe the result. AIWorks proposes the steps.'],
  review: ['Review', 'Is this the right goal and limits?'], 'add-project': ['Add project', 'Which folder should AIWorks work on?'] };
const screenKey = (route) => route.screen === 'settings' ? route.section ?? 'settings' : route.screen === 'project' ? route.tab : route.screen;
const tabLabels = { now: 'Overview', work: 'Work', results: 'Results', cost: 'Cost' };

/** The frame for the current address: heading, page title, aria-current in the global bar and the project tabs. */
function showRoute() {
  const route = current.route, [title, question] = screenText[screenKey(route)];
  const project = route.project ?? null;
  $('#view-eyebrow').textContent = project ? `PROJECT · ${projectName(project).toUpperCase()}` : route.screen === 'settings' && route.section ? 'SETTINGS' : 'AIWORKS';
  $('#view-title').textContent = project && route.screen === 'project' && route.tab === 'now' ? projectName(project) : title;
  $('#view-description').textContent = question;
  $('#project-back').hidden = !project;
  document.title = [title, project ? projectName(project) : null, 'AIWorks'].filter(Boolean).join(' · ');
  const place = globalOf(route);
  for (const node of document.querySelectorAll('[data-global]')) {
    node.classList.toggle('active', node.dataset.global === place);
    if (node.dataset.global === place) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  }
  const messages = $('#messages-link');
  if (route.screen === 'settings' && route.section === 'messages') messages.setAttribute('aria-current', 'page'); else messages.removeAttribute('aria-current');
  // Project tabs are links, not an ARIA tablist: each has its own address.
  const tabs = $('#project-tabs'), tab = tabOf(route);
  tabs.hidden = !project;
  tabs.replaceChildren(...(project ? Object.entries(tabLabels).map(([id, label]) => el('a', { href: formatRoute({ screen: 'project', project, tab: id }),
    class: `tab${id === tab ? ' active' : ''}`, 'aria-current': id === tab && route.screen === 'project' ? 'page' : null }, label)) : []));
  if (project && route.screen === 'project') writeLastProject(project);
  // The screen this project was left on, so coming back to the project opens it again (go(); aiworks#11 review F5).
  if (project) projectMemory.set(project.toLowerCase(), current.address);
  $('#notice').hidden = !$('#notice').childNodes.length || noticeAddress !== null && noticeAddress !== current.address;
  $('#filters').hidden = !(route.screen === 'settings' && route.section === 'diagnostics');
  if (state) render();
}

// Today's summary cards, each on the screen that now answers it (OWNER_WORKSPACE §9): roadmap items on Diagnostics,
// Needs you on Needs me, agents working on a project's Work. Cost so far is the headline of a project's Cost tab (S7).
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
  // The Needs me count in the global bar: never zero while the supervisor state is unknown, and never final while a merge
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
const terminalLabels = { accepted: 'passed the check', rejected: 'rejected', resolved: 'built, waiting for the independent check', 'evidence-unavailable': 'could not gather required evidence', 'blocked-owner-reserved': 'blocked on a decision reserved for you' };
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
  if (!delivery && !task.blocked && task.waitingReason && task.state !== 'done') return badge('pending', /dependencies in main/.test(task.waitingReason) ? 'Waiting for merges' : 'Waiting');
  if (!delivery) return badge(task.blocked ? 'blocked' : task.state);
  const [cls, text] = deliveryNames[delivery.state] ?? ['unknown', delivery.state];
  return badge(cls, text);
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
function taskRow(c, task) {
  const canRecheck = !sending && !offline && state.supervisor.available && ['registered', 'paused'].includes(c.control) && Boolean(task.blocked || task.retryAt || task.errorClass) && task.state !== 'done';
  const last = task.state === 'done' ? null : outcomeText(task.lastOutcome);
  const delivery = deliveryOf(c, task);
  const td = (cls, ...children) => el('td', { class: cls }, ...children);
  return el('tr', { 'data-focus-scope': `${c.id}/${task.id}` }, td('c-id', el('span', { class: 'package-id' }, task.id)),
    td('c-work', link(task.outcome ?? task.title, task.issueUrl, 'task-name'), task.outcome ? el('div', { class: 'subtext' }, task.title) : null,
      el('div', { class: 'subtext' }, task.dependsOn.length ? `After ${task.dependsOn.join(', ')}` : 'Independent step')),
    td('c-state', stepBadge(c, task),
      delivery?.state === 'merged' && delivery.mergedAt ? el('div', { class: 'subtext' }, `Merged ${dateTime(delivery.mergedAt)}`)
        : delivery?.note ? el('div', { class: 'subtext' }, delivery.note) : null,
      delivery?.asOf ? el('div', { class: 'subtext' }, mergeAsOf(delivery.asOf)) : null,
      task.signature ? el('div', { class: 'subtext task-signature' }, formatTaskSignatureBrief(task.signature)) : null,
      // Supervisor-authored wait (for example, dependencies that must be merged first); never worker text.
      task.waitingReason && !task.blocked && task.state !== 'done' ? el('div', { class: 'subtext' }, task.waitingReason) : null,
      task.retryAt ? el('div', { class: 'subtext' }, `Next check ${timeOnly(task.retryAt)}`) : null,
      task.blockedReason ? el('div', { class: 'subtext' }, `Stopped: ${task.blockedReason}`) : null,
      !task.blocked && !task.waitingReason && task.state === 'pending' && task.dependsOn.some((dep) => c.tasks.find((item) => item.id === dep)?.state !== 'done')
        ? el('div', { class: 'subtext' }, `Waiting for ${task.dependsOn.filter((dep) => c.tasks.find((item) => item.id === dep)?.state !== 'done').join(', ')}`) : null,
      last ? el('div', { class: 'subtext' }, `Last: ${last}`) : null),
    td('c-tries', el('span', { class: 'number tries' }, plural(task.attempts, 'try', 'tries')), watchChip(task)),
    el('td', { class: 'table-actions c-action' }, task.resultUrl ? link(delivery?.number ? `Open PR #${delivery.number} ↗` : 'View result ↗', task.resultUrl)
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
      : 'There is no cost ceiling: work pauses only when an AI worker reports its own subscription or usage limit, and resumes after the reset. ',
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
  const steps = [receiptStep(true, 'Sent', `AIWorks received your request at ${clock(m.receivedAt)}`)];
  if (m.state === 'received') {
    steps.push(m.failure ? receiptStep(false, 'Retrying', `the last read ended without an answer (${outcomeLabels[m.failure] ?? m.failure}); next attempt ${dateTime(m.retryAt)}`, 'failed')
      : !coordinator.configured ? receiptStep(false, 'Not read', NOT_READ.receipt, 'failed')
        : coordinator.blocked ? receiptStep(false, 'Not read yet', 'AIWorks cannot read requests right now; why is under Needs me', 'failed')
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
  return el('article', { class: 'receipt' }, el('strong', {}, from), el('p', {}, m.text), el('ol', { class: 'receipt-steps' }, ...steps),
    m.replyBody ? disclosure(`message/${m.id}/reply`, 'Read the plan', el('pre', { class: 'coordinator-reply' }, m.replyBody)) : null);
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

function messagesPanel(limit) {
  const coordinator = state.supervisor.coordinator;
  if (!coordinator) return panel('Your messages to AIWorks', 'Not known right now', empty('Messages unavailable', state.supervisor.message ?? ''));
  const items = coordinator.messages.slice(0, limit);
  // Sending is offered only while something reads messages; otherwise the panel says so and what to do instead.
  return panel('Your messages to AIWorks', coordinator.configured
    ? `AIWorks reads them and changes nothing · replies stay in this dashboard · ${coordinator.runsToday}${coordinator.maxRunsPerDay === null ? '' : `/${coordinator.maxRunsPerDay}`} read in the last 24h${coordinator.blocked ? ' · not reading now; why is under Needs me' : ''}`
    : null,
  el('div', {}, notRead(coordinator), items.length ? el('div', { class: 'instruction-list' }, ...items.map((m) => messageReceipt(m, coordinator, state.supervisor.controller)))
    : empty('No messages yet', coordinator.configured ? 'Use “New message” to ask for a review or a plan.' : '')),
  coordinator.configured ? button('✉ New message', openMessage, 'link') : null);
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
      else if (now === 'answered') announce('Answered', item.replyBody ? 'The reply is ready in Messages.' : item.replyUrl ? 'The reply is posted.' : 'Check Messages for the reply.');
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

// The message box lives on Settings › Messages, so its draft is kept under that address.
const MESSAGES_ADDRESS = formatRoute({ screen: 'settings', section: 'messages' });
const messageDraft = {
  get text() { return drafts.get(MESSAGES_ADDRESS, 'message') ?? ''; },
  set text(value) { if (value) drafts.set(MESSAGES_ADDRESS, 'message', value); else drafts.delete(MESSAGES_ADDRESS, 'message'); },
};
function openMessage() {
  const coordinator = state?.supervisor.coordinator;
  $('#message-target').textContent = coordinator?.configured ? 'Replies stay in this dashboard. Nothing is posted to GitHub.' : `${NOT_READ.title} ${NOT_READ.text}`;
  $('#message-text').value = messageDraft.text;
  $('#message-dialog').showModal();
  $('#message-text').focus();
}

async function sendMessage(text) {
  sending = true; render();
  const requestId = crypto.randomUUID(), from = current.address;
  const attempt = async () => {
    try {
      const result = await post('/api/messages', { requestId, text });
      messageDraft.text = '';
      notice(result.duplicate ? 'This message was already received; it was not stored twice.' : `Sent · AIWorks received your request at ${clock(Date.now())}. You will see "Read" when AIWorks starts on it.`, null, null, MESSAGES_ADDRESS);
      if (current.address !== MESSAGES_ADDRESS) go(MESSAGES_ADDRESS);
    } catch (error) {
      notice(error.known ? error.message : 'Delivery could not be confirmed. Retry: the same message is never stored twice.', error.known ? null : attempt, null, from);
    }
  };
  try { await attempt(); } finally { sending = false; await poll(); }
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
    if (!plan || plan.code === 'DRAFTING') return el('p', { class: 'subtext' }, 'Sent · AIWorks is drafting a plan. Nothing changes yet. The plan appears here when it is ready.');
    if (plan.code === 'DRAFT_FAILED') return el('p', { class: 'subtext' }, 'AIWorks couldn’t draft a plan for this request. Ask again, or change the goal.');
    return el('p', { class: 'subtext' }, 'Your plan is ready. ', routeLink('Review the plan', { screen: 'review', project: plan.project, plan: plan.id }), '.');
  }
  const id = startDraft(address).sent, coordinator = state.supervisor.coordinator;
  if (!id || !coordinator) return null;
  const m = coordinator.messages.find((item) => item.id === id);
  return m ? messageReceipt(m, coordinator, state.supervisor.controller) : el('p', { class: 'subtext' }, 'Sent. Its receipt is under ', routeLink('Messages', MESSAGES_ADDRESS), '.');
}

function startScreen(project) {
  const address = formatRoute({ screen: 'start', project }), draft = startDraft(address), coordinator = state.supervisor.coordinator;
  // Plan and do is offered only where it can start: a connected GitHub project, or a project without GitHub whose rules
  // the owner confirmed, with drafting switched on (UI14, UI17).
  const doable = Boolean(state.work?.planAndDo && state.work.projects?.some((name) => sameProject(name, project)));
  // A project without GitHub plans through Plan and do only, from a description: it has no issues or pull requests.
  const local = Boolean(localProject(project));
  if (local && !doable) {
    return [empty('Confirm this project’s rules first.', state.work?.planAndDo ? 'You confirm them on its Now screen. Then you can ask for a plan here and approve it.'
      : 'Planning here is switched off in the AIWorks configuration file on this computer.'), routeLink('Open Now', { screen: 'project', project, tab: 'now' }, 'button secondary')];
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
const PLAN_WORDS = { DRAFTING: 'Drafting a plan', DRAFT_READY: 'Plan ready', PLAN_ONLY_READY: 'Plan ready (plan only)', CONFLICT: 'Overlaps other work',
  DRAFT_STALE: 'Plan out of date', DRAFT_FAILED: 'Couldn’t draft a plan', APPROVED: 'Approved' };
const projectPlans = (project) => (state.work?.plans ?? []).filter((plan) => sameProject(plan.project, project));
const approvedText = (at) => `Approved at ${clock(at)} · waiting for AIWorks to pick it up`;
let approving = null;

/** This project's plans, newest first, each with its state and a link to Review. */
function planRows(project) {
  const plans = projectPlans(project);
  if (!plans.length) return [];
  return [el('h2', {}, 'Plans for this project'), el('ul', { class: 'plan-list' }, ...plans.map((plan) => el('li', { 'data-focus-scope': `plan/${plan.id}` },
    routeLink(plan.outcome || 'A plan being drafted', { screen: 'review', project, plan: plan.id }),
    el('span', { class: 'subtext' }, ` · ${PLAN_WORDS[plan.code] ?? 'State unknown'}`))))];
}

function reviewScreen(project, id) {
  const plan = projectPlans(project).find((item) => item.id === id);
  const back = routeLink('Start work', { screen: 'start', project }, 'button secondary');
  if (!plan) return [empty('This plan is not on this computer', 'It may belong to another project, or the address is mistyped.'), back];
  if (!plan.version) {
    return [plan.code === 'DRAFT_FAILED' ? empty('AIWorks couldn’t draft a plan', 'Ask again from Start work, or change the goal.')
      : empty('AIWorks is drafting a plan', 'Nothing changes yet. This page shows the plan when it is ready.'), back];
  }
  const items = (values) => el('ul', {}, ...values.map((value) => el('li', {}, value)));
  const part = (title, ...body) => el('div', { class: 'review-part' }, el('h3', {}, title), ...body);
  const status = plan.code === 'APPROVED' ? el('p', { class: 'notice' }, approvedText(plan.approvedAt), ' · ', routeLink('Open Work', { screen: 'project', project, tab: 'work' }))
    : plan.code === 'DRAFT_STALE' ? el('p', { class: 'notice warning' }, `${projectName(project)} changed since this plan was drafted (${plan.staleWhat.join(', ') || 'its source changed'}). Draft it again before approving. `,
      routeLink('Plan again', { screen: 'start', project }))
      : plan.code === 'CONFLICT' ? el('p', { class: 'notice warning' }, 'This plan overlaps other work. Approve anyway and the overlapping step waits for it, or ask for a new plan without that step.')
        : el('p', {}, plan.planOnly ? 'This plan changes nothing yet. You can start it while the project stays as it is.' : 'Here’s what AIWorks would do, what it may change and how it will be checked.');
  const busy = approving === plan.id;
  const approve = el('button', { class: 'button', type: 'button', disabled: !plan.startable || Boolean(approving) || sending || offline || !state.supervisor.available,
    'aria-busy': busy ? 'true' : null, onclick: () => void approvePlan(project, plan) }, busy ? 'Starting…' : 'Approve and start');
  const limits = plan.limits && Object.keys(plan.limits).length ? `Limits: ${Object.entries(plan.limits).map(([key, value]) => `${key} ${value}`).join(', ')}.` : 'No limits. You can pause or cancel it at any time.';
  return [el('section', { class: 'panel review', 'data-focus-scope': `review/${plan.id}` }, el('div', { class: 'panel-body' },
    el('h2', {}, plan.outcome || 'Review the plan'), status,
    part('How it is checked', items(plan.acceptance)),
    part('Main steps', plan.steps.length ? el('ol', {}, ...plan.steps.map((step) => el('li', {}, step.title, step.check ? el('span', { class: 'subtext' }, ` · checked by: ${step.check}`) : null)))
      : items(plan.tasks.map((task) => task.title))),
    part('Overlaps with other work', plan.conflicts.length ? items(plan.conflicts.map((item) => item.code === 'DUPLICATE_WORK'
      ? `"${item.campaignId}" already does this step (${item.taskId}). Starting is refused until that work finishes or is cancelled.`
      : `"${item.campaignId}" is changing the same files (${item.taskId}). This step waits for it.`)) : el('p', {}, 'None found.')),
    part('What it may change', plan.writes.length ? items(plan.writes) : el('p', {}, 'No files: it only reports.'),
      plan.denyWrites.length ? el('p', { class: 'subtext' }, `Never: ${plan.denyWrites.join(', ')}`) : null),
    part('AI workers and limits', el('p', {}, plan.providers.length ? `Uses ${plan.providers.join(', ')}.` : 'AI workers: not stated.'), el('p', {}, limits)),
    part('Release', el('p', {}, plan.local ? 'Release: Review only. AIWorks stops when a result passes the check. Nothing in your folder changes until you press Apply on it, and Undo apply puts it back.'
      : 'Release: Review only. AIWorks stops when a result passes the check and is published. You merge and release.')),
    plan.questions.length ? part('Open questions', items(plan.questions)) : null,
    el('details', {}, el('summary', {}, 'Plan details'), el('p', { class: 'subtext' }, plan.summary), el('pre', { class: 'plan-text' }, plan.plan),
      el('p', { class: 'subtext' }, `Plan fingerprint ${plan.fingerprint} · version ${plan.version}`)),
    plan.code === 'APPROVED' ? null : approve))];
}

async function approvePlan(project, plan) {
  const from = current.address, requestId = crypto.randomUUID();
  approving = plan.id; render();
  const attempt = async () => {
    try {
      const result = await post('/api/work/approve', { requestId, plan: plan.id, version: plan.version, authorityDigest: plan.authorityDigest });
      const work = formatRoute({ screen: 'project', project, tab: 'work' });
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
  paused: 'Paused. Nothing new starts until it is resumed.', finished: 'All steps are finished. The checked results are under Results.', cancelled: 'Cancelled.' };
let applying = null;

function localResultRow(row) {
  const busy = applying !== null || sending || offline || !state.supervisor.available, key = `${row.campaignId}/${row.taskId}`;
  const press = row.action === 'apply' ? button(applying === key ? 'Applying…' : 'Apply', () => void pressApply(row, 'apply'), '', busy)
    : row.action === 'undo' ? button(applying === key ? 'Undoing…' : 'Undo apply', () => void pressApply(row, 'undo'), 'secondary', busy) : null;
  return el('li', { class: 'result-row', 'data-focus-scope': `local-result/${key}` },
    el('div', { class: 'needs-text' }, el('span', {}, row.title)),
    el('div', { class: 'result-state' }, row.state),
    el('p', { class: 'subtext local-text' }, row.text),
    row.files.length ? el('ul', { class: 'subtext local-text', 'aria-label': 'Files' }, ...row.files.map((file) => el('li', {}, file))) : null,
    press ? el('div', { class: 'needs-actions' }, press) : null);
}

/** Results of a project without GitHub: each step's checked result, with Apply or Undo apply. */
function localResultsScreen(project) {
  const rows = localWork(project).flatMap((c) => c.results);
  if (!rows.length) return [el('section', { class: 'panel' }, empty('No results yet.', 'Checked results appear here. Nothing in your folder changes until you press Apply on one.'))];
  return [el('section', { class: 'panel', 'aria-labelledby': 'results-title', 'data-focus-scope': `results/${project}` },
    el('div', { class: 'panel-header' }, el('h2', { id: 'results-title' }, plural(rows.length, 'result'))),
    el('ul', { class: 'needs-list' }, ...rows.map(localResultRow)))];
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
  const active = work.find((c) => !['finished', 'cancelled'].includes(c.control));
  const doable = Boolean(state.work?.planAndDo && state.work.projects?.some((name) => sameProject(name, row.id)));
  const plan = doable && !offline && state.supervisor.available ? routeLink('Plan work', { screen: 'start', project: row.id }, waiting ? 'button secondary' : 'button') : null;
  const line = waiting ? [el('strong', {}, 'All steps are finished.'), ` ${waiting === 1 ? 'A checked result is' : `${waiting} checked results are`} ready to apply. Nothing in your folder has changed yet.`]
    : active ? [el('strong', {}, `Working on: ${active.outcome}.`), ` ${LOCAL_CONTROL[active.control] ?? ''}`] : null;
  const head = line ? el('section', { class: 'panel', 'data-focus-scope': `now/${row.id}` }, el('div', { class: 'panel-body' },
    el('p', { role: 'status', 'aria-live': 'polite' }, ...line),
    waiting ? routeLink('See results', { screen: 'project', project: row.id, tab: 'results' }, 'button')
      : routeLink('Open Work', { screen: 'project', project: row.id, tab: 'work' }, 'button secondary'), plan)) : null;
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
        : item.outcome ? ` · ${item.outcome}` : ''), el('div', { class: 'timeline-subtext' }, item.operation ?? item.campaignId)),
    el('time', { class: 'timeline-time', datetime: new Date(item.at).toISOString(), title: dateTime(item.at) }, timeAgo(item.at)))));
}

/** "Since you last looked": merged, delivered, newly waiting for you, failed or rejected runs, and AIWorks' own problems apart. */
function sinceSummary() {
  const recent = state.owner?.recent;
  if (!recent) return null;
  const when = previousVisit ? `Since you last looked (${dateTime(previousVisit)})` : 'In the last 24 hours';
  const prs = (list) => list.filter((item) => item.url).map((item) => link(`#${item.number} ↗`, item.url));
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
const campaignContext = (id) => { const c = campaignById(id); return c ? campaignTitle(c) : id; };
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
  return panel(`Finished work (${list.length})`, 'Most recent first. Each line says where that work’s results stand.',
    el('div', { class: 'finished-list' }, ...list.map((c) => el('div', { class: 'finished-row', 'data-focus-scope': c.id },
      el('div', { class: 'row-line' }, el('strong', { class: 'finished-title' }, campaignTitle(c)), link(`tracking issue #${c.trackingIssue ?? ''} ↗`, c.trackingUrl)),
      el('div', { class: 'subtext' }, ownerCampaign(c)?.outcome ?? (c.control === 'cancelled' ? 'Cancelled' : 'All steps are finished')),
      disclosure(`${c.id}/finished-steps`, `See all ${plural(c.tasks.length, 'step')}`, stepsTable(c))))));
}

/** When the merge check behind a step is not current, or its last fetch failed: when it is from, and what happens next. */
const mergeAsOf = (check) => `Merge check from ${!check.at ? 'an unknown time' : new Date(check.at).toDateString() === new Date().toDateString() ? timeOnly(check.at) : dateTime(check.at)}; ${
  check.reason === 'fetch-failed' ? 'the last fetch failed, retrying within 5 minutes' : 'checking again'}`;

/** One Needs me row: what to do, then the subject (what the step delivers) with its link, then the evidence in one line. */
const needsItem = (item) => el('li', { class: `needs-item ${item.kind}` },
  el('div', { class: 'needs-body' },
    el('div', { class: 'needs-context' }, [item.about ? `Project ${projectName(item.about)}` : null,
      item.campaignId ? campaignContext(item.campaignId) : null].filter(Boolean).join(' · ')),
    item.action ? el('div', { class: 'needs-action' }, item.action) : null,
    el('div', { class: 'needs-text' }, el('span', {}, `${item.text}${item.at ? ` at about ${timeOnly(item.at)}` : ''}${item.since ? ` since ${timeOnly(item.since)}` : ''}`)),
    item.mergeCheck ? el('div', { class: 'needs-stale' }, mergeAsOf(item.mergeCheck)) : null,
    item.link ? el('div', { class: 'needs-actions' }, link(`${item.link.label} ↗`, item.link.url, 'button secondary needs-link')) : null,
    item.evidence ? disclosure(`needs/${item.link?.url ?? item.text}`, el('span', { class: 'evidence' }, item.evidence),
      el('p', { class: 'needs-detail' }, item.detail)) : null),
  // The Check again a stopped work's sentence names is on its card, after that sentence: a card has no More menu (aiworks#11 review 5 G8).
  item.points.length || item.command ? el('div', { class: 'needs-impact' }, ...item.points.map((point) => el('div', { class: 'needs-point' },
    point.link ? link(`${point.link.label} ↗`, point.link.url, 'needs-link') : null, el('span', {}, point.text))),
    item.command ? el('div', { class: 'needs-actions' }, primaryAction(item.command)) : null) : null);

/**
 * One Needs me group (OWNER_WORKSPACE S3): a project, named and linked to its own screen, or "AIWorks itself" (always
 * last), with its count and its items in today's order.
 */
const needsGroup = (group) => el('section', { class: 'needs-group', 'aria-labelledby': `needs-group-${group.key}`, 'data-focus-scope': `needs/${group.key}` },
  el('h3', { id: `needs-group-${group.key}`, class: 'section-title' }, group.project ? routeLink(group.name, { screen: 'project', project: group.project }) : group.name, NEEDS.groupCount(group.count, group.notCounted)),
  el('ul', { class: 'needs-list' }, ...group.items.map(needsItem)));

/** Needs me: what is waiting for the owner, grouped by project, in plain words, each with the link to act on. */
function needsYou() {
  const owner = state.owner;
  if (!owner?.available) return null;
  const { headline, count, groups = [], held = [], unknownResults: unknown, reply } = owner;
  // aiworks#18: a stopped supervisor leads, with the time it last renewed its leases, unless the one item for AIWorks
  // stopped already says it with its time (one fact, once; review 4 F2).
  const controller = state.supervisor.controller;
  const said = owner.items.some((item) => item.kind === 'controller' && !item.system);
  return el('section', { class: `needs${count || held.length ? '' : unknown ? ' checking' : ' calm'}`, 'aria-labelledby': 'needs-title' },
    controller?.stopped && !said ? el('p', { class: 'needs-stopped' }, NEEDS.banner(controller.lastLeaseRenewalAt, { dateTime }, controller.stopRequested)) : null,
    el('div', { class: 'needs-head' }, el('h2', { id: 'needs-title' }, headline),
      unknown ? el('span', { class: 'needs-unknown' }, `Merge of ${unknown} published step${unknown === 1 ? '' : 's'} being checked`) : null),
    // Only owner actions here (owner, 2026-10-13): posted reports and merged work ready for release are on Results.
    ...groups.map(needsGroup),
    // Projects held up by the owner's decisions: no work is blocked, so they are not counted, but each is named with a
    // link to its Now, which says which decisions (aiworks#11 review 5 G7).
    held.length ? el('ul', { class: 'needs-list', 'data-focus-scope': 'needs/held' }, ...held.map((project) => el('li', {},
      el('strong', {}, project.name), ` · ${project.text} `, routeLink(`Open ${project.name}`, { screen: 'project', project: project.id })))) : null,
    reply ? el('div', { class: 'needs-reply' }, `AIWorks answered your message (${dateTime(reply.answeredAt)}). `,
      reply.url ? link('Read its “What needs you” ↗', reply.url) : routeLink('Read the plan', MESSAGES_ADDRESS)) : null);
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
    cell(task.resultUrl ? link(delivery?.number ? `PR #${delivery.number} ↗` : 'Report ↗', task.resultUrl) : el('span', { class: 'muted' }, 'Not published yet'))));
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
    waiting || checking ? routeLink('Open Needs me →', { screen: 'needs' }, waiting ? 'button' : 'button secondary') : null);
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
  const form = el('form', { class: 'panel-body start-form add-form', 'data-add-form': 'add', 'data-focus-scope': 'add-project',
    onsubmit: (event) => { event.preventDefault(); void checkFolder(); } },
    el('label', { class: 'field' }, el('strong', {}, 'Folder path'), path,
      el('span', { class: 'subtext', id: 'add-path-hint' }, 'Type or paste the full path of a folder on this computer, for example D:\\Projects\\my-app. AIWorks only reads it to check what it is.')),
    el('button', { class: `button${ready ? ' secondary' : ''}`, type: 'submit', disabled: busy }, 'Check folder'),
    area,
    ready ? el('button', { class: 'button', type: 'button', 'data-connect': 'connect', disabled: busy, onclick: () => void connectFolder() }, 'Connect project') : null,
    draft.outcome?.code === 'PROJECT_MOVED' ? button('Connect as a new project', () => void connectFolder({ asNewProject: true }), 'secondary', busy) : null);
  return [el('section', { class: 'panel' }, form)];
}

/** The 5-second refresh keeps the Add project form as typed: only its buttons follow the connection. False when it must be built. */
function refreshAdd(content) {
  const form = content.querySelector('form[data-add-form]');
  if (!form || !state.projects?.addProject || !state.supervisor.available) return false;
  for (const node of form.querySelectorAll('button')) node.disabled = Boolean(addBusy) || offline;
  return true;
}
/** Build the Add project form again from its draft, and keep the owner where the answer is. */
function rebuildAdd({ focus = false } = {}) {
  document.querySelector('form[data-add-form]')?.remove();
  render();
  if (focus) $('#add-result')?.focus({ preventScroll: true });
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
      addBusy = null;
      await poll();
      go(formatRoute({ screen: 'project', project: result.project.route }));
      // The project's Now leads with what it can do, so the notice does not say that a second time (review 5 G2).
      notice(result.ok ? [`Connected "${result.project.name}".`, ...(result.notices ?? []).filter((item) => item.code !== 'LOCAL_START_OFF').map((item) => item.message)].join(' ')
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

function accountsSection(accounts = []) {
  return el('div', { class: 'accounts-section' },
    el('div', { class: 'panel-header' }, el('h3', {}, 'Logins and usage'), routeLink('Manage on separate page →', '#/settings/accounts')),
    accountRows(accounts));
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
        el('p', { class: 'subtext' }, 'Completed steps display model signatures (name, type, effort, and tokens) on the Step and Results screens.')))));

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
  'result-ready': 'Result ready for your review', merged: 'Merged', built: 'Builder finished a run', checked: 'Passed the independent check',
  'check-rejected': 'The independent checker asked for changes', 'run-failed': 'An AI worker run did not finish; AIWorks retries by itself',
  'limit-wait': 'Waiting for an AI worker limit', 'wait-ended': 'An AI worker can take work again', 'needs-you': 'Needs me',
  'decision-cleared': 'A question for you was cleared', 'aiworks-problem': 'AIWorks had a problem of its own' };
// The order of the one-line summary: what the owner acts on first.
const EVENT_ORDER = ['needs-you', 'result-ready', 'merged', 'checked', 'check-rejected', 'paused', 'resumed', 'goal-started', 'cancelled',
  'limit-wait', 'wait-ended', 'run-failed', 'aiworks-problem', 'built', 'decision-cleared'];
const SUMMARY_WORDS = { 'needs-you': 'new for you', 'result-ready': 'ready for review', merged: 'merged', checked: 'passed the check',
  'check-rejected': 'sent back by the checker', paused: 'paused', resumed: 'resumed', 'goal-started': 'started', cancelled: 'cancelled',
  'limit-wait': 'limit waits', 'wait-ended': 'waits ended', 'run-failed': 'runs retried', 'aiworks-problem': 'AIWorks problems', built: 'builder runs',
  'decision-cleared': 'questions cleared' };

let scopedBusy = null, seenBusy = false;
const goalName = (id) => { const c = campaignById(id); return c ? campaignTitle(c, { inProject: true }) : id; };

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
    el('span', { class: 'subtext' }, [eventProject(event), event.campaignId ? goalName(event.campaignId) : null, event.taskId ? `step ${event.taskId}` : null].filter(Boolean).join(' · ')),
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

/** Home: one line since the last visit (the server-side marker), the decision first, each project in one sentence, all work's pause. */
function homeScreen() {
  const home = state.home;
  if (!state.supervisor.available || !home?.available) return [unavailable()];
  const { since, lastSeen } = home;
  const counts = EVENT_ORDER.filter((type) => since.counts[type]).map((type) => `${since.counts[type]} ${SUMMARY_WORDS[type]}`);
  const when = lastSeen.at ? `Since your last visit (${dateTime(lastSeen.at)})` : 'Everything AIWorks recorded so far';
  const changed = el('section', { class: 'since', 'aria-labelledby': 'home-since-title', 'data-focus-scope': 'home/since' },
    el('h2', { id: 'home-since-title' }, when),
    el('p', { role: 'status', 'aria-live': 'polite' }, counts.length ? `${counts.join(' · ')}${since.more ? ', and more' : ''}.` : 'Nothing changed.'),
    since.events.length ? disclosure('home/events', `What changed (${since.more ? `latest ${since.events.length}` : since.events.length})`, eventList(since.events)) : null,
    since.count ? button(seenBusy ? 'Marking…' : 'Mark as seen', markSeen, 'secondary small', seenBusy || offline) : null);
  const first = state.owner?.items?.[0];
  const decision = panel('Needs me', home.needsYou.count ? 'The first decision; the rest are in Needs me.' : null, el('div', { class: 'panel-body', 'data-focus-scope': 'home/needs' },
    home.needsYou.count && first ? el('ul', { class: 'needs-list' }, needsItem(first)) : el('p', {}, 'Nothing needs you right now.'),
    home.needsYou.count > 1 ? routeLink(`All ${home.needsYou.count} in Needs me`, '#/needs', 'button secondary small') : null));
  const projects = home.projects.length
    ? el('ul', { class: 'settings-links home-projects' }, ...home.projects.map((project) => el('li', { 'data-focus-scope': `home/project/${project.id}`, 'data-state': project.state.key },
      routeLink(project.name, { screen: 'project', project: project.id, tab: 'now' }, 'task-name'), el('div', { class: 'subtext' }, project.state.text ?? 'Not known right now.'))))
    : empty('No projects yet.', 'Projects appear here when the AIWorks configuration file on this computer lists a repository.');
  return [changed, decision,
    panel('Projects', 'Each project in one sentence.', el('div', { class: 'panel-body' }, projects)),
    panel('All work', 'Pause stops new steps everywhere; steps already running finish and are recorded. Resume all resumes only what Pause all paused.',
      el('div', { class: 'panel-body' }, pauseControls(home.pause, 'all', {}, { label: 'all work' })))];
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
    goal.next ? el('div', { class: 'subtext' }, `Next: ${clockTimes(goal.next)}`) : null,
    el('div', { class: 'campaign-controls' }, goal.control === 'registered'
      ? button(busy ? 'Pausing…' : 'Pause goal', () => scopedControl('pause', 'goal', [goal.binding], { campaignId: goal.id }), 'secondary small', commandsOff())
      : button(busy ? 'Resuming…' : 'Resume goal', () => scopedControl('resume', 'goal', [goal.binding], { campaignId: goal.id }), 'small', commandsOff())));
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
const TRUST_WORDS = { TRUSTED: 'Trusted', MAIN_REWRITTEN: 'Local main was rewound or rewritten: no new work starts until it is fixed',
  NO_ANCHOR: 'Not known: local trust has no starting point recorded yet', UNREADABLE: 'Not known: local main cannot be read on this computer' };
const BACKUP_WORDS = { off: 'Off', none: 'On, not tried yet', pushing: 'Sending now', pushed: 'Sent', refused: 'Refused by the backup', failed: 'Could not reach the backup' };

function trustedMainLines(trusted) {
  if (!trusted) return [el('p', {}, 'Not known right now: AIWorks could not read its records.')];
  if (trusted.mode === 'origin') return [el('p', {}, 'Trusted main: GitHub’s main of each project. AIWorks’s own code runs only when GitHub’s main contains it.'),
    trusted.problem ? el('p', { class: 'subtext' }, 'The self-hosting setting is not valid, so GitHub’s main stays trusted.') : null];
  const backup = trusted.backup;
  return [el('p', {}, `Trusted main of ${trusted.repository}: local main on this computer. ${TRUST_WORDS[trusted.state] ?? 'Not known'}${trusted.tip ? ` at ${trusted.tip.slice(0, 7)}` : ''}.`),
    Number.isSafeInteger(trusted.unrecordedCount) && trusted.unrecordedCount > 0
      ? el('p', { class: 'subtext' }, `Main has ${plural(trusted.unrecordedCount, 'commit')} AIWorks did not put there; ${trusted.unrecordedCount === 1 ? 'it is' : 'they are'} not trusted.`) : null,
    el('p', { class: 'subtext' }, `Backup to ${backup.remote} ${backup.branch}: ${BACKUP_WORDS[backup.state] ?? 'Not known'}${backup.at ? ` (${clock(backup.at)})` : ''}${
      backup.enabled && backup.state === 'pushed' ? backup.current ? '; it has the trusted tip' : '; it is behind the trusted tip' : ''}${
      backup.nextAttemptAfter && ['refused', 'failed', 'pushing'].includes(backup.state) ? `; next try after ${clock(backup.nextAttemptAfter)}` : ''}. Nothing waits for the backup.`)];
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
        : el('p', {}, 'No AI worker account is set up on this computer.'))),
    panel('Merge checks', 'Where each project’s merges are seen from. The dashboard never calls GitHub’s API.', el('div', { class: 'panel-body' }, merges)),
    panel('Trusted main and backup', 'The version AIWorks’s own code must be part of before it starts or resumes work.', el('div', { class: 'panel-body' }, ...trustedMainLines(view.trustedMain).filter(Boolean)))];
}

function settingsScreen() {
  const host = state.host ?? {};
  const ver = host.version ?? DASHBOARD_VERSION;
  const verName = host.versionName ?? DASHBOARD_VERSION_NAME;
  const currentVer = DASHBOARD_VERSIONS.find((v) => v.version === ver || v.status === 'current') ?? DASHBOARD_VERSIONS[DASHBOARD_VERSIONS.length - 2];
  const computer = panel('This computer', 'Each computer runs its own AIWorks. This page shows only this one.', el('div', { class: 'panel-body' },
    el('p', {}, `${host.name ?? 'Unknown computer'} · Dashboard v${ver} (${verName}) · revision ${host.revision?.slice(0, 7) ?? 'unknown'}`),
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
  const active = state.supervisor.campaigns.filter((c) => !['finished', 'cancelled'].includes(c.control));
  const workers = panel('AI workers', `Once for ${host.name ?? 'this computer'}, whatever the work.`, el('div', {},
    accountsSection(settings.accounts ?? []),
    el('ul', { class: 'settings-links' }, ...settings.workers.map((w) => {
      const { text, notes } = workerLine(w);
      return el('li', { 'data-focus-scope': `worker/${w.kind}` }, el('strong', {}, text), ...notes.map((note) => el('div', { class: 'subtext' }, note)));
    })),
    // Details: provider order per piece of work and the supervisor version running it.
    active.length ? disclosure('settings/workers', 'Details', el('ul', { class: 'settings-links' }, ...active.map((c) => el('li', {}, el('strong', {}, campaignTitle(c)),
      el('div', { class: 'subtext' }, `Tried in this order: ${c.executors.map(provider).join(' → ')}`),
      el('div', { class: 'subtext' }, `Supervisor version ${c.controllerRevision ? String(c.controllerRevision).slice(0, 7) : 'not known (not running)'}`))))) : null,
    el('p', { class: 'subtext' }, `Commands set in the AIWorks configuration file on this computer: ${settings.commands.length ? settings.commands.join(', ') : 'none'}.`)));
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
    el('li', {}, routeLink('Worker accounts', '#/settings/accounts'), el('div', { class: 'subtext' }, 'Each AI worker login on this computer, and whether it can take work now.')),
    el('li', {}, routeLink('Worker accounts', '#/settings/accounts'), el('div', { class: 'subtext' }, 'Connect and manage isolated worker logins, view live quota usage, and export encrypted bundles.')),
    el('li', {}, routeLink('Model instructions', '#/settings/instructions'), el('div', { class: 'subtext' }, 'Which AI models should handle what kind of work, by role, domain and reasoning effort.')),
    el('li', {}, routeLink('Version and roadmap', '#/settings/version'), el('div', { class: 'subtext' }, `Dashboard v${DASHBOARD_VERSION} (${DASHBOARD_VERSION_NAME}), active features and pre-1.0 roadmap.`)),
    el('li', {}, routeLink('Messages', '#/settings/messages'), el('div', { class: 'subtext' }, 'What you asked AIWorks, and what it answered.')),
    el('li', {}, routeLink('Diagnostics', '#/settings/diagnostics'), el('div', { class: 'subtext' }, 'The full activity journal, every step with its issue and pull request, the roadmap of the platform that keeps your project rules, and how fresh each merge check is.'))));
}

/**
 * The one primary action of a state (OWNER_WORKSPACE §4.4), or nothing: a screen link, a GitHub link, Resume, or the
 * Check again of work a recorded blocker stopped, each only while the work allows it.
 */
function primaryAction(primary) {
  if (!primary) return null;
  if (primary.route) return routeLink(primary.label, primary.route, 'button');
  if (primary.url) return link(`${primary.label} ↗`, primary.url, 'button');
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
    el('ul', {}, ...view.since.map((line) => el('li', { class: line.tone ?? '' }, `${line.text} `, ...line.links.map((item) => link(`${item.label} ↗`, item.url)))))) : null;
  // The work as AIWorks names it, in owner words: no "campaign" where "work" will do (aiworks#11 review 5 G13).
  const others = details.others.map((item) => item.purpose ? `${item.purpose} (known to AIWorks as ${item.id})` : item.id);
  // What else goes on in the project stays in view, whatever leads (aiworks#11 review 5 G5): a pause carries its Resume.
  const also = view.also?.length ? el('section', { 'aria-labelledby': `now-also-${project}` },
    el('h3', { id: `now-also-${project}`, class: 'section-title' }, 'Also in this project'),
    el('ul', { class: 'settings-links' }, ...view.also.map((line) => {
      const c = line.primary ? campaignById(line.primary.campaignId) : null;
      return el('li', { 'data-state': line.kind }, line.text, ' ',
        c?.controls?.primary === 'resume' ? button(line.primary.label, () => command(c, 'resume'), 'secondary', commandsOff()) : null);
    }))) : null;
  return [el('section', { class: 'panel', 'data-focus-scope': `now/${project}` }, el('div', { class: 'panel-body' },
    goal ? el('p', { class: 'eyebrow' }, goal) : null,
    el('p', { role: 'status', 'aria-live': 'polite', 'data-state': now.key }, el('strong', {}, now.title), now.text ? ` ${now.text}` : ''),
    primaryAction(now.primary), startWork, also,
    view.progress ? el('p', { class: 'subtext' }, view.progress) : null,
    view.note ? el('p', { class: 'subtext' }, `${view.note.title} ${view.note.text}`) : null,
    details.workId || others.length ? disclosure(`now/${project}/details`, 'Details', el('div', { class: 'subtext' }, [
      details.workId ? `Known to AIWorks as ${details.workId}` : null, details.trackingUrl ? link(`tracking issue #${details.trackingIssue} ↗`, details.trackingUrl) : null,
      others.length ? `Other work in this project: ${others.join(', ')}` : null].filter(Boolean).flatMap((part, index) => index ? [' · ', part] : [part]))) : null)),
  overviewPanel(project), row?.connection ? connectionPanel(row) : null, since].filter(Boolean);
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
 * Step (OWNER_WORKSPACE §4.8, slice S5): the outcome with its work's goal and project; one state and who is on it;
 * progress from the worker's own record; the last result; guidance sent, with receipts; one primary action by state;
 * and, in Details, every attempt with its end and the step's own events.
 */
function stepScreen(project, c, task) {
  const agent = c.agents.find((item) => item.taskId === task.id), p = agent?.progress;
  const number = deliveryOf(c, task)?.number ?? /\/pull\/(\d+)$/.exec(task.resultUrl ?? '')?.[1];
  const unfinished = !['done', 'verified'].includes(task.state);
  const primary = task.stopped ? primaryAction(task.stopped.primary)
    : task.resultUrl ? link(number ? `Open pull request #${number} ↗` : 'Open the result ↗', task.resultUrl, 'button')
      : unfinished && c.controls?.more.length ? button('Send guidance', () => openInstructions(c, task), '', commandsOff()) : null;
  const last = task.verifiedSha ? `Passed the check at commit ${task.verifiedSha.slice(0, 7)}` : outcomeText(task.lastOutcome);
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
      task.stopped && canCheckAgain(c, task) ? el('div', { class: 'campaign-controls' }, primary, button('Check again', () => command(c, 'recheck', task), 'secondary', commandsOff())) : primary,
      guidance.length ? el('div', { class: 'instruction-list' }, el('h3', { class: 'section-title' }, 'Guidance you sent'), ...guidance.map((item) => instructionReceipt(item, c))) : null,
      disclosure(`step/${c.id}/${task.id}/details`, `Details · ${plural(attempts.length, 'attempt')}`, el('div', {},
        attempts.length ? el('ol', { class: 'receipt-steps' }, ...attempts.map((a) => el('li', {}, attemptText(a), a.id ? el('div', { class: 'subtext' }, `Run ${a.id}`) : null)))
          : el('p', { class: 'subtext' }, 'No attempt has run yet.'),
        activityList(30, events),
        el('p', { class: 'subtext' }, `Step ${task.id} · campaign ${c.id} · `, link('step issue ↗', task.issueUrl))))))];
}

/** One Results row: what the step delivers, its state word, what follows, the link to the result and the check in details. */
const resultRow = (row) => el('li', { class: `result-row ${row.group}`, 'data-focus-scope': `${row.campaignId}/${row.taskId}` },
  el('div', { class: 'needs-text' }, el('span', {}, row.text), row.link ? link(`${row.link.label} ↗`, row.link.url, 'needs-link') : null),
  // A merged row says when, then the project's release rule: never released or live.
  el('div', { class: 'result-state' }, row.group === 'merged' ? [`Merged${row.mergedAt ? ` ${dateTime(row.mergedAt)}` : ''}.`, row.release].join(' ') : row.word),
  row.note ? el('div', { class: 'subtext' }, row.note) : null,
  row.ladder ? releaseLadder(row.ladder) : null,
  row.asOf ? el('div', { class: 'needs-stale' }, mergeAsOf(row.asOf)) : null,
  row.evidence ? disclosure(`results/${row.campaignId}/${row.taskId}`, el('span', { class: 'evidence' }, row.evidence),
    el('p', { class: 'needs-detail' }, row.detail)) : null,
  row.signature ? el('div', { class: 'subtext task-signature' }, formatTaskSignatureBrief(row.signature)) : null,
  el('div', { class: 'subtext' }, campaignContext(row.campaignId)));

/** The five release steps of one result, each Yes, No, In progress or Unknown, never one tick (AUTO_RELEASE.md section 1). */
const releaseLadder = (ladder) => el('div', { class: 'release-ladder' },
  el('ul', { 'aria-label': `Release steps${ladder.sha ? ` of commit ${ladder.sha}` : ''}` }, ...ladder.steps.map((step) => el('li', { class: `ladder-${step.answer}` }, step.text))),
  ladder.note ? el('div', { class: 'subtext' }, ladder.note) : null);

/**
 * Results (OWNER_WORKSPACE §4.9, slice S6): the project's finished steps grouped by state in the owner view's order,
 * with "Review pull request #N" for the oldest waiting review as the one primary action.
 */
function resultsScreen(project) {
  const results = state.owner?.results?.[String(project).toLowerCase()];
  if (!state.owner?.available) return unavailable();
  // The §7.1 empty copy, from the copy module through the owner view.
  if (!results?.groups.length) return el('section', { class: 'panel' }, empty(state.owner.noResults.title, state.owner.noResults.text));
  return el('section', { class: 'panel', 'aria-labelledby': 'results-title', 'data-focus-scope': `results/${project}` },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', { id: 'results-title' }, `${plural(results.total, 'result')}, grouped by state`)),
      results.primary ? link(`${results.primary.label} ↗`, results.primary.url, 'button') : null),
    ...results.groups.map((group) => el('section', { class: 'needs-group', 'aria-labelledby': `results-group-${group.key}` },
      el('h3', { id: `results-group-${group.key}`, class: 'section-title' }, `${group.title} (${group.count})`),
      el('ul', { class: 'needs-list' }, ...group.rows.map(resultRow)))),
    // Stop all releases is reachable from every project's Results (AUTO_RELEASE.md section 9).
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
 * A project's Cost tab (OWNER_WORKSPACE §4.10, slice S7). First what finished work reported, with work not finished yet
 * counted apart (costSummary) and the runs that reported no cost counted apart; then "See the breakdown": per piece of work and per step,
 * its runs, reported cost, unreported runs, retries and checker rejections. No primary action.
 */
function costScreen(project, all) {
  const total = state.supervisor.costs?.find((item) => sameProject(item.repository, project));
  // Nothing has run: the §7.1 copy, which the server takes from the state copy module.
  if (!total) return [unavailable()];
  if (total.empty) return [empty(total.empty.title, total.empty.text)];
  const { headline, lines } = costSummary(all, (c) => ownerCampaign(c)?.counts.delivered ?? 0);
  if (costRunsLine(total)) lines.push(costRunsLine(total));
  const work = (c) => el('section', { class: 'panel', 'data-focus-scope': `cost/${c.id}` },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', {}, campaignTitle(c)),
      el('p', {}, `${plural(c.runsUsed, 'run')} · ${costText({ runs: c.runsUsed, ...c.cost })}`),
      unitCostText(c.costByUnit) ? el('p', { class: 'subtext' }, `Tokens and dollars, each counted on its own: ${unitCostText(c.costByUnit)}`) : null)),
    el('div', { class: 'steps' }, table(['Step', 'Runs', 'Cost', 'Retries', 'Checker rejections'], runOrder(c).map((task) => el('tr', { 'data-focus-scope': `cost/${c.id}/${task.id}` },
      el('td', { class: 'c-work' }, routeLink(task.outcome ?? task.title, { screen: 'step', project, work: c.id, step: task.id }, 'task-name'),
        ...[modelsText(task.routing), movedUpText(task.routing)].filter(Boolean).map((text) => el('div', { class: 'subtext' }, text))),
      cell(String(stepRuns(task.cost))), cell(costText(task.cost), unitCostText(task.costByUnit) ? el('div', { class: 'subtext' }, unitCostText(task.costByUnit)) : null),
      cell(String(task.cost.retries)), cell(String(task.cost.checkerRejections)))))),
    costNotes(c).body);
  return [el('section', { class: 'panel' }, el('h2', {}, headline), ...lines.map((line) => el('p', {}, line))),
    disclosure(`cost/${project}`, 'See the breakdown', el('div', {}, ...all.map(work)))];
}

/** One project's screens. Campaign cards, step tables and costs are today's, limited to this project. */
function projectScreen(route) {
  const project = route.project, all = projectCampaigns(project);
  // Now from the state copy module, for a project this computer knows (or while its state cannot be read).
  if (route.screen === 'project' && route.tab === 'now' && (offline || !state.supervisor.available || all.length ||
    projectList().some((item) => sameProject(item.id, project)))) return nowScreen(project);
  if (!state.supervisor.available) return [unavailable()];
  if (route.screen === 'start' && (all.length || projectList().some((item) => sameProject(item.id, project)))) {
    const plans = planRows(project);
    return plans.length ? [...startScreen(project), el('section', { class: 'panel' }, el('div', { class: 'panel-body', id: 'start-plans' }, ...plans))] : startScreen(project);
  }
  if (route.screen === 'review') return reviewScreen(project, route.plan);
  // A project without GitHub: its Work and Results come from the work view; never a pull request (UI17). Earlier work and
  // results stay reachable after its rules are revoked, so an applied result can still be undone.
  const local = localProject(project);
  if (local && route.screen === 'project') {
    if (route.tab === 'cost') return [empty('Not shown here yet.', 'The cost of work in a project without GitHub is not added up on this page yet.')];
    if (!localWork(project).length && !local.connection?.startWork.allowed) return [empty('No work yet.', local.connection?.startWork.text ?? '')];
    return route.tab === 'results' ? localResultsScreen(project) : localWorkScreen(project);
  }
  // A connected project where work cannot start says what its Now says, never a reason that is not its own (review 5 G2).
  const cannot = !all.length ? projectList().find((item) => sameProject(item.id, project) && item.connection && !item.connection.startWork.allowed) : null;
  if (cannot) return [empty('No work yet.', cannot.connection.startWork.text)];
  // A repository this computer's settings list, with no work yet (OWNER_WORKSPACE §7.1). Starting work here is not built yet.
  if (!all.length && projectList().some((item) => sameProject(item.id, project))) return [empty('No work yet.', `Work in ${projectName(project)} appears here once it is registered on this computer. Starting work from this page is not built yet.`)];
  if (!all.length) return [empty('This project has no work on this computer', 'The address may be mistyped, or its work was removed.'), routeLink('All projects', '#/projects', 'button secondary')];
  const layout = campaignLayout(), mine = (list) => list.filter((c) => sameProject(c.repository, project));
  // Campaigns with something for the owner and active ones get cards; finished ones are one line each, under Results.
  const cards = mine(layout.cards), finished = mine(layout.finished);
  if (route.screen === 'step') {
    const c = all.find((item) => item.id === route.work), task = c?.tasks.find((item) => item.id === route.step);
    if (!task) return [empty('This step is not recorded for this project', 'It may belong to another project, or the address is mistyped.'), routeLink('All work in this project', { screen: 'project', project, tab: 'work' }, 'button secondary')];
    return stepScreen(project, c, task);
  }
  if (route.tab === 'work') {
    return [...cards.map((c) => workPanel(project, c)), cards.some((c) => c.agents.length) ? verdictExplanation() : null,
      cards.some((c) => !['finished', 'cancelled'].includes(c.control)) ? providerNote() : null,
      cards.length ? null : empty('Nothing is running or waiting in this project', 'Finished work is under Results.')].filter(Boolean);
  }
  if (route.tab === 'results') return [resultsScreen(project), finishedList(finished)].filter(Boolean);
  if (route.tab === 'cost') return costScreen(project, all);
  return cards.length ? [...cards.map((c) => campaignCard(c, false))] : [empty('No work is running in this project', 'Finished work and its results are under Results.')];
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
  const content = $('#content'), route = current.route;
  const focusKey = (node) => JSON.stringify([node.closest('[data-focus-scope]')?.dataset.focusScope, node.tagName, node.getAttribute('href'), node.textContent]);
  const focused = content.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  const diagnostics = route.screen === 'settings' && route.section === 'diagnostics';
  renderMetrics(route.project ? projectCampaigns(route.project) : state.supervisor.campaigns, diagnostics ? ['Platform roadmap items']
    : route.screen === 'project' && route.tab === 'work' ? ['AI workers working'] : []);
  if (route.screen === 'home') patch(content, homeScreen());
  else if (route.screen === 'needs') patch(content, [needsYou() ?? unavailable()]);
  else if (route.screen === 'settings' && route.section === 'connections') patch(content, connectionsScreen());
  else if (route.screen === 'settings' && route.section === 'messages') patch(content, [messagesPanel(20)]);
  else if (route.screen === 'settings' && route.section === 'accounts') patch(content, accountsScreen());
  else if (route.screen === 'settings' && route.section === 'version') patch(content, versionScreen());
  else if (route.screen === 'settings' && route.section === 'instructions') patch(content, modelInstructionsScreen());
  else if (diagnostics) patch(content, [trackOverview(), roadmapView(), workView(), mergeChecksPanel(), projectWaitsPanel(),
    panel('Execution journal', 'Latest 80 events · raw agent transcripts and secrets are never shown', activityList())].filter(Boolean));
  else if (route.screen === 'settings') patch(content, settingsScreen());
  else if (route.screen === 'add-project' && refreshAdd(content)) { /* the form stays as the owner typed it */ }
  else if (route.screen === 'add-project') patch(content, addProjectScreen());
  else if (route.screen === 'start' && refreshStart(content, route.project)) { /* the form stays as the owner typed it */ }
  else if (route.project) patch(content, projectScreen(route));
  else patch(content, projectsScreen());
  // Focus stays where it was; only when its element was replaced does it move to the one that took its place.
  if (focused && !content.contains(document.activeElement)) [...content.querySelectorAll('a, button, summary')].find((node) => focusKey(node) === focused)?.focus({ preventScroll: true });
  // How fresh a merge check is, and whether its last fetch failed, is said on the row that uses it (a step, a result, a
  // Needs me item, Settings and Diagnostics), never page-wide (OWNER_WORKSPACE §7.4; aiworks#11 review F8).
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
    $('#host-detail').title = `Dashboard v${ver} "${verName}" (revision ${state.host.revision?.slice(0, 7) ?? 'unknown'})`;
  }
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

async function poll() {
  try {
    const response = await fetch(`/api/state?since=${since}`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error('state unavailable');
    state = await response.json(); offline = false;
    // The header keeps only "Page connected" or the disconnected text (OWNER_WORKSPACE §3.4, §7.4; aiworks#11 review F8):
    // it is about this page, never read as "AIWorks is running" (review 4 F6).
    $('#connection').textContent = 'Page connected';
    $('#connection').className = 'connection online';
    trackReceipts();
    if (!document.querySelector('dialog[open]')) render();
    $('#confirm-cancel').disabled = $('#send-instruction').disabled = $('#send-message').disabled = sending;
  } catch {
    offline = true; $('#connection').textContent = 'Disconnected · controls disabled'; $('#connection').className = 'connection offline';
    $('#confirm-cancel').disabled = $('#send-instruction').disabled = $('#send-message').disabled = true;
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
  const left = !restore && next.route.screen === 'project' && next.route.tab === 'now' && !sameProject(next.route.project, current.route.project)
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
if (current.replace) history.replaceState(null, '', current.address);
showRoute();
try { csrf = (await (await fetch('/api/session')).json()).csrf; } catch { notice('Command session unavailable. Reload when the dashboard reconnects.', null, null, null); }
await poll();
setInterval(() => { if (!sending) void poll(); }, 5000);
