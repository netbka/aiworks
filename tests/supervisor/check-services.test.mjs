// External check services (docs/guides/check-services.md): a service's answer can only stand in for a full gate of the
// exact commit, and a busy or broken service never holds the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptRemoteResult, runOnService } from '../../src/supervisor/check-services.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const JOB = '11111111-2222-3333-4444-555555555555';
const project = { projectId: 'sampleapp', profile: 'full' };
const service = { name: 'lab', kind: 'remote-gate-http', baseUrl: 'https://192.0.2.10:4319', caFile: 'ca.crt',
  projects: { 'example-org/sampleapp': project }, queueSeconds: 60, timeoutMinutes: 30 };
const fullGate = { phase: 'step-1-check', argv: ['node', 'npm-cli.js', 'run', 'check'], exitCode: 0 };
const passed = { jobId: JOB, ...project, requestedSha: SHA, commitSha: SHA, state: 'passed', exitCode: 0, commands: [fullGate] };

// A fake service: `states` are the answers to successive status polls; every call is recorded.
function fake(states, result = passed) {
  const calls = [];
  let polls = 0;
  const client = () => ({
    health: async () => { calls.push('health'); return { status: 'ok' }; },
    submit: async (spec) => { calls.push('submit'); return { jobId: JOB, state: 'pending', spec }; },
    status: async (id) => { calls.push(`status ${id}`); return { jobId: id, state: states[Math.min(polls++, states.length - 1)] }; },
    result: async () => { calls.push('result'); return result; },
    log: async () => '# all test files\n# fail 0\n',
    cancel: async (id) => { calls.push(`cancel ${id}`); return {}; },
  });
  return { client, calls };
}
const clock = () => { let at = 0; return { now: () => at, sleep: async (ms) => { at += ms; } }; };
const offer = (fakeService, extra = {}) => runOnService({ services: [service], repository: 'Example-Org/SampleApp', sha: SHA,
  client: fakeService.client, ...clock(), pollMs: 10_000, ...extra });

test('only a full gate of the exact commit that exited 0 counts as a pass; anything else is no pass', async () => {
  const asked = { jobId: JOB, sha: SHA, ...project };
  assert.deepEqual(acceptRemoteResult(passed, asked), { counted: true, passed: true, state: 'passed' });
  const notPasses = {
    'another commit checked out': { ...passed, commitSha: OTHER },
    'another commit asked for': { ...passed, requestedSha: OTHER },
    'another job': { ...passed, jobId: '99999999-2222-3333-4444-555555555555' },
    'another project': { ...passed, projectId: 'other' },
    'non-zero exit': { ...passed, exitCode: 1 },
    'no full gate step': { ...passed, commands: [{ ...fullGate, argv: ['node', 'npm-cli.js', 'run', 'test:affected'] }] },
    'full gate step failed': { ...passed, commands: [{ ...fullGate, exitCode: 1 }] },
    'environment failure': { ...passed, state: 'environment_failure', exitCode: null },
    'still running': { ...passed, state: 'running' },
  };
  for (const [why, result] of Object.entries(notPasses)) {
    assert.notEqual(acceptRemoteResult(result, asked).passed, true, why);
    const ran = await offer(fake(['passed'], result));
    assert.notEqual(ran?.exit, 0, why);
  }
  // A test failure there is a failed gate here, never a pass.
  assert.equal((await offer(fake(['test_failure'], { ...passed, state: 'test_failure', exitCode: 1 })))?.exit, 1);
  assert.equal((await offer(fake(['passed'])))?.exit, 0);
});

test('a busy, broken or unreachable service hands the gate back to this computer and cancels only its own job', async () => {
  // Queued past queueSeconds: its own job is cancelled and the gate runs here (null).
  const busy = fake(['pending']);
  assert.equal(await offer(busy), null);
  assert.deepEqual(busy.calls.filter((call) => call.startsWith('cancel')), [`cancel ${JOB}`]);
  // Down: no job, nothing to cancel.
  const down = { client: () => ({ health: async () => { throw new Error('ECONNREFUSED'); } }) };
  assert.equal(await offer(down), null);
  // A commit no origin branch holds is never submitted: the service could not fetch it.
  const unpushed = fake(['passed']);
  assert.equal(await offer(unpushed, { available: () => false }), null);
  assert.deepEqual(unpushed.calls, []);
  // A repository the service does not list is never sent to it.
  const unlisted = fake(['passed']);
  assert.equal(await runOnService({ services: [service], repository: 'example-org/service', sha: SHA, client: unlisted.client, ...clock() }), null);
  assert.deepEqual(unlisted.calls, []);
});
