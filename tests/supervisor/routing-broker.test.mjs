// A routed (routing.mode auto) commit campaign whose only implementer on Windows is the brokered Cursor provider must be
// able to start: the provider's code broker grant reaches its routing candidate, as on the static path.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoReceipt, policyInputs } from '../../src/supervisor/router.mjs';

const routing = {
  mode: 'auto',
  candidates: [
    { kind: 'cursor-cli', model: 'example-cursor-model', tier: 2 },
    { kind: 'claude-cli', model: 'example-claude-model', tier: 3 },
  ],
  pin: { implementer: { tier: 2 }, verifier: { kind: 'claude-cli', model: 'example-claude-model' } },
};
const spec = { deliverable: 'commit', web: null, references: ['AGENTS.md'], acceptance: ['works'], dependsOn: [], writes: ['src/'] };
const facts = () => ({ cliConfigured: true, hostUnavailable: null, wait: null });
const choose = (providers) => autoReceipt(policyInputs({ stage: 'implement', spec, routing, providers, platform: 'win32', facts })).decision.chosen;

test('a routed commit step on Windows runs on the brokered Cursor provider its operator granted, and on nothing without it', () => {
  const claude = { kind: 'claude-cli', model: 'example-claude-model', permissionMode: 'dontAsk' };
  const cursor = { kind: 'cursor-cli', model: 'example-cursor-model' };
  assert.equal(choose([{ ...cursor, brokeredCode: true }, claude])?.kind, 'cursor-cli');
  assert.equal(choose([cursor, claude]), null, 'without the grant no tier-2 implementer may commit, and the pin keeps Claude out');
});
