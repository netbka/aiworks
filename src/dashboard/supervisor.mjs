import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { Store } from '../supervisor/store.mjs';
import { campaignStatus, campaignPause, campaignCancel, campaignRecheck, campaignStart, supervisorLiveness } from '../supervisor/api.mjs';
import { DEFAULTS } from '../supervisor/controller.mjs';
import { safeText } from './roadmap.mjs';
import { pendingInstructions } from '../supervisor/instructions.mjs';
import { roleUnavailableReason, runNotCounted } from '../supervisor/adapters/executors.mjs';
import { campaignLimits } from '../supervisor/campaign.mjs';
import { coordinatorView, postOwnerMessage } from '../supervisor/coordinator.mjs';
import { CODE_ROOT, revisionNotMerged } from '../supervisor/provenance.mjs';
import { COMMANDS, stateCopy, stopReasonWords } from './copy.mjs';
import { configuredRepositories } from './projects.mjs';

const readConfig = (dataDir) => {
  try { return JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { return {}; }
};

// `detail` is the machine's own reason, for the page's Details disclosure; `message` is what the owner reads.
const fail = (status, message, detail = null) => Object.assign(new Error(message), { status, ...(detail ? { detail } : {}) });
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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
 * Why a step waits, in the owner's words (OWNER_WORKSPACE §4.7, slice S5): other steps are named by their outcome, never
 * by ID, and only supervisor-known fields are read (stored errors can quote worker text). `retryAt` is when AIWorks
 * tries again by itself. Built from today's fields; the status `wait` field replaces it later (plan §6.12 C7, UI11).
 */
const shortName = (text, max = 80) => {
  const safe = safeText(String(text), 200);
  if (safe.length <= max) return safe;
  const cut = safe.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).replace(/[s,;:.]+$/, '')}…`;
};
function stepWait(task, spec, specs, taskRows) {
  if (task.blocked || ['done', 'verified'].includes(task.state)) return null;
  const names = (ids) => {
    // A step is named by its outcome; a long outcome sentence gives way to the short title instead of being cut mid-word
    // (owner review 2026-10-13).
    const named = (spec) => spec?.outcome && (spec.outcome.length <= 80 || !spec.title) ? spec.outcome : spec?.title ?? spec?.outcome ?? 'an earlier step';
    const quoted = ids.map((id) => `“${shortName(named(specs.get(id)))}”`);
    return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}` : quoted[0];
  };
  const be = (ids) => ids.length === 1 ? 'is' : 'are';
  const error = String(task.last_error ?? ''), dependsOn = spec?.dependsOn ?? [];
  if (error.startsWith('dependency-integration:') && dependsOn.length) return { text: `Starts after ${names(dependsOn)} ${be(dependsOn)} merged`, retryAt: task.retry_at ?? null };
  if (error.startsWith('waiting for executor availability:') || error.startsWith('quota:')) return { text: 'Waiting for an AI worker to be free', retryAt: task.retry_at ?? null };
  if (task.retry_at) return { text: 'The last run did not finish; AIWorks tries again by itself', retryAt: task.retry_at };
  const open = dependsOn.filter((id) => taskRows.find((item) => item.task_id === id)?.state !== 'done');
  if (task.state === 'pending' && open.length) return { text: `Starts after ${names(open)} ${be(open)} finished`, retryAt: null };
  return null;
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
 * Release mode per project (OWNER_WORKSPACE §10.3, slice S8): Review only is on; Auto Release is off and not available.
 * Text only. There is no control and no field a page could turn into one: Auto Release waits for the owner's release
 * decision (#33, D5-gate) and a release grant for the project, neither of which exists.
 */
export function releaseModes(repositories) {
  const projects = new Map();
  for (const repository of repositories) if (/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') && !projects.has(repository.toLowerCase())) projects.set(repository.toLowerCase(), repository);
  return [...projects.values()].sort((a, b) => a.localeCompare(b)).map((repository) => ({ repository, mode: 'review-only', modes: [
    { key: 'review-only', label: 'Review only', on: true, text: 'AIWorks stops when a result passes the check and is published. You merge and release.' },
    { key: 'auto-release', label: 'Auto Release', on: false, available: false,
      text: 'Not available. Turning this on needs your separate release approval for this project, which has not been given.',
      waitsFor: 'https://github.com/netbka/aiworks/issues/33' }] }));
}

/** Settings (slice S8): configured command names, the AI workers once for this computer, and release mode per project. */
export function computerSettings(campaigns, config, { platform = process.platform, now = Date.now(), repositories = [] } = {}) {
  return { commands: configuredCommandNames(config), workers: aiWorkers(campaigns, config, { platform, now }),
    releases: releaseModes([...repositories, ...campaigns.map((c) => c.repository)]),
    // Where supervisor faults are tracked: config.json "supervisorIssue" (a GitHub issue link) when set, so a disposable
    // review copy can name a made-up one; otherwise null, and the owner view links AIWorks' own (owner.mjs SUPERVISOR_ISSUE).
    supervisorIssue: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(config?.supervisorIssue ?? '') ? config.supervisorIssue : null };
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

export function supervisorSnapshot(dataDir, now = Date.now(), { since } = {}) {
  const path = join(dataDir, 'supervisor.db');
  if (!existsSync(path)) return { available: false, message: 'No supervisor store at the configured location.', campaigns: [], costs: [], activity: [] };
  let store;
  try {
    store = new Store(path, { readOnly: true });
    store.db.exec('BEGIN');
    const campaigns = store.all("SELECT id FROM campaigns ORDER BY CASE WHEN control IN ('finished', 'cancelled') THEN 1 ELSE 0 END, created_at").map(({ id }) => {
      const c = store.campaign(id), status = campaignStatus(store, id, now);
      const taskRows = store.tasks(id);
      const specs = new Map(c.declaration.tasks.map((task) => [task.id, task]));
      const operations = store.openOperations(id);
      const order = status.executorOrder;
      // Verifier rejections per task: a churn signal for the owner, not a limit.
      const rejections = new Map();
      for (const op of store.all("SELECT task_id, outcome FROM operations WHERE campaign_id = ? AND kind = 'verify' AND state = 'finished'", id)) {
        if (op.outcome?.class === 'result' && (op.outcome.value?.verdict ?? op.outcome.value?.result) === 'rejected') rejections.set(op.task_id, (rejections.get(op.task_id) ?? 0) + 1);
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
          // OWNER_WORKSPACE S5: why it waits, naming steps by outcome; a stop in §7.7 words; its own attempts and events.
          wait: stepWait(task, specs.get(task.task_id), specs, taskRows),
          stopped: stepStopped(task, safeText(specs.get(task.task_id)?.outcome ?? specs.get(task.task_id)?.title ?? task.task_id),
            `https://github.com/${c.declaration.target.repository}/issues/${specs.get(task.task_id)?.issue}`),
          history: histories.get(task.task_id) ?? { attempts: [], events: [] },
          // OWNER_WORKSPACE S7: its runs and the cost they reported; null, never 0, when none reported one.
          cost: (({ reportedUsd, ...rest }) => ({ ...rest, reportedUsd: reportedUsd > 0 ? reportedUsd : null, checkerRejections: rejections.get(task.task_id) ?? 0 }))(
            costs.get(task.task_id) ?? { runs: 0, reportedUsd: 0, unreportedRuns: 0, runningRuns: 0, retries: 0 }) })),
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
    // aiworks#18: a stopped supervisor, with its last lease renewal, for the owner view to lead with.
    const controller = supervisorLiveness(store, { now, leaseMs: readConfig(dataDir).leaseMs ?? DEFAULTS.leaseMs, stopRequested: existsSync(join(dataDir, 'STOP')) });
    store.db.exec('COMMIT');
    const view = coordinatorView(store, readConfig(dataDir), now);
    const coordinator = { configured: view.configured, configError: view.configError ? safeText(view.configError, 300) : null,
      blocked: view.blocked ? safeText(view.blocked, 300) : null, reportTo: view.reportTo ?? null, runsToday: view.runsToday ?? 0, maxRunsPerDay: view.maxRunsPerDay ?? null,
      messages: view.messages.map((m) => ({ id: m.id, text: safeText(m.text, 4000), source: safeText(m.source, 80), state: code(m.state),
        receivedAt: m.receivedAt, readAt: m.readAt, answeredAt: m.answeredAt, failure: code(m.failure), retryAt: m.retryAt, attempts: m.attempts,
        replyState: code(m.replyState), replyUrl: githubLink(m.replyUrl),
        progress: m.state === 'read' ? (() => {
          const run = view.runs.find((item) => item.id === m.runId);
          return run ? workerProgress(dataDir, { executor_kind: 'claude-cli', workspace: run.workspace, session_id: run.session_id, run_dir: run.run_dir }) : null;
        })() : null })) };
    const settings = computerSettings(campaigns, readConfig(dataDir), { now, repositories: configuredRepositories(dataDir) });
    return { available: true, observedAt: new Date(now).toISOString(), controller, campaigns, costs: projectCosts(campaigns), activity, coordinator, recent, settings };
  } catch { return { available: false, message: 'Supervisor state is temporarily unavailable. Commands are disabled until it reconnects.', campaigns: [], costs: [], activity: [] }; }
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
  const known = [...configuredRepositories(dataDir), ...store.all('SELECT id FROM campaigns').map(({ id }) => store.campaign(id).declaration.target.repository)];
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
  if (!existsSync(join(dataDir, 'supervisor.db'))) throw fail(503, 'Supervisor is unavailable.');
  const store = new Store(join(dataDir, 'supervisor.db'));
  try {
    const text = isPlan ? planRequestText(planRequest(store, dataDir, input.plan)) : input.text;
    return postOwnerMessage(store, { text, requestId: input.requestId, source: isPlan ? 'owner (Start work: Plan only)' : 'owner (dashboard)' }, now);
  } catch (error) {
    if (error.code === 'INVALID_MESSAGE') throw fail(400, error.message);
    if (error.code === 'CONFLICT') throw fail(409, error.message);
    throw error;
  } finally { store.close(); }
}

// provenanceRoot: the checkout whose origin/main a Resume is checked against (AW-005). The HTTP server never passes it, so
// it is always this dashboard's own checkout; only in-process callers (the tests) point it at another repository.
export function applyCommand(dataDir, input, now = Date.now(), { provenanceRoot = CODE_ROOT } = {}) {
  const allowed = ['campaignId', 'action', 'taskId', 'taskVersion', 'version', 'authorizationVersion', 'scopeDigest', 'requestId', 'text', 'role'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key)) ||
      !identifier.test(input.campaignId ?? '') || !['pause', 'resume', 'recheck', 'cancel', 'instruct'].includes(input.action) ||
      !/^[0-9a-f-]{36}$/i.test(input.requestId ?? '') || !Number.isSafeInteger(input.version) || input.version < 1 ||
      !Number.isSafeInteger(input.authorizationVersion) || !/^[a-f0-9]{64}$/.test(input.scopeDigest ?? '') ||
      input.taskId !== undefined && (!identifier.test(input.taskId) || !['recheck', 'instruct'].includes(input.action) || !Number.isSafeInteger(input.taskVersion)) ||
      input.action === 'instruct' && (!input.taskId || !['implement', 'verify'].includes(input.role) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text) || safeText(input.text, 2000) !== input.text) ||
      input.action !== 'instruct' && (input.text !== undefined || input.role !== undefined)) {
    throw fail(400, 'Invalid dashboard command.');
  }
  if (!existsSync(join(dataDir, 'supervisor.db'))) throw fail(503, 'Supervisor is unavailable.');
  const store = new Store(join(dataDir, 'supervisor.db'));
  try {
    // Private Resume uses the registered declaration; executable code must still be merged.
    const before = input.action === 'resume' ? store.campaign(input.campaignId) : null;
    if (before?.control === 'paused') {
      const notMerged = revisionNotMerged({ root: provenanceRoot });
      if (notMerged) throw fail(409, COMMANDS.resumeRefused, `Resume refused: ${notMerged}`);
    }
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
