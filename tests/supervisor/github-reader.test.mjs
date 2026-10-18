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
    const s=JSON.parse(readFileSync(process.argv[2])),r=s.routes?s.routes[process.argv.at(-1)]??{fail:true}:s;
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

test('pull responses say whether the pull request is a draft and whether it can merge', (t) => {
  const f = fixture(t); f.identity();
  const pull = { url: `${base}/pulls/5`, id: 50, number: 5, draft: true, mergeable: false, mergeable_state: 'dirty',
    base: { sha: 'a'.repeat(40) }, head: { sha: 'c'.repeat(40) } };
  f.respond(pull);
  assert.deepEqual(Object.entries(f.read({ resource: 'pull', number: 5 }).data).filter(([key]) => key.startsWith('draft') || key.startsWith('mergeable')),
    [['draft', true], ['mergeable', false], ['mergeable_state', 'dirty']]);
  f.respond([{ ...pull, draft: false, mergeable: null, mergeable_state: 'unknown' }]);
  const listed = f.read({ resource: 'pulls' }).data[0];
  assert.equal(listed.draft, false);
  assert.equal(listed.mergeable, null);
  assert.equal(listed.mergeable_state, 'unknown');
});

test('reviews are read for one pull request of the assigned repository only', (t) => {
  const f = fixture(t);
  assert.throws(() => f.read({ resource: 'reviews', number: 5 }), /identity first/);
  f.identity();
  assert.throws(() => f.read({ resource: 'reviews' }), /exactly its numeric/);
  f.respond([{ id: 70, user: { login: 'reviewer' }, body: 'looks fine', state: 'APPROVED', html_url: 'https://github.com/owner/example/pull/5#pullrequestreview-70',
    pull_request_url: `${base}/pulls/5`, submitted_at: '2026-10-14T10:00:00Z', commit_id: 'c'.repeat(40), token: 'never-return' }]);
  const value = f.read({ resource: 'reviews', number: 5, perPage: 1 });
  assert.deepEqual(f.args(), ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/owner/example/pulls/5/reviews?per_page=1&page=1']);
  assert.equal(value.untrusted, true);
  assert.equal(value.possiblyMore, true);
  assert.deepEqual(JSON.parse(JSON.stringify(value.data[0])), { id: 70, body: 'looks fine', state: 'APPROVED', html_url: 'https://github.com/owner/example/pull/5#pullrequestreview-70',
    submitted_at: '2026-10-14T10:00:00Z', commit_id: 'c'.repeat(40), author: 'reviewer' });
  for (const pullRequestUrl of [`${base}/pulls/6`, 'https://api.github.com/repos/other/repo/pulls/5']) {
    const read = createGitHubReader(f.config);
    f.respond({ url: base, full_name: repository }); read({ resource: 'repository' });
    f.respond([{ id: 70, state: 'APPROVED', pull_request_url: pullRequestUrl }]);
    assert.throws(() => read({ resource: 'reviews', number: 5 }), /outside/);
    f.respond([]); assert.throws(() => read({ resource: 'reviews', number: 5 }), /stopped after an upstream failure/);
  }
});

test('checks return status and check runs only for the head commit of a pull request in the assigned repository', (t) => {
  const f = fixture(t);
  const sha = 'c'.repeat(40), other = 'd'.repeat(40), route = (path) => `repos/owner/example/commits/${sha}${path}`;
  const pulls = [{ url: `${base}/pulls/5`, id: 50, number: 5, head: { sha } }, { url: `${base}/pulls/2`, id: 20, number: 2, head: { sha: other } }];
  const status = { sha, state: 'failure', repository: { full_name: repository }, total_count: 1,
    statuses: [{ context: 'ci/build', state: 'failure', description: 'Build failed', target_url: 'https://ci.example/1', updated_at: '2026-10-14T10:00:00Z', creator: { login: 'bot' } }] };
  const runs = { total_count: 1, check_runs: [{ id: 90, url: `${base}/check-runs/90`, head_sha: sha, name: 'test', status: 'completed',
    conclusion: 'success', started_at: '2026-10-14T10:00:00Z', completed_at: '2026-10-14T10:05:00Z', html_url: 'https://github.com/owner/example/runs/90', app: { slug: 'github-actions' }, output: { text: 'not returned' } }] };
  const routes = (changes = {}) => ({ routes: { [route('/pulls?per_page=100')]: pulls, [route('/status')]: status,
    [route('/check-runs?per_page=30&page=1')]: runs, ...changes } });
  assert.throws(() => f.read({ resource: 'checks', sha }), /identity first/);
  f.identity();
  for (const invalid of [{ resource: 'checks' }, { resource: 'checks', sha: 'C'.repeat(40) }, { resource: 'checks', sha: 'c'.repeat(39) },
    { resource: 'checks', sha, number: 5 }, { resource: 'pull', number: 5, sha }, { resource: 'checks', sha: `../${'c'.repeat(37)}` }]) {
    assert.throws(() => f.read(invalid));
  }
  f.respond(routes());
  const value = f.read({ resource: 'checks', sha });
  assert.deepEqual(f.args(), ['api', '--hostname', 'github.com', '--method', 'GET', route('/check-runs?per_page=30&page=1')]);
  assert.equal(value.untrusted, true);
  assert.equal(value.runId, f.config.runId);
  assert.equal(value.possiblyMore, false);
  assert.deepEqual(value.data, { sha, pulls: [5], state: 'failure',
    statuses: [{ context: 'ci/build', state: 'failure', description: 'Build failed', target_url: 'https://ci.example/1', updated_at: '2026-10-14T10:00:00Z' }],
    totalCheckRuns: 1, checkRuns: [{ id: 90, name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-10-14T10:00:00Z',
      completed_at: '2026-10-14T10:05:00Z', html_url: 'https://github.com/owner/example/runs/90', app: 'github-actions' }] });
  assert.ok(!JSON.stringify(value).includes('not returned'));
  // A commit that is not the head of a pull request here is refused before its status or checks are read.
  for (const notHead of [[], [pulls[1]]]) {
    f.respond(routes({ [route('/pulls?per_page=100')]: notHead }));
    assert.throws(() => f.read({ resource: 'checks', sha }), /not the head of a pull request in the assigned repository/);
    assert.equal(f.args().at(-1), route('/pulls?per_page=100'));
  }
  f.respond(routes()); assert.equal(f.read({ resource: 'checks', sha }).data.pulls[0], 5);
  for (const outside of [{ [route('/pulls?per_page=100')]: [{ ...pulls[0], url: 'https://api.github.com/repos/other/repo/pulls/5' }] },
    { [route('/status')]: { ...status, repository: { full_name: 'other/repo' } } }, { [route('/status')]: { ...status, sha: other } },
    { [route('/check-runs?per_page=30&page=1')]: { check_runs: [{ ...runs.check_runs[0], head_sha: other }] } },
    { [route('/check-runs?per_page=30&page=1')]: { check_runs: [{ ...runs.check_runs[0], url: 'https://api.github.com/repos/other/repo/check-runs/90' }] } }]) {
    const read = createGitHubReader(f.config);
    f.respond({ url: base, full_name: repository }); read({ resource: 'repository' });
    f.respond(routes(outside));
    assert.throws(() => read({ resource: 'checks', sha }), /outside/);
    f.respond(routes()); assert.throws(() => read({ resource: 'checks', sha }), /stopped after an upstream failure/);
  }
  const read = createGitHubReader(f.config);
  f.respond({ url: base, full_name: repository }); read({ resource: 'repository' });
  f.respond(routes({ [route('/status')]: { fail: true } }));
  assert.throws(() => read({ resource: 'checks', sha }), /GitHub read failed \(HTTP 403\)/);
  f.respond(routes()); assert.throws(() => read({ resource: 'checks', sha }), /stopped after an upstream failure/);
});
