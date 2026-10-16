// A verification retried after the controller refused its predecessor's result is told why (aiworks#59): the next packet
// for the same head carries the recorded refusal as one controller note, the prompt states it, and a new head carries none.
// Synthetic workers only; no model, network or GitHub access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT, declaration, runUntil, skipWithoutSqlite } from './helpers.mjs';
import { NONE, setup } from './unlimited-harness.mjs';
import { packetDigest, validatePacket } from '../../scripts/lib/worker-context.mjs';

const POLICY = JSON.parse(readFileSync(join(ROOT, 'registry', 'worker-context-policy.json'), 'utf8'));
const NOTE = /Controller note: the previous verification of ([0-9a-f]{40}) was refused as invalid-result: /;

function dispatched(store, id, name) {
  const op = store.get('SELECT run_dir, packet_digest, target_sha FROM operations WHERE id = ?', `${id}.T1.${name}`);
  const prompt = readFileSync(join(op.run_dir, 'prompt.txt'), 'utf8');
  const packet = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt)[1]);
  return { ...op, prompt, packet, notes: packet.constraints.filter((item) => NOTE.test(item)) };
}

test('a verifier that accepted with a failed check is refused, and the next verifier of that head is told why; a new head is not (aiworks#59)', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: NONE });
  const { store, controller, id } = setup(t, { decl, scenario: { implement: ['commit', 'commit'], verify: ['accept-failed-check', 'reject', 'accept'] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished', { timeoutMs: 120_000 });
  const first = dispatched(store, id, 'verify.2'), retried = dispatched(store, id, 'verify.3'), fresh = dispatched(store, id, 'verify.5');
  assert.deepEqual(first.notes, [], 'the first verification of a head carries no note');
  assert.equal(retried.target_sha, first.target_sha, 'the retry verifies the same head');
  const note = `Controller note: the previous verification of ${first.target_sha} was refused as invalid-result: accepted with a failed check. Verify this head again from the start and return a result that does not repeat that contradiction; scope, acceptance and your independence are unchanged.`;
  assert.deepEqual(retried.notes, [note], 'the retried packet carries exactly the recorded refusal');
  assert.equal(retried.prompt.split(note).length - 1, 2, 'the prompt states the note after the packet as well as inside it');
  // The note is a packet constraint: the packet still validates and its recorded digest covers it.
  assert.doesNotThrow(() => validatePacket(retried.packet, POLICY));
  assert.equal(packetDigest(retried.packet, POLICY), retried.packet_digest);
  assert.notEqual(retried.packet_digest, first.packet_digest);
  assert.deepEqual(retried.packet.references, first.packet.references, 'the note adds no reference');
  assert.deepEqual(retried.packet.acceptance, first.packet.acceptance);
  assert.deepEqual(retried.packet.constraints.filter((item) => item !== note), first.packet.constraints, 'nothing else in the packet changes');
  assert.notEqual(fresh.target_sha, first.target_sha, 'the repair produced a new head');
  assert.deepEqual(fresh.notes, [], 'a verification of a new head carries no note');
  assert.ok(!NOTE.test(fresh.prompt));
});

test('a verifier that rejected without a blocking finding is refused, and the retry is told why (aiworks#59)', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: NONE });
  const { store, controller, id } = setup(t, { decl, scenario: { verify: ['reject-unblocked', 'accept'] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished', { timeoutMs: 120_000 });
  const retried = dispatched(store, id, 'verify.3');
  assert.equal(retried.notes.length, 1);
  assert.ok(retried.notes[0].includes('refused as invalid-result: rejected without a blocking finding.'));
});

test('the repeat guard still holds a task after four identical refusals, each retry carrying one note (aiworks#59, aiworks#136)', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], limits: NONE });
  const same = Array(4).fill('accept-failed-check');
  const { env, store, controller, id } = setup(t, { decl, scenario: { verify: [...same, 'accept'] } });
  await runUntil(controller, store, id, (c) => c.status === 'blocked-owner-decision', { timeoutMs: 120_000 });
  const task = store.task(id, 'T1');
  assert.equal(task.blocked.class, 'B3');
  assert.equal(task.blocked.reason, 'no progress: 4 identical invalid-result failures; last: accepted with a failed check');
  assert.equal(env.calls().filter((c) => c.role === 'verify').length, 4, 'exactly four verifications, then it stops');
  for (const name of ['verify.3', 'verify.4', 'verify.5']) assert.equal(dispatched(store, id, name).notes.length, 1, `${name} carries one note`);
});
