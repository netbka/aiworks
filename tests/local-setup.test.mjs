import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setupLocal } from '../scripts/setup-local.mjs';
import { assertRegisteredTarget, projectGovernance } from '../src/supervisor/campaign.mjs';

test('local setup creates no project authority and never overwrites existing governance', t => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-local-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const governance = setupLocal(root);
  assert.deepEqual(readdirSync(join(governance, 'registry/projects')), []);
  const declaration = { target: { repository: 'example/project' }, tasks: [] };
  assert.throws(() => assertRegisteredTarget(declaration, governance), /not a registered project/);
  const path = join(governance, 'registry/projects/example.json');
  const contract = readFileSync(join(governance, 'project.example'), 'utf8');
  writeFileSync(path, contract);
  assert.doesNotThrow(() => assertRegisteredTarget(declaration, governance));
  assert.deepEqual(projectGovernance('example/project', governance).policies, ['BASE-001']);
  assert.throws(() => setupLocal(root), { code: 'EEXIST' });
  assert.equal(readFileSync(path, 'utf8'), contract);
  const unsafe = JSON.parse(contract);
  unsafe.governance.authorities[0].path = '.env';
  writeFileSync(path, JSON.stringify(unsafe));
  assert.throws(() => projectGovernance('example/project', governance));
});
