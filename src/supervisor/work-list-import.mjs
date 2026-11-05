// The one-time import of a repository's open GitHub issues into the local work list (docs/design/LOCAL_OPERATION.md
// section 5.4, slice SELF10). Read-only towards GitHub: every call is a REST GET, page by page (never GraphQL, never a
// write). A dry run, the default, reads GitHub and the store and writes nothing. An imported item keeps its issue number,
// its source URL and the issue's `updated_at`; each comment keeps its author login and time and is recorded once under
// the GitHub comment id. A re-run adds only new comments and reports changed titles and bodies: it never overwrites an
// item, so the owner's work stays. Secret-like text is withheld and listed by number and comment id, never echoed.
//
// Closing the imported issues on GitHub (slice SELF11, closeConfirmedIssues below) is built switched off: it is a GitHub
// write outside a campaign, so it waits for the owner's typed confirmation in the dashboard (UI20) and the amended AW-001
// (SELF12), and nothing calls it before then.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeIssue, marker, postComment, rest } from './adapters/github.mjs';
import { containsSecret } from './coordinator.mjs';
import { OWNER_CALLER } from './local-admission.mjs';
import { addComment, comments, createItem, item, items, raiseNumberFloor } from './work-list.mjs';

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const PER_PAGE = 100;
// At most 100 pages (10,000 entries) of one list: a larger answer is refused rather than read without bound.
const MAX_PAGES = 100;
const MAX_LABELS = 50;
const MAX_LABEL = 50;
export const commentKey = (id) => `github-comment:${id}`;

export class WorkListImportError extends Error {
  constructor(code, message) { super(message); this.name = 'WorkListImportError'; this.code = code; }
}

/** Every entry of one paginated REST list, read with GET only. */
function pages(gh, what, path, fields = {}) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = Object.entries({ ...fields, per_page: PER_PAGE, page }).flatMap(([key, value]) => ['-f', `${key}=${value}`]);
    const list = rest(gh, `GET ${what}`, ['--method', 'GET', path, ...query]);
    if (!Array.isArray(list)) throw new WorkListImportError('WORK_IMPORT_UNEXPECTED', `GET ${what} did not answer with a list`);
    all.push(...list);
    if (list.length < PER_PAGE) return all;
  }
  throw new WorkListImportError('WORK_IMPORT_TOO_LARGE', `GET ${what} has more than ${MAX_PAGES} pages`);
}

const issueNumber = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
const time = (value) => { const at = Date.parse(value ?? ''); return Number.isFinite(at) && at >= 0 ? at : null; };
const labelsOf = (issue) => (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label?.name))
  .filter((name) => typeof name === 'string' && name.trim() && name.length <= MAX_LABEL && !containsSecret(name)).slice(0, MAX_LABELS);

/**
 * Import the open issues of `repository` into the work list of `store`. `dryRun` (the default) writes nothing; `store`
 * may then be null (no store yet) or read-only. Returns counts and lists of numbers only, never issue or comment text.
 */
export function importIssues({ store, gh = ['gh'], repository, dryRun = true, now = Date.now() }) {
  if (!REPOSITORY.test(String(repository ?? ''))) throw new WorkListImportError('WORK_IMPORT_INVALID', 'the repository must be owner/name');
  if (!dryRun && !store) throw new WorkListImportError('WORK_IMPORT_INVALID', 'an import that writes needs the store');
  const repo = repository.toLowerCase();
  const open = pages(gh, 'issues', `repos/${repo}/issues`, { state: 'open' });
  // The newest issue or pull request in any state: a new local item must never take a number GitHub already used.
  const newest = rest(gh, 'GET issues', ['--method', 'GET', `repos/${repo}/issues`, '-f', 'state=all', '-f', 'sort=created',
    '-f', 'direction=desc', '-f', 'per_page=1']);
  const highest = Math.max(0, ...[...open, ...(Array.isArray(newest) ? newest : [])].map((entry) => issueNumber(entry?.number) ?? 0));
  const report = { repository: repo, dryRun, highestNumber: highest, pullRequestsSkipped: 0, issues: 0,
    items: { new: [], existing: [] }, comments: { new: 0, existing: 0 }, changed: [], conflicts: [], withheld: [] };
  if (!dryRun) raiseNumberFloor(store, highest);

  for (const issue of open) {
    if (issue?.pull_request) { report.pullRequestsSkipped++; continue; }
    const number = issueNumber(issue?.number);
    const url = String(issue?.html_url ?? '');
    if (!number || !url) { report.conflicts.push({ number, reason: 'GitHub returned an issue without a number or URL' }); continue; }
    report.issues++;
    const title = String(issue.title ?? '');
    const body = String(issue.body ?? '');
    if (containsSecret(title) || containsSecret(body)) { report.withheld.push({ number }); continue; }
    const existing = store ? item(store, number) : null;
    if (existing && (existing.author_kind !== 'import' || String(existing.source_url ?? '').toLowerCase() !== url.toLowerCase())) {
      // Another item holds this number (the owner's, the supervisor's or one imported from elsewhere): left as it is.
      report.conflicts.push({ number, reason: `work item #${number} is not the import of this issue` });
      continue;
    }
    if (existing) {
      report.items.existing.push(number);
      const fields = [...(existing.title !== title ? ['title'] : []), ...(existing.body !== body ? ['body'] : [])];
      if (fields.length) report.changed.push({ number, fields, updatedAt: issue.updated_at ?? null });
    } else {
      report.items.new.push(number);
      if (!dryRun) {
        createItem(store, { number, kind: 'task', title, body, labels: labelsOf(issue), authorKind: 'import',
          source: { url, updatedAt: issue.updated_at ?? null }, now });
      }
    }

    const recorded = new Set(existing ? comments(store, number).map((comment) => comment.idempotency_key) : []);
    for (const comment of pages(gh, `issue #${number} comments`, `repos/${repo}/issues/${number}/comments`)) {
      const key = commentKey(comment?.id);
      if (recorded.has(key)) { report.comments.existing++; continue; }
      const text = String(comment?.body ?? '');
      if (!Number.isSafeInteger(comment?.id) || !text.trim()) continue;
      const author = typeof comment.user?.login === 'string' && !containsSecret(comment.user.login) ? comment.user.login : null;
      if (containsSecret(text)) { report.withheld.push({ number, comment: comment.id }); continue; }
      if (!dryRun) {
        const added = addComment(store, { number, idempotencyKey: key, body: text, authorKind: 'import', author,
          createdAt: time(comment.created_at) ?? now, now });
        if (!added.created) { report.comments.existing++; continue; }
      }
      report.comments.new++;
    }
  }
  return report;
}

/** Closing imported issues on GitHub stays off until UI20 (the owner's typed confirmation) and SELF12 (amended AW-001). */
export const CLOSE_IMPORTED_ON = false;
// At most this many issues in one confirmed list: a larger list is refused rather than walked without bound.
const MAX_SELECTION = 1000;
export const pointerKey = (number) => `work-list-moved:${number}`;
const issueUrl = (repository, number) => `https://github.com/${repository}/issues/${number}`;

// Created on the first confirmed close, because this slice does not own store.mjs. Additive: a store that never closed
// an issue has no such table and behaves exactly as before. One row per issue, written before its pointer is posted, so
// a retry after a crash knows a pointer may exist and reconciles from GitHub instead of posting it again.
const DDL = `CREATE TABLE IF NOT EXISTS work_list_closures (
  repository TEXT NOT NULL, number INTEGER NOT NULL, imported_updated_at TEXT NOT NULL, state TEXT NOT NULL,
  comment_url TEXT, recorded_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (repository, number))`;
const hasClosures = (store) => Boolean(store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'work_list_closures'"));
const closure = (store, repository, number) => (hasClosures(store)
  ? store.get('SELECT * FROM work_list_closures WHERE repository = ? AND number = ?', repository, number) : null);
const setClosure = (store, repository, number, changes, now) => store.run(
  `UPDATE work_list_closures SET ${Object.keys(changes).map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE repository = ? AND number = ?`,
  ...Object.values(changes), now, repository, number);

/** The version of a stored imported item: any change to it after the owner saw the list makes a selection stale. */
export const itemVersion = (found) => createHash('sha256').update(JSON.stringify([found.number, found.source_url,
  found.source_updated_at, found.title, found.body, found.state, found.updated_at]), 'utf8').digest('hex');

/**
 * The list the owner confirms: every item imported from `repository` whose issue this flow has not closed, each as the
 * selection entry that binds it: { repository, number, updatedAt (the issue's `updated_at` at import), version }.
 */
export function closeCandidates(store, repository) {
  const repo = String(repository ?? '').toLowerCase();
  return items(store).filter((entry) => entry.author_kind === 'import').map((entry) => item(store, entry.number))
    .filter((found) => String(found.source_url ?? '').toLowerCase() === issueUrl(repo, found.number) && found.source_updated_at
      && closure(store, repo, found.number)?.state !== 'closed')
    .sort((a, b) => a.number - b.number)
    .map((found) => ({ repository: repo, number: found.number, updatedAt: found.source_updated_at, version: itemVersion(found) }));
}

/** The caller check's answer, read as Apply reads it: no check, a throw or any other answer refuses. */
async function ownerCaller(store, caller) {
  let answer = null;
  let code = null;
  try { answer = typeof caller === 'function' ? await caller(store) : null; } catch (error) { code = error?.code ?? null; }
  if (code === 'APPROVAL_FROM_AIWORKS') throw new WorkListImportError('WORK_CLOSE_FROM_AIWORKS', 'this close came from a program AIWorks started, not from you, so nothing was written or sent');
  if (answer !== OWNER_CALLER) throw new WorkListImportError('WORK_CLOSE_UNCHECKED', 'AIWorks could not check that this close came from you, so nothing was written or sent');
}

/** Every entry must still name exactly the stored import it was shown for; otherwise the whole list is refused. */
function checkSelection(store, repo, selection) {
  const stale = (number, why) => { throw new WorkListImportError('WORK_CLOSE_STALE', `the confirmed list is out of date (#${number}: ${why}); nothing was sent. Confirm the list again`); };
  if (!Array.isArray(selection) || !selection.length || selection.length > MAX_SELECTION) {
    throw new WorkListImportError('WORK_CLOSE_INVALID', `the confirmed list must name 1 to ${MAX_SELECTION} issues`);
  }
  const seen = new Set();
  return selection.map((entry) => {
    const number = issueNumber(entry?.number);
    if (!number || seen.has(number)) throw new WorkListImportError('WORK_CLOSE_INVALID', 'the confirmed list names an issue twice or without a number');
    seen.add(number);
    if (String(entry.repository ?? '').toLowerCase() !== repo) stale(number, 'another repository');
    const found = item(store, number);
    if (!found || found.author_kind !== 'import' || String(found.source_url ?? '').toLowerCase() !== issueUrl(repo, number)) stale(number, 'not an issue imported from this repository');
    if (!found.source_updated_at || found.source_updated_at !== entry.updatedAt) stale(number, 'imported at another time');
    if (itemVersion(found) !== entry.version) stale(number, 'the work item changed');
    return { number, importedAt: found.source_updated_at };
  });
}

/**
 * Close the imported issues the owner confirmed (docs/design/LOCAL_OPERATION.md section 5.4, slice SELF11). `selection`
 * is the list the owner confirmed, as closeCandidates gave it; `caller(store)` is the dashboard route's caller check
 * (local-admission.mjs checkCaller). Off until CLOSE_IMPORTED_ON; `available` is for tests only.
 *
 * The caller check runs first, then every entry is checked against the store: a stale or foreign entry refuses the whole
 * list before any write. For each issue, in order: an issue that changed on GitHub since the import is skipped and
 * reported; otherwise its closure is recorded, one marked pointer comment is posted, and the issue is closed as
 * `not_planned`. Labels and every issue outside the list are never touched. A retry after a crash finds the recorded
 * closure and the marked comment and closes without commenting again, unless the issue changed after the pointer.
 */
export async function closeConfirmedIssues({ store, gh = ['gh'], repository, selection, caller, terms = [], now = Date.now(),
  available = CLOSE_IMPORTED_ON }) {
  if (!available) throw new WorkListImportError('WORK_CLOSE_OFF', 'closing imported issues on GitHub is not switched on');
  if (!REPOSITORY.test(String(repository ?? ''))) throw new WorkListImportError('WORK_IMPORT_INVALID', 'the repository must be owner/name');
  if (!store) throw new WorkListImportError('WORK_IMPORT_INVALID', 'closing imported issues needs the store');
  await ownerCaller(store, caller);
  const repo = repository.toLowerCase();
  const confirmed = checkSelection(store, repo, selection);
  store.db.exec(DDL);
  const report = { repository: repo, closed: [], alreadyClosed: [], skipped: [] };
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-close-'));
  try {
    for (const { number, importedAt } of confirmed) {
      const recorded = closure(store, repo, number);
      if (recorded?.state === 'closed') { report.alreadyClosed.push(number); continue; }
      const skip = (reason) => { report.skipped.push({ number, reason }); };
      const live = rest(gh, `GET issue #${number}`, ['--method', 'GET', `repos/${repo}/issues/${number}`]);
      if (live?.number !== number || live.pull_request) { skip('GitHub no longer answers with this issue'); continue; }
      const unchanged = live.state === 'open' && live.updated_at === importedAt;
      let pointer = null;
      if (recorded) {
        // A pointer may have been posted before a crash: GitHub's comments are the record of it.
        pointer = pages(gh, `issue #${number} comments`, `repos/${repo}/issues/${number}/comments`)
          .find((comment) => String(comment?.body ?? '').includes(marker(pointerKey(number)))) ?? null;
      } else {
        if (!unchanged) { skip('the issue changed on GitHub since the import'); continue; }
        store.run(`INSERT INTO work_list_closures (repository, number, imported_updated_at, state, recorded_at, updated_at)
          VALUES (?, ?, ?, 'pointing', ?, ?)`, repo, number, importedAt, now, now);
      }
      if (pointer) {
        if (live.state === 'closed') {
          // The close landed before the crash; anything else closed it otherwise and is left as it is.
          if (live.state_reason !== 'not_planned') { skip('the issue was closed on GitHub by someone else'); continue; }
          setClosure(store, repo, number, { state: 'closed', comment_url: pointer.html_url ?? null }, now);
          report.alreadyClosed.push(number);
          continue;
        }
        // Unchanged since the pointer: GitHub's last change to the issue is the pointer itself.
        if (!(Date.parse(live.updated_at) <= Date.parse(pointer.updated_at ?? pointer.created_at))) {
          skip('the issue changed on GitHub after the pointer');
          continue;
        }
      } else {
        if (!unchanged) { skip('the issue changed on GitHub since the import'); continue; }
        const date = new Date(now).toISOString().slice(0, 10);
        const url = postComment({ gh, repository: repo, issue: number, bodyFile: join(dir, `pointer-${number}.md`), terms,
          body: `${marker(pointerKey(number))}\nMoved to the AIWorks local work list as #${number} on ${date}. Continue there.` });
        setClosure(store, repo, number, { state: 'pointed', comment_url: url }, now);
      }
      closeIssue({ gh, repository: repo, issue: number });
      setClosure(store, repo, number, { state: 'closed' }, now);
      report.closed.push(number);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return report;
}
