// The local merge of AIWorks's own repository with local main trusted (docs/design/LOCAL_OPERATION.md section 4.4, slice
// SELF8). Ref moves live only under src/supervisor/release/ (the REL5 boundary, tests/supervisor/release-boundary.test.mjs);
// ../merge.mjs decides when to call these. They write a merge commit object and move local main from the trusted tip to
// it, nothing else: never a force, a `+` refspec, another ref, a push, a fetch or a remote.
import { exec } from '../adapters/git.mjs';

const SHA = /^[0-9a-f]{40}$/;
const MAIN = 'refs/heads/main';

const read = (git, repoPath, args) => {
  const out = exec(git, args, { cwd: repoPath, timeoutMs: 30_000 });
  return out.ok ? out.stdout : null;
};
const treeOf = (git, repoPath, sha) => read(git, repoPath, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]);

/**
 * A commit's tree and parents, or null when it cannot be read. Read-only. Used to recognize the planned merge commit
 * after a crash: same parents in the same order, and the verified tree.
 */
export function commitShape({ git, repoPath, sha }) {
  if (!SHA.test(sha ?? '')) return null;
  const parents = read(git, repoPath, ['rev-list', '--parents', '--max-count=1', sha]);
  const tree = treeOf(git, repoPath, sha);
  if (!parents || !SHA.test(tree ?? '')) return null;
  return { sha, tree, parents: parents.split(/\s+/).slice(1) };
}

/** Whether `sha` is the merge commit planned for `trusted` and `verified`: exactly those two parents, the verified tree. */
export function isPlannedMerge({ git, repoPath, sha, trusted, verified }) {
  const shape = commitShape({ git, repoPath, sha }), tree = treeOf(git, repoPath, verified);
  return Boolean(shape && SHA.test(tree ?? '') && shape.tree === tree && shape.parents.length === 2
    && shape.parents[0] === trusted && shape.parents[1] === verified);
}

/**
 * Write the merge commit: the verified tree, the trusted tip as first parent and the verified head as second. It writes
 * objects only; no ref moves. Returns { ok: true, commit, tree }, or { ok: false, reason } when the commit cannot be made
 * or its tree is not the verified tree, so nothing may move.
 */
export function writeMergeCommit({ git, repoPath, trusted, verified, message }) {
  if (!SHA.test(trusted ?? '') || !SHA.test(verified ?? '')) return { ok: false, reason: 'a local merge needs the full trusted and verified SHAs' };
  const tree = treeOf(git, repoPath, verified);
  if (!SHA.test(tree ?? '')) return { ok: false, reason: `the verified tree of ${verified} cannot be read` };
  const out = exec(git, ['commit-tree', `${verified}^{tree}`, '-p', trusted, '-p', verified, '-F', '-'], { cwd: repoPath, input: `${message}\n`, timeoutMs: 60_000 });
  if (!out.ok || !SHA.test(out.stdout)) return { ok: false, reason: `commit-tree failed: ${out.stderr || out.error || `exit ${out.status}`}`.slice(0, 500) };
  if (!isPlannedMerge({ git, repoPath, sha: out.stdout, trusted, verified })) {
    return { ok: false, reason: `the merge commit ${out.stdout} does not carry the verified tree ${tree} with parents ${trusted} and ${verified}` };
  }
  return { ok: true, commit: out.stdout, tree };
}

/**
 * Move local main from `trusted` to `commit`, only from there. With `checkout` (the clean worktree that has main checked
 * out, checked by the caller) a fast-forward merge in that checkout, so the owner's files follow; otherwise a ref update
 * that names the old value, so Git refuses when main moved in between. Returns { ok, reason }; on success main is `commit`.
 */
export function moveMain({ git, repoPath, trusted, commit, checkout = null }) {
  if (!SHA.test(trusted ?? '') || !SHA.test(commit ?? '')) return { ok: false, reason: 'moving main needs full SHAs' };
  const main = () => read(git, checkout ?? repoPath, ['rev-parse', '--verify', '--quiet', `${MAIN}^{commit}`]);
  if (main() !== trusted) return { ok: false, reason: 'main is no longer at the trusted tip' };
  const out = checkout
    ? exec(git, ['merge', '--ff-only', '--no-edit', commit], { cwd: checkout, timeoutMs: 120_000 })
    : exec(git, ['update-ref', MAIN, commit, trusted], { cwd: repoPath, timeoutMs: 30_000 });
  if (!out.ok) return { ok: false, reason: `main was not moved: ${out.stderr || out.error || `exit ${out.status}`}`.slice(0, 500) };
  if (main() !== commit) return { ok: false, reason: 'main is not at the merge commit after the move' };
  return { ok: true };
}
