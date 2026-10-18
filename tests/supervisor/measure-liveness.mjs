#!/usr/bin/env node
// Measurement probe for historical regression, not a test: launches real contained runners (src/supervisor/runner.mjs) with a
// synthetic worker and records, from inside each runner, when it started, wrote runner.json, beat and finished.
// The process-test liveness bounds in helpers.mjs are derived from these numbers; rerun this under load to check them.
// Usage: node tests/supervisor/measure-liveness.mjs [--runs 10] [--parallel 2] [--worker-ms 3000] [--heartbeat-ms 100] [--stop 1]
// --stop 1 stops each run through stopOwnedRun as soon as its worker starts and records how long that owned stop took.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readJsonIfExists, stopOwnedRun } from '../../src/supervisor/proc.mjs';

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
};
const runs = option('runs', 10), parallel = option('parallel', 2), workerMs = option('worker-ms', 3000), heartbeatMs = option('heartbeat-ms', 100), stop = option('stop', 0) === 1;
const runnerPath = fileURLToPath(new URL('../../src/supervisor/runner.mjs', import.meta.url));

// Preloaded into the runner only: logs every receipt rename (and failed heartbeat rename) with its wall-clock time.
const PRELOAD = `if (process.argv[1]?.endsWith('runner.mjs')) {
const fs = require('node:fs'); const path = require('node:path'); const { syncBuiltinESMExports } = require('node:module');
const log = path.join(process.argv[2], 'timeline.log'); const rename = fs.renameSync;
fs.appendFileSync(log, 'boot ' + Date.now() + '\\n');
fs.renameSync = function (from, to) {
  const name = path.basename(String(to));
  try { const value = rename.apply(this, arguments); fs.appendFileSync(log, name + ' ' + Date.now() + '\\n'); return value; }
  catch (error) { if (name === 'heartbeat') fs.appendFileSync(log, 'missed ' + Date.now() + '\\n'); throw error; }
};
const cp = require('node:child_process'); const execFile = cp.execFile; const spawn = cp.spawn;
cp.execFile = function () { fs.appendFileSync(log, 'identity ' + Date.now() + '\\n'); return execFile.apply(this, arguments); };
cp.spawn = function () { fs.appendFileSync(log, 'helper ' + Date.now() + '\\n'); return spawn.apply(this, arguments); };
syncBuiltinESMExports();
}
`;

async function one() {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-measure-'));
  writeFileSync(join(dir, 'prompt.txt'), 'synthetic prompt');
  writeFileSync(join(dir, 'worker.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('worker-started', String(Date.now())); setTimeout(() => {}, ${workerMs});`);
  writeFileSync(join(dir, 'preload.cjs'), PRELOAD);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ argv: [process.execPath, join(dir, 'worker.mjs')], cwd: dir, timeoutMs: 120_000, heartbeatMs }));
  const spawnedAt = Date.now();
  // Detached with ignored stdio, exactly as the controller launches a runner.
  const child = spawn(process.execPath, [runnerPath, dir], { detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(join(dir, 'preload.cjs'))}` } });
  const exited = new Promise((done) => child.on('exit', done));
  let stopped = null;
  if (stop) {
    while (!existsSync(join(dir, 'worker-started')) && child.exitCode === null) await sleep(10);
    const metadata = readJsonIfExists(join(dir, 'runner.json'));
    const before = Date.now();
    stopped = { result: stopOwnedRun(metadata), ms: Date.now() - before, contained: Boolean(metadata?.containment) };
  }
  await exited;
  const lines = readFileSync(join(dir, 'timeline.log'), 'utf8').trim().split('\n').map((line) => line.split(' ')).map(([k, v]) => [k, Number(v)]);
  const at = (kind, nth = 0) => lines.filter(([k]) => k === kind)[nth]?.[1] ?? null;
  const beats = lines.filter(([k]) => k === 'heartbeat').map(([, v]) => v);
  const result = at('result.json');
  const gaps = beats.slice(1).map((value, i) => value - beats[i]);
  const finalGap = result && beats.length ? result - beats.at(-1) : null;
  const sample = {
    boot: at('boot') - spawnedAt, runnerJson: at('runner.json') - spawnedAt, firstBeat: beats[0] - spawnedAt,
    contained: at('runner.json', 1) ? at('runner.json', 1) - spawnedAt : null,
    workerStarted: existsSync(join(dir, 'worker-started')) ? Number(readFileSync(join(dir, 'worker-started'), 'utf8')) - spawnedAt : null,
    result: result ? result - spawnedAt : null, beats: beats.length, missed: lines.filter(([k]) => k === 'missed').length,
    maxBeatGap: Math.max(0, ...gaps), finalGap,
  };
  // Positive: the worker was already running before runner.json carried the containment identity a stop needs.
  // processCreationTime (one PowerShell start, 10 s timeout in proc.mjs) runs from `identity` until the helper is spawned.
  sample.identityMs = at('identity') !== null && at('helper') !== null ? at('helper') - at('identity') : null;
  sample.receiptAfterWorker = sample.contained !== null && sample.workerStarted !== null ? sample.contained - sample.workerStarted : null;
  if (stopped) Object.assign(sample, { stopMs: stopped.ms, stopResult: stopped.result, receiptContainedAtStop: stopped.contained });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return sample;
}

const samples = [];
for (let done = 0; done < runs; done += parallel) {
  samples.push(...await Promise.all(Array.from({ length: Math.min(parallel, runs - done) }, one)));
  await sleep(50);
}
const stats = (key) => {
  const values = samples.map((s) => s[key]).filter((v) => v !== null).sort((a, b) => a - b);
  return { min: values[0], median: values[Math.floor(values.length / 2)], max: values.at(-1) };
};
const keys = ['boot', 'runnerJson', 'firstBeat', 'contained', 'workerStarted', 'result', 'maxBeatGap', 'finalGap', 'missed', 'identityMs', 'receiptAfterWorker'];
const tally = (key) => Object.fromEntries([...new Set(samples.map((s) => String(s[key])))].map((v) => [v, samples.filter((s) => String(s[key]) === v).length]));
if (stop) keys.push('stopMs');
console.log(JSON.stringify({ ...(stop ? { stopResults: tally('stopResult'), receiptContainedAtStop: tally('receiptContainedAtStop') } : {}), at: new Date().toISOString(), runs, parallel, workerMs, heartbeatMs, cpus: (await import('node:os')).cpus().length,
  ms: Object.fromEntries(keys.map((key) => [key, stats(key)])) }, null, 2));
