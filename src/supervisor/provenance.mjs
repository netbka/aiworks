// AW-005 (docs/DECISIONS.md): a campaign runs only from merged supervisor code, with its declaration file in campaigns/ on
// main. These checks only read git state. They never fetch, write the index or move a ref. None of them can be switched
// off from the CLI, config.json or the environment, and they always run the `git` on PATH: config.json `commands.git`
// is not used here, so a configured command cannot answer "merged" in git's place.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CampaignError } from './api.mjs';
import { canonicalJson } from './campaign.mjs';

/** The checkout this code runs from: on HomePc the pinned runtime checkout `.local/runtime`. */
export const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT = 'git';
const MAIN = 'refs/remotes/origin/main';
// "On main", exactly: committed in campaigns/ in a revision merged to main and used unmodified, at a runtime HEAD that is
// an ancestor of origin/main. Main's tip is not the rule: an older merged revision, or an older merged version of a
// declaration, qualifies.
const RULE = 'a campaign runs only from merged supervisor code with its declaration on main: committed in campaigns/ ' +
  'in a revision merged to main and used unmodified, at a runtime HEAD that is an ancestor of origin/main; main\'s tip is not ' +
  'required (AW-005)';

function run(args, cwd) {
  const out = spawnSync(GIT, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: !out.error && out.status === 0, status: out.error ? null : out.status, stdout: out.stdout ?? '', stderr: String(out.stderr ?? '').trim() };
}

/** Blob contents for `<commit>:<path>` specs through one `git cat-file --batch`; a missing object is left out. */
function readBlobs(specs, cwd) {
  if (!specs.length) return [];
  const out = spawnSync(GIT, ['cat-file', '--batch'],
    { cwd, input: `${specs.join('\n')}\n`, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (out.error || out.status !== 0) return [];
  const blobs = [];
  let at = 0;
  for (const spec of specs) {
    const end = out.stdout.indexOf(0x0a, at);
    if (end < 0) break;
    const header = /^[0-9a-f]+ (\w+) (\d+)$/.exec(out.stdout.subarray(at, end).toString('utf8'));
    at = end + 1;
    if (!header) continue; // "<spec> missing"
    const size = Number(header[2]);
    if (header[1] === 'blob') blobs.push({ spec, text: out.stdout.subarray(at, at + size).toString('utf8') });
    at += size + 1;
  }
  return blobs;
}

// A checkout may convert line endings (core.autocrlf); that alone is not a modification.
const lf = (text) => text.replace(/\r\n/g, '\n');

/**
 * Null when `revision` of the checkout at `root` is an ancestor of origin/main there (so origin/main moving ahead is
 * fine); otherwise the reason it is not. An unknown revision, a missing origin/main or a failed comparison count as
 * not merged.
 */
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

/**
 * The declaration `cli.mjs start <file>` may register, amend or resume, read from its committed blob. Refused with
 * DECLARATION_NOT_ON_MAIN unless the file resolves to campaigns/<name>.json of the checkout at `root` (the checkout the
 * CLI runs from) and is committed and unmodified at its HEAD; refused with RUNTIME_NOT_MERGED unless that HEAD is an
 * ancestor of origin/main.
 */
export function declarationFromMain(file, { root = CODE_ROOT } = {}) {
  let campaigns, path;
  try {
    campaigns = realpathSync.native(join(root, 'campaigns'));
    path = realpathSync.native(resolve(String(file ?? '')));
  } catch (error) {
    throw new CampaignError('DECLARATION_NOT_ON_MAIN', `declaration ${file} cannot be read (${error.code ?? error.message}); ${RULE}`);
  }
  const name = relative(campaigns, path);
  if (!name || isAbsolute(name) || /[\\/]/.test(name) || name.startsWith('..') || !name.endsWith('.json')) {
    throw new CampaignError('DECLARATION_NOT_ON_MAIN', `${file} is not a file in ${campaigns}; ${RULE}`);
  }
  const tracked = `campaigns/${name}`;
  const blob = run(['cat-file', 'blob', `HEAD:${tracked}`], root);
  if (!blob.ok) throw new CampaignError('DECLARATION_NOT_ON_MAIN', `${tracked} is not committed at this checkout's HEAD; ${RULE}`);
  if (lf(readFileSync(path, 'utf8')) !== lf(blob.stdout)) {
    throw new CampaignError('DECLARATION_NOT_ON_MAIN', `${tracked} differs from its committed version at HEAD; ${RULE}`);
  }
  const notMerged = revisionNotMerged({ root });
  if (notMerged) throw new CampaignError('RUNTIME_NOT_MERGED', `${notMerged}; ${RULE}`);
  return JSON.parse(blob.stdout);
}

/**
 * Dashboard Resume has no file: the stored declaration must equal, canonically, a version of a campaigns/ file committed
 * in a revision merged to main, that is, at some commit in origin/main's history (all paths, merges included). It does
 * not have to be the version at main's tip. Returns `<commit>:<path>`, or throws DECLARATION_NOT_ON_MAIN. The dashboard
 * runs no work itself, so its own revision is not checked here; the controller checks the revision that runs the work.
 */
export function storedDeclarationOnMain(declaration, { root = CODE_ROOT } = {}) {
  const history = run(['log', '-m', '--full-history', '--format=commit %H', '--name-only', MAIN, '--', 'campaigns/'], root);
  if (!history.ok) throw new CampaignError('DECLARATION_NOT_ON_MAIN', `origin/main is not available to check campaign ${declaration?.campaignId}; ${RULE}`);
  const own = `campaigns/${declaration?.campaignId}.json`;
  const versions = new Set();
  let commit = null;
  for (const line of history.stdout.split(/\r?\n/).map((item) => item.trim())) {
    const header = /^commit ([0-9a-f]{40,64})$/.exec(line);
    if (header) commit = header[1];
    else if (commit && /^campaigns\/[^/]+\.json$/.test(line)) versions.add(`${commit}:${line}`);
  }
  // The campaign's own file first; any other committed declaration file may hold it too.
  const specs = [...versions].sort((a, b) => Number(b.endsWith(`:${own}`)) - Number(a.endsWith(`:${own}`)));
  const want = canonicalJson(declaration);
  for (const { spec, text } of readBlobs(specs, root)) {
    try { if (canonicalJson(JSON.parse(text)) === want) return spec; } catch { /* not a declaration */ }
  }
  throw new CampaignError('DECLARATION_NOT_ON_MAIN',
    `campaign ${declaration?.campaignId}'s stored declaration is not committed in campaigns/ in any revision merged to main; resume it with cli.mjs start <campaigns file> from a merged runtime instead. ${RULE}`);
}
