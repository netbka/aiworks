// The supervisor's one pull request merge call, for the merge gate (aiworks#138). Merge calls live only under
// src/supervisor/release/ (the REL5 boundary, tests/supervisor/release-boundary.test.mjs); ../merge.mjs decides when
// to call it. It uses the operator's existing gh login, never the release credential, and only merges: it never
// deploys, releases or changes provider resources.
import { rest } from '../adapters/github.mjs';

const SHA = /^[0-9a-f]{40}$/;

/**
 * Merge with a merge commit: PUT repos/{repo}/pulls/{n}/merge with merge_method=merge and sha=<verified>, so GitHub
 * refuses if the head moved. Never a squash, a rebase, an admin bypass or a branch deletion. Returns the merge commit;
 * throws when GitHub refuses or the outcome is unknown, and the caller reads the pull request before any retry.
 */
export function mergeWithMergeCommit({ gh, repository, number, sha }) {
  if (!SHA.test(sha ?? '')) throw new Error('a merge needs the full verified SHA');
  const result = rest(gh, 'PUT merge', ['--method', 'PUT', `repos/${repository}/pulls/${number}/merge`,
    '-f', 'merge_method=merge', '-f', `sha=${sha}`], { timeoutMs: 60_000 });
  if (result?.merged !== true || !SHA.test(result.sha ?? '')) throw new Error(`PUT merge returned no merge commit: ${JSON.stringify(result)}`.slice(0, 500));
  return { mergeCommit: result.sha };
}
