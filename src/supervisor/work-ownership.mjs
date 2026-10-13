// aiworks#5 scope A: registration-time ownership of commit work, not another scheduler or lease.
// The caller must hold the store's BEGIN IMMEDIATE transaction through registration, so two
// connections cannot both pass the check before either inserts its campaign.
import { createHash } from 'node:crypto';
import { specsOf } from './plan.mjs';

/** Exact intended work, independent of campaign/task IDs, display text and reference order.
 * This is deliberately not fuzzy matching. Differently worded repairs need the same explicit workKey.
 */
export function workFingerprint(task) {
  return createHash('sha256').update(JSON.stringify([
    task.issue, task.goal.trim(), task.acceptance.map((item) => item.trim()).sort(),
  ])).digest('hex');
}

// A stored declaration was validated when it was registered. One that is no longer readable owns
// nothing here rather than making every later registration fail with a raw TypeError.
const readable = (d) => d && typeof d === 'object' && d.target && typeof d.target.repository === 'string' && Array.isArray(d.tasks);
const commitTask = (task) => task && task.deliverable === 'commit' && typeof task.goal === 'string' && Array.isArray(task.acceptance) &&
  task.acceptance.every((item) => typeof item === 'string');

/**
 * Find an existing owner in this store and tenant/repository. Paused and cancelling campaigns
 * keep their assignments; a finished or cancelled campaign releases them once its operations drain.
 * A nonterminal campaign keeps all its commit assignments, including published tasks: another
 * task may still be integrating that work. Reports never reserve write ownership.
 *
 * An owner's admitted child tasks own work exactly like its declared ones (WORK_ENVELOPE 6.7, slice E3).
 *
 * This does not inspect unmerged PRs after a campaign finishes, fence existing writers, or
 * reconcile duplicate campaigns registered before this guard. Those are aiworks#5 scope B.
 */
export function findWorkConflict(store, declaration) {
  const candidates = declaration.tasks.filter((task) => task.deliverable === 'commit')
    .map((task) => ({ task, fingerprint: workFingerprint(task) }));
  if (!candidates.length) return null;
  const repository = declaration.target.repository.toLowerCase();
  const owners = store.all(`SELECT id, control, declaration FROM campaigns
    WHERE id != ? AND (control NOT IN ('finished', 'cancelled')
      OR EXISTS (SELECT 1 FROM operations WHERE campaign_id = campaigns.id
        AND state IN ('recorded', 'dispatched')))
    ORDER BY created_at, id`, declaration.campaignId);
  for (const owner of owners) {
    const previous = owner.declaration;
    if (!readable(previous) || previous.target.tenantId !== declaration.target.tenantId ||
        previous.target.repository.toLowerCase() !== repository) continue;
    for (const owned of specsOf(store, owner.id, previous).values()) {
      if (!commitTask(owned)) continue;
      const fingerprint = workFingerprint(owned);
      for (const { task, fingerprint: candidate } of candidates) {
        const sharedKey = task.workKey && task.workKey === owned.workKey;
        if (!sharedKey && candidate !== fingerprint) continue;
        return {
          taskId: task.id, campaignId: owner.id, ownerTaskId: owned.id, ownerControl: owner.control,
          reason: sharedKey ? 'work-key' : 'same-task', workKey: sharedKey ? task.workKey : null,
        };
      }
    }
  }
  return null;
}

// ---- aiworks#5 scope B / ADAPTIVE_SCHEDULER 4.3: write domains, held from dispatch until integration. ----

const normalise = (path) => path.split('\\').join('/').toLowerCase();
// A declared entry covers a path when it is that path or a directory above it: `docs/A.md` covers neither `docs/A.md.bak`
// nor `docs/A.mdx`, and `src/a` covers `src/a/x.js` but not `src/ab.js`. A trailing slash marks a directory.
const covers = (entry, path) => entry.endsWith('/') ? path.startsWith(entry) : path === entry || path.startsWith(`${entry}/`);

/**
 * The write domain of a task: the part of one repository its implement step may change. A commit task without `writes`
 * owns the whole repository (the safe default). Report tasks and verifiers write nothing and hold nothing: null.
 */
export function domainOf(declaration, task) {
  if (!task || task.deliverable !== 'commit' || !readable(declaration)) return null;
  const key = `${declaration.target.tenantId}\u0000${declaration.target.repository.toLowerCase()}`;
  const workKey = task.workKey ?? null;
  if (!Array.isArray(task.writes)) return { key, whole: true, paths: [], resources: [], workKey };
  return { key, whole: false, workKey,
    paths: task.writes.filter((entry) => !entry.startsWith('resource:')).map(normalise),
    resources: task.writes.filter((entry) => entry.startsWith('resource:')) };
}

/**
 * Two domains overlap within one tenant and repository when either owns the whole repository, they share a workKey, one
 * declared path covers the other (case folded, as Windows file systems fold case), or they name the same resource.
 */
export function domainsOverlap(a, b) {
  if (!a || !b || a.key !== b.key) return false;
  if (a.whole || b.whole || (a.workKey && a.workKey === b.workKey)) return true;
  return a.paths.some((x) => b.paths.some((y) => covers(x, y) || covers(y, x))) ||
    a.resources.some((resource) => b.resources.includes(resource));
}

/** Changed paths outside a declared domain; [] for a whole-repository domain. */
export function pathsOutside(domain, paths) {
  if (!domain || domain.whole) return [];
  return paths.filter((path) => !domain.paths.some((entry) => covers(entry, normalise(path))));
}

const ACTIVE = new Set(['implementing', 'implemented', 'verifying', 'verified']);

/**
 * Who holds a domain that overlaps `domain`, computed from existing rows, never from a lock table (ADAPTIVE_SCHEDULER 4.3):
 * - an open implement operation, in any campaign: it is writing ('writing'). A cancelled or finished campaign's run holds
 *   its domain until it is settled, because suspicion is not proof it stopped;
 * - a task implemented, verifying or verified, not yet integrated ('unintegrated');
 * - a done commit task whose verified head is not in its base yet, in any campaign, finished or cancelled included
 *   ('published-unmerged'). `integrated(campaignId, taskRow, declaration)` answers that from the fetched base.
 * A pending task with nothing open holds nothing. The candidate task itself is skipped. Admitted child tasks hold their
 * `writes` like declared tasks (WORK_ENVELOPE 6.7); a cancelled child holds nothing.
 */
export function domainHolders(store, { campaignId, taskId, domain }, { integrated = () => false } = {}) {
  if (!domain) return [];
  const holders = [];
  for (const c of store.all('SELECT id, control, declaration FROM campaigns ORDER BY created_at, id')) {
    if (!readable(c.declaration)) continue;
    const terminal = ['finished', 'cancelled'].includes(c.control);
    const writing = new Set(store.all("SELECT task_id FROM operations WHERE campaign_id = ? AND kind = 'implement' AND state IN ('recorded', 'dispatched')", c.id)
      .map((row) => row.task_id));
    const rows = new Map(store.all('SELECT * FROM tasks WHERE campaign_id = ?', c.id).map((row) => [row.task_id, row]));
    for (const spec of specsOf(store, c.id, c.declaration).values()) {
      if (c.id === campaignId && spec.id === taskId) continue;
      if (!domainsOverlap(domain, domainOf(c.declaration, spec))) continue;
      const row = rows.get(spec.id);
      if (!row) continue;
      const reason = writing.has(spec.id) ? 'writing'
        : !terminal && ACTIVE.has(row.state) ? 'unintegrated'
          : row.state === 'done' && row.verified_sha && !integrated(c.id, row, c.declaration) ? 'published-unmerged' : null;
      if (reason) holders.push({ campaignId: c.id, taskId: spec.id, reason });
    }
  }
  return holders;
}

/** The packet constraint that tells a worker and its verifier the task's declared write domain before it is enforced. */
export const writeDomainConstraint = (writes) => {
  const paths = writes.filter((entry) => !entry.startsWith('resource:'));
  const resources = writes.filter((entry) => entry.startsWith('resource:'));
  return `Write domain: change only files under ${paths.length ? paths.join(', ') : 'no repository path'}${resources.length ? ` (resources held: ${resources.join(', ')})` : ''}. A commit that changes any other file is rejected as a boundary violation; if the outcome needs another file, report that instead of changing it.`;
};
