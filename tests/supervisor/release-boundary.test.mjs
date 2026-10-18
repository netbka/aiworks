// REL5 (AUTO_RELEASE slice R5, section 6): merge, deploy and apply calls, and the release credential, live only under
// src/supervisor/release/. A static scan of every source file under src/; the scanner is first shown to catch each
// kind of call, so an empty answer means something. The one exception is named with its reason.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ROOT } from './helpers.mjs';

const RELEASE_DIR = 'src/supervisor/release/';

/** The release powers: who may merge, deploy, apply or hold the release credential. */
const RULES = [
  ['gh pr merge', /\bpr\s+merge\b/],
  ['gh pr merge (argument array)', /['"`]pr['"`]\s*,\s*['"`]merge['"`]/],
  // A programmatic git merge. Prose such as the integration-repair instruction, where a worker merges the base into its
  // own task branch (aiworks#27), is not a release and is not matched.
  ['git merge (argument array)', /['"`]merge['"`]\s*[,\]]/],
  ['REST merge of a pull request', /pulls\/[^'"`\s]*\/merge\b/],
  ['REST merge of a branch', /repos\/[^'"`\s]*\/merges\b/],
  ['GraphQL merge', /\b(mergePullRequest|enablePullRequestAutoMerge)\b/],
  ["a project's deploy or rollback command", /\bcommands\s*\??\.\s*(deploy|rollback)\b|\bcommands\s*\[\s*['"`](deploy|rollback)['"`]\s*\]/],
  ['a deploy call', /\bdeploy\s*\(/],
  ['fast-forward apply', /['"`]--ff-only['"`]/],
  ['moving a ref', /\bupdate-ref\b/],
  ['the release backup ref', /refs\/aiworks\/release-backup/],
  ['a GitHub token in an environment', /\b(GH_TOKEN|GITHUB_TOKEN)\b/],
  ['fetching the release credential', /\bfetchCredential\b/],
];

/** Text outside release/ that matches a rule but is not a call: [file, exact text, why]. */
const ALLOWED = [
  ['src/supervisor/adapters/claude.mjs', "'Bash(gh pr merge:*)'", 'the worker deny list: it forbids the call'],
];

/** Every match of a rule in one file's text: [{ file, line, rule, text }]. Matches under release/ are allowed. */
function scan(file, text) {
  if (file.startsWith(RELEASE_DIR)) return [];
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [rule, pattern] of RULES) {
      if (!pattern.test(line)) continue;
      if (ALLOWED.some(([path, exact]) => path === file && line.includes(exact) && !pattern.test(line.replace(exact, '')))) continue;
      found.push({ file, line: index + 1, rule, text: line.trim().slice(0, 160) });
    }
  });
  return found;
}

const sources = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
  return /\.(mjs|cjs|js|ps1)$/.test(entry.name) ? [relative(ROOT, path).split(sep).join('/')] : [];
});

test('the scanner catches every kind of release call outside src/supervisor/release/', () => {
  const calls = [
    "spawn('gh', ['pr', 'merge', String(n), '--squash'])",
    "run(`gh pr merge ${n} --match-head-commit ${sha}`)",
    "git(repo, 'merge', '--ff-only', sha)",
    "gh(['api', '-X', 'PUT', `repos/${repo}/pulls/${n}/merge`])",
    "gh(['api', `repos/${repo}/merges`])",
    'mutation { mergePullRequest(input: $input) { clientMutationId } }',
    'run(destination.commands.deploy, sha)',
    "run(destination.commands?.rollback)",
    "run(destination.commands['deploy'])",
    'await adapter.deploy(release)',
    "git(repo, 'update-ref', 'refs/heads/main', sha)",
    "const backup = `refs/aiworks/release-backup/${id}`",
    'env: { ...env, GH_TOKEN: token }',
    'const token = fetchCredential(store, ref)',
  ];
  for (const call of calls) {
    assert.ok(scan('src/supervisor/controller.mjs', call).length > 0, `missed: ${call}`);
    assert.deepEqual(scan(`${RELEASE_DIR}github-merge.mjs`, call), [], `under release/ it is allowed: ${call}`);
  }
  // The allowance is exact: the deny-list entry passes, a call beside it on the same line does not.
  assert.deepEqual(scan('src/supervisor/adapters/claude.mjs', "['Bash(gh pr merge:*)']"), []);
  assert.ok(scan('src/supervisor/adapters/claude.mjs', "['Bash(gh pr merge:*)']; spawn('gh', ['pr', 'merge'])").length > 0);
  assert.equal(scan('src/supervisor/coordinator.mjs', "'Bash(gh pr merge:*)'").length, 1, 'only in the file it is named for');
  // Words that are not calls stay quiet: the dashboard's merge check, its apply command, a merge-base query.
  for (const quiet of ["run(this.git, ['merge-base', '--is-ancestor', sha, tip])", '`git merge-tree --write-tree`', 'applyCommand(body)', "'Review and merge'", 'deployedDigest']) {
    assert.deepEqual(scan('src/dashboard/merges.mjs', quiet), [], quiet);
  }
});

test('merge, deploy and apply calls and the release credential live only in src/supervisor/release/', () => {
  const files = sources(join(ROOT, 'src'));
  assert.ok(files.length > 20 && files.includes('src/supervisor/controller.mjs'), 'the scan sees the source tree');
  const found = files.flatMap((file) => scan(file, readFileSync(join(ROOT, file), 'utf8')));
  assert.deepEqual(found, [], found.map((item) => `${item.file}:${item.line} ${item.rule}: ${item.text}`).join('\n'));
  // Not vacuous: the release runner is where the credential is fetched and handed to its one command.
  const runner = readFileSync(join(ROOT, RELEASE_DIR, 'runner.mjs'), 'utf8');
  assert.match(runner, /\bfetchCredential\b/);
  assert.match(runner, /\bGH_TOKEN\b/);
  // Every allowance still matches real text, so a stale one cannot hide a new call.
  for (const [file, exact] of ALLOWED) assert.ok(readFileSync(join(ROOT, file), 'utf8').includes(exact), `${file} no longer holds ${exact}`);
});
