// OWNER_UI_V2 WP5: the project settings route. A program AIWorks started, another origin or a stale page cannot change a
// project's protected areas or raise its budget; the owner's save applies exactly one new version and says which.
// Synthetic store and a fictional repository, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';

const REPOSITORY = 'example-org/sampleapp';
const roadmap = { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) };
const lookupAs = (ancestors) => async () => ({ pid: 999_991, ancestors, jobs: [] });
const OWNER = { platform: 'win32', lookup: lookupAs([999_990]) };
const WORKER = { platform: 'win32', lookup: lookupAs([process.pid]) };

test('only the owner, from the version shown, changes a project’s protected areas or repair limit', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-dashboard-settings-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ repositories: { [REPOSITORY]: { path: 'unused' } } }));
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
    return { send: (body, headers = {}) => fetch(`${base}/api/v2/projects/settings`, { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf, ...headers }, body: JSON.stringify(body) }),
    read: async () => (await fetch(`${base}/api/v2/projects/${encodeURIComponent(REPOSITORY)}/settings`)).json() };
  };
  const owner = await serve(OWNER), worker = await serve(WORKER);
  const change = (version, maxRepairRounds = 1) => ({ requestId: randomUUID(), project: REPOSITORY, version, protectedAreas: ['config/production.json'],
    notes: 'Keep changes small.', limits: { maxRepairRounds } });

  const refused = async (response, status, code) => { assert.equal(response.status, status); if (code) assert.equal((await response.json()).code, code); };
  await refused(await worker.send(change(0)), 403, 'APPROVAL_FROM_AIWORKS');
  await refused(await owner.send(change(0), { Origin: 'http://127.0.0.1:1' }), 403);
  assert.equal((await owner.read()).version, 0, 'nothing saved');

  const saved = await owner.send(change(0));
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.deepEqual([body.version, body.view.version, body.view.settings.limits.maxRepairRounds], [1, 1, 1]);
  // A page still showing version 0 cannot raise the repair limit over the version saved since.
  await refused(await owner.send(change(0, 5)), 409, 'SETTINGS_CHANGED');
  const shown = await owner.read();
  assert.deepEqual([shown.version, shown.settings.limits.maxRepairRounds, shown.settings.protectedAreas], [1, 1, ['config/production.json']]);
});
