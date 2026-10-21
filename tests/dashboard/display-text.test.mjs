import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DisplayTextChecks } from '../../src/dashboard/display-text.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { Store } from '../../src/supervisor/store.mjs';
import { createItem, addComment } from '../../src/supervisor/work-list.mjs';
import { safeText } from '../../src/dashboard/roadmap.mjs';

if (process.argv.includes('--probe')) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-display-text-'));
  const checks = new DisplayTextChecks();
  let server;
  const blocked = 'a:?a=a:#'.repeat(25000);
  try {
    writeFileSync(join(dir, 'config.json'), '{}');
    const store = new Store(join(dir, 'supervisor.db'));
    createItem(store, { kind: 'note', title: 'Synthetic imported report', body: '', authorKind: 'owner', now: 1 });
    // Existing imported text must be safe to read even if a former writer admitted it.
    store.run('UPDATE work_items SET body=? WHERE number=1', blocked);
    const medium = 'a:?a=a:#'.repeat(499);
    for (let i = 0; i < 200; i++) addComment(store, {
      number: 1, idempotencyKey: `synthetic-${i}`, body: medium, authorKind: 'owner', now: 1,
    });
    createItem(store, { kind: 'note', title: 'Synthetic repeated short reports', body: '', authorKind: 'owner', now: 1 });
    const shorter = 'a:?a=a:#'.repeat(128);
    for (let i = 0; i < 200; i++) addComment(store, {
      number: 2, idempotencyKey: `synthetic-${i}`, body: shorter, authorKind: 'owner', now: 1,
    });
    store.close();
    server = createDashboardServer({ dataDir: dir, roadmap: { snapshot: () => ({ entries: [] }) } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const start = performance.now();
    const shown = await (await fetch(`${base}/api/v2/worklist/1`)).json();
    assert.notEqual(shown.body, blocked);
    assert.equal(shown.comments.length, 200);
    assert(shown.comments.every(comment => comment.body !== medium));
    const shortShown = await (await fetch(`${base}/api/v2/worklist/2`)).json();
    assert.equal(shortShown.comments.length, 200);
    assert(shortShown.comments.every(comment => comment.body !== shorter));
    assert.equal((await fetch(`${base}/api/session`)).status, 200);
    assert.ok(performance.now() - start < 2000, 'large untrusted text blocked owner requests');
    await new Promise(resolve => server.close(resolve));
    server = null;

    const clean = 'a'.repeat(61000);
    const sensitive = clean + ' https://example.test/?api_key=synthetic';
    const bodies = [blocked, clean, sensitive, ...Array.from({ length: 25 }, (_, i) => 'ordinary '.repeat(600) + i)];
    for (const body of bodies) {
      const first = checks.read(body, 200000);
      assert.equal(first.state, 'checking');
      assert.notEqual(first.text, body, 'unchecked content escaped');
    }
    const tick = performance.now();
    await delay(30);
    assert.ok(performance.now() - tick < 1000, 'classifier ran on the owner event loop');
    const deadline = Date.now() + 12000;
    while (bodies.some(body => checks.read(body, 200000).state === 'checking') && Date.now() < deadline) await delay(50);
    assert.equal(checks.read(blocked, 200000).state, 'unavailable');
    assert.deepEqual(checks.read(clean, 200000), { state: 'ready', text: clean });
    assert.deepEqual(checks.read(sensitive, 200000), { state: 'ready', text: safeText(sensitive, 200000) });
    for (const body of bodies.slice(3)) assert.deepEqual(checks.read(body, 200000), { state: 'ready', text: body });
    const receipt = checks.read(blocked, 200000);
    await delay(60);
    assert.deepEqual(checks.read(blocked, 200000), receipt, 'polling restarted a failed check');
    const changed = clean + ' changed';
    assert.equal(checks.read(changed, 200000).state, 'checking', 'a different body reused an old result');
    await checks.close();
    assert.equal(checks.read(changed, 200000).state, 'unavailable');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await checks.close();
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  test('large display text cannot block owner requests or bypass content checks', () => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--probe'], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
    });
    assert.equal(child.error, undefined, 'the display boundary failed to reclaim its work');
    assert.equal(child.status, 0, child.stderr);
  });
}
