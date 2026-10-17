import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Synthetic repositories only. Never point the output at an existing project.
const root = resolve(process.argv[2] ?? './.bakeoff-fixtures');
const fixtures = {
  'BUG-1': {
    'package.json': '{"private":true,"type":"module","scripts":{"test":"node --test"}}\n',
    'src/format-duration.mjs': `export function formatDuration(totalSeconds) {
  if (!Number.isInteger(totalSeconds) || totalSeconds < 0) throw new RangeError('non-negative integer required');
  return Math.floor(totalSeconds / 60) + ':' + (totalSeconds % 60); // intentionally incorrect padding
}
`,
    'test/format-duration.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from '../src/format-duration.mjs';
test('format', () => {
  for (const [n, expected] of [[0,'0:00'],[9,'0:09'],[10,'0:10'],[60,'1:00'],[125,'2:05']])
    assert.equal(formatDuration(n), expected);
});
test('invalid input', () => {
  for (const n of [-1,1.2,NaN,'9']) assert.throws(() => formatDuration(n));
});
`
  },
  'FEATURE-1': {
    'package.json': '{"private":true,"type":"module","scripts":{"test":"node --test"}}\n',
    'src/server.mjs': `import { createServer } from 'node:http';
export function createTaskServer() {
  const tasks = [];
  return createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/tasks') {
      res.writeHead(200); res.end(JSON.stringify(tasks)); return;
    }
    res.writeHead(404); res.end(JSON.stringify({error:'not found'}));
  });
}
`,
    'test/tasks.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createTaskServer } from '../src/server.mjs';
test('existing GET and new POST contract', async () => {
  const server = createTaskServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = body => fetch(base + '/tasks', {
    method:'POST', headers:{'content-type':'application/json'}, body
  });
  try {
    let res = await fetch(base + '/tasks');
    assert.equal(res.status, 200); assert.deepEqual(await res.json(), []);
    for (const bad of ['{invalid','{}',JSON.stringify({title:'  '})]) {
      res = await post(bad); assert.equal(res.status, 400);
    }
    res = await post(JSON.stringify({title:'First'})); assert.equal(res.status, 201);
    const first = await res.json(); assert.equal(first.title,'First'); assert.ok(first.id);
    res = await post(JSON.stringify({title:'Second'})); assert.equal(res.status, 201);
    const second = await res.json(); assert.notEqual(first.id,second.id);
    res = await fetch(base + '/tasks');
    assert.equal(res.status, 200); assert.deepEqual(await res.json(), [first,second]);
  } finally {
    await new Promise((done,fail) => server.close(e => e ? fail(e) : done()));
  }
});
`
  }
};
for (const [name, files] of Object.entries(fixtures)) {
  const dir = join(root,name);
  await rm(dir,{recursive:true,force:true});
  for (const [path, contents] of Object.entries(files)) {
    const dest = join(dir,path);
    await mkdir(dirname(dest),{recursive:true});
    await writeFile(dest,contents);
  }
  execFileSync('git',['init','-q'],{cwd:dir});
  execFileSync('git',['add','.'],{cwd:dir});
  const env = {...process.env,GIT_AUTHOR_DATE:'2020-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2020-01-01T00:00:00Z'};
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','initial fixture'],{cwd:dir,env});
  const sha = execFileSync('git',['rev-parse','HEAD'],{cwd:dir,encoding:'utf8'}).trim();
  console.log(name + ' ' + sha + ' ' + dir);
}
