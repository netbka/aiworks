#!/usr/bin/env node
// npm run rebuild [-- --root <installation root>] [--wait <minutes>] [--port <dashboard port>]
// Pause, drain, update and resume the AIWorks installation at --root (default: this checkout) to the trusted main,
// run from an operator checkout at exactly that commit (docs/SUPERVISOR.md section 6, "Rebuild"). Running it again
// after a failure continues where it stopped. The steps are src/supervisor/rebuild.mjs; this file supplies the
// external commands. Each one starts hidden: Node starts powershell.exe with windowsHide, and that PowerShell starts
// git, node and npm through hidden-exec.ps1 (ProcessStartInfo with CreateNoWindow on and UseShellExecute off), capturing
// stdout, stderr and the exit code. deploy.ps1 runs its own commands the same way.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { POWERSHELL } from '../../src/supervisor/proc.mjs';
import { rebuild } from '../../src/supervisor/rebuild.mjs';
import { selfHostingSettings } from '../../src/supervisor/self-hosting.mjs';

const source = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HIDDEN = fileURLToPath(new URL('./hidden-exec.ps1', import.meta.url));
const DEPLOY = fileURLToPath(new URL('./deploy.ps1', import.meta.url));

const { values } = parseArgs({ options: { root: { type: 'string' }, wait: { type: 'string' }, port: { type: 'string' } } });
const waitMinutes = values.wait === undefined ? 240 : Number(values.wait);
const port = values.port === undefined ? 4318 : Number(values.port);
if (!Number.isSafeInteger(waitMinutes) || waitMinutes < 1 || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
  console.error('usage: npm run rebuild [-- --root <installation root>] [--wait <minutes>] [--port <dashboard port>]');
  process.exit(2);
}
if (!POWERSHELL) {
  console.error('REBUILD_WINDOWS_ONLY: npm run rebuild maintains the Windows installation (scheduled tasks); nothing was changed');
  process.exit(2);
}
const root = resolve(values.root ?? source);

function powershell(args, timeoutMs) {
  const out = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...args],
    { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  return { exitCode: out.status ?? -1, stdout: out.stdout ?? '', stderr: `${out.stderr ?? ''}${out.error ? `\n${out.error.message}` : ''}` };
}

const services = {
  exec(file, args, { cwd, timeoutMs }) {
    const request = Buffer.from(JSON.stringify({ file, args, cwd, timeoutMs }), 'utf8').toString('base64');
    const out = powershell([HIDDEN, '-Request', request], timeoutMs + 60_000);
    try { return JSON.parse(out.stdout); } catch { return { exitCode: -1, stdout: '', stderr: `hidden-exec.ps1 failed (exit ${out.exitCode}): ${out.stderr}` }; }
  },
  // One step of deploy.ps1 (Stop, Install or Start).
  maintain(step, { sha, main, keepStop } = {}) {
    return powershell([DEPLOY, '-Step', step, '-Root', root, '-Node', process.execPath, '-Governance', 'no', '-KeepStop', keepStop ? 'yes' : 'no',
      ...(sha ? ['-Sha', sha, '-Main', main] : [])], 60 * 60_000);
  },
  async dashboardAnswers(dashboardPort) {
    try { return (await fetch(`http://127.0.0.1:${dashboardPort}/`, { signal: AbortSignal.timeout(5_000) })).ok; } catch { return false; }
  },
  processAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  },
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: Date.now,
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
};

try {
  const configFile = join(root, '.local/supervisor/config.json');
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
  const settings = selfHostingSettings(config);
  if (settings.problem) throw new Error(settings.problem);
  const configured = settings.local && config.repositories?.[settings.repository]?.path;
  // A self-hosting installation can keep its reviewed source apart from the checkout the operator opens.
  if (configured && realpathSync(configured).toLowerCase() !== realpathSync(source).toLowerCase()) {
    const stateFile = join(root, '.local/supervisor/rebuild/state.json');
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
    const recovering = ['stopped', 'backed-up', 'installed', 'started', 'resumed'].includes(state?.phase);
    const run = (file, args, cwd = configured, timeoutMs = 120_000) => services.exec(file, args, { cwd, timeoutMs });
    const trusted = recovering ? { exitCode: 0, stdout: state.target } : run(process.execPath,
      [join(root, '.local/runtime/src/supervisor/cli.mjs'), 'trusted-main', '--data', join(root, '.local/supervisor')], join(root, '.local/runtime'));
    const target = trusted.stdout?.split(/\r?\n/)[0].trim();
    const head = run('git', ['rev-parse', 'HEAD']);
    const status = run('git', ['status', '--porcelain']);
    if (trusted.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(target ?? '') || head.exitCode !== 0 || status.exitCode !== 0 ||
        head.stdout.trim() !== target || status.stdout.trim()) {
      throw new Error('The configured AIWorks source must be clean and at the reviewed trusted version before rebuilding; nothing was changed');
    }
    const launcher = join(configured, 'scripts/supervisor/rebuild.mjs');
    if (!existsSync(launcher)) throw new Error('The trusted AIWorks source does not contain the rebuild command yet; update that source first. Nothing was changed');
    console.log('AIWorks: rebuilding from the configured reviewed source. Waiting for active work to finish.');
    const result = run(process.execPath, [launcher, '--root', root, '--wait', String(waitMinutes), '--port', String(port)],
      configured, (waitMinutes + 120) * 60_000);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode === 0 ? 0 : 1;
  } else {
    const summary = await rebuild({ root, source, waitMinutes, port }, services);
    console.log(JSON.stringify(summary, null, 2));
  }
} catch (error) {
  console.error(`${error.code ?? error.name}: ${error.message}`);
  process.exitCode = 1;
}
