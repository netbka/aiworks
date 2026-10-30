// npm run rebuild (src/supervisor/rebuild.mjs) against a synthetic installation: a real store, with Git, deploy.ps1 and
// the scheduled tasks replaced by recorded stand-ins. Disposable processes exercise locking; no live installation is used.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POWERSHELL } from '../../src/supervisor/proc.mjs';
import { campaignCancel, campaignPause, campaignStart } from '../../src/supervisor/api.mjs';
import { canonicalJson } from '../../src/supervisor/campaign.mjs';
import { installationPaths, pauseReason, rebuild } from '../../src/supervisor/rebuild.mjs';
import { Store } from '../../src/supervisor/store.mjs';
import { declaration, SQLITE } from './helpers.mjs';

const skip = SQLITE ? false : 'node:sqlite requires Node >= 22.5';
const TARGET = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });

test('rebuild runs a separate configured source only at its clean trusted revision, including recovery',
  { skip: skip || (process.platform !== 'win32' && 'Windows maintenance command') }, () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-launch-'));
    const source = join(root, 'reviewed source');
    const paths = installationPaths(root);
    const marker = join(root, 'executed');
    const hidden = fileURLToPath(new URL('../../scripts/supervisor/hidden-exec.ps1', import.meta.url));
    const launcher = fileURLToPath(new URL('../../scripts/supervisor/rebuild.mjs', import.meta.url));
    const run = (file, args, cwd = source) => {
      const request = Buffer.from(JSON.stringify({ file, args, cwd, timeoutMs: 30_000 })).toString('base64');
      const out = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hidden, '-Request', request],
        { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
      assert.equal(out.status, 0, out.stderr);
      return JSON.parse(out.stdout);
    };
    const git = (...args) => { const out = run('git', args); assert.equal(out.exitCode, 0, out.stderr); return out.stdout.trim(); };
    try {
      mkdirSync(join(source, 'scripts/supervisor'), { recursive: true });
      mkdirSync(dirname(paths.cli), { recursive: true });
      mkdirSync(paths.data, { recursive: true });
      writeFileSync(paths.config, JSON.stringify({ selfHosting: { repository: 'example/aiworks', trustedMain: 'local' },
        repositories: { 'example/aiworks': { path: source } } }));
      writeFileSync(join(source, 'scripts/supervisor/rebuild.mjs'),
        `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
      git('init', '-q'); git('add', '.');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
      const head = git('rev-parse', 'HEAD');
      writeFileSync(paths.cli, `console.log('${'f'.repeat(40)}');`);
      assert.equal(run(process.execPath, [launcher, '--root', root]).exitCode, 1);
      assert.equal(existsSync(marker), false, 'an untrusted checkout must not execute');
      writeFileSync(paths.cli, `console.log('${head}');`);
      writeFileSync(join(source, 'unreviewed.txt'), 'dirty');
      assert.equal(run(process.execPath, [launcher, '--root', root]).exitCode, 1);
      assert.equal(existsSync(marker), false, 'a dirty checkout must not execute');
      rmSync(join(source, 'unreviewed.txt'));
      const accepted = run(process.execPath, [launcher, '--root', root]);
      assert.equal(accepted.exitCode, 0, accepted.stderr);
      assert.equal(existsSync(marker), true);
      rmSync(marker);
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(paths.state, JSON.stringify({ phase: 'draining', target: head }));
      writeFileSync(join(source, 'next.txt'), 'later reviewed work');
      git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'next');
      const next = git('rev-parse', 'HEAD');
      git('-C', paths.runtime, 'init', '-q');
      git('-C', paths.runtime, 'fetch', '-q', source, 'HEAD');
      git('checkout', '-q', '--detach', head);
      writeFileSync(paths.cli, `console.log('${next}');`);
      const draining = run(process.execPath, [launcher, '--root', root]);
      assert.equal(draining.exitCode, 0, draining.stderr);
      assert.equal(existsSync(marker), true, 'recovery keeps its trusted ancestor when main advances');
      rmSync(marker);
      writeFileSync(paths.cli, `console.log('${'f'.repeat(40)}');`);
      assert.equal(run(process.execPath, [launcher, '--root', root]).exitCode, 1);
      assert.equal(existsSync(marker), false, 'recovery must not run a source outside current trust');
      writeFileSync(paths.state, JSON.stringify({ phase: 'stopped', target: head }));
      writeFileSync(paths.cli, 'throw new Error("runtime unavailable during recovery");');
      const recovery = run(process.execPath, [launcher, '--root', root]);
      assert.equal(recovery.exitCode, 0, recovery.stderr);
      assert.equal(existsSync(marker), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

function installation() {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-rebuild-'));
  const paths = installationPaths(root);
  mkdirSync(dirname(paths.cli), { recursive: true });
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.cli, '');
  writeFileSync(paths.config, '{}');
  const store = new Store(paths.db);
  const options = { root, source: join(root, 'operator-checkout'), pollMs: 0, startTimeoutMs: 5_000 };
  return { root, paths, store, options, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

/**
 * Recorded stand-ins for Git, deploy.ps1 and the tasks. A started supervisor takes leases under the runtime's commit.
 * As in the supported layout, the installation root is a separate checkout: only the runtime, a worktree of the canonical
 * repository, has the trusted commits and origin.
 */
function services(inst, { git = {}, onDeploy = () => undefined, onSleep = () => {} } = {}) {
  let runtimeHead = OLD;
  const calls = [];
  return {
    calls,
    deploys: () => calls.filter((call) => call[0] === 'deploy').map((call) => call[1]),
    exec(file, args, { cwd }) {
      const key = args.join(' ');
      calls.push(['exec', file, key, cwd]);
      if (git[key]) return git[key](cwd);
      if (/^(fetch|cat-file|merge-base|rev-parse --verify)/.test(key) && cwd !== inst.paths.runtime) return { exitCode: 128, stdout: '', stderr: 'not in this repository' };
      if (key === 'rev-parse HEAD') return ok(cwd === inst.paths.runtime ? runtimeHead : TARGET);
      if (key === 'rev-parse --verify --quiet refs/remotes/origin/main^{commit}') return ok(TARGET);
      return ok('');
    },
    maintain(step, params) {
      calls.push(['deploy', step, params]);
      const out = onDeploy(step, params) ?? ok('');
      if (out.exitCode !== 0) return out;
      if (step === 'Stop') writeFileSync(inst.paths.stop, 'stop');
      if (step === 'Install') runtimeHead = params.sha;
      if (step === 'Start' && !params.keepStop) {
        rmSync(inst.paths.stop, { force: true });
        for (const { id } of inst.store.all('SELECT id FROM campaigns')) {
          inst.store.run('INSERT OR REPLACE INTO leases (campaign_id, instance_id, generation, code_revision, acquired_at, expires_at) VALUES (?, ?, 1, ?, ?, ?)',
            id, 'new-supervisor', runtimeHead, Date.now(), Date.now() + 3_600_000);
        }
      }
      return out;
    },
    dashboardAnswers: () => true,
    processAlive: () => false,
    sleep: async () => onSleep(),
    log: () => {},
  };
}

// Each campaign owns its own two issues, so the work-ownership check admits several.
let issue = 500;
const register = (store, campaignId) => campaignStart(store, declaration({ campaignId, tasks: ['T1', 'T2'].map((id, index) => ({ id, issue: issue++,
  title: `task ${id}`, deliverable: 'commit', goal: 'Produce an artifact.', dependsOn: index ? ['T1'] : [], acceptance: ['artifact exists'], references: ['AGENTS.md'] })) }));
const openRun = (store, id, campaignId, taskId) => store.insert('operations', { id, campaign_id: campaignId, task_id: taskId, kind: 'implement', seq: 1,
  idempotency_key: id, lease_generation: 1, state: 'dispatched', session_id: id, run_dir: 'synthetic', workspace: 'synthetic', packet: {},
  packet_digest: 'synthetic', created_at: 1, updated_at: 1 });
const finishRun = (store, id) => store.run("UPDATE operations SET state = 'finished', outcome = ? WHERE id = ?", JSON.stringify({ status: 'resolved', id }), id);
const lastPause = (store, id) => store.get("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'paused' ORDER BY seq DESC LIMIT 1", id)?.detail?.reason;

test('simultaneous stale-lock retries admit one maintainer and recover again after that maintainer crashes', { skip, timeout: 300_000 }, async () => {
  const inst = installation();
  const children = [];
  const launch = (pause) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/rebuild-contender.mjs', import.meta.url)), inst.root, pause],
      { cwd: inst.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const events = [], waiters = [];
    child.on('message', (event) => { if (waiters.length) waiters.shift()(event); else events.push(event); });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.on('error', (error) => { output += error.message; });
    const next = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`contender timed out: ${output}`)), 120_000);
      const done = (event) => { clearTimeout(timer); resolve(event); };
      if (events.length) done(events.shift()); else waiters.push(done);
    });
    const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; };
    const contender = { next, stop };
    children.push(contender);
    return contender;
  };
  try {
    // Obtain a real dead PID instead of assuming a PID is unused on the test machine.
    const dead = spawnSync(process.execPath, ['-e', ''], { cwd: inst.root, windowsHide: true });
    assert.equal(dead.status, 0);
    writeFileSync(inst.paths.lock, JSON.stringify({ owner: 'aiworks rebuild', pid: dead.pid, token: 'crashed' }));
    const first = launch('pause');
    assert.equal((await first.next()).event, 'stale');
    const second = launch('continue');
    const competing = await second.next();
    writeFileSync(join(inst.root, 'continue'), 'go');
    assert.equal((await first.next()).event, 'entered');
    assert.equal(competing.event, 'refused', 'a delayed stale reader must not remove a new maintainer lock');
    assert.equal(competing.code, 'REBUILD_IN_PROGRESS');
    const owned = readFileSync(inst.paths.lock, 'utf8');
    const svc = services(inst);
    await assert.rejects(rebuild(inst.options, svc), { code: 'REBUILD_IN_PROGRESS' });
    assert.deepEqual(svc.calls, [], 'a competing retry must not start preflight or maintenance');
    assert.equal(readFileSync(inst.paths.lock, 'utf8'), owned);
    await first.stop();
    await second.stop();
    register(inst.store, 'alpha');
    const result = await rebuild(inst.options, svc);
    assert.deepEqual(result.resumed, ['alpha']);
    assert.deepEqual(svc.deploys(), ['Stop', 'Install', 'Start']);
    assert.equal(existsSync(inst.paths.lock), false);
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    inst.close();
  }
});

test('an open run finishes and is recorded before the runtime stops, and one admitted at the stop is recorded before anything is replaced', { skip }, async () => {
  const inst = installation();
  try {
    register(inst.store, 'alpha');
    openRun(inst.store, 'run-a', 'alpha', 'T1');
    const open = () => inst.store.all("SELECT id FROM operations WHERE state IN ('recorded', 'dispatched')").map((op) => op.id);
    let stops = 0;
    const svc = services(inst, {
      onSleep: () => {
        // The supervisor is still running while it waits: nothing stopped it under the open run.
        assert.equal(svc.deploys().at(-1) === 'Stop', false);
        for (const id of open()) finishRun(inst.store, id);
      },
      onDeploy: (step) => {
        // An older runtime admits a run between the drained check and STOP: it must be recorded, never replaced under.
        if (step === 'Stop' && ++stops === 1) openRun(inst.store, 'run-b', 'alpha', 'T2');
        if (step === 'Install') assert.deepEqual(open(), []);
      },
    });
    const summary = await rebuild(inst.options, svc);
    assert.deepEqual(svc.deploys(), ['Stop', 'Start', 'Stop', 'Install', 'Start']);
    for (const id of ['run-a', 'run-b']) {
      const op = inst.store.get('SELECT state, outcome FROM operations WHERE id = ?', id);
      assert.equal(op.state, 'finished');
      assert.deepEqual(op.outcome, { status: 'resolved', id });
    }
    assert.deepEqual(summary.resumed, ['alpha']);
    assert.equal(inst.store.campaign('alpha').control, 'registered');
  } finally { inst.close(); }
});

test('earlier pauses, cancellations and STOP stay, and the resumed campaign keeps its exact authority, budget use, retry timers and history', { skip }, async () => {
  const inst = installation();
  try {
    for (const id of ['owner-paused', 'cancelled', 'running']) register(inst.store, id);
    campaignPause(inst.store, 'owner-paused', 'owner reason');
    campaignCancel(inst.store, 'cancelled', 'owner cancel');
    inst.store.run("UPDATE campaigns SET control = 'cancelled' WHERE id = 'cancelled'");
    inst.store.run("UPDATE campaigns SET runs_used = 3, cost_usd = 1.5 WHERE id = 'running'");
    inst.store.run("UPDATE tasks SET attempts = 2, retry_at = 12345, last_error = 'timeout' WHERE campaign_id = 'running' AND task_id = 'T1'");
    inst.store.journal('running', 'task-failed', { task: 'T1' }, 1);
    const before = inst.store.campaign('running');
    const history = inst.store.all('SELECT seq, kind FROM journal ORDER BY seq');
    writeFileSync(inst.paths.stop, 'operator stop');
    const svc = services(inst);
    const summary = await rebuild(inst.options, svc);

    assert.deepEqual(summary.resumed, ['running']);
    assert.equal(inst.store.campaign('owner-paused').control, 'paused');
    assert.equal(lastPause(inst.store, 'owner-paused'), 'owner reason');
    assert.equal(inst.store.campaign('cancelled').control, 'cancelled');
    assert.ok(existsSync(inst.paths.stop), 'the operator STOP stays');
    assert.ok(svc.calls.filter((call) => call[1] === 'Start').every((call) => call[2].keepStop === true));
    const after = inst.store.campaign('running');
    assert.equal(after.control, 'registered');
    assert.equal(canonicalJson(after.declaration), canonicalJson(before.declaration));
    assert.deepEqual([after.scope_digest, after.authorization_version, after.runs_used, after.cost_usd],
      [before.scope_digest, before.authorization_version, 3, 1.5]);
    const task = inst.store.task('running', 'T1');
    assert.deepEqual([task.attempts, task.retry_at, task.last_error], [2, 12345, 'timeout']);
    assert.deepEqual(inst.store.all('SELECT seq, kind FROM journal WHERE seq <= ? ORDER BY seq', history.at(-1).seq), history);
  } finally { inst.close(); }
});

test('after a failed install the same command continues without repeating a step and resumes only what it paused and nobody changed', { skip }, async () => {
  const inst = installation();
  const originalGet = Store.prototype.get;
  try {
    for (const id of ['alpha', 'beta']) register(inst.store, id);
    openRun(inst.store, 'done-run', 'alpha', 'T1');
    finishRun(inst.store, 'done-run');
    let installs = 0;
    let competingOwner = false, checkedConcurrentWriter = false;
    inst.store.db.exec('PRAGMA busy_timeout=0');
    const svc = services(inst, { onDeploy: (step) => {
      if (step === 'Start') competingOwner = true;
      if (step === 'Install' && ++installs === 1) return { exitCode: 1, stdout: '', stderr: 'npm ci failed' };
    } });
    Store.prototype.get = function (sql, ...args) {
      const row = originalGet.call(this, sql, ...args);
      if (competingOwner && sql.includes("kind = 'paused'") && args[0] === 'alpha') {
        competingOwner = false;
        // A separate dashboard connection tries to replace the pause after the resume guard reads it.
        assert.throws(() => inst.store.tx(() => {
          campaignStart(inst.store, inst.store.campaign('alpha').declaration);
          campaignPause(inst.store, 'alpha', 'new owner pause');
        }), /locked|busy/i);
        checkedConcurrentWriter = true;
      }
      return row;
    };
    await assert.rejects(rebuild(inst.options, svc), (error) => error.code === 'INSTALL_FAILED');
    assert.equal(inst.store.campaign('alpha').control, 'paused');
    assert.equal(inst.store.campaign('beta').control, 'paused');
    assert.ok(existsSync(inst.paths.state) && !existsSync(inst.paths.lock));

    // While it is down the owner resumes beta and pauses it again: that pause is the owner's, not the rebuild's.
    campaignStart(inst.store, inst.store.campaign('beta').declaration);
    campaignPause(inst.store, 'beta', 'owner pause');

    const summary = await rebuild(inst.options, svc);
    assert.deepEqual(svc.deploys(), ['Stop', 'Install', 'Install', 'Start']);
    assert.deepEqual(summary.resumed, ['alpha']);
    assert.deepEqual(summary.kept.map((entry) => entry.id), ['beta']);
    assert.equal(inst.store.campaign('alpha').control, 'registered');
    assert.equal(inst.store.campaign('beta').control, 'paused');
    assert.equal(lastPause(inst.store, 'beta'), 'owner pause');
    assert.equal(inst.store.get("SELECT COUNT(*) AS n FROM journal WHERE campaign_id = 'alpha' AND kind = 'paused'").n, 1);
    assert.equal(lastPause(inst.store, 'alpha'), pauseReason(summary.id));
    assert.equal(inst.store.get('SELECT COUNT(*) AS n FROM operations').n, 1);
    assert.ok(!existsSync(inst.paths.state));
    assert.equal(checkedConcurrentWriter, true);
  } finally { Store.prototype.get = originalGet; inst.close(); }
});

test('a dirty checkout, a revision that is not the trusted main or another maintenance session is refused before anything is paused or stopped', { skip }, async () => {
  const inst = installation();
  try {
    register(inst.store, 'alpha');
    const dirty = (where) => (cwd) => ok(cwd === where ? ' M src/supervisor/api.mjs\n' : '');
    const cases = [
      [{ 'status --porcelain': dirty(inst.options.source) }, 'SOURCE_NOT_CLEAN'],
      [{ 'status --porcelain': dirty(inst.paths.runtime) }, 'RUNTIME_NOT_CLEAN'],
      [{ 'rev-parse --verify --quiet refs/remotes/origin/main^{commit}': () => ok('c'.repeat(40)) }, 'SOURCE_NOT_AT_TARGET'],
      [{ 'fetch -q origin': () => ({ exitCode: 128, stdout: '', stderr: 'fetch failed' }) }, 'TARGET_NOT_TRUSTED'],
    ];
    for (const [git, code] of cases) {
      const svc = services(inst, { git });
      await assert.rejects(rebuild(inst.options, svc), (error) => error.code === code);
      assert.deepEqual(svc.deploys(), []);
      assert.equal(inst.store.campaign('alpha').control, 'registered');
      assert.ok(!existsSync(inst.paths.state) && !existsSync(inst.paths.lock));
    }
    // Another session maintaining the runtime holds the installation's lock: refused, and its lock is left in place.
    writeFileSync(inst.paths.lock, 'held by another maintenance session');
    const svc = services(inst);
    await assert.rejects(rebuild(inst.options, svc), (error) => error.code === 'MAINTENANCE_IN_PROGRESS');
    assert.deepEqual(svc.calls, []);
    assert.equal(inst.store.campaign('alpha').control, 'registered');
    assert.ok(!existsSync(inst.paths.state) && existsSync(inst.paths.lock));
    for (const pid of [process.pid, process.pid + 1]) {
      const holder = JSON.stringify({ owner: 'aiworks rebuild', pid, token: 'live-owner' });
      writeFileSync(inst.paths.lock, holder);
      svc.processAlive = () => true;
      await assert.rejects(rebuild(inst.options, svc), { code: 'REBUILD_IN_PROGRESS' });
      assert.equal(readFileSync(inst.paths.lock, 'utf8'), holder);
      assert.deepEqual(svc.calls, []);
    }
  } finally { inst.close(); }
});
