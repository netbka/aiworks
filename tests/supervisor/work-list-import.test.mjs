// LO L10 (docs/design/LOCAL_OPERATION.md section 9, slice SELF10): the one-time issue import against a synthetic gh that
// serves one fictional repository. It sees only REST GET; a dry run writes nothing; a re-run keeps every item, the owner's
// edits and each comment once; secret-like text is never stored or printed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/supervisor/store.mjs';
import { comments, item, items, nextNumber } from '../../src/supervisor/work-list.mjs';
import { importIssues } from '../../src/supervisor/work-list-import.mjs';

const NOW = 1_760_000_000_000;
const REPOSITORY = 'example-org/aiworks-sample';
const GH = [process.execPath, fileURLToPath(new URL('./fixtures/fake-gh-issues.mjs', import.meta.url))];
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const url = (number) => `https://github.com/${REPOSITORY}/issues/${number}`;

// `count` open entries (105: two pages), every tenth a pull request; the newest number, #130, is a closed pull request.
// Issue #3 carries a credential in its body; issue #2 has 101 comments (two pages), one of which carries a credential.
function fixture(count) {
  const open = Array.from({ length: count }, (_, i) => i + 1).map((number) => (number % 10 === 0
    ? { number, title: `Pull request ${number}`, pull_request: { url: 'synthetic' }, html_url: `https://github.com/${REPOSITORY}/pull/${number}` }
    : { number, title: `Issue ${number}`, body: number === 3 ? `push with ${TOKEN}` : `Body ${number}`, html_url: url(number),
      labels: [{ name: 'synthetic' }], updated_at: '2026-10-18T00:00:00Z' }));
  const comment = (id, body) => ({ id, body, user: { login: 'example-user' }, created_at: '2026-10-17T12:00:00Z' });
  return { open, closed: [{ number: 130, title: 'Closed pull request', pull_request: { url: 'synthetic' } }],
    comments: { 2: Array.from({ length: 101 }, (_, i) => comment(2001 + i, i === 49 ? `API_TOKEN=${TOKEN}` : `Comment ${i}`)),
      4: [comment(4001, 'First comment')] } };
}

function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-work-import-'));
  const stores = [];
  const ghState = mkdtempSync(join(dir, 'gh-'));
  process.env.FAKE_GH_STATE = ghState;
  const open = () => { const store = new Store(join(dir, 'supervisor.db')); stores.push(store); return store; };
  t.after(() => { for (const store of stores) try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  const serve = (data) => writeFileSync(join(ghState, 'issues.json'), JSON.stringify(data));
  const calls = () => readFileSync(join(ghState, 'gh-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).args);
  return { open, serve, calls };
}

test('the import sends only GET, pages through every list, and a dry run changes neither the store nor GitHub', (t) => {
  const { open, serve, calls } = rig(t);
  const data = fixture(105);
  serve(data);
  const store = open();
  const report = importIssues({ store, gh: GH, repository: REPOSITORY, now: NOW });
  assert.equal(report.dryRun, true);
  assert.equal(report.highestNumber, 130);
  assert.equal(report.pullRequestsSkipped, 10);
  assert.equal(report.items.new.length, 94);
  assert.ok(!report.items.new.includes(3));
  assert.equal(report.comments.new, 101);
  assert.deepEqual(report.withheld, [{ number: 2, comment: 2050 }, { number: 3 }]);
  // Nothing written: no item, no comment, no number floor.
  assert.deepEqual(items(store), []);
  assert.equal(nextNumber(store), 1);
  // Without a store the dry run reads the same.
  assert.deepEqual(importIssues({ store: null, gh: GH, repository: REPOSITORY, now: NOW }), report);

  const seen = calls();
  for (const args of seen) {
    assert.equal(args[0], 'api');
    assert.equal(args[args.indexOf('--method') + 1], 'GET');
    assert.ok(!args.some((arg) => /graphql/i.test(arg)));
  }
  const pagesOf = (path) => seen.filter((args) => args.includes(path)).map((args) => args.find((arg) => arg.startsWith('page=')));
  assert.ok(pagesOf(`repos/${REPOSITORY}/issues`).includes('page=2'));
  assert.ok(pagesOf(`repos/${REPOSITORY}/issues/2/comments`).includes('page=2'));
  // The served data, the only "remote", is untouched.
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.FAKE_GH_STATE, 'issues.json'), 'utf8')), data);
});

test('a repeated import keeps identities and owner edits, adds each comment once and never stores a credential', (t) => {
  const { open, serve } = rig(t);
  const data = fixture(12);
  serve(data);
  const store = open();
  const first = importIssues({ store, gh: GH, repository: REPOSITORY, dryRun: false, now: NOW });
  assert.equal(first.items.new.length, 10);
  assert.equal(nextNumber(store), 131);
  const four = item(store, 4);
  assert.equal(four.author_kind, 'import');
  assert.equal(four.source_url, url(4));
  assert.equal(four.source_updated_at, '2026-10-18T00:00:00Z');
  assert.equal(item(store, 3), null);
  assert.equal(item(store, 10), null);
  assert.deepEqual(comments(store, 4).map(({ author, created_at: at }) => ({ author, at })),
    [{ author: 'example-user', at: Date.parse('2026-10-17T12:00:00Z') }]);
  assert.equal(comments(store, 2).length, 100);

  // The owner edits an imported item locally; on GitHub issue #5 changes and #4 gets a new comment.
  store.run('UPDATE work_items SET body = ? WHERE number = ?', 'Owner notes', 4);
  store.close();
  data.open[4].body = 'Rewritten on GitHub';
  data.comments[4].push({ id: 4002, body: 'Second comment', user: { login: 'example-user' }, created_at: '2026-10-19T08:00:00Z' });
  serve(data);

  const reopened = open();
  const second = importIssues({ store: reopened, gh: GH, repository: REPOSITORY, dryRun: false, now: NOW + 1 });
  assert.deepEqual(second.items.new, []);
  assert.equal(second.items.existing.length, 10);
  assert.equal(second.comments.new, 1);
  assert.deepEqual(second.changed.map(({ number, fields }) => ({ number, fields })), [{ number: 4, fields: ['body'] }, { number: 5, fields: ['body'] }]);
  assert.equal(item(reopened, 4).body, 'Owner notes');
  assert.equal(item(reopened, 5).body, 'Body 5');
  assert.deepEqual(comments(reopened, 4).map((comment) => comment.body), ['First comment', 'Second comment']);
  assert.equal(importIssues({ store: reopened, gh: GH, repository: REPOSITORY, dryRun: false, now: NOW + 2 }).comments.new, 0);
  assert.equal(comments(reopened, 4).length, 2);

  // The credential is in neither the store nor any report.
  const everything = JSON.stringify([first, second, items(reopened).map(({ number }) => [item(reopened, number), comments(reopened, number)])]);
  assert.ok(!everything.includes(TOKEN));
});
