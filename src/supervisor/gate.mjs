// The full-gate helper a commit worker runs instead of improvising one (FULL_GATE_RULE in adapters/executors.mjs). On
// 2026-10-14 a verifier started npm run check as a background process, the process ended three minutes later without an
// exit code, and the verifier waited for a summary line that could no longer appear until its two-hour bound ended the
// run. Here `start` runs the gate as a separate process that records its own exit code, and `wait` checks every few
// seconds that the process still runs: a gate that ended without an exit code is reported as died at once.
//
//   node gate.mjs start [command...]                     default command: npm run check
//   node gate.mjs wait [--minutes 25] [--poll-seconds 10]
//
// Every file is a git-ignored .log in the working directory (#135): gate.log (output), gate-exit.log (exit code),
// gate-pid.log (process id) and gate-previous.log (the log of the run before). wait exits 0 when the gate passed, 1 when
// it failed, 2 while it still runs, 3 when it died and 4 when no gate was started here. When a verification of a commit
// task ends, the controller reads gate.log and gate-exit.log through readGateRun (#43).
//
// Gate slots: on 2026-10-17 four full gates ran at once on one PC and failed with "git init: not enough memory" and timing
// tests, and the supervisor refused the verifications (12 since 16 Oct). The gate command now runs only while it holds one
// of AIWORKS_GATE_SLOTS (default 2) machine-wide slots, lock files under AIWORKS_GATE_SLOTS_DIR (default <tmp>/aiworks-gate-
// slots); until then gate.log says it waits, and wait keeps reporting running. A gate started inside a gate (the suite's
// own gate tests) takes no slot. A slot whose process is gone, or older than SLOT_MAX_AGE_MS, is taken over.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const GATE_FILES = Object.freeze({ log: 'gate.log', exit: 'gate-exit.log', pid: 'gate-pid.log', previous: 'gate-previous.log' });
const SELF = fileURLToPath(import.meta.url);
const again = (action) => `node "${SELF.replaceAll('\\', '/')}" ${action}`;

const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const tail = (text, lines) => (text ?? '').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
// The final summary of scripts/run-tests.mjs (the block after "# all test files"), else the log's last lines.
const summary = (text) => {
  const at = (text ?? '').lastIndexOf('# all test files');
  return at >= 0 ? text.slice(at).trimEnd() : tail(text, 15);
};
// The final node:test summary only: the block after "# all test files", else the last run of node:test count lines.
// Unlike `summary`, never the log's last lines, so nothing but the tally reaches a published PR body.
const COUNT_LINE = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) \d+(\.\d+)?$/;
export function testSummary(text) {
  const lines = (text ?? '').replaceAll('\r\n', '\n').trimEnd().split('\n');
  const all = lines.findLastIndex((line) => line.startsWith('# all test files'));
  if (all >= 0) return lines.slice(all).join('\n');
  const first = lines.findLastIndex((line) => /^# tests \d+$/.test(line));
  if (first < 0) return null;
  let end = first;
  while (end + 1 < lines.length && COUNT_LINE.test(lines[end + 1])) end += 1;
  return lines.slice(first, end + 1).join('\n');
}

/**
 * The gate run the helper left in `dir` (#43), as the controller reads it when a verification ends: the exit code it
 * recorded (null when the gate never finished) and its final node:test summary (null when the log has none). Null when no
 * gate ran in `dir`. gate.log holds only the last run; the run before is gate-previous.log, which is not read.
 */
export function readGateRun(dir) {
  const log = read(join(dir, GATE_FILES.log));
  if (log === null) return null;
  return { exit: read(join(dir, GATE_FILES.exit))?.trim() || null, summary: testSummary(log) };
}

/** Why a recorded gate run failed: a non-zero exit code or a failed test in its summary. Null when it did not. */
export function gateFailure(run) {
  if (!run) return null;
  if (run.exit !== null && run.exit !== '0') return `exited ${run.exit}`;
  const failed = Number(/^# fail (\d+)$/m.exec(run.summary ?? '')?.[1] ?? 0);
  return failed > 0 ? `reports ${failed} failed test${failed === 1 ? '' : 's'}` : null;
}

const recordedPid = () => {
  const pid = Number(read(GATE_FILES.pid)?.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};
const exitCode = () => read(GATE_FILES.exit)?.trim() || null;
// Signal 0 tests for the process without touching it; EPERM means it exists under another account.
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const minutesSinceOutput = () => (existsSync(GATE_FILES.log) ? Math.floor((Date.now() - statSync(GATE_FILES.log).mtimeMs) / 60_000) : null);

function start(command) {
  const pid = recordedPid();
  if (pid !== null && exitCode() === null && alive(pid)) {
    console.log(`already running: process ${pid}. Wait for it with: ${again('wait')}`);
    return 0;
  }
  let commandError = null;
  if (!command.length) {
    // Keep the existing convenience only where this project actually defines it.
    // Other projects supply their documented gate explicitly; never guess a
    // smaller substitute for the checks their acceptance contract requires.
    let scripts;
    try { scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts; } catch { /* explicit command required */ }
    if (typeof scripts?.check !== 'string' || !scripts.check.trim()) {
      commandError = 'not started: this project has no npm check script. Read its verification contract and pass its full command to gate.mjs start <command...>.';
    }
    command = ['npm', 'run', 'check'];
  }
  try {
    if (existsSync(GATE_FILES.log)) renameSync(GATE_FILES.log, GATE_FILES.previous);
  } catch (error) {
    // Windows refuses to move a file another process still writes: part of the last gate may still run.
    console.log(`not started: ${GATE_FILES.log} is still in use (${error.code}), so part of the last gate may still run. Wait a minute and start again.`);
    return 1;
  }
  rmSync(GATE_FILES.exit, { force: true });
  const out = openSync(GATE_FILES.log, 'w');
  if (commandError) {
    // A failed attempt must replace a previous pass, never leave stale green evidence.
    writeFileSync(out, `${commandError}\n`);
    closeSync(out);
    writeFileSync(GATE_FILES.exit, 'command-required\n');
    console.log(commandError);
    return 1;
  }
  // Detached, so the worker's shell returns at once; it stays in the worker's containment, which ends it with the run.
  const child = spawn(process.execPath, [SELF, 'run', ...command], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  closeSync(out);
  writeFileSync(GATE_FILES.pid, `${child.pid}\n`);
  child.unref();
  console.log(`started: process ${child.pid} runs ${command.join(' ')} with its output in ${GATE_FILES.log}. Wait for it with: ${again('wait')}`);
  return 0;
}

const NESTED = 'AIWORKS_GATE_SLOT_HELD';
const SLOT_MAX_AGE_MS = 4 * 60 * 60_000;
export function slotSettings(env = process.env) {
  const count = Number(env.AIWORKS_GATE_SLOTS ?? 2);
  return { count: Number.isSafeInteger(count) && count >= 1 && count <= 8 ? count : 2,
    dir: env.AIWORKS_GATE_SLOTS_DIR || join(tmpdir(), 'aiworks-gate-slots') };
}

/** Whether the lock file is held: its process runs and it is younger than SLOT_MAX_AGE_MS. Unreadable for a minute: no. */
function held(file, now) {
  let holder = null;
  try { holder = JSON.parse(readFileSync(file, 'utf8')); } catch { /* being written, or left empty */ }
  if (holder) return Number.isSafeInteger(holder.pid) && alive(holder.pid) && now - holder.at < SLOT_MAX_AGE_MS;
  try { return now - statSync(file).mtimeMs < 60_000; } catch { return false; }
}
/** Takes a free or abandoned slot for this process: its lock file path, or null when every slot is held. */
export function takeSlot({ count, dir }, now = Date.now()) {
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= count; i += 1) {
    const file = join(dir, `slot-${i}.lock`);
    if (existsSync(file)) {
      if (held(file, now)) continue;
      // Two gates taking over the same abandoned slot at once can both run: the limit is a throttle, not a lock.
      rmSync(file, { force: true });
    }
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: now, cwd: process.cwd() }), { flag: 'wx' });
      return file;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return null;
}

async function slot(settings) {
  let said = false;
  for (;;) {
    const file = takeSlot(settings);
    if (file) {
      if (said) console.log(`# gate slot ${file} taken; the gate starts now`);
      return file;
    }
    if (!said) console.log(`# waiting for a free gate slot: ${settings.count} full gate(s) already run on this PC (${settings.dir})`);
    said = true;
    await sleep(5_000);
  }
}

// The detached process: runs the command through the shell (npm is npm.cmd on Windows) and records how it ended.
async function run(command) {
  let recorded = false, lock = null;
  const record = (value) => {
    if (recorded) return;
    recorded = true;
    if (lock) rmSync(lock, { force: true });
    writeFileSync(GATE_FILES.exit, `${value}\n`);
  };
  try { lock = process.env[NESTED] ? null : await slot(slotSettings()); }
  catch (error) { console.log(`# gate slots unavailable (${error.code ?? error.message}); the gate runs without one`); }
  const child = spawn(command.join(' '), { shell: true, stdio: 'inherit', windowsHide: true, env: { ...process.env, [NESTED]: '1' } });
  child.on('error', (error) => record(`spawn-error ${error.code ?? error.message}`));
  child.on('close', (code, signal) => record(code ?? signal));
}

async function wait({ minutes, pollSeconds }) {
  const pid = recordedPid();
  if (pid === null && exitCode() === null) {
    console.log(`no gate was started in this directory. Start it with: ${again('start')}`);
    return 4;
  }
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const code = exitCode();
    if (code !== null) {
      console.log(`finished: exit ${code}. Final summary from ${GATE_FILES.log}:\n${summary(read(GATE_FILES.log))}`);
      return code === '0' ? 0 : 1;
    }
    if (pid === null || !alive(pid)) {
      // The exit code is written before the process ends: read it once more before calling the gate dead.
      if (exitCode() !== null) continue;
      console.log(`died: process ${pid} ended without an exit code, so the gate never finished. ${GATE_FILES.log} ends with:\n` +
        `${tail(read(GATE_FILES.log), 5)}\nStart it again with: ${again('start')} (this log is kept as ${GATE_FILES.previous}).`);
      return 3;
    }
    if (Date.now() >= deadline) {
      const quiet = minutesSinceOutput();
      console.log(`running: process ${pid}${quiet === null ? '' : `; ${GATE_FILES.log} was last written ${quiet} minute(s) ago`}. ` +
        `It ends with:\n${tail(read(GATE_FILES.log), 3)}\nWait again with: ${again('wait')}`);
      return 2;
    }
    await sleep(Math.max(0, Math.min(pollSeconds * 1000, deadline - Date.now())));
  }
}

function option(args, name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = Number(args[at + 1]);
  if (!(value > 0)) throw new Error(`${name} needs a positive number`);
  return value;
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && samePath(resolve(process.argv[1]), SELF)) {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'start') process.exitCode = start(args);
  else if (action === 'run') await run(args);
  else if (action === 'wait') process.exitCode = await wait({ minutes: option(args, '--minutes', 25), pollSeconds: option(args, '--poll-seconds', 10) });
  else {
    console.error('usage: node gate.mjs start [command...] | wait [--minutes 25] [--poll-seconds 10]');
    process.exitCode = 64;
  }
}
