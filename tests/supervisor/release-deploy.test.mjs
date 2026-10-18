// REL7 (AUTO_RELEASE slice R7, sections 7.2, 7.4 and 8): deploy, check and rollback through the project's own commands
// at the merge commit the merge gate recorded, driven by release/state.mjs and run by release/runner.mjs. Built switched
// off: the config here is a synthetic object; config.json keeps release.enabled false until REL11. No model, network or
// GitHub call: the project commands are synthetic scripts in a disposable repository, and the destination is a folder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { acquireLock, createRelease, destinationState, markUnknownAfterRestart, reconcile, release, runStep } from '../../src/supervisor/release/state.mjs';
import { deployAdapter } from '../../src/supervisor/release/deploy.mjs';

const GRANT = 'g'.repeat(64);
const ELIGIBLE = () => ({ eligible: true, failed: [], inputs: { grantDigest: GRANT } });

/** The synthetic project commands. Each logs its call, then acts on the destination folder as `behave.json` says. */
const SCRIPTS = {
  observe: `const live = json('live.json'); console.log('revision: ' + live.revision); console.log('digest: ' + live.digest);`,
  deploy: `writeFileSync(at('retained.json'), JSON.stringify(json('live.json')));
if (behave.deploy !== 'noop') writeFileSync(at('live.json'), JSON.stringify({ revision: process.argv[2], digest: behave.deploy === 'drift' ? 'sha256:other' : 'sha256:new' }));
console.log('digest: sha256:new');`,
  check: `process.exit((behave.check ?? {})[json('live.json').digest] ?? 0);`,
  rollback: `if (behave.rollback === 'fail') process.exit(1);
const previous = json('retained.json');
if (behave.rollback !== 'claims-only') writeFileSync(at('live.json'), JSON.stringify(previous));
console.log('digest: ' + previous.digest);`,
};

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/**
 * A disposable project: a repository whose base commit holds the four commands, a verified task commit, and the merge
 * gate's merge commit of it (same tree). The destination runs the base revision with digest sha256:old.
 */
function rig(t, { behave = {}, rollback = 'automatic' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-release-deploy-'));
  const repo = join(dir, 'repo'), dest = join(dir, 'destination'), dataDir = join(dir, 'data');
  for (const path of [repo, dest, dataDir]) mkdirSync(path);
  const rig = { dir, repo, dest, dataDir, now: 1_000_000, time: 0, stores: [] };
  t.after(() => { for (const store of rig.stores) try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'ops'));
  for (const [name, body] of Object.entries(SCRIPTS)) {
    writeFileSync(join(repo, 'ops', `${name}.mjs`), `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const at = (name) => ${JSON.stringify(dest)} + '/' + name;
const json = (name, fallback = {}) => (existsSync(at(name)) ? JSON.parse(readFileSync(at(name), 'utf8')) : fallback);
const behave = json('behave.json');
appendFileSync(at('calls.log'), JSON.stringify({ name: ${JSON.stringify(name)}, cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
${body}
`);
  }
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base');
  rig.base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'task');
  writeFileSync(join(repo, 'app.txt'), 'the verified change\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'task');
  rig.verified = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge gate', 'task');
  rig.merge = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'app.txt'), 'not what was verified\n');
  git(repo, 'commit', '-q', '-am', 'another tree');
  rig.otherTree = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', rig.merge);

  writeFileSync(join(dest, 'live.json'), JSON.stringify({ revision: rig.base, digest: 'sha256:old' }));
  writeFileSync(join(dest, 'behave.json'), JSON.stringify(behave));
  rig.calls = (name) => (existsSync(join(dest, 'calls.log')) ? readFileSync(join(dest, 'calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [])
    .filter((call) => !name || call.name === name);
  rig.live = () => JSON.parse(readFileSync(join(dest, 'live.json'), 'utf8'));

  rig.store = new Store(join(dataDir, 'supervisor.db'));
  rig.stores.push(rig.store);
  rig.lease = { instanceId: 'first', generation: rig.store.acquireLease('c', 'first', rig.now, 60_000).generation };
  rig.at = () => ({ lease: rig.lease, now: rig.now });
  rig.journaled = (kind) => rig.store.all('SELECT kind FROM journal WHERE kind = ?', kind).length;
  rig.adapter = (mergeCommit = rig.merge) => {
    rig.store.journal('c', 'merged', { task: 'T1', sha: rig.verified, mergeCommit }, rig.now);
    return deployAdapter({
      destination: { id: 'prod', environment: 'production', kind: 'deploy', changeClasses: ['app-code'], rollback, checkWindowMinutes: 1,
        commands: { deploy: 'ops/deploy.mjs', observe: 'ops/observe.mjs', check: 'ops/check.mjs', rollback: 'ops/rollback.mjs' } },
      repo, config: { release: { enabled: true } }, dataDir, store: rig.store, timeoutMs: 60_000, checkIntervalMs: 15_000,
      clock: () => rig.time, sleep: async (ms) => { rig.time += ms; },
    });
  };
  rig.locked = () => {
    const id = createRelease(rig.store, { project: 'sampleapp', destination: 'prod', campaignId: 'c', taskId: 'T1', verifiedSha: rig.verified,
      grantVersion: 1, grantDigest: GRANT, steps: ['deploy', 'check'], ...rig.at() }).id;
    assert.equal(acquireLock(rig.store, id, { ...rig.at(), recheck: ELIGIBLE }).locked, true);
    return id;
  };
  rig.lock = () => destinationState(rig.store, 'sampleapp', 'prod');
  return rig;
}

test('a deploy release whose merge commit holds another tree than the verified one is refused and runs nothing', async (t) => {
  const r = rig(t);
  const adapter = r.adapter(r.otherTree), id = r.locked();
  const after = await runStep(r.store, adapter, id, r.at());
  assert.equal(after.state, 'refused');
  assert.deepEqual(r.calls(), [], 'no project command ran');
  assert.deepEqual(r.live(), { revision: r.base, digest: 'sha256:old' });
  assert.equal(r.journaled('release-deploy-refused'), 1, 'the owner is told why');
});

test('observe disagreeing with the digest deploy printed is unknown, never success, and deploy never runs twice', async (t) => {
  const r = rig(t, { behave: { deploy: 'drift' } });
  const adapter = r.adapter(), id = r.locked();
  assert.equal((await runStep(r.store, adapter, id, r.at())).state, 'unknown');
  assert.equal((await reconcile(r.store, adapter, id, r.at())).state, 'unknown', 'a second look does not make it success');
  await assert.rejects(runStep(r.store, adapter, id, r.at()), /unknown/);
  assert.equal(r.calls('deploy').length, 1);
  assert.equal(r.lock().releaseId, id, 'the unknown release keeps the destination lock');
});

test('a deploy interrupted by a crash is settled by observe after the restart, never repeated, then checked', async (t) => {
  const r = rig(t);
  const adapter = r.adapter(), id = r.locked();
  let effected;
  const deployRan = new Promise((done) => { effected = done; });
  // The controller dies after the deploy acted and before its outcome was recorded.
  const crashing = { run: async (rel, step) => { await adapter.run(rel, step); effected(); return new Promise(() => {}); }, observe: adapter.observe };
  runStep(r.store, crashing, id, r.at());
  await deployRan;
  assert.equal(release(r.store, id).step_outcome, null, 'the step is open: its outcome was never recorded');
  assert.deepEqual(markUnknownAfterRestart(r.store, 'c', r.at()), [id]);

  const settled = await reconcile(r.store, adapter, id, r.at());
  assert.equal(settled.state, 'deployed');
  assert.deepEqual([settled.deployed_digest, settled.previous_digest], ['sha256:new', 'sha256:old']);
  const done = await runStep(r.store, adapter, id, r.at());
  assert.equal(done.state, 'accepted');
  assert.equal(r.calls('deploy').length, 1, 'deploy ran once');
  assert.deepEqual(r.calls('deploy')[0].args, [r.merge], 'it deployed the merge commit');
  const checkout = realpathSync.native(join(r.dataDir, 'releases', id, 'checkout'));
  assert.ok(r.calls().every((call) => realpathSync.native(call.cwd) === checkout), 'every command ran in the release checkout, never in the repository');
  assert.equal(r.lock().free, true, 'accepted frees the lock');
});

test('a deploy proven not done after it may have started goes to the owner and is not run again', async (t) => {
  const r = rig(t, { behave: { deploy: 'noop' } });
  const adapter = r.adapter(), id = r.locked();
  assert.equal((await runStep(r.store, adapter, id, r.at())).state, 'unknown');
  assert.equal((await reconcile(r.store, adapter, id, r.at())).state, 'unknown');
  assert.ok(r.journaled('release-owner-needed') >= 1, 'the owner is asked');
  assert.equal(r.calls('deploy').length, 1);
  assert.equal(r.lock().releaseId, id);
});

test('failing checks roll back automatically to the previous digest, which observe and check confirm', async (t) => {
  const r = rig(t, { behave: { check: { 'sha256:new': 1 } } });
  const adapter = r.adapter(), id = r.locked();
  assert.equal((await runStep(r.store, adapter, id, r.at())).state, 'deployed');
  assert.equal((await runStep(r.store, adapter, id, r.at())).state, 'checking', 'the check failed for the whole window');
  assert.ok(r.calls('check').length > 1, 'check ran again within the window');
  const after = await runStep(r.store, adapter, id, r.at());
  assert.equal(after.state, 'rolled-back');
  assert.deepEqual(r.live(), { revision: r.base, digest: 'sha256:old' });
  assert.deepEqual(r.calls('rollback')[0].args, ['sha256:old']);
  assert.equal(r.lock().free, true);
});

test('checks still unknown at the end of the window count as failed and roll back', async (t) => {
  const r = rig(t, { behave: { check: { 'sha256:new': 3 } } });
  const adapter = r.adapter(), id = r.locked();
  await runStep(r.store, adapter, id, r.at());
  assert.equal((await runStep(r.store, adapter, id, r.at())).step_outcome, 'failed');
  assert.equal((await runStep(r.store, adapter, id, r.at())).state, 'rolled-back');
});

test('a failed rollback is an incident that keeps the destination lock', async (t) => {
  // It fails outright, or it claims the previous digest while observe still sees the new one.
  for (const rollback of ['fail', 'claims-only']) {
    const r = rig(t, { behave: { check: { 'sha256:new': 1 }, rollback } });
    const adapter = r.adapter(), id = r.locked();
    await runStep(r.store, adapter, id, r.at());
    await runStep(r.store, adapter, id, r.at());
    assert.equal((await runStep(r.store, adapter, id, r.at())).state, 'rollback-failed', rollback);
    assert.equal(r.journaled('release-incident'), 1, rollback);
    assert.equal(r.lock().releaseId, id, 'nothing else is released on top of it');
    await assert.rejects(runStep(r.store, adapter, id, r.at()), /no step to run/);
    assert.equal(r.calls('rollback').length, 1, rollback);
  }
});
