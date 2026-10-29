// Owner UI v2 view layer (docs/design/OWNER_UI_V2.md section 8, work package WP1): Home, a project's Overview, Settings ->
// Connections and the typed event feed, built server-side from the readers /api/state already uses. Each view returns
// allowlisted fields only: codes, counts, times, identifiers and sentences the supervisor or the dashboard wrote. No worker
// text, no reason a native process printed, no local path. Unknown stays unknown: a value nothing recorded is null or
// 'unknown', never 0, "No" or green. Every Git read here is local and read-only; nothing fetches.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../supervisor/store.mjs';
import { selfHostingSettings, trustedTip } from '../supervisor/self-hosting.mjs';
import { backupStatus } from '../supervisor/github-backup.mjs';
import { projectOf } from '../supervisor/project-settings.mjs';

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const id = (value) => identifier.test(value ?? '') ? value : null;
const SHA = /^[0-9a-f]{40}$/;
// The project a declaration belongs to: its GitHub repository, or the lp- id of a project without GitHub.
export { projectOf };
export const sameProject = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// ---------------------------------------------------------------------------------------------------------------------
// Typed events (OWNER_UI_V2 section 8, GET /api/v2/events): one type per journal entry the owner can act on or should
// know about. Only the type, time, work, step and project leave; never the entry's detail.

const JOURNAL_KINDS = ['registered', 'paused', 'resumed', 'cancel-requested', 'published', 'result-accepted', 'merged', 'operation-finished', 'blocker-raised',
  'blocker-opened', 'blocker-cleared', 'blocker-resolved', 'executor-unavailable', 'provider-wait-cleared', 'step-error', 'liveness-defect'];
export const EVENT_TYPES = Object.freeze(['goal-started', 'paused', 'resumed', 'cancelled', 'result-ready', 'accepted', 'merged', 'built', 'checked',
  'check-rejected', 'run-failed', 'limit-wait', 'wait-ended', 'needs-you', 'decision-cleared', 'aiworks-problem']);

function eventType(kind, detail) {
  switch (kind) {
    case 'registered': return 'goal-started';
    case 'paused': case 'resumed': case 'merged': return kind;
    case 'cancel-requested': return 'cancelled';
    case 'published': return 'result-ready';
    // The owner's recorded acceptance of exactly a checked version (supervisor.mjs applyResultReview); never a merge.
    case 'result-accepted': return 'accepted';
    case 'blocker-raised': case 'blocker-opened': return 'needs-you';
    case 'blocker-cleared': case 'blocker-resolved': return 'decision-cleared';
    case 'executor-unavailable': return 'limit-wait';
    case 'provider-wait-cleared': return 'wait-ended';
    case 'step-error': case 'liveness-defect': return 'aiworks-problem';
    case 'operation-finished':
      // Usage limits and unavailable workers are waits, not failures; the checker's rejection is its own type.
      if (['quota', 'unavailable'].includes(detail?.class)) return 'limit-wait';
      if (detail?.class !== 'result') return 'run-failed';
      return detail.terminal === 'accepted' ? 'checked' : detail.terminal === 'rejected' ? 'check-rejected' : 'built';
    default: return null;
  }
}

/** campaign id -> project, for every registered campaign (projects without GitHub included). */
export function campaignProjects(store) {
  return new Map(store.all('SELECT id FROM campaigns').map(({ id: campaignId }) => [campaignId, projectOf(store.campaign(campaignId).declaration)]));
}

/**
 * Typed events, newest first. `after`: only entries after this journal sequence (the last-seen marker); `since`: only
 * entries recorded at or after this time (ms); `cursor`: only entries before it (the next page); `project` and `type`
 * filter. Returns { events, next } where `next` is the cursor of the following page, or null when there is none.
 */
export function typedEvents(store, { after = 0, since = 0, cursor = null, project = null, type = null, limit = 50 } = {}) {
  const projects = campaignProjects(store);
  const kinds = type ? JOURNAL_KINDS.filter((kind) => eventType(kind, null) === type || kind === 'operation-finished') : JOURNAL_KINDS;
  if (type && !EVENT_TYPES.includes(type)) return { events: [], next: null };
  const campaigns = project ? [...projects].filter(([, value]) => sameProject(value, project)).map(([key]) => key) : null;
  if (campaigns && !campaigns.length) return { events: [], next: null };
  const events = [];
  let before = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : Number.MAX_SAFE_INTEGER, more = true;
  // Read in pages until enough entries of the asked type are found; each page is bounded.
  while (events.length <= limit && more) {
    const rows = store.all(`SELECT seq, campaign_id, at, kind, detail FROM journal WHERE seq > ? AND seq < ? AND at >= ? AND kind IN (${kinds.map(() => '?').join(', ')})
      ${campaigns ? `AND campaign_id IN (${campaigns.map(() => '?').join(', ')})` : ''} ORDER BY seq DESC LIMIT 500`, after, before, since, ...kinds, ...(campaigns ?? []));
    more = rows.length === 500;
    for (const row of rows) {
      before = row.seq;
      const kind = eventType(row.kind, row.detail);
      if (!kind || type && kind !== type) continue;
      events.push({ id: row.seq, type: kind, at: row.at, campaignId: id(row.campaign_id), taskId: id(row.detail?.task),
        project: projects.get(row.campaign_id) ?? null });
      if (events.length > limit) break;
    }
  }
  const page = events.slice(0, limit);
  return { events: page, next: events.length > limit ? page.at(-1).id : null };
}

// ---------------------------------------------------------------------------------------------------------------------
// The last-seen marker (OWNER_UI_V2 section 8: "server-side last-seen marker"): the newest journal sequence the owner
// marked as seen, beside config.json in the data directory, never in the work records. It only moves forward.

const LAST_SEEN_FILE = 'dashboard-last-seen.json';

/** { seq, at }: the marker, or { seq: 0, at: null } when none was recorded or the file is unreadable. */
export function readLastSeen(dataDir) {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, LAST_SEEN_FILE), 'utf8'));
    if (Number.isSafeInteger(value?.seq) && value.seq >= 0 && Number.isSafeInteger(value.at)) return { seq: value.seq, at: value.at };
  } catch { /* none yet */ }
  return { seq: 0, at: null };
}

/**
 * Mark everything up to journal sequence `seq` as seen. `newest` is the newest journal sequence the store holds: a
 * marker past it is refused, so a later entry is never hidden. An older marker than the recorded one changes nothing.
 */
export function markSeen(dataDir, input, newest, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['seq', 'requestId'].includes(key)) ||
      !Number.isSafeInteger(input.seq) || input.seq < 0 || input.seq > newest) {
    throw Object.assign(new Error('Invalid last-seen marker. Refresh the page and try again.'), { status: 400 });
  }
  const recorded = readLastSeen(dataDir);
  if (input.seq <= recorded.seq) return { accepted: true, duplicate: true, lastSeen: recorded };
  const lastSeen = { seq: input.seq, at: now }, file = join(dataDir, LAST_SEEN_FILE), temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(lastSeen)}\n`);
  renameSync(temporary, file);
  return { accepted: true, duplicate: false, lastSeen };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reports the owner marked as read, by `<campaignId>/<taskId>`, beside the last-seen marker. A read report leaves
// "Reports to read" for the History of its project's Review; nothing else changes.

const READ_REPORTS_FILE = 'dashboard-read-reports.json';

/** The set of read report keys, empty when none was recorded or the file is unreadable. */
export function readReports(dataDir) {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, READ_REPORTS_FILE), 'utf8'));
    if (Array.isArray(value?.read)) return new Set(value.read.filter((key) => typeof key === 'string'));
  } catch { /* none yet */ }
  return new Set();
}

/** Mark one report as read; marking it again changes nothing. */
export function markReportRead(dataDir, input) {
  const valid = (text) => typeof text === 'string' && text.length > 0 && text.length <= 200 && !text.includes('/');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['campaignId', 'taskId', 'requestId'].includes(key)) ||
      !valid(input.campaignId) || !valid(input.taskId)) {
    throw Object.assign(new Error('Invalid report. Refresh the page and try again.'), { status: 400 });
  }
  const read = readReports(dataDir), key = `${input.campaignId}/${input.taskId}`;
  if (read.has(key)) return { accepted: true, duplicate: true };
  const file = join(dataDir, READ_REPORTS_FILE), temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ read: [...read, key] })}\n`);
  renameSync(temporary, file);
  return { accepted: true, duplicate: false };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pause for all, a project or a goal: stopping while a run it started is still open, stopped when none is.

/** A paused goal's pause: who it covers (`scope`), since when, and whether runs it started are still finishing. */
export function pauseState(goal) {
  if (goal?.control !== 'paused') return null;
  return { scope: goal.pauseScope ?? { kind: 'goal' }, at: goal.pausedAt ?? null, openRuns: goal.openRuns ?? null,
    state: goal.openRuns === null || goal.openRuns === undefined ? 'unknown' : goal.openRuns > 0 ? 'stopping' : 'stopped' };
}

/**
 * The pause summary of a set of goals (all, one project's): how many run, stop or stopped, and which a pause or a resume
 * of `scope` would bind. Resume binds only the goals that very scope paused, never a goal paused for another reason.
 */
export function pauseSummary(goals, scope) {
  const open = goals.filter((goal) => ['registered', 'paused'].includes(goal.control));
  const paused = open.filter((goal) => goal.control === 'paused');
  const matches = (goal) => scope.kind === 'goal' || goal.pauseScope?.kind === scope.kind && (scope.kind !== 'project' || sameProject(goal.pauseScope.project, scope.project));
  const bind = ({ id: campaignId, version, authorizationVersion, scopeDigest }) => ({ campaignId, version, authorizationVersion, scopeDigest });
  return { running: open.length - paused.length, stopping: paused.filter((goal) => pauseState(goal).state === 'stopping').length,
    stopped: paused.filter((goal) => pauseState(goal).state === 'stopped').length,
    pause: open.filter((goal) => goal.control === 'registered').map(bind), resume: paused.filter(matches).map(bind),
    otherPaused: paused.filter((goal) => !matches(goal)).length };
}

// ---------------------------------------------------------------------------------------------------------------------
// Views.

const projectRow = (row) => ({ id: row.id, name: row.name, kind: row.kind, repository: row.repository ?? null,
  state: { key: row.state?.key ?? 'unknown', text: row.state?.text ?? null }, needsYou: row.details?.needsYou ?? 0, lastActivityAt: row.lastActivityAt ?? null });

/**
 * Home (GET /api/v2/home): what changed since the last-seen marker, the decisions first, each project in one sentence,
 * and the pause of all work. `events` is typedEvents after the marker and no older than `window` (ms), so history the
 * owner never marked as seen does not stay "new" forever.
 */
export function homeView({ supervisor, owner, projects, events, lastSeen, newest, window = null }) {
  if (!supervisor?.available) return { available: false, lastSeen, needsYou: null, projects: [], since: null, pause: null };
  const counts = {};
  for (const event of events.events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return { available: true, lastSeen, newest,
    since: { count: events.events.length, more: events.next !== null, counts, events: events.events.slice(0, 20), window },
    needsYou: { count: owner?.count ?? 0, items: (owner?.items ?? []).slice(0, 3).map((item) => ({ kind: item.kind, campaignId: id(item.campaignId),
      repository: item.repository ?? null, text: item.text ?? null, at: item.at ?? null })) },
    projects: (projects?.projects ?? []).map(projectRow),
    pause: pauseSummary(supervisor.goals ?? [], { kind: 'all' }) };
}

/** Built, Checked and Available to users of one goal's steps: three separate counts, the third unknown unless a release says so. */
export function goalStrip(campaign, releases = []) {
  const tasks = campaign.tasks ?? [];
  const recorded = releases.filter((release) => release.campaignId === campaign.id);
  const live = recorded.filter((release) => release.state === 'accepted').length;
  const unknown = recorded.filter((release) => !['accepted', 'refused', 'rolled-back'].includes(release.state)).length;
  return { steps: tasks.length,
    built: tasks.filter((task) => SHA.test(task.headSha ?? '') || ['verifying', 'verified', 'done'].includes(task.state)).length,
    // Counted only when the check passed every criterion of the verified head (supervisor.mjs checkPassed).
    checked: tasks.filter((task) => SHA.test(task.verifiedSha ?? '') && task.checkPassed === true).length,
    // Release is switched off today, so nothing is recorded: "not published", never "Live" or "No" for the users' side.
    available: recorded.length ? { state: unknown ? 'unknown' : 'recorded', live, unknown } : { state: 'not-published', reason: 'release-off', live: null, unknown: 0 } };
}

/** Overview (GET /api/v2/projects/:id): the project's sentence, each goal with its strip, budget, next action and pause. */
export function overviewView(project, { supervisor, projects }) {
  if (!supervisor?.available) return { available: false, project: null, goals: [], pause: null };
  const row = (projects?.projects ?? []).find((item) => sameProject(item.id, project));
  const goals = (supervisor.goals ?? []).filter((goal) => sameProject(goal.project, project));
  if (!row && !goals.length) return null;
  const campaigns = new Map((supervisor.campaigns ?? []).map((c) => [c.id, c]));
  return { available: true, project: row ? projectRow(row) : { id: project, name: project, kind: null, repository: null, state: { key: 'unknown', text: null }, needsYou: 0, lastActivityAt: null },
    goals: goals.map((goal) => {
      const c = campaigns.get(goal.id);
      return { id: goal.id, purpose: c?.purpose ?? null, control: goal.control, pause: pauseState(goal),
        binding: { campaignId: goal.id, version: goal.version, authorizationVersion: goal.authorizationVersion, scopeDigest: goal.scopeDigest },
        strip: c ? goalStrip(c, supervisor.releases ?? []) : null,
        budget: c ? { runsUsed: c.runsUsed ?? null, maxWorkerRuns: c.maxWorkerRuns ?? null, reportedUsd: c.cost?.reportedUsd ?? null, unreportedRuns: c.cost?.unreportedRuns ?? null } : null,
        next: c?.nextAction ?? null };
    }),
    pause: pauseSummary(goals, { kind: 'project', project: row?.id ?? project }) };
}

const short = (sha) => SHA.test(sha ?? '') ? sha.slice(0, 12) : null;

// ---------------------------------------------------------------------------------------------------------------------
// Releases (OWNER_UI_V2 WP9, GET /api/v2/projects/:id/releases): what reaches users and what can be undone, from the
// release rows (supervisor.mjs recordedReleases), Settings' release mode and the Results ladder. Checked, merged, live
// and accepted are answered apart and never merged into one word. Unknown health is never healthy. There is no Publish:
// which destinations a manual release may reach is the owner's (OWNER_UI_V2 section 10), so it is listed as missing.

/** The release line of OWNER_UI_V2 section 5: live only with a passed post-release check, unknown never success. */
const RELEASE_LINE = { accepted: 'live', 'rolled-back': 'rolled-back', 'rollback-failed': 'failed', unknown: 'unknown', refused: 'not-released' };
const releaseLine = (state) => RELEASE_LINE[state] ?? 'publishing';

/** What a restore would put back, from the destination the release recorded: { scope, previous }. */
function restoreScope(r) {
  const d = r.destinationDetails;
  if (!d) return { scope: 'unknown-destination', previous: null };
  if (r.state === 'refused') return { scope: 'nothing-changed', previous: null };
  if (d.kind === 'merge') return { scope: 'revert-pull-request', previous: null };
  if (d.kind === 'local-git-apply') return { scope: 'backup-branch', previous: null };
  if (d.kind === 'local-folder-apply') return { scope: 'backup-files', previous: null };
  if (d.rollback !== 'automatic') return { scope: 'report-only', previous: r.previousDigest };
  if (!d.commands.includes('rollback')) return { scope: 'no-rollback-command', previous: r.previousDigest };
  return r.previousDigest ? { scope: 'previous-version', previous: r.previousDigest } : { scope: 'previous-unknown', previous: null };
}

/**
 * How the destination did at its latest check: { outcome, at, by }. `outcome` is passed, failed, unknown, checking or
 * not-checked; `by` is release (the post-release check), rollback (the check after a rollback, of the restored version)
 * or owner (Check the site now). The latest one counts.
 */
function releaseHealth(r) {
  if (r.healthCheck?.state === 'checking') return { outcome: 'checking', at: r.healthCheck.startedAt, by: 'owner' };
  const seen = [];
  if (r.healthCheck?.state === 'done') seen.push({ outcome: r.healthCheck.outcome ?? 'unknown', at: r.healthCheck.checkedAt, by: 'owner' });
  const last = (r.history ?? []).filter((entry) => entry.step === 'check' || entry.step === 'rollback').at(-1);
  if (last) {
    const outcome = last.outcome === 'done' ? 'passed' : last.outcome === 'failed' ? 'failed' : last.outcome === null && r.state !== 'unknown' ? 'checking' : 'unknown';
    seen.push({ outcome, at: last.endedAt, by: last.step === 'rollback' ? 'rollback' : 'release' });
  }
  return seen.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0] ?? { outcome: 'not-checked', at: null, by: null };
}

const acceptance = (review) => review?.state === 'accepted' ? 'yes' : !review || review.state === 'merged' ? 'unknown' : 'no';

/** Releases of one project (GET /api/v2/projects/:id/releases); null when the project is not known here. */
export function releasesView(project, { supervisor, owner, projects }) {
  if (!supervisor?.available) return { available: false, project: null, publish: null, releases: [], results: [] };
  const row = (projects?.projects ?? []).find((item) => sameProject(item.id, project));
  const goals = (supervisor.goals ?? []).filter((goal) => sameProject(goal.project, project));
  if (!row && !goals.length) return null;
  const campaigns = new Map((supervisor.campaigns ?? []).map((c) => [c.id, c]));
  // Every goal of the project, finished ones too: a result's Live: Yes always has its release listed here.
  const mine = new Set([...goals.map((goal) => goal.id), ...[...campaigns.values()].filter((c) => sameProject(c.repository, project)).map((c) => c.id)]);
  const text = (campaignId, taskId) => {
    const task = campaigns.get(campaignId)?.tasks?.find((item) => item.id === taskId);
    return task ? task.outcome ?? task.title ?? task.id : null;
  };
  const mode = (supervisor.settings?.releases ?? []).find((item) => sameProject(item.repository ?? item.project, project));
  const missing = mode?.modes?.find((item) => item.key === 'auto-release')?.missing ?? [];
  const results = Object.values(owner?.results ?? {}).filter((item) => sameProject(item.project, project))
    .flatMap((item) => item.groups.flatMap((group) => group.rows)).filter((item) => item.ladder);
  return { available: true, project: row ? projectRow(row) : { id: project, name: project, kind: null, repository: null, state: { key: 'unknown', text: null }, needsYou: 0, lastActivityAt: null },
    // Manual release: not built, and never more than an already granted destination could take (AW-010).
    publish: { available: false, missing: [...missing.map((item) => item.code), ...(mode && !mode.repository ? ['no-github'] : []), 'publish-not-built'] },
    stop: supervisor.settings?.releaseStop?.set ?? null,
    releases: (supervisor.releases ?? []).filter((r) => mine.has(r.campaignId)).map((r) => ({
      id: r.id, campaignId: r.campaignId, taskId: r.taskId, text: text(r.campaignId, r.taskId), line: releaseLine(r.state), state: r.state,
      destination: { id: r.destination, environment: r.destinationDetails?.environment ?? null, kind: r.destinationDetails?.kind ?? null },
      change: r.change, version: { verifiedSha: r.verifiedSha, mergeCommit: r.mergeCommit, deployedDigest: r.deployedDigest, previousDigest: r.previousDigest, grantVersion: r.grantVersion },
      restore: restoreScope(r), health: releaseHealth(r), checkNow: r.checkNow ?? { available: false, reason: null }, updatedAt: r.updatedAt })),
    // Each checked result with checked, merged, live and accepted apart (the Results ladder and recorded acceptance).
    results: results.map((item) => ({ campaignId: item.campaignId, taskId: item.taskId, text: item.text, sha: item.ladder.sha,
      steps: item.ladder.steps.map((step) => ({ key: step.key, answer: step.answer })), accepted: acceptance(item.review), note: item.ladder.note,
      // Live: Yes is only ever the recorded release's own deploy or apply step; this names that release's destination.
      liveFrom: item.ladder.steps.some((step) => step.key === 'deployed' && step.answer === 'yes') ? item.ladder.destination ?? 'its destination' : null })) };
}

/**
 * The trusted main and its backup (UI19, LOCAL_OPERATION.md sections 4.2 and 4.6), read-only and never fetching. With
 * origin trust (today's default) it says so and reads nothing. Reasons Git printed are never served: only state codes.
 */
export function trustedMainView(store, config) {
  const settings = selfHostingSettings(config);
  if (!settings.local) return { mode: 'origin', repository: settings.repository, problem: settings.problem ? 'invalid-setting' : null, state: null, backup: null };
  const path = config.repositories?.[settings.repository]?.path ?? Object.entries(config.repositories ?? {})
    .find(([name]) => name.toLowerCase() === settings.repository)?.[1]?.path;
  const tip = typeof path === 'string' && path ? trustedTip(store, { git: config.commands?.git ?? ['git'], repoPath: path, repository: settings.repository })
    : { state: 'UNREADABLE' };
  const backup = backupStatus(store, settings, settings.repository, tip.tip ?? null);
  return { mode: 'local', repository: settings.repository, problem: null, state: tip.state, tip: short(tip.tip), main: short(tip.main),
    unrecordedCount: Number.isSafeInteger(tip.unrecordedCount) ? tip.unrecordedCount : null,
    // The exact tips the owner route records (POST /api/v2/settings/trusted-main), shown in full beside its button.
    record: tip.state === 'TRUSTED' && tip.unrecordedCount > 0 ? { oldTip: tip.tip, newTip: tip.main } : null,
    backup: { enabled: backup.enabled, remote: backup.remote, branch: backup.branch, state: backup.state, at: backup.at, current: backup.current,
      tip: short(backup.tip), nextAttemptAfter: backup.nextAttemptAfter } };
}

/** Settings -> Connections (GET /api/v2/settings): AIWorks itself, each AI worker account, the merge checks and the trusted main. */
export function connectionsView({ supervisor, merges, trustedMain }) {
  if (!supervisor?.available) return { available: false, supervisor: null, accounts: [], workers: [], merges: [], trustedMain: null };
  const controller = supervisor.controller ?? {};
  return { available: true,
    supervisor: { state: controller.state ?? 'unknown', stopRequested: controller.stopRequested === true },
    accounts: (supervisor.settings?.accounts ?? []).map((account) => ({ kind: account.kind, name: account.name, state: account.state, retryAt: account.retryAt ?? null,
      open: account.open ?? 0, limit: account.limit ?? null })),
    // The AI workers that can take work, from the same readiness Settings shows: with no account registered, they run on
    // this computer's default login, and Connections says so instead of "none is set up".
    workers: (supervisor.settings?.workers ?? []).filter((worker) => ['ready', 'running', 'waiting'].includes(worker.state))
      .map((worker) => ({ kind: worker.kind, state: worker.state })),
    merges: (merges?.repositories ?? []).map((repo) => ({ repository: repo.repository, configured: repo.configured, local: repo.local === true,
      checkedAt: repo.fetchedAt ?? null, error: repo.error ?? null })),
    trustedMain };
}

/** Whether a data directory has a supervisor store at all (the views answer "not available" without one). */
export const hasStore = (dataDir) => existsSync(join(dataDir, 'supervisor.db'));

const readConfig = (dataDir) => { try { return JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { return {}; } };

/** Run `fn` with a read-only store of `dataDir`, or return `fallback` when there is none or it cannot be read. */
export function withReadOnlyStore(dataDir, fn, fallback) {
  if (!hasStore(dataDir)) return fallback;
  let store;
  try {
    store = new Store(join(dataDir, 'supervisor.db'), { readOnly: true });
    return fn(store, readConfig(dataDir));
  } catch { return fallback; } finally { store?.close(); }
}
