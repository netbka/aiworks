// Shared harness of the AIWorks crash/restart rehearsals (restart*.test.mjs) with real `serve` processes. Each case kills
// the controller (or the whole host-side process tree) at a mutation boundary and proves the
// replacement continues without an owner "continue", without duplicate dispatch or publication.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { declaration, environment, sleep, runtimeCheckout } from './helpers.mjs';

export const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

/**
 * One more disposable origin and clone for `repository` (a project registered in the test governance), added to the
 * environment's config.json before `serve` reads it. Campaigns on different repositories never share a write domain.
 */
export function addRepository(env, repository) {
  const name = repository.split('/')[1];
  const origin = join(env.tmp, `${name}-origin.git`);
  const repo = join(env.tmp, `${name}-repo`);
  git(env.tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(env.tmp, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'Supervisor Test');
  git(repo, 'config', 'user.email', 'supervisor-test@example.invalid');
  writeFileSync(join(repo, 'AGENTS.md'), `# ${name} test repository rules\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  mkdirSync(join(env.tmp, `${name}-worktrees`), { recursive: true });
  env.config.repositories[repository] = { path: repo, worktreeRoot: join(env.tmp, `${name}-worktrees`) };
  writeFileSync(join(env.dataDir, 'config.json'), JSON.stringify(env.config, null, 2));
  return origin;
}

export async function harness(t, { scenario, decl, config = {}, repositories = [] }) {
  const { Store } = await import('../../src/supervisor/store.mjs');
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const { stopOwnedRun } = await import('../../src/supervisor/proc.mjs');
  const env = environment({ scenario, config });
  const origins = { 'example-org/sampleapp': env.origin };
  for (const repository of repositories) origins[repository] = addRepository(env, repository);
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = decl ?? declaration({ tasks: [declaration().tasks[0]] });
  campaignStart(store, d);
  // `serve` starts new work only from code merged into origin/main (AW-005): run it from a merged runtime checkout.
  const runtime = runtimeCheckout();
  const children = new Set();
  const serve = (extraEnv = {}) => {
    const child = spawn(process.execPath, ['--no-warnings', runtime.cli, 'serve', '--data', env.dataDir], {
      env: { ...process.env, ...env.env, ...extraEnv }, stdio: 'ignore', windowsHide: true,
    });
    children.add(child);
    child.exited = new Promise((done) => child.on('exit', (code) => { children.delete(child); done(code); }));
    return child;
  };
  // Up to three contained runs (20-30 s each under heavy load, measure-liveness.mjs), a lease takeover and a stale
  // heartbeat must fit; a passing case returns as soon as the predicate holds (historical regression).
  const waitFor = async (predicate, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`timed out: ${JSON.stringify(store.campaign(d.campaignId))} ${JSON.stringify(store.tasks(d.campaignId))}`);
  };
  const finished = () => waitFor(() => store.campaign(d.campaignId).control === 'finished');
  t.after(async () => {
    for (const child of children) child.kill();
    await sleep(200);
    store.close();
    env.cleanup();
    runtime.cleanup();
  });
  // The branch head in the origin of `repository`, or null.
  const remoteHead = (repository, branch) => spawnSync('git', ['ls-remote', origins[repository], `refs/heads/${branch}`],
    { encoding: 'utf8', windowsHide: true }).stdout.split(/\s/)[0] || null;
  return { env, store, d, id: d.campaignId, serve, waitFor, finished, stopOwnedRun, remoteHead };
}

export const ops = (store, id) => store.all('SELECT id, kind, state, outcome FROM operations WHERE campaign_id = ? ORDER BY created_at', id);

// ---- RUN6 (ADAPTIVE_SCHEDULER slice S7): the same guarantees with several open operations and two controllers. ----
// The fake worker commits at the repository root, so each task here declares no `writes` and owns its whole repository
// (ADAPTIVE_SCHEDULER 4.3). Campaigns that may run side by side target different repositories; campaigns on one
// repository share its domain and must take turns.

export const PROJECTS = { 'example-org/sampleapp': 'sampleapp', 'example-org/service': 'service', 'example-org/sample-wiki': 'sample-wiki' };
/** A campaign of one commit task on `repository`. */
export const single = (campaignId, issue, repository = 'example-org/sampleapp') => {
  const d = declaration({ campaignId, tasks: [{ id: 'T1', issue, title: `task of ${campaignId}`, deliverable: 'commit',
    goal: `Produce the artifact of ${campaignId}.`, dependsOn: [], acceptance: ['artifact exists'], references: ['AGENTS.md'] }] });
  return { ...d, target: { ...d.target, repository, projectId: PROJECTS[repository] } };
};
export const implementCalls = (h) => h.env.calls().filter((c) => c.role === 'implement').length;
export const allFinished = (h, ids) => ids.every((id) => h.store.campaign(id).control === 'finished');
export const openOperations = (store) => store.all("SELECT id, campaign_id, kind FROM operations WHERE state IN ('recorded', 'dispatched')");
/**
 * The most operations the store ever held open at once. An operation is open from its record (created_at) until its
 * final state (updated_at); one still open counts to the end. At equal times a close comes before an open: admission
 * reads only committed rows, so a slot freed and taken in the same millisecond was never shared.
 */
export const peakOpen = (store) => {
  const events = store.all('SELECT state, created_at, updated_at FROM operations').flatMap((op) =>
    [[op.created_at, 1], ...(['recorded', 'dispatched'].includes(op.state) ? [] : [[op.updated_at, -1]])]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0, peak = 0;
  for (const [, delta] of events) peak = Math.max(peak, open += delta);
  return peak;
};
