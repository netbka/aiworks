import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { buildReviewFixture } from './fixtures/review-store.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-accounts-api-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return buildReviewFixture(root);
}

test('dashboard accounts API: list and remove; no route adds, exports or imports a login', async (t) => {
  const { dataDir } = fixture(t);
  const profilesDir = join(dataDir, 'profiles');
  mkdirSync(join(profilesDir, 'work-account', '.claude'), { recursive: true });
  writeFileSync(join(profilesDir, 'work-account', '.claude', '.credentials.json'), JSON.stringify({ token: 'tok_claude_123' }));

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
  const post = (path, body) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dashboard-csrf': csrf, origin }, body: JSON.stringify(body),
  });

  const listRes = await fetch(`${origin}/api/accounts`, { headers: { origin } });
  assert.equal(listRes.status, 200);
  const listText = await listRes.text();
  assert.ok(!listText.includes('tok_claude_123'), 'the list never carries a credential');
  const workAcct = JSON.parse(listText).accounts.find((a) => a.id === 'claude/work-account');
  assert.ok(workAcct?.usage, 'work-account is listed with its usage');

  // Even with a valid CSRF token, which any local process can read from /api/session, these answer 404 and change nothing.
  const refused = [
    ['/api/accounts/add', { provider: 'codex', name: 'team-bot', apiKey: 'sk-test-key' }],
    ['/api/accounts/export', { passphrase: 'safe-password-999' }],
    ['/api/accounts/import', { bundleBase64: Buffer.alloc(64).toString('base64'), passphrase: 'safe-password-999' }],
  ];
  for (const [path, body] of refused) {
    const res = await post(path, body);
    assert.equal(res.status, 404, path);
    assert.ok(!(await res.text()).includes('tok_claude_123'), `${path} returns no credential`);
  }
  assert.deepEqual(readdirSync(profilesDir), ['work-account'], 'nothing was added or imported');

  // A remove names a known provider and a plain account name, or is refused before anything changes.
  for (const body of [{ provider: 'other', name: 'work-account' }, { provider: 'claude', name: '../profiles' }, { provider: 'claude' }]) {
    assert.equal((await post('/api/accounts/remove', body)).status, 400, JSON.stringify(body));
  }
  assert.ok(existsSync(join(profilesDir, 'work-account')));

  const removeRes = await post('/api/accounts/remove', { provider: 'claude', name: 'work-account' });
  assert.equal(removeRes.status, 200);
  const removeBody = await removeRes.json();
  assert.equal(removeBody.success, true);
  assert.equal(removeBody.pathRemoved, true);
  const { accounts: afterRemove } = await (await fetch(`${origin}/api/accounts`, { headers: { origin } })).json();
  assert.ok(!afterRemove.some((a) => a.id === 'claude/work-account'));
});
