// Safe checkout sync (docs/plans/git-maintenance-merge-orchestrator.md, stage P1, acceptance 4): bring an explicitly
// named checkout up to its own upstream as locally observed, by fast-forward only, and only when it is clean, on a
// branch with an upstream, has no commits of its own past that upstream and no recorded AIWorks activity. Everything
// else is left as it is and named. A dry run by default: the fast-forward runs only with `apply`, and then only for a
// checkout the owner listed under config.json `maintenance.sync` (separately authorized, never implied by merging).
// It never fetches: ahead and behind describe refs as the checkout has them. The fast-forward itself lives under
// release/ (REL5) and checks branch, changes and ancestry again right before it moves anything.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gitA from './adapters/git.mjs';
import { fastForwardFolder } from './release/folder-update.mjs';
import { LANE as COORDINATOR_LANE } from './coordinator.mjs';

const SHA = /^[0-9a-f]{40}$/;
const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OFF = Object.freeze({ enabled: false, checkouts: new Set(), problem: null });

const comparable = (path) => {
  let value;
  try { value = realpathSync.native(path); } catch { value = resolve(path); }
  value = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
const overlap = (a, b) => { const [x, y] = [comparable(a), comparable(b)]; return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`); };

/**
 * The owner's sync authorization from config.json `maintenance.sync`: `{ "enabled": true, "checkouts": ["<path>", ...] }`
 * lets `maintenance sync --apply` fast-forward exactly those checkouts. Absent: off, and every apply is refused.
 * Malformed: off, and `problem` says what is malformed.
 */
export function syncSettings(config) {
  const sync = config?.maintenance?.sync;
  if (sync === undefined || sync === null) return OFF;
  const off = (problem) => ({ ...OFF, problem: `checkout sync stays off: ${problem}` });
  if (typeof sync !== 'object' || Array.isArray(sync)) return off('maintenance.sync must be an object');
  if (sync.enabled !== true) return OFF;
  const list = sync.checkouts;
  if (!Array.isArray(list) || !list.length || !list.every((item) => typeof item === 'string' && item.trim())) {
    return off('maintenance.sync.checkouts must list the checkout paths that may be fast-forwarded');
  }
  return { enabled: true, checkouts: new Set(list.map((path) => comparable(path))), problem: null };
}

/** Recorded AIWorks activity on one checkout path: 'active', 'inactive', or 'unknown' when the store cannot say. */
function activity(store, path, now) {
  if (!store) return 'unknown';
  let ops, coordinators, leases;
  try {
    ops = store.all('SELECT campaign_id, state FROM operations WHERE lower(workspace) = lower(?) OR workspace = ?', path, path);
    coordinators = store.all('SELECT state FROM coordinator_runs WHERE lower(workspace) = lower(?) OR workspace = ?', path, path);
    leases = store.all('SELECT campaign_id, expires_at FROM leases');
  } catch { return 'unknown'; }
  const open = (state) => ['recorded', 'dispatched'].includes(state);
  const live = leases.some((lease) => lease.expires_at > now &&
    (ops.some((op) => op.campaign_id === lease.campaign_id) || (coordinators.length && lease.campaign_id === COORDINATOR_LANE)));
  return ops.some((op) => open(op.state)) || coordinators.some((op) => open(op.state)) || live ? 'active' : 'inactive';
}

/**
 * Judge, and with `apply` fast-forward, each checkout in `checkouts`. Returns a report: one entry per checkout with
 * `action` `updated`, `already`, `would-update` or `left`, the `reason` when left (`unreadable`, `not-authorized`,
 * `aiworks-runtime`, `detached`, `no-upstream`, `unknown-activity`, `active`, `changes`, `own-commits`), and the SHAs
 * read. Nothing is fetched, no hook runs, and a checkout left alone keeps every byte it had.
 */
export function safeSync({ checkouts = [], store = null, git = ['git'], dataDir = null, runtimeRoot = RUNTIME_ROOT, settings = OFF, apply = false, now = Date.now() } = {}) {
  const report = { schema: 'aiworks-maintenance-sync/1', observedAt: new Date(now).toISOString(), apply: apply === true,
    remoteState: 'locally-observed-only', authorization: settings.enabled ? 'configured' : 'absent', checkouts: [] };
  if (settings.problem) report.problem = settings.problem;
  const command = [...git, '-c', 'core.fsmonitor=false'];
  for (const requested of checkouts) {
    const entry = { path: resolve(requested), branch: null, upstream: null, head: null, target: null, activity: 'unknown', action: 'left', reason: null };
    report.checkouts.push(entry);
    let path;
    try { path = realpathSync.native(resolve(requested)); } catch { entry.reason = 'unreadable'; continue; }
    entry.path = path;
    const run = (...args) => gitA.exec(command, args, { cwd: path, timeoutMs: 60_000 });
    if (report.apply && !(settings.enabled && settings.checkouts.has(comparable(path)))) { entry.reason = 'not-authorized'; continue; }
    if (overlap(path, runtimeRoot) || (dataDir && overlap(path, dataDir))) { entry.reason = 'aiworks-runtime'; continue; }
    const symbolic = run('symbolic-ref', '-q', 'HEAD');
    if (!symbolic.ok) { entry.reason = symbolic.status === 1 ? 'detached' : 'unreadable'; continue; }
    if (!symbolic.stdout.startsWith('refs/heads/')) { entry.reason = 'unreadable'; continue; }
    entry.branch = symbolic.stdout.slice('refs/heads/'.length);
    const upstream = run('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
    if (!upstream.ok) { entry.reason = 'no-upstream'; continue; }
    entry.upstream = upstream.stdout;
    const target = run('rev-parse', '--verify', '--quiet', '@{upstream}^{commit}');
    const head = run('rev-parse', '--verify', '--quiet', 'HEAD^{commit}');
    if (!target.ok || !SHA.test(target.stdout) || !head.ok || !SHA.test(head.stdout)) { entry.reason = 'unreadable'; continue; }
    entry.target = target.stdout;
    entry.head = head.stdout;
    entry.activity = activity(store, path, now);
    if (entry.activity === 'unknown') { entry.reason = 'unknown-activity'; continue; }
    const indexLock = run('rev-parse', '--git-path', 'index.lock');
    if (entry.activity === 'active' || (indexLock.ok && existsSync(resolve(path, indexLock.stdout)))) { entry.reason = 'active'; continue; }
    const changes = gitA.worktreeChanges({ git: command, path });
    if (changes === null) { entry.reason = 'unreadable'; continue; }
    if (changes.some((line) => !line.startsWith('!! '))) { entry.reason = 'changes'; continue; }
    if (gitA.isAncestor({ git: command, path, ancestor: entry.target, descendant: entry.head })) { entry.action = 'already'; continue; }
    if (!gitA.isAncestor({ git: command, path, ancestor: entry.head, descendant: entry.target })) { entry.reason = 'own-commits'; continue; }
    if (!report.apply) { entry.action = 'would-update'; continue; }
    const hooksOff = resolve(dataDir ?? path, 'no-hooks');
    const moved = fastForwardFolder({ git: command, path, branch: entry.branch, target: entry.target, hooksOff });
    if (moved.updated) { entry.action = moved.already ? 'already' : 'updated'; entry.head = moved.to; } else entry.reason = moved.reason;
  }
  return report;
}
