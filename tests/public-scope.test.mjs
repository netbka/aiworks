import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPublicScope, checkPublicHistory } from '../scripts/check-public-scope.mjs';

test('public scope rejects private files even when force-added, while allowing synthetic fixtures', t => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-public-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const out = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(out.status, 0, out.stderr);
  };
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), 'campaigns/\n.local/\n');
  mkdirSync(join(root, 'tests/fixtures/campaigns'), { recursive: true });
  writeFileSync(join(root, 'tests/fixtures/campaigns/synthetic.json'), '{}');
  git('add', '.');
  assert.doesNotThrow(() => checkPublicScope(root));
  for (const path of ['campaigns/private.json', '.local/supervisor/config.json', 'supervisor.db', '.env.production', '.ENV.production',
    '.aws/credentials', '.ssh/id_ed25519', '.npmrc', '.claude/settings.local.json', 'registry/projects/actual.json']) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'private-value-must-never-be-printed');
    git('add', '-f', path);
    assert.throws(() => checkPublicScope(root), e => /Private installation files/.test(e.message) && !e.message.includes('private-value'), path);
    git('rm', '--cached', '-f', path);
    rmSync(join(root, path));
  }
  const canary = ['ghp', 'A'.repeat(36)].join('_');
  for (const content of [canary, ['netbka', 'private-project'].join('/'), ['netbka', 'aiworks-private'].join('/'), ['D:', 'Git', 'private-project'].join('/')]) {
    writeFileSync(join(root, 'README.md'), content);
    git('add', 'README.md');
    writeFileSync(join(root, 'README.md'), 'A clean working copy does not clean the index.');
    assert.throws(() => checkPublicScope(root), error => /Public content check failed/.test(error.message) && !error.message.includes(content));
    git('rm', '--cached', '-f', 'README.md');
  }
  writeFileSync(join(root, '.local/publication.json'), JSON.stringify({ privateTerms: ['fictional-private-host'] }));
  writeFileSync(join(root, 'README.md'), 'fictional-private-host');
  git('add', 'README.md');
  assert.throws(() => checkPublicScope(root), /Public content check failed/);
  git('rm', '--cached', '-f', 'README.md');
  writeFileSync(join(root, 'fictional-private-host.md'), 'Generic content');
  git('add', 'fictional-private-host.md');
  assert.throws(() => checkPublicScope(root), /Public content check failed/);
});

test('the push check rejects a private blob removed by a later commit and a private commit message', t => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-private-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const out = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  git('init', '-q');
  writeFileSync(join(root, 'README.md'), 'Public source');
  git('add', '.'); git('commit', '-qm', 'Public baseline');
  const baseline = git('rev-parse', 'HEAD');
  assert.doesNotThrow(() => checkPublicHistory(root, ['HEAD']));
  const push = (ref, sha) => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-public-scope.mjs', import.meta.url)), '--pre-push'], {
    cwd: root, input: `${ref} ${sha} ${ref} ${'0'.repeat(40)}\n`, encoding: 'utf8', windowsHide: true,
  });
  git('tag', '-a', 'unsafe-annotation', baseline, '-m', ['ghp', 'C'.repeat(36)].join('_'));
  const tagResult = push('refs/tags/unsafe-annotation', git('rev-parse', 'unsafe-annotation'));
  assert.equal(tagResult.status, 1);
  assert.match(tagResult.stderr, /tag annotation/);
  git('tag', 'blob-target', git('rev-parse', `${baseline}:README.md`));
  assert.equal(push('refs/tags/blob-target', git('rev-parse', 'blob-target')).status, 1);
  writeFileSync(join(root, 'README.md'), ['ghp', 'B'.repeat(36)].join('_'));
  git('add', '.'); git('commit', '-qm', 'Intermediate content');
  writeFileSync(join(root, 'README.md'), 'Public source');
  git('add', '.'); git('commit', '-qm', 'Remove intermediate content');
  assert.doesNotThrow(() => checkPublicScope(root));
  assert.throws(() => checkPublicHistory(root, [`${baseline}..HEAD`]), /Public content check failed/);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal(push('refs/heads/new-public-branch', git('rev-parse', 'HEAD')).status, 1);
  git('commit', '--allow-empty', '-qm', ['netbka', 'private-project'].join('/'));
  assert.throws(() => checkPublicHistory(root, ['HEAD^..HEAD']), /commit message contains private/);
});
