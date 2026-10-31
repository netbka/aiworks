// The Docker gate is the one machine-wide limit on Docker stacks (host crash of 2026-10-31). A fake engine on a named
// pipe stands in for Docker; nothing real is started.
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDockerGate } from '../../src/supervisor/docker-gate.mjs';

const listen = (server, path) => new Promise((done) => server.listen(path, done));
const call = (socketPath, method, path) => new Promise((done, fail) => {
  const req = http.request({ socketPath, method, path }, (res) => { res.resume(); res.on('end', () => done(res.statusCode)); });
  req.on('error', fail);
  req.end();
});

test('container starts beyond the slots wait until a stack stops; agents and other requests are never held', { skip: process.platform !== 'win32' }, async (t) => {
  const id = randomUUID();
  const enginePipe = `\\\\.\\pipe\\aiworks-test-engine-${id}`, gatePipe = `\\\\.\\pipe\\aiworks-test-gate-${id}`;
  // Containers: a1, a2 of project a; b1 of project b; c1 of project c. `running` is what the engine reports as running.
  const project = { a1: 'a', a2: 'a', b1: 'b', c1: 'c' };
  const running = new Set();
  const engine = http.createServer((req, res) => {
    const start = /^\/v1\.51\/containers\/(\w+)\/start$/.exec(req.url);
    const inspect = /^\/containers\/(\w+)\/json$/.exec(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/containers/json') res.end(JSON.stringify([...running].map((name) => ({ Id: name, Labels: { 'com.docker.compose.project': project[name] } }))));
    else if (inspect) res.end(JSON.stringify({ Id: inspect[1], Config: { Labels: { 'com.docker.compose.project': project[inspect[1]] } } }));
    else if (start) { running.add(start[1]); res.statusCode = 204; res.end(); }
    else res.end('{}');
  });
  const gate = createDockerGate({ engine: enginePipe, slots: 2, pollMs: 20, graceMs: 60_000 });
  await listen(engine, enginePipe);
  await listen(gate.server, gatePipe);
  t.after(() => { gate.server.close(); engine.close(); });

  assert.equal(await call(gatePipe, 'POST', '/v1.51/containers/a1/start'), 204);
  assert.equal(await call(gatePipe, 'POST', '/v1.51/containers/a2/start'), 204, 'a second container of a running project takes no new slot');
  assert.equal(await call(gatePipe, 'POST', '/v1.51/containers/b1/start'), 204, 'the second slot');
  let third = null;
  const waiting = call(gatePipe, 'POST', '/v1.51/containers/c1/start').then((status) => { third = status; });
  await sleep(200);
  assert.equal(third, null, 'a third project waits while two run');
  assert.equal(running.has('c1'), false, 'and the engine never saw its start');
  assert.equal(await call(gatePipe, 'GET', '/v1.51/containers/json'), 200, 'other requests pass while a start waits');
  running.delete('b1');
  await waiting;
  assert.equal(third, 204, 'it starts once a stack stopped');
  assert.equal(running.has('c1'), true);
});
