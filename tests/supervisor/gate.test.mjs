// The full-gate helper (src/supervisor/gate.mjs). On 2026-10-14 a verifier's own background gate ended without an exit
// code and the verifier waited on a summary line until its two-hour bound ended the run. These tests run the helper on
// small synthetic gate scripts in a temporary directory: no model, network or GitHub calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = fileURLToPath(new URL('../../src/supervisor/gate.mjs', import.meta.url));
const SCRIPTS = {
  'pass.mjs': "console.log('# start tests/a.test.mjs'); console.log('# all test files'); console.log('# tests 3'); console.log('# pass 3'); console.log('# fail 0');",
  'fail.mjs': "console.log('# all test files'); console.log('# fail 1'); process.exitCode = 3;",
  'slow.mjs': "console.log('# start tests/slow.test.mjs'); setTimeout(() => console.log('# all test files'), 3000);",
  // Ends the helper's gate process from inside, as the gate on 2026-10-14 ended: no exit code is ever recorded.
  'dies.mjs': [
    "import { existsSync, readFileSync } from 'node:fs';",
    "for (let i = 0; i < 200 && !existsSync('gate-pid.log'); i += 1) await new Promise((done) => setTimeout(done, 25));",
    "console.log('# start tests/unlimited.test.mjs');",
    "process.kill(Number(readFileSync('gate-pid.log', 'utf8')));",
  ].join('\n'),
};

function workdir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-gate-'));
  for (const [name, text] of Object.entries(SCRIPTS)) writeFileSync(join(dir, name), text);
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  return dir;
}
const gate = (dir, ...args) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [GATE, ...args], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { code: result.status, out: result.stdout };
};
const waitFast = (dir, ...more) => gate(dir, 'wait', '--poll-seconds', '0.1', ...more);

test('a gate that passes: wait returns its exit code and the final summary block, and every file it wrote is a .log', (t) => {
  const dir = workdir(t);
  const started = gate(dir, 'start', 'node', 'pass.mjs');
  assert.equal(started.code, 0);
  assert.match(started.out, /^started: process \d+ runs node pass\.mjs with its output in gate\.log\. Wait for it with: node ".+gate\.mjs" wait/);
  const done = waitFast(dir);
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /^finished: exit 0\. Final summary from gate\.log:\n# all test files\n# tests 3\n# pass 3\n# fail 0\n$/);
  assert.deepEqual(readdirSync(dir).filter((name) => !(name in SCRIPTS)).sort(), ['gate-exit.log', 'gate-pid.log', 'gate.log']);
});

test('a gate that fails: wait reports its exit code and exits 1', (t) => {
  const dir = workdir(t);
  gate(dir, 'start', 'node', 'fail.mjs');
  const done = waitFast(dir);
  assert.equal(done.code, 1, done.out);
  assert.match(done.out, /^finished: exit 3\./);
});

test('a gate that still runs: wait returns running at its bound, start does not start a second one, and a later wait finishes', (t) => {
  const dir = workdir(t);
  gate(dir, 'start', 'node', 'slow.mjs');
  const early = waitFast(dir, '--minutes', '0.005');
  assert.equal(early.code, 2, early.out);
  assert.match(early.out, /^running: process \d+; gate\.log was last written 0 minute\(s\) ago\. It ends with:\n/);
  assert.match(early.out, /Wait again with: node ".+gate\.mjs" wait\n$/);
  const second = gate(dir, 'start', 'node', 'pass.mjs');
  assert.match(second.out, /^already running: process \d+\./);
  const done = waitFast(dir);
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /# all test files/);
});

test('a gate process that ends without an exit code is reported as died at once, and a new start keeps its log', (t) => {
  const dir = workdir(t);
  gate(dir, 'start', 'node', 'dies.mjs');
  const before = Date.now();
  const died = waitFast(dir);
  assert.equal(died.code, 3, died.out);
  assert.ok(Date.now() - before < 30_000, 'reported within seconds, not at a time bound');
  assert.match(died.out, /^died: process \d+ ended without an exit code, so the gate never finished\. gate\.log ends with:\n# start tests\/unlimited\.test\.mjs\n/);
  assert.match(died.out, /Start it again with: node ".+gate\.mjs" start \(this log is kept as gate-previous\.log\)\.\n$/);
  // Until the dying gate's shell lets go of gate.log, Windows refuses to move it and start says so instead of starting.
  let restarted;
  for (let tries = 0; tries < 40; tries += 1) {
    restarted = gate(dir, 'start', 'node', 'pass.mjs');
    if (!restarted.out.startsWith('not started:')) break;
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 250)']);
  }
  assert.match(restarted.out, /^started:/, restarted.out);
  assert.equal(waitFast(dir).code, 0);
  assert.match(readFileSync(join(dir, 'gate-previous.log'), 'utf8'), /# start tests\/unlimited\.test\.mjs/);
});

test('wait with no gate started says how to start one', (t) => {
  const dir = workdir(t);
  const none = waitFast(dir);
  assert.equal(none.code, 4);
  assert.match(none.out, /^no gate was started in this directory\. Start it with: node ".+gate\.mjs" start\n$/);
});
