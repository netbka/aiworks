// Owner view: what needs the owner, and where each finished campaign step stands. It joins the supervisor snapshot
// with recorded merge receipts and local git (merges.mjs); it never calls GitHub. Without a matching receipt, unknown
// or stale merge state never reads as merged; fields come from the supervisor or local git, never worker output.

import { DELEGATED, NEEDS, RESTART_ADVICE, blockerCheck, blockerWords, stateCopy } from './copy.mjs';
import { rulesSummary } from './projects.mjs';

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;
const COMMENT_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+#issuecomment-\d+$/;
// A checked local review's work-list address (supervisor.mjs localReviewAddress), the only in-dashboard result link.
const WORK_ADDRESS = /^#\/worklist\/([1-9]\d{0,8})$/;
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
 * minutes). Without a recorded merge, older data or no successful fetch reads "published, merge not seen
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
  'no-checkout': 'This computer has no checkout of the repository configured, so AIWorks cannot see the merge here',
  'no-verified-sha': 'No independent check is recorded, so AIWorks cannot see the merge here',
  'no-link': 'AIWorks did not record where this result went' };

/**
 * Owner-facing state of a finished step: merged, published (merge not seen yet), report posted, or unknown when no
 * result link was recorded. Merged requires an exact-head receipt or a current check of the base branch. A published
 * step carries why its merge is not seen: `pending` when a check that can still come shortly is running or due.
 * `asOf` is the time of a merge check that is not current, or that is current but whose last fetch failed.
 * With merging delegated by the owner (`delegation`, config.json `merges`, #17), a verified pull request whose merge is
 * not seen and is not being checked is `delegated`: merged for the owner by `by`, or `held` with its reason key. Merging
 * delegated to AIWorks itself (`supervisor`) covers only the repositories the owner opted in (the step's review says
 * `mergeGate: 'on'`); in any other repository nobody merges for the owner, so the result stays theirs to review.
 * `merger` is who merges: 'aiworks' (its merge gate) or 'delegate' (someone else). `wait` is why the gate holds it, as
 * the code it journaled for this verified head (supervisor.mjs mergeWaitCode), or null. One not held that waited longer
 * than `delegation.stallHours` since its check (`task.verifiedAt`) is `stalled`, in whole hours (#139): time alone never
 * says why, so what that means for the owner is decided from `merger` and `wait` (needsForMerge).
 * A checked local review (`task.resultUrl` its work-list address) is `local`, with its `route` (localDelivery);
 * `target` is its campaign's repository, whose merge check says whether its merge can be seen here.
 */
export function delivery(task, merges = NO_MERGES, now = Date.now(), campaignId = null, delegation = null, target = null) {
  if (task.state !== 'done') return null;
  const url = task.resultUrl ?? '';
  if (COMMENT_URL.test(url)) return { state: 'report-posted', url, note: NOTES['report-posted'] };
  // A report recorded in the local work list (supervisor.mjs localReport): read there, never a merge or an acceptance.
  const local = task.localReport;
  if (Number.isSafeInteger(local?.number) && local.number > 0) {
    return { state: 'report-posted', local: true, url: null, number: local.number, route: { label: `Read the report in work list #${local.number}`, address: `#/worklist/${local.number}` },
      note: NOTES['report-posted'] };
  }
  const review = WORK_ADDRESS.exec(url);
  if (review) return localDelivery(task, Number(review[1]), merges, now, campaignId, target);
  const pr = PR_URL.exec(url);
  if (!pr) return { state: 'unknown', reason: 'no-link', note: NOTES['no-link'] };
  const receipt = task.mergeReceipt, recordedPr = PR_URL.exec(receipt?.url ?? '');
  if (recordedPr && receipt.sha === task.verifiedSha && receipt.originalUrl === url) {
    return { state: 'merged', repository: recordedPr[1], number: Number(recordedPr[2]), url: receipt.url,
      asOf: null, note: null, mergedAt: receipt.mergedAt ?? null };
  }
  const repository = pr[1], number = Number(pr[2]);
  const check = mergeCheck(merges, repository, now);
  const step = merges?.steps?.[`${campaignId}/${task.id}`];
  const result = task.verifiedSha && step?.sha === task.verifiedSha ? step.merged : null;
  const asOf = check.reason && check.reason !== 'no-checkout' && check.at !== null ? { at: check.at, reason: check.reason } : null;
  const base = { repository, number, url, asOf };
  if (result === true && check.fresh) return { state: 'merged', ...base, note: null, mergedAt: step.mergedAt ?? null };
  const reason = !task.verifiedSha ? 'no-verified-sha' : check.reason === 'no-checkout' ? 'no-checkout'
    : check.reason === 'fetch-failed' && !check.fresh ? 'fetch-failed' : !check.fresh || result === null ? 'checking' : null;
  // A version the owner accepts themselves (AW-015) is not merged for them until they do: it waits for their review.
  const merger = delegation?.delegatedTo === 'supervisor' ? 'aiworks' : 'delegate';
  const optedIn = merger !== 'aiworks' || task.review?.mergeGate === 'on';
  if (delegation && optedIn && task.verifiedSha && reason !== 'checking' && !task.review?.awaitsAcceptance) {
    const held = delegation.held?.[url.toLowerCase()] ?? null;
    const waited = !held && Number.isSafeInteger(task.verifiedAt) ? now - task.verifiedAt : null;
    const stalled = waited !== null && waited > (delegation.stallHours ?? MERGE_STALL_HOURS) * HOUR_MS ? Math.floor(waited / HOUR_MS) : null;
    const wait = held ? 'held' : task.mergeWait?.kind ?? null;
    return { state: 'delegated', ...base, reason, pending: false, held, stalled, by: delegation.delegatedTo, merger, wait,
      note: held ? DELEGATED.held[held] : stalled ? mergeWaitWords(merger, wait).reason : DELEGATED.note(delegation.delegatedTo) };
  }
  return { state: 'published', ...base, reason, pending: reason === 'checking', note: NOTES[reason ?? 'published'] };
}

/** Why a delegated merge waits and what happens next, in owner words; unknown stays unknown (DELEGATED.unknown). */
function mergeWaitWords(merger, wait) {
  if (merger !== 'aiworks') return { routine: false, reason: 'Merging is left to someone other than AIWorks', next: 'AIWorks is not allowed to merge it.' };
  return wait ? DELEGATED.waits[wait] ?? DELEGATED.waits.other : { routine: true, ...DELEGATED.unknown };
}

/** Who merges a result in a repository AIWorks may not merge in: said once, the same on every screen. */
const OWN_MERGE = 'Merging follows this project’s own rules: AIWorks merges only in projects where you allowed it';

/**
 * What the owner already settled on a step, so it waits for AIWorks, not for them (`handling`, never counted): an answer
 * to its decision that the controller has not applied yet, or requested changes it has not reopened yet. Null otherwise.
 */
function ownerSettled(base, task) {
  const entry = { ...base, taskId: task.id, text: label(task), recorded: true };
  if (task.decision?.answered) return { ...entry, reason: 'Your answer is recorded', next: 'AIWorks resumes this step with it on its next pass.', since: task.decision.answered.at ?? null, sinceWords: 'Answered' };
  if (task.review?.state === 'changes-requested') return { ...entry, reason: 'Your requested changes are recorded', next: 'AIWorks reopens this step as a repair round within the approved plan.', since: task.review.requestedAt ?? null, sinceWords: 'Requested' };
  return null;
}

const LOCAL_NOTES = { published: 'Checked on this computer and recorded in the work list; not merged into local main yet',
  checking: NOTES.checking, 'no-verified-sha': 'No verified commit is recorded, so the merge cannot be checked here',
  'not-checked': 'The merge into local main cannot be seen on this computer; open the work list' };

/**
 * A checked local review of AIWorks's own repository, read in the work list (UI20). Merged only from the local merge
 * gate's receipt for the verified commit and this review, or local main containing that commit (merges.mjs reads the
 * local branch and never fetches). Merged is never accepted, deployed or pushed; merging delegation does not apply here.
 */
function localDelivery(task, number, merges, now, campaignId, repository) {
  const base = { local: true, repository, number, url: null, asOf: null,
    route: { label: `Open work list #${number}`, address: `#/worklist/${number}` } };
  const receipt = task.mergeReceipt;
  if (task.verifiedSha && receipt?.sha === task.verifiedSha && receipt.url === `aiworks-work:${number}`) {
    return { state: 'merged', ...base, note: null, mergedAt: receipt.mergedAt ?? null };
  }
  const step = merges?.steps?.[`${campaignId}/${task.id}`];
  const result = task.verifiedSha && step?.sha === task.verifiedSha ? step.merged : null;
  if (result === true) return { state: 'merged', ...base, note: null, mergedAt: step.mergedAt ?? null };
  // A merge check that cannot come (no checkout configured here, or a failed read) is not seen, never pending.
  const check = repository ? mergeCheck(merges, repository, now) : null;
  const unseen = !step || check?.reason === 'no-checkout' || (check?.reason === 'fetch-failed' && !check.fresh);
  const reason = !task.verifiedSha ? 'no-verified-sha' : result !== null ? null : unseen ? 'not-checked' : 'checking';
  return { state: 'published', ...base, reason, pending: reason === 'checking', note: LOCAL_NOTES[reason ?? 'published'] };
}

/**
 * What the owner can know before merging: whether the exact version passed the independent check. The version's identity
 * stays in the review binding, never in these words. `short` is one compact line; `text` the full sentence.
 */
export function reviewEvidence(task) {
  if (!task.verifiedSha || task.review?.state === 'no-evidence') return { ...NEEDS.noEvidence };
  return task.checkPassed ? NEEDS.evidence() : incompleteCheck(task);
}

/**
 * What the independent check left open on a verified result that did not pass (supervisor.mjs `checkPassed`): its
 * failed and not-checked criteria and open blocking findings, as Review counts them. Never "passed".
 */
function incompleteCheck(task) {
  const u = task.review?.unresolved;
  const missing = (u ? [u.failed ? `${plural(u.failed, 'criterion', 'criteria')} failed` : null,
    u.notChecked ? `${plural(u.notChecked, 'criterion', 'criteria')} not checked` : null,
    u.blocking ? `${plural(u.blocking, 'blocking finding')} open` : null].filter(Boolean).join(' · ') : '') || 'not every criterion is recorded as passed';
  return { short: `Not complete: ${missing}`, text: `The independent check did not pass every criterion of this version (${missing}); Review shows what is missing.` };
}

/**
 * The check evidence of one result, in the Results words (OWNER_WORKSPACE §2.3): "Passed the check", never
 * "accepted", which is kept for recorded acceptance (#4). `short` is the row line; `text` the sentence in its details.
 */
export function resultEvidence(task) {
  if (!task.verifiedSha || task.review?.state === 'no-evidence') return { short: 'Independent check not recorded here', text: 'The independent check is not recorded here.' };
  if (!task.checkPassed) return incompleteCheck(task);
  return { short: 'Passed the independent check', text: 'Passed the independent check of exactly this version; Review shows its criteria and evidence.' };
}

/**
 * Results (OWNER_WORKSPACE §4.9, slice S6, build slice UI7): the groups in screen order, each with its §2.3 state word.
 * "Closed without merging" has no source yet: the local merge check cannot tell a closed pull request from an open
 * one, so such a result stays under "Waiting for your review" and is never merged. "Changes requested by you" is the
 * owner's own request recorded in AIWorks (Request changes), never GitHub's review state, which the dashboard does not
 * read (PROJECT_WORKSPACE_PLAN §6.12 C1, gap G3).
 */
export const RESULT_GROUPS = [
  { key: 'review', title: 'Waiting for your review' },
  { key: 'changes', title: 'Changes requested by you' },
  { key: 'accepted', title: 'Accepted by you · not merged yet' },
  { key: 'local-review', title: 'Checked on this computer · not merged yet' },
  { key: 'delegated', title: 'Being merged for you' },
  { key: 'closed', title: 'Closed without merging' },
  { key: 'reports', title: 'Reports to read' },
  { key: 'read', title: 'Reports you read' },
  { key: 'merged', title: 'Merged' },
  { key: 'unknown', title: 'Not known yet' },
];

/**
 * Review of a result (OWNER_UI_V2 WP4) from Results, Home and Overview: the step screen that holds its criteria, evidence,
 * Accept result and Request changes, bound to the verified head. `acceptedAt` only from recorded acceptance; null otherwise.
 */
export function reviewEntry(c, task, d = null) {
  const review = task.review;
  if (!review || !['ready', 'accepted', 'changes-requested', 'no-evidence', 'merged'].includes(review.state)) return null;
  // Merged outside the merge gate (seen in local git), as the step's Review says: nothing is left to accept.
  const state = d?.state === 'merged' && ['ready', 'accepted'].includes(review.state) ? 'merged' : review.state;
  return { label: state === 'ready' && review.canAccept ? 'Review and accept' : 'Review result', state,
    acceptedAt: review.state === 'accepted' ? review.acceptedAt ?? null : null,
    address: { screen: 'step', project: c.repository, work: c.id, step: task.id } };
}

/** One finished step as a Results row: its group, its state word, what it means, and the link to the result. */
function resultRow(c, task, d, releases, recorded = null, read = new Set()) {
  const base = { campaignId: c.id, taskId: task.id, repository: c.repository, text: label(task), mergedAt: null, release: null, asOf: d.asOf ?? null, signature: task.signature ?? null,
    checkPassed: task.checkPassed === true,
    review: reviewEntry(c, task, d),
    // A report is read, never released, so it has no release steps.
    ladder: d.state === 'report-posted' ? null : releaseLadder(task, d, recorded) };
  if (d.state === 'report-posted') {
    const evidence = task.verifiedSha ? resultEvidence(task) : null;
    if (read.has(`${c.id}/${task.id}`)) return { ...base, group: 'read', word: 'Read by you', note: null,
      link: d.local ? null : { label: 'Read the report', url: d.url }, route: d.local ? d.route : null, evidence: null, detail: null };
    return { ...base, group: 'reports', canMarkRead: true, word: d.local ? 'Report recorded in the work list · for you to read' : 'Report posted · for you to read', note: null,
      link: d.local ? null : { label: 'Read the report', url: d.url }, route: d.local ? d.route : null,
      evidence: evidence?.short ?? null, detail: evidence?.text ?? null };
  }
  if (d.state === 'unknown') {
    return { ...base, group: 'unknown', word: 'Not known yet', note: 'AIWorks did not record where this result went', link: null,
      route: { label: 'Open the step', address: { screen: 'step', project: c.repository, work: c.id, step: task.id } }, evidence: null, detail: null };
  }
  // A checked local review opens its work-list item (UI20): it merges into local main, never through a pull request.
  if (d.local) {
    const row = { ...localReviewRow({ campaignId: c.id, taskId: task.id, number: d.number, verifiedSha: task.verifiedSha, mergedAt: d.mergedAt ?? null },
      base.text, d.state === 'merged'), review: base.review, ladder: base.ladder, signature: base.signature };
    checkedRow(row, task);
    // A merge check that can still come shortly: neither waiting nor merged. Why a merge cannot be seen is said.
    return d.pending ? { ...row, group: 'unknown', word: 'Not known yet', note: d.note } : d.reason ? { ...row, note: d.note } : row;
  }
  // The pull request is supporting reference only: Review, inside AIWorks, is where the result is resolved.
  const evidence = resultEvidence(task), link = { label: `Pull request #${d.number}`, url: d.url }, number = d.number;
  const proof = { evidence: evidence.short, detail: evidence.text, number };
  // Merged only from a current merge check; what follows is the project's release rule, never "released" or "live".
  if (d.state === 'merged') return { ...base, ...proof, group: 'merged', word: 'Merged', note: null, link, mergedAt: d.mergedAt ?? null,
    release: `Release follows ${releaseRule(releases, c.repository)}.` };
  // Merging delegated by the owner: passed the check and merged for them, held with its reason, or waiting too long.
  if (d.state === 'delegated') return { ...base, ...proof, group: 'delegated', note: d.note, link,
    word: d.held ? DELEGATED.heldRow(number, DELEGATED.held[d.held]) : d.stalled ? DELEGATED.waitedRow(d.stalled, task.checkPassed === true) : DELEGATED.row(number, d.by, task.checkPassed === true) };
  // A merge check that can still come shortly: the state is not known yet, so it is neither waiting nor merged.
  if (d.pending) return { ...base, ...proof, group: 'unknown', word: 'Not known yet', note: d.note, link };
  // Sent back by the owner: no longer waiting for their review. Only running work repairs it (ownerSettled).
  if (task.review?.state === 'changes-requested') return { ...base, ...proof, group: 'changes', word: 'Changes requested by you · not merged',
    note: c.control === 'paused' ? 'This work is paused, so nobody is making the changes until you resume it.'
      : c.control === 'cancelled' ? 'This work was stopped, so AIWorks will not make the changes; plan this work again if you still want them.'
        : 'AIWorks repairs this step within the approved plan.', link };
  // Accepted by the owner where AIWorks may not merge: their decision is recorded, merging follows the project's own rules.
  if (task.review?.state === 'accepted') return { ...base, ...proof, group: 'accepted', word: 'Accepted by you · not merged yet', note: OWN_MERGE, link };
  return { ...base, ...proof, group: 'review', word: `Pull request #${number} · waiting for your review`,
    note: d.reason ? d.note : 'The merge is not seen on the base branch yet', link };
}

/** When a handling entry's check ran: "Passed the check" only when it passed every criterion (supervisor.mjs checkPassed). */
const checkedWords = (task) => task.checkPassed ? 'Passed the check' : 'Checked';

/** A local review row of a step whose check did not pass every criterion says what is missing, never that it passed. */
function checkedRow(row, task) {
  row.checkPassed = task.checkPassed === true;
  if (!task.verifiedSha || task.checkPassed) return row;
  const evidence = incompleteCheck(task);
  return Object.assign(row, { evidence: evidence.short, detail: evidence.text,
    note: row.group === 'local-review' ? 'A local review recorded in the work list, not on GitHub; its independent check is not complete.' : row.note });
}

/** The newest checked local review of each campaign step, by `<campaignId>/<taskId>` (work-list.mjs reviewRows, newest first). */
function localReviews(workList) {
  const reviews = new Map();
  for (const review of workList?.reviews ?? []) {
    const key = `${review.campaignId}/${review.taskId}`;
    if (review.campaignId && review.taskId && !reviews.has(key)) reviews.set(key, review);
  }
  return reviews;
}

/**
 * A checked local review as a Results row (LOCAL_OPERATION section 5.2, UI20): passed the independent check at its
 * commit and recorded on this computer. Merged only when the local merge gate recorded that commit on main; never
 * "accepted", which is kept for recorded acceptance.
 */
function localReviewRow(review, text, merged = Boolean(review.mergedAt)) {
  const evidence = review.verifiedSha ? { short: 'Passed the independent check', text: 'Passed the independent check of exactly this version. Nothing was pushed to GitHub.' }
    : { short: 'Independent check not recorded here', text: 'The independent check is not recorded here.' };
  const base = { campaignId: review.campaignId, taskId: review.taskId, repository: null, text, release: null, asOf: null, signature: null, ladder: null, number: review.number,
    link: null, route: { label: `Work list #${review.number}`, address: `#/worklist/${review.number}` }, evidence: evidence.short, detail: evidence.text };
  return merged
    ? { ...base, group: 'merged', word: 'Merged into local main', mergedAt: review.mergedAt ?? null, note: null,
      release: 'Into local main on this computer; nothing was pushed. Merged is not accepted: acceptance is recorded only when you accept it.' }
    : { ...base, group: 'local-review', word: 'Checked on this computer · not merged, not accepted', mergedAt: null,
      note: 'A local review: it passed the independent check and is recorded in the work list, not on GitHub.' };
}

/** The words of one release step's answer (AUTO_RELEASE.md section 1). */
export const LADDER_ANSWERS = { yes: 'Yes', no: 'No', 'in-progress': 'In progress', unknown: 'Unknown' };

/**
 * The five steps of one result (AUTO_RELEASE.md section 1 and 9, slice UI15), each yes, no, in-progress or unknown,
 * never merged into one tick. `recorded` is the result's latest release (supervisor.mjs recordedReleases), or null:
 * none is recorded in Review only, which is every project until #33. A step is yes only from recorded evidence: an
 * outcome of done, a current merge check, or the independent check of the exact commit. A started step with no
 * outcome is in progress, or unknown when the release is unknown; anything unreadable is unknown. A project without
 * GitHub (`github` false) has no merge step, and its release is Applied, not Deployed.
 */
export function releaseLadder(task, d, recorded = null, { github = true } = {}) {
  const forward = (step) => {
    if (!recorded?.steps.includes(step)) return null;
    const entry = recorded.history.filter((item) => item.step === step).at(-1);
    if (!entry) return recorded.state === 'unknown' && recorded.step === step ? 'unknown' : 'no';
    if (entry.outcome === 'done') return 'yes';
    if (['failed', 'refused', 'not-done'].includes(entry.outcome)) return 'no';
    return entry.outcome === null && recorded.state !== 'unknown' ? 'in-progress' : 'unknown';
  };
  const merged = !github ? null : d?.state === 'merged' ? 'yes' : forward('merge') ?? (!d || d.state === 'unknown' || d.pending ? 'unknown' : 'no');
  // Without a recorded release AIWorks released nothing; whether the project's own release made it live is not known here.
  const unreleased = merged === 'no' ? 'no' : 'unknown';
  const releases = !recorded || ['deploy', 'apply'].some((step) => recorded.steps.includes(step));
  const steps = [
    { key: 'implemented', label: 'Implemented', answer: task.headSha ? 'yes' : 'unknown' },
    // Yes only when every criterion passed; checked with criteria failed or not checked is no (result-review.mjs passedCheck).
    { key: 'checked', label: 'Independently checked', answer: task.checkPassed ? 'yes' : task.verifiedSha ? 'no' : 'unknown' },
    github ? { key: 'merged', label: 'Merged', answer: merged } : null,
    releases ? { key: 'deployed', label: github ? 'Deployed' : 'Applied', answer: forward('deploy') ?? forward('apply') ?? unreleased } : null,
    { key: 'release-checked', label: 'Release checked', answer: forward('check') ?? unreleased },
  ].filter(Boolean).map((step) => ({ ...step, text: `${step.label}: ${LADDER_ANSWERS[step.answer]}` }));
  const sha = String(recorded?.verifiedSha ?? task.verifiedSha ?? '').toLowerCase().slice(0, 7) || null;
  const note = !recorded ? 'Review only: AIWorks does not deploy this result. Whether it is live is not recorded here.'
    : recorded.state === 'rolled-back' ? 'Rolled back: the checks after release failed.'
      : recorded.state === 'rollback-failed' ? 'The rollback failed. See Needs you.'
        : recorded.state === 'unknown' ? 'Outcome unknown: AIWorks is checking the destination and will not release there again until it knows.' : null;
  return { sha, steps, note, destination: recorded?.destination ?? null };
}

/**
 * Results per project, keyed by the lowercased repository: the non-empty groups in RESULT_GROUPS order, and at most one
 * primary action, "Review pull request #N" for the oldest waiting review (the lowest pull request number). Rows keep
 * the campaigns' order, except that reviews are oldest first.
 */
function resultsByProject(supervisor, campaigns, releases, reviews = new Map(), selfRepository = null, read = new Set()) {
  const projects = new Map(), shown = new Set();
  const recorded = new Map((supervisor.releases ?? []).map((r) => [`${r.campaignId}/${r.taskId}`, r]));
  const add = (project, row) => {
    const key = project.toLowerCase();
    if (!projects.has(key)) projects.set(key, { project, rows: [] });
    projects.get(key).rows.push(row);
  };
  for (const c of supervisor.campaigns) for (const task of c.tasks) {
    const d = campaigns[c.id].deliveries[task.id], review = reviews.get(`${c.id}/${task.id}`);
    if (review && d?.state === 'unknown') { shown.add(review.number); add(c.repository, checkedRow({ ...localReviewRow(review, label(task)), review: reviewEntry(c, task, d) }, task)); continue; }
    if (!d) continue;
    if (d.local) shown.add(d.number);
    add(c.repository, resultRow(c, task, d, releases, recorded.get(`${c.id}/${task.id}`) ?? null, read));
  }
  // Reviews of work no longer on this computer still belong to AIWorks's own repository.
  // Their criteria are not on this computer, so they are never shown as passed (checkedRow).
  if (selfRepository) for (const review of reviews.values()) if (!shown.has(review.number)) add(selfRepository, checkedRow(localReviewRow(review, review.title), { verifiedSha: review.verifiedSha, checkPassed: false }));
  return Object.fromEntries([...projects].map(([key, { project, rows }]) => {
    const groups = RESULT_GROUPS.map((group) => {
      const mine = rows.filter((row) => row.group === group.key);
      if (group.key === 'review') mine.sort((a, b) => a.number - b.number);
      return { ...group, count: mine.length, rows: mine };
    }).filter((group) => group.count);
    // The oldest result waiting for review opens Review in the dashboard when its check is recorded; otherwise its pull request.
    const oldest = groups.find((group) => group.key === 'review')?.rows[0];
    return [key, { project, total: rows.length, groups,
      primary: !oldest ? null : oldest.review ? { label: `Review result: ${oldest.text}`, route: oldest.review.address }
        : { label: `Review pull request #${oldest.number}`, url: oldest.link.url } }];
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
/**
 * Whether a step's result still has something unresolved (OWNER_UI_V2 WP4): a criterion that failed or was not checked,
 * a blocking finding, no accepted verification of its head, or changes the owner requested. Its goal is never complete.
 */
export const unresolvedResult = (task) => Boolean(task.review) && (['no-evidence', 'changes-requested'].includes(task.review.state) ||
  Boolean(task.review.unresolved && task.review.unresolved.failed + task.review.unresolved.notChecked + task.review.unresolved.blocking));

function finishedSummary(c, steps, releases) {
  const count = (test) => steps.filter(test).length;
  const state = (name) => count((step) => step.delivery?.state === name);
  const has = (n) => n === 1 ? 'has' : 'have';
  const missing = count((step) => !step.delivery), noLink = state('unknown'),
    checking = count((step) => step.delivery?.pending),
    accepted = count((step) => step.delivery?.state === 'published' && !step.delivery.pending && step.task.review?.state === 'accepted'),
    published = state('published') - checking - accepted,
    reports = state('report-posted'), merged = state('merged'), delegated = state('delegated'), unresolved = count((step) => unresolvedResult(step.task));
  // Merged work is ready for release only when every other step is a report: none unknown, being checked or unmerged,
  // and no result has a criterion failed or not checked, a blocking finding or requested changes (WP4).
  const releaseReady = merged > 0 && !(missing + noLink + checking + published + accepted + delegated + unresolved);
  const parts = [
    unresolved ? `${plural(unresolved, 'step')} ${has(unresolved)} criteria not checked, failed or open findings; see ${unresolved === 1 ? 'its' : 'their'} evidence` : null,
    missing ? `${plural(missing, 'step')} ${has(missing)} no recorded result` : null,
    checking ? `the merge of ${plural(checking, 'step')} is being checked; check again shortly` : null,
    noLink ? `${plural(noLink, 'step')} ${has(noLink)} no recorded result link; check ${noLink === 1 ? 'its issue' : 'their issues'}` : null,
    published ? `${plural(published, 'step')} ${published === 1 ? 'waits' : 'wait'} for your review (merge not seen yet)` : null,
    accepted ? `${plural(accepted, 'step')} accepted by you, not merged yet` : null,
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
 * verified, unmerged pull request is no Needs you item and is counted as `delegated`, never as awaiting the owner, until
 * it waited longer than `delegation.stallHours` since its check: then it is a counted Needs you item that opens it (#139).
 * `connected` are the connected project records when Add project is on (connectedProjects): a project held up by the
 * owner's decisions is in `held`, and the calm headline names it (aiworks#11 review 5 G7).
 */
export function ownerView(supervisor, merges = NO_MERGES, { host = null, now = Date.now(), releases = {}, delegation = null, connected = [], workList = null, localWork = {}, readReports = new Set() } = {}) {
  // Results with nothing finished in a project show the §7.1 empty copy, written once in copy.mjs.
  const { title, text } = stateCopy('results-empty'), noResults = { title, text };
  if (!supervisor?.available) return { available: false, headline: null, count: 0, items: [], handling: [], groups: [], held: [], unknownResults: 0, also: null, layout: { cards: [], finished: [] }, reply: null, campaigns: {}, results: {}, noResults, recent: null };
  // `host` names this computer in the page header; the items say "this computer" (aiworks#11 review F22).
  const items = [], handling = [], campaigns = {}, halted = [];
  let unknownResults = 0;
  // A step of AIWorks's own repository recorded in the local work list (UI20) is a checked local review, not a missing link.
  const reviews = localReviews(workList);
  // Whether AIWorks itself runs on this computer: the computer-wide state the supervisor reports from all its leases
  // (src/supervisor/api.mjs supervisorLiveness), never one piece of work's lease (aiworks#11 review 4 F2). A snapshot
  // without it (a synthetic one in a test) is read by the same rule: AIWorks runs while any lease is live.
  const aiworks = supervisor.controller?.state ?? (supervisor.campaigns.some((c) => c.controllerLive) ? 'running' : null);
  const entries = supervisor.campaigns.map((c) => ({ id: c.id, purpose: purpose(c) }));
  distinguish(entries);
  for (const c of supervisor.campaigns) {
    const steps = c.tasks.map((task) => ({ task, delivery: delivery(task, merges, now, c.id, ['registered', 'finished'].includes(c.control) ? delegation : null, c.repository) }));
    const by = (state) => steps.filter((step) => step.delivery?.state === state);
    // "Checking for merges" only while a merge check that can still come shortly is running or due. Every other
    // published step waits for the owner's review: its merge is not seen, whatever the reason.
    const checking = by('published').filter((step) => step.delivery.pending);
    // A result the owner accepted or asked to change no longer waits for their review (ownerSettled, OWN_MERGE).
    const settledReview = (step) => ['accepted', 'changes-requested'].includes(step.task.review?.state);
    const awaiting = by('published').filter((step) => !step.delivery.pending && !settledReview(step)), unknown = by('unknown');
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
        awaiting: awaiting.length, ...(delegation ? { delegated: by('delegated').length } : {}), checking: checking.length, unknown: unknown.length, reports: by('report-posted').filter((step) => !readReports.has(`${c.id}/${step.task.id}`)).length,
        // Results with evidence still unresolved (WP4): a finished goal with any is not shown as complete.
        unresolved: c.tasks.filter(unresolvedResult).length } };
    const base = { campaignId: c.id, repository: c.repository };
    // Every step item names its step (`taskId`) and opens it inside AIWorks; a GitHub link is supporting reference only.
    const project = (supervisor.goals ?? []).find((goal) => goal.id === c.id)?.project ?? c.repository;
    const stepRoute = (task, text = 'Open the step') => ({ label: text, address: { screen: 'step', project, work: c.id, step: task.id } });
    const reviewRoute = (task) => { const entry = reviewEntry(c, task); return entry ? { label: 'Open the full review', address: entry.address } : stepRoute(task); };
    const reference = (d) => d && !d.local && d.number ? { label: `Pull request #${d.number}`, url: d.url } : null;
    const stopped = !['registered', 'finished'].includes(c.control);
    const stoppedWords = c.control === 'paused' ? 'This work is paused. Resume it from its work controls when you want it to continue.'
      : 'This work was stopped. AIWorks will not continue it; plan new work if you want to use this result.';
    // Accepted where AIWorks may not merge: the owner's approval is recorded, but the result is not merged and its goal is
    // not finished. Completing it is planned work, approved like any plan; no merge permission comes from here.
    const acceptedItem = (task, d) => ({ ...base, taskId: task.id, kind: 'accepted-unmerged', action: 'Accepted · not merged yet', text: label(task),
      why: stopped ? `You accepted this result. ${stoppedWords}` : 'You accepted this result, but AIWorks is not allowed to finish integrating it in this project. The goal is still unfinished.',
      route: reviewRoute(task), reference: reference(d), mergeCheck: d?.asOf ?? null,
      plan: c.control === 'paused' ? null : { label: 'Plan the completion…', goal: `Complete the accepted result “${label(task)}”: ` },
      command: c.control === 'paused' && c.controls?.primary === 'resume' ? { label: 'Resume this work', command: 'resume', campaignId: c.id } : null,
      points: stopped ? [] : [{ link: null, text: `${OWN_MERGE}. To have AIWorks complete it, plan the follow-up; nothing starts until you approve the plan, and it gives AIWorks no permission to merge here.` }] });
    // Changes the owner requested in stopped work: nothing repairs them while it is paused, and cancelled work never
    // resumes, so the request stays theirs to continue with the work's own Resume or with new planned work. It claims no
    // worker and resumes nothing by itself.
    const changesItem = (task, d) => ({ ...base, taskId: task.id, kind: 'changes-stopped', action: 'Changes requested · not being made', text: label(task),
      why: `You requested changes to this result. ${c.control === 'paused' ? 'This work is paused, so nobody is making them. Resume it from its work controls when you want them made.'
        : 'This work was stopped, so AIWorks will not make them. Plan this work again if you still want them; nothing starts until you approve the plan.'}`,
      route: reviewRoute(task), reference: reference(d), mergeCheck: d?.asOf ?? null,
      plan: c.control === 'paused' ? null : { label: 'Plan this work again…', goal: `Make the changes I requested to “${label(task)}”: ` },
      command: c.control === 'paused' && c.controls?.primary === 'resume' ? { label: 'Resume this work', command: 'resume', campaignId: c.id } : null, points: [] });
    // A checked local review in a project whose merge gate is on merges into local main by that gate once its conditions
    // hold, with or without the owner's review (merge.mjs candidates): AIWorks's own work, never an owner chore. A wait
    // the gate recorded says why; one it cannot settle by itself is listed under AIWorks itself, as for pull requests.
    const gateMerges = (task, d) => !stopped && d.local && task.verifiedSha && task.review?.mergeGate === 'on';
    const gateHandles = (task, accepted) => {
      const wait = task.mergeWait?.kind ?? null, words = wait ? mergeWaitWords('aiworks', wait) : null;
      if (words?.owner) {
        items.push({ ...base, taskId: task.id, kind: wait, action: words.action, text: label(task), why: `${words.reason}. ${words.next}`,
          route: stepRoute(task, 'Open work controls'), command: wait === 'local-unsaved' ? null : { label: 'Review project connection', route: '#/settings/connections' }, points: [] });
        return;
      }
      if (words && !words.routine) {
        items.push({ ...base, repository: null, about: c.repository, taskId: task.id, kind: 'merge-problem', system: true, action: 'AIWorks cannot finish this by itself',
          text: label(task), why: `${words.reason}. ${words.next}`, route: stepRoute(task), reference: null,
          points: [{ link: null, text: 'Not an investigation for you: AIWorks keeps what it recorded for its maintainers. If this result should not continue, stop this work from its project.' }] });
        return;
      }
      handling.push({ ...base, taskId: task.id, text: label(task), recorded: Boolean(wait), since: task.verifiedAt ?? null, sinceWords: checkedWords(task),
        reason: words?.reason ?? (accepted ? 'You accepted this version' : task.checkPassed ? 'It passed the independent check on this computer' : 'It was checked on this computer; not every criterion passed'),
        next: words?.next ?? 'AIWorks finishes integrating this result when its required checks and approvals pass.' });
    };
    // A checked version the merge gate holds for the owner's acceptance (AW-015): one item, resolved on its card or its
    // Review, where Accept result and Request changes bind exactly that version and report. Merged outside the gate, nothing is left.
    const accepting = steps.filter((step) => step.task.review?.awaitsAcceptance && step.delivery?.state !== 'merged');
    for (const { task, delivery: d } of accepting) {
      const evidence = reviewEvidence(task);
      items.push({ ...base, taskId: task.id, kind: 'accept', action: NEEDS.accept.action, text: label(task), why: stopped ? stoppedWords
          : task.checkPassed ? NEEDS.accept.point : `${evidence.text} Review it before you accept it or request changes.`,
        route: reviewRoute(task), reference: reference(d), evidence: evidence.short, detail: evidence.text, points: [] });
    }
    // One item per step, led by what the step delivers. Nobody merges it for the owner here, so it waits for their review.
    // Requested changes wait for AIWorks; an accepted version is in Results, merged by the project's own rules.
    for (const { task, delivery: d } of by('published').filter((step) => !step.delivery.pending && settledReview(step))) {
      const settled = stopped ? null : ownerSettled(base, task);
      if (settled) handling.push(settled);
      else if (task.review?.state === 'changes-requested') items.push(changesItem(task, d));
      else if (task.review?.state === 'accepted') {
        if (gateMerges(task, d)) gateHandles(task, true);
        else items.push(acceptedItem(task, d));
      }
    }
    for (const { task, delivery: d } of awaiting.filter((step) => !accepting.includes(step))) {
      // Published without an independent check on record: it can be neither accepted nor sent back, so the owner's real
      // choice is to plan its completion again (approved like any plan) or leave it unmerged. Never "passed the check".
      if (!d.local && (!task.verifiedSha || task.review?.state === 'no-evidence')) {
        items.push({ ...base, taskId: task.id, kind: 'unchecked', action: 'Decide how this result continues', text: label(task),
          why: 'AIWorks published this result, but no independent check of it is on record, so it cannot be accepted or sent back here, and nothing of it counts as passed or merged.',
          route: reviewEntry(c, task) ? reviewRoute(task) : d.route ?? stepRoute(task), reference: reference(d), evidence: NEEDS.noEvidence.short, mergeCheck: d.asOf,
          plan: { label: 'Plan this work again…', goal: `Redo and check “${label(task)}”: ` },
          points: [{ link: null, text: 'Plan this work again to have AIWorks rebuild and check it; nothing starts until you approve the plan. If it is not needed, leave it unmerged.' }] });
        continue;
      }
      if (gateMerges(task, d)) { gateHandles(task, false); continue; }
      const waitingOn = c.tasks.filter((other) => other.state !== 'done' && other.dependsOn.includes(task.id));
      // A step starts from the base branch as it is at its first run and keeps that base (its worktree is created
      // once), so only steps that have not started yet can build on the merge.
      const notStarted = (other) => other.state === 'pending' && !other.attempts;
      const pending = waitingOn.filter(notStarted), started = waitingOn.filter((other) => !notStarted(other));
      // Steps declared to require merged dependencies cannot start at all until the owner merges.
      const gated = pending.filter((other) => other.requiresMergedDependencies);
      const churn = task.attempts >= CHURN_ATTEMPTS || task.verifierRejections > 0;
      const evidence = reviewEvidence(task);
      items.push({ ...base, taskId: task.id, kind: 'review', action: 'Review this result', text: label(task),
        why: !task.verifiedSha ? 'AIWorks published it, but no independent check of it is recorded here, so it cannot be accepted here. It waits for your review.'
          : stopped ? stoppedWords
          : !task.checkPassed ? `${evidence.text} Review it before you accept it or request changes.`
          : d.local ? 'It passed the independent check on this computer. Review it here; AIWorks is not allowed to finish integrating results in this project.'
            : 'It passed the independent check. Accept it to approve exactly this version, or request changes to send it back.',
        route: reviewEntry(c, task) ? reviewRoute(task) : d.route ?? stepRoute(task), reference: reference(d),
        evidence: evidence.short, detail: evidence.text, mergeCheck: d.asOf,
        points: [
          // Why the merge cannot be seen at all on this computer, when that is the case.
          ['no-checkout', 'no-verified-sha'].includes(d.reason) ? `${d.note}.` : null,
          churn ? NEEDS.churn(task.attempts, task.verifierRejections) : null,
          gated.length ? NEEDS.gated(named(gated)) : pending.length ? NEEDS.buildsOn(named(pending))
            : started.length ? NEEDS.startedWithout(named(started), started.length) : null,
        ].filter(Boolean).map((text) => ({ link: null, text })) });
    }
    // Delegated merges (#139). Time alone never makes one the owner's: what it means comes from who merges and why the
    // gate holds it. AIWorks's routine waits are its own work (`handling`, listed, not counted); a problem AIWorks cannot
    // settle by itself is listed under AIWorks itself, never as an owner chore; only a merge left to someone else that
    // waited past `stallHours` is the owner's, because AIWorks may not merge it. A hold the owner set stays in Results.
    for (const { task, delivery: d } of by('delegated').filter((step) => !step.delivery.held)) {
      const settled = ownerSettled(base, task);
      if (settled) { handling.push(settled); continue; }
      const words = mergeWaitWords(d.merger, d.wait);
      if (d.merger === 'aiworks' && words.routine) {
        if (d.stalled || d.wait) handling.push({ ...base, taskId: task.id, text: label(task), reason: words.reason, next: words.next, since: task.verifiedAt ?? null, sinceWords: checkedWords(task), recorded: Boolean(d.wait) });
      } else if (d.merger === 'aiworks') {
        items.push({ ...base, repository: null, about: c.repository, taskId: task.id, kind: 'merge-problem', system: true, action: 'AIWorks cannot finish this by itself',
          text: label(task), why: `${words.reason}. ${words.next}`, route: stepRoute(task), reference: reference(d),
          points: [{ link: null, text: 'Not an investigation for you: AIWorks keeps what it recorded for its maintainers. If this result should not continue, stop this work from its project.' }] });
      } else if (d.stalled && task.review?.state === 'accepted') {
        items.push(acceptedItem(task, d));
      } else if (d.stalled) {
        const evidence = reviewEvidence(task);
        items.push({ ...base, taskId: task.id, kind: 'merge-overdue', action: DELEGATED.overdue.action, text: label(task), why: DELEGATED.overdue.why(d.stalled, task.checkPassed === true),
          route: reviewRoute(task), reference: reference(d), evidence: evidence.short, detail: evidence.text, mergeCheck: d.asOf,
          points: [{ link: null, text: 'Accept approves exactly this version for whoever merges in this project. Request changes sends it back as a repair round within the approved plan.' }] });
      }
    }
    // A finished step whose result AIWorks did not record is AIWorks's own record problem, never an owner chore on GitHub.
    for (const { task } of unknown.filter((step) => !reviews.has(`${c.id}/${step.task.id}`))) {
      items.push({ ...base, repository: null, about: c.repository, taskId: task.id, kind: 'unrecorded', system: true, action: 'Result not recorded', text: label(task),
        why: 'This step finished, but AIWorks did not record where its result went, so it cannot say where it stands. Nothing of it is counted as merged.',
        route: stepRoute(task), mergeCheck: null, points: [] });
    }
    // A cancelled campaign's stops are history: no answer or recheck resumes it, so they are no owner item. Its open
    // pull requests above still are, because a published result can still be merged.
    const cancelled = c.control === 'cancelled';
    if (c.blocker && !cancelled) {
      // What happened and what to do in owner words; what the supervisor recorded stays in its records. The card carries
      // the Check again its sentence names, while the work takes it: a Needs you card has no More menu (review 5 G8).
      const check = (c.controls?.more ?? []).includes('recheck') ? blockerCheck(c.blocker, c.id) : null;
      const words = blockerWords(c.blocker, { check: Boolean(check) });
      items.push({ ...base, kind: c.blockerClass === 'B3' ? 'decision' : 'stopped', text: NEEDS.workStopped, command: check,
        points: [{ link: null, text: `${words.reason}. What to do: ${words.action}.` }] });
    }
    for (const task of cancelled ? [] : c.tasks.filter((item) => item.blocked && item.state !== 'done')) {
      // An answered decision has left the owner's queue: it waits for AIWorks to resume the step with the answer.
      const settled = task.decision?.answered ? ownerSettled(base, task) : null;
      if (settled) { handling.push(settled); continue; }
      // A decision (WP2) is answered on its card or its step, snoozed or marked as not needing the owner. A step that
      // stopped for good takes the owner's guidance and Check again on its card: one more try within the same plan.
      const decision = task.blocked === 'B3' || Boolean(task.decision);
      items.push({ ...base, taskId: task.id, kind: decision ? 'decision' : 'stopped', action: decision ? 'Decision needed' : 'Stopped; will not retry by itself',
        text: label(task), why: decision ? 'An AI worker stopped this step for your decision. The step waits for your answer.'
          : 'It will not retry by itself. Your guidance with Check again gives it one more try within the approved plan; a wider change is new work to plan.',
        route: stepRoute(task),
        ...(task.decision?.snoozedUntil ? { snoozedUntil: task.decision.snoozedUntil } : {}),
        points: [{ link: null, text: `${task.blockedReason.charAt(0).toUpperCase()}${task.blockedReason.slice(1)}.` },
          ...(task.decision?.snoozedUntil ? [{ link: null, text: NEEDS.snoozed(task.decision.snoozedUntil) }] : [])] });
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
  // Releases whose outcome is unknown, or whose rollback failed (AUTO_RELEASE.md sections 8 and 9, slice UI15). Every
  // unknown one is listed, not only those past their check window: the dashboard reads no grant to know the window.
  for (const r of (supervisor.releases ?? []).filter((item) => ['unknown', 'rollback-failed'].includes(item.state))) {
    const c = supervisor.campaigns.find((item) => item.id === r.campaignId);
    const where = `${r.verifiedSha ? 'the checked version' : 'an unknown version'} to ${[r.project, r.destination].filter(Boolean).join(' ') || 'an unknown destination'}`;
    items.push(r.state === 'unknown'
      ? { campaignId: c ? r.campaignId : null, repository: c?.repository ?? null, kind: 'release-unknown', action: 'Release outcome unknown',
        text: `Release of ${where}: outcome unknown`, since: r.stepStartedAt ?? r.updatedAt,
        points: [{ link: null, text: 'AIWorks is checking the destination and will not release there again until it knows. Stop all releases still works.' }] }
      : { campaignId: c ? r.campaignId : null, repository: c?.repository ?? null, kind: 'release-failed', action: 'Rollback failed',
        text: `Release of ${where}: the rollback failed`, at: r.updatedAt,
        points: [{ link: null, text: 'The destination may not be working. AIWorks will not release there again until you check it.' }] });
  }
  // The open decisions of the local work list (UI20), each opened on its own work list screen.
  for (const decision of workList?.decisions ?? []) {
    items.push({ campaignId: supervisor.campaigns.some((c) => c.id === decision.campaignId) ? decision.campaignId : null, repository: workList.repository ?? null,
      kind: 'decision', action: 'Decision needed', text: `#${decision.number} ${decision.title}`, route: { label: 'Open in the work list', address: `#/worklist/${decision.number}` },
      points: [] });
  }
  // The open decisions of projects without GitHub (work.mjs workView `local`): each is answered on its project's Overview
  // with the same card as a step's, and listed under that project, never under AIWorks itself.
  for (const record of connected.filter((item) => item.source_kind !== 'github')) {
    for (const c of (localWork[record.id] ?? []).filter((plan) => ['registered', 'paused'].includes(plan.control))) {
      for (const step of c.steps.filter((item) => item.decision && !item.decision.answered)) {
        items.push({ campaignId: null, repository: null, project: record.id, projectName: record.name, kind: 'decision', action: 'Decision needed',
          text: step.title, local: { project: record.id, campaignId: c.id, taskId: step.id },
          why: 'An AI worker stopped this step for your decision. The step waits for your answer.', route: { label: 'Open the project', address: { screen: 'project', project: record.id, tab: 'overview' } },
          ...(step.decision.snoozedUntil ? { snoozedUntil: step.decision.snoozedUntil } : {}),
          points: [{ link: null, text: NEEDS.localDecision(c.outcome) },
            ...(step.decision.snoozedUntil ? [{ link: null, text: NEEDS.snoozed(step.decision.snoozedUntil) }] : [])] });
      }
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
      points: [{ link: null, text: `${waiting ? `${plural(waiting, 'message')} waiting. ` : ''}Not yours to fix: the AIWorks configuration file on this computer needs a fix by whoever maintains AIWorks.` }] });
  }
  const answered = (coordinator?.messages ?? []).filter((m) => m.state === 'answered' && (m.replyBody || m.replyUrl)).sort((a, b) => b.answeredAt - a.answeredAt)[0];
  // Calm only about what blocks on the owner; reports and releases are said apart, never as "nothing". Items that say
  // they are not owner actions (a supervisor fault, an unreadable inbox) are listed but not counted (review F17).
  // A snoozed decision still holds its step, so it stays listed and counted, after everything else.
  items.sort((a, b) => Boolean(a.snoozedUntil) - Boolean(b.snoozedUntil));
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
  return { available: true, headline, count, items, handling, groups: needsGroups(items), held, unknownResults, also: alsoForYou(supervisor, campaigns, releases), layout, campaigns,
    results: resultsByProject(supervisor, campaigns, releases, reviews, workList?.repository ?? null, readReports), noResults, recent: recentSummary(supervisor, campaigns), reply: answered ? { messageId: answered.id, threadId: answered.threadId ?? answered.id, answeredAt: answered.answeredAt, url: answered.replyBody ? null : answered.replyUrl } : null };
}

/**
 * The one Needs you item for AIWorks stopped on this computer (OWNER_WORKSPACE §7.2), listed under AIWorks itself: when
 * it last checked in and how to restart it. With one piece of work held up it is worded for that work and names it
 * (`about`, `campaignId`); with several, one line per project names the work it holds up and what a pause or a
 * still-working AI worker means for it.
 */
function stoppedItem(halted, entries, onPurpose) {
  // The Needs you banner is not shown with this item, so it says here whether AIWorks was stopped on purpose (one fact, once).
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
 * Connected projects held up by the owner's decision (aiworks#11 review 5 G7): a project without GitHub, connected and
 * checked, where work cannot start until the owner confirms its rules on its Now screen (D2; OWNER_WORKSPACE §5.3). No work is blocked there, so they are no Needs you items and no count includes them, but Needs
 * me names each and links to its Now, which says what the decisions are. A setup problem is not here: Projects and the
 * project's Now say it (§4.2).
 */
function heldProjects(records) {
  return (records ?? []).filter((record) => record && record.source_kind !== 'github' && record.status === 'ready' && record.capabilities?.startWork?.allowed !== true &&
    rulesSummary(record.overlay ?? null).state !== 'confirmed')
    .map((record) => ({ id: record.id, name: record.name, text: NEEDS.held.row }));
}

export const SYSTEM_GROUP = 'AIWorks itself';

/**
 * Needs you (OWNER_WORKSPACE slice S3): the same items, grouped by project. One group per repository (case-insensitive,
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
    if (item.system || !item.repository && !item.project) { system.push(item); continue; }
    // A project without GitHub is grouped by its id and named by its own name.
    const key = item.repository ? item.repository.toLowerCase() : `local-${item.project}`;
    if (!groups.has(key)) groups.set(key, { key, project: item.repository ?? item.project, name: item.repository ? short(item.repository) : item.projectName, items: [] });
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
    if (d?.state === 'merged' && d.mergedAt >= recent.since) merged.push({ campaignId: c.id, taskId: task.id, number: d.number, url: d.url, route: d.route ?? null, at: d.mergedAt });
    if (d?.state === 'published' && recent.published.some((p) => p.campaignId === c.id && p.taskId === task.id)) {
      waiting.push({ campaignId: c.id, taskId: task.id, number: d.number, url: d.url, route: d.route ?? null });
    }
  }
  // Agent runs and the supervisor's own problems are counted apart: a failing supervisor step is journaled on every tick.
  const kind = (...kinds) => recent.failures.filter((f) => kinds.includes(f.kind)).length;
  // Passed: published steps whose check passed every criterion; the others finished with their check not complete.
  const passed = recent.published.filter((p) => supervisor.campaigns.find((c) => c.id === p.campaignId)?.tasks.find((task) => task.id === p.taskId)?.checkPassed === true);
  return { since: recent.since, merged, delivered: recent.published, passed, waiting,
    failures: kind('failed-run', 'rejected'), rejected: kind('rejected'), supervisorErrors: kind('step-error'), livenessProblems: kind('liveness-defect') };
}
