// Owner view: what needs the owner, and where each finished campaign step stands. It joins the supervisor snapshot
// with the merge state the dashboard reads from local git (merges.mjs); it never calls GitHub. Unknown or stale merge
// state never reads as merged; every sentence is built from supervisor or local git fields, never from worker output.

import { DELEGATED, NEEDS, RESTART_ADVICE, blockerCheck, blockerWords, stateCopy } from './copy.mjs';

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;
const COMMENT_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+#issuecomment-\d+$/;
/** Attempts at which a step is flagged for a closer look. Information only: it never limits work (AW-002). */
export const CHURN_ATTEMPTS = 5;
/** A running agent whose own record shows activity within this window is treated as still working. */
export const ACTIVE_WINDOW_MS = 15 * 60_000;
/** The concrete action that restarts a stopped supervisor (docs/SUPERVISOR.md §6), worded in the copy module. */
export const RESTART_ACTION = RESTART_ADVICE;
/**
 * After the controller lease lapses, a restart or upgrade usually brings it back within this window: no restart advice
 * yet. A newly registered campaign that no supervisor has picked up gets the same window from its registration.
 */
export const RESTART_GRACE_MS = 5 * 60_000;
/**
 * The merge check is current for this long after a successful fetch of the base branch (fetched at most every 5
 * minutes). Older data, or no successful fetch yet, never shows a step as merged: it reads "published, merge not seen
 * yet", and "Needs you" items built from it say when the check is from. A failed fetch keeps the last result and its time.
 */
export const MERGE_FRESH_MS = 15 * 60_000;
/**
 * A delegated, verified, unmerged and not-held pull request that waited longer than this since its check is the owner's
 * again (#139). config.json `merges.stallHours` replaces it.
 */
export const MERGE_STALL_HOURS = 3;
const HOUR_MS = 60 * 60_000;
/** Where the supervisor's own faults are tracked (docs/SUPERVISOR.md). */
export const SUPERVISOR_ISSUE = 'https://github.com/netbka/aiworks/issues/2';
/** The supervisor's own next action for a finished campaign whose steps are all reports. */
const REPORTS_ACTION = /review recommendations before assigning implementation\.?$/;

const short = (repository) => repository.split('/')[1] ?? repository;
const list = (values) => values.length <= 2 ? values.join(' and ') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const label = (task) => task.outcome ?? task.title ?? task.id;
/** Steps named by what they deliver, never by ID: “Price sync” and “Search page”. */
const named = (tasks) => list(tasks.map((task) => `“${label(task)}”`));
const NO_MERGES = { repositories: [], steps: {} };

/**
 * How current the merge check of a repository is: `fresh` after a successful fetch under 15 minutes old; `at` is when
 * that fetch ran (null before the first one) and `reason` says why it is not current, or that the last fetch failed.
 * `reason` is 'no-checkout' when this computer has no checkout of the repository configured.
 */
export function mergeCheck(merges, repository, now = Date.now()) {
  const repo = (merges?.repositories ?? []).find((item) => item.repository?.toLowerCase() === repository.toLowerCase());
  if (repo && !repo.configured) return { fresh: false, at: null, reason: 'no-checkout' };
  const at = Number.isSafeInteger(repo?.fetchedAt) ? repo.fetchedAt : null;
  const fresh = at !== null && now - at < MERGE_FRESH_MS;
  return { fresh, at, reason: repo?.error ? 'fetch-failed' : fresh ? null : at === null ? 'not-checked' : 'old' };
}

/** The line under a finished step's state: what it means for the owner, or why the merge is not seen. */
const NOTES = { published: 'Your review and merge', 'report-posted': 'For you to read and decide on',
  checking: 'Checking the base branch for the merge; check again shortly',
  'fetch-failed': 'The last check of the base branch failed; showing the last known state',
  'no-checkout': 'This computer has no checkout of the repository configured, so the merge cannot be seen here; check the pull request',
  'no-verified-sha': 'No verified commit is recorded, so the merge cannot be checked here; check the pull request',
  'no-link': 'No result link was recorded; check the step issue' };

/**
 * Owner-facing state of a finished step: merged, published (merge not seen yet), report posted, or unknown when no
 * result link was recorded. Merged only when a current check found the verified commit on the base branch. A published
 * step carries why its merge is not seen: `pending` when a check that can still come shortly is running or due.
 * `asOf` is the time of a merge check that is not current, or that is current but whose last fetch failed.
 * With merging delegated by the owner (`delegation`, config.json `merges`, #17), a verified pull request whose merge is
 * not seen and is not being checked is `delegated`: merged for the owner by `by`, or `held` with its reason key. One not
 * held that waited longer than `delegation.stallHours` since its check (`task.verifiedAt`) is `stalled`, in whole hours (#139).
 */
export function delivery(task, merges = NO_MERGES, now = Date.now(), campaignId = null, delegation = null) {
  if (task.state !== 'done') return null;
  const url = task.resultUrl ?? '';
  if (COMMENT_URL.test(url)) return { state: 'report-posted', url, note: NOTES['report-posted'] };
  const pr = PR_URL.exec(url);
  if (!pr) return { state: 'unknown', reason: 'no-link', note: NOTES['no-link'] };
  const repository = pr[1], number = Number(pr[2]);
  const check = mergeCheck(merges, repository, now);
  const step = merges?.steps?.[`${campaignId}/${task.id}`];
  const result = task.verifiedSha && step?.sha === task.verifiedSha ? step.merged : null;
  const asOf = check.reason && check.reason !== 'no-checkout' && check.at !== null ? { at: check.at, reason: check.reason } : null;
  const base = { repository, number, url, asOf };
  if (result === true && check.fresh) return { state: 'merged', ...base, note: null, mergedAt: step.mergedAt ?? null };
  const reason = !task.verifiedSha ? 'no-verified-sha' : check.reason === 'no-checkout' ? 'no-checkout'
    : check.reason === 'fetch-failed' && !check.fresh ? 'fetch-failed' : !check.fresh || result === null ? 'checking' : null;
  if (delegation && task.verifiedSha && reason !== 'checking') {
    const held = delegation.held?.[url.toLowerCase()] ?? null;
    const waited = !held && Number.isSafeInteger(task.verifiedAt) ? now - task.verifiedAt : null;
    const stalled = waited !== null && waited > (delegation.stallHours ?? MERGE_STALL_HOURS) * HOUR_MS ? Math.floor(waited / HOUR_MS) : null;
    return { state: 'delegated', ...base, reason, pending: false, held, stalled, by: delegation.delegatedTo,
      note: held ? DELEGATED.held[held] : stalled ? DELEGATED.stalled(stalled) : DELEGATED.note(delegation.delegatedTo) };
  }
  return { state: 'published', ...base, reason, pending: reason === 'checking', note: NOTES[reason ?? 'published'] };
}

/**
 * What the owner can know before merging. The dashboard does not read CI checks or conflicts: it names the commit the
 * independent checker accepted and points to the pull request. `short` is one compact line; `text` the full sentence.
 */
export function reviewEvidence(task) {
  if (!task.verifiedSha) return { ...NEEDS.noEvidence };
  return NEEDS.evidence(String(task.verifiedSha).toLowerCase().slice(0, 7));
}

/**
 * The check evidence of one result, in the Results words (OWNER_WORKSPACE §2.3): "Passed the check", never
 * "accepted", which is kept for recorded acceptance (#4). `short` is the row line; `text` the sentence in its details.
 */
export function resultEvidence(task, pullRequest = true) {
  const where = pullRequest ? ' This dashboard does not read CI checks or conflicts; see them on the pull request.' : '';
  if (!task.verifiedSha) return { short: 'Independent check not recorded here', text: `The independent check is not recorded here.${where}` };
  const sha7 = String(task.verifiedSha).toLowerCase().slice(0, 7);
  return { short: `Passed the check at commit ${sha7}`, text: `Passed the independent check at commit ${sha7}.${where}` };
}

/**
 * Results (OWNER_WORKSPACE §4.9, slice S6, build slice UI7): the groups in screen order, each with its §2.3 state word.
 * "Closed without merging" has no source yet: the local merge check cannot tell a closed pull request from an open
 * one, so such a result stays under "Waiting for your review" and is never merged. "Changes requested" is not built:
 * it needs GitHub's review state, which the dashboard does not read (PROJECT_WORKSPACE_PLAN §6.12 C1, gap G3).
 */
export const RESULT_GROUPS = [
  { key: 'review', title: 'Waiting for your review' },
  { key: 'delegated', title: 'Being merged for you' },
  { key: 'closed', title: 'Closed without merging' },
  { key: 'reports', title: 'Reports to read' },
  { key: 'merged', title: 'Merged' },
  { key: 'unknown', title: 'Not known yet' },
];

/** One finished step as a Results row: its group, its state word, what it means, and the link to the result. */
function resultRow(c, task, d, releases) {
  const base = { campaignId: c.id, taskId: task.id, repository: c.repository, text: label(task), mergedAt: null, release: null, asOf: d.asOf ?? null, signature: task.signature ?? null };
  if (d.state === 'report-posted') {
    const evidence = task.verifiedSha ? resultEvidence(task, false) : null;
    return { ...base, group: 'reports', word: 'Report posted · for you to read', note: null, link: { label: 'Read the report', url: d.url },
      evidence: evidence?.short ?? null, detail: evidence?.text ?? null };
  }
  if (d.state === 'unknown') {
    return { ...base, group: 'unknown', word: 'Not known yet', note: d.note, link: { label: NEEDS.stepIssue, url: task.issueUrl }, evidence: null, detail: null };
  }
  const evidence = resultEvidence(task), link = { label: `Pull request #${d.number}`, url: d.url }, number = d.number;
  const proof = { evidence: evidence.short, detail: evidence.text, number };
  // Merged only from a current merge check; what follows is the project's release rule, never "released" or "live".
  if (d.state === 'merged') return { ...base, ...proof, group: 'merged', word: 'Merged', note: null, link, mergedAt: d.mergedAt ?? null,
    release: `Release follows ${releaseRule(releases, c.repository)}.` };
  // Merging delegated by the owner: passed the check and merged for them, held with its reason, or waiting too long.
  if (d.state === 'delegated') return { ...base, ...proof, group: 'delegated', note: d.note, link,
    word: d.held ? DELEGATED.heldRow(number, DELEGATED.held[d.held]) : d.stalled ? DELEGATED.stalledRow(number, d.stalled) : DELEGATED.row(number, d.by) };
  // A merge check that can still come shortly: the state is not known yet, so it is neither waiting nor merged.
  if (d.pending) return { ...base, ...proof, group: 'unknown', word: 'Not known yet', note: d.note, link };
  return { ...base, ...proof, group: 'review', word: `Pull request #${number} · waiting for your review`,
    note: d.reason ? d.note : 'The merge is not seen on the base branch yet', link };
}

/**
 * Results per project, keyed by the lowercased repository: the non-empty groups in RESULT_GROUPS order, and at most one
 * primary action, "Review pull request #N" for the oldest waiting review (the lowest pull request number). Rows keep
 * the campaigns' order, except that reviews are oldest first.
 */
function resultsByProject(supervisor, campaigns, releases) {
  const projects = new Map();
  for (const c of supervisor.campaigns) for (const task of c.tasks) {
    const d = campaigns[c.id].deliveries[task.id];
    if (!d) continue;
    const key = c.repository.toLowerCase();
    if (!projects.has(key)) projects.set(key, { project: c.repository, rows: [] });
    projects.get(key).rows.push(resultRow(c, task, d, releases));
  }
  return Object.fromEntries([...projects].map(([key, { project, rows }]) => {
    const groups = RESULT_GROUPS.map((group) => {
      const mine = rows.filter((row) => row.group === group.key);
      if (group.key === 'review') mine.sort((a, b) => a.number - b.number);
      return { ...group, count: mine.length, rows: mine };
    }).filter((group) => group.count);
    const oldest = groups.find((group) => group.key === 'review')?.rows[0];
    return [key, { project, total: rows.length, groups,
      primary: oldest ? { label: `Review pull request #${oldest.number}`, url: oldest.link.url } : null }];
  }));
}

/**
 * Where merged work goes next in a repository. A standing deploy authorization recorded in the project registry
 * (governance provider's CONSTITUTION §14, EP-029) is named; otherwise release follows the project's own policy. Neither says who acts.
 */
const releaseRule = (releases, repository, whose = `${short(repository)}'s`) =>
  `${whose} ${releases?.[repository.toLowerCase()] ? 'standing deploy authorization' : 'release policy'}`;

/**
 * A finished campaign in one sentence. "Nothing waits for you" only when every step is merged or a report; merge
 * checks still running, published steps whose merge is not seen yet and reports to read are each said plainly.
 * `releaseReady` is the same claim as "the merged work is ready", and `line` is the sentence without its "All steps are finished".
 */
function finishedSummary(c, steps, releases) {
  const count = (test) => steps.filter(test).length;
  const state = (name) => count((step) => step.delivery?.state === name);
  const has = (n) => n === 1 ? 'has' : 'have';
  const missing = count((step) => !step.delivery), noLink = state('unknown'),
    checking = count((step) => step.delivery?.pending), published = state('published') - checking,
    reports = state('report-posted'), merged = state('merged'), delegated = state('delegated');
  // Merged work is ready for release only when every other step is a report: none unknown, being checked or unmerged.
  const releaseReady = merged > 0 && !(missing + noLink + checking + published + delegated);
  const parts = [
    missing ? `${plural(missing, 'step')} ${has(missing)} no recorded result` : null,
    checking ? `the merge of ${plural(checking, 'step')} is being checked; check again shortly` : null,
    noLink ? `${plural(noLink, 'step')} ${has(noLink)} no recorded result link; check ${noLink === 1 ? 'its issue' : 'their issues'}` : null,
    published ? `${plural(published, 'step')} ${published === 1 ? 'waits' : 'wait'} for your review (merge not seen yet)` : null,
    delegated ? DELEGATED.progress(delegated) : null,
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
 * `outcome`, else its title (what the campaign delivers). Otherwise null: the page shows the campaign id. Issue titles
 * are not read from GitHub.
 */
export function purpose(campaign) {
  if (campaign.purpose) return { text: campaign.purpose, from: 'declaration' };
  const only = campaign.tasks?.length === 1 ? campaign.tasks[0] : null;
  if (only?.outcome) return { text: only.outcome, from: 'step-outcome' };
  if (only?.title) return { text: capital(only.title), from: 'step-title' };
  return null;
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
 * `delegation` is the owner's merge delegation from config.json (configuredMergeDelegation), or null: with it, a
 * verified, unmerged pull request is no Needs me item and is counted as `delegated`, never as awaiting the owner, until
 * it waited longer than `delegation.stallHours` since its check: then it is a counted Needs me item that opens it (#139).
 * `connected` are the connected project records when Add project is on (connectedProjects): a project held up by the
 * owner's decisions is in `held`, and the calm headline names it (aiworks#11 review 5 G7).
 */
export function ownerView(supervisor, merges = NO_MERGES, { host = null, now = Date.now(), releases = {}, delegation = null, connected = [] } = {}) {
  // Results with nothing finished in a project show the §7.1 empty copy, written once in copy.mjs.
  const { title, text } = stateCopy('results-empty'), noResults = { title, text };
  if (!supervisor?.available) return { available: false, headline: null, count: 0, items: [], groups: [], held: [], unknownResults: 0, also: null, layout: { cards: [], finished: [] }, reply: null, campaigns: {}, results: {}, noResults, recent: null };
  // `host` names this computer in the page header; the items say "this computer" (aiworks#11 review F22).
  const items = [], campaigns = {}, halted = [];
  let unknownResults = 0;
  // Whether AIWorks itself runs on this computer: the computer-wide state the supervisor reports from all its leases
  // (src/supervisor/api.mjs supervisorLiveness), never one piece of work's lease (aiworks#11 review 4 F2). A snapshot
  // without it (a synthetic one in a test) is read by the same rule: AIWorks runs while any lease is live.
  const aiworks = supervisor.controller?.state ?? (supervisor.campaigns.some((c) => c.controllerLive) ? 'running' : null);
  const entries = supervisor.campaigns.map((c) => ({ id: c.id, purpose: purpose(c) }));
  distinguish(entries);
  for (const c of supervisor.campaigns) {
    const steps = c.tasks.map((task) => ({ task, delivery: delivery(task, merges, now, c.id, delegation) }));
    const by = (state) => steps.filter((step) => step.delivery?.state === state);
    // "Checking for merges" only while a merge check that can still come shortly is running or due. Every other
    // published step waits for the owner's review: its merge is not seen, whatever the reason.
    const checking = by('published').filter((step) => step.delivery.pending);
    const awaiting = by('published').filter((step) => !step.delivery.pending), unknown = by('unknown');
    unknownResults += checking.length;
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
    let liveness = c.controllerLive ? 'running' : ['finished', 'cancelled'].includes(c.control) ? 'finished' : late ? 'late' : awaitingPickup ? 'awaiting-pickup'
      : working ? 'agent-working-supervisor-silent' : 'stopped';
    // One lapsed lease is that work's own state while AIWorks runs; while AIWorks restarts, it is only late.
    if (['stopped', 'agent-working-supervisor-silent'].includes(liveness)) {
      if (aiworks === 'running') liveness = neverLeased ? 'work-not-picked-up' : 'work-lapsed';
      else if (aiworks === 'restarting') liveness = neverLeased ? 'awaiting-pickup' : 'late';
    }
    campaigns[c.id] = { purpose: entries.find((entry) => entry.id === c.id).purpose, deliveries: Object.fromEntries(steps.map((step) => [step.task.id, step.delivery])),
      liveness,
      lastCheckIn: c.controllerLive ? null : leaseEnded, registeredAt,
      finished: finished?.text ?? null, releaseReady: finished?.releaseReady ?? false,
      // One line for the compact list of finished and cancelled campaigns.
      outcome: finished?.line ?? (c.control === 'cancelled' ? `Cancelled · ${delivered} of ${plural(c.tasks.length, 'step')} delivered` : null),
      // `delegated` only when the owner delegated merging: without it the counts are as before.
      counts: { total: c.tasks.length, delivered, merged: by('merged').length,
        awaiting: awaiting.length, ...(delegation ? { delegated: by('delegated').length } : {}), checking: checking.length, unknown: unknown.length, reports: by('report-posted').length } };
    const base = { campaignId: c.id, repository: c.repository };
    // One item per step, led by what the step delivers. The evidence is one compact line; the full sentence is one click away.
    for (const { task, delivery: d } of awaiting) {
      const waitingOn = c.tasks.filter((other) => other.state !== 'done' && other.dependsOn.includes(task.id));
      // A step starts from the base branch as it is at its first run and keeps that base (its worktree is created
      // once), so only steps that have not started yet can build on the merge.
      const notStarted = (other) => other.state === 'pending' && !other.attempts;
      const pending = waitingOn.filter(notStarted), started = waitingOn.filter((other) => !notStarted(other));
      // Steps declared to require merged dependencies cannot start at all until the owner merges.
      const gated = pending.filter((other) => other.requiresMergedDependencies);
      const churn = task.attempts >= CHURN_ATTEMPTS || task.verifierRejections > 0;
      const evidence = reviewEvidence(task);
      items.push({ ...base, kind: 'review', action: 'Review and merge', text: label(task), link: { label: `Open PR #${d.number}`, url: d.url },
        evidence: evidence.short, detail: evidence.text, mergeCheck: d.asOf,
        points: [
          // Why the merge cannot be seen at all on this computer, when that is the case.
          ['no-checkout', 'no-verified-sha'].includes(d.reason) ? `${d.note}.` : null,
          churn ? NEEDS.churn(task.attempts, task.verifierRejections) : null,
          gated.length ? NEEDS.gated(named(gated)) : pending.length ? NEEDS.buildsOn(named(pending))
            : started.length ? NEEDS.startedWithout(named(started), started.length)
              // Who releases is the project's rule (registry), never assumed to be the owner.
              : NEEDS.nothingWaits(releaseRule(releases, d.repository)),
        ].filter(Boolean).map((text) => ({ link: null, text })) });
    }
    // A delegated merge that waited too long: nothing has merged it, so it is the owner's again (#139).
    for (const { task, delivery: d } of by('delegated').filter((step) => step.delivery.stalled)) {
      items.push({ ...base, kind: 'merge-stalled', action: DELEGATED.stalledAction, text: label(task), link: { label: `Open PR #${d.number}`, url: d.url },
        mergeCheck: d.asOf, points: [{ link: null, text: DELEGATED.stalled(d.stalled) }] });
    }
    for (const { task } of unknown) {
      items.push({ ...base, kind: 'check', action: 'Check on GitHub', text: label(task), link: { label: NEEDS.stepIssue, url: task.issueUrl }, mergeCheck: null,
        points: [{ link: null, text: 'This step finished, but no result link was recorded, so the dashboard cannot tell where it stands.' }] });
    }
    // A cancelled campaign's stops are history: no answer or recheck resumes it, so they are no owner item. Its open
    // pull requests above still are, because a published result can still be merged.
    const cancelled = c.control === 'cancelled';
    if (c.blocker && !cancelled) {
      // What happened and what to do in owner words; what the supervisor recorded is one click away. The card carries the
      // Check again its sentence names, while the work takes it: a Needs me card has no More menu (review 5 G8).
      const check = (c.controls?.more ?? []).includes('recheck') ? blockerCheck(c.blocker, c.id) : null;
      const words = blockerWords(c.blocker, { check: Boolean(check) });
      items.push({ ...base, kind: c.blockerClass === 'B3' ? 'decision' : 'stopped', text: NEEDS.workStopped, command: check,
        evidence: NEEDS.recorded, detail: [c.blockerClass, c.blockerReason, c.blockerAction].filter(Boolean).join(' · '),
        points: [{ link: { label: 'Tracking issue', url: c.trackingUrl }, text: `${words.reason}. What to do: ${words.action}.` }] });
    }
    for (const task of cancelled ? [] : c.tasks.filter((item) => item.blocked && item.state !== 'done')) {
      items.push({ ...base, kind: task.blocked === 'B3' ? 'decision' : 'stopped', action: task.blocked === 'B3' ? 'Decision needed' : 'Stopped; will not retry by itself',
        text: label(task), link: { label: NEEDS.stepIssue, url: task.issueUrl },
        points: [{ link: null, text: `${task.blockedReason.charAt(0).toUpperCase()}${task.blockedReason.slice(1)}.` }] });
    }
    // A pause by itself is not for the owner: the campaign card shows it in a neutral state, with the reason given (the
    // store does not record who paused, so nothing is inferred from the reason text). A paused campaign still needs a
    // running supervisor, which renews its lease too, so a stopped or absent supervisor is listed, worded for the pause.
    const paused = c.control === 'paused';
    // A supervisor fault is not an owner action (aiworks#11 review F6, F17): it is listed under AIWorks itself, names the
    // project it holds up in `about`, and no project or headline counts it.
    if (c.livenessDefect) {
      const issue = supervisor.settings?.supervisorIssue ?? SUPERVISOR_ISSUE;
      items.push({ campaignId: c.id, repository: null, about: c.repository, kind: 'controller', system: true, text: NEEDS.fault.text,
        points: [{ link: { label: NEEDS.fault.link.replace(/\d+$/, issue.split('/').at(-1)), url: issue }, text: NEEDS.fault.point }] });
    } else if (['work-lapsed', 'work-not-picked-up'].includes(liveness)) {
      // AIWorks runs, but not this work: an item of this work's project, worded for this work alone, with its one time.
      const words = liveness === 'work-lapsed' ? NEEDS.lapsed(paused, working > 0) : NEEDS.unpicked(paused);
      items.push({ ...base, kind: 'unattended', at: liveness === 'work-lapsed' ? leaseEnded : undefined, text: words.text, points: [{ link: null, text: words.point }] });
    } else if (liveness === 'agent-working-supervisor-silent') {
      halted.push({ c, at: leaseEnded, how: 'silent', paused });
    } else if (liveness === 'stopped') {
      halted.push({ c, at: neverLeased ? undefined : leaseEnded, how: neverLeased ? 'not-picked-up' : 'stopped', paused });
    }
  }
  // AIWorks stopped on this computer is one fact, listed once under AIWorks itself with the work it holds up, not once
  // per piece of work (aiworks#11 review F9). Restarting it is the owner's action, so it counts toward Needs you.
  if (halted.length) items.push(stoppedItem(halted, entries, supervisor.controller?.stopRequested === true));
  const coordinator = supervisor.coordinator;
  if (coordinator && (coordinator.configError || coordinator.blocked)) {
    const waiting = coordinator.messages.filter((m) => m.state === 'received').length;
    // Owner words at this level (aiworks#11 review 4 F4); the machine's reason is one click away, under What AIWorks recorded.
    items.push({ kind: 'coordinator', system: true, campaignId: null, repository: null, text: 'AIWorks cannot read your messages',
      evidence: 'What AIWorks recorded', detail: coordinator.configError ?? coordinator.blocked,
      points: [{ link: null, text: `${waiting ? `${plural(waiting, 'message')} waiting. ` : ''}Not yours to fix: the AIWorks configuration file on this computer needs a fix by whoever maintains AIWorks.` }] });
  }
  const answered = (coordinator?.messages ?? []).filter((m) => m.state === 'answered' && (m.replyBody || m.replyUrl)).sort((a, b) => b.answeredAt - a.answeredAt)[0];
  // Calm only about what blocks on the owner; reports and releases are said apart, never as "nothing". Items that say
  // they are not owner actions (a supervisor fault, an unreadable inbox) are listed but not counted (review F17).
  const count = items.filter((item) => !item.system).length;
  // No work is blocked, but a project waiting for the owner's decisions is named, never hidden behind an all-clear.
  const held = heldProjects(connected);
  const headline = count ? `Needs you (${count})` : unknownResults ? 'Checking for merges before listing what needs you'
    : held.length ? NEEDS.held.headline(held.map((project) => project.name)) : 'No work is blocked on you right now';
  // Page order: campaigns with something listed for the owner, then the other active ones. Finished or cancelled
  // campaigns with nothing listed collapse into a compact list, most recent first.
  const listed = new Set(items.map((item) => item.campaignId).filter(Boolean));
  const terminal = (c) => ['finished', 'cancelled'].includes(c.control), recency = (c) => Date.parse(c.lastProgressAt ?? '') || 0;
  const layout = { cards: [...supervisor.campaigns.filter((c) => listed.has(c.id)), ...supervisor.campaigns.filter((c) => !listed.has(c.id) && !terminal(c))].map((c) => c.id),
    finished: supervisor.campaigns.filter((c) => !listed.has(c.id) && terminal(c)).sort((a, b) => recency(b) - recency(a)).map((c) => c.id) };
  return { available: true, headline, count, items, groups: needsGroups(items), held, unknownResults, also: alsoForYou(supervisor, campaigns, releases), layout, campaigns,
    results: resultsByProject(supervisor, campaigns, releases), noResults, recent: recentSummary(supervisor, campaigns), reply: answered ? { messageId: answered.id, answeredAt: answered.answeredAt, url: answered.replyBody ? null : answered.replyUrl } : null };
}

/**
 * The one Needs me item for AIWorks stopped on this computer (OWNER_WORKSPACE §7.2), listed under AIWorks itself: when
 * it last checked in and how to restart it. With one piece of work held up it is worded for that work and names it
 * (`about`, `campaignId`); with several, one line per project names the work it holds up and what a pause or a
 * still-working AI worker means for it.
 */
function stoppedItem(halted, entries, onPurpose) {
  // The Needs me banner is not shown with this item, so it says here whether AIWorks was stopped on purpose (one fact, once).
  const why = (point) => onPurpose ? `${NEEDS.onPurpose} ${point}` : point;
  if (halted.length === 1) {
    const [{ c, at, how, paused }] = halted;
    const words = how === 'silent' ? NEEDS.silent : how === 'not-picked-up' ? NEEDS.notPickedUp(paused) : NEEDS.stopped(paused);
    return { kind: 'controller', campaignId: c.id, repository: null, about: c.repository, holdsUp: [c.repository], at, text: words.text, points: [{ link: null, text: why(words.point) }] };
  }
  const known = halted.map((entry) => entry.at).filter(Number.isFinite);
  // What all of it has in common is said once, in the item's text; each piece of work notes only what differs.
  const common = halted.every((entry) => entry.how === halted[0].how) ? halted[0].how : 'stopped';
  const words = common === 'silent' ? NEEDS.silent : NEEDS.halted(common === 'not-picked-up');
  const projects = new Map();
  for (const { c, how, paused } of halted) {
    const key = c.repository.toLowerCase(), purpose = entries.find((entry) => entry.id === c.id).purpose;
    const name = purpose ? `${purpose.text}${purpose.variant ? ` (${purpose.variant})` : ''}` : c.id;
    if (!projects.has(key)) projects.set(key, { repository: c.repository, name: short(c.repository), works: [] });
    projects.get(key).works.push(NEEDS.heldWork(name, how === common ? null : how, paused));
  }
  return { kind: 'controller', campaignId: null, repository: null, holdsUp: [...projects.values()].map((project) => project.repository),
    at: known.length ? Math.max(...known) : null, text: words.text,
    points: [{ link: null, text: why(words.point) }, ...[...projects.values()].map(({ name, works }) => ({ link: null, text: NEEDS.heldUp(name, works) }))] };
}

/**
 * Connected projects held up by the owner's decisions (aiworks#11 review 5 G7): a project without GitHub, connected and
 * checked, where work cannot start until two decisions are made (D2 in the project rules and D4, owner question Q2;
 * OWNER_WORKSPACE §5.3). No work is blocked there, so they are no Needs me items and no count includes them, but Needs
 * me names each and links to its Now, which says what the decisions are. A setup problem is not here: Projects and the
 * project's Now say it (§4.2).
 */
function heldProjects(records) {
  return (records ?? []).filter((record) => record && record.source_kind !== 'github' && record.status === 'ready' && record.capabilities?.startWork?.allowed !== true)
    .map((record) => ({ id: record.id, name: record.name, text: NEEDS.held.row }));
}

export const SYSTEM_GROUP = 'AIWorks itself';

/**
 * Needs me (OWNER_WORKSPACE slice S3): the same items, grouped by project. One group per repository (case-insensitive,
 * in the order its first item is listed), named by its short name, or `owner/name` when two share one; then "AIWorks
 * itself" last, unless it holds an item that holds up work in several projects (`holdsUp`, AIWorks stopped on this
 * computer): then it comes first, with that item at its top, because no project item it holds up can move until it is
 * fixed (OWNER_WORKSPACE §4.2, aiworks#11 review 4 F5). That group holds the items about this computer's AIWorks: the one stopped-AIWorks item, which is the
 * owner's to restart, and the items marked `system`, which say they are not owner actions (a supervisor fault, an
 * unreadable coordinator inbox). A group's `count` is its owner actions, so a project's count is the Projects screen's
 * and the counts add up to the headline; `notCounted` is its items that are not owner actions (review F6, F17).
 * Grouping only: no item is added, dropped or reworded.
 */
function needsGroups(items) {
  const groups = new Map(), system = [];
  for (const item of items) {
    if (item.system || !item.repository) { system.push(item); continue; }
    const key = item.repository.toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, project: item.repository, name: short(item.repository), items: [] });
    groups.get(key).items.push(item);
  }
  const projects = [...groups.values()];
  const shared = projects.filter((group) => projects.some((other) => other !== group && other.name.toLowerCase() === group.name.toLowerCase()));
  for (const group of shared) group.name = group.project;
  if (system.length) {
    const root = (item) => (item.holdsUp?.length ?? 0) > 1;
    const group = { key: 'aiworks-itself', project: null, name: SYSTEM_GROUP, items: [...system.filter(root), ...system.filter((item) => !root(item))] };
    if (system.some(root)) projects.unshift(group); else projects.push(group);
  }
  return projects.map((group) => {
    const count = group.items.filter((item) => !item.system).length;
    return { ...group, count, notCounted: group.items.length - count };
  });
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
    if (d?.state === 'published' && recent.published.some((p) => p.campaignId === c.id && p.taskId === task.id)) {
      waiting.push({ campaignId: c.id, taskId: task.id, number: d.number, url: d.url });
    }
  }
  // Agent runs and the supervisor's own problems are counted apart: a failing supervisor step is journaled on every tick.
  const kind = (...kinds) => recent.failures.filter((f) => kinds.includes(f.kind)).length;
  return { since: recent.since, merged, delivered: recent.published, waiting,
    failures: kind('failed-run', 'rejected'), rejected: kind('rejected'), supervisorErrors: kind('step-error'), livenessProblems: kind('liveness-defect') };
}
