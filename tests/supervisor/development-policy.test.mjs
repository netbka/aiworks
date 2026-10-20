// A publication must never start GitHub Actions, including through comments or merges.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { rest } from '../../src/supervisor/adapters/github.mjs';
import { exec, pushVerified } from '../../src/supervisor/adapters/git.mjs';
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

test('GitHub mutations and pushes require a fresh disabled Actions policy and never dispatch workflows', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-development-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const policy = join(dir, 'policy.json'), calls = join(dir, 'calls.jsonl'), fake = join(dir, 'cli.mjs');
  writeFileSync(calls, '');
  writeFileSync(fake, `import { appendFileSync, readFileSync } from 'node:fs';
const [kind, policy, calls, ...args] = process.argv.slice(2);
appendFileSync(calls, JSON.stringify({ kind, args }) + '\\n');
const p = JSON.parse(readFileSync(policy, 'utf8'));
if (kind === 'gh') {
  if (args.some(a => a.endsWith('/actions/permissions'))) {
    if (p.error) { process.stderr.write('synthetic policy read failure'); process.exit(1); }
    const route = args.find(a => a.endsWith('/actions/permissions'));
    process.stdout.write(JSON.stringify(p.destinations?.[route] ?? p));
  } else process.stdout.write('{}');
} else if (args.includes('get-url')) {
  if (p.remoteError) process.exit(1);
  process.stdout.write(p.urls ?? 'https://github.com/example-org/sampleapp.git');
} else if (args.includes('ls-remote')) process.stdout.write('${'a'.repeat(40)}\\trefs/heads/campaign/example/T1\\n');
`);
  const gh = [process.execPath, fake, 'gh', policy, calls];
  const git = [process.execPath, fake, 'git', policy, calls];
  const repository = 'example-org/sampleapp';
  const push = { git, gh, repository, repoPath: dir, branch: 'campaign/example/T1', sha: 'a'.repeat(40) };
  const mutations = [
    ['--method', 'POST', `repos/${repository}/pulls`],
    ['--method', 'POST', `repos/${repository}/issues/1/comments`],
    ['--method', 'PATCH', `repos/${repository}/issues/1`],
    ['--method', 'PUT', `repos/${repository}/pulls/1/merge`],
    [`repos/${repository}/issues/1/comments`, '-f', 'body=example'],
  ];
  const seen = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  for (const value of [{ enabled: true }, {}, { enabled: 'false' }, { enabled: null }, { error: true }]) {
    writeFileSync(policy, JSON.stringify(value));
    writeFileSync(calls, '');
    for (const args of mutations) assert.throws(() => rest(gh, 'write', args));
    assert.throws(() => pushVerified(push));
    assert.equal(pushTrustedTip({ ...push, remote: 'origin', tip: push.sha }).kind, 'backup-refused');
    assert.ok(seen().every(({ kind, args }) => kind === 'gh' && args.includes('GET') && args.some(a => a.endsWith('/actions/permissions'))),
      'only policy reads: no Git push, PR, comment, merge or issue mutation');
  }
  writeFileSync(policy, JSON.stringify({ enabled: false }));
  writeFileSync(calls, '');
  rest(gh, 'write', mutations[0]);
  pushVerified(push);
  assert.equal(seen().filter(({ args }) => args.some(a => a.endsWith('/actions/permissions'))).length, 3);
  assert.equal(seen().filter(({ kind, args }) => kind === 'git' && args.includes('push')).length, 1);
  // A later policy change invalidates the next write immediately; success was not cached.
  writeFileSync(policy, JSON.stringify({ enabled: true }));
  assert.throws(() => rest(gh, 'write', mutations[1]), { code: 'LOCAL_DEVELOPMENT_ONLY' });
  writeFileSync(policy, JSON.stringify({ enabled: false }));
  const before = seen().length;
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
  assert.equal(seen().length, before, 'workflow and resource writes never reach the CLI, even with Actions disabled');
  const backup = { ...push, remote: 'backup', tip: push.sha }, other = 'https://github.com/example-org/archive.git';
  for (const urls of [other, `https://github.com/${repository}.git\n${other}`]) {
    writeFileSync(policy, JSON.stringify({ enabled: false, urls,
      destinations: { 'repos/example-org/archive/actions/permissions': { enabled: true } } }));
    writeFileSync(calls, '');
    assert.throws(() => pushVerified(push), { code: 'LOCAL_DEVELOPMENT_ONLY' });
    assert.equal(pushTrustedTip(backup).kind, 'backup-refused');
    assert.ok(seen().some(({ args }) => args.includes('repos/example-org/archive/actions/permissions')));
    assert.ok(!seen().some(({ kind, args }) => kind === 'git' && args.includes('push')), 'no push to an unchecked destination');
  }
  writeFileSync(policy, JSON.stringify({ enabled: false, urls: other }));
  assert.equal(pushTrustedTip(backup).kind, 'backup-pushed', 'a configured backup checks its own destination');
  for (const value of [{ urls: '' }, { urls: 'ext::untrusted helper' }, { urls: 'https://example.invalid/repo' },
    { urls: '//server/share/repo' }, { remoteError: true }]) {
    writeFileSync(policy, JSON.stringify({ enabled: false, ...value }));writeFileSync(calls, '');
    assert.throws(() => pushVerified(push), { code: 'LOCAL_DEVELOPMENT_ONLY' });
    assert.equal(pushTrustedTip(backup).kind, 'backup-refused');
    assert.ok(!seen().some(({ kind, args }) => kind === 'git' && args.includes('push')));
  }
  writeFileSync(policy, JSON.stringify({ enabled: false, urls: dir }));
  pushVerified(push);
  assert.equal(pushTrustedTip(backup).kind, 'backup-pushed', 'offline local directory transports remain available');
});
