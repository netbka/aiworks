// A managed worktree is created only inside its configured worktree root, after links and junctions are resolved.
// Disposable repositories in a temporary folder; no network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareImplementWorkspace } from '../../src/supervisor/adapters/git.mjs';
import { checkout } from '../../src/supervisor/merge-refresh.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

test('no managed worktree is created outside the configured root or through a junction; a dirty one inside is kept', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'aiworks-root-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = join(tmp, 'repo'), root = join(tmp, 'worktrees'), outside = join(tmp, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  git(tmp, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'README.md'), 'sample\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
  const base = git(repo, 'rev-parse', 'HEAD');
  const implement = (taskId) => prepareImplementWorkspace({ git: ['git'], repoPath: repo, worktreeRoot: root, campaignId: 'camp', taskId, baseBranch: 'main', baseSha: base });

  // A dirty worktree inside the root is reused as it is.
  const made = implement('T1');
  writeFileSync(join(made.path, 'unsaved.txt'), 'keep\n');
  assert.equal(implement('T1').path, made.path);
  assert.equal(readFileSync(join(made.path, 'unsaved.txt'), 'utf8'), 'keep\n');

  // A destination outside the root (refresh, group and base checks take theirs from the journal) is refused.
  assert.throws(() => checkout(['git'], repo, join(outside, 'refresh'), base, root), { code: 'WORKTREE_ROOT' });
  assert.throws(() => checkout(['git'], repo, join(root, '..', 'outside', 'refresh'), base, root), { code: 'WORKTREE_ROOT' });
  // A junction (a symbolic link elsewhere) inside the root that leads outside it is refused, at the destination or above.
  symlinkSync(outside, join(root, 'camp-T2'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => implement('T2'), { code: 'WORKTREE_ROOT' });
  symlinkSync(outside, join(root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => checkout(['git'], repo, join(root, 'nested', 'refresh'), base, root), { code: 'WORKTREE_ROOT' });
  assert.deepEqual(readdirSync(outside), [], 'nothing was written outside the root');
  assert.equal(existsSync(join(repo, '.git', 'worktrees', 'camp-T2')), false, 'no worktree was registered');
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 2);
});
