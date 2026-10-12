// RUN3 (ADAPTIVE_SCHEDULER slice S1): a usage limit, a failed login or an unavailable host belongs to the provider account,
// not to one campaign. One wait on the account holds every campaign that uses it; a recheck or a success ends it once, and
// the campaigns waiting on it resume at once. Accounts are named per executor kind in config.json (providerAccounts) and
// default to the kind. Workers are played through applyOutcome: nothing is spawned, no model, network or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignRecheck, campaignStart, campaignStatus } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { accountOf, accountWait, laterWait } from '../../src/supervisor/accounts.mjs';
import { declaration, environment } from './helpers.mjs';

const chain = { kind: 'cli-chain', providers: [{ kind: 'claude-cli', model: 'opus', permissionMode: 'auto' }],
  implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
const campaign = (campaignId, issue) => ({ ...declaration({ campaignId, tasks: [{ id: 'T1', issue, title: `${campaignId} task`,
  deliverable: 'commit', goal: 'Produce it.', dependsOn: [], acceptance: ['it exists'], references: ['AGENTS.md'] }] }), executor: chain });

function rig(t, config = {}) {
  const env = environment();
  Object.assign(env.config, config);
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  controller.launch = async () => {}; // the test plays the worker; nothing is spawned
  const open = (id) => store.openOperations(id)[0] ?? null;
  const quota = (id, retryAt) => {
    const op = open(id);
    assert.ok(op, `${id} has an open operation`);
    controller.applyOutcome({ id, generation: controller.held.get(id) }, op, { class: 'quota', retryAt,
      detail: 'usage limit reached; resets later', receipt: { sessionId: op.session_id } });
  };
  return { env, store, controller, open, quota, tick: () => controller.tick() };
}

test('one account cooldown holds every campaign using that account', async (t) => {
  const r = rig(t);
  campaignStart(r.store, campaign('camp-a', 801));
  await r.tick();
  const resetAt = Date.now() + 60 * 60_000;
  r.quota('camp-a', resetAt);
  assert.equal(accountWait(r.store, r.env.config, 'claude-cli')?.retry_at, resetAt, 'the usage limit is recorded on the account');

  // A campaign registered afterwards uses the same Claude account: it waits instead of sending work to an exhausted account.
  campaignStart(r.store, campaign('camp-b', 802));
  await r.tick();
  assert.equal(r.open('camp-b'), null, 'camp-b dispatched nothing while the account waits');
  const waiting = r.store.task('camp-b', 'T1');
  assert.equal(waiting.retry_at, resetAt);
  assert.match(waiting.last_error, /^waiting for executor availability/);
  const status = campaignStatus(r.store, 'camp-b');
  assert.deepEqual(status.executorWaits.map((w) => [w.executor_kind, w.retry_at]), [['claude-cli', resetAt]], 'status shows the account wait');
});

test('a recheck of one campaign ends the account wait once, and every campaign waiting on it resumes at once', async (t) => {
  const r = rig(t);
  campaignStart(r.store, campaign('camp-a', 811));
  await r.tick();
  r.quota('camp-a', Date.now() + 60 * 60_000);
  campaignStart(r.store, campaign('camp-b', 812));
  await r.tick();
  assert.equal(r.open('camp-b'), null);

  campaignRecheck(r.store, 'camp-a', { note: 'the owner says the limit lifted' });
  await r.tick();
  assert.equal(accountWait(r.store, r.env.config, 'claude-cli'), null, 'the account wait ended');
  assert.ok(r.open('camp-a'), 'camp-a resumed');
  assert.ok(r.open('camp-b'), 'camp-b resumed without waiting for its own timer');
  for (const id of ['camp-a', 'camp-b']) {
    assert.equal(r.store.all("SELECT kind FROM journal WHERE campaign_id = ? AND kind = 'provider-wait-cleared'", id).length, 1, `${id} journals the cleared wait once`);
  }
});

test('different accounts cool down independently', async (t) => {
  const r = rig(t, { providerAccounts: { 'claude-cli': 'claude-main' } });
  assert.equal(accountOf(r.env.config, 'claude-cli'), 'claude-main');
  assert.equal(accountOf({ providerAccounts: { 'claude-cli': '../bad name' } }, 'claude-cli'), 'claude-cli', 'a malformed name falls back to the kind');
  assert.equal(accountOf({}, 'codex-cli'), 'codex-cli', 'without a mapping the account is the executor kind');
  // A wait on another account (an earlier mapping, or another login) never holds this one.
  r.store.run('INSERT INTO provider_waits (account, executor_kind, retry_at, reason, campaign_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    'claude-other', 'claude-cli', Date.now() + 60 * 60_000, 'quota: another account', 'elsewhere', Date.now());
  campaignStart(r.store, campaign('camp-c', 821));
  await r.tick();
  assert.ok(r.open('camp-c'), 'the wait of claude-other does not hold claude-main');
  r.quota('camp-c', Date.now() + 60 * 60_000);
  assert.ok(accountWait(r.store, r.env.config, 'claude-cli'), 'the limit lands on claude-main');
  assert.equal(r.store.all("SELECT * FROM provider_waits WHERE account = 'claude-other'").length, 1, 'the other account is untouched');
});

test('the later wait wins, and an untimed wait beats any time', () => {
  const at = (retry_at) => ({ retry_at });
  assert.equal(laterWait(null, null), null);
  assert.deepEqual(laterWait(at(5), null), at(5));
  assert.deepEqual(laterWait(null, at(5)), at(5));
  assert.deepEqual(laterWait(at(5), at(9)), at(9));
  assert.deepEqual(laterWait(at(9), at(null)), at(null));
});
