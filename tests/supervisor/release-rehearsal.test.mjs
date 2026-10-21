// The disposable release rehearsal (AUTO_RELEASE slice R12 first half, REL11): whole releases through the production
// release code, end to end, against a synthetic project, grant and site folder. One test: if any part of the composed
// release path breaks, an unauthorized, repeated or unchecked deploy could follow. No model, network or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rehearsalText, rehearseRelease } from '../../src/supervisor/release/rehearsal.mjs';

test('the rehearsal releases the exact revision, restores on a failed check, recovers from a crash and refuses unauthorized releases', async () => {
  const result = await rehearseRelease();
  assert.deepEqual(result.scenarios.map((item) => item.id),
    ['exact-release', 'check-now', 'rollback', 'crash-recovery', 'unknown-outcome', 'refusals', 'stop-and-tree', 'review-only']);
  assert.equal(result.passed, true, rehearsalText(result));
});
