#!/usr/bin/env node
// The runner owns a noninheritable Windows job handle; its death kills every worker descendant.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { drainJob, processCreationTime, POWERSHELL, windowsHelperArgs, workerEnv, writeAtomic } from './proc.mjs';

const runDir = process.argv[2];
if (!runDir) process.exit(2);
const file = (name) => join(runDir, name);
// The controller discards runner stdio, so record why a runner died before exiting as Node would.
process.on('uncaughtException', (error) => {
  try { appendFileSync(file('runner-error.log'), `${new Date().toISOString()} ${error?.code ?? ''} ${error?.stack ?? error}\n`); } catch { /* best effort */ }
  process.exit(1);
});
try { openSync(file('run.lock'), 'wx'); } catch { process.exit(3); }
const spec = JSON.parse(readFileSync(file('spec.json'), 'utf8'));
const startedAt = Date.now();
writeAtomic(file('runner.json'), JSON.stringify({ pid: process.pid, startedAt }));
// A reader, scanner or indexer holding `heartbeat` makes the Windows rename fail (EPERM). Skip that beat
// without retrying: the next one follows within heartbeatMs, and the controller only declares a run lost
// after staleMs without any beat. Throwing here killed the runner, its job and the worker (engineering-platform-archive#58).
const beat = () => {
  try { writeAtomic(file('heartbeat'), String(Date.now()), { retries: 0 }); } catch { /* missed beat */ }
};
beat();
const heartbeat = setInterval(beat, spec.heartbeatMs);
const jobName = `Local\\aiworks-supervisor-${randomUUID()}`;
let finished = false;
let attached = false;
let outcome = null;

async function finish(failure) {
  if (finished) return;
  finished = true;
  // A failed drain leaves no consumable result. Exiting closes our handle as a final kill safeguard.
  if (attached && await drainJob(jobName) !== 'stopped') process.exit(4);
  clearInterval(heartbeat);
  writeAtomic(file('result.json'), JSON.stringify({ ...(failure ?? outcome ?? { spawnError: 'containment-helper-failed' }),
    containment: 'windows-job-v1', containmentStopped: true, startedAt, endedAt: Date.now() }));
  process.exit(0);
}

if (!POWERSHELL) finish({ spawnError: 'Windows Job Object containment required' });
const creationTime = await processCreationTime(process.pid);
if (!creationTime) finish({ spawnError: 'runner-process-identity-unavailable' });
const helper = spawn(POWERSHELL, windowsHelperArgs('Run', jobName, { runDir, pid: process.pid, creationTime }),
{ windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: workerEnv(process.env, spec.env) });
helper.on('error', () => finish({ spawnError: 'containment-helper-unavailable' }));
createInterface({ input: helper.stdout }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.ready === true && message.creationTime === creationTime) {
    attached = true;
    writeAtomic(file('runner.json'), JSON.stringify({ pid: process.pid, startedAt, creationTime: message.creationTime,
      jobName, containment: 'windows-job-v1' }));
  } else if (message.outcome) outcome = message.outcome;
});
helper.on('close', (code) => finish(code === 0 && attached ? null : { spawnError: 'containment-helper-failed' }));
