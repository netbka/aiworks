import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceAudit } from '../../src/supervisor/maintenance.mjs';

test('maintenance cannot mutate repositories or expose file contents, and unknown ownership never authorizes cleanup', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), linked = join(root, 'linked');
  mkdirSync(repo);
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args],
      { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'private/\n');
  writeFileSync(join(repo, 'tracked.txt'), 'original\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fixture');
  git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
  git(repo, 'worktree', 'lock', linked);
  writeFileSync(join(linked, 'tracked.txt'), 'unsaved-private-content\n');
  writeFileSync(join(linked, 'untracked.txt'), 'untracked-private-content\n');
  mkdirSync(join(linked, 'private'));
  writeFileSync(join(linked, 'private', 'evidence.txt'), 'ignored-private-content\n');
  // An audit must not execute a repository's filesystem-monitor hook.
  git(repo, 'config', 'core.fsmonitor', 'not-a-command');
  const head = git(repo, 'rev-parse', 'HEAD');
  const indexPath = git(linked, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  const before = readFileSync(indexPath);
  const report = maintenanceAudit({ repositories: [repo, linked], root });
  assert.equal(report.errors.length, 0);
  assert.equal(report.repositories.length, 1);
  const item = report.repositories[0].worktrees.find((wt) => wt.path.replaceAll('\\', '/') === linked.replaceAll('\\', '/'));
  assert.equal(item.classification, 'locked');
  assert.deepEqual(item.status, { dirty: true, untracked: true, ignored: true });
  assert.equal(item.activity, 'unknown');
  assert.equal(item.suggestion, 'retain');
  assert.equal(JSON.stringify(report).includes('private-content'), false);
  assert.deepEqual(readFileSync(indexPath), before);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(linked, 'tracked.txt'), 'utf8'), 'unsaved-private-content\n');
  const bounded = maintenanceAudit({ repositories: [repo] });
  assert.ok(bounded.repositories[0].worktrees.find((wt) => !wt.primary).reasons.includes('outside-root'));
});
