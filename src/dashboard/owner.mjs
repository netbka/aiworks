// Owner view: what needs the owner, and where each finished campaign step stands on GitHub. It joins the
// supervisor snapshot with the GitHub metadata the dashboard already fetches. Unknown GitHub state stays unknown;
// every sentence is built from supervisor or GitHub fields, never from worker output.

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;
const COMMENT_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+#issuecomment-\d+$/;
/** Attempts at which a step is flagged for a closer look. Information only: it never limits work (AW-002). */
export const CHURN_ATTEMPTS = 5;
/** A running agent whose own record shows activity within this window is treated as still working. */
export const ACTIVE_WINDOW_MS = 15 * 60_000;
/** The concrete action that restarts a stopped supervisor (docs/SUPERVISOR.md §6). */
export const RESTART_ACTION = 'If nobody is upgrading it right now, restart it there: sign in on that computer (it starts at logon) or start the scheduled task “AIWorks Supervisor”.';
/**
 * After the controller lease lapses, a restart or upgrade usually brings it back within this window: no restart advice
 * yet. A newly registered campaign that no supervisor has picked up gets the same window from its registration.
 */
export const RESTART_GRACE_MS = 5 * 60_000;
/**
 * GitHub data is fresh for this long (it refreshes every minute). Older data, a cache read at startup before the first
 * successful fetch, or data kept after a failed refresh never supports "ready to merge", and "Needs you" items built
 * from it say when the data is from.
 */
export const GITHUB_FRESH_MS = 5 * 60_000;
/** Where the supervisor's own faults are tracked (docs/SUPERVISOR.md). */
export const SUPERVISOR_ISSUE = 'https://github.com/netbka/aiworks/issues/2';
/** The supervisor's own next action for a finished campaign whose steps are all reports. */
const REPORTS_ACTION = /review recommendations before assigning implementation\.?$/;

const sourceFor = (sources, repository) => sources.find((source) => source.repository?.toLowerCase() === repository.toLowerCase());
const short = (repository) => repository.split('/')[1] ?? repository;
const list = (values) => values.length <= 2 ? values.join(' and ') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const label = (task) => task.outcome ?? task.title ?? task.id;

/**
 * Why a repository's GitHub data is not fresh, with when it was fetched, or null when it is fresh. Never fetched is
 * not "stale": steps without data are unknown and say so themselves.
 */
export function githubStale(source, now = Date.now()) {
  if (!source?.fetchedAt) return null;
  const at = Date.parse(source.fetchedAt);
  const reason = source.error ? 'refresh-failed' : source.cached ? 'startup-cache' : !(now - at < GITHUB_FRESH_MS) ? 'old' : null;
  return reason ? { at: Number.isFinite(at) ? at : null, reason } : null;
}
/** The oldest stale GitHub data behind a set of pull requests, or null when all of it is fresh. */
const stalest = (sources, repositories, now) => repositories.map((repository) => githubStale(sourceFor(sources, repository), now))
  .filter(Boolean).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))[0] ?? null;

/** The line under a finished step's state: what it means for the owner. Unknown says why it is unknown. */
const NOTES = { 'awaiting-review': 'Your review and merge', 'report-posted': 'For you to read and decide on',
  'not-loaded': 'Not loaded from GitHub yet; check again shortly', 'github-unavailable': 'GitHub could not be read; check it on GitHub',
  'not-found': 'Not in the GitHub data the dashboard has; check it on GitHub', 'no-link': 'No result link was recorded; check the step issue' };

/**
 * Owner-facing state of a published step: merged, waiting for review, closed unmerged, report posted or unknown.
 * Unknown carries its reason: GitHub not loaded yet, GitHub unavailable, the pull request not found, or no
 * recognisable result link. A step is never "published" or settled on a link the dashboard cannot read.
 */
export function delivery(task, sources, now = Date.now()) {
  if (task.state !== 'done') return null;
  const url = task.resultUrl ?? '';
  if (COMMENT_URL.test(url)) return { state: 'report-posted', url, note: NOTES['report-posted'] };
  const pr = PR_URL.exec(url);
  if (!pr) return { state: 'unknown', reason: 'no-link', note: NOTES['no-link'] };
  const repository = pr[1], number = Number(pr[2]);
  const source = sourceFor(sources, repository);
  const item = source?.items?.find((entry) => entry.kind === 'pr' && entry.number === number);
  if (!item) {
    const reason = source?.fetchedAt ? 'not-found' : source?.error ? 'github-unavailable' : 'not-loaded';
    return { state: 'unknown', reason, repository, number, url, note: NOTES[reason], stale: Boolean(source?.error) };
  }
  const state = item.state === 'MERGED' ? 'merged' : item.state === 'OPEN' ? 'awaiting-review' : 'closed-unmerged';
  return { state, repository, number, url, note: NOTES[state] ?? null, mergedAt: item.mergedAt ? Date.parse(item.mergedAt) : null, stale: Boolean(source.error),
    ...(state === 'awaiting-review' ? { readiness: mergeReadiness(task, item, source, now) } : {}) };
}

/**
 * Whether the owner can merge without checking further. "Ready to merge" only when fresh GitHub data shows the pull
 * request still at the commit the independent checker accepted, no conflicts and every CI check passed. Otherwise
 * the sentence says what is accepted and what is not confirmed. `short` is the same evidence in one compact line;
 * `text` is the full sentence, one click away on the page.
 */
export function mergeReadiness(task, item, source, now = Date.now()) {
  if (!task.verifiedSha) return { ready: false, short: 'Independent check not recorded here', text: 'Published by the supervisor; the independent check is not recorded here.' };
  const sha = String(task.verifiedSha).toLowerCase(), sha7 = sha.slice(0, 7), accepted = `An independent checker accepted commit ${sha7}`;
  const merge = item?.merge;
  const not = (short, text) => ({ ready: false, short, text });
  if (!merge || !source?.fetchedAt || githubStale(source, now)) return not(`Checker accepted ${sha7} · conflicts and CI not confirmed`, `${accepted}; check conflicts and CI on GitHub before merging.`);
  if (merge.head !== sha) return not(`Checker accepted ${sha7} · the pull request now points at ${merge.head ? merge.head.slice(0, 7) : 'another commit'}`,
    `${accepted}, but the pull request now points at ${merge.head ? `commit ${merge.head.slice(0, 7)}` : 'another commit'}; check what changed before merging.`);
  if (item.draft) return not(`Checker accepted ${sha7} · still a draft`, `${accepted}, but the pull request is still a draft; check it on GitHub before merging.`);
  if (merge.mergeable === 'CONFLICTING') return not('Checker accepted the head · conflicts with the base branch', `${accepted}, but GitHub reports conflicts with the base branch; they must be resolved before merging.`);
  if (merge.mergeable !== 'MERGEABLE') return not('Checker accepted the head · conflict check not finished', `${accepted}; GitHub has not finished checking it for conflicts, so check conflicts and CI on GitHub before merging.`);
  const { total, failed, pending } = merge.checks;
  const clean = `${accepted}, it is still the pull request's head and GitHub reports no conflicts`, cleanShort = 'Checker accepted the head · no conflicts';
  if (failed) return not(`${cleanShort} · ${plural(failed, 'CI check')} failed`, `${clean}, but ${plural(failed, 'CI check')} failed; check ${failed === 1 ? 'it' : 'them'} on GitHub before merging.`);
  if (pending) return not(`${cleanShort} · ${plural(pending, 'CI check')} not passed yet`, `${clean}, but ${plural(pending, 'CI check')} ${pending === 1 ? 'has' : 'have'} not passed yet; check again before merging.`);
  if (!total) return not(`${cleanShort} · no CI checks ran`, `${clean}; no CI checks ran on it, so nothing else has tested it.`);
  return { ready: true, short: `Ready to merge · checker accepted the head · no conflicts · ${total === 1 ? 'CI check passed' : `all ${total} CI checks passed`}`,
    text: `Ready to merge: an independent checker accepted commit ${sha7}, it is still the pull request's head, GitHub reports no conflicts and ${total === 1 ? 'its CI check' : `all ${total} CI checks`} passed.` };
}

/**
 * Where merged work goes next in a repository. A standing deploy authorization recorded in the project registry
 * (Engineering Platform's CONSTITUTION §14, EP-029) is named; otherwise release follows the project's own policy. Neither says who acts.
 */
const releaseRule = (releases, repository, whose = `${short(repository)}'s`) =>
  `${whose} ${releases?.[repository.toLowerCase()] ? 'standing deploy authorization' : 'release policy'}`;

/**
 * A finished campaign in one sentence. "Nothing waits for you" only when every step's GitHub state is known and
 * settled; unknown states, closed pull requests, reviews and reports to read are each said plainly. `releaseReady`
 * is the same claim as "the merged work is ready", and `line` is the sentence without its "All steps are finished".
 */
function finishedSummary(c, steps, releases) {
  const count = (test) => steps.filter(test).length;
  const state = (name) => count((step) => step.delivery?.state === name);
  const unknown = (reason) => count((step) => step.delivery?.state === 'unknown' && step.delivery.reason === reason);
  const has = (n) => n === 1 ? 'has' : 'have', them = (n) => n === 1 ? 'it' : 'them';
  const missing = count((step) => !step.delivery), notLoaded = unknown('not-loaded'), unreadable = unknown('github-unavailable'),
    notFound = unknown('not-found'), noLink = unknown('no-link'), closed = state('closed-unmerged'), awaiting = state('awaiting-review'),
    reports = state('report-posted'), merged = state('merged');
  // Merged work is ready for release only when no other step is unknown, closed or still under review.
  const releaseReady = merged > 0 && !(missing + notLoaded + unreadable + notFound + noLink + closed + awaiting);
  const parts = [
    missing ? `${plural(missing, 'step')} ${has(missing)} no recorded result` : null,
    notLoaded ? `GitHub state of ${plural(notLoaded, 'step')} not loaded yet; check again shortly` : null,
    unreadable ? `GitHub could not be read, so the state of ${plural(unreadable, 'step')} is unknown; check ${them(unreadable)} on GitHub` : null,
    notFound ? `the GitHub state of ${plural(notFound, 'step')} is not known; check ${them(notFound)} on GitHub` : null,
    noLink ? `${plural(noLink, 'step')} ${has(noLink)} no recorded result link; check ${noLink === 1 ? 'its issue' : 'their issues'}` : null,
    closed ? `${plural(closed, 'pull request')} ${closed === 1 ? 'was' : 'were'} closed without merging` : null,
    awaiting ? `${plural(awaiting, 'step')} ${awaiting === 1 ? 'waits' : 'wait'} for your review` : null,
    // A report is for the owner to read and decide on. A campaign of reports only shows the supervisor's own next action.
    reports ? reports === steps.length && REPORTS_ACTION.test(c.nextAction ?? '') ? c.nextAction : `${plural(reports, 'report')} posted for you to read` : null,
    merged ? releaseReady ? `the merged work is ready; release follows ${releaseRule(releases, c.repository)}` : `${merged} merged` : null,
  ].filter(Boolean);
  const line = parts.length ? parts.join(' · ') : 'nothing waits for you';
  return { text: `All steps are finished · ${line}`, line: line.charAt(0).toUpperCase() + line.slice(1), releaseReady };
}

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The campaign's title. Declared wording first: the campaign's `purpose`, or for a campaign of one step that step's
 * `outcome`, else its title (what the campaign delivers). Otherwise its tracking issue title without a leading ID.
 */
export function purpose(campaign, sources) {
  if (campaign.purpose) return { text: campaign.purpose, from: 'declaration' };
  const only = campaign.tasks?.length === 1 ? campaign.tasks[0] : null;
  if (only?.outcome) return { text: only.outcome, from: 'step-outcome' };
  if (only?.title) return { text: capital(only.title), from: 'step-title' };
  const issue = sourceFor(sources, campaign.repository)?.items?.find((item) => item.kind === 'issue' && item.number === campaign.trackingIssue);
  if (!issue?.title) return null;
  return { text: capital(issue.title.replace(/^[A-Z][A-Z0-9]*-\d+[A-Za-z0-9-]*:\s*/, '')), from: 'tracking-issue' };
}

/** Words that keep their capitals in a name built from an id. */
const ACRONYMS = { pr: 'PR', prs: 'PRs', ui: 'UI', ux: 'UX', ci: 'CI', api: 'API', mcp: 'MCP', qa: 'QA', id: 'ID', ids: 'IDs' };
/** "open-runtime-prs" → "Open runtime PRs"; issue numbers are dropped unless they are all there is. */
const humanize = (words, keepNumbers) => {
  const named = keepNumbers ? words : words.filter((word) => !/^\d+$/.test(word));
  return capital((named.length ? named : words).map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase()).join(' '));
};

/**
 * Campaigns sharing a title get a distinguishing name from the words of their ids that differ (…-telegram /
 * …-whatsapp), humanized. Issue numbers are kept only when names would otherwise be the same.
 */
function distinguish(entries) {
  const groups = new Map();
  for (const entry of entries) if (entry.purpose) groups.set(entry.purpose.text, [...(groups.get(entry.purpose.text) ?? []), entry]);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const words = group.map((entry) => entry.id.split(/[-_.]+/).filter(Boolean));
    let common = 0;
    while (words.every((list) => common < list.length - 1 && list[common] === words[0][common])) common++;
    let names = words.map((list) => humanize(list.slice(common), false));
    if (new Set(names).size < names.length) names = words.map((list) => humanize(list.slice(common), true));
    group.forEach((entry, index) => { entry.purpose = { ...entry.purpose, variant: names[index] || entry.id }; });
  }
}

/** Is an agent of this campaign still doing work by its own record (heartbeat or recent turns)? */
const agentWorking = (agent, now) => agent.heartbeatState === 'recent' || (agent.progress?.lastActivityAt ?? 0) > now - ACTIVE_WINDOW_MS;

/**
 * The owner view. `releases` maps a lowercased repository to the standing deploy authorization its registry entry
 * records (readReleaseAuthorizations); a repository without one is described only by its own release policy.
 */
export function ownerView(supervisor, sources = [], { host = null, now = Date.now(), releases = {} } = {}) {
  if (!supervisor?.available) return { available: false, headline: null, items: [], unknownResults: 0, also: null, layout: { cards: [], finished: [] }, reply: null, campaigns: {}, recent: null };
  const items = [], campaigns = {}, where = host ? `on ${host}` : 'on its computer';
  let unknownResults = 0;
  const entries = supervisor.campaigns.map((c) => ({ id: c.id, purpose: purpose(c, sources) }));
  distinguish(entries);
  for (const c of supervisor.campaigns) {
    const steps = c.tasks.map((task) => ({ task, delivery: delivery(task, sources, now) }));
    const by = (state) => steps.filter((step) => step.delivery?.state === state);
    const awaiting = by('awaiting-review'), closed = by('closed-unmerged'), unknown = by('unknown');
    // "Checking GitHub" only for state a refresh can still bring. No recorded link, or a pull request missing from data
    // GitHub did return, stays unknown until someone looks: those become "check on GitHub" items instead.
    const transient = unknown.filter((step) => ['not-loaded', 'github-unavailable'].includes(step.delivery.reason));
    const permanent = unknown.filter((step) => !transient.includes(step));
    unknownResults += transient.length;
    const working = c.agents.filter((agent) => agentWorking(agent, now)).length;
    const leaseEnded = c.leaseExpiresAt ? Date.parse(c.leaseExpiresAt) : null;
    // A lease that lapsed minutes ago is usually a restart or an upgrade in progress: late, not yet stopped.
    const late = !c.controllerLive && Number.isFinite(leaseEnded) && now - leaseEnded < RESTART_GRACE_MS;
    // A campaign no supervisor has ever leased (no lease row; releasing a lease keeps the row) gets the same grace from
    // its registration: a running supervisor picks it up at its next check, paused or not, so restart advice right
    // after registering would be premature.
    const neverLeased = !c.controllerLive && !c.leaseExpiresAt && ['registered', 'paused'].includes(c.control);
    const registeredAt = neverLeased && Number.isSafeInteger(c.registeredAt) ? c.registeredAt : null;
    const awaitingPickup = registeredAt !== null && now - registeredAt < RESTART_GRACE_MS;
    const finished = c.control === 'finished' ? finishedSummary(c, steps, releases) : null;
    const delivered = steps.filter((step) => step.delivery).length;
    campaigns[c.id] = { purpose: entries.find((entry) => entry.id === c.id).purpose, deliveries: Object.fromEntries(steps.map((step) => [step.task.id, step.delivery])),
      liveness: c.controllerLive ? 'running' : ['finished', 'cancelled'].includes(c.control) ? 'finished' : late ? 'late' : awaitingPickup ? 'awaiting-pickup'
        : working ? 'agent-working-supervisor-silent' : 'stopped',
      lastCheckIn: c.controllerLive ? null : leaseEnded, registeredAt,
      finished: finished?.text ?? null, releaseReady: finished?.releaseReady ?? false,
      // One line for the compact list of finished and cancelled campaigns.
      outcome: finished?.line ?? (c.control === 'cancelled' ? `Cancelled · ${delivered} of ${plural(c.tasks.length, 'step')} delivered` : null),
      counts: { total: c.tasks.length, delivered, merged: by('merged').length,
        awaiting: awaiting.length, closed: closed.length, unknown: unknown.length, reports: by('report-posted').length } };
    const base = { campaignId: c.id, repository: c.repository };
    // One item per step, led by what the step delivers. The evidence is one compact line; the full sentence is one click away.
    for (const { task, delivery: d } of awaiting) {
      const waitingOn = c.tasks.filter((other) => other.state !== 'done' && other.dependsOn.includes(task.id));
      // A step starts from the base branch as it is at its first run and keeps that base (its worktree is created
      // once), so only steps that have not started yet can build on the merge.
      const notStarted = (other) => other.state === 'pending' && !other.attempts;
      const pending = waitingOn.filter(notStarted), started = waitingOn.filter((other) => !notStarted(other)).map((other) => other.id);
      // Steps declared to require merged dependencies cannot start at all until the owner merges.
      const gated = pending.filter((other) => other.requiresMergedDependencies).map((other) => other.id);
      const churn = task.attempts >= CHURN_ATTEMPTS || task.verifierRejections > 0;
      items.push({ ...base, kind: 'review', action: 'Review and merge', text: label(task), link: { label: `Open PR #${d.number}`, url: d.url },
        evidence: d.readiness.short, detail: d.readiness.text, ready: d.readiness.ready, github: stalest(sources, [d.repository], now),
        points: [
          churn ? `Check its review history first: it took ${plural(task.attempts, 'try', 'tries')}${task.verifierRejections ? ` and the checker rejected it ${plural(task.verifierRejections, 'time')}` : ''} before it was accepted.` : null,
          gated.length ? `${list(gated)} cannot start until you merge it.` : pending.length ? `Merging lets ${list(pending.map((other) => other.id))} build on it.`
            : started.length ? `${list(started)} already started without it, so merging now does not change ${started.length === 1 ? 'that step' : 'those steps'}.`
              // Who releases is the project's rule (registry), never assumed to be the owner.
              : `Nothing else in this campaign waits on it; after merging, release follows ${releaseRule(releases, d.repository)}.`,
        ].filter(Boolean).map((text) => ({ link: null, text })) });
    }
    for (const step of closed) {
      items.push({ ...base, kind: 'closed', action: 'Closed without merging', text: label(step.task), link: { label: `Open PR #${step.delivery.number}`, url: step.delivery.url },
        github: stalest(sources, [step.delivery.repository], now),
        points: [{ link: null, text: `It was checked and published, but its pull request was closed, so that work is not in ${short(c.repository)}. Reopen it or re-plan the step.` }] });
    }
    for (const { task, delivery: d } of permanent) {
      items.push({ ...base, kind: 'check', action: 'Check on GitHub', text: label(task), link: { label: `Open step issue (${task.id})`, url: task.issueUrl },
        github: d.reason === 'not-found' ? stalest(sources, [d.repository], now) : null,
        points: [d.reason === 'not-found'
          ? { link: { label: `PR #${d.number}`, url: d.url }, text: 'This step finished, but its pull request is not in the GitHub data the dashboard has, so where it stands is unknown.' }
          : { link: null, text: 'This step finished, but no result link was recorded, so the dashboard cannot tell where it stands.' }] });
    }
    if (c.blocker) {
      items.push({ ...base, kind: c.blockerClass === 'B3' ? 'decision' : 'stopped', text: `${c.id} is stopped`,
        points: [{ link: { label: 'Tracking issue', url: c.trackingUrl }, text: [c.blockerReason, c.blockerAction ? `What to do: ${c.blockerAction}` : null].filter(Boolean).join(' · ') }] });
    }
    for (const task of c.tasks.filter((item) => item.blocked && item.state !== 'done')) {
      items.push({ ...base, kind: task.blocked === 'B3' ? 'decision' : 'stopped', action: task.blocked === 'B3' ? 'Decision needed' : 'Stopped; will not retry by itself',
        text: label(task), link: { label: `Open step issue (${task.id})`, url: task.issueUrl },
        points: [{ link: null, text: `${task.blockedReason.charAt(0).toUpperCase()}${task.blockedReason.slice(1)}.` }] });
    }
    // A pause by itself is not for the owner: the campaign card shows it in a neutral state, with the reason given (the
    // store does not record who paused, so nothing is inferred from the reason text). A paused campaign still needs a
    // running supervisor, which renews its lease too, so a stopped or absent supervisor is listed, worded for the pause.
    const paused = c.control === 'paused';
    if (c.livenessDefect) {
      items.push({ ...base, kind: 'controller', text: `The supervisor ${where} reports an internal problem with ${c.id}`,
        points: [{ link: { label: 'Supervisor issue #2', url: SUPERVISOR_ISSUE },
          text: 'Not an owner action: this is a supervisor fault for AIWorks\'s maintainers. Work in this campaign may not progress until it is fixed.' }] });
    } else if (campaigns[c.id].liveness === 'agent-working-supervisor-silent') {
      items.push({ ...base, kind: 'controller', at: leaseEnded, text: `An agent is still working, but the supervisor ${where} stopped checking in`,
        points: [{ link: null, text: `The agent's result is collected and checked only when the supervisor runs again. ${RESTART_ACTION}` }] });
    } else if (campaigns[c.id].liveness === 'stopped' && neverLeased) {
      items.push({ ...base, kind: 'controller', text: `The supervisor ${where} has not started ${c.id} yet${paused ? ' (it is paused)' : ''}`,
        points: [{ link: null, text: `It is registered${paused ? ' and paused' : ''}, but no supervisor has picked it up. ${RESTART_ACTION}` }] });
    } else if (campaigns[c.id].liveness === 'stopped') {
      items.push({ ...base, kind: 'controller', at: leaseEnded,
        text: paused ? `The supervisor ${where} stopped while ${c.id} was paused` : `The supervisor ${where} stopped running ${c.id}`,
        points: [{ link: null, text: paused ? `No work starts while it is paused, and none can resume until a supervisor runs again. ${RESTART_ACTION}`
          : `No new work starts. ${RESTART_ACTION}` }] });
    }
  }
  const coordinator = supervisor.coordinator;
  if (coordinator && (coordinator.configError || coordinator.blocked)) {
    const waiting = coordinator.messages.filter((m) => m.state === 'received').length;
    items.push({ kind: 'coordinator', campaignId: null, repository: null, text: 'The coordinator cannot read your messages',
      points: [{ link: null, text: `${coordinator.configError ?? coordinator.blocked}${waiting ? ` · ${plural(waiting, 'message')} waiting` : ''}. This is a supervisor configuration fix for whoever maintains AIWorks.` }] });
  }
  const answered = (coordinator?.messages ?? []).filter((m) => m.state === 'answered' && m.replyUrl).sort((a, b) => b.answeredAt - a.answeredAt)[0];
  // Calm only about what blocks on the owner; reports and releases are said apart, never as "nothing".
  const headline = items.length ? `Needs you (${items.length})` : unknownResults ? 'Checking GitHub for anything that needs you' : 'Nothing is blocked on you right now';
  // Page order: campaigns with something listed for the owner, then the other active ones. Finished or cancelled
  // campaigns with nothing listed collapse into a compact list, most recent first.
  const listed = new Set(items.map((item) => item.campaignId).filter(Boolean));
  const terminal = (c) => ['finished', 'cancelled'].includes(c.control), recency = (c) => Date.parse(c.lastProgressAt ?? '') || 0;
  const layout = { cards: [...supervisor.campaigns.filter((c) => listed.has(c.id)), ...supervisor.campaigns.filter((c) => !listed.has(c.id) && !terminal(c))].map((c) => c.id),
    finished: supervisor.campaigns.filter((c) => !listed.has(c.id) && terminal(c)).sort((a, b) => recency(b) - recency(a)).map((c) => c.id) };
  return { available: true, headline, items, unknownResults, also: alsoForYou(supervisor, campaigns, releases), layout, campaigns, recent: recentSummary(supervisor, campaigns),
    reply: answered ? { messageId: answered.id, answeredAt: answered.answeredAt, url: answered.replyUrl } : null };
}

/**
 * What else there is without blocking anything: posted reports for the owner to read, and finished campaigns whose
 * merged work is ready, with the project's release rule (who releases is not assumed). The dashboard has no read or
 * release state, so these are what was posted and merged, not what is still unread or unreleased.
 */
function alsoForYou(supervisor, campaigns, releases) {
  const reports = supervisor.campaigns.reduce((n, c) => n + campaigns[c.id].counts.reports, 0);
  const release = supervisor.campaigns.filter((c) => campaigns[c.id].releaseReady).map((c) => ({ campaignId: c.id, repository: c.repository }));
  if (!reports && !release.length) return null;
  const read = reports ? `${plural(reports, 'report')} for you to read` : null;
  const ready = [...new Set(release.map((item) => item.repository))]
    .map((repository) => `merged work in ${short(repository)} is ready; release follows ${releaseRule(releases, repository, 'its')}`);
  return { reports, release, text: `Also: ${[read, ...ready].filter(Boolean).join(' · ')}`,
    short: [read, release.length ? 'merged work ready for release' : null].filter(Boolean).join(' · ') };
}

/** "Since you last looked": merged, delivered, newly waiting for the owner, and failed or rejected runs. */
function recentSummary(supervisor, campaigns) {
  const recent = supervisor.recent;
  if (!recent) return null;
  const merged = [], waiting = [];
  for (const c of supervisor.campaigns) for (const task of c.tasks) {
    const d = campaigns[c.id].deliveries[task.id];
    if (d?.state === 'merged' && d.mergedAt >= recent.since) merged.push({ campaignId: c.id, taskId: task.id, number: d.number, url: d.url, at: d.mergedAt });
    if (d?.state === 'awaiting-review' && recent.published.some((p) => p.campaignId === c.id && p.taskId === task.id)) {
      waiting.push({ campaignId: c.id, taskId: task.id, number: d.number, url: d.url });
    }
  }
  // Agent runs and the supervisor's own problems are counted apart: a failing supervisor step is journaled on every tick.
  const kind = (...kinds) => recent.failures.filter((f) => kinds.includes(f.kind)).length;
  return { since: recent.since, merged, delivered: recent.published, waiting,
    failures: kind('failed-run', 'rejected'), rejected: kind('rejected'), supervisorErrors: kind('step-error'), livenessProblems: kind('liveness-defect') };
}
