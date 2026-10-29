// Worker fallback (aiworks#39): a step that reaches its retry limit only through unusable results on one provider runs
// once more on another declared provider before it stops. Never after a denial, never past the run limit, and a
// single-provider campaign stops as before. Synthetic campaign; no model, network or GitHub calls.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { declaration, environment, sleep, SQLITE, skipWithoutSqlite } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const chain = { kind: 'cli-chain', providers: [{ kind: 'codex-cli' }, { kind: 'claude-cli', model: 'opus', permissionMode: 'auto' }],
  implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };

function fixture(t, { executor = chain, limits = {} } = {}) {
  const env = environment();
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(env.tmp, 'CODEX_HOME');
  env.config.commands.codex = ['synthetic-codex'];
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = declaration({ tasks: [{ ...declaration().tasks[0], deliverable: 'report' }], limits: { maxRetriesPerTask: 1, ...limits } });
  d.executor = structuredClone(executor);
  campaignStart(store, d);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir });
  controller.launch = async () => {};
  t.after(() => {
    controller.release(); store.close(); env.cleanup();
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  });
  const id = d.campaignId;
  // Dispatch the next attempt, run `meanwhile`, settle it with `verdict`; returns the provider that ran it.
  const attempt = async (verdict, meanwhile = () => {}) => {
    await sleep(60);
    await controller.tick();
    const op = store.openOperations(id)[0];
    assert.ok(op, 'an attempt was dispatched');
    meanwhile();
    controller.applyOutcome({ id, generation: controller.held.get(id) }, op, { ...verdict, receipt: { sessionId: op.session_id } });
    return op.executor_kind;
  };
  const wait = (kind) => store.run("INSERT OR REPLACE INTO executor_waits (campaign_id, executor_kind, retry_at, reason) VALUES (?, ?, NULL, 'auth: synthetic')", id, kind);
  const back = (kind) => () => store.run('DELETE FROM executor_waits WHERE campaign_id = ? AND executor_kind = ?', id, kind);
  const fallbacks = () => store.all("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'worker-fallback'", id).map((row) => row.detail);
  return { store, controller, id, attempt, wait, back, fallbacks };
}

const invalid = (n) => ({ class: 'invalid-result', detail: `terminal message is not JSON (${n})` });

test('a step stopped by unusable results on one provider runs exactly once more on the next provider, then stops', { skip: skipWithoutSqlite }, async (t) => {
  const { store, id, attempt, wait, back, fallbacks } = fixture(t);
  wait('claude-cli');
  assert.equal(await attempt(invalid(1)), 'codex-cli');
  // The other provider waited while both attempts ran on Codex and is back when the retry limit is reached.
  assert.equal(await attempt(invalid(2), back('claude-cli')), 'codex-cli');
  assert.equal(store.task(id, 'T1').blocked, null, 'the step gets one more run instead of stopping');
  assert.deepEqual(fallbacks().map(({ from, to }) => ({ from, to })), [{ from: 'codex-cli', to: 'claude-cli' }]);
  assert.match(fallbacks()[0].reason, /unusable results on codex-cli/, 'the record says why the provider changed');
  assert.equal(await attempt(invalid(4)), 'claude-cli', 'the fallback run uses the next provider');
  assert.equal(store.task(id, 'T1').blocked?.class, 'stalled', 'the step stops when the fallback run also fails');
  assert.equal(fallbacks().length, 1, 'only once per step and head');
});

test('a denial or a spent run limit never moves the step to another provider', { skip: skipWithoutSqlite }, async (t) => {
  for (const [name, limits, last] of [
    ['denial', {}, { class: 'error', detail: 'native command permission denied; no provider fallback' }],
    ['run limit', { maxWorkerRuns: 2 }, invalid(2)],
  ]) {
    await t.test(name, async (st) => {
      const { store, id, attempt, wait, back, fallbacks } = fixture(st, { limits });
      wait('claude-cli');
      assert.equal(await attempt(invalid(1)), 'codex-cli');
      assert.equal(await attempt(last, back('claude-cli')), 'codex-cli');
      assert.equal(store.task(id, 'T1').blocked?.class, 'stalled', `${name}: the step stops`);
      assert.equal(fallbacks().length, 0, `${name}: no fallback run`);
    });
  }
});

test('a campaign with a single provider stops at its retry limit as before', { skip: skipWithoutSqlite }, async (t) => {
  const { store, id, attempt, fallbacks } = fixture(t, { executor: declaration().executor });
  assert.equal(await attempt(invalid(1)), 'claude-cli');
  assert.equal(await attempt(invalid(2)), 'claude-cli');
  assert.equal(store.task(id, 'T1').blocked?.class, 'stalled');
  assert.equal(fallbacks().length, 0);
});
