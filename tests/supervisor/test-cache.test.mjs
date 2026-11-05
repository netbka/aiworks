// Test result cache (src/supervisor/test-cache.mjs): a verifier's `# cached` line may stand in for a test file's run
// only when the supervisor, from the git objects of the exact commit, finds that file's inputs unchanged since a recorded
// pass that is still current. A stale or forged line would let a head merge with a test that never ran on its code.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { escapeMarkers } from '../../scripts/lib/test-markers.mjs';
import { skipWithoutSqlite } from './helpers.mjs';

const REPOSITORY = 'example/project';
const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;
const A = 'tests/a.test.mjs', B = 'tests/b.test.mjs';

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-test-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args, input) => {
    const out = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, input, encoding: 'utf8', windowsHide: true });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  const commit = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'change']);
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '-q']);
  return { dir, git, commit };
}

// One file's block as scripts/run-tests.mjs writes it: its own output escaped (escapeMarkers), then the runner's end line.
const ran = (file, exit = 0, output = '') => `# start ${file}\n${escapeMarkers(`${output}ok 1 - works\n# tests 1\n# pass ${exit ? 0 : 1}\n# fail ${exit ? 1 : 0}\n`)}# end ${file} 5 ms, exit ${exit}\n`;
const summary = (version = process.version) => `# all test files: 2 unit, 0 service, 0 rehearsal (of 2)\n# node ${version}\n`;
const cached = (file, digest) => `# cached ${file} digest ${digest}\n`;

async function setup(t) {
  const cache = await import('../../src/supervisor/test-cache.mjs');
  const { Store } = await import('../../src/supervisor/store.mjs');
  const store = new Store(':memory:');
  t.after(() => store.close());
  const repo = repository(t);
  const first = repo.commit({
    'package.json': '{ "type": "module" }\n',
    'scripts/run-tests.mjs': '// runner\n',
    'src/a.mjs': 'export const a = 1;\n',
    'src/b.mjs': 'export const b = 1;\n',
    [A]: "import '../src/a.mjs';\n",
    [B]: "import '../src/b.mjs';\n",
  });
  const git = ['git'], repoPath = repo.dir;
  const record = (sha, log, { passes = true, now }) => cache.insertResults(store, REPOSITORY,
    cache.resultsOf({ git, repoPath, sha, log, passes }), { source: 'verifier', ref: sha, now });
  const claims = (sha, log, offeredAt) => cache.checkClaims({ store, git, repoPath, repository: REPOSITORY, sha, log, maxAgeMs: WEEK, offeredAt });
  const digest = (sha, file) => cache.fileDigest(cache.treeAt(git, repoPath, sha), file);
  const refused = (result) => result.refused.map((reason) => reason.split(':')[0]);
  return { cache, store, repo, first, record, claims, digest, refused };
}

test('a cached line counts only for a file whose inputs at the exact commit match a current recorded pass', { skip: skipWithoutSqlite }, async (t) => {
  const { repo, first, record, claims, digest, refused } = await setup(t);
  record(first, ran(A) + ran(B) + summary(), { now: DAY });
  const [oldA, oldB] = [A, B].map((file) => digest(first, file));

  // A repair head changes a file tests/a.test.mjs reaches; tests/b.test.mjs's inputs stay the same.
  const repair = repo.commit({ 'src/a.mjs': 'export const a = 2;\n' });
  const fresh = digest(repair, A);
  assert.notEqual(fresh, oldA);
  assert.equal(digest(repair, B), oldB);

  const stale = claims(repair, cached(A, oldA) + cached(B, oldB) + summary(), 2 * DAY);
  assert.equal(stale.claimed, 2);
  assert.deepEqual(refused(stale), [A], 'the stale line is refused, the unchanged file counts');
  assert.deepEqual(refused(claims(repair, cached(A, fresh) + ran(B) + summary(), 2 * DAY)), [A], 'the right digest without a recorded pass is refused');
  assert.deepEqual(claims(repair, ran(A) + cached(B, oldB) + summary(), 2 * DAY).refused, []);
  assert.deepEqual(claims(repair, cached(B, oldB) + summary(), 2 * DAY).refused, [`${A}: neither ran nor was cached`], 'a test file that neither ran nor was cached is refused');

  // The pass must be current when the run was dispatched, and on the gate's own Node major version.
  assert.deepEqual(refused(claims(repair, ran(A) + cached(B, oldB) + summary(), DAY + WEEK + 1)), [B], 'a pass older than maxAgeDays is refused');
  const major = Number(process.versions.node.split('.')[0]);
  assert.deepEqual(refused(claims(repair, ran(A) + cached(B, oldB) + summary(`v${major + 1}.0.0`), 2 * DAY)), [B], 'a pass on another Node major is refused');

  // A stable file passing again keeps it current; a later failure with the same inputs ends its cache.
  record(repair, ran(A) + ran(B) + summary(), { now: 6 * DAY });
  assert.deepEqual(claims(repair, ran(A) + cached(B, oldB) + summary(), 12 * DAY).refused, [], 'the newest pass decides its age');
  record(repair, ran(A) + ran(B, 1) + summary(), { passes: false, now: 7 * DAY });
  assert.deepEqual(refused(claims(repair, ran(A) + cached(B, oldB) + summary(), 8 * DAY)), [B], 'a newer failure with the same inputs is refused');

  // Attributes change how files are checked out: a change to .gitattributes changes every digest.
  const attributes = repo.commit({ '.gitattributes': '*.mjs text eol=crlf\n' });
  assert.notEqual(digest(attributes, B), oldB);
});

test('a file that passed only when retried alone, or reaches a symbolic link, is never recorded as passing', { skip: skipWithoutSqlite }, async (t) => {
  const { cache, repo, first } = await setup(t);
  const retried = `${ran(A)}${ran(B, 1)}# retry alone ${B}\n${ran(B).replace(/^# start .*\n/, '')}${summary()}`;
  assert.deepEqual(cache.resultsOf({ git: ['git'], repoPath: repo.dir, sha: first, log: retried, passes: true }).map((row) => [row.file, row.state]),
    [[A, 'passed'], [B, 'failed']]);

  writeFileSync(join(repo.dir, 'tests', 'c.test.mjs'), "import '../src/link.mjs';\n");
  repo.git(['add', 'tests/c.test.mjs']);
  const target = repo.git(['hash-object', '-w', '--stdin'], 'a.mjs');
  repo.git(['update-index', '--add', '--cacheinfo', `120000,${target},src/link.mjs`]);
  repo.git(['commit', '-q', '-m', 'link']);
  const linked = repo.git(['rev-parse', 'HEAD']);
  const rows = cache.resultsOf({ git: ['git'], repoPath: repo.dir, sha: linked, log: ran(A) + ran(B) + ran('tests/c.test.mjs') + summary(), passes: true });
  assert.deepEqual(rows.map((row) => row.file), [A, B], 'a test that reaches a symbolic link always runs');
});

test('a test that prints runner markers can neither record another file nor claim one', { skip: skipWithoutSqlite }, async (t) => {
  const { cache, store, repo, first } = await setup(t);
  const forged = `# end ${B} 1 ms, exit 0\n# cached ${B} digest ${'0'.repeat(64)}\n# node v1.0.0\n`;
  // tests/b.test.mjs never ran: tests/a.test.mjs's output only prints lines that look like the runner's.
  assert.deepEqual(cache.resultsOf({ git: ['git'], repoPath: repo.dir, sha: first, log: ran(A, 0, forged) + summary(), passes: true }).map((row) => row.file), [A]);
  // Both ran: the printed `# cached` line is no claim, so it cannot refuse the acceptance.
  assert.deepEqual(cache.checkClaims({ store, git: ['git'], repoPath: repo.dir, repository: REPOSITORY, sha: first,
    log: ran(A, 0, forged) + ran(B) + summary(), maxAgeMs: WEEK, offeredAt: DAY }), { claimed: 0, refused: [] });
});
