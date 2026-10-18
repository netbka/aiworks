// Runtime code must be merged. Campaign declarations and envelope approvals are private operator data.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CampaignError } from './api.mjs';
import { SECRET_LIKE_PATH_PATTERN } from '../../scripts/lib/worker-context.mjs';
import { selfHostingSettings, trustedTip } from './self-hosting.mjs';
export const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN = 'refs/remotes/origin/main';
const secretPath = new RegExp(SECRET_LIKE_PATH_PATTERN, 'u');
function run(args, cwd) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: !out.error && out.status === 0, status: out.error ? null : out.status, stdout: out.stdout ?? '', stderr: String(out.stderr ?? '').trim() };
}
/**
 * The trusted main of the runtime (AW-005, docs/design/LOCAL_OPERATION.md section 4.3): null while it is origin/main
 * (today's, the default), or the main ledger of AIWorks's own repository when config.json `selfHosting.trustedMain` is
 * "local". The runtime is AIWorks itself, so the setting's repository is the one its checkout belongs to.
 */
export function runtimeTrust(config, store, { log } = {}) {
  const settings = selfHostingSettings(config, { log });
  return settings.local && store ? Object.freeze({ store, repository: settings.repository }) : null;
}
/**
 * Why `revision` may not start new work, or null when it is an ancestor of the trusted main: origin/main, or with
 * `trust` (runtimeTrust) the trusted tip of local main. Read-only: never fetches and never moves a ref.
 */
export function revisionNotMerged({ root = CODE_ROOT, revision = 'HEAD', trust = null } = {}) {
  if (!revision) return 'the supervisor code revision is unknown';
  const head = run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], root);
  if (!head.ok) return `revision ${revision} cannot be resolved in the supervisor checkout`;
  if (trust) return notOnLocalMain(head.stdout.trim(), root, trust);
  const main = run(['rev-parse', '--verify', '--quiet', `${MAIN}^{commit}`], root);
  if (!main.ok) return 'origin/main is not available in the supervisor checkout (fetch origin)';
  const [sha, mainSha] = [head.stdout.trim(), main.stdout.trim()];
  const ancestor = run(['merge-base', '--is-ancestor', sha, mainSha], root);
  if (ancestor.ok) return null;
  return ancestor.status === 1
    ? `supervisor code ${sha.slice(0, 12)} is not merged: it is not an ancestor of origin/main ${mainSha.slice(0, 12)}`
    : `supervisor code ${sha.slice(0, 12)} cannot be compared with origin/main: ${ancestor.stderr.slice(0, 200) || `exit ${ancestor.status}`}`;
}
// A commit on local main that no ledger row put there is not trusted, so a worker that moves main by hand trusts nothing.
function notOnLocalMain(sha, root, { store, repository }) {
  const tip = trustedTip(store, { repoPath: root, repository });
  if (tip.state === 'MAIN_REWRITTEN') return `local main is not trusted (MAIN_REWRITTEN): ${tip.reason}`;
  if (tip.state !== 'TRUSTED') return `local main has no trusted tip in the supervisor checkout: ${tip.reason}`;
  const ancestor = run(['merge-base', '--is-ancestor', sha, tip.tip], root);
  if (ancestor.ok) return null;
  return ancestor.status === 1
    ? `supervisor code ${sha.slice(0, 12)} is not merged: it is not an ancestor of the trusted tip of local main ${tip.tip.slice(0, 12)}`
    : `supervisor code ${sha.slice(0, 12)} cannot be compared with the trusted tip of local main: ${ancestor.stderr.slice(0, 200) || `exit ${ancestor.status}`}`;
}
/** A private local JSON file, read only by merged runtime code. `code` and `what` name the refusal of an unreadable file. */
function privateJson(file, root, code, what, trust) {
  const notMerged = revisionNotMerged({ root, trust });
  if (notMerged) throw new CampaignError('RUNTIME_NOT_MERGED', notMerged);
  try {
    const requested = resolve(String(file ?? ''));
    if (secretPath.test(requested.replaceAll('\\', '/').toLowerCase())) throw new Error('Not a declaration path');
    const path = realpathSync.native(requested);
    if (secretPath.test(path.replaceAll('\\', '/').toLowerCase())) throw new Error('Not a declaration path');
    const stat = statSync(path);
    if (extname(path) !== '.json' || !stat.isFile() || stat.size > 1024 * 1024) throw new Error('Expected a JSON declaration of at most 1 MiB');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // Never echo private file contents or parser snippets into diagnostics.
    throw new CampaignError(code, `Cannot read the local ${what} (${error.code ?? error.name}).`);
  }
}
/** campaignStart validates owner authority and immutable scope after reading this local file. */
export function declarationFromFile(file, { root = CODE_ROOT, trust = null } = {}) {
  return privateJson(file, root, 'DECLARATION_INVALID', 'declaration', trust);
}
/** The owner's private envelope approval (WORK_ENVELOPE.md section 5, slice E7); approvals.mjs checks what it binds. */
export function approvalFromFile(file, { root = CODE_ROOT, trust = null } = {}) {
  return privateJson(file, root, 'APPROVAL_INVALID', 'approval', trust);
}
