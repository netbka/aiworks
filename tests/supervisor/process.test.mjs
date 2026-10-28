// Synthetic process containment tests.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readJsonIfExists, stopOwnedRun } from '../../src/supervisor/proc.mjs';

const runnerPath = fileURLToPath(new URL('../../src/supervisor/runner.mjs', import.meta.url));
test('job drain proves owned process handles signaled before reporting completion', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./fixtures/job-drain-proof.ps1', import.meta.url)), '-Helper',
    fileURLToPath(new URL('../../src/supervisor/windows-process.ps1', import.meta.url)), '-Node', process.execPath],
  { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
});
async function waitFor(predicate, diagnostics = () => null) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await sleep(25); }
  assert.fail('synthetic runner did not reach expected state: ' + JSON.stringify(diagnostics()));
}
function launch(t, code, timeoutMs = 10_000, extraArgs = [], env = process.env) {
  const dir = mkdtempSync(join(tmpdir(), "aiworks-process-quote'-"));
  writeFileSync(join(dir, 'prompt.txt'), 'synthetic prompt');
  writeFileSync(join(dir, 'worker.mjs'), code);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ argv: [process.execPath, join(dir, 'worker.mjs'), ...extraArgs],
    cwd: dir, timeoutMs, heartbeatMs: 50 }));
  const child = spawn(process.execPath, [runnerPath, dir], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: typeof env === 'function' ? env(dir) : env });
  const output = { stdout: '', stderr: '' };
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', (data) => { output[stream] = (output[stream] + data).slice(-4000); });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const metadata = readJsonIfExists(join(dir, 'runner.json'));
      if (metadata?.containment) stopOwnedRun(metadata);
      else child.kill();
      await exited;
    }
    if (!existsSync(join(dir, 'test-failure.json'))) rmSync(dir, { recursive: true, force: true });
  });
  const diagnostics = () => {
    const files = Object.fromEntries(['runner.json', 'result.json', 'heartbeat', 'stdout.json', 'stderr.log',
      'identity-ready', 'identity-release', 'drain-ready', 'drain-release', 'identity-callback.json', 'drain-callback.json'].map((name) => {
      try { return [name, readFileSync(join(dir, name), 'utf8').slice(-4000)]; }
      catch (error) { return [name, error.code]; }
    }));
    const evidence = { dir, exitCode: child.exitCode, signalCode: child.signalCode, output, files };
    writeFileSync(join(dir, 'test-failure.json'), JSON.stringify(evidence, null, 2));
    return evidence;
  };
  return { dir, child, exited, diagnostics, result: () => readJsonIfExists(join(dir, 'result.json')) };
}
// The orphan mutates the run directory as soon as the test writes `release`, which it does only after the point the
// orphan must not outlive (published result, owned stop, runner death). A fixed 4 s orphan timer raced the PowerShell
// drain and stop, which take seconds under load, so a contained orphan could write before success was published (historical regression).
const descendant = [
  "import { spawn } from 'node:child_process';",
  "import { writeFileSync } from 'node:fs';",
  "const child = spawn(process.execPath, ['-e', \"const fs = require('node:fs'); setInterval(() => fs.existsSync('release') && fs.writeFileSync('late.txt', 'unsafe'), 50)\"],",
  "{ cwd: process.cwd(), detached: true, windowsHide: true, stdio: 'ignore' });",
  "child.unref(); writeFileSync('started.txt', String(child.pid));",
].join('\n');
/** Release any surviving orphan, then report whether it mutated the run directory. */
async function orphanWrote(run) {
  writeFileSync(join(run.dir, 'release'), '');
  await sleep(4300);
  return existsSync(join(run.dir, 'late.txt'));
}

test('runner contains detached descendants before publishing success', { skip: process.platform !== 'win32' }, async (t) => {
  const run = launch(t, descendant + "console.log('complete'); process.exit(0);");
  const result = await waitFor(run.result, run.diagnostics);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.containmentStopped, true);
  assert.equal(readFileSync(join(run.dir, 'stdout.json'), 'utf8').trim(), 'complete');
  await run.exited;
  assert.equal(await orphanWrote(run), false, 'orphan cannot mutate after success');
});

test('runner timeout kills root and detached descendants before publishing timeout', { skip: process.platform !== 'win32' }, async (t) => {
  const run = launch(t, descendant + 'setInterval(() => {}, 1000);', 150);
  const result = await waitFor(run.result, run.diagnostics);
  assert.equal(result.timedOut, true, JSON.stringify(result));
  assert.equal(result.containmentStopped, true);
  await run.exited;
  assert.equal(await orphanWrote(run), false);
});

test('owned stop refuses a reused PID identity, then stops the exact whole job', { skip: process.platform !== 'win32' }, async (t) => {
  const run = launch(t, descendant + 'setInterval(() => {}, 1000);');
  // The helper prints its ready line and starts the worker at once; the runner rewrites runner.json with the job identity
  // only when it reads that line, which under load can come after the worker started (historical regression). Stop on the complete receipt.
  const metadata = await waitFor(() => existsSync(join(run.dir, 'started.txt')) &&
    [readJsonIfExists(join(run.dir, 'runner.json'))].find((receipt) => receipt?.containment), run.diagnostics);
  assert.equal(stopOwnedRun({ ...metadata, creationTime: '1' }), 'identity-mismatch');
  assert.equal(run.child.exitCode, null);
  assert.equal(stopOwnedRun({ ...metadata, containment: undefined }), 'ownership-unavailable');
  assert.equal(stopOwnedRun(metadata), 'stopped');
  await run.exited;
  assert.equal(run.result(), null, 'cancellation never publishes success');
  assert.equal(await orphanWrote(run), false);
});

test('abrupt runner death closes the only job handle and kills detached descendants', { skip: process.platform !== 'win32' }, async (t) => {
  const run = launch(t, descendant + 'setInterval(() => {}, 1000);');
  await waitFor(() => existsSync(join(run.dir, 'started.txt')));
  run.child.kill();
  await run.exited;
  assert.equal(await orphanWrote(run), false);
  assert.equal(run.result(), null);
});

test('unsupported runtimes fail closed before starting a worker', { skip: process.platform === 'win32' }, async (t) => {
  const run = launch(t, "require('node:fs').writeFileSync('started.txt', 'unsafe')");
  const result = await waitFor(run.result, run.diagnostics);
  assert.match(result.spawnError, /Windows Job Object/);
  assert.equal(existsSync(join(run.dir, 'started.txt')), false);
});

test('native process launch preserves arguments and prompt bytes', { skip: process.platform !== 'win32' }, async (t) => {
  const argv = ['', 'two words', 'a"quoted"value', 'ending\\', 'slash\\"quote', 'שלום'];
  const run = launch(t, "import { readFileSync } from 'node:fs'; console.log(JSON.stringify({ argv: process.argv.slice(2), prompt: readFileSync(0, 'utf8') }));", 10_000, argv);
  const result = await waitFor(run.result, run.diagnostics);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.deepEqual(JSON.parse(readFileSync(join(run.dir, 'stdout.json'), 'utf8')), { argv, prompt: 'synthetic prompt' });
});

test('unavailable containment helper never starts a worker', { skip: process.platform !== 'win32' }, async (t) => {
  const run = launch(t, "import { writeFileSync } from 'node:fs'; writeFileSync('started.txt', 'unsafe');",
    10_000, [], (dir) => {
      // Node 24 initializes CSPRNG using SystemRoot before preloads. Change it
      // after bootstrap so this probes the missing helper, rather than aborting Node.
      const preload = join(dir, 'missing-helper.cjs');
      writeFileSync(preload, `process.env.SystemRoot = ${JSON.stringify(join(tmpdir(), 'aiworks-no-windows'))};`);
      return { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
    });
  const result = await waitFor(run.result, run.diagnostics);
  assert.ok(result.spawnError);
  assert.equal(result.containmentStopped, true);
  assert.equal(existsSync(join(run.dir, 'started.txt')), false);
});

test('runner heartbeats continue while native identity and drain proof are pending', { skip: process.platform !== 'win32' }, async (t) => {
  const run = launch(t, "console.log('complete');", 10_000, [], (dir) => {
    const preload = join(dir, 'hold-native.cjs');
    writeFileSync(preload, [
      "if (process.argv[1]?.endsWith('runner.mjs')) {",
      "  const cp = require('node:child_process');",
      "  const fs = require('node:fs');",
      "  const path = require('node:path');",
      "  const original = cp.execFile;",
      "  cp.execFile = (file, args, options, callback) => {",
      "    const phase = args.includes('-Command') ? 'identity' : 'drain';",
      "    return original(file, args, options, (...result) => {",
      "      const [error, stdout, stderr] = result;",
      "      fs.writeFileSync(path.join(process.argv[2], phase + '-callback.json'), JSON.stringify({ error: error && { code: error.code, killed: error.killed, signal: error.signal }, stdout: String(stdout).slice(-4000), stderr: String(stderr).slice(-4000) }));",
      "      fs.writeFileSync(path.join(process.argv[2], phase + '-ready'), '');",
      "      const timer = setInterval(() => {",
      "        if (!fs.existsSync(path.join(process.argv[2], phase + '-release'))) return;",
      "        clearInterval(timer); callback(...result);",
      "      }, 20);",
      "    });",
      "  };",
      "  require('node:module').syncBuiltinESMExports();",
      "}",
    ].join('\n'));
    return { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '') + ' --require "' + preload.replaceAll('\\', '/') + '"' };
  });
  for (const phase of ['identity', 'drain']) {
    await waitFor(() => existsSync(join(run.dir, phase + '-ready')), run.diagnostics);
    const before = Number(readFileSync(join(run.dir, 'heartbeat'), 'utf8'));
    await waitFor(() => Number(readFileSync(join(run.dir, 'heartbeat'), 'utf8')) > before, run.diagnostics);
    assert.equal(run.result(), null, 'unsettled native proof must not publish a result');
    if (phase === 'identity') assert.equal(existsSync(join(run.dir, 'stdout.json')), false, 'worker waits for exact runner identity');
    writeFileSync(join(run.dir, phase + '-release'), '');
  }
  const result = await waitFor(run.result, run.diagnostics);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.containmentStopped, true);
});

test('a heartbeat that cannot be written never kills the runner or its result (historical regression)', { skip: process.platform !== 'win32' }, async (t) => {
  // A reader, scanner or indexer holding `heartbeat` makes the Windows rename fail (EPERM). A directory in its
  // place makes every beat fail deterministically. The runner must skip those beats, not crash: a crash
  // closed the job handle, killed the worker and left no result.json (the historical regression supervisor-test signature).
  const run = launch(t, "await new Promise((done) => setTimeout(done, 300)); console.log('complete');", 10_000, [], (dir) => {
    mkdirSync(join(dir, 'heartbeat', 'blocked'), { recursive: true });
    return process.env;
  });
  const result = await waitFor(run.result, run.diagnostics);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.containmentStopped, true);
  assert.equal(readFileSync(join(run.dir, 'stdout.json'), 'utf8').trim(), 'complete');
});
