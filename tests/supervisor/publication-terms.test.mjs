import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRoots, termsForTarget } from '../../src/supervisor/controller.mjs';
import { GATE_HELPER } from '../../src/supervisor/adapters/executors.mjs';
import { publicationFindings, relativeTo } from '../../src/shared/public-text.mjs';

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

// A term and a repository name are written with hyphens or underscores interchangeably, in any case: such a variant of
// the target's own name names that target too, and still binds every other target.
test('a hyphen or underscore variant of the target name is dropped for that target only', () => {
  const terms = ['sample-wiki', 'Sample_Shop'];
  assert.deepEqual(termsForTarget(terms, { repository: 'example-owner/sample_wiki' }), ['Sample_Shop']);
  assert.deepEqual(termsForTarget(terms, { repository: 'example-owner/SAMPLE-SHOP' }), ['sample-wiki']);
  assert.deepEqual(termsForTarget(terms, { repository: 'example-owner/other' }), terms);
});

// Every verifier is handed the gate helper by its absolute path in this runtime and lists that command among its checks.
// Left as it is, the privacy check refused each such verification, and a task stalled once its fresh verifier runs were
// used up. The runtime's own root is cut; any other absolute path in the same text is still refused.
test('the gate helper command a verifier reports is publishable; another absolute path is not', () => {
  const options = { repository: 'example-owner/sampleapp' };
  const roots = publicRoots({ path: 'C:/Repo/sampleapp', worktreeRoot: 'C:/Wt/sampleapp' });
  const check = `- \`${GATE_HELPER} start npm test\`: passed`;
  assert.deepEqual(publicationFindings(relativeTo(check, roots), options), []);
  assert.deepEqual(publicationFindings(relativeTo(`${check}\nsee D:/Data/notes.txt`, roots), options), ['absolute local path']);
});
