// State copy (docs/design/OWNER_WORKSPACE.md §7, slice S4, build slice UI5): every owner-facing state sentence in one
// module, and the project's Now screen built from it. Pure functions with no imports and no DOM or Node access, so the
// page and Node tests use the same text. The dashboard reads no GitHub (PROJECT_WORKSPACE_PLAN §6.12 C1): the §7.4
// "GitHub stale" copy is the local merge-check copy here, and "not known yet" is about the merge check.
//
// Every state is { key, section, needsYou, title, text, primary }. `title` is the bold sentence, `text` the rest and
// `primary` the one primary action ({ label, route }, { label, url } or { label, command, campaignId }), or null.
// `needsYou` is true for a state that is a Needs me item of this project, false for a calm or neutral state, and null
// when the state is not known. Words for result states follow §2.3: an open pull request is never called merged, and
// unknown is never shown as nothing or zero.

/** Machine words kept out of headings, sentences and buttons (§2.2); they appear only in details. */
export const DETAIL_ONLY_WORDS = ['pipeline', 'fencing', 'lease', 'slots', 'control plane', 'campaign declaration', 'scope digest',
  'authorization version', 'operation', 'executor', 'DAG', 'run ID', 'packet', 'heartbeat', 'campaign'];
/** Claims that text about an open pull request never makes (§2.3, §7). */
export const NOT_FOR_OPEN = ['merged', 'deployed', 'released', 'live', 'done', 'accepted'];
/** A running AI worker whose own record has not moved for this long reads "no progress" (today's dashboard rule). */
export const STUCK_MS = 15 * 60_000;
/** A merge check is current for this long after a successful fetch (src/dashboard/owner.mjs MERGE_FRESH_MS). */
export const MERGE_FRESH_MS = 15 * 60_000;

const PROVIDERS = { 'claude-cli': 'Claude', 'codex-cli': 'Codex', 'cursor-cli': 'Cursor', 'agy-cli': 'AGY browser' };
/** The AI worker's owner-facing name. */
export const providerName = (kind) => PROVIDERS[kind] ?? 'An AI worker';

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const sentence = (text) => !text ? '' : /[.!?…]$/.test(text) ? text : `${text}.`;
const capital = (text) => text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
const shortName = (project) => String(project ?? '').split('/')[1] || String(project ?? '') || 'this project';
const whose = (project) => { const name = shortName(project); return name.endsWith('s') ? `${name}’` : `${name}’s`; };
const label = (task) => task?.outcome ?? task?.title ?? 'a step';
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const PR = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/;
const route = (project, tab) => ({ screen: 'project', project, tab });
const openWork = (project) => ({ label: 'Open current work', route: route(project, 'work') });
const seeResults = (project) => ({ label: 'See results', route: route(project, 'results') });
const stepIssue = (url) => url ? { label: 'Open the step issue', url } : null;
const review = (number, url) => ({ label: `Review pull request #${number}`, url });
// Locale-neutral English times, whatever the computer's own locale: "12:31" and "10 Oct 22:58".
const TIME = (value) => new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const DATE_TIME = (value) => new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '');
const RESTART = 'If nobody is updating it right now, restart it there: sign in on that computer, or start the task “AIWorks Supervisor”.';

/**
 * Every state of §7, by key. `d` is the data the sentence is filled from; `f` the time formatters. Keys a slice has
 * not built yet (Add project, Start work, local projects) are here with the switch that turns them on, off by default.
 */
const STATES = {
  // §7.1 Empty
  'projects-empty': { section: '7.1', needsYou: false, copy: (d) => d.addProject
    // After Add project exists (OW S11, build slice UI13).
    ? ['No projects yet.', 'Add a folder on this computer. It can be a GitHub repository, a local Git repository or an ordinary folder.', { label: 'Add project', route: { screen: 'add-project' } }]
    : ['No projects yet.', 'Projects appear here when this computer’s AIWorks settings list a repository. Adding a project from this page is not built yet.', null] },
  'no-work': { section: '7.1', needsYou: false, copy: (d) => d.startWork
    // After Start work exists (OW S9, build slice UI10).
    ? ['No work yet.', `Tell AIWorks what you want done in ${shortName(d.project)}.`, { label: 'Start work', route: { screen: 'start', project: d.project } }]
    : ['No work yet.', `Work in ${shortName(d.project)} appears here once it is registered on this computer. Starting work from this page is not built yet.`, null] },
  'needs-calm': { section: '7.1', needsYou: false, copy: (d) => ['Nothing is blocked on you right now.', d.also ?? '', null] },
  'results-empty': { section: '7.1', needsYou: false, copy: () => ['No results yet.', 'Results appear here when a step finishes and passes the independent check.', null] },
  'cost-empty': { section: '7.1', needsYou: false, copy: () => ['No cost yet.', 'Nothing has run for this project.', null] },
  // §7.2 Disconnected
  'page-disconnected': { section: '7.2', needsYou: null, copy: (d, f) => ['Can’t reach AIWorks on this computer.',
    `${d.loadedAt ? `Showing what was loaded at ${f.time(d.loadedAt)}.` : 'No state has been loaded yet.'} Buttons are off until it reconnects. Trying again every 5 seconds.`, null] },
  'unreadable': { section: '7.2', needsYou: null, copy: () => ['AIWorks can’t read its work records right now.',
    'What you see may be out of date. Buttons are off until it can read them again.', null] },
  'supervisor-stopped': { section: '7.2', needsYou: true, copy: (d) => [`AIWorks has stopped on ${d.host ?? 'its computer'}.`, `No new step starts. ${RESTART}`, null] },
  'supervisor-late': { section: '7.2', needsYou: false, copy: () => ['AIWorks is a few minutes late checking in.',
    'This is normal during a restart or an update. Nothing for you to do yet.', null] },
  // §7.3 No worker
  'provider-wait': { section: '7.3', needsYou: false, copy: (d, f) => ['Waiting for an AI worker to be free.',
    `${d.retryAt ? `${providerName(d.provider)} can start again at ${f.time(d.retryAt)}. ` : ''}Work continues by itself. Nothing for you to do.`, null] },
  // "See Settings › AI workers" waits for that screen (OW S8, build slice UI9); until then the sentence says where the fix is.
  'no-worker-can-run': { section: '7.3', needsYou: true, copy: (d) => [`No AI worker can run this work on ${d.host ?? 'this computer'}.`,
    `${(d.reasons ?? []).map(sentence).join(' ')}${d.reasons?.length ? ' ' : ''}AIWorks can’t fix this by itself: it needs a change on that computer.`, null] },
  'nothing-running': { section: '7.3', needsYou: false, copy: (d) => ['No AI worker is busy on this project right now.',
    `${d.next ? `“${d.next}”` : 'The next step'} starts when it is ready.`, openWork(d.project)] },
  // §7.4 became the local merge-check copy (C1). A note on the screen that uses the data; no primary action.
  'merge-old': { section: '7.4', needsYou: false, copy: (d, f) => [`Merge check from ${f.time(d.at)}; checking again.`,
    'Pull request states may be out of date, so no step is shown as merged until the check is current.', null] },
  'merge-failed': { section: '7.4', needsYou: false, copy: (d, f) => [d.at ? `Merge check from ${f.time(d.at)}; the last check failed, retrying.` : 'The merge check failed; retrying.',
    'Pull request states may be out of date, so no step is shown as merged until the check is current.', null] },
  'merge-never': { section: '7.4', needsYou: false, copy: (d) => ['Checking for merges…', `The state of ${plural(d.count, 'result')} is not known yet.`, null] },
  // §7.5 Paused: neutral, never a Needs me item by itself.
  'paused': { section: '7.5', needsYou: false, copy: (d, f) => [d.pausedAt ? `Paused since ${f.dateTime(d.pausedAt)}.` : 'Paused.',
    `No new step starts. A step already running may finish.${d.reason ? ` Reason given: “${d.reason}”.` : ''}`, { label: 'Resume', command: 'resume', campaignId: d.campaignId }] },
  'paused-stopped': { section: '7.5', needsYou: true, copy: (d) => [`Paused, and AIWorks has stopped on ${d.host ?? 'its computer'}.`,
    `Nothing can resume until it runs again. ${RESTART}`, null] },
  // §7.6 Running
  'builder-working': { section: '7.6', needsYou: false, copy: (d, f) => [`Working on: ${sentence(d.step)}`,
    `The builder (${providerName(d.provider)}) started at ${f.time(d.startedAt)}${d.lastActivityAt ? ` · last activity ${ago(d.now - d.lastActivityAt)}` : ''}.`, openWork(d.project)] },
  'checker-working': { section: '7.6', needsYou: false, copy: (d) => [`Checking: ${sentence(d.step)}`,
    `An independent checker (${providerName(d.provider)}) is reviewing the result.`, openWork(d.project)] },
  'possibly-stuck': { section: '7.6', needsYou: false, copy: (d) => [`${d.step}: no progress for ${plural(d.minutes, 'minute')}.`,
    'AIWorks retries by itself if the worker stops.', openWork(d.project)] },
  'waiting-for-merge': { section: '7.6', needsYou: true, copy: (d) => [`Waiting for you to merge “${d.step}”.`,
    `${d.next ? `“${d.next}” starts` : 'The next step starts'} once you merge it.`, review(d.number, d.url)] },
  'awaiting-pickup': { section: '7.6', needsYou: false, copy: (d, f) => [`Approved at ${f.time(d.registeredAt)}; waiting for AIWorks to pick it up.`, 'Nothing for you to do yet.', null] },
  'cancelling': { section: '7.6', needsYou: false, copy: () => ['Cancelling: waiting for running AI workers to stop.', 'Nothing for you to do.', null] },
  // §4.4: what needs the owner, when no §7.6–7.8 sentence says it more exactly.
  'review': { section: '4.4', needsYou: true, copy: (d) => [`Pull request #${d.number} waits for your review.`, sentence(d.step), review(d.number, d.url)] },
  'one-thing': { section: '4.4', needsYou: true, copy: (d) => ['One thing needs you.',
    sentence([d.action, d.text].filter(Boolean).join(': ')), d.url ? { label: d.linkLabel ?? 'Open it', url: d.url } : { label: 'See what needs you', route: { screen: 'needs' } }] },
  'several': { section: '4.4', needsYou: true, copy: (d) => [`${capital(plural(d.count, 'thing'))} need you.`,
    'Each one says what to do in Needs me.', { label: `See the ${d.count} things that need you`, route: { screen: 'needs' } }] },
  'supervisor-fault': { section: '7.7', needsYou: true, copy: () => ['AIWorks has a problem of its own with this work.',
    'It is not yours to fix: it is tracked for AIWorks’ maintainers. This work may not move until it is fixed.', null] },
  // §7.7 Blocked
  'needs-decision': { section: '7.7', needsYou: true, copy: (d) => ['Stopped: needs your decision.', `${d.step}: ${sentence(d.reason)}`, stepIssue(d.url)] },
  'failed-attempts': { section: '7.7', needsYou: true, copy: (d) => [`Stopped: ${plural(d.attempts, 'attempt')} failed.`,
    `${sentence(d.step)} It will not retry by itself. Fix the cause, then check it again.`, stepIssue(d.url)] },
  'recorded-blocker': { section: '7.7', needsYou: true, copy: (d) => ['Stopped: AIWorks needs a fix on this computer.',
    `${sentence(d.reason)}${d.action ? ` What to do: ${sentence(d.action)}` : ''}`, null] },
  'others-continue': { section: '7.7', needsYou: true, copy: (d) => ['One step is stopped; the others continue.',
    d.decision ? `${d.step} needs your decision.` : `${d.step} stopped after ${plural(d.attempts, 'failed attempt')}.`, stepIssue(d.url)] },
  // §7.8 Finished. "Merged" only with a current merge check; unknown is said, never counted as nothing.
  'finished-open': { section: '7.8', needsYou: true, copy: (d) => ['All steps are finished.',
    `${plural(d.awaiting, 'pull request')} ${d.awaiting === 1 ? 'waits' : 'wait'} for your review${d.merged ? ` · ${d.merged} merged` : ''}.`, seeResults(d.project)] },
  'finished-merged': { section: '7.8', needsYou: false, copy: (d) => ['All steps are finished and merged.',
    `Release follows ${whose(d.project)} ${d.standing ? 'standing deploy authorization' : 'release policy'}.`, seeResults(d.project)] },
  'finished-unknown': { section: '7.8', needsYou: false, copy: (d) => ['All steps are finished.',
    `The merge state of ${plural(d.count, 'result')} is not known yet, so this is not settled.`, seeResults(d.project)] },
  'finished-reports': { section: '7.8', needsYou: false, copy: (d) => ['All steps are finished.',
    `${plural(d.reports, 'report')} posted for you to read${d.merged ? ` · ${d.merged} merged` : ''}.`, seeResults(d.project)] },
  // Needs the closed state of a pull request, which the local merge check does not see (C1); the copy is ready for it.
  'finished-closed': { section: '7.8', needsYou: false, copy: (d) => ['All steps are finished.',
    `${plural(d.closed, 'pull request')} ${d.closed === 1 ? 'was' : 'were'} closed without merging, so that work is not in ${shortName(d.project)}.`, seeResults(d.project)] },
  // Local projects (OW S12, build slice UI17) wait for #24 and #32; nothing selects this state until then.
  'finished-local': { section: '7.8', needsYou: false, copy: (d) => ['All steps are finished.',
    'The checked result is ready to apply. Nothing in your folder has changed yet.', seeResults(d.project)] },
  'cancelled': { section: '7.8', needsYou: false, copy: (d) => ['Cancelled.', `${d.delivered} of ${plural(d.total, 'step')} had results before it stopped.`, seeResults(d.project)] },
};

/** Every state key, in §7 order. */
export const STATE_KEYS = Object.freeze(Object.keys(STATES));

function ago(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${plural(minutes, 'minute')} ago` : `${plural(Math.floor(minutes / 60), 'hour')} ago`;
}

/** The copy of one state, filled from `data`. `format` may replace the time formatters ({ time, dateTime }). */
export function stateCopy(key, data = {}, format = {}) {
  const state = STATES[key];
  if (!state) throw new Error(`No copy for state ${key}`);
  const [title, text, primary] = state.copy({ now: Date.now(), ...data }, { time: format.time ?? TIME, dateTime: format.dateTime ?? DATE_TIME });
  return { key, section: state.section, needsYou: state.needsYou, title, text, primary };
}

/**
 * Progress in the owner's terms: "6 of 9 steps have results · 3 merged · 2 waiting for your review". `counts` are the
 * owner view's counts of one piece of work; without them progress is not known, and says so.
 */
export function progressText(counts) {
  if (!counts || !Number.isSafeInteger(counts.total)) return 'Progress is not known yet.';
  const parts = [`${counts.delivered ?? 0} of ${counts.total} ${counts.total === 1 ? 'step has' : 'steps have'} results`];
  if (counts.merged) parts.push(`${counts.merged} merged`);
  if (counts.awaiting) parts.push(`${counts.awaiting} waiting for your review`);
  if (counts.reports) parts.push(`${plural(counts.reports, 'report')} for you to read`);
  if (counts.checking) parts.push(`the merge of ${counts.checking} is being checked`);
  if (counts.unknown) parts.push(`${counts.unknown} without a recorded result link`);
  return parts.join(' · ');
}

/**
 * "Since you last looked", for one project's pieces of work (`ids`): lines of { text, links, tone }. `recent` is the
 * owner view's summary across projects and `failures` the supervisor's recent failures (each with its campaignId);
 * null when it is not known. The supervisor's own faults are not this project's and stay on the Projects screen.
 */
export function sinceLines(recent, ids, failures = []) {
  if (!recent) return null;
  const mine = (list) => (list ?? []).filter((item) => ids.includes(item.campaignId));
  const prs = (list) => list.filter((item) => item.url).map((item) => ({ label: `#${item.number}`, url: item.url }));
  const merged = mine(recent.merged), delivered = mine(recent.delivered), waiting = mine(recent.waiting);
  const runs = mine(failures).filter((item) => ['failed-run', 'rejected'].includes(item.kind)), rejected = runs.filter((item) => item.kind === 'rejected').length;
  return [
    merged.length ? { text: `${plural(merged.length, 'step')} merged`, links: prs(merged), tone: null } : null,
    delivered.length ? { text: `${plural(delivered.length, 'step')} finished and passed the check`, links: [], tone: null } : null,
    waiting.length ? { text: `${waiting.length} newly waiting for your review`, links: prs(waiting), tone: 'attention' } : null,
    runs.length ? { text: `${plural(runs.length, 'AI worker run')} did not succeed${rejected ? ` (${rejected} rejected by the independent checker)` : ''}; AIWorks retries by itself`, links: [], tone: 'warn' } : null,
  ].filter(Boolean);
}

/** The step a task row names, by its result or issue link. */
const taskBy = (c, key, url) => url ? c?.tasks.find((task) => task[key] === url) ?? null : null;

/** The state for one Needs me item of this project. */
function itemState(item, c, d) {
  if (item.kind === 'controller' && item.system) return ['supervisor-fault', {}];
  if (item.kind === 'controller') return [c?.control === 'paused' ? 'paused-stopped' : 'supervisor-stopped', {}];
  if (item.kind === 'review') {
    const task = taskBy(c, 'resultUrl', item.link?.url), number = PR.exec(item.link?.url ?? '')?.[1];
    if (task && number) {
      // A step that cannot start until this one is merged: the owner's merge is what the work waits for.
      const gated = c.tasks.find((other) => other.state === 'pending' && other.requiresMergedDependencies && other.dependsOn.includes(task.id));
      if (gated) return ['waiting-for-merge', { step: label(task), next: label(gated), number, url: item.link.url }];
      const counts = d.owner?.campaigns?.[c.id]?.counts;
      if (c.control === 'finished' && counts) return ['finished-open', { awaiting: counts.awaiting, merged: counts.merged }];
      return ['review', { step: label(task), number, url: item.link.url }];
    }
  }
  if (['decision', 'stopped'].includes(item.kind)) {
    const task = taskBy(c, 'issueUrl', item.link?.url);
    if (task?.blocked) {
      const decision = task.blocked === 'B3';
      const others = c.control !== 'paused' && c.tasks.some((other) => other !== task && other.state !== 'done' && !other.blocked);
      const data = { step: label(task), reason: task.blockedReason, attempts: task.attempts, url: task.issueUrl, decision };
      return [others ? 'others-continue' : decision ? 'needs-decision' : 'failed-attempts', data];
    }
    if (c?.blocker) {
      if (c.blocker === 'executors') {
        const reasons = [...new Set((c.providers ?? []).filter((p) => p.priority !== null).map((p) => p.hostLimit ?? p.availabilityReason).filter(Boolean))];
        return ['no-worker-can-run', { reasons }];
      }
      return ['recorded-blocker', { reason: c.blockerReason ?? 'A recorded blocker stops this work', action: c.blockerAction }];
    }
  }
  const [, number] = PR.exec(item.link?.url ?? '') ?? [];
  return ['one-thing', { action: item.action, text: item.text, url: item.link?.url ?? null, linkLabel: number ? `Review pull request #${number}` : item.link ? 'Open the step issue' : null }];
}

/** The state of active (not finished or cancelled) work with nothing for the owner. */
function activeState(active, d) {
  const owner = (c) => d.owner?.campaigns?.[c.id];
  const late = active.find((c) => owner(c)?.liveness === 'late');
  if (late) return [late, 'supervisor-late', {}];
  const going = active.filter((c) => c.control !== 'paused');
  if (going.length && going.every((c) => c.control === 'cancel-requested')) return [going[0], 'cancelling', {}];
  // A worker whose own record stopped moving is said first; otherwise the first one at work.
  const agents = going.flatMap((c) => c.agents.map((agent) => ({ c, agent, task: c.tasks.find((item) => item.id === agent.taskId),
    last: agent.progress?.lastActivityAt ?? agent.outputAt ?? null })));
  const stuck = agents.find(({ last }) => last && d.now - last >= STUCK_MS);
  if (stuck) return [stuck.c, 'possibly-stuck', { step: capital(label(stuck.task)), minutes: Math.floor((d.now - stuck.last) / 60_000) }];
  if (agents.length) {
    const [{ c, agent, task, last }] = agents;
    return [c, agent.role === 'Verifier' ? 'checker-working' : 'builder-working', { step: label(task), provider: agent.executor, startedAt: agent.startedAt, lastActivityAt: last }];
  }
  const waiting = going.find((c) => c.waitingReason === 'provider-availability');
  if (waiting) {
    const next = (waiting.providers ?? []).filter((p) => p.priority !== null && p.retryAt > d.now).sort((a, b) => a.retryAt - b.retryAt)[0];
    return [waiting, 'provider-wait', { provider: next?.kind ?? null, retryAt: next?.retryAt ?? null }];
  }
  const pickup = active.find((c) => owner(c)?.liveness === 'awaiting-pickup');
  if (pickup) return [pickup, 'awaiting-pickup', { registeredAt: owner(pickup).registeredAt }];
  if (!going.length) {
    const c = active[0];
    return [c, 'paused', { pausedAt: c.pausedAt, reason: c.pausedReason, campaignId: c.id }];
  }
  const c = going[0];
  const ready = c.tasks.find((task) => task.state !== 'done' && !task.blocked && task.dependsOn.every((id) => c.tasks.find((t) => t.id === id)?.state === 'done'));
  return [c, 'nothing-running', { next: ready ? label(ready) : null }];
}

/** The state of finished or cancelled work: the most recent piece. */
function finishedState(c, d) {
  const view = d.owner?.campaigns?.[c.id], counts = view?.counts;
  if (c.control === 'cancelled') return ['cancelled', { delivered: counts?.delivered ?? c.tasks.filter((task) => task.state === 'done').length, total: c.tasks.length }];
  if (!counts) return ['finished-unknown', { count: c.tasks.length }];
  const unknown = counts.total - counts.delivered + counts.checking + counts.unknown;
  if (unknown) return ['finished-unknown', { count: unknown }];
  if (counts.awaiting) return ['finished-open', { awaiting: counts.awaiting, merged: counts.merged }];
  if (counts.reports) return ['finished-reports', { reports: counts.reports, merged: counts.merged }];
  return ['finished-merged', { standing: /standing deploy authorization/.test(view.finished ?? '') }];
}

/** The local merge check of this project's repository, when it is not current (§7.4 as C1 resolves it). */
function mergeNote(project, merges, counts, now) {
  const repo = (merges?.repositories ?? []).find((item) => same(item.repository, project));
  // Only work with pull requests depends on the merge check; reports do not.
  if (!repo || repo.configured === false || !(counts?.merged || counts?.awaiting || counts?.checking)) return null;
  const at = Number.isSafeInteger(repo.fetchedAt) ? repo.fetchedAt : null;
  if (repo.error) return ['merge-failed', { at }];
  if (at === null) return counts?.checking ? ['merge-never', { count: counts.checking }] : null;
  return now - at >= MERGE_FRESH_MS ? ['merge-old', { at }] : null;
}

/**
 * The project's Now screen (§4.4): its goal, one state sentence with at most one primary action, progress, a merge
 * note when the merge check is not current, and "since you last looked" for this project only. `data` is the page's
 * /api/state answer ({ supervisor, owner, merges, host, observedAt }) plus `offline` when the page cannot reach the
 * dashboard. The state is about this project alone: it needs the owner exactly when this project has Needs me items.
 * `options.startWork` turns on the Start work action (OW S9); it is off until that screen exists.
 */
export function nowView(project, data = {}, { now = Date.now(), format = {}, startWork = false } = {}) {
  const { supervisor, owner, merges, offline = false } = data, host = data.host?.name ?? null;
  const d = { owner, now };
  const make = (key, values = {}) => stateCopy(key, { project, host, now, ...values }, format);
  const campaigns = (supervisor?.campaigns ?? []).filter((c) => same(c.repository, project));
  const recency = (c) => Date.parse(c.lastProgressAt ?? '') || c.registeredAt || 0;
  const result = (state, c = null) => {
    const view = c ? owner?.campaigns?.[c.id] : null, merge = c ? mergeNote(project, merges, view?.counts, now) : null;
    return { project, name: shortName(project), state,
      goal: view?.purpose ? { text: view.purpose.text, variant: view.purpose.variant ?? null } : null,
      progress: c ? progressText(view?.counts) : null, note: merge ? make(...merge) : null,
      since: sinceLines(owner?.recent ?? null, campaigns.map((item) => item.id), supervisor?.recent?.failures ?? []),
      details: { workId: c?.id ?? null, trackingUrl: c?.trackingUrl ?? null, trackingIssue: c?.trackingIssue ?? null,
        others: campaigns.filter((item) => item !== c).map((item) => ({ id: item.id, purpose: owner?.campaigns?.[item.id]?.purpose?.text ?? null, control: item.control })) } };
  };
  if (offline) return result(make('page-disconnected', { loadedAt: Date.parse(data.observedAt ?? '') || null }));
  if (!supervisor?.available || !owner?.available) return result(make('unreadable'));
  if (!campaigns.length) return result(make('no-work', { startWork }));
  const items = (owner.items ?? []).filter((item) => same(item.repository, project));
  const byId = (id) => campaigns.find((c) => c.id === id) ?? null;
  if (items.length) {
    // AIWorks itself stopped leads: nothing in this project moves until it runs again.
    const stopped = items.find((item) => item.kind === 'controller' && !item.system);
    if (stopped) return result(make(...itemState(stopped, byId(stopped.campaignId), d)), byId(stopped.campaignId));
    const first = byId(items[0].campaignId), counts = owner.campaigns?.[first?.id]?.counts;
    // Only pull requests of one finished piece of work: §7.8 says it more exactly than a count.
    if (first?.control === 'finished' && counts && items.every((item) => item.kind === 'review' && item.campaignId === first.id)) {
      return result(make('finished-open', { awaiting: counts.awaiting, merged: counts.merged }), first);
    }
    if (items.length > 1) return result(make('several', { count: items.length }), first);
    return result(make(...itemState(items[0], first, d)), first);
  }
  const active = campaigns.filter((c) => !['finished', 'cancelled'].includes(c.control));
  if (active.length) {
    const [c, key, values] = activeState(active, d);
    return result(make(key, values), c);
  }
  const latest = [...campaigns].sort((a, b) => recency(b) - recency(a))[0];
  return result(make(...finishedState(latest, d)), latest);
}
