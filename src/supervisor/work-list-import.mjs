// The one-time import of a repository's open GitHub issues into the local work list (docs/design/LOCAL_OPERATION.md
// section 5.4, slice SELF10). Read-only towards GitHub: every call is a REST GET, page by page (never GraphQL, never a
// write). A dry run, the default, reads GitHub and the store and writes nothing. An imported item keeps its issue number,
// its source URL and the issue's `updated_at`; each comment keeps its author login and time and is recorded once under
// the GitHub comment id. A re-run adds only new comments and reports changed titles and bodies: it never overwrites an
// item, so the owner's work stays. Secret-like text is withheld and listed by number and comment id, never echoed.
import { rest } from './adapters/github.mjs';
import { containsSecret } from './coordinator.mjs';
import { addComment, comments, createItem, item, raiseNumberFloor } from './work-list.mjs';

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
