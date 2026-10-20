// Follow-ups from the historical regression review: hooks off, broader reply secret gate, no inherited Claude session variables,
// and no stale coordinator block while idle. Synthetic workers only; no model, network or GitHub access.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildArgv, ISOLATION_ARGS } from '../../src/supervisor/adapters/claude.mjs';
import { workerEnv } from '../../src/supervisor/proc.mjs';
import { declaration, environment, runUntil, SQLITE, skipWithoutSqlite } from './helpers.mjs';

const coordinator = await import('../../src/supervisor/coordinator.mjs');
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const api = SQLITE ? await import('../../src/supervisor/api.mjs') : {};

test('every Claude worker and the coordinator run with all hooks disabled', () => {
  const at = ISOLATION_ARGS.indexOf('--settings');
  assert.deepEqual(JSON.parse(ISOLATION_ARGS[at + 1]), { disableAllHooks: true });
  for (const role of ['implementer', 'verification']) {
    const argv = buildArgv({ command: ['claude'], executor: { model: 'opus', permissionMode: 'auto' }, role, deliverable: 'commit', sessionId: 's' });
    assert.equal(argv[argv.indexOf('--settings') + 1], '{"disableAllHooks":true}');
    assert.equal(argv[argv.indexOf('--setting-sources') + 1], '');
  }
});

test('the reply gate catches common credential formats but not placeholders or prose', () => {
  const real = [`sk_live_${'a1'.repeat(12)}`, `npm_${'A1b2'.repeat(9)}`, `123456789:AA${'x'.repeat(33)}`, `AIza${'B'.repeat(35)}`,
    ['postgres://app', 's3cretPass@db.internal:5432/app'].join(':'), 'API_KEY=Zx81Kq0pLm2Nb7Rt', 'DB_PASSWORD: "hunter2hunter2"', `token ghp_${'A'.repeat(36)}`];
  for (const text of real) assert.equal(coordinator.containsSecret(`see ${text} here`), true, text);
  const benign = ['API_KEY=<your-key>', 'API_KEY=xxxxxxxx', 'API_KEY=${API_KEY}', 'DB_PASSWORD: changeme', 'rotate the deploy token next week',
    'https://github.com/example-org/sampleapp/pull/465', 'postgres://db.internal:5432/app', 'set SECRET_NAME in Infisical'];
  for (const text of benign) assert.equal(coordinator.containsSecret(text), false, text);
});

test('workers never inherit the supervisor\'s own Claude Code session variables', () => {
  const env = workerEnv({ PATH: 'p', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', CLAUDE_CODE_SHELL: 'x', HOME: 'h' },
    { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
  assert.deepEqual(env, { PATH: 'p', HOME: 'h', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
    GIT_LFS_SKIP_SMUDGE: '1', GIT_LFS_SKIP_PUSH: '1' });
});

test('an inherited session variable does not reach a real contained worker process', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const previous = process.env.CLAUDE_CODE_PROBE_INHERITED;
  process.env.CLAUDE_CODE_PROBE_INHERITED = 'leaked-from-supervisor';
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CODE_PROBE_INHERITED; else process.env.CLAUDE_CODE_PROBE_INHERITED = previous; store.close(); env.cleanup(); });
  const decl = declaration({ tasks: [declaration().tasks[0]] });
  api.campaignStart(store, decl);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  await runUntil(controller, store, decl.campaignId, (c) => c.control === 'finished');
  assert.ok(env.calls().length >= 2);
  assert.ok(env.calls().every((call) => call.inheritedProbe === null && call.autoMemoryDisabled === true));
});

test('an idle coordinator with valid configuration clears a stale blocked reason', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  env.config.coordinator = { repositories: ['example-org/aiworks'], reportTo: 'example-org/aiworks#3', sourceRepo: env.repo,
    worktreeRoot: join(env.tmp, 'coordinator-worktrees') };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  store.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('coordinator_blocked', 'invalid coordinator configuration: stale')");
  await controller.tick();
  assert.equal(coordinator.coordinatorView(store, env.config).blocked, null);
  // A recorded violation is different: it stays until the owner clears it.
  store.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('coordinator_violation', ?)", JSON.stringify({ run: 'x' }));
  await controller.tick();
  assert.match(coordinator.coordinatorView(store, env.config).blocked, /coordinator-clear/);
  coordinator.postOwnerMessage(store, { text: 'hi', requestId: randomUUID() });
  for (let i = 0; i < 3; i++) await controller.tick();
  assert.equal(env.calls().length, 0, 'no read while a violation is recorded');
});
