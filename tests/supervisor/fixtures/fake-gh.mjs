#!/usr/bin/env node
// Synthetic stand-in for the gh CLI in supervisor tests: PRs and comments live in <FAKE_GH_STATE>.
// It answers only the REST routes the supervisor uses (gh api). Every call is logged to gh-calls.jsonl; a GraphQL-backed
// command (gh pr ..., gh issue comment, gh api graphql) is refused, so a supervisor path that still uses one fails its test.
// <FAKE_GH_STATE>/rate-limit.json ({ route: 'POST pulls', times: 1, retryAfter: 2 } or { ..., reset: <epoch s> }) makes
// that route refuse with a 403 rate-limit response carrying the reset headers, `times` times.
// <FAKE_GH_STATE>/check-runs.json ({ "<sha>": [{ name, status, conclusion }] }) holds the CI check runs of each commit; a
// commit it does not list has none yet.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const state = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);
const option = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const prsFile = join(state, 'prs.json');
const commentsFile = join(state, 'comments.jsonl');
const limitFile = join(state, 'rate-limit.json');
const prs = existsSync(prsFile) ? JSON.parse(readFileSync(prsFile, 'utf8')) : [];
const comments = existsSync(commentsFile) ? readFileSync(commentsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
appendFileSync(join(state, 'gh-calls.jsonl'), `${JSON.stringify({ args, at: Date.now() })}\n`);

const refuse = (text) => { process.stderr.write(`fake gh: ${text}\n`); process.exit(9); };
if (args[0] !== 'api') refuse(`GraphQL-backed or unsupported command refused: gh ${args.join(' ')}`);

// gh api [--include] [--method M] <path> [-f k=v | -F k=v | -F k=@file]... [--paginate] [--jq expr]
const include = args.includes('--include') || args.includes('-i');
const method = (option('--method') ?? option('-X') ?? 'GET').toUpperCase();
const fields = {};
const rest = [];
for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (['-f', '-F', '--raw-field', '--field'].includes(arg)) {
    const [key, ...parts] = args[++i].split('=');
    const value = parts.join('=');
    fields[key] = ['-F', '--field'].includes(arg) && value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value;
  } else if (['--method', '-X', '--jq', '-q', '--hostname'].includes(arg)) i++;
  else if (!arg.startsWith('-')) rest.push(arg);
}
const path = rest[0] ?? '';
if (path === 'graphql' || path.endsWith('/graphql')) refuse(`GraphQL endpoint refused: gh ${args.join(' ')}`);

const respond = (status, body, extra = {}) => {
  const text = JSON.stringify(body);
  if (include) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-Ratelimit-Limit': '5000', 'X-Ratelimit-Remaining': '4999', ...extra };
    process.stdout.write(`HTTP/2.0 ${status} ${status < 300 ? 'OK' : 'Forbidden'}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${text}`);
  } else process.stdout.write(text);
  if (status >= 300) { process.stderr.write(`gh: ${body.message} (HTTP ${status})\n`); process.exit(1); }
};

const pulls = /^repos\/([^/]+\/[^/]+)\/pulls$/.exec(path);
const pull = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
const issueComments = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path);
const checkRuns = /^repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]{40})\/check-runs$/.exec(path);
const route = `${method} ${pulls ? 'pulls' : pull ? 'pull' : issueComments ? 'comments' : checkRuns ? 'check-runs' : path}`;

const limit = existsSync(limitFile) ? JSON.parse(readFileSync(limitFile, 'utf8')) : null;
if (limit && limit.times > 0 && (limit.route === route || limit.route === '*')) {
  writeFileSync(limitFile, JSON.stringify({ ...limit, times: limit.times - 1 }));
  const reset = limit.reset ?? Math.ceil(Date.now() / 1000) + 3600;
  respond(403, { message: 'API rate limit exceeded for user ID 1.', documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api' },
    { 'X-Ratelimit-Remaining': '0', 'X-Ratelimit-Reset': String(reset), ...(limit.retryAfter !== undefined ? { 'Retry-After': String(limit.retryAfter) } : {}) });
}

const receipt = (pr) => ({ html_url: pr.url, number: Number(/\/pull\/(\d+)$/.exec(pr.url)[1]), state: pr.merged ? 'closed' : 'open',
  merged: Boolean(pr.merged), merge_commit_sha: pr.mergeCommit ?? null, head: { ref: pr.head, sha: pr.headSha ?? null }, base: { ref: pr.base } });

if (/^repos\/[^/]+\/[^/]+\/actions\/permissions$/.test(path) && method === 'GET') {
  const policyFile = join(state, 'actions-policy.json');
  respond(200, existsSync(policyFile) ? JSON.parse(readFileSync(policyFile, 'utf8')) : { enabled: false });
} else if (pulls && method === 'GET') {
  const owner = pulls[1].split('/')[0];
  respond(200, prs.filter((pr) => `${owner}:${pr.head}` === fields.head && fields.state === 'open' && !pr.merged).map(receipt));
} else if (pulls && method === 'POST') {
  if (prs.some((pr) => pr.head === fields.head && !pr.merged)) {
    respond(422, { message: `Validation Failed: A pull request already exists for ${pulls[1].split('/')[0]}:${fields.head}.` });
  }
  const pr = { url: `https://github.com/${pulls[1]}/pull/${1000 + prs.length}`, head: fields.head, base: fields.base, title: fields.title, body: fields.body };
  prs.push(pr);
  writeFileSync(prsFile, JSON.stringify(prs));
  respond(201, receipt(pr));
} else if (pull && method === 'GET') {
  const pr = prs.find((item) => item.url === `https://github.com/${pull[1]}/pull/${pull[2]}`);
  if (!pr) respond(404, { message: 'Not Found' });
  respond(200, receipt(pr));
} else if (issueComments && method === 'POST') {
  const url = `https://github.com/${issueComments[1]}/issues/${issueComments[2]}#issuecomment-${comments.length + 1}`;
  appendFileSync(commentsFile, `${JSON.stringify({ issue: issueComments[2], url, body: fields.body })}\n`);
  respond(201, { html_url: url, body: fields.body });
} else if (issueComments && method === 'GET') {
  const needle = /contains\((".*")\)/.exec(option('--jq') ?? '')?.[1];
  const text = needle ? JSON.parse(needle) : null;
  for (const comment of comments.filter((c) => c.issue === issueComments[2] && (!text || c.body.includes(text)))) process.stdout.write(`${comment.url}\n`);
} else if (checkRuns && method === 'GET') {
  const runsFile = join(state, 'check-runs.json');
  const runs = (existsSync(runsFile) ? JSON.parse(readFileSync(runsFile, 'utf8')) : {})[checkRuns[2]] ?? [];
  respond(200, { total_count: runs.length, check_runs: runs.slice(0, Number(fields.per_page ?? 30)).map((run, index) => ({ id: index + 1,
    name: run.name, status: run.status, conclusion: run.conclusion ?? null, head_sha: checkRuns[2],
    html_url: `https://github.com/${checkRuns[1]}/actions/runs/${index + 1}` })) });
} else {
  refuse(`unsupported gh ${args.join(' ')}`);
}
