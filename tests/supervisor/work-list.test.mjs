// LO L5 (docs/design/LOCAL_OPERATION.md section 9, slice SELF5): the local work list in a disposable store. Append-only
// comments, the idempotency key across a restart, numbering that keeps imported issue numbers, the body bound and the
// credential check. No git, network or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { addComment, comments, createItem, item, items, MAX_BODY_BYTES, nextNumber, raiseNumberFloor } from '../../src/supervisor/work-list.mjs';

const NOW = 1_760_000_000_000;

function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-work-list-'));
  const stores = [];
  const open = (options) => { const store = new Store(join(dir, 'supervisor.db'), options); stores.push(store); return store; };
  t.after(() => { for (const store of stores) try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  return { open, store: open() };
}
const code = (expected) => (error) => error.code === expected;

test('comments are append-only and a repeated idempotency key after a restart records nothing', (t) => {
  const { open, store } = rig(t);
  const { number } = createItem(store, { kind: 'review', title: 'Verified head of SELF5', authorKind: 'supervisor', now: NOW });
  const first = addComment(store, { number, idempotencyKey: 'repair:run-1', body: 'Repair head abc.', authorKind: 'supervisor', now: NOW });
  assert.equal(first.created, true);
  assert.throws(() => store.run('UPDATE work_item_comments SET body = ? WHERE seq = ?', 'rewritten', first.comment.seq), /append-only/);
  assert.throws(() => store.run('DELETE FROM work_item_comments WHERE seq = ?', first.comment.seq), /append-only/);
  assert.throws(() => store.run('DELETE FROM work_items WHERE number = ?', number), /never deleted/);
  store.close();

  // A crash after recording: the restarted supervisor repeats the same comment with the same key.
  const reopened = open();
  const again = addComment(reopened, { number, idempotencyKey: 'repair:run-1', body: 'Repair head abc.', authorKind: 'supervisor', now: NOW + 1 });
  assert.equal(again.created, false);
  assert.equal(again.comment.seq, first.comment.seq);
  assert.deepEqual(comments(reopened, number).map((comment) => comment.body), ['Repair head abc.']);
  assert.equal(addComment(reopened, { number, idempotencyKey: 'repair:run-2', body: 'Second head.', authorKind: 'supervisor', now: NOW + 2 }).created, true);
  assert.deepEqual(comments(reopened, number).map((comment) => comment.idempotency_key), ['repair:run-1', 'repair:run-2']);
});

test('imported items keep their GitHub numbers and new items are numbered after the highest number seen', (t) => {
  const { open, store } = rig(t);
  createItem(store, { number: 14, kind: 'task', title: 'Program tracking page', authorKind: 'import', source: { url: 'https://github.com/example-org/aiworks/issues/14', updatedAt: '2026-10-16T00:00:00Z' }, now: NOW });
  createItem(store, { number: 3, kind: 'finding', title: 'An older issue', authorKind: 'import', now: NOW });
  assert.throws(() => createItem(store, { number: 14, kind: 'task', title: 'Duplicate', authorKind: 'import', now: NOW }), code('WORK_ITEM_EXISTS'));
  assert.throws(() => createItem(store, { number: 99, kind: 'note', title: 'Chosen number', authorKind: 'owner', now: NOW }), code('WORK_ITEM_INVALID'));
  // Pull request #40 was the highest GitHub number seen: a new item never takes a number a declaration could mean.
  assert.equal(raiseNumberFloor(store, 40), 40);
  assert.equal(raiseNumberFloor(store, 20), 40);
  assert.equal(createItem(store, { kind: 'decision', title: 'Owner decision', needsOwner: true, authorKind: 'supervisor', now: NOW }).number, 41);
  store.close();

  const reopened = open();
  assert.equal(nextNumber(reopened), 42);
  assert.equal(item(reopened, 14).title, 'Program tracking page');
  assert.deepEqual(items(reopened).map((row) => row.number), [41, 14, 3]);
  // The read-only view the CLI uses sees the same list.
  assert.deepEqual(items(open({ readOnly: true }), { state: 'open' }).map((row) => row.number), [41, 14, 3]);
});

test('a body up to 1 MiB is stored whole, a larger one is refused', (t) => {
  const { store } = rig(t);
  const report = `# Report\n${'Verified line.\n'.repeat(Math.floor((MAX_BODY_BYTES - 9) / 15))}`;
  assert.ok(report.length > 65_536 && Buffer.byteLength(report) <= MAX_BODY_BYTES);
  const { number } = createItem(store, { kind: 'review', title: 'Long report', body: report, authorKind: 'supervisor', now: NOW });
  assert.equal(item(store, number).body, report);
  addComment(store, { number, idempotencyKey: 'report', body: report, authorKind: 'supervisor', now: NOW });
  assert.equal(comments(store, number)[0].body, report);
  // Multi-byte text is measured in bytes, so no stored body exceeds the bound.
  const over = 'é'.repeat(MAX_BODY_BYTES / 2 + 1);
  assert.throws(() => createItem(store, { kind: 'note', title: 'Too long', body: over, authorKind: 'owner', now: NOW }), code('WORK_ITEM_TOO_LARGE'));
  assert.throws(() => addComment(store, { number, idempotencyKey: 'over', body: over, authorKind: 'owner', now: NOW }), code('WORK_ITEM_TOO_LARGE'));
  assert.equal(comments(store, number).length, 1);
});

test('secret-like text is refused and nothing is stored', (t) => {
  const { store } = rig(t);
  const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
  assert.throws(() => createItem(store, { kind: 'finding', title: 'Leak', body: `use ${token} to push`, authorKind: 'import', number: 7, now: NOW }), code('WORK_ITEM_SECRET'));
  assert.throws(() => createItem(store, { kind: 'finding', title: `API_KEY=${'s3cr3tValue'.repeat(2)}`, authorKind: 'owner', now: NOW }), code('WORK_ITEM_SECRET'));
  assert.throws(() => createItem(store, { kind: 'finding', title: 'Labels', labels: [token], authorKind: 'owner', now: NOW }), code('WORK_ITEM_SECRET'));
  assert.deepEqual(items(store), []);
  const { number } = createItem(store, { kind: 'note', title: 'Clean', body: 'API_KEY=<your-key> is a placeholder', authorKind: 'owner', now: NOW });
  assert.throws(() => addComment(store, { number, idempotencyKey: 'k', body: ['-----BEGIN RSA', 'PRIVATE KEY-----\nMIIE'].join(' '), authorKind: 'supervisor', now: NOW }), code('WORK_ITEM_SECRET'));
  assert.deepEqual(comments(store, number), []);
});
