// A verified result in a repository the merge settings leave out says that AIWorks does not merge it, instead of a
// silent wait; one the owner opted in stays with the merge gate. Synthetic repository and tasks only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delivery } from '../../src/dashboard/owner.mjs';

const NOW = Date.UTC(2026, 0, 1);
const REPOSITORY = 'example/recipes';
const SHA = 'a'.repeat(40);
const merges = { repositories: [{ repository: REPOSITORY, configured: true, fetchedAt: NOW - 60_000 }],
  steps: { 'demo/T1': { sha: SHA, merged: false } } };
const task = (mergeGate, resultUrl = `https://github.com/${REPOSITORY}/pull/7`) =>
  ({ id: 'T1', state: 'done', resultUrl, verifiedSha: SHA, review: { mergeGate } });
const delegation = { delegatedTo: 'supervisor' };

test('merging delegated to AIWorks in a repository left out of the merge settings is shown as off', () => {
  const off = delivery(task('off'), merges, NOW, 'demo', delegation);
  assert.equal(off.state, 'published');
  assert.equal(off.reason, 'gate-off');
  assert.equal(off.pending, false);
  assert.ok(off.note);

  const on = delivery(task('on'), merges, NOW, 'demo', delegation);
  assert.equal(on.state, 'delegated', 'an opted-in repository stays with the merge gate');

  const local = delivery(task('off', '#/worklist/12'), merges, NOW, 'demo', delegation, REPOSITORY);
  assert.equal(local.reason, 'gate-off', 'the local work-list review says the same');
});
