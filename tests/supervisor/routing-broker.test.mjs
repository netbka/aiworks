// A routed (routing.mode auto) commit campaign whose only implementer on Windows is the brokered Cursor provider must be
// able to start: the code broker grant reaches exactly the routing candidate (kind, model) it was judged for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoReceipt, policyInputs } from '../../src/supervisor/router.mjs';

const claude = { kind: 'claude-cli', model: 'example-claude-model', permissionMode: 'dontAsk' };
const routing = (cursorModels) => ({
  mode: 'auto',
  candidates: [...cursorModels.map((model) => ({ kind: 'cursor-cli', model, tier: 2 })), { kind: 'claude-cli', model: claude.model, tier: 3 }],
  pin: { implementer: { tier: 2 }, verifier: { kind: 'claude-cli', model: claude.model } },
});
const spec = { deliverable: 'commit', web: null, references: ['AGENTS.md'], acceptance: ['works'], dependsOn: [], writes: ['src/'] };
const facts = () => ({ cliConfigured: true, hostUnavailable: null, wait: null });
const choose = (routes, providers) => autoReceipt(policyInputs({ stage: 'implement', spec, routing: routes, providers, platform: 'win32', facts })).decision.chosen;
const cursor = (model, granted) => ({ kind: 'cursor-cli', model, ...(granted ? { brokeredCode: true } : {}) });

test('a routed commit step on Windows runs only on a Cursor model its operator granted, and on nothing without a grant', () => {
  assert.equal(choose(routing(['granted-model']), [cursor('granted-model', true), claude])?.kind, 'cursor-cli');
  assert.equal(choose(routing(['granted-model']), [cursor('granted-model', false), claude]), null,
    'without the grant no tier-2 implementer may commit, and the pin keeps Claude out');
  for (let i = 0; i < 2; i++) {
    const order = i ? ['other-model', 'granted-model'] : ['granted-model', 'other-model'];
    assert.equal(choose(routing(order), [cursor('granted-model', true), cursor('other-model', false), claude])?.model, 'granted-model',
      'an ungranted model of the same provider is never chosen');
  }
});
