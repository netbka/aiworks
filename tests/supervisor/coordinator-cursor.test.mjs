import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { environment, SQLITE, skipWithoutSqlite } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const coordinator = SQLITE ? await import('../../src/supervisor/coordinator.mjs') : {};

test('a native nullable coordinator envelope keeps planning moving without relaxing identity or scope', { skip: skipWithoutSqlite }, () => {
  const sessionId = randomUUID(), nativeSession = randomUUID(), digest = 'a'.repeat(64), model = 'Example Low';
  const value = { summary: 'Scoped plan', reply: 'Continue the registered work.', newWork: [], plan: 'Keep the approved order.' };
  const envelope = { runId: sessionId, packetDigest: digest, result: { result: 'resolved', summary: 'Plan',
    headSha: null, report: JSON.stringify(value), evidence: null, ownerTrigger: null, tried: null, decision: null } };
  const initial = { type: 'system', subtype: 'init', session_id: nativeSession, apiKeySource: 'login', model };
  const classify = (body = envelope, init = initial, extra = []) => coordinator.classifyCursorCoordinator({
    run: { session_id: sessionId }, spec: { packetDigest: digest, nativeModel: model, repositories: ['example-org/sampleapp'] },
    result: { exitCode: 0 }, now: 1, stderrText: '', stdoutText: [init, ...extra,
      { type: 'result', subtype: 'success', is_error: false, session_id: nativeSession, result: JSON.stringify(body) }].map(JSON.stringify).join('\n'),
  });
  assert.deepEqual(classify(), { class: 'result', value, costUsd: null });
  assert.equal(classify({ ...envelope, runId: randomUUID() }).class, 'invalid-result');
  assert.equal(classify({ ...envelope, packetDigest: 'b'.repeat(64) }).class, 'invalid-result');
  assert.equal(classify(envelope, { ...initial, model: 'Other model' }).class, 'invalid-result');
  assert.notEqual(classify(envelope, { ...initial, apiKeySource: 'api-key' }).class, 'result');
  assert.notEqual(classify(envelope, initial, [{ type: 'tool_call' }]).class, 'result');
  const foreign = { ...value, newWork: [{ repository: 'example-org/unassigned', number: 1, kind: 'issue',
    title: 'Unassigned', classification: 'no-action', reason: 'Outside the grant' }] };
  assert.equal(classify({ ...envelope, result: { ...envelope.result, report: JSON.stringify(foreign) } }).class, 'invalid-result');
});

test('a selected message cannot give the Cursor coordinator access to a repository outside its grant', { skip: skipWithoutSqlite }, () => {
  const allowed = ['example-org/sampleapp'];
  assert.deepEqual(coordinator.cursorRepositoryScope([{ repository: 'example-org/sampleapp' }], allowed), allowed);
  assert.throws(() => coordinator.cursorRepositoryScope([{ repository: 'example-org/unassigned' }], allowed), /outside its configured grant/);
});

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
