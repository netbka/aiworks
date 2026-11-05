// One isolated retry per failed test file (owner decision 2026-11-05). On 2026-11-05 a verifier's 53-minute full gate
// failed only because tests/supervisor/browser-login.test.mjs hung until the file limit under load; run alone it passed.
// The supervisor refused the acceptance, and a new verifier ran all 107 files again. In 22 saved gate logs from
// 22 Oct-5 Nov about 47 of 49 failures were browser, preview, timing or lease waits under load.
//
// A file that fails in the full run now runs once more on its own, after every tier has finished, so nothing else
// competes with it. The gate passes only if every retried file passes alone. Every first failure stays in the log and
// is named in the final summary. Nothing is skipped, and no test changes. When more files fail than the retry limit
// allows, none is retried: that many failures is a broken change, not load.

export const COUNTS = Object.freeze(['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']);

/** The node:test count lines in one file's output, as numbers (a file stopped before its summary counts nothing). */
export function countsOf(text) {
  const counts = Object.fromEntries(COUNTS.map((key) => [key, 0]));
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (match) counts[match[1]] += Number(match[2]);
  }
  return counts;
}

/** The files to run again alone: every failed file when there are at most `limit` of them, else none. */
export function retryPlan(runs, limit) {
  const failed = runs.filter((run) => run.code !== 0).map((run) => run.file);
  if (!failed.length || !(limit > 0)) return { files: [], skipped: failed.length ? `retry is off (AIWORKS_TEST_RETRY_FILES=0)` : null };
  if (failed.length > limit) return { files: [], skipped: `${failed.length} files failed, more than the retry limit of ${limit}; none is retried` };
  return { files: failed, skipped: null };
}

/**
 * The tests one file's node:test output reports failed, each as its path of names (`suite > test`), so a failing
 * subtest is named on its own and not hidden by its failing parent. Nesting comes from the `# Subtest:` lines' indent.
 */
export function failedOf(text) {
  const names = [], path = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const subtest = /^( *)# Subtest: (.+)$/.exec(line);
    if (subtest) { path.length = Math.floor(subtest[1].length / 4); path.push(subtest[2].trim()); continue; }
    const match = /^( *)not ok \d+ - (.+)$/.exec(line);
    if (!match || / # TODO\b/.test(match[2])) continue;
    const depth = Math.floor(match[1].length / 4);
    names.push([...path.slice(0, depth), match[2].trim()].join(' > '));
  }
  return names;
}

/** Whether one file's output ends with its node:test count lines, so its failures are all listed (not killed or crashed). */
export const complete = (text) => /^# tests \d+$/m.test(String(text ?? '')) && /^# fail \d+$/m.test(String(text ?? ''));

// The most `# failed:` lines the summary lists. Past it one `# failed: not listed` line says the list is incomplete, so
// a reader comparing failures against a base (src/supervisor/gate.mjs failedTests) treats them as unknown.
export const FAILED_LINES = 50;

/**
 * The gate's result from every file's first run and the retries. A retried file counts with its retry: its tally and
 * exit code. Every other file counts with its first run. Status 1 when any file's counted run failed. Every failed
 * counted run is listed as `# failed: <file> :: <test>` per failed test. A failed run that stopped before its own
 * summary (killed at the file limit, or crashed) may hide more failures, so the list is then marked incomplete
 * (`# failed: not listed: ...`), and a reader treats every failure as unknown.
 */
export function settle(runs, retries) {
  const retried = new Map(retries.map((run) => [run.file, run]));
  const total = Object.fromEntries(COUNTS.map((key) => [key, 0]));
  let status = 0;
  const failed = [], unlisted = [];
  for (const run of runs) {
    const counted = retried.get(run.file) ?? run;
    for (const key of COUNTS) total[key] += counted.counts?.[key] ?? 0;
    if (counted.code !== 0) {
      status = 1;
      const names = counted.failed ?? [];
      if (counted.complete !== true || !names.length) unlisted.push(counted.file);
      failed.push(...names.map((name) => `${counted.file} :: ${name}`));
    }
  }
  const lines = retries.map((run) => {
    const first = runs.find((entry) => entry.file === run.file);
    return `# retried alone after exit ${first?.code ?? '?'}: ${run.file} ${run.code === 0 ? 'passed' : `failed again, exit ${run.code}`}`;
  });
  lines.push(...failed.slice(0, FAILED_LINES).map((id) => `# failed: ${id}`));
  if (failed.length > FAILED_LINES) lines.push(`# failed: not listed: ${failed.length - FAILED_LINES} more`);
  for (const file of unlisted) lines.push(`# failed: not listed: ${file} failed without a complete summary`);
  return { status, total, lines };
}
