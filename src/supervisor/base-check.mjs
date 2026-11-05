// Base compare (opt-in, config.json `baseCompare`; owner decision 2026-11-05, slice A2). Measured 2026-11-05: 48 verifier
// acceptances were refused because the verifier's own gate failed, about 28 hours of verifier time, and in the managed
// projects several tasks were verified 4 to 11 times for failures that were already on their base. A new verifier of
// the same head cannot fix a test the base already fails.
//
// The rule: when a verify operation of a commit task runs, the supervisor gates the task's base commit itself, once per
// (repository, base SHA, gate command), in its own detached worktree, through the gate helper (gate.mjs) as a separate
// process, exactly as the merge-gate refresh does (merge-refresh.mjs). An acceptance whose own gate failed still stands
// only when the base gate failed too and every failed test the head's summary names is one the base summary names
// (failedTests in gate.mjs). The acceptance then records those base failures. In every other case, among them a summary
// that names no tests, a base that passed, or a base check that could not run or did not finish in time, the acceptance
// is refused as before. While the base gate still runs, the accepted result is left unconsumed and read again later,
// up to the base check's own bound. A base gate is never killed; its worktree stays in place like every supervisor
// worktree.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as gitA from './adapters/git.mjs';
import { failedTests, gateFailure, readGateRun } from './gate.mjs';
import { alive, checkout, gatePid, startGate } from './merge-refresh.mjs';
import { recordGateResults } from './test-cache.mjs';

const DEFAULT_TIMEOUT_MINUTES = 120;

/**
 * `baseCompare` from config.json: `{ "command": ["npm", "ci", "&&", "npm", "run", "check"], "timeoutMinutes": 120 }`.
 * Absent: null (off; every failed gate refuses the acceptance, as before). Malformed: { problem }.
 */
export function baseCompareSettings(value) {
  if (value === undefined || value === null) return null;
  const problem = (text) => ({ problem: `baseCompare ${text}` });
  if (typeof value !== 'object' || Array.isArray(value)) return problem('must be an object');
  const { command, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES } = value;
  if (!Array.isArray(command) || !command.length || !command.every((part) => typeof part === 'string' && part.trim())) {
    return problem('.command must list the gate command, for example ["npm", "ci", "&&", "npm", "run", "check"]');
  }
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1) return problem('.timeoutMinutes must be a positive number of minutes');
  return { command: [...command], timeoutMs: timeoutMinutes * 60_000 };
}

const key = (command) => JSON.stringify(command);
const row = (store, repository, baseSha, command) => {
  const found = store.get('SELECT * FROM base_checks WHERE repository = ? AND base_sha = ? AND command = ?', repository.toLowerCase(), baseSha, key(command));
  return found ? { ...found, failed: found.failed === null ? null : JSON.parse(found.failed) } : null;
};

/** The base check record of `baseSha` under `settings`, read-only; null when none was started. */
export function baseRecord(store, repository, baseSha, settings) {
  return row(store, repository, baseSha, settings.command);
}

/**
 * One step of the base check of `baseSha` for a verify operation, inside its campaign step and holding its lease
 * (`ctx`). Starts the base gate when there is no record, reads it while it runs, and settles it once. Returns the
 * record: { state: 'running' | 'passed' | 'failed', failed: sorted test ids or null when unknown, reason }.
 */
export function baseCheckStep(controller, ctx, { repository, repoPath, worktreeRoot, baseSha }, settings) {
  const { store } = controller, git = controller.cmd.git, now = controller.now();
  const repo = repository.toLowerCase(), command = key(settings.command);
  const write = (fields) => controller.fenced(ctx, () => store.run(`UPDATE base_checks SET state = ?, failed = ?, summary = ?, reason = ?, updated_at = ?
    WHERE repository = ? AND base_sha = ? AND command = ? AND state = 'running'`,
  fields.state, fields.failed === null ? null : JSON.stringify(fields.failed), fields.summary ?? null, fields.reason ?? null, now, repo, baseSha, command));
  let record = row(store, repository, baseSha, settings.command);
  if (!record) {
    const digest = createHash('sha256').update(command, 'utf8').digest('hex').slice(0, 8);
    const path = join(worktreeRoot, `basecheck-${baseSha.slice(0, 12)}-${digest}`);
    // Recorded before anything starts, so a second campaign on the same base and a restart find this one run.
    const inserted = controller.fenced(ctx, () => store.run(`INSERT OR IGNORE INTO base_checks (repository, base_sha, command, path, started_at, state, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?)`, repo, baseSha, command, path, now, now)).changes === 1;
    record = row(store, repository, baseSha, settings.command);
    if (!inserted) return record;
    try {
      checkout(git, repoPath, path, baseSha);
      startGate(path, settings.command);
    } catch (error) {
      write({ state: 'failed', failed: null, reason: `the base check could not start: ${error.message}`.slice(0, 500) });
      return row(store, repository, baseSha, settings.command);
    }
    controller.log(`base check of ${repository} ${baseSha}: gate started in ${path}`);
    return record;
  }
  if (record.state !== 'running') return record;

  const run = readGateRun(record.path);
  if (run === null || run.exit === null) {
    if (now - record.started_at > settings.timeoutMs) {
      write({ state: 'failed', failed: null, reason: `the base gate did not finish within ${Math.round(settings.timeoutMs / 60_000)} minutes` });
      return row(store, repository, baseSha, settings.command);
    }
    // A gate that ended without an exit code (a restart, a reboot) starts again in the same worktree, as a refresh does.
    const pid = gatePid(record.path);
    if (pid === null || !alive(pid)) {
      try { checkout(git, repoPath, record.path, baseSha); startGate(record.path, settings.command); } catch (error) {
        write({ state: 'failed', failed: null, reason: `the base gate could not restart: ${error.message}`.slice(0, 500) });
        return row(store, repository, baseSha, settings.command);
      }
    }
    return record;
  }
  // The result counts only for the checkout it was meant for.
  const head = gitA.exec(git, ['rev-parse', 'HEAD'], { cwd: record.path });
  if (!head.ok || head.stdout !== baseSha) {
    write({ state: 'failed', failed: null, reason: `the base gate finished, but its checkout is no longer at ${baseSha}` });
  } else if (gateFailure(run)) {
    write({ state: 'failed', failed: failedTests(run.summary), summary: run.summary, reason: `the base gate ${gateFailure(run)}` });
    recordGateResults(controller, ctx, { repository, repoPath, sha: baseSha, dir: record.path, green: false });
  } else {
    write({ state: 'passed', failed: [], summary: run.summary, reason: null });
    recordGateResults(controller, ctx, { repository, repoPath, sha: baseSha, dir: record.path, green: true });
  }
  record = row(store, repository, baseSha, settings.command);
  controller.log(`base check of ${repository} ${baseSha}: ${record.state}`);
  return record;
}

/**
 * Whether an acceptance whose own gate failed stands against the base record: only when the base failed with known
 * tests and the head's failed tests, which must be known and at least one, are all among them. Returns the base
 * failures the head shares, or null when the acceptance is refused as before.
 */
export function sharedBaseFailures(record, headSummary) {
  if (record?.state !== 'failed' || !Array.isArray(record.failed) || !record.failed.length) return null;
  const head = failedTests(headSummary);
  if (!head?.length) return null;
  const base = new Set(record.failed);
  return head.every((id) => base.has(id)) ? head : null;
}
