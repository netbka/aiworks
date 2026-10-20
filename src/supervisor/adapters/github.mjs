// AIWorks GitHub adapter through the existing authenticated gh CLI. No GitHub Actions,
// no new identity. Creation calls are preceded by a lookup so a retry after an unknown
// outcome reconciles instead of duplicating (no exactly-once promise).
// Every call is REST (gh api), never GraphQL: the account's GraphQL quota is shared with the
// dashboard and other tools, and a spent quota must not stall publication (AIWorks).
import { writeFileSync } from 'node:fs';
import { exec } from './git.mjs';
import { assertPublishable } from '../../shared/public-text.mjs';

/** GitHub refused a call for a rate limit. `resetAt` (epoch ms) is when it allows calls again, or null if it did not say. */
export class RateLimitError extends Error {
  constructor(message, resetAt) { super(message); this.name = 'RateLimitError'; this.resetAt = resetAt; }
}

/** Split `gh api --include` output into status, lower-cased headers and body. Output without a status line is all body. */
export function parseResponse(stdout) {
  const text = String(stdout ?? '');
  if (!/^HTTP\/\S+ \d{3}/.test(text)) return { status: null, headers: {}, body: text };
  const end = /\r?\n\r?\n/.exec(text);
  const head = end ? text.slice(0, end.index) : text;
  const [statusLine, ...lines] = head.split(/\r?\n/);
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(/ (\d{3})/.exec(statusLine)[1]), headers, body: end ? text.slice(end.index + end[0].length) : '' };
}

/** Reset time (epoch ms) of a rate-limit refusal, null when GitHub gave none, or undefined when it is not one. */
export function rateLimitReset({ status, headers, body }, stderr = '', now = Date.now()) {
  const retryAfter = headers['retry-after'] === undefined ? NaN : Number(headers['retry-after']);
  const limited = status === 429 || ((status === 403 || status === null) &&
    (headers['x-ratelimit-remaining'] === '0' || Number.isFinite(retryAfter) || /rate limit/i.test(`${body} ${stderr}`)));
  if (!limited) return undefined;
  if (Number.isFinite(retryAfter)) return now + retryAfter * 1000;
  const reset = Number(headers['x-ratelimit-reset']);
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
}

/** One REST call; returns the parsed JSON body or throws (RateLimitError for a rate-limit refusal). */
export function rest(gh, what, args, { timeoutMs } = {}) {
  const { method, route } = requestScope(args);
  if (!['GET', 'HEAD'].includes(method)) {
    const repository = /^repos\/([^/]+\/[^/]+)\//.exec(route ?? '')?.[1];
    // Only existing delivery operations may write. No Actions, Codespaces,
    // packages, billing, plan changes, repository settings or resource provisioning.
    const deliveryWrite = method === 'POST' && /^repos\/[^/]+\/[^/]+\/(?:pulls|issues\/[1-9]\d*\/comments)$/.test(route ?? '') ||
      method === 'PATCH' && /^repos\/[^/]+\/[^/]+\/issues\/[1-9]\d*$/.test(route ?? '') ||
      method === 'PUT' && /^repos\/[^/]+\/[^/]+\/pulls\/[1-9]\d*\/merge$/.test(route ?? '');
    if (!repository || !deliveryWrite) {
      throw developmentRefusal('only pull requests, issue comments, issue updates and authorized merges may write to GitHub');
    }
    // Comments, issue updates and merges can trigger workflows too. Check every write,
    // without a cache; a read failure must not become permission to publish.
    assertActionsDisabled({ gh, repository });
  }
  const out = exec(gh, ['api', '--include', ...args], { timeoutMs });
  const response = parseResponse(out.stdout);
  if (!out.ok) {
    const message = `${what} failed: ${out.stderr || out.error || response.body}`.slice(0, 500);
    const resetAt = rateLimitReset(response, out.stderr);
    if (resetAt !== undefined) throw new RateLimitError(message, resetAt);
    const status = response.status ?? Number(/\(HTTP (\d{3})\)/.exec(out.stderr ?? '')?.[1] ?? NaN);
    throw Object.assign(new Error(message), { status: Number.isInteger(status) ? status : null });
  }
  return JSON.parse(response.body || 'null');
}

const developmentRefusal = (message) => Object.assign(new Error(`LOCAL_DEVELOPMENT_ONLY: ${message}`), { code: 'LOCAL_DEVELOPMENT_ONLY' });

// Accept only the CLI syntax used by our delivery adapter. Unknown flags,
// alternate hosts, duplicate methods/endpoints and inline flag spellings must
// not let gh interpret a request differently from the policy check.
function requestScope(args) {
  let method, route, fields = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--method', '-X', '-f', '-F', '--field', '--raw-field'].includes(arg)) {
      const value = args[++index];
      if (typeof value !== 'string' || !value) throw developmentRefusal('invalid GitHub request argument');
      if (arg === '--method' || arg === '-X') {
        if (method || !/^(GET|HEAD|POST|PATCH|PUT|DELETE)$/i.test(value)) throw developmentRefusal('invalid GitHub request method');
        method = value.toUpperCase();
      } else fields = true;
    } else {
      if (route || typeof arg !== 'string' || !/^repos\/[\w.-]+\/[\w.-]+\/[^\s#]+$/.test(arg)) {
        throw developmentRefusal('only explicit repository REST requests are supported');
      }
      route = arg;
    }
  }
  if (!route) throw developmentRefusal('a GitHub request needs one repository endpoint');
  return { method: method ?? (fields ? 'POST' : 'GET'), route };
}

/** No write or push may trigger repository automation. This only reads policy, never changes it. */
export function assertActionsDisabled({ gh, repository }) {
  if (!Array.isArray(gh) || !gh.length || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
    throw developmentRefusal('a GitHub destination and CLI are required to check Actions policy');
  }
  const policy = rest(gh, 'GET Actions permissions', ['--method', 'GET', `repos/${repository}/actions/permissions`], { timeoutMs: 30_000 });
  if (policy?.enabled !== false) throw developmentRefusal('GitHub Actions must be disabled for the destination repository before publication');
}

export function findOpenPullRequest({ gh, repository, branch }) {
  const owner = repository.split('/')[0];
  const list = rest(gh, 'GET pulls', ['--method', 'GET', `repos/${repository}/pulls`,
    '-f', `head=${owner}:${branch}`, '-f', 'state=open']) ?? [];
  const pr = list[0];
  return pr ? { url: pr.html_url, headRefOid: pr.head?.sha ?? null } : null;
}

/** Read-only merge receipt, bound to the exact published PR, reviewed head and base. */
export function integratedPullRequest({ gh, repository, url, headSha, baseBranch }) {
  const prefix = `https://github.com/${repository}/pull/`;
  if (!url?.startsWith(prefix) || !/^[1-9]\d*$/.test(url.slice(prefix.length))) return null;
  try {
    const receipt = rest(gh, 'GET pull', ['--method', 'GET', `repos/${repository}/pulls/${url.slice(prefix.length)}`], { timeoutMs: 30_000 });
    return receipt?.html_url === url && receipt.merged === true && receipt.head?.sha === headSha &&
      receipt.base?.ref === baseBranch && /^[0-9a-f]{40}$/.test(receipt.merge_commit_sha ?? '') ? receipt.merge_commit_sha : null;
  } catch { return null; }
}

/**
 * One pull request as the merge gate reads it (aiworks#138): GET repos/{repo}/pulls/{n}. `mergeable` is GitHub's own
 * answer: true, false, or null while GitHub is still computing it. Throws when the read fails.
 */
export function pullRequest({ gh, repository, number }) {
  const pr = rest(gh, 'GET pull', ['--method', 'GET', `repos/${repository}/pulls/${number}`], { timeoutMs: 30_000 });
  return { url: pr?.html_url ?? null, state: pr?.state ?? null, merged: pr?.merged === true, mergeable: pr?.mergeable ?? null,
    headRef: pr?.head?.ref ?? null, headSha: pr?.head?.sha ?? null, baseRef: pr?.base?.ref ?? null, mergeCommit: pr?.merge_commit_sha ?? null };
}

const CI_PASSED = new Set(['success', 'neutral', 'skipped']);
const CI_FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * The CI result of one commit from a check-runs response (aiworks#42). `pending`: no run yet, or a run not completed.
 * `failure`: every run completed and one failed, timed out or could not start. `success`: every run completed as success,
 * neutral or skipped. `inconclusive`: completed otherwise (for example cancelled), or more runs than the page holds.
 * `checks` are { name, status, conclusion, url }.
 */
export function ciState(body) {
  if (!Array.isArray(body?.check_runs)) throw new Error('GET check-runs returned no check_runs');
  const checks = body.check_runs.map((run) => ({ name: String(run.name ?? 'unnamed').slice(0, 200), status: run.status ?? null,
    conclusion: run.conclusion ?? null, url: typeof run.html_url === 'string' ? run.html_url : null }));
  if (!checks.length || checks.some((check) => check.status !== 'completed')) return { state: 'pending', checks };
  if (checks.some((check) => CI_FAILED.has(check.conclusion))) return { state: 'failure', checks };
  if (Number(body.total_count) > checks.length) return { state: 'inconclusive', checks };
  return { state: checks.every((check) => CI_PASSED.has(check.conclusion)) ? 'success' : 'inconclusive', checks };
}

/** Read-only CI result of a pushed commit: GET repos/{repo}/commits/{sha}/check-runs (REST, one page of 100). */
export function commitChecks({ gh, repository, sha }) {
  return ciState(rest(gh, 'GET check-runs', ['--method', 'GET', `repos/${repository}/commits/${sha}/check-runs`, '-f', 'per_page=100'], { timeoutMs: 30_000 }));
}

/**
 * A campaign declaration is private installation data and is never published (docs/design/WORK_ENVELOPE.md section 5,
 * slice E9): a `declare/...` branch, the former declaration-PR route, is refused before any gh call.
 */
export const declarationBranch = (branch) => /^declare\//i.test(String(branch ?? ''));

// Every PR and comment text passes the shared publication check (aiworks#8) before any GitHub call or body file write.
// `terms` are the installation's private terms; the refusal names categories only.
export function openPullRequest({ gh, repository, baseBranch, branch, title, body, bodyFile, terms = [] }) {
  if (declarationBranch(branch)) {
    throw Object.assign(new Error(`DECLARATION_PUBLISH_REFUSED: ${branch} is a declaration branch; approved declarations stay private and are never opened as a pull request`), { code: 'DECLARATION_PUBLISH_REFUSED' });
  }
  assertPublishable('pull request', `${branch}
${title}
${body}`, { repository, terms });
  const existing = findOpenPullRequest({ gh, repository, branch });
  if (existing) return existing.url;
  writeFileSync(bodyFile, body, 'utf8');
  let created;
  try {
    created = rest(gh, 'POST pulls', ['--method', 'POST', `repos/${repository}/pulls`,
      '-f', `title=${title}`, '-f', `head=${branch}`, '-f', `base=${baseBranch}`, '-F', `body=@${bodyFile}`]);
  } catch (error) {
    // The create may have landed before the failure was reported: reconcile instead of duplicating.
    // A rate-limit refusal is reported as is, so the caller waits for its reset.
    if (error instanceof RateLimitError) throw error;
    const again = findOpenPullRequest({ gh, repository, branch });
    if (again) return again.url;
    throw error;
  }
  if (!created?.html_url) throw new Error('POST pulls returned no html_url');
  return created.html_url;
}

export const marker = (key) => `<!-- aiworks:${key} -->`;

/** URL of the comment carrying this marker, or null. */
export function findMarkedComment({ gh, repository, issue, key }) {
  const out = exec(gh, ['api', `repos/${repository}/issues/${issue}/comments`, '--paginate',
    '--jq', `.[] | select(.body | contains(${JSON.stringify(marker(key))})) | .html_url`]);
  if (!out.ok) throw new Error(`gh api comments failed: ${out.stderr || out.error}`.slice(0, 500));
  return out.stdout.split('\n').filter(Boolean)[0] ?? null;
}

export function postComment({ gh, repository, issue, body, bodyFile, terms = [] }) {
  assertPublishable('comment', body, { repository, terms });
  writeFileSync(bodyFile, body, 'utf8');
  const created = rest(gh, 'POST comment', ['--method', 'POST', `repos/${repository}/issues/${issue}/comments`, '-F', `body=@${bodyFile}`]);
  if (!created?.html_url) throw new Error('POST comment returned no html_url');
  return created.html_url;
}

/**
 * Close an issue as not planned (SELF11): one REST PATCH of its state and state reason, never its labels or anything
 * else. Returns the issue GitHub answers with; throws when GitHub does not report it closed.
 */
export function closeIssue({ gh, repository, issue }) {
  const closed = rest(gh, 'PATCH issue', ['--method', 'PATCH', `repos/${repository}/issues/${issue}`,
    '-f', 'state=closed', '-f', 'state_reason=not_planned']);
  if (closed?.state !== 'closed') throw new Error('PATCH issue did not report the issue closed');
  return closed;
}
