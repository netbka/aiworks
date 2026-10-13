// Runtime code must be merged. Campaign declarations are private operator data.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CampaignError } from './api.mjs';
import { SECRET_LIKE_PATH_PATTERN } from '../../scripts/lib/worker-context.mjs';
export const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN = 'refs/remotes/origin/main';
const secretPath = new RegExp(SECRET_LIKE_PATH_PATTERN, 'u');
function run(args, cwd) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: !out.error && out.status === 0, status: out.error ? null : out.status, stdout: out.stdout ?? '', stderr: String(out.stderr ?? '').trim() };
}
export function revisionNotMerged({ root = CODE_ROOT, revision = 'HEAD' } = {}) {
  if (!revision) return 'the supervisor code revision is unknown';
  const head = run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], root);
  if (!head.ok) return `revision ${revision} cannot be resolved in the supervisor checkout`;
  const main = run(['rev-parse', '--verify', '--quiet', `${MAIN}^{commit}`], root);
  if (!main.ok) return 'origin/main is not available in the supervisor checkout (fetch origin)';
  const [sha, mainSha] = [head.stdout.trim(), main.stdout.trim()];
  const ancestor = run(['merge-base', '--is-ancestor', sha, mainSha], root);
  if (ancestor.ok) return null;
  return ancestor.status === 1
    ? `supervisor code ${sha.slice(0, 12)} is not merged: it is not an ancestor of origin/main ${mainSha.slice(0, 12)}`
    : `supervisor code ${sha.slice(0, 12)} cannot be compared with origin/main: ${ancestor.stderr.slice(0, 200) || `exit ${ancestor.status}`}`;
}
/** campaignStart validates owner authority and immutable scope after reading this local file. */
export function declarationFromFile(file, { root = CODE_ROOT } = {}) {
  const notMerged = revisionNotMerged({ root });
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
    throw new CampaignError('DECLARATION_INVALID', `Cannot read the local declaration (${error.code ?? error.name}).`);
  }
}
