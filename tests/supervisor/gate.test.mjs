// The full-gate helper (src/supervisor/gate.mjs). On 2026-10-14 a verifier's own background gate ended without an exit
// code and the verifier waited on a summary line until its two-hour bound ended the run. These tests run the helper on
// small synthetic gate scripts in a temporary directory: no model, network or GitHub calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// Each test's gates take slots in its own directory, never the PC's, and not as a gate nested in the suite's own gate.
const gateIn = (dir, extra, ...args) => {
  const env = { ...process.env, AIWORKS_GATE_SLOTS_DIR: join(dir, 'slots'), ...extra };
  delete env.NODE_TEST_CONTEXT;
  if (!extra.AIWORKS_GATE_SLOT_HELD) delete env.AIWORKS_GATE_SLOT_HELD;
  const result = spawnSync(process.execPath, [GATE, ...args], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { code: result.status, out: result.stdout };
};
const gate = (dir, ...args) => gateIn(dir, {}, ...args);

test('a project without check uses its explicit gate; a missing command cannot leave stale passing evidence', (t) => {
  const dir = workdir(t);
  assert.equal(gate(dir, 'start', 'node', 'pass.mjs').code, 0);
  assert.equal(gate(dir, 'wait', '--minutes', '0.2', '--poll-seconds', '0.1').code, 0);
  assert.equal(gate(dir, 'start').code, 1);
  assert.notEqual(readFileSync(join(dir, 'gate-exit.log'), 'utf8').trim(), '0');
  assert.equal(gate(dir, 'wait', '--minutes', '0.2', '--poll-seconds', '0.1').code, 1);
  assert.equal(gate(dir, 'start', 'node', 'fail.mjs').code, 0);
  assert.equal(gate(dir, 'wait', '--minutes', '0.2', '--poll-seconds', '0.1').code, 1);
});
const waitFast = (dir, ...more) => gate(dir, 'wait', '--poll-seconds', '0.1', ...more);
const ended = () => spawnSync(process.execPath, ['-e', '']).pid;

test('a gate that passes: wait returns its exit code and the final summary block, and every file it wrote is a .log', (t) => {
  const dir = workdir(t);
  const started = gate(dir, 'start', 'node', 'pass.mjs');
  assert.equal(started.code, 0);
  assert.match(started.out, /^started: process \d+ runs node pass\.mjs with its output in gate\.log\. Wait for it with: node ".+gate\.mjs" wait/);
  const done = waitFast(dir);
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /^finished: exit 0\. Final summary from gate\.log:\n# all test files\n# tests 3\n# pass 3\n# fail 0\n$/);
  assert.deepEqual(readdirSync(dir).filter((name) => !(name in SCRIPTS)).sort(), ['gate-exit.log', 'gate-pid.log', 'gate.log', 'slots']);
  assert.deepEqual(readdirSync(join(dir, 'slots')), [], 'the slot is given back when the gate ends');
});

test('gate slots: a gate waits while every slot is held, says so in gate.log, and starts once one is free', (t) => {
  const dir = workdir(t);
  mkdirSync(join(dir, 'slots'));
  const lock = join(dir, 'slots', 'slot-1.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), cwd: 'elsewhere' }));
  assert.equal(gateIn(dir, { AIWORKS_GATE_SLOTS: '1' }, 'start', 'node', 'pass.mjs').code, 0);
  const queued = waitFast(dir, '--minutes', '0.01');
  assert.equal(queued.code, 2, queued.out);
  assert.match(queued.out, /# waiting for a free gate slot: 1 full gate\(s\) already run on this PC/);
  assert.doesNotMatch(readFileSync(join(dir, 'gate.log'), 'utf8'), /# all test files/, 'the command has not started');
  rmSync(lock);
  const done = waitFast(dir);
  assert.equal(done.code, 0, done.out);
  assert.match(readFileSync(join(dir, 'gate.log'), 'utf8'), /# gate slot .+slot-1\.lock taken; the gate starts now\n# start tests\/a\.test\.mjs/);
  assert.deepEqual(readdirSync(join(dir, 'slots')), []);
});

test('gate slots: a gate inside a gate (the suite testing the gate helper) takes no slot', (t) => {
  const dir = workdir(t);
  mkdirSync(join(dir, 'slots'));
  writeFileSync(join(dir, 'slots', 'slot-1.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  gateIn(dir, { AIWORKS_GATE_SLOTS: '1', AIWORKS_GATE_SLOT_HELD: '1' }, 'start', 'node', 'pass.mjs');
  const done = waitFast(dir, '--minutes', '0.5');
  assert.equal(done.code, 0, done.out);
  assert.doesNotMatch(readFileSync(join(dir, 'gate.log'), 'utf8'), /gate slot/);
});

test('gate slots: takeSlot takes a free slot or one whose process ended, is too old or was left empty, never a held one', async (t) => {
  const { slotSettings, takeSlot } = await import('../../src/supervisor/gate.mjs');
  const dir = join(workdir(t), 'slots');
  const now = Date.now();
  const lock = (i, holder) => writeFileSync(join(dir, `slot-${i}.lock`), holder === '' ? '' : JSON.stringify(holder));
  assert.equal(takeSlot({ count: 2, dir }, now), join(dir, 'slot-1.lock'));
  assert.equal(takeSlot({ count: 2, dir }, now), join(dir, 'slot-2.lock'));
  assert.equal(takeSlot({ count: 2, dir }, now), null, 'both held by this live process');
  assert.equal(JSON.parse(readFileSync(join(dir, 'slot-1.lock'), 'utf8')).pid, process.pid);
  lock(2, { pid: ended(), at: now });
  assert.equal(takeSlot({ count: 2, dir }, now), join(dir, 'slot-2.lock'), 'its process ended');
  lock(2, { pid: process.pid, at: now - 5 * 60 * 60_000 });
  assert.equal(takeSlot({ count: 2, dir }, now), join(dir, 'slot-2.lock'), 'older than four hours');
  lock(2, '');
  assert.equal(takeSlot({ count: 2, dir }, now), null, 'an empty lock may be being written');
  assert.equal(takeSlot({ count: 2, dir }, now + 120_000), join(dir, 'slot-2.lock'), 'empty for over a minute');
  assert.deepEqual(slotSettings({}), { count: 2, dir: join(tmpdir(), 'aiworks-gate-slots') });
  assert.deepEqual(slotSettings({ AIWORKS_GATE_SLOTS: '1', AIWORKS_GATE_SLOTS_DIR: dir }), { count: 1, dir });
  for (const bad of ['0', '9', '1.5', 'many']) assert.equal(slotSettings({ AIWORKS_GATE_SLOTS: bad }).count, 2, bad);
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

test('readGateRun: the exit code and the final node:test summary the controller keeps with a verification (#43)', async (t) => {
  const { gateFailure, readGateRun, testSummary } = await import('../../src/supervisor/gate.mjs');
  const dir = workdir(t);
  assert.equal(readGateRun(dir), null, 'no gate ran here');
  writeFileSync(join(dir, 'gate.log'), 'noise\r\n# all test files: 1 unit (of 1)\r\n# tests 3\r\n# pass 3\r\n# fail 0\r\n');
  assert.deepEqual(readGateRun(dir), { exit: null, summary: '# all test files: 1 unit (of 1)\n# tests 3\n# pass 3\n# fail 0' }, 'an unfinished gate has no exit code');
  writeFileSync(join(dir, 'gate-exit.log'), '0\n');
  assert.equal(readGateRun(dir).exit, '0');
  // A plain node --test run has no "# all test files" line: its last run of count lines is the summary, never other output.
  assert.equal(testSummary('# tests 1\n# pass 1\nok\n# tests 2\n# pass 1\n# fail 1\n# duration_ms 5.5\nnpm ERR! after'), '# tests 2\n# pass 1\n# fail 1\n# duration_ms 5.5');
  assert.equal(testSummary('no summary here\n'), null);
  assert.equal(gateFailure(null), null);
  assert.equal(gateFailure({ exit: '0', summary: '# tests 2\n# pass 2\n# fail 0' }), null);
  assert.equal(gateFailure({ exit: null, summary: null }), null, 'an unfinished gate is shown, not refused');
  assert.equal(gateFailure({ exit: '1', summary: '# fail 0' }), 'exited 1');
  assert.equal(gateFailure({ exit: '0', summary: '# tests 4\n# fail 2' }), 'reports 2 failed tests');
});
