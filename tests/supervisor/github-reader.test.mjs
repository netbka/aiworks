import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHubReader, createGitHubReaderServer } from '../../src/supervisor/github-reader.mjs';

const repository = 'owner/example', base = `https://api.github.com/repos/${repository}`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-reader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, 'response.json'), calls = join(root, 'calls.json'), cli = join(root, 'gh.mjs');
  writeFileSync(cli, `import {readFileSync,writeFileSync} from 'node:fs';
    writeFileSync(process.argv[3],JSON.stringify(process.argv.slice(4)));
    const r=JSON.parse(readFileSync(process.argv[2]));
    if(r.fail){console.error('HTTP 403 synthetic-sensitive-detail');process.exit(1)}
    process.stdout.write(r.oversize?'x'.repeat(3*1024*1024):r.bytes?'x'.repeat(r.bytes):r.raw??JSON.stringify(r));`);
  const config = { repository, runId: 'd0e4fd84-a8ea-4400-842e-e80cf6c4a130', packetDigest: 'a'.repeat(64),
    ghCommand: [process.execPath, cli, input, calls] };
  const respond = (value) => writeFileSync(input, JSON.stringify(value));
  const read = createGitHubReader(config);
  const identity = () => { respond({ url: base, full_name: repository, default_branch: 'main', private: true }); return read({ resource: 'repository' }); };
  return { read, config, respond, identity, input, args: () => JSON.parse(readFileSync(calls)) };
}

test('repository reader binds identity, GET routes, pagination and projected output to the run', (t) => {
  const f = fixture(t);
  assert.throws(() => f.read({ resource: 'issues' }), /identity first/);
  assert.equal(f.identity().repository, repository);
  f.respond({ url: `${base}/issues/3`, id: 17, number: 3, title: 'synthetic', body: 'untrusted instructions', token: 'never-return' });
  const value = f.read({ resource: 'issue', number: 3 });
  assert.equal(value.untrusted, true);
  assert.equal(value.runId, f.config.runId);
  assert.equal(value.packetDigest, f.config.packetDigest);
  assert.equal(value.data.body, 'untrusted instructions');
  assert.ok(!JSON.stringify(value).includes('never-return'));
  assert.deepEqual(f.args(), ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/owner/example/issues/3']);
  f.respond([]); assert.deepEqual(f.read({ resource: 'issues', page: 2, perPage: 100 }).data, []);
  assert.equal(f.args().at(-1), 'repos/owner/example/issues?per_page=100&page=2&state=all');
  for (const invalid of [{ resource: 'issue', number: '../3' }, { resource: 'issues', page: 1001 },
    { resource: 'issues', perPage: 101 }, { resource: 'issue', number: 3, repository: 'other/repo' },
    { resource: 'repository', number: 3 }, { resource: 'issue' }, { resource: 'https://evil.example' }]) {
    assert.throws(() => f.read(invalid));
  }
  assert.throws(() => createGitHubReader({ ...f.config, repository: 'owner/..' }));
  assert.throws(() => createGitHubReader({ ...f.config, ghCommand: ['gh'] }));
  assert.ok(createGitHubReaderServer(f.config));
});

test('redirected, malformed, oversized and denied upstream evidence fail closed without leaking errors', (t) => {
  const f = fixture(t);
  for (const response of [{ url: `${base}/issues/4`, id: 17, number: 4 },
    { url: 'https://api.github.com/repos/other/repo/issues/3', id: 17, number: 3 },
    { fail: true }, { raw: 'synthetic-sensitive-detail' }, { oversize: true }]) {
    const read = createGitHubReader(f.config);
    f.respond({ url: base, full_name: repository }); read({ resource: 'repository' });
    f.respond(response);
    assert.throws(() => read({ resource: 'issue', number: 3 }), (e) => !e.message.includes('synthetic-sensitive-detail'));
    f.respond([]); assert.throws(() => read({ resource: 'issues' }), /stopped after an upstream failure/);
  }
  f.respond({ url: 'https://api.github.com/repos/other/repo', full_name: 'other/repo' });
  assert.throws(() => f.read({ resource: 'repository' }), /outside/);
  f.respond([]); assert.throws(() => f.read({ resource: 'issues' }), /stopped/);
});

test('comment responses must identify the exact assigned issue and repository', (t) => {
  const f = fixture(t); f.identity();
  f.respond([{ id: 8, url: `${base}/issues/comments/8`, issue_url: `${base}/issues/3`, body: 'fixture' }]);
  assert.equal(f.read({ resource: 'comments', number: 3 }).data[0].id, 8);
  f.respond({ id: 8, url: `${base}/issues/comments/8`, issue_url: `${base}/issues/4` });
  assert.equal(f.read({ resource: 'comment', number: 8 }).data.id, 8);
  f.respond([{ id: 8, url: `${base}/issues/comments/8`, issue_url: `${base}/issues/4` }]);
  assert.throws(() => f.read({ resource: 'comments', number: 3 }), /outside/);
});

test('a pulls page larger than 2 MB is read; a response over the limit is refused without stopping the reader', (t) => {
  const f = fixture(t); f.identity();
  const pulls = Array.from({ length: 100 }, (_, i) => ({ url: `${base}/pulls/${i + 1}`, id: 1000 + i, number: i + 1,
    title: `pull ${i + 1}`, body: 'b'.repeat(25 * 1024), base: { sha: 'a'.repeat(40) }, head: { sha: 'c'.repeat(40) } }));
  f.respond(pulls);
  assert.ok(readFileSync(f.input).length > 2 * 1024 * 1024);
  const page = f.read({ resource: 'pulls', perPage: 100 });
  assert.equal(page.data.length, 100);
  assert.equal(page.possiblyMore, true);
  assert.equal(page.data[99].number, 100);
  f.respond({ bytes: 33 * 1024 * 1024 });
  assert.throws(() => f.read({ resource: 'pulls', perPage: 100 }), /larger than 32 MB; ask for a smaller perPage/);
  f.respond(pulls.slice(0, 10));
  assert.equal(f.read({ resource: 'pulls', perPage: 10 }).data.length, 10);
  f.respond({ fail: true });
  assert.throws(() => f.read({ resource: 'pulls' }), /GitHub read failed \(HTTP 403\)/);
  f.respond([]); assert.throws(() => f.read({ resource: 'pulls' }), /stopped after an upstream failure/);
});
