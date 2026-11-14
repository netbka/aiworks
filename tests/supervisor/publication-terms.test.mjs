import test from 'node:test';
import assert from 'node:assert/strict';
import { termsForTarget } from '../../src/supervisor/controller.mjs';

// A private term naming the target itself must not stop that target's own pull requests, and must still bind every other
// target: dropping it everywhere would let one project's name leak into another repository.
test('a private term is dropped only for the target it names', () => {
  const terms = ['alpha_notes', 'beta-shop', 'example-owner'];
  const alpha = { repository: 'example-owner/alpha_notes', projectId: 'alpha' };
  const beta = { repository: 'example-owner/shop', projectId: 'beta-shop' };
  assert.deepEqual(termsForTarget(terms, alpha), ['beta-shop', 'example-owner']);
  // The projectId is private, not public like the repository name: a term matching only it still binds.
  assert.deepEqual(termsForTarget(terms, beta), terms);
  assert.deepEqual(termsForTarget(terms, { repository: 'example-owner/other', projectId: 'other' }), terms);
  assert.deepEqual(termsForTarget(terms, undefined), terms);
});
