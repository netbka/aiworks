// The authorized check-service caller (docs/guides/check-services.md): a supervisor restart re-attaches to the job it
// recorded for a verified commit and never submits a second one. Synthetic store, fictional service, fake transport.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { createCheckServiceCaller, OFFER_WINDOW_MS, OFFERED, RESULT } from '../../src/supervisor/check-service-caller.mjs';
import { declaration, skipWithoutSqlite } from './helpers.mjs';

const SHA = 'a'.repeat(40);
const JOB = '11111111-2222-3333-4444-555555555555';
const project = { projectId: 'sampleapp', profile: 'full' };
const config = { checkServices: [{ name: 'lab', kind: 'remote-gate-http', baseUrl: 'https://192.0.2.10:4319', caFile: 'ca.crt', offer: 'verified',
  projects: { 'example-org/sampleapp': project } }] };
const passed = { jobId: JOB, ...project, requestedSha: SHA, commitSha: SHA, state: 'passed', exitCode: 0,
  commands: [{ phase: 'step-1-check', argv: ['npm', 'run', 'check'], exitCode: 0 }] };

function fakeService(state) {
  const calls = [];
  const client = () => ({
    health: async () => { calls.push('health'); return { status: 'ok' }; },
    submit: async (spec) => { calls.push('submit'); return { jobId: JOB, state: 'pending', spec }; },
    status: async (id) => { calls.push(`status ${id}`); return { jobId: id, state: state() }; },
    result: async () => { calls.push('result'); return passed; },
    log: async () => { calls.push('log'); return '# tests 1\n# pass 1\n# fail 0\n'; },
    cancel: async () => { calls.push('cancel'); return {}; },
  });
  return { client, calls };
}

test('a restart after an offer was recorded re-attaches to that job and never submits a second one for the commit', { skip: skipWithoutSqlite }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-check-caller-'));
  const store = new Store(join(dir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const now = Date.now();
  store.insert('campaigns', { id: 'test-campaign', controller_id: 'aiworks-supervisor/test-campaign', scope_digest: 'a'.repeat(64), authorization_version: 1,
    declaration: declaration(), control: 'registered', status: 'active', next_action: 'x', next_wakeup_at: null, blocker: null, version: 1, created_at: now, updated_at: now });
  store.insert('operations', { id: 'op-verify', campaign_id: 'test-campaign', task_id: 'T1', kind: 'verify', seq: 1, idempotency_key: 'op-verify',
    lease_generation: 1, state: 'finished', session_id: 's', run_dir: dir, workspace: dir, target_sha: SHA, packet: {}, packet_digest: 'd',
    outcome: { class: 'result', value: { verdict: 'accepted', findings: [] } }, created_at: now, updated_at: now });
  const options = { store, config, repositoryOf: () => 'example-org/sampleapp', available: async () => true, pollMs: 1 };

  // The first instance submits, records the job, and is stopped while the job still runs.
  const first = fakeService(() => 'running');
  const before = createCheckServiceCaller({ ...options, client: first.client, sleep: async () => { before.stop(0); } });
  before.tick();
  await before.idle();
  assert.deepEqual(first.calls.filter((call) => call === 'submit'), ['submit']);
  assert.ok(!first.calls.includes('cancel'), 'stopping never cancels the remote job');
  const offered = store.all('SELECT detail FROM journal WHERE kind = ?', OFFERED).map((row) => row.detail);
  assert.deepEqual(offered.map((detail) => [detail.service, detail.sha, detail.jobId]), [['lab', SHA, JOB]]);
  assert.equal(store.all('SELECT 1 FROM journal WHERE kind = ?', RESULT).length, 0);

  // The restarted instance re-attaches to the recorded job: no health check, no second submission.
  const second = fakeService(() => 'passed');
  const after = createCheckServiceCaller({ ...options, client: second.client, sleep: async () => {} });
  after.tick();
  await after.idle();
  assert.deepEqual(second.calls, [`status ${JOB}`, 'result', 'log']);
  const results = store.all('SELECT detail FROM journal WHERE kind = ?', RESULT).map((row) => row.detail);
  assert.deepEqual(results.map((detail) => [detail.service, detail.sha, detail.jobId, detail.state]), [['lab', SHA, JOB, 'passed']]);

  // Once answered, the commit is never offered to that service again.
  const third = fakeService(() => 'passed');
  const later = createCheckServiceCaller({ ...options, client: third.client, sleep: async () => {} });
  later.tick();
  await later.idle();
  assert.deepEqual(third.calls, []);
});

test('a commit whose offer window ended without an answer gets exactly one final result, also across a restart', { skip: skipWithoutSqlite }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-check-caller-'));
  const store = new Store(join(dir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const now = Date.now();
  const verifiedAt = now - OFFER_WINDOW_MS - 3600_000;
  store.insert('campaigns', { id: 'test-campaign', controller_id: 'aiworks-supervisor/test-campaign', scope_digest: 'a'.repeat(64), authorization_version: 1,
    declaration: declaration(), control: 'registered', status: 'active', next_action: 'x', next_wakeup_at: null, blocker: null, version: 1, created_at: verifiedAt, updated_at: verifiedAt });
  const OTHER = 'b'.repeat(40);
  const AGAIN = 'c'.repeat(40);
  // One commit's job was offered and never answered; another was never asked about while its service was busy; a third
  // aged out once but was verified again a minute ago, so it is still offered.
  for (const [seq, sha, at] of [[1, SHA, verifiedAt], [2, OTHER, verifiedAt], [3, AGAIN, verifiedAt], [4, AGAIN, now - 60_000]]) {
    store.insert('operations', { id: `op-verify-${seq}`, campaign_id: 'test-campaign', task_id: 'T1', kind: 'verify', seq, idempotency_key: `op-verify-${seq}`,
      lease_generation: 1, state: 'finished', session_id: 's', run_dir: dir, workspace: dir, target_sha: sha, packet: {}, packet_digest: 'd',
      outcome: { class: 'result', value: { verdict: 'accepted', findings: [] } }, created_at: at, updated_at: at });
  }
  store.journal('test-campaign', OFFERED, { task: 'T1', service: 'lab', sha: SHA, project: 'sampleapp', jobId: JOB }, verifiedAt + 60_000);
  const options = { store, config, repositoryOf: () => 'example-org/sampleapp', available: async () => true, pollMs: 1, sleep: async () => {}, now: () => now };

  for (let start = 0; start < 2; start += 1) {
    const service = fakeService(() => 'passed');
    const caller = createCheckServiceCaller({ ...options, client: service.client });
    caller.tick();
    await caller.idle();
    // Only the commit verified again is offered, once; a commit past its window never is.
    assert.equal(service.calls.filter((call) => call === 'submit').length, start === 0 ? 1 : 0);
  }
  const results = store.all('SELECT detail FROM journal WHERE kind = ?', RESULT).map((row) => row.detail);
  assert.deepEqual(results.map((detail) => [detail.sha, detail.state === 'unavailable']).sort(), [[SHA, true], [OTHER, true], [AGAIN, false]]);
});
