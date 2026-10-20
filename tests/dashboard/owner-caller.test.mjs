// The production dashboard (src/dashboard/main.mjs, as `npm run dashboard` starts it) with its native Windows caller
// lookup: an independent process saves a protected owner setting; a contained AIWorks worker's detached descendant,
// whose parent has exited, is refused and writes nothing, both while its runner.json is still the runner's first
// `{ pid, startedAt }` and once it names the job. Synthetic data directory and runs; no live records.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readJsonIfExists, stopOwnedRun } from '../../src/supervisor/proc.mjs';
import { Store } from '../../src/supervisor/store.mjs';

const main = fileURLToPath(new URL('../../src/dashboard/main.mjs', import.meta.url));
const runnerPath = fileURLToPath(new URL('../../src/supervisor/runner.mjs', import.meta.url));
const node = JSON.stringify(process.execPath);
// A client's answer file, once it is completely written.
const answer = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
// Every row of every table: what a refused request must leave unchanged.
const durable = (path) => {
  const store = new Store(path, { readOnly: true });
  try {
    return Object.fromEntries(store.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map(({ name }) => [name, store.all(`SELECT * FROM "${name}"`)]));
  } finally { store.close(); }
};

async function waitFor(what, predicate) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await sleep(50); }
  assert.fail(`timed out waiting for ${what}`);
}
async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const { port } = probe.address(); probe.close(); await once(probe, 'close');
  return port;
}

test('the production dashboard saves a protected setting from an independent process and refuses a contained worker', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-owner-caller-'));
  const dataDir = join(dir, 'data'), runDir = join(dir, 'run');
  for (const path of [dataDir, runDir]) mkdirSync(path);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerIntervention: { enabled: true } }));
  const dbPath = join(dataDir, 'supervisor.db');
  const store = new Store(dbPath);
  // One open worker run of a synthetic campaign, whose runner reports its pid and job in runner.json.
  store.run(`INSERT INTO operations (id, campaign_id, task_id, kind, seq, idempotency_key, lease_generation, state, session_id, run_dir, workspace,
    packet, packet_digest, created_at, updated_at) VALUES ('op-1', 'example', 'T1', 'implement', 1, 'op-1', 1, 'dispatched', 's', ?, 'w', '{}', 'd', ?, ?)`,
  runDir, Date.now(), Date.now());
  store.close();

  // The client: reads the session's CSRF token like any local process can, asks to save alert rules, writes the answer.
  const client = join(dir, 'client.mjs');
  writeFileSync(client, `import { existsSync, writeFileSync } from 'node:fs';
const [base, out, go] = process.argv.slice(2);
while (go && !existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 25));
const { csrf } = await (await fetch(base + '/api/session')).json();
const response = await fetch(base + '/api/v2/settings/alerts', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf },
  body: JSON.stringify({ requestId: crypto.randomUUID(), version: 0, rules: { classes: { B2: false, B3: false, B4: false, B5: false }, reminders: false, quietHours: null } }) });
writeFileSync(out, JSON.stringify({ status: response.status, body: await response.json() }));
`);
  // Starts the client detached and exits, so the client has no living parent.
  const orphan = (args) => `{ const c = require('child_process').spawn(${node}, ${JSON.stringify([client, ...args])}, { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); }`;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dashboard = spawn(process.execPath, [main, '--data', dataDir, '--port', String(port)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; for (const stream of [dashboard.stdout, dashboard.stderr]) stream.on('data', (data) => { log = (log + data).slice(-4000); });
  const runner = { child: null };
  t.after(async () => {
    writeFileSync(join(runDir, 'done'), '');
    const metadata = readJsonIfExists(join(runDir, 'runner.json'));
    if (runner.child && runner.child.exitCode === null) { if (metadata?.containment) stopOwnedRun(metadata); else runner.child.kill(); }
    dashboard.kill();
    await sleep(200);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await waitFor('the dashboard', () => log.includes('AIWorks dashboard:'));

  // The worker: its root starts an intermediate that starts two clients detached and exits; the root then waits.
  writeFileSync(join(runDir, 'prompt.txt'), 'synthetic prompt');
  const clients = orphan([base, join(runDir, 'early-answer.json'), join(runDir, 'go-early')]) + orphan([base, join(runDir, 'worker-answer.json'), join(runDir, 'go')]);
  writeFileSync(join(runDir, 'worker.mjs'), `import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const middle = spawn(${node}, ['-e', ${JSON.stringify(clients)}], { stdio: 'ignore', windowsHide: true });
middle.on('exit', () => writeFileSync(${JSON.stringify(join(runDir, 'orphaned'))}, ''));
while (!existsSync(${JSON.stringify(join(runDir, 'done'))})) await new Promise((resolve) => setTimeout(resolve, 50));
`);
  writeFileSync(join(runDir, 'spec.json'), JSON.stringify({ argv: [process.execPath, join(runDir, 'worker.mjs')], cwd: runDir, timeoutMs: 120_000, heartbeatMs: 200 }));
  runner.child = spawn(process.execPath, [runnerPath, runDir], { windowsHide: true, stdio: 'ignore' });
  await waitFor('the contained worker', () => readJsonIfExists(join(runDir, 'runner.json'))?.containment === 'windows-job-v1' && existsSync(join(runDir, 'orphaned')));
  const shown = async () => (await (await fetch(`${base}/api/v2/settings/alerts`)).json()).version;

  // runner.json held at the runner's first write, as when its worker starts before the job is recorded: the contained
  // orphan cannot be named, so it is refused and nothing durable changes.
  const identified = readFileSync(join(runDir, 'runner.json'), 'utf8');
  const { pid, startedAt } = JSON.parse(identified);
  writeFileSync(join(runDir, 'runner.json'), JSON.stringify({ pid, startedAt }));
  const before = durable(dbPath);
  writeFileSync(join(runDir, 'go-early'), '');
  const earlyAnswer = await waitFor('the early worker request', () => answer(join(runDir, 'early-answer.json')));
  assert.equal(earlyAnswer.status, 403);
  assert.equal(earlyAnswer.body.code, 'APPROVAL_UNCHECKED', 'a run without its complete identity is never left out');
  assert.deepEqual(durable(dbPath), before, 'nothing durable changed');
  assert.equal(await shown(), 0);

  writeFileSync(join(runDir, 'runner.json'), identified);
  writeFileSync(join(runDir, 'go'), '');
  const workerAnswer = await waitFor('the worker request', () => answer(join(runDir, 'worker-answer.json')));
  assert.equal(workerAnswer.status, 403);
  assert.equal(workerAnswer.body.code, 'APPROVAL_FROM_AIWORKS', 'refused by its job, with its parent gone');
  assert.deepEqual(durable(dbPath), before, 'nothing saved');

  // The owner's independent process, outside every AIWorks run, while the worker run is still open.
  const ownerAnswerPath = join(dir, 'owner-answer.json');
  const starter = spawn(process.execPath, ['-e', orphan([base, ownerAnswerPath])], { windowsHide: true, stdio: 'ignore' });
  await once(starter, 'exit');
  const ownerAnswer = await waitFor('the owner request', () => answer(ownerAnswerPath));
  assert.equal(ownerAnswer.status, 200, JSON.stringify(ownerAnswer.body));
  assert.equal(ownerAnswer.body.version, 1);
  assert.equal(await shown(), 1);
});
