import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { environment, SQLITE, skipWithoutSqlite } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const coordinator = SQLITE ? await import('../../src/supervisor/coordinator.mjs') : {};

test('Cursor coordinator requires an included model attestation and never falls back to Claude', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  env.config.coordinator = { repositories: ['example-org/sampleapp'], executorKind: 'cursor-cli', model: 'grok-4.7-low',
    allowedModels: ['grok-4.7-low'], nativeModel: 'Grok 4.7 256K Low',
    includedOnly: { attestedBy: 'owner', paidOverages: false, recordedAt: '2026-01-01' } };
  const store = new Store(`${env.dataDir}/supervisor.db`);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  assert.equal(coordinator.coordinatorConfigError(env.config.coordinator), null);
  assert.match(coordinator.coordinatorConfigError({ ...env.config.coordinator, includedOnly: false }), /includedOnly/);
  assert.match(coordinator.coordinatorConfigError({ ...env.config.coordinator, model: 'other-model' }), /allowedModels/);
  coordinator.postOwnerMessage(store, { text: 'Review the sample project.', repository: 'example-org/sampleapp', requestId: randomUUID() });

  await controller.tick();

  assert.equal(store.get('SELECT state FROM owner_messages').state, 'received');
  assert.equal(env.calls().length, 0, 'Claude is configured by the fixture but must not receive a Cursor request');
  assert.match(coordinator.coordinatorView(store, env.config).blocked, /cursor-cli coordinator command is unavailable/);
});
