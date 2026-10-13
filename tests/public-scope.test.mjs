import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkPublicScope } from '../scripts/check-public-scope.mjs';

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
  for (const path of ['campaigns/private.json', '.local/supervisor/config.json', 'supervisor.db', '.env.production']) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'private-value-must-never-be-printed');
    git('add', '-f', path);
    assert.throws(() => checkPublicScope(root), e => /Private installation files/.test(e.message) && !e.message.includes('private-value'));
    git('rm', '--cached', '-f', path);
  }
});
