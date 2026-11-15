// Standing project settings (docs/design/OWNER_UI_V2.md section 9, work package WP5): the owner's protected areas, notes
// for the AI, the repair limit and the acceptance mode (AW-015) of one project, kept as append-only versions in
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
// - the merge gate (merge.mjs, result-review.mjs awaitingAcceptance): with acceptance "owner" ("I accept results
//   myself", AW-015) a verified head merges only after the owner accepted exactly that head and report. The newest
//   settings decide at every check, so switching to "owner" holds every unmerged head without acceptance, and switching
//   back lets the gate go on. "automatic", the default and the mode of every project without the field, changes nothing.
// - repair rounds (effectiveLimits, AW-002 amended 2026-11-06): `limits.maxRepairRounds` (0..5, or null for no limit)
//   applies to every campaign of the project whose declaration does not name the limit itself; without it the default
//   is campaign.mjs DEFAULT_MAX_REPAIR_ROUNDS. The newest settings decide at every check. Reaching the limit never waits
//   for the owner: the step is finished (controller.mjs settleStopped, AW-017).
import { createHash } from 'node:crypto';
import { campaignLimits, canonicalJson } from './campaign.mjs';
import { containsKnownSecretValue } from '../shared/credential-metadata.mjs';

export class ProjectSettingsError extends Error {
  constructor(code, message) { super(message); this.name = 'ProjectSettingsError'; this.code = code; }
}
const refuse = (code, message) => { throw new ProjectSettingsError(code, message); };
const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const MAX_PROTECTED = 32;
export const MAX_NOTES = 2000;
export const ACCEPTANCE_MODES = Object.freeze(['automatic', 'owner']);
export const REPAIR_ROUNDS_RANGE = Object.freeze({ min: 0, max: 5 });
// `limits` is empty unless the owner set repair rounds: then { maxRepairRounds: 0..5 or null (no limit) }.
export const EMPTY_SETTINGS = Object.freeze({ protectedAreas: [], notes: '', acceptance: 'automatic', limits: {} });

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

/**
 * The owner's settings, checked and in their stored form. Refusals carry a code:
 *   SETTINGS_FIELD       a field settings do not have: files to change, providers, release or any authority;
 *   SETTINGS_PROTECTED   protected areas that are not 0..32 distinct repository-relative path prefixes;
 *   SETTINGS_NOTES       notes longer than 2,000 characters, or not text;
 *   SETTINGS_SECRET      notes that look like they contain a credential;
 *   SETTINGS_ACCEPTANCE  an acceptance mode other than "automatic" (the default) or "owner";
 *   SETTINGS_LIMITS      limits other than `maxRepairRounds` 0..5 or null (no limit). Omitted means not set: the default.
 * `limits` is kept only when it sets repair rounds, so settings saved without it keep their digest.
 */
export function normalizeSettings(input) {
  if (!plainObject(input)) refuse('SETTINGS_FIELD', 'project settings must be an object');
  const extra = Object.keys(input).filter((key) => !['protectedAreas', 'notes', 'budget', 'acceptance', 'limits'].includes(key));
  if (extra.length) refuse('SETTINGS_FIELD', `project settings cannot set ${extra.join(', ')}: they only add protection, notes, limits and the acceptance mode`);
  const areas = input.protectedAreas ?? [];
  if (!Array.isArray(areas) || areas.length > MAX_PROTECTED || !areas.every(safeArea) || new Set(areas.map(folded)).size !== areas.length) {
    refuse('SETTINGS_PROTECTED', `protected areas must be up to ${MAX_PROTECTED} distinct repository-relative folders or files`);
  }
  const notes = input.notes ?? '';
  if (typeof notes !== 'string' || notes.length > MAX_NOTES) refuse('SETTINGS_NOTES', `notes for the AI must be text of at most ${MAX_NOTES} characters`);
  if (containsKnownSecretValue(notes)) refuse('SETTINGS_SECRET', 'notes for the AI look like they contain a credential');
  const acceptance = input.acceptance ?? 'automatic';
  if (!ACCEPTANCE_MODES.includes(acceptance)) refuse('SETTINGS_ACCEPTANCE', 'the acceptance mode is "automatic" or "owner"');
  const limits = input.limits ?? {};
  const rounds = limits.maxRepairRounds;
  if (!plainObject(limits) || Object.keys(limits).some((key) => key !== 'maxRepairRounds') ||
      !(rounds === undefined || rounds === null || (Number.isSafeInteger(rounds) && rounds >= REPAIR_ROUNDS_RANGE.min && rounds <= REPAIR_ROUNDS_RANGE.max))) {
    refuse('SETTINGS_LIMITS', `repair rounds per step are ${REPAIR_ROUNDS_RANGE.min} to ${REPAIR_ROUNDS_RANGE.max}, no limit (null), or not set`);
  }
  return { protectedAreas: areas.map((entry) => entry.replace(/\\/g, '/').replace(/\/+$/, '')), notes: notes.trim(), acceptance,
    ...(rounds === undefined ? {} : { limits: { maxRepairRounds: rounds } }) };
}

export const settingsDigest = (settings) => `sha256:${createHash('sha256').update(canonicalJson(settings), 'utf8').digest('hex')}`;

const hasTable = (store) => Boolean(store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_settings'"));
// Settings saved before the acceptance mode existed read as "automatic", what they meant then; without limits, as none set.
const decoded = (row) => (row ? { project: row.project, version: row.version, settings: { protectedAreas: row.settings.protectedAreas ?? [], notes: row.settings.notes ?? '', acceptance: row.settings?.acceptance === 'owner' ? 'owner' : 'automatic',
  limits: plainObject(row.settings?.limits) ? row.settings.limits : {} }, digest: row.digest, requestId: row.request_id, createdAt: row.created_at } : null);

/** The newest settings of a project, or none: version 0 with no protection, no notes and automatic acceptance. */
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
    if (kept.project !== key || settingsDigest(normalizeSettings(kept.settings)) !== digest) refuse('SETTINGS_REQUEST_REUSED', 'this request id was already used for other settings');
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
    acceptance: value.acceptance, limits: value.limits ?? {} }, now);
  return { ...decoded(store.get('SELECT * FROM project_settings WHERE project = ? AND version = ?', key, version)), duplicate: false };
}

/**
 * A project's acceptance mode now (AW-015): "owner" when its newest settings say the owner accepts results, otherwise
 * "automatic", also for a project without settings or a store without the table.
 */
export const acceptanceMode = (store, project) => (currentSettings(store, project).settings.acceptance === 'owner' ? 'owner' : 'automatic');

/**
 * A campaign's effective limits now (campaign.mjs campaignLimits): its declaration's, with the repair-round limit taken
 * from the newest settings of its project when the declaration does not name it, else the default of 3. Every caller
 * that holds the store uses this, so the dashboard, status and the controller judge one value.
 */
export const effectiveLimits = (store, declaration) => campaignLimits(declaration, projectLimitsOf(store, declaration));
/** The `limits` of the newest settings of a declaration's project, or null when none are set or the store has no table. */
export function projectLimitsOf(store, declaration) {
  const key = store ? projectKey(projectOf(declaration)) : null;
  if (!key || !hasTable(store)) return null;
  const limits = currentSettings(store, key).settings.limits;
  return limits.maxRepairRounds === undefined ? null : limits;
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
