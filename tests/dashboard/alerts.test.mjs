// OWNER_UI_V2 WP6: Settings -> Alerts. A program AIWorks started, another origin or a stale page cannot mute the owner's
// alerts; the page says delivery is unavailable until a transport is set up and never serves a secret store reference.
// Synthetic store and fictional configuration, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';

const roadmap = { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) };
const lookupAs = (ancestors) => async () => ({ pid: 999_991, ancestors, jobs: [] });
const OWNER = { platform: 'win32', lookup: lookupAs([999_990]) };
const WORKER = { platform: 'win32', lookup: lookupAs([process.pid]) };
const SECRET_REF = 'vault:alerts/relay-key';

test('only the owner, from the version shown, changes alert rules; delivery reads unavailable and no secret reference is served', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-dashboard-alerts-'));
  const config = (transport) => writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerIntervention: { enabled: true }, ...(transport ? { alerts: { transport } } : {}) }));
  config(null);
  new Store(join(dataDir, 'supervisor.db')).close();
  const servers = [];
  t.after(async () => {
    for (const server of servers) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    rmSync(dataDir, { recursive: true, force: true });
  });
  const serve = async (callerCheck) => {
    const server = createDashboardServer({ dataDir, roadmap, callerCheck });
    servers.push(server);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
    return { send: (body, headers = {}) => fetch(`${base}/api/v2/settings/alerts`, { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf, ...headers }, body: JSON.stringify(body) }),
    read: async () => (await fetch(`${base}/api/v2/settings/alerts`)).text() };
  };
  const owner = await serve(OWNER), worker = await serve(WORKER);
  const mute = (version) => ({ requestId: randomUUID(), version, rules: { classes: { B2: false, B3: false, B4: false, B5: false }, reminders: false, quietHours: null } });

  const shown = JSON.parse(await owner.read());
  assert.equal(shown.delivery.transport, 'unconfigured');
  const refused = async (response, status, code) => { assert.equal(response.status, status); if (code) assert.equal((await response.json()).code, code); };
  await refused(await worker.send(mute(0)), 403, 'APPROVAL_FROM_AIWORKS');
  await refused(await owner.send(mute(0), { Origin: 'http://127.0.0.1:1' }), 403);
  assert.equal(JSON.parse(await owner.read()).version, 0, 'nothing saved');

  const saved = await owner.send({ ...mute(0), rules: { ...mute(0).rules, classes: { B2: true, B3: true, B4: false, B5: true } } });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).version, 1);
  // A page still showing version 0 cannot mute the alerts saved since.
  await refused(await owner.send(mute(0)), 409, 'ALERTS_CHANGED');
  assert.equal(JSON.parse(await owner.read()).rules.classes.B3, true);

  // A transport kind without an adapter stays unavailable, and its secret store reference is never served.
  config({ kind: 'chat-relay', secretRef: SECRET_REF });
  const text = await owner.read();
  assert.equal(JSON.parse(text).delivery.transport, 'unavailable');
  assert.ok(!text.includes(SECRET_REF));
});
