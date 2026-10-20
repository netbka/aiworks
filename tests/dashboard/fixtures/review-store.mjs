// Review fixture (OWNER_WORKSPACE slice S0, build slice UI1): a synthetic supervisor store and disposable local git
// repositories that show every owner state of docs/design/OWNER_WORKSPACE.md §7, so a disposable dashboard can be
// reviewed without live data. No GitHub at all (PROJECT_WORKSPACE_PLAN §6.12 C1): merges are read from local git, as the
// dashboard does today, and there is no fake `gh`. No network, model or credential is used.
//
// Start a disposable review dashboard (foreground; Ctrl+C stops it and deletes its temporary directory):
//
//   node tests/dashboard/fixtures/review-store.mjs --port 4319
//
// Options: `--store full` (default; every state), `--store stopped` (the full store after AIWorks stopped on this
// computer: every lease ended two hours ago), `--store empty` (the first run: no projects) or `--store unreadable`
// (AIWorks can't read its work records). `--dir <new or empty directory>` builds there instead of a temporary directory
// and leaves it in place. Port 4318 is refused: it is the live dashboard's port. Never point --dir at .local.
// Then open http://127.0.0.1:4319. It runs the unchanged dashboard (src/dashboard/main.mjs) against the fixture, with its
// own governance copy: the test governance checkout with a made-up roadmap and project registry (review-governance/), so
// the page names no real project, and links only made-up issues. Commands sent from the page change only the synthetic store.
//
// The dashboard runs from a disposable runtime checkout (<dir>/runtime): an unchanged copy of this repository's code,
// committed together with the synthetic declarations in campaigns/ and pushed to a local origin's main. Resume checks the
// stored declaration against that checkout's origin/main exactly as it does on workstation (AW-005), so the paused work resumes.
// The full store has a coordinator that reports to a made-up issue, so Messages shows each receipt; nothing runs it, so
// a message sent during the review stays received.
//
// Times are fixed when the fixture is built. In the full store AIWorks runs (most leases are live), so after 5 minutes
// "a few minutes late" turns into that work's own "AIWorks is running, but last checked on this work", and "waiting to be
// picked up" (recipes-share) into "AIWorks is running, but has not picked it up", as they would live; restart the command
// to see them again. Those are the states recipes showed right after Resume in review 4 (aiworks#11 F2): not the resumed
// work, whose lease lasts 30 days, but recipes-share, past its 5-minute grace, worded as if AIWorks had stopped. The serving
// process keeps the heartbeat of the two working agents current, so "working normally" holds for the whole review.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../../../src/supervisor/store.mjs';
import { campaignStart, campaignPause } from '../../../src/supervisor/api.mjs';
import { runNotCounted } from '../../../src/supervisor/adapters/executors.mjs';
import { postOwnerMessage, LANE } from '../../../src/supervisor/coordinator.mjs';
import { planRequestText } from '../../../src/dashboard/supervisor.mjs';
import { createProject } from '../../../src/supervisor/projects.mjs';
import { recordDraft, reviseDraft, submitWorkRequest, workRequest } from '../../../src/supervisor/intake.mjs';
import { addComment, createItem } from '../../../src/supervisor/work-list.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const GOVERNANCE = join(ROOT, 'tests', 'fixtures', 'governance');
/** What the review copy of GOVERNANCE replaces: the documents the dashboard roadmap reads (src/dashboard/roadmap.mjs). */
export const REVIEW_GOVERNANCE = fileURLToPath(new URL('review-governance', import.meta.url));
/** The review dashboard's port. 4318 is the live dashboard's and is never used. */
export const REVIEW_PORT = 4319;
export const LIVE_PORT = 4318;
export const PROJECTS = ['example/shop-app', 'example/recipes', 'example/notes-site'];
/** Where the fixture's supervisor faults are tracked: a made-up issue, never AIWorks' own. */
const REVIEW_SUPERVISOR_ISSUE = 'https://github.com/example/aiworks/issues/2';
/** What the full store's coordinator posts to: made up, and nothing reads or posts it (no supervisor runs). */
const COORDINATOR = { repositories: PROJECTS, reportTo: 'example/recipes#1' };
/** The code the runtime checkout copies: what the dashboard and the supervisor modules it imports read. */
const RUNTIME_PARTS = ['package.json', 'registry', 'schemas', 'scripts', 'src'];

const M = 60_000, H = 60 * M;
/** A lease that outlives any review, so "running" holds without a live supervisor. */
const LEASE_MS = 30 * 24 * H;

/**
 * Every owner state of OWNER_WORKSPACE §7 the full store shows, with the one piece of work that shows it. `taskId` is
 * the step the state is about, when it is about one step. States that need a different store name it in `store`.
 */
export const REVIEW_STATES = {
  'empty': { section: '7.1', store: 'empty' },
  'no-runs': { section: '7.1', campaignId: 'recipes-share' },
  'unreadable': { section: '7.2', store: 'unreadable' },
  // AIWorks itself stopped is the stopped store; in the full store AIWorks runs, so the same work is its own state.
  'supervisor-stopped': { section: '7.2', store: 'stopped', campaignId: 'notes-archive' },
  'work-lapsed': { section: '7.2', campaignId: 'notes-archive' },
  'supervisor-late': { section: '7.2', campaignId: 'notes-drafts' },
  'provider-wait': { section: '7.3', campaignId: 'recipes-tags', taskId: 'T1' },
  'no-worker-can-run': { section: '7.3', campaignId: 'notes-deploy' },
  'nothing-running': { section: '7.3', campaignId: 'recipes-idle' },
  // §7.4 "GitHub stale" became the merge-check copy (C1): the last check failed, and results whose state is unknown.
  'merge-check-failed': { section: '7.4', campaignId: 'notes-links', taskId: 'T3' },
  'paused': { section: '7.5', campaignId: 'recipes-import' },
  'paused-supervisor-stopped': { section: '7.5', store: 'stopped', campaignId: 'notes-tags' },
  'paused-work-lapsed': { section: '7.5', campaignId: 'notes-tags' },
  'builder-working': { section: '7.6', campaignId: 'shop-checkout', taskId: 'T1' },
  'checker-working': { section: '7.6', campaignId: 'shop-reviews', taskId: 'T1' },
  'possibly-stuck': { section: '7.6', campaignId: 'shop-wishlist', taskId: 'T1' },
  'waiting-for-merge': { section: '7.6', campaignId: 'shop-contracts', taskId: 'T2' },
  'awaiting-pickup': { section: '7.6', campaignId: 'recipes-share' },
  'needs-decision': { section: '7.7', campaignId: 'notes-theme', taskId: 'T1' },
  'others-continue': { section: '7.7', campaignId: 'notes-theme', taskId: 'T2' },
  'failed-attempts': { section: '7.7', campaignId: 'notes-search', taskId: 'T1' },
  'recorded-blocker': { section: '7.7', campaignId: 'notes-deploy' },
  'supervisor-fault': { section: '7.7', campaignId: 'notes-health' },
  'finished-all-merged': { section: '7.8', campaignId: 'recipes-units' },
  'finished-open-and-merged': { section: '7.8', campaignId: 'shop-search' },
  'closed-without-merging': { section: '7.8', campaignId: 'shop-search', taskId: 'T3' },
  'finished-reports': { section: '7.8', campaignId: 'notes-audit' },
  'finished-unknown': { section: '7.8', campaignId: 'notes-links' },
  'cancelled': { section: '7.8', campaignId: 'recipes-print' },
};

function git(cwd, ...args) {
  const out = spawnSync('git', ['-c', 'user.name=Review Fixture', '-c', 'user.email=review-fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}

// The git side of one fixture is about 70 git processes, 10 s or more on Windows, and a test file builds the fixture up
// to 14 times. Each repository is built once per process under a template directory and copied after that: the same
// commits and SHAs, a fresh copy per fixture, origin pointed at the copy's own bare repository. The templates are never
// changed and are deleted when the process exits.
const templates = new Map();
let templateDir = null;
function fromTemplate(key, build) {
  if (!templates.has(key)) {
    if (!templateDir) {
      templateDir = mkdtempSync(join(tmpdir(), 'aiworks-review-template-'));
      process.once('exit', () => rmSync(templateDir, { recursive: true, force: true, maxRetries: 5 }));
    }
    templates.set(key, build(join(templateDir, String(templates.size))));
  }
  return templates.get(key);
}
/** Copies a template's checkout and bare origin to `path` and `bare`, and points the copy's origin at `bare`. */
function copyRepository(built, path, bare) {
  if (existsSync(built.origin)) cpSync(built.origin, bare, { recursive: true });
  cpSync(built.path, path, { recursive: true, filter: (source) => source !== join(built.path, 'node_modules') });
  git(path, 'remote', 'set-url', 'origin', bare);
}

/**
 * A local repository with an `origin` that is a bare repository on disk (never a URL). Each branch gets one commit
 * from main; `merged` branches are merged into main with a merge commit, `pushed` ones are pushed, the rest stay
 * local and their branch is deleted (a pull request closed without merging). `origin: false` points origin at a
 * directory that does not exist, so every merge check of that project fails.
 */
function repository(root, name, branches, options = {}) {
  const built = fromTemplate(JSON.stringify(['repository', name, branches, options]), (dir) => buildRepository(dir, name, branches, options));
  const bare = join(root, 'git', `${name}.git`), path = join(root, 'checkouts', name);
  copyRepository(built, path, bare);
  return { path, origin: bare, shas: built.shas };
}

function buildRepository(root, name, branches, { origin = true } = {}) {
  const bare = join(root, 'git', `${name}.git`), path = join(root, 'checkouts', name);
  mkdirSync(path, { recursive: true });
  if (origin) { mkdirSync(bare, { recursive: true }); git(bare, 'init', '-q', '--bare', '-b', 'main'); }
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'README.md'), `# ${name}\n\nA made-up project for the AIWorks review dashboard.\n`);
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'initial');
  git(path, 'remote', 'add', 'origin', bare);
  const shas = {};
  for (const { branch, merged = false, pushed = false, files = {} } of branches) {
    git(path, 'checkout', '-q', '-b', branch, 'main');
    writeFileSync(join(path, `${branch}.md`), `${branch}\n`);
    for (const [file, text] of Object.entries(files)) { mkdirSync(join(path, file, '..'), { recursive: true }); writeFileSync(join(path, file), text); }
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', branch);
    shas[branch] = git(path, 'rev-parse', 'HEAD');
    git(path, 'checkout', '-q', 'main');
    if (merged) git(path, 'merge', '-q', '--no-ff', '-m', `Merge ${branch}`, branch);
    if (origin && pushed && !merged) git(path, 'push', '-q', 'origin', branch);
    if (!merged && !pushed) git(path, 'branch', '-q', '-D', branch);
  }
  if (origin) git(path, 'push', '-q', 'origin', 'main');
  return { path, origin: bare, shas };
}

/** The checked search page's static files, so Review can preview that version (OWNER_UI_V2 WP7). Made up. */
const SEARCH_PAGE = {
  'public/index.html': '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Shop search</title><link rel="stylesheet" href="style.css"></head>\n<body><main><h1>Find a product</h1>' +
    '<label>Search <input type="search" value="kettle"></label><ul><li>Kettle, 1.7 l</li><li>Kettle descaler</li><li>Travel kettle</li></ul></main></body></html>\n',
  'public/style.css': 'body{margin:0;font-family:system-ui,sans-serif}main{max-width:640px;margin:0 auto;padding:24px}input{width:100%;padding:8px;margin-top:4px}\n',
};
const task = (id, issue, title, outcome, extra = {}) => ({ id, issue, title, outcome, deliverable: 'commit',
  goal: `${outcome}.`, dependsOn: [], acceptance: ['Synthetic review fixture step.'], references: ['README.md'], ...extra });
const CLAUDE = { kind: 'claude-cli', model: 'opus', permissionMode: 'auto' };
const CHAIN = { kind: 'cli-chain', providers: [{ kind: 'codex-cli' }, CLAUDE], implementerTimeoutMinutes: 60, verifierTimeoutMinutes: 30 };
const SINGLE = { ...CLAUDE, implementerTimeoutMinutes: 60, verifierTimeoutMinutes: 30 };

function declaration(campaignId, repository, purpose, trackingIssue, tasks, executor = SINGLE) {
  return { version: 1, campaignId, purpose,
    authorization: { version: 1, grantedBy: 'owner', grantedAt: '2026-10-12', reference: 'https://github.com/example/aiworks/issues/11', text: 'Synthetic review fixture; nothing runs.' },
    target: { tenantId: 'example', projectId: repository.split('/')[1], environment: 'research', repository, baseBranch: 'main', trackingIssue },
    limits: { slots: 1 }, executor, constraints: ['Synthetic review fixture: no network, no production.'], tasks };
}

/** The full store: every state of REVIEW_STATES across three made-up projects. */
function fill(store, dataDir, root, now) {
  const repos = {
    'example/shop-app': repository(root, 'shop-app', [
      { branch: 'search-page', merged: true, files: SEARCH_PAGE },{ branch: 'search-filters', pushed: true }, { branch: 'sale-banner' },
      { branch: 'contracts-import', pushed: true }]),
    'example/recipes': repository(root, 'recipes', [{ branch: 'print-card', merged: true },
      { branch: 'unit-converter', merged: true }, { branch: 'metric-units', merged: true }]),
    'example/notes-site': repository(root, 'notes-site', [{ branch: 'sitemap' }], { origin: false }),
  };
  const sha = (repo, branch) => repos[repo].shas[branch];
  const pull = (repo, n) => `https://github.com/${repo}/pull/${n}`;
  const declarations = [];
  const start = (d, at) => { campaignStart(store, d, at); declarations.push(d); return d.campaignId; };
  const lease = (id, expiresAt) => store.insert('leases', { campaign_id: id, instance_id: 'review-fixture', generation: 1,
    code_revision: 'review0fixture', acquired_at: Math.min(expiresAt, now) - H, expires_at: expiresAt });
  const live = (id) => lease(id, now + LEASE_MS);
  const setTask = (id, taskId, changes) => store.patch('tasks', { campaign_id: id, task_id: taskId }, store.task(id, taskId).version, changes, now);
  const setCampaign = (id, changes) => store.patch('campaigns', { id }, store.campaign(id).version, changes, now);
  let seq = 0;
  const operation = (id, taskId, kind, { executor = 'claude-cli', state = 'dispatched', at = now - 20 * M, outcome = null } = {}) => {
    const opId = `${id}.${taskId}.${kind}.${++seq}`, runDir = join(dataDir, 'runs', opId);
    mkdirSync(runDir, { recursive: true });
    store.insert('operations', { id: opId, campaign_id: id, task_id: taskId, kind, seq, idempotency_key: opId, lease_generation: 1, state,
      session_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, run_dir: runDir, workspace: join(root, 'worktrees', opId),
      packet: { synthetic: true }, packet_digest: '0'.repeat(64), outcome, created_at: at, updated_at: state === 'finished' ? at + 10 * M : at, executor_kind: executor });
    return { runDir, workspace: join(root, 'worktrees', opId), sessionId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}` };
  };
  // Claude's session transcript, where the dashboard reads a Claude worker's turns and tool calls (under the fixture's
  // own Claude directory, never this computer's): a turn with a tool call, then one without. The last turn's time is the
  // worker's last activity.
  const transcript = ({ workspace, sessionId }, from, to) => {
    const dir = join(root, 'claude', 'projects', String(workspace).replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), [
      { type: 'assistant', timestamp: new Date(from).toISOString(), message: { content: [{ type: 'text', text: 'Synthetic turn.' }, { type: 'tool_use', name: 'Read' }] } },
      { type: 'assistant', timestamp: new Date(to).toISOString(), message: { content: [{ type: 'text', text: 'Synthetic turn.' }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
  };
  // Codex's streamed record: turns and actions the dashboard counts; its time is the file's.
  const streamed = ({ runDir }, at) => {
    const path = join(runDir, 'stdout.json');
    writeFileSync(path, [{ type: 'item.completed', item: { type: 'agent_message' } }, { type: 'item.completed', item: { type: 'command_execution' } },
      { type: 'item.completed', item: { type: 'agent_message' } }].map((line) => JSON.stringify(line)).join('\n') + '\n');
    utimesSync(path, new Date(at), new Date(at));
  };
  const working = [];
  const beat = ({ runDir }, at = now) => { writeFileSync(join(runDir, 'heartbeat'), String(at)); working.push(runDir); };
  const finished = (result, costUsd) => ({ class: 'result', value: result, ...(costUsd ? { receipt: { costUsd } } : {}) });

  // example/shop-app: running work, a finished campaign with merged, open and closed results, and a merge wait.
  const shop = 'example/shop-app';
  let id = start(declaration('shop-checkout', shop, 'Let customers pay at checkout', 10, [task('T1', 11, 'checkout form', 'Checkout form'),
    task('T2', 12, 'order email', 'Order confirmation email', { dependsOn: ['T1'] })], CHAIN), now - 3 * H);
  live(id);
  // Running steps are in the state the supervisor gives them while a worker runs (implementing, verifying), and the
  // builder is Claude: Settings shows it can build code on this computer, whatever the platform.
  let run = operation(id, 'T1', 'implement', { at: now - 20 * M });
  transcript(run, now - 20 * M, now - 2 * M); beat(run);
  setTask(id, 'T1', { state: 'implementing', attempts: 1 });

  id = start(declaration('shop-reviews', shop, 'Show product reviews', 20, [task('T1', 21, 'review list', 'Product review list')]), now - 4 * H);
  live(id);
  operation(id, 'T1', 'implement', { state: 'finished', at: now - 2 * H, outcome: finished({ result: 'implemented' }, 1.1) });
  beat(operation(id, 'T1', 'verify', { at: now - 6 * M }));
  setTask(id, 'T1', { state: 'verifying', attempts: 1, head_sha: 'c'.repeat(40) });

  id = start(declaration('shop-wishlist', shop, 'Let customers save a wishlist', 30, [task('T1', 31, 'wishlist', 'Wishlist page')], CHAIN), now - 2 * H);
  live(id);
  // Claude built it; Codex checks it, which Settings says Codex can do here ("can check and report here").
  operation(id, 'T1', 'implement', { state: 'finished', at: now - 2 * H, outcome: finished({ result: 'implemented' }, 0.7) });
  run = operation(id, 'T1', 'verify', { executor: 'codex-cli', at: now - 70 * M });
  // The worker process is alive, but its own record has not moved for 25 minutes.
  writeFileSync(join(run.runDir, 'heartbeat'), String(now));
  streamed(run, now - 25 * M);
  setTask(id, 'T1', { state: 'verifying', attempts: 1, head_sha: 'd'.repeat(40) });

  // Review (OWNER_UI_V2 WP4): each step's done-when criteria with the checker's evidence; the filters step has one
  // criterion not checked, a non-blocking finding and an item for the owner's own eyes, so it can be accepted or sent back.
  const searchCriteria = ['Searching a product name lists it first', 'Filters narrow the list by price', 'The page works at 320 pixels wide'];
  id = start(declaration('shop-search', shop, 'Help customers find products', 40, [task('T1', 41, 'search page', 'Search page', { acceptance: searchCriteria }),
    task('T2', 42, 'search filters', 'Search filters', { acceptance: searchCriteria }), task('T3', 43, 'sale banner', 'Sale banner')]), now - 30 * H);
  const searchReview = { T1: { criteria: [1, 2, 3].map((criterion) => ({ criterion, result: 'pass', check: 'Opened the synthetic shop page', evidence: 'Behaves as stated with the fixture catalogue.' })) },
    T2: { criteria: [{ criterion: 1, result: 'pass', check: 'Searched the fixture catalogue for “kettle”', evidence: 'The kettle is listed first of 4 results.' },
      { criterion: 2, result: 'pass', check: 'Set the price filter to 10–20', evidence: 'Only the 3 products in that range remain.' },
      { criterion: 3, result: 'not-checked', check: 'No narrow viewport was available to the checker', evidence: 'Not measured.' }],
    findings: [{ id: 'N1', severity: 'non-blocking', description: 'The filter labels are not translated yet.' }], eyesOn: ['Whether “Price” or “Cost” reads better on the filter'] } };
  for (const [taskId, branch, n, implementCost, verifyCost] of [['T1', 'search-page', 101, 1.9, 0.8], ['T2', 'search-filters', 102, 1.5, null], ['T3', 'sale-banner', 103, null, null]]) {
    // Runs that reported a cost and runs that did not: unknown cost is never shown as zero.
    operation(id, taskId, 'implement', { state: 'finished', at: now - 28 * H, outcome: finished({ result: 'implemented' }, implementCost) });
    operation(id, taskId, 'verify', { state: 'finished', at: now - 27 * H, outcome: finished({ verdict: 'accepted', findings: [] }, verifyCost) });
    const report = `# ${taskId} report\n\nSynthetic review fixture report.`, head = sha(shop, branch), review = searchReview[taskId];
    setTask(id, taskId, { state: 'done', attempts: 1, head_sha: head, verified_sha: head, pr_url: pull(shop, n),
      ...(review ? { result: { result: 'resolved', summary: 'implemented', headSha: head, report },
        verification: { verdict: 'accepted', targetSha: head, reportDigest: createHash('sha256').update(report, 'utf8').digest('hex'), summary: 'Checked against the fixture catalogue.',
          verdictSummary: `${taskId === 'T1' ? 'The search page' : 'The filters'} do what the plan promised on the fixture catalogue.`, findings: review.findings ?? [],
          checks: [{ command: 'npm run check', result: 'pass' }], criteria: review.criteria, eyesOn: review.eyesOn ?? [] } } : {}) });
    store.journal(id, 'published', { task: taskId, url: pull(shop, n) }, now - 26 * H);
  }
  setCampaign(id, { control: 'finished', status: 'ready',
    next_action: 'Release gate: review campaign deliveries under example/shop-app\'s own merge and release policy.' });
  lease(id, now - 26 * H);

  id = start(declaration('shop-contracts', shop, 'Import supplier contracts', 50, [task('T1', 51, 'contracts import', 'Contracts import'),
    task('T2', 52, 'price sync', 'Price sync', { dependsOn: ['T1'], requiresMergedDependencies: true })]), now - 6 * H);
  live(id);
  setTask(id, 'T1', { state: 'done', attempts: 1, head_sha: sha(shop, 'contracts-import'), verified_sha: sha(shop, 'contracts-import'), pr_url: pull(shop, 104) });
  setTask(id, 'T2', { last_error: 'dependency-integration: T1 is not merged into main yet', retry_at: now + 10 * M });

  // example/recipes: paused, waiting for a usage limit, idle, waiting to be picked up, cancelled, and everything merged.
  const recipes = 'example/recipes';
  id = start(declaration('recipes-import', recipes, 'Import recipes from a spreadsheet', 60, [task('T1', 61, 'spreadsheet import', 'Spreadsheet import')]), now - 9 * H);
  live(id);
  campaignPause(store, id, 'Paused for an update on this computer', now - 50 * M);

  id = start(declaration('recipes-tags', recipes, 'Tag recipes by diet', 70, [task('T1', 71, 'diet tags', 'Diet tags')]), now - 5 * H);
  live(id);
  setTask(id, 'T1', { attempts: 1, last_error: 'quota: usage limit reached', retry_at: now + 45 * M });
  store.insert('executor_waits', { campaign_id: id, executor_kind: 'claude-cli', retry_at: now + 45 * M, reason: 'quota: usage limit reached' });

  id = start(declaration('recipes-idle', recipes, 'Add cooking timers', 80, [task('T1', 81, 'cooking timers', 'Cooking timers')]), now - 2 * H);
  live(id);

  start(declaration('recipes-share', recipes, 'Share a recipe by link', 90, [task('T1', 91, 'share link', 'Share link')]), now - M);

  id = start(declaration('recipes-print', recipes, 'Print recipe cards', 100, [task('T1', 101, 'print card', 'Print card'),
    task('T2', 102, 'print layout', 'Print layout'), task('T3', 103, 'print settings', 'Print settings')]), now - 50 * H);
  operation(id, 'T1', 'implement', { state: 'finished', at: now - 49 * H, outcome: finished({ result: 'implemented' }, 0.9) });
  setTask(id, 'T1', { state: 'done', attempts: 1, head_sha: sha(recipes, 'print-card'), verified_sha: sha(recipes, 'print-card'), pr_url: pull(recipes, 201) });
  setCampaign(id, { control: 'cancelled', status: 'cancelled' });
  lease(id, now - 40 * H);

  // Every step finished and merged into main, so every state is known and only the release follows.
  id = start(declaration('recipes-units', recipes, 'Convert recipe units', 105, [task('T1', 106, 'unit converter', 'Unit converter'),
    task('T2', 107, 'metric units', 'Metric units')]), now - 30 * H);
  for (const [taskId, branch, n] of [['T1', 'unit-converter', 202], ['T2', 'metric-units', 203]]) {
    operation(id, taskId, 'implement', { state: 'finished', at: now - 29 * H, outcome: finished({ result: 'implemented' }, 1.2) });
    operation(id, taskId, 'verify', { state: 'finished', at: now - 28 * H, outcome: finished({ verdict: 'accepted', findings: [] }, 0.5) });
    setTask(id, taskId, { state: 'done', attempts: 1, head_sha: sha(recipes, branch), verified_sha: sha(recipes, branch), pr_url: pull(recipes, n) });
    store.journal(id, 'published', { task: taskId, url: pull(recipes, n) }, now - 27 * H);
  }
  setCampaign(id, { control: 'finished', status: 'ready',
    next_action: 'Release gate: review campaign deliveries under example/recipes\'s own merge and release policy.' });
  lease(id, now - 27 * H);

  // example/notes-site: stopped work, owner decisions, failures, a supervisor fault, and results whose state is unknown.
  const notes = 'example/notes-site';
  id = start(declaration('notes-theme', notes, 'Give the site a dark theme', 110, [task('T1', 111, 'dark theme', 'Dark theme'),
    task('T2', 112, 'theme switch', 'Theme switch')]), now - 7 * H);
  live(id);
  // A structured decision (OWNER_UI_V2 WP2): options with consequences, a suggestion, what continues and what happens unanswered.
  setTask(id, 'T1', { attempts: 1, blocked: { class: 'B3', reason: 'owner-reserved: the colour palette is a brand decision', at: now - 6 * H, decision: {
    question: 'Which palette should the dark theme use?',
    options: [{ id: 'brand', label: 'Brand colours', consequence: 'Matches the logo; two contrast fixes are needed.' },
      { id: 'neutral', label: 'Neutral greys', consequence: 'Passes contrast as is; looks plainer.' }],
    suggestion: { option: 'neutral', reason: 'It passes the contrast check without extra work.' },
    continues: 'Other work on the site keeps going.', unanswered: 'Dark theme stays stopped; nothing is published.' } } });
  // A free-text decision: the worker described no options, so the owner answers in their own words.
  setTask(id, 'T2', { attempts: 1, blocked: { class: 'B3', reason: 'owner-reserved: where the switch goes is a design decision', at: now - 5 * H } });

  id = start(declaration('notes-search', notes, 'Search notes', 120, [task('T1', 121, 'notes search', 'Notes search')]), now - 8 * H);
  live(id);
  for (let n = 0; n < 5; n++) operation(id, 'T1', 'implement', { state: 'finished', at: now - (7 - n) * H, outcome: { class: 'invalid-result' } });
  setTask(id, 'T1', { attempts: 5, blocked: { class: 'stalled', reason: '5 failed attempts; last invalid-result' } });

  id = start(declaration('notes-deploy', notes, 'Publish the site preview', 130, [task('T1', 131, 'site preview', 'Site preview')],
    { kind: 'cli-chain', providers: [{ kind: 'codex-cli' }], implementerTimeoutMinutes: 60, verifierTimeoutMinutes: 30 }), now - 6 * H);
  live(id);
  store.insert('executor_waits', { campaign_id: id, executor_kind: 'codex-cli', retry_at: null, reason: 'codex-cli: unavailable: command not configured' });
  setCampaign(id, { status: 'blocked', blocker: { kind: 'executors', class: 'B2', reason: 'No configured executor supports this task role',
    requestedAction: 'Configure an authorized native CLI command and scoped role support, then recheck the campaign.' } });

  id = start(declaration('notes-archive', notes, 'Archive old notes', 140, [task('T1', 141, 'archive', 'Note archive')]), now - 10 * H);
  lease(id, now - 2 * H);

  id = start(declaration('notes-drafts', notes, 'Save drafts automatically', 150, [task('T1', 151, 'autosave', 'Draft autosave')]), now - 3 * H);
  lease(id, now - 2 * M);

  id = start(declaration('notes-tags', notes, 'Tag notes', 160, [task('T1', 161, 'note tags', 'Note tags')]), now - 12 * H);
  campaignPause(store, id, 'Paused for an update on this computer', now - 3 * H);
  lease(id, now - 2 * H);

  id = start(declaration('notes-health', notes, 'Check broken links', 170, [task('T1', 171, 'link check', 'Broken link check')]), now - 4 * H);
  live(id);
  setCampaign(id, { liveness_defect: 1 });

  id = start(declaration('notes-audit', notes, 'Review the site’s accessibility', 180, [
    task('T1', 181, 'accessibility audit', 'Accessibility audit', { deliverable: 'report' }),
    task('T2', 182, 'performance audit', 'Performance audit', { deliverable: 'report' })]), now - 20 * H);
  for (const [taskId, n] of [['T1', 181], ['T2', 182]]) {
    setTask(id, taskId, { state: 'done', attempts: 1, pr_url: `https://github.com/${notes}/issues/${n}#issuecomment-${n}000` });
  }
  setCampaign(id, { control: 'finished', status: 'ready', next_action: 'Planning reports published in example/notes-site; review recommendations before assigning implementation.' });
  lease(id, now - 19 * H);

  id = start(declaration('notes-links', notes, 'Tidy the site’s links', 190, [task('T1', 191, 'link redirects', 'Link redirects'),
    task('T2', 192, 'footer links', 'Footer links'), task('T3', 193, 'sitemap', 'Sitemap')]), now - 15 * H);
  setTask(id, 'T1', { state: 'done', attempts: 1 });
  setTask(id, 'T2', { state: 'done', attempts: 1, pr_url: pull(notes, 302) });
  setTask(id, 'T3', { state: 'done', attempts: 1, head_sha: sha(notes, 'sitemap'), verified_sha: sha(notes, 'sitemap'), pr_url: pull(notes, 303) });
  setCampaign(id, { control: 'finished', status: 'ready' });
  lease(id, now - 14 * H);

  // A report the supervisor recorded in the local work list (controller.mjs recordLocalReview), as for AIWorks's own
  // repository with local main trusted: the step links the work item, and the item holds the supervisor's comment for
  // exactly this step and report. Results shows it under Reports to read with the work item's own address.
  id = start(declaration('notes-research', notes, 'Compare static site hosts', 200, [task('T1', 201, 'hosting comparison', 'Hosting comparison', { deliverable: 'report' })]), now - 10 * H);
  const researchReport = '# Hosting comparison\n\nSynthetic review fixture report: three made-up hosts compared by price and build time.';
  const researchItem = createItem(store, { kind: 'task', title: 'Compare static site hosts', body: 'Synthetic review fixture item.', authorKind: 'owner', now: now - 10 * H });
  addComment(store, { number: researchItem.number, authorKind: 'supervisor', now: now - 8 * H, body: `${researchReport}\n\nVerified by an independent checker.`,
    idempotencyKey: `${id}:T1:report:${createHash('sha256').update(researchReport, 'utf8').digest('hex')}` });
  setTask(id, 'T1', { state: 'done', attempts: 1, pr_url: `aiworks-work:${researchItem.number}`, result: { result: 'resolved', summary: 'reported', report: researchReport } });
  store.journal(id, 'published', { task: 'T1', url: `aiworks-work:${researchItem.number}` }, now - 8 * H);
  setCampaign(id, { control: 'finished', status: 'ready' });
  lease(id, now - 7 * H);

  // Plan (OWNER_UI_V2 WP3): example/recipes connected, with plans in Now, Next and Later, each with versions the owner
  // edited, one out of date and one still being drafted. Written as intake.mjs writes them; nothing approves or starts.
  createProject(store, { id: 'recipes', tenant_id: 'example', name: 'Recipes', source_kind: 'github', root_path: repos[recipes].path,
    github_repository: recipes, base_branch: 'main' }, now - 40 * H);
  let planSeq = 0;
  const planId = () => `00000000-0000-4000-b000-${String(++planSeq).padStart(12, '0')}`;
  const plan = (goal, outcome, acceptance, edits, { at, stale = false } = {}) => {
    const requestId = planId();
    submitWorkRequest(store, { projectId: 'recipes', route: 'goal', text: goal, trackingIssue: 1, requestId }, at);
    const writes = [`src/${requestId.slice(-2)}/`];
    const proposal = { summary: `Synthetic plan: ${outcome}`, plan: 'One step, checked by the independent checker.', steps: [{ title: outcome, check: acceptance[0] }], questions: [],
      outline: { checks: acceptance.map(() => 'Opened the synthetic recipe page'), included: [outcome], later: [], estimate: { amount: 1, unit: 'days' } },
      declaration: { outcome, acceptance, writes, deliverables: ['commit'], constraints: ['Synthetic review fixture: no network, no production.'],
        tasks: [{ id: 'T1', title: outcome.toLowerCase(), deliverable: 'commit', goal: `${outcome}.`, dependsOn: [], acceptance, references: ['README.md'], writes }] } };
    let draft = recordDraft(store, { request: workRequest(store, requestId), proposal, pinned: { base: sha(recipes, 'metric-units') }, now: at + 10 * M });
    for (const [index, edit] of edits.entries()) {
      draft = reviseDraft(store, { requestId, version: draft.version, authorityDigest: draft.authority_digest, editId: planId(),
        edits: { outcome: draft.declaration.envelope.outcome, criteria: acceptance.map((text) => ({ text, check: 'Opened the synthetic recipe page' })), included: [outcome], later: [],
          horizon: 'now', priority: 'normal', estimate: { amount: 1, unit: 'days' }, ...edit } }, at + (index + 2) * H).draft;
    }
    if (stale) store.run("UPDATE work_drafts SET state = 'stale', stale_what = ? WHERE request_id = ? AND version = ?", ['a new version of the project'], requestId, draft.version);
  };
  plan('Users can print a shopping list from a recipe.', 'Shopping list from a recipe', ['The list holds every ingredient', 'It prints on one page'],
    [{ priority: 'high', estimate: { amount: 2, unit: 'days' } }], { at: now - 30 * H });
  plan('Users can rate recipes.', 'Recipe ratings', ['A rating of 1 to 5 stars is saved'], [{ horizon: 'next' }], { at: now - 28 * H });
  plan('Users can plan meals for a week.', 'Weekly meal planner', ['Seven days show one recipe each'],
    [{ horizon: 'later' }, { horizon: 'later', later: ['Share the plan with family'] }], { at: now - 26 * H });
  plan('Recipes show their cooking time.', 'Cooking time on each recipe', ['Every recipe shows minutes'], [], { at: now - 24 * H, stale: true });
  submitWorkRequest(store, { projectId: 'recipes', route: 'goal', text: 'Users can import recipes from a photo.', trackingIssue: 1, requestId: planId() }, now - 20 * M);

  // The campaign counters follow the runs, as the supervisor keeps them: every recorded run counts unless it was refunded,
  // and every cost a run reported adds to the total. So a project's total is the sum of what its runs reported.
  for (const { id: campaignId } of store.all('SELECT id FROM campaigns')) {
    const outcomes = store.all('SELECT outcome FROM operations WHERE campaign_id = ?', campaignId).map((op) => op.outcome);
    setCampaign(campaignId, { runs_used: outcomes.filter((outcome) => !runNotCounted(outcome)).length,
      cost_usd: Math.round(outcomes.reduce((sum, outcome) => sum + (outcome?.receipt?.costUsd > 0 ? outcome.receipt.costUsd : 0), 0) * 10000) / 10000 });
  }

  // Settings › Messages: Plan only requests with each receipt of OWNER_WORKSPACE §5.4 (answered, read, received), written as the
  // dashboard and the coordinator write them. The answer links a made-up comment.
  const message = (project, goal, at) => postOwnerMessage(store, { text: planRequestText({ project, goal, from: 'description' }),
    requestId: `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`, source: 'owner (Start work: Plan only)' }, at).id;
  const coordinatorRun = (state, at, messageIds) => {
    const runId = `coordinator-review-${++seq}`, runDir = join(dataDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const recorded = { runId, workspace: join(root, 'worktrees', runId), sessionId: `00000000-0000-4000-a000-${String(seq).padStart(12, '0')}` };
    store.insert('coordinator_runs', { id: runId, state, session_id: recorded.sessionId, run_dir: runDir, workspace: recorded.workspace,
      message_ids: messageIds, outcome: null, cost_usd: null, created_at: at, updated_at: at });
    for (const messageId of messageIds) {
      store.run("UPDATE owner_messages SET state = 'read', run_id = ?, read_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?", runId, at, at, messageId);
    }
    return recorded;
  };
  const answered = message('example/recipes', 'Users can print a shopping list from a recipe.', now - 3 * H);
  const reply = coordinatorRun('answered', now - 3 * H + M, [answered]), key = `${LANE}:${reply.runId}:reply`;
  store.run("INSERT INTO outbox (key, campaign_id, target, body, state, attempts, posted, updated_at) VALUES (?, ?, ?, ?, 'posted', 1, ?, ?)",
    key, LANE, COORDINATOR.reportTo, 'Synthetic plan reply.', 'https://github.com/example/recipes/issues/1#issuecomment-1001', now - 3 * H + 20 * M);
  store.run("UPDATE owner_messages SET state = 'answered', answered_at = ?, response_key = ?, updated_at = ? WHERE id = ?", now - 3 * H + 20 * M, key, now - 3 * H + 20 * M, answered);
  const reading = coordinatorRun('dispatched', now - 11 * M, [message('example/shop-app', 'Customers can pay with a gift card.', now - 12 * M)]);
  transcript(reading, now - 11 * M, now - M);
  message('example/notes-site', 'Notes can be exported as a PDF.', now - 2 * M);

  return { declarations, repositories: Object.fromEntries(Object.entries(repos).map(([name, repo]) => [name, { path: repo.path }])),
    commits: Object.fromEntries(Object.entries(repos).map(([name, repo]) => [name, repo.shas])), heartbeats: working };
}

/**
 * A disposable runtime checkout, like workstation's `.local/runtime`: this repository's code (RUNTIME_PARTS) and the
 * synthetic declarations in ignored campaigns/, with only code committed and pushed to a local bare origin, so its origin/main holds the code.
 * Its node_modules is a link to this repository's, so nothing is installed. The review dashboard runs from here, so
 * Resume's AW-005 check reads this checkout, never this repository.
 */
function runtimeCheckout(root, declarations) {
  const built = fromTemplate(JSON.stringify(['runtime', declarations]), (dir) => buildRuntime(dir, declarations));
  const path = join(root, 'runtime'), origin = join(root, 'git', 'aiworks.git');
  copyRepository(built, path, origin);
  // A junction needs no privilege on Windows. Deleting the fixture removes the link, never what it points at.
  symlinkSync(join(ROOT, 'node_modules'), join(path, 'node_modules'), 'junction');
  return path;
}

function buildRuntime(root, declarations) {
  const path = join(root, 'runtime'), origin = join(root, 'git', 'aiworks.git');
  mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  mkdirSync(join(path, 'campaigns'), { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  for (const part of RUNTIME_PARTS) cpSync(join(ROOT, part), join(path, part), { recursive: true });
  for (const d of declarations) writeFileSync(join(path, 'campaigns', `${d.campaignId}.json`), `${JSON.stringify(d, null, 2)}\n`);
  writeFileSync(join(path, '.gitignore'), '/node_modules\n/campaigns/\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'Review fixture runtime: AIWorks code and the synthetic declarations');
  git(path, 'remote', 'add', 'origin', origin);
  git(path, 'push', '-q', 'origin', 'main');
  git(path, 'fetch', '-q', 'origin');
  return { path, origin };
}

/**
 * Builds a review fixture under `root` (a new or empty directory) and returns its paths. `store`: 'full' (every
 * state), 'stopped' (the full store with every lease ended two hours ago: AIWorks stopped on this computer), 'empty'
 * (first run, no projects) or 'unreadable'. Writes `<root>/data/supervisor.db`, and
 * `<root>/data/config.json` with `repositories`, a made-up `supervisorIssue` and, for the full store, a `coordinator`
 * that reports to a made-up issue (no commands, no credentials, no `gh`). It sets no `autoReleaseDecision`, so Auto
 * Release links no issue. Writes `<root>/governance`: a copy of
 * GOVERNANCE whose roadmap documents and project registry are REVIEW_GOVERNANCE's (GOVERNANCE is not changed);
 * `<root>/claude`, the Claude transcripts of the working agents; and `<root>/runtime` (runtimeCheckout).
 */
export function buildReviewFixture(root, { now = Date.now(), store: kind = 'full' } = {}) {
  if (!['full', 'stopped', 'empty', 'unreadable'].includes(kind)) throw new Error('store must be full, stopped, empty or unreadable');
  if (existsSync(root) && readdirSync(root).length) throw new Error('the review fixture needs a new or empty directory');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  let built = { declarations: [], repositories: {}, commits: {}, heartbeats: [] };
  if (kind === 'unreadable') writeFileSync(join(dataDir, 'supervisor.db'), 'not a supervisor store\n');
  else {
    const store = new Store(join(dataDir, 'supervisor.db'));
    try {
      if (['full', 'stopped'].includes(kind)) built = fill(store, dataDir, root, now);
      // No controller renews any lease: the computer-wide state is "stopped" (src/supervisor/api.mjs supervisorLiveness).
      if (kind === 'stopped') store.run('UPDATE leases SET acquired_at = MIN(acquired_at, ?), expires_at = ? WHERE expires_at > ?', now - 3 * H, now - 2 * H, now - 2 * H);
    }
    finally { store.close(); }
  }
  const { declarations, ...paths } = built;
  // The full store has Plan and do and Add project on, so Plan, Review's Edit plan and the idea-first Add project show.
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ repositories: paths.repositories, governanceRoot: join(root, 'governance'),
    ...(['full', 'stopped'].includes(kind) ? { coordinator: { ...COORDINATOR, intake: true }, projectConnection: { enabled: true } } : {}), supervisorIssue: REVIEW_SUPERVISOR_ISSUE }, null, 2));
  const governance = join(root, 'governance');
  cpSync(GOVERNANCE, governance, { recursive: true });
  rmSync(join(governance, 'registry', 'projects'), { recursive: true });
  cpSync(REVIEW_GOVERNANCE, governance, { recursive: true });
  return { root, dataDir, governance, claudeConfigDir: join(root, 'claude'), runtime: runtimeCheckout(root, declarations), now, ...paths };
}

/** Command-line entry: build a fixture, then run the unchanged dashboard against it in this process. */
async function serve(args) {
  const options = { '--port': String(REVIEW_PORT), '--store': 'full' };
  for (let i = 0; i < args.length; i += 2) {
    if (!['--port', '--store', '--dir'].includes(args[i]) || !args[i + 1]) {
      throw new Error('Usage: node tests/dashboard/fixtures/review-store.mjs [--port 4319] [--store full|stopped|empty|unreadable] [--dir <new directory>]');
    }
    options[args[i]] = args[i + 1];
  }
  const port = Number(options['--port']);
  if (port === LIVE_PORT) throw new Error(`Port ${LIVE_PORT} is the live dashboard's; use ${REVIEW_PORT}.`);
  const owned = !options['--dir'];
  const root = owned ? mkdtempSync(join(tmpdir(), 'aiworks-review-')) : resolve(options['--dir']);
  if (owned) process.on('exit', () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const fixture = buildReviewFixture(root, { store: options['--store'] });
  // Keep the working agents' heartbeats current for the whole review; the timer never keeps the process alive.
  setInterval(() => { for (const dir of fixture.heartbeats) writeFileSync(join(dir, 'heartbeat'), String(Date.now())); }, 30_000).unref();
  console.log(`Review fixture (${options['--store']}): ${fixture.dataDir}`);
  // The working agents' transcripts are the fixture's, never this computer's own Claude directory.
  process.env.CLAUDE_CONFIG_DIR = fixture.claudeConfigDir;
  const main = join(fixture.runtime, 'src', 'dashboard', 'main.mjs');
  process.argv = [process.argv[0], main, '--data', fixture.dataDir, '--port', String(port), '--governance', fixture.governance];
  await import(pathToFileURL(main).href);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
