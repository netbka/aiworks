// LO L4 (docs/design/LOCAL_OPERATION.md sections 4.2 and 9, slice SELF4): with local main trusted, the self-hosted
// repository is worked on with no remote at all. Bases, worktrees and dependency receipts come from local refs and the
// main ledger; a synthetic gh and a Git guard fail the test if anything reaches for GitHub or a remote.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { recordAnchor, recordMainCommit } from '../../src/supervisor/self-hosting.mjs';
import { connectGithubProject, checkGithubProject } from '../../src/supervisor/project-connect.mjs';
import { pinRequest } from '../../src/supervisor/intake.mjs';
import { selfHostingSettings } from '../../src/supervisor/self-hosting.mjs';
import { declaration, environment, GOVERNANCE, runUntil, skipWithoutSqlite, SQLITE } from './helpers.mjs';

const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

/**
 * Command lines that record every call in `log` and refuse it: one stands in for gh, the other wraps Git and refuses
 * fetch, push and ls-remote while running every other Git command unchanged.
 */
function guards(dir) {
  const log = join(dir, 'forbidden.log');
  writeFileSync(join(dir, 'forbidden-gh.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], JSON.stringify(['gh', ...process.argv.slice(3)]) + '\\n');
process.exit(97);
`);
  writeFileSync(join(dir, 'git-guard.mjs'), `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(3);
if (args.some((arg) => ['fetch', 'push', 'ls-remote', 'pull'].includes(arg))) {
  appendFileSync(process.argv[2], JSON.stringify(['git', ...args]) + '\\n');
  process.exit(97);
}
const out = spawnSync('git', args, { stdio: 'inherit', windowsHide: true });
process.exit(out.status ?? 1);
`);
  return { log, gh: [process.execPath, join(dir, 'forbidden-gh.mjs'), log], git: [process.execPath, join(dir, 'git-guard.mjs'), log] };
}

/** Anchor the main ledger at the current main, then remove the remote: the repository never talks to one again. */
function anchorAndDisconnect(store, repo, repository) {
  const anchor = git(repo, 'rev-parse', 'main');
  git(repo, 'update-ref', 'refs/remotes/origin/main', anchor);
  assert.equal(recordAnchor(store, { repoPath: repo, repository, sha: anchor, now: 1 }).recorded, true);
  git(repo, 'remote', 'remove', 'origin');
  assert.equal(git(repo, 'remote'), '');
  return anchor;
}

/** A commit on main that no ledger row put there, as a worker moving main by hand would leave it. */
function unrecordedCommit(repo) {
  writeFileSync(join(repo, 'unrecorded.txt'), 'not trusted\n');
  git(repo, 'add', 'unrecorded.txt');
  git(repo, 'commit', '-q', '-m', 'unrecorded');
  return git(repo, 'rev-parse', 'HEAD');
}

test('LO L4: implement, verify, repair and dependency integration of the self-hosted repository with no remote and no gh', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment({ scenario: { verify: ['reject', 'accept', 'accept'] } });
  const forbidden = guards(env.tmp);
  const config = { ...env.config, commands: { ...env.config.commands, gh: forbidden.gh, git: forbidden.git },
    selfHosting: { repository: 'example-org/sampleapp', trustedMain: 'local' },
    ciRepair: { enabled: true }, integrationRepair: { enabled: true }, ciPollMs: 50 };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const anchor = anchorAndDisconnect(store, env.repo, 'example-org/sampleapp');
  const unrecorded = unrecordedCommit(env.repo);

  const d = declaration();
  d.tasks[1].requiresMergedDependencies = true;
  campaignStart(store, d);
  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  // Publication to the work list is local-review.test.mjs's; this test records the merged state by hand.
  controller.publish = async () => {};

  // Implement, a rejected verification, the repair round and the accepted verification of the exact head.
  await runUntil(controller, store, d.campaignId, () => /^[0-9a-f]{40}$/.test(store.task(d.campaignId, 'T1').verified_sha ?? ''));
  const t1 = store.task(d.campaignId, 'T1');
  assert.deepEqual(env.calls().map((call) => call.role), ['implement', 'verify', 'implement', 'verify']);
  assert.equal(t1.repair_rounds, 1);
  const [first] = env.calls();
  assert.equal(git(first.cwd, 'merge-base', anchor, t1.verified_sha), anchor, 'the worktree starts from the trusted tip');
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', unrecorded, t1.verified_sha], { cwd: env.repo, windowsHide: true }).status, 1,
    'a commit on main that the ledger does not record never becomes a base');

  // The local merge gate (SELF8) records its merge commit; the dependant's receipt comes from the ledger alone.
  const merge = git(env.repo, 'commit-tree', `${t1.verified_sha}^{tree}`, '-p', anchor, '-p', t1.verified_sha, '-m', 'merge T1');
  git(env.repo, 'update-ref', 'refs/heads/main', merge);
  assert.equal(recordMainCommit(store, { repository: 'example-org/sampleapp', kind: 'gate-merge', oldTip: anchor, newTip: merge,
    campaignId: d.campaignId, taskId: 'T1', verifiedSha: t1.verified_sha, now: 2 }).recorded, true);
  store.patch('tasks', { campaign_id: d.campaignId, task_id: 'T1' }, t1.version,
    { state: 'done', pr_url: 'https://github.com/example-org/sampleapp/pull/1', retry_at: null, last_error: null }, Date.now());
  await runUntil(controller, store, d.campaignId, () => /^[0-9a-f]{40}$/.test(store.task(d.campaignId, 'T2').verified_sha ?? ''));
  const t2 = store.task(d.campaignId, 'T2');
  assert.equal(git(env.repo, 'merge-base', merge, t2.verified_sha), merge, 'the dependant starts from the recorded merge');

  assert.deepEqual(lines(forbidden.log), [], 'nothing ran gh, fetched, pushed or listed a remote');
  assert.equal(existsSync(join(env.repo, '.git', 'FETCH_HEAD')), false);
});

test('the self-hosted repository connects, checks and pins its intake base from local refs, never running gh', { skip: !SQLITE && 'node:sqlite requires Node >= 22.5' }, (t) => {
  const env = environment();
  const forbidden = guards(env.tmp);
  const repository = 'example-org/aiworks';
  const config = { ...env.config, selfHosting: { repository, trustedMain: 'local' } };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  git(env.repo, 'remote', 'set-url', 'origin', `https://github.com/${repository}.git`);
  const anchor = git(env.repo, 'rev-parse', 'main');
  git(env.repo, 'update-ref', 'refs/remotes/origin/main', anchor);
  assert.equal(recordAnchor(store, { repoPath: env.repo, repository, sha: anchor, now: 1 }).recorded, true);
  unrecordedCommit(env.repo);
  const refuse = () => { throw new Error('a remote or gh read ran for the self-hosted repository'); };
  const options = { store, config, dataDir: env.dataDir, governanceRoot: GOVERNANCE, git: forbidden.git, gh: refuse, lsRemote: refuse,
    protectedRoots: [env.dataDir] };

  const connected = connectGithubProject({ path: env.repo, id: 'aiworks' }, options);
  assert.equal(connected.code, null, JSON.stringify(connected));
  assert.equal(connected.project.base_branch, 'main');
  assert.equal(checkGithubProject(store, 'aiworks', options).status, 'ready');

  const pinned = pinRequest(store, { project_id: 'aiworks', route: 'goal' }, { git: forbidden.git, gh: forbidden.gh, selfHosting: selfHostingSettings(config) });
  assert.equal(pinned.ok, true, JSON.stringify(pinned));
  assert.equal(pinned.pinned.base, anchor, 'the intake base is the trusted tip, not the unrecorded main');
  assert.deepEqual(lines(forbidden.log), []);
});
