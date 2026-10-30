import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDraft, draftDeclaration } from '../../src/supervisor/intake.mjs';

// A new draft routes among the models its providers already name (MODEL_ROUTING 4.1 and 6, aiworks#39). Its model
// choice adds no provider, model or permission, and its checks are pinned to the strongest tier.
test('a new draft routes only among already authorized models, with checks on the strongest tier', () => {
  const executor = { kind: 'cli-chain', implementerTimeoutMinutes: 60, verifierTimeoutMinutes: 30, providers: [
    { kind: 'claude-cli', model: 'sonnet', permissionMode: 'auto' }, { kind: 'codex-cli' }, { kind: 'agy-cli', model: 'example-model' }] };
  const { declaration } = draftDeclaration({
    request: { request_id: '00000000-0000-4000-a000-000000000001', route: 'goal', reference: null, tracking_issue: 7 },
    project: { id: 'sampleapp', tenant_id: 'example', source_kind: 'github', github_repository: 'example-org/sampleapp', base_branch: 'main' },
    pinned: { base: 'a'.repeat(40) }, executor, sensitivePaths: ['src/core/'], now: Date.parse('2026-10-30T08:00:00Z'),
    proposal: { outcome: 'Add a page', acceptance: ['The page opens'], writes: ['src/pages/'], deliverables: ['commit'], constraints: ['Synthetic: no network.'],
      routing: { mode: 'auto', candidates: [{ kind: 'cursor-cli', model: 'extra', tier: 1 }] },
      tasks: [{ id: 'T1', title: 'add a page', deliverable: 'commit', goal: 'Add a page.', dependsOn: [], acceptance: ['The page opens'], references: ['README.md'],
        writes: ['src/pages/'], routing: { risk: 'high' } }] } });
  checkDraft(declaration);
  assert.deepEqual(declaration.executor, executor, 'the providers and their permissions are exactly the ones given');
  assert.deepEqual(declaration.routing, { mode: 'auto', sensitivePaths: ['src/core/'], pin: { verifier: { tier: 3 } }, candidates: [
    { kind: 'claude-cli', model: 'sonnet', tier: 2 }, { kind: 'agy-cli', model: 'example-model', tier: 3 }] });
  assert.equal(declaration.tasks[0].routing, undefined, 'the proposal cannot set routing');
});
