// Test result cache (opt-in, config.json `testCache`; slice 4 of the 2026-11-05 test review). A repair head usually
// changes a few files, yet its verifier ran every test file again, each full gate 20 to 50 minutes. A test file whose
// inputs are byte-for-byte the same as at a recorded pass gives no new information when it runs again.
//
// The rules:
// - A `test_results` row says one test file passed (as a whole, on its first run) or failed, with exactly the inputs
//   named by its digest, on one Node major version. Rows are only inserted, never changed; for one file, digest and
//   Node major the newest row decides. Only the controller writes them (recordGateResults, controller.mjs testResults):
//   passes from the gate log of an accepted exact-head verification whose gate exited 0, or of a green supervisor gate
//   (merge refresh, group merge, base check) after its checkout was confirmed; failures from any of those gates and from
//   a rejected verification. A file that passed only when retried alone is never a pass, and its first failure is
//   recorded. The Node version is the one the gate's runner names in its summary (`# node v...`).
// - The digest (fileDigest) is always computed by the supervisor from the git objects of the exact commit, in the main
//   checkout, with replace objects ignored: never read from a worktree, a run directory or a log. It covers every path
//   the test reaches by the rule of scripts/lib/affected-tests.mjs (imports and named repository paths, transitively),
//   with its file mode, the dependencies, the test runner and its libraries, every .gitattributes and this schema
//   version. A test that reaches a symbolic link or a submodule has no digest: it always runs.
// - Before a verify run of a commit task, the controller writes the matching passes to skip.json in the run directory,
//   which the supervisor owns, names it in AIWORKS_TEST_CACHE and tells the verifier what a cached line is (CACHE_RULE).
//   scripts/run-tests.mjs then prints `# cached <file> digest <digest>` instead of running that file. The list only
//   saves time: it is never evidence. A task of a project with a standing release grant is never offered the cache.
// - When the result is consumed, every `# cached` line counts only when the supervisor recomputes that file's digest at
//   the target commit, finds it equal to the line's, and the newest row for it on the gate's Node major is a pass no older
//   than maxAgeDays when the run was dispatched (checkClaims). Every test file of the target must also have run or be such
//   a cached file. Otherwise an acceptance is refused as invalid-result naming the file. With the cache off, or for a
//   target without scripts/run-tests.mjs, `# cached` lines are not read at all, exactly as before.
// - Supervisor gates never use the cache (merge-refresh.mjs startGate clears AIWORKS_TEST_CACHE). A release (AW-010) and
//   a delivery with known defects (AW-017) need a verification that counted no cached file.
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
/** What a verifier is told when its run is offered the cache; a run without the offer is told nothing. */
export const CACHE_RULE = 'A "# cached <file>" line in the gate output is not a skipped file: the supervisor offered that file\'s recorded pass for identical inputs through AIWORKS_TEST_CACHE and checks each such line again itself; never set or change that variable.';
const RUNNER = 'scripts/run-tests.mjs';
const SCHEMA = 2;
const DEFAULT_MAX_AGE_DAYS = 7;
// A pass of a file already recorded as passing within this time is not recorded again, so the table grows by at most
// one row per file, digest and Node major a day while it is in use.
const REFRESH_MS = 24 * 60 * 60_000;
// Inputs of every test file: the dependencies and the test runner with its libraries (.gitattributes are added too).
const SHARED = ['package.json', 'package-lock.json', RUNNER, 'scripts/lib/'];
const CODE = /\.(?:mjs|cjs|js)$/;
const SHA = /^[0-9a-f]{40}$/;
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

/**
 * `testCache` from config.json: `{ "enabled": true, "maxAgeDays": 7 }`. Absent or not enabled: null (off; every
 * verifier gate runs every file, as before). Malformed: { problem }. maxAgeDays bounds how old a recorded pass may be.
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
    maxBuffer: 256 * 1024 * 1024, timeout: 120_000, env: { ...process.env, ...DEVELOPMENT_ENV, GIT_NO_REPLACE_OBJECTS: '1' } });
  if (out.error || out.status !== 0) throw new Error(`git ${args[0]} failed: ${(out.stderr?.toString() || out.error?.message || `exit ${out.status}`).trim()}`.slice(0, 300));
  return out.stdout;
}

/** Whether commit `sha` has scripts/run-tests.mjs as a regular file: one ls-tree of that path, before any other read. */
export function hasRunner(command, repoPath, sha) {
  if (!SHA.test(sha ?? '')) return false;
  return /^100(?:644|755) blob /.test(git(command, repoPath, ['ls-tree', sha, '--', RUNNER]).toString('utf8'));
}

const trees = new Map();
/**
 * The tree of commit `sha` from git objects: `blobs` (regular file path -> "mode blob-id"), `special` (symbolic links and
 * submodules) and the reference graph of its code.
 */
export function treeAt(command, repoPath, sha) {
  if (!SHA.test(sha ?? '')) throw new Error(`not a commit id: ${sha}`);
  const key = `${repoPath}\n${sha}`;
  if (trees.has(key)) return trees.get(key);
  const blobs = new Map(), ids = new Map(), special = new Set();
  for (const entry of git(command, repoPath, ['ls-tree', '-r', '-z', '--full-tree', sha]).toString('utf8').split('\0')) {
    const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(entry);
    if (!match) continue;
    if (match[2] === 'blob' && /^100(?:644|755)$/.test(match[1])) { blobs.set(match[4], `${match[1]} ${match[3]}`); ids.set(match[4], match[3]); }
    else special.add(match[4]);
  }
  const code = [...ids.keys()].filter((path) => CODE.test(path));
  const texts = new Map();
  if (code.length) {
    const out = git(command, repoPath, ['cat-file', '--batch'], code.map((path) => ids.get(path)).join('\n') + '\n');
    let at = 0;
    for (const path of code) {
      const end = out.indexOf(0x0a, at);
      const header = /^([0-9a-f]{40}) blob (\d+)$/.exec(out.subarray(at, end).toString('utf8'));
      if (!header || header[1] !== ids.get(path)) throw new Error(`git cat-file returned an unexpected object for ${path}`);
      const size = Number(header[2]);
      texts.set(path, out.subarray(end + 1, end + 1 + size).toString('utf8'));
      at = end + 1 + size + 1;
    }
  }
  const tree = { blobs, special, graph: referenceGraph([...blobs.keys(), ...special], (path) => texts.get(path) ?? '') };
  trees.set(key, tree);
  if (trees.size > 8) trees.delete(trees.keys().next().value);
  return tree;
}

/** The test files scripts/run-tests.mjs runs in `tree`: tests/**\/*.test.mjs outside any fixtures folder, sorted. */
export const testFiles = (tree) => [...tree.blobs.keys()]
  .filter((path) => /^tests\/.+\.test\.mjs$/.test(path) && !path.split('/').slice(1, -1).includes('fixtures')).sort();

/**
 * The content digest of test `file` in `tree`: the mode and blob of everything it reaches, of the shared inputs and of
 * every .gitattributes, with the schema version. Null when it reaches a symbolic link or a submodule: never cached.
 */
export function fileDigest(tree, file) {
  const paths = new Set();
  let uncacheable = false;
  const add = (ref) => {
    if (ref.endsWith('/')) {
      for (const path of tree.blobs.keys()) if (path.startsWith(ref)) paths.add(path);
      for (const path of tree.special) if (path.startsWith(ref)) uncacheable = true;
    } else if (tree.blobs.has(ref)) paths.add(ref);
    else if (tree.special.has(ref)) uncacheable = true;
  };
  for (const ref of reach(tree.graph, file)) add(ref);
  for (const ref of SHARED) add(ref);
  for (const path of tree.blobs.keys()) if (path === '.gitattributes' || path.endsWith('/.gitattributes')) paths.add(path);
  if (uncacheable) return null;
  const hash = createHash('sha256').update(`aiworks-test-cache ${SCHEMA}\ntest ${file}\n`);
  for (const path of [...paths].sort()) hash.update(`${path}\0${tree.blobs.get(path)}\n`);
  return hash.digest('hex');
}

/**
 * What a scripts/run-tests.mjs log says, from the runner's own markers only (a test file's output cannot start a line
 * with one, scripts/lib/test-markers.mjs): `ends` (file -> its `# end` lines: exit code, counts, and whether it was the
 * run alone after `# retry alone`), `claims` (`# cached` lines, as { file, digest }) and `nodeMajor` (from `# node v...`;
 * null when missing or not one version).
 */
export function parseGateLog(text) {
  const ends = new Map(), retried = new Set(), claims = [], nodes = new Set();
  let block = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    let match;
    if (line.startsWith('# cached ')) {
      match = /^# cached (\S+)(?: digest (\S+))?$/.exec(line);
      claims.push({ file: match?.[1] ?? line.slice('# cached '.length), digest: match?.[2] ?? null });
    } else if ((match = /^# retry alone (\S+)$/.exec(line))) retried.add(match[1]);
    else if ((match = /^# end (\S+) \d+ ms, exit (\S+)$/.exec(line))) {
      ends.set(match[1], [...(ends.get(match[1]) ?? []), { exit: match[2], counts: countsOf(block.join('\n')), alone: retried.has(match[1]) }]);
    } else if ((match = /^# node v(\d+)\.\d+\.\d+$/.exec(line))) nodes.add(Number(match[1]));
    else if (!/^# start \S+$/.test(line)) { block.push(line); continue; }
    block = [];
  }
  return { ends, retried, claims, nodeMajor: nodes.size === 1 ? [...nodes][0] : null };
}

const key = (repository) => repository.toLowerCase();
/** The newest row for one file, digest and Node major: it decides whether the file is cached. */
const latest = (store, repository, file, digest, nodeMajor) => store.get(`SELECT * FROM test_results WHERE repository = ? AND file = ? AND digest = ?
  AND node_major = ? ORDER BY at DESC, seq DESC LIMIT 1`, key(repository), file, digest, nodeMajor);
const usable = (row, at, maxAgeMs) => row?.state === 'passed' && at - row.at <= maxAgeMs;

/**
 * Whether the `# cached` lines of a gate log may count, for commit `sha` of `repository`, from a run dispatched at
 * `offeredAt`. Each is honoured only when the digest the supervisor computes now from the git objects of `sha` equals
 * the line's, and the newest row for it on the gate's own Node major is a pass no older than `maxAgeMs` at `offeredAt`;
 * then every test file of `sha` must have an `# end` line or an honoured `# cached` line. Returns { claimed, refused }:
 * claimed is the number of files the log claims, refused names each file that cannot count (empty when all do).
 */
export function checkClaims({ store, git: command, repoPath, repository, sha, log, maxAgeMs, offeredAt }) {
  const { ends, claims, nodeMajor } = parseGateLog(log);
  if (!claims.length) return { claimed: 0, refused: [] };
  const files = [...new Set(claims.map((claim) => claim.file))];
  if (nodeMajor === null) return { claimed: files.length, refused: ['the gate output names no single Node version'] };
  let tree;
  try { tree = treeAt(command, repoPath, sha); } catch (error) { return { claimed: files.length, refused: [`the commit ${sha} cannot be read: ${error.message}`] }; }
  const tests = new Set(testFiles(tree)), honoured = new Set(), refused = [];
  for (const { file, digest } of claims) {
    if (!tests.has(file)) { refused.push(`${file}: not a test file of ${sha}`); continue; }
    const actual = fileDigest(tree, file);
    if (actual === null || digest !== actual) refused.push(`${file}: its inputs at ${sha} are not the ones the line names`);
    else if (!usable(latest(store, repository, file, actual, nodeMajor), offeredAt, maxAgeMs)) refused.push(`${file}: no current recorded pass for its inputs at ${sha} on Node ${nodeMajor}`);
    else honoured.add(file);
  }
  for (const file of tests) if (!ends.has(file) && !honoured.has(file) && !refused.some((reason) => reason.startsWith(`${file}:`))) refused.push(`${file}: neither ran nor was cached`);
  return { claimed: files.length, refused: [...new Set(refused)] };
}

/**
 * The rows a gate log of commit `sha` gives, with digests computed from the git objects of `sha`: a failure for each
 * test file whose first run failed, and, when `passes`, a pass for each that ran exactly once, exited 0 and was not
 * retried alone. Never a row for a cached file, a file without a digest, or a log that names no single Node version.
 */
export function resultsOf({ git: command, repoPath, sha, log, passes }) {
  const { ends, retried, claims, nodeMajor } = parseGateLog(log);
  if (nodeMajor === null) return [];
  const tree = treeAt(command, repoPath, sha), cached = new Set(claims.map((claim) => claim.file));
  return testFiles(tree).flatMap((file) => {
    const runs = ends.get(file) ?? [], first = runs.filter((run) => !run.alone);
    if (cached.has(file) || !first.length) return [];
    const failed = first.some((run) => run.exit !== '0');
    if (!failed && !(passes && runs.length === 1 && !retried.has(file))) return [];
    const digest = fileDigest(tree, file);
    return digest === null ? [] : [{ file, digest, nodeMajor, state: failed ? 'failed' : 'passed', counts: first[0].counts }];
  });
}

/**
 * Records `rows` (resultsOf) for `repository`, only inserting, inside the controller's fence. `source` is 'verifier'
 * (a pass is then 'verified-head', a failure 'verifier-gate') or 'supervisor-gate'.
 */
export function insertResults(store, repository, rows, { source, ref, now }) {
  for (const row of rows) {
    const newest = latest(store, repository, row.file, row.digest, row.nodeMajor);
    if (newest?.state === row.state && now - newest.at < REFRESH_MS) continue;
    store.run(`INSERT INTO test_results (repository, file, digest, node_major, state, counts, source, ref, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      key(repository), row.file, row.digest, row.nodeMajor, row.state, JSON.stringify(row.counts),
      source !== 'verifier' ? source : row.state === 'passed' ? 'verified-head' : 'verifier-gate', ref, now);
  }
}

/**
 * Records the results of a supervisor gate of commit `sha` in `dir`: passes only when it is green and the caller
 * confirmed its checkout is still at `sha`, failures in any case. Does nothing while the cache is off, for a commit
 * without scripts/run-tests.mjs, or when the log claims cached files (supervisor gates run every file). A failure to
 * read records nothing and is logged: the cache only saves time. Inside the campaign's fence when `ctx` is given; a
 * group merge, which no single campaign owns, writes like its own journal records.
 */
export function recordGateResults(controller, ctx, { repository, repoPath, sha, dir, green }) {
  if (!controller.testCache) return;
  let rows;
  try {
    if (!hasRunner(controller.cmd.git, repoPath, sha)) return;
    const log = readFileSync(join(dir, GATE_FILES.log), 'utf8');
    if (parseGateLog(log).claims.length) return;
    rows = resultsOf({ git: controller.cmd.git, repoPath, sha, log, passes: green });
  } catch (error) {
    controller.log(`test cache: results of ${repository} ${sha} not recorded: ${error.message}`);
    return;
  }
  const insert = () => insertResults(controller.store, repository, rows, { source: 'supervisor-gate', ref: sha, now: controller.now() });
  if (ctx) controller.fenced(ctx, insert);
  else controller.store.tx(insert);
}

/**
 * Before a verify run of commit `sha`: writes the current recorded passes for its test files on this Node major to
 * skip.json in `runDir` and returns the environment that names it, or null when nothing matches or the target has no
 * scripts/run-tests.mjs.
 */
export function offerCache({ store, git: command, repoPath, repository, sha, runDir, settings, now }) {
  if (!hasRunner(command, repoPath, sha)) return null;
  const tree = treeAt(command, repoPath, sha);
  const files = testFiles(tree).flatMap((file) => {
    const digest = fileDigest(tree, file), row = digest && latest(store, repository, file, digest, NODE_MAJOR);
    if (!usable(row, now, settings.maxAgeMs)) return [];
    const counts = JSON.parse(row.counts);
    return [{ file, digest, nodeMajor: NODE_MAJOR, counts: Object.fromEntries(COUNTS.map((name) => [name, Number(counts?.[name]) || 0])) }];
  });
  if (!files.length) return null;
  const path = join(runDir, SKIP_FILE);
  // Written before the run starts and owned by the supervisor; a changed copy changes nothing, since checkClaims decides.
  writeAtomic(path, JSON.stringify({ version: SCHEMA, sha, files }));
  return { [CACHE_ENV]: path };
}
