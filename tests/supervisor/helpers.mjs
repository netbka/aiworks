// Shared harness for AIWorks supervisor tests: a disposable git origin + clone, synthetic
// claude/gh executables and fast timings. No network, model, production or GitHub access.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..', '..');
export const CLI = join(ROOT, 'src', 'supervisor', 'cli.mjs');
// A small stand-in for the Engineering Platform checkout AIWorks reads governance from; tests never need a real one.
export const GOVERNANCE = join(ROOT, 'tests', 'fixtures', 'governance');

let sqliteAvailable = true;
try { await import('node:sqlite'); } catch { sqliteAvailable = false; }
export const SQLITE = sqliteAvailable;
export const skipWithoutSqlite = !sqliteAvailable ? 'node:sqlite requires Node >= 22.5; the supervisor refuses to run without it'
  : process.platform !== 'win32' ? 'worker execution requires Windows Job Object containment' : false;

const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};

export const FAST = {
  // Allow the native Windows helper to compile and drain without declaring its runner lost. A lease must outlive one tick,
  // and a dispatching tick awaits the runner receipt for up to dispatchWaitMs (5 s) without renewing it. Under load,
  // controllers renewed their 1.5 s lease up to 3.5 s late (engineering-platform-archive#58), so it is 2 x dispatchWaitMs, as production's 90 s exceeds 15 s.
  // staleMs and startGraceMs stay 5 s: under 24 busy processes on 20 cores, runners beat at most 1.9 s apart and wrote
  // their first beat within 1.5 s of spawn (tests/supervisor/measure-liveness.mjs), so a healthy runner is never stale.
  tickMs: 50, leaseMs: 10_000, pollMs: 500, heartbeatMs: 100, staleMs: 5000, startGraceMs: 5000,
  dispatchWaitMs: 5000, publishRetryMs: 200, outboxRetryMs: 100, retryBackoffMs: [50, 50, 50],
  codexSandboxProbe: false, // synthetic executors: never spawn the real Codex sandbox helper
};

export function environment({ scenario = {}, config = {} } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'aiworks-supervisor-'));
  const origin = join(tmp, 'origin.git');
  const repo = join(tmp, 'repo');
  const stateClaude = join(tmp, 'claude');
  const stateGh = join(tmp, 'gh');
  const dataDir = join(tmp, 'data');
  for (const dir of [stateClaude, stateGh, dataDir]) mkdirSync(dir, { recursive: true });
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'Supervisor Test');
  git(repo, 'config', 'user.email', 'supervisor-test@example.invalid');
  writeFileSync(join(repo, 'AGENTS.md'), '# Test repository rules\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  writeFileSync(join(stateClaude, 'scenario.json'), JSON.stringify(scenario));
  const env = {
    FAKE_CLAUDE_STATE: stateClaude, FAKE_GH_STATE: stateGh,
    GIT_AUTHOR_NAME: 'Fake Worker', GIT_AUTHOR_EMAIL: 'worker@example.invalid',
    GIT_COMMITTER_NAME: 'Fake Worker', GIT_COMMITTER_EMAIL: 'worker@example.invalid',
  };
  Object.assign(process.env, env);
  const fullConfig = {
    ...FAST,
    governanceRoot: GOVERNANCE,
    repositories: { 'netbka/Dyk': { path: repo, worktreeRoot: join(tmp, 'worktrees') } },
    commands: {
      claude: [process.execPath, join(here, 'fixtures', 'fake-claude.mjs')],
      gh: [process.execPath, join(here, 'fixtures', 'fake-gh.mjs')],
    },
    ...config,
  };
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(fullConfig, null, 2));
  return {
    tmp, origin, repo, dataDir, env, config: fullConfig,
    calls: () => (existsSync(join(stateClaude, 'calls.jsonl'))
      ? readFileSync(join(stateClaude, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    prs: () => (existsSync(join(stateGh, 'prs.json')) ? JSON.parse(readFileSync(join(stateGh, 'prs.json'), 'utf8')) : []),
    comments: () => (existsSync(join(stateGh, 'comments.jsonl'))
      ? readFileSync(join(stateGh, 'comments.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    // Every synthetic gh call, in order: { args, at }. The fake refuses GraphQL-backed commands (gh pr ..., gh api graphql).
    ghCalls: () => (existsSync(join(stateGh, 'gh-calls.jsonl'))
      ? readFileSync(join(stateGh, 'gh-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    // Make one REST route ('GET pulls', 'POST pulls', 'GET pull', 'POST comments', or '*') refuse with a rate limit `times` times.
    rateLimit: (limit) => writeFileSync(join(stateGh, 'rate-limit.json'), JSON.stringify(limit)),
    // The owner merged the PR of `branch`: the synthetic gh no longer lists it as open. The test moves the base itself.
    markMerged: (branch, mergeCommit = null) => writeFileSync(join(stateGh, 'prs.json'), JSON.stringify(
      JSON.parse(readFileSync(join(stateGh, 'prs.json'), 'utf8')).map((pr) => (pr.head === branch ? { ...pr, merged: true, mergeCommit } : pr)))),
    remoteHead: (branch) => spawnSync('git', ['ls-remote', origin, `refs/heads/${branch}`], { encoding: 'utf8', windowsHide: true }).stdout.split(/\s/)[0] || null,
    setScenario: (next) => writeFileSync(join(stateClaude, 'scenario.json'), JSON.stringify(next)),
    cleanup: () => {
      if (existsSync(join(dataDir, 'test-failure.json'))) return; // Preserve only failed synthetic runs for diagnosis.
      try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may hold files briefly */ }
    },
  };
}

export function declaration({ tasks, limits = {}, version = 1, campaignId = 'test-campaign' } = {}) {
  return {
    version: 1,
    campaignId,
    authorization: { version, grantedBy: 'owner', grantedAt: '2026-10-09', reference: 'https://github.com/netbka/aiworks/issues/2', text: 'Synthetic test authorization.' },
    target: { tenantId: 'netbka', projectId: 'dyk', environment: 'research', repository: 'netbka/Dyk', baseBranch: 'main', trackingIssue: 443 },
    limits: { maxWorkerRuns: 12, slots: 1, maxRepairRounds: 2, maxRetriesPerTask: 2, ...limits },
    executor: { kind: 'claude-cli', model: 'opus', permissionMode: 'auto', implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 },
    constraints: ['Synthetic test constraint: no network, no production.'],
    tasks: tasks ?? [
      { id: 'T1', issue: 437, title: 'first task', deliverable: 'commit', goal: 'Produce the first artifact.', dependsOn: [], acceptance: ['artifact exists'], references: ['AGENTS.md'] },
      { id: 'T2', issue: 438, title: 'second task', deliverable: 'commit', goal: 'Produce the second artifact.', dependsOn: ['T1'], acceptance: ['artifact exists'], references: ['AGENTS.md'] },
    ],
  };
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * A disposable AIWorks checkout for tests that run cli.mjs as a process (AW-005): a temp git repository holding a copy of
 * this tree's supervisor code, worker-context runtime, schemas and campaigns, plus any extra `declarations`, committed
 * with `refs/remotes/origin/main` at that commit, so it is "merged main". `unmerged: true` adds one local commit that
 * origin/main does not contain. node_modules is linked, never copied or committed. The real checkout's own git state
 * (a campaign branch, a CI merge commit) therefore never decides a test. Governance still comes from GOVERNANCE.
 */
export function runtimeCheckout({ declarations = {}, unmerged = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-runtime-'));
  for (const dir of ['src/supervisor', 'scripts/lib', 'registry', 'schemas', 'campaigns']) {
    cpSync(join(ROOT, dir), join(root, dir), { recursive: true });
  }
  cpSync(join(ROOT, 'package.json'), join(root, 'package.json'));
  for (const [name, value] of Object.entries(declarations)) writeFileSync(join(root, 'campaigns', name), `${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'junction');
  // autocrlf=true, as on HomePc: committed blobs are LF while working files may keep CRLF.
  const run = (...args) => git(root, '-c', 'user.name=Runtime Test', '-c', 'user.email=runtime-test@example.invalid', '-c', 'core.autocrlf=true', ...args);
  run('init', '-q', '-b', 'main');
  run('add', '-A');
  run('commit', '-q', '-m', 'merged runtime');
  run('update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (unmerged) {
    writeFileSync(join(root, 'UNMERGED.md'), 'A local commit that origin/main does not contain.\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'unmerged local change');
  }
  return {
    root, cli: join(root, 'src', 'supervisor', 'cli.mjs'), git: run,
    // The node_modules junction is removed as a link; rmSync never follows it into the real dependencies.
    cleanup: () => { try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may hold files briefly */ } },
  };
}

/** Run `cli.mjs <args>` from `cli` as the owner would, with a clean environment for the store selection. */
export function runCli(cli, args) {
  const env = { ...process.env, AIWORKS_DATA: '' };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--no-warnings', cli, ...args], { env, windowsHide: true, encoding: 'utf8' });
}

/** Tick a controller until the predicate holds, asserting the liveness invariant on every tick. The generous
 * deadline only matters when a run is slow under machine load (engineering-platform-archive#58); a passing test returns as soon as it holds. */
export async function runUntil(controller, store, campaignId, predicate, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await controller.tick();
    const campaign = store.campaign(campaignId);
    if (campaign?.liveness_defect) throw new Error(`liveness defect: ${JSON.stringify(store.tasks(campaignId).map((t) => [t.task_id, t.state, t.blocked]))}`);
    if (predicate(campaign)) return campaign;
    await sleep(40);
  }
  const operations = store.all('SELECT id, state, run_dir, outcome FROM operations WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 8', campaignId)
    .map((op) => ({ ...op, files: Object.fromEntries(['runner.json', 'result.json', 'heartbeat', 'launch.json'].map((name) => {
      try { return [name, readFileSync(join(op.run_dir, name), 'utf8').slice(-4000)]; }
      catch (error) { return [name, error.code]; }
    })), locked: existsSync(join(op.run_dir, 'run.lock')) }));
  const evidence = { campaign: store.campaign(campaignId), tasks: store.tasks(campaignId), operations,
    journal: store.all('SELECT kind, detail, at FROM journal WHERE campaign_id = ? ORDER BY seq DESC LIMIT 12', campaignId) };
  const evidencePath = join(controller.dataDir, 'test-failure.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  throw new Error(`timed out; preserved ${evidencePath}; ${JSON.stringify(evidence)}`);
}
