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

test('a gate that fails: wait reports its exit code and exits 1', (t) => {
  const dir = workdir(t);
  gate(dir, 'start', 'node', 'fail.mjs');
  const done = waitFast(dir);
  assert.equal(done.code, 1, done.out);
  assert.match(done.out, /^finished: exit 3\./);
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

test('readGateRun: the exit code and the final node:test summary the controller keeps with a verification (#43)', async (t) => {
  const { gateFailure, readGateRun, testSummary } = await import('../../src/supervisor/gate.mjs');
  const dir = workdir(t);
  assert.equal(readGateRun(dir), null, 'no gate ran here');
  writeFileSync(join(dir, 'gate.log'), 'noise\r\n# all test files: 1 unit (of 1)\r\n# tests 3\r\n# pass 3\r\n# fail 0\r\n');
  assert.deepEqual(readGateRun(dir), { exit: null, summary: '# all test files: 1 unit (of 1)\n# tests 3\n# pass 3\n# fail 0', exited: null }, 'an unfinished gate has no exit code');
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
  // That run is still a failure, and the files that exited non-zero come from gate.log itself (the last run of a file
  // retried alone counts), never from the verifier's result.
  writeFileSync(join(dir, 'gate.log'), ['# start tests/a.test.mjs', 'not ok 1 - a', '# end tests/a.test.mjs 900000 ms, exit 1',
    '# end tests/b.test.mjs 5 ms, exit 1', '# end tests/c.test.mjs 7 ms, exit 0', '# retry alone tests/b.test.mjs',
    '# end tests/b.test.mjs 6 ms, exit 0', '# all test files: 3 unit (of 3)', '# tests 4', '# pass 4', '# fail 0', ''].join('\r\n'));
  writeFileSync(join(dir, 'gate-exit.log'), '1\n');
  const uncounted = readGateRun(dir);
  assert.deepEqual(uncounted.exited, ['tests/a.test.mjs']);
  assert.ok(gateFailure(uncounted), 'a non-zero exit fails the gate whatever the summary counts');
  assert.ok(gateFailure({ exit: '1', summary: null }));
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
});
