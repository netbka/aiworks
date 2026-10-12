import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { researchContext, safeResearchPath } from '../../src/supervisor/adapters/research-context.mjs';
import { declaration } from './helpers.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-research-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'AGENTS.md'), 'synthetic project authority');
  const fake = join(root, 'gh.mjs');
  writeFileSync(fake, `
    const [, , command, ...all] = process.argv;
    const path = all.find((v) => v.startsWith('repos/')); const flags = all;
    const base = 'https://api.github.com/' + path.split('/').slice(0,3).join('/');
    if (command !== 'api') process.exit(2);
    if (path.includes('per_page=100') && (!flags.includes('--paginate') || !flags.includes('--slurp'))) process.exit(3);
    const issue = (n) => ({ number:n, title:'issue '+n, body:'x'.repeat(4000), state:'open', html_url:'https://github.com/test/repo/issues/'+n });
    let value;
    if (path.split('/').length === 3) value = {full_name:path.slice(6)};
    else if (path.includes('/commits/')) value = { sha:'a'.repeat(40) };
    else if (path.includes('/git/trees/')) value = { truncated:false, tree:[{path:'AGENTS.md',type:'blob',mode:'100644'}] };
    else if (path.includes('/contents/')) value = { encoding:'base64', content:Buffer.from('pinned external guidelines').toString('base64') };
    else if (path.includes('/comments?')) value = [Array.from({length:12},(_,i)=>({body:'comment '+i,html_url:'comment:'+i})),Array.from({length:10},(_,i)=>({body:'comment '+(12+i),html_url:'comment:'+(12+i)}))];
    else if (path.includes('/issues?')) value = [[issue(1)],[issue(2)]];
    else value = path.includes('state=open') ? [[]] : [];
    const bind=(item) => ({ ...item, url:base + '/synthetic' });
    if (Array.isArray(value)) value = value.map((page) => Array.isArray(page) ? page.map(bind) : bind(page));
    else value = bind(value);
    console.log(JSON.stringify(value));
  `);
  const d = declaration({ tasks: [{ ...declaration().tasks[0], deliverable: 'report' }] });
  d.authorization.readSources = [{ repository: 'test/guidelines', paths: ['AGENTS.md'] }];
  return { root, workspace, fake, args: { gh: [process.execPath, fake], workspace, declaration: d,
    task: d.tasks[0], now: 1000, revision: 'b'.repeat(40) } };
}

test('broker captures every open item across pages, pins guidelines and labels truncation/history', (t) => {
  const { args } = fixture(t);
  const text = researchContext(args);
  const data = JSON.parse(text.split('<research-context>\n')[1].split('\n</research-context>')[0]);
  assert.equal(data.capturedAt, new Date(1000).toISOString());
  assert.ok(data.sources[0].source.includes('b'.repeat(40)));
  const backlog = JSON.parse(data.sources.find((s) => s.source.endsWith('/issues')).content);
  assert.deepEqual(backlog.openIssues.map((i) => i.number), [1, 2]);
  assert.equal(backlog.openIssues[0].bodyTruncated, true);
  assert.equal(backlog.coordination.totalComments, 22);
  assert.equal(backlog.coordination.comments.length, 5);
  assert.equal(backlog.coordination.comments[0].body, 'comment 17');
  assert.equal(backlog.currentBaseSha, 'a'.repeat(40));
  assert.ok(data.sources.at(-1).source.includes('/blob/' + 'a'.repeat(40) + '/'));
});

test('broker rejects secret paths, API-query injection and escaping junctions', (t) => {
  for (const path of ['.env', 'a/.env.local', '.git/config', 'auth.json', 'credentials/token', '../AGENTS.md', 'C:/private', 'file?ref=other', 'file%2fsecret']) assert.equal(safeResearchPath(path), false, path);
  const { args, root, workspace } = fixture(t);
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'doc.txt'), 'outside');
  symlinkSync(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => researchContext({ ...args, task: { ...args.task, references: ['escape/doc.txt'] } }), /escapes checkout/);
  const secretDir = join(workspace, 'secrets'); mkdirSync(secretDir); writeFileSync(join(secretDir, 'doc.txt'), 'synthetic forbidden evidence');
  symlinkSync(secretDir, join(workspace, 'public'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => researchContext({ ...args, task: { ...args.task, references: ['public/doc.txt'] } }), /forbidden secret path/);
});

test('broker supplies local Git status/history without granting workers shell access', (t) => {
  const { args, root } = fixture(t);
  const git = join(root, 'git.mjs');
  writeFileSync(git, `const args=process.argv.slice(2); if(args[0]==='status') console.log(''); else if(args[0]==='log') console.log('synthetic-sha synthetic commit'); else process.exit(1);`);
  const text = researchContext({ ...args, git: [process.execPath, git] });
  const data = JSON.parse(text.split('<research-context>\n')[1].split('\n</research-context>')[0]);
  const evidence = JSON.parse(data.sources.find((s) => s.source.endsWith(':local-git-evidence')).content);
  assert.equal(evidence.workingTreeClean, true);
  assert.equal(evidence.recentCommits, 'synthetic-sha synthetic commit');
  assert.match(text, /shell\/gh examples elsewhere are conceptual/);
  writeFileSync(git, 'process.exit(1)');
  assert.throws(() => researchContext({ ...args, git: [process.execPath, git] }), /local Git evidence unavailable/);
});

test('broker fails closed when evidence cannot be acquired or exceeds bounds', (t) => {
  const { args, fake, workspace } = fixture(t);
  writeFileSync(fake, 'process.exit(1)');
  assert.throws(() => researchContext(args), /GitHub context unavailable/);
  writeFileSync(join(workspace, 'AGENTS.md'), 'x'.repeat(200001));
  assert.throws(() => researchContext(args), /bounded capture/);
});

test('broker rejects external symlinks before the contents API can dereference them', (t) => {
  const { args, fake } = fixture(t);
  writeFileSync(fake, readFileSync(fake, 'utf8').replace("mode:'100644'", "mode:'120000'"));
  assert.throws(() => researchContext(args), /regular pinned file, not a symlink/);
});

test('broker rejects moved repository identities and cross-repository canonical response URLs', (t) => {
  const { args, fake } = fixture(t);
  const source = readFileSync(fake, 'utf8');
  writeFileSync(fake, source.replace('full_name:path.slice(6)', "full_name:'other/repository'"));
  assert.throws(() => researchContext(args), /identity changed/);
  writeFileSync(fake, source.replace("url:base + '/synthetic'", "url:'https://api.github.com/repos/other/repository/synthetic'"));
  assert.throws(() => researchContext(args), /outside the declared repository/);
});
