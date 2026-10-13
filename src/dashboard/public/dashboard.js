import { formatRoute, globalOf, resolveRoute, tabOf } from '/router.mjs';
// The state copy of OWNER_WORKSPACE §7 and the Now screen (slice S4); the server serves src/dashboard/copy.mjs here.
import { COMMANDS, DIALOGS, NEEDS, costRunsLine, nowView, workLine } from '/copy.mjs';

const $ = (selector) => document.querySelector(selector);
const names = { done: 'Done', blocked: 'Blocked', unknown: 'Unknown',
  pending: 'Not started', implementing: 'Being built', implemented: 'Waiting for the independent check', verifying: 'Being checked', verified: 'Checked; publishing',
  recent: 'Working', stale: 'No recent sign of life' };
const provider = (kind) => ({ 'claude-cli': 'Claude', 'codex-cli': 'Codex', 'cursor-cli': 'Cursor Agent', 'agy-cli': 'AGY (Antigravity) browser' })[kind] ?? 'Unknown AI provider';
// Owner-facing role names: the agent that builds a step, and the separate agent that checks it.
const roleName = (role) => ({ Verifier: 'Independent checker', Implementer: 'Builder', verify: 'independent checker', implement: 'builder' })[role] ?? role;
// What a finished step means for the owner: merged into the project (seen in local git), or published with its merge
// not seen yet. The line under it (what it means for the owner, or why the merge is not seen) is `delivery.note`.
const deliveryNames = { merged: ['done', 'Merged'], published: ['attention', 'Published, merge not seen yet'],
  'report-posted': ['done', 'Report posted'], unknown: ['unknown', 'Result not known'] };
const CHURN_ATTEMPTS = 5;
const STUCK_MINUTES = 15;
const ownerCampaign = (c) => state.owner?.campaigns?.[c.id] ?? null;
const deliveryOf = (c, task) => ownerCampaign(c)?.deliveries?.[task.id] ?? null;
const shortRepo = (repository) => repository?.split('/')[1] ?? repository ?? '';
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const usd = (value) => `$${value.toFixed(2)}`;
const campaignTitle = (c) => {
  const purpose = ownerCampaign(c)?.purpose;
  return `${shortRepo(c.repository)}: ${purpose?.text ?? c.id}${purpose?.variant ? ` (${purpose.variant})` : ''}`;
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

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
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
const panel = (title, description, body, action) => el('section', { class: 'panel' },
  el('div', { class: 'panel-header' }, el('div', {}, el('h2', {}, title), description ? el('p', {}, description) : null), action ?? null), body);
const table = (headers, rows) => el('div', { class: 'table-scroll' }, el('table', {},
  el('thead', {}, el('tr', {}, ...headers.map((text) => el('th', { scope: 'col' }, text)))), el('tbody', {}, ...rows)));
const cell = (...children) => el('td', {}, ...children);
const notice = (text, retry, detail = null) => {
  const node = $('#notice'); node.hidden = false;
  node.replaceChildren(document.createTextNode(text));
  if (retry) node.append(button(COMMANDS.retry, retry, 'secondary small'));
  if (detail) node.append(el('details', {}, el('summary', {}, COMMANDS.details), el('p', { class: 'subtext' }, detail)));
};

/** A link to another screen of this page: a real link, so it opens in a new tab and Back works. */
const routeLink = (text, route, cls = '') => el('a', { href: typeof route === 'string' ? route : formatRoute(route), class: cls }, text);
const projectName = (project) => shortRepo(project) || project;
// Each screen's heading and the one question it answers (OWNER_WORKSPACE §3.1).
const screenText = { projects: ['Projects', 'Which project should I open?'], needs: ['Needs me', 'What is waiting for me, across projects?'],
  settings: ['Settings', 'What can AIWorks use on this computer?'], messages: ['Messages', 'What did I ask AIWorks, and what did it answer?'],
  diagnostics: ['Diagnostics', 'What exactly did the machine record?'], now: ['Now', 'Where are we now?'],
  work: ['Work', 'What is running or waiting, and why?'], results: ['Results', 'What has been delivered, and what remains?'],
  cost: ['Cost', 'What did this cost?'], step: ['Step', 'What is happening on this step?'], start: ['Start work', 'What should AIWorks do?'],
  review: ['Review', 'Is this the right goal and limits?'], 'add-project': ['Add project', 'Which folder should AIWorks work on?'] };
const screenKey = (route) => route.screen === 'settings' ? route.section ?? 'settings' : route.screen === 'project' ? route.tab : route.screen;
const tabLabels = { now: 'Now', work: 'Work', results: 'Results', cost: 'Cost' };

/** The frame for the current address: heading, page title, aria-current in the global bar and the project tabs. */
function showRoute() {
  const route = current.route, [title, question] = screenText[screenKey(route)];
  const project = route.project ?? null;
  $('#view-eyebrow').textContent = project ? `PROJECT · ${projectName(project).toUpperCase()}` : route.screen === 'settings' && route.section ? 'SETTINGS' : 'AIWORKS';
  $('#view-title').textContent = project && route.screen === 'project' && route.tab === 'now' ? projectName(project) : title;
  $('#view-description').textContent = question;
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
  $('#filters').hidden = !(route.screen === 'settings' && route.section === 'diagnostics');
  if (state) render();
}

// Today's summary cards, each on the screen that now answers it (OWNER_WORKSPACE §9): roadmap items on Diagnostics,
// Needs you on Needs me, agents working on a project's Work. Cost so far is the headline of a project's Cost tab (S7).
function renderMetrics(campaigns = state.supervisor.campaigns, shown = []) {
  const entries = state.roadmap.entries;
  const agents = campaigns.flatMap((c) => c.agents);
  // Everything listed under "Needs you": owner reviews, decisions, stopped work, a stopped supervisor and an unreadable
  // inbox. A pause by itself is not listed: the campaign card shows it.
  // A published step whose merge is still being checked is never counted as nothing.
  // "Nothing" is only about what blocks on the owner: reports to read and releases are named after it.
  const owner = state.owner ?? { items: [], unknownResults: 0, also: null }, attention = owner.items.length, unknown = owner.unknownResults;
  const available = state.supervisor.available;
  const verdicts = agents.map((agent) => agentVerdict(agent)[0]);
  const metrics = [
    ['Platform roadmap items', entries.length, null, 'Definitions from the governance checkout; progress is tracked on GitHub', '☷'],
    ['Agents working', available ? agents.length : '—', null, !available ? 'Supervisor unavailable'
      : agents.length ? `${verdicts.filter((v) => v === 'recent').length} working normally${verdicts.some((v) => v === 'stale') ? ` · ${verdicts.filter((v) => v === 'stale').length} possibly stuck or not started` : ''}` : 'None right now', '◎'],
    ['Needs you', !available ? '—' : unknown && !attention ? '?' : attention, available && unknown && attention ? '+ ?' : null,
      !available ? 'Execution state unknown'
        : `${attention ? `${plural(attention, 'item')} listed below` : unknown ? 'Nothing confirmed yet' : 'Nothing is blocked on you'}${unknown ? ` · merge of ${plural(unknown, 'published step')} being checked` : ''}${owner.also ? ` · also ${owner.also.short}` : ''}`, '◈'],
  ];
  $('#metrics').replaceChildren(...metrics.filter(([title]) => shown.includes(title)).map(([title, value, total, foot, icon]) => el('div', { class: 'metric' },
    el('div', { class: 'metric-title' }, title, el('span', { class: 'metric-icon', 'aria-hidden': 'true' }, icon)),
    el('div', { class: 'metric-value number' }, String(value), total ? el('small', {}, total) : null), el('div', { class: 'metric-foot' }, foot))));
  $('#metrics').hidden = !shown.length;
  // The Needs me count in the global bar: never zero while the supervisor state is unknown.
  $('#needs-count').textContent = !state.supervisor.available ? '?' : attention ? String(attention) : unknown ? '?' : '';
}

// Engineering Platform's own roadmap (read from the governance checkout), kept apart from project campaigns; display names replace internal track labels.
const trackNames = { 'Product control plane': 'Control plane: first release', 'Product · next': 'Control plane: after the first release',
  'Autonomous governance': 'Portfolio rules rollout', 'Tracked extensions': 'Other tracked platform work' };
function governanceMissing() {
  const governance = state.roadmap.governance;
  return governance && governance.configured === false ? empty('Governance checkout not configured', governance.reason ?? 'Set governanceRoot in the supervisor config.json or start the dashboard with --governance <path>.') : null;
}
function trackOverview() {
  const missing = governanceMissing();
  if (missing) return panel('Engineering Platform roadmap', 'Read from the Engineering Platform governance checkout.', missing);
  // Definitions only: the dashboard does not read GitHub, so it shows no progress for these items.
  const rows = [...new Set(state.roadmap.entries.map((entry) => entry.track))].map((track) => {
    const list = state.roadmap.entries.filter((item) => item.track === track);
    return el('div', { class: 'track-row' }, el('div', { class: 'row-line' }, el('span', { class: 'track-name' }, trackNames[track] ?? track), el('span', { class: 'track-count number' }, plural(list.length, 'item'))));
  });
  return panel('Engineering Platform roadmap', 'The platform’s own work toward its product, the project control plane. This is separate from your projects. Its progress is tracked on GitHub, not read here.',
    el('div', { class: 'panel-body' }, ...rows));
}

/** A plain verdict per running agent: working normally, possibly stuck, starting or not started. */
function agentVerdict(agent) {
  const last = agent.progress?.lastActivityAt ?? agent.outputAt ?? null;
  const minutes = last ? Math.max(0, Math.floor((Date.now() - last) / 60_000)) : null;
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

/** How the verdicts are decided, shown once rather than on every card. */
const verdictExplanation = () => el('details', { class: 'explain' }, el('summary', {}, 'How “working normally” is decided'),
  el('div', { class: 'notes' }, `Working normally: the agent's own record shows a turn or action in the last ${STUCK_MINUTES} minutes, or, for an agent that reports only at the end, its runner is still alive. `,
    `Possibly stuck: no progress for ${STUCK_MINUTES} minutes or more. Not started: no sign of life 5 minutes after it was scheduled. `,
    'Counts come from the agent’s own session record; its prompts and output are never shown here.'));

/** Shown once per page: what provider waits mean and what they never do. */
const providerNote = () => el('div', { class: 'notes' }, 'Provider account balances are not queried: a provider failure is observed evidence, not a measured balance. ',
  'Switching to the next AI provider never overrides a permission denial',
  state.supervisor.campaigns.some((c) => c.maxWorkerRuns !== null) ? ' or raises the run limit of a piece of work.' : '.');

function providerStatus(c) {
  const labels = { running: 'In use now', idle: 'Not in use', cooldown: 'Waiting', unavailable: 'Unavailable',
    'retry-due': 'Retry due', 'not-configured': 'Not used by this campaign' };
  const host = state.host?.name ?? 'this computer';
  return el('div', { class: 'panel-body' },
    el('p', {}, `${plural(c.agents.length, 'agent')} working · ${c.slots} at a time allowed. AI providers are tried in this order.`),
    el('div', { class: 'agents-grid' }, ...(c.providers ?? []).map((p) => el('article', { class: 'agent-card' },
      // A provider that cannot run on this machine at all is not "waiting": say so instead of offering a retry.
      el('strong', {}, `${p.priority ? `${p.priority}. ` : ''}${provider(p.kind)} — ${p.priority && p.hostLimit ? `Not available on ${host}` : labels[p.state]}`),
      p.priority && p.hostLimit ? el('div', { class: 'subtext' }, `No action needed: the campaign runs without it on ${host}. ${p.hostLimit}.`)
        : p.retryAt ? el('div', { class: 'subtext' }, p.retryAt > Date.now() ? `No action needed — retries automatically at ${timeOnly(p.retryAt)}.`
          : `Overdue: the retry was due at ${timeOnly(p.retryAt)}; it happens at the supervisor's next check.`) : null,
      p.reason ? el('div', { class: 'subtext' }, p.credits ? 'Reported exhausted credits or a billing limit.'
        : p.reason === 'quota' ? 'Reported a usage or rate limit.' : `Last failure: ${p.reason}.`) : null,
      p.availabilityReason ? el('div', { class: 'subtext' }, p.availabilityReason) : null,
      p.priority && !p.hostLimit && p.roleLimit ? el('div', { class: 'subtext' }, `Can check and report on ${host}, but cannot build code there.`) : null))));
}

// What the worker actually returned. "result" only means a valid response arrived; the verdict inside decides.
const terminalLabels = { accepted: 'passed the check', rejected: 'rejected', resolved: 'built, waiting for the independent check', 'evidence-unavailable': 'could not gather required evidence', 'blocked-owner-reserved': 'blocked on a decision reserved for you' };
const outcomeLabels = { unavailable: 'AI provider unavailable (run not counted)', quota: 'provider limit', auth: 'provider authentication', timeout: 'timed out', lost: 'runner lost', 'invalid-result': 'invalid result', 'exit-without-result': 'exited without a result', 'spawn-failed': 'could not start', error: 'failed',
  'reply-withheld': 'reply withheld because it looked like it contained a credential (it was not posted)',
  'boundary-violation': 'the agent changed its checkout or the live runtime; nothing it produced was posted' };
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

/** A remembered open/closed disclosure (survives the 5-second refresh). */
const disclosure = (key, summary, body, openByDefault = false) => el('details', { open: opened.has(key) || openByDefault && !opened.has(`${key}:closed`),
  ontoggle: (event) => { if (event.target.open) { opened.add(key); opened.delete(`${key}:closed`); } else { opened.delete(key); opened.add(`${key}:closed`); } } }, el('summary', {}, summary), body);

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
      // Supervisor-authored wait (for example, dependencies that must be merged first); never worker text.
      task.waitingReason && !task.blocked && task.state !== 'done' ? el('div', { class: 'subtext' }, task.waitingReason) : null,
      task.retryAt ? el('div', { class: 'subtext' }, `Next check ${timeOnly(task.retryAt)}`) : null,
      task.blockedReason ? el('div', { class: 'subtext' }, `Stopped: ${task.blockedReason}`) : null,
      !task.blocked && !task.waitingReason && task.state === 'pending' && task.dependsOn.some((dep) => c.tasks.find((item) => item.id === dep)?.state !== 'done')
        ? el('div', { class: 'subtext' }, `Waiting for ${task.dependsOn.filter((dep) => c.tasks.find((item) => item.id === dep)?.state !== 'done').join(', ')}`) : null,
      last ? el('div', { class: 'subtext' }, `Last: ${last}`) : null),
    td('c-tries', el('span', { class: 'number tries' }, plural(task.attempts, 'try', 'tries')), watchChip(task)),
    el('td', { class: 'table-actions c-action' }, task.resultUrl ? link(delivery?.number ? `Open PR #${delivery.number} ↗` : 'View result ↗', task.resultUrl)
      : button('Recheck', () => command(c, 'recheck', task), 'secondary small', !canRecheck)));
}
const stepsTable = (c) => el('div', { class: 'steps' }, table(['Step', 'What it delivers', 'Where it stands', 'Tries', ''], c.tasks.map((task) => taskRow(c, task))));

/** "8 of 9 steps delivered · 5 merged · 3 waiting for your review": progress in the owner's terms, plus a phone-length form. */
function deliverySummary(c) {
  const counts = ownerCampaign(c)?.counts;
  const delivered = counts?.delivered ?? c.tasks.filter((task) => task.state === 'done').length;
  const parts = [`${delivered} of ${plural(c.tasks.length, 'step')} delivered`];
  if (counts?.merged) parts.push(`${counts.merged} merged`);
  if (counts?.awaiting) parts.push(`${counts.awaiting} waiting for your review`);
  if (counts?.reports) parts.push(`${plural(counts.reports, 'report')} for you to read`);
  if (counts?.checking) parts.push(`merge of ${counts.checking} being checked`);
  if (counts?.unknown) parts.push(`${counts.unknown} without a recorded result`);
  return { delivered, text: parts.join(' · '), short: `${delivered}/${c.tasks.length} done${counts?.awaiting ? ` · ${counts.awaiting} for you` : ''}` };
}

/** Why the campaign controls are off, so a disabled button is never silent. */
function controlsNote(c) {
  if (!state.supervisor.available) return 'Controls are off: the supervisor state is unavailable right now.';
  if (offline) return 'Controls are off: this page lost its connection to the dashboard.';
  if (sending) return 'Sending your command…';
  return { finished: 'Controls are off: every step of this work is finished.', cancelled: 'Controls are off: this work was cancelled.',
    'cancel-requested': 'Controls are off: cancellation is in progress.' }[c.control] ?? null;
}

/** The work's state in one sentence, in owner words (the copy module), with liveness reconciled with the agents' own records. */
const campaignNext = (c) => workLine(c, ownerCampaign(c), { time: timeOnly, dateTime });

const livenessNames = { running: 'Supervisor running', late: 'Supervisor checking in late', 'awaiting-pickup': 'Waiting for the supervisor',
  'agent-working-supervisor-silent': 'Agent working · supervisor silent', stopped: 'Supervisor not running' };
/** The supervisor's state for one campaign; a paused campaign reads neutral, whatever the supervisor is doing. */
function livenessBadge(c, liveness) {
  if (liveness === 'finished') return null;
  // Neutral while a supervisor holds it (or is only late); a paused campaign with no supervisor is not calm.
  if (c.control === 'paused') return badge(['running', 'late', 'awaiting-pickup'].includes(liveness) ? 'unknown' : 'stale', `${livenessNames[liveness] ?? 'Supervisor state unknown'} · campaign paused`);
  return badge(liveness === 'running' ? 'recent' : ['late', 'awaiting-pickup'].includes(liveness) ? 'pending' : 'stale', livenessNames[liveness]);
}

/** Runs, cost and the provider order of one campaign: detail on its card, and the body of the project's Cost tab. */
function costNotes(c) {
  // Unknown cost is "not reported", never $0.00.
  const budget = c.budget, unreported = (budget?.unknownCostRuns ?? 0) + c.agents.length;
  const cost = c.recordedCostUsd > 0 ? `${usd(c.recordedCostUsd)} reported${unreported ? ` + ${plural(unreported, 'run')} not reported yet` : ''}` : 'cost not reported yet';
  return { cost, body: el('div', { class: 'notes' }, `AI providers in order of preference: ${c.executors.map(provider).join(' → ')}. `,
    c.maxWorkerRuns === null ? `${plural(c.runsUsed, 'run')}; this campaign has no run limit. ` : `${c.runsUsed} of ${plural(c.maxWorkerRuns, 'run')} allowed. `,
    `Cost: ${cost}. `,
    budget?.maxCostUsd ? `${usd(budget.chargedCostUsd)} of the ${usd(budget.maxCostUsd)} ceiling is used, counting each unreported run at ${usd(budget.unknownRunCostUsd)}. `
      : 'There is no cost ceiling: work pauses only when an AI provider reports its own subscription or usage limit, and resumes after the reset. ',
    'Pause stops new work from starting. Recheck asks the supervisor to look again; it never skips the independent check.') };
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
    el('button', { class: 'button secondary small', onclick: () => command(c, 'recheck'), disabled: !controllable, title: note }, '↻ Recheck'),
    el('button', { class: 'button text-danger small', disabled: !controllable, title: note, onclick: () => askCancel(c) }, 'Cancel…'));
  const owner = ownerCampaign(c), summary = deliverySummary(c);
  const liveness = owner?.liveness ?? (c.controllerLive ? 'running' : 'stopped');
  const progress = el('progress', { max: c.tasks.length || 1, value: summary.delivered, 'aria-label': 'Campaign steps delivered' });
  const title = el('div', { class: 'campaign-heading' }, el('div', { class: 'row-line' },
    el('div', {}, el('div', { class: 'campaign-title' }, el('h2', {}, campaignTitle(c)), livenessBadge(c, liveness)),
      el('div', { class: 'campaign-meta' }, `Campaign ${c.id} · `, link(`tracking issue #${c.trackingIssue ?? ''}`, c.trackingUrl))),
    terminal ? null : el('div', {}, controls, note ? el('div', { class: 'controls-note' }, note) : null)));
  const card = el('section', { class: 'panel', 'data-focus-scope': c.id }, title, el('div', { class: 'campaign-banner' }, el('div', {}, el('strong', {}, campaignNext(c)),
    c.blocker && c.blockerAction ? el('div', { class: 'subtext' }, `What to do: ${c.blockerAction}`) : null),
  el('div', { class: 'campaign-progress' }, progress, el('span', { class: 'long' }, summary.text), el('span', { class: 'short' }, summary.short))));
  // Provider detail matters only while the campaign can still start agents.
  if (expanded) card.append(...(terminal ? [] : [providerStatus(c)]), disclosure(`${c.id}/agent-steps`, `See all ${plural(c.tasks.length, 'step')}`, stepsTable(c)));
  else card.append(disclosure(c.id, `See all ${plural(c.tasks.length, 'step')}`, stepsTable(c)));
  const { cost, body } = costNotes(c);
  card.append(disclosure(`${c.id}/costs`, `Runs, cost and AI providers · ${plural(c.runsUsed, 'run')} · ${cost}`, body));
  if (c.instructions?.length) card.append(disclosure(`${c.id}/instructions`, `Your instructions to agents (${c.instructions.length})`,
    el('div', { class: 'instruction-list' }, ...c.instructions.map((item) => instructionReceipt(item, c)))));
  return card;
}

/** A step named by what it delivers, for receipts and notices: never its ID. */
const stepName = (campaignId, taskId) => { const task = campaignById(campaignId)?.tasks.find((t) => t.id === taskId); return task ? `“${task.outcome ?? task.title}”` : 'this step'; };

function instructionReceipt(item, c) {
  const role = roleName(item.role), step = stepName(c.id, item.taskId);
  const steps = [
    receiptStep(true, 'Received', `stored by the supervisor ${dateTime(item.at)}`),
    item.status === 'attached' ? receiptStep(true, 'Read', `by the ${role} (${provider(item.executor)}) ${dateTime(item.attachedAt)}; it is in that agent's instructions`)
      : item.status === 'queued' ? receiptStep(false, 'Waiting', `delivered to the next ${role} run of ${step}; a running AI worker is not interrupted`)
        : receiptStep(false, 'Not delivered', item.status === 'outdated' ? 'the approved goal or limits changed before an AI worker ran' : 'no further run of this step is scheduled', 'failed'),
    item.status === 'attached' ? receiptStep(item.runState === 'finished', item.runState === 'finished' ? 'Agent finished' : 'Agent working',
      item.runState === 'finished' ? `outcome: ${terminalLabels[item.runOutcome] ?? outcomeLabels[item.runOutcome] ?? item.runOutcome ?? 'unknown'}` : 'its result will appear here') : null,
  ];
  return el('article', { class: 'receipt' }, el('strong', {}, `${step} · ${role}`), el('p', {}, item.text), el('ol', { class: 'receipt-steps' }, ...steps));
}

function receiptStep(done, label, detail, tone) {
  return el('li', { class: `receipt-step ${tone ?? (done ? 'done' : 'pending')}` }, el('span', { class: 'receipt-mark', 'aria-hidden': 'true' }, tone === 'failed' ? '!' : done ? '✓' : '…'),
    el('span', {}, el('strong', {}, label), ` · ${detail}`));
}

function messageReceipt(m, coordinator) {
  const steps = [receiptStep(true, 'Received', `stored by the supervisor ${dateTime(m.receivedAt)}`)];
  if (m.state === 'received') {
    steps.push(m.failure ? receiptStep(false, 'Retrying', `the last read ended without an answer (${outcomeLabels[m.failure] ?? m.failure}); next attempt ${dateTime(m.retryAt)}`, 'failed')
      : !coordinator.configured ? receiptStep(false, 'Not read', coordinator.configError ? `the coordinator configuration is invalid: ${coordinator.configError}` : 'no coordinator agent is configured on this supervisor', 'failed')
        : coordinator.blocked ? receiptStep(false, 'Not read yet', coordinator.blocked, 'failed')
        : coordinator.maxRunsPerDay !== null && coordinator.runsToday >= coordinator.maxRunsPerDay ? receiptStep(false, 'Waiting', `today's ${coordinator.maxRunsPerDay} coordinator runs are used; it is read when the window frees up`)
          : receiptStep(false, 'Waiting', 'the coordinator agent picks it up within seconds'));
  } else if (m.readAt) {
    steps.push(receiptStep(true, 'Read', `by the coordinator agent (Claude) ${dateTime(m.readAt)}`));
  }
  if (m.state === 'read') {
    steps.push(receiptStep(false, 'Working', m.progress ? `${m.progress.turns} turns · ${m.progress.toolCalls} tool calls · last activity ${timeAgo(m.progress.lastActivityAt)}${m.progress.lastTool ? ` (${m.progress.lastTool})` : ''}` : 'reviewing and planning'));
  } else if (m.state === 'answered') {
    steps.push(receiptStep(true, 'Answered', m.replyUrl ? `${dateTime(m.answeredAt)} · ` : `${dateTime(m.answeredAt)} · posting the reply to ${coordinator.reportTo ?? 'GitHub'}…`));
    if (m.replyUrl) steps.at(-1).append(link('Open the reply ↗', m.replyUrl));
  } else if (m.state === 'failed') {
    steps.push(receiptStep(false, 'Not answered', `two reads ended without an answer (${outcomeLabels[m.failure] ?? m.failure}). Send it again or check the supervisor log.`, 'failed'));
  }
  return el('article', { class: 'receipt' }, el('strong', {}, `Message #${m.id} · ${m.source}`), el('p', {}, m.text), el('ol', { class: 'receipt-steps' }, ...steps));
}

function messagesPanel(limit) {
  const coordinator = state.supervisor.coordinator;
  if (!coordinator) return panel('Messages to the coordinator', 'Supervisor state unavailable', empty('Messages unavailable', state.supervisor.message ?? ''));
  const items = coordinator.messages.slice(0, limit);
  return panel('Messages to the coordinator', coordinator.configured
    ? `Read-only coordinator agent · replies go to ${coordinator.reportTo ?? 'GitHub'} · ${coordinator.runsToday}${coordinator.maxRunsPerDay === null ? '' : `/${coordinator.maxRunsPerDay}`} runs in the last 24h${coordinator.blocked ? ` · not reading now: ${coordinator.blocked}` : ''}`
    : coordinator.configError ? `Coordinator configuration is invalid (${coordinator.configError}): messages are stored but nothing reads them`
      : 'No coordinator agent is configured: messages are stored but nothing reads them',
  items.length ? el('div', { class: 'instruction-list' }, ...items.map((m) => messageReceipt(m, coordinator))) : empty('No messages yet', 'Use “New message” to ask for a review or a plan.'),
  button('✉ New message', openMessage, 'link'));
}

// Receipt transitions become a notice here and a desktop notification, so the owner learns when work was read.
const seenReceipts = new Map();
let receiptsPrimed = false;
function announce(title, body) {
  notice(`${title}: ${body}`);
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
      if (now === 'received' && !before) announce(`Message #${item.id} received`, 'The supervisor stored it.');
      else if (now === 'read') announce(`Message #${item.id} read`, 'The coordinator agent started working on it.');
      else if (now === 'answered') announce(`Message #${item.id} answered`, item.replyUrl ? 'The reply is posted.' : 'The reply is being posted.');
      else if (now === 'failed') announce(`Message #${item.id} not answered`, 'Two reads ended without an answer.');
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
  $('#message-target').textContent = coordinator?.configured ? `Replies are posted to ${coordinator.reportTo}.` : 'No coordinator agent is configured yet: the message will be stored, but nothing will read it.';
  $('#message-text').value = messageDraft.text;
  $('#message-dialog').showModal();
  $('#message-text').focus();
}

async function sendMessage(text) {
  sending = true; render();
  const requestId = crypto.randomUUID();
  const attempt = async () => {
    try {
      const result = await post('/api/messages', { requestId, text });
      messageDraft.text = '';
      notice(result.duplicate ? `Message #${result.id} was already received; it was not stored twice.` : `Message #${result.id} received by the supervisor. You will see "Read" when the coordinator agent starts on it.`);
      if (current.address !== MESSAGES_ADDRESS) go(MESSAGES_ADDRESS);
    } catch (error) {
      notice(error.known ? error.message : 'Delivery could not be confirmed. Retry: the same message is never stored twice.', error.known ? null : attempt);
    }
  };
  try { await attempt(); } finally { sending = false; await poll(); }
}

/*
 * Start work (OWNER_WORKSPACE §4.5, slice S9; build slice UI10): the goal, where the work starts from, and Plan only.
 * "Ask for a plan" sends those parts; the supervisor module writes them into one coordinator message and stores it like
 * any owner message, so the receipt (Received, Read, Answered) shows here in place. Plan only never changes a project
 * file or registers work. Plan and do is shown but cannot be chosen until slice S10 and the admission API (#8).
 */
const PLAN_AND_DO_OFF = ['Starting work from this page is not built yet.', 'Today, work starts after its plan is merged into AIWorks and started on this computer.'];
const START_FROM = [['description', 'Just my description'], ['issue', 'A GitHub issue'], ['pull', 'A GitHub pull request']];
const startBlocked = () => sending || offline || !state.supervisor.available;
// The unsent goal and source, kept per address like every draft, and the message id of the last request sent from here.
const startDraft = (address) => ({ goal: '', from: 'description', number: '', sent: null, ...(drafts.get(address, 'start') ?? {}) });

/** The receipt of the last plan request sent from this project's Start work, or null. */
function startReceipt(address) {
  const id = startDraft(address).sent, coordinator = state.supervisor.coordinator;
  if (!id || !coordinator) return null;
  const m = coordinator.messages.find((item) => item.id === id);
  return m ? messageReceipt(m, coordinator) : el('p', { class: 'subtext' }, `Sent as message #${id}. Its receipt is under `, routeLink('Messages', MESSAGES_ADDRESS), '.');
}

function startScreen(project) {
  const address = formatRoute({ screen: 'start', project }), draft = startDraft(address), coordinator = state.supervisor.coordinator;
  // Every project this computer has today is a GitHub repository; the coordinator posts its plan there (AW-004).
  // A project without GitHub waits for a local place for the reply (OWNER_WORKSPACE §14, plan gap G4).
  if (!projectCampaigns(project).length && projectList().find((item) => sameProject(item.id, project))?.kind !== 'GitHub') {
    return [empty('Plan only is not available for this project yet.', 'AIWorks posts its plan on GitHub, and this project has no GitHub repository.')];
  }
  const save = () => drafts.set(address, 'start', { goal: goal.value, from: form.elements['start-from'].value, number: number.value, sent: startDraft(address).sent });
  const goal = el('textarea', { id: 'start-goal', rows: 5, maxlength: 2000, required: true, oninput: save });
  goal.value = draft.goal;
  const number = el('input', { id: 'start-number', type: 'number', min: 1, step: 1, inputmode: 'numeric', required: draft.from !== 'description', oninput: save });
  number.value = draft.number;
  const numberLabel = el('label', { hidden: draft.from === 'description' }, 'Number ', number);
  const from = ([value, label]) => el('label', {}, el('input', { type: 'radio', name: 'start-from', value, checked: draft.from === value,
    onchange: () => { numberLabel.hidden = value === 'description'; number.required = value !== 'description'; save(); } }), ` ${label}`);
  const form = el('form', { class: 'panel-body', 'data-start-form': project, 'data-focus-scope': `start/${project}`,
    onsubmit: (event) => { event.preventDefault(); save(); void askForPlan(project, address); } },
    el('label', { for: 'start-goal' }, el('strong', {}, 'What should be true when this is finished?')), goal,
    el('fieldset', {}, el('legend', {}, 'Start from'), ...START_FROM.map(from), numberLabel),
    el('fieldset', {}, el('legend', {}, 'How far AIWorks goes'),
      el('label', {}, el('input', { type: 'radio', name: 'start-mode', value: 'plan-only', checked: true }), ' Plan only'),
      el('p', { class: 'subtext' }, 'AIWorks looks and proposes a plan. Nothing in your project changes.'),
      el('label', {}, el('input', { type: 'radio', name: 'start-mode', value: 'plan-and-do', disabled: true, 'aria-describedby': 'plan-and-do-note' }), ' Plan and do'),
      el('p', { class: 'subtext', id: 'plan-and-do-note' }, 'AIWorks proposes a plan. After you approve it once, it does the work. ', PLAN_AND_DO_OFF.join(' '))),
    el('p', { class: 'subtext' }, coordinator?.configured ? `The plan is posted to ${coordinator.reportTo ?? 'GitHub'}. No secrets; up to 2,000 characters.`
      : 'No coordinator agent is configured yet: the request will be stored, but nothing will read it.'),
    el('button', { class: 'button', type: 'submit', disabled: startBlocked() }, 'Ask for a plan'),
    el('div', { id: 'start-receipt', 'aria-live': 'polite' }, startReceipt(address)));
  return [el('section', { class: 'panel' }, form)];
}

/** The 5-second refresh keeps the Start work form as typed: only its receipt and button change. False when it must be built. */
function refreshStart(content, project) {
  const form = content.querySelector('form[data-start-form]');
  if (!form || form.dataset.startForm !== project || !state.supervisor.available) return false;
  form.querySelector('button[type="submit"]').disabled = startBlocked();
  const receipt = startReceipt(formatRoute({ screen: 'start', project }));
  form.querySelector('#start-receipt').replaceChildren(...(receipt ? [receipt] : []));
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
      notice(result.duplicate ? `Plan request #${result.id} was already received; it was not stored twice.` : `Plan request #${result.id} received by the supervisor. You will see "Read" when the coordinator agent starts on it.`);
    } catch (error) {
      notice(error.known ? error.message : 'Delivery could not be confirmed. Retry: the same request is never stored twice.', error.known ? null : attempt);
    }
  };
  try { await attempt(); } finally { sending = false; await poll(); }
}

// An instruction draft belongs to the address its dialog was opened from, and to its campaign.
let instructionAddress = null;
function saveDraft() {
  if (instructionCampaign) drafts.set(instructionAddress, `instruction:${instructionCampaign.id}`, { taskId: $('#instruction-task').value, role: $('#instruction-role').value, text: $('#instruction-text').value });
}

function openInstructions(c, task = null) {
  instructionCampaign = c; instructionAddress = current.address;
  const draft = drafts.get(instructionAddress, `instruction:${c.id}`);
  $('#instruction-campaign').textContent = campaignTitle(c);
  $('#instruction-task').replaceChildren(...c.tasks.filter((t) => !['done', 'verified'].includes(t.state)).map((t) => el('option', { value: t.id }, t.outcome ?? t.title)));
  if (draft && c.tasks.some((t) => t.id === draft.taskId && !['done', 'verified'].includes(t.state))) $('#instruction-task').value = draft.taskId;
  else if (task) $('#instruction-task').value = task.id;
  $('#instruction-role').value = draft?.role ?? (c.tasks.find((t) => t.id === $('#instruction-task').value)?.state === 'implemented' ? 'verify' : 'implement');
  $('#instruction-text').value = draft?.text ?? '';
  $('#instruction-dialog').showModal();
  $('#instruction-text').focus();
}

function activityList(limit = 80, journal = state.supervisor.activity) {
  const descriptions = { 'operation-recorded': 'Agent scheduled', 'operation-finished': 'Agent finished', 'lease-acquired': 'Supervisor took over the campaign',
    'run-refunded': 'Unused run not counted', 'runs-recounted': 'Run count corrected', 'dashboard-command': 'Your dashboard command',
    paused: 'Campaign paused', resumed: 'Campaign resumed', 'cancel-requested': 'Cancellation requested', cancelled: 'Campaign cancelled',
    'event-recheck': 'Recheck done', registered: 'Campaign registered' };
  descriptions['executor-fallback'] = 'Switched AI provider';
  descriptions['executor-unavailable'] = 'AI provider unavailable';
  descriptions['executor-amended'] = 'AI provider order updated';
  descriptions['operation-dispatched'] = 'Agent started';
  descriptions.published = 'Finished step published for your review';
  Object.assign(descriptions, { 'integration-wait': 'Waiting for merges before the next step', 'integration-ready': 'Merged work is in place; the next step can start',
    'blocker-raised': 'Stopped: needs a decision or action', 'blocker-cleared': 'Stop cleared; work continues', 'stall-released': 'Stopped step released to continue',
    'authorization-amended': 'Campaign authorization updated', 'message-received': 'Your message was received', 'message-read': 'The coordinator started reading your message',
    'message-answered': 'The coordinator answered', 'message-failed': 'Your message was not answered', 'instruction-attached': 'Your instruction reached a worker',
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

/** "Since you last looked": merged, delivered, newly waiting for you, failed or rejected runs, and supervisor problems apart. */
function sinceSummary() {
  const recent = state.owner?.recent;
  if (!recent) return null;
  const when = previousVisit ? `Since you last looked (${dateTime(previousVisit)})` : 'In the last 24 hours';
  const prs = (list) => list.filter((item) => item.url).map((item) => link(`#${item.number} ↗`, item.url));
  const facts = [
    recent.merged.length ? el('li', {}, `${plural(recent.merged.length, 'step')} merged `, ...prs(recent.merged)) : null,
    recent.delivered.length ? el('li', {}, `${plural(recent.delivered.length, 'step')} delivered by agents`) : null,
    recent.waiting.length ? el('li', { class: 'attention' }, `${recent.waiting.length} newly waiting for your review `, ...prs(recent.waiting)) : null,
    recent.failures ? el('li', { class: 'warn' }, `${plural(recent.failures, 'agent run')} did not succeed${recent.rejected ? ` (${recent.rejected} rejected by the independent checker)` : ''}; the supervisor retries automatically`) : null,
    // The supervisor's own problems, never counted as agent runs: a failing step is recorded on every 5-second check.
    // Not an owner action, but actionable for whoever maintains the supervisor: where it is tracked, and when it happened.
    recent.supervisorErrors || recent.livenessProblems ? el('li', { class: 'warn' }, `The supervisor itself had problems (${[
      recent.supervisorErrors ? `its own check failed ${plural(recent.supervisorErrors, 'time')} and was retried` : null,
      recent.livenessProblems ? plural(recent.livenessProblems, 'liveness problem') : null].filter(Boolean).join('; ')}). Not an owner action: these are supervisor faults for AIWorks's maintainers. `,
    link('Supervisor issue #2 ↗', 'https://github.com/netbka/aiworks/issues/2'), ' · ', routeLink('When, in Diagnostics', '#/settings/diagnostics')) : null,
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
  if (missingRoadmap) return panel('Engineering Platform roadmap items', 'Read from the Engineering Platform governance checkout.', missingRoadmap);
  return panel('Engineering Platform roadmap items', `${entries.length} of ${state.roadmap.entries.length} items · the platform’s own work toward the project control plane. Definitions only: progress is tracked on GitHub and not read here`,
    rows.length ? table(['Item', 'Outcome', 'Role'], rows) : empty('No matching items', 'Try another search or track filter.'));
}

const campaignById = (id) => state.supervisor.campaigns.find((c) => c.id === id);
/** "Dyk: <purpose>": the work a row belongs to. Its ID is in the work's Details on Now and in Diagnostics. */
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
  item.action ? el('div', { class: 'needs-action' }, item.action) : null,
  // A time, when known, completes the sentence: "…stopped checking in at about 12:31".
  el('div', { class: 'needs-text' }, el('span', {}, `${item.text}${item.at ? ` at about ${timeOnly(item.at)}` : ''}`),
    item.link ? link(`${item.link.label} ↗`, item.link.url, 'needs-link') : null),
  item.mergeCheck ? el('div', { class: 'needs-stale' }, mergeAsOf(item.mergeCheck)) : null,
  item.evidence ? disclosure(`needs/${item.link?.url ?? item.text}`, el('span', { class: 'evidence' }, item.evidence),
    el('p', { class: 'needs-detail' }, item.detail)) : null,
  ...item.points.map((point) => el('div', { class: 'needs-point' }, point.link ? link(`${point.link.label} ↗`, point.link.url, 'needs-link') : null, el('span', {}, point.text))),
  // Under "AIWorks itself", an item about one project's work still names that project.
  el('div', { class: 'subtext' }, [item.system && item.repository ? `Project ${projectName(item.repository)}` : null,
    item.campaignId ? campaignContext(item.campaignId) : null].filter(Boolean).join(' · ')));

/**
 * One Needs me group (OWNER_WORKSPACE S3): a project, named and linked to its own screen, or "AIWorks itself" (always
 * last), with its count and its items in today's order.
 */
const needsGroup = (group) => el('section', { class: 'needs-group', 'aria-labelledby': `needs-group-${group.key}`, 'data-focus-scope': `needs/${group.key}` },
  el('h3', { id: `needs-group-${group.key}`, class: 'section-title' }, group.project ? routeLink(group.name, { screen: 'project', project: group.project }) : group.name, ` (${group.count})`),
  el('ul', { class: 'needs-list' }, ...group.items.map(needsItem)));

/** Needs me: what is waiting for the owner, grouped by project, in plain words, each with the link to act on. */
function needsYou() {
  const owner = state.owner;
  if (!owner?.available) return null;
  const { headline, items, groups = [], unknownResults: unknown, also, reply } = owner;
  // aiworks#18: a stopped supervisor leads, with the time it last renewed its leases.
  const controller = state.supervisor.controller;
  return el('section', { class: `needs${items.length ? '' : unknown ? ' checking' : ' calm'}`, 'aria-labelledby': 'needs-title' },
    controller?.stopped ? el('p', { class: 'needs-stopped' }, NEEDS.banner(controller.lastLeaseRenewalAt, { dateTime }, controller.stopRequested)) : null,
    el('div', { class: 'needs-head' }, el('h2', { id: 'needs-title' }, headline),
      unknown ? el('span', { class: 'needs-unknown' }, `Merge of ${unknown} published step${unknown === 1 ? '' : 's'} being checked`) : null),
    // Not blocking, never "nothing": posted reports and merged work ready for release.
    also ? el('p', { class: 'needs-also' }, also.text) : null,
    ...groups.map(needsGroup),
    reply ? el('div', { class: 'needs-reply' }, `The coordinator answered your message #${reply.messageId} (${dateTime(reply.answeredAt)}). `,
      link('Read its “What needs you” ↗', reply.url)) : null);
}

/**
 * Every campaign step with its issue and its pull request or report, from the supervisor store: issue numbers and
 * titles come from the declarations. Issues and pull requests not tied to a campaign are not shown.
 */
function campaignWork(campaigns = state.supervisor.campaigns) {
  return campaigns.flatMap((c) => c.tasks.map((task) => {
    const delivery = deliveryOf(c, task);
    const status = delivery ? delivery.state === 'published' ? 'review' : delivery.state === 'unknown' ? 'unknown' : 'done' : task.blocked ? 'blocked' : 'in_progress';
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
const unavailable = () => empty('Supervisor unavailable', state.supervisor.message ?? 'The supervisor state cannot be read right now. This is not the same as nothing happening.');
const stateTones = { 'needs-you': 'attention', running: 'in_progress', paused: 'pending', finished: 'done', cancelled: 'pending', 'no-work': 'pending' };
const stateWords = { 'needs-you': 'Needs you', running: 'Running', paused: 'Paused', finished: 'Finished', cancelled: 'Cancelled', 'no-work': 'No work yet' };
const projectAction = (action) => action.url ? link(`${action.label} ↗`, action.url, 'project-action') : routeLink(action.label, action.route, 'project-action');

function projectsScreen() {
  if (!state.supervisor.available) return [unavailable()];
  const projects = projectList(), saved = readLastProject(), last = projects.find((project) => sameProject(project.id, saved))?.id;
  // "Configuration file", never "settings": the Settings screen cannot list a repository (aiworks#11 review F18).
  if (!projects.length) return [empty('No projects yet.', 'Projects appear here when the AIWorks configuration file on this computer lists a repository. Adding a project from this page is not built yet.')];
  return [last ? el('p', { class: 'continue' }, routeLink(`Continue with ${projectName(last)} →`, { screen: 'project', project: last }, 'continue-link')) : null,
    sinceSummary(),
    panel('Your projects', 'One row per repository this computer works on. Those that need you come first, then those with work running.',
      el('ul', { class: 'project-list' }, ...projects.map((project) => el('li', { class: 'project-row', 'data-focus-scope': project.id },
        el('div', { class: 'row-line' }, routeLink(project.name, { screen: 'project', project: project.id }, 'project-name'), el('span', { class: 'subtext' }, project.kind)),
        // One state, said in words (never by colour alone), and one next action.
        el('div', { class: 'row-line' }, badge(stateTones[project.state.key] ?? 'unknown', stateWords[project.state.key] ?? 'Not known'), el('span', {}, project.state.text)),
        projectAction(project.action),
        disclosure(`project/${project.id}`, 'Details', el('div', { class: 'subtext' }, [`Repository ${project.repository}`, `owner ${project.details.owner}`,
          plural(project.details.work, 'piece of work', 'pieces of work'), project.details.configured ? 'listed in the AIWorks configuration file on this computer' : null].filter(Boolean).join(' · ')))))))].filter(Boolean);
}

/**
 * One AI worker of this computer in plain words (OWNER_WORKSPACE §4.3, slice S8): "Claude · ready", "Codex · not set up on
 * this computer", "Cursor · not available on Windows", with what it means in the lines under it.
 */
function workerLine(w) {
  const status = { ready: 'ready', running: 'in use now', 'not-set-up': 'not set up on this computer', 'host-unavailable': 'not available on Windows',
    unavailable: 'unavailable', waiting: w.overdue ? 'retry due' : 'waiting for its usage limit' }[w.state] ?? 'state not known';
  const notes = [
    w.state === 'waiting' ? w.overdue ? `The retry was due at ${timeOnly(w.retryAt)}; it happens at the supervisor's next check. No action needed.`
      : `${w.credits ? 'It reported exhausted credits or a billing limit. ' : ''}AIWorks tries it again at ${timeOnly(w.retryAt)}. No action needed.` : null,
    w.state === 'unavailable' ? `${w.availabilityReason ?? 'The supervisor recorded it as unavailable'}.` : null,
    w.state === 'host-unavailable' ? 'Its native sandbox does not support Windows. Work runs without it here; no action needed.' : null,
    w.state === 'not-set-up' ? 'The AIWorks configuration file on this computer sets no command for it, so no work runs on it here.' : null,
    w.setUp === 'default' && w.state !== 'host-unavailable' ? 'Uses the claude command on this computer’s PATH; the AIWorks configuration file sets none.' : null,
    w.buildLimit === 'checks-only' && !['host-unavailable', 'not-set-up'].includes(w.state) ? 'Can check and report here, but cannot build code here.' : null,
    w.buildLimit === 'web-only' ? 'Runs only browser checks of web pages.' : null,
    w.usedBy ? `Allowed in ${plural(w.usedBy, 'piece')} of work.` : 'No current work allows it.'].filter(Boolean);
  return { text: `${provider(w.kind)} · ${status}`, notes };
}

/**
 * Release mode per project (OWNER_WORKSPACE §10.3): Review only is on, Auto Release is off and not available. Text only:
 * there is no switch and no disabled control until the owner's release decision (#33) and a grant for the project exist.
 */
function releasePanel(releases) {
  return panel('Release mode', 'Per project. AIWorks never merges or releases by itself.', releases.length
    ? el('ul', { class: 'settings-links' }, ...releases.map((r) => el('li', { 'data-focus-scope': `release/${r.repository}` }, el('strong', {}, projectName(r.repository)),
      ...r.modes.map((m) => el('div', {}, el('div', {}, `${m.label} · ${m.on ? 'On' : 'Off'}`), el('div', { class: 'subtext' }, m.text,
        m.waitsFor ? ' It waits for the release decision in ' : null, m.waitsFor ? link('issue #33 ↗', m.waitsFor) : null, m.waitsFor ? '.' : null))))))
    : empty('No projects yet.', 'Release mode is shown per project once this computer has one.'));
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

/** Diagnostics: how fresh each project's merge check is, in place of "Refresh GitHub" (plan §6.12 C1). */
function mergeChecksPanel() {
  const projects = projectList();
  return panel('Merge checks', `Read from each project’s local checkout with git, at most every 5 minutes while this page is open. No GitHub API call is made, so there is no refresh button: the check runs by itself.${state.merges?.refreshing ? ' Checking now…' : ''}`,
    projects.length ? el('ul', { class: 'settings-links' }, ...projects.map((project) => el('li', { 'data-focus-scope': `merges/${project.id}` },
      el('strong', {}, project.name), el('div', { class: 'subtext' }, mergeFreshness(mergeRow(project.repository))))))
      : empty('No projects yet.', 'Merge checks appear here once this computer has a project.'));
}

/**
 * Settings (OWNER_WORKSPACE §4.3, slice S8): this computer, its AI workers once, each project's kind and connection, and
 * release mode as text. No primary action: Settings only shows what the machine has. Messages and Diagnostics are linked.
 */
function settingsScreen() {
  const host = state.host ?? {};
  const computer = panel('This computer', 'Each computer runs its own AIWorks. This page shows only this one.', el('div', { class: 'panel-body' },
    el('p', {}, `${host.name ?? 'Unknown computer'} · dashboard version ${host.revision?.slice(0, 7) ?? 'unknown'}`)));
  const settings = state.supervisor.settings;
  if (!state.supervisor.available || !settings) return [computer, unavailable(), settingsLinks()];
  const active = state.supervisor.campaigns.filter((c) => !['finished', 'cancelled'].includes(c.control));
  const workers = panel('AI workers', `Once for ${host.name ?? 'this computer'}, whatever the work.`, el('div', {},
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
  const connections = panel('Projects', 'Each project’s kind and whether this computer is connected to it.', projects.length
    ? el('ul', { class: 'settings-links' }, ...projects.map((project) => el('li', { 'data-focus-scope': `connection/${project.id}` },
      el('strong', {}, `${project.name} · ${project.kind}`),
      el('div', { class: 'subtext' }, project.details.configured ? 'Listed in the AIWorks configuration file on this computer.' : 'Has work on this computer, but the AIWorks configuration file does not list it.'),
      el('div', { class: 'subtext' }, mergeFreshness(mergeRow(project.repository))))))
    : empty('No projects yet.', 'Projects appear here when the AIWorks configuration file on this computer lists a repository.'));
  return [computer, workers, connections, releasePanel(settings.releases), settingsLinks()];
}

function settingsLinks() {
  return panel('More', null, el('ul', { class: 'settings-links' },
    el('li', {}, routeLink('Messages', '#/settings/messages'), el('div', { class: 'subtext' }, 'What you asked AIWorks, and what it answered.')),
    el('li', {}, routeLink('Diagnostics', '#/settings/diagnostics'), el('div', { class: 'subtext' }, 'The full activity journal, every step with its issue and pull request, the Engineering Platform roadmap and how fresh each merge check is.'))));
}

/** The one primary action of a state (OWNER_WORKSPACE §4.4), or nothing: a screen link, a GitHub link or Resume. */
function primaryAction(primary) {
  if (!primary) return null;
  if (primary.route) return routeLink(primary.label, primary.route, 'button');
  if (primary.url) return link(`${primary.label} ↗`, primary.url, 'button');
  const c = primary.command === 'resume' ? campaignById(primary.campaignId) : null;
  if (!c) return null;
  return button(primary.label, () => command(c, 'resume'), '', sending || offline || !state.supervisor.available);
}

/**
 * Now (OWNER_WORKSPACE §4.4, slice S4): the project's goal, where it stands in one sentence with at most one primary
 * action, progress in the owner's terms and what changed for this project since the last visit. The sentence is a
 * polite live region, so a screen reader hears it only when its text changes.
 */
function nowScreen(project) {
  // Start work exists since slice S9 (Plan only), so the no-work state offers it as its primary action.
  const view = nowView(project, { ...state, offline }, { now: Date.now(), startWork: true }), { state: now, details } = view;
  const startWork = now.primary?.route?.screen === 'start' || offline || !state.supervisor.available ? null : routeLink('Start work', { screen: 'start', project }, 'button secondary');
  const goal = view.goal ? `${view.goal.text}${view.goal.variant ? ` (${view.goal.variant})` : ''}` : null;
  const since = view.since?.length ? el('section', { class: 'since', 'aria-labelledby': 'since-title' },
    el('h2', { id: 'since-title' }, previousVisit ? `Since you last looked (${dateTime(previousVisit)})` : 'In the last 24 hours'),
    el('ul', {}, ...view.since.map((line) => el('li', { class: line.tone ?? '' }, `${line.text} `, ...line.links.map((item) => link(`${item.label} ↗`, item.url)))))) : null;
  const others = details.others.map((item) => `${item.purpose ?? item.id} (campaign ${item.id})`);
  return [el('section', { class: 'panel', 'data-focus-scope': `now/${project}` }, el('div', { class: 'panel-body' },
    goal ? el('p', { class: 'eyebrow' }, goal) : null,
    el('p', { role: 'status', 'aria-live': 'polite', 'data-state': now.key }, el('strong', {}, now.title), now.text ? ` ${now.text}` : ''),
    primaryAction(now.primary), startWork,
    view.progress ? el('p', { class: 'subtext' }, view.progress) : null,
    view.note ? el('p', { class: 'subtext' }, `${view.note.title} ${view.note.text}`) : null,
    details.workId || others.length ? disclosure(`now/${project}/details`, 'Details', el('div', { class: 'subtext' }, [
      details.workId ? `Campaign ${details.workId}` : null, details.trackingUrl ? link(`tracking issue #${details.trackingIssue} ↗`, details.trackingUrl) : null,
      others.length ? `Other work in this project: ${others.join(', ')}` : null].filter(Boolean).flatMap((part, index) => index ? [' · ', part] : [part]))) : null)),
  since].filter(Boolean);
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

// Why a step waits (named by step outcomes in the supervisor snapshot), with when AIWorks tries again by itself.
const waitLine = (wait) => wait ? `${wait.text}${wait.retryAt ? ` · next try ${timeOnly(wait.retryAt)}` : ''}` : null;
const commandsOff = () => sending || offline || !state.supervisor.available;
function askCancel(c) {
  pendingCancel = c; $('#cancel-description').textContent = campaignTitle(c); $('#cancel-dialog').showModal();
}
const resumeButton = (c) => c.controls?.primary === 'resume' ? button('Resume', () => command(c, 'resume'), '', commandsOff()) : null;

/**
 * The More menu (OWNER_WORKSPACE §4.7): Pause, Check again and Cancel work, as the supervisor allows them for this work
 * now. Finished and cancelled work allows none, so it has no menu. On a step, Check again rechecks that step only.
 */
function moreMenu(c, task = null) {
  const allowed = c.controls?.more ?? [];
  const actions = task ? allowed.filter((action) => action === 'recheck' && task.state !== 'done' && Boolean(task.blocked || task.retryAt || task.errorClass)) : allowed;
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
function workPanel(project, c) {
  const terminal = ['finished', 'cancelled'].includes(c.control), note = terminal ? null : controlsNote(c);
  const rows = runOrder(c).map((task) => el('tr', { 'data-focus-scope': `${c.id}/${task.id}` },
    el('td', { class: 'c-work' }, routeLink(task.outcome ?? task.title, { screen: 'step', project, work: c.id, step: task.id }, 'task-name'),
      task.outcome ? el('div', { class: 'subtext' }, task.title) : null),
    el('td', { class: 'c-state' }, stepBadge(c, task),
      ...[whoIsOn(c, task), task.stopped?.title, waitLine(task.wait)].filter(Boolean).map((text) => el('div', { class: 'subtext' }, text)))));
  const { cost, body } = costNotes(c);
  return el('section', { class: 'panel', 'data-focus-scope': `work/${c.id}` },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', {}, campaignTitle(c)), el('p', {}, campaignNext(c)), note ? el('p', { class: 'controls-note' }, note) : null),
      el('div', {}, resumeButton(c), moreMenu(c))),
    el('div', { class: 'steps' }, table(['What it delivers', 'Where it stands'], rows)),
    disclosure(`${c.id}/work-details`, `Details · ${plural(c.tasks.length, 'step')} · ${plural(c.runsUsed, 'run')} · ${cost}`,
      el('div', {}, stepsTable(c), terminal ? null : providerStatus(c), body)));
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
  const guidance = (c.instructions ?? []).filter((item) => item.taskId === task.id);
  const { attempts, events } = task.history ?? { attempts: [], events: [] };
  return [el('section', { class: 'panel', 'data-focus-scope': `step/${c.id}/${task.id}` },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', {}, task.outcome ?? task.title), el('p', {}, `${campaignTitle(c)} · project ${projectName(project)}`)),
      moreMenu(c, task)),
    el('div', { class: 'panel-body' },
      el('p', { role: 'status', 'aria-live': 'polite' }, stepBadge(c, task), ' ', task.stopped ? el('strong', {}, task.stopped.title) : whoIsOn(c, task) ?? waitLine(task.wait) ?? ''),
      task.stopped ? el('p', {}, task.stopped.text) : null,
      p ? el('p', { class: 'subtext' }, `From the worker’s own record: ${plural(p.turns, 'turn')} · ${plural(p.toolCalls, 'action')} · last activity ${timeAgo(p.lastActivityAt)}`) : null,
      last ? el('p', { class: 'subtext' }, `Last result: ${last}`) : null,
      primary,
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
  row.asOf ? el('div', { class: 'needs-stale' }, mergeAsOf(row.asOf)) : null,
  row.evidence ? disclosure(`results/${row.campaignId}/${row.taskId}`, el('span', { class: 'evidence' }, row.evidence),
    el('p', { class: 'needs-detail' }, row.detail)) : null,
  el('div', { class: 'subtext' }, campaignContext(row.campaignId)));

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
      el('ul', { class: 'needs-list' }, ...group.rows.map(resultRow)))));
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

/**
 * A project's Cost tab (OWNER_WORKSPACE §4.10, slice S7). First the project's reported total, from today's per-campaign
 * totals, with the runs that reported no cost counted apart; then "See the breakdown": per piece of work and per step,
 * its runs, reported cost, unreported runs, retries and checker rejections. No primary action.
 */
function costScreen(project, all) {
  const total = state.supervisor.costs?.find((item) => sameProject(item.repository, project));
  // Nothing has run: the §7.1 copy, which the server takes from the state copy module.
  if (!total) return [unavailable()];
  if (total.empty) return [empty(total.empty.title, total.empty.text)];
  const withResult = all.reduce((n, c) => n + (ownerCampaign(c)?.counts.delivered ?? 0), 0);
  const headline = total.reportedUsd !== null ? `${usd(total.reportedUsd)} reported for this project${withResult ? ` · about ${usd(total.reportedUsd / withResult)} per step with a result` : ''}`
    : 'No cost reported for this project yet';
  const lines = [total.unreportedRuns ? `${plural(total.unreportedRuns, 'run')} did not report a cost, so the real total is ${total.reportedUsd !== null ? 'higher' : 'not known'}.` : null,
    total.runningRuns ? `${plural(total.runningRuns, 'run')} still running; ${total.runningRuns === 1 ? 'its' : 'their'} cost is not known yet.` : null,
    costRunsLine(total)].filter(Boolean);
  const work = (c) => el('section', { class: 'panel', 'data-focus-scope': `cost/${c.id}` },
    el('div', { class: 'panel-header' }, el('div', {}, el('h2', {}, campaignTitle(c)),
      el('p', {}, `${plural(c.runsUsed, 'run')} · ${costText({ runs: c.runsUsed, ...c.cost })}`))),
    el('div', { class: 'steps' }, table(['Step', 'Runs', 'Cost', 'Retries', 'Checker rejections'], runOrder(c).map((task) => el('tr', { 'data-focus-scope': `cost/${c.id}/${task.id}` },
      el('td', { class: 'c-work' }, routeLink(task.outcome ?? task.title, { screen: 'step', project, work: c.id, step: task.id }, 'task-name')),
      cell(String(task.cost.runs)), cell(costText(task.cost)), cell(String(task.cost.retries)), cell(String(task.cost.checkerRejections)))))),
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
  if (route.screen === 'start' && (all.length || projectList().some((item) => sameProject(item.id, project)))) return startScreen(project);
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
  if (route.screen === 'review') return [empty(...PLAN_AND_DO_OFF)];
  if (route.tab === 'work') {
    return [...cards.map((c) => workPanel(project, c)), cards.some((c) => c.agents.length) ? verdictExplanation() : null,
      cards.some((c) => !['finished', 'cancelled'].includes(c.control)) ? providerNote() : null,
      cards.length ? null : empty('Nothing is running or waiting in this project', 'Finished work is under Results.')].filter(Boolean);
  }
  if (route.tab === 'results') return [resultsScreen(project), finishedList(finished)].filter(Boolean);
  if (route.tab === 'cost') return costScreen(project, all);
  return cards.length ? [...cards.map((c) => campaignCard(c, false))] : [empty('No work is running in this project', 'Finished work and its results are under Results.')];
}

function render() {
  if (!state) return;
  const content = $('#content'), route = current.route;
  const focusKey = (node) => JSON.stringify([node.closest('[data-focus-scope]')?.dataset.focusScope, node.tagName, node.getAttribute('href'), node.textContent]);
  const focused = content.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  const diagnostics = route.screen === 'settings' && route.section === 'diagnostics';
  renderMetrics(route.project ? projectCampaigns(route.project) : state.supervisor.campaigns, diagnostics ? ['Platform roadmap items']
    : route.screen === 'project' && route.tab === 'work' ? ['Agents working'] : []);
  if (route.screen === 'needs') content.replaceChildren(needsYou() ?? unavailable());
  else if (route.screen === 'settings' && route.section === 'messages') content.replaceChildren(messagesPanel(20));
  else if (diagnostics) content.replaceChildren(trackOverview(), roadmapView(), workView(), mergeChecksPanel(),
    panel('Execution journal', 'Latest 80 events · raw agent transcripts and secrets are never shown', activityList()));
  else if (route.screen === 'settings') content.replaceChildren(...settingsScreen());
  else if (route.screen === 'add-project') content.replaceChildren(empty('Adding a project from this page is not built yet.', 'Projects appear on Projects when the AIWorks configuration file on this computer lists a repository.'));
  else if (route.screen === 'start' && refreshStart(content, route.project)) { /* the form stays as the owner typed it */ }
  else if (route.project) content.replaceChildren(...projectScreen(route));
  else content.replaceChildren(...projectsScreen());
  if (focused) [...content.querySelectorAll('a, button, summary')].find((node) => focusKey(node) === focused)?.focus({ preventScroll: true });
  const repositories = state.merges?.repositories ?? [];
  const problems = repositories.filter((repo) => repo.error);
  const warning = $('#source-warning');
  warning.hidden = !problems.length && state.supervisor.available;
  warning.textContent = [!state.supervisor.available ? state.supervisor.message : '', ...problems.map((repo) => `${repo.repository}: the last fetch of its base branch failed; ${
    repo.fetchedAt ? `merge state is from ${dateTime(repo.fetchedAt)}` : 'its merges are not seen yet'}.`)].filter(Boolean).join(' ');
  const fetched = repositories.map((repo) => repo.fetchedAt).filter(Boolean).sort((a, b) => a - b);
  $('#updated').textContent = `${state.host?.name ? `${state.host.name} · ` : ''}Checked ${timeOnly(state.observedAt)} · merges ${fetched.length ? `checked ${timeAgo(fetched[0])}` : 'not checked yet'}`;
  // Which machine this is: each computer runs its own supervisor and campaigns.
  if (state.host) {
    // The page starts with a neutral "…" so it never names the wrong computer before the first answer.
    $('#host-name').textContent = `${state.host.name ?? 'Unknown computer'} · this computer`;
    $('#host-name').removeAttribute('aria-busy');
    $('#host-detail').textContent = `Dashboard version ${state.host.revision?.slice(0, 7) ?? 'unknown'}`;
  }
}

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error), { known: true, detail: value.detail ?? null });
  return value;
}

async function deliver(payload, draftAddress = null) {
  sending = true; render();
  try {
    const result = await post('/api/commands', payload);
    notice(result.duplicate ? COMMANDS.duplicate : COMMANDS.accepted[payload.action]);
    if (payload.action === 'instruct' && draftAddress) drafts.delete(draftAddress, `instruction:${payload.campaignId}`);
  } catch (error) {
    // A refusal says what happened and what to do; the machine's reason is behind Details.
    notice(error.known ? error.message : COMMANDS.unconfirmed, error.known ? null : () => deliver(payload, draftAddress), error.known ? error.detail : null);
  } finally { sending = false; await poll(); }
}

function command(c, action, task, extra = {}, draftAddress = null) {
  return deliver({ campaignId: c.id, action, requestId: crypto.randomUUID(), version: c.version,
    authorizationVersion: c.authorizationVersion, scopeDigest: c.scopeDigest,
    ...(task ? { taskId: task.id, taskVersion: task.version } : {}), ...extra }, draftAddress);
}

async function poll() {
  try {
    const response = await fetch(`/api/state?since=${since}`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error('state unavailable');
    state = await response.json(); offline = false;
    $('#connection').textContent = state.merges?.refreshing ? 'Live · checking for merges…'
      : (state.merges?.repositories ?? []).some((repo) => repo.error) ? 'Live · a merge check failed' : 'Live · updates every 5s';
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

// A new destination starts at its top; Back or Forward returns to where that address was left (UX-001 §8, preserve
// context). The page keeps scroll per address itself, so the browser's own restoration is switched off.
const scrollMemory = new Map();
try { history.scrollRestoration = 'manual'; } catch { /* the browser restores by itself */ }
function go(address, { restore = false } = {}) {
  scrollMemory.set(current.address, window.scrollY);
  const next = resolveRoute(address);
  if (!restore) history.pushState(null, '', next.address);
  else if (next.replace) history.replaceState(null, '', next.address);
  current = next;
  showRoute();
  window.scrollTo(0, restore ? scrollMemory.get(current.address) ?? 0 : 0);
  // Focus moves to the new screen's heading, so a screen reader starts there.
  $('#view-title').focus({ preventScroll: true });
}
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
// The skip link moves focus to the content without changing the address.
$('.skip-link').addEventListener('click', (event) => { event.preventDefault(); $('#main').focus(); });
for (const selector of ['#search', '#track', '#status']) $(selector).addEventListener('input', () => { workLimit = 80; render(); });
$('#confirm-cancel').addEventListener('click', () => { $('#cancel-dialog').close(); if (pendingCancel) void command(pendingCancel, 'cancel'); pendingCancel = null; });
$('#close-instruction').addEventListener('click', () => { saveDraft(); $('#instruction-dialog').close(); });
$('#instruction-dialog').addEventListener('cancel', saveDraft);
$('#instruction-form').addEventListener('submit', (event) => {
  event.preventDefault();
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
  if (offline || sending) return;
  const text = $('#message-text').value;
  messageDraft.text = text;
  $('#message-dialog').close();
  askNotifications();
  void sendMessage(text);
});
// Our own navigation already set the address; any other change (Back, Forward, an edited address) restores that address's position.
window.addEventListener('hashchange', () => { if (location.hash !== current.address) go(location.hash, { restore: true }); });
// The visit ends when the page is hidden or closed; the next visit summarizes what changed after this point.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeLastSeen(); });
window.addEventListener('pagehide', writeLastSeen);
// An empty, legacy or unknown address is rewritten once, without a new history entry.
if (current.replace) history.replaceState(null, '', current.address);
showRoute();
try { csrf = (await (await fetch('/api/session')).json()).csrf; } catch { notice('Command session unavailable. Reload when the dashboard reconnects.'); }
await poll();
setInterval(() => { if (!sending) void poll(); }, 5000);
