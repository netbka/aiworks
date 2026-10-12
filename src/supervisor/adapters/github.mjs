// AIWorks GitHub adapter through the existing authenticated gh CLI. No GitHub Actions,
// no new identity. Creation calls are preceded by a lookup so a retry after an unknown
// outcome reconciles instead of duplicating (no exactly-once promise).
// Every call is REST (gh api), never GraphQL: the account's GraphQL quota is shared with the
// dashboard and other tools, and a spent quota must not stall publication (netbka/aiworks#21).
import { writeFileSync } from 'node:fs';
import { exec } from './git.mjs';

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
function rest(gh, what, args, { timeoutMs } = {}) {
  const out = exec(gh, ['api', '--include', ...args], { timeoutMs });
  const response = parseResponse(out.stdout);
  if (!out.ok) {
    const message = `${what} failed: ${out.stderr || out.error || response.body}`.slice(0, 500);
    const resetAt = rateLimitReset(response, out.stderr);
    if (resetAt !== undefined) throw new RateLimitError(message, resetAt);
    throw new Error(message);
  }
  return JSON.parse(response.body || 'null');
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

export function openPullRequest({ gh, repository, baseBranch, branch, title, body, bodyFile }) {
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

export function postComment({ gh, repository, issue, body, bodyFile }) {
  writeFileSync(bodyFile, body, 'utf8');
  const created = rest(gh, 'POST comment', ['--method', 'POST', `repos/${repository}/issues/${issue}/comments`, '-F', `body=@${bodyFile}`]);
  if (!created?.html_url) throw new Error('POST comment returned no html_url');
  return created.html_url;
}
