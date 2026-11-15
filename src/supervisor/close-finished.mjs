// Closing finished work (owner request 2026-11-15). Built switched off: nothing here runs unless config.json says
// "closeFinished": { "enabled": true }; absent or any other value is off, as for cleanup.
//
// Two things are closed, each at most once per integrationPollMs pass:
// - The source of a finished campaign whose declaration says `target.closeWhenDone: true` (intake sets it for a request
//   made from an issue): once every task is done (each commit task merged into the trusted main or recorded merged, each
//   report posted; none ended not done or delivered with known defects) and no other unfinished campaign names that issue,
//   AIWorks comments what was merged and closes the tracking issue as completed, or, for its own repository with local main
//   trusted, comments on and closes that work-list item. A tracking issue alone never closes: it may be a shared roadmap.
// - Pull requests AIWorks itself opened that will never merge: of a cancelled campaign, of a step that ended not done, or
//   whose verified head is already in the base. One comment says why; no branch is ever deleted. A PR whose branch is not
//   the task's own `campaign/<campaign>/<task>`, whose head is not one AIWorks published, or whose task has an open
//   operation is left as it is.
// Every GitHub write is a marked comment and one REST PATCH, and only while `github.comments` is not false. Each close is
// journaled before (`source-close-started`, `pr-close-started`) and after (`source-closed`, `pr-closed`); one started but
// never finished is settled from the state GitHub reports and never repeated blindly.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as gitA from './adapters/git.mjs';
import * as github from './adapters/github.mjs';
import { isLocalTarget } from './local-candidates.mjs';
import { ACCEPT_TASK, PLAN_TASK, specsOf } from './plan.mjs';
import { addComment, item as workItem, setItemState, workLink, WorkListError } from './work-list.mjs';

const SHA = /^[0-9a-f]{40}$/;
const OPEN = ['recorded', 'dispatched'];
// A close that failed (GitHub refused it, a rate limit) is tried again on a later pass, at most this many times in all.
const MAX_ATTEMPTS = 3;
// Outcomes after which nothing more is done for that source or pull request.
const SETTLED = ['closed', 'already-closed', 'merged', 'not-ours', 'not-an-issue', 'no-item'];

export const closeFinishedEnabled = (config) => config?.closeFinished?.enabled === true;

// Per controller: when the last pass ran, and which kept pull requests were already logged.
const memory = new WeakMap();

/**
 * One pass, at most once per integrationPollMs. Returns { sources, pulls } (what was closed), or null when it did not run:
 * switched off, unmerged runtime code (AW-005), or not yet due.
 */
export async function closeFinishedPass(ctl) {
  if (!closeFinishedEnabled(ctl.config) || ctl.unmergedRevision()) return null;
  const state = memory.get(ctl) ?? { checkedAt: -Infinity, reported: new Set() };
  memory.set(ctl, state);
  const now = ctl.now();
  if (state.checkedAt + ctl.config.integrationPollMs > now) return null;
  state.checkedAt = now;
  const report = { sources: [], pulls: [] }, bases = new Map();
  for (const { id } of ctl.store.all("SELECT id FROM campaigns WHERE control IN ('finished', 'cancelled') ORDER BY created_at")) {
    const c = ctl.store.campaign(id);
    if (isLocalTarget(c.declaration) || foreignLease(ctl, id)) continue;
    try { await closeSource(ctl, c, bases, report); } catch (error) { ctl.log(`closing the source of ${id} failed: ${error.message}`); }
    try { await closePulls(ctl, c, bases, report, state); } catch (error) { ctl.log(`closing pull requests of ${id} failed: ${error.message}`); }
  }
  if (report.sources.length || report.pulls.length) ctl.log(`closed ${report.sources.length} finished sources and ${report.pulls.length} pull requests`);
  return report;
}

/** A live lease held by another supervisor instance: that instance may be working on it, so nothing is touched. */
function foreignLease(ctl, id) {
  const lease = ctl.store.lease(id);
  return Boolean(lease && lease.instance_id !== ctl.instanceId && lease.expires_at > ctl.now());
}

/** The campaign's lease, acquired or renewed for a write; null while another instance holds it. */
function lease(ctl, id) {
  const held = ctl.store.acquireLease(id, ctl.instanceId, ctl.now(), ctl.config.leaseMs, ctl.codeRevision);
  if (!held) { ctl.held.delete(id); return null; }
  ctl.held.set(id, held.generation);
  return { id, generation: held.generation };
}

/** GitHub writes are allowed: the installation did not switch GitHub comments off. */
const commentsOn = (ctl) => ctl.config.github?.comments !== false;

/** The close records of one campaign for one subject: { open, settled, attempts }, by `match(detail)`. */
function records(ctl, id, started, finished, match) {
  const begun = ctl.store.all('SELECT seq, detail FROM journal WHERE campaign_id = ? AND kind = ? ORDER BY seq', id, started).filter((row) => match(row.detail));
  const ended = ctl.store.all('SELECT detail FROM journal WHERE campaign_id = ? AND kind = ? ORDER BY seq', id, finished).map((row) => row.detail).filter(match);
  const closedSeqs = new Set(ended.map((detail) => detail?.started).filter(Number.isInteger));
  return { open: begun.find((row) => !closedSeqs.has(row.seq)) ?? null, settled: ended.some((detail) => SETTLED.includes(detail?.outcome)), attempts: begun.length };
}

/** The base branch as last fetched (the trusted tip of local main when self-hosted), once per pass: { path, sha } or null. */
async function baseOf(ctl, decl, bases) {
  const repo = ctl.checkout(decl);
  if (!repo?.path) return null;
  const key = `${repo.path}\n${decl.target.baseBranch}`;
  if (!bases.has(key)) bases.set(key, (await ctl.fetchBase(repo.path, decl.target.baseBranch, decl.target.repository)).sha ?? null);
  return { path: repo.path, sha: bases.get(key) };
}
const contains = (ctl, base, sha) => SHA.test(sha ?? '') && SHA.test(base?.sha ?? '') &&
  gitA.isAncestor({ git: ctl.cmd.git, path: base.path, ancestor: sha, descendant: base.sha });

// ---- The source of finished work. ----

async function closeSource(ctl, c, bases, report) {
  const decl = c.declaration, { repository, trackingIssue: issue } = decl.target;
  if (decl.target.closeWhenDone !== true || c.control !== 'finished') return;
  const local = ctl.selfHosted(repository);
  // A campaign that keeps its reports local posts nothing, and with comments off nothing is written to GitHub either.
  if (!local && (!commentsOn(ctl) || decl.reportPublication === 'local')) return;
  const mine = (detail) => detail?.subject === 'source';
  const { open, settled, attempts } = records(ctl, c.id, 'source-close-started', 'source-closed', mine);
  if (settled) return;
  if (open) { if (!local) settleIssue(ctl, c, open); return; }
  if (attempts >= MAX_ATTEMPTS) return;
  const lines = await finishedWork(ctl, c, bases);
  if (!lines || otherHolder(ctl, c)) return;
  const ctx = lease(ctl, c.id);
  if (!ctx) return;
  const body = [`AIWorks finished the work this ${local ? 'item' : 'issue'} asked for (campaign \`${c.id}\`). Every step passed independent verification and is in \`${decl.target.baseBranch}\`:`,
    '', ...lines, '', `AIWorks closes this ${local ? 'item' : 'issue'} as completed. Merged is not deployed: nothing was released or deployed.`].join('\n');
  const closed = local ? closeWorkItem(ctl, ctx, c, issue, body) : closeIssue(ctl, ctx, c, issue, body);
  if (closed) report.sources.push(local ? workLink(issue) : `${repository}#${issue}`);
}

/**
 * The lines naming what a finished campaign delivered, or null unless every task is done: each commit task recorded merged
 * at its verified head or contained in the base, each report posted, none delivered with known defects or ended not done.
 * A child step the plan itself cancelled (WORK_ENVELOPE 6.4) is no step of the outcome and is passed over.
 */
async function finishedWork(ctl, c, bases) {
  const { store } = ctl, decl = c.declaration, tasks = store.tasks(c.id);
  if (!tasks.length || store.openOperations(c.id).length) return null;
  const specs = specsOf(store, c.id, decl);
  const merged = new Map(store.all("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'merged' ORDER BY seq", c.id)
    .map((row) => [`${row.detail?.task}:${row.detail?.sha}`, row.detail]));
  const lines = [];
  let base;
  for (const task of tasks) {
    if (task.state === 'cancelled' && !/^not done:/.test(task.last_error ?? '') && planCancelled(store, c.id, task.task_id)) continue;
    if (task.state !== 'done' || task.blocked || Array.isArray(task.verification?.knownDefects)) return null;
    // The generated planning step and closing check (WORK_ENVELOPE 6.2, 6.6) deliver no change of their own: done is enough.
    if ([PLAN_TASK, ACCEPT_TASK].includes(task.task_id)) {
      if (/^https:\/\//.test(task.pr_url ?? '')) lines.push(`- ${task.task_id}: report ${task.pr_url}`);
      continue;
    }
    const deliverable = specs.get(task.task_id)?.deliverable;
    if (deliverable === 'report') {
      if (!task.pr_url) return null;
      if (/^https:\/\//.test(task.pr_url) || /^aiworks-work:/.test(task.pr_url)) lines.push(`- ${task.task_id}: report ${task.pr_url}`);
      continue;
    }
    if (deliverable !== 'commit' || !SHA.test(task.verified_sha ?? '')) return null;
    const record = merged.get(`${task.task_id}:${task.verified_sha}`);
    if (record) {
      lines.push(`- ${task.task_id}: ${task.pr_url ?? `\`${task.verified_sha}\``}${SHA.test(record.mergeCommit ?? '') ? `, merge commit \`${record.mergeCommit}\`` : ''}`);
      continue;
    }
    base ??= await baseOf(ctl, decl, bases);
    if (!contains(ctl, base, task.verified_sha)) return null;
    lines.push(`- ${task.task_id}: ${task.pr_url ?? 'verified'} at \`${task.verified_sha}\`, contained in \`${decl.target.baseBranch}\``);
  }
  // Settle-time reads awaited: anything that opened meanwhile keeps the source open.
  return lines.length && !store.openOperations(c.id).length ? lines : null;
}

/** Read again under the write lock before a close starts: the campaign is still finished, idle and alone on its issue. */
const stillFinished = (ctl, c) => ctl.store.campaign(c.id)?.control === 'finished' && !ctl.store.openOperations(c.id).length && !otherHolder(ctl, c);

const planCancelled = (store, campaignId, taskId) => Boolean(store.get(`SELECT cancelled_at FROM task_specs WHERE campaign_id = ? AND task_id = ?
  ORDER BY revision DESC LIMIT 1`, campaignId, taskId)?.cancelled_at);

/** Another campaign that is not finished or cancelled names the same issue: as its tracking issue, a task issue or its authorization. */
function otherHolder(ctl, c) {
  const { repository, trackingIssue: issue } = c.declaration.target;
  const references = new Set([`https://github.com/${repository}/issues/${issue}`.toLowerCase(), workLink(issue)]);
  return ctl.store.all("SELECT id, declaration FROM campaigns WHERE control NOT IN ('finished', 'cancelled') AND id <> ?", c.id).some(({ declaration: d }) =>
    String(d?.target?.repository ?? '').toLowerCase() === String(repository).toLowerCase() && (d.target.trackingIssue === issue ||
      (d.tasks ?? []).some((task) => task?.issue === issue) || references.has(String(d.authorization?.reference ?? '').toLowerCase())));
}

/** Comment once (a marked comment) and close the issue as completed, journaled before and after. Returns whether it closed. */
function closeIssue(ctl, ctx, c, issue, text) {
  const decl = c.declaration, repository = decl.target.repository, gh = ctl.cmd.gh;
  let live;
  try { live = github.issueState({ gh, repository, issue }); } catch (error) { ctl.log(`source of ${c.id}: ${repository}#${issue} unread: ${error.message}`); return false; }
  if (live.pullRequest || live.state === 'closed') {
    ctl.fenced(ctx, () => ctl.store.journal(c.id, 'source-closed', { subject: 'source', repository, issue,
      outcome: live.pullRequest ? 'not-an-issue' : 'already-closed' }, ctl.now()));
    return false;
  }
  const key = `${c.id}:source-closed`;
  const started = ctl.fenced(ctx, () => {
    if (!stillFinished(ctl, c) || records(ctl, c.id, 'source-close-started', 'source-closed', (detail) => detail?.subject === 'source').open) return null;
    return ctl.store.journal(c.id, 'source-close-started', { subject: 'source', repository, issue }, ctl.now());
  });
  if (!started) return false;
  const { outcome, comment, reason } = commentAndClose(ctl, decl, { issue, key, body: ctl.publicText(decl, text), reason: 'completed' });
  ctl.fenced(ctx, () => ctl.store.journal(c.id, 'source-closed', { subject: 'source', started, repository, issue, outcome, comment, reason }, ctl.now()));
  return outcome === 'closed';
}

/** After a crash between the two records: settle the started close once from the issue's state; never act on it. */
function settleIssue(ctl, c, open) {
  const { repository, issue } = open.detail;
  let live;
  try { live = github.issueState({ gh: ctl.cmd.gh, repository, issue }); } catch { return; }
  const ctx = lease(ctl, c.id);
  if (!ctx) return;
  ctl.fenced(ctx, () => ctl.store.journal(c.id, 'source-closed', { subject: 'source', started: open.seq, repository, issue,
    outcome: live.state === 'closed' ? 'closed' : 'interrupted', reconciled: true }, ctl.now()));
}

/**
 * The marked comment (found again rather than posted twice) and the one PATCH. `reason` is the state reason, null for a
 * pull request. Returns { outcome: 'closed' | 'failed', comment, reason }.
 */
function commentAndClose(ctl, decl, { issue, key, body, reason }) {
  const repository = decl.target.repository, gh = ctl.cmd.gh;
  try {
    const dir = join(ctl.dataDir, 'runs');
    mkdirSync(dir, { recursive: true });
    const comment = github.findMarkedComment({ gh, repository, issue, key }) ?? github.postComment({ gh, repository, issue,
      body: `${body}\n\n${github.marker(key)}`, bodyFile: join(dir, 'close-finished.md'), terms: ctl.publicationTerms(decl) });
    github.closeIssue({ gh, repository, issue, reason });
    return { outcome: 'closed', comment, reason: null };
  } catch (error) {
    return { outcome: 'failed', comment: null, reason: String(error.message).slice(0, 300) };
  }
}

/** The self-hosted repository: the comment and the close of the work item in one fenced transaction. Returns whether it closed. */
function closeWorkItem(ctl, ctx, c, number, body) {
  return ctl.fenced(ctx, () => {
    const now = ctl.now(), found = workItem(ctl.store, number);
    if (!stillFinished(ctl, c) || records(ctl, c.id, 'source-close-started', 'source-closed', (detail) => detail?.subject === 'source').open) return false;
    if (!found || found.state === 'closed') {
      ctl.store.journal(c.id, 'source-closed', { subject: 'source', item: number, outcome: found ? 'already-closed' : 'no-item' }, now);
      return false;
    }
    const started = ctl.store.journal(c.id, 'source-close-started', { subject: 'source', item: number }, now);
    try {
      const { comment } = addComment(ctl.store, { number, idempotencyKey: `${c.id}:source-closed`, body, authorKind: 'supervisor', now });
      setItemState(ctl.store, { number, state: 'closed', now });
      ctl.store.journal(c.id, 'source-closed', { subject: 'source', started, item: number, outcome: 'closed', comment: `${workLink(number)}#${comment.seq}` }, now);
      return true;
    } catch (error) {
      if (!(error instanceof WorkListError)) throw error;
      ctl.store.journal(c.id, 'source-closed', { subject: 'source', started, item: number, outcome: 'failed', reason: error.code }, now);
      return false;
    }
  });
}

// ---- AIWorks's own pull requests that will never merge. ----

async function closePulls(ctl, c, bases, report, state) {
  const decl = c.declaration, repository = decl.target.repository, { store } = ctl;
  if (ctl.selfHosted(repository) || !commentsOn(ctl)) return;
  const prefix = `https://github.com/${repository}/pull/`;
  const published = store.all("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'published' ORDER BY seq", c.id).map((row) => row.detail);
  for (const task of store.tasks(c.id)) {
    const url = task.pr_url, number = String(url ?? '').startsWith(prefix) ? Number(/^([1-9]\d*)$/.exec(url.slice(prefix.length))?.[1]) : null;
    if (!number) continue;
    // Only a pull request AIWorks opened: published by this task under this URL, at these heads.
    const heads = new Set(published.filter((detail) => detail?.task === task.task_id && detail?.url === url).map((detail) => detail.sha));
    if (!heads.size) continue;
    const mine = (detail) => detail?.subject === 'pull' && detail?.url === url;
    const { open, settled, attempts } = records(ctl, c.id, 'pr-close-started', 'pr-closed', mine);
    if (settled) continue;
    if (open) { settlePull(ctl, c, open); continue; }
    if (attempts >= MAX_ATTEMPTS || openOperation(store, c.id, task.task_id)) continue;
    // Why it will never merge, or null while it still may: a finished campaign's done step waits for its merge.
    const why = c.control === 'cancelled' ? 'cancelled' : task.state !== 'done' ? 'not-done'
      : contains(ctl, await baseOf(ctl, decl, bases), task.verified_sha) ? 'landed' : null;
    if (!why) continue;
    let pr;
    try { pr = github.pullRequest({ gh: ctl.cmd.gh, repository, number }); } catch (error) { ctl.log(`pull request ${url} unread: ${error.message}`); continue; }
    const ctx = lease(ctl, c.id);
    if (!ctx) continue;
    const ours = pr.headRef === gitA.branchName(c.id, task.task_id);
    if (pr.merged || pr.state !== 'open' || !ours) {
      ctl.fenced(ctx, () => ctl.store.journal(c.id, 'pr-closed', { subject: 'pull', task: task.task_id, url,
        outcome: pr.merged ? 'merged' : !ours ? 'not-ours' : 'already-closed' }, ctl.now()));
      continue;
    }
    // Someone else pushed to it: it is no longer only AIWorks's work, so it stays open (said once per head).
    if (!heads.has(pr.headSha)) {
      const seen = `${url}\n${pr.headSha}`;
      if (!state.reported.has(seen)) { state.reported.add(seen); ctl.log(`pull request ${url} kept open: its head ${pr.headSha} is not one AIWorks published`); }
      continue;
    }
    const started = ctl.fenced(ctx, () => {
      if (!['finished', 'cancelled'].includes(store.campaign(c.id)?.control) || openOperation(store, c.id, task.task_id) || records(ctl, c.id, 'pr-close-started', 'pr-closed', mine).open) return null;
      return ctl.store.journal(c.id, 'pr-close-started', { subject: 'pull', task: task.task_id, url, number, why, head: pr.headSha }, ctl.now());
    });
    if (!started) continue;
    const words = why === 'cancelled' ? `campaign \`${c.id}\` was cancelled, so AIWorks will not merge this change`
      : why === 'not-done' ? `step \`${task.task_id}\` of campaign \`${c.id}\` ended without being done, so AIWorks will not merge this change`
        : `campaign \`${c.id}\` is finished and its verified head \`${task.verified_sha}\` is already in \`${decl.target.baseBranch}\`: the change landed through another merge`;
    const body = `AIWorks closes this pull request: ${words}. Nothing was deleted; the branch \`${gitA.branchName(c.id, task.task_id)}\` stays.`;
    const { outcome, comment, reason } = commentAndClose(ctl, decl, { issue: number, key: `${c.id}:${task.task_id}:pr-closed:${number}`, body, reason: null });
    ctl.fenced(ctx, () => ctl.store.journal(c.id, 'pr-closed', { subject: 'pull', started, task: task.task_id, url, outcome, why, comment, reason }, ctl.now()));
    if (outcome === 'closed') report.pulls.push(url);
  }
}

const openOperation = (store, campaignId, taskId) => Boolean(store.get(`SELECT 1 AS v FROM operations WHERE campaign_id = ? AND task_id = ?
  AND state IN (${OPEN.map(() => '?').join(', ')})`, campaignId, taskId, ...OPEN));

/** After a crash between the two records: settle the started close once from the pull request's state; never act on it. */
function settlePull(ctl, c, open) {
  const { url, number, task } = open.detail;
  let pr;
  try { pr = github.pullRequest({ gh: ctl.cmd.gh, repository: c.declaration.target.repository, number }); } catch { return; }
  const ctx = lease(ctl, c.id);
  if (!ctx) return;
  ctl.fenced(ctx, () => ctl.store.journal(c.id, 'pr-closed', { subject: 'pull', started: open.seq, task, url,
    outcome: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'interrupted', reconciled: true }, ctl.now()));
}
