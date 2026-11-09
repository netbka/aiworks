import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeSnapshot } from '../../src/supervisor/code-broker.mjs';
import { inputKey, sameFailedInput } from '../../src/supervisor/failure-review.mjs';
import { exec } from '../../src/supervisor/adapters/git.mjs';
import { environment } from './helpers.mjs';

const git = (cwd, ...args) => { const r = exec(['git'], args, { cwd }); assert.ok(r.ok, r.stderr); return r.stdout; };

test('a repair snapshot holds its own diff, the callers of an export it changed and the files its findings name', (t) => {
  const env = environment(); t.after(() => env.cleanup());
  mkdirSync(join(env.repo, 'src'), { recursive: true });
  mkdirSync(join(env.repo, 'tests'), { recursive: true });
  writeFileSync(join(env.repo, 'src/shared.mjs'), 'export function checkout(git, path, commit) {\n  return [git, path, commit];\n}\n');
  writeFileSync(join(env.repo, 'src/caller.mjs'), "import { checkout } from './shared.mjs';\nexport const run = () => checkout('git', 'p', 'c');\n");
  writeFileSync(join(env.repo, 'tests/caller.test.mjs'), "import { run } from '../src/caller.mjs';\nrun();\n");
  git(env.repo, 'add', '-A'); git(env.repo, 'commit', '-q', '-m', 'base');
  const baseSha = git(env.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(env.repo, 'src/shared.mjs'), 'export function checkout(git, path, commit, root) {\n  if (!root) throw new Error("root");\n  return [git, path, commit, root];\n}\n');
  git(env.repo, 'commit', '-q', '-am', 'change the signature');
  const revision = git(env.repo, 'rev-parse', 'HEAD');
  const args = { git: ['git'], workspace: env.repo, revision, baseSha, task: { references: [] },
    policy: { allowedRoot: env.tmp }, evidenceTexts: ['The full check is red: tests/caller.test.mjs fails at this head.'] };
  const paths = codeSnapshot(args).value.files.map((f) => f.path);
  assert.ok(paths.includes('src/shared.mjs'), 'the changed file');
  assert.ok(paths.includes('src/caller.mjs'), 'the caller the signature change can break');
  assert.ok(paths.includes('tests/caller.test.mjs'), 'the failing test the finding names');
  const denied = codeSnapshot({ ...args, deniedPaths: ['tests/'] }).value.files.map((f) => f.path);
  assert.ok(!denied.includes('tests/caller.test.mjs'), 'a denied path never enters as self-review evidence');
});

test('only a deterministic no-progress end on the same input, executor and model is predicted; a transient one retries', () => {
  const key = inputKey({ executor: 'cursor-cli', model: 'example-model', prompt: 'packet and snapshot' });
  const lacked = { id: 'run.implement.7', inputKey: key, outcome: { class: 'result', value: { result: 'evidence-unavailable' } } };
  assert.equal(sameFailedInput(key, [lacked])?.id, 'run.implement.7');
  for (const transient of [{ class: 'exit-without-result', detail: 'stream ended' }, { class: 'error', detail: 'provider timeout' }, { class: 'timeout' }]) {
    assert.equal(sameFailedInput(key, [{ ...lacked, outcome: transient }]), null, `${transient.class} keeps its retry and backoff`);
  }
  assert.equal(sameFailedInput(inputKey({ executor: 'codex-cli', model: 'other-model', prompt: 'packet and snapshot' }), [lacked]), null,
    'another executor or model may run the same packet');
});
