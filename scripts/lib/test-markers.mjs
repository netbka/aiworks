// The lines scripts/run-tests.mjs writes at the start of a line of its own output, which readers act on: the supervisor's
// test result cache (src/supervisor/test-cache.mjs) reads which files ran, passed, were retried or cached and on which
// Node version, and the gate reader (src/supervisor/gate.mjs) reads the summary and its failed tests. A test file's own
// output is printed whole inside the runner's output, and a test that prints, say, `# end tests/x.test.mjs 1 ms, exit 0`
// would otherwise look like one of them. escapeMarkers puts `#| ` before every such line of a test file's output, so a
// marker at the start of a line is always the runner's own. node:test's own lines (`# tests 3`, `# Subtest: ...`) are not
// markers and stay as they are.
const MARKER = /^(?=# (?:start |end |retry alone |retried alone|cached|failed:|all test files|node |not retried|first run failed|file times))/gm;

/** A test file's output with every line that starts like a runner marker escaped. */
export const escapeMarkers = (text) => String(text ?? '').replace(MARKER, '#| ');
