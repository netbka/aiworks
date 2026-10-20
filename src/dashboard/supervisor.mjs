import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { Store } from '../supervisor/store.mjs';
import { campaignStatus, campaignPause, campaignCancel, campaignRecheck, campaignStart, supervisorLiveness } from '../supervisor/api.mjs';
import { DEFAULTS } from '../supervisor/controller.mjs';
import { safeText } from './roadmap.mjs';
import { pendingInstructions } from '../supervisor/instructions.mjs';
import { decisionId, isDecision, structuredDecision } from '../supervisor/decisions.mjs';
import { criterionEvidence, MAX_FEEDBACK, mergedHead, OWNER_CHANGES, pendingChanges, unresolvedOf, verifiedReview } from '../supervisor/result-review.mjs';
import { mergeSettings } from '../supervisor/merge.mjs';
import { previewManifest, previewSupport, PreviewError } from '../supervisor/preview.mjs';
import { resolveCheckout, resolveLocalProject } from '../supervisor/project-connect.mjs';
import { configuredGitCommand } from './merges.mjs';
import { roleUnavailableReason, runNotCounted } from '../supervisor/adapters/executors.mjs';
import { campaignLimits } from '../supervisor/campaign.mjs';
import { parseReference } from '../supervisor/reading.mjs';
import { coordinatorView, LANE as COORDINATOR_LANE, postOwnerMessage } from '../supervisor/coordinator.mjs';
import { CODE_ROOT, revisionNotMerged, runtimeTrust } from '../supervisor/provenance.mjs';
import { COMMANDS, stateCopy, stopReasonWords } from './copy.mjs';
import { configuredRepositories, connectedProjects, projectConnectionEnabled } from './projects.mjs';
import { openOnProfile, setRoleModelPreference, shallowHomesRoot, configuredAccounts } from '../supervisor/accounts.mjs';
export { shallowHomesRoot };
import { removeShallowProfile } from '../supervisor/adapters/caam.mjs';
import { FORWARD_STEPS, RELEASE_STOP } from '../supervisor/release/state.mjs';
import { isLocalTarget } from '../supervisor/local-candidates.mjs';
import { pauseSummary, projectOf, sameProject } from './views.mjs';

const readConfig = (dataDir) => {
  try { return JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { return {}; }
};

/** Why an instruction the credential filter flags is refused, and what to change. Nothing is recorded or sent for it. */
export const INSTRUCTION_LOOKS_SENSITIVE = 'This text looks like it may contain a credential, so nothing was sent. Remove any key, token, password or session value and send again.';
// `detail` is the machine's own reason, for the page's Details disclosure; `message` is what the owner reads.
const fail = (status, message, detail = null) => Object.assign(new Error(message), { status, ...(detail ? { detail } : {}) });
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A project as a pause scope names it: a GitHub repository or the lp- id of a project without GitHub, never a path.
const PROJECT = /^(?:[\w.-]+\/[\w.-]+|lp-[a-z0-9][a-z0-9-]{0,38})$/;
const githubLink = (value) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+(?:#issuecomment-\d+)?$/.test(value ?? '') ? value : null;
const code = (value) => /^[a-z][a-z0-9-]{0,60}$/i.test(value ?? '') ? value : null;
function publicTaskWait(task, spec) {
  if (task.blocked) return ({ B3: 'Owner decision or environment authorization required', stalled: 'Bounded attempts exhausted; recovery required' })[task.blocked.class] ?? 'Required evidence or worker recovery is blocked';
  const error = String(task.last_error ?? '');
  if (error.startsWith('dependency-integration:')) return `Waiting for verified dependencies in main: ${spec.dependsOn.join(', ')}`;
  if (error.startsWith('waiting for executor availability:')) return 'Waiting for an eligible provider; automatic retry scheduled';
  if (error.startsWith('quota:')) return 'Provider usage limit; automatic retry scheduled';
  if (task.retry_at) return `Retry after ${code(error.split(':')[0]) ?? 'worker failure'}`;
  return null;
}

/**
 * Why a step waits and what AIWorks does next by itself: the supervisor's own `wait` of the step in status (RUN9,
 * ADAPTIVE_SCHEDULER section 6), never a sentence of the dashboard's (plan §6.12 C7, UI11). Status builds it from
 * supervisor fields only, so no worker text reaches it. Only its code, its two sentences and its time are served, with
 * the owner's word for an AI worker (OWNER_WORKSPACE §2.1). A step being worked on, ready to start, stopped, finished or
 * in finished work has no wait: who is on it, the stop copy or the result says where it stands.
 */
const ownerWords = (text) => safeText(String(text ?? ''), 300).replace(/\bAI provider\b/g, 'AI worker').replace(/\bprovider account\b/g, 'AI worker account');
function stepWait(task, wait, control) {
  if (!wait || ['running', 'ready'].includes(wait.code) || task.blocked || ['finished', 'cancelled'].includes(control)) return null;
  return { code: code(wait.code), text: ownerWords(wait.text), next: ownerWords(wait.next), until: wait.until ?? null };
}

/** A stopped step in the §7.7 words of the state copy module, with its one primary action (open the step issue). */
function stepStopped(task, label, issueUrl) {
  if (!task.blocked) return null;
  const reason = String(task.blocked.reason ?? '');
  // An owner decision: the worker said so, it made no progress, or the checker still rejects it after the repair rounds.
  const key = task.blocked.class === 'B3' || /^verifier still rejects/.test(reason) ? 'needs-decision' : /^admission blocked/.test(reason) ? 'recorded-blocker' : 'failed-attempts';
  const { title, text, primary } = stateCopy(key, { step: label, reason: stopReason(task), attempts: task.attempts, url: issueUrl });
  return { key, title, text, primary };
}

/** What the owner can do with a piece of work: Resume first when paused; Pause, Check again and Cancel in the More menu. */
function workControls(control) {
  if (control === 'paused') return { primary: 'resume', more: ['recheck', 'cancel'] };
  if (control === 'registered') return { primary: null, more: ['pause', 'recheck', 'cancel'] };
  // Finished, cancelled or cancelling work accepts no command (applyCommand refuses it), so it has no menu.
  return { primary: null, more: [] };
}

/** One journal entry with supervisor-authored fields only: the activity journal and a step's own history share it. */
const publicEvent = (item, op) => ({
  id: item.seq, campaignId: item.campaign_id, at: item.at, kind: code(item.kind),
  operation: typeof item.detail?.op === 'string' && /^[\w.-]{1,220}$/.test(item.detail.op) ? item.detail.op : null,
  action: code(item.detail?.action), outcome: code(item.detail?.class), terminal: code(item.detail?.terminal),
  blocking: Number.isSafeInteger(item.detail?.blocking) ? item.detail.blocking : null, run: Number.isSafeInteger(item.detail?.run) ? item.detail.run : null,
  taskId: identifier.test(op?.task_id ?? item.detail?.task ?? '') ? op?.task_id ?? item.detail.task : null,
  executor: code(item.detail?.executor ?? op?.executor_kind), fromExecutor: code(item.detail?.from),
  reason: code(item.detail?.reason), credits: item.detail?.credits === true || /credits\/billing/.test(item.detail?.detail ?? ''),
});

const HISTORY_LIMIT = 30;
/**
 * Every step's own history (OWNER_WORKSPACE §4.8, slice S5): its attempts with how each ended, from `operations`, and
 * its journal events. A read-only query of one campaign's records; an entry belongs to a step only when the supervisor
 * recorded it for that step, so one step never shows another's. Worker text never leaves: codes, counts, times, run IDs.
 */
function stepHistories(store, campaignId) {
  const histories = new Map(), of = (taskId) => {
    if (!histories.has(taskId)) histories.set(taskId, { attempts: [], events: [] });
    return histories.get(taskId);
  };
  const operations = new Map();
  for (const op of store.all('SELECT id, task_id, kind, executor_kind, state, outcome, created_at, updated_at FROM operations WHERE campaign_id = ? ORDER BY created_at DESC, seq DESC', campaignId)) {
    operations.set(op.id, op);
    const { attempts } = of(op.task_id);
    if (attempts.length >= HISTORY_LIMIT) continue;
    const terminal = op.outcome?.class === 'result' ? op.outcome.value?.result ?? op.outcome.value?.verdict ?? null : null;
    attempts.push({ id: /^[\w.-]{1,220}$/.test(op.id) ? op.id : null, role: op.kind === 'verify' ? 'Verifier' : 'Implementer', executor: code(op.executor_kind),
      state: code(op.state), startedAt: op.created_at, endedAt: ['finished', 'abandoned'].includes(op.state) ? op.updated_at : null,
      outcome: code(op.outcome?.class), terminal: code(terminal), refunded: op.outcome?.refunded === true,
      blockingFindings: op.outcome?.class === 'result' && Array.isArray(op.outcome.value?.findings) ? op.outcome.value.findings.filter((f) => f?.severity === 'blocking').length : null });
  }
  for (const item of store.all("SELECT seq, campaign_id, at, kind, detail FROM journal WHERE campaign_id = ? AND kind NOT IN ('event-dashboard-command', 'lease-acquired') ORDER BY seq DESC LIMIT 2000", campaignId)) {
    const event = publicEvent(item, typeof item.detail?.op === 'string' ? operations.get(item.detail.op) ?? null : null);
    if (!event.taskId) continue;
    const { events } = of(event.taskId);
    if (events.length < HISTORY_LIMIT) events.push(event);
  }
  return histories;
}

const cents = (value) => Math.round(value * 10000) / 10000;
const reportedCost = (outcome) => Number.isFinite(outcome?.receipt?.costUsd) && outcome.receipt.costUsd > 0 ? outcome.receipt.costUsd : 0;
/**
 * What each step cost (OWNER_WORKSPACE §4.10, slice S7), from the cost each run's own receipt reported: the same receipts
 * the campaign total adds up, and the same rule as the budget for a run whose cost is not reported (a counted, finished
 * run without a positive cost). Runs still in progress have no cost yet and are counted apart. A refunded run (the
 * provider or executor refused before any work) is not a run of the step. Unknown stays unknown: it is never added as $0.
 */
function stepCosts(store, campaignId) {
  const costs = new Map(), of = (taskId) => {
    if (!costs.has(taskId)) costs.set(taskId, { runs: 0, reportedUsd: 0, unreportedRuns: 0, runningRuns: 0, retries: 0 });
    return costs.get(taskId);
  };
  for (const op of store.all("SELECT task_id, state, outcome FROM operations WHERE campaign_id = ? AND state IN ('finished', 'recorded', 'dispatched')", campaignId)) {
    const step = of(op.task_id);
    if (op.state !== 'finished') { step.runningRuns++; continue; }
    // A reported cost counts even on a refunded run: the campaign total adds it too.
    step.reportedUsd = cents(step.reportedUsd + reportedCost(op.outcome));
    if (runNotCounted(op.outcome)) continue;
    step.runs++;
    if (!reportedCost(op.outcome)) step.unreportedRuns++;
    // A counted run that ended without a result (failed, timed out, invalid): the step had to run again.
    if (op.outcome?.class !== 'result') step.retries++;
  }
  return costs;
}

/**
 * Cost per project (OWNER_WORKSPACE §4.10, slice S7): today's per-campaign totals added up by repository, so a project's
 * total is exactly the sum of its campaigns' recorded cost. Runs that reported no cost and runs still in progress are
 * counted apart, never as $0.00. `reportedUsd` is null when nothing reported a cost; `empty` is the §7.1 copy when nothing ran.
 */
export function projectCosts(campaigns) {
  const projects = new Map();
  for (const c of campaigns) {
    const key = String(c.repository).toLowerCase();
    const project = projects.get(key) ?? { repository: c.repository, works: 0, worksWithRuns: 0, runs: 0, reportedUsd: 0, unreportedRuns: 0, runningRuns: 0 };
    project.works++;
    // Pieces of work with counted runs, so the summary matches the breakdown's run counts (aiworks#11 review F14).
    if (c.runsUsed > 0) project.worksWithRuns++;
    project.runs += c.runsUsed;
    project.reportedUsd = cents(project.reportedUsd + (c.cost.reportedUsd ?? 0));
    project.unreportedRuns += c.cost.unreportedRuns;
    project.runningRuns += c.cost.runningRuns;
    projects.set(key, project);
  }
  return [...projects.values()].map((project) => {
    const empty = !project.runs && !project.runningRuns && !project.unreportedRuns && !(project.reportedUsd > 0) ? stateCopy('cost-empty') : null;
    return { ...project, reportedUsd: project.reportedUsd > 0 ? project.reportedUsd : null, empty: empty && { title: empty.title, text: empty.text } };
  });
}

// ---- Model, tier, cost by unit and why a step moved up (MODEL_ROUTING slice R6, dashboard half; build slice UI12). The
// supervisor's status (MOD6) is the one source; this only narrows it to safe values. Units are never added together: dollars
// stay dollars, tokens stay per provider, and runs without reported dollars are counted, never shown as $0.00. ----

const TIERS = ['economy', 'standard', 'strongest'];
const modelName = (value) => /^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(value ?? '') ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
/** One run's model: the provider, the model its receipt names (null when not recorded) and its tier name. */
const modelUsed = (view) => view ? { executor: code(view.executor), model: modelName(view.model), tier: TIERS.includes(view.tierName) ? view.tierName : null } : null;
// The status reason is built from fixed labels only (MOD6). This keeps it to that shape, so no other text can reach the page.
const MOVED_UP = /^Moved to the (?:economy|standard|strongest|tier \d+) model after (?:poor-quality results|(?:\w+ (?:rejected|unusable|timed-out|without evidence) (?:attempt|review)s?)(?: and \w+ (?:rejected|unusable|timed-out|without evidence) (?:attempt|review)s?)*)$/;
/** Why a step moved to a stronger model, in the status's own words; a sentence of any other shape becomes the general one. */
function movedUp(escalation) {
  if (!escalation) return null;
  const tier = TIERS.includes(escalation.toTierName) ? escalation.toTierName : null;
  return { stage: escalation.stage === 'verify' ? 'verify' : 'implement', tier,
    reason: MOVED_UP.test(escalation.reason ?? '') ? escalation.reason : `Moved to ${tier ? `the ${tier}` : 'a stronger'} model after poor-quality results` };
}
/** A step's or a work program's cost by unit: reported dollars (null, never 0, when none), tokens per provider and unknown-cost runs. */
export function costByUnit(cost) {
  const reported = Number.isFinite(cost?.usd?.reported) && cost.usd.reported > 0 ? cost.usd.reported : null;
  return { usd: reported, usdRuns: reported === null ? 0 : count(cost.usd.reportedRuns),
    tokens: Object.entries(cost?.tokens ?? {}).filter(([kind]) => code(kind)).map(([executor, item]) => ({ executor, runs: count(item.runs),
      input: count(item.input), output: count(item.output), cacheRead: count(item.cacheRead), cacheCreation: count(item.cacheCreation),
      cachedInInput: count(item.runs) > 0 && count(item.inputIncludesCacheReadRuns) === count(item.runs) })),
    unknownRuns: count(cost?.unknownCostRuns) };
}
/** A step's models and move up, from its status row. */
export function stepRouting(row) {
  return { implement: modelUsed(row?.routing?.implement), verify: modelUsed(row?.routing?.verify), movedUp: movedUp(row?.routing?.escalation) };
}

// ---- Scoped reading (SCOPED_READING section 8, slice UI18, the dashboard half of READ3). The status `reading` is the
// source; the rule a returned change broke and the sections the next attempt was given come from the supervisor's own
// records of that check and that attempt. Only a path, a section slug and a heading leave this module: never document
// text, a finding or any other worker text. A step whose status `reading` is null gets null, so it shows nothing new. ----

const FALLBACK_REASONS = ['missing', 'ambiguous', 'not-markdown', 'unreadable'];
const CITE_KINDS = ['covered', 'section-miss', 'unreferenced-doc'];
const READING_LIST_LIMIT = 8;
/** `{ path, anchor }` of a repository reference, or null when it is not one or would carry anything else. */
function sectionOf(path, anchor) {
  const parsed = parseReference(anchor ? `${path}#${anchor}` : path);
  return parsed && safeText(parsed.path, 512) === parsed.path ? parsed : null;
}
/** A heading as the document names it, one line and bounded; null when it is missing or looks like a secret. */
function headingOf(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
  return text && safeText(text, 120) === text ? text : null;
}
/** The newest dispatch's sections added from this work's other steps (journal `reading-guide-extended`), distinct. */
function extendedSections(store, campaignId, taskId) {
  const out = [];
  for (const { detail } of store.all("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'reading-guide-extended' ORDER BY seq DESC LIMIT 200", campaignId)) {
    const section = detail?.task === taskId ? sectionOf(detail.path, detail.anchor) : null;
    if (!section?.anchor || out.some((item) => item.path === section.path && item.anchor === section.anchor)) continue;
    out.push(section);
    if (out.length >= READING_LIST_LIMIT) break;
  }
  return out;
}
/**
 * A step's reading, from its status `reading`: the counts and fallbacks as status has them; `broke`, the sections the
 * blocking findings of the step's latest check cite when that check returned the change; `next`, whether an attempt
 * started after that check, and which of those sections it was given. Null when status has none.
 */
export function stepReading(store, campaignId, taskId, reading) {
  if (!reading) return null;
  const fallbacks = (reading.fallbacks ?? []).flatMap((item) => {
    const section = sectionOf(item?.path, item?.anchor);
    return section?.anchor ? [{ ...section, reason: FALLBACK_REASONS.includes(item.reason) ? item.reason : null }] : [];
  }).slice(0, READING_LIST_LIMIT);
  const check = store.get("SELECT created_at, outcome FROM operations WHERE campaign_id = ? AND task_id = ? AND kind = 'verify' AND state = 'finished' ORDER BY created_at DESC, seq DESC LIMIT 1",
    campaignId, taskId);
  const value = check?.outcome?.class === 'result' ? check.outcome.value : null;
  const blocking = new Set((Array.isArray(value?.findings) ? value.findings : []).filter((f) => f?.severity === 'blocking').map((f) => f.id));
  const broke = [];
  for (const cite of value?.verdict === 'rejected' && Array.isArray(check.outcome.reading?.cites) ? check.outcome.reading.cites : []) {
    const section = blocking.has(cite?.finding) ? sectionOf(cite.path, cite.anchor) : null;
    if (!section || broke.some((item) => item.path === section.path && item.anchor === section.anchor)) continue;
    broke.push({ ...section, heading: section.anchor ? headingOf(cite.heading) : null, kind: CITE_KINDS.includes(cite.classification) ? cite.classification : null });
    if (broke.length >= READING_LIST_LIMIT) break;
  }
  // The first attempt after that check is the one the repair round started; its references hold the sections it was given.
  const after = broke.length ? store.get("SELECT packet FROM operations WHERE campaign_id = ? AND task_id = ? AND kind = 'implement' AND created_at > ? ORDER BY created_at, seq LIMIT 1",
    campaignId, taskId, check.created_at) : null;
  const given = new Set((Array.isArray(after?.packet?.references) ? after.packet.references : []).map((item) => item?.path));
  return { anchored: count(reading.anchored), fallbacks, misses: { section: count(reading.misses?.section), unreferenced: count(reading.misses?.unreferenced) },
    extended: count(reading.extended), extendedSections: count(reading.extended) ? extendedSections(store, campaignId, taskId) : [],
    broke: broke.map((item) => ({ ...item, given: after ? given.has(item.anchor ? `${item.path}#${item.anchor}` : item.path) : null })),
    nextStarted: broke.length ? Boolean(after) : null };
}

// The command names config.json may set (`commands.<name>`). Only the names leave this module, never the configured value:
// a command is an executable path and its arguments (OWNER_WORKSPACE §8, slice S8).
const COMMAND_NAMES = ['claude', 'codex', 'cursor', 'agy', 'chrome', 'git', 'gh'];
/** The AI workers this computer can have, in the order the owner reads them. AGY is listed only when set up or allowed. */
const WORKERS = [
  { kind: 'claude-cli', command: 'claude', fallback: true }, { kind: 'codex-cli', command: 'codex' },
  { kind: 'cursor-cli', command: 'cursor' }, { kind: 'agy-cli', command: 'agy', needs: ['chrome'], optional: true },
];
const TERMINAL = ['finished', 'cancelled'];

/** Which `commands.<name>` entries this computer's config.json sets, by name only. */
export function configuredCommandNames(config) {
  const commands = config?.commands;
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) return [];
  return COMMAND_NAMES.filter((name) => Array.isArray(commands[name]) && commands[name].length > 0 && commands[name].every((part) => typeof part === 'string' && part.length > 0));
}

/**
 * The AI workers of this computer, once each (OWNER_WORKSPACE §4.3, slice S8). Each campaign's own provider rows are
 * merged: a worker is "running" when any active campaign runs it, "waiting" for a usage limit with the earliest time
 * AIWorks tries again, "unavailable" with the supervisor's reason, "not-set-up" when config.json sets no command for it
 * (Claude falls back to `claude` on PATH, as the controller does), and "host-unavailable" when it cannot run on this
 * operating system at all. Finished and cancelled work no longer waits for anything, so its rows are not read.
 */
export function aiWorkers(campaigns, config, { platform = process.platform, now = Date.now() } = {}) {
  const names = configuredCommandNames(config), active = campaigns.filter((c) => !TERMINAL.includes(c.control));
  return WORKERS.filter((w) => !w.optional || names.includes(w.command) || active.some((c) => c.executors.includes(w.kind))).map((w) => {
    const rows = active.flatMap((c) => (c.providers ?? []).filter((p) => p.kind === w.kind && p.priority !== null));
    const setUp = names.includes(w.command) && (w.needs ?? []).every((name) => names.includes(name)) ? 'configured' : w.fallback ? 'default' : 'missing';
    const hostLimit = w.kind === 'cursor-cli' && platform === 'win32' ? 'windows' : null;
    const limit = roleUnavailableReason({ kind: w.kind }, 'implementer', 'commit', platform);
    const waits = rows.filter((p) => ['cooldown', 'retry-due'].includes(p.state) && p.retryAt !== null);
    const unavailable = rows.find((p) => p.state === 'unavailable');
    const state = hostLimit ? 'host-unavailable' : rows.some((p) => p.state === 'running') ? 'running' : setUp === 'missing' ? 'not-set-up'
      : unavailable ? 'unavailable' : waits.length ? 'waiting' : 'ready';
    const retryAt = state === 'waiting' ? Math.min(...waits.map((p) => p.retryAt)) : null;
    return { kind: w.kind, state, setUp, usedBy: rows.length, retryAt, overdue: retryAt !== null && retryAt <= now,
      reason: state === 'waiting' ? waits.find((p) => p.retryAt === retryAt).reason ?? 'quota' : state === 'unavailable' ? unavailable.reason : null,
      credits: state === 'waiting' && waits.some((p) => p.credits), availabilityReason: state === 'unavailable' ? unavailable.availabilityReason : null,
      hostLimit, buildLimit: !limit ? null : w.kind === 'agy-cli' ? 'web-only' : 'checks-only' };
  });
}

/**
 * Release mode per project (OWNER_WORKSPACE §10.3 and S13, AUTO_RELEASE.md section 9 and R9; slices S8 and UI15): Review
 * only is on; Auto Release is off, unavailable, and `missing` says exactly why, one condition of AUTO_RELEASE.md
 * section 3 each. There is no switch and no field a page could turn into one: a switch needs a valid release grant, and
 * the dashboard reads none, so none can exist until #33 (REL11). `waitsFor` links that decision when config.json
 * "autoReleaseDecision" names it (a GitHub issue link); otherwise it is null and the mode shows no link, so a
 * disposable review copy names no real issue. `enabled` is config.json `release.enabled === true`; `stop` is
 * releaseStopState's `set`.
 * `connected` are the connected project records when Add project is on, so Release mode lists every project Settings
 * lists: a connected GitHub project by its repository, and a project without GitHub with the sentence that release does
 * not apply to it yet, since no work can start there (aiworks#11 review 5 G10).
 */
export function releaseModes(repositories, { waitsFor = null, connected = [], enabled = false, stop = false } = {}) {
  const projects = new Map();
  const github = connected.filter((record) => record.source_kind === 'github').map((record) => record.github_repository);
  for (const repository of [...repositories, ...github]) if (/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') && !projects.has(repository.toLowerCase())) projects.set(repository.toLowerCase(), repository);
  const local = connected.filter((record) => record.source_kind !== 'github').sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((record) => ({ repository: null, project: record.id, name: record.name, mode: null, modes: [], text: RELEASE_LOCAL }));
  const missing = [RELEASE_MISSING.grant, enabled === true ? null : RELEASE_MISSING.off,
    stop === true ? RELEASE_MISSING.stopped : stop === false ? null : RELEASE_MISSING.stopUnknown].filter(Boolean);
  return [...[...projects.values()].sort((a, b) => a.localeCompare(b)).map((repository) => ({ repository, mode: 'review-only', modes: [
    { key: 'review-only', label: 'Review only', on: true, text: 'Release is not enabled here. Merging follows the project’s merge permissions.' },
    { key: 'auto-release', label: 'Auto Release', on: false, available: false,
      text: 'Not available. Turning this on needs your separate release approval for this project, which has not been given.',
      missing, waitsFor }] })), ...local];
}
// Why Auto Release is unavailable, one condition each (AUTO_RELEASE.md section 3). The grant comes first: without it
// nothing else matters, and the dashboard reads no grant, so it is always missing here.
const RELEASE_MISSING = {
  grant: { code: 'no-grant', text: 'No valid release grant is recorded for this project.' },
  off: { code: 'switched-off', text: 'Auto Release is switched off on this computer.' },
  stopped: { code: 'release-stop', text: 'Stop all releases is on.' },
  stopUnknown: { code: 'release-stop-unknown', text: 'Whether Stop all releases is on cannot be read.' },
};
const RELEASE_LOCAL = 'Release does not apply to a project without GitHub: a checked result changes your folder only when you press Apply on it, under Review only.';

/** Settings (slice S8): configured command names, the AI workers once for this computer, accounts, and release mode per project. */
export function computerSettings(campaigns, config, { platform = process.platform, now = Date.now(), repositories = [], connected = [], accounts = [],
  releaseStop = { set: false, since: null } } = {}) {
  return { commands: configuredCommandNames(config), workers: aiWorkers(campaigns, config, { platform, now }),
    accounts,
    modelPreferences: savedModelOrder(config),
    releases: releaseModes([...repositories, ...campaigns.map((c) => c.repository)], { waitsFor: issueLink(config?.autoReleaseDecision), connected,
      enabled: config?.release?.enabled === true, stop: releaseStop.set }),
    // Stop all releases (AUTO_RELEASE.md 4.5): whether RELEASE-STOP is set; `set` null when it cannot be read.
    releaseStop,
    // Where supervisor faults are tracked: config.json "supervisorIssue" (a GitHub issue link) when set, so a disposable
    // review copy can name a made-up one; otherwise null, and the owner view links AIWorks' own (owner.mjs SUPERVISOR_ISSUE).
    supervisorIssue: issueLink(config?.supervisorIssue) };
}

const ACCOUNT_PROVIDERS = ['claude', 'codex', 'agy', 'cursor'];
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The folder a provider's login is saved in inside a profile (src/supervisor/accounts.mjs configuredAccounts).
const LOGIN_FOLDER = { claude: '.claude', codex: '.codex', agy: '.agy', cursor: '.cursor' };
// An account's wait by the outcome class its reason starts with (src/supervisor/accounts.mjs ACCOUNT_SCOPED).
const WAIT_STATE = { quota: 'usage-limit', auth: 'sign-in', unavailable: 'unavailable' };
const PREFERENCE_ROLES = ['implementer', 'verification'];
// The saved model order of each role the page shows; any other value reads as nothing saved. Work does not read it:
// each piece of work uses the order its approved plan names (SUPERVISOR.md section 13).
const savedModelOrder = (config) => Object.fromEntries(PREFERENCE_ROLES.map((role) =>
  [role, Array.isArray(config?.modelPreferences?.[role]) ? config.modelPreferences[role] : []]));
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

function refusal(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * The worker accounts as the page shows them: whose login, whether it is saved on this computer, and one state. The wait
 * reason itself is never served: it can carry a worker's raw error text (OWNER_WORKSPACE §10.1). Neither is any path.
 */
export function dashboardAccounts(store, config, { now = Date.now(), dataDir } = {}) {
  const root = shallowHomesRoot(config, dataDir);
  return configuredAccounts(store, config, { now, dataDir }).map(({ id, provider, kind, name, usage }) => {
    const open = usage.open ?? 0;
    const waitClass = typeof usage.waitReason === 'string' ? usage.waitReason.split(':')[0] : null;
    const outcomes = usage.outcomes ?? {};
    return { id, provider, kind, name: safeText(name, 64),
      hasLogin: ACCOUNT_PROVIDERS.includes(provider) && ACCOUNT_NAME.test(name) && existsSync(join(root, name, LOGIN_FOLDER[provider])),
      state: usage.coolingDown ? WAIT_STATE[waitClass] ?? 'unavailable' : open > 0 ? 'in-use' : 'ready',
      retryAt: usage.coolingDown && Number.isFinite(usage.retryAt) ? new Date(usage.retryAt).toISOString() : null,
      open, limit: usage.limit ?? null,
      runs: { finished: (usage.totalOperations ?? 0) - (outcomes.open ?? 0), withResult: outcomes.result ?? 0, usageLimit: outcomes.quota ?? 0 },
      runMinutes: Math.round((usage.totalDurationMs ?? 0) / 60_000) };
  });
}

/**
 * Remove an account's saved login folder from this computer: only a login saved here, and never while it runs work. Its
 * run history, usage-limit wait and learned limit stay. They are AIWorks' records, not the login, and ending a wait here
 * would send work straight back to an account at its limit. The dashboard never writes the supervisor store.
 */
export function removeDashboardAccount(dataDir, { provider, name } = {}) {
  if (!ACCOUNT_PROVIDERS.includes(provider) || typeof name !== 'string' || !ACCOUNT_NAME.test(name)) {
    throw refusal(400, 'Provider must be claude, codex, agy or cursor, and the account name only letters, numbers, dots, dashes and underscores.');
  }
  const root = shallowHomesRoot(readConfig(dataDir), dataDir);
  if (!existsSync(join(root, name, LOGIN_FOLDER[provider]))) throw refusal(404, 'This account has no saved login on this computer.');
  const account = `${provider}/${name}`;
  const path = join(dataDir, 'supervisor.db');
  if (existsSync(path)) {
    const store = new Store(path, { readOnly: true });
    try {
      if (openOnProfile(store, account) > 0) throw refusal(409, 'This account is running work right now. Remove its login after that work finishes.');
    } finally { store.close(); }
  }
  const { removed } = removeShallowProfile({ kind: `${provider}-cli`, name, root });
  return { success: true, account, removed };
}

export function configuredModelPreferences(dataDir) {
  return savedModelOrder(readConfig(dataDir));
}

/**
 * Save one role's model order in the shape the supervisor reads (src/supervisor/accounts.mjs applyModelPreferences): a
 * list of model names, each tied to one AI worker when `kind` is given. Only Builder and Independent checker have an
 * order, because nothing reads one for another role. The other role's order is kept. An empty list returns the role to
 * AIWorks' own order.
 */
export function saveDashboardModelPreferences(dataDir, { role, models, kind = null } = {}) {
  if (!PREFERENCE_ROLES.includes(role)) throw refusal(400, 'Choose Builder or Independent checker.');
  if (!Array.isArray(models) || models.length > 10 || !models.every((model) => typeof model === 'string' && MODEL_NAME.test(model))) {
    throw refusal(400, 'List up to 10 model names, each in letters, numbers, dots, colons, slashes or dashes.');
  }
  if (kind !== null && !WORKERS.some((worker) => worker.kind === kind)) throw refusal(400, 'Choose an AI worker from the list.');
  return setRoleModelPreference(dataDir, role, models.map((model) => kind ? { model, kind } : model));
}

/** `value` when it is a GitHub issue link, else null. */
function issueLink(value) {
  return typeof value === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(value) ? value : null;
}

// The controller's own next action for a finished campaign is one of two fixed sentences naming the repository; it
// is passed through only when it is exactly one of them (other next actions can quote stored worker text).
const FINISHED_ACTION = /^(?:Planning reports published in [\w.-]+\/[\w.-]+; review recommendations before assigning implementation|Release gate: review campaign deliveries under [\w.-]+\/[\w.-]+'s own merge and release policy)\.$/;
function publicNextAction(c, status, tasks, operations) {
  if (c.control === 'finished') return FINISHED_ACTION.test(c.next_action ?? '') ? c.next_action : 'All registered deliverables published; repository acceptance and release remain separate gates';
  if (c.control === 'cancelled') return 'Campaign cancelled';
  if (c.control === 'paused') return 'Paused; existing workers may finish';
  if (c.control === 'cancel-requested') return 'Cancellation requested; waiting for owned workers to stop';
  if (!status.controller.live) return 'Waiting for a live campaign controller';
  if (c.blocker) return `Blocked: ${code(c.blocker.kind) ?? 'required recovery'}`;
  if (operations.length) return `${operations[0].kind === 'verify' ? 'Verify' : 'Implement'} ${operations[0].task_id}`;
  const next = tasks.find((task) => task.state !== 'done' && !task.blocked && c.declaration.tasks.find((s) => s.id === task.task_id).dependsOn.every((id) => tasks.find((t) => t.task_id === id)?.state === 'done'));
  if (next) return publicTaskWait(next, c.declaration.tasks.find((s) => s.id === next.task_id)) ?? `Next task: ${next.task_id}`;
  return tasks.some((task) => task.blocked) ? 'Required task gates remain blocked; independent eligible work continues' : 'Waiting for dependency deliveries';
}

function heartbeat(dataDir, runDir) {
  try {
    const path = realpathSync(join(runDir, 'heartbeat'));
    const inside = relative(realpathSync(join(dataDir, 'runs')), path);
    if (inside.startsWith('..') || isAbsolute(inside) || statSync(path).size > 40) return null;
    const time = Number(readFileSync(path, 'utf8'));
    return Number.isSafeInteger(time) && time > 0 && time <= Date.now() + 5000 ? time : null;
  } catch { return null; }
}

function outputAt(dataDir, runDir) {
  try {
    const path = realpathSync(join(runDir, 'stdout.json'));
    const inside = relative(realpathSync(join(dataDir, 'runs')), path);
    if (inside.startsWith('..') || isAbsolute(inside)) return null;
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0 && stat.mtimeMs <= Date.now() + 5000 ? stat.mtimeMs : null;
  } catch { return null; }
}

// Claude Code writes a headless session's transcript under <config>/projects/<cwd slug>/<session>.jsonl.
const claudeTranscript = (workspace, sessionId) => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects',
  String(workspace).replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
const PROGRESS_MAX_BYTES = 64 * 1024 * 1024;
const toolName = (value) => /^[A-Za-z][\w.-]{0,60}$/.test(value ?? '') ? value : null;

/**
 * Evidence that a running worker is doing work, not merely alive: counts of turns and tool calls and the
 * time of the last one, read from the provider's own streamed record. Only counts, tool names and
 * timestamps leave this function; prompts, commands, file contents and model text never do.
 */
function workerProgress(dataDir, op) {
  try {
    const kind = op.executor_kind ?? 'claude-cli';
    const path = kind === 'claude-cli' ? claudeTranscript(op.workspace, op.session_id) : realpathSync(join(op.run_dir, 'stdout.json'));
    if (kind !== 'claude-cli' && relative(realpathSync(join(dataDir, 'runs')), path).startsWith('..')) return null;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0 || stat.size > PROGRESS_MAX_BYTES) return null;
    let turns = 0, toolCalls = 0, lastTool = null, lastAt = null;
    // The newest tool call that has no result yet: the worker is waiting on it (a test suite, a build), not idle.
    let open = null;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (kind === 'claude-cli') {
        if (event.type === 'user') {
          const done = (Array.isArray(event.message?.content) ? event.message.content : []).filter((part) => part?.type === 'tool_result').map((part) => part.tool_use_id);
          if (open && done.includes(open.id)) open = null;
          continue;
        }
        if (event.type !== 'assistant') continue;
        turns++;
        const at = Date.parse(event.timestamp ?? '');
        if (Number.isFinite(at)) lastAt = at;
        for (const part of event.message?.content ?? []) {
          if (part?.type !== 'tool_use') continue;
          toolCalls++; lastTool = toolName(part.name);
          open = { id: part.id, tool: lastTool, since: Number.isFinite(at) ? at : null };
        }
      } else {
        const item = event.item;
        if (event.type === 'item.started' && item?.type === 'command_execution') open = { id: item.id, tool: 'command', since: stat.mtimeMs };
        if (event.type === 'item.completed' && open && item?.id === open.id) open = null;
        if (event.type === 'item.completed' && item?.type === 'agent_message') turns++;
        if (event.type === 'item.completed' && ['command_execution', 'mcp_tool_call'].includes(item?.type)) {
          toolCalls++; lastTool = item.type === 'mcp_tool_call' ? toolName(`${item.server}.${item.tool}`) : 'command';
        }
        lastAt = stat.mtimeMs;
      }
    }
    return { source: kind === 'claude-cli' ? 'session-transcript' : 'streamed-output', turns, toolCalls, lastTool,
      lastActivityAt: lastAt ?? stat.mtimeMs, updatedAt: stat.mtimeMs,
      runningTool: open?.tool ?? null, runningSince: open ? open.since ?? lastAt ?? stat.mtimeMs : null };
  } catch { return null; }
}

/** A task's stop reason in the owner's words (the copy module); never the stored free text, which may quote a worker. */
const stopReason = (task) => stopReasonWords(task.blocked, task.repair_rounds);

/**
 * What happened since a point in time, for the owner's "since you last looked" summary: published steps,
 * failed or rejected worker runs and the supervisor's own step errors and liveness problems (kept apart by kind),
 * from the journal's supervisor-authored fields only.
 */
function recentEvents(store, since, now) {
  if (!Number.isSafeInteger(since) || since > now) return null;
  const published = [], failures = [];
  for (const item of store.all(`SELECT campaign_id, at, kind, detail FROM journal WHERE at >= ? AND kind IN ('published', 'operation-finished', 'step-error', 'liveness-defect')
      ORDER BY seq DESC LIMIT 2000`, since)) {
    const task = identifier.test(item.detail?.task ?? '') ? item.detail.task : null;
    if (item.kind === 'published') published.push({ campaignId: item.campaign_id, taskId: task, url: githubLink(item.detail?.url), at: item.at });
    // Provider limits and unavailable providers are waits, not failures; a rejection by the independent checker is.
    else if (item.kind !== 'operation-finished' || !['result', 'unavailable', 'quota'].includes(item.detail?.class) || item.detail?.terminal === 'rejected') {
      failures.push({ campaignId: item.campaign_id, at: item.at, kind: item.kind === 'operation-finished' ? item.detail?.terminal === 'rejected' ? 'rejected' : 'failed-run' : item.kind });
    }
  }
  return { since, published, failures };
}

/**
 * Every goal's control (OWNER_UI_V2 WP1: pause for all, a project or a goal), projects without GitHub included: the
 * versions a pause or resume binds, and for a paused goal who paused it (`pauseScope`: all, project or goal), when, and
 * how many runs it started are still open, so the page says "stopping" until the last one ends and "stopped" after.
 */
function goalControls(store) {
  return store.all("SELECT id FROM campaigns WHERE control IN ('registered', 'paused') ORDER BY created_at").map(({ id }) => {
    const c = store.campaign(id), paused = c.control === 'paused'
      ? store.get("SELECT at, detail FROM journal WHERE campaign_id = ? AND kind = 'paused' ORDER BY seq DESC LIMIT 1", id) : null;
    const scope = paused?.detail?.scope;
    return { id, project: projectOf(c.declaration), control: c.control, version: c.version, authorizationVersion: c.authorization_version,
      scopeDigest: c.scope_digest, openRuns: store.openOperations(id).length, pausedAt: paused?.at ?? null,
      pauseScope: !paused ? null : scope?.kind === 'all' ? { kind: 'all' } : scope?.kind === 'project' && PROJECT.test(scope.project ?? '') ? { kind: 'project', project: scope.project } : { kind: 'goal' } };
  });
}

// The states of a release (release/state.mjs, AUTO_RELEASE.md 7.1). Anything else reads as unknown, never as done.
const RELEASE_STATES = new Set(['eligible', 'locked', 'merging', 'merged', 'deploying', 'deployed', 'applying', 'applied', 'checking', 'accepted',
  'rolling-back', 'rolled-back', 'rollback-failed', 'unknown', 'refused']);
const RELEASE_OUTCOMES = new Set(['done', 'failed', 'not-done', 'refused']);
const RELEASE_HISTORY_STEPS = [...FORWARD_STEPS, 'rollback'];

/**
 * The releases recorded in the store (slice REL3), the latest attempt per step, for the five-step ladder on Results and
 * the unknown and failure lines in Needs me (AUTO_RELEASE.md section 9, slice UI15). Built switched off (#33): nothing
 * writes them yet, so this is empty today. Only names, states, step names and outcomes leave here, each checked: an
 * unrecognised state or outcome is `unknown`, and an outcome not recorded is null (started, not finished).
 */
function recordedReleases(store) {
  if (!store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'releases'")) return [];
  const latest = new Map();
  for (const r of store.all('SELECT * FROM releases ORDER BY created_at, attempt')) latest.set(`${r.campaign_id}/${r.task_id}`, r);
  return [...latest.values()].map((r) => ({ id: safeText(r.id, 200), project: identifier.test(r.project) ? r.project : null,
    destination: identifier.test(r.destination) ? r.destination : null, campaignId: r.campaign_id, taskId: r.task_id,
    verifiedSha: /^[0-9a-f]{40}$/.test(r.verified_sha ?? '') ? r.verified_sha : null,
    state: RELEASE_STATES.has(r.state) ? r.state : 'unknown', step: RELEASE_HISTORY_STEPS.includes(r.step) ? r.step : null,
    steps: Array.isArray(r.steps) ? r.steps.filter((step) => FORWARD_STEPS.includes(step)) : [],
    history: (Array.isArray(r.history) ? r.history : []).filter((entry) => RELEASE_HISTORY_STEPS.includes(entry?.step))
      .map((entry) => ({ step: entry.step, outcome: entry.outcome === null || entry.outcome === undefined ? null : RELEASE_OUTCOMES.has(entry.outcome) ? entry.outcome : 'unknown' })),
    stepStartedAt: Number.isSafeInteger(r.step_started_at) ? r.step_started_at : null, updatedAt: r.updated_at }));
}

/**
 * Stop all releases (AUTO_RELEASE.md 4.5): whether `<dataDir>/RELEASE-STOP` is set, and since when. `set` is null when
 * the file cannot be read: a stop is never assumed absent, so unknown is never shown as off.
 */
export function releaseStopState(dataDir) {
  try { return { set: true, since: statSync(join(dataDir, RELEASE_STOP)).mtimeMs }; }
  catch (error) { return error?.code === 'ENOENT' ? { set: false, since: null } : { set: null, since: null }; }
}

/**
 * Stop all releases from the dashboard (slice UI15): the same file `supervisor release-stop` writes, and nothing else.
 * It needs no work record and no SQLite, so it works while they cannot be read. Narrowing is always allowed and needs
 * no approval (AUTO_RELEASE.md section 3); removing the file is the owner's, by hand, and no route does it.
 */
export function stopAllReleases(dataDir, input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['action', 'requestId'].includes(key)) ||
      input.action !== 'release-stop' || !/^[0-9a-f-]{36}$/i.test(input.requestId ?? '')) throw fail(400, 'Invalid dashboard command.');
  try { writeFileSync(join(dataDir, RELEASE_STOP), new Date(now).toISOString(), { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') return { accepted: true, duplicate: true, action: 'release-stop' };
    throw fail(503, 'AIWorks could not write the release stop on this computer. Run supervisor release-stop instead.', `RELEASE-STOP: ${code(error.code) ?? 'write failed'}`);
  }
  return { accepted: true, duplicate: false, action: 'release-stop' };
}

const DECISION_EVENTS = ['decision-answer', 'decision-snooze', 'decision-not-needed'];
const decisionFeedback = (store, campaignId) =>
  store.all(`SELECT kind, payload, received_at FROM events WHERE campaign_id = ? AND kind IN (${DECISION_EVENTS.map(() => '?').join(', ')}) ORDER BY seq`,
    campaignId, ...DECISION_EVENTS);

/**
 * A step's open decision (OWNER_UI_V2 WP2), or null. Its question, options, suggestion, what continues and what happens
 * unanswered are served only when they came from a validated worker result field, and each passes the credential filter;
 * a stop without them is a free-text decision (`structured: false`) answered in the owner's own words. `id` binds every
 * answer, snooze and "did not need me" to this one stop. The owner's own words are never served back.
 */
function decisionView(campaignId, task, feedback, now) {
  if (!isDecision(task)) return null;
  const id = decisionId(campaignId, task.task_id, task.blocked);
  const mine = feedback.filter((event) => event.payload?.taskId === task.task_id && event.payload?.decision === id);
  const d = structuredDecision({ decision: task.blocked.decision });
  const answer = mine.find((event) => event.kind === 'decision-answer');
  const until = Math.max(0, ...mine.filter((event) => event.kind === 'decision-snooze').map((event) => event.payload.until));
  return { id, structured: Boolean(d), question: d ? safeText(d.question, 500) : null,
    options: d ? d.options.map((o) => ({ id: o.id, label: safeText(o.label, 120), consequence: safeText(o.consequence, 500) })) : [],
    suggestion: d?.suggestion ? { option: d.suggestion.option, reason: safeText(d.suggestion.reason, 500) } : null,
    continues: d?.continues ? safeText(d.continues, 500) : null, unanswered: d?.unanswered ? safeText(d.unanswered, 500) : null,
    answered: answer ? { at: answer.received_at, option: answer.payload.option ?? null } : null,
    snoozedUntil: until > now ? until : null, notNeeded: mine.some((event) => event.kind === 'decision-not-needed') };
}

/**
 * Review of one step's result (OWNER_UI_V2 WP4), or null before any head was verified. Each acceptance criterion of the
 * step with what the independent verifier checked and saw, from the validated fields of its accepted verification of
 * exactly the verified head and report (result-review.mjs); a criterion it did not report is "not checked". The verdict
 * summary, findings and where the owner's eyes matter are bounded and pass the credential filter; never a raw log.
 * `canAccept` and `canRequestChanges` are the server's: applyResultReview checks every binding again. A local result is
 * accepted by Apply under its own rules, so it offers only Request changes here.
 */
export function resultReview(store, c, task, spec, config = {}) {
  const review = reviewOf(store, c, task, spec, config);
  // Whether Review offers a preview of this checked version (WP7), and why not when it does not.
  return review && { ...review, preview: previewSupport(task, spec, review) };
}

function reviewOf(store, c, task, spec, config) {
  if (!task?.verified_sha) return null;
  const local = isLocalTarget(c.declaration), commit = spec?.deliverable === 'commit';
  const limits = campaignLimits(c.declaration);
  const roundsLeft = limits.maxRepairRounds === null ? null : Math.max(0, limits.maxRepairRounds - task.repair_rounds);
  const base = { verifiedSha: task.verified_sha, local, commit, repairRounds: task.repair_rounds, roundsLeft, criteria: [], findings: [], eyesOn: [],
    unresolved: null, summary: null, reportDigest: null, acceptedAt: null, requestedAt: null, mergeGate: null, canAccept: false, canRequestChanges: false };
  if (task.state !== 'done') {
    // Reopened at the owner's request: the earlier result and its check stay in the record, and the new head is checked again.
    const reopened = (task.findings ?? []).find((finding) => finding?.id === OWNER_CHANGES);
    return reopened ? { ...base, state: 'changes-requested', from: reopened.verified, criterion: reopened.criterion ?? null, stalled: Boolean(task.blocked) } : null;
  }
  const v = verifiedReview(task);
  if (!v) return { ...base, state: 'no-evidence' };
  const requested = pendingChanges(store, c.id, task.task_id, task.verified_sha);
  const merged = !local && mergedHead(store, c.id, task.task_id, task.verified_sha);
  const accepted = store.get('SELECT received_at FROM events WHERE dedup_key = ?', `result-accepted:${c.id}:${task.task_id}:${task.verified_sha}`);
  const criteria = criterionEvidence(spec?.acceptance, v).map((item) => ({ criterion: item.criterion, text: safeText(item.text, 300), result: item.result,
    check: item.check === null ? null : safeText(item.check, 300), evidence: item.evidence === null ? null : safeText(item.evidence, 500) }));
  const unresolved = unresolvedOf(criteria, v), open = ['registered', 'finished'].includes(c.control), gate = mergeSettings(config);
  return { ...base, state: requested ? 'changes-requested' : merged ? 'merged' : accepted ? 'accepted' : 'ready', from: requested ? task.verified_sha : null,
    criterion: requested?.payload?.criterion ?? null, requestedAt: requested?.received_at ?? null, reportDigest: v.reportDigest,
    summary: safeText(v.verdictSummary ?? v.summary, 500), criteria, unresolved,
    findings: v.findings.slice(0, 30).map((f) => ({ id: safeText(f.id, 40), severity: f.severity === 'blocking' ? 'blocking' : 'non-blocking', description: safeText(f.description, 500) })),
    eyesOn: (Array.isArray(v.eyesOn) ? v.eyesOn : []).slice(0, 8).map((item) => safeText(item, 500)),
    acceptedAt: accepted?.received_at ?? null,
    mergeGate: local ? null : gate.enabled && gate.repositories.has(String(c.declaration.target.repository).toLowerCase()) ? 'on' : 'off',
    canAccept: open && !local && !requested && !merged && !accepted && !unresolved.failed && !unresolved.blocking,
    canRequestChanges: open && commit && !requested && !merged && roundsLeft !== 0 };
}

/**
 * A report the supervisor recorded in the local work list (controller.mjs recordLocalReview, AIWorks's own repository
 * with local main trusted): the step's published link names a work item, and that item holds the supervisor's comment
 * for exactly this campaign, step and report digest. Null otherwise: an `aiworks-work:` link alone is never taken as a
 * report, and a report is never a merge or an acceptance. { number, at } names the item and when the report was recorded.
 */
function localReport(store, campaignId, task, spec) {
  const number = /^aiworks-work:([1-9]\d{0,8})$/.exec(task.pr_url ?? '')?.[1];
  if (!number || task.state !== 'done' || spec?.deliverable !== 'report') return null;
  const digest = createHash('sha256').update(String(task.result?.report ?? ''), 'utf8').digest('hex');
  let row = null;
  try {
    row = store.get("SELECT created_at FROM work_item_comments WHERE item_number = ? AND idempotency_key = ? AND author_kind = 'supervisor'",
      Number(number), `${campaignId}:${task.task_id}:report:${digest}`);
  } catch { row = null; }
  return row ? { number: Number(number), at: row.created_at } : null;
}

function mergeReceipt(task, rows) {
  const row = rows.find(({ detail }) => detail?.task === task.task_id && detail.sha === task.verified_sha &&
    (detail.originalUrl ?? detail.url) === task.pr_url && /^[a-f0-9]{40}$/.test(detail.sha ?? '') &&
    /^[a-f0-9]{40}$/.test(detail.mergeCommit ?? '') &&
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(detail.url ?? ''));
  if (!row) return null;
  const d = row.detail;
  return { sha: d.sha, originalUrl: d.originalUrl ?? d.url, url: d.url, mergeCommit: d.mergeCommit,
    mergedAt: Number.isSafeInteger(d.mergedAt) ? d.mergedAt : row.at };
}

export function supervisorSnapshot(dataDir, now = Date.now(), { since } = {}) {
  const path = join(dataDir, 'supervisor.db');
  if (!existsSync(path)) return { available: false, message: 'No supervisor store at the configured location.', campaigns: [], costs: [], activity: [] };
  let store;
  try {
    store = new Store(path, { readOnly: true });
    store.db.exec('BEGIN');
    // The supervisor's config, so each step's wait names the same admission check the controller applies (scheduler on or off).
    const config = readConfig(dataDir);
    // Work in a project without GitHub has no repository, issue or pull request: its project screens show it from
    // work.mjs (workView `local`), never as a GitHub campaign here (OWNER_WORKSPACE S12).
    const campaigns = store.all("SELECT id FROM campaigns ORDER BY CASE WHEN control IN ('finished', 'cancelled') THEN 1 ELSE 0 END, created_at")
      .filter(({ id }) => !isLocalTarget(store.campaign(id).declaration)).map(({ id }) => {
      // Connections reads trusted main once; this per-campaign view does not use that field.
      const c = store.campaign(id), status = campaignStatus(store, id, now, { config, selfHostingConfig: null });
      const taskRows = store.tasks(id);
      const merged = store.all("SELECT at, detail FROM journal WHERE campaign_id = ? AND kind = 'merged' ORDER BY seq DESC", id);
      const feedback = decisionFeedback(store, id);
      const specs = new Map(c.declaration.tasks.map((task) => [task.id, task]));
      const operations = store.openOperations(id);
      const order = status.executorOrder;
      // Verifier rejections per task: a churn signal for the owner, not a limit. And when each commit passed the check:
      // the latest finished check that accepted it, by task and commit (a delegated merge that waits too long, #139).
      const rejections = new Map(), acceptedAt = new Map();
      for (const op of store.all("SELECT task_id, target_sha, outcome, updated_at FROM operations WHERE campaign_id = ? AND kind = 'verify' AND state = 'finished'", id)) {
        const verdict = op.outcome?.class === 'result' ? op.outcome.value?.verdict ?? op.outcome.value?.result : null;
        if (verdict === 'rejected') rejections.set(op.task_id, (rejections.get(op.task_id) ?? 0) + 1);
        const key = `${op.task_id}/${op.target_sha}`;
        if (verdict === 'accepted' && Number.isSafeInteger(op.updated_at)) acceptedAt.set(key, Math.max(acceptedAt.get(key) ?? 0, op.updated_at));
      }
      const histories = stepHistories(store, id);
      const costs = stepCosts(store, id);
      const paused = c.control === 'paused' ? store.get("SELECT at, detail FROM journal WHERE campaign_id = ? AND kind = 'paused' ORDER BY seq DESC LIMIT 1", id) : null;
      // Latest finished attempt per task: the worker's own verdict, not the protocol class alone.
      const lastOutcome = (taskId) => {
        const op = store.get("SELECT kind, executor_kind, outcome, updated_at FROM operations WHERE campaign_id = ? AND task_id = ? AND state = 'finished' ORDER BY created_at DESC LIMIT 1", id, taskId);
        if (!op?.outcome) return null;
        const terminal = op.outcome.class === 'result' ? op.outcome.value?.result ?? op.outcome.value?.verdict ?? null : null;
        return { role: op.kind === 'verify' ? 'Verifier' : 'Implementer', executor: code(op.executor_kind), at: op.updated_at,
          outcome: code(op.outcome.class), terminal: code(terminal), refunded: op.outcome.refunded === true,
          blockingFindings: op.outcome.class === 'result' && Array.isArray(op.outcome.value?.findings) ? op.outcome.value.findings.filter((f) => f?.severity === 'blocking').length : null,
          reason: op.outcome.class === 'unavailable' ? 'executor-unavailable' : op.outcome.class === 'result' ? null : code(op.outcome.class) };
      };
      return { id, version: c.version, authorizationVersion: c.authorization_version, scopeDigest: c.scope_digest,
        repository: c.declaration.target.repository, trackingUrl: `https://github.com/${c.declaration.target.repository}/issues/${c.declaration.target.trackingIssue}`,
        trackingIssue: c.declaration.target.trackingIssue, purpose: c.declaration.purpose ? safeText(c.declaration.purpose) : null,
        // Who paused it and when: the pause reason is owner/operator command text, never worker output.
        pausedAt: paused?.at ?? null, pausedReason: paused ? safeText(String(paused.detail?.reason ?? ''), 160) || null : null,
        control: c.control, status: status.status, readiness: status.readiness, controllerLive: status.controller.live,
        // When the campaign was registered: a campaign no supervisor has picked up yet gets a grace period from it.
        registeredAt: c.created_at,
        controllerRevision: status.controller.codeRevision, leaseExpiresAt: status.controller.leaseExpiresAt,
        nextWakeupAt: status.nextWakeupAt, blocker: code(c.blocker?.kind), livenessDefect: status.livenessDefect,
        // Why dispatch stopped, rebuilt from supervisor-known fields only (stored reasons can quote worker text).
        stopReasons: taskRows.filter((task) => task.blocked && task.state !== 'done').map((task) => `${task.task_id}: ${stopReason(task)}`),
        budget: status.budget,
        nextAction: publicNextAction(c, status, taskRows, operations), lastProgressAt: status.lastProgressAt,
        controllerState: status.readiness,
        waitingReason: status.phase === 'provider-wait' ? 'provider-availability' : null,
        // Budget and executor-selection text is deterministic; other blockers can contain native/worker errors.
        blockerClass: code(c.blocker?.class),
        blockerReason: c.blocker ? ['budget', 'executors'].includes(c.blocker.kind) ? safeText(String(c.blocker.reason ?? ''), 300) : `Recovery required: ${code(c.blocker.kind) ?? 'blocked'}` : null,
        blockerAction: c.blocker ? ['budget', 'executors'].includes(c.blocker.kind) ? safeText(String(c.blocker.requestedAction ?? ''), 300) : 'Inspect local supervisor status, resolve the recorded blocker, then recheck.' : null,
        controls: workControls(c.control),
        slots: campaignLimits(c.declaration).slots, phase: status.phase,
        runsUsed: status.runsUsed, maxWorkerRuns: status.maxWorkerRuns, recordedCostUsd: status.costUsd,
        // OWNER_WORKSPACE S7: today's totals, with unreported and running runs apart; null, never 0, when nothing reported a cost.
        cost: { reportedUsd: status.costUsd > 0 ? status.costUsd : null, unreportedRuns: status.budget.unknownCostRuns, runningRuns: operations.length },
        // MODEL_ROUTING R6 (UI12): the same work's cost in each unit apart, from status.
        costByUnit: costByUnit(status.costByUnit),
        executors: (c.declaration.executor.providers ?? [c.declaration.executor]).map((item) => code(item.kind)),
        providers: [...order, ...['codex-cli', 'claude-cli', 'cursor-cli'].filter((kind) => !order.includes(kind))].map((kind) => {
          const wait = status.executorWaits.find((item) => item.executor_kind === kind);
          const legacyWait = !wait && order.length === 1 ? taskRows.find((task) => task.retry_at > now && String(task.last_error ?? '').startsWith('quota:')) : null;
          return { kind, priority: order.includes(kind) ? order.indexOf(kind) + 1 : null,
            state: !order.includes(kind) ? 'not-configured' : operations.some((op) => (op.executor_kind ?? 'claude-cli') === kind) ? 'running'
              : wait ? wait.retry_at === null ? 'unavailable' : wait.retry_at > now ? 'cooldown' : 'retry-due' : legacyWait ? 'cooldown' : 'idle',
            reason: code(wait?.reason?.split(':')[0]) ?? (legacyWait ? 'quota' : null),
            availabilityReason: /extensions|configuration/.test(wait?.reason ?? '') ? 'Local CLI configuration needs adapter review'
              : /not configured/.test(wait?.reason ?? '') ? 'CLI command is not configured on this PC'
              : /absolute GitHub CLI/.test(wait?.reason ?? '') ? 'Repository reader requires a configured GitHub CLI'
              : /^web acceptance/.test(wait?.reason ?? '') ? 'The browser worker needs Chrome and chrome-devtools-mcp configured on this PC'
                : /sandbox is unavailable/.test(wait?.reason ?? '') ? 'Native sandbox is unavailable on this host'
                  : /sandbox setup failed|sandbox probe|could not start any local process/.test(wait?.reason ?? '') ? 'Codex sandbox could not start a local process (its runtime is locked by another Codex session on this host); retried automatically after the wait' : null,
            credits: /credits\/billing/.test(wait?.reason ?? ''), retryAt: wait?.retry_at ?? legacyWait?.retry_at ?? null,
            hostLimit: kind === 'cursor-cli' && process.platform === 'win32' ? 'Cursor native sandbox does not support Windows' : null,
            roleLimit: roleUnavailableReason({ kind }, 'implementer', 'commit') };
        }),
        instructions: store.all("SELECT * FROM events WHERE campaign_id = ? AND kind = 'agent-instruction' ORDER BY seq DESC LIMIT 30", id).map((event) => {
          const p = event.payload, task = taskRows.find((item) => item.task_id === p.taskId);
          return { id: event.seq, taskId: p.taskId, role: p.role, text: safeText(p.text, 2000), at: event.received_at,
            status: p.delivery ? 'attached' : p.authorizationVersion !== c.authorization_version || p.scopeDigest !== c.scope_digest ? 'outdated'
              : ['done', 'verified'].includes(task?.state) || ['cancelled', 'cancel-requested', 'finished'].includes(c.control) ? 'undelivered' : 'queued',
            operationId: p.delivery?.operationId ?? null, attachedAt: p.delivery?.at ?? null,
            // Who read it: the worker whose prompt carried it, and how that worker's run ended.
            ...(() => {
              const op = p.delivery?.operationId ? store.get('SELECT executor_kind, state, outcome FROM operations WHERE id = ?', p.delivery.operationId) : null;
              return { executor: code(op?.executor_kind), runState: code(op?.state),
                runOutcome: code(op?.outcome?.class === 'result' ? op.outcome.value?.result ?? op.outcome.value?.verdict : op?.outcome?.class) };
            })() };
        }),
        tasks: taskRows.map((task) => ({ id: task.task_id, title: safeText(specs.get(task.task_id)?.title),
          decision: decisionView(id, task, feedback, now),
          review: resultReview(store, c, task, specs.get(task.task_id), config),
           mergeReceipt: mergeReceipt(task, merged),
          localReport: localReport(store, id, task, specs.get(task.task_id)),
          outcome: specs.get(task.task_id)?.outcome ? safeText(specs.get(task.task_id).outcome) : null,
          deliverable: code(specs.get(task.task_id)?.deliverable), verifierRejections: rejections.get(task.task_id) ?? 0,
          version: task.version, issueUrl: `https://github.com/${c.declaration.target.repository}/issues/${specs.get(task.task_id)?.issue}`,
          state: task.state, attempts: task.attempts, repairRounds: task.repair_rounds,
          waitingReason: publicTaskWait(task, specs.get(task.task_id)),
          requiresMergedDependencies: specs.get(task.task_id)?.requiresMergedDependencies === true,
          blocked: code(task.blocked?.class), blockedReason: task.blocked ? stopReason(task) : null,
          errorClass: code(String(task.last_error ?? '').split(':')[0]),
          retryAt: task.retry_at, dependsOn: specs.get(task.task_id)?.dependsOn ?? [], resultUrl: githubLink(task.pr_url),
          headSha: task.head_sha, verifiedSha: task.verified_sha, lastOutcome: lastOutcome(task.task_id),
          // When the verified commit passed the check. Without a recorded check run, when the step last changed, which is
          // never earlier, so a wait is never overstated.
          verifiedAt: task.verified_sha ? acceptedAt.get(`${task.task_id}/${task.verified_sha}`) ?? task.updated_at : null,
          // Why it waits, from status (UI11); a stop in §7.7 words and its own attempts and events (OWNER_WORKSPACE S5).
          wait: stepWait(task, status.tasks.find((item) => item.id === task.task_id)?.wait, c.control),
          stopped: stepStopped(task, safeText(specs.get(task.task_id)?.outcome ?? specs.get(task.task_id)?.title ?? task.task_id),
            `https://github.com/${c.declaration.target.repository}/issues/${specs.get(task.task_id)?.issue}`),
          history: histories.get(task.task_id) ?? { attempts: [], events: [] },
          // OWNER_WORKSPACE S7: its runs and the cost they reported; null, never 0, when none reported one.
          cost: (({ reportedUsd, ...rest }) => ({ ...rest, reportedUsd: reportedUsd > 0 ? reportedUsd : null, checkerRejections: rejections.get(task.task_id) ?? 0 }))(
            costs.get(task.task_id) ?? { runs: 0, reportedUsd: 0, unreportedRuns: 0, runningRuns: 0, retries: 0 }),
          // MODEL_ROUTING R6 (UI12): its models and tiers, why it moved up, and its cost in each unit apart, from status.
          routing: stepRouting(status.tasks.find((item) => item.id === task.task_id)),
          costByUnit: costByUnit(status.tasks.find((item) => item.id === task.task_id)?.costByUnit),
          // SCOPED_READING (UI18): the rule a returned change broke and what the next attempt was given; null before READ3.
          reading: stepReading(store, id, task.task_id, status.tasks.find((item) => item.id === task.task_id)?.reading) })),
        agents: operations.map((op) => {
          const beat = heartbeat(dataDir, op.run_dir);
          return { id: op.id, taskId: op.task_id, role: op.kind === 'verify' ? 'Verifier' : 'Implementer',
            executor: code(op.executor_kind) ?? (c.declaration.executor.kind === 'cli-chain' ? 'unknown' : code(c.declaration.executor.kind)),
            state: op.state, startedAt: op.created_at, heartbeatAt: beat, outputAt: outputAt(dataDir, op.run_dir),
            heartbeatState: beat === null ? 'unknown' : now - beat < 90_000 ? 'recent' : 'stale',
            progress: workerProgress(dataDir, op) };
        }) };
    });
    const activity = store.all("SELECT seq, campaign_id, at, kind, detail FROM journal WHERE kind NOT IN ('event-dashboard-command', 'lease-acquired') ORDER BY seq DESC LIMIT 80").map((item) =>
      publicEvent(item, typeof item.detail?.op === 'string' ? store.get('SELECT * FROM operations WHERE id = ?', item.detail.op) : null));
    const recent = recentEvents(store, since, now);
    const releases = recordedReleases(store);
    const goals = goalControls(store);
    // aiworks#18: a stopped supervisor, with its last lease renewal, for the owner view to lead with.
    const controller = supervisorLiveness(store, { now, leaseMs: readConfig(dataDir).leaseMs ?? DEFAULTS.leaseMs, stopRequested: existsSync(join(dataDir, 'STOP')) });
    store.db.exec('COMMIT');
    const view = coordinatorView(store, readConfig(dataDir), now);
    // `reading`: the request reader holds a live lease, so a waiting request is known to be picked up (aiworks#11 review 4 F12).
    const reading = Boolean(store.get('SELECT 1 AS live FROM leases WHERE campaign_id = ? AND expires_at > ?', COORDINATOR_LANE, now));
    const coordinator = { configured: view.configured, configError: view.configError ? safeText(view.configError, 300) : null, reading,
      blocked: view.blocked ? safeText(view.blocked, 300) : null, reportTo: view.reportTo ?? null, runsToday: view.runsToday ?? 0, maxRunsPerDay: view.maxRunsPerDay ?? null,
      messages: view.messages.map((m) => ({ id: m.id, text: safeText(m.text, 4000), source: safeText(m.source, 80), state: code(m.state),
        receivedAt: m.receivedAt, readAt: m.readAt, answeredAt: m.answeredAt, failure: code(m.failure), retryAt: m.retryAt, attempts: m.attempts,
        repository: m.repository, replyBody: m.replyBody ? safeText(m.replyBody, 61000) : null,
        replyState: code(m.replyState), replyUrl: githubLink(m.replyUrl),
        progress: m.state === 'read' ? (() => {
          const run = view.runs.find((item) => item.id === m.runId);
          return run ? workerProgress(dataDir, { executor_kind: 'claude-cli', workspace: run.workspace, session_id: run.session_id, run_dir: run.run_dir }) : null;
        })() : null })) };
    const settings = computerSettings(campaigns, readConfig(dataDir), { now, repositories: configuredRepositories(dataDir),
      connected: projectConnectionEnabled(dataDir) ? connectedProjects(dataDir) : [],
      accounts: dashboardAccounts(store, readConfig(dataDir), { now, dataDir }), releaseStop: releaseStopState(dataDir) });
    return { available: true, observedAt: new Date(now).toISOString(), controller, campaigns, costs: projectCosts(campaigns), activity, coordinator, recent, settings, releases, goals,
      newestEvent: store.get('SELECT MAX(seq) AS seq FROM journal')?.seq ?? 0 };
  } catch { return { available: false, message: "AIWorks can't read its work records right now. What you see may be out of date. Buttons are off until it can read them again.", campaigns: [], costs: [], activity: [] }; }
  finally { store?.close(); }
}

// Start work: Plan only (OWNER_WORKSPACE §4.5, slice S9; build slice UI10). The page sends the parts and this module
// writes the coordinator message, so every Plan only request has the same structure and the same read-only limits. It
// goes through the owner-message path above: it stores one message and nothing else. It never registers, starts or
// changes work and never touches a project's files. "Plan and do" waits for the admission API (#8) and slice S10.
export const PLAN_GOAL_LIMIT = 2000;
export const PLAN_SOURCES = Object.freeze({ description: 'Just my description', issue: 'A GitHub issue', pull: 'A GitHub pull request' });
const PLAN_AND_DO_OFF = 'Plan and do is not built yet. Today, work starts when an authorized private plan is registered on this computer.';

/** The coordinator message for a checked Plan only request: project, where it starts from, the goal and the limits. */
export function planRequestText({ project, goal, from, number }) {
  const source = from === 'issue' ? `GitHub issue #${number} (https://github.com/${project}/issues/${number})`
    : from === 'pull' ? `GitHub pull request #${number} (https://github.com/${project}/pull/${number})` : 'my description below';
  return [
    'Start work: Plan only, sent from the dashboard.',
    `Project: ${project}`,
    `Start from: ${source}`,
    'Goal (what should be true when this is finished):',
    goal,
    '',
    'Reply with a proposed plan: how success is checked, the main steps in order with the result of each, and any earlier or overlapping work in this project.',
    'This is Plan only. Change no file, register or start no work, and open, edit or comment on no issue or pull request.',
  ].join('\n');
}

/** Checks a Plan only request against the projects this computer knows; returns the parts with the project as known. */
function planRequest(store, dataDir, plan) {
  const invalid = (message) => fail(400, message);
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).some((key) => !['mode', 'project', 'goal', 'from', 'number'].includes(key))) {
    throw invalid('Invalid plan request.');
  }
  if (plan.mode === 'plan-and-do') throw fail(409, PLAN_AND_DO_OFF);
  if (plan.mode !== 'plan-only') throw invalid('Invalid plan request.');
  const known = [...configuredRepositories(dataDir), ...store.all('SELECT id FROM campaigns').map(({ id }) => store.campaign(id).declaration.target.repository)].filter((name) => typeof name === 'string');
  const project = typeof plan.project === 'string' ? known.find((name) => name.toLowerCase() === plan.project.toLowerCase()) : undefined;
  if (!project) throw invalid('That project is not known on this computer.');
  const goal = typeof plan.goal === 'string' ? plan.goal.trim() : '';
  if (!goal || goal.length > PLAN_GOAL_LIMIT) throw invalid(`Describe the goal in 1 to ${PLAN_GOAL_LIMIT.toLocaleString('en-US')} characters.`);
  if (safeText(goal, PLAN_GOAL_LIMIT) !== goal) throw invalid('The goal looks like it contains a secret. Remove it and send again.');
  if (!Object.hasOwn(PLAN_SOURCES, plan.from)) throw invalid('Choose where the work starts from.');
  if (plan.from === 'description' ? plan.number !== undefined : !(Number.isSafeInteger(plan.number) && plan.number > 0)) {
    throw invalid(plan.from === 'description' ? 'Invalid plan request.' : `Give the ${plan.from === 'issue' ? 'issue' : 'pull request'} number.`);
  }
  return { project, goal, from: plan.from, number: plan.number };
}

/**
 * Owner message to the coordinator. Returns the durable receipt; exact retries are acknowledged, not duplicated.
 * `input` is { requestId, text } for a free message, or { requestId, plan } for Start work: Plan only (slice S9).
 */
export function postMessage(dataDir, input, now = Date.now()) {
  const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : null;
  const isPlan = keys?.includes('plan') && !keys.includes('text');
  if (!keys || keys.some((key) => !['requestId', isPlan ? 'plan' : 'text'].includes(key)) ||
      (!isPlan && (typeof input.text !== 'string' || safeText(input.text, 4000) !== input.text))) {
    throw fail(400, 'Invalid message. Up to 4,000 characters, no secrets.');
  }
  if (!existsSync(join(dataDir, 'supervisor.db'))) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  const store = new Store(join(dataDir, 'supervisor.db'));
  try {
    const plan = isPlan ? planRequest(store, dataDir, input.plan) : null;
    const text = plan ? planRequestText(plan) : input.text;
    return postOwnerMessage(store, { text, repository: plan?.project ?? null, requestId: input.requestId,
      source: isPlan ? 'owner (Start work: Plan only)' : 'owner (dashboard)' }, now);
  } catch (error) {
    if (error.code === 'INVALID_MESSAGE') throw fail(400, error.message);
    if (error.code === 'CONFLICT') throw fail(409, error.message);
    throw error;
  } finally { store.close(); }
}

/**
 * AW-005 for a Resume (UI19, LOCAL_OPERATION.md section 4.3): the code this dashboard runs must be an ancestor of the
 * trusted main, origin/main or, with config.json `selfHosting.trustedMain` "local", the trusted tip of the main ledger.
 * Read-only: it never fetches. Throws the owner's refusal, with the machine's reason as its detail.
 */
function resumeAllowed(dataDir, store, provenanceRoot) {
  const notMerged = revisionNotMerged({ root: provenanceRoot, trust: runtimeTrust(readConfig(dataDir), store) });
  if (notMerged) throw fail(409, COMMANDS.resumeRefused, `Resume refused: ${notMerged}`);
}

// provenanceRoot: the checkout whose origin/main a Resume is checked against (AW-005). The dashboard's own entry point never
// passes it, so it is always this dashboard's own checkout; only the tests point a server or a call at another repository.
export function applyCommand(dataDir, input, now = Date.now(), { provenanceRoot = CODE_ROOT } = {}) {
  // Stop all releases is no campaign's command: it reaches RELEASE-STOP only.
  if (input?.action === 'release-stop') return stopAllReleases(dataDir, input, now);
  const allowed = ['campaignId', 'action', 'taskId', 'taskVersion', 'version', 'authorizationVersion', 'scopeDigest', 'requestId', 'text', 'role'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key)) ||
      !identifier.test(input.campaignId ?? '') || !['pause', 'resume', 'recheck', 'cancel', 'instruct'].includes(input.action) ||
      !/^[0-9a-f-]{36}$/i.test(input.requestId ?? '') || !Number.isSafeInteger(input.version) || input.version < 1 ||
      !Number.isSafeInteger(input.authorizationVersion) || !/^[a-f0-9]{64}$/.test(input.scopeDigest ?? '') ||
      input.taskId !== undefined && (!identifier.test(input.taskId) || !['recheck', 'instruct'].includes(input.action) || !Number.isSafeInteger(input.taskVersion)) ||
      input.action === 'instruct' && (!input.taskId || !['implement', 'verify'].includes(input.role) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)) ||
      input.action !== 'instruct' && (input.text !== undefined || input.role !== undefined)) {
    throw fail(400, 'Invalid dashboard command.');
  }
  // The same credential filter as before, refused with its own reason so the owner knows what to change (aiworks#61).
  if (input.action === 'instruct' && safeText(input.text, 2000) !== input.text) {
    throw Object.assign(fail(400, INSTRUCTION_LOOKS_SENSITIVE), { code: 'INSTRUCTION_LOOKS_SENSITIVE' });
  }
  if (!existsSync(join(dataDir, 'supervisor.db'))) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  const store = new Store(join(dataDir, 'supervisor.db'));
  try {
    // Private Resume uses the registered declaration; executable code must still be merged.
    const before = input.action === 'resume' ? store.campaign(input.campaignId) : null;
    if (before?.control === 'paused') resumeAllowed(dataDir, store, provenanceRoot);
    return store.tx(() => {
      const id = input.campaignId;
      const c = store.campaign(id);
      if (!c) throw fail(404, COMMANDS.notFound);
      const payload = { campaignId: id, action: input.action, taskId: input.taskId ?? null, taskVersion: input.taskVersion ?? null,
        version: input.version, authorizationVersion: input.authorizationVersion, scopeDigest: input.scopeDigest,
        ...(input.action === 'instruct' ? { text: input.text, role: input.role } : {}) };
      const dedup = `dashboard:${input.requestId}`;
      const previous = store.get('SELECT payload FROM events WHERE dedup_key = ?', dedup);
      if (previous) {
        if (JSON.stringify(previous.payload) !== JSON.stringify(payload)) throw fail(409, 'That command identifier was already used for a different request.');
        return { accepted: true, duplicate: true, action: input.action };
      }
      if (c.version !== input.version || c.authorization_version !== input.authorizationVersion || c.scope_digest !== input.scopeDigest) {
        throw fail(409, 'Work changed since this view was loaded. Refresh and try again.');
      }
      if (!['registered', 'paused'].includes(c.control)) throw fail(409, COMMANDS.closed);
      if (input.taskId) {
        const task = store.task(id, input.taskId);
        if (!task || task.version !== input.taskVersion || task.state === 'done') throw fail(409, COMMANDS.stepChanged);
        if (input.action === 'instruct' && task.state === 'verified') throw fail(409, COMMANDS.noNextRun);
      }
      if (input.action === 'resume') {
        if (c.control !== 'paused') throw fail(409, COMMANDS.notPaused);
        if (c.version !== before?.version) throw fail(409, 'Work changed since this view was loaded. Refresh and try again.');
        campaignStart(store, c.declaration, now);
      } else if (input.action === 'instruct') {
        if (pendingInstructions(store, c, input.taskId).length >= 5) throw fail(409, 'This task already has five queued instructions. Wait for its next worker.');
        store.addEvent(id, 'agent-instruction', { taskId: input.taskId, role: input.role, text: input.text,
          authorizationVersion: c.authorization_version, scopeDigest: c.scope_digest }, `instruction:${input.requestId}`, now);
      } else if (input.action === 'pause') campaignPause(store, id, 'Owner command from local dashboard', now);
      else if (input.action === 'cancel') campaignCancel(store, id, 'Owner command from local dashboard', now);
      else campaignRecheck(store, id, { task: input.taskId ?? null, note: 'Owner recheck from local dashboard' }, now);
      store.addEvent(id, 'dashboard-command', payload, dedup, now);
      store.journal(id, 'dashboard-command', { action: input.action, task: input.taskId ?? null, requestId: input.requestId }, now);
      return { accepted: true, duplicate: false, action: input.action };
    });
  } finally { store.close(); }
}

const PAUSE_SCOPES = ['all', 'project', 'goal'];
const SCOPE_REASON = { all: 'Owner paused all work from the local dashboard', project: 'Owner paused this project from the local dashboard',
  goal: 'Owner paused this goal from the local dashboard' };

/**
 * Pause or resume all work, one project's or one goal (OWNER_UI_V2 WP1), through the same version-bound control as a
 * single goal's Pause and Resume. `input` is { requestId, action: 'pause' | 'resume', scope: 'all' | 'project' | 'goal',
 * project?, campaignId?, goals: [{ campaignId, version, authorizationVersion, scopeDigest }] }. `goals` must be exactly
 * the goals the scope covers now, each at the version the page showed: a pause binds every running goal of the scope; a
 * resume only the goals that this very scope paused (for a goal: that goal), so it never resumes work paused for
 * another reason. Anything else changed refuses the whole request with nothing written. Resume first passes the AW-005
 * check against the trusted main. Runs already started finish and are recorded; nothing new is dispatched.
 */
export function applyScopedControl(dataDir, input, now = Date.now(), { provenanceRoot = CODE_ROOT } = {}) {
  const goalKeys = ['campaignId', 'version', 'authorizationVersion', 'scopeDigest'];
  const validGoal = (goal) => goal && typeof goal === 'object' && !Array.isArray(goal) && Object.keys(goal).every((key) => goalKeys.includes(key)) &&
    identifier.test(goal.campaignId ?? '') && Number.isSafeInteger(goal.version) && goal.version >= 1 && Number.isSafeInteger(goal.authorizationVersion) &&
    /^[a-f0-9]{64}$/.test(goal.scopeDigest ?? '');
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['requestId', 'action', 'scope', 'project', 'campaignId', 'goals'].includes(key)) ||
      !/^[0-9a-f-]{36}$/i.test(input.requestId ?? '') || !['pause', 'resume'].includes(input.action) || !PAUSE_SCOPES.includes(input.scope) ||
      (input.scope === 'project') !== PROJECT.test(input.project ?? '') ||
      (input.scope === 'goal') !== identifier.test(input.campaignId ?? '') ||
      !Array.isArray(input.goals) || input.goals.length > 200 || !input.goals.every(validGoal) ||
      new Set(input.goals.map((goal) => goal.campaignId)).size !== input.goals.length) {
    throw fail(400, 'Invalid dashboard command.');
  }
  if (!existsSync(join(dataDir, 'supervisor.db'))) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  const scope = input.scope === 'all' ? { kind: 'all' } : input.scope === 'project' ? { kind: 'project', project: input.project } : { kind: 'goal' };
  const store = new Store(join(dataDir, 'supervisor.db'));
  try {
    const payload = { action: input.action, scope, campaignId: input.campaignId ?? null,
      goals: [...input.goals].sort((a, b) => a.campaignId.localeCompare(b.campaignId)).map((goal) => goalKeys.map((key) => goal[key])) };
    const dedup = `dashboard:${input.requestId}`;
    const replay = () => {
      const previous = store.get('SELECT payload FROM events WHERE dedup_key = ?', dedup);
      if (!previous) return null;
      if (JSON.stringify(previous.payload) !== JSON.stringify(payload)) throw fail(409, 'That command identifier was already used for a different request.');
      return { accepted: true, duplicate: true, action: input.action, scope: input.scope, goals: input.goals.length };
    };
    const earlier = replay();
    if (earlier) return earlier;
    // AW-005 before anything is written: a resume from code the trusted main does not contain changes nothing.
    if (input.action === 'resume') resumeAllowed(dataDir, store, provenanceRoot);
    return store.tx(() => {
      const again = replay();
      if (again) return again;
      const goals = goalControls(store).filter((goal) => input.scope === 'goal' ? goal.id === input.campaignId
        : input.scope === 'all' || sameProject(goal.project, input.project));
      const summary = pauseSummary(goals, scope);
      const expected = input.action === 'pause' ? summary.pause : summary.resume;
      const bound = new Map(input.goals.map((goal) => [goal.campaignId, goal]));
      if (!expected.length) throw fail(409, input.action === 'pause' ? COMMANDS.nothingToPause : COMMANDS.nothingToResume);
      if (expected.length !== bound.size || expected.some((goal) => goalKeys.some((key) => bound.get(goal.campaignId)?.[key] !== goal[key]))) {
        throw fail(409, 'Work changed since this view was loaded. Refresh and try again.');
      }
      for (const goal of expected) {
        if (input.action === 'pause') campaignPause(store, goal.campaignId, SCOPE_REASON[scope.kind], now, { scope });
        else campaignStart(store, store.campaign(goal.campaignId).declaration, now);
      }
      // One receipt for the request, kept with the first goal it covers, and an audit line on each goal.
      store.addEvent(expected[0].campaignId, 'dashboard-command', payload, dedup, now);
      for (const goal of expected) store.journal(goal.campaignId, 'dashboard-command', { action: input.action, scope: scope.kind, requestId: input.requestId }, now);
      return { accepted: true, duplicate: false, action: input.action, scope: input.scope, goals: expected.length };
    });
  } finally { store.close(); }
}

const SNOOZE = { '1h': 3_600_000, '4h': 4 * 3_600_000, '1d': 86_400_000 };
const DECISION_KEYS = ['requestId', 'campaignId', 'taskId', 'taskVersion', 'version', 'authorizationVersion', 'scopeDigest', 'decision', 'option', 'text', 'snooze'];

/**
 * Answer, snooze or "this did not need me" on one decision (OWNER_UI_V2 WP2; `action` comes from the address). The
 * request binds the goal's version, authorization and scope, the step's version and the decision's id, so a stale,
 * wrong-step or replayed request changes nothing. An answer is recorded once per decision: the controller then clears
 * exactly that stop and gives the step's next worker the answer as guidance under the same packet, so it can never widen
 * the work, clear another blocker or start a second run. A wider change goes through a new plan approval. Snooze and
 * "did not need me" are feedback only: the step stays stopped until it is answered.
 */
export function applyDecision(dataDir, action, input, now = Date.now()) {
  if (!['answer', 'snooze', 'not-needed'].includes(action) || !input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !DECISION_KEYS.includes(key)) || !/^[0-9a-f-]{36}$/i.test(input.requestId ?? '') ||
      !identifier.test(input.campaignId ?? '') || !identifier.test(input.taskId ?? '') || !Number.isSafeInteger(input.taskVersion) ||
      !Number.isSafeInteger(input.version) || input.version < 1 || !Number.isSafeInteger(input.authorizationVersion) ||
      !/^[a-f0-9]{64}$/.test(input.scopeDigest ?? '') || !/^[a-f0-9]{32}$/.test(input.decision ?? '') ||
      input.option !== undefined && (action !== 'answer' || !/^[a-z][a-z0-9-]{0,31}$/.test(input.option)) ||
      input.text !== undefined && (action === 'snooze' || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)) ||
      (input.snooze !== undefined) !== (action === 'snooze') || action === 'snooze' && !Object.hasOwn(SNOOZE, input.snooze) ||
      action === 'answer' && input.option === undefined && input.text === undefined) {
    throw fail(400, 'Invalid dashboard command.');
  }
  if (input.text !== undefined && safeText(input.text, 2000) !== input.text) {
    throw Object.assign(fail(400, INSTRUCTION_LOOKS_SENSITIVE), { code: 'INSTRUCTION_LOOKS_SENSITIVE' });
  }
  if (!existsSync(join(dataDir, 'supervisor.db'))) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  const store = new Store(join(dataDir, 'supervisor.db'));
  try {
    return store.tx(() => {
      const id = input.campaignId;
      const payload = { taskId: input.taskId, decision: input.decision, action, taskVersion: input.taskVersion, version: input.version,
        authorizationVersion: input.authorizationVersion, scopeDigest: input.scopeDigest, option: input.option ?? null,
        // The receipt binds the owner's words by digest: they are kept once, in the decision's own event.
        text: input.text === undefined ? null : createHash('sha256').update(input.text, 'utf8').digest('hex'), snooze: input.snooze ?? null };
      const dedup = `dashboard:${input.requestId}`;
      const previous = store.get('SELECT campaign_id, payload FROM events WHERE dedup_key = ?', dedup);
      if (previous) {
        if (previous.campaign_id !== id || JSON.stringify(previous.payload) !== JSON.stringify(payload)) throw fail(409, 'That command identifier was already used for a different request.');
        return { accepted: true, duplicate: true, action };
      }
      const c = store.campaign(id);
      if (!c) throw fail(404, COMMANDS.notFound);
      if (c.version !== input.version || c.authorization_version !== input.authorizationVersion || c.scope_digest !== input.scopeDigest) {
        throw fail(409, 'Work changed since this view was loaded. Refresh and try again.');
      }
      if (!['registered', 'paused'].includes(c.control)) throw fail(409, COMMANDS.closed);
      const task = store.task(id, input.taskId);
      if (!task || task.version !== input.taskVersion || !isDecision(task) || decisionId(id, task.task_id, task.blocked) !== input.decision) {
        throw fail(409, COMMANDS.decision.stale);
      }
      const answered = `decision-answer:${id}:${input.decision}`;
      if (store.get('SELECT 1 FROM events WHERE dedup_key = ?', answered)) throw fail(409, COMMANDS.decision.answered);
      const event = { taskId: input.taskId, decision: input.decision, requestId: input.requestId };
      if (action === 'answer') {
        const d = structuredDecision({ decision: task.blocked.decision });
        if (input.option !== undefined && !d?.options.some((o) => o.id === input.option)) throw fail(400, COMMANDS.decision.notOption);
        store.addEvent(id, 'decision-answer', { ...event, option: input.option ?? null, text: input.text ?? null,
          authorizationVersion: c.authorization_version, scopeDigest: c.scope_digest }, answered, now);
      } else if (action === 'snooze') {
        store.addEvent(id, 'decision-snooze', { ...event, until: now + SNOOZE[input.snooze] }, null, now);
      } else {
        if (!store.addEvent(id, 'decision-not-needed', { ...event, text: input.text ?? null }, `decision-not-needed:${id}:${input.decision}`, now)) {
          throw fail(409, COMMANDS.decision.noted);
        }
      }
      store.addEvent(id, 'dashboard-command', payload, dedup, now);
      store.journal(id, 'dashboard-command', { action: `decision-${action}`, task: input.taskId, requestId: input.requestId }, now);
      return { accepted: true, duplicate: false, action, ...(action === 'snooze' ? { until: now + SNOOZE[input.snooze] } : {}) };
    });
  } finally { store.close(); }
}

const RESULT_KEYS = ['requestId', 'campaignId', 'taskId', 'taskVersion', 'version', 'authorizationVersion', 'scopeDigest', 'verifiedSha', 'reportDigest', 'text', 'criterion'];

/**
 * Accept a result or request changes to it (OWNER_UI_V2 WP4; `action` comes from the address). The request binds the
 * goal's version, authorization and scope, the step's version, its verified head and the digest of the report that head
 * was checked with, so a changed, unverified, stale or replayed request changes nothing.
 *
 * Accept records the owner's acceptance of exactly that head: it never merges, pushes or reads GitHub. A GitHub result
 * merges only through the supervisor's merge gate, in a repository the owner opted in, or under the project's own gate;
 * a result with a failed criterion or a blocking finding is not accepted. A local result is accepted by Apply.
 *
 * Request changes records the owner's words once per verified head. The controller then reopens the finished step as a
 * bounded repair round on its own branch (Controller.requestedChanges): earlier runs and checks stay, the merge gate
 * holds that head meanwhile, and only a fresh independent verification of the new head is published.
 */
export function applyResultReview(dataDir, action, input, now = Date.now(), { config = readConfig(dataDir) } = {}) {
  const changes = action === 'request-changes';
  if (!['accept', 'request-changes'].includes(action) || !input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !RESULT_KEYS.includes(key)) || !/^[0-9a-f-]{36}$/i.test(input.requestId ?? '') ||
      !identifier.test(input.campaignId ?? '') || !identifier.test(input.taskId ?? '') || !Number.isSafeInteger(input.taskVersion) ||
      !Number.isSafeInteger(input.version) || input.version < 1 || !Number.isSafeInteger(input.authorizationVersion) ||
      !/^[a-f0-9]{64}$/.test(input.scopeDigest ?? '') || !/^[0-9a-f]{40}$/.test(input.verifiedSha ?? '') || !/^[0-9a-f]{64}$/.test(input.reportDigest ?? '') ||
      (input.text !== undefined) !== changes || changes && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_FEEDBACK ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)) ||
      input.criterion !== undefined && (!changes || !Number.isSafeInteger(input.criterion) || input.criterion < 1 || input.criterion > 16)) {
    throw fail(400, 'Invalid dashboard command.');
  }
  if (changes && safeText(input.text, MAX_FEEDBACK) !== input.text) {
    throw Object.assign(fail(400, INSTRUCTION_LOOKS_SENSITIVE), { code: 'INSTRUCTION_LOOKS_SENSITIVE' });
  }
  if (!existsSync(join(dataDir, 'supervisor.db'))) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  const store = new Store(join(dataDir, 'supervisor.db'));
  try {
    return store.tx(() => {
      const id = input.campaignId, sha = input.verifiedSha;
      const payload = { taskId: input.taskId, action, taskVersion: input.taskVersion, version: input.version, authorizationVersion: input.authorizationVersion,
        scopeDigest: input.scopeDigest, verifiedSha: sha, reportDigest: input.reportDigest, criterion: input.criterion ?? null,
        // The receipt binds the owner's words by digest: they are kept once, in the request's own event.
        text: input.text === undefined ? null : createHash('sha256').update(input.text, 'utf8').digest('hex') };
      const dedup = `dashboard:${input.requestId}`;
      const previous = store.get('SELECT campaign_id, payload FROM events WHERE dedup_key = ?', dedup);
      if (previous) {
        if (previous.campaign_id !== id || JSON.stringify(previous.payload) !== JSON.stringify(payload)) throw fail(409, 'That command identifier was already used for a different request.');
        return { accepted: true, duplicate: true, action };
      }
      const c = store.campaign(id);
      if (!c) throw fail(404, COMMANDS.notFound);
      if (c.version !== input.version || c.authorization_version !== input.authorizationVersion || c.scope_digest !== input.scopeDigest) {
        throw fail(409, 'Work changed since this view was loaded. Refresh and try again.');
      }
      if (!['registered', 'finished'].includes(c.control)) throw fail(409, COMMANDS.result.closed);
      const task = store.task(id, input.taskId);
      const spec = c.declaration.tasks.find((item) => item.id === input.taskId);
      if (!task || task.version !== input.taskVersion) throw fail(409, COMMANDS.result.changed);
      const review = resultReview(store, c, task, spec, config);
      // Exactly the head that passed the independent check, with the report it was checked with: never a newer or older one.
      if (!review || review.verifiedSha !== sha || review.reportDigest !== input.reportDigest || !['ready', 'accepted', 'changes-requested', 'merged'].includes(review.state)) {
        throw fail(409, COMMANDS.result.changed);
      }
      if (review.state === 'changes-requested') throw fail(409, COMMANDS.result.requested);
      if (review.state === 'merged') throw fail(409, COMMANDS.result.merged);
      if (changes) {
        if (!review.commit) throw fail(409, COMMANDS.result.reportOnly);
        if (review.roundsLeft === 0) throw fail(409, COMMANDS.result.noRounds);
        if (!store.addEvent(id, 'result-changes', { taskId: task.task_id, verifiedSha: sha, reportDigest: input.reportDigest, criterion: input.criterion ?? null,
          text: input.text, authorizationVersion: c.authorization_version, scopeDigest: c.scope_digest, requestId: input.requestId },
        `result-changes:${id}:${task.task_id}:${sha}`, now)) throw fail(409, COMMANDS.result.requested);
      } else {
        if (review.local) throw fail(409, COMMANDS.result.applyLocal);
        if (review.state === 'accepted') throw fail(409, COMMANDS.result.alreadyAccepted);
        if (review.unresolved.failed || review.unresolved.blocking) throw fail(409, COMMANDS.result.unresolved);
        // A record only, handled here: the controller has nothing to do for it, and the merge gate keeps its own conditions.
        store.addEvent(id, 'result-accepted', { taskId: task.task_id, verifiedSha: sha, reportDigest: input.reportDigest, requestId: input.requestId },
          `result-accepted:${id}:${task.task_id}:${sha}`, now);
        store.run('UPDATE events SET processed_at = ? WHERE dedup_key = ?', now, `result-accepted:${id}:${task.task_id}:${sha}`);
        store.journal(id, 'result-accepted', { task: task.task_id, sha, reportDigest: input.reportDigest }, now);
      }
      store.addEvent(id, 'dashboard-command', payload, dedup, now);
      store.journal(id, 'dashboard-command', { action: `result-${action}`, task: input.taskId, requestId: input.requestId }, now);
      return { accepted: true, duplicate: false, action, mergeGate: review.mergeGate };
    });
  } finally { store.close(); }
}

const PREVIEW_KEYS = ['campaignId', 'taskId', 'taskVersion', 'version', 'authorizationVersion', 'scopeDigest', 'verifiedSha', 'reportDigest'];

/**
 * Open a preview of a checked version (OWNER_UI_V2 WP7). The request binds the same goal, step, verified head and report
 * as Review's accept, and nothing else: no command, path or address. The review is read again here, so only the exact
 * head of a finished step that passed the independent check with that report is previewed; a changed, unverified,
 * reopened or report-only result is refused. The pages are read from that commit's Git objects in AIWorks's own
 * checkout (preview.mjs); nothing is built or started, and nothing is written. The answer names the preview's address and the commit,
 * never a folder.
 */
export function openResultPreview(dataDir, input, sessions, { config = readConfig(dataDir) } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !PREVIEW_KEYS.includes(key)) ||
      !identifier.test(input.campaignId ?? '') || !identifier.test(input.taskId ?? '') || !Number.isSafeInteger(input.taskVersion) ||
      !Number.isSafeInteger(input.version) || input.version < 1 || !Number.isSafeInteger(input.authorizationVersion) ||
      !/^[a-f0-9]{64}$/.test(input.scopeDigest ?? '') || !/^[0-9a-f]{40}$/.test(input.verifiedSha ?? '') || !/^[0-9a-f]{64}$/.test(input.reportDigest ?? '')) {
    throw fail(400, 'Invalid dashboard command.');
  }
  if (!existsSync(join(dataDir, 'supervisor.db'))) throw fail(503, 'AIWorks can’t read its work records on this computer right now.');
  const store = new Store(join(dataDir, 'supervisor.db'), { readOnly: true });
  let repoPath = null;
  try {
    const c = store.campaign(input.campaignId);
    if (!c) throw fail(404, COMMANDS.notFound);
    if (c.version !== input.version || c.authorization_version !== input.authorizationVersion || c.scope_digest !== input.scopeDigest) {
      throw fail(409, 'Work changed since this view was loaded. Refresh and try again.');
    }
    const task = store.task(c.id, input.taskId), spec = c.declaration.tasks.find((item) => item.id === input.taskId);
    if (!task || task.version !== input.taskVersion) throw fail(409, COMMANDS.result.changed);
    const review = resultReview(store, c, task, spec, config);
    // Exactly the head that passed the independent check, with the report it was checked with: never a newer or older one.
    if (!review || review.verifiedSha !== input.verifiedSha || review.reportDigest !== input.reportDigest) throw fail(409, COMMANDS.result.changed);
    if (!review.preview.available) throw fail(409, review.preview.reason);
    try { repoPath = isLocalTarget(c.declaration) ? resolveLocalProject(store, c.declaration).checkout.path : resolveCheckout(store, config, c.declaration.target.repository)?.path ?? null; }
    catch { repoPath = null; }
  } finally { store.close(); }
  const git = configuredGitCommand(dataDir);
  let manifest;
  try { manifest = previewManifest({ git, repoPath, sha: input.verifiedSha }); }
  catch (error) { if (error instanceof PreviewError) throw fail(409, error.message); throw error; }
  const { token, expiresAt } = sessions.add({ git, repoPath, sha: input.verifiedSha, manifest, binding: { campaignId: input.campaignId, taskId: input.taskId } });
  return { url: `/preview/${token}/${manifest.entry.split('/').map(encodeURIComponent).join('/')}`, verifiedSha: input.verifiedSha, expiresAt };
}
