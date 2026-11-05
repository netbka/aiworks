// Test result cache (src/supervisor/test-cache.mjs): a verifier's `# cached` line may stand in for a test file's run
// only when the supervisor, from the git objects of the exact commit, finds that file's inputs unchanged since a recorded
// pass. A stale or forged line would let a head merge with a test that never ran on its code.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { skipWithoutSqlite } from './helpers.mjs';

const REPOSITORY = 'example/project';

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-test-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const out = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  const commit = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  return { dir, commit };
}

const ran = (file, exit = 0) => `# start ${file}\nok 1 - works\n# tests 1\n# pass ${exit ? 0 : 1}\n# fail ${exit ? 1 : 0}\n# end ${file} 5 ms, exit ${exit}\n`;

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
    'tests/a.test.mjs': "import '../src/a.mjs';\n",
    'tests/b.test.mjs': "import '../src/b.mjs';\n",
  });
  return { cache, store, repo, first };
}

test('a cached line counts only for a file whose inputs at the exact commit match a recorded pass', { skip: skipWithoutSqlite }, async (t) => {
  const { cache, store, repo, first } = await setup(t);
  const at = (sha) => ({ store, git: ['git'], repoPath: repo.dir, repository: REPOSITORY, sha, enabled: true });
  cache.insertPasses(store, REPOSITORY, cache.passesOf({ git: ['git'], repoPath: repo.dir, sha: first, log: ran('tests/a.test.mjs') + ran('tests/b.test.mjs') }),
    { source: 'verified-head', ref: first, now: 1 });
  const before = cache.treeAt(['git'], repo.dir, first);
  const [oldA, oldB] = ['tests/a.test.mjs', 'tests/b.test.mjs'].map((file) => cache.fileDigest(before, file));

  // A repair head changes a file tests/a.test.mjs reaches; tests/b.test.mjs's inputs stay the same.
  const repair = repo.commit({ 'src/a.mjs': 'export const a = 2;\n' });
  const fresh = cache.fileDigest(cache.treeAt(['git'], repo.dir, repair), 'tests/a.test.mjs');
  assert.notEqual(fresh, oldA);

  const stale = cache.checkClaims({ ...at(repair), log: `# cached tests/a.test.mjs digest ${oldA}\n# cached tests/b.test.mjs digest ${oldB}\n` });
  assert.equal(stale.claimed, 2);
  assert.deepEqual(stale.refused.map((reason) => reason.split(':')[0]), ['tests/a.test.mjs'], 'the stale line is refused, the unchanged file counts');

  const forged = cache.checkClaims({ ...at(repair), log: `# cached tests/a.test.mjs digest ${fresh}\n${ran('tests/b.test.mjs')}` });
  assert.deepEqual(forged.refused.map((reason) => reason.split(':')[0]), ['tests/a.test.mjs'], 'a line with the right digest but no recorded pass is refused');

  const honest = cache.checkClaims({ ...at(repair), log: `${ran('tests/a.test.mjs')}# cached tests/b.test.mjs digest ${oldB}\n` });
  assert.deepEqual(honest.refused, []);
});

test('a file that passed only when retried alone is never recorded', { skip: skipWithoutSqlite }, async (t) => {
  const { cache, repo, first } = await setup(t);
  const log = `${ran('tests/a.test.mjs')}${ran('tests/b.test.mjs', 1)}# retry alone tests/b.test.mjs\n${ran('tests/b.test.mjs').replace(/^# start .*\n/, '')}`;
  assert.deepEqual(cache.passesOf({ git: ['git'], repoPath: repo.dir, sha: first, log }).map((row) => row.file), ['tests/a.test.mjs']);
});
