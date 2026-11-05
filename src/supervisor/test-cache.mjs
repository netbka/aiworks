// Test result cache (opt-in, config.json `testCache`; slice 4 of the 2026-11-05 test review). A repair head usually
// changes a few files, yet its verifier ran every test file again, each full gate 20 to 50 minutes. A test file whose
// inputs are byte-for-byte the same as at a recorded pass gives no new information when it runs again.
//
// The rules:
// - A row of `test_results` says one test file passed, as a whole and on its first run, with exactly the inputs named
//   by its digest. Only the controller writes rows (recordPasses), from the gate log of an accepted exact-head
//   verification whose gate exited 0, or of a green supervisor gate (merge refresh, group merge, base check) after its
//   checkout was confirmed. A file that passed only when retried alone is never recorded. Rows are never changed.
// - The digest (fileDigest) is always computed by the supervisor from the git objects of the exact commit, in the main
//   checkout: never read from a worktree, a run directory or a log. It covers every path the test reaches by the rule
//   of scripts/lib/affected-tests.mjs (imports and named repository paths, transitively), the dependencies and the test
//   runner, the Node major version and this schema version.
// - Before a verify run of a commit task, the controller writes the matching rows to skip.json in the run directory,
//   which the supervisor owns, and names it in AIWORKS_TEST_CACHE. scripts/run-tests.mjs then prints
//   `# cached <file> digest <digest>` instead of running that file. The list only saves time: it is never evidence.
// - When the result is consumed, every `# cached` line counts only when the supervisor recomputes that file's digest
//   at the target commit, finds it equal to the line's, and finds a row for it (checkClaims). Every test file of the
//   target must also have run or be such a cached file. Otherwise an acceptance is refused as invalid-result naming the
//   file. With the cache off, every `# cached` line is refused.
// - Supervisor gates never use the cache (merge-refresh.mjs startGate clears AIWORKS_TEST_CACHE), and a release
//   (AW-010) needs a verification whose gate ran every file.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reach, referenceGraph } from '../../scripts/lib/affected-tests.mjs';
import { COUNTS, countsOf } from '../../scripts/lib/test-retry.mjs';
import { DEVELOPMENT_ENV } from './development-policy.mjs';
import { GATE_FILES } from './gate.mjs';
import { writeAtomic } from './proc.mjs';

export const CACHE_ENV = 'AIWORKS_TEST_CACHE';
export const SKIP_FILE = 'skip.json';
const SCHEMA = 1;
const DEFAULT_MAX_AGE_DAYS = 7;
// Inputs of every test file: the dependencies and the test runner with its libraries.
const SHARED = ['package.json', 'package-lock.json', 'scripts/run-tests.mjs', 'scripts/lib/'];
const CODE = /\.(?:mjs|cjs|js)$/;
const SHA = /^[0-9a-f]{40}$/;
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

/**
 * `testCache` from config.json: `{ "enabled": true, "maxAgeDays": 7 }`. Absent or not enabled: null (off; every
 * verifier gate runs every file, as before). Malformed: { problem }. maxAgeDays bounds how old a row may be to be offered.
 */
export function testCacheSettings(value) {
  if (value === undefined || value === null) return null;
  const problem = (text) => ({ problem: `testCache ${text}` });
  if (typeof value !== 'object' || Array.isArray(value)) return problem('must be an object');
  if (value.enabled !== true) return null;
  const { maxAgeDays = DEFAULT_MAX_AGE_DAYS } = value;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return problem('.maxAgeDays must be a positive number of days');
  return { maxAgeMs: maxAgeDays * 24 * 60 * 60_000 };
}

function git(command, repoPath, args, input) {
  const out = spawnSync(command[0], [...command.slice(1), ...args], { cwd: repoPath, input, windowsHide: true,
    maxBuffer: 256 * 1024 * 1024, timeout: 120_000, env: { ...process.env, ...DEVELOPMENT_ENV } });
  if (out.error || out.status !== 0) throw new Error(`git ${args[0]} failed: ${(out.stderr?.toString() || out.error?.message || `exit ${out.status}`).trim()}`.slice(0, 300));
  return out.stdout;
}

const trees = new Map();
/** The tree of commit `sha` from git objects: every blob path with its object id, and the reference graph of its code. */
export function treeAt(command, repoPath, sha) {
  if (!SHA.test(sha ?? '')) throw new Error(`not a commit id: ${sha}`);
  const key = `${repoPath}\n${sha}`;
  if (trees.has(key)) return trees.get(key);
  const blobs = new Map();
  for (const entry of git(command, repoPath, ['ls-tree', '-r', '-z', '--full-tree', sha]).toString('utf8').split('\0')) {
    const match = /^\d+ blob ([0-9a-f]{40})\t(.+)$/s.exec(entry);
    if (match) blobs.set(match[2], match[1]);
  }
  const code = [...blobs.keys()].filter((path) => CODE.test(path));
  const texts = new Map();
  if (code.length) {
    const out = git(command, repoPath, ['cat-file', '--batch'], code.map((path) => blobs.get(path)).join('\n') + '\n');
    let at = 0;
    for (const path of code) {
      const end = out.indexOf(0x0a, at);
      const header = /^([0-9a-f]{40}) blob (\d+)$/.exec(out.subarray(at, end).toString('utf8'));
      if (!header || header[1] !== blobs.get(path)) throw new Error(`git cat-file returned an unexpected object for ${path}`);
      const size = Number(header[2]);
      texts.set(path, out.subarray(end + 1, end + 1 + size).toString('utf8'));
      at = end + 1 + size + 1;
    }
  }
  const tree = { blobs, graph: referenceGraph([...blobs.keys()], (path) => texts.get(path) ?? '') };
  trees.set(key, tree);
  if (trees.size > 8) trees.delete(trees.keys().next().value);
  return tree;
}

/** The test files scripts/run-tests.mjs runs in `tree`: tests/**\/*.test.mjs outside any fixtures folder, sorted. */
export const testFiles = (tree) => [...tree.blobs.keys()]
  .filter((path) => /^tests\/.+\.test\.mjs$/.test(path) && !path.split('/').slice(1, -1).includes('fixtures')).sort();

/** The content digest of test `file` in `tree`: every blob it reaches, the shared inputs, the Node major and the schema. */
export function fileDigest(tree, file) {
  const paths = new Set();
  const add = (ref) => {
    if (ref.endsWith('/')) { for (const path of tree.blobs.keys()) if (path.startsWith(ref)) paths.add(path); }
    else if (tree.blobs.has(ref)) paths.add(ref);
  };
  for (const ref of reach(tree.graph, file)) add(ref);
  for (const ref of SHARED) add(ref);
  const hash = createHash('sha256').update(`aiworks-test-cache ${SCHEMA}\nnode ${NODE_MAJOR}\ntest ${file}\n`);
  for (const path of [...paths].sort()) hash.update(`${path}\0${tree.blobs.get(path)}\n`);
  return hash.digest('hex');
}

/**
 * What a scripts/run-tests.mjs log says about each file: `ends` (file -> the exit codes and counts of its `# end` lines),
 * `retried` (files run again alone) and `claims` (`# cached` lines, as { file, digest }).
 */
export function parseGateLog(text) {
  const ends = new Map(), retried = new Set(), claims = [];
  let block = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    let match;
    if (line.startsWith('# cached ')) {
      match = /^# cached (\S+)(?: digest (\S+))?$/.exec(line);
      claims.push({ file: match?.[1] ?? line.slice('# cached '.length), digest: match?.[2] ?? null });
    } else if ((match = /^# retry alone (\S+)$/.exec(line))) retried.add(match[1]);
    else if ((match = /^# end (\S+) \d+ ms, exit (\S+)$/.exec(line))) {
      ends.set(match[1], [...(ends.get(match[1]) ?? []), { exit: match[2], counts: countsOf(block.join('\n')) }]);
    } else if (!/^# start \S+$/.test(line)) { block.push(line); continue; }
    block = [];
  }
  return { ends, retried, claims };
}

const key = (repository) => repository.toLowerCase();
const rowFor = (store, repository, file, digest) => store.get('SELECT * FROM test_results WHERE repository = ? AND file = ? AND digest = ?', key(repository), file, digest);

/**
 * Whether the `# cached` lines of a gate log may count, for commit `sha` of `repository`. Each is honoured only when the
 * digest the supervisor computes now from the git objects of `sha` equals the line's and a row holds it; then every test
 * file of `sha` must have an `# end` line or an honoured `# cached` line. Returns { claimed, refused: [reason...] }:
 * claimed is the number of files the log claims, refused names each file that cannot count (empty when all do).
 */
export function checkClaims({ store, git: command, repoPath, repository, sha, log, enabled }) {
  const { ends, claims } = parseGateLog(log);
  if (!claims.length) return { claimed: 0, refused: [] };
  const files = [...new Set(claims.map((claim) => claim.file))];
  if (!enabled) return { claimed: files.length, refused: files.map((file) => `${file}: the test cache is off`) };
  let tree;
  try { tree = treeAt(command, repoPath, sha); } catch (error) { return { claimed: files.length, refused: [`the commit ${sha} cannot be read: ${error.message}`] }; }
  const tests = new Set(testFiles(tree)), honoured = new Set(), refused = [];
  for (const { file, digest } of claims) {
    if (!tests.has(file)) { refused.push(`${file}: not a test file of ${sha}`); continue; }
    const actual = fileDigest(tree, file);
    if (digest !== actual) refused.push(`${file}: its inputs at ${sha} are not the ones the line names`);
    else if (!rowFor(store, repository, file, actual)) refused.push(`${file}: no recorded pass for its inputs at ${sha}`);
    else honoured.add(file);
  }
  for (const file of tests) if (!ends.has(file) && !honoured.has(file) && !refused.some((reason) => reason.startsWith(`${file}:`))) refused.push(`${file}: neither ran nor was cached`);
  return { claimed: files.length, refused: [...new Set(refused)] };
}

/**
 * The rows a passed gate log of commit `sha` gives: each test file of `sha` that ran exactly once, exited 0 and was
 * not retried alone, with its digest computed from the git objects of `sha`. Never a cached or retried file.
 */
export function passesOf({ git: command, repoPath, sha, log }) {
  const { ends, retried, claims } = parseGateLog(log);
  const tree = treeAt(command, repoPath, sha), cached = new Set(claims.map((claim) => claim.file));
  return testFiles(tree).flatMap((file) => {
    const runs = ends.get(file) ?? [];
    if (runs.length !== 1 || runs[0].exit !== '0' || retried.has(file) || cached.has(file)) return [];
    return [{ file, digest: fileDigest(tree, file), counts: runs[0].counts }];
  });
}

/** Records `rows` (passesOf) for `repository`. Inside the controller's fence; an existing row is kept. */
export function insertPasses(store, repository, rows, { source, ref, now }) {
  for (const row of rows) {
    store.run(`INSERT OR IGNORE INTO test_results (repository, file, digest, node_major, state, counts, source, ref, at)
      VALUES (?, ?, ?, ?, 'passed', ?, ?, ?, ?)`, key(repository), row.file, row.digest, NODE_MAJOR, JSON.stringify(row.counts), source, ref, now);
  }
}

/**
 * Records the passes of a green supervisor gate of commit `sha` in `dir`, after the caller confirmed its checkout is
 * still at `sha`. Does nothing while the cache is off or when the log claims cached files (supervisor gates run every
 * file). A git failure records nothing and is logged: the cache only saves time. Inside the campaign's fence when `ctx`
 * is given; a group merge, which no single campaign owns, writes like its own journal records.
 */
export function recordGatePasses(controller, ctx, { repository, repoPath, sha, dir, source }) {
  if (!controller.testCache) return;
  let rows;
  try {
    const log = readFileSync(join(dir, GATE_FILES.log), 'utf8');
    if (parseGateLog(log).claims.length) return;
    rows = passesOf({ git: controller.cmd.git, repoPath, sha, log });
  } catch (error) {
    controller.log(`test cache: passes of ${repository} ${sha} not recorded: ${error.message}`);
    return;
  }
  const insert = () => insertPasses(controller.store, repository, rows, { source, ref: sha, now: controller.now() });
  if (ctx) controller.fenced(ctx, insert);
  else controller.store.tx(insert);
}

/**
 * Before a verify run of commit `sha`: writes the recorded passes for its test files to skip.json in `runDir` and
 * returns the environment that names it, or null when nothing matches (or the target has no scripts/run-tests.mjs).
 */
export function offerCache({ store, git: command, repoPath, repository, sha, runDir, settings, now }) {
  const tree = treeAt(command, repoPath, sha);
  if (!tree.blobs.has('scripts/run-tests.mjs')) return null;
  const files = testFiles(tree).flatMap((file) => {
    const digest = fileDigest(tree, file), row = rowFor(store, repository, file, digest);
    if (!row || now - row.at > settings.maxAgeMs) return [];
    const counts = JSON.parse(row.counts);
    return [{ file, digest, counts: Object.fromEntries(COUNTS.map((name) => [name, Number(counts?.[name]) || 0])) }];
  });
  if (!files.length) return null;
  const path = join(runDir, SKIP_FILE);
  // Written before the run starts and owned by the supervisor; a changed copy changes nothing, since checkClaims decides.
  writeAtomic(path, JSON.stringify({ version: SCHEMA, sha, files }));
  return { [CACHE_ENV]: path };
}
