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
// gate-pid.log (process id), gate-head.log (the commit it ran on and whether the checkout was clean when it started) and
// gate-previous.log (the log of the run before). wait exits 0 when the gate passed, 1 when
// it failed, 2 while it still runs, 3 when it died and 4 when no gate was started here. When a verification of a commit
// task ends, the controller reads gate.log, gate-exit.log and gate-head.log through readGateRun (#43).
//
// Full checks share one durable host slot (gate-slot.mjs), independent of checkout, account profile and TEMP.
// A slot is released only after its contained command has stopped. Nested components must prove membership in
// the owning job and use their own contained subjob. Browser-session guards below remain advisory and separate.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { GATE_CONTEXT, GateSlotStore, gateActivity, gateCheckoutKey, gateHost, gateHostKey, recoverGateOwner, recoverQueuedRequests } from './gate-slot.mjs';
import { drainJob, gateJobMember, gateProcessIdentity, processCreationTime, POWERSHELL, windowsHelperArgs, writeAtomic } from './proc.mjs';

export const GATE_FILES = Object.freeze({ log: 'gate.log', exit: 'gate-exit.log', pid: 'gate-pid.log', previous: 'gate-previous.log',
  head: 'gate-head.log', request: 'gate-request.log', spec: 'gate-spec.log' });
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
 * The test files whose last run in a gate log exited non-zero, from scripts/run-tests.mjs's `# end <file> <ms> ms, exit
 * <code>` lines (a file retried alone counts with its retry), sorted. Null when the log has no such line (another runner).
 * In a run-tests.mjs older than its minimum-one-failure rule (test-retry.mjs settle), a file stopped at its time limit, or
 * that crashed before its own summary, added nothing to the `# fail` count (2026-11-05: `# fail 0` with exit 1), so these
 * lines are where such a file is named.
 */
export function exitedFiles(text) {
  const last = new Map();
  for (const line of (text ?? '').replaceAll('\r\n', '\n').split('\n')) {
    const match = /^# end (\S+) \d+ ms, exit (\S+)$/.exec(line);
    if (match) last.set(match[1], match[2]);
  }
  return last.size ? [...last].filter(([, code]) => code !== '0').map(([file]) => file).sort() : null;
}

// gate-head.log as start writes it: { sha, clean }. sha is null when git could not read the commit; clean is true for a
// clean checkout, false for a changed one and null when git status could not be read.
const headOf = (text) => {
  const [sha, state] = text.trim().split(/\s+/);
  return { sha: /^[0-9a-f]{40}$/.test(sha ?? '') ? sha : null, clean: state === 'clean' ? true : state === 'changed' ? false : null };
};

/**
 * The gate run the helper left in `dir` (#43), as the controller reads it when a verification ends: the exit code it
 * recorded (null when the gate never finished), its final node:test summary (null when the log has none), the test files
 * that exited non-zero (exitedFiles) and the commit it started on (gate-head.log; null when there is none). Null when no
 * gate ran in `dir`. gate.log holds only the last run; the run before is gate-previous.log, which is not read. Nothing
 * here comes from the verifier's result.
 */
export function readGateRun(dir, expectedRequest = null) {
  const log = read(join(dir, GATE_FILES.log));
  if (log === null) return null;
  const head = read(join(dir, GATE_FILES.head));
  let exit = read(join(dir, GATE_FILES.exit))?.trim() || null;
  if (existsSync(join(dir, GATE_FILES.request))) {
    let store;
    try {
      const receipt = JSON.parse(read(join(dir, GATE_FILES.request)));
      if (expectedRequest && receipt.id !== expectedRequest) throw new Error('gate request changed');
      store = new GateSlotStore(gateHost().root, { readOnly: true });
      const request = store.request(receipt.id);
      const recorded = head === null ? { sha: null, clean: null } : headOf(head);
      if (!request || request.generation !== receipt.generation || request.createdAt !== receipt.createdAt ||
          request.checkoutKey !== gateCheckoutKey(dir) || request.head !== (recorded.sha ?? 'unknown') ||
          request.clean !== (recorded.clean === true) || !['finished','failed'].includes(request.state) || request.exit !== exit) exit = null;
    } catch { exit = null; }
    finally { store?.close(); }
  } else if (expectedRequest) exit = null;
  return { exit, summary: testSummary(log), exited: exitedFiles(log),
    head: head === null ? null : headOf(head) };
}

/**
 * Why a gate run is not a run of exactly `targetSha`, or null when its gate-head.log records that commit on a clean
 * checkout. Every verifier gate is to be started by this helper (FULL_GATE_RULE, for every project), whose start writes
 * that record, so a run without one tested an unknown commit (an older helper, or gate files written another way). The
 * record guards against honest mistakes, a gate run on another commit or a changed checkout; it proves nothing against
 * a verifier that writes the file itself, as it could write gate.log.
 */
export function gateHeadProblem(run, targetSha) {
  if (!run?.head) return `has no ${GATE_FILES.head}, which the gate helper's start writes, so the commit it tested is unknown`;
  if (run.head.sha === null) return `recorded no commit: git could not read the checkout's HEAD when the gate started`;
  if (run.head.sha !== targetSha) return `ran on ${run.head.sha}, not the verified ${targetSha}`;
  if (run.head.clean === null) return `cannot show a clean checkout: git status could not be read when the gate started`;
  if (!run.head.clean) return `started on a checkout with changes git does not ignore, so it did not test ${targetSha} as committed`;
  return null;
}

/**
 * The failed tests a gate summary lists (scripts/run-tests.mjs `# failed: <file> :: <test>` or `# failed: <file>` lines),
 * sorted and unique. Null when they are unknown: no run-tests summary block (another runner, or the gate stopped before
 * the tests), or a list the runner cut short. An empty array means the summary names no failed test.
 */
export function failedTests(summary) {
  if (typeof summary !== 'string' || !summary.startsWith('# all test files')) return null;
  const ids = new Set();
  for (const line of summary.split('\n')) {
    if (!line.startsWith('# failed: ')) continue;
    const id = line.slice('# failed: '.length).trim();
    if (id.startsWith('not listed')) return null;
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

// Why a gate exited with a numeric non-zero code while its summary counts no failed test, from its own log only. Comes
// first in a refusal, so the next verifier's note (cut at 300 characters) names the cause instead of `# fail 0`.
function uncountedCause(run) {
  const files = Array.isArray(run.exited) ? run.exited : null;
  if (files?.length) {
    return ` with no failed test counted, because ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''} exited ` +
      'non-zero (a file stopped at its time limit or crashed before its own summary adds no failed test to the count)';
  }
  if (run.summary === null) return ` before any test summary: a step before the tests, or the test command itself, failed (see ${GATE_FILES.log})`;
  const cancelled = Number(/^# cancelled (\d+)$/m.exec(run.summary)?.[1] ?? 0);
  if (cancelled > 0) return ` with no failed test counted but ${cancelled} cancelled test${cancelled === 1 ? '' : 's'}`;
  return files ? ` with no failed test counted, and every test file exited 0: a step after the tests failed` : ' with no failed test counted';
}

/**
 * Why a recorded gate run failed: not a run of the verified head (the headProblem the controller keeps with it, from
 * gateHeadProblem), a non-zero exit code or a failed test in its summary. Null when it did not. A non-zero exit whose
 * summary counts no failed test says why (uncountedCause); it is a failure all the same.
 */
export function gateFailure(run) {
  if (!run) return null;
  if (run.headProblem) return run.headProblem;
  const failed = Number(/^# fail (\d+)$/m.exec(run.summary ?? '')?.[1] ?? 0);
  if (run.exit !== null && run.exit !== '0') return `exited ${run.exit}${failed > 0 || !/^\d+$/.test(run.exit) ? '' : uncountedCause(run)}`;
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

// The commit this checkout is at and whether it is clean (every git status entry is one of the helper's own untracked files),
// as gate-head.log records it when a gate starts; "unknown" when git cannot read them. Short bounds, so start stays well
// inside the supervisor's own 60-second bound on it (merge-refresh.mjs startGate) on a slow checkout.
function checkoutState() {
  const git = (timeout, ...args) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true, timeout });
  const sha = git(10_000, 'rev-parse', 'HEAD').stdout?.trim() ?? '';
  if (!/^[0-9a-f]{40}$/.test(sha)) return 'unknown';
  const status = git(30_000, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  if (status.status !== 0) return `${sha} unknown`;
  const own = new Set(Object.values(GATE_FILES));
  const clean = status.stdout.split('\0').filter(Boolean).every((entry) => entry.startsWith('?? ') && own.has(entry.slice(3)));
  return `${sha} ${clean ? 'clean' : 'changed'}`;
}

async function start(command, requestSelected = () => {}) {
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
  const state = checkoutState(), parsed = headOf(state), identity = { pid: process.pid, creationTime: await processCreationTime(process.pid) };
  if (!identity.creationTime) { console.log('not started: exact process identity unavailable'); return 1; }
  let store, queued;
  try {
    store = new GateSlotStore();
    await recoverGateOwner(store);
    await recoverQueuedRequests(store);
    queued = store.enqueue({ cwd: process.cwd(), head: parsed.sha ?? 'unknown', clean: parsed.clean === true, launcher: identity,
      commandDigest: createHash('sha256').update(JSON.stringify(command)).digest('hex') });
    requestSelected(queued.request.id);
    if (!queued.created) {
      const expected = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      if (queued.request.commandDigest !== expected || queued.request.head !== (parsed.sha ?? 'unknown')) {
        console.log('not started: this checkout already has a different gate request; its evidence cannot be reused'); return 1;
      }
      console.log(`already running: request ${queued.request.id}. Wait for it with: ${again('wait')}`); return 0;
    }
  } catch (error) { console.log(`not started: host gate ownership unavailable (${error.code ?? error.message})`); return 1; }
  finally { store?.close(); }
  const failStart = (reason) => {
    const current = new GateSlotStore();
    try { current.failQueued(queued.request.id, identity, reason); } finally { current.close(); }
  };
  try {
    if (existsSync(GATE_FILES.log)) renameSync(GATE_FILES.log, GATE_FILES.previous);
  } catch (error) {
    // Windows refuses to move a file another process still writes: part of the last gate may still run.
    console.log(`not started: ${GATE_FILES.log} is still in use (${error.code}), so part of the last gate may still run. Wait a minute and start again.`);
    failStart('evidence-unavailable');
    return 1;
  }
  rmSync(GATE_FILES.exit, { force: true });
  writeFileSync(GATE_FILES.head, `${state}\n`);
  writeAtomic(GATE_FILES.request, JSON.stringify({ id: queued.request.id, generation: null, createdAt: queued.request.createdAt }));
  const out = openSync(GATE_FILES.log, 'a');
  if (commandError) {
    // A failed attempt must replace a previous pass, never leave stale green evidence.
    writeFileSync(out, `${commandError}\n`);
    closeSync(out);
    writeFileSync(GATE_FILES.exit, 'command-required\n');
    failStart('command-required');
    console.log(commandError);
    return 1;
  }
  // Detached, so the worker's shell returns at once; it stays in the worker's containment, which ends it with the run.
  const child = spawn(process.execPath, [SELF, 'run', queued.request.id, ...command], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.on('error', () => { failStart('spawn-failed'); });
  closeSync(out);
  writeFileSync(GATE_FILES.pid, `${child.pid}\n`);
  if (child.pid) {
    const creationTime = await processCreationTime(child.pid);
    if (creationTime) {
      const current = new GateSlotStore();
      try { current.bind(queued.request.id, { pid: child.pid, creationTime }); } finally { current.close(); }
    }
  }
  child.unref();
  console.log(`started: process ${child.pid} runs ${command.join(' ')} with its output in ${GATE_FILES.log}. Wait for it with: ${again('wait')}`);
  return 0;
}

const NESTED = GATE_CONTEXT;
// Browser-session guards retain their advisory heartbeat/lifetime policy. These clocks never release a gate slot.
const STALE_MS = 2 * 60_000;
const MAX_LIFE_MS = 120 * 60_000;
// A time more than this far ahead (the clock was set back) proves nothing: the lock is not held.
const FUTURE_MS = 60_000;
// The longest a gate waits for web task runs to leave the browser session; then it goes on and says so in gate.log.
const BROWSER_WAIT_MS = 30 * 60_000;
export function slotSettings() { return { count: 1, dir: gateHost().root }; }

// When a file was last written, or 0 when it cannot be read.
const mtime = (file) => {
  try { return statSync(file).mtimeMs; } catch { return 0; }
};
// Whether time `at` lies within the last `limit` ms, and not more than FUTURE_MS ahead.
const within = (at, now, limit) => Number.isFinite(at) && now - at < limit && at - now < FUTURE_MS;
/**
 * Whether the lock file is held: its process runs, its last beat is younger than STALE_MS and its gate started less than
 * MAX_LIFE_MS ago. The beat is the lock's `at`, or for a browser lock the later write of the run's `heartbeat` file; the
 * start is `startedAt`, or `at` in a lock that has none. Unreadable for a minute: no.
 */
function held(file, now) {
  let holder = null;
  try { holder = JSON.parse(readFileSync(file, 'utf8')); } catch { /* being written, or left empty */ }
  if (holder) {
    const beat = Math.max(Number(holder.at) || 0, typeof holder.heartbeat === 'string' ? mtime(holder.heartbeat) : 0);
    return Number.isSafeInteger(holder.pid) && within(beat, now, STALE_MS)
      && within(Number(holder.startedAt ?? holder.at), now, MAX_LIFE_MS) && alive(holder.pid);
  }
  return within(mtime(file), now, 60_000);
}
/** Durable active gates and queued requests pause admission; unreadable ownership is never free capacity. */
export function heldSlotCount({ dir } = slotSettings(), now = Date.now()) {
  const state = gateActivity();
  if (!state.available) throw new Error('host gate ownership unavailable');
  let waiting = 0;
  try { waiting = readdirSync(dir).filter((name) => /^waiting-\d+\.lock$/.test(name) && held(join(dir,name),now)).length; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return state.count + waiting;
}
/** A caller's timeout never releases possibly live command custody. */
export function retireGate() { return 0; }

// Browser-session locks (owner decision 2026-11-05): a web task's run may drive the owner's own Chrome session, and full
// gates and those runs never overlap. With the gate pause on (host.mjs gatePauseOn: the scheduler on and pauseAtGates
// under 99) the supervisor writes browser-<operation>.lock in the slot folder, holding the run's runner process id and the
// path of its heartbeat file, when it launches a web task, removes it when the operation settles, and marks that run's
// environment with BROWSER_RUN, so a gate the same run starts does not wait for itself. With it off no lock is written, so
// no gate waits. A lock whose runner ended, or whose run has not beaten for STALE_MS, is removed by the next gate that
// reads it.
export const BROWSER_RUN = 'AIWORKS_BROWSER_RUN';
export const browserLockPath = (dir, operationId) => join(dir, `browser-${operationId}.lock`);
/** The web task runs that hold the owner's browser session now, other than `own`; locks no longer held are removed. */
export function heldBrowserRuns({ dir }, now = Date.now(), own = process.env[BROWSER_RUN] ?? null) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const runs = [];
  for (const name of names) {
    const match = /^browser-(.+)\.lock$/.exec(name);
    if (!match || match[1] === own) continue;
    const file = join(dir, name);
    if (held(file, now)) runs.push(match[1]);
    else {
      // Another account's file, or one being read, may refuse removal; it is not held either way.
      try { rmSync(file, { force: true }); } catch { /* a later gate removes it */ }
    }
  }
  return runs;
}

async function browserWait(settings, deadline) {
  const since = Date.now(); let said = false;
  while (heldBrowserRuns(settings).length && Date.now() - since < BROWSER_WAIT_MS) {
    if (Date.now() >= deadline) return false;
    if (!said) console.log('# waiting: another web task uses the browser session');
    said = true;
    await sleep(1000);
  }
  if (said && Date.now() - since >= BROWSER_WAIT_MS) console.log('# browser-session wait bound reached; the gate continues under its own exclusive slot');
  return Date.now() < deadline;
}

// A gate owns its noninheritable job handle. It acknowledges native attachment durably before permitting execution.
async function run(id, command) {
  let store, lease = null, attached = false;
  const identity = { pid: process.pid, creationTime: await processCreationTime(process.pid) };
  const deadline = Date.now() + 120 * 60_000;
  try {
    if (!identity.creationTime || !POWERSHELL) throw new Error('gate custody unavailable');
    store = new GateSlotStore();
    if (!store.bind(id, identity)) throw new Error('gate request already belongs to another process');
    writeFileSync(GATE_FILES.pid, String(process.pid) + '\n');
    const request = store.request(id);
    if (request.commandDigest !== createHash('sha256').update(JSON.stringify(command)).digest('hex')) throw new Error('gate command differs from queued request');
    let context = null;
    try { context = JSON.parse(process.env[NESTED] ?? 'null'); } catch { /* never a nesting proof */ }
    let parent = null;
    if (context) {
      const owner = store.owner();
      if (context.host !== gateHostKey() || !owner || owner.attached !== true ||
          owner.requestId !== context.requestId || owner.generation !== context.generation || owner.token !== context.token ||
          await gateProcessIdentity(owner) !== 'running' || !await gateJobMember(identity, owner.jobName)) {
        throw new Error('nested gate ownership is not proven');
      }
      parent = owner;
    }
    if (!parent && !await browserWait(slotSettings(), deadline)) throw new Error('gate wait expired');
    let said = false;
    for (;;) {
      lease = store.claim(id, identity, 'Global\\aiworks-gate-' + randomUUID(), parent);
      if (lease) break;
      if (Date.now() >= deadline) throw new Error('gate wait expired');
      if (!said) console.log('# waiting: the host full-check slot is occupied; command has not started');
      said = true;
      await recoverGateOwner(store);
      await sleep(1000);
    }
    writeAtomic(GATE_FILES.request, JSON.stringify({ id, generation: lease.generation, createdAt: request.createdAt }));
    const current = headOf(checkoutState());
    if (request.head !== 'unknown' && (current.sha !== request.head || current.clean !== request.clean)) {
      store.finish(lease, 'checkout-changed', 'checkout-changed', () => writeFileSync(GATE_FILES.exit, 'checkout-changed\n')); return;
    }
    const permit = JSON.stringify({ requestId: id, generation: lease.generation, jobName: lease.jobName,
      pid: identity.pid, creationTime: identity.creationTime, token: lease.token });
    const wrapper = "const c=require('node:child_process').spawn(process.argv[1],{shell:true,stdio:'inherit',windowsHide:true});c.on('error',()=>process.exit(1));c.on('close',c=>process.exit(c===null?1:c));";
    writeAtomic(GATE_FILES.spec, JSON.stringify({ cwd: process.cwd(), argv: [process.execPath, '-e', wrapper, command.join(' ')],
      timeoutMs: Math.max(1, deadline-Date.now()), permit, output: resolve(GATE_FILES.log) }));
    const outer = parent ?? lease;
    const child = spawn(POWERSHELL, windowsHelperArgs('Gate', lease.jobName, { runDir: process.cwd(), ...identity }),
      { windowsHide: true, stdio: ['pipe','pipe','pipe'], env: { ...process.env,
        [NESTED]: JSON.stringify({ host: gateHostKey(), requestId: outer.requestId, generation: outer.generation, token: outer.token }) } });
    let outcome = null, failed = null;
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.stdin.on('error', () => { failed = 'native-permit-unavailable'; });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.ready === true && value.creationTime === identity.creationTime && !attached) {
        // Only a successful native Attach can produce this private pipe acknowledgement. A reserved job name is not custody.
        attached = true;
        try {
          if (!store.attached(lease)) { failed = 'gate-generation-changed'; child.stdin.end(); return; }
          child.stdin.end(permit+'\n');
        } catch { failed = 'gate-attachment-record-unavailable'; child.stdin.end(); }
      } else if (value.outcome) outcome = value.outcome;
    });
    const code = await new Promise((done) => { child.on('error', () => done(-1)); child.on('close', done); });
    if (!attached) {
      store.finish(lease, 'not-permitted', 'native-attach-failed', () => writeFileSync(GATE_FILES.exit, 'not-permitted\n')); return;
    }
    if (await drainJob(lease.jobName) !== 'stopped') {
      store.hold(lease, 'custody-unproven'); console.log('# held: command custody could not be proved stopped'); return;
    }
    const exit = failed || code !== 0 || !outcome ? 'native-gate-failed' : outcome.timedOut ? 'timeout' : outcome.exitCode;
    store.finish(lease, exit, null, () => writeFileSync(GATE_FILES.exit, String(exit)+'\n'));
  } catch (error) {
    console.log('# gate refused: '+(error.code ?? error.message));
    if (lease) {
      if (attached) store?.hold(lease, 'custody-unproven');
      else store?.finish(lease, 'not-permitted', 'not-permitted', () => writeFileSync(GATE_FILES.exit, 'not-permitted\n'));
    } else store?.failQueued(id, identity, 'gate-unavailable', () => writeFileSync(GATE_FILES.exit, 'gate-unavailable\n'));
  } finally { store?.close(); }
}

async function wait({ minutes, pollSeconds, requestId = null }) {
  let pid = recordedPid();
  if (pid === null && exitCode() === null && !requestId) {
    console.log(`no gate was started in this directory. Start it with: ${again('start')}`);
    return 4;
  }
  const deadline = Date.now() + minutes * 60_000;
  let expected = requestId;
  if (!expected) { try { expected = JSON.parse(read(GATE_FILES.request)).id; } catch { /* older helper output */ } }
  for (;;) {
    let receipt = null;
    try { receipt = JSON.parse(read(GATE_FILES.request)); } catch { /* unavailable evidence */ }
    if (expected && receipt?.id !== expected) {
      let store, current;
      try { store = new GateSlotStore(gateHost().root, { readOnly: true }); current = store.request(expected); }
      catch { console.log('incomplete: gate request ownership is unavailable'); return 1; }
      finally { store?.close(); }
      if (!current || !['queued','running','held'].includes(current.state)) {
        console.log('incomplete: this checkout no longer holds this request evidence'); return 1;
      }
      if (Date.now() >= deadline) { console.log('incomplete: the selected gate request did not finish within its wait bound'); return 2; }
      await sleep(Math.max(1, Math.min(pollSeconds * 1000, deadline - Date.now())));
      continue;
    }
    if (expected) {
      let store, current;
      try { store = new GateSlotStore(gateHost().root, { readOnly: true }); current = store.request(expected); }
      catch { console.log('incomplete: gate request ownership is unavailable'); return 1; }
      finally { store?.close(); }
      if (current?.state === 'queued' && !current.identity) {
        if (Date.now() >= deadline) { console.log('incomplete: the selected gate request was not acknowledged'); return 2; }
        await sleep(Math.max(1, Math.min(pollSeconds * 1000, deadline - Date.now()))); continue;
      }
      pid = current?.identity?.pid ?? recordedPid();
    }
    const code = readGateRun(process.cwd(), expected)?.exit;
    if (code !== null && code !== undefined) {
      console.log(`finished: exit ${code}. Final summary from ${GATE_FILES.log}:\n${summary(read(GATE_FILES.log))}`);
      return code === '0' ? 0 : 1;
    }
    if (pid === null || !alive(pid)) {
      // The exit code is written before the process ends: read it once more before calling the gate dead.
      if (readGateRun(process.cwd(), expected)?.exit != null) continue;
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
  if (action === 'start') process.exitCode = await start(args);
  else if (action === 'start-wait') {
    let requestId = null;
    const started = await start(args, (id) => { requestId = id; });
    process.exitCode = started || await wait({ minutes: 120, pollSeconds: 1, requestId });
  }
  else if (action === 'run') await run(args[0], args.slice(1));
  else if (action === 'wait') process.exitCode = await wait({ minutes: option(args, '--minutes', 25), pollSeconds: option(args, '--poll-seconds', 10) });
  else {
    console.error('usage: node gate.mjs start [command...] | wait [--minutes 25] [--poll-seconds 10]');
    process.exitCode = 64;
  }
}
