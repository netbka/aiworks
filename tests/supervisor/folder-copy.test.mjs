// The copy of a plain folder (docs/design/PROJECT_CONNECTION.md sections 4.3 to 4.5): only the listed files of the folder
// reach AIWorks's copy, never what a link leads to or what the owner excluded. Synthetic folders only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { folderFiles, syncFolderSnapshot } from '../../src/supervisor/adapters/mirror.mjs';
import { preflight } from '../../src/supervisor/project-preflight.mjs';

function folders(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-folder-copy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'notes'), outside = join(dir, 'outside');
  for (const path of [join(source, 'sub'), outside]) mkdirSync(path, { recursive: true });
  return { dir, source, outside };
}

test('a folder swapped for a junction while the copy runs never brings the files it leads to into the copy', (t) => {
  const { dir, source, outside } = folders(t);
  writeFileSync(join(source, 'a.txt'), 'first\n');
  writeFileSync(join(source, 'sub', 'z.txt'), 'inside\n');
  writeFileSync(join(outside, 'z.txt'), 'OUTSIDE-SYNTHETIC-SECRET\n');
  let swapped = false;
  const afterHash = () => {
    if (swapped) return;
    swapped = true;
    renameSync(join(source, 'sub'), join(dir, 'moved'));
    symlinkSync(outside, join(source, 'sub'), 'junction');
  };
  const mirrorRoot = join(dir, 'mirrors', 'notes');
  let result = null;
  try { result = syncFolderSnapshot({ mirrorRoot, sourceRoot: source, hooks: { afterHash } }); } catch (error) { assert.equal(error.code, 'CHANGED_DURING_COPY'); }
  if (result) {
    // The retry lists the folder again and leaves the junction out.
    const tree = spawnSync('git', ['-C', result.snapshotPath, 'ls-tree', '-r', '--name-only', result.head], { encoding: 'utf8', windowsHide: true }).stdout;
    assert.ok(!tree.split('\n').includes('sub/z.txt'), 'nothing behind the junction is committed');
    assert.ok(result.excluded.links.examples.includes('sub'));
  }
});

test('an owner exclusion leaves out the folder whatever the case of its name on Windows', { skip: process.platform !== 'win32' }, (t) => {
  const { source } = folders(t);
  mkdirSync(join(source, 'Build'));
  writeFileSync(join(source, 'Build', 'out.bin'), 'private\n');
  writeFileSync(join(source, 'kept.txt'), 'kept\n');
  const { files, excluded } = folderFiles(source, { exclusions: ['build'] });
  assert.deepEqual(files, ['kept.txt']);
  assert.equal(excluded.owner.count, 1);
});

test('a worktree root not created yet, named through a junction into the folder, still protects it', (t) => {
  const { dir, source } = folders(t);
  writeFileSync(join(source, 'kept.txt'), 'kept\n');
  symlinkSync(source, join(dir, 'alias'), 'junction');
  const future = join(dir, 'alias', 'worktrees-not-yet');
  const refused = preflight(source, { worktreeRoots: [{ repository: 'example-org/notes', path: future }], home: join(dir, 'home'), env: {} });
  assert.equal(refused.code, 'PATH_PROTECTED');
});
