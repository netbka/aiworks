// LO L5 (docs/design/LOCAL_OPERATION.md section 9, slice SELF5): the local work list in a disposable store. Append-only
// comments, the idempotency key across a restart, numbering that keeps imported issue numbers, the body bound and the
// credential check. No git, network or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { addComment, comments, createItem, followUp, item, items, settleSubject, subjectLabel } from '../../src/supervisor/work-list.mjs';

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

test('a retry of the same work shares one not-done item, and only a clean finish of that work closes it', (t) => {
  const { store } = rig(t);
  const decl = { purpose: 'Analyse request 7', target: { repository: 'example/app' } };
  const subject = subjectLabel(decl, 'ANALYZE');
  const notDone = (campaignId, extra = {}) => followUp(store, { campaignId, taskId: 'ANALYZE', key: 'not-done', subject, now: NOW,
    title: 'Finish ANALYZE', body: 'Not done.', fallback: 'Not done.', ...extra });
  const first = notDone('analyse-7-a');
  assert.equal(notDone('analyse-7-b').number, first.number, 'the retry comments on the open item instead of adding one');
  assert.equal(notDone('analyse-7-b').number, first.number);
  assert.equal(comments(store, first.number).length, 1, 'a repeated retry report records nothing twice');
  const other = followUp(store, { campaignId: 'analyse-8-a', taskId: 'ANALYZE', key: 'not-done', subject: subjectLabel({ ...decl, purpose: 'Analyse request 8' }, 'ANALYZE'),
    now: NOW, title: 'Finish ANALYZE', body: 'Not done.', fallback: 'Not done.' });
  const defects = followUp(store, { campaignId: 'analyse-7-a', taskId: 'ANALYZE', key: 'abc123', subject, now: NOW, title: 'Fix the known defects', body: 'Defects.', fallback: 'Defects.' });
  assert.deepEqual(settleSubject(store, { subject, campaignId: 'analyse-7-c', taskId: 'ANALYZE', now: NOW }), [first.number]);
  assert.equal(item(store, first.number).state, 'closed');
  assert.equal(item(store, other.number).state, 'open', 'other work stays open');
  assert.equal(item(store, defects.number).state, 'open', 'known defects are not shown fixed by a later pass');
  assert.equal(subjectLabel({ target: { repository: 'example/app' } }, 'ANALYZE'), null, 'no purpose, no subject');
});
