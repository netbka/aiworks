#!/usr/bin/env node
// Synthetic stand-in for the gh CLI in supervisor tests: PRs and comments live in <FAKE_GH_STATE>.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const state = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);
const option = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const prsFile = join(state, 'prs.json');
const commentsFile = join(state, 'comments.jsonl');
const prs = existsSync(prsFile) ? JSON.parse(readFileSync(prsFile, 'utf8')) : [];
const comments = existsSync(commentsFile) ? readFileSync(commentsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
const [area, action] = args;

if (area === 'pr' && action === 'list') {
  process.stdout.write(JSON.stringify(prs.filter((pr) => pr.head === option('--head')).map((pr) => ({ url: pr.url, headRefOid: null }))));
} else if (area === 'pr' && action === 'create') {
  const url = `https://github.com/${option('--repo')}/pull/${1000 + prs.length}`;
  prs.push({ url, head: option('--head'), base: option('--base'), title: option('--title'), body: readFileSync(option('--body-file'), 'utf8') });
  writeFileSync(prsFile, JSON.stringify(prs));
  process.stdout.write(`${url}\n`);
} else if (area === 'issue' && action === 'comment') {
  const url = `https://github.com/${option('--repo')}/issues/${args[2]}#issuecomment-${comments.length + 1}`;
  appendFileSync(commentsFile, `${JSON.stringify({ issue: args[2], url, body: readFileSync(option('--body-file'), 'utf8') })}\n`);
  process.stdout.write(`${url}\n`);
} else if (area === 'api') {
  const issue = /issues\/(\d+)\/comments/.exec(args[1])?.[1];
  const needle = /contains\((".*")\)/.exec(option('--jq') ?? '')?.[1];
  const text = needle ? JSON.parse(needle) : null;
  for (const comment of comments.filter((c) => c.issue === issue && (!text || c.body.includes(text)))) process.stdout.write(`${comment.url}\n`);
} else {
  process.stderr.write(`fake gh: unsupported ${args.join(' ')}\n`);
  process.exit(9);
}
