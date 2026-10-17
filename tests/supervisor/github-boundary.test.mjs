// SELF1 (docs/design/LOCAL_OPERATION.md L1, section 3): every place AIWorks calls GitHub today, pinned by a static
// scan of src/ and scripts/. The scanner is first shown to catch each call form in a temporary copy of the tree, so an
// empty answer means something; then the real tree must match the list below exactly. A new call site fails with its
// file:line. Each later SELF slice removes the sites it retires from SITES.
//
// A site is named by its file, its line at e0ff151 (the revision section 3 cites) and the start of its text. The match
// is by text, not line number: an edit elsewhere in the file moves lines but keeps the list valid, while a new or edited
// site fails and names its current file:line.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { ROOT } from './helpers.mjs';

const SCANNED = ['src', 'scripts'];

/** The call forms of section 3.1: the gh command, its REST host, and Git commands that talk to the origin remote. */
const RULES = [
  // gh as a word (gh api, gh issue view, a gh argument) or a name built on it (ghCommand, ghRun, ghRead).
  ['the gh command', /\bgh(?:[A-Z]\w*)?\b/],
  ['gh api (argument array)', /['"`]api['"`]\s*,/],
  ['the GitHub REST host', /api\.github\.com/],
  ['git fetch, push or ls-remote against origin (argument array)', /['"`](?:fetch|push|ls-remote)['"`]\s*,.*['"`]origin['"`]/],
  ['git fetch, push or ls-remote against origin (command text)', /\b(?:fetch|push|ls-remote)\s+(?:-[\w-]+\s+)*origin\b(?!\/)/],
];

/** Section 3.1: every line the call forms reach, with its row. [row, file, line at e0ff151, start of the trimmed line]. */
const SITES = [
['G30', 'src/dashboard/merges.mjs', 135, "const fetched = await run(this.git, ['fetch', '-"],
  ['G31', 'src/dashboard/projects.mjs', 336, "* §4.1). `inject` is for tests only (synthetic g"],
  ['G31', 'src/dashboard/server.mjs', 33, "* GitHub project with read-only gh calls; `proje"],
  ['G19', 'src/supervisor/adapters/claude.mjs', 177, "`Read the task issue (gh issue view ${issue} --repo ${repository}) unless a packet constraint restricts what you may read;"],
  ['G19', 'src/supervisor/adapters/claude.mjs', 190, "`Read the full task issue first: gh issue view $"],
  ['G19', 'src/supervisor/adapters/claude.mjs', 198, "`Read the task issue (gh issue view ${issue} --repo ${repository}) unless a packet constraint restricts what you may read."],
  ['G17', 'src/supervisor/adapters/executors.mjs', 173, "export function unavailableReason(executor, work"],
  ['G17', 'src/supervisor/adapters/executors.mjs', 195, "if (executor.kind === 'codex-cli' && ghCommand &"],
  ['G18', 'src/supervisor/adapters/executors.mjs', 238, "export function prepare({ executor, command, rol"],
  ['G18', 'src/supervisor/adapters/executors.mjs', 271, "const readerServer = repository && ghCommand ? {"],
  ['G18', 'src/supervisor/adapters/executors.mjs', 273, "args: [fileURLToPath(new URL('../github-reader.m"],
  ['G18', 'src/supervisor/adapters/executors.mjs', 275, "const readerInstructions = readerServer ? '\\nFor"],
  ['G18', 'src/supervisor/adapters/executors.mjs', 287, "const reader = executor.kind === 'codex-cli' && "],
  ['G24', 'src/supervisor/adapters/git.mjs', 33, "if (!baseSha) must(exec(git, ['fetch', 'origin',"],
  ['G25', 'src/supervisor/adapters/git.mjs', 91, "must(exec(git, ['push', 'origin', `${sha}:refs/h"],
  ['G25', 'src/supervisor/adapters/git.mjs', 92, "const remote = must(exec(git, ['ls-remote', 'ori"],
  ['G26', 'src/supervisor/adapters/git.mjs', 103, "const out = exec(git, ['ls-remote', 'origin', pa"],
  ['G2', 'src/supervisor/adapters/github.mjs', 1, "// AIWorks GitHub adapter through the existing a"],
  ['G2', 'src/supervisor/adapters/github.mjs', 4, "// Every call is REST (gh api), never GraphQL: t"],
  ['G2', 'src/supervisor/adapters/github.mjs', 14, "/** Split `gh api --include` output into status,"],
  ['G2', 'src/supervisor/adapters/github.mjs', 41, "export function rest(gh, what, args, { timeoutMs"],
  ['G2', 'src/supervisor/adapters/github.mjs', 42, "const out = exec(gh, ['api', '--include', ...arg"],
  ['G3', 'src/supervisor/adapters/github.mjs', 53, "export function findOpenPullRequest({ gh, reposi"],
  ['G3', 'src/supervisor/adapters/github.mjs', 55, "const list = rest(gh, 'GET pulls', ['--method', "],
  ['G4', 'src/supervisor/adapters/github.mjs', 62, "export function integratedPullRequest({ gh, repo"],
  ['G4', 'src/supervisor/adapters/github.mjs', 66, "const receipt = rest(gh, 'GET pull', ['--method'"],
  ['G5', 'src/supervisor/adapters/github.mjs', 76, "export function pullRequest({ gh, repository, nu"],
  ['G5', 'src/supervisor/adapters/github.mjs', 77, "const pr = rest(gh, 'GET pull', ['--method', 'GE"],
  ['G6', 'src/supervisor/adapters/github.mjs', 102, "export function commitChecks({ gh, repository, s"],
  ['G6', 'src/supervisor/adapters/github.mjs', 103, "return ciState(rest(gh, 'GET check-runs', ['--me"],
  ['G7', 'src/supervisor/adapters/github.mjs', 108, "* slice E9): a `declare/...` branch, the former "],
  ['G7', 'src/supervisor/adapters/github.mjs', 112, "export function openPullRequest({ gh, repository"],
  ['G7', 'src/supervisor/adapters/github.mjs', 116, "const existing = findOpenPullRequest({ gh, repos"],
  ['G7', 'src/supervisor/adapters/github.mjs', 121, "created = rest(gh, 'POST pulls', ['--method', 'P"],
  ['G7', 'src/supervisor/adapters/github.mjs', 127, "const again = findOpenPullRequest({ gh, reposito"],
  ['G8', 'src/supervisor/adapters/github.mjs', 138, "export function findMarkedComment({ gh, reposito"],
  ['G8', 'src/supervisor/adapters/github.mjs', 139, "const out = exec(gh, ['api', `repos/${repository"],
  ['G8', 'src/supervisor/adapters/github.mjs', 141, "if (!out.ok) throw new Error(`gh api comments fa"],
  ['G9', 'src/supervisor/adapters/github.mjs', 145, "export function postComment({ gh, repository, is"],
  ['G9', 'src/supervisor/adapters/github.mjs', 147, "const created = rest(gh, 'POST comment', ['--met"],
  ['G20', 'src/supervisor/adapters/research-context.mjs', 12, "export function researchContext({ gh, git, works"],
  ['G20', 'src/supervisor/adapters/research-context.mjs', 42, "const out = exec(gh, ['api', '--hostname', 'gith"],
  ['G20', 'src/supervisor/adapters/research-context.mjs', 46, "const base = `https://api.github.com/repos/${rep"],
  ['G20', 'src/supervisor/adapters/research-context.mjs', 104, "return `\\nRead-only broker snapshot. The followi"],
  ['G1', 'src/supervisor/controller.mjs', 435, "claude: commands.claude ?? ['claude'], git: comm"],
  ['G28', 'src/supervisor/controller.mjs', 701, "requestedAction: 'Deploy a revision of origin/ma"],
  ['G12', 'src/supervisor/controller.mjs', 1224, "const mergedSha = github.integratedPullRequest({"],
  ['G27', 'src/supervisor/controller.mjs', 1236, "const fetched = gitA.exec(this.cmd.git, ['fetch'"],
  ['G13', 'src/supervisor/controller.mjs', 1381, "read = github.commitChecks({ gh: this.cmd.gh, re"],
  ['G13', 'src/supervisor/controller.mjs', 1383, "if (read.state === 'failure') read.pr = github.f"],
  ['G14', 'src/supervisor/controller.mjs', 1554, "const merged = github.integratedPullRequest({ gh"],
  ['G17', 'src/supervisor/controller.mjs', 1854, "const reason = executors.unavailableReason(provi"],
  ['G20', 'src/supervisor/controller.mjs', 2121, "try { prompt += researchContext({ gh: this.cmd.g"],
  ['G17', 'src/supervisor/controller.mjs', 2128, "const unavailable = executors.unavailableReason("],
  ['G18', 'src/supervisor/controller.mjs', 2139, "repository: decl.target.repository, ghCommand: t"],
  ['G15', 'src/supervisor/controller.mjs', 2253, "const existing = github.findOpenPullRequest({ gh"],
  ['G15', 'src/supervisor/controller.mjs', 2267, "const target = { gh: this.cmd.gh, repository: decl.target.repository, issue: Number(number), key "],
  ['G15', 'src/supervisor/controller.mjs', 2283, "url = github.openPullRequest({ gh: this.cmd.gh, "],
  ['G15', 'src/supervisor/controller.mjs', 2289, "const target = { gh: this.cmd.gh, repository: decl.target.repository, issue: Number(number), key:"],
  ['G15', 'src/supervisor/controller.mjs', 2296, "const target = { gh: this.cmd.gh, repository: decl.target.repository, issue: s"],
  ['G16', 'src/supervisor/controller.mjs', 2768, "// status and the journal, and gh is never calle"],
  ['G16', 'src/supervisor/controller.mjs', 2790, "if (github.findMarkedComment({ gh: this.cmd.gh, "],
  ['G16', 'src/supervisor/controller.mjs', 2795, "const url = github.postComment({ gh: this.cmd.gh"],
  ['G21', 'src/supervisor/coordinator.mjs', 83, "'Bash(gh issue list:*)', 'Bash(gh issue view:*)'"],
  ['G21', 'src/supervisor/coordinator.mjs', 84, "'Bash(gh pr checks:*)', 'Bash(gh search issues:*"],
  ['G21', 'src/supervisor/coordinator.mjs', 292, "`2. When a message asks you to review work, inve"],
  ['G21', 'src/supervisor/coordinator.mjs', 294, "'3. Plan execution of new work by the accepted A"],
  ['G21', 'src/supervisor/coordinator.mjs', 417, "const pin = pinRequest(ctl.store, request, { git"],
  ['G18', 'src/supervisor/github-reader.mjs', 19, "ghCommand: z.array(z.string()).min(1).refine((v)"],
  ['G18', 'src/supervisor/github-reader.mjs', 31, "const base = `https://api.github.com/repos/${con"],
  ['G18', 'src/supervisor/github-reader.mjs', 45, "const result = spawnSync(config.ghCommand[0], [."],
  ['G18', 'src/supervisor/github-reader.mjs', 99, "// gh may canonicalize a moved repository: rejec"],
  ['G22', 'src/supervisor/intake.mjs', 131, "const ghRead = (gh, path) => {"],
  ['G22', 'src/supervisor/intake.mjs', 132, "const out = run(gh, ['api', '--method', 'GET', p"],
  ['G22', 'src/supervisor/intake.mjs', 149, "* never read through gh. Returns { ok, pinned, e"],
  ['G22', 'src/supervisor/intake.mjs', 150, "* `git` and `gh` are command lines (arrays)."],
  ['G22', 'src/supervisor/intake.mjs', 152, "export function pinRequest(store, request, { git"],
  ['G22', 'src/supervisor/intake.mjs', 160, "const fetched = run(git, ['fetch', '--quiet', 'o"],
  ['G22', 'src/supervisor/intake.mjs', 172, "const read = ghRead(gh, `repos/${repo}/issues/${"],
  ['G22', 'src/supervisor/intake.mjs', 179, "const read = ghRead(gh, `repos/${repo}/pulls/${r"],
  ['G11', 'src/supervisor/merge.mjs', 140, "const git = controller.cmd.git, gh = controller."],
  ['G11', 'src/supervisor/merge.mjs', 150, "try { pr = github.pullRequest({ gh, repository, "],
  ['G11', 'src/supervisor/merge.mjs', 200, "const { mergeCommit } = mergeWithMergeCommit({ g"],
  ['G23', 'src/supervisor/project-connect.mjs', 2, "// a campaign's checkout through it. Connect rea"],
  ['G23', 'src/supervisor/project-connect.mjs', 3, "// (never GraphQL: gh repo view is GraphQL-backe"],
  ['G23', 'src/supervisor/project-connect.mjs', 36, "GH_MISSING: 'GitHub projects need the GitHub CLI"],
  ['G23', 'src/supervisor/project-connect.mjs', 37, "GH_SIGNED_OUT: \"The GitHub CLI isn't signed in. "],
  ['G23', 'src/supervisor/project-connect.mjs', 120, "/** The GitHub half of connect: gh present and s"],
  ['G23', 'src/supervisor/project-connect.mjs', 121, "function readGithub(gh, repository) {"],
  ['G23', 'src/supervisor/project-connect.mjs', 122, "const auth = gh(['auth', 'status']);"],
  ['G23', 'src/supervisor/project-connect.mjs', 125, "const read = gh(['api', `repos/${repository}`, '"],
  ['G23', 'src/supervisor/project-connect.mjs', 129, "return { code: /HTTP 401|gh auth login/i.test(re"],
  ['G23', 'src/supervisor/project-connect.mjs', 154, "* Options: store, config, dataDir, governanceRoo"],
  ['G23', 'src/supervisor/project-connect.mjs', 157, "export function connectGithubProject(input, { st"],
  ['G23', 'src/supervisor/project-connect.mjs', 164, "const ghRun = gh ?? ((args) => run(config.comman"],
  ['G23', 'src/supervisor/project-connect.mjs', 171, "const github = readGithub(ghRun, repository);"],
  ['G23', 'src/supervisor/project-connect.mjs', 203, "* then the same reads as connect: gh, the regist"],
  ['G23', 'src/supervisor/project-connect.mjs', 207, "export function checkGithubProject(store, id, { "],
  ['G23', 'src/supervisor/project-connect.mjs', 218, "const github = readGithub(gh ?? ((args) => run(c"],
  ['G23', 'src/supervisor/project-connect.mjs', 243, "/** `git ls-remote --heads origin <branch>`: rea"],
  ['G23', 'src/supervisor/project-connect.mjs', 246, "const listed = run(git, ['-C', root, 'ls-remote'"],
  ['G28', 'src/supervisor/provenance.mjs', 20, "if (!main.ok) return 'origin/main is not availab"],
  ['G10', 'src/supervisor/release/github-merge.mjs', 3, "// to call it. It uses the operator's existing g"],
  ['G10', 'src/supervisor/release/github-merge.mjs', 14, "export function mergeWithMergeCommit({ gh, repos"],
  ['G10', 'src/supervisor/release/github-merge.mjs', 16, "const result = rest(gh, 'PUT merge', ['--method'"],
  ['G32', 'scripts/supervisor/deploy.ps1', 19, "& git -C $Root fetch -q origin"],
];

const DENY = 'a deny list, or a comment on one, that forbids gh writes';
const TOKEN = 'a GitHub token pattern for secret detection';
const PROBE = 'gh is one of the commands Diagnostics probes for presence';
const RUNNER = "the test runner's tier pattern names the synthetic gh fixture";
const SAYS_NO = 'a comment that says this code calls no GitHub';
const LOCAL = 'a comment that says a project without GitHub pushes nothing and calls no gh';
const TALLY = "a tally of workers' transcripts that sorts their recorded gh commands (added on main at 596dbda)";
const APPROVE = "a comment on Approve and start, whose freshness check reuses G22's git read and runs no gh (added by UI14)";

/** Section 3.2: lines the call forms reach that make no call. [file, line at e0ff151, start of the trimmed line, why]. */
const NOT_CALLS = [
  ['src/dashboard/roadmap.mjs', 11, "return containsCredentialMaterial(text) || /(?:g", TOKEN],
  ['src/dashboard/server.mjs', 39, "// state. `work` is for tests only (governanceRoot", APPROVE],
  ['src/dashboard/supervisor.mjs', 258, "const COMMAND_NAMES = ['claude', 'codex', 'curso", PROBE],
  ['src/dashboard/work.mjs', 198, "// fresh. The dashboard runs git only, never gh:", APPROVE],
  ['src/shared/credential-metadata.mjs', 12, "/(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{30,}", TOKEN],
  ['src/supervisor/adapters/claude.mjs', 76, "export const ALWAYS_DENIED = ['Bash(git push:*)'", DENY],
  ['src/supervisor/adapters/claude.mjs', 77, "'Bash(gh issue comment:*)', 'Bash(gh issue close", DENY],
  ['src/supervisor/adapters/claude.mjs', 91, "// allowlisted mode denies ssh, gh issue comment", DENY],
  ['src/supervisor/controller.mjs', 2353, "* pushed branch, a pull request or an issue comm", LOCAL],
  ['src/supervisor/coordinator.mjs', 71, "// An intake read needs no gh at all: code has a", SAYS_NO],
  ['src/supervisor/coordinator.mjs', 72, "// GitHub therefore drafts without gh, and the c", SAYS_NO],
  ['src/supervisor/coordinator.mjs', 77, "// denied without a prompt; prefix deny rules al", DENY],
  ['src/supervisor/coordinator.mjs', 78, "// No gh api: its write flags can appear anywher", DENY],
  ['src/supervisor/coordinator.mjs', 88, "export const COORDINATOR_DENIED = [...ALWAYS_DEN", DENY],
  ['src/supervisor/coordinator.mjs', 89, "'Bash(gh issue edit:*)', 'Bash(gh issue delete:*", DENY],
  ['src/supervisor/coordinator.mjs', 90, "'Bash(gh pr edit:*)', 'Bash(gh pr review:*)', 'B", DENY],
  ['src/supervisor/coordinator.mjs', 91, "'Bash(gh label:*)', 'Bash(git -C:*)', 'Bash(git ", DENY],
  ['src/supervisor/local-admission.mjs', 13, "// store; STA17 removes it. This module never re", SAYS_NO],
  ['src/supervisor/project-preflight.mjs', 4, "// writes Git configuration and never calls GitH", SAYS_NO],
  ['src/supervisor/projects.mjs', 3, "// it never reads the project's folder, runs git", SAYS_NO],
  ['scripts/run-tests.mjs', 35, "const REHEARSAL = /\\b(environment|runUntil|runti", RUNNER],
  ['scripts/supervisor/worker-reading-cost.mjs', 31, "/** The kind of one tool call: tests, git, gh, sh", TALLY],
  ['scripts/supervisor/worker-reading-cost.mjs', 37, "if (/\\bgh (api|issue|pr)\\b/.test(command)) retur", TALLY],
];

/**
 * Lines the scan reaches that section 3 does not cite (findings for the design, which this slice does not edit):
 * project-connect.mjs:171 runs the G23 read through `ghRun`; controller.mjs:2353 is a comment that makes no call;
 * worker-reading-cost.mjs:31 and :37 (added on main after the design) sort transcript commands and make no call;
 * local-admission.mjs:13 (added on main after the design) is a comment saying the module never calls gh;
 * dashboard server.mjs:39 and work.mjs:198 (added by UI14) are comments: Approve and start reuses G22 and runs no gh.
 */
const NOT_IN_DESIGN = ['src/supervisor/project-connect.mjs:171', 'src/supervisor/controller.mjs:2353',
  'scripts/supervisor/worker-reading-cost.mjs:31', 'scripts/supervisor/worker-reading-cost.mjs:37',
  'src/supervisor/local-admission.mjs:13', 'src/dashboard/server.mjs:39', 'src/dashboard/work.mjs:198'];

/** The rules one line matches. */
const rulesOf = (text) => RULES.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule);

const files = (root, directory) => readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(root, path);
  return [path.split(sep).join('/')];
});

/** Every line under src/ and scripts/ of `root` that matches a rule: [{ file, line, text, rules }]. */
function scan(root) {
  return SCANNED.flatMap((directory) => files(root, directory)).flatMap((file) =>
    readFileSync(join(root, file), 'utf8').split(/\r?\n/).flatMap((line, index) => {
      const rules = rulesOf(line);
      return rules.length ? [{ file, line: index + 1, text: line.trim(), rules }] : [];
    }));
}

/** Compares a scan with the lists: `unlisted` are hits no entry names, `missing` are entries no hit matches. */
function compare(found) {
  const entries = [...SITES.map(([row, file, line, start]) => ({ name: row, file, line, start })),
    ...NOT_CALLS.map(([file, line, start]) => ({ name: 'not a call', file, line, start }))];
  const used = new Set();
  const unlisted = [];
  for (const hit of found) {
    const entry = entries.find((item) => !used.has(item) && item.file === hit.file && hit.text.startsWith(item.start));
    if (entry) used.add(entry);
    else unlisted.push(`${hit.file}:${hit.line} ${hit.rules.join('; ')}: ${hit.text.slice(0, 160)}`);
  }
  const missing = entries.filter((entry) => !used.has(entry))
    .map((entry) => `${entry.name} ${entry.file} (line ${entry.line} at e0ff151) no longer found: ${entry.start}`);
  return { unlisted, missing };
}

const report = ({ unlisted, missing }) => [...unlisted.map((item) => `new GitHub call site? ${item}`), ...missing].join('\n');

/** The `file:line` citations of a design table cell, with ranges expanded: `a.mjs:1`, `:4-5` -> a.mjs:1, a.mjs:4, a.mjs:5. */
function cited(cell) {
  const out = [];
  let file = null;
  for (const [, token] of cell.matchAll(/`([^`]+)`/g)) {
    const match = /^([^:\s]*):(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) continue;
    if (match[1]) file = match[1];
    if (!file) continue;
    for (let line = Number(match[2]); line <= Number(match[3] ?? match[2]); line += 1) out.push(`${file}:${line}`);
  }
  return out;
}

test('the scanner catches each call form, and words that are not calls stay quiet', () => {
  const calls = [
    "run(`gh api repos/${repo}/issues/${n}`)",
    "exec(gh, ['issue', 'list'])",
    "spawnSync(ghCommand[0], [...ghCommand.slice(1), 'issue', 'view'])",
    "exec(command, ['api', `repos/${repo}/pulls`])",
    "fetch(`https://api.github.com/repos/${repo}`)",
    "exec(git, ['fetch', 'origin', base])",
    "exec(git, ['fetch', '--quiet', 'origin', ref])",
    "exec(git, ['push', 'origin', `${sha}:refs/heads/${branch}`])",
    "exec(git, ['-C', root, 'ls-remote', '--heads', 'origin', ref])",
    '& git -C $Root fetch -q origin',
    'git push origin HEAD',
    'git ls-remote origin refs/heads/main',
  ];
  for (const call of calls) assert.ok(rulesOf(call).length > 0, `missed: ${call}`);
  const quiet = [
    "exec(git, ['rev-parse', 'origin/main'])", "exec(git, ['merge-base', '--is-ancestor', sha, 'origin/main'])",
    "req.headers['sec-fetch-site'] === 'cross-site'", "'Only the local dashboard origin is allowed.'",
    'const github = connect(repository)', "'https://github.com/example-org/demo'", 'GH_MISSING', 'await fetch(url)',
    "exec(git, ['fetch', path, base])", "'Bash(git push:*)'",
  ];
  for (const text of quiet) assert.deepEqual(rulesOf(text), [], text);
});

test('planted calls in a temporary copy of the tree are each reported with their file:line (LO L1)', (t) => {
  const copy = mkdtempSync(join(tmpdir(), 'aiworks-github-boundary-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const directory of SCANNED) cpSync(join(ROOT, directory), join(copy, directory), { recursive: true });
  assert.deepEqual(compare(scan(copy)), { unlisted: [], missing: [] }, 'the copy starts equal to the list');

  /** Inserts `text` before line `at` (1-based) of `file` in the copy; returns the planted line's file:line. */
  const plant = (file, at, text) => {
    const lines = readFileSync(join(copy, file), 'utf8').split(/\r?\n/);
    lines.splice(at - 1, 0, text);
    writeFileSync(join(copy, file), lines.join('\n'));
    return `${file}:${at}`;
  };
  // Inserted near the top of each file, so every listed site below them moves down: the list still matches them.
  const planted = [
    plant('src/supervisor/controller.mjs', 10, "const planted = execSync('gh api repos/example-org/demo/issues');"),
    plant('src/supervisor/adapters/git.mjs', 5, "export const plantedFetch = (git, cwd) => exec(git, ['fetch', 'origin', 'main'], { cwd });"),
    plant('src/dashboard/merges.mjs', 4, "const plantedList = (git, ref) => run(git, ['ls-remote', '--heads', 'origin', ref]);"),
    plant('scripts/supervisor/deploy.ps1', 7, '& git -C $Root push origin HEAD:refs/heads/main'),
    plant('src/shared/credential-metadata.mjs', 1, "const plantedGh = (gh, path) => exec(gh, ['issue', 'view', path]);"),
  ];
  writeFileSync(join(copy, 'src/supervisor/planted.mjs'), "// planted\nexport const read = (path) => fetch(`https://api.github.com/${path}`);\n");
  planted.push('src/supervisor/planted.mjs:2');

  const result = compare(scan(copy));
  assert.deepEqual(result.missing, [], 'moved sites still match by text');
  assert.deepEqual(result.unlisted.map((item) => item.split(' ')[0]).sort(), planted.sort(), report(result));
  assert.match(report(result), /^new GitHub call site\? src\/supervisor\/controller\.mjs:10 the gh command: /m);
});

test('a removed or duplicated site fails with its name and file:line', (t) => {
  const copy = mkdtempSync(join(tmpdir(), 'aiworks-github-boundary-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const directory of SCANNED) cpSync(join(ROOT, directory), join(copy, directory), { recursive: true });
  const file = 'src/supervisor/adapters/git.mjs';
  const lines = readFileSync(join(copy, file), 'utf8').split(/\r?\n/);
  const push = lines.findIndex((line) => line.includes("['push', 'origin'"));
  const lsRemote = lines.findIndex((line) => line.includes("['ls-remote', 'origin', pattern]"));
  assert.ok(push > 0 && lsRemote > push, 'the push and the remote branch read are where the list says');
  lines.splice(lsRemote + 1, 0, lines[lsRemote]);
  lines.splice(push, 1);
  writeFileSync(join(copy, file), lines.join('\n'));

  const result = compare(scan(copy));
  assert.deepEqual(result.missing.map((item) => item.split(' ').slice(0, 2).join(' ')), [`G25 ${file}`]);
  assert.deepEqual(result.unlisted.map((item) => item.split(' ')[0]), [`${file}:${lsRemote + 1}`],
    'the copy below the original is the new site (one line up: the push above it is gone)');
});

test('the real tree matches the list of GitHub call sites exactly', () => {
  const found = scan(ROOT);
  assert.ok(found.some((hit) => hit.file === 'src/supervisor/adapters/github.mjs'), 'the scan sees the source tree');
  assert.ok(found.some((hit) => hit.file === 'scripts/supervisor/deploy.ps1'), 'the scan sees scripts/');
  const result = compare(found);
  assert.deepEqual(result, { unlisted: [], missing: [] }, report(result));
});

test('the list is the one docs/design/LOCAL_OPERATION.md section 3 names', () => {
  const design = readFileSync(join(ROOT, 'docs/design/LOCAL_OPERATION.md'), 'utf8').replace(/\r\n/g, '\n');
  const calls = design.slice(design.indexOf('### 3.1 Calls that reach GitHub'), design.indexOf('### 3.2 Hits that make no call'));
  const quiet = design.slice(design.indexOf('### 3.2 Hits that make no call'), design.indexOf('## 4. Local main'));
  assert.ok(calls.length > 1000 && quiet.length > 500, 'sections 3.1 and 3.2 are found');
  const rows = new Map(calls.split('\n').filter((line) => /^\| G\d+ \|/.test(line)).map((line) => {
    const cells = line.split(' | ');
    return [cells[0].slice(2), new Set(cited(cells[2]))];
  }));
  const quietCited = new Set(quiet.split('\n').filter((line) => line.startsWith('| `')).flatMap((line) => cited(line.split(' | ')[0])));
  assert.equal(rows.size, 33, 'G1 to G33');

  const off = [];
  for (const [row, file, line] of SITES) {
    const site = `${file}:${line}`;
    if (!rows.has(row)) off.push(`${row} is not a row of section 3.1`);
    else if (!NOT_IN_DESIGN.includes(site) && !rows.get(row).has(site)) off.push(`${site} is not cited by ${row}`);
  }
  for (const [file, line] of NOT_CALLS) {
    const site = `${file}:${line}`;
    if (!NOT_IN_DESIGN.includes(site) && !quietCited.has(site)) off.push(`${site} is not cited by section 3.2`);
  }
  assert.deepEqual(off, []);
  // Each finding is still one: when the design cites the line, it leaves NOT_IN_DESIGN.
  const everyCited = new Set([...[...rows.values()].flatMap((set) => [...set]), ...quietCited]);
  for (const site of NOT_IN_DESIGN) assert.ok(!everyCited.has(site), `${site} is cited now: remove it from NOT_IN_DESIGN`);
});
