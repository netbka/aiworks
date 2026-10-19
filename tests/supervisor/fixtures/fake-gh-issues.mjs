#!/usr/bin/env node
// Synthetic stand-in for the gh CLI in the work-list import test. <FAKE_GH_STATE>/issues.json holds
// { open: [issue or pull request], closed: [...], comments: { "<number>": [comment] } } of one fictional repository.
// It answers `gh api --method GET` for the issue list (paged by -f page/per_page), one issue and each issue's comments.
// Only when the state has `writable: true` (the close test) it also takes POST of a comment and PATCH of an issue's state,
// stamping each with `clock` and moving it one second on; `crashAfter: "comment"` or `"close"` makes that write land
// and then fail once, as a crash before the answer is read would. Every call is logged to gh-calls.jsonl first; anything
// else (another method, GraphQL, a command other than api) is refused.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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
const data = JSON.parse(readFileSync(join(state, 'issues.json'), 'utf8'));
if ((method !== 'GET' && !data.writable) || path.endsWith('graphql')) refuse(`${method} ${path} refused`);
const page = (list) => {
  const size = Number(fields.per_page ?? 30);
  const index = Number(fields.page ?? 1);
  return list.slice((index - 1) * size, index * size);
};
let body;
const issues = /^repos\/[^/]+\/[^/]+\/issues$/.exec(path);
const one = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(path);
const comments = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path);
const find = (number) => [...data.open, ...data.closed].find((entry) => entry.number === Number(number)) ?? refuse(`no issue ${number}`);
const tick = () => { const at = data.clock; data.clock = new Date(Date.parse(at) + 1000).toISOString().replace('.000Z', 'Z'); return at; };
const save = (crash) => {
  const crashed = data.crashAfter === crash;
  if (crashed) delete data.crashAfter;
  writeFileSync(join(state, 'issues.json'), JSON.stringify(data));
  if (crashed) refuse(`synthetic crash after the ${crash} landed`);
};
if (method === 'POST' && comments) {
  const issue = find(comments[2]);
  const text = fields.body?.startsWith('@') ? readFileSync(fields.body.slice(1), 'utf8') : fields.body;
  const at = tick();
  const id = 9000 + Object.values(data.comments).flat().length;
  body = { id, body: text, html_url: `https://github.com/${comments[1]}/issues/${issue.number}#issuecomment-${id}`, created_at: at, updated_at: at };
  (data.comments[issue.number] ??= []).push(body);
  issue.updated_at = at;
  save('comment');
} else if (method === 'PATCH' && one) {
  const issue = find(one[2]);
  if (Object.keys(fields).some((key) => !['state', 'state_reason'].includes(key))) refuse('PATCH of anything but the state refused');
  Object.assign(issue, fields, { updated_at: tick() });
  data.open = data.open.filter((entry) => entry !== issue);
  data.closed.push(issue);
  body = issue;
  save('close');
} else if (method !== 'GET') refuse(`${method} ${path} is not served`);
else if (one) body = find(one[2]);
else if (issues && fields.state === 'open') body = page(data.open);
else if (issues && fields.state === 'all') body = page([...data.open, ...data.closed].sort((a, b) => b.number - a.number));
else if (comments) body = page(data.comments[comments[2]] ?? []);
else refuse(`GET ${path} is not served`);
process.stdout.write(`HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`);
