// AIWorks never creates, enables, dispatches or reruns GitHub Actions. Publication does not depend on the Actions setting.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { rest } from '../../src/supervisor/adapters/github.mjs';
import { assertNoWorkflowChange, exec, pushVerified } from '../../src/supervisor/adapters/git.mjs';
import { pushTrustedTip } from '../../src/supervisor/github-backup.mjs';
import { workerEnv } from '../../src/supervisor/proc.mjs';

test('checkout and push environments suppress automatic LFS charges without restricting AI billing', () => {
  const env = workerEnv({ PATH: 'p', GIT_LFS_SKIP_SMUDGE: '0', GIT_LFS_SKIP_PUSH: '0', OPENAI_API_KEY: 'synthetic' },
    { GIT_LFS_SKIP_SMUDGE: '0', GIT_LFS_SKIP_PUSH: '0' });
  assert.equal(env.GIT_LFS_SKIP_SMUDGE, '1');
  assert.equal(env.GIT_LFS_SKIP_PUSH, '1');
  assert.equal(env.OPENAI_API_KEY, 'synthetic');
  const out = exec([process.execPath], ['-e', 'console.log(JSON.stringify([process.env.GIT_LFS_SKIP_SMUDGE, process.env.GIT_LFS_SKIP_PUSH]))']);
  assert.equal(out.ok, true);
  assert.deepEqual(JSON.parse(out.stdout), ['1', '1']);
});

test('publication does not read or wait on the Actions setting, and no write can dispatch or enable Actions', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-development-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls.jsonl'), fake = join(dir, 'cli.mjs');
  writeFileSync(calls, '');
  writeFileSync(fake, `import { appendFileSync } from 'node:fs';
const [kind, calls, ...args] = process.argv.slice(2);
appendFileSync(calls, JSON.stringify({ kind, args }) + '\\n');
if (kind === 'gh') {
  // An Actions setting that is enabled or unreadable must not matter.
  if (args.some(a => a.endsWith('/actions/permissions'))) { process.stderr.write('synthetic policy read failure'); process.exit(1); }
  process.stdout.write('{}');
} else if (args.includes('get-url')) process.stdout.write(process.env.SYNTHETIC_URLS ?? 'https://github.com/example-org/sampleapp.git');
else if (args.includes('diff')) process.stdout.write((process.env.SYNTHETIC_DIFF ?? '').split(',').filter(Boolean).map((path) => path + '\\0').join(''));
else if (args.includes('ls-remote')) process.stdout.write('${'a'.repeat(40)}\\trefs/heads/campaign/example/T1\\n');
`);
  const gh = [process.execPath, fake, 'gh', calls];
  const git = [process.execPath, fake, 'git', calls];
  const repository = 'example-org/sampleapp';
  const push = { git, gh, repository, repoPath: dir, branch: 'campaign/example/T1', sha: 'a'.repeat(40), base: 'c'.repeat(40) };
  const local = { git, repoPath: dir, base: push.base, head: push.sha };
  const seen = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  for (const args of [
    ['--method', 'POST', `repos/${repository}/pulls`],
    ['--method', 'POST', `repos/${repository}/issues/1/comments`],
    ['--method', 'PATCH', `repos/${repository}/issues/1`],
    ['--method', 'PUT', `repos/${repository}/pulls/1/merge`],
  ]) rest(gh, 'write', args, { local });
  // Comments and issue updates change no code: they need no tree.
  for (const args of [['--method', 'POST', `repos/${repository}/issues/1/comments`], ['--method', 'PATCH', `repos/${repository}/issues/1`]]) rest(gh, 'write', args);
  pushVerified(push);
  writeFileSync(calls, '');
  assert.equal(pushTrustedTip({ ...push, remote: 'origin', tip: push.sha }).kind, 'backup-pushed');
  assert.ok(!seen().some(({ args }) => ['ls-remote', 'fetch', 'pull'].some((verb) => args.includes(verb))), 'the guard reads no destination before the push');
  assert.ok(!seen().some(({ args }) => args.some(a => a.endsWith('/actions/permissions'))), 'the Actions setting is never read');
  assert.equal(seen().filter(({ kind, args }) => kind === 'git' && args.includes('push')).length, 1);
  const before = seen().length;
  assert.throws(() => rest(gh, 'write', ['--method', 'POST', `repos/${repository}/pulls`]), { code: 'LOCAL_DEVELOPMENT_ONLY' }, 'a code write whose change is unknown is refused');
  for (const route of ['actions/workflows/check.yml/dispatches', 'actions/runs/1/rerun', 'actions/permissions', 'codespaces', 'packages']) {
    assert.throws(() => rest(gh, 'workflow', ['--method', 'POST', `repos/${repository}/${route}`]), { code: 'LOCAL_DEVELOPMENT_ONLY' });
  }
  for (const route of ['user/codespaces', 'orgs/example-org/packages', 'orgs/example-org/settings/billing']) {
    assert.throws(() => rest(gh, 'resource', ['--method', 'POST', route]), { code: 'LOCAL_DEVELOPMENT_ONLY' });
  }
  for (const args of [
    ['--method=POST', `repos/${repository}/codespaces`],
    ['-XPOST', `repos/${repository}/codespaces`],
    ['--method', 'GET', '-X', 'POST', `repos/${repository}/codespaces`],
    ['--method', 'POST', 'user/codespaces', `repos/${repository}/pulls`],
    ['--method', 'POST', `repos/${repository}/pulls`, '--hostname', 'example.invalid'],
  ]) assert.throws(() => rest(gh, 'ambiguous request', args), { code: 'LOCAL_DEVELOPMENT_ONLY' });
  assert.equal(seen().length, before, 'workflow and resource writes never reach the CLI');
  // A change to a workflow file could start a hosted run: no push, backup push, pull request or merge reaches GitHub.
  // A workflow file the base already holds and the head leaves alone is the owner's repository matter and does not stop them.
  const code = [['--method', 'POST', `repos/${repository}/pulls`], ['--method', 'PUT', `repos/${repository}/pulls/1/merge`]];
  for (const changed of ['.github/workflows/x.yml', '.GitHub/Workflows/sub/y.yml', 'docs/a.md,.github/workflows']) {
    process.env.SYNTHETIC_DIFF = changed;
    writeFileSync(calls, '');
    assert.throws(() => pushVerified(push), { code: 'LOCAL_DEVELOPMENT_ONLY' });
    assert.equal(pushTrustedTip({ ...push, remote: 'origin', tip: push.sha }).kind, 'backup-refused');
    for (const args of code) assert.throws(() => rest(gh, 'write', args, { local }), { code: 'LOCAL_DEVELOPMENT_ONLY' });
    assert.ok(!seen().some(({ kind, args }) => (kind === 'git' && args.includes('push')) || (kind === 'gh' && args.includes('POST'))), 'nothing reached GitHub');
  }
  process.env.SYNTHETIC_DIFF = 'src/app.mjs,.github/CODEOWNERS,workflows/x.yml';
  t.after(() => { delete process.env.SYNTHETIC_DIFF; });
  writeFileSync(calls, '');
  pushVerified(push);
  for (const args of code) rest(gh, 'write', args, { local });
  assert.equal(seen().filter(({ kind, args }) => kind === 'git' && args.includes('push')).length, 1);
  delete process.env.SYNTHETIC_DIFF;
  const backup = { ...push, remote: 'backup', tip: push.sha };
  for (const urls of ['ext::untrusted helper', 'https://example.invalid/repo', '//server/share/repo', '']) {
    process.env.SYNTHETIC_URLS = urls;
    t.after(() => { delete process.env.SYNTHETIC_URLS; });
    writeFileSync(calls, '');
    assert.throws(() => pushVerified(push), { code: 'LOCAL_DEVELOPMENT_ONLY' });
    assert.equal(pushTrustedTip(backup).kind, 'backup-refused');
    assert.ok(!seen().some(({ kind, args }) => kind === 'git' && args.includes('push')), 'no push over an untrusted transport');
  }
  process.env.SYNTHETIC_URLS = dir;
  pushVerified(push);
  assert.equal(pushTrustedTip(backup).kind, 'backup-pushed', 'offline local directory transports remain available');
});

test('a base that gained a workflow after the fork does not block the head, and the head changing a workflow still does', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-workflow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const out = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  const commit = (path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); git('add', '-A'); git('commit', '-q', '-m', path); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  commit('README.md', 'one');
  const fork = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
  const clean = commit('src/app.mjs', 'change');
  git('checkout', '-q', 'main');
  const base = commit('.github/workflows/ci.yml', 'name: ci');
  git('checkout', '-q', '-b', 'edits', fork);
  const editing = commit('.github/Workflows/other.yml', 'name: x');
  const check = (args) => assertNoWorkflowChange({ git: ['git'], repoPath: dir, ...args });
  // The head does not contain the base's new workflow; a two-dot comparison would call that the head's own change.
  check({ base, head: clean });
  assert.throws(() => check({ base, head: editing }), { code: 'LOCAL_DEVELOPMENT_ONLY' });
  // A merge through the refresh path carries a gated merge result: the base's workflow plus the head's source change is fine.
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'merge', 'feature');
  check({ base, head: clean, tree: git('rev-parse', 'HEAD^{tree}') });
  assert.throws(() => check({ base, head: clean, tree: git('rev-parse', `${editing}^{tree}`) }), { code: 'LOCAL_DEVELOPMENT_ONLY' }, 'a gated result that changes workflows is refused');
  const gh = [process.execPath, '-e', "process.stdout.write('{}')"];
  const merge = ['--method', 'PUT', 'repos/example-org/sampleapp/pulls/1/merge'];
  rest(gh, 'merge', merge, { local: { git: ['git'], repoPath: dir, base, head: clean } });
  assert.throws(() => rest(gh, 'merge', merge, { local: { git: ['git'], repoPath: dir, base, head: editing } }), { code: 'LOCAL_DEVELOPMENT_ONLY' });
});
