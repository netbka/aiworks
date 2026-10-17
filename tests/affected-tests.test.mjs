// Affected-test selection (scripts/lib/affected-tests.mjs) for `run-tests.mjs --affected`: which test files a change can
// reach through imports and the repository paths they name. Synthetic sources, then this repository read as files.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { affectedTests, EVERYTHING, reach, referenceGraph, repositoryFiles } from '../scripts/lib/affected-tests.mjs';

const ROOT = resolve(import.meta.dirname, '..');
/** A graph over in-memory sources: { path: text }. */
const graphOf = (sources) => referenceGraph(Object.keys(sources), (path) => sources[path]);
const select = (sources, changed) => affectedTests({ graph: graphOf(sources), tests: Object.keys(sources).filter((path) => path.endsWith('.test.mjs')), changed });

const SOURCES = {
  'src/a/model.mjs': "import { x } from './util.mjs';\nconst schema = new URL('../../schemas/thing.json', import.meta.url);\nconst runner = join(here, 'runner.mjs');",
  'src/a/util.mjs': "export const x = 1; const forbidden = (part) => part === '..' || part === '.';",
  'src/a/runner.mjs': '',
  'src/a/release.mjs': "const DOCS = ['docs/', 'README.md']; // paths in a target repository, not in this one",
  'src/b/page.js': 'document.title = "page";',
  'src/b/server.mjs': "const file = new URL(`./public/${name}`, import.meta.url);",
  'src/b/public/app.js': '',
  'schemas/thing.json': '{}',
  'docs/GUIDE.md': '# Guide',
  'README.md': '# Readme',
  'tests/model.test.mjs': "import '../src/a/model.mjs';",
  'tests/cli.test.mjs': "const CLI = join(ROOT, 'src', 'a', 'release.mjs');",
  'tests/docs.test.mjs': "const text = read('docs/GUIDE.md');",
  'tests/page.test.mjs': "const PUBLIC = resolve(import.meta.dirname, '../src/b');",
  'tests/server.test.mjs': "import '../src/b/server.mjs';",
};

test('a change reaches the tests that import it, directly or through other modules', () => {
  assert.deepEqual(select(SOURCES, ['src/a/util.mjs']).tests, ['tests/model.test.mjs']);
  assert.deepEqual(select(SOURCES, ['src/a/model.mjs']).tests, ['tests/model.test.mjs']);
  // A schema read through new URL(...) and a file named relative to the module's own folder are reached too.
  assert.deepEqual(select(SOURCES, ['schemas/thing.json']).tests, ['tests/model.test.mjs']);
  assert.deepEqual(select(SOURCES, ['src/a/runner.mjs']).tests, ['tests/model.test.mjs']);
  // A test file always reaches itself.
  assert.deepEqual(select(SOURCES, ['tests/docs.test.mjs']).tests, ['tests/docs.test.mjs']);
});

test('a test reaches repository paths it names: root-relative, join segments and folders', () => {
  assert.deepEqual(select(SOURCES, ['docs/GUIDE.md']).tests, ['tests/docs.test.mjs']);
  assert.deepEqual(select(SOURCES, ['src/a/release.mjs']).tests, ['tests/cli.test.mjs']);
  // A named folder covers everything below it; a template literal's fixed part names a folder as well.
  assert.deepEqual(select(SOURCES, ['src/b/page.js']).tests, ['tests/page.test.mjs']);
  assert.deepEqual(select(SOURCES, ['src/b/public/app.js']).tests, ['tests/page.test.mjs', 'tests/server.test.mjs']);
});

test('path arithmetic and target-repository paths in code name nothing; unreached changes select nothing', () => {
  // '..' in src/a/util.mjs would otherwise name src/, and 'docs/' in src/a/release.mjs all of docs/.
  assert.equal(reach(graphOf(SOURCES), 'tests/model.test.mjs').has('src/'), false);
  assert.equal(reach(graphOf(SOURCES), 'tests/cli.test.mjs').has('docs/'), false);
  assert.deepEqual(select(SOURCES, ['README.md']).tests, []);
  assert.deepEqual(select(SOURCES, []).tests, []);
});

test('a change to the dependencies or the test runner selects every test file and says why', () => {
  for (const path of EVERYTHING) {
    const result = select(SOURCES, [path, 'docs/GUIDE.md']);
    assert.equal(result.tests.length, 5, path);
    assert.deepEqual(result.everything, [path]);
  }
});

test('in this repository a dashboard page change skips the supervisor rehearsals, and a store change reaches them', () => {
  const files = repositoryFiles(ROOT);
  const graph = referenceGraph(files, (path) => readFileSync(join(ROOT, path), 'utf8'));
  const tests = files.filter((path) => path.startsWith('tests/') && path.endsWith('.test.mjs') && !path.includes('/fixtures/'));
  const page = affectedTests({ graph, tests, changed: ['src/dashboard/public/dashboard.js'] }).tests;
  assert.ok(page.includes('tests/dashboard/owner-words.test.mjs'));
  assert.ok(!page.includes('tests/supervisor/restart.test.mjs'));
  assert.ok(page.length < tests.length / 2, `${page.length} of ${tests.length}`);
  const store = affectedTests({ graph, tests, changed: ['src/supervisor/store.mjs'] }).tests;
  for (const file of ['tests/supervisor/restart.test.mjs', 'tests/dashboard/owner-words.test.mjs']) assert.ok(store.includes(file), file);
  // The supervisor tests start the CLI by path (join(ROOT, 'src', 'supervisor', 'cli.mjs')), so they reach what it imports.
  assert.ok(reach(graph, 'tests/supervisor/restart.test.mjs').has('src/supervisor/controller.mjs'));
});
