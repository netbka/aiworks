// AIWorks GitHub adapter through the existing authenticated gh CLI. No GitHub Actions,
// no new identity. Creation calls are preceded by a lookup so a retry after an unknown
// outcome reconciles instead of duplicating (no exactly-once promise).
import { writeFileSync } from 'node:fs';
import { exec } from './git.mjs';

export function findOpenPullRequest({ gh, repository, branch }) {
  const out = exec(gh, ['pr', 'list', '--repo', repository, '--head', branch, '--state', 'open', '--json', 'url,headRefOid']);
  if (!out.ok) throw new Error(`gh pr list failed: ${out.stderr || out.error}`.slice(0, 500));
  const list = JSON.parse(out.stdout || '[]');
  return list[0] ?? null;
}

/** Read-only merge receipt, bound to the exact published PR, reviewed head and base. */
export function integratedPullRequest({ gh, repository, url, headSha, baseBranch }) {
  const prefix = `https://github.com/${repository}/pull/`;
  if (!url?.startsWith(prefix) || !/^[1-9]\d*$/.test(url.slice(prefix.length))) return null;
  const out = exec(gh, ['pr', 'view', url.slice(prefix.length), '--repo', repository,
    '--json', 'url,state,headRefOid,baseRefName,mergeCommit'], { timeoutMs: 30_000 });
  if (!out.ok) return null;
  try {
    const receipt = JSON.parse(out.stdout);
    return receipt.url === url && receipt.state === 'MERGED' && receipt.headRefOid === headSha &&
      receipt.baseRefName === baseBranch && /^[0-9a-f]{40}$/.test(receipt.mergeCommit?.oid ?? '') ? receipt.mergeCommit.oid : null;
  } catch { return null; }
}

export function openPullRequest({ gh, repository, baseBranch, branch, title, body, bodyFile }) {
  const existing = findOpenPullRequest({ gh, repository, branch });
  if (existing) return existing.url;
  writeFileSync(bodyFile, body, 'utf8');
  const out = exec(gh, ['pr', 'create', '--repo', repository, '--base', baseBranch, '--head', branch, '--title', title, '--body-file', bodyFile]);
  if (!out.ok) {
    const again = findOpenPullRequest({ gh, repository, branch });
    if (again) return again.url;
    throw new Error(`gh pr create failed: ${out.stderr || out.error}`.slice(0, 500));
  }
  return out.stdout.split('\n').filter(Boolean).pop();
}

export const marker = (key) => `<!-- aiworks:${key} -->`;

/** URL of the comment carrying this marker, or null. */
export function findMarkedComment({ gh, repository, issue, key }) {
  const out = exec(gh, ['api', `repos/${repository}/issues/${issue}/comments`, '--paginate',
    '--jq', `.[] | select(.body | contains(${JSON.stringify(marker(key))})) | .html_url`]);
  if (!out.ok) throw new Error(`gh api comments failed: ${out.stderr || out.error}`.slice(0, 500));
  return out.stdout.split('\n').filter(Boolean)[0] ?? null;
}

export function postComment({ gh, repository, issue, body, bodyFile }) {
  writeFileSync(bodyFile, body, 'utf8');
  const out = exec(gh, ['issue', 'comment', String(issue), '--repo', repository, '--body-file', bodyFile]);
  if (!out.ok) throw new Error(`gh issue comment failed: ${out.stderr || out.error}`.slice(0, 500));
  return out.stdout.split('\n').filter(Boolean).pop();
}
