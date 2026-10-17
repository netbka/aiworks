// Task model signature and account preferences tests
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { campaignStart, campaignStatus } from '../../src/supervisor/api.mjs';
import { buildTaskSignature, formatSignatureLines, formatTokensUsage, formatTokensSummary,
  modelPreferences, setRoleModelPreference, clearRoleModelPreferences, applyModelPreferences, preferenceFor, roleModelOrder } from '../../src/supervisor/accounts.mjs';
import { declaration, environment, SQLITE, skipWithoutSqlite } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};

test('formatTokensUsage and buildTaskSignature format model signature with name, type, effort, tokens', () => {
  const usage = {
    input_tokens: 15200,
    output_tokens: 840,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 1000,
  };
  const tokens = formatTokensUsage(usage);
  assert.equal(tokens.input, 15200);
  assert.equal(tokens.output, 840);
  assert.equal(tokens.cacheRead, 5000);
  assert.equal(tokens.cacheCreation, 1000);
  assert.equal(tokens.total, 17040);

  const summary = formatTokensSummary(tokens);
  assert.ok(summary.includes('17,040 tokens'));
  assert.ok(summary.includes('15,200 in'));
  assert.ok(summary.includes('840 out'));
  assert.ok(summary.includes('5,000 cached'));

  const sig = buildTaskSignature({
    model: 'claude-3-7-sonnet',
    executorKind: 'claude-cli',
    effort: 'high',
    usage,
    verifier: {
      model: 'gpt-4o',
      executorKind: 'codex',
      effort: 'standard',
      usage: { input_tokens: 4000, output_tokens: 200 },
    },
  });

  assert.equal(sig.name, 'claude-3-7-sonnet');
  assert.equal(sig.type, 'claude-cli');
  assert.equal(sig.effort, 'high');
  assert.equal(sig.tokens.total, 17040);
  assert.ok(sig.verifier);
  assert.equal(sig.verifier.name, 'gpt-4o');
  assert.equal(sig.verifier.type, 'codex');
  assert.equal(sig.verifier.effort, 'standard');
  assert.equal(sig.verifier.tokens.total, 4200);

  const lines = formatSignatureLines(sig);
  assert.ok(lines.some((l) => l.includes('- **Implementer**: `claude-3-7-sonnet` (claude-cli) · Effort: high · Tokens: 17,040 tokens (15,200 in, 840 out, 5,000 cached)')));
  assert.ok(lines.some((l) => l.includes('- **Verifier**: `gpt-4o` (codex) · Effort: standard · Tokens: 4,200 tokens (4,000 in, 200 out)')));
});

test('buildTaskSignature handles missing token usage gracefully (tokens: null)', () => {
  const sig = buildTaskSignature({
    model: 'cursor-fast',
    executorKind: 'cursor',
    effort: 'standard',
    usage: null,
  });
  assert.equal(sig.name, 'cursor-fast');
  assert.equal(sig.type, 'cursor');
  assert.equal(sig.effort, 'standard');
  assert.equal(sig.tokens, null);

  const lines = formatSignatureLines(sig);
  assert.ok(lines.some((l) => l.includes('- **Implementer**: `cursor-fast` (cursor) · Effort: standard · Tokens: unreported')));
});

test('tasks table stores signature JSON and persists across database close and reopen', { skip: skipWithoutSqlite }, (t) => {
  const env = environment();
  t.after(() => env.cleanup());
  const dbPath = join(env.dataDir, 'supervisor.db');
  const store = new Store(dbPath);

  const decl = declaration();
  campaignStart(store, decl);

  // Check columns in tasks table
  const cols = store.all('PRAGMA table_info(tasks)').map((c) => c.name);
  assert.ok(cols.includes('signature'), 'signature column exists in tasks table');

  // Initially signature is null
  const initialTask = store.get('SELECT * FROM tasks WHERE campaign_id = ? AND task_id = ?', decl.campaignId, 'T1');
  assert.equal(initialTask.signature, null);

  // Update task with signature
  const signatureData = {
    name: 'claude-3-5-sonnet',
    type: 'claude-cli',
    effort: 'standard',
    tokens: { input: 1000, output: 200, total: 1200 },
  };
  store.run('UPDATE tasks SET signature = ? WHERE campaign_id = ? AND task_id = ?', signatureData, decl.campaignId, 'T1');

  // Re-read from active store
  const updatedTask = store.get('SELECT * FROM tasks WHERE campaign_id = ? AND task_id = ?', decl.campaignId, 'T1');
  assert.deepEqual(updatedTask.signature, signatureData);

  // Close and reopen store to verify durability
  store.close();
  const reopenedStore = new Store(dbPath);
  t.after(() => reopenedStore.close());

  const persistedTask = reopenedStore.get('SELECT * FROM tasks WHERE campaign_id = ? AND task_id = ?', decl.campaignId, 'T1');
  assert.deepEqual(persistedTask.signature, signatureData);

  // Check campaignStatus exposes signature
  const status = campaignStatus(reopenedStore, decl.campaignId);
  const statusTask = status.tasks.find((task) => task.id === 'T1');
  assert.deepEqual(statusTask.signature, signatureData);
});

test('legacy store without signature column migrates additively on open', { skip: skipWithoutSqlite }, (t) => {
  const env = environment();
  t.after(() => env.cleanup());
  const path = join(env.dataDir, 'legacy.db');
  const old = new Store(path);
  const decl = declaration();
  campaignStart(old, decl);
  old.db.exec('ALTER TABLE tasks DROP COLUMN signature');
  const oldCols = old.all('PRAGMA table_info(tasks)').map((c) => c.name);
  assert.ok(!oldCols.includes('signature'), 'simulated legacy store lacks signature column');
  old.close();

  // Reopen with current Store class - migration should add signature column additively
  const migrated = new Store(path);
  t.after(() => migrated.close());
  const newCols = migrated.all('PRAGMA table_info(tasks)').map((c) => c.name);
  assert.ok(newCols.includes('signature'), 'migrated store contains signature column');

  // Existing task reads signature as null
  const existing = migrated.get('SELECT * FROM tasks WHERE campaign_id = ? AND task_id = ?', decl.campaignId, 'T1');
  assert.equal(existing.signature, null);
});

test('modelPreferences helper manages role order and candidate sorting', (t) => {
  const env = environment();
  t.after(() => env.cleanup());

  // 1. Initial empty preferences
  const emptyPrefs = modelPreferences({});
  assert.deepEqual(emptyPrefs.implementer, []);
  assert.deepEqual(emptyPrefs.verification, []);

  // 2. Set role preference
  setRoleModelPreference(env.dataDir, 'implementer', ['claude-3-7-sonnet', 'claude-3-5-sonnet']);
  setRoleModelPreference(env.dataDir, 'verification', ['gpt-4o']);

  const storeFile = join(env.dataDir, 'config.json');
  const loadedPrefs = modelPreferences(JSON.parse(execFileSync(process.execPath, ['-e', `console.log(require('fs').readFileSync(${JSON.stringify(storeFile)}, 'utf8'))`], { encoding: 'utf8' })));
  assert.deepEqual(loadedPrefs.implementer, ['claude-3-7-sonnet', 'claude-3-5-sonnet']);
  assert.deepEqual(loadedPrefs.verification, ['gpt-4o']);

  // 3. Candidate sorting
  const candidates = [
    { kind: 'claude-cli', model: 'claude-3-5-haiku' },
    { kind: 'claude-cli', model: 'claude-3-5-sonnet' },
    { kind: 'claude-cli', model: 'claude-3-7-sonnet' },
  ];
  const sorted = applyModelPreferences(candidates, 'implementer', { modelPreferences: loadedPrefs });
  assert.equal(sorted[0].model, 'claude-3-7-sonnet');
  assert.equal(sorted[1].model, 'claude-3-5-sonnet');
  assert.equal(sorted[2].model, 'claude-3-5-haiku');

  // 4. Clear role preference
  clearRoleModelPreferences(env.dataDir, 'implementer');
  const afterClear = modelPreferences(JSON.parse(execFileSync(process.execPath, ['-e', `console.log(require('fs').readFileSync(${JSON.stringify(storeFile)}, 'utf8'))`], { encoding: 'utf8' })));
  assert.deepEqual(afterClear.implementer, []);
  assert.deepEqual(afterClear.verification, ['gpt-4o']);
});

test('cli.mjs account commands manage preferences and list accounts', (t) => {
  const env = environment();
  t.after(() => env.cleanup());
  const cliPath = join(process.cwd(), 'src', 'supervisor', 'cli.mjs');

  // 1. account preferences (empty)
  const prefsInitial = JSON.parse(execFileSync(process.execPath, [cliPath, 'account', 'preferences', '--data', env.dataDir], { encoding: 'utf8' }));
  assert.ok(prefsInitial.preferences);
  assert.deepEqual(prefsInitial.preferences.implementer, []);

  // 2. account set-preference implementer claude-3-7-sonnet claude-3-5-sonnet --effort high
  const setOut = JSON.parse(execFileSync(process.execPath, [cliPath, 'account', 'set-preference', 'implementer', 'claude-3-7-sonnet', 'claude-3-5-sonnet', '--effort', 'high', '--data', env.dataDir], { encoding: 'utf8' }));
  assert.equal(setOut.success, true);
  assert.equal(setOut.role, 'implementer');
  assert.equal(setOut.preferences[0].model, 'claude-3-7-sonnet');
  assert.equal(setOut.preferences[0].effort, 'high');

  // 3. account preferences (reflects saved preferences)
  const prefsAfter = JSON.parse(execFileSync(process.execPath, [cliPath, 'account', 'preferences', '--data', env.dataDir], { encoding: 'utf8' }));
  assert.equal(prefsAfter.preferences.implementer[0].model, 'claude-3-7-sonnet');
  assert.equal(prefsAfter.preferences.implementer[0].effort, 'high');

  // 4. account clear-preferences implementer
  const clearOut = JSON.parse(execFileSync(process.execPath, [cliPath, 'account', 'clear-preferences', 'implementer', '--data', env.dataDir], { encoding: 'utf8' }));
  assert.equal(clearOut.success, true);
  assert.equal(clearOut.cleared, 'implementer');

  // 5. account list
  const listOut = JSON.parse(execFileSync(process.execPath, [cliPath, 'account', 'list', '--data', env.dataDir], { encoding: 'utf8' }));
  assert.ok(Array.isArray(listOut.accounts));
});

test('a malformed model order in config.json never throws in dispatch: it reads as AIWorks’ own order', () => {
  // The shape an earlier dashboard saved ({ models, effort, kind } per role) made executorChoice throw on every tick.
  const broken = { modelPreferences: { implementer: { models: ['model-a'], effort: 'high' }, verification: [null, 'model-b', { model: 'model-c', kind: 'codex-cli' }] } };
  const chosen = { kind: 'claude-cli' };
  assert.deepEqual(roleModelOrder(broken, 'implementer'), []);
  assert.equal(preferenceFor(broken, 'implementer', chosen), null);
  assert.equal(preferenceFor(broken, 'verification', chosen), null, 'a null entry matches no candidate');
  assert.deepEqual(preferenceFor(broken, 'verification', { kind: 'codex-cli', model: 'model-c' }), { model: 'model-c', kind: 'codex-cli' });
  const candidates = [{ kind: 'claude-cli', model: 'model-a' }, { kind: 'codex-cli', model: 'model-b' }];
  assert.deepEqual(applyModelPreferences(candidates, 'implementer', broken), candidates);
  assert.deepEqual(modelPreferences(broken), { implementer: [], verification: broken.modelPreferences.verification });
  assert.deepEqual(modelPreferences({ modelPreferences: { coordinator: ['model-a'] } }), { implementer: [], verification: [] }, 'only the roles dispatch reads');
});
