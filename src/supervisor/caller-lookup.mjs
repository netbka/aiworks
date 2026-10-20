// The production process lookup of the dashboard's caller check (local-admission.mjs checkCaller, WORK_ENVELOPE 8.2).
// It runs the hidden native helper windows-caller.ps1 for one request's loopback connection and answers
// `{ pid, ancestors, jobs }`, or throws: an unknown or ambiguous endpoint, a pid whose identity changed, ancestry or job
// information it cannot read, or a job it cannot see while the run's runner is alive. checkCaller then fails closed.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { helperArgs, POWERSHELL } from './proc.mjs';

export const WINDOWS_CALLER_HELPER = fileURLToPath(new URL('./windows-caller.ps1', import.meta.url));
const JOB_NAME = /^Local\\aiworks-supervisor-[0-9a-f-]{36}$/;
const LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const port = (value) => Number.isSafeInteger(value) && value > 0 && value <= 65535;

export class CallerLookupError extends Error {
  constructor(code) { super(`caller lookup failed (${code})`); this.name = 'CallerLookupError'; this.code = code; }
}

/**
 * `connection` is the request's socket; `jobNames` the job objects of AIWorks's open runs and `runners` their runners'
 * `{ jobName, pid, creationTime }`, so a job that is not visible from here while its runner lives refuses.
 */
export async function windowsCallerLookup(connection, { jobNames = [], runners = [] } = {}) {
  if (!POWERSHELL) throw new CallerLookupError('LOOKUP_UNSUPPORTED');
  const { remoteAddress, remotePort, localAddress, localPort } = connection ?? {};
  if (!LOOPBACK.test(remoteAddress ?? '') || !LOOPBACK.test(localAddress ?? '') || !port(remotePort) || !port(localPort)) {
    throw new CallerLookupError('LOOKUP_ENDPOINT');
  }
  if (!jobNames.every((name) => JOB_NAME.test(name))) throw new CallerLookupError('LOOKUP_JOB');
  const identity = (name) => {
    const runner = runners.find((entry) => entry.jobName === name);
    return Number.isSafeInteger(runner?.pid) && /^\d+$/.test(runner?.creationTime ?? '') ? `${runner.pid}:${runner.creationTime}` : '0:0';
  };
  const args = helperArgs(WINDOWS_CALLER_HELPER, { ClientAddress: remoteAddress, ClientPort: remotePort, ServerAddress: localAddress,
    ServerPort: localPort, Jobs: jobNames.join('|'), Runners: jobNames.map(identity).join('|') });
  const stdout = await new Promise((resolve) => execFile(POWERSHELL, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
    (error, out) => resolve(error ? null : out.trim())));
  let found = null;
  try { found = stdout ? JSON.parse(stdout) : null; } catch { found = null; }
  if (!found) throw new CallerLookupError('LOOKUP_REFUSED');
  return found;
}
