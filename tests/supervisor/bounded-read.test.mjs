// A timed-out bounded read stops every process it started before it settles (aiworks#140): a helper that outlived the
// deadline could keep writing refs after the controller had judged the read failed. A read whose processes were not all
// shown ended keeps its checkout from being read again until they are.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execBounded, execContained, treeKill } from '../../src/supervisor/adapters/git.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { POWERSHELL, readJsonIfExists, runnerIdentified } from '../../src/supervisor/proc.mjs';
import { Store } from '../../src/supervisor/store.mjs';
import { environment, ROOT, skipWithoutSqlite, sleep } from './helpers.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// A parent that starts a helper and hangs. The helper stands in for a fetch's remote helper: it records its pid, then
// writes after the deadline.
function hungTree(dir) {
  const pidFile = join(dir, 'helper.pid'), late = join(dir, 'late-write');
  const helper = join(dir, 'helper.mjs');
  writeFileSync(helper, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => writeFileSync(${JSON.stringify(late)}, 'written after the deadline'), 4000);`);
  const parent = join(dir, 'parent.mjs');
  writeFileSync(parent, `import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(helper)}], { stdio: 'ignore', windowsHide: true });
setInterval(() => {}, 1000);`);
  return { parent, pidFile, late };
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-bounded-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}

test('a read that times out has stopped its whole process tree when it settles', async (t) => {
  const { parent, pidFile, late } = hungTree(tempDir(t));
  const result = await execBounded([process.execPath, parent], [], { timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ETIMEDOUT');
  assert.equal(result.contained, undefined, 'the tree stop was shown to finish');
  assert.ok(existsSync(pidFile), 'the helper was running before the deadline');
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false, 'the helper is gone when the read settles');
  await sleep(3000);
  assert.equal(existsSync(late), false, 'nothing the read started writes after it settled');
});

test('a child gone before taskkill looks for it is not taken as a stopped tree', { skip: process.platform !== 'win32' && 'Windows taskkill only' }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  // Block the event loop while the child exits: Node has not yet seen its exit, so taskkill finds no process (exit 128).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  assert.equal(child.exitCode, null);
  assert.equal(await treeKill(child, 10_000), false, 'its helpers could no longer be found, so their end is not shown');
});

test('a contained fetch that times out has shown its whole tree ended and keeps no receipt', async (t) => {
  const dir = tempDir(t), runRoot = join(dir, 'runs');
  const { parent, pidFile, late } = hungTree(dir);
  const result = await execContained([process.execPath, parent], [], { cwd: dir, runRoot, timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ETIMEDOUT');
  assert.equal(result.contained, undefined, 'the job was shown empty');
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false, 'the helper is gone when the read settles');
  assert.deepEqual(readdirSync(runRoot), [], 'a run shown ended keeps no receipt');
  await sleep(3000);
  assert.equal(existsSync(late), false, 'nothing the read started writes after it settled');
});

test('a checkout with a fetch not shown ended is not read again until its end is shown', { skip: skipWithoutSqlite || (!POWERSHELL && 'Windows job containment only') }, async (t) => {
  const env = environment(); const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  const logs = [];
  controller.log = (line) => logs.push(line);
  const runRoot = controller.baseReadRoot(env.repo);
  // A run left by an earlier controller whose job is still running: a hung fetch with a live helper.
  const { parent, pidFile, late } = hungTree(env.tmp);
  const leftover = join(runRoot, 'read-leftover');
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, 'prompt.txt'), '');
  writeFileSync(join(leftover, 'spec.json'), JSON.stringify({ cwd: env.tmp, timeoutMs: 600_000, heartbeatMs: 1000, argv: [process.execPath, parent] }));
  const runner = spawn(process.execPath, [join(ROOT, 'src', 'supervisor', 'runner.mjs'), leftover], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { runner.kill(); } catch { /* gone */ } });
  while (!runnerIdentified(readJsonIfExists(join(leftover, 'runner.json'))) || !existsSync(pidFile)) await sleep(100);
  const helper = Number(readFileSync(pidFile, 'utf8'));
  // And a run whose runner recorded itself but not its job, with no result: its end cannot be shown.
  const unproven = join(runRoot, 'read-unproven');
  mkdirSync(unproven);
  writeFileSync(join(unproven, 'run.lock'), '');
  writeFileSync(join(unproven, 'runner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

  const sha = git(env.repo, 'rev-parse', 'HEAD');
  for (const fresh of [false, true]) {
    assert.deepEqual(await controller.fetchBase(env.repo, 'main', null, { fresh }), { ok: false, sha: null, failure: 'uncontained' });
  }
  assert.equal(alive(helper), false, 'the job of the identified run was stopped through its runner identity');
  assert.equal(existsSync(leftover), false, 'its receipt goes once its end is shown');
  assert.equal(git(env.repo, 'for-each-ref', 'refs/aiworks/base/'), '', 'nothing was fetched into the checkout meanwhile');
  assert.ok(logs.includes('base read unavailable: uncontained'));

  // The runner's own drained result is the proof that ends the wait.
  writeFileSync(join(unproven, 'result.json'), JSON.stringify({ containment: 'windows-job-v1', containmentStopped: true, attached: true }));
  assert.deepEqual(await controller.fetchBase(env.repo, 'main', null), { ok: true, sha });
  assert.deepEqual(readdirSync(runRoot), [], 'no receipt is left once every run is shown ended');
  await sleep(4000);
  assert.equal(existsSync(late), false, 'the stopped helper never wrote');
});
