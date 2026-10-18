// Synthetic gate for the merge-gate refresh tests (merge-refresh.test.mjs), run by the gate helper in a refresh worktree.
// It appends { cwd, head, tree } to <FAKE_REFRESH_STATE>/runs.jsonl, then behaves as <FAKE_REFRESH_STATE>/mode says:
// `pass` (default) prints a node:test summary and exits 0, `fail` prints one with a failure and exits 1, and `hold`
// waits until <FAKE_REFRESH_STATE>/release exists, then passes. No network, model or GitHub call.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const state = process.env.FAKE_REFRESH_STATE;
const git = (...args) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true }).stdout.trim();
appendFileSync(join(state, 'runs.jsonl'), `${JSON.stringify({ cwd: process.cwd(), head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') })}\n`);
const mode = existsSync(join(state, 'mode')) ? readFileSync(join(state, 'mode'), 'utf8').trim() : 'pass';
if (mode === 'hold') while (!existsSync(join(state, 'release'))) await sleep(50);
const failed = mode === 'fail' ? 1 : 0;
console.log(`# all test files: 1 unit, 0 service, 0 rehearsal (of 1)\n# tests 2\n# pass ${2 - failed}\n# fail ${failed}`);
process.exitCode = failed;
