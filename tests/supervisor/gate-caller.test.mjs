// Standalone gate commands are AIWorks processes even when no campaign operation names them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { GateSlotStore } from '../../src/supervisor/gate-slot.mjs';
import { gateTestEnv, useGateTestHost } from './fixtures/gate-host-bootstrap.mjs';

const GATE = fileURLToPath(new URL('../../src/supervisor/gate.mjs', import.meta.url));

test('a standalone gate descendant cannot authorize owner actions and uncertain gate custody fails closed',
  { skip: process.platform !== 'win32' ? 'Windows Job Object custody and native caller lookup' : false, timeout: 90_000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'aiworks-gate-caller-')), host = join(root, 'host'), cwd = join(root, 'command');
    mkdirSync(cwd); useGateTestHost(host);
    const { Store } = await import('../../src/supervisor/store.mjs');
    const { checkCaller } = await import('../../src/supervisor/local-admission.mjs');
    const { windowsCallerLookup } = await import('../../src/supervisor/caller-lookup.mjs');
    const { stopOwnedRunAsync } = await import('../../src/supervisor/proc.mjs');
    const store = new Store(join(root, 'supervisor.db')), slots = new GateSlotStore(host);
    const server = createServer(); let socket = null, passed = false;
    t.after(async () => {
      writeFileSync(join(cwd, 'release.log'), '');
      const deadline = Date.now() + 30_000;
      while (!existsSync(join(cwd, 'gate-exit.log')) && Date.now() < deadline) await sleep(50);
      const owner = slots.owner();
      if (owner?.attached) await stopOwnedRunAsync({ ...owner, containment: 'windows-job-v1' });
      socket?.destroy(); server.close(); slots.close(); store.close();
      if (passed) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      else t.diagnostic(`Synthetic caller evidence retained in ${root}`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const connected = once(server, 'connection');
    writeFileSync(join(cwd, 'peer.mjs'), [
      "import {connect} from 'node:net';",
      "import {existsSync} from 'node:fs';",
      "import {setTimeout as sleep} from 'node:timers/promises';",
      `const socket=connect(${server.address().port},'127.0.0.1'); socket.on('error',()=>{});`,
      "while(!existsSync('release.log')) await sleep(50);",
      "socket.end(); console.log('# all test files\\n# tests 1\\n# pass 1\\n# fail 0');",
    ].join('\n'));
    const started = spawnSync(process.execPath, [GATE, 'start', `"${process.execPath}"`, 'peer.mjs'],
      { cwd, env: gateTestEnv(host), encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    [socket] = await Promise.race([connected, sleep(30_000).then(() => { throw new Error('gate peer did not connect'); })]);
    socket.on('error', () => {});
    assert.equal(store.get('SELECT COUNT(*) AS n FROM operations').n, 0);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM coordinator_runs').n, 0);
    const owner = slots.owner();
    assert.equal(owner.attached, true);
    let nativeChecked = false;
    const options = { connection: socket, aiworksPids: [], platform: 'win32', lookup: async (connection, custody) => {
      assert.ok(custody.jobNames.includes(owner.jobName), 'standalone gate custody is included without an ordinary run');
      const found = await windowsCallerLookup(connection, custody);
      assert.ok(found.jobs.includes(owner.jobName), 'native lookup confirms actual Global job membership');
      nativeChecked = true; return found;
    } };
    await assert.rejects(checkCaller(store, options), { code: 'APPROVAL_FROM_AIWORKS' });
    assert.equal(nativeChecked, true);
    const original = slots.db.prepare('SELECT * FROM slot WHERE id=1').get();
    for (const damage of ['missing-row', 'missing-owner', 'malformed-custody', 'missing-identity']) {
      try {
        if (damage === 'missing-row') slots.db.prepare('DELETE FROM slot WHERE id=1').run();
        else if (damage === 'missing-owner') slots.db.prepare('UPDATE slot SET owner=NULL WHERE id=1').run();
        else slots.db.prepare('UPDATE slot SET owner=? WHERE id=1').run(damage === 'malformed-custody' ? '{ invalid' : JSON.stringify({ ...owner, creationTime: null }));
        await assert.rejects(checkCaller(store, { ...options, lookup: async () => ({ pid: 999991, ancestors: [], jobs: [] }) }),
          { code: 'APPROVAL_UNCHECKED' }, damage);
      } finally {
        slots.db.prepare('INSERT OR REPLACE INTO slot(id,generation,owner) VALUES (1,?,?)').run(original.generation, original.owner);
      }
    }
    writeFileSync(join(cwd, 'release.log'), '');
    const deadline = Date.now() + 30_000;
    while (!existsSync(join(cwd, 'gate-exit.log')) && Date.now() < deadline) await sleep(50);
    assert.equal(readFileSync(join(cwd, 'gate-exit.log'), 'utf8').trim(), '0');
    passed = true;
  });
