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
/** A worker waiting on one command (a test suite, a build) is busy, not stuck, for up to this long while its runner is alive. */
export const COMMAND_MAX_MS = 60 * 60_000;
/**
 * Minutes a live worker has been waiting on its newest command, or null. The worker's record does not move while a long
 * command runs, so without this a full test suite reads as "no progress" (#102). A dead runner or a command running
 * longer than COMMAND_MAX_MS is not busy: those still read as possibly stuck.
 */
export function busyOnCommand(agent, now) {
  const since = agent?.progress?.runningTool ? agent.progress.runningSince : null;
  if (agent?.heartbeatState !== 'recent' || !Number.isFinite(since) || now - since >= COMMAND_MAX_MS) return null;
  return Math.max(0, Math.floor((now - since) / 60_000));
}
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
// The dashboard reads the AIWorks records of the computer it runs on (AW-006), so the computer AIWorks runs on is always
// "this computer"; its name is in the page header (aiworks#11 review F22).
const RESTART = 'If nobody is updating it right now, restart it on this computer: sign out and sign in again, or start the task “AIWorks Supervisor”.';
/** What restarts AIWorks when it has stopped (docs/SUPERVISOR.md §6), in the owner's words. */
export const RESTART_ADVICE = RESTART;

/**
 * Every state of §7, by key. `d` is the data the sentence is filled from; `f` the time formatters. Keys a slice has
 * not built yet (Add project, Start work, local projects) are here with the switch that turns them on, off by default.
 */
const STATES = {
  // §7.1 Empty
  'projects-empty': { section: '7.1', needsYou: false, copy: (d) => d.addProject
    // After Add project exists (OW S11, build slice UI13).
    ? ['No projects yet.', 'Add a folder on this computer. It can be a GitHub repository, a local Git repository or an ordinary folder.', { label: 'Add project', route: { screen: 'add-project' } }]
    // "Configuration file", never "settings": the Settings screen cannot list a repository (aiworks#11 review F18).
    : ['No projects yet.', 'Projects appear here when the AIWorks configuration file on this computer lists a repository. Adding a project from this page is not built yet.', null] },
  'no-work': { section: '7.1', needsYou: false, copy: (d) => d.startWork
    // After Start work exists (OW S9, build slice UI10).
    ? ['No work yet.', `Tell AIWorks what you want done in ${shortName(d.project)}.`, { label: 'Start work', route: { screen: 'start', project: d.project } }]
    : ['No work yet.', `Work in ${shortName(d.project)} appears here once it is registered on this computer. Starting work from this page is not built yet.`, null] },
  // Calm means nothing at all for the owner: reports and releases are on Results, never named here (owner, 2026-10-13).
  'needs-calm': { section: '7.1', needsYou: false, copy: () => ['Nothing is blocked on you right now.', '', null] },
  'results-empty': { section: '7.1', needsYou: false, copy: () => ['No results yet.', 'Results appear here when a step finishes and passes the independent check.', null] },
  'cost-empty': { section: '7.1', needsYou: false, copy: () => ['No cost yet.', 'Nothing has run for this project.', null] },
  // §7.2 Disconnected
  'page-disconnected': { section: '7.2', needsYou: null, copy: (d, f) => ['Can’t reach AIWorks on this computer.',
    `${d.loadedAt ? `Showing what was loaded at ${f.time(d.loadedAt)}.` : 'No state has been loaded yet.'} Buttons are off until it reconnects. Trying again every 5 seconds.`, null] },
  'unreadable': { section: '7.2', needsYou: null, copy: () => ['AIWorks can’t read its work records right now.',
    'What you see may be out of date. Buttons are off until it can read them again.', null] },
  'supervisor-stopped': { section: '7.2', needsYou: true, copy: (d, f) => [`AIWorks has stopped on this computer${stoppedAt(d.stoppedAt, f)}.`, `No new step starts. ${RESTART}`, null] },
  'supervisor-late': { section: '7.2', needsYou: false, copy: () => ['AIWorks is a few minutes late checking in.',
    'This is normal during a restart or an update. Nothing for you to do yet.', null] },
  // §7.3 No worker
  'provider-wait': { section: '7.3', needsYou: false, copy: (d, f) => ['Waiting for an AI worker to be free.',
    `${d.retryAt ? `${providerName(d.provider)} can start again at ${f.time(d.retryAt)}. ` : ''}Work continues by itself. Nothing for you to do.`, null] },
  // "See Settings › AI workers" waits for that screen (OW S8, build slice UI9); until then the sentence says where the fix is.
  'no-worker-can-run': { section: '7.3', needsYou: true, copy: (d) => ['No AI worker can run this work on this computer.',
    `${(d.reasons ?? []).map(sentence).join(' ')}${d.reasons?.length ? ' ' : ''}AIWorks can’t fix this by itself: it needs a change on this computer.`, null] },
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
  // One time per event, written the same on every screen: the pause with its date, the stop "at about" its time (F23).
  'paused-stopped': { section: '7.5', needsYou: true, copy: (d, f) => [`${d.pausedAt ? `Paused since ${f.dateTime(d.pausedAt)}` : 'Paused'}, and AIWorks has stopped on this computer${stoppedAt(d.stoppedAt, f)}.`,
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
  // Not an owner action, so not one of the project's Needs me items (review F17).
  'supervisor-fault': { section: '7.7', needsYou: false, copy: () => ['AIWorks has a problem of its own with this work.',
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
  // Merging delegated by the owner (#97): the pull requests still open are merged for them, so nothing waits for them.
  'finished-delegated': { section: '7.8', needsYou: false, copy: (d) => ['All steps are finished.',
    `${plural(d.delegated, 'pull request')} passed the check and ${d.delegated === 1 ? 'is' : 'are'} to be merged for you${d.merged ? ` · ${d.merged} merged` : ''}.`, seeResults(d.project)] },
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

/** "at about 02:24": when AIWorks stopped, the same words wherever that stop is said. */
const stoppedAt = (at, f) => at ? ` at about ${f.time(at)}` : '';

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
  if (counts.delegated) parts.push(DELEGATED.progress(counts.delegated));
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
      return ['recorded-blocker', blockerWords(c.blocker)];
    }
  }
  const [, number] = PR.exec(item.link?.url ?? '') ?? [];
  // A delegated merge that waited too long (#139): the step and how long it waited; its action opens the pull request.
  if (item.kind === 'merge-stalled' && number) return ['one-thing', { action: item.text, text: item.points[0]?.text, url: item.link.url, linkLabel: `Open pull request #${number}` }];
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
  const stuck = agents.find(({ agent, last }) => last && d.now - last >= STUCK_MS && busyOnCommand(agent, d.now) === null);
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
  // Reports are the owner's to read, so they are said before pull requests merged for the owner.
  if (counts.reports) return ['finished-reports', { reports: counts.reports, merged: counts.merged }];
  if (counts.delegated) return ['finished-delegated', { delegated: counts.delegated, merged: counts.merged }];
  return ['finished-merged', { standing: /standing deploy authorization/.test(view.finished ?? '') }];
}

/** The local merge check of this project's repository, when it is not current (§7.4 as C1 resolves it). */
function mergeNote(project, merges, counts, now) {
  const repo = (merges?.repositories ?? []).find((item) => same(item.repository, project));
  // Only work with pull requests depends on the merge check; reports do not.
  if (!repo || repo.configured === false || !(counts?.merged || counts?.awaiting || counts?.delegated || counts?.checking)) return null;
  const at = Number.isSafeInteger(repo.fetchedAt) ? repo.fetchedAt : null;
  if (repo.error) return ['merge-failed', { at }];
  if (at === null) return counts?.checking ? ['merge-never', { count: counts.checking }] : null;
  return now - at >= MERGE_FRESH_MS ? ['merge-old', { at }] : null;
}

/**
 * The project's Now screen (§4.4): its goal, one state sentence with at most one primary action, progress, a merge
 * note when the merge check is not current, and "since you last looked" for this project only. `data` is the page's
 * /api/state answer ({ supervisor, owner, merges, host, observedAt }) plus `offline` when the page cannot reach the
 * dashboard. The state is about this project alone: it needs the owner when this project has Needs me items, or when
 * AIWorks stopped on this computer holds up its work (that one item is listed under AIWorks itself).
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
  // This project's Needs me items: the ones the Projects screen counts and Needs me lists under it (review F6).
  const items = (owner.items ?? []).filter((item) => same(item.repository, project));
  const byId = (id) => campaigns.find((c) => c.id === id) ?? null;
  // With several pieces of work, what needs the owner leads (review F16): this project's Needs me items, then a pause the
  // owner can resume, then AIWorks stopped for its work, then a fault of AIWorks itself; then work that goes on by itself.
  if (items.length) {
    const first = byId(items[0].campaignId), counts = owner.campaigns?.[first?.id]?.counts;
    // Only pull requests of one finished piece of work: §7.8 says it more exactly than a count.
    if (first?.control === 'finished' && counts && items.every((item) => item.kind === 'review' && item.campaignId === first.id)) {
      return result(make('finished-open', { awaiting: counts.awaiting, merged: counts.merged }), first);
    }
    if (items.length > 1) return result(make('several', { count: items.length }), first);
    return result(make(...itemState(items[0], first, d)), first);
  }
  const liveness = (c) => owner.campaigns?.[c.id]?.liveness;
  const active = campaigns.filter((c) => !['finished', 'cancelled'].includes(c.control));
  // Resume works only while AIWorks runs this work; a pause AIWorks is late on keeps today's "late" sentence.
  const resumable = active.find((c) => c.control === 'paused' && liveness(c) === 'running');
  if (resumable) return result(make('paused', { pausedAt: resumable.pausedAt, reason: resumable.pausedReason, campaignId: resumable.id }), resumable);
  // AIWorks stopped on this computer: nothing of this work moves until it runs again (§7.2, §7.5).
  const stopped = active.find((c) => ['stopped', 'agent-working-supervisor-silent'].includes(liveness(c)));
  if (stopped) {
    return result(make(stopped.control === 'paused' ? 'paused-stopped' : 'supervisor-stopped',
      { stoppedAt: owner.campaigns[stopped.id].lastCheckIn ?? null, pausedAt: stopped.pausedAt ?? null }), stopped);
  }
  // Not an owner action, but this work may not move until it is fixed (§7.7).
  const fault = (owner.items ?? []).find((item) => item.system && item.campaignId && same(item.about, project));
  if (fault) return result(make('supervisor-fault'), byId(fault.campaignId));
  if (active.length) {
    const [c, key, values] = activeState(active, d);
    return result(make(key, values), c);
  }
  const latest = [...campaigns].sort((a, b) => recency(b) - recency(a))[0];
  return result(make(...finishedState(latest, d)), latest);
}

/*
 * Owner words outside the §7 states (aiworks#11 review F3, F7, F14, F22, F23 and F24): Needs me items, a piece of work's
 * one-line state on Work, refusals and notices of commands, and the Cost summary. The machine's own words (the stop
 * class, the AI worker's internal name, step and work IDs, the rule a refusal cites) stay in Details or Diagnostics.
 */

/** Why work is stopped by a recorded blocker, by its kind: what happened and what to do. Never the stored text. */
export function blockerWords(kind) {
  if (kind === 'executors') return { reason: 'No AI worker on this computer can do this step',
    action: 'Set up an AI worker that can do it on this computer (see Settings), then choose Check again under More' };
  if (kind === 'budget') return { reason: 'This work has used all the runs or cost it was approved for',
    action: 'Decide whether to allow more. If you do, approve it again with higher limits' };
  return { reason: 'AIWorks stopped this work and needs a fix on this computer',
    action: 'See Settings › Diagnostics for what it recorded, fix it, then choose Check again under More' };
}

/**
 * Why a step stopped, from the supervisor-known stop record of the step only (`blocked`: { class, reason }), never its
 * free text, which may quote a worker. `rounds` is the step's repair rounds.
 */
export function stopReasonWords(blocked, rounds = 0) {
  const reason = String(blocked?.reason ?? '');
  const stuck = /^no progress: (\d+)/.exec(reason);
  if (blocked?.class === 'B3' && stuck) return `no progress after ${plural(Number(stuck[1]), 'attempt')} that could not go on; see the step issue, then check it again`;
  if (blocked?.class === 'B3') return /^owner-reserved/.test(reason) ? 'the AI worker needs your decision; see the step issue' : 'it needs your decision';
  if (/^verifier still rejects/.test(reason)) return `the independent checker still rejects it after ${plural(rounds, 'repair round')}; decide whether to accept the gap, narrow the step or allow more rounds, then check it again`;
  if (/^admission blocked/.test(reason)) return 'the rules for AI workers on this computer did not let it start';
  const failed = /^(\d+) failed attempts; last ([a-z-]+)/.exec(reason);
  if (failed) return `${failed[1]} failed attempts (last: ${failed[2].replaceAll('-', ' ')}); check it again after fixing the cause`;
  return 'it stopped; see Settings › Diagnostics for what AIWorks recorded';
}

/**
 * A verified pull request whose merge the owner delegated (config.json `merges`, #17, #97): not a Needs me item, never
 * called merged before it is. `held` is why one is held from merging, by the reason key config.json records. `by` is
 * who merges (`merges.delegatedTo`): AIWorks itself (`supervisor`, #138) merges after its check against the latest
 * main; anyone else is not named. There is no CI to wait for. One that waited too long since its check is `stalled`:
 * a Needs me item again (#139).
 */
const MERGES_AFTER = 'AIWorks merges it after it passes the check against the latest main';
export const DELEGATED = {
  word: 'Passed the check',
  note: (by) => by === 'supervisor' ? `${MERGES_AFTER}. Nothing for you to do.` : 'Will be merged for you. Nothing for you to do.',
  row: (number, by) => `Pull request #${number} · passed the check · ${by === 'supervisor' ? MERGES_AFTER : 'will be merged for you'}`,
  heldRow: (number, reason) => `Pull request #${number} · ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`,
  progress: (n) => `${n} to be merged for you`,
  stalledAction: 'Check why it is not merged',
  stalled: (hours) => `Checked and waiting to be merged for ${plural(hours, 'hour')}. Nothing has merged it.`,
  stalledRow: (number, hours) => `Pull request #${number} · checked and waiting to be merged for ${plural(hours, 'hour')}`,
  held: {
    'newer-work': 'Held: waiting to be combined with newer work',
    other: 'Held for now; the pull request says why',
  },
};

/** Needs me items about AIWorks itself and about stopped work, in the owner's words. */
export const NEEDS = {
  stepIssue: 'Open the step issue',
  workStopped: 'This work is stopped',
  recorded: 'What AIWorks recorded',
  fault: { text: 'AIWorks has a problem of its own with this work', link: 'AIWorks issue #2',
    point: 'Not yours to fix: it is tracked for AIWorks’ maintainers. This work may not move until it is fixed.' },
  // AIWorks stopped on this computer is said once (review F9). The page adds "at about <time>" after the text, so the time
  // always follows the stop, never the pause (F23). With one piece of work held up, the item is worded for it:
  silent: { text: 'An AI worker is still working, but AIWorks stopped checking in on this computer',
    point: `Its result is collected and checked only when AIWorks runs again. ${RESTART}` },
  notPickedUp: (paused) => ({ text: `AIWorks on this computer has not picked up this work yet${paused ? ' (it is paused)' : ''}`,
    point: `It is approved${paused ? ' and paused' : ''}, but AIWorks has not picked it up. ${RESTART}` }),
  stopped: (paused) => paused
    ? { text: 'This work was paused, then AIWorks stopped on this computer', point: `No step starts while it is paused, and it can’t resume until AIWorks runs again. ${RESTART}` }
    : { text: 'AIWorks stopped on this computer', point: `No new step starts. ${RESTART}` },
  // with several, it names the work it holds up per project. `pickup` when it never picked up any of it.
  halted: (pickup) => pickup
    ? { text: 'AIWorks on this computer has not picked up approved work', point: `None of it starts until AIWorks runs. ${RESTART}` }
    : { text: 'AIWorks stopped on this computer', point: `No new step starts. ${RESTART}` },
  /** A Needs me group's count: its owner actions, and the items listed there that are not (review F17). */
  groupCount: (count, notCounted) => `${count ? ` (${count})` : ''}${notCounted ? ` · ${count ? 'also ' : ''}${plural(notCounted, 'item')} for its maintainers, not counted` : ''}`,
  /** One piece of work a stopped AIWorks holds up, with what that means for it when the item's text does not say it. */
  heldWork: (name, how, paused) => {
    const notes = [paused ? 'paused; it can’t resume until AIWorks runs again' : null, how === 'not-picked-up' ? 'not picked up yet' : null,
      how === 'silent' ? 'an AI worker is still working; its result is collected and checked only when AIWorks runs again' : null].filter(Boolean);
    return `“${name}”${notes.length ? ` (${notes.join('; ')})` : ''}`;
  },
  /** The work a stopped AIWorks holds up in one project. */
  heldUp: (project, works) => `Held up in ${project}: ${works.join(', ')}.`,
  /** The banner when this computer's AIWorks has stopped; `at` is its last check-in. */
  banner: (at, f, onPurpose) => `AIWorks has stopped on this computer. It last checked in ${at ? f.dateTime(at) : 'at a time not known'}${onPurpose ? ' (it was stopped on purpose: an update or its operator)' : ''}.`,
  /** The check evidence of a step waiting for review (§2.3: "Passed the check", never "accepted"). */
  evidence: (sha7) => ({ short: `Passed the check at ${sha7} · CI and conflicts on the PR`,
    text: `Passed the independent check at commit ${sha7}. This dashboard does not read CI checks or conflicts; see them on the pull request before merging.` }),
  noEvidence: { short: 'Independent check not recorded here',
    text: 'Published by AIWorks; the independent check is not recorded here. See CI checks and conflicts on the pull request before merging.' },
  churn: (attempts, rejections) => `Check its review history first: it took ${plural(attempts, 'try', 'tries')}${rejections ? ` and the independent checker rejected it ${plural(rejections, 'time')}` : ''} before it passed the check.`,
  gated: (names) => `${names} cannot start until you merge it.`,
  buildsOn: (names) => `Merging lets ${names} build on it.`,
  startedWithout: (names, n) => `${names} already started without it, so merging now does not change ${n === 1 ? 'that step' : 'those steps'}.`,
  nothingWaits: (rule) => `Nothing else in this work waits on it; after merging, release follows ${rule}.`,
};

/**
 * A piece of work's state in one line, for its panel on Work. `c` is the supervisor snapshot of the work and `owner`
 * the owner view's entry for it. Steps are named by their outcome, never by ID.
 */
export function workLine(c, owner = null, format = {}) {
  const f = { time: format.time ?? TIME, dateTime: format.dateTime ?? DATE_TIME };
  // A neutral state, not an owner item: who paused is not recorded, so the reason is shown as given and nothing is inferred.
  if (c.control === 'paused') {
    const stopped = ['stopped', 'agent-working-supervisor-silent'].includes(owner?.liveness) ? ` · AIWorks stopped on this computer${stoppedAt(owner.lastCheckIn, f)}` : '';
    return `${c.pausedAt ? `Paused since ${f.dateTime(c.pausedAt)}` : 'Paused'} · no new step starts; a step already running may finish${c.pausedReason ? ` · reason given: “${c.pausedReason}”` : ''}${stopped}`;
  }
  if (c.control === 'cancel-requested') return 'Cancelling: waiting for running AI workers to stop';
  if (c.control === 'cancelled') return 'Cancelled';
  if (c.control === 'finished') return owner?.finished ?? 'All steps are finished';
  if (owner?.liveness === 'late') return `AIWorks on this computer is a few minutes late checking in (last check-in${stoppedAt(owner.lastCheckIn, f)}); nothing for you to do yet: this is normal during a restart or an update`;
  if (owner?.liveness === 'awaiting-pickup') return `Approved at about ${f.time(owner.registeredAt)}; waiting for AIWorks on this computer to pick it up · nothing for you to do yet`;
  if (owner?.liveness === 'agent-working-supervisor-silent') return `${NEEDS.silent.text}${stoppedAt(owner.lastCheckIn, f)}`;
  if (!c.controllerLive) return `AIWorks stopped on this computer${stoppedAt(owner?.lastCheckIn, f)}; this work does not move until it runs again`;
  if (c.blocker) return `Stopped: ${blockerWords(c.blocker).reason}`;
  const agent = c.agents?.[0], task = agent ? c.tasks.find((item) => item.id === agent.taskId) : null;
  if (agent) return `${agent.role === 'Verifier' ? 'Being checked' : 'Being built'}: ${label(task)}`;
  if (['provider-quota', 'provider-availability'].includes(c.waitingReason)) return `Waiting for an AI worker to be free${c.nextWakeupAt ? ` · next check ${f.dateTime(c.nextWakeupAt)}` : ''} · nothing for you to do`;
  const stopped = c.tasks.filter((item) => item.blocked && item.state !== 'done');
  if (['blocked-child', 'blocked-owner-decision', 'blocked-owner-action', 'blocked-external'].includes(c.status)) {
    return `Stopped · no AI worker starts until you act. ${stopped.length ? stopped.map((item) => `${capital(label(item))}: ${item.blockedReason}`).join(' | ') : 'A step is stopped; see the steps.'}`;
  }
  const done = (id) => c.tasks.find((item) => item.id === id)?.state === 'done';
  const ready = c.tasks.find((item) => item.state !== 'done' && !item.blocked && item.dependsOn.every(done));
  if (ready) return ready.wait?.text ?? `Next step: “${label(ready)}”`;
  if (stopped.length) return c.tasks.some((item) => item.state !== 'done' && !item.blocked) ? 'Some steps are stopped; the others continue'
    : `Stopped · no AI worker starts until you act on ${stopped.length === 1 ? 'the stopped step' : 'the stopped steps'}`;
  return c.nextWakeupAt ? `Next check ${f.dateTime(c.nextWakeupAt)}` : 'Waiting for the next step to become ready';
}

/** What the page says after a command: accepted (by action), or refused, with what to do. */
export const COMMANDS = {
  accepted: { pause: 'Paused. No new step starts; a step already running may finish.', resume: 'Resumed with the goal and limits you approved.',
    instruct: 'Guidance received. The AI worker you chose reads it at its next run on this step; the receipt shows Received, Read and what the worker did.',
    recheck: 'Check again requested. AIWorks looks at this work again; its limits and the independent check still apply.',
    cancel: 'Cancel requested. AIWorks stops the AI workers running on this work.' },
  duplicate: 'This command was already accepted; it was not applied again.',
  unconfirmed: 'Delivery could not be confirmed. Retry this same command safely.',
  retry: 'Retry same command',
  details: 'Details',
  // aiworks#11 review F3: what happened, that nothing changed, and what the owner can do. The rule and the files are in Details.
  resumeRefused: 'AIWorks did not resume this work. Nothing changed: it is still paused. The AIWorks software here is not merged yet. Update AIWorks to a reviewed version, then press Resume again.',
  notFound: 'This work is not recorded on this computer any more. Refresh the page to see what is.',
  closed: 'This work is finished or cancelled, so it takes no more commands. Refresh the page to see where it stands.',
  notPaused: 'Only paused work can resume. Refresh the page to see where it stands.',
  stepChanged: 'This step changed or is already finished. Refresh the page and try again.',
  noNextRun: 'No AI worker runs this step again, so it cannot get guidance. Refresh the page to see where it stands.',
};

/**
 * When nothing on this computer reads a request (no coordinator is configured, or its configuration is invalid): Start
 * work and Messages say so before anything is sent, keep the unsent text, and offer what the owner can do instead of
 * sending (aiworks#11 review F10). The machine's reason is in Details.
 */
export const NOT_READ = {
  title: 'Nothing will read this request yet.',
  text: 'AIWorks on this computer is not set up to read requests, so a request sent now would wait with no answer.',
  invalid: 'AIWorks on this computer cannot read requests: the part of its configuration file that sets up reading them is not valid.',
  instead: 'What you can do instead: keep your text here, it is not lost, and set up request reading in the AIWorks configuration file on this computer. Then send it.',
  setUp: 'How to set it up',
  setUpUrl: 'https://github.com/netbka/aiworks/blob/main/docs/SUPERVISOR.md#9-owner-messages-and-the-coordinator',
  receipt: 'nothing on this computer is set up to read requests yet',
};

/** The Cancel dialog and the guidance dialog, in the owner's words. */
export const DIALOGS = {
  cancelTitle: 'Cancel this work?',
  cancelText: 'No new step starts, and AIWorks stops the AI workers running on it. Results already finished stay available. Cancelled work cannot be resumed.',
  cancelKeep: 'Keep the work',
  cancelConfirm: 'Cancel the work',
  guidanceStep: 'Step',
};

/**
 * The Cost summary of a project (§4.10): its counted runs, and in how many of its pieces of work they ran, so the
 * sentence matches the breakdown under it, which lists every piece (aiworks#11 review F14). `total` is the server's
 * project total; null when no run is counted yet (runs still running are said apart).
 */
export function costRunsLine(total) {
  if (!total.runs) return null;
  const ran = total.worksWithRuns ?? total.works;
  return `${plural(total.runs, 'run')} in ${ran === total.works ? plural(ran, 'piece') : `${ran} of ${plural(total.works, 'piece')}`} of work.`;
}
