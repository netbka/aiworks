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
import { closeCandidates, closeConfirmedIssues, importIssues } from '../../src/supervisor/work-list-import.mjs';
import { checkCaller } from '../../src/supervisor/local-admission.mjs';

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

// LO L11 (slice SELF11): closing imported issues after the owner confirms the list, against the same synthetic gh.
const ownerCaller = (store) => checkCaller(store, { platform: 'win32', lookup: async () => ({ pid: 7001, ancestors: [7000], jobs: [] }) });
// A worker started by AIWorks: the process above it is AIWorks itself.
const workerCaller = (store) => checkCaller(store, { platform: 'win32', lookup: async () => ({ pid: 7002, ancestors: [process.pid], jobs: [] }) });
const writes = (calls) => calls().filter((args) => args[args.indexOf('--method') + 1] !== 'GET');

function imported(t, count) {
  const { open, serve, calls } = rig(t);
  const base = fixture(count);
  const data = { ...base, open: base.open.map((issue) => ({ ...issue, state: 'open' })), writable: true, clock: '2026-10-19T09:00:00Z' };
  serve(data);
  const store = open();
  importIssues({ store, gh: GH, repository: REPOSITORY, dryRun: false, now: NOW });
  const remote = () => JSON.parse(readFileSync(join(process.env.FAKE_GH_STATE, 'issues.json'), 'utf8'));
  return { store, serve, calls, data, remote };
}

test('only the confirmed, unchanged imported issues are closed, and only for the owner', async (t) => {
  const { store, serve, calls, data, remote } = imported(t, 9);
  const close = (selection, options = {}) => closeConfirmedIssues({ store, gh: GH, repository: REPOSITORY, selection,
    caller: ownerCaller, now: NOW, available: true, ...options });
  const all = closeCandidates(store, REPOSITORY);
  assert.deepEqual(all.map((entry) => entry.number), [1, 2, 4, 5, 6, 7, 8, 9]);
  const selection = all.filter((entry) => [2, 4, 5].includes(entry.number));
  const before = calls().length;

  // Switched off by default; a worker, an unchecked caller and stale or foreign entries are refused before any gh call.
  await assert.rejects(closeConfirmedIssues({ store, gh: GH, repository: REPOSITORY, selection, caller: ownerCaller, now: NOW }), { code: 'WORK_CLOSE_OFF' });
  await assert.rejects(close(selection, { caller: workerCaller }), { code: 'WORK_CLOSE_FROM_AIWORKS' });
  await assert.rejects(close(selection, { caller: null }), { code: 'WORK_CLOSE_UNCHECKED' });
  await assert.rejects(close([...selection, { ...all[0], updatedAt: '2026-10-01T00:00:00Z' }]), { code: 'WORK_CLOSE_STALE' });
  await assert.rejects(close([{ ...selection[0], repository: 'example-org/other' }]), { code: 'WORK_CLOSE_STALE' });
  await assert.rejects(close([{ repository: REPOSITORY, number: 3, updatedAt: '2026-10-18T00:00:00Z', version: 'x' }]), { code: 'WORK_CLOSE_STALE' });
  store.run('UPDATE work_items SET body = ? WHERE number = ?', 'Owner notes', 4);
  await assert.rejects(close(selection), { code: 'WORK_CLOSE_STALE' });
  assert.equal(calls().length, before);

  // Confirmed again; #5 then changes on GitHub and is skipped.
  const fresh = closeCandidates(store, REPOSITORY).filter((entry) => [2, 4, 5].includes(entry.number));
  data.open.find((issue) => issue.number === 5).updated_at = '2026-10-19T08:00:00Z';
  serve(data);
  const report = await close(fresh);
  assert.deepEqual(report.closed, [2, 4]);
  assert.deepEqual(report.skipped.map((entry) => entry.number), [5]);

  const after = remote();
  for (const number of [2, 4]) {
    const issue = after.closed.find((entry) => entry.number === number);
    assert.deepEqual([issue.state, issue.state_reason, issue.labels], ['closed', 'not_planned', [{ name: 'synthetic' }]]);
    assert.equal(after.comments[number].filter((comment) => comment.body.includes(`aiworks:work-list-moved:${number}`)).length, 1);
  }
  assert.deepEqual(after.open.map((issue) => issue.number), [1, 3, 5, 6, 7, 8, 9]);
  // Every write named a confirmed issue: one comment and one state change each, nothing else.
  assert.deepEqual(writes(calls).map((args) => `${args[args.indexOf('--method') + 1]} ${args.find((arg) => arg.startsWith('repos/'))}`), [
    `POST repos/${REPOSITORY}/issues/2/comments`, `PATCH repos/${REPOSITORY}/issues/2`,
    `POST repos/${REPOSITORY}/issues/4/comments`, `PATCH repos/${REPOSITORY}/issues/4`]);
});

test('a crash after the pointer or after the close neither comments twice nor writes again', async (t) => {
  const { store, serve, calls, data, remote } = imported(t, 4);
  const close = (selection) => closeConfirmedIssues({ store, gh: GH, repository: REPOSITORY, selection, caller: ownerCaller,
    now: NOW, available: true });
  const selection = closeCandidates(store, REPOSITORY).filter((entry) => [1, 2].includes(entry.number));

  serve({ ...data, crashAfter: 'comment' });
  await assert.rejects(close(selection));
  const report = await close(selection);
  assert.deepEqual([report.closed, report.skipped], [[1, 2], []]);
  const after = remote();
  for (const number of [1, 2]) {
    assert.equal(after.comments[number].filter((comment) => comment.body.includes(`aiworks:work-list-moved:${number}`)).length, 1);
    assert.equal(after.closed.find((entry) => entry.number === number).state_reason, 'not_planned');
  }

  // The close of #4 lands but its answer is lost: the retry records it and writes nothing.
  const four = closeCandidates(store, REPOSITORY).filter((entry) => entry.number === 4);
  serve({ ...after, crashAfter: 'close' });
  await assert.rejects(close(four));
  const count = writes(calls).length;
  assert.deepEqual((await close(four)).alreadyClosed, [4]);
  assert.deepEqual((await close(four)).alreadyClosed, [4]);
  assert.equal(writes(calls).length, count);
  assert.equal(remote().comments[4].filter((comment) => comment.body.includes('aiworks:work-list-moved:4')).length, 1);
  assert.deepEqual(remote().open.map((issue) => issue.number), [3]);
});
