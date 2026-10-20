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
// "this computer"; its name is in the page header (aiworks#11 review F22). AIWorks starts by itself when the owner signs
// in (docs/SUPERVISOR.md §6), so the advice needs no name of how it runs; when that does not help, the fix is outside
// this page, and the sentence says who makes it (aiworks#11 review 5 G4).
const SIGN_IN = 'sign out of this computer and sign in again, or restart the computer: AIWorks starts again by itself when you sign in.';
const RESTART = `If nobody is updating it right now, ${SIGN_IN} If AIWorks still does not start, whoever set up AIWorks on this computer needs to look at it.`;
/** What restarts AIWorks when it has stopped (docs/SUPERVISOR.md §6), in the owner's words. */
export const RESTART_ADVICE = RESTART;
// AIWorks runs, but has not checked on one piece of work (aiworks#11 review 4 F2): restarting is the owner's fix only if it lasts.
const RESTART_RUNNING = `If it stays like this, ${SIGN_IN} If that does not help, whoever set up AIWorks on this computer needs to look at it.`;

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
    ? ['No work yet.', `Tell AIWorks what you want done in ${shortName(d.project)}.`, { label: 'Plan work', route: { screen: 'start', project: d.project } }]
    : ['No work yet.', `Work in ${shortName(d.project)} appears here once it is registered on this computer. Starting work from this page is not built yet.`, null] },
  // Calm means nothing at all for the owner: reports and releases are on Results, never named here (owner, 2026-10-13).
  // It speaks of work only, because work is all Needs me checks: a setup problem met in Add project is said there and on
  // Projects, never here (OWNER_WORKSPACE §4.2; aiworks#11 review F8).
  'needs-calm': { section: '7.1', needsYou: false, copy: () => ['No work is blocked on you right now.', '', null] },
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
  // One piece of work while AIWorks itself runs (aiworks#11 review 4 F2): its own state, with its one time. "AIWorks has
  // stopped" is said only from the computer-wide state (src/supervisor/api.mjs supervisorLiveness), never from one lease.
  'work-lapsed': { section: '7.2', needsYou: true, copy: (d, f) => [`AIWorks is running, but last checked on this work${stoppedAt(d.stoppedAt, f)}.`,
    `Other work goes on. This work does not move until AIWorks checks on it again. ${RESTART_RUNNING}`, null] },
  'work-not-picked-up': { section: '7.2', needsYou: true, copy: (d, f) => [`Approved${d.registeredAt ? ` at ${f.time(d.registeredAt)}` : ''}; AIWorks is running, but has not picked it up.`,
    `Nothing of it starts until AIWorks picks it up. ${RESTART_RUNNING}`, null] },
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
    'Pull request states may be out of date. Recorded merges remain visible; other results wait for a current check.', null] },
  'merge-failed': { section: '7.4', needsYou: false, copy: (d, f) => [d.at ? `Merge check from ${f.time(d.at)}; the last check failed, retrying.` : 'The merge check failed; retrying.',
    'Pull request states may be out of date. Recorded merges remain visible; other results wait for a current check.', null] },
  'merge-never': { section: '7.4', needsYou: false, copy: (d) => ['Checking for merges…', `The state of ${plural(d.count, 'result')} is not known yet.`, null] },
  // §7.5 Paused: neutral, never a Needs me item by itself.
  'paused': { section: '7.5', needsYou: false, copy: (d, f) => [d.pausedAt ? `Paused since ${f.dateTime(d.pausedAt)}.` : 'Paused.',
    `No new step starts. A step already running may finish.${d.reason ? ` Reason given: “${d.reason}”.` : ''}`, { label: 'Resume', command: 'resume', campaignId: d.campaignId }] },
  // One time per event, written the same on every screen: the pause with its date, the stop "at about" its time (F23).
  'paused-stopped': { section: '7.5', needsYou: true, copy: (d, f) => [`${d.pausedAt ? `Paused since ${f.dateTime(d.pausedAt)}` : 'Paused'}, and AIWorks has stopped on this computer${stoppedAt(d.stoppedAt, f)}.`,
    `Nothing can resume until it runs again. ${RESTART}`, null] },
  'paused-work-lapsed': { section: '7.5', needsYou: true, copy: (d, f) => [`${d.pausedAt ? `Paused since ${f.dateTime(d.pausedAt)}` : 'Paused'}; AIWorks is running, but last checked on this work${stoppedAt(d.stoppedAt, f)}.`,
    `It can’t resume until AIWorks checks on it again. ${RESTART_RUNNING}`, null] },
  // §7.6 Running
  'builder-working': { section: '7.6', needsYou: false, copy: (d, f) => [`Working on: ${sentence(d.step)}`,
    `The builder (${providerName(d.provider)}) started at ${f.time(d.startedAt)}${d.lastActivityAt ? ` · last activity ${ago(d.now - d.lastActivityAt)}` : ''}.`, openWork(d.project)] },
  'checker-working': { section: '7.6', needsYou: false, copy: (d) => [`Checking: ${sentence(d.step)}`,
    `An independent checker (${providerName(d.provider)}) is reviewing the result.`, openWork(d.project)] },
  'possibly-stuck': { section: '7.6', needsYou: false, copy: (d) => [`Possibly stuck: ${d.step} has made no progress for ${plural(d.minutes, 'minute')}.`,
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
    `${sentence(d.reason)}${d.action ? ` What to do: ${sentence(d.action)}` : ''}`, d.check ?? null] },
  'others-continue': { section: '7.7', needsYou: true, copy: (d) => ['One step is stopped; the others continue.',
    d.decision ? `${d.step} needs your decision.` : `${d.step} stopped after ${plural(d.attempts, 'failed attempt')}.`, stepIssue(d.url)] },
  // §7.8 Finished. "Merged" only with a current merge check; unknown is said, never counted as nothing.
  'finished-open': { section: '7.8', needsYou: true, copy: (d) => ['All steps are finished.',
    `${plural(d.awaiting, 'pull request')} ${d.awaiting === 1 ? 'waits' : 'wait'} for your review${d.merged ? ` · ${d.merged} merged` : ''}.`, seeResults(d.project)] },
  // OWNER_UI_V2 WP4: never "complete" while a result's evidence is unresolved; each step's Review shows what is.
  'finished-unresolved': { section: '7.8', needsYou: false, copy: (d) => ['All steps are finished, but not complete.',
    `${plural(d.count, 'result')} ${d.count === 1 ? 'has' : 'have'} criteria not checked, failed or open findings. Review ${d.count === 1 ? 'its' : 'their'} evidence before you accept.`, seeResults(d.project)] },
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
      // The Check again its sentence names is this state's primary action, while the work takes it (review 5 G8).
      const check = (c.controls?.more ?? []).includes('recheck') ? blockerCheck(c.blocker, c.id) : null;
      return ['recorded-blocker', { ...blockerWords(c.blocker, { check: Boolean(check) }), check }];
    }
  }
  // One piece of work AIWorks, while running, has not checked on or picked up (review 4 F2): that work's own state.
  if (item.kind === 'unattended' && c) {
    const view = d.owner?.campaigns?.[c.id];
    if (view?.liveness === 'work-not-picked-up') return ['work-not-picked-up', { registeredAt: view.registeredAt }];
    return [c.control === 'paused' ? 'paused-work-lapsed' : 'work-lapsed', { stoppedAt: view?.lastCheckIn ?? null, pausedAt: c.pausedAt ?? null }];
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

/**
 * Now's progress line: the whole project's, counted as Results counts it, so the two screens give the same numbers
 * (aiworks#11 review 5 G11). With more than one piece of work it says so, so it never reads as the count of the one
 * piece Now's sentence is about.
 */
function projectProgress(campaigns, owner) {
  const all = campaigns.map((c) => owner?.campaigns?.[c.id]?.counts);
  if (!all.length || all.some((counts) => !counts || !Number.isSafeInteger(counts.total))) return progressText(null);
  const sum = {};
  for (const counts of all) for (const [key, n] of Object.entries(counts)) sum[key] = (sum[key] ?? 0) + (Number.isSafeInteger(n) ? n : 0);
  const text = progressText(sum);
  return all.length > 1 ? `All work in this project: ${text}` : text;
}

/** Work AIWorks is not checking on: its own Needs me item, or AIWorks stopped, says what it means. */
const UNATTENDED = ['stopped', 'agent-working-supervisor-silent', 'work-lapsed', 'work-not-picked-up'];

/**
 * What else goes on in this project beside the sentence Now leads with (aiworks#11 review 5 G5, review 4 F14): each
 * worker possibly stuck, each pause the owner can resume, with its Resume, and each worker at work, in that order. Each
 * line is { kind, workId, title, text, primary }; `text` names the work by its purpose when the project has more than
 * one piece of active work. Work AIWorks is not checking on is left out: its own item says so.
 */
function alsoLines(campaigns, d, make) {
  const view = (c) => d.owner?.campaigns?.[c.id];
  const active = campaigns.filter((c) => !['finished', 'cancelled'].includes(c.control) && !UNATTENDED.includes(view(c)?.liveness));
  const line = (kind, c, copy) => {
    const purpose = active.length > 1 ? view(c)?.purpose?.text : null;
    return { kind, workId: c.id, title: copy.title, text: purpose ? `${purpose} · ${copy.title}` : copy.title, primary: kind === 'paused' ? copy.primary : null };
  };
  const lines = [];
  for (const c of active) {
    // Resume works only while AIWorks runs this work, as for Now's own paused sentence.
    if (c.control === 'paused') {
      if (view(c)?.liveness === 'running') lines.push(line('paused', c, make('paused', { pausedAt: c.pausedAt, reason: c.pausedReason, campaignId: c.id })));
      continue;
    }
    // Workers of work being cancelled are stopping, not at work.
    if (c.control === 'cancel-requested') continue;
    for (const agent of c.agents ?? []) {
      const task = c.tasks.find((item) => item.id === agent.taskId), last = agent.progress?.lastActivityAt ?? agent.outputAt ?? null;
      if (last && d.now - last >= STUCK_MS && busyOnCommand(agent, d.now) === null) {
        lines.push(line('possibly-stuck', c, make('possibly-stuck', { step: capital(label(task)), minutes: Math.floor((d.now - last) / 60_000) })));
      } else {
        lines.push(line('working', c, make(agent.role === 'Verifier' ? 'checker-working' : 'builder-working',
          { step: label(task), provider: agent.executor, startedAt: agent.startedAt, lastActivityAt: last })));
      }
    }
  }
  const order = ['possibly-stuck', 'paused', 'working'];
  return lines.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/**
 * The Projects row's short form of Now's other lines (alsoLines): "Also: 2 AI workers possibly stuck · 1 piece of work
 * paused, with Resume on Now · 1 AI worker working", or null when there are none.
 */
export function alsoSummary(also) {
  const n = (kind) => (also ?? []).filter((line) => line.kind === kind).length;
  const parts = [n('possibly-stuck') ? `${plural(n('possibly-stuck'), 'AI worker')} possibly stuck` : null,
    n('paused') ? `${plural(n('paused'), 'piece')} of work paused, with Resume on Now` : null,
    n('working') ? `${plural(n('working'), 'AI worker')} working` : null].filter(Boolean);
  return parts.length ? `Also: ${parts.join(' · ')}` : null;
}

/** The state of finished or cancelled work: the most recent piece. */
function finishedState(c, d) {
  const view = d.owner?.campaigns?.[c.id], counts = view?.counts;
  if (c.control === 'cancelled') return ['cancelled', { delivered: counts?.delivered ?? c.tasks.filter((task) => task.state === 'done').length, total: c.tasks.length }];
  if (!counts) return ['finished-unknown', { count: c.tasks.length }];
  const unknown = counts.total - counts.delivered + counts.checking + counts.unknown;
  if (unknown) return ['finished-unknown', { count: unknown }];
  // A result with a criterion failed or not checked, a blocking finding or requested changes keeps the goal open (WP4).
  if (counts.unresolved) return ['finished-unresolved', { count: counts.unresolved }];
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
 * The project's Now screen (§4.4): its goal, one state sentence with at most one primary action, what else goes on in
 * the project (`also`: possibly stuck workers, pauses with their Resume, workers at work; review 5 G5), the whole
 * project's progress, a merge note when the merge check is not current, and "since you last looked" for this project
 * only. `data` is the page's
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
  const readable = !offline && supervisor?.available && owner?.available;
  const result = (state, c = null) => {
    const view = c ? owner?.campaigns?.[c.id] : null, merge = c ? mergeNote(project, merges, view?.counts, now) : null;
    // What the leading sentence already says about the same work is not said again.
    const also = readable ? alsoLines(campaigns, d, make).filter((line) => !(line.workId === c?.id && line.title === state.title)) : [];
    return { project, name: shortName(project), state, also,
      goal: view?.purpose ? { text: view.purpose.text, variant: view.purpose.variant ?? null } : null,
      progress: c ? projectProgress(campaigns, owner) : null, note: merge ? make(...merge) : null,
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
  // Whatever leads, `also` keeps possibly stuck, paused and running work in view (review 5 G5).
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

/**
 * Why work is stopped by a recorded blocker, by its kind: what happened and what to do. Never the stored text. `check`
 * when the screen that says it carries Check again for this work (the Needs me card and Now do, while the work takes
 * commands): the sentence names a control only where it is (aiworks#11 review 5 G8).
 */
export function blockerWords(kind, { check = true } = {}) {
  const then = check ? ', then choose Check again' : '';
  if (kind === 'executors') return { reason: 'No AI worker on this computer can do this step',
    action: `Set up an AI worker that can do it on this computer (see Settings)${then}` };
  if (kind === 'budget') return { reason: 'This work has used all the runs or cost it was approved for',
    action: 'Decide whether to allow more. If you do, approve it again with higher limits' };
  return { reason: 'AIWorks stopped this work and needs a fix on this computer',
    action: `See Settings › Diagnostics for what it recorded, and fix it${then}` };
}
/** The Check again a recorded blocker's sentence names, carried on the screen that says it (review 5 G8). */
export const blockerCheck = (kind, campaignId) => kind === 'budget' ? null : { label: 'Check again', command: 'recheck', campaignId };

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
  // A decision the owner snoozed (WP2): still listed, because its step stays stopped until it is answered.
  snoozed: (until) => `Snoozed until ${new Date(until).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '')}; the step waits for your answer.`,
  // A connected project where work can't start until the owner confirms its rules (review 5 G7): not an item, since no
  // work is blocked, but the calm headline names it and a row links to its Now, where the rules are confirmed.
  held: {
    headline: (names) => `No work is blocked on you right now, but ${names.length === 1 ? `${names[0]} waits` : `${names.length} projects wait`} for you to confirm their rules before work can start`,
    row: 'Can’t start work until you confirm this project’s rules. You confirm them on its Now screen.',
  },
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
  // While AIWorks runs, one piece of work it has not checked on or picked up is that work's own item, listed under its
  // project with its one time (review 4 F2); "AIWorks stopped" is never said for it.
  lapsed: (paused, working) => ({ text: `AIWorks is running, but last checked on this ${paused ? 'paused ' : ''}work`,
    point: [paused ? 'It can’t resume until AIWorks checks on it again.' : 'Other work goes on. This work does not move until AIWorks checks on it again.',
      working ? 'An AI worker is still working on it; its result is collected and checked only then.' : null, RESTART_RUNNING].filter(Boolean).join(' ') }),
  unpicked: (paused) => ({ text: `AIWorks is running, but has not picked up this ${paused ? 'paused ' : ''}work yet`,
    point: `It is approved${paused ? ' and paused' : ''}, and nothing of it starts until AIWorks picks it up. ${RESTART_RUNNING}` }),
  /** Said when AIWorks was stopped on purpose (its STOP file: an update or its operator). */
  onPurpose: 'It was stopped on purpose: an update or its operator.',
  // AIWorks itself stopped: with several pieces of work, it names the work it holds up per project. `pickup` when it never picked up any of it.
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
    const stopped = ['stopped', 'agent-working-supervisor-silent'].includes(owner?.liveness) ? ` · AIWorks stopped on this computer${stoppedAt(owner.lastCheckIn, f)}`
      : owner?.liveness === 'work-lapsed' ? ` · AIWorks is running, but last checked on this work${stoppedAt(owner.lastCheckIn, f)}`
        : owner?.liveness === 'work-not-picked-up' ? ' · AIWorks is running, but has not picked it up yet' : '';
    return `${c.pausedAt ? `Paused since ${f.dateTime(c.pausedAt)}` : 'Paused'} · no new step starts; a step already running may finish${c.pausedReason ? ` · reason given: “${c.pausedReason}”` : ''}${stopped}`;
  }
  if (c.control === 'cancel-requested') return 'Cancelling: waiting for running AI workers to stop';
  if (c.control === 'cancelled') return 'Cancelled';
  if (c.control === 'finished') return owner?.finished ?? 'All steps are finished';
  if (owner?.liveness === 'late') return `AIWorks on this computer is a few minutes late checking in (last check-in${stoppedAt(owner.lastCheckIn, f)}); nothing for you to do yet: this is normal during a restart or an update`;
  if (owner?.liveness === 'awaiting-pickup') return `Approved at about ${f.time(owner.registeredAt)}; waiting for AIWorks on this computer to pick it up · nothing for you to do yet`;
  if (owner?.liveness === 'agent-working-supervisor-silent') return `${NEEDS.silent.text}${stoppedAt(owner.lastCheckIn, f)}`;
  if (owner?.liveness === 'work-lapsed') return `AIWorks is running, but last checked on this work${stoppedAt(owner.lastCheckIn, f)}; it does not move until AIWorks checks on it again`;
  if (owner?.liveness === 'work-not-picked-up') return `Approved${owner.registeredAt ? ` at about ${f.time(owner.registeredAt)}` : ''}; AIWorks is running, but has not picked it up yet`;
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
  // Pause and resume for all, a project or a goal (OWNER_UI_V2 WP1).
  nothingToPause: 'Nothing here is running, so there is nothing to pause. Refresh the page to see where it stands.',
  nothingToResume: 'Nothing here was paused by this control, so there is nothing to resume. Work you paused another way keeps its own Resume.',
  scoped: { pause: (n) => `Paused ${n === 1 ? '1 goal' : `${n} goals`}. No new step starts; steps already running finish and are recorded.`,
    resume: (n) => `Resumed ${n === 1 ? '1 goal' : `${n} goals`} with the goals and limits you approved.` },
  stepChanged: 'This step changed or is already finished. Refresh the page and try again.',
  noNextRun: 'No AI worker runs this step again, so it cannot get guidance. Refresh the page to see where it stands.',
  // Structured decisions (OWNER_UI_V2 WP2): an answer, a snooze and "this did not need me" are bound to one decision.
  decision: {
    answer: 'Answer received. AIWorks clears this decision once and the step continues with your answer; its limits and the independent check still apply.',
    snooze: (until) => `Snoozed until ${new Date(until).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '')}. The step stays stopped until you answer.`,
    'not-needed': 'Thank you. AIWorks recorded that this did not need you; the step still waits for an answer.',
    stale: 'This decision changed or is no longer open. Nothing was recorded. Refresh the page to see the current one.',
    answered: 'This decision was already answered. Nothing was recorded twice.',
    notOption: 'Choose one of the options shown, or write your own answer.',
    noted: 'You already said this decision did not need you.',
  },
  // Review of a result (OWNER_UI_V2 WP4): accept and request changes are bound to one verified head and its report.
  result: {
    accept: (gate) => gate === 'on' ? 'Accepted. AIWorks recorded your acceptance of this checked version; the merge gate merges it when its own conditions hold.'
      : 'Accepted. AIWorks recorded your acceptance of this checked version. Nothing was merged: merging follows this project’s own gate.',
    'request-changes': 'Changes requested. AIWorks reopens this step as a repair round within the approved plan; nothing of it is published or merged until a fresh independent check passes.',
    changed: 'This result changed since you opened it, or it is not the version that passed the check. Nothing was recorded. Refresh the page and review it again.',
    closed: 'This work is paused, cancelled or not finished, so its result takes no review now. Refresh the page to see where it stands.',
    requested: 'Changes to this version were already requested. Nothing was recorded twice.',
    merged: 'This version is already merged. To change it, ask for a new plan.',
    reportOnly: 'Requesting changes is available for code results. For a report, ask for a new plan.',
    noRounds: 'This step has used all its repair rounds, so no further repair starts. Ask for a new plan to change it.',
    applyLocal: 'A result in a project without GitHub is accepted with Apply.',
    alreadyAccepted: 'You already accepted this version.',
    unresolved: 'A criterion failed or a blocking finding is open, so this version cannot be accepted. Request changes instead.',
  },
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

/**
 * What fixing the cause of a step stopped on invalid results involves, in owner words (aiworks#11 review 5 G4): what
 * "the plan" is, where it is kept and who changes it. Nothing on this page changes it, so the sentence says the fix is
 * outside the page; Check again is beside it on the Step screen.
 */
const PLAN_FIX = 'Fixing the cause is done outside this page. What each step must deliver, and which AI workers may do it, are set in the plan approved for this work. That plan is a file kept on this computer, and this page can’t change it. Whoever set up AIWorks on this computer changes it: they can let another AI worker do this step, or replace this work with a plan where the step is smaller or clearer. If a clear step keeps failing this way, AIWorks itself needs a fix, which is for AIWorks’ maintainers.';
/**
 * What a last result of "invalid result" means, said beside it on the Step screen (OWNER_WORKSPACE §4.8 item 4 and §7.7;
 * aiworks#11 review 4 F13). Built from the result's class and role only, never from the worker's own text. `stopped`
 * when the step will not retry by itself: then it says what "Fix the cause" involves. `check` when the screen shows Check
 * again for the step: the sentence names it only then (review 5 G8).
 */
export function resultMeaning(outcome, { stopped = false, check = true } = {}) {
  if (outcome?.outcome !== 'invalid-result') return null;
  const checker = outcome.role === 'Verifier';
  const kind = checker
    ? 'Invalid result: the independent checker finished, but its answer failed AIWorks’ own checks, for example it checked an older version of the step, or its answer was not in the form AIWorks reads. The step’s change is kept.'
    : 'Invalid result: the builder finished, but what it handed back failed AIWorks’ own checks, for example no commit, a commit that does not start where the step began, or an answer not in the form AIWorks reads. Nothing it made was used.';
  const fix = stopped
    ? `${PLAN_FIX}${check ? ' When the cause is fixed, choose Check again.' : ''}`
    : 'AIWorks tries again by itself. Nothing for you to do yet.';
  return { kind, fix };
}

/** The Cancel dialog and the guidance dialog, in the owner's words. */
export const DIALOGS = {
  cancelTitle: 'Cancel this work?',
  cancelText: 'No new step starts, and AIWorks stops the AI workers running on it. Results already finished stay available. Cancelled work cannot be resumed.',
  cancelKeep: 'Keep the work',
  cancelConfirm: 'Cancel the work',
  guidanceStep: 'Step',
};

/**
 * What a step was asked to read, the rule its returned change broke and what the next attempt was given (SCOPED_READING
 * section 8, slice UI18), in plain words. `reading` is the step's served `reading`: paths, section slugs and headings
 * only. Null when it is null or says nothing, so a step without scoped reading shows nothing new.
 */
const FALLBACK_WORDS = { missing: 'no longer there', ambiguous: 'more than one heading matches', 'not-markdown': 'not a document AIWorks reads by section',
  unreadable: 'could not be read' };
const BROKE_WORDS = { covered: 'That section was already in what this step had to read.',
  'section-miss': 'The plan had marked other sections of that document, not this one.',
  'unreferenced-doc': 'The plan had not named that document for this step.' };
const sectionName = (item) => !item.anchor ? `${item.path} (the whole document)`
  : item.heading ? `section “${item.heading}” of ${item.path}` : `section #${item.anchor} of ${item.path}`;
const list = (items) => items.map(sectionName).join('; ');
export function readingLines(reading) {
  if (!reading) return null;
  const broke = reading.broke ?? [], given = broke.filter((item) => item.given), notGiven = broke.filter((item) => item.given === false);
  const lines = [
    reading.anchored ? `This step was asked to start with ${plural(reading.anchored, 'marked section')} of its documents.` : null,
    ...broke.map((item) => `The checker returned the last change: it broke the rule in ${sectionName(item)}. ${BROKE_WORDS[item.kind] ?? ''}`.trim()),
    broke.length && !reading.nextStarted ? `The next attempt has not started yet. It will be given ${broke.length === 1 ? 'that section' : 'those sections'} to read.` : null,
    given.length ? `The next attempt was given ${list(given)} to read.` : null,
    notGiven.length ? `The next attempt had no room for ${list(notGiven)}, so it reads ${notGiven.length === 1 ? 'that rule' : 'those rules'} in the checker’s finding.` : null,
    reading.fallbacks?.length ? `${plural(reading.fallbacks.length, 'marked section')} could not be found, so the whole document was given instead: ${
      reading.fallbacks.map((item) => `${item.path} (#${item.anchor}${FALLBACK_WORDS[item.reason] ? `, ${FALLBACK_WORDS[item.reason]}` : ''})`).join('; ')}.` : null,
    reading.misses?.section || reading.misses?.unreferenced ? `So far the checker found ${[
      reading.misses.section ? `${plural(reading.misses.section, 'broken rule')} in sections the plan did not mark` : null,
      reading.misses.unreferenced ? `${plural(reading.misses.unreferenced, 'broken rule')} in documents the plan did not name` : null].filter(Boolean).join(' and ')}.` : null,
    reading.extended ? `${plural(reading.extended, 'section')} ${reading.extended === 1 ? 'was' : 'were'} added to what it reads, because the checker found ${
      reading.extended === 1 ? 'it' : 'them'} missed in another step of this work${reading.extendedSections?.length ? `: ${list(reading.extendedSections)}` : ''}.` : null,
  ].filter(Boolean);
  return lines.length ? { title: 'What it reads and the rules it broke', lines } : null;
}

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

/** The current dashboard semantic version, kept below 1.0.0 until the roadmap is completed. */
export const DASHBOARD_VERSION = '0.9.0';
/** The name of the current dashboard version describing its primary feature theme. */
export const DASHBOARD_VERSION_NAME = 'Model Routing & Task Signatures';

/**
 * Meaningful version milestones for the dashboard: each release below 1.0.0 has a name
 * and a list of features enabled in that version, leading up to the 1.0.0 roadmap target.
 */
export const DASHBOARD_VERSIONS = [
  {
    version: '0.1.0',
    name: 'Foundation & Review Fixture',
    description: 'Core AIWorks runtime with synthetic store and review fixture.',
    features: [
      'Deterministic SQLite state storage',
      'Synthetic review store and fixture',
      'Loopback dashboard HTTP server with CSRF protection',
    ],
    status: 'completed',
  },
  {
    version: '0.2.0',
    name: 'Owner Navigation',
    description: 'Project-first navigation shell with responsive 320px layout.',
    features: [
      'Navigation shell (Projects, Needs me, Settings)',
      'Needs me owner-attention inbox',
      'Hash-based routing with deep-link state preservation',
      'Responsive mobile-first layout',
    ],
    status: 'completed',
  },
  {
    version: '0.3.0',
    name: 'Project State & Copy',
    description: 'Calm owner copy and project overview.',
    features: [
      'Project Now overview screen',
      'Plain-language owner copy without machine jargon',
      'Per-project calm rule and status summaries',
    ],
    status: 'completed',
  },
  {
    version: '0.4.0',
    name: 'Work & Step Observability',
    description: 'Execution inspection and lifecycle controls.',
    features: [
      'Step timeline and history inspection',
      'Independent verification results view',
      'Pause, cancel, resume, and check-again controls',
      'Retry tracking and wait reason reporting',
    ],
    status: 'completed',
  },
  {
    version: '0.5.0',
    name: 'Usage & Cost Transparency',
    description: 'Token math and cost tracking per project and step.',
    features: [
      'Detailed token counts (input, cache read, cache write, output)',
      'Cost calculation per project and per step',
      'Unreported run accounting',
    ],
    status: 'completed',
  },
  {
    version: '0.6.0',
    name: 'Project Connection',
    description: 'Local directory and Git project onboarding.',
    features: [
      'Connect ordinary local folders without Git metadata',
      'Connect local Git repositories and GitHub remotes',
      'Project rules confirmation and review',
    ],
    status: 'completed',
  },
  {
    version: '0.7.0',
    name: 'Release Ladder & Diagnostics',
    description: 'Five-step release readiness ladder and diagnostics.',
    features: [
      'Five-step release readiness ladder',
      'Execution journal with event timeline',
      'Local merge-check freshness tracking',
      'Project rules diagnostics',
    ],
    status: 'completed',
  },
  {
    version: '0.8.0',
    name: 'Multi-Account Quota Management',
    description: 'Isolated login profiles and usage observability.',
    features: [
      'Multiple account logins per AI worker provider',
      'Isolated account profile directories with CAAM integration',
      'Account usage observability and rate-limit cooldown tracking',
      'CLI account credential management with strict web boundary',
    ],
    status: 'completed',
  },
  {
    version: '0.9.0',
    name: 'Model Routing & Task Signatures',
    description: 'Role-based model preferences and durable task model signatures.',
    features: [
      'Task model signatures (model name, type, effort, tokens consumed)',
      'Role-based model preferences (implementer, checker, assistant)',
      'Model signature badges in Step, Work, and Results views',
      'Interactive preference configuration in Settings',
      'CLI model preference management commands',
    ],
    status: 'current',
  },
  {
    version: '1.0.0',
    name: 'Autonomous Project Delivery',
    description: 'Full autonomous multi-project delivery and automated release gates.',
    features: [
      'Autonomous end-to-end plan-and-do across projects',
      'Adaptive multi-worker parallel scheduling',
      'Opt-in automatic release gate execution',
      'Complete self-hosting workspace workflow',
    ],
    status: 'roadmap',
  },
];

