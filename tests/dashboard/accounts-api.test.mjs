// Worker accounts over HTTP (aiworks#197; worker-accounts audit 2026-10-17): the dashboard lists accounts, removes a
// saved login and keeps each role's model order. No route adds, connects, exports or imports a login, because any local
// process can read the CSRF token from /api/session. Synthetic review fixture, disposable stores and made-up profile
// folders only: no route here reads a real home folder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { Store } from '../../src/supervisor/store.mjs';
import { preferenceFor } from '../../src/supervisor/accounts.mjs';
import { buildReviewFixture } from './fixtures/review-store.mjs';

const M = 60_000;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-accounts-api-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return buildReviewFixture(root);
}

/** A made-up login folder: `<dataDir>/profiles/<name>/<folder>/<file>`. */
function login(dataDir, name, folder, file = 'credentials.json') {
  mkdirSync(join(dataDir, 'profiles', name, folder), { recursive: true });
  writeFileSync(join(dataDir, 'profiles', name, folder, file), JSON.stringify({ token: `tok_${name}_123` }));
}

async function serve(t, dataDir) {
  const server = createDashboardServer({
    dataDir,
    roadmap: { snapshot: () => ({ entries: [], governance: { configured: false, reason: 'Synthetic test.' } }) },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { csrf } = await (await fetch(`${origin}/api/session`, { headers: { origin } })).json();
  assert.ok(csrf, 'CSRF token returned');
  return {
    get: async (path) => (await fetch(`${origin}${path}`, { headers: { origin } })).text(),
    post: (path, body) => fetch(`${origin}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dashboard-csrf': csrf, origin }, body: JSON.stringify(body),
    }),
  };
}

test('dashboard accounts API: list and remove; no route adds, connects, exports or imports a login', async (t) => {
  const { dataDir } = fixture(t);
  login(dataDir, 'work-account', '.claude', '.credentials.json');
  const { get, post } = await serve(t, dataDir);

  const listText = await get('/api/accounts');
  assert.ok(!listText.includes('tok_work-account_123'), 'the list never carries a credential');
  const workAcct = JSON.parse(listText).accounts.find((a) => a.id === 'claude/work-account');
  assert.deepEqual([workAcct?.hasLogin, workAcct?.state], [true, 'ready'], 'work-account is listed with its saved login');

  // Even with a valid CSRF token, which any local process can read from /api/session, these answer 404 and change
  // nothing. The connect routes once copied this computer's own login files into a folder named by the request.
  const refused = [
    ['/api/accounts/add', { provider: 'codex', name: 'team-bot', apiKey: 'sk-test-key' }],
    ['/api/accounts/connect/start', { provider: 'claude', name: 'team-bot', openBrowser: false }],
    ['/api/accounts/connect/check', { provider: 'claude', name: '../escaped', force: true }],
    ['/api/accounts/export', { passphrase: 'safe-password-999' }],
    ['/api/accounts/import', { bundleBase64: Buffer.alloc(64).toString('base64'), passphrase: 'safe-password-999' }],
  ];
  for (const [path, body] of refused) {
    const res = await post(path, body);
    assert.equal(res.status, 404, path);
    assert.ok(!(await res.text()).includes('tok_work-account_123'), `${path} returns no credential`);
  }
  assert.deepEqual(readdirSync(join(dataDir, 'profiles')), ['work-account'], 'nothing was added, connected or imported');
  assert.equal(existsSync(join(dataDir, 'escaped')), false, 'nothing was written outside the profiles folder');

  // A remove names a known provider and a plain account name, or is refused before anything changes.
  for (const body of [{ provider: 'other', name: 'work-account' }, { provider: 'claude', name: '../profiles' }, { provider: 'claude' }]) {
    assert.equal((await post('/api/accounts/remove', body)).status, 400, JSON.stringify(body));
  }
  // Only a login saved on this computer can be removed, and only under its own provider.
  assert.equal((await post('/api/accounts/remove', { provider: 'codex', name: 'work-account' })).status, 404);
  assert.ok(existsSync(join(dataDir, 'profiles', 'work-account')));

  const removeRes = await post('/api/accounts/remove', { provider: 'claude', name: 'work-account' });
  assert.equal(removeRes.status, 200);
  assert.deepEqual(await removeRes.json(), { success: true, account: 'claude/work-account', removed: true });
  assert.ok(!JSON.parse(await get('/api/accounts')).accounts.some((a) => a.id === 'claude/work-account'));
});

test('dashboard accounts API: a login that runs work is kept, and a removed login leaves AIWorks’ records alone', async (t) => {
  const { dataDir } = fixture(t);
  login(dataDir, 'busy-account', '.claude');
  login(dataDir, 'limited-account', '.codex');
  const now = Date.now();
  const store = new Store(join(dataDir, 'supervisor.db'));
  try {
    const open = store.get("SELECT id FROM operations WHERE state IN ('recorded', 'dispatched') LIMIT 1");
    assert.ok(open, 'the full review store has open work');
    store.run('UPDATE operations SET account_identity = ? WHERE id = ?', 'claude/busy-account', open.id);
    store.run(`INSERT INTO provider_waits (account, executor_kind, retry_at, reason, campaign_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      'codex/limited-account', 'codex-cli', now + 42 * M, 'quota: raw worker text 7f3a', 'example-shop-1', now);
    store.run(`INSERT INTO capacity (scope, id, value, reason, updated_at) VALUES ('account', ?, ?, ?, ?)`, 'codex/limited-account', 2, 'synthetic', now);
  } finally { store.close(); }
  const { get, post } = await serve(t, dataDir);

  const listText = await get('/api/accounts');
  const stateText = await get('/api/state');
  for (const [where, text] of [['/api/accounts', listText], ['/api/state', stateText]]) {
    assert.ok(!text.includes('raw worker text'), `${where} never serves the wait reason (OWNER_WORKSPACE §10.1)`);
    assert.ok(!text.includes(JSON.stringify(join(dataDir, 'profiles')).slice(1, -1)), `${where} serves no profile path`);
  }
  const byId = (text, list) => Object.fromEntries(list(JSON.parse(text)).map((a) => [a.id, a]));
  for (const accounts of [byId(listText, (body) => body.accounts), byId(stateText, (body) => body.supervisor.settings.accounts)]) {
    assert.deepEqual([accounts['claude/busy-account'].state, accounts['claude/busy-account'].open], ['in-use', 1]);
    const limited = accounts['codex/limited-account'];
    assert.deepEqual([limited.state, limited.limit, limited.hasLogin], ['usage-limit', 2, true]);
    assert.equal(Date.parse(limited.retryAt), now + 42 * M);
  }

  const busy = await post('/api/accounts/remove', { provider: 'claude', name: 'busy-account' });
  assert.equal(busy.status, 409);
  assert.match((await busy.json()).error, /running work right now/);
  assert.ok(existsSync(join(dataDir, 'profiles', 'busy-account')), 'a login that runs work is kept');

  assert.equal((await post('/api/accounts/remove', { provider: 'codex', name: 'limited-account' })).status, 200);
  assert.equal(existsSync(join(dataDir, 'profiles', 'limited-account')), false);
  const check = new Store(join(dataDir, 'supervisor.db'), { readOnly: true });
  try {
    assert.ok(check.get('SELECT 1 FROM provider_waits WHERE account = ?', 'codex/limited-account'), 'its usage-limit wait stays');
    assert.ok(check.get("SELECT 1 FROM capacity WHERE scope = 'account' AND id = ?", 'codex/limited-account'), 'its learned limit stays');
  } finally { check.close(); }
  const after = byId(await get('/api/accounts'), (body) => body.accounts)['codex/limited-account'];
  assert.deepEqual([after.hasLogin, after.state], [false, 'usage-limit'], 'listed from its records, with no saved login');
});

test('dashboard accounts API: each role’s model order, saved in the shape the supervisor reads', async (t) => {
  const { dataDir } = fixture(t);
  const { get, post } = await serve(t, dataDir);
  const preferences = async () => JSON.parse(await get('/api/accounts/preferences')).preferences;

  assert.deepEqual(await preferences(), { implementer: [], verification: [] }, 'only the roles the supervisor reads');

  const setRes = await post('/api/accounts/preferences', { role: 'implementer', models: ['model-a', 'model-b'] });
  assert.equal(setRes.status, 200);
  assert.deepEqual((await setRes.json()).preferences, ['model-a', 'model-b']);
  assert.equal((await post('/api/accounts/preferences', { role: 'verification', models: ['model-c'], kind: 'codex-cli' })).status, 200);
  const saved = { implementer: ['model-a', 'model-b'], verification: [{ model: 'model-c', kind: 'codex-cli' }] };
  assert.deepEqual(await preferences(), saved, 'saving one role keeps the other');

  // The shapes that once replaced every role, or that dispatch could not read, are refused before anything is written.
  const refusedBodies = [
    { preferences: { implementer: { models: ['model-x'], effort: 'high' } } },
    { role: 'coordinator', models: ['model-x'] },
    { role: 'implementer', models: 'model-x' },
    { role: 'implementer', models: ['../not a model'] },
    { role: 'implementer', models: ['model-x'], kind: 'codex' },
    { role: 'implementer', models: Array.from({ length: 11 }, (_, i) => `model-${i}`) },
  ];
  for (const body of refusedBodies) assert.equal((await post('/api/accounts/preferences', body)).status, 400, JSON.stringify(body));
  assert.deepEqual(await preferences(), saved);

  assert.equal((await post('/api/accounts/preferences', { role: 'implementer', models: [] })).status, 200);
  assert.deepEqual(await preferences(), { implementer: [], verification: saved.verification }, 'an empty list is AIWorks’ own order');

  // What dispatch reads from that config.json (controller.mjs executorChoice and routedChoice).
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  assert.deepEqual(preferenceFor(config, 'verification', { kind: 'codex-cli', model: 'model-c' }), { model: 'model-c', kind: 'codex-cli' });
  assert.equal(preferenceFor(config, 'implementer', { kind: 'claude-cli', model: 'model-a' }), null);
});
