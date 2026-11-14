import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPublicScope, checkPublicHistory } from '../scripts/check-public-scope.mjs';
import { assertPublishable, contentFindings, privateTerms, PUBLIC_REPOSITORY } from '../src/shared/public-text.mjs';

test('publication accepts the public repository followed by punctuation but refuses other repository names', () => {
  for (const name of [PUBLIC_REPOSITORY, `${PUBLIC_REPOSITORY}.git`, PUBLIC_REPOSITORY.toUpperCase()]) {
    for (const suffix of ['', '.', '...', ',', ')', "'s"]) {
      const text = `Reviewed ${name}${suffix}`;
      assert.deepEqual(contentFindings(text), []);
      assert.doesNotThrow(() => assertPublishable('report', text, { repository: PUBLIC_REPOSITORY }));
    }
  }
  for (const suffix of ['-private', '.private', '_private', '.git.private']) {
    const text = `Reviewed ${PUBLIC_REPOSITORY}${suffix}.`;
    assert.deepEqual(contentFindings(text), ['another upstream-owner project']);
    assert.throws(() => assertPublishable('report', text, { repository: PUBLIC_REPOSITORY }),
      error => error.code === 'PUBLICATION_TEXT_REFUSED' && !error.message.includes(text));
  }
});

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

test('a real merge header names a branch without exempting private messages, branch terms or credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-merge-message-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const out = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  git('init', '-q');
  writeFileSync(join(root, 'README.md'), 'Public source');
  git('add', '.'); git('commit', '-qm', 'Public baseline');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'docs/example');
  git('commit', '--allow-empty', '-qm', 'Public documentation');
  const child = git('rev-parse', 'HEAD');
  const header = ['Merge pull request #7 from netbka', 'docs/example'].join('/');
  const commit = (message, parents = [base, child]) => git('commit-tree', 'HEAD^{tree}', ...parents.flatMap(p => ['-p', p]), '-m', message);
  const check = sha => checkPublicHistory(root, [`${base}..${sha}`]);
  assert.doesNotThrow(() => check(commit(header)));
  assert.throws(() => check(commit(header, [base])), /commit message contains private/);
  assert.throws(() => check(commit(`${header}\n\n${['netbka', 'private-project'].join('/')}`)), /commit message contains private/);
  assert.throws(() => check(commit(`${header}\n\n${['ghp', 'D'.repeat(36)].join('_')}`)), /commit message contains private/);
  mkdirSync(join(root, '.local'));
  writeFileSync(join(root, '.local/publication.json'), JSON.stringify({ privateTerms: [header] }));
  assert.throws(() => check(commit(header)), /commit message contains private/);
});

test('a binary file is refused in a commit and in pushed history until its blob id is listed', t => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-binary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const out = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  git('init', '-q');
  writeFileSync(join(root, 'README.md'), 'Public source');
  git('add', '.'); git('commit', '-qm', 'Public baseline');
  const base = git('rev-parse', 'HEAD');
  // A screenshot named like text and one with an image extension: neither carries a private term the text check sees.
  writeFileSync(join(root, 'notes.txt'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  writeFileSync(join(root, 'shot.png'), 'looks like text');
  git('add', '.');
  assert.throws(() => checkPublicScope(root), /Binary files not in/);
  git('commit', '-qm', 'Add screenshots');
  writeFileSync(join(root, 'notes.txt'), 'Public notes');
  git('rm', '-q', 'shot.png'); git('add', '.'); git('commit', '-qm', 'Remove screenshots');
  // Removed later, the screenshots are still in the pushed history.
  assert.throws(() => checkPublicHistory(root, [`${base}..HEAD`]), /Binary files not in/);
  const ids = [git('rev-parse', 'HEAD~1:notes.txt'), git('rev-parse', 'HEAD~1:shot.png')];
  writeFileSync(join(root, '.public-binaries'), `# reviewed\n${ids[0]} notes.txt\n${ids[1]} shot.png\n`);
  git('add', '.'); git('commit', '-qm', 'List reviewed screenshots');
  assert.doesNotThrow(() => checkPublicScope(root));
  assert.doesNotThrow(() => checkPublicHistory(root, [`${base}..HEAD`]));
});

test('a Git checkout under a configured repository root is a private term without being listed', t => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-repo-names-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repos = join(root, 'repos'), self = join(repos, 'public-tool');
  for (const name of ['fictional_ledger', 'public-tool', 'scratch-folder']) mkdirSync(join(repos, name), { recursive: true });
  mkdirSync(join(repos, 'fictional_ledger', '.git'));
  mkdirSync(join(self, '.git')); mkdirSync(join(self, '.local'));
  writeFileSync(join(self, '.local/publication.json'), JSON.stringify({ privateTerms: [], repositoryRoots: [repos, join(root, 'absent')] }));
  const git = (...args) => {
    const out = spawnSync('git', args, { cwd: self, encoding: 'utf8', windowsHide: true });
    assert.equal(out.status, 0, out.stderr);
  };
  rmSync(join(self, '.git'), { recursive: true });
  git('init', '-q');
  writeFileSync(join(self, 'README.md'), 'public-tool works with scratch-folder notes.');
  git('add', 'README.md');
  assert.doesNotThrow(() => checkPublicScope(self));
  writeFileSync(join(self, 'README.md'), 'Data comes from the fictional-ledger service.');
  git('add', 'README.md');
  assert.throws(() => checkPublicScope(self), /Public content check failed/);
  // The supervisor's publications to a target name that target: they keep to the listed terms only.
  assert.deepEqual(privateTerms(self), []);
});
