// aiworks#5 scope A: registration-time ownership of commit work, not another scheduler or lease.
// The caller must hold the store's BEGIN IMMEDIATE transaction through registration, so two
// connections cannot both pass the check before either inserts its campaign.
import { createHash } from 'node:crypto';

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
    for (const owned of previous.tasks) {
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
