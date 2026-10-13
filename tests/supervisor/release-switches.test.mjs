// REL4 (AUTO_RELEASE slice R4): the kill switches and the mode, checked before every step. RELEASE-STOP stops the next
// step of every release; a stop after deploy still runs checks and rollback; switching to Review only needs no grant;
// release.enabled absent means off; no command can switch a destination to Auto Release. Built switched off until
// netbka/aiworks#33. No model, network or GitHub call: the adapter is a fake and the CLI runs on a temporary data dir.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart, campaignStatus } from '../../src/supervisor/api.mjs';
import { evaluateEligibility } from '../../src/supervisor/release/eligibility.mjs';
import {
  AUTO_RELEASE, RELEASE_STOP, REVIEW_ONLY, acquireLock, createRelease, destinationState, release, releaseGate, releaseMode,
  releaseSwitches, runStep, setReviewOnly,
} from '../../src/supervisor/release/state.mjs';
import { CLI, declaration } from './helpers.mjs';

const SHA = 'b'.repeat(40);
const TTL = 60_000;
const ON = { release: { enabled: true } };
/** A grant as eligibility.mjs holds one after release/authorization.mjs validated it. */
const grant = ({ version = 3, grantedAt = '2026-11-01', destinations = ['prod', 'staging'] } = {}) =>
  ({ record: { version, grantedAt, destinations: destinations.map((id) => ({ id })) }, digest: 'g'.repeat(64) });

function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-release-switches-'));
  const store = new Store(join(dir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-05T10:00:00Z');
  const lease = { instanceId: 'first', generation: store.acquireLease('c', 'first', now, TTL).generation };
  const at = { lease, now };
  const locked = (destination, steps = ['merge', 'deploy', 'check']) => {
    const { id } = createRelease(store, { project: 'dyk', destination, campaignId: 'c', taskId: 'T1', verifiedSha: SHA, grantVersion: 3,
      grantDigest: 'g'.repeat(64), steps, lease, now });
    assert.equal(acquireLock(store, id, { ...at, recheck: () => ({ eligible: true, failed: [], inputs: { grantDigest: 'g'.repeat(64) } }) }).locked, true);
    return id;
  };
  // The real gate, bound to one destination, as the release runner will bind it.
  const gate = ({ config = ON, held = grant() } = {}) => (r) => releaseGate({ dataDir: dir, config, store, project: r.project, destination: r.destination, grant: held });
  return { dir, store, now, at, locked, gate };
}

/** A fake adapter: `run` records the step and answers from the given function. */
function fake(run = () => 'done') {
  const adapter = { runs: [] };
  adapter.run = async (r, step) => { adapter.runs.push(`${r.destination}:${step}`); return run(r, step); };
  adapter.observe = async () => 'unknown';
  return adapter;
}

const stoppedJournal = (store) => store.all("SELECT detail FROM journal WHERE kind = 'release-stopped' ORDER BY seq").map((row) => row.detail);

test('RELEASE-STOP stops the next step of every release', async (t) => {
  const r = rig(t);
  const prod = r.locked('prod'), staging = r.locked('staging');
  const adapter = fake();
  assert.equal((await runStep(r.store, adapter, prod, { ...r.at, gate: r.gate() })).state, 'merged', 'with every switch on, the step runs');
  writeFileSync(join(r.dir, RELEASE_STOP), 'stop');
  for (const id of [prod, staging]) {
    const before = release(r.store, id);
    const after = await runStep(r.store, adapter, id, { ...r.at, gate: r.gate() });
    assert.equal(after.state, before.state, 'the release stays where it was');
    assert.equal(after.step_key, before.step_key, 'no step was started: no intent recorded');
    assert.match(after.reason, /RELEASE-STOP is set/);
    assert.equal(destinationState(r.store, 'dyk', after.destination).releaseId, id, 'it keeps its lock: nothing lands on top of it');
  }
  assert.deepEqual(adapter.runs, ['prod:merge'], 'no further step of any release ran');
  assert.equal(stoppedJournal(r.store).length, 2, 'each stop is journalled');
  // A gate that cannot answer stops too: a stop is never assumed absent.
  rmSync(join(r.dir, RELEASE_STOP));
  const unreadable = await runStep(r.store, adapter, staging, { ...r.at, gate: () => { throw new Error('disk gone'); } });
  assert.match(unreadable.reason, /could not be read: disk gone/);
  assert.equal(releaseGate({ dataDir: r.dir, config: ON, store: r.store, project: 'dyk', destination: 'prod', grant: grant(), exists: () => { throw new Error('EACCES'); } }),
    'whether RELEASE-STOP is set is unknown');
  assert.deepEqual(adapter.runs, ['prod:merge']);
  // Once the owner removes the file the release continues from where it stopped, never repeating a step.
  assert.equal((await runStep(r.store, adapter, prod, { ...r.at, gate: r.gate() })).state, 'deployed');
  assert.deepEqual(adapter.runs, ['prod:merge', 'prod:deploy']);
});

test('a stop after deploy still runs checks and rollback', async (t) => {
  const r = rig(t);
  const id = r.locked('prod');
  const adapter = fake((rel, step) => (step === 'check' ? 'failed' : 'done'));
  await runStep(r.store, adapter, id, { ...r.at, gate: r.gate() });
  await runStep(r.store, adapter, id, { ...r.at, gate: r.gate() });
  assert.equal(release(r.store, id).state, 'deployed');
  writeFileSync(join(r.dir, RELEASE_STOP), 'stop');
  assert.equal((await runStep(r.store, adapter, id, { ...r.at, gate: r.gate() })).state, 'checking', 'the check ran and failed');
  const after = await runStep(r.store, adapter, id, { ...r.at, gate: r.gate() });
  assert.equal(after.state, 'rolled-back', 'the rollback ran');
  assert.deepEqual(adapter.runs, ['prod:merge', 'prod:deploy', 'prod:check', 'prod:rollback'], 'stopping releases never stops recovery');
  assert.equal(stoppedJournal(r.store).length, 0);
  // Whereas a stop after a merge prevents the deploy, the next forward step.
  rmSync(join(r.dir, RELEASE_STOP));
  const other = r.locked('staging');
  await runStep(r.store, adapter, other, { ...r.at, gate: r.gate() });
  writeFileSync(join(r.dir, RELEASE_STOP), 'stop');
  assert.equal((await runStep(r.store, adapter, other, { ...r.at, gate: r.gate() })).state, 'merged');
  assert.deepEqual(adapter.runs.slice(4), ['staging:merge'], 'the deploy did not run');
  // A check with no forward step before it is not recovery, so the stop holds it too.
  rmSync(join(r.dir, RELEASE_STOP));
  const checkOnly = r.locked('qa', ['check']);
  writeFileSync(join(r.dir, RELEASE_STOP), 'stop');
  assert.match((await runStep(r.store, adapter, checkOnly, { ...r.at, gate: r.gate() })).reason, /RELEASE-STOP/);
  assert.deepEqual(adapter.runs.slice(5), []);
});

test('switching to review-only needs no grant', async (t) => {
  const r = rig(t);
  assert.equal(releaseMode(r.store, { project: 'dyk', destination: 'prod', grant: null }), REVIEW_ONLY, 'no grant: Review only, the default');
  assert.equal(releaseMode(r.store, { project: 'dyk', destination: 'prod', grant: { reason: 'the grant expired on 2026-10-01' } }), REVIEW_ONLY, 'an invalid grant: Review only');
  assert.equal(releaseMode(r.store, { project: 'dyk', destination: 'other', grant: grant() }), REVIEW_ONLY, 'a destination the grant does not name: Review only');
  assert.equal(releaseMode(r.store, { project: 'dyk', destination: 'prod', grant: grant() }), AUTO_RELEASE, 'only a valid grant makes Auto Release available');
  // Narrowing with no grant at all, and with no approval: allowed, immediate, and it holds against the current grant.
  setReviewOnly(r.store, { project: 'dyk', destination: 'prod', now: r.now });
  assert.equal(releaseMode(r.store, { project: 'dyk', destination: 'prod', grant: grant() }), REVIEW_ONLY);
  assert.equal(releaseMode(r.store, { project: 'dyk', destination: 'prod', grant: grant({ version: 4, grantedAt: '2026-11-05' }) }), REVIEW_ONLY,
    'a grant from the day of the narrowing, before it, does not widen');
  assert.equal(releaseMode(r.store, { project: 'dyk', destination: 'prod', grant: grant({ version: 4, grantedAt: '2026-11-06' }) }), AUTO_RELEASE,
    'only a grant made after the narrowing widens again');
  assert.equal(releaseMode(r.store, { project: 'dyk', destination: 'staging', grant: grant() }), AUTO_RELEASE, 'the narrowing is per destination');
  // Narrowing that knows the grant in force: the same or a lower version stays Review only; a higher version widens.
  setReviewOnly(r.store, { project: 'dyk', destination: 'staging', grantVersion: 3, now: r.now });
  assert.equal(releaseMode(r.store, { project: 'dyk', destination: 'staging', grant: grant({ version: 3, grantedAt: '2026-12-01' }) }), REVIEW_ONLY);
  assert.equal(releaseMode(r.store, { project: 'dyk', destination: 'staging', grant: grant({ version: 4 }) }), AUTO_RELEASE);
  // The narrowing takes effect before the next step of a release already under way.
  const id = r.locked('qa');
  const adapter = fake();
  await runStep(r.store, adapter, id, { ...r.at, gate: r.gate({ held: grant({ destinations: ['qa'] }) }) });
  setReviewOnly(r.store, { project: 'dyk', destination: 'qa', now: r.now });
  const after = await runStep(r.store, adapter, id, { ...r.at, gate: r.gate({ held: grant({ destinations: ['qa'] }) }) });
  assert.equal(after.reason, 'the destination is in Review only');
  assert.deepEqual(adapter.runs, ['qa:merge']);
  assert.equal(r.store.all("SELECT kind FROM journal WHERE kind = 'release-mode-narrowed'").length, 3, 'each narrowing is journalled');
});

test('release.enabled absent means off', async (t) => {
  const r = rig(t);
  for (const config of [undefined, {}, { release: {} }, { release: { enabled: 'true' } }, { release: { enabled: 1 } }, { release: true }]) {
    const switches = releaseSwitches({ dataDir: r.dir, config, store: r.store, project: 'dyk', destination: 'prod', grant: grant() });
    assert.equal(switches.enabled, false, JSON.stringify(config));
    assert.equal(releaseGate({ dataDir: r.dir, config, store: r.store, project: 'dyk', destination: 'prod', grant: grant() }),
      'Auto Release is switched off (release.enabled is not true)');
    // Eligibility check E1 reads the same switches and agrees.
    const result = evaluateEligibility({ project: 'dyk', destinationId: 'prod', taskId: 'T1', verifiedSha: SHA }, { switches: () => switches });
    assert.equal(result.failed.find((item) => item.check === 'E1')?.reason, 'Auto Release is switched off (release.enabled is not true)');
  }
  const id = r.locked('prod');
  const adapter = fake();
  const after = await runStep(r.store, adapter, id, { ...r.at, gate: r.gate({ config: {} }) });
  assert.equal(after.state, 'locked');
  assert.deepEqual(adapter.runs, [], 'with release.enabled absent, no step runs');
  // Every switch on, no stop, a valid grant and an unnarrowed destination: only then does the gate allow a step, and E1 passes.
  const on = { dataDir: r.dir, config: ON, store: r.store, project: 'dyk', destination: 'prod', grant: grant() };
  assert.equal(releaseGate(on), null);
  assert.deepEqual(releaseSwitches(on), { enabled: true, stop: false, mode: AUTO_RELEASE });
  assert.equal(evaluateEligibility({ project: 'dyk', destinationId: 'prod', taskId: 'T1', verifiedSha: SHA }, { switches: () => releaseSwitches(on) })
    .failed.some((item) => item.check === 'E1'), false);
  assert.equal(releaseGate({ ...on, grant: null }), 'the destination is in Review only', 'enabled without a grant is still Review only');
});

test('no command can switch a project to Auto Release; release-stop and release-mode review-only narrow', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-release-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args, '--data', dir], { encoding: 'utf8', windowsHide: true, env: { ...process.env, AIWORKS_DATA: '' } });
  for (const args of [['dyk', 'prod', 'auto-release'], ['dyk', 'prod', 'auto'], ['dyk', 'prod', 'Auto Release'], ['dyk', 'prod'], ['dyk', 'prod', 'review-only', 'auto-release'],
    ['dyk', '', 'review-only'], []]) {
    const refused = cli('release-mode', ...args);
    assert.equal(refused.status, 2, `release-mode ${args.join(' ')} is refused`);
    assert.match(refused.stderr, /RELEASE_MODE_REFUSED: release-mode only narrows/);
  }
  assert.equal(existsSync(join(dir, 'supervisor.db')), false, 'a refused mode never opens the store');
  const usage = cli();
  assert.doesNotMatch(usage.stderr, /release-mode[^\n]*auto-release/i, 'the usage offers no Auto Release mode');

  const narrowed = cli('release-mode', 'dyk', 'prod', 'review-only');
  assert.equal(narrowed.status, 0, narrowed.stderr);
  const printed = JSON.parse(narrowed.stdout);
  assert.equal(printed.project, 'dyk');
  assert.equal(printed.narrowed.destination, 'prod');
  assert.equal(printed.narrowed.mode, REVIEW_ONLY);
  const stopped = cli('release-stop');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.ok(existsSync(join(dir, RELEASE_STOP)), 'release-stop writes the file');

  // Status shows both stops, and a store with neither shows the release field exactly as before.
  const store = new Store(join(dir, 'supervisor.db'));
  try {
    campaignStart(store, declaration());
    const status = campaignStatus(store, 'test-campaign', Date.now(), { releaseStop: existsSync(join(dir, RELEASE_STOP)) });
    assert.equal(status.release.stopped, 'RELEASE-STOP is set: every release is stopped');
    assert.equal(status.release.mode, REVIEW_ONLY);
  } finally { store.close(); }
  const fresh = mkdtempSync(join(tmpdir(), 'aiworks-release-cli-fresh-'));
  t.after(() => rmSync(fresh, { recursive: true, force: true }));
  const other = new Store(join(fresh, 'supervisor.db'));
  try {
    campaignStart(other, declaration());
    const status = campaignStatus(other, 'test-campaign');
    assert.equal('stopped' in status.release, false);
    assert.equal('narrowed' in status.release, false);
    setReviewOnly(other, { project: declaration().target.projectId, destination: 'prod', now: Date.now() });
    assert.deepEqual(campaignStatus(other, 'test-campaign').release.narrowed.map((row) => [row.destination, row.mode]), [['prod', REVIEW_ONLY]]);
  } finally { other.close(); }
});
