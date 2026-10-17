// Runs the AIWorks test files in three tiers (#102). Every file runs in its own node --test process; its output is shown
// whole when it ends, with its time, and one combined summary in node:test's own format comes last, so the last summary
// is always the total.
//
//   unit       no child process, server or synthetic worker: pure logic over files and stores. Many at once.
//   service    starts a dashboard server, builds the review fixture or runs git in disposable repositories. Several at once.
//   rehearsal  starts supervisor controllers, contained worker runs or other real processes (anything that uses the
//              supervisor test harness: environment(), runUntil, runtimeCheckout, the CLI, containment). Two at a time,
//              slowest first: each takes its own temporary directories, data directories and OS-assigned ports, so two
//              never share state, and two at once leaves native Windows containment probes capacity for helper startup.
//
// The unit tier runs first, then the service and rehearsal tiers run side by side (service files wait on servers and
// git, rehearsal files on supervisor timers, so neither starves the other). `--tiers unit,service` runs only those
// tiers (`npm run test:quick`); the full gate is always every tier. `--affected [base]` (default origin/main; `npm run
// test:affected`) runs only the files that the changes since the merge base with `base` can reach, committed or not
// (scripts/lib/affected-tests.mjs): a fast check while working, never the gate. AIWORKS_TEST_CONCURRENCY sets how many
// unit and service files run at once, AIWORKS_HEAVY_CONCURRENCY how many rehearsal files (1 = one at a time, in the
// order before #102). Any other argument goes to node --test.
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectedTests, referenceGraph, repositoryFiles } from './lib/affected-tests.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TIERS = ['unit', 'service', 'rehearsal'];
const discover = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : discover(path);
  return entry.isFile() && entry.name.endsWith('.test.mjs') ? [relative(root, path).replaceAll(sep, '/')] : [];
});

// A file that starts a supervisor controller, a contained worker run, the CLI or a containment helper is a rehearsal:
// it imports the supervisor harness's process-starting exports, or names a fault, a fixture executable or containment.
// Every import from ./helpers.mjs except the pure ones (declaration, GOVERNANCE, ROOT, SQLITE, skipWithoutSqlite, sleep)
// starts processes.
const REHEARSAL = /\b(environment|runUntil|runtimeCheckout|runCli|CLI)\b[^;]*from '\.\/helpers\.mjs'|from '\.\/[a-z-]+-harness\.mjs'|new Controller|keep-preload|stopOwnedRun|containment|POWERSHELL|AIWORKS_FAULT|fake-(claude|gh|agy)|browser-mcp/;
// A file that starts a server, builds the review fixture, spawns git or runs any other child process (a synthetic
// executable started through process.execPath) is a service file. Only a file that matches neither pattern is a unit.
const SERVICE = /child_process|process\.execPath|\.listen\(|createServer|review-store|startDashboard|main\.mjs/;
const tierOf = (source) => (REHEARSAL.test(source) ? 'rehearsal' : SERVICE.test(source) ? 'service' : 'unit');

// The slowest files of each tier, slowest first (measured 2026-10-14; the runner prints every file's time). A tier's
// slowest files start first so a long file never runs alone at the end. A file missing here only starts later; the
// order changes no result.
const SLOWEST = {
  rehearsal: ['restart-parallel', 'supervisor', 'restart-publish', 'restart', 'unlimited', 'owner-intervention-recheck',
    'unlimited-retries', 'routing', 'parallel', 'integration-repair', 'merged-code', 'owner-intervention', 'merge-gate',
    'provider-accounts', 'process', 'rest-publish', 'routing-receipt', 'packet-governance'].map((name) => `tests/supervisor/${name}.test.mjs`),
  service: ['dashboard/review-fixture', 'dashboard/owner-words', 'dashboard/stability', 'dashboard/needs-counts', 'supervisor/project-local-git',
    'dashboard/merges', 'dashboard/work', 'supervisor/project-folder', 'dashboard/copy', 'dashboard/settings', 'dashboard/cost'].map((name) => `tests/${name}.test.mjs`),
  unit: [],
};
const ordered = (tier, files) => {
  const rank = (file) => (SLOWEST[tier].includes(file) ? SLOWEST[tier].indexOf(file) : SLOWEST[tier].length);
  return [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
};

/** `--tiers a,b` (or `--tiers=a,b`) selects tiers, `--affected [base]` the files a change can reach; every other argument goes to node --test. */
function parseArgs(argv) {
  const rest = [];
  let tiers = TIERS, affected = null;
  for (let i = 0; i < argv.length; i++) {
    const since = /^--affected(?:=(.+))?$/.exec(argv[i]);
    if (since) {
      affected = since[1] ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : 'origin/main');
      continue;
    }
    const match = /^--tiers(?:=(.*))?$/.exec(argv[i]);
    if (!match) { rest.push(argv[i]); continue; }
    const value = match[1] ?? argv[++i] ?? '';
    tiers = value.split(',').map((name) => name.trim()).filter(Boolean);
    const unknown = tiers.filter((name) => !TIERS.includes(name));
    if (!tiers.length || unknown.length) throw new Error(`--tiers takes a comma-separated subset of ${TIERS.join(', ')}; got "${value}"`);
  }
  return { tiers, affected, rest };
}

/** The paths changed since the merge base of HEAD and `base`: commits, staged and unstaged changes, and new files. */
function changedSince(base) {
  const git = (...args) => {
    const out = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    if (out.status !== 0) throw new Error(`--affected ${base}: git ${args.join(' ')} failed: ${(out.stderr || out.error?.message || '').trim()}`);
    return out.stdout.split(/\r?\n/).filter(Boolean);
  };
  const [mergeBase] = git('merge-base', base, 'HEAD');
  return { mergeBase, changed: [...new Set([...git('diff', '--name-only', '--no-renames', mergeBase), ...git('ls-files', '--others', '--exclude-standard')])] };
}

const setting = (name, fallback) => {
  const requested = Number(process.env[name]);
  return Number.isInteger(requested) && requested > 0 ? requested : fallback;
};
const concurrency = setting('AIWORKS_TEST_CONCURRENCY', Math.min(4, Math.max(1, Math.floor(availableParallelism() / 4))));
const heavyConcurrency = setting('AIWORKS_HEAVY_CONCURRENCY', 2);

// An inherited test-worker marker makes a nested node --test silently skip its files.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const COUNTS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const total = Object.fromEntries(COUNTS.map((key) => [key, 0]));
const times = [];

/** Runs one test file in its own node --test process; resolves its exit status. */
function runFile(file, tier, testArgs) {
  return new Promise((done) => {
    const started = Date.now();
    console.log(`# start ${file}`);
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...testArgs, file],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    const finish = (code) => {
      const ms = Date.now() - started;
      const text = Buffer.concat(output).toString('utf8');
      process.stdout.write(text.endsWith('\n') || !text ? text : `${text}\n`);
      for (const line of text.split(/\r?\n/)) {
        const match = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
        if (match) total[match[1]] += Number(match[2]);
      }
      times.push({ file, tier, ms, code });
      console.log(`# end ${file} ${ms} ms, exit ${code}`);
      done(code === 0 ? 0 : 1);
    };
    child.on('error', (error) => { output.push(Buffer.from(`Test process failed: ${error.message}\n`)); finish(1); });
    child.on('close', (code) => finish(code ?? 1));
  });
}

/** Runs `group` with at most `limit` files at once, in order; resolves 1 if any file failed. */
async function run(group, tier, limit, testArgs) {
  const queue = [...group];
  let status = 0;
  const worker = async () => { while (queue.length) status = (await runFile(queue.shift(), tier, testArgs)) || status; };
  await Promise.all(Array.from({ length: Math.min(limit, group.length) }, worker));
  return status;
}

const { tiers, affected, rest } = parseArgs(process.argv.slice(2));
const files = discover(join(root, 'tests')).sort();
const byTier = Object.fromEntries(TIERS.map((tier) => [tier, []]));
let reachable = files;
if (affected) {
  const { mergeBase, changed } = changedSince(affected);
  const repository = repositoryFiles(root);
  const graph = referenceGraph([...new Set([...repository, ...changed])], (path) => (repository.includes(path) ? readFileSync(join(root, path), 'utf8') : ''));
  const result = affectedTests({ graph, tests: files, changed });
  reachable = result.tests;
  console.log(`# affected: ${changed.length} changed files since ${affected} (merge base ${mergeBase.slice(0, 12)}) reach ${reachable.length} of ${files.length} test files${result.everything.length ? `; every file runs because ${result.everything.join(', ')} changed` : ''}`);
}
for (const file of reachable) byTier[tierOf(readFileSync(join(root, file), 'utf8'))].push(file);
const selected = (tier) => (tiers.includes(tier) ? (heavyConcurrency > 1 || tier !== 'rehearsal' ? ordered(tier, byTier[tier]) : byTier[tier]) : []);

const started = Date.now();
const unitStatus = await run(selected('unit'), 'unit', concurrency, rest);
const lanesStarted = Date.now();
const [serviceStatus, rehearsalStatus] = await Promise.all([
  run(selected('service'), 'service', concurrency, rest),
  run(selected('rehearsal'), 'rehearsal', heavyConcurrency, rest),
]);
const lanesMs = Date.now() - lanesStarted;
console.log(`# file times, slowest first (service and rehearsal lanes ${lanesMs} ms)`);
for (const { file, tier, ms, code } of times.sort((a, b) => b.ms - a.ms)) {
  console.log(`# ${String(ms).padStart(8)} ms ${tier.padEnd(9)} ${file}${code === 0 ? '' : ` exit ${code}`}`);
}
const counts = TIERS.map((tier) => `${selected(tier).length} ${tier}`).join(', ');
console.log(`# all test files: ${counts} (of ${files.length}); unit and service ${concurrency} at a time, rehearsal ${heavyConcurrency} at a time`);
for (const key of COUNTS) console.log(`# ${key} ${total[key]}`);
console.log(`# duration_ms ${Date.now() - started}`);
process.exit(unitStatus || serviceStatus || rehearsalStatus);
