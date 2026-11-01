// Read-only maintenance inventory. A report is never permission to merge or remove a checkout.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import * as gitA from './adapters/git.mjs';
import { LANE as COORDINATOR_LANE } from './coordinator.mjs';

const key = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const inside = (root, path) => {
  const part = relative(root, path);
  return part === '' || (!part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && part !== '..' && !isAbsolute(part));
};
const canonical = (path) => realpathSync.native(resolve(path));
const open = (state) => ['recorded', 'dispatched'].includes(state);

/** Explicit repositories plus immediate repositories under root; never recursively scans installation data. */
export function maintenanceAudit({ repositories = [], root, allowedRoots = [], store, git = ['git'], now = Date.now() } = {}) {
  const report = { schema: 'aiworks-maintenance/1', observedAt: new Date(now).toISOString(), readOnly: true,
    remoteState: 'locally-observed-only', repositories: [], errors: [] };
  const roots = [], candidates = [...repositories], seen = new Set();
  for (const path of [...allowedRoots, ...repositories, ...(root ? [root] : [])]) {
    try { roots.push(canonical(path)); } catch { report.errors.push({ path: resolve(path), reason: 'root-unreadable' }); }
  }
  if (root) {
    try {
      const directory = canonical(root);
      if (existsSync(join(directory, '.git'))) candidates.push(directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(directory, entry.name, '.git'))) candidates.push(join(directory, entry.name));
      }
    } catch { report.errors.push({ path: resolve(root), reason: 'discovery-unreadable' }); }
  }
  // --no-optional-locks prevents status from refreshing the index. No command below fetches or writes refs.
  const command = [...git, '--no-optional-locks', '-c', 'core.fsmonitor=false'];
  const run = (path, args) => gitA.exec(command, args, { cwd: path, timeoutMs: 30_000 });
  let ownership = null;
  if (store) {
    try {
      ownership = {
        operations: store.all('SELECT campaign_id, task_id, workspace, state FROM operations'),
        tasks: store.all('SELECT campaign_id, task_id, state, verified_sha FROM tasks'),
        campaigns: store.all('SELECT id, control FROM campaigns'),
        leases: store.all('SELECT campaign_id, expires_at FROM leases'),
        coordinators: store.all('SELECT workspace, state FROM coordinator_runs'),
      };
    } catch { report.errors.push({ reason: 'ownership-unreadable' }); }
  }
  for (const candidate of candidates) {
    let path;
    try { path = canonical(candidate); } catch { report.errors.push({ path: resolve(candidate), reason: 'repository-unreadable' }); continue; }
    if (!roots.some((allowed) => inside(allowed, path))) { report.errors.push({ path, reason: 'outside-root' }); continue; }
    const common = run(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    let commonPath;
    try { if (!common.ok) throw new Error(); commonPath = canonical(common.stdout); }
    catch { report.errors.push({ path, reason: 'common-directory-unreadable' }); continue; }
    if (!roots.some((allowed) => inside(allowed, commonPath))) { report.errors.push({ path, reason: 'common-directory-outside-root' }); continue; }
    if (seen.has(key(commonPath))) continue;
    seen.add(key(commonPath));
    const list = gitA.worktreeList({ git: command, repoPath: path });
    if (!list) { report.errors.push({ path, reason: 'worktree-list-unreadable' }); continue; }
    const mainResult = run(path, ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}']);
    const main = mainResult.ok ? mainResult.stdout : null;
    const repository = { path, commonDirectory: commonPath, main, worktrees: [] };
    report.repositories.push(repository);
    for (const [index, wt] of list.entries()) {
      const item = { ...wt, primary: index === 0, classification: 'unknown', reasons: [], suggestion: 'retain',
        activity: 'unknown', processActivity: 'unknown', owners: [], status: null, upstream: null, ahead: null, behind: null,
        mergedIntoLocalMain: null, verified: false };
      repository.worktrees.push(item);
      let worktreePath;
      try { worktreePath = canonical(wt.path); }
      catch { item.reasons.push('missing-or-unreadable-worktree'); continue; }
      if (!roots.some((allowed) => inside(allowed, worktreePath))) { item.reasons.push('outside-root'); continue; }
      // A replaced worktree directory must still identify the listed repository and head.
      const identity = run(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const head = run(worktreePath, ['rev-parse', '--verify', 'HEAD']);
      try {
        if (!identity.ok || key(canonical(identity.stdout)) !== key(commonPath) || !head.ok || head.stdout !== wt.head) throw new Error();
      } catch { item.reasons.push('worktree-identity-changed'); continue; }
      const changes = gitA.worktreeChanges({ git: command, path: worktreePath });
      if (changes === null) item.reasons.push('status-unreadable');
      else item.status = { dirty: changes.some((entry) => !entry.startsWith('!! ')),
        untracked: changes.some((entry) => entry.startsWith('?? ')), ignored: changes.some((entry) => entry.startsWith('!! ')) };
      if (main) {
        const merged = run(path, ['merge-base', '--is-ancestor', wt.head, main]);
        if (merged.status === 0 || merged.status === 1) item.mergedIntoLocalMain = merged.status === 0;
        const base = run(path, ['merge-base', wt.head, main]);
        item.mergeBase = base.ok ? base.stdout : null;
      }
      if (wt.branch) {
        const upstream = run(worktreePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
        if (upstream.ok) {
          item.upstream = upstream.stdout;
          const distance = run(worktreePath, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
          if (distance.ok && /^\d+\s+\d+$/.test(distance.stdout)) [item.ahead, item.behind] = distance.stdout.split(/\s+/).map(Number);
        }
      }
      if (ownership) {
        const ops = ownership.operations.filter((op) => key(op.workspace) === key(wt.path));
        const coordinators = ownership.coordinators.filter((op) => key(op.workspace) === key(wt.path));
        item.owners = [...new Set(ops.map((op) => `${op.campaign_id}/${op.task_id}`))];
        const tasks = ownership.tasks.filter((task) => ops.some((op) => task.campaign_id === op.campaign_id && task.task_id === op.task_id));
        const liveLease = ownership.leases.some((lease) => lease.expires_at > now &&
          (ops.some((op) => op.campaign_id === lease.campaign_id) || (coordinators.length && lease.campaign_id === COORDINATOR_LANE)));
        item.activity = ops.some((op) => open(op.state)) || coordinators.some((op) => open(op.state)) || liveLease ? 'active' :
          ops.length || coordinators.length ? 'no-open-recorded-operation' : 'unknown';
        item.verified = tasks.some((task) => task.verified_sha === wt.head && ['verified', 'done'].includes(task.state));
        item.completed = tasks.length > 0 && tasks.every((task) => task.state === 'done');
        item.controls = [...new Set(ownership.campaigns.filter((campaign) => ops.some((op) => op.campaign_id === campaign.id)).map((campaign) => campaign.control))];
      }
      if (item.primary) item.reasons.push('primary');
      if (wt.locked) item.reasons.push('locked');
      if (!wt.branch) item.reasons.push('detached');
      if (item.status?.dirty) item.reasons.push('changes');
      if (item.status?.ignored) item.reasons.push('ignored-files');
      if (item.activity === 'active') item.reasons.push('active-operation-or-lease');
      if (item.activity === 'unknown') item.reasons.push('ownership-unknown');
      if (!item.verified) item.reasons.push('head-not-verified');
      if (!item.completed) item.reasons.push('completion-not-proven');
      if (item.mergedIntoLocalMain !== true) item.reasons.push('head-not-in-local-main');
      item.reasons.push('external-process-activity-unknown');
      item.classification = item.primary ? 'primary' : wt.locked ? 'locked' : item.activity === 'active' ? 'active' :
        item.status === null ? 'unknown' : item.status.dirty ? 'dirty' : item.mergedIntoLocalMain === false ? 'unmerged' :
          item.completed && item.verified ? 'completed-retained' : 'unfinished-or-unknown';
    }
  }
  return report;
}
