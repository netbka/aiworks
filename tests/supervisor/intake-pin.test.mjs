import assert from 'node:assert/strict';
import test from 'node:test';
import { pinRequest } from '../../src/supervisor/intake.mjs';

// The intake pin reads a GitHub project's base only through the bounded read that keeps custody receipts (aiworks#143):
// a checkout whose earlier fetch is not shown ended is never pinned, and no fetch of its own runs beside that read.
test('intake does not pin a base while the checkout has an unresolved read receipt', async () => {
  const row = { id: 'sampleapp', source_kind: 'github', root_path: 'example/sampleapp', github_repository: 'example-org/sampleapp',
    base_branch: 'main', disconnected_at: null };
  const store = { get: () => row };
  const request = { project_id: 'sampleapp', route: 'goal', reference: null };
  const reads = [];
  const refused = await pinRequest(store, request, { git: ['example-git-that-must-not-run'],
    readBase: async (repo, base) => { reads.push([repo, base]); return { ok: false, sha: null, failure: 'uncontained' }; } });
  assert.deepEqual(refused, { ok: false, code: 'BASE_UNKNOWN', retry: true });
  assert.deepEqual(reads, [['example/sampleapp', 'main']]);
  assert.deepEqual(await pinRequest(store, request, { git: ['example-git-that-must-not-run'] }), { ok: false, code: 'BASE_UNKNOWN', retry: true });
  const sha = 'a'.repeat(40);
  const pinned = await pinRequest(store, request, { readBase: async () => ({ ok: true, sha }) });
  assert.equal(pinned.pinned.base, sha);
});
