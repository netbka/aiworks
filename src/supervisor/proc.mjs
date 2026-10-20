// AIWorks process and file primitives shared by the controller and the detached runner.
import { execFile, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEVELOPMENT_ENV } from './development-policy.mjs';

export const WINDOWS_PROCESS_HELPER = fileURLToPath(new URL('./windows-process.ps1', import.meta.url));
export const POWERSHELL = process.platform === 'win32'
  ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : null;
const retrySleep = new Int32Array(new SharedArrayBuffer(4));

/**
 * Durable replace: write a temp file, fsync it, then rename over the target. A transient Windows denial is
 * retried (`retries` x 20 ms, blocking); periodic writes that can simply skip a beat pass `retries: 0`.
 */
export function writeAtomic(path, text, { retries = 50 } = {}) {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, path); return; }
    catch (error) {
      // Windows readers/scanners can briefly deny replacement; never remove the old durable receipt.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= retries) throw error;
      Atomics.wait(retrySleep, 0, 0, 20);
    }
  }
}

/**
 * A worker never inherits the supervisor's own Claude Code session variables (for example when the supervisor was
 * started from inside a Claude Code terminal); only the variables the controller put in the spec are added.
 */
export const workerEnv = (inherited, specEnv) => ({
  ...Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(CLAUDE_CODE_|CLAUDECODE$)/i.test(key))),
  ...(specEnv ?? {}),
  ...DEVELOPMENT_ENV,
});

export function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function readTextIfExists(path, maxBytes = 4 * 1024 * 1024) {
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8');
  return text.length > maxBytes ? text.slice(-maxBytes) : text;
}

function runPowerShell(args, timeout) {
  return new Promise((resolve) => execFile(POWERSHELL, args, { encoding: 'utf8', windowsHide: true, timeout },
    (error, stdout) => resolve(error ? null : stdout.trim())));
}

export async function processCreationTime(pid) {
  if (!POWERSHELL || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const value = await runPowerShell(['-NoProfile', '-NonInteractive', '-Command',
    `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc().ToString()`], 10_000);
  return /^\d+$/.test(value ?? '') ? value : null;
}

export function windowsHelperArgs(mode, jobName, { runDir, pid, creationTime } = {}) {
  const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
  const params = { Mode: mode, JobName: jobName, RunDir: runDir, RunnerPid: pid, CreationTime: creationTime };
  const command = `& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(WINDOWS_PROCESS_HELPER)})))` +
    Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => ` -${key} ${quote(value)}`).join('');
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
}

function jobCommand(mode, jobName, identity) {
  if (!POWERSHELL || !/^Local\\aiworks-supervisor-[0-9a-f-]{36}$/.test(jobName ?? '')) return 'ownership-unavailable';
  const out = spawnSync(POWERSHELL, windowsHelperArgs(mode, jobName, identity),
  { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return out.status === 0 ? out.stdout.trim() : 'stop-failed';
}

/** Wait for the entire job to stop before publishing output or replacing its workspace. */
export async function drainJob(jobName) {
  if (!POWERSHELL || !/^Local\\aiworks-supervisor-[0-9a-f-]{36}$/.test(jobName ?? '')) return 'ownership-unavailable';
  return await runPowerShell(windowsHelperArgs('Drain', jobName), 30_000) ?? 'stop-failed';
}

/** Compare the creation time on an open process handle, never a PID/image guess. */
export function stopOwnedRun(runner) {
  if (runner?.containment !== 'windows-job-v1' || !Number.isSafeInteger(runner.pid) || runner.pid <= 0 ||
      !/^\d+$/.test(runner.creationTime ?? '')) return 'ownership-unavailable';
  return jobCommand('Stop', runner.jobName, { pid: runner.pid, creationTime: runner.creationTime });
}
