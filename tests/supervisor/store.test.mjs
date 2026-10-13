// Durable operation account identity (docs/design/ACCOUNT_ADAPTER_CAAM.md section 3.1, slice CAAM1-STORE): a writer
// migrates an older store additively, legacy operations read account_identity as null, and a recorded identity
// survives close and reopen. Disposable stores only; no model, network or GitHub call.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { declaration, environment, SQLITE, skipWithoutSqlite } from './helpers.mjs';

const { Store, STORE_VERSION, ConflictError } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};

const operation = (id, extra = {}) => ({ id, campaign_id: 'test-campaign', task_id: 'T1', kind: 'implement',
  seq: 1, idempotency_key: id, lease_generation: 1, state: 'finished', session_id: `${id}-session`,
  run_dir: 'synthetic', workspace: 'synthetic', packet: {}, packet_digest: 'a'.repeat(64), created_at: 1, updated_at: 1,
  ...extra });
const columns = (store) => store.all('PRAGMA table_info(operations)').map((column) => column.name);

test('a new store has operations.account_identity TEXT', { skip: skipWithoutSqlite }, (t) => {
  const env = environment();
  t.after(() => env.cleanup());
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => store.close());
  const column = store.all('PRAGMA table_info(operations)').find((item) => item.name === 'account_identity');
  assert.ok(column, 'account_identity column exists');
  assert.equal(column.type, 'TEXT');
  assert.equal(column.notnull, 0);
  assert.equal(store.get('PRAGMA journal_mode').journal_mode, 'wal');
});

test('an older store migrates on writer open; legacy rows read null; a reader never migrates', { skip: skipWithoutSqlite }, (t) => {
  const env = environment();
  t.after(() => env.cleanup());
  const path = join(env.dataDir, 'legacy.db');
  const old = new Store(path);
  campaignStart(old, declaration());
  old.db.exec('ALTER TABLE operations DROP COLUMN account_identity');
  assert.ok(!columns(old).includes('account_identity'), 'the simulated legacy store lacks the column');
  old.insert('operations', operation('old-run'));
  old.close();

  const reader = new Store(path, { readOnly: true });
  try {
    assert.ok(!columns(reader).includes('account_identity'), 'a reader never migrates');
    assert.equal(reader.get('SELECT id FROM operations WHERE id = ?', 'old-run').id, 'old-run');
  } finally { reader.close(); }

  const migrated = new Store(path);
  t.after(() => migrated.close());
  assert.ok(columns(migrated).includes('account_identity'), 'the writer added the column');
  assert.equal(migrated.get("SELECT value FROM meta WHERE key = 'store_version'").value, String(STORE_VERSION), 'the store version is unchanged');
  const legacy = migrated.get('SELECT * FROM operations WHERE id = ?', 'old-run');
  assert.equal(legacy.account_identity, null);
  assert.equal(legacy.executor_kind, 'claude-cli');
  assert.equal(legacy.state, 'finished');
});

test('a recorded account_identity persists across close and reopen', { skip: skipWithoutSqlite }, (t) => {
  const env = environment();
  t.after(() => env.cleanup());
  const path = join(env.dataDir, 'supervisor.db');
  const first = new Store(path);
  campaignStart(first, declaration());
  first.tx(() => first.recordOperation(operation('with-account', { state: 'recorded', account_identity: 'claude/profile-a' })));
  first.tx(() => first.recordOperation(operation('without-account', { task_id: 'T2', idempotency_key: 'without-account', state: 'recorded', created_at: 2 })));
  assert.throws(() => first.tx(() => first.recordOperation(operation('second-open', { idempotency_key: 'second-open', state: 'recorded',
    account_identity: 'claude/profile-b' }))), ConflictError, 'the one-open-operation-per-task rule still holds');
  first.close();

  const reopened = new Store(path);
  t.after(() => reopened.close());
  assert.equal(reopened.get('SELECT account_identity FROM operations WHERE id = ?', 'with-account').account_identity, 'claude/profile-a');
  assert.equal(reopened.get('SELECT account_identity FROM operations WHERE id = ?', 'without-account').account_identity, null);
  assert.equal(reopened.get('SELECT id FROM operations WHERE id = ?', 'second-open'), null);
  const open = reopened.openOperations('test-campaign').map((op) => [op.id, op.account_identity]);
  assert.deepEqual(open, [['with-account', 'claude/profile-a'], ['without-account', null]]);
});

test('recordOperation refuses an account_identity that is not a non-empty string', { skip: skipWithoutSqlite }, (t) => {
  const env = environment();
  t.after(() => env.cleanup());
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => store.close());
  campaignStart(store, declaration());
  for (const [index, bad] of ['', 42, { id: 'claude/profile-a' }].entries()) {
    const id = `bad-${index}`;
    assert.throws(() => store.tx(() => store.recordOperation(operation(id, { idempotency_key: id, account_identity: bad }))), TypeError);
    assert.equal(store.get('SELECT id FROM operations WHERE id = ?', id), null, 'nothing was recorded');
  }
});
