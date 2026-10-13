// Runs every AIWorks test file. Files that start supervisor workers, servers or other real processes run one at a time
// (native Windows containment probes need capacity for helper startup); every other file runs several at a time (#102),
// before them. Both groups' output is shown as it comes, followed by one combined summary in node:test's own format,
// so the last summary is always the total. AIWORKS_TEST_CONCURRENCY sets how many light files run at once (1 = all serial).
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
const requested = Number(process.env.AIWORKS_TEST_CONCURRENCY);
const concurrency = Number.isInteger(requested) && requested > 0 ? requested : Math.min(4, Math.max(1, Math.floor(availableParallelism() / 4)));

// An inherited test-worker marker makes a nested node --test silently skip its files.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const COUNTS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const total = Object.fromEntries(COUNTS.map((key) => [key, 0]));

function run(group, groupConcurrency) {
  if (!group.length) return Promise.resolve(0);
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--test', `--test-concurrency=${groupConcurrency}`, ...process.argv.slice(2), ...group],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    let pending = '';
    const count = (line) => {
      const match = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
      if (match) total[match[1]] += Number(match[2]);
    };
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      const lines = (pending + chunk.toString('utf8')).split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(count);
    });
    child.on('error', (error) => { console.error(`Test process failed: ${error.message}`); done(1); });
    child.on('close', (code) => { count(pending); done(code ?? 1); });
  });
}

const started = Date.now();
const lightStatus = await run(light, concurrency);
const heavyStatus = await run(heavy, 1);
console.log(`# all test files: ${light.length} run ${concurrency} at a time, then ${heavy.length} one at a time`);
for (const key of COUNTS) console.log(`# ${key} ${total[key]}`);
console.log(`# duration_ms ${Date.now() - started}`);
process.exit(lightStatus || heavyStatus);
