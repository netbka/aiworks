// LO L3 (docs/design/LOCAL_OPERATION.md sections 4.3 and 9, slice SELF3): runtime provenance against the trusted tip of
// local main, in disposable git repositories. No network: the anchor's origin/main is set with update-ref, never fetched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { recordAnchor } from '../../src/supervisor/self-hosting.mjs';
import { revisionNotMerged, runtimeTrust } from '../../src/supervisor/provenance.mjs';

const REPOSITORY = 'example-org/aiworks';
const LOCAL = { selfHosting: { repository: REPOSITORY, trustedMain: 'local' } };

/** A repository with no remote whose main ledger is anchored at its second commit (`base` lies below), plus a store beside it. */
function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-provenance-local-'));
  const repoPath = join(dir, 'repo');
  const git = (cwd, ...args) => {
    const out = spawnSync('git', ['-c', 'user.name=Provenance Test', '-c', 'user.email=provenance@example.invalid', ...args],
      { cwd, encoding: 'utf8', windowsHide: true });
    if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
    return out.stdout.trim();
  };
  spawnSync('git', ['init', '-q', '-b', 'main', repoPath], { windowsHide: true });
  let n = 0;
  const commit = (cwd = repoPath) => {
    writeFileSync(join(cwd, 'file.txt'), `${++n}\n`);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', `commit ${n}`);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const store = new Store(join(dir, 'supervisor.db'));
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  const base = commit();
  const anchor = commit();
  // The switch-on step anchors at origin/main; the ref is removed again, so the repository never had an origin.
  git(repoPath, 'update-ref', 'refs/remotes/origin/main', anchor);
  assert.equal(recordAnchor(store, { repoPath, repository: REPOSITORY, sha: anchor, now: 1 }).recorded, true);
  git(repoPath, 'update-ref', '-d', 'refs/remotes/origin/main');
  return { dir, repoPath, git, commit, store, base, anchor, trust: runtimeTrust(LOCAL, store) };
}

test('local trust passes with no origin remote, never fetches, and a main forged from a worker worktree is not trusted', (t) => {
  const { dir, repoPath, git, commit, store, anchor, trust } = rig(t);
  assert.equal(git(repoPath, 'remote'), '');
  assert.equal(runtimeTrust({}, store), null, 'without a selfHosting block the trusted main stays origin/main');
  assert.match(revisionNotMerged({ root: repoPath, revision: anchor }), /origin\/main is not available/);
  assert.equal(revisionNotMerged({ root: repoPath, revision: anchor, trust }), null);

  // A worker commits in its linked worktree and moves the shared main to its own commit with update-ref.
  const worker = join(dir, 'worker');
  git(repoPath, 'worktree', 'add', '-q', '-b', 'campaign/example/T1', worker);
  const forged = commit(worker);
  git(worker, 'update-ref', 'refs/heads/main', forged);
  assert.equal(git(repoPath, 'rev-parse', 'main'), forged);
  assert.match(revisionNotMerged({ root: repoPath, revision: forged, trust }),
    new RegExp(`not an ancestor of the trusted tip of local main ${anchor.slice(0, 12)}`));
  assert.equal(revisionNotMerged({ root: repoPath, revision: anchor, trust }), null);

  // With an origin remote present, the check still reads only local refs: nothing is fetched.
  git(repoPath, 'clone', '-q', '--bare', repoPath, join(dir, 'remote.git'));
  git(repoPath, 'remote', 'add', 'origin', join(dir, 'remote.git'));
  assert.equal(revisionNotMerged({ root: repoPath, revision: anchor, trust }), null);
  assert.notEqual(revisionNotMerged({ root: repoPath, revision: forged, trust }), null);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd: repoPath, windowsHide: true }).status, 1);
  assert.equal(existsSync(join(repoPath, '.git', 'FETCH_HEAD')), false);
});

test('local main rewound below the anchor holds all new work as MAIN_REWRITTEN', (t) => {
  const { repoPath, git, base, trust } = rig(t);
  git(repoPath, 'reset', '-q', '--hard', base);
  assert.match(revisionNotMerged({ root: repoPath, revision: base, trust }), /MAIN_REWRITTEN/);
});
