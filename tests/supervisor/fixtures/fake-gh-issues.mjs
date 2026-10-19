#!/usr/bin/env node
// Synthetic stand-in for the gh CLI in the work-list import test. <FAKE_GH_STATE>/issues.json holds
// { open: [issue or pull request], closed: [...], comments: { "<number>": [comment] } } of one fictional repository.
// It answers `gh api --method GET` for the issue list (paged by -f page/per_page) and each issue's comments. Every call is
// logged to gh-calls.jsonl first; anything else (another method, GraphQL, a command other than api) is refused.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const state = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);
appendFileSync(join(state, 'gh-calls.jsonl'), `${JSON.stringify({ args })}\n`);
const refuse = (text) => { process.stderr.write(`fake gh: ${text}\n`); process.exit(9); };
if (args[0] !== 'api') refuse(`unsupported command refused: gh ${args.join(' ')}`);

const fields = {};
const positional = [];
let method = 'GET';
for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (['-f', '-F', '--raw-field', '--field'].includes(arg)) { const [key, ...value] = args[++i].split('='); fields[key] = value.join('='); }
  else if (['--method', '-X'].includes(arg)) method = args[++i].toUpperCase();
  else if (['--jq', '-q', '--hostname', '--input'].includes(arg)) refuse(`option ${arg} refused`);
  else if (!arg.startsWith('-')) positional.push(arg);
}
const path = positional[0] ?? '';
if (method !== 'GET' || path.endsWith('graphql')) refuse(`${method} ${path} refused`);

const data = JSON.parse(readFileSync(join(state, 'issues.json'), 'utf8'));
const page = (list) => {
  const size = Number(fields.per_page ?? 30);
  const index = Number(fields.page ?? 1);
  return list.slice((index - 1) * size, index * size);
};
let body;
const issues = /^repos\/[^/]+\/[^/]+\/issues$/.exec(path);
const comments = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path);
if (issues && fields.state === 'open') body = page(data.open);
else if (issues && fields.state === 'all') body = page([...data.open, ...data.closed].sort((a, b) => b.number - a.number));
else if (comments) body = page(data.comments[comments[1]] ?? []);
else refuse(`GET ${path} is not served`);
process.stdout.write(`HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`);
