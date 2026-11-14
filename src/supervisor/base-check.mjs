// Base compare (opt-in, config.json `baseCompare`; owner decision 2026-11-05, slice A2). Measured 2026-11-05: 48 verifier
// acceptances were refused because the verifier's own gate failed, about 28 hours of verifier time, and in the managed
// projects several tasks were verified 4 to 11 times for failures that were already on their base. A new verifier of
// the same head cannot fix a test the base already fails.
//
// The rule: when a verify operation of a commit task runs, the supervisor gates the task's base commit itself, once per
// (repository, base SHA, gate command), in its own detached worktree, through the gate helper (gate.mjs) as a separate
// process, exactly as the merge-gate refresh does (merge-refresh.mjs). An acceptance whose own gate failed still stands
// only when the base gate failed too and every failed test the head's summary names is one the base summary names
// (failedTests in gate.mjs reads them from the whole gate.log of scripts/run-tests.mjs, vitest, jest, pytest, go test,
// dotnet test and cargo test, and only under the same runner). The acceptance then records those base failures. In every other case, among them a summary
// that names no tests, a base that passed, or a base check that could not run or did not finish in time, the acceptance
// is refused as before. While the base gate still runs, the accepted result is left unconsumed and read again later,
// up to the base check's own bound. A base gate is never killed; its worktree stays in place like every supervisor
// worktree.
//
// Per project: `baseCompare.projects` gives a project its own command (owner/repo or lp- id), with the top-level command
// as the fallback (projectBaseCompare). The gate helper records the command each run used (gate-command.log), and a
// head counts against a base only when both ran the same command. baseCompareInventory lists, read-only, what each
// registered project would need (cli.mjs base-compare-inventory).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as gitA from './adapters/git.mjs';
import { failureList, gateFailureList, gateFailure, readGateRun } from './gate.mjs';
import { alive, checkout, gatePid, startGate } from './merge-refresh.mjs';
import { recordGateResults } from './test-cache.mjs';

const DEFAULT_TIMEOUT_MINUTES = 120;
// A project key of baseCompare.projects: a GitHub repository (owner/repo) or a project without GitHub (its lp- id).
const PROJECT_KEY = /^(?:[\w.-]+\/[\w.-]+|lp-[a-z0-9][a-z0-9-]{0,38})$/;
const EXAMPLE = '["npm", "ci", "&&", "npm", "run", "check"]';
const validCommand = (command) => Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === 'string' && part.trim());
const validTimeout = (minutes) => Number.isFinite(minutes) && minutes >= 1;

/**
 * `baseCompare` from config.json:
 *   { "command": [...], "timeoutMinutes": 120,
 *     "projects": { "<owner/repo or lp-id>": { "command": [...], "timeoutMinutes": 90 } } }
 * The top-level command is the fallback for a project without its own entry; with `projects` it may be left out, and
 * then only the listed projects are compared. A project's timeoutMinutes defaults to the top-level one (120).
 * Absent: null (off; every failed gate refuses the acceptance, as before). Malformed at the top level: { problem }
 * (off everywhere). A malformed project entry turns base compare off for that project only, never falls back to the
 * top-level command, and is listed in `problems` for the log.
 */
export function baseCompareSettings(value) {
  if (value === undefined || value === null) return null;
  const problem = (text) => ({ problem: `baseCompare ${text}` });
  if (typeof value !== 'object' || Array.isArray(value)) return problem('must be an object');
  const { command, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES, projects } = value;
  if (projects !== undefined && (projects === null || typeof projects !== 'object' || Array.isArray(projects))) {
    return problem('.projects must be an object keyed by owner/repo or lp- id');
  }
  if ((projects === undefined || command !== undefined) && !validCommand(command)) {
    return problem(`.command must list the gate command, for example ${EXAMPLE}`);
  }
  if (!validTimeout(timeoutMinutes)) return problem('.timeoutMinutes must be a positive number of minutes');
  const entries = new Map(), problems = [];
  for (const [name, entry] of Object.entries(projects ?? {})) {
    const where = `baseCompare.projects[${JSON.stringify(name)}]`;
    const off = (text) => {
      const reason = `${where}${text.startsWith('.') ? '' : ' '}${text}`;
      problems.push(`${reason}; base compare is off for that project`);
      return { problem: reason };
    };
    const id = name.toLowerCase();
    if (!PROJECT_KEY.test(name)) entries.set(id, off('is not an owner/repo or lp- id'));
    else if (entries.has(id)) entries.set(id, off('is listed twice'));
    else if (!entry || typeof entry !== 'object' || Array.isArray(entry)) entries.set(id, off('must be an object with a command'));
    else if (!validCommand(entry.command)) entries.set(id, off(`.command must list the gate command, for example ${EXAMPLE}`));
    else if (entry.timeoutMinutes !== undefined && !validTimeout(entry.timeoutMinutes)) entries.set(id, off('.timeoutMinutes must be a positive number of minutes'));
    else entries.set(id, { command: [...entry.command], timeoutMs: (entry.timeoutMinutes ?? timeoutMinutes) * 60_000 });
  }
  return { command: command === undefined ? null : [...command], timeoutMs: timeoutMinutes * 60_000, projects: entries, problems };
}

/**
 * The base compare settings of one campaign target ({ command, timeoutMs }), or null when it is off for it: its own
 * entry, by repository (case-insensitive) or, for a project without GitHub, by lp- id; else the top-level command. A
 * malformed entry is off for that project.
 */
export function projectBaseCompare(settings, { repository = null, projectId = null } = {}) {
  if (!settings || settings.problem) return null;
  const own = (repository && settings.projects?.get(repository.toLowerCase())) || (projectId && settings.projects?.get(projectId.toLowerCase())) || null;
  if (own) return own.problem ? null : own;
  return settings.command ? { command: settings.command, timeoutMs: settings.timeoutMs } : null;
}

const key = (command) => JSON.stringify(command);
const row = (store, repository, baseSha, command) => {
  const found = store.get('SELECT * FROM base_checks WHERE repository = ? AND base_sha = ? AND command = ?', repository.toLowerCase(), baseSha, key(command));
  return found ? { ...found, failed: found.failed === null ? null : JSON.parse(found.failed), red: found.red === 1 } : null;
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
  const write = (fields) => controller.fenced(ctx, () => store.run(`UPDATE base_checks SET state = ?, failed = ?, summary = ?, reason = ?, red = ?, runner = ?, updated_at = ?
    WHERE repository = ? AND base_sha = ? AND command = ? AND state = 'running'`,
  fields.state, fields.failed === null ? null : JSON.stringify(fields.failed), fields.summary ?? null, fields.reason ?? null, fields.red ? 1 : 0, fields.runner ?? null, now, repo, baseSha, command));
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
      checkout(git, repoPath, path, baseSha, worktreeRoot);
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
      // The caller may stop waiting, but live or uncertain gate custody retains the host slot.
      write({ state: 'failed', failed: null, reason: `the base gate did not finish within ${Math.round(settings.timeoutMs / 60_000)} minutes` });
      return row(store, repository, baseSha, settings.command);
    }
    // A gate that ended without an exit code (a restart, a reboot) starts again in the same worktree, as a refresh does.
    const pid = gatePid(record.path);
    if (pid === null || !alive(pid)) {
      try { checkout(git, repoPath, record.path, baseSha, worktreeRoot); startGate(record.path, settings.command); } catch (error) {
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
    // Only here is the base itself red: its own gate finished on its checkout and failed. It gets one repair item
    // (controller.mjs recordBaseRed); a start failure, a timeout or a moved checkout says nothing about the base.
    const list = gateFailureList(run);
    write({ state: 'failed', failed: list?.ids ?? null, runner: list?.runner ?? null, summary: run.summary, reason: `the base gate ${gateFailure(run)}`, red: true });
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
 * Claim the one repair item of a red base, inside the caller's fenced write: true for exactly one caller per
 * (repository, base SHA, command), whatever the tasks, campaigns and restarts that share the base; `item` says where
 * the item went. A base that is not red, or whose item is already recorded, is never claimed.
 */
export function claimBaseRed(store, record, item, now) {
  return store.run('UPDATE base_checks SET item = ?, updated_at = ? WHERE repository = ? AND base_sha = ? AND command = ? AND red = 1 AND item IS NULL',
    item, now, record.repository, record.base_sha, record.command).changes === 1;
}

/** Record where the claimed repair item of a red base went, once it is known. */
export function settleBaseRed(store, record, item, now) {
  store.run('UPDATE base_checks SET item = ?, updated_at = ? WHERE repository = ? AND base_sha = ? AND command = ?',
    item, now, record.repository, record.base_sha, record.command);
}

/**
 * Whether an acceptance whose own gate failed stands against the base record: only when the head's gate ran under the
 * same command as the base gate (gate-command.log; an unrecorded command never matches), its failed tests were named by
 * the same runner as the base's (a record without a runner never matches), the base failed with known tests and the
 * head's failed tests, which must be known and at least one, are all among them. Returns the base failures the head
 * shares, or null when the acceptance is refused as before. `head` is the head's list with its runner ({ runner, ids },
 * gateFailureList of its gate run), or a gate log or summary that failureList reads.
 */
export function sharedBaseFailures(record, head, headCommand) {
  if (record?.state !== 'failed' || !Array.isArray(record.failed) || !record.failed.length) return null;
  if (!validCommand(headCommand) || key(headCommand) !== record.command) return null;
  const list = typeof head === 'string' ? failureList(head) : head;
  if (typeof record.runner !== 'string' || list?.runner !== record.runner) return null;
  const ids = list.ids;
  if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === 'string')) return null;
  const base = new Set(record.failed);
  return ids.every((id) => base.has(id)) ? [...ids] : null;
}

// ---- Inventory (read-only): what each registered project's check is and the baseCompare.projects entry it needs ----

const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
// Test runners recognised in a package script. Those in LIST_RUNNERS print output failedTests (gate.mjs) reads with their
// default console reporter; another reporter, or a runner not listed, gives no list and its failed gates are refused.
// Plain node:test names no file with a failed test, so it gives no list (scripts/run-tests.mjs does).
const SCRIPT_RUNNERS = [['vitest', /\bvitest\b/], ['jest', /\bjest\b/], ['mocha', /\bmocha\b/], ['playwright', /\bplaywright\b/], ['node:test', /\bnode\b[^&|;]*--test\b/]];
const LIST_RUNNERS = new Set(['scripts/run-tests.mjs', 'vitest', 'jest', 'cargo test', 'go test', 'pytest']);

/**
 * What one project checkout's full check is, from its files only (nothing runs): { command, runner, failedTestList }.
 * command is what a verifier would pass to the gate helper, or null when none is found; failedTestList is true only for
 * a runner whose output base compare can read (LIST_RUNNERS), so every other runner is refused as before.
 */
export function detectCheck(path) {
  const pkg = readJson(join(path, 'package.json'));
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : null;
  if (scripts) {
    const has = (name) => typeof scripts[name] === 'string' && scripts[name].trim();
    const check = has('check') ? ['npm', 'run', 'check'] : has('test') ? ['npm', 'test'] : null;
    const text = Object.values(scripts).filter((value) => typeof value === 'string').join('\n');
    // The runner prints its summary header itself and its failed-test lines through scripts/lib/test-retry.mjs.
    const runTests = readText(join(path, 'scripts', 'run-tests.mjs'));
    const lists = runTests && [runTests, readText(join(path, 'scripts', 'lib', 'test-retry.mjs')) ?? ''].some((source) => source.includes('# failed: '));
    const runner = runTests && /run-tests\.mjs/.test(text) && runTests.includes('# all test files') && lists
      ? 'scripts/run-tests.mjs'
      : SCRIPT_RUNNERS.find(([, pattern]) => pattern.test(text))?.[0] ?? (check ? 'unknown npm script' : null);
    // A base check runs in a fresh worktree without node_modules, so the command installs from the lock file first.
    const install = existsSync(join(path, 'package-lock.json')) ? ['npm', 'ci', '&&'] : [];
    return { command: check ? [...install, ...check] : null, runner, failedTestList: LIST_RUNNERS.has(runner) && Boolean(check) };
  }
  // cargo stops at the first failed test binary unless told otherwise, and then the list is unknown.
  if (existsSync(join(path, 'Cargo.toml'))) return { command: ['cargo', 'test', '--no-fail-fast'], runner: 'cargo test', failedTestList: true };
  if (existsSync(join(path, 'go.mod'))) return { command: ['go', 'test', './...'], runner: 'go test', failedTestList: true };
  if (['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini'].some((file) => existsSync(join(path, file)))) {
    return { command: ['python', '-m', 'pytest'], runner: 'pytest', failedTestList: true };
  }
  return { command: null, runner: null, failedTestList: false };
}

/**
 * The base compare inventory: for each registered project contract, its check command, detected runner, whether that
 * runner gives a failed-test list, what config.json baseCompare gives it now, and the exact `baseCompare.projects` entry
 * to add (only where the list is readable: elsewhere a base check would cost a full gate and never keep an acceptance).
 * Projects whose runner gives no list are follow-up candidates: they need a supported runner or summary first. Reads the
 * contracts it is given and the project checkouts' files; writes nothing, runs nothing, makes no network call.
 *   contracts: projectContracts(governanceRoot) (governance.mjs); config: config.json ({} when absent).
 */
export function baseCompareInventory({ contracts, config = {} }) {
  const parsed = baseCompareSettings(config.baseCompare);
  const repositories = config.repositories && typeof config.repositories === 'object' ? config.repositories : {};
  const checkoutOf = (github, contract) => {
    const found = github ? Object.entries(repositories).find(([name]) => name.toLowerCase() === github.toLowerCase())?.[1] : null;
    const path = typeof found?.path === 'string' ? found.path : typeof contract.repository?.localRoot === 'string' ? contract.repository.localRoot : null;
    return path && existsSync(path) ? path : null;
  };
  const configuredFor = (github, projectId) => {
    if (parsed?.problem) return { off: parsed.problem };
    const own = (github && parsed?.projects?.get(github.toLowerCase())) || (projectId && parsed?.projects?.get(projectId.toLowerCase())) || null;
    if (own?.problem) return { off: own.problem };
    const applied = projectBaseCompare(parsed, { repository: github, projectId });
    return applied ? { command: applied.command, timeoutMinutes: applied.timeoutMs / 60_000 } : { off: 'no baseCompare command applies to it' };
  };
  const projects = [], followUp = [], entries = {};
  for (const item of contracts) {
    if (item.problem) { projects.push({ file: item.file, problem: item.problem }); continue; }
    const { contract } = item;
    const github = typeof contract.repository?.github === 'string' ? contract.repository.github : null;
    const project = { id: contract.id, repository: github, checkout: checkoutOf(github, contract), configured: configuredFor(github, contract.id) };
    if (!project.checkout) {
      projects.push({ ...project, command: null, runner: null, failedTestList: false, entry: null,
        reason: "no local checkout: neither config.json repositories nor the contract's repository.localRoot names an existing folder" });
      continue;
    }
    const check = detectCheck(project.checkout);
    Object.assign(project, check);
    if (check.command && check.failedTestList && github) {
      project.entry = { [github]: { command: check.command, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES } };
      entries[github] = project.entry[github];
    } else {
      project.entry = null;
      project.reason = !check.command ? 'no check command was found in its checkout'
        : !github ? 'it has no GitHub repository to key the entry by'
          : `its runner (${check.runner}) prints no failed-test list base compare can read: it needs a supported runner or its own summary (# all test files, # failed: <file> :: <test>) first`;
      if (check.command) followUp.push({ id: contract.id, repository: github, runner: check.runner, reason: project.reason });
    }
    projects.push(project);
  }
  return {
    note: 'Read-only: nothing was written, run or fetched. Merge baseCompare.projects into config.json "baseCompare", then apply it through the upgrade procedure (docs/SUPERVISOR.md, Base compare).',
    configProblems: parsed?.problem ? [parsed.problem] : parsed?.problems ?? [],
    projects,
    baseCompare: { projects: entries },
    followUp,
  };
}
