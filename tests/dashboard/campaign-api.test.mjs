// The external campaign API (docs/SUPERVISOR.md section 16): `POST /api/campaigns` registers a campaign exactly as
// `cli.mjs start <file>` does, from an HTTP body instead of a private file; `GET /api/campaigns/:id/status` reads it
// exactly as `cli.mjs status <id>` does. Off by default; authenticated by a static bearer token resolved from a
// synthetic credential helper (never the dashboard's own per-process CSRF secret, and that secret is never accepted
// here). No network, no real credential store, no real governance checkout: a disposable git runtime checkout and the
// repository's own synthetic governance fixture only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { Store } from '../../src/supervisor/store.mjs';
import { declaration, GOVERNANCE, runtimeCheckout } from '../supervisor/helpers.mjs';

/** A synthetic credential helper command (release/credential.mjs commandCredentialStore's contract) holding one value. */
function tokenHelper(t, { ref = 'aiworks-campaign-api', value = `synthetic-campaign-token-${randomUUID()}` } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-campaign-token-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vault = join(dir, 'vault.json');
  writeFileSync(vault, JSON.stringify({ [ref]: value }));
  writeFileSync(join(dir, 'helper.mjs'), `import { readFileSync } from 'node:fs';
const [vault, op, name] = process.argv.slice(2);
const value = JSON.parse(readFileSync(vault, 'utf8'))[name];
if (value === undefined) process.exit(1);
if (op === 'get') process.stdout.write(value + '\\n');
process.exit(0);
`);
  return { ref, value, command: [process.execPath, join(dir, 'helper.mjs'), vault] };
}

/** A data directory with an empty but schema-ready store and a config.json pointing at the synthetic governance fixture. */
function fixture(t, { campaignApi } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-campaign-api-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }));
  new Store(join(dataDir, 'supervisor.db')).close();
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ governanceRoot: GOVERNANCE, ...(campaignApi ? { campaignApi } : {}) }));
  return dataDir;
}

async function serve(t, dataDir, { provenanceRoot } = {}) {
  const server = createDashboardServer({ dataDir, provenanceRoot,
    roadmap: { snapshot: () => ({ entries: [], governance: { configured: false, reason: 'Synthetic test.' } }) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { csrf } = await (await fetch(`${origin}/api/session`, { headers: { origin } })).json();
  return {
    csrf,
    post: (path, body, headers = {}) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', origin, ...headers }, body: JSON.stringify(body) }),
    postRaw: (path, body, headers = {}) => fetch(`${origin}${path}`, { method: 'POST', headers: { origin, ...headers }, body }),
    get: (path, headers = {}) => fetch(`${origin}${path}`, { headers: { origin, ...headers } }),
  };
}

test('the campaign API answers 404 while off, even with a well-formed request', async (t) => {
  const dataDir = fixture(t);
  const { post, get } = await serve(t, dataDir);
  const d = declaration({ campaignId: `off-${randomUUID()}` });
  assert.equal((await post('/api/campaigns', d, { authorization: 'Bearer anything' })).status, 404);
  assert.equal((await get(`/api/campaigns/${d.campaignId}/status`, { authorization: 'Bearer anything' })).status, 404);
});

test('registers a campaign exactly as cli.mjs start does, and status reads it back', async (t) => {
  const token = tokenHelper(t);
  const dataDir = fixture(t, { campaignApi: { enabled: true, tokenRef: token.ref, credentialStore: { kind: 'command', command: token.command } } });
  const runtime = runtimeCheckout();
  t.after(() => runtime.cleanup());
  const { post, get, csrf } = await serve(t, dataDir, { provenanceRoot: runtime.root });
  const auth = { authorization: `Bearer ${token.value}` };
  const d = declaration({ campaignId: `remote-${randomUUID()}` });

  // No token, a wrong token, and the dashboard's own browser-session CSRF secret are all refused the same way: this
  // surface and the browser surface share no secret.
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { 'x-dashboard-csrf': csrf }]) {
    const res = await post('/api/campaigns', d, headers);
    assert.equal(res.status, 401, JSON.stringify(headers));
  }
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { 'x-dashboard-csrf': csrf }]) {
    assert.equal((await get(`/api/campaigns/${d.campaignId}/status`, headers)).status, 401, JSON.stringify(headers));
  }

  const created = await post('/api/campaigns', d, auth);
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.campaignId, d.campaignId);
  assert.equal(createdBody.control, 'registered');
  assert.equal(createdBody.tasks.length, d.tasks.length);

  // An identical resend is never refused (api.mjs campaignStart), and is not a second creation.
  const resent = await post('/api/campaigns', d, auth);
  assert.equal(resent.status, 200);
  assert.equal((await resent.json()).campaignId, d.campaignId);

  const status = await get(`/api/campaigns/${d.campaignId}/status`, auth);
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.campaignId, d.campaignId);
  assert.equal(statusBody.control, 'registered');

  assert.equal((await get(`/api/campaigns/${randomUUID()}/status`, auth)).status, 404, 'an unregistered id is a plain 404');
});

test('refuses unmerged runtime code and an unregistered target, without registering anything', async (t) => {
  const token = tokenHelper(t);
  const dataDir = fixture(t, { campaignApi: { enabled: true, tokenRef: token.ref, credentialStore: { kind: 'command', command: token.command } } });
  const unmerged = runtimeCheckout({ unmerged: true });
  const merged = runtimeCheckout();
  t.after(() => { unmerged.cleanup(); merged.cleanup(); });
  const auth = { authorization: `Bearer ${token.value}` };

  const offRuntime = await serve(t, dataDir, { provenanceRoot: unmerged.root });
  const res = await offRuntime.post('/api/campaigns', declaration({ campaignId: `unmerged-${randomUUID()}` }), auth);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'RUNTIME_NOT_MERGED');

  const { post } = await serve(t, dataDir, { provenanceRoot: merged.root });
  const notRegistered = declaration({ campaignId: `not-registered-${randomUUID()}` });
  notRegistered.target = { ...notRegistered.target, repository: 'example-org/never-registered' };
  const refused = await post('/api/campaigns', notRegistered, auth);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /not a registered project/);

  const store = new Store(join(dataDir, 'supervisor.db'), { readOnly: true });
  try { assert.equal(store.campaign(notRegistered.campaignId), null); } finally { store.close(); }
});

test('rejects an oversized, non-JSON or malformed body before touching the store', async (t) => {
  const token = tokenHelper(t);
  const dataDir = fixture(t, { campaignApi: { enabled: true, tokenRef: token.ref, credentialStore: { kind: 'command', command: token.command } } });
  const runtime = runtimeCheckout();
  t.after(() => runtime.cleanup());
  const { postRaw } = await serve(t, dataDir, { provenanceRoot: runtime.root });
  const auth = { authorization: `Bearer ${token.value}` };

  assert.equal((await postRaw('/api/campaigns', 'not json', { ...auth, 'content-type': 'text/plain' })).status, 415);
  assert.equal((await postRaw('/api/campaigns', 'not json', { ...auth, 'content-type': 'application/json' })).status, 400);
  const big = JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) });
  assert.equal((await postRaw('/api/campaigns', big, { ...auth, 'content-type': 'application/json' })).status, 413);
});
