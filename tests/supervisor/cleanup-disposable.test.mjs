// Cleanup deletes only what is disposable, so no private file or evidence goes with it (cleanup.mjs, docs/SUPERVISOR.md
// section 15): a finished worktree loses only the ignored paths its repository lists, a finished run only its Chrome profile.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disposablePaths, removeBrowserProfiles } from '../../src/supervisor/cleanup.mjs';

test('only relative paths listed for that repository are disposable', () => {
  const config = { cleanup: { enabled: true, disposable: { 'Example/App': ['build/', '.cache/state.json', '../outside/', '/abs/', 'C:/x/', String.raw`a\b/`, 'x/../y/', 7] } } };
  assert.deepEqual(disposablePaths(config, 'example/app'), ['build/', '.cache/state.json']);
  assert.deepEqual(disposablePaths(config, 'example/other'), []);
  assert.deepEqual(disposablePaths({ cleanup: { enabled: true, disposable: ['build/'] } }, 'example/app'), []);
  assert.deepEqual(disposablePaths({ cleanup: { enabled: true } }, 'example/app'), []);
});

test('a finished run loses only its Chrome profile; an open run keeps it', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-profiles-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const run = (id) => { const dir = join(dataDir, 'runs', id); mkdirSync(join(dir, 'chrome-profile', 'Default'), { recursive: true });
    writeFileSync(join(dir, 'chrome-profile', 'Default', 'Cache'), 'x'); writeFileSync(join(dir, 'stdout.json'), '{}'); return dir; };
  const done = run('done'), open = run('open'), outside = join(dataDir, 'elsewhere');
  mkdirSync(join(outside, 'chrome-profile'), { recursive: true });
  const ops = [{ id: 'done', state: 'finished', run_dir: done }, { id: 'open', state: 'dispatched', run_dir: open }, { id: 'x', state: 'finished', run_dir: outside }];
  const journal = [];
  const ctl = { dataDir, now: () => 1, store: { all: (_sql, ...open) => ops.filter((op) => !open.includes(op.state)), journal: (...entry) => journal.push(entry) } };
  assert.equal(removeBrowserProfiles(ctl), 1);
  assert.equal(existsSync(join(done, 'chrome-profile')), false);
  assert.equal(existsSync(join(done, 'stdout.json')), true, 'the run evidence stays');
  assert.equal(existsSync(join(open, 'chrome-profile', 'Default', 'Cache')), true, 'an open run keeps its browser');
  assert.equal(existsSync(join(outside, 'chrome-profile')), true, 'only run directories under the data directory');
});
