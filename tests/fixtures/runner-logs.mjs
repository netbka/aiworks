// Synthetic gate logs of the test runners base compare reads (src/supervisor/gate.mjs failedTests): for each, a passing
// run, a failing run with the failed-test ids it names, and runs whose list is unknown (cut short, crashed, or stopped
// before every test ran). The node:test and pytest logs follow real output of node 22 and pytest 9; the others follow
// their runners' documented console formats. Fictional files and packages only.

const runTests = (lines) => ['# start tests/a.test.mjs', 'TAP version 13', 'not ok 1 - a', '# tests 1', '# fail 1',
  '# end tests/a.test.mjs 12 ms, exit 1', '# file times, slowest first', '# all test files: 1 unit, 0 service, 0 rehearsal (of 1)',
  '# node v22.0.0', ...lines, '# tests 2', '# pass 1', '# fail 1', '# duration_ms 40'].join('\n');

const tap = (body, fail, extra = '') => `TAP version 13\n${body}\n1..3\n# tests 3\n# suites 1\n# pass ${3 - fail}\n# fail ${fail}\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 118.99${extra}\n`;
const TAP_FAIL = `# Subtest: passes
ok 1 - passes
  ---
  duration_ms: 0.7
  ...
# Subtest: fails
not ok 2 - fails
  ---
  duration_ms: 0.6
  failureType: 'testCodeFailure'
  error: '1 == 2'
  code: 'ERR_ASSERTION'
  ...
# Subtest: suite
    # Subtest: inner bad
    not ok 1 - inner bad
      ---
      failureType: 'testCodeFailure'
      error: 'x'
      ...
    1..1
not ok 3 - suite
  ---
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...`;
const TAP_CRASH = `# Subtest: passes
ok 1 - passes
# Subtest: tests/crash.test.mjs
not ok 2 - tests/crash.test.mjs
  ---
  duration_ms: 75.9
  failureType: 'testCodeFailure'
  exitCode: 3
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...`;

const spec = (tree, fail, list = '') => `${tree}\nℹ tests 3\nℹ suites 1\nℹ pass ${3 - fail}\nℹ fail ${fail}\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 98.37\n${list}`;
const SPEC_FAIL_TREE = `✔ passes (0.7375ms)
✖ fails (0.6481ms)
▶ suite
  ✔ inner ok (1.0944ms)
  ✖ inner bad (0.2408ms)
✖ suite (1.5839ms)`;
const SPEC_FAIL_LIST = `
✖ failing tests:

test at a.test.mjs:4:1
✖ fails (0.6481ms)
  AssertionError [ERR_ASSERTION]: 1 == 2
      at TestContext.<anonymous> (file:///C:/example/a.test.mjs:4:30)

test at a.test.mjs:5:55
✖ inner bad (0.2408ms)
  Error: x
`;

const VITEST_HEAD = '\n RUN  v1.6.0 /work/example\n\n';
const VITEST_FAIL = `${VITEST_HEAD} ✓ src/a.test.ts (3 tests) 5ms
 ❯ src/b.test.ts (2 tests | 2 failed) 7ms
   × b > fails 3ms
     → expected 1 to be 2
   × b > nested > also fails 1ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/b.test.ts > b > fails
AssertionError: expected 1 to be 2
 ❯ src/b.test.ts:5:15

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  src/b.test.ts > b > nested > also fails
Error: boom

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 3 passed (5)
   Start at  12:00:00
   Duration  300ms (transform 20ms, setup 0ms, collect 30ms, tests 12ms)
`;
const VITEST_SUITE = `${VITEST_HEAD} ✓ src/a.test.ts (3 tests) 5ms
 ❯ src/c.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/c.test.ts [ src/c.test.ts ]
Error: Cannot find module './missing'

 Test Files  1 failed | 1 passed (2)
      Tests  3 passed (3)
`;

const JEST_FAIL = `PASS src/a.test.js
FAIL src/b.test.js (5.123 s)
  b
    ✓ works (2 ms)
    ✕ fails (3 ms)

  ● b › fails

    expect(received).toBe(expected) // Object.is equality

Summary of all failing tests
FAIL src/b.test.js (5.123 s)
  ● b › fails

    expect(received).toBe(expected) // Object.is equality

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 4 passed, 5 total
Snapshots:   0 total
Time:        6.2 s
Ran all test suites.
`;
const JEST_SUITE = `PASS src/a.test.js
FAIL src/c.test.js
  ● Test suite failed to run

    Cannot find module './missing' from 'src/c.test.js'

Test Suites: 1 failed, 1 passed, 2 total
Tests:       4 passed, 4 total
`;

const PYTEST_HEAD = '============================= test session starts =============================\nplatform linux -- Python 3.12.2, pytest-9.1.1, pluggy-1.6.0\ncollected 6 items\n';
const PYTEST_FAIL = `${PYTEST_HEAD}t/test_a.py .FF.FE                                                       [100%]
=================================== ERRORS ====================================
_________________________ ERROR at setup of test_err __________________________
================================== FAILURES ===================================
__________________________________ test_bad ___________________________________
E       assert 1 == 2
=========================== short test summary info ===========================
FAILED t/test_a.py::test_bad - assert 1 == 2
FAILED t/test_a.py::TestK::test_m - assert False
FAILED t/test_a.py::test_p[2] - assert 2 == 1
ERROR t/test_a.py::test_err - RuntimeError: setup
==================== 3 failed, 2 passed, 1 error in 0.11s =====================
`;
const PYTEST_COLLECT = `${PYTEST_HEAD}E   ModuleNotFoundError: No module named 'nonexistent_mod'
=========================== short test summary info ===========================
ERROR t/test_c.py
!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
============================== 1 error in 0.18s ===============================
`;

const GO_FAIL = `=== RUN   TestA
--- FAIL: TestA (0.00s)
    a_test.go:10: want 1, got 2
=== RUN   TestB
=== RUN   TestB/sub
    b_test.go:14: boom
--- FAIL: TestB (0.00s)
    --- FAIL: TestB/sub (0.00s)
FAIL
FAIL\texample.com/app/pkg\t0.003s
ok  \texample.com/app/other\t0.002s
?   \texample.com/app/cmd\t[no test files]
FAIL
`;
const GO_PANIC = `--- FAIL: TestA (0.00s)
panic: runtime error: index out of range [3] with length 3 [recovered]
FAIL\texample.com/app/pkg\t0.004s
FAIL
`;

const DOTNET_START = 'Test run for /work/example/Example.Tests/bin/Debug/net8.0/Example.Tests.dll (.NETCoreApp,Version=v8.0)\nStarting test execution, please wait...\nA total of 1 test files matched the specified pattern.\n';
const DOTNET_FAIL = `${DOTNET_START}  Failed Example.Tests.MathTests.Adds [3 ms]
  Error Message:
   Assert.Equal() Failure: Values differ
  Stack Trace:
     at Example.Tests.MathTests.Adds() in /work/example/Example.Tests/MathTests.cs:line 12
  Failed Example.Tests.MathTests.Divides(a: 1, b: 0) [< 1 ms]
  Error Message:
   System.DivideByZeroException : Attempted to divide by zero.

Failed!  - Failed:     2, Passed:     4, Skipped:     0, Total:     6, Duration: 30 ms - Example.Tests.dll (net8.0)
`;
const DOTNET_PASS = `${DOTNET_START}\nPassed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 9 ms - Example.Tests.dll (net8.0)\n`;
const DOTNET_SUMMARY = (failed, total) => `\nTest summary: total: ${total}, failed: ${failed}, succeeded: ${total - failed}, skipped: 0, duration: 1.2s\n`;
const DOTNET_ABORT = `${DOTNET_START}The active test run was aborted. Reason: Test host process crashed : Stack overflow.
Test Run Aborted with error System.Exception: One or more errors occurred.
`;

const CARGO_FAIL = `   Compiling example v0.1.0 (/work/example)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 1.20s
     Running unittests src/lib.rs (target/debug/deps/example-0123456789abcdef)

running 3 tests
test tests::a ... ok
test tests::b ... FAILED
test tests::c ... ignored

failures:

---- tests::b stdout ----
thread 'tests::b' panicked at src/lib.rs:10:5:
assertion \`left == right\` failed

failures:
    tests::b

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s

error: test failed, to rerun pass \`-p example --lib\`
     Running tests/it.rs (target/debug/deps/it-fedcba9876543210)

running 1 test
test checks_io ... FAILED

failures:
    checks_io

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

error: test failed, to rerun pass \`-p example --test it\`
error: 2 targets failed:
    \`-p example --lib\`
    \`-p example --test it\`
`;
const CARGO_PASS = `     Running unittests src/lib.rs (target/debug/deps/example-0123456789abcdef)

running 2 tests
test tests::a ... ok
test tests::b ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests example

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

/** Per runner: logs with the failed-test ids failedTests gives, null where the list is unknown. */
export const RUNNER_LOGS = {
  'run-tests': [
    { name: 'pass', log: runTests([]), failed: [] },
    { name: 'fail', log: runTests(['# failed: tests/a.test.mjs :: a']), failed: ['tests/a.test.mjs :: a'] },
    { name: 'list cut short', log: runTests(['# failed: tests/a.test.mjs :: a', '# failed: not listed: 3 more']), failed: null },
    { name: 'stopped before its summary', log: runTests([]).split('# all test files')[0], failed: null },
  ],
  'node-tap': [
    { name: 'pass', log: tap('# Subtest: passes\nok 1 - passes', 0), failed: [] },
    { name: 'fail', log: tap(TAP_FAIL, 2), failed: ['fails', 'suite', 'suite > inner bad'] },
    { name: 'cut short', log: `TAP version 13\n${TAP_FAIL}\n`, failed: null },
    { name: 'file crashed', log: tap(TAP_CRASH, 1), failed: null },
  ],
  'node-spec': [
    { name: 'pass', log: spec('✔ passes (0.7ms)\n✔ again (0.2ms)\n✔ more (0.1ms)', 0), failed: [] },
    { name: 'fail', log: spec(SPEC_FAIL_TREE, 2, SPEC_FAIL_LIST), failed: ['fails', 'suite', 'suite > inner bad'] },
    { name: 'cut short', log: `${SPEC_FAIL_TREE}\n`, failed: null },
    { name: 'file crashed', log: spec('✔ passes (0.7ms)\n✖ tests/crash.test.mjs (75.9ms)', 1, "\n✖ failing tests:\n\ntest at tests/crash.test.mjs:1:1\n✖ tests/crash.test.mjs (75.9ms)\n  'test failed'\n"), failed: null },
  ],
  vitest: [
    { name: 'pass', log: `${VITEST_HEAD} ✓ src/a.test.ts (3 tests) 5ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n`, failed: [] },
    { name: 'fail', log: VITEST_FAIL, failed: ['src/b.test.ts > b > fails', 'src/b.test.ts > b > nested > also fails'] },
    { name: 'cut short', log: VITEST_FAIL.split(' Test Files')[0], failed: null },
    { name: 'a suite failed to load', log: VITEST_SUITE, failed: null },
  ],
  jest: [
    { name: 'pass', log: 'PASS src/a.test.js\n\nTest Suites: 1 passed, 1 total\nTests:       4 passed, 4 total\n', failed: [] },
    { name: 'fail', log: JEST_FAIL, failed: ['src/b.test.js :: b › fails'] },
    { name: 'cut short', log: JEST_FAIL.split('Summary of all')[0], failed: null },
    { name: 'a suite failed to run', log: JEST_SUITE, failed: null },
  ],
  pytest: [
    { name: 'pass', log: `${PYTEST_HEAD}t/test_a.py ..                                                       [100%]\n============================== 2 passed in 0.01s ==============================\n`, failed: [] },
    { name: 'fail', log: PYTEST_FAIL, failed: ['t/test_a.py::TestK::test_m', 't/test_a.py::test_bad', 't/test_a.py::test_err', 't/test_a.py::test_p[2]'] },
    { name: 'cut short', log: PYTEST_FAIL.split('==================== 3 failed')[0], failed: null },
    { name: 'collection error', log: PYTEST_COLLECT, failed: null },
  ],
  go: [
    { name: 'pass', log: 'ok  \texample.com/app/pkg\t0.003s\n?   \texample.com/app/cmd\t[no test files]\n', failed: [] },
    { name: 'fail', log: GO_FAIL, failed: ['example.com/app/pkg :: TestA', 'example.com/app/pkg :: TestB', 'example.com/app/pkg :: TestB/sub'] },
    // Stopped between two packages: without go's final bare FAIL a later package may hold more failures.
    { name: 'cut after a failed package', log: GO_FAIL.split('ok  \t')[0], failed: null },
    { name: 'cut after a later package', log: GO_FAIL.split('?   \t')[0], failed: null },
    { name: 'cut short', log: GO_FAIL.split('FAIL\n')[0], failed: null },
    { name: 'panicked', log: GO_PANIC, failed: null },
    { name: 'build failed', log: 'FAIL\texample.com/app/pkg [build failed]\nFAIL\n', failed: null },
  ],
  dotnet: [
    { name: 'pass', log: `${DOTNET_START}\nPassed!  - Failed:     0, Passed:     6, Skipped:     0, Total:     6, Duration: 30 ms - Example.Tests.dll (net8.0)\n`, failed: [] },
    { name: 'fail', log: `${DOTNET_FAIL}${DOTNET_SUMMARY(2, 6)}`, failed: ['Example.Tests.MathTests.Adds', 'Example.Tests.MathTests.Divides(a: 1, b: 0)'] },
    { name: 'fail in one of two projects', log: `${DOTNET_FAIL}${DOTNET_PASS}${DOTNET_SUMMARY(2, 9)}`, failed: ['Example.Tests.MathTests.Adds', 'Example.Tests.MathTests.Divides(a: 1, b: 0)'] },
    // Without the closing summary a log cut between two projects reads like a finished run.
    { name: 'no end of the run after a failed project', log: DOTNET_FAIL, failed: null },
    { name: 'summary before the last project', log: `${DOTNET_FAIL}${DOTNET_SUMMARY(2, 6)}${DOTNET_PASS}`, failed: null },
    { name: 'summary counts another failure', log: `${DOTNET_FAIL}${DOTNET_SUMMARY(3, 9)}`, failed: null },
    { name: 'cut short', log: DOTNET_FAIL.split('\nFailed!')[0], failed: null },
    { name: 'test host crashed', log: DOTNET_ABORT, failed: null },
  ],
  cargo: [
    { name: 'pass', log: CARGO_PASS, failed: [] },
    { name: 'fail', log: CARGO_FAIL, failed: ['tests/it.rs :: checks_io', 'unittests src/lib.rs :: tests::b'] },
    { name: 'cut short', log: CARGO_FAIL.split('test result: FAILED. 0 passed')[0], failed: null },
    { name: 'stopped at the first failed binary', log: CARGO_FAIL.split('     Running tests/it.rs')[0], failed: null },
    // Cut right after a binary's result, before the closing `error: N targets failed:` of --no-fail-fast.
    { name: 'cut after a failed binary', log: CARGO_FAIL.split('error: test failed, to rerun pass `-p example --lib`')[0], failed: null },
    { name: 'cut after the last binary', log: CARGO_FAIL.split('error: 2 targets failed')[0], failed: null },
    { name: 'closing line counts another binary', log: CARGO_FAIL.replace('error: 2 targets', 'error: 3 targets'), failed: null },
    { name: 'one target failed', log: `${CARGO_FAIL.split('     Running tests/it.rs')[0]}error: 1 target failed:\n    \`-p example --lib\`\n`, failed: ['unittests src/lib.rs :: tests::b'] },
    { name: 'a passing binary after the closing line', log: `${CARGO_FAIL}${CARGO_PASS}`, failed: null },
  ],
};
