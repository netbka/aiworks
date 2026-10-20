// Project settings in the dashboard (docs/design/OWNER_UI_V2.md section 9, work package WP5): a project's standing
// protected areas, notes for the AI and optional project and monthly budgets, with what the budget has left. The rules
// live in src/supervisor/project-settings.mjs; this module only reads them for the page and saves the owner's change.
//
// Saving is an owner route (server.mjs: same origin, CSRF token, 16 KiB, JSON) that runs the caller check first, so a
// worker or any other program AIWorks started cannot write. It binds the version the page showed and a request id: a
// stale version saves nothing, and a retry answers with the version it saved. Settings only add protection and limits;
// they never change a registered campaign. A project without GitHub has settings once its rules are confirmed.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../supervisor/store.mjs';
import { BUDGET_RANGE, currentSettings, MAX_NOTES, MAX_PROTECTED, projectBudget, projectKey, projectOf, ProjectSettingsError, saveSettings,
  unallocatedPlanning, UNKNOWN_RUN_RANGE } from '../supervisor/project-settings.mjs';
import { configuredRepositories } from './projects.mjs';
import { ownerOnly } from './work-list.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const LOCAL_ID = /^[\w-]{1,64}$/;
const fail = (status, message, code = null) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const storePath = (dataDir) => join(dataDir, 'supervisor.db');
const UNREADABLE = 'AIWorks can’t read its work records on this computer right now.';
const NOT_FOUND = 'This project is not on this computer. Refresh the page.';
const NO_RULES = 'Confirm this project’s rules first: settings apply to a project AIWorks may work on.';

/**
 * The settings key of a dashboard project: a GitHub repository AIWorks knows (configured, or the target of recorded
 * work), or a connected project without GitHub by the id of its confirmed rules. Throws 404 or 409 otherwise.
 */
function resolveProject(store, dataDir, project) {
  if (typeof project === 'string' && REPOSITORY.test(project)) {
    const known = configuredRepositories(dataDir).some((name) => name.toLowerCase() === project.toLowerCase()) ||
      store.all('SELECT declaration FROM campaigns').some((row) => projectOf(row.declaration)?.toLowerCase() === project.toLowerCase());
    if (!known) throw fail(404, NOT_FOUND, 'PROJECT_NOT_FOUND');
    return { id: project, key: projectKey(project), local: false };
  }
  if (typeof project !== 'string' || !LOCAL_ID.test(project)) throw fail(404, NOT_FOUND, 'PROJECT_NOT_FOUND');
  let record = null, rules = null;
  try {
    record = store.get('SELECT id, disconnected_at FROM projects WHERE id = ?', project);
    rules = store.get('SELECT id, revoked_at FROM project_overlays WHERE project_id = ?', project);
  } catch { /* a store that never connected a project has neither table */ }
  if (!record || record.disconnected_at != null) throw fail(404, NOT_FOUND, 'PROJECT_NOT_FOUND');
  if (!rules || rules.revoked_at != null || !projectKey(rules.id)) throw fail(409, NO_RULES, 'SETTINGS_NO_RULES');
  return { id: project, key: projectKey(rules.id), local: true };
}

// Reported dollars, runs with no reported cost and open runs, each in its own unit.
const units = (value) => (value ? { reportedUsd: value.reportedUsd, unknownCostRuns: value.unknownCostRuns, openRuns: value.openRuns } : null);
const period = (value) => (value ? { capUsd: value.capUsd, reportedUsd: value.reportedUsd, unknownCostRuns: value.unknownCostRuns, openRuns: value.openRuns,
  chargedUsd: value.chargedUsd, remainingUsd: value.remainingUsd, exhausted: value.exhausted, planning: units(value.planning) } : null);

/** What the page shows: the saved version and its settings, and the spend against the budget. Allowlisted fields only. */
function settingsView(store, resolved, now) {
  const current = currentSettings(store, resolved.key);
  const spend = projectBudget(store, resolved.key, now, { detail: true });
  return { available: true, project: resolved.id, version: current.version, savedAt: current.createdAt, settings: current.settings,
    spend: { monthStart: spend.monthStart, unknownRunCostUsd: spend.unknownRunCostUsd, total: period(spend.total), month: period(spend.month),
      exhausted: spend.exhausted ? (spend.month?.exhausted && !spend.total?.exhausted ? 'month' : 'total') : null,
      // Planning that names no single project: charged to no project's budget, so shown apart and never in this one's sum.
      unallocated: units(unallocatedPlanning(store, now).total) },
    limits: { protected: MAX_PROTECTED, notes: MAX_NOTES, budget: BUDGET_RANGE, unknownRun: UNKNOWN_RUN_RANGE } };
}

/** GET /api/v2/projects/:id/settings. Read-only; a missing store is unavailable, never empty settings. */
export function projectSettingsView(dataDir, project, now = Date.now()) {
  if (!existsSync(storePath(dataDir))) throw fail(503, UNREADABLE);
  const store = new Store(storePath(dataDir), { readOnly: true });
  try { return settingsView(store, resolveProject(store, dataDir, project), now); } finally { store.close(); }
}

const REFUSAL_STATUS = { SETTINGS_CHANGED: 409, SETTINGS_REQUEST_REUSED: 409 };
const REFUSAL_WORDS = {
  SETTINGS_CHANGED: 'These settings changed since this page read them. Your entries are kept: review the newest version and save again. Nothing was saved.',
  SETTINGS_REQUEST_REUSED: 'This request was already used for other settings. Refresh the page; nothing was saved.',
  SETTINGS_SECRET: 'The notes look like they contain a password or key, so nothing was saved. Remove it and try again.',
};

/**
 * POST /api/v2/projects/settings: the owner saves a project's settings as the next version. input: { requestId, project,
 * version, protectedAreas, notes, budget: { totalUsd, monthlyUsd, unknownRunCostUsd } }. The caller check runs first.
 */
export async function saveProjectSettings(dataDir, input, { caller, now = Date.now() } = {}) {
  const keys = ['requestId', 'project', 'version', 'protectedAreas', 'notes', 'budget'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key)) ||
      !UUID.test(input.requestId ?? '') || typeof input.project !== 'string' || !Number.isSafeInteger(input.version) || input.version < 0) {
    throw fail(400, 'Invalid request.');
  }
  if (!existsSync(storePath(dataDir))) throw fail(503, UNREADABLE);
  const store = new Store(storePath(dataDir));
  try {
    await ownerOnly(store, caller);
    return store.tx(() => {
      const resolved = resolveProject(store, dataDir, input.project);
      const saved = saveSettings(store, { project: resolved.key, expectedVersion: input.version, requestId: input.requestId,
        settings: { protectedAreas: input.protectedAreas, notes: input.notes, budget: input.budget } }, now);
      return { ok: true, duplicate: saved.duplicate, version: saved.version,
        message: saved.duplicate ? `Version ${saved.version} was already saved; nothing was saved twice.` : `Saved as version ${saved.version}. It applies to the next step AIWorks starts in this project.`,
        view: settingsView(store, resolved, now) };
    });
  } catch (error) {
    if (error instanceof ProjectSettingsError) throw fail(REFUSAL_STATUS[error.code] ?? 400, REFUSAL_WORDS[error.code] ?? `Not saved: ${error.message}.`, error.code);
    throw error;
  } finally { store.close(); }
}
