// AW-022: a sign-in check that spends no tokens. Each configured CLI that offers a status command is asked, at most once
// every LOGIN_CHECK_MS, whether it is signed in. Only a definite "not signed in" records an untimed wait on that
// account, so AIWorks does not launch paid runs to find out and a chain moves to its next worker at once. A later
// definite "signed in" ends only a wait this check recorded; a wait a real run recorded keeps its own rules. Any other
// answer (a time-out, an unreadable reply, a missing command) changes nothing. Off unless config.json says
// `"loginCheck": true`. The reply is read in memory only: an account's address or organisation is never stored or logged.
import { spawn } from 'node:child_process';
import { accountWait, clearAccountWait, setAccountWait } from './accounts.mjs';

export const LOGIN_CHECK_MS = 30 * 60_000;
export const LOGIN_REASON = 'auth: sign-in check: the CLI reports it is not signed in';
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 64 * 1024;

/** What each CLI's status reply says: 'in', 'out', or null when it does not say for certain. */
export const LOGIN_CHECKS = Object.freeze({
  'claude-cli': { command: 'claude', args: ['auth', 'status', '--json'], read: (code, out) => {
    try {
      const reply = JSON.parse(out);
      return reply?.loggedIn === true ? 'in' : reply?.loggedIn === false ? 'out' : null;
    } catch { return null; }
  } },
  // Codex writes its status line to stderr; both streams are read.
  'codex-cli': { command: 'codex', args: ['login', 'status'], read: (code, stdout, stderr) => {
    const out = `${stdout}\n${stderr}`;
    return /not logged in/i.test(out) ? (code !== 0 ? 'out' : null) : code === 0 && /logged in/i.test(out) ? 'in' : null;
  } },
});

/** Run one status command with a time limit; resolves `{ code, out, err }`, `code` null when it did not finish. */
export function runStatus(argv, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolveRun) => {
    let out = '', err = '', done = false;
    const finish = (code) => { if (!done) { done = true; resolveRun({ code, out, err }); } };
    let child;
    try { child = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { finish(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (out.length < MAX_OUTPUT) out += chunk; });
    child.stderr.on('data', (chunk) => { if (err.length < MAX_OUTPUT) err += chunk; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => { clearTimeout(timer); finish(code); });
  });
}

/**
 * One pass over the configured CLIs. `ctl` provides store, config, cmd, now() and log(); `run` is injected by tests.
 * Returns the answers it acted on, by kind, for the log.
 */
export async function loginCheckPass(ctl, { run = runStatus } = {}) {
  if (ctl.config?.loginCheck !== true) return {};
  // With CAAM profiles each login lives in its own profile home, which a status command run here does not see.
  if (ctl.config?.caam?.enabled === true) return {};
  const checked = (ctl.loginChecked ??= new Map());
  const acted = {};
  for (const [kind, check] of Object.entries(LOGIN_CHECKS)) {
    // Only a command the operator configured: never a default name, so a test or a bare install runs nothing here.
    const base = ctl.config?.commands?.[check.command];
    if (!Array.isArray(base) || !base.length) continue;
    if (now(ctl) - (checked.get(kind) ?? -Infinity) < LOGIN_CHECK_MS) continue;
    checked.set(kind, now(ctl));
    const { code, out = '', err = '' } = await run([...base, ...check.args]);
    const answer = code === null ? null : check.read(code, out, err);
    const wait = accountWait(ctl.store, ctl.config, kind);
    // A wait still in force (a usage limit with its reset, or a failed login a run found) keeps its own rules and time.
    const active = wait && (wait.retry_at === null || wait.retry_at > now(ctl));
    if (answer === 'out' && !active) {
      setAccountWait(ctl.store, ctl.config, { kind, retryAt: null, reason: LOGIN_REASON, campaignId: 'login-check', now: now(ctl) });
      ctl.store.journal(null, 'login-check-signed-out', { executor: kind }, now(ctl));
      ctl.log?.(`login check: ${kind} reports it is not signed in; its account waits until it is`);
      acted[kind] = 'out';
    } else if (answer === 'in' && wait?.reason === LOGIN_REASON) {
      clearAccountWait(ctl.store, ctl.config, kind);
      ctl.store.journal(null, 'login-check-signed-in', { executor: kind }, now(ctl));
      ctl.log?.(`login check: ${kind} is signed in again; its account wait ended`);
      acted[kind] = 'in';
    }
  }
  return acted;
}

const now = (ctl) => (typeof ctl.now === 'function' ? ctl.now() : Date.now());
