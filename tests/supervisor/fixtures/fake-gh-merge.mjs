#!/usr/bin/env node
// Synthetic gh for the merge gate tests (aiworks#138). It answers GET repos/{repo}/pulls/{n} with the head the disposable
// origin really has (FAKE_GH_ORIGIN) and GitHub's mergeable flag, and PUT repos/{repo}/pulls/{n}/merge by writing a real
// merge commit (base first parent, PR head second) into that origin, refusing a `sha` that is not the head, as GitHub
// does. Every other call goes to fake-gh.mjs. No network and no GitHub.
// <FAKE_GH_STATE>/merge-calls.jsonl records every PUT with its fields. <FAKE_GH_STATE>/mergeable.json ({ "<pr url>": false })
// overrides the mergeable flag. <FAKE_GH_STATE>/lose-merge-response exists: the next PUT merges, then reports a failure
// (an unknown outcome), and the file is removed.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const state = process.env.FAKE_GH_STATE, origin = process.env.FAKE_GH_ORIGIN;
const args = process.argv.slice(2);
const option = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const method = (option('--method') ?? 'GET').toUpperCase();
const path = args.slice(1).find((arg, index, list) => !arg.startsWith('-') && !['--method', '-f', '-F', '--jq'].includes(list[index - 1])) ?? '';
const pull = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/merge)?$/.exec(path);

if (args[0] !== 'api' || !pull || !(method === 'GET' && !pull[3]) && !(method === 'PUT' && pull[3])) {
  const delegated = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'fake-gh.mjs'), ...args], { stdio: 'inherit' });
  process.exit(delegated.status ?? 1);
}
appendFileSync(join(state, 'gh-calls.jsonl'), `${JSON.stringify({ args, at: Date.now() })}\n`);

const fields = {};
for (let i = 1; i < args.length; i++) if (args[i] === '-f') { const [key, ...rest] = args[++i].split('='); fields[key] = rest.join('='); }
const git = (...list) => spawnSync('git', ['-C', origin, '-c', 'user.name=Synthetic GitHub', '-c', 'user.email=github@example.invalid', ...list],
  { encoding: 'utf8', windowsHide: true });
const head = (branch) => git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).stdout.trim() || null;
const respond = (status, body) => {
  process.stdout.write(`HTTP/2.0 ${status} ${status < 300 ? 'OK' : 'Error'}\r\nContent-Type: application/json\r\nX-Ratelimit-Remaining: 4999\r\n\r\n${JSON.stringify(body)}`);
  if (status >= 300) { process.stderr.write(`gh: ${body.message} (HTTP ${status})\n`); process.exit(1); }
  process.exit(0);
};

const prsFile = join(state, 'prs.json');
const prs = existsSync(prsFile) ? JSON.parse(readFileSync(prsFile, 'utf8')) : [];
const url = `https://github.com/${pull[1]}/pull/${pull[2]}`;
const pr = prs.find((item) => item.url === url);
if (!pr) respond(404, { message: 'Not Found' });
const overrides = existsSync(join(state, 'mergeable.json')) ? JSON.parse(readFileSync(join(state, 'mergeable.json'), 'utf8')) : {};
const headSha = head(pr.head), baseSha = head(pr.base);
const mergeable = pr.merged ? null : Object.hasOwn(overrides, url) ? overrides[url]
  : git('merge-tree', '--write-tree', baseSha, headSha).status === 0;

if (method === 'GET') {
  respond(200, { html_url: url, number: Number(pull[2]), state: pr.merged ? 'closed' : 'open', merged: Boolean(pr.merged), mergeable,
    merge_commit_sha: pr.mergeCommit ?? null, head: { ref: pr.head, sha: headSha }, base: { ref: pr.base } });
}
appendFileSync(join(state, 'merge-calls.jsonl'), `${JSON.stringify({ url, fields })}\n`);
if (pr.merged) respond(405, { message: 'Pull Request is not mergeable' });
if (fields.sha !== headSha) respond(409, { message: 'Head branch was modified. Review and try the merge again.' });
if (mergeable !== true) respond(405, { message: 'Pull Request is not mergeable' });
if (fields.merge_method !== 'merge') respond(405, { message: `this synthetic GitHub allows merge commits only, not ${fields.merge_method}` });
const tree = git('merge-tree', '--write-tree', baseSha, headSha).stdout.trim().split('\n')[0];
const commit = git('commit-tree', tree, '-p', baseSha, '-p', headSha, '-m', `Merge pull request #${pull[2]} from ${pr.head}`).stdout.trim();
if (git('update-ref', `refs/heads/${pr.base}`, commit, baseSha).status !== 0) respond(409, { message: 'Base branch was modified.' });
writeFileSync(prsFile, JSON.stringify(prs.map((item) => (item.url === url ? { ...item, merged: true, mergeCommit: commit } : item))));
const lose = join(state, 'lose-merge-response');
if (existsSync(lose)) {
  rmSync(lose);
  process.stderr.write('gh: connection reset by peer\n');
  process.exit(1);
}
respond(200, { sha: commit, merged: true, message: 'Pull Request successfully merged' });
