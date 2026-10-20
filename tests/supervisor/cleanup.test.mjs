// CLN1 (PROJECT_WORKSPACE_PLAN 6.8c): cleanup after finished work removes only finished, owned, clean worktrees inside the
// registered folder and the local task branches the trusted main contains; it is off unless config.json turns it on.
// Workers are played through the controller's own result path, as in merge-gate.test.mjs: a disposable git origin and a
// synthetic gh, no model or network call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { branchName, prepareImplementWorkspace } from '../../src/supervisor/adapters/git.mjs';
import { declaration, environment, passedGate, skipWithoutSqlite } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const run = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
const git = (cwd, ...args) => {
  const result = run(cwd, ...args);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const A = 'camp-a', B = 'camp-b', C = 'camp-c';
const ON = { cleanup: { enabled: true } };
const task = (id, issue, file) => ({ id, issue, title: `change ${file}`, deliverable: 'commit', goal: `Change ${file}.`,
  dependsOn: [], acceptance: [`${file} changed`], references: ['AGENTS.md'] });

function rig(t, campaigns) {
  const env = environment({ config: { commands: {
    claude: [process.execPath, join(here, 'fixtures', 'fake-claude.mjs')],
    gh: [process.execPath, join(here, 'fixtures', 'fake-gh-merge.mjs')],
  } } });
  process.env.FAKE_GH_ORIGIN = env.origin;
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { r.controller?.release(); store.close(); env.cleanup(); });
  for (const [campaignId, tasks] of Object.entries(campaigns)) campaignStart(store, declaration({ campaignId, tasks }));
  const ctx = (id) => ({ id, generation: r.controller.held.get(id) });
  const now = Date.now();
  const r = {
    env, store, controller: null,
    start(config = {}) {
      r.controller?.release();
      r.controller = new Controller({ store, config: { ...env.config, ...config }, dataDir: env.dataDir, now: () => now, fault: null });
      r.controller.launch = async () => {}; // the test plays the worker; nothing is spawned
    },
    tick: () => r.controller.tick(),
    ops: (id) => store.all('SELECT * FROM operations WHERE campaign_id = ? ORDER BY created_at', id),
    open: (id) => store.openOperations(id)[0],
    implement(id, file) {
      const op = r.open(id);
      writeFileSync(join(op.workspace, file), `${id}\n`);
      git(op.workspace, 'add', '-A');
      git(op.workspace, 'commit', '-qm', `work for ${id}`);
      const headSha = git(op.workspace, 'rev-parse', 'HEAD');
      r.controller.applyOutcome(ctx(id), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { result: 'resolved', summary: 'implemented', headSha, report: `# Report for ${id}` } });
      return headSha;
    },
    verify(id) {
      const op = r.open(id);
      passedGate(op.workspace);
      r.controller.applyOutcome(ctx(id), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { verdict: 'accepted', summary: 'checked', targetSha: op.target_sha, findings: [], checks: [{ command: 'npm run check', result: 'pass' }] } });
    },
    worktrees: () => git(env.repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9)).sort(),
    branches: () => git(env.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/campaign/').split('\n').filter(Boolean).sort(),
    journal: (kind) => store.all('SELECT detail FROM journal WHERE kind = ? ORDER BY seq', kind).map((row) => row.detail),
  };
  r.start();
  return r;
}

/** Each campaign's single task implemented, verified and published, so the campaign is finished. */
async function finish(r, ids) {
  await r.tick();
  const heads = {};
  for (const id of ids) heads[id] = r.implement(id, `${id}.txt`);
  await r.tick();
  for (const id of ids) r.verify(id);
  await r.tick();
  await r.tick();
  for (const id of ids) assert.equal(r.store.campaign(id).control, 'finished', `${id} finished`);
  return heads;
}

test('cleanup is off unless enabled, and then removes only finished, owned, clean worktrees and merged local branches', { skip: skipWithoutSqlite }, async (t) => {
  const r = rig(t, { [A]: [task('A1', 601, 'a.txt')], [B]: [task('B1', 602, 'b.txt')] });
  const heads = await finish(r, [A, B]);
  // The owner merged A1 into main; B1 is published but not merged.
  git(r.env.repo, 'push', '-q', 'origin', `${heads[A]}:refs/heads/main`);
  // C1 is still running: its implement operation is open.
  campaignStart(r.store, declaration({ campaignId: C, tasks: [task('C1', 603, 'c.txt')] }));
  await r.tick();
  const active = r.open(C);
  assert.equal(active?.kind, 'implement');
  // B1's verifier checkout keeps an unsaved file; a checkout nobody owns sits in the registered folder.
  const [bImplement, bVerify] = r.ops(B).map((op) => op.workspace);
  writeFileSync(join(bVerify, 'notes.txt'), 'unsaved\n');
  const unowned = join(r.env.config.repositories['example-org/sampleapp'].worktreeRoot, 'by-hand');
  git(r.env.repo, 'worktree', 'add', '-q', '--detach', unowned, 'main');
  const worktrees = r.worktrees(), branches = r.branches();
  const runDirs = [...r.ops(A), ...r.ops(B)].map((op) => op.run_dir);
  assert.ok(runDirs.every((dir) => existsSync(dir)));

  // Absent, malformed, or with every owned worktree outside the registered folder: nothing is removed.
  const elsewhere = join(r.env.tmp, 'other-root');
  mkdirSync(elsewhere);
  for (const config of [{}, { cleanup: { enabled: 'true' } }, { cleanup: true },
    { cleanup: { enabled: true, repositories: [] } },
    { cleanup: { enabled: true, repositories: ['example-org/another-project'] } },
    { cleanup: { enabled: true, repositories: 'example-org/sampleapp' } },
    { cleanup: { enabled: true, repositories: [''] } },
    { ...ON, repositories: { 'example-org/sampleapp': { path: r.env.repo, worktreeRoot: elsewhere } } }]) {
    r.start(config);
    await r.tick();
    assert.deepEqual(r.worktrees(), worktrees, `no worktree removed with ${JSON.stringify(config)}`);
    assert.deepEqual(r.branches(), branches, `no branch deleted with ${JSON.stringify(config)}`);
  }
  assert.ok(r.journal('cleanup-kept').some((item) => item.reason === 'outside-root'));
  assert.equal(r.journal('cleanup-started').length, 0);

  r.start({ cleanup: { enabled: true, repositories: ['EXAMPLE-ORG/SAMPLEAPP'] } });
  await r.tick();
  const [aImplement, aVerify] = r.ops(A).map((op) => op.workspace);
  for (const path of [aImplement, aVerify, bImplement]) assert.ok(!existsSync(path), `${path} removed`);
  for (const path of [bVerify, unowned, active.workspace]) assert.ok(existsSync(path), `${path} kept`);
  assert.equal(readFileSync(join(bVerify, 'notes.txt'), 'utf8'), 'unsaved\n');
  assert.ok(!r.branches().includes(`refs/heads/${branchName(A, 'A1')}`), 'the merged local branch is deleted');
  assert.ok(r.branches().includes(`refs/heads/${branchName(B, 'B1')}`), 'the unmerged branch is kept');
  assert.ok(r.branches().includes(`refs/heads/${branchName(C, 'C1')}`), 'the active branch is kept');
  assert.equal(r.env.remoteHead(branchName(A, 'A1')), heads[A], 'the remote branch is never deleted');
  assert.ok(runDirs.every((dir) => existsSync(dir)), 'every run directory survives');
  // The verifier's gate output is kept in its run directory before its checkout goes.
  const verifyRun = r.ops(A).find((op) => op.kind === 'verify').run_dir;
  assert.match(readFileSync(join(verifyRun, `worktree-${aVerify.split(/[\\/]/).pop()}-gate.log`), 'utf8'), /# pass 1/);
  const kept = r.journal('cleanup-kept').map((item) => item.reason);
  for (const reason of ['changes', 'unowned', 'not-in-main']) assert.ok(kept.includes(reason), `${reason} reported`);
  assert.equal(r.journal('cleanup-started').length, r.journal('cleanup-finished').length);
});

test('a removal interrupted by a crash finishes once after a restart, and a later repair recreates the checkout', { skip: skipWithoutSqlite }, async (t) => {
  const r = rig(t, { [A]: [task('A1', 601, 'a.txt')] });
  const { [A]: verified } = await finish(r, [A]);
  git(r.env.repo, 'push', '-q', 'origin', `${verified}:refs/heads/main`);
  const [implement, verify] = r.ops(A).map((op) => op.workspace);
  // The previous supervisor journaled the removal, removed the worktree, and stopped before recording the outcome.
  r.store.journal(A, 'cleanup-started', { action: 'remove-worktree', path: implement, task: 'A1', repoPath: r.env.repo }, Date.now());
  git(r.env.repo, 'worktree', 'remove', implement);

  r.start(ON);
  await r.tick();
  assert.ok(!existsSync(verify));
  assert.deepEqual(r.journal('cleanup-finished').filter((item) => item.reconciled).map((item) => item.outcome), ['removed']);
  assert.equal(r.journal('cleanup-started').filter((item) => item.action === 'delete-branch').length, 1);
  assert.ok(!r.branches().includes(`refs/heads/${branchName(A, 'A1')}`));
  const started = r.journal('cleanup-started').length;
  r.start(ON); // another restart: nothing is repeated
  await r.tick();
  assert.equal(r.journal('cleanup-started').length, started);

  // A later repair round prepares its checkout the way dispatch does, at the published verified head.
  const repo = r.env.config.repositories['example-org/sampleapp'];
  const ws = prepareImplementWorkspace({ git: ['git'], repoPath: repo.path, worktreeRoot: repo.worktreeRoot,
    campaignId: A, taskId: 'A1', baseBranch: 'main', baseSha: verified });
  assert.equal(ws.path, implement);
  assert.equal(ws.head, verified);
});

test('a finished worktree holding ignored evidence or unknown ignored files is kept; installed node_modules is not', { skip: skipWithoutSqlite }, async (t) => {
  const r = rig(t, { [A]: [task('A1', 601, 'a.txt')], [B]: [task('B1', 602, 'b.txt')] });
  const heads = await finish(r, [A, B]);
  git(r.env.repo, 'push', '-q', 'origin', `${heads[A]}:refs/heads/main`);
  const common = git(r.env.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  mkdirSync(join(common, 'info'), { recursive: true });
  writeFileSync(join(common, 'info', 'exclude'), '.local/\nnode_modules/\n*.cache\n');
  const [aImplement, aVerify] = r.ops(A).map((op) => op.workspace);
  const [bImplement] = r.ops(B).map((op) => op.workspace);
  mkdirSync(join(aImplement, '.local'));
  writeFileSync(join(aImplement, '.local', 'run-notes.json'), '{"synthetic":true}\n');
  writeFileSync(join(aVerify, 'unknown.cache'), 'synthetic\n');
  mkdirSync(join(bImplement, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(bImplement, 'node_modules', 'pkg', 'index.js'), '// synthetic\n');
  r.start(ON);
  await r.tick();
  assert.equal(readFileSync(join(aImplement, '.local', 'run-notes.json'), 'utf8'), '{"synthetic":true}\n');
  assert.equal(readFileSync(join(aVerify, 'unknown.cache'), 'utf8'), 'synthetic\n');
  assert.ok(!existsSync(bImplement), 'a checkout whose only ignored entry is installed node_modules is removed');
  assert.equal(r.journal('cleanup-kept').filter((item) => item.reason === 'ignored-files').length, 2);
});
