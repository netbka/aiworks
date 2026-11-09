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
  const snapshot = codeSnapshot({ git: ['git'], workspace: env.repo, revision, baseSha, task: { references: [] },
    policy: { allowedRoot: env.tmp }, evidenceTexts: ['The full check is red: tests/caller.test.mjs fails at this head.'] });
  const paths = snapshot.value.files.map((f) => f.path);
  assert.ok(paths.includes('src/shared.mjs'), 'the changed file');
  assert.ok(snapshot.value.diff.includes('root'), 'the change itself');
  assert.ok(paths.includes('src/caller.mjs'), 'the caller the signature change can break');
  assert.ok(paths.includes('tests/caller.test.mjs'), 'the failing test the finding names');
});

test('an attempt whose complete input already ended without progress is predicted, not paid for again', () => {
  const key = inputKey({ snapshotDigest: 'a'.repeat(64), findings: ['finding'], note: 'repair round 1' });
  const failed = { id: 'run.implement.7', inputKey: key, outcome: { class: 'result', value: { result: 'evidence-unavailable' } } };
  assert.equal(sameFailedInput(key, [failed])?.id, 'run.implement.7');
  assert.equal(sameFailedInput(key, [{ ...failed, outcome: { class: 'result', value: { result: 'resolved' } } }]), null, 'progress is not a repeat');
  const widened = inputKey({ snapshotDigest: 'b'.repeat(64), findings: ['finding'], note: 'repair round 1' });
  assert.equal(sameFailedInput(widened, [failed]), null, 'a changed input may run');
});
