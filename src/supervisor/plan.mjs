// AIWorks task specs from one accessor (docs/design/WORK_ENVELOPE.md section 6.4, slice E1). A task's spec is the one
// in the stored declaration, or else the live revision of an admitted child task in `task_specs`. Nothing writes
// `task_specs` yet: child admission is slice E3, so today every spec is the declared one and nothing changes.
// The declared spec always wins, without a query, so the controller's hot paths read exactly what they read before.

const hasTable = (store, name) => Boolean(store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name));

/**
 * Live child specs of a campaign, keyed by task id: the newest revision of each child that is not cancelled. A store
 * opened read-only that predates the tables has none (status never migrates a store).
 */
function childSpecs(store, campaignId, taskId = null) {
  if (!hasTable(store, 'task_specs')) return [];
  const rows = store.all(`SELECT task_id, spec FROM task_specs s WHERE campaign_id = ?${taskId === null ? '' : ' AND task_id = ?'}
    AND cancelled_at IS NULL AND revision = (SELECT MAX(revision) FROM task_specs r WHERE r.campaign_id = s.campaign_id AND r.task_id = s.task_id)
    ORDER BY task_id`, campaignId, ...(taskId === null ? [] : [taskId]));
  return rows.map((row) => [row.task_id, row.spec]);
}

/** The spec of one task: declared, or the live child revision; undefined when there is neither. */
export function specOf(store, campaignId, taskId, declaration = store.campaign(campaignId)?.declaration) {
  const declared = declaration?.tasks?.find((task) => task.id === taskId);
  if (declared) return declared;
  return childSpecs(store, campaignId, taskId)[0]?.[1];
}

/** Every spec of a campaign as a Map by task id: declared tasks in declaration order, then live children. */
export function specsOf(store, campaignId, declaration = store.campaign(campaignId)?.declaration) {
  const specs = new Map((declaration?.tasks ?? []).map((task) => [task.id, task]));
  for (const [id, spec] of childSpecs(store, campaignId)) if (!specs.has(id)) specs.set(id, spec);
  return specs;
}
