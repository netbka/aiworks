// A routed (routing.mode auto) commit campaign whose only implementer on Windows is the brokered Cursor provider must be
// able to start: the code broker grant reaches exactly the routing candidate (kind, model) it was judged for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoReceipt, policyInputs } from '../../src/supervisor/router.mjs';
import { environment, declaration, skipWithoutSqlite } from './helpers.mjs';
import { Store } from '../../src/supervisor/store.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';

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

test('a routed brokered implementer dispatches on a host with global Cursor configuration', { skip: skipWithoutSqlite || process.platform !== 'win32' }, async (t) => {
  const env = environment(), d = declaration({ tasks: [{ ...declaration().tasks[0], writes: ['note.txt'] }] });
  const model = 'example-included-model';
  d.executor = { kind: 'cli-chain', providers: [{ kind: 'cursor-cli', model }, claude], implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
  d.routing = { ...routing([model]) };
  const oldHome = process.env.CURSOR_CONFIG_DIR;
  process.env.CURSOR_CONFIG_DIR = join(env.tmp, 'cursor-home'); mkdirSync(process.env.CURSOR_CONFIG_DIR);
  writeFileSync(join(process.env.CURSOR_CONFIG_DIR, 'cli-config.json'), '{}'); // global configuration a tool-free run never loads
  const packageRoot = join(env.tmp, 'package'); mkdirSync(packageRoot);
  for (const name of ['node', 'index.js']) writeFileSync(join(packageRoot, name), 'synthetic, never executed');
  const credentialFile = join(env.tmp, 'public-fixture.txt'); writeFileSync(credentialFile, 'not a credential');
  const configPath = join(env.tmp, 'transport.json');
  writeFileSync(configPath, JSON.stringify({ version: 1, distribution: 'ExampleLinux', allowedRoot: env.tmp, packageRoot, credentialFile, allowedModels: [model] }));
  env.config.commands.cursor = [process.execPath, fileURLToPath(new URL('../../src/supervisor/adapters/cursor-wsl.mjs', import.meta.url)), '--config', configPath];
  env.config.codeBroker = { enabled: true, repositories: { [d.target.repository]: { campaigns: [d.campaignId], models: [model],
    roles: ['implementer', 'verification'], includedOnly: { attestedBy: 'owner', paidOverages: false, recordedAt: '2026-01-01' },
    nativeModels: { [model]: 'Example Included' }, allowedRoot: env.tmp, verificationCommand: ['npm', 'run', 'check'] } } };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  campaignStart(store, d);
  const ctl = new Controller({ store, config: env.config, dataDir: env.dataDir });
  ctl.launch = async () => {}; // Durable dispatch only; no real provider process.
  t.after(() => { ctl.release(); store.close(); env.cleanup();
    if (oldHome === undefined) delete process.env.CURSOR_CONFIG_DIR; else process.env.CURSOR_CONFIG_DIR = oldHome; });
  await ctl.tick();
  const op = store.openOperations(d.campaignId)[0];
  assert.equal(op?.executor_kind, 'cursor-cli', JSON.stringify(store.campaign(d.campaignId).blocker));
});
