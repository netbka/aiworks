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
// gate-pid.log (process id), gate-head.log (the commit it ran on and whether the checkout was clean when it started),
// gate-command.log (the command it ran, as a JSON array) and gate-previous.log (the log of the run before). wait exits
// 0 when the gate passed, 1 when it failed, 2 while it still runs, 3 when it died and 4 when no gate was started here.
// When a verification of a commit task ends, the controller reads gate.log, gate-exit.log, gate-head.log and
// gate-command.log through readGateRun (#43).
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
  head: 'gate-head.log', request: 'gate-request.log', spec: 'gate-spec.log', command: 'gate-command.log' });
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

// gate-command.log as start writes it: the command it ran, a JSON array of non-empty strings; null when absent or malformed.
const commandOf = (text) => {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) && value.length && value.every((part) => typeof part === 'string' && part) ? value : null;
  } catch { return null; }
};
const commandDigest = (command) => createHash('sha256').update(JSON.stringify(command)).digest('hex');

/**
 * The gate run the helper left in `dir` (#43), as the controller reads it when a verification ends: the exit code it
 * recorded (null when the gate never finished), its final node:test summary (null when the log has none), the test files
 * that exited non-zero (exitedFiles), the lines failedTests reads (failures; gateFailedTests reads them), the commit it
 * started on (gate-head.log; null when there is none) and the command it ran (gate-command.log; null when there is none,
 * as from a helper older than that record, or when the host request it names queued another command). Null when no
 * gate ran in `dir`. gate.log holds only the last run; the run before is gate-previous.log, which is not read. Nothing
 * here comes from the verifier's result.
 */
export function readGateRun(dir, expectedRequest = null) {
  const log = read(join(dir, GATE_FILES.log));
  if (log === null) return null;
  const head = read(join(dir, GATE_FILES.head));
  let exit = read(join(dir, GATE_FILES.exit))?.trim() || null;
  const recordedCommand = read(join(dir, GATE_FILES.command));
  let command = recordedCommand === null ? null : commandOf(recordedCommand);
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
      // The host request keeps the digest of the command it queued; a gate-command.log naming another is no record of it.
      if (command && request?.commandDigest !== commandDigest(command)) command = null;
    } catch { exit = null; command = null; }
    finally { store?.close(); }
  } else if (expectedRequest) exit = null;
  return { exit, summary: testSummary(log), exited: exitedFiles(log), failures: failureEvidence(log),
    head: head === null ? null : headOf(head), command };
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
 * Base compare reads the failed tests of the gate a verifier and a base check ran (base-check.mjs), from gate.log. Each
 * runner below names its own lines: `signs` say the runner ran (its start, summary or failure lines) and `lines` are
 * every line its `parse` reads, so a parse of only those lines is the parse of the whole log. `parse` gives the sorted
 * failed-test ids, or null when the list is unknown: no final summary (the log was cut short, or the run stopped
 * before it), a list the runner itself cut short, a test file or binary that crashed or was stopped before it reported
 * every test (it may hide more failures), a collection, build or setup failure, or fewer names than the runner's own
 * failed count. An id is only compared with the ids of the same runner under the same command on the base.
 */
const failed = (re, text) => Number(re.exec(text)?.[1] ?? 0);
const total = (lines, line, re) => lines.filter((each) => line.test(each)).reduce((sum, each) => sum + failed(re, each), 0);
const sorted = (ids) => [...new Set(ids)].sort();
// A pytest node id from its short-summary line: the text up to ` - <message>`, where that separator counts only outside
// the brackets of a parametrize id (`test_x[a - b]` is one id). Null when its brackets do not balance or it has a space
// outside them: the id is then unknown, never a shorter one that another test could share.
function pytestId(text) {
  let depth = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '[') depth += 1;
    else if (char === ']') { depth -= 1; if (depth < 0) return null; }
    else if (depth === 0 && char === ' ') return text.startsWith(' - ', at) ? text.slice(0, at) : null;
  }
  return depth === 0 ? text : null;
}

// A cargo test binary's own name, from the path in its `Running <source> (<path>)` line: the file name without `.exe` and
// without cargo's `-<16 hex>` hash, so the unit tests of two crates in one workspace never share a target.
const cargoBinary = (path) => path.split(/[\\/]/).pop().replace(/\.exe$/i, '').replace(/-[0-9a-f]{16}$/, '');

const RUNNERS = [
  {
    // scripts/run-tests.mjs: its summary after `# all test files` lists `# failed: <file> :: <test>`, at most 50, and
    // `# failed: not listed: ...` when the list is cut short or a file stopped before its own summary.
    name: 'run-tests', signs: [/^# all test files/, /^# (start|end) \S+/], lines: [/^# all test files/, /^# (start|end) \S+/, /^# failed: /],
    parse(lines) {
      const at = lines.findLastIndex((line) => line.startsWith('# all test files'));
      if (at < 0) return null;
      const ids = [];
      for (const line of lines.slice(at + 1)) {
        if (!line.startsWith('# failed: ')) return null; // a run that started after the summary and never finished
        const id = line.slice('# failed: '.length).trim();
        if (id.startsWith('not listed')) return null;
        if (id) ids.push(id);
      }
      return sorted(ids);
    },
  },
  {
    // node --test, TAP reporter. Its `not ok` lines name a test (`suite > test`) but not its file, so with several files
    // a failure of `works` in one file and of `works` in another read the same: any failure is an unknown list. Only a
    // finished run with no failure, cancellation or crashed file is read, as an empty list. scripts/run-tests.mjs, which
    // prefixes each id with its file, is the runner that gives a list for node:test.
    name: 'node-tap', signs: [/^TAP version \d+$/, /^# tests \d+$/],
    lines: [/^TAP version \d+$/, /^ *# Subtest: /, /^ *not ok \d+ - /, /^# (tests|fail|cancelled) \d+$/, /^ *exitCode: \d/, /^ *signal: '/],
    parse(lines) {
      const last = lines.findLastIndex((line) => /^# fail \d+$/.test(line));
      if (last < 0 || lines.slice(last + 1).some((line) => /not ok|# Subtest:|^TAP version/.test(line))) return null;
      if (lines.some((line) => /^ *(exitCode|signal):|^ *not ok /.test(line)) || total(lines, /^# cancelled /, /(\d+)/) > 0) return null;
      return total(lines, /^# fail /, /(\d+)/) > 0 ? null : [];
    },
  },
  {
    // node --test, spec reporter: `✖ <test> (<ms>)` nested two spaces per level under `▶ <suite>`, `ℹ fail N`, then a
    // `✖ failing tests:` list that repeats each failure without its suites, where a file that crashed reads 'test failed'.
    // As with TAP its ids carry no file, so any failure is an unknown list; only a finished run without one reads as [].
    name: 'node-spec', signs: [/^ℹ tests \d+$/, /^✖ failing tests:$/, /^ *✖ .+ \([\d.]+m?s\)$/],
    lines: [/^ *[▶✔✖] /, /^ℹ (tests|fail|cancelled) \d+$/, /^ *'test failed'$/],
    parse(lines) {
      if (!lines.some((line) => /^ℹ fail \d+$/.test(line)) || lines.some((line) => /^ *'test failed'$/.test(line))) return null;
      if (total(lines, /^ℹ cancelled /, /(\d+)/) > 0) return null;
      const names = [], path = [];
      let listing = false, summed = false;
      for (const line of lines) {
        if (line.startsWith('ℹ ')) { summed = true; continue; }
        if (line === '✖ failing tests:') { listing = true; continue; }
        const match = /^( *)([▶✔✖]) (.+?)(?: \([\d.]+m?s\))?( # (?:TODO|SKIP)\b.*)?$/.exec(line);
        if (!match || (listing && match[2] === '✖')) continue;
        // A test reported after a summary with no failure list is a second run; after a list, the next run's first line.
        if (summed && !listing && match[2] === '✖') return null;
        listing = false; summed = false;
        const depth = Math.floor(match[1].length / 2);
        if (match[2] === '▶') { path.length = depth; path.push(match[3]); continue; }
        if (match[2] === '✖' && !match[4]) names.push([...path.slice(0, depth), match[3]].join(' > '));
      }
      if (!summed && !listing) return null; // tests reported after the last summary: a run cut short
      return names.length || total(lines, /^ℹ fail /, /(\d+)/) > 0 ? null : [];
    },
  },
  {
    // vitest: ` FAIL  <file> > <suite> > <test>` per failed test, `Test Files` and `Tests` summary lines. A failed suite
    // (a file that did not load, a failing hook) or an unhandled error is not a list of tests, and neither is a run with
    // a skipped test file: --bail skips the files after the first failures, and they may hold more.
    name: 'vitest', signs: [/^ *RUN +v\d/, /^ *Test Files +\d/, /⎯ Failed Tests \d+ ⎯/, /⎯ Failed Suites \d+ ⎯/],
    lines: [/^ *RUN +v\d/, /^ *Test Files +\d/, /^ *Tests {2,}\d/, /^ *FAIL +\S/, /⎯ (Failed Suites \d+|Unhandled Errors?) ⎯/, /^ *Errors +\d+ errors?/],
    parse(lines) {
      const ends = lines.filter((line) => /^ *Test Files +\d/.test(line)).length;
      if (!ends || lines.filter((line) => /^ *RUN +v\d/.test(line)).length > ends) return null;
      if (lines.some((line) => /⎯ (Failed Suites|Unhandled Error)|^ *Errors +\d/.test(line))) return null;
      if (total(lines, /^ *Test Files +\d/, /(\d+) skipped/) > 0) return null;
      const ids = [];
      for (const line of lines) {
        const match = /^ *FAIL +(.+)$/.exec(line);
        if (!match) continue;
        if (/\[ .+ \]$/.test(match[1])) return null;
        ids.push(match[1]);
      }
      const names = sorted(ids);
      if (total(lines, /^ *Test Files +\d/, /(\d+) failed/) > 0 && !names.length) return null;
      return names.length < total(lines, /^ *Tests {2,}\d/, /(\d+) failed/) ? null : names;
    },
  },
  {
    // jest: `FAIL <file>` then `  ● <suite> › <test>` per failed test, `Test Suites:` and `Tests:` summary lines. A suite
    // that failed to run is not a list of tests, and neither is a run that stopped early (--bail): its summary counts
    // `N of M total`, and the suites that never ran may hold more failures.
    name: 'jest', signs: [/^Test Suites: /, /^Tests: +\d/, /^ *● /],
    lines: [/^ *(PASS|FAIL) +\S/, /^ *● /, /^Test Suites: /, /^Tests: +\d/],
    parse(lines) {
      if (!lines.some((line) => /^Tests: +\d/.test(line))) return null;
      if (lines.some((line) => /^(Test Suites|Tests):.*\bof \d+ total\b/.test(line))) return null;
      const ids = [];
      let file = null;
      for (const line of lines) {
        const header = /^ *(PASS|FAIL) +(.+?)(?: \([\d.]+ m?s\))?$/.exec(line);
        if (header) { file = header[1] === 'FAIL' ? header[2] : null; continue; }
        const bullet = /^ *● (.+)$/.exec(line);
        if (!bullet || file === null || bullet[1] === 'Console') continue;
        if (bullet[1] === 'Test suite failed to run') return null;
        ids.push(`${file} :: ${bullet[1]}`);
      }
      const names = sorted(ids);
      if (total(lines, /^Test Suites: /, /(\d+) failed/) > 0 && !names.length) return null;
      return names.length < total(lines, /^Tests: +\d/, /(\d+) failed/) ? null : names;
    },
  },
  {
    // pytest: `FAILED <node id> - <message>` and `ERROR <node id>` in the short test summary, and the final
    // `=== N failed, M passed in 1.2s ===`. An ERROR of a whole file is a collection error; `!!! ... !!!` is a run
    // interrupted (a collection error, -x, a keyboard interrupt).
    name: 'pytest', signs: [/^=+ test session starts =+$/, /^=+ .*\bin [\d.]+s\b.*=+$/],
    lines: [/^=+ test session starts =+$/, /^=+ .*\bin [\d.]+s\b.*=+$/, /^(FAILED|ERROR) \S/, /^!+ .* !+$/],
    parse(lines) {
      const end = /^=+ .*\bin [\d.]+s\b.*=+$/;
      const ends = lines.filter((line) => end.test(line)).length;
      if (!ends || lines.filter((line) => /^=+ test session starts/.test(line)).length > ends || lines.some((line) => line.startsWith('!'))) return null;
      const ids = [];
      for (const line of lines) {
        const match = /^(FAILED|ERROR) (.+)$/.exec(line);
        if (!match) continue;
        const id = pytestId(match[2]);
        if (!id?.includes('::')) return null;
        ids.push(id);
      }
      const names = sorted(ids);
      return names.length < total(lines, end, /(\d+) failed/) + total(lines, end, /(\d+) errors?\b/) ? null : names;
    },
  },
  {
    // go test: `--- FAIL: TestName` (a subtest `TestName/sub`) before its package's `FAIL\t<package>\t<time>` line, ids
    // `<package> :: <test>`. A panic stops the package's test binary; a build or setup failure runs no test. A run with a
    // failed package ends with a bare `FAIL` line after its last package line; without it the run stopped between
    // packages, and a later package may hold more failures.
    name: 'go', signs: [/^(ok {2}|FAIL|\? {3})\t\S/, /^ *--- FAIL: /],
    lines: [/^(ok {2}|FAIL|\? {3})\t\S/, /^ *--- FAIL: /, /^panic: /, /^FAIL$/],
    parse(lines) {
      const ids = [];
      let pending = [], packages = 0, closed = false;
      for (const line of lines) {
        if (line.startsWith('panic: ')) return null;
        // A bare FAIL with tests pending is the package's test binary ending its own output, before its package line.
        if (line === 'FAIL') { closed = !pending.length; continue; }
        const test = /^ *--- FAIL: (\S+)/.exec(line);
        if (test) { pending.push(test[1]); closed = false; continue; }
        const [status, pkg] = line.split('\t');
        packages += 1; closed = false;
        if (status !== 'FAIL') { if (pending.length) return null; continue; }
        if (line.includes('[') || !pending.length) return null; // [build failed], [setup failed], or no named test
        ids.push(...pending.map((name) => `${pkg} :: ${name}`));
        pending = [];
      }
      return !packages || pending.length || (ids.length && !closed) ? null : sorted(ids);
    },
  },
  {
    // dotnet test (VSTest console): `  Failed <fully qualified name> [<time>]` per failed test and one `Passed!  - Failed:
    // N, ...` or `Failed!  - Failed: N, ...` line per test run. An aborted run or a build error is not a list. dotnet test
    // runs one test project after another and its console output has no end of the whole run, so a log cut between two
    // projects reads like a finished one: a run with a failure is a list only when the SDK's closing `Test summary:
    // total: N, failed: F, ...` line comes after the last test run and F is the failed count of the runs.
    name: 'dotnet', signs: [/^(Passed|Failed)! +- +Failed: +\d/, /^ *Starting test execution/],
    lines: [/^(Passed|Failed)! +- +Failed: +\d/, /^ *Starting test execution/, /^ +Failed .+ \[[^\]]*\]$/, /Test Run Aborted|test run was aborted|Build FAILED|: error [A-Z]+\d+:/i,
      /^ *Test summary: total: \d+, failed: \d+/],
    parse(lines) {
      const end = /^(Passed|Failed)! +- +Failed: +\d/;
      const ends = lines.filter((line) => end.test(line)).length;
      if (!ends || lines.filter((line) => /^ *Starting test execution/.test(line)).length > ends) return null;
      if (lines.some((line) => /Test Run Aborted|test run was aborted|Build FAILED|: error [A-Z]+\d+:/i.test(line))) return null;
      const listed = lines.map((line) => /^ +Failed (.+) \[[^\]]*\]$/.exec(line)?.[1]).filter(Boolean);
      const count = total(lines, end, /Failed: +(\d+)/);
      if (listed.length < count) return null;
      if (!count && !listed.length) return [];
      const close = /^ *Test summary: total: \d+, failed: (\d+)/;
      const at = lines.findLastIndex((line) => close.test(line));
      if (at < 0 || at < lines.findLastIndex((line) => end.test(line) || /^ *Starting test execution/.test(line))) return null;
      return failed(close, lines[at]) === count ? sorted(listed) : null;
    },
  },
  {
    // cargo test: `test <name> ... FAILED` between a binary's `running N tests` and its `test result:` line, ids
    // `<target> :: <name>` with the target `<source> (<binary>)` from its `Running <source> (<path>)` line (a Running line
    // without its binary path is no list), or `Doc-tests <crate>`. Each
    // failed binary prints `error: test failed, to rerun pass ...`. Without --no-fail-fast cargo stops there, so later
    // binaries never ran; with it the run ends with `error: N target(s) failed:`, N the failed binaries. A run with a
    // failure is a list only when it ends with that line: a log cut between two binaries reads like a finished one. A
    // binary that crashed prints no `test result:`; a compile error runs nothing.
    name: 'cargo', signs: [/^test result: (ok|FAILED)\./, /^running \d+ tests?$/],
    lines: [/^test result: (ok|FAILED)\./, /^running \d+ tests?$/, /^ *Running \S/, /^ *Doc-tests \S/, /^test .+ \.\.\. FAILED$/, /^error/],
    parse(lines) {
      const ids = [];
      let target = '', open = false, count = 0, results = 0, failedResults = 0, reruns = 0, closing = null;
      for (const line of lines) {
        if (closing !== null) return null; // a line after the end of the run
        const end = /^error: (\d+) targets? failed:$/.exec(line);
        if (end) { if (open) return null; closing = Number(end[1]); continue; }
        if (line.startsWith('error: test failed, to rerun pass ')) { reruns += 1; continue; }
        if (line.startsWith('error')) return null;
        if (/^ *Running /.test(line)) {
          const running = /^ *Running (.+?) \((.+)\)$/.exec(line);
          if (open || !running) return null;
          target = `${running[1]} (${cargoBinary(running[2])})`;
          continue;
        }
        const doc = /^ *(Doc-tests \S+)$/.exec(line);
        if (doc) { if (open) return null; target = doc[1]; continue; }
        if (/^running \d+ tests?$/.test(line)) { if (open) return null; open = true; continue; }
        const test = /^test (.+) \.\.\. FAILED$/.exec(line);
        if (test) { if (!open) return null; ids.push(`${target} :: ${test[1]}`); continue; }
        if (!open) return null; // a result with no run before it
        open = false; results += 1;
        count += failed(/(\d+) failed/, line);
        if (line.startsWith('test result: FAILED.')) failedResults += 1;
      }
      if (open || !results || ids.length < count) return null;
      if (closing === null) return failedResults || reruns ? null : sorted(ids);
      return closing === failedResults && failedResults > 0 ? sorted(ids) : null;
    },
  },
];

// Colours are removed, and a line rewritten in place with \r counts as its last text.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const logLines = (text) => text.replace(ANSI, '').replaceAll('\r\n', '\n').split('\n').map((line) => line.slice(line.lastIndexOf('\r') + 1).trimEnd());
const matches = (patterns, line) => patterns.some((pattern) => pattern.test(line));
// The runners whose signs are in the log. scripts/run-tests.mjs prints each file's node:test output, so it is one runner.
function runnersOf(lines) {
  const found = RUNNERS.filter((runner) => lines.some((line) => matches(runner.signs, line)));
  return found.some((runner) => runner.name === 'run-tests') ? found.filter((runner) => !runner.name.startsWith('node-')) : found;
}
// More failed tests than this, or a longer failure excerpt, is no list: it would not fit a verification record.
const MAX_FAILED = 500, MAX_EVIDENCE = 200_000;

/**
 * The failed tests a gate log lists, sorted and unique, from the whole gate.log or a part of it that keeps the lines
 * its runner's parse reads (a run-tests summary block, or failureEvidence): scripts/run-tests.mjs, node:test (TAP or
 * spec), vitest, jest, pytest, go test, dotnet test or cargo test (RUNNERS). Null when they are unknown: an unrecognised
 * runner, more than one runner in the log, a list cut short or a test file that crashed (each runner's parse). An empty
 * array means the run reports no failed test.
 */
export function failedTests(text) {
  return failureList(text)?.ids ?? null;
}

/**
 * failedTests with the runner that named them: { runner, ids }, or null when the list is unknown. Ids of two runners are
 * never compared (a jest `file :: suite › test` and a run-tests `file :: test` are different tests), so base compare
 * keeps the runner with the base record and with a kept acceptance.
 */
export function failureList(text) {
  if (typeof text !== 'string') return null;
  const lines = logLines(text);
  const runners = runnersOf(lines);
  if (runners.length !== 1) return null;
  const [runner] = runners;
  const ids = runner.parse(lines.filter((line) => matches(runner.lines, line)));
  return ids && ids.length <= MAX_FAILED ? { runner: runner.name, ids } : null;
}

/**
 * The lines of a gate log that failedTests reads: every runner's signs and the found runner's own lines, so
 * failedTests(failureEvidence(log)) is failedTests(log). readGateRun keeps it with the run, so the merge gate parses the
 * same text again (result-review.mjs baseExplained). Null when there is no log or it is too long to keep, which reads
 * as an unknown list.
 */
export function failureEvidence(text) {
  if (typeof text !== 'string') return null;
  const lines = logLines(text);
  const runners = runnersOf(lines);
  const own = runners.length === 1 ? runners[0].lines : [];
  const kept = lines.filter((line) => matches(own, line) || RUNNERS.some((runner) => matches(runner.signs, line))).join('\n');
  return kept.length <= MAX_EVIDENCE ? kept : null;
}

/**
 * The failed tests of a recorded gate run: failedTests of the failure lines readGateRun kept. A run-tests summary must
 * name the same list, so the two views of one run never disagree. A run recorded before the failure lines were kept is
 * read from its run-tests summary, as then.
 */
export function gateFailedTests(run) {
  return gateFailureList(run)?.ids ?? null;
}

/** gateFailedTests with its runner ({ runner, ids }, failureList), or null when the list is unknown. */
export function gateFailureList(run) {
  if (!run || typeof run !== 'object') return null;
  const block = typeof run.summary === 'string' && run.summary.startsWith('# all test files');
  const listed = block ? failureList(run.summary) : null;
  if (!Object.hasOwn(run, 'failures')) return listed;
  const found = failureList(run.failures);
  if (found && block && (listed === null || listed.runner !== found.runner || listed.ids.join('\n') !== found.ids.join('\n'))) return null;
  return found;
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
  // The command this run uses, so base compare (base-check.mjs) compares a head and a base only under the same command.
  writeFileSync(GATE_FILES.command, `${JSON.stringify(command)}\n`);
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
    const started = await start(args, (id) => {
      requestId = id;
      // A controller parent binds to this selection, never a later mutable checkout receipt.
      if (process.send) process.send({ type: 'gate-request', id });
    });
    process.exitCode = started || await wait({ minutes: 120, pollSeconds: 1, requestId });
  }
  else if (action === 'run') await run(args[0], args.slice(1));
  else if (action === 'wait') process.exitCode = await wait({ minutes: option(args, '--minutes', 25), pollSeconds: option(args, '--poll-seconds', 10) });
  else {
    console.error('usage: node gate.mjs start [command...] | wait [--minutes 25] [--poll-seconds 10]');
    process.exitCode = 64;
  }
}
