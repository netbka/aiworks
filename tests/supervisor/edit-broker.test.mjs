import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyEdits } from '../../src/supervisor/edit-broker.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-edit-broker-'));
  const workspace = join(root, 'workspace');
  const runDir = join(root, 'run');
  mkdirSync(workspace); mkdirSync(runDir);
  git(workspace, 'init', '-q', '-b', 'task');
  git(workspace, 'config', 'user.name', 'Fixture');
  git(workspace, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(workspace, '.gitignore'), 'ignored-evidence.log\n');
  writeFileSync(join(workspace, 'note.txt'), 'first line\nsecond line\n');
  git(workspace, 'add', '--', '.gitignore', 'note.txt'); git(workspace, 'commit', '-q', '-m', 'base');
  const baseSha = git(workspace, 'rev-parse', 'HEAD');
  const input = { git: ['git'], workspace, runDir, operationId: 'op-1', sessionId: 'session-1', packetDigest: 'a'.repeat(64),
    baseSha, snapshotDigest: 'b'.repeat(64), edits: [{ path: 'note.txt', before: 'second line', after: 'replacement' }],
    expectedBranch: 'task', allowedPaths: ['note.txt'], deniedPaths: ['private'] };
  return { root, workspace, runDir, input, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('rejects invalid, misbound, and secret-shaped edits without changing repository state', () => {
  const f = fixture();
  try {
    const before = git(f.workspace, 'status', '--porcelain=v1');
    for (const edit of [
      { path: '../note.txt', before: 'second line', after: 'changed' },
      { path: '.github/workflows/build.yml', before: '', after: 'workflow' },
      { path: 'note.txt', before: 'missing', after: 'changed' },
      { path: 'note.txt', before: 'second line', after: 'API_KEY=not-a-placeholder-value' },
      { path: 'outside.txt', before: '', after: 'new' },
    ]) assert.throws(() => applyEdits({ ...f.input, edits: [edit] }), edit.path);
    assert.equal(git(f.workspace, 'status', '--porcelain=v1'), before);
    assert.equal(readFileSync(join(f.workspace, 'note.txt'), 'utf8'), 'first line\nsecond line\n');
  } finally { f.cleanup(); }
});

test('recovers crashes at intent, write, stage, tree, and commit exactly once while preserving unrelated evidence', () => {
  for (const checkpoint of ['intent', 'write', 'stage', 'tree', 'commit', 'candidate', 'promote']) {
    const f = fixture();
    try {
      writeFileSync(join(f.workspace, 'ignored-evidence.log'), 'keep me\n');
      assert.throws(() => applyEdits({ ...f.input, checkpoint: (at) => { if (at === checkpoint) throw new Error('simulated crash'); } }), /simulated crash/);
      const recovered = applyEdits(f.input);
      const again = applyEdits(f.input);
      assert.equal(recovered.headSha, again.headSha);
      assert.equal(git(f.workspace, 'rev-list', '--count', `${f.input.baseSha}..HEAD`), '1');
      assert.equal(readFileSync(join(f.workspace, 'note.txt'), 'utf8').replaceAll('\r\n', '\n'), 'first line\nreplacement\n');
      assert.equal(readFileSync(join(f.workspace, 'ignored-evidence.log'), 'utf8'), 'keep me\n');
    } finally { f.cleanup(); }
  }
});

test('refuses a stale or concurrently advanced branch without applying edits', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workspace, 'concurrent.txt'), 'concurrent change\n');
    git(f.workspace, 'add', '--', 'concurrent.txt'); git(f.workspace, 'commit', '-q', '-m', 'concurrent');
    const movedHead = git(f.workspace, 'rev-parse', 'HEAD');
    assert.throws(() => applyEdits(f.input), /differs from pinned base/);
    assert.equal(git(f.workspace, 'rev-parse', 'HEAD'), movedHead);
    assert.equal(readFileSync(join(f.workspace, 'note.txt'), 'utf8'), 'first line\nsecond line\n');
  } finally { f.cleanup(); }
});
