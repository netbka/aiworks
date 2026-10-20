// The dashboard caller check's native Windows lookup (caller-lookup.mjs) on real loopback connections: it names the
// exact peer process and fails closed on an unknown endpoint or a job it cannot see while its runner lives.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { windowsCallerLookup } from '../../src/supervisor/caller-lookup.mjs';
import { processCreationTime } from '../../src/supervisor/proc.mjs';

const UNSEEN_JOB = 'Local\\aiworks-supervisor-00000000-0000-4000-8000-000000000000';

test('the caller lookup names the exact loopback peer and fails closed when it cannot tell', { skip: process.platform !== 'win32' }, async (t) => {
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const accepted = once(server, 'connection');
  // A peer whose parent has exited, as an owner's browser started from the desktop has no AIWorks process above it.
  const peerCode = `require('net').connect(${server.address().port}, '127.0.0.1'); setTimeout(() => {}, 60000);`;
  const starter = spawn(process.execPath, ['-e', `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(peerCode)}],
    { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); console.log(c.pid);`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = ''; starter.stdout.on('data', (data) => { out += data; });
  await once(starter, 'exit');
  const peerPid = Number(out.trim());
  const [socket] = await accepted;
  socket.on('error', () => { /* the peer is killed at the end */ });
  t.after(() => { socket.destroy(); try { process.kill(peerPid); } catch { /* already gone */ } server.close(); });

  const found = await windowsCallerLookup(socket);
  assert.equal(found.pid, peerPid, 'the client end of this exact connection');
  assert.deepEqual(found.jobs, []);
  assert.ok(!found.ancestors.includes(process.pid));

  // The same server end with a client port no connection has.
  const unknown = { remoteAddress: '127.0.0.1', remotePort: socket.remotePort === 1 ? 2 : 1, localAddress: socket.localAddress, localPort: socket.localPort };
  await assert.rejects(windowsCallerLookup(unknown), { code: 'LOOKUP_REFUSED' });
  // A job this process cannot open, while its runner (here this live process) still runs: refused, never "not in it".
  const creationTime = await processCreationTime(process.pid);
  await assert.rejects(windowsCallerLookup(socket, { jobNames: [UNSEEN_JOB], runners: [{ jobName: UNSEEN_JOB, pid: process.pid, creationTime }] }),
    { code: 'LOOKUP_REFUSED' });
  // An address outside IPv4 loopback is never looked up.
  await assert.rejects(windowsCallerLookup({ ...unknown, remoteAddress: '::1' }), { code: 'LOOKUP_ENDPOINT' });
});
