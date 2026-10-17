import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { buildReviewFixture } from './fixtures/review-store.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-accounts-api-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return buildReviewFixture(root);
}

test('dashboard accounts API: list, export, import, and remove with CSRF protection', async (t) => {
  const { dataDir, root } = fixture(t);
  const profilesDir = join(dataDir, 'profiles');
  mkdirSync(join(profilesDir, 'work-account', '.claude'), { recursive: true });
  writeFileSync(join(profilesDir, 'work-account', '.claude', 'config.json'), JSON.stringify({ token: 'tok_claude_123' }));

  const server = createDashboardServer({
    dataDir,
    roadmap: { snapshot: () => ({ entries: [], governance: { configured: false, reason: 'Synthetic test.' } }) },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const origin = `http://127.0.0.1:${server.address().port}`;

  // 1. GET /api/session to obtain CSRF token
  const sessionRes = await fetch(`${origin}/api/session`, { headers: { origin } });
  assert.equal(sessionRes.status, 200);
  const { csrf } = await sessionRes.json();
  assert.ok(csrf, 'CSRF token returned');

  // 2. GET /api/accounts
  const listRes = await fetch(`${origin}/api/accounts`, { headers: { origin } });
  assert.equal(listRes.status, 200);
  const { accounts } = await listRes.json();
  assert.ok(Array.isArray(accounts));
  const workAcct = accounts.find((a) => a.id === 'claude/work-account');
  assert.ok(workAcct, 'work-account is listed in accounts');
  assert.equal(workAcct.provider, 'claude');
  assert.ok(workAcct.usage);

  // 2b. POST /api/accounts/add
  const addRes = await fetch(`${origin}/api/accounts/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dashboard-csrf': csrf, origin },
    body: JSON.stringify({ provider: 'codex', name: 'team-bot', apiKey: 'sk-test-key' }),
  });
  assert.equal(addRes.status, 200);
  const addBody = await addRes.json();
  assert.equal(addBody.success, true);
  assert.equal(addBody.account, 'codex/team-bot');

  const listAfterAdd = await fetch(`${origin}/api/accounts`, { headers: { origin } });
  const { accounts: acctsAfterAdd } = await listAfterAdd.json();
  assert.ok(acctsAfterAdd.some((a) => a.id === 'codex/team-bot'));

  // 3. POST /api/accounts/export without passphrase -> 400
  const exportNoPass = await fetch(`${origin}/api/accounts/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dashboard-csrf': csrf, origin },
    body: JSON.stringify({}),
  });
  assert.equal(exportNoPass.status, 400);

  // 4. POST /api/accounts/export with valid passphrase -> bundle returned
  const exportRes = await fetch(`${origin}/api/accounts/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dashboard-csrf': csrf, origin },
    body: JSON.stringify({ passphrase: 'safe-password-999' }),
  });
  assert.equal(exportRes.status, 200);
  const exportBody = await exportRes.json();
  assert.equal(exportBody.success, true);
  assert.ok(exportBody.bundleBase64);

  // 5. POST /api/accounts/remove
  const removeRes = await fetch(`${origin}/api/accounts/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dashboard-csrf': csrf, origin },
    body: JSON.stringify({ provider: 'claude', name: 'work-account' }),
  });
  assert.equal(removeRes.status, 200);
  const removeBody = await removeRes.json();
  assert.equal(removeBody.success, true);
  assert.equal(removeBody.pathRemoved, true);

  // Verify removed from GET /api/accounts
  const listAfterRemove = await fetch(`${origin}/api/accounts`, { headers: { origin } });
  const { accounts: accountsAfterRemove } = await listAfterRemove.json();
  assert.ok(!accountsAfterRemove.some((a) => a.id === 'claude/work-account'));

  // 6. POST /api/accounts/import with wrong passphrase -> 400
  const importWrongPass = await fetch(`${origin}/api/accounts/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dashboard-csrf': csrf, origin },
    body: JSON.stringify({ bundleBase64: exportBody.bundleBase64, passphrase: 'wrong-passphrase' }),
  });
  assert.equal(importWrongPass.status, 400);

  // 7. POST /api/accounts/import with correct passphrase -> success
  const importRes = await fetch(`${origin}/api/accounts/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dashboard-csrf': csrf, origin },
    body: JSON.stringify({ bundleBase64: exportBody.bundleBase64, passphrase: 'safe-password-999' }),
  });
  assert.equal(importRes.status, 200);
  const importBody = await importRes.json();
  assert.equal(importBody.success, true);
  assert.ok(importBody.imported.includes('claude/work-account'));

  // Verify restored
  const listAfterImport = await fetch(`${origin}/api/accounts`, { headers: { origin } });
  const { accounts: accountsAfterImport } = await listAfterImport.json();
  assert.ok(accountsAfterImport.some((a) => a.id === 'claude/work-account'));
});
