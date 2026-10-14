// Runs every AIWorks test file. Light files run several at a time first (#102). Files that start supervisor workers,
// servers or other real processes (heavy) run next, 2 at a time, slowest first: each takes its own temporary directories, data
// directories and OS-assigned ports, so two never share state, and two at once leaves native Windows containment probes
// capacity for helper startup. Each file runs in its own node --test process; its output is shown whole when it ends,
// with its time, and one combined summary in node:test's own format comes last, so the last summary is always the
// total. AIWORKS_TEST_CONCURRENCY sets how many light files run at once, AIWORKS_HEAVY_CONCURRENCY how many heavy files
// (1 = one at a time, the order before #102).
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const discover = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : discover(path);
  return entry.isFile() && entry.name.endsWith('.test.mjs') ? [relative(root, path).replaceAll(sep, '/')] : [];
});
const files = discover(join(root, 'tests')).sort();
// Anything that runs the supervisor, a worker, a server or a containment helper is heavy. When unsure, a file is heavy.
export const HEAVY = /environment\(|runUntil|\.tick\(|runtimeCheckout|new Controller|\.listen\(|createServer|review-store|startDashboard|cli\.mjs|\bCLI\b|keep-preload|runner\.mjs|stopOwnedRun|containment|POWERSHELL|main\.mjs|fake-(claude|gh|agy)|browser-mcp/;
const heavy = files.filter((file) => HEAVY.test(readFileSync(join(root, file), 'utf8')));
const light = files.filter((file) => !heavy.includes(file));
const setting = (name, fallback) => {
  const requested = Number(process.env[name]);
  return Number.isInteger(requested) && requested > 0 ? requested : fallback;
};
const concurrency = setting('AIWORKS_TEST_CONCURRENCY', Math.min(4, Math.max(1, Math.floor(availableParallelism() / 4))));
const heavyConcurrency = setting('AIWORKS_HEAVY_CONCURRENCY', 2);
// The slowest heavy files, slowest first (measured for #102; the runner prints every file's time). When heavy files run
// side by side these start first, so a long file never runs alone at the end; one at a time keeps the order before #102.
// A file missing here only starts later; the order changes no result.
const SLOWEST = ['restart', 'supervisor', 'unlimited', 'owner-intervention', 'merged-code', 'packet-governance', 'parallel', 'plan-specs']
  .map((name) => `tests/supervisor/${name}.test.mjs`);
const rank = (file) => (SLOWEST.includes(file) ? SLOWEST.indexOf(file) : SLOWEST.length);
if (heavyConcurrency > 1) heavy.sort((a, b) => rank(a) - rank(b));

// An inherited test-worker marker makes a nested node --test silently skip its files.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const COUNTS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const total = Object.fromEntries(COUNTS.map((key) => [key, 0]));
const times = [];

/** Runs one test file in its own node --test process; resolves its exit status. */
function runFile(file) {
  return new Promise((done) => {
    const started = Date.now();
    console.log(`# start ${file}`);
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), file],
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
      times.push({ file, ms, code });
      console.log(`# end ${file} ${ms} ms, exit ${code}`);
      done(code === 0 ? 0 : 1);
    };
    child.on('error', (error) => { output.push(Buffer.from(`Test process failed: ${error.message}\n`)); finish(1); });
    child.on('close', (code) => finish(code ?? 1));
  });
}

/** Runs `group` with at most `limit` files at once, in order; resolves 1 if any file failed. */
async function run(group, limit) {
  const queue = [...group];
  let status = 0;
  const worker = async () => { while (queue.length) status = (await runFile(queue.shift())) || status; };
  await Promise.all(Array.from({ length: Math.min(limit, group.length) }, worker));
  return status;
}

const started = Date.now();
const lightStatus = await run(light, concurrency);
const heavyStarted = Date.now();
const heavyStatus = await run(heavy, heavyConcurrency);
const heavyMs = Date.now() - heavyStarted;
console.log(`# file times, slowest first (heavy group ${heavyMs} ms)`);
for (const { file, ms, code } of times.sort((a, b) => b.ms - a.ms)) {
  console.log(`# ${String(ms).padStart(8)} ms ${heavy.includes(file) ? 'heavy' : 'light'} ${file}${code === 0 ? '' : ` exit ${code}`}`);
}
console.log(`# all test files: ${light.length} run ${concurrency} at a time, then ${heavy.length} run ${heavyConcurrency} at a time`);
for (const key of COUNTS) console.log(`# ${key} ${total[key]}`);
console.log(`# duration_ms ${Date.now() - started}`);
process.exit(lightStatus || heavyStatus);
