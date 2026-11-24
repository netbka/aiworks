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
// used up. Only the runtime's src/ prefix is cut: a path into its ignored .local/, any other absolute path and a personal
// path in Git Bash form are still refused.
test('the gate helper command a verifier reports is publishable; any other local path is not', () => {
  const options = { repository: 'example-owner/sampleapp' };
  const repo = { path: 'C:/Repo/sampleapp', worktreeRoot: 'C:/Wt/sampleapp' };
  assert.deepEqual(publicationFindings(relativeTo(`- \`${GATE_HELPER} start npm test\`: passed`, publicRoots(repo)), options), []);
  const roots = publicRoots(repo, 'C:/Rt/aiworks');
  assert.equal(relativeTo('node "C:\\Rt\\aiworks\\src\\supervisor\\gate.mjs" wait', roots), 'node "src\\supervisor\\gate.mjs" wait');
  const gitBash = ['', 'c', 'Users', 'sample', 'notes.txt'].join('/');
  for (const text of ['C:/Rt/aiworks/.local/notes.txt', 'C:/Rt/aiworks/src/../.local/notes.txt', 'D:/Data/notes.txt', gitBash]) {
    assert.notDeepEqual(publicationFindings(relativeTo(text, roots), options), [], text);
  }
});
