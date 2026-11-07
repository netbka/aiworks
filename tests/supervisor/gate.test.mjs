// The full-gate helper (src/supervisor/gate.mjs). On 2026-10-14 a verifier's own background gate ended without an exit
// code and the verifier waited on a summary line until its two-hour bound ended the run. These tests run the helper on
// small synthetic gate scripts in a temporary directory: no model, network or GitHub calls.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GateSlotStore } from '../../src/supervisor/gate-slot.mjs';
import { gateTestEnv, useGateTestHost } from './fixtures/gate-host-bootstrap.mjs';

const GATE = fileURLToPath(new URL('../../src/supervisor/gate.mjs', import.meta.url));
const HOST = mkdtempSync(join(tmpdir(), 'aiworks-gate-test-host-'));
const native = { skip: process.platform !== 'win32' ? 'Windows Job Object custody' : false };
useGateTestHost(HOST);
process.on('exit', () => { try { rmSync(HOST, { recursive: true, force: true }); } catch { /* preserve unsettled evidence */ } });
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
// Explicit fixture injection keeps every command in this file off the live host registry.
const gateIn = (dir, extra, ...args) => {
  const env = gateTestEnv(HOST, extra);
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [GATE, ...args], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { code: result.status, out: result.stdout };
};
const gate = (dir, ...args) => gateIn(dir, {}, ...args);

test('a project without check uses its explicit gate; a missing command cannot leave stale passing evidence', native, (t) => {
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
// A process id whose process has ended.
const ended = () => spawnSync(process.execPath, ['-e', '']).pid;

test('a gate that passes: wait returns its exit code and the final summary block, and every file it wrote is a .log', native, (t) => {
  const dir = workdir(t);
  const started = gate(dir, 'start', 'node', 'pass.mjs');
  assert.equal(started.code, 0);
  const done = waitFast(dir);
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /# tests 3\n# pass 3\n# fail 0/);
  assert.ok(readdirSync(dir).filter((name) => !(name in SCRIPTS)).every((name) => name.endsWith('.log')));
  const store = new GateSlotStore(HOST);
  try { assert.equal(store.snapshot().owner, null, 'the slot is released only after completion'); }
  finally { store.close(); }
});

test('a gate that fails: wait reports its exit code and exits 1', native, (t) => {
  const dir = workdir(t);
  gate(dir, 'start', 'node', 'fail.mjs');
  const done = waitFast(dir);
  assert.equal(done.code, 1, done.out);
  assert.match(done.out, /^finished: exit 3\./);
});

test('a gate process that ends without an exit code is reported as died at once, and a new start keeps its log', native, (t) => {
  const dir = workdir(t);
  gate(dir, 'start', 'node', 'dies.mjs');
  const before = Date.now();
  const died = waitFast(dir);
  assert.equal(died.code, 3, died.out);
  assert.ok(Date.now() - before < 30_000, 'reported within seconds, not at a time bound');
  // Until the dying gate's shell lets go of gate.log, Windows refuses to move it and start says so instead of starting.
  let restarted;
  for (let tries = 0; tries < 40; tries += 1) {
    restarted = gate(dir, 'start', 'node', 'pass.mjs');
    if (restarted.code === 0) break;
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 250)']);
  }
  assert.equal(restarted.code, 0, restarted.out);
  assert.equal(waitFast(dir).code, 0);
  assert.match(readFileSync(join(dir, 'gate-previous.log'), 'utf8'), /# start tests\/unlimited\.test\.mjs/);
});

test('a web task run holding the browser session holds back other gates, never its own, and a lapsed lock never blocks', native, async (t) => {
  const { browserLockPath, heldBrowserRuns, heldSlotCount } = await import('../../src/supervisor/gate.mjs');
  const { gatePauseOn } = await import('../../src/supervisor/host.mjs');
  // Off (the scheduler off, its default, or pauseAtGates 99), the supervisor writes no browser lock, so no gate waits.
  for (const config of [{}, { scheduler: { enabled: false } }, { scheduler: { enabled: true, pressure: { pauseAtGates: 99 } } }]) {
    assert.equal(gatePauseOn(config), false, JSON.stringify(config));
  }
  assert.equal(gatePauseOn({ scheduler: { enabled: true } }), true);
  const dir = workdir(t), slots = HOST;
  mkdirSync(slots, { recursive: true });
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => holder.kill());
  writeFileSync(browserLockPath(slots, 'op-web'), JSON.stringify({ pid: holder.pid, at: Date.now(), operation: 'op-web' }));
  writeFileSync(browserLockPath(slots, 'op-gone'), JSON.stringify({ pid: ended(), at: Date.now(), operation: 'op-gone' }));
  assert.deepEqual(heldBrowserRuns({ dir: slots }, Date.now(), null), ['op-web']);
  assert.equal(existsSync(browserLockPath(slots, 'op-gone')), false, 'a lock whose run ended is removed');
  // The run's own gate (its environment names the operation) starts at once; another waits until the run ends.
  assert.equal(gateIn(dir, { AIWORKS_BROWSER_RUN: 'op-web' }, 'start', `"${process.execPath}"`, 'pass.mjs').code, 0);
  assert.equal(waitFast(dir).code, 0, 'its own gate finished');
  assert.equal(gate(dir, 'start', `"${process.execPath}"`, 'pass.mjs').code, 0);
  assert.equal(waitFast(dir, '--minutes', '0.05').code, 2, 'another gate waits while the run holds the session');
  // The waiting gate holds no slot, yet admission counts it, or a wave of web task runs would starve it.
  assert.equal(heldSlotCount({ dir: slots }), 1, 'a gate waiting for the browser session pauses admission');
  holder.kill();
  assert.equal(waitFast(dir, '--minutes', '1').code, 0, 'and runs once the run ended');
  assert.equal(heldSlotCount({ dir: slots }), 0, 'a finished gate counts no more');
});

test('advisory browser locks follow their heartbeat without granting gate ownership', async (t) => {
  const { browserLockPath, heldBrowserRuns } = await import('../../src/supervisor/gate.mjs');
  const dir = workdir(t), slots = HOST, heartbeat = join(dir, 'heartbeat');
  mkdirSync(slots, { recursive: true });
  // A live process stands in for one Windows gave a dead gate's or run's id to.
  const reused = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => reused.kill());
  const old = Date.now() - 10 * 60_000;
  writeFileSync(browserLockPath(slots, 'op-stale'), JSON.stringify({ pid: reused.pid, at: old, heartbeat }));
  assert.deepEqual(heldBrowserRuns({ dir: slots }, Date.now(), null), [], 'a stale browser lock does not hold gates back');
  // A run that still beats keeps its browser lock, though the lock was written long ago.
  writeFileSync(heartbeat, String(Date.now()));
  writeFileSync(browserLockPath(slots, 'op-beating'), JSON.stringify({ pid: reused.pid, at: old, heartbeat }));
  assert.deepEqual(heldBrowserRuns({ dir: slots }, Date.now(), null), ['op-beating']);
});

test('readGateRun: the exit code and the final node:test summary the controller keeps with a verification (#43)', async (t) => {
  const { gateFailure, readGateRun, testSummary } = await import('../../src/supervisor/gate.mjs');
  const dir = workdir(t);
  assert.equal(readGateRun(dir), null, 'no gate ran here');
  writeFileSync(join(dir, 'gate.log'), 'noise\r\n# all test files: 1 unit (of 1)\r\n# tests 3\r\n# pass 3\r\n# fail 0\r\n');
  assert.deepEqual(readGateRun(dir), { exit: null, summary: '# all test files: 1 unit (of 1)\n# tests 3\n# pass 3\n# fail 0', exited: null, head: null }, 'an unfinished gate has no exit code');
  writeFileSync(join(dir, 'gate-exit.log'), '0\n');
  assert.equal(readGateRun(dir).exit, '0');
  // A plain node --test run has no "# all test files" line: its last run of count lines is the summary, never other output.
  assert.equal(testSummary('# tests 1\n# pass 1\nok\n# tests 2\n# pass 1\n# fail 1\n# duration_ms 5.5\nnpm ERR! after'), '# tests 2\n# pass 1\n# fail 1\n# duration_ms 5.5');
  assert.equal(testSummary('no summary here\n'), null);
  assert.equal(gateFailure(null), null);
  assert.equal(gateFailure({ exit: '0', summary: '# tests 2\n# pass 2\n# fail 0' }), null);
  assert.equal(gateFailure({ exit: null, summary: null }), null, 'an unfinished gate is shown, not refused');
  assert.equal(gateFailure({ exit: '0', summary: '# tests 4\n# fail 2' }), 'reports 2 failed tests');
  // 2026-11-05: a file stopped at its time limit printed no summary of its own, so the gate exited 1 with `# fail 0`.
  // That run is still a failure.
  writeFileSync(join(dir, 'gate.log'), ['# start tests/a.test.mjs', 'not ok 1 - a', '# end tests/a.test.mjs 900000 ms, exit 1',
    '# all test files: 1 unit (of 1)', '# tests 0', '# pass 0', '# fail 0', ''].join('\r\n'));
  writeFileSync(join(dir, 'gate-exit.log'), '1\n');
  assert.ok(gateFailure(readGateRun(dir)), 'a non-zero exit fails the gate whatever the summary counts');
  assert.ok(gateFailure({ exit: '1', summary: null }));
});

// The controller trusts a verifier's gate only as a run of the exact head it verifies: start records the commit and
// whether the checkout was clean, and a run of another commit, of a changed checkout or without that record is refused.
test('a gate run is a run of the verified head only when start recorded that commit on a clean checkout', native, async (t) => {
  const { gateFailure, gateHeadProblem, readGateRun } = await import('../../src/supervisor/gate.mjs');
  const dir = workdir(t);
  const git = (...args) => {
    const out = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  git('init', '-q');
  writeFileSync(join(dir, '.gitignore'), '*.log\n');
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'target');
  const target = git('rev-parse', 'HEAD');
  assert.equal(gate(dir, 'start', 'node', 'pass.mjs').code, 0);
  assert.equal(waitFast(dir).code, 0);
  const run = readGateRun(dir);
  assert.equal(gateHeadProblem(run, target), null, 'started on the target, its own gate files only');
  assert.ok(gateHeadProblem(run, '0'.repeat(40)), 'a run of another commit');
  assert.ok(gateFailure({ ...run, headProblem: gateHeadProblem(run, '0'.repeat(40)) }), 'kept with its reason, it never counts as passed');
  writeFileSync(join(dir, 'pass.mjs'), "console.log('# all test files'); console.log('# tests 0'); console.log('# fail 0');");
  assert.equal(gate(dir, 'start', 'node', 'pass.mjs').code, 0);
  assert.equal(waitFast(dir).code, 0, 'a development command may run on its recorded dirty checkout');
  assert.ok(gateHeadProblem(readGateRun(dir), target), 'started on a checkout with a changed file');
  rmSync(join(dir, 'gate-head.log'));
  assert.ok(gateHeadProblem(readGateRun(dir), target), 'no record of the commit it ran on');
});

// One isolated retry per failed file (scripts/lib/test-retry.mjs): a file that fails again alone must still fail the
// gate, or a verifier could accept a broken head on a passing tally.
test('a failed file retried alone passes the gate only when its retry passes; too many failures are not retried', async () => {
  const { retryPlan, settle } = await import('../../scripts/lib/test-retry.mjs');
  const counts = (pass, fail) => ({ tests: pass + fail, pass, fail });
  const runs = [
    { file: 'tests/a.test.mjs', code: 0, counts: counts(3, 0) },
    { file: 'tests/b.test.mjs', code: 1, counts: counts(1, 1) },
    { file: 'tests/c.test.mjs', code: 1, counts: counts(0, 0) }, // stopped at the file limit before its summary
  ];
  assert.deepEqual(retryPlan(runs, 10).files, ['tests/b.test.mjs', 'tests/c.test.mjs']);
  assert.deepEqual(retryPlan(runs, 1).files, [], 'more failures than the limit: none is retried');
  assert.deepEqual(retryPlan(runs, 0).files, []);

  const passed = settle(runs, [{ file: 'tests/b.test.mjs', code: 0, counts: counts(2, 0) }, { file: 'tests/c.test.mjs', code: 0, counts: counts(4, 0) }]);
  assert.equal(passed.status, 0);
  assert.equal(passed.total.fail, 0);
  assert.equal(passed.total.pass, 9);
  assert.equal(passed.lines.length, 2, 'every retry is named in the summary');

  const again = settle(runs, [{ file: 'tests/b.test.mjs', code: 0, counts: counts(2, 0) }, { file: 'tests/c.test.mjs', code: 1, counts: counts(3, 1) }]);
  assert.equal(again.status, 1);
  assert.equal(again.total.fail, 1);
  assert.equal(settle(runs, []).status, 1, 'no retry: the first failures stand');
  // A file stopped before its own summary counts no failed test, yet the total must not read `# fail 0` beside it.
  assert.equal(settle(runs, []).total.fail, 2);
  assert.equal(settle(runs, [{ file: 'tests/b.test.mjs', code: 0, counts: counts(2, 0) }, { file: 'tests/c.test.mjs', code: 1, counts: counts(0, 0) }]).total.fail, 1);
});
