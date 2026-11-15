// A finished worktree loses only the ignored paths its repository lists as disposable: anything else keeps it, so no
// private file or evidence is deleted with a checkout (cleanup.mjs, docs/SUPERVISOR.md section 15).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { disposablePaths } from '../../src/supervisor/cleanup.mjs';

test('only relative paths listed for that repository are disposable', () => {
  const config = { cleanup: { enabled: true, disposable: { 'Example/App': ['build/', '.cache/state.json', '../outside/', '/abs/', 'C:/x/', String.raw`a\b/`, 'x/../y/', 7] } } };
  assert.deepEqual(disposablePaths(config, 'example/app'), ['build/', '.cache/state.json']);
  assert.deepEqual(disposablePaths(config, 'example/other'), []);
  assert.deepEqual(disposablePaths({ cleanup: { enabled: true, disposable: ['build/'] } }, 'example/app'), []);
  assert.deepEqual(disposablePaths({ cleanup: { enabled: true } }, 'example/app'), []);
});
