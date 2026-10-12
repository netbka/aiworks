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
let state, csrf, offline = false, sending = false, pendingCancel, instructionCampaign, view = 'overview', workLimit = 80;
const drafts = new Map();
const opened = new Set();

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
const notice = (text, retry) => {
  const node = $('#notice'); node.hidden = false;
  node.replaceChildren(document.createTextNode(text));
  if (retry) node.append(button('Retry same command', retry, 'secondary small'));
};

function setView(next) {
  view = ['overview', 'roadmap', 'work', 'agents', 'messages', 'activity'].includes(next) ? next : 'overview';
  location.hash = view;
  const titles = { overview: ['Overview', 'What changed, what needs you, and how each project campaign is moving.'],
    roadmap: ['Campaign plans & platform roadmap', 'Each project campaign’s steps first, then the Engineering Platform’s own roadmap.'],
    work: ['Issues & pull requests', 'Each campaign step’s issue and its pull request or report, from the supervisor’s records.'],
    agents: ['Agents', 'Which AI agents are working and how they are doing, and the AI providers each campaign can use.'],
    messages: ['Messages', 'What you sent, when it was received, when an agent read it, and its answer.'],
    activity: ['Recent activity', 'Agent results, AI provider switches, published steps and your commands.'] };
  $('#view-title').textContent = titles[view][0]; $('#view-description').textContent = titles[view][1];
  $('.breadcrumb strong').textContent = titles[view][0];
  for (const node of document.querySelectorAll('[data-view]')) {
    node.classList.toggle('active', node.dataset.view === view);
    if (node.dataset.view === view) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  }
  $('#filters').hidden = !['roadmap', 'work'].includes(view);
  $('#track').disabled = view === 'work';
  $('#status').disabled = view !== 'work';
  if (state) render();
}

function renderMetrics() {
  const entries = state.roadmap.entries, campaigns = state.supervisor.campaigns;
  const agents = campaigns.flatMap((c) => c.agents);
  // Everything listed under "Needs you": owner reviews, decisions, stopped work, a stopped supervisor and an unreadable
  // inbox. A pause by itself is not listed: the campaign card shows it.
  // A published step whose merge is still being checked is never counted as nothing.
  // "Nothing" is only about what blocks on the owner: reports to read and releases are named after it.
  const owner = state.owner ?? { items: [], unknownResults: 0, also: null }, attention = owner.items.length, unknown = owner.unknownResults;
  const available = state.supervisor.available;
  const used = campaigns.reduce((n, c) => n + c.runsUsed, 0);
  // Unknown cost is never shown as $0: finished runs without a reported cost and runs still in progress are "not reported".
  const reported = campaigns.reduce((n, c) => n + c.recordedCostUsd, 0);
  const unreported = campaigns.reduce((n, c) => n + (c.budget?.unknownCostRuns ?? 0) + c.agents.length, 0);
  const delivered = Object.values(owner.campaigns ?? {}).reduce((n, item) => n + item.counts.delivered, 0);
  const verdicts = agents.map((agent) => agentVerdict(agent)[0]);
  const metrics = [
    ['Platform roadmap items', entries.length, null, 'Definitions from the governance checkout; progress is tracked on GitHub', '☷'],
    ['Agents working', available ? agents.length : '—', null, !available ? 'Supervisor unavailable'
      : agents.length ? `${verdicts.filter((v) => v === 'recent').length} working normally${verdicts.some((v) => v === 'stale') ? ` · ${verdicts.filter((v) => v === 'stale').length} possibly stuck or not started` : ''}` : 'None right now', '◎'],
    ['Needs you', !available ? '—' : unknown && !attention ? '?' : attention, available && unknown && attention ? '+ ?' : null,
      !available ? 'Execution state unknown'
        : `${attention ? `${plural(attention, 'item')} listed on Overview` : unknown ? 'Nothing confirmed yet' : 'Nothing is blocked on you'}${unknown ? ` · merge of ${plural(unknown, 'published step')} being checked` : ''}${owner.also ? ` · also ${owner.also.short}` : ''}`, '◈'],
    ['Cost so far', !available ? '—' : reported > 0 ? usd(reported) : 'not reported', null, !available ? 'Supervisor unavailable'
      : `${plural(used, 'run')} · ${delivered && reported > 0 ? `about ${usd(reported / delivered)} per delivered step` : 'no cost per step yet'}${unreported ? ` · ${plural(unreported, 'run')} not reported yet, so the real total is higher` : ''}`, '↗'],
  ];
  $('#metrics').replaceChildren(...metrics.map(([title, value, total, foot, icon]) => el('div', { class: 'metric' },
    el('div', { class: 'metric-title' }, title, el('span', { class: 'metric-icon', 'aria-hidden': 'true' }, icon)),
    el('div', { class: 'metric-value number' }, String(value), total ? el('small', {}, total) : null), el('div', { class: 'metric-foot' }, foot))));
  $('#roadmap-count').textContent = entries.length;
  $('#agent-count').textContent = agents.length || '';
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
  return panel('Engineering Platform roadmap', 'The platform’s own work toward its product, the project control plane. This is separate from the project campaigns above. Its progress is tracked on GitHub, not read here.',
    el('div', { class: 'panel-body' }, ...rows), button('View roadmap ↗', () => go('roadmap'), 'link'));
}

/** A plain verdict per running agent: working normally, possibly stuck, starting or not started. */
function agentVerdict(agent) {
  const last = agent.progress?.lastActivityAt ?? agent.outputAt ?? null;
  const minutes = last ? Math.max(0, Math.floor((Date.now() - last) / 60_000)) : null;
  if (minutes !== null) return minutes < STUCK_MINUTES ? ['recent', 'Working normally'] : ['stale', `Possibly stuck: no progress for ${minutes} min`];
  if (agent.heartbeatState === 'recent') return ['recent', 'Working normally'];
  return Date.now() - agent.startedAt < 5 * 60_000 ? ['pending', 'Starting'] : ['stale', 'Not started'];
}

function agentCard(campaign, agent) {
  const task = campaign.tasks.find((item) => item.id === agent.taskId);
  const [tone, verdict] = agentVerdict(agent);
  const p = agent.progress;
  return el('article', { class: 'agent-card' }, el('div', { class: 'agent-heading' },
    el('div', { class: 'agent-avatar', 'aria-hidden': 'true' }, provider(agent.executor)[0]),
    el('div', {}, el('div', { class: 'agent-name' }, `${provider(agent.executor)} · ${roleName(agent.role)}`), el('div', { class: 'agent-role' }, campaignTitle(campaign))),
    el('div', { class: 'agent-state' }, badge(tone, verdict))),
    el('div', { class: 'agent-task' }, task?.outcome ?? task?.title ?? agent.taskId),
    el('div', { class: 'agent-meta' }, el('span', {}, agent.taskId), el('span', {}, `started ${timeAgo(agent.startedAt)}`),
      p ? el('span', {}, `${plural(p.turns, 'turn')} · ${plural(p.toolCalls, 'action')} · last activity ${timeAgo(p.lastActivityAt)}`)
        : agent.outputAt ? el('span', {}, `last output ${timeAgo(agent.outputAt)}`) : null));
}

/** How the verdicts are decided, shown once rather than on every card. */
const verdictExplanation = () => el('details', { class: 'explain' }, el('summary', {}, 'How “working normally” is decided'),
  el('div', { class: 'notes' }, `Working normally: the agent's own record shows a turn or action in the last ${STUCK_MINUTES} minutes, or, for an agent that reports only at the end, its runner is still alive. `,
    `Possibly stuck: no progress for ${STUCK_MINUTES} minutes or more. Not started: no sign of life 5 minutes after it was scheduled. `,
    'Counts come from the agent’s own session record; its prompts and output are never shown here.'));

/** Shown once per page: what provider waits mean and what they never do. */
const providerNote = () => el('div', { class: 'notes' }, 'Provider account balances are not queried: a provider failure is observed evidence, not a measured balance. ',
  'Switching to the next AI provider never overrides a permission denial',
  state.supervisor.campaigns.some((c) => c.maxWorkerRuns !== null) ? ' or raises a campaign’s run cap.' : '.');

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
const terminalLabels = { accepted: 'accepted', rejected: 'rejected', resolved: 'built, waiting for the independent check', 'evidence-unavailable': 'could not gather required evidence', 'blocked-owner-reserved': 'blocked on a decision reserved for you' };
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
  return { finished: 'Controls are off: every step of this campaign is finished.', cancelled: 'Controls are off: this campaign was cancelled.',
    'cancel-requested': 'Controls are off: cancellation is in progress.' }[c.control] ?? null;
}

/** The campaign's state in one sentence, with the host named and liveness reconciled with the agents' own records. */
function campaignNext(c) {
  const owner = ownerCampaign(c), host = state.host?.name ?? 'its computer';
  const active = c.agents[0], activeTask = active ? c.tasks.find((task) => task.id === active.taskId) : null;
  // A neutral state, not an owner item: who paused is not recorded, so the reason is shown as given and nothing is inferred.
  if (c.control === 'paused') {
    const supervisor = ['stopped', 'agent-working-supervisor-silent'].includes(owner?.liveness)
      ? ` · the supervisor on ${host} is not running${owner.lastCheckIn ? ` (last check-in about ${timeOnly(owner.lastCheckIn)})` : ''}` : '';
    return `Paused${c.pausedAt ? ` since ${dateTime(c.pausedAt)}` : ''} · no new work starts; a running agent may finish${c.pausedReason ? ` · reason given: “${c.pausedReason}”` : ''}${supervisor}`;
  }
  if (c.control === 'cancel-requested') return 'Cancellation requested · waiting for the supervisor';
  if (c.control === 'cancelled') return 'Cancelled';
  // Built by the owner view: calm only when every step is merged or a report.
  if (c.control === 'finished') return owner?.finished ?? 'All steps are finished';
  if (owner?.liveness === 'late') return `The supervisor on ${host} is late checking in (last at about ${timeOnly(owner.lastCheckIn)}); no action yet: this is normal for a few minutes during a restart or an upgrade`;
  if (owner?.liveness === 'awaiting-pickup') return `Registered at about ${timeOnly(owner.registeredAt)}; waiting for the supervisor on ${host} to pick it up · no action yet`;
  if (owner?.liveness === 'agent-working-supervisor-silent') return `An agent is still working, but the supervisor on ${host} stopped checking in at about ${timeOnly(owner.lastCheckIn)}`;
  if (!c.controllerLive) return `The supervisor on ${host} is not running this campaign${owner?.lastCheckIn ? ` (last check-in about ${timeOnly(owner.lastCheckIn)})` : ''}`;
  if (c.blocker) return `Stopped (${c.blockerClass ?? c.blocker}): ${c.blockerReason ?? c.blocker}`;
  if (active) return `${active.role === 'Verifier' ? 'Independently checking' : 'Building'} ${active.taskId}: ${activeTask?.outcome ?? activeTask?.title ?? ''}`;
  if (['provider-quota', 'provider-availability'].includes(c.waitingReason)) return `Waiting for an AI provider to become available again · next check ${dateTime(c.nextWakeupAt)} · no action needed`;
  if (['blocked-child', 'blocked-owner-decision', 'blocked-owner-action', 'blocked-external'].includes(c.status)) {
    return `Stopped · no agent will start until you act. ${c.stopReasons?.length ? c.stopReasons.join(' | ') : 'A step is blocked; see the steps.'}`;
  }
  // The supervisor's own next action (for example, waiting for dependencies to be merged), when it has one.
  if (c.nextAction) return c.nextAction;
  return c.nextWakeupAt ? `Next check ${dateTime(c.nextWakeupAt)}` : 'Waiting for the next step to become ready';
}

const livenessNames = { running: 'Supervisor running', late: 'Supervisor checking in late', 'awaiting-pickup': 'Waiting for the supervisor',
  'agent-working-supervisor-silent': 'Agent working · supervisor silent', stopped: 'Supervisor not running' };
/** The supervisor's state for one campaign; a paused campaign reads neutral, whatever the supervisor is doing. */
function livenessBadge(c, liveness) {
  if (liveness === 'finished') return null;
  // Neutral while a supervisor holds it (or is only late); a paused campaign with no supervisor is not calm.
  if (c.control === 'paused') return badge(['running', 'late', 'awaiting-pickup'].includes(liveness) ? 'unknown' : 'stale', `${livenessNames[liveness] ?? 'Supervisor state unknown'} · campaign paused`);
  return badge(liveness === 'running' ? 'recent' : ['late', 'awaiting-pickup'].includes(liveness) ? 'pending' : 'stale', livenessNames[liveness]);
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
    el('button', { class: 'button text-danger small', disabled: !controllable, title: note,
      onclick: () => { pendingCancel = c; $('#cancel-description').textContent = `${c.id} · ${c.repository}`; $('#cancel-dialog').showModal(); } }, 'Cancel…'));
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
  // Runs, cost and the provider order are detail. Unknown cost is "not reported", never $0.00.
  const budget = c.budget, unreported = (budget?.unknownCostRuns ?? 0) + c.agents.length;
  const cost = c.recordedCostUsd > 0 ? `${usd(c.recordedCostUsd)} reported${unreported ? ` + ${plural(unreported, 'run')} not reported yet` : ''}` : 'cost not reported yet';
  card.append(disclosure(`${c.id}/costs`, `Runs, cost and AI providers · ${plural(c.runsUsed, 'run')} · ${cost}`,
    el('div', { class: 'notes' }, `AI providers in order of preference: ${c.executors.map(provider).join(' → ')}. `,
      c.maxWorkerRuns === null ? `${plural(c.runsUsed, 'run')}; this campaign has no run limit. ` : `${c.runsUsed} of ${plural(c.maxWorkerRuns, 'run')} allowed. `,
      `Cost: ${cost}. `,
      budget?.maxCostUsd ? `${usd(budget.chargedCostUsd)} of the ${usd(budget.maxCostUsd)} ceiling is used, counting each unreported run at ${usd(budget.unknownRunCostUsd)}. `
        : 'There is no cost ceiling: work pauses only when an AI provider reports its own subscription or usage limit, and resumes after the reset. ',
      'Pause stops new work from starting. Recheck asks the supervisor to look again; it never skips the independent check.')));
  if (c.instructions?.length) card.append(disclosure(`${c.id}/instructions`, `Your instructions to agents (${c.instructions.length})`,
    el('div', { class: 'instruction-list' }, ...c.instructions.map((item) => instructionReceipt(item)))));
  return card;
}

function instructionReceipt(item) {
  const role = roleName(item.role);
  const steps = [
    receiptStep(true, 'Received', `stored by the supervisor ${dateTime(item.at)}`),
    item.status === 'attached' ? receiptStep(true, 'Read', `by the ${role} (${provider(item.executor)}) ${dateTime(item.attachedAt)}; it is in that agent's instructions`)
      : item.status === 'queued' ? receiptStep(false, 'Waiting', `delivered to the next ${role} run of ${item.taskId}; a running agent is not interrupted`)
        : receiptStep(false, 'Not delivered', item.status === 'outdated' ? 'the campaign authorization changed before an agent ran' : 'no further run of this step is scheduled', 'failed'),
    item.status === 'attached' ? receiptStep(item.runState === 'finished', item.runState === 'finished' ? 'Agent finished' : 'Agent working',
      item.runState === 'finished' ? `outcome: ${terminalLabels[item.runOutcome] ?? outcomeLabels[item.runOutcome] ?? item.runOutcome ?? 'unknown'}` : 'its result will appear here') : null,
  ];
  return el('article', { class: 'receipt' }, el('strong', {}, `${item.taskId} · ${role}`), el('p', {}, item.text), el('ol', { class: 'receipt-steps' }, ...steps));
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
  items.length ? el('div', { class: 'instruction-list' }, ...items.map((m) => messageReceipt(m, coordinator))) : empty('No messages yet', 'Use “Message coordinator” to ask for a review or a plan.'),
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
  for (const c of state.supervisor.campaigns) for (const i of c.instructions ?? []) current.set(`i${c.id}:${i.id}`, [i.status === 'attached' ? `attached:${i.runState}` : i.status, i]);
  if (receiptsPrimed) for (const [key, [now, item]] of current) {
    const before = seenReceipts.get(key);
    if (before === now) continue;
    if (key.startsWith('m')) {
      if (now === 'received' && !before) announce(`Message #${item.id} received`, 'The supervisor stored it.');
      else if (now === 'read') announce(`Message #${item.id} read`, 'The coordinator agent started working on it.');
      else if (now === 'answered') announce(`Message #${item.id} answered`, item.replyUrl ? 'The reply is posted.' : 'The reply is being posted.');
      else if (now === 'failed') announce(`Message #${item.id} not answered`, 'Two reads ended without an answer.');
    } else if (now === 'attached:dispatched' || now === 'attached:recorded') announce(`Instruction for ${item.taskId} read`, `The ${roleName(item.role)} (${provider(item.executor)}) received it.`);
    else if (now === 'attached:finished') announce(`The agent that read your ${item.taskId} instruction finished`, `Outcome: ${terminalLabels[item.runOutcome] ?? outcomeLabels[item.runOutcome] ?? item.runOutcome ?? 'unknown'}.`);
  }
  for (const [key, [value]] of current) seenReceipts.set(key, value);
  receiptsPrimed = true;
  const open = (state.supervisor.coordinator?.messages ?? []).filter((m) => ['received', 'read'].includes(m.state)).length;
  $('#message-count').textContent = open || '';
}
const askNotifications = () => { try { if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission(); } catch { /* unsupported */ } };

const messageDraft = { text: '' };
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
      go('messages');
    } catch (error) {
      notice(error.known ? error.message : 'Delivery could not be confirmed. Retry: the same message is never stored twice.', error.known ? null : attempt);
    }
  };
  try { await attempt(); } finally { sending = false; await poll(); }
}

function saveDraft() {
  if (instructionCampaign) drafts.set(instructionCampaign.id, { taskId: $('#instruction-task').value, role: $('#instruction-role').value, text: $('#instruction-text').value });
}

function openInstructions(c) {
  instructionCampaign = c;
  const draft = drafts.get(c.id);
  $('#instruction-campaign').textContent = c.id;
  $('#instruction-task').replaceChildren(...c.tasks.filter((t) => !['done', 'verified'].includes(t.state)).map((t) => el('option', { value: t.id }, `${t.id} — ${t.title}`)));
  if (draft && c.tasks.some((t) => t.id === draft.taskId && !['done', 'verified'].includes(t.state))) $('#instruction-task').value = draft.taskId;
  $('#instruction-role').value = draft?.role ?? (c.tasks.find((t) => t.id === $('#instruction-task').value)?.state === 'implemented' ? 'verify' : 'implement');
  $('#instruction-text').value = draft?.text ?? '';
  $('#instruction-dialog').showModal();
  $('#instruction-text').focus();
}

function activityList(limit = 80) {
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
  const items = state.supervisor.activity.slice(0, limit);
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
    link('Supervisor issue #2 ↗', 'https://github.com/netbka/aiworks/issues/2'), ' · ', button('When, in Activity', () => go('activity'), 'link small')) : null,
  ].filter(Boolean);
  return el('section', { class: 'since', 'aria-labelledby': 'since-title' }, el('h2', { id: 'since-title' }, when),
    facts.length ? el('ul', {}, ...facts) : el('p', {}, 'Nothing changed.'));
}

/** Search applies to both lists; the track filter to the platform roadmap, the status filter to campaign steps. */
function filtered(items) {
  const query = $('#search').value.trim().toLowerCase(), status = $('#status').value, track = $('#track').value;
  return items.filter((item) => (!query || `${item.id ?? ''} ${item.number ?? ''} ${item.title} ${item.repository} ${item.campaignId ?? ''}`.toLowerCase().includes(query)) &&
    (view !== 'work' || !status || item.status === status) && (view === 'work' || !track || item.track === track));
}

function roadmapView() {
  const entries = filtered(state.roadmap.entries);
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
/** "Dyk: <purpose> · campaign <id>", without repeating the id when the title is the id. */
const campaignContext = (id) => { const c = campaignById(id), title = c ? campaignTitle(c) : id; return title.includes(id) ? title : `${title} · campaign ${id}`; };
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
  return panel(`Finished campaigns (${list.length})`, 'Most recent first. Each line says where that campaign’s results stand.',
    el('div', { class: 'finished-list' }, ...list.map((c) => el('div', { class: 'finished-row', 'data-focus-scope': c.id },
      el('div', { class: 'row-line' }, el('strong', { class: 'finished-title' }, campaignTitle(c)), link(`tracking issue #${c.trackingIssue ?? ''} ↗`, c.trackingUrl)),
      el('div', { class: 'subtext' }, ownerCampaign(c)?.outcome ?? (c.control === 'cancelled' ? 'Cancelled' : 'All steps are finished')),
      disclosure(`${c.id}/finished-steps`, `See all ${plural(c.tasks.length, 'step')}`, stepsTable(c))))));
}

function campaignRoadmaps() {
  const { cards, finished } = campaignLayout();
  return [...cards, ...finished].map((c) => panel(campaignTitle(c),
    `Campaign ${c.id} · ${deliverySummary(c).text}. This is the work assigned to the campaign; the repository may have other backlog.`, stepsTable(c)));
}

/** When the merge check behind a step is not current, or its last fetch failed: when it is from, and what happens next. */
const mergeAsOf = (check) => `Merge check from ${!check.at ? 'an unknown time' : new Date(check.at).toDateString() === new Date().toDateString() ? timeOnly(check.at) : dateTime(check.at)}; ${
  check.reason === 'fetch-failed' ? 'the last fetch failed, retrying within 5 minutes' : 'checking again'}`;

/** The first thing on Overview: what is waiting for the owner, in plain words, each with the link to act on. */
function needsYou() {
  const owner = state.owner;
  if (!owner?.available) return null;
  const { headline, items, unknownResults: unknown, also, reply } = owner;
  // aiworks#18: a stopped supervisor leads, with the time it last renewed its leases.
  const controller = state.supervisor.controller;
  return el('section', { class: `needs${items.length ? '' : unknown ? ' checking' : ' calm'}`, 'aria-labelledby': 'needs-title' },
    controller?.stopped ? el('p', { class: 'needs-stopped' }, `Supervisor stopped. Last lease renewal ${dateTime(controller.lastLeaseRenewalAt)}${
      controller.stopRequested ? ' (STOP file present: an upgrade or an operator stop)' : ''}.`) : null,
    el('div', { class: 'needs-head' }, el('h2', { id: 'needs-title' }, headline),
      unknown ? el('span', { class: 'needs-unknown' }, `Merge of ${unknown} published step${unknown === 1 ? '' : 's'} being checked`) : null),
    // Not blocking, never "nothing": posted reports and merged work ready for release.
    also ? el('p', { class: 'needs-also' }, also.text) : null,
    items.length ? el('ul', { class: 'needs-list' }, ...items.map((item) => el('li', { class: `needs-item ${item.kind}` },
      // What to do, then the subject (what the step delivers) with its link, then the evidence in one line.
      item.action ? el('div', { class: 'needs-action' }, item.action) : null,
      // A time, when known, completes the sentence: "…stopped checking in at about 12:31".
      el('div', { class: 'needs-text' }, el('span', {}, `${item.text}${item.at ? ` at about ${timeOnly(item.at)}` : ''}`),
        item.link ? link(`${item.link.label} ↗`, item.link.url, 'needs-link') : null),
      item.mergeCheck ? el('div', { class: 'needs-stale' }, mergeAsOf(item.mergeCheck)) : null,
      item.evidence ? disclosure(`needs/${item.link?.url ?? item.text}`, el('span', { class: 'evidence' }, item.evidence),
        el('p', { class: 'needs-detail' }, item.detail)) : null,
      ...item.points.map((point) => el('div', { class: 'needs-point' }, point.link ? link(`${point.link.label} ↗`, point.link.url, 'needs-link') : null, el('span', {}, point.text))),
      el('div', { class: 'subtext' }, item.campaignId ? campaignContext(item.campaignId) : '')))) : null,
    reply ? el('div', { class: 'needs-reply' }, `The coordinator answered your message #${reply.messageId} (${dateTime(reply.answeredAt)}). `,
      link('Read its “What needs you” ↗', reply.url)) : null);
}

/**
 * Every campaign step with its issue and its pull request or report, from the supervisor store: issue numbers and
 * titles come from the declarations. Issues and pull requests not tied to a campaign are not shown.
 */
function campaignWork() {
  return state.supervisor.campaigns.flatMap((c) => c.tasks.map((task) => {
    const delivery = deliveryOf(c, task);
    const status = delivery ? delivery.state === 'published' ? 'review' : delivery.state === 'unknown' ? 'unknown' : 'done' : task.blocked ? 'blocked' : 'in_progress';
    return { c, task, delivery, status, id: task.id, campaignId: c.id, repository: c.repository, title: `${task.outcome ?? ''} ${task.title}`,
      number: /\/issues\/(\d+)$/.exec(task.issueUrl ?? '')?.[1] ?? null };
  }));
}

function workView() {
  const work = filtered(campaignWork());
  const rows = work.slice(0, workLimit).map(({ c, task, delivery, number }) => el('tr', { 'data-focus-scope': `${c.id}/${task.id}` },
    cell(link(number ? `Issue #${number}` : task.id, task.issueUrl, 'package-id')),
    cell(el('span', { class: 'task-name' }, task.outcome ?? task.title), el('div', { class: 'subtext' }, `${task.id} · ${campaignTitle(c)}`)),
    cell(stepBadge(c, task), delivery?.note ? el('div', { class: 'subtext' }, delivery.note) : null),
    cell(task.resultUrl ? link(delivery?.number ? `PR #${delivery.number} ↗` : 'Report ↗', task.resultUrl) : el('span', { class: 'muted' }, 'Not published yet'))));
  const body = el('div', {}, rows.length ? table(['Step issue', 'What it delivers', 'Where it stands', 'Pull request or report'], rows) : empty('No matching work', 'Try clearing the filters.'));
  if (work.length > workLimit) body.append(el('div', { class: 'load-more' }, button(`Show more (${work.length - workLimit} remaining)`, () => { workLimit += 80; render(); }, 'secondary')));
  return panel('Campaign issues and pull requests', `${work.length} steps · from the supervisor's own records. Issues and pull requests that no campaign owns are not shown here; see them on GitHub`, body);
}

function render() {
  if (!state) return;
  const content = $('#content');
  const focusKey = (node) => JSON.stringify([node.closest('[data-focus-scope]')?.dataset.focusScope, node.tagName, node.getAttribute('href'), node.textContent]);
  const focused = content.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  renderMetrics();
  $('#metrics').hidden = !['overview', 'roadmap'].includes(view);
  const campaigns = state.supervisor.campaigns, agents = campaigns.flatMap((c) => c.agents.map((a) => [c, a]));
  // Campaigns with something for the owner and active ones get cards; finished ones are one line each, further down.
  const { cards, finished } = campaignLayout();
  if (view === 'roadmap') content.replaceChildren(...campaignRoadmaps(), roadmapView());
  else if (view === 'work') content.replaceChildren(workView());
  else if (view === 'activity') content.replaceChildren(panel('Execution journal', 'Latest 80 events · raw agent transcripts and secrets are never shown', activityList()));
  else if (view === 'messages') content.replaceChildren(messagesPanel(20));
  else if (view === 'agents') content.replaceChildren(...(agents.length ? [el('div', { class: 'agents-grid' }, ...agents.map(([c, a]) => agentCard(c, a))), verdictExplanation()] : []),
    ...(campaigns.length ? [...cards.map((c) => campaignCard(c)), finishedList(finished),
      cards.some((c) => !['finished', 'cancelled'].includes(c.control)) ? providerNote() : null].filter(Boolean)
      : [empty('No registered campaigns', state.supervisor.message ?? 'Register authorized work through the supervisor.')]));
  else content.replaceChildren(...[sinceSummary(), needsYou()].filter(Boolean), ...cards.map((c) => campaignCard(c, false)), el('div', { class: 'overview-grid' },
    panel('Live now', 'What the AI agents are doing right now', agents.length ? el('div', {}, ...agents.map(([c, a]) => agentCard(c, a)), verdictExplanation())
      : empty(state.supervisor.available ? 'No agent is working right now' : 'Supervisor unavailable', state.supervisor.message ?? 'Work appears here when the supervisor starts an agent.'), button('View agents ↗', () => go('agents'), 'link')),
    trackOverview()),
    ...[finishedList(finished)].filter(Boolean),
    panel('Latest activity', 'What happened recently, newest first', activityList(5), button('View all ↗', () => go('activity'), 'link')),
  messagesPanel(3));
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
  if (!response.ok) throw Object.assign(new Error(value.error), { known: true });
  return value;
}

async function deliver(payload) {
  sending = true; render();
  try {
    const result = await post('/api/commands', payload);
    const messages = { pause: 'Campaign paused. New dispatch is stopped; running work may finish.', resume: 'Campaign resumed with its existing scope and budget.',
      instruct: 'Instruction received by the supervisor. It is read by the selected role’s next run on this task; the receipt on the campaign card shows Received, Read and the worker’s outcome.',
      recheck: 'Recheck queued. The controller will reassess the selected work; limits and verification still apply.', cancel: 'Cancellation requested. The controller will stop its owned workers.' };
    notice(result.duplicate ? 'This command was already accepted; it was not applied again.' : messages[payload.action]);
    if (payload.action === 'instruct') drafts.delete(payload.campaignId);
  } catch (error) {
    notice(error.known ? error.message : 'Delivery could not be confirmed. Retry this same command safely.', error.known ? null : () => deliver(payload));
  } finally { sending = false; await poll(); }
}

function command(c, action, task, extra = {}) {
  return deliver({ campaignId: c.id, action, requestId: crypto.randomUUID(), version: c.version,
    authorizationVersion: c.authorizationVersion, scopeDigest: c.scopeDigest,
    ...(task ? { taskId: task.id, taskVersion: task.version } : {}), ...extra });
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

// A new destination starts at its top; Back or Forward returns to where that view was left (UX-001 §8, preserve context).
const scrollMemory = new Map();
function go(next, { restore = false } = {}) {
  scrollMemory.set(view, window.scrollY);
  setView(next);
  window.scrollTo(0, restore ? scrollMemory.get(view) ?? 0 : 0);
}
for (const node of document.querySelectorAll('[data-view]')) node.addEventListener('click', () => { if (node.dataset.view !== view) go(node.dataset.view); });
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
  void command(instructionCampaign, 'instruct', task, { role: $('#instruction-role').value, text: $('#instruction-text').value });
});
$('#open-message').addEventListener('click', openMessage);
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
// Our own navigation already set the hash; any other change (Back, Forward, an edited link) restores that view's position.
window.addEventListener('hashchange', () => { if (location.hash.slice(1) !== view) go(location.hash.slice(1), { restore: true }); });
// The visit ends when the page is hidden or closed; the next visit summarizes what changed after this point.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeLastSeen(); });
window.addEventListener('pagehide', writeLastSeen);
setView(location.hash.slice(1));
try { csrf = (await (await fetch('/api/session')).json()).csrf; } catch { notice('Command session unavailable. Reload when the dashboard reconnects.'); }
await poll();
setInterval(() => { if (!sending) void poll(); }, 5000);
