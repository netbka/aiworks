// Standing project settings (docs/design/OWNER_UI_V2.md section 9, work package WP5): the owner's protected areas, notes
// for the AI and optional project and monthly budgets of one project, kept as append-only versions in
// `project_settings`. Settings can only add protection and limits on top of what was registered: they have no field for
// files to change, providers, release or authority, so they never widen a declaration or grant a release. Saving them
// never rewrites a campaign's declaration, authorization version or scope digest.
//
// Enforcement:
// - registration (api.mjs campaignStart): a new campaign, or a new authorization version, whose declared writes lie inside
//   a protected area is refused (PROTECTED_AREA), so neither a new nor a stale approval reaches one;
// - the commit check (controller.mjs applyOutcome): a commit that changes a path inside a protected area is a boundary
//   violation, held for the owner. A campaign keeps the areas that were in force when it was registered, so removing an
//   area later never loosens work already running; areas added later apply to it at once;
// - admission (api.mjs admissionBudget): no paid worker run starts while the project's charged spend, all time or in this
//   calendar month (UTC), leaves less than one run at the declared unknown-run price. Reported dollars count as reported;
//   a run with no reported cost and every open run are charged at that price, never at zero. No budget means no cap.
//   Planning counts too (planningRuns): a coordinator run that drafts a work request is charged to the request's project,
//   and a message run to the one project all its messages name. The coordinator checks the same budget in the fenced
//   transaction that records a planning run, so the recorded run is its reservation. A run that names no single project
//   is unallocated: shown on its own and charged to no project's budget.
import { createHash } from 'node:crypto';
import { runNotCounted } from './adapters/executors.mjs';
import { canonicalJson } from './campaign.mjs';
import { containsKnownSecretValue } from '../shared/credential-metadata.mjs';

export class ProjectSettingsError extends Error {
  constructor(code, message) { super(message); this.name = 'ProjectSettingsError'; this.code = code; }
}
const refuse = (code, message) => { throw new ProjectSettingsError(code, message); };
const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const MAX_PROTECTED = 32;
export const MAX_NOTES = 2000;
export const BUDGET_RANGE = Object.freeze({ min: 1, max: 100000 });
export const UNKNOWN_RUN_RANGE = Object.freeze({ min: 0.5, max: 100 });
export const EMPTY_SETTINGS = Object.freeze({ protectedAreas: [], notes: '', budget: { totalUsd: null, monthlyUsd: null, unknownRunCostUsd: null } });

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const LOCAL_PROJECT = /^lp-[a-z0-9][a-z0-9-]{0,38}$/;

/** The project a declaration belongs to: its GitHub repository, or the lp- id of a project without GitHub. */
export function projectOf(declaration) {
  const target = declaration?.target ?? {};
  if (REPOSITORY.test(target.repository ?? '')) return target.repository;
  return LOCAL_PROJECT.test(target.projectId ?? '') ? target.projectId : null;
}
/** The key settings are stored under: the project, case folded (GitHub names and Windows paths fold case). */
export const projectKey = (project) => (typeof project === 'string' && (REPOSITORY.test(project) || LOCAL_PROJECT.test(project)) ? project.toLowerCase() : null);

// A protected area is a repository-relative path prefix compared like a write entry: `\` read as `/`, no trailing `/`,
// case folded. `src/a` protects `src/a/x.js`, never `src/ab.js`.
const folded = (entry) => entry.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const covers = (outer, inner) => inner === outer || inner.startsWith(`${outer}/`);
const safeArea = (entry) => typeof entry === 'string' && entry.length <= 200 && !/^[\\/]|^[A-Za-z]:|[:%*?<>|\u0000-\u001f\u007f]/.test(entry) &&
  folded(entry).length > 0 && !folded(entry).split('/').some((part) => !part || part === '.' || part === '..');
const money = (value, { min, max }) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max);

/**
 * The owner's settings, checked and in their stored form. Refusals carry a code:
 *   SETTINGS_FIELD       a field settings do not have: files to change, providers, release or any authority;
 *   SETTINGS_PROTECTED   protected areas that are not 0..32 distinct repository-relative path prefixes;
 *   SETTINGS_NOTES       notes longer than 2,000 characters, or not text;
 *   SETTINGS_SECRET      notes that look like they contain a credential;
 *   SETTINGS_BUDGET      a budget outside 1..100,000 dollars, or an unknown-run price outside 0.5..100 dollars;
 *   SETTINGS_UNKNOWN_COST a budget without the price a run with no reported cost is charged at (never zero), or a price
 *                        without a budget.
 */
export function normalizeSettings(input) {
  if (!plainObject(input)) refuse('SETTINGS_FIELD', 'project settings must be an object');
  const extra = Object.keys(input).filter((key) => !['protectedAreas', 'notes', 'budget'].includes(key));
  if (extra.length) refuse('SETTINGS_FIELD', `project settings cannot set ${extra.join(', ')}: they only add protection, notes and limits`);
  const areas = input.protectedAreas ?? [];
  if (!Array.isArray(areas) || areas.length > MAX_PROTECTED || !areas.every(safeArea) || new Set(areas.map(folded)).size !== areas.length) {
    refuse('SETTINGS_PROTECTED', `protected areas must be up to ${MAX_PROTECTED} distinct repository-relative folders or files`);
  }
  const notes = input.notes ?? '';
  if (typeof notes !== 'string' || notes.length > MAX_NOTES) refuse('SETTINGS_NOTES', `notes for the AI must be text of at most ${MAX_NOTES} characters`);
  if (containsKnownSecretValue(notes)) refuse('SETTINGS_SECRET', 'notes for the AI look like they contain a credential');
  const budget = input.budget ?? {};
  if (!plainObject(budget) || Object.keys(budget).some((key) => !['totalUsd', 'monthlyUsd', 'unknownRunCostUsd'].includes(key))) {
    refuse('SETTINGS_FIELD', 'a project budget has only totalUsd, monthlyUsd and unknownRunCostUsd');
  }
  const totalUsd = budget.totalUsd ?? null, monthlyUsd = budget.monthlyUsd ?? null, unknownRunCostUsd = budget.unknownRunCostUsd ?? null;
  if (!money(totalUsd, BUDGET_RANGE) || !money(monthlyUsd, BUDGET_RANGE)) refuse('SETTINGS_BUDGET', `a project budget is ${BUDGET_RANGE.min} to ${BUDGET_RANGE.max} dollars, or none`);
  if (!money(unknownRunCostUsd, UNKNOWN_RUN_RANGE)) refuse('SETTINGS_BUDGET', `the price of a run with no reported cost is ${UNKNOWN_RUN_RANGE.min} to ${UNKNOWN_RUN_RANGE.max} dollars`);
  const capped = totalUsd !== null || monthlyUsd !== null;
  if (capped && unknownRunCostUsd === null) refuse('SETTINGS_UNKNOWN_COST', 'a project budget needs the price a run with no reported cost is charged at: unknown cost is never zero');
  if (!capped && unknownRunCostUsd !== null) refuse('SETTINGS_UNKNOWN_COST', 'a price for runs with no reported cost needs a project budget');
  return { protectedAreas: areas.map((entry) => entry.replace(/\\/g, '/').replace(/\/+$/, '')), notes: notes.trim(), budget: { totalUsd, monthlyUsd, unknownRunCostUsd } };
}

export const settingsDigest = (settings) => `sha256:${createHash('sha256').update(canonicalJson(settings), 'utf8').digest('hex')}`;

const hasTable = (store) => Boolean(store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_settings'"));
const decoded = (row) => (row ? { project: row.project, version: row.version, settings: row.settings, digest: row.digest, requestId: row.request_id, createdAt: row.created_at } : null);

/** The newest settings of a project, or none: version 0 with no protection, no notes and no budget. */
export function currentSettings(store, project) {
  const key = projectKey(project);
  const row = key && hasTable(store) ? store.get('SELECT * FROM project_settings WHERE project = ? ORDER BY version DESC LIMIT 1', key) : null;
  return decoded(row) ?? { project: key, version: 0, settings: structuredClone(EMPTY_SETTINGS), digest: null, requestId: null, createdAt: null };
}

/**
 * Save the owner's settings as the next version, bound to the version the owner saw (`expectedVersion`, 0 for none) and
 * to a request id: a repeat of the same request answers with the version it saved; the same id with other settings is
 * refused. The caller holds the store transaction. Refusals: SETTINGS_CHANGED (a newer version was saved meanwhile),
 * SETTINGS_REQUEST_REUSED, and every code of normalizeSettings.
 */
export function saveSettings(store, { project, expectedVersion, requestId, settings }, now) {
  const key = projectKey(project);
  if (!key) refuse('SETTINGS_PROJECT', 'settings belong to a GitHub repository or a project without GitHub');
  if (typeof requestId !== 'string' || !/^[\w-]{8,80}$/.test(requestId)) refuse('SETTINGS_REQUEST', 'a settings change needs a request id');
  const value = normalizeSettings(settings);
  const digest = settingsDigest(value);
  const kept = store.get('SELECT * FROM project_settings WHERE request_id = ?', requestId.toLowerCase());
  if (kept) {
    if (kept.project !== key || kept.digest !== digest) refuse('SETTINGS_REQUEST_REUSED', 'this request id was already used for other settings');
    return { ...decoded(kept), duplicate: true };
  }
  const current = currentSettings(store, key);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== current.version) {
    refuse('SETTINGS_CHANGED', `the settings changed since version ${expectedVersion}: version ${current.version} is the newest`);
  }
  const version = current.version + 1;
  store.run('INSERT INTO project_settings (project, version, settings, digest, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    key, version, JSON.stringify(value), digest, requestId.toLowerCase(), now);
  store.journal(null, 'project-settings-saved', { project: key, version, digest, protectedAreas: value.protectedAreas.length,
    budget: value.budget }, now);
  return { ...decoded(store.get('SELECT * FROM project_settings WHERE project = ? AND version = ?', key, version)), duplicate: false };
}

/**
 * The protected areas that bind a campaign now: those of the newest settings, together with those in force when the
 * campaign was registered. An area removed since keeps binding the work registered under it.
 */
export function protectedAreasFor(store, campaign) {
  const key = projectKey(projectOf(campaign?.declaration));
  if (!key || !hasTable(store)) return [];
  const now = currentSettings(store, key).settings.protectedAreas;
  const then = store.get('SELECT settings FROM project_settings WHERE project = ? AND created_at <= ? ORDER BY version DESC LIMIT 1', key, campaign.created_at ?? 0);
  const seen = new Map();
  for (const entry of [...(then?.settings?.protectedAreas ?? []), ...now]) if (!seen.has(folded(entry))) seen.set(folded(entry), entry);
  return [...seen.values()];
}

/** The changed paths that lie inside a protected area. */
export function protectedPaths(areas, paths) {
  const prefixes = areas.map(folded);
  return paths.filter((path) => prefixes.some((prefix) => covers(prefix, folded(path))));
}

/** Every write a declaration asks for: its envelope's files and each task's own, path entries only. */
const declaredWrites = (declaration) => [...(declaration?.envelope?.writes ?? []), ...(declaration?.tasks ?? []).flatMap((task) => task.writes ?? [])]
  .filter((entry) => typeof entry === 'string' && !entry.startsWith('resource:'));

/**
 * Registration check: a declaration whose writes lie inside a protected area of its project is refused. A wider write
 * entry that contains an area is allowed; the commit check keeps the area itself untouched.
 */
export function protectedWriteConflicts(store, declaration) {
  const key = projectKey(projectOf(declaration));
  if (!key || !hasTable(store)) return [];
  const areas = currentSettings(store, key).settings.protectedAreas.map(folded);
  return declaredWrites(declaration).filter((entry) => areas.some((area) => covers(area, folded(entry))));
}

/** The first moment of the calendar month (UTC) that contains `now`. */
export const monthStart = (now) => { const day = new Date(now); return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1); };
const cents = (value) => Math.round(value * 10000) / 10000;
const tableExists = (store, name) => Boolean(store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name));

/** The one repository an owner message names: its own field, or the project line of a Start work plan-only request. */
export const messageRepository = (m) => m.repository ?? (m.source === 'owner (Start work: Plan only)'
  ? /^Start work: Plan only, sent from the dashboard\.\r?\nProject: ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\r?\n/.exec(m.text)?.[1] ?? null : null);

/**
 * The settings key of a connected project record: its GitHub repository, or the `lp-` id its local plans name
 * (intake.mjs draft target). Null for an unknown record.
 */
export function requestProjectKey(store, projectId) {
  const row = tableExists(store, 'projects') ? store.get('SELECT id, source_kind, github_repository FROM projects WHERE id = ?', projectId) : null;
  if (!row) return null;
  return projectKey(row.source_kind === 'github' ? row.github_repository : `lp-${row.id}`.slice(0, 42));
}

/**
 * Every planning run (coordinator_runs) with the project it is charged to. An intake run belongs to the project of its
 * work request (the request id its outcome records, or the request that points at it while it is open); a message run to
 * the one project every message it read names. Anything else, such as a message naming no project or several, has
 * project null: unallocated, never charged to an arbitrary project. A run that could not start costs nothing.
 */
export function planningRuns(store) {
  if (!tableExists(store, 'coordinator_runs')) return [];
  const requests = tableExists(store, 'work_requests') ? store.all('SELECT request_id, project_id, run_id FROM work_requests') : [];
  const byRequest = new Map(requests.map((row) => [row.request_id, row.project_id]));
  const byRun = new Map(requests.filter((row) => row.run_id).map((row) => [row.run_id, row.project_id]));
  const keys = new Map();
  const keyOf = (projectId) => { if (!keys.has(projectId)) keys.set(projectId, requestProjectKey(store, projectId)); return keys.get(projectId); };
  const messages = tableExists(store, 'owner_messages') ? new Map(store.all('SELECT * FROM owner_messages').map((m) => [m.id, m])) : new Map();
  return store.all('SELECT id, state, message_ids, outcome, cost_usd, created_at FROM coordinator_runs').map((run) => {
    let project = null;
    if (run.id.startsWith('intake.')) {
      const projectId = byRequest.get(run.outcome?.requestId) ?? byRun.get(run.id);
      project = projectId ? keyOf(projectId) : null;
    } else {
      const named = (run.message_ids ?? []).map((id) => messages.get(id)).map((m) => (m ? projectKey(messageRepository(m)) : null));
      project = named.length && named.every((key) => key && key === named[0]) ? named[0] : null;
    }
    return { project, open: ['recorded', 'dispatched'].includes(run.state), counted: run.outcome?.class !== 'spawn-failed', costUsd: run.cost_usd, createdAt: run.created_at };
  });
}

// One period's runs in their own units: reported dollars, finished runs with no reported cost, and open runs.
const tally = (rows) => {
  const counted = rows.filter((row) => !row.open && row.counted);
  return { reportedUsd: cents(counted.reduce((sum, row) => sum + (row.costUsd > 0 ? row.costUsd : 0), 0)),
    unknownCostRuns: counted.filter((row) => !(row.costUsd > 0)).length, openRuns: rows.filter((row) => row.open).length };
};

/**
 * The project's spend against its budget, from durable operation rows of every campaign of the project and its planning
 * runs (planningRuns). Each period (all time, this month) has: reported dollars, runs with no reported cost, open runs,
 * the planning part of those, the charged sum (reported plus every unpriced and open run at the declared price; null
 * without a budget, so unknown is never shown as zero), the cap, what remains and whether it is exhausted: less than one
 * more run at the declared price fits. Without a budget and without `detail`, nothing is counted (admission needs no
 * count): both periods are then null, never zero.
 */
export function projectBudget(store, project, now = Date.now(), { detail = false } = {}) {
  const current = currentSettings(store, project);
  const { totalUsd, monthlyUsd, unknownRunCostUsd } = current.settings.budget;
  const key = current.project;
  if (!detail && totalUsd === null && monthlyUsd === null) return { project: key, version: current.version, unknownRunCostUsd, monthStart: monthStart(now), total: null, month: null, exhausted: null };
  const campaigns = key ? store.all('SELECT id, declaration FROM campaigns').filter((c) => projectKey(projectOf(c.declaration)) === key).map((c) => c.id) : [];
  const ops = campaigns.flatMap((id) => store.all("SELECT state, outcome, created_at FROM operations WHERE campaign_id = ? AND state IN ('finished', 'recorded', 'dispatched')", id))
    .map((op) => ({ open: op.state !== 'finished', counted: !runNotCounted(op.outcome), costUsd: op.outcome?.receipt?.costUsd, createdAt: op.created_at, planning: false }));
  const planning = key ? planningRuns(store).filter((run) => run.project === key).map((run) => ({ ...run, planning: true })) : [];
  const since = monthStart(now);
  const period = (rows, cap) => {
    const { reportedUsd: reported, unknownCostRuns, openRuns } = tally(rows);
    const charged = unknownRunCostUsd === null ? null : cents(reported + (unknownCostRuns + openRuns) * unknownRunCostUsd);
    const remaining = cap === null || charged === null ? null : cents(cap - charged);
    return { capUsd: cap, reportedUsd: reported, unknownCostRuns, openRuns, planning: tally(rows.filter((row) => row.planning)), chargedUsd: charged,
      remainingUsd: remaining, exhausted: remaining !== null && remaining < unknownRunCostUsd };
  };
  const rows = [...ops, ...planning];
  const total = period(rows, totalUsd), month = period(rows.filter((row) => row.createdAt >= since), monthlyUsd);
  const exhausted = total.exhausted ? `project budget reached ($${total.chargedUsd.toFixed(2)} charged of $${totalUsd.toFixed(2)}; ${total.unknownCostRuns} run(s) with unreported cost and ${total.openRuns} open run(s) priced at $${unknownRunCostUsd.toFixed(2)})`
    : month.exhausted ? `monthly project budget reached ($${month.chargedUsd.toFixed(2)} charged of $${monthlyUsd.toFixed(2)} this month; ${month.unknownCostRuns} run(s) with unreported cost and ${month.openRuns} open run(s) priced at $${unknownRunCostUsd.toFixed(2)})`
      : null;
  return { project: key, version: current.version, unknownRunCostUsd, monthStart: since, total, month, exhausted };
}

/** Planning that names no single project, all time and this month: charged to no project's budget, shown on its own. */
export function unallocatedPlanning(store, now = Date.now()) {
  const rows = planningRuns(store).filter((run) => run.project === null);
  const since = monthStart(now);
  return { monthStart: since, total: tally(rows), month: tally(rows.filter((row) => row.createdAt >= since)) };
}
