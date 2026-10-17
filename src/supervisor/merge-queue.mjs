// AIWorks merge queue (opt-in: config.json `merges.queue: true`). Without it, every move of the base reopens each waiting
// pull request as an integration repair round: a model merges the base in and runs the full gate, then a second model
// verifies, once per pull request per move. With it, a verified pull request whose head no longer contains the base, and
// merges into it without a textual conflict, is integrated by the supervisor itself:
//
//   1. Stack: the waiting pull requests of the repository, in candidate order, are merged one on top of the other with
//      the base first (`git merge-tree`, `git commit-tree`; objects only, no worktree, the verified head as first parent).
//      The stack stops at the first one that conflicts; that one waits for the existing model repair.
//   2. Gate: the full gate runs once, on the top of the stack, in a detached worktree inside the same Windows job
//      containment as a worker (runner.mjs), through gate.mjs so it takes a gate slot.
//   3. Passed: each integrated head is pushed to its own branch as a plain fast-forward (the verified head is its first
//      parent; never a force-push) and becomes the task's verified head, with the gate result as its verification. Only
//      the top pull request is merged, by the unchanged merge gate: its head contains the base, so the merge puts exactly
//      the gated tree on the base. The pull requests below it are in that merge and are recorded as merged with it.
//   4. Failed, or the gate process was lost: nothing is pushed, and the first pull request goes to the existing model
//      repair round with the failing summary. A base that moved, or a task, campaign or pull request that changed while
//      the gate ran, discards the stack; the next pass builds a new one.
//
// A queue in progress is a file per repository under <data>/merge-queue, so it survives a controller restart.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gitA from './adapters/git.mjs';
import * as github from './adapters/github.mjs';
import { gateFailure, testSummary } from './gate.mjs';
import { readJsonIfExists, readTextIfExists, stopOwnedRun, writeAtomic } from './proc.mjs';

const GATE = fileURLToPath(new URL('./gate.mjs', import.meta.url));
const RUNNER = fileURLToPath(new URL('./runner.mjs', import.meta.url));
/** At most this many pull requests in one stack, so one failing gate never sends back more than it must. */
export const QUEUE_LIMIT = 6;
const GATE_COMMAND = 'npm ci --no-audit --no-fund && npm run check';
const GATE_TIMEOUT_MS = 120 * 60_000;
const IDENTITY = ['-c', 'user.name=AIWorks merge queue', '-c', 'user.email=merge-queue@aiworks.invalid'];

/** The default gate: gate.mjs run in a contained runner, the same containment and result files as a worker run. */
export const runnerGate = {
  start({ runDir, cwd, heartbeatMs, command = GATE_COMMAND }) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'prompt.txt'), '');
    writeAtomic(join(runDir, 'spec.json'), JSON.stringify({ argv: [process.execPath, GATE, 'run', command], cwd, timeoutMs: GATE_TIMEOUT_MS, heartbeatMs }));
    const child = spawn(process.execPath, [RUNNER, runDir], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => writeAtomic(join(runDir, 'result.json'), JSON.stringify({ spawnError: 'runner-spawn-failed' })));
    child.unref();
  },
  /** null while it runs; else { exit, summary }. `exit` is the gate command's exit code as text when it finished. */
  read({ runDir, cwd, startedAt }, { now, staleMs, startGraceMs }) {
    const result = readJsonIfExists(join(runDir, 'result.json'));
    if (!result) {
      const beat = Number(readTextIfExists(join(runDir, 'heartbeat')) || 0);
      if (beat ? now - beat < staleMs : now - startedAt < startGraceMs) return null;
      const runner = readJsonIfExists(join(runDir, 'runner.json'));
      return { exit: `lost (${runner ? stopOwnedRun(runner) : 'no runner'})`, summary: null };
    }
    if (result.spawnError) return { exit: `spawn-error ${result.spawnError}`, summary: null };
    const summary = testSummary(readTextIfExists(join(runDir, 'stdout.json')) ?? '');
    if (result.timedOut) return { exit: 'timed-out', summary };
    return { exit: readTextIfExists(join(cwd, 'gate-exit.log'))?.trim() || 'none', summary };
  },
};

const statePath = (controller, repository) => join(controller.dataDir, 'merge-queue', `${repository.toLowerCase().replace('/', '__')}.json`);
const readState = (controller, repository) => readJsonIfExists(statePath(controller, repository));
function writeState(controller, state) {
  mkdirSync(join(controller.dataDir, 'merge-queue'), { recursive: true });
  writeAtomic(statePath(controller, state.repository), JSON.stringify(state));
}
const clearState = (controller, repository) => rmSync(statePath(controller, repository), { force: true });

/** The merge-queue integration that made `sha` this task's verified head, or null. */
export function queuedAt(store, campaignId, taskId, sha) {
  const row = store.get(`SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'queue-integrated'
    AND json_extract(detail, '$.task') = ? AND json_extract(detail, '$.sha') = ? ORDER BY seq DESC LIMIT 1`, campaignId, taskId, sha);
  return row?.detail ?? null;
}
const isTop = (queued, item) => queued.top.campaign === item.campaignId && queued.top.task === item.task.task_id;
/** The top of a stack still waits to merge at the integrated head: the heads below it merge with it. */
export function topWaits(store, queued) {
  const top = store.task(queued.top.campaign, queued.top.task);
  return Boolean(top && top.state === 'done' && !top.blocked && top.verified_sha === queued.top.sha);
}
/** The merge commit the top of a stack was merged with, or null while it is not merged. */
export function topMerge(store, queued) {
  const row = store.get(`SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'merged'
    AND json_extract(detail, '$.task') = ? AND json_extract(detail, '$.sha') = ? ORDER BY seq DESC LIMIT 1`, queued.top.campaign, queued.top.task, queued.top.sha);
  return row?.detail?.mergeCommit ?? null;
}

/** A later pull request may join the stack: open at its verified head on its campaign branch, never held or requested. */
function joinable(controller, item, settings, base) {
  const { store } = controller, { campaignId, decl, task, number } = item;
  if (decl.target.baseBranch !== base || settings.held.has(task.pr_url.toLowerCase())) return false;
  if (queuedAt(store, campaignId, task.task_id, task.verified_sha)) return false;
  if (store.get("SELECT 1 FROM journal WHERE campaign_id = ? AND kind = 'merge-requested' AND json_extract(detail, '$.task') = ? AND json_extract(detail, '$.sha') = ?",
    campaignId, task.task_id, task.verified_sha)) return false;
  let pr;
  try { pr = github.pullRequest({ gh: controller.cmd.gh, repository: decl.target.repository, number }); } catch { return false; }
  return !pr.merged && pr.state === 'open' && pr.url === task.pr_url && pr.headSha === task.verified_sha
    && pr.baseRef === base && pr.headRef === gitA.branchName(campaignId, task.task_id);
}

/**
 * Start a queue for `first` (whose verified head does not contain `baseSha` but merges into it cleanly) and the
 * joinable pull requests in `rest`. Inside no fence: each journal write takes its campaign's lease. Returns true.
 */
export function startQueue(controller, { first, rest, settings, repoPath, baseSha, lease }) {
  const git = controller.cmd.git, decl = first.decl, base = decl.target.baseBranch, repository = decl.target.repository;
  const id = `${controller.now().toString(36)}-${baseSha.slice(0, 8)}`;
  const items = [];
  let prev = baseSha;
  for (const item of [first, ...rest]) {
    if (items.length >= QUEUE_LIMIT) break;
    if (item !== first && !joinable(controller, item, settings, base)) continue;
    const sha = item.task.verified_sha, branch = gitA.branchName(item.campaignId, item.task.task_id);
    let stacked = sha;
    if (!gitA.isAncestor({ git, path: repoPath, ancestor: prev, descendant: sha })) {
      const check = gitA.mergeCheck({ git, repoPath, baseSha: prev, sha });
      if (!check.clean) break;
      const message = `Merge ${base} ${baseSha.slice(0, 12)}${items.length ? ` and ${items.length} queued pull request(s)` : ''} into ${branch} (merge queue ${id})`;
      stacked = gitA.exec(git, [...IDENTITY, 'commit-tree', check.tree, '-p', sha, '-p', prev, '-m', message], { cwd: repoPath }).stdout;
      if (!/^[0-9a-f]{40}$/.test(stacked ?? '')) throw new Error(`merge queue ${id}: commit-tree failed for ${branch}`);
    }
    items.push({ campaign: item.campaignId, task: item.task.task_id, url: item.task.pr_url, number: item.number, branch, verified: sha, stacked });
    prev = stacked;
  }
  const worktree = join(controller.repo(decl).worktreeRoot, `merge-queue-${id}`);
  const added = gitA.exec(git, ['worktree', 'add', '--detach', worktree, prev], { cwd: repoPath });
  if (!added.ok) throw new Error(`merge queue ${id}: worktree add failed: ${added.stderr}`);
  const state = { id, repository, baseBranch: base, baseSha, items, top: prev, worktree, runDir: join(controller.dataDir, 'runs', `merge-queue-${id}`),
    phase: 'gate', startedAt: controller.now() };
  writeState(controller, state);
  (controller.queueGate ?? runnerGate).start({ runDir: state.runDir, cwd: worktree, heartbeatMs: controller.config.heartbeatMs });
  note(controller, state, lease, 'queue-started', (item) => ({ task: item.task, sha: item.verified, stacked: item.stacked, queue: id, base: baseSha, size: items.length }));
  controller.log(`merge queue ${id} for ${repository}: full gate on ${prev} (${items.map((item) => `${item.campaign}/${item.task}`).join(', ')}) over ${base} ${baseSha}`);
  return true;
}

/** One journal row per item, each in its own campaign's lease. */
function note(controller, state, lease, kind, detail) {
  for (const item of state.items) {
    const ctx = lease(controller, item.campaign);
    if (ctx) controller.fenced(ctx, () => controller.store.journal(item.campaign, kind, detail(item), controller.now()));
  }
}

/** Why the stack no longer describes the repository, or null when every item still waits at its verified head. */
function stale(controller, state, repoPath, gh) {
  const fetched = controller.fetchBase(repoPath, state.baseBranch);
  if (!fetched.ok) return 'the base could not be fetched';
  if (fetched.sha !== state.baseSha) return `${state.baseBranch} moved to ${fetched.sha} while the gate ran`;
  for (const item of state.items) {
    const campaign = controller.store.campaign(item.campaign), task = controller.store.task(item.campaign, item.task);
    if (!['registered', 'finished'].includes(campaign?.control)) return `${item.campaign} is ${campaign?.control ?? 'gone'}`;
    // While pushing, a branch may already be at its integrated head: pushed, then the controller stopped before recording.
    const heads = state.phase === 'push' ? [item.verified, item.stacked] : [item.verified];
    if (task?.state !== 'done' || task.blocked || !heads.includes(task.verified_sha) || task.pr_url !== item.url) return `${item.campaign}/${item.task} changed`;
    let pr;
    try { pr = github.pullRequest({ gh, repository: state.repository, number: item.number }); } catch { return `${item.url} could not be read`; }
    if (pr.merged || pr.state !== 'open' || !heads.includes(pr.headSha)) return `${item.url} is no longer open at ${item.verified}`;
  }
  return null;
}

/**
 * Advance the repository's queue, if it has one. Returns true while a queue owns the repository, so the merge pass
 * merges nothing else there: any merge would move the base under the gate.
 */
export function advanceQueue(controller, { repository, repoPath, lease, repair }) {
  const state = readState(controller, repository);
  if (!state) return false;
  const { store } = controller, git = controller.cmd.git, now = controller.now();
  if (state.phase === 'gate') {
    const out = (controller.queueGate ?? runnerGate).read(state, { now, staleMs: controller.config.staleMs, startGraceMs: controller.config.startGraceMs });
    if (!out) return true;
    state.gate = out;
    state.phase = out.exit === '0' && !gateFailure(out) ? 'push' : 'failed';
    writeState(controller, state);
  }
  gitA.exec(git, ['worktree', 'remove', '--force', state.worktree], { cwd: repoPath });
  const why = stale(controller, state, repoPath, controller.cmd.gh);
  if (why) {
    note(controller, state, lease, 'queue-discarded', (item) => ({ task: item.task, sha: item.verified, queue: state.id, reason: why }));
    controller.log(`merge queue ${state.id} for ${repository} discarded: ${why}`);
    clearState(controller, repository);
    return true;
  }
  if (state.phase === 'failed') {
    note(controller, state, lease, 'queue-failed', (item) => ({ task: item.task, sha: item.verified, queue: state.id, exit: state.gate.exit, summary: state.gate.summary }));
    const first = state.items[0], ctx = lease(controller, first.campaign);
    if (!ctx) return true;
    const campaign = store.campaign(first.campaign);
    controller.fenced(ctx, () => repair(controller, ctx, { campaignId: first.campaign, decl: campaign.declaration, task: store.task(first.campaign, first.task) }, repoPath, state.baseSha,
      `The merge queue merged ${state.baseBranch} into this branch${state.items.length > 1 ? ` with ${state.items.length - 1} later pull request(s) on top` : ''} and ran the full gate on the result; it failed (exit ${state.gate.exit}${state.gate.summary ? `; ${state.gate.summary.replace(/\n/g, '; ')}` : ''}).`));
    controller.log(`merge queue ${state.id} for ${repository} failed (exit ${state.gate.exit}): ${first.campaign}/${first.task} goes to an integration repair round`);
    clearState(controller, repository);
    return true;
  }
  const top = state.items.at(-1);
  for (const item of state.items) {
    const ctx = lease(controller, item.campaign);
    if (!ctx) return true;
    const done = controller.fenced(ctx, () => {
      const task = store.task(item.campaign, item.task);
      if (task.verified_sha === item.stacked) return true;
      if (item.stacked !== item.verified) gitA.pushVerified({ git, repoPath, branch: item.branch, sha: item.stacked });
      store.patch('tasks', { campaign_id: item.campaign, task_id: item.task }, task.version, {
        verified_sha: item.stacked,
        verification: { verdict: 'accepted', by: 'merge-queue', queue: state.id, from: item.verified, base: state.baseSha, targetSha: item.stacked,
          checks: [{ command: GATE_COMMAND, at: state.top, result: 'pass', summary: state.gate.summary }], previous: task.verification ?? null },
      }, controller.now());
      store.journal(item.campaign, 'queue-integrated', { task: item.task, from: item.verified, sha: item.stacked, base: state.baseSha, queue: state.id,
        top: { campaign: top.campaign, task: top.task, sha: top.stacked, url: top.url }, summary: state.gate.summary }, controller.now());
      return true;
    });
    if (!done) return true;
  }
  controller.log(`merge queue ${state.id} for ${repository} passed: ${top.url} merges ${state.items.length} pull request(s) at ${top.stacked}`);
  clearState(controller, repository);
  return true;
}
