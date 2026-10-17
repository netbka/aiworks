import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkVerification, prepareVerifyWorkspace } from '../../src/supervisor/adapters/git.mjs';
import { GATE_FILES } from '../../src/supervisor/gate.mjs';

function fixture(t, trackedGate = false) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-verify-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Synthetic Reviewer');
  git('config', 'user.email', 'reviewer@example.invalid');
  git('config', 'core.excludesFile', join(root, 'empty-ignore'));
  writeFileSync(join(root, 'empty-ignore'), '');
  writeFileSync(join(repo, 'source.txt'), 'original\n');
  if (trackedGate) writeFileSync(join(repo, GATE_FILES.log), 'tracked content\n');
  git('add', '.');
  git('commit', '-qm', 'synthetic base');
  const options = { git: ['git'], path: repo, targetSha: git('rev-parse', 'HEAD') };
  return { root, repo, git, options };
}

test('verification accepts the helper artifacts in a target with no log ignore rule, including retry preparation', (t) => {
  const { root, repo, options } = fixture(t);
  const workspace = { git: ['git'], repoPath: repo, worktreeRoot: join(root, 'worktrees'), campaignId: 'synthetic', taskId: 'T1', targetSha: options.targetSha, attempt: 1 };
  const { path } = prepareVerifyWorkspace(workspace);
  for (const name of Object.values(GATE_FILES)) writeFileSync(join(path, name), 'synthetic helper output\n');
  assert.equal(checkVerification({ ...options, path }), null);
  assert.equal(prepareVerifyWorkspace(workspace).path, path);
  assert.match(checkVerification({ ...options, path, targetSha: 'a'.repeat(40) }), /target SHA/);
  writeFileSync(join(path, 'source.txt'), 'changed\n');
  assert.match(checkVerification({ ...options, path }), /not clean/);
});

test('other log files, nested artifact names and arbitrary untracked files remain dirty', (t) => {
  const { repo, options } = fixture(t);
  for (const name of ['other.log', 'gate.log.extra', 'source-new.txt', 'nested/gate.log']) {
    mkdirSync(join(repo, 'nested'), { recursive: true });
    writeFileSync(join(repo, name), 'unexpected\n');
    assert.match(checkVerification(options), /not clean/, name);
    rmSync(join(repo, name));
  }
});

test('tracked helper names and hardlinked helper artifacts remain dirty', (t) => {
  const { repo, options } = fixture(t, true);
  writeFileSync(join(repo, GATE_FILES.log), 'changed tracked log\n');
  assert.match(checkVerification(options), /not clean/);
  const second = fixture(t);
  linkSync(join(second.repo, 'source.txt'), join(second.repo, GATE_FILES.log));
  assert.match(checkVerification(second.options), /not clean/);
});
