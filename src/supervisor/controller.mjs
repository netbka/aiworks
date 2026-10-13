// AIWorks campaign controller. Deterministic code owns leases, timers, dispatch,
// reconciliation and publication; models are called only as bounded workers/verifiers.
// Idle ticks do not call models. Explicit integration gates refresh read-only Git refs at bounded intervals.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptsLease, packetDigest, planContext, validatePacket } from '../../scripts/lib/worker-context.mjs';
import * as executors from './adapters/executors.mjs';
import { researchContext } from './adapters/research-context.mjs';
import * as gitA from './adapters/git.mjs';
import * as github from './adapters/github.mjs';
import { authorityDigest, campaignLimits, executorOrder, projectGovernance } from './campaign.mjs';
import { resolveCheckout } from './project-connect.mjs';
import { campaignBudget } from './api.mjs';
import { ACCOUNT_SCOPED, accountOf, accountWait, clearAccountWait, laterWait, setAccountWait } from './accounts.mjs';
import { domainOf, pathsOutside, writeDomainConstraint } from './work-ownership.mjs';
import { adjustFanout, admissionCheck, classifyRun, fanoutBound, hostCeiling, orderCandidates, schedulerEnabled, thrashing } from './scheduler.mjs';
import { coordinatorTick, LANE as COORDINATOR_LANE } from './coordinator.mjs';
import { stopOwnedRun, readJsonIfExists, readTextIfExists, writeAtomic } from './proc.mjs';
import { pendingInstructions, attachInstructions } from './instructions.mjs';
import { priorAttempt, receiptInputs, staticReceipt } from './router.mjs';
import { PLAN_TASK, settleAmendment, specOf, specsOf } from './plan.mjs';
import { ConflictError, FencedError } from './store.mjs';
import { OWNER_CLASSES, blockerFingerprint, nextRecheckAt, noopTransport, ownerMessage, redact, reminderDue } from './owner-intervention.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const POLICY = JSON.parse(readFileSync(resolve(here, '../../registry/worker-context-policy.json'), 'utf8'));
const RUNNER = join(here, 'runner.mjs');
// A task whose fresh sessions keep returning evidence-unavailable is not making progress. After this many
// such results it stops with a B3 owner decision, whatever the retry limit (historical regression): a no-progress guard, not
// a spend cap. With the 2/10/30-minute backoff the fourth result comes at least ~42 minutes after the first,
// so a short outage does not stop work. A resolved or accepted result, or a recheck naming the task, resets
// the count.
export const NO_PROGRESS_LIMIT = 4;
// GitHub rejects issue/PR bodies and comments over 65,536 characters.
const BODY_LIMIT = 65536;
const RETRYABLE = new Set(['invalid-result', 'exit-without-result', 'timeout', 'spawn-failed', 'error', 'evidence-unavailable', 'lost']);
export const dispatchBudget = (executor, role, prompt) => ({
  inputTokens: Math.ceil(Buffer.byteLength(prompt) / 3) + (executor.researchOnly ? 20_000 : 40_000),
  outputReserveTokens: executor.researchOnly && role === 'verification' ? 16_000 : 32_000,
  safetyTokens: 16_000, windowTokens: 200_000,
});
const STATUS_FOR = { B2: 'blocked-owner-action', B3: 'blocked-owner-decision', B4: 'blocked-external' };
const RUNNABLE = ['pending', 'implemented', 'verified'];
// aiworks#1: dependencies whose recheck is a deterministic in-process probe. Any other dependency is rechecked by one
// bounded probe run of a held parent task, which only an owner or recovery event (never a timer) starts.
const DETERMINISTIC_PROBES = new Set(['budget', 'process-ownership', 'runtime-not-merged']);
const RECHECK_PROCEDURE = {
  auth: 'Run the held task once with the same executor; a structured result proves the login works.',
  executors: 'Select an eligible executor and run the held task once; a structured result proves availability.',
  'research-context': 'Rebuild the read-only research context and run the held task once.',
  'publication-size': 'Publish the held task again; a successful publication is the evidence.',
  budget: 'Evaluate the campaign budget from durable state; resume when it is no longer exhausted.',
  'process-ownership': 'Reconcile the recorded run; resume when the operation is no longer open.',
  'runtime-not-merged': 'Compare the supervisor code revision with origin/main in its checkout; resume once it is an ancestor.',
  'owner-decision': 'Record the decision on the task issue, then run: supervisor recheck <campaign> --task <task>.',
};
const RECOVERY_TRIED = {
  auth: 'the executor run failed authentication; no credential was read or refreshed by the supervisor',
  executors: 'every authorized executor in the declared order was tried or is waiting',
  'process-ownership': 'containment stop of the recorded run',
  'owner-decision': 'none: the worker reported an owner-reserved decision',
};
const MAX_NOTIFY_ATTEMPTS = 5;
// A task whose run raised the blocker resumes in the phase that run started from.
const RESUME_PHASE = { implementing: 'pending', verifying: 'implemented' };
// A provider usage limit belongs to the executor account, not to one task: the latest pending reset holds every dispatch.
const quotaHoldUntil = (tasks, now) => Math.max(0, ...tasks
  .filter((task) => task.retry_at > now && String(task.last_error ?? '').startsWith('quota:')).map((task) => task.retry_at));

export const DEFAULTS = {
  tickMs: 5_000, leaseMs: 90_000, pollMs: 30_000, heartbeatMs: 10_000, staleMs: 90_000,
  startGraceMs: 30_000, dispatchWaitMs: 15_000, publishRetryMs: 5 * 60_000, outboxRetryMs: 60_000,
  retryBackoffMs: [2 * 60_000, 10 * 60_000, 30 * 60_000],
  integrationPollMs: 60_000,
  // aiworks#42: a published head's CI is read at most once per ciPollMs; a head with no check run ciNoChecksMs after its
  // publication is recorded as having no CI, and its polling stops.
  ciPollMs: 60_000, ciNoChecksMs: 30 * 60_000,
  // A GitHub rate-limit refusal waits for its reported reset plus this margin, instead of publishRetryMs (aiworks#21).
  rateLimitMarginMs: 5_000,
};
// Findings that reopen a published task as a repair round on its own branch and PR (aiworks#27, aiworks#42).
const REPAIR_FINDINGS = new Set(['integration-conflict', 'ci-failure']);
// Journal kinds that settle a published head's CI result; its polling stops after one of them (aiworks#42).
const CI_SETTLED = ['ci-passed', 'ci-failed', 'ci-inconclusive', 'ci-none'];
// GitHub resets its rate limits within the hour: a reset time further out is treated as an hour.
const RATE_LIMIT_MAX_WAIT_MS = 60 * 60_000;
// AW-005: how often a controller re-reads whether its own revision is merged. A constant, not a config.json key.
const REVISION_CHECK_MS = 60_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const runLease = (op, state, sessionId = op.session_id) => ({
  tenantId: op.packet.tenantId, projectId: op.packet.projectId, environment: op.packet.environment,
  taskId: op.packet.taskId, stageId: op.packet.stageId, runId: op.packet.runId, sessionId,
  revision: op.packet.revision, authorityDigest: op.packet.authorityDigest,
  generation: op.seq, state, expiresAtMs: Number.MAX_SAFE_INTEGER,
});

export class Controller {
  // governanceRoot: the read-only governance provider checkout whose registry/projects and policies/catalog.json resolve each
  // target project's governance; the explicit argument, else config.json `governanceRoot`. With neither (or an invalid root) no
  // worker is dispatched: dispatch fails closed with a project-governance blocker, never falling back to this checkout.
  // revisionCheck (AW-005): returns null while this code is merged into origin/main, else the reason. `cli.mjs serve` always
  // supplies it from git; only an in-process embedding (the tests) constructs a controller without it. revisionCheckMs
  // is likewise an in-process seam, never read from config.json.
  constructor({ store, config, dataDir, log = () => {}, now = () => Date.now(), instanceId = randomUUID(),
    codeRevision = null, fault = process.env.AIWORKS_FAULT ?? null, notifier = noopTransport, probes = {},
    governanceRoot = undefined, revisionCheck = null, revisionCheckMs = REVISION_CHECK_MS }) {
    Object.assign(this, { store, dataDir, log, now, instanceId, codeRevision, fault, notifier, probes, governanceRoot,
      revisionCheck, revisionCheckMs });
    this.config = { ...DEFAULTS, ...config };
    this.governanceRoot = governanceRoot ?? this.config.governanceRoot;
    // aiworks#1 owner-intervention core: off unless the data-directory config enables it.
    this.oi = this.config.ownerIntervention?.enabled === true;
    // aiworks#27 integration repair: off unless the data-directory config enables it. The check times are kept in memory
    // only: after a restart every published task is checked once more, which is harmless.
    this.ir = this.config.integrationRepair?.enabled === true;
    this.integrationCheckedAt = new Map();
    // aiworks#42 CI repair: off unless the data-directory config enables it. Poll times are kept in memory only: after a
    // restart each published head whose CI is not yet settled is read once more. Settled results are in the journal.
    this.ci = this.config.ciRepair?.enabled === true;
    this.ciNextAt = new Map();
    this.ciPolledAt = new Map();
    // ADAPTIVE_SCHEDULER (slice RUN5): off unless the data-directory config enables it. Off, every campaign keeps one
    // operation at a time and nothing below changes behaviour. On, campaigns only collect candidates while they settle,
    // and one admission pass per tick starts at most one of them. Candidates, the campaigns that waited for fan-out and
    // the last wait reasons are per-tick memory only; every admission input is a store row or a local git ref. The base
    // check times and the PRs found merged at their exact head are caches: a restart reads them again.
    this.sched = schedulerEnabled(this.config);
    this.candidates = [];
    this.fanoutWaited = new Set();
    this.waitReasons = new Map();
    this.domainWaits = [];
    this.baseCheckedAt = new Map();
    this.mergedHeads = new Set();
    const commands = config.commands ?? {};
    this.cmd = { codex: commands.codex, cursor: commands.cursor, agy: commands.agy, chrome: commands.chrome,
      claude: commands.claude ?? ['claude'], git: commands.git ?? ['git'], gh: commands.gh ?? ['gh'] };
    this.held = new Map();
  }

  /** Crash rehearsal hook: terminate abruptly at a named point (AIWORKS_FAULT). */
  injectFault(name) {
    if (this.fault !== name) return;
    this.log(`fault injected: ${name}`);
    process.exit(86);
  }

  async tick() {
    const ids = this.store.all(`SELECT id FROM campaigns WHERE control IN ('registered', 'paused', 'cancel-requested')
      OR EXISTS (SELECT 1 FROM outbox WHERE campaign_id = campaigns.id AND state = 'pending')`).map((row) => row.id);
    // A finished campaign is visited again only while integration repair is on and its published PRs are due a check.
    if (this.ir) {
      for (const { id } of this.store.all("SELECT id FROM campaigns WHERE control = 'finished'")) {
        if (!ids.includes(id) && this.integrationDue(id)) ids.push(id);
      }
    }
    // Likewise while CI repair is on and a published head's CI is due a read.
    if (this.ci) {
      for (const { id } of this.store.all("SELECT id FROM campaigns WHERE control = 'finished'")) {
        if (!ids.includes(id) && (this.ciNextAt.get(id) ?? -Infinity) <= this.now()) ids.push(id);
      }
    }
    this.candidates = [];
    for (const id of ids) {
      try {
        await this.step(id);
      } catch (error) {
        if (error instanceof FencedError) {
          this.held.delete(id);
          this.log(`fenced: ${error.message}`);
        } else if (error instanceof ConflictError) {
          this.log(`conflict, retrying next tick: ${error.message}`);
        } else {
          this.log(`campaign ${id} step failed: ${error.stack || error}`);
          try { this.store.journal(id, 'step-error', { message: String(error.message).slice(0, 500) }, this.now()); } catch { /* store unavailable */ }
        }
      }
    }
    // Admission: at most one launch per tick across every campaign this instance holds (ADAPTIVE_SCHEDULER 4.1).
    if (this.sched) {
      try { await this.admit(); }
      catch (error) {
        if (error instanceof FencedError || error instanceof ConflictError) this.log(`admission retried next tick: ${error.message}`);
        else this.log(`admission failed: ${error.stack || error}`);
      }
    }
    // The owner's coordinator inbox is its own single-slot lane with its own lease; it never takes a campaign slot.
    try {
      await coordinatorTick(this);
    } catch (error) {
      if (error instanceof FencedError) { this.held.delete(COORDINATOR_LANE); this.log(`fenced: ${error.message}`); }
      else if (!(error instanceof ConflictError)) this.log(`coordinator step failed: ${error.stack || error}`);
    }
    await this.drainOutbox();
    await this.drainOwnerNotifications();
  }

  /** Graceful shutdown: expire held leases so a restarted instance takes over at once. */
  release() {
    for (const [id, generation] of this.held) this.store.releaseLease(id, this.instanceId, generation, this.now());
    this.held.clear();
  }

  fenced(ctx, fn) {
    return this.store.tx(() => {
      this.store.assertLease(ctx.id, this.instanceId, ctx.generation, this.now());
      const value = fn();
      // Hold the write lock across external effects so expiry cannot admit a second writer.
      this.store.run('UPDATE leases SET expires_at = ? WHERE campaign_id = ? AND instance_id = ? AND generation = ?',
        this.now() + this.config.leaseMs, ctx.id, this.instanceId, ctx.generation);
      return value;
    });
  }

  async step(id) {
    const lease = this.store.acquireLease(id, this.instanceId, this.now(), this.config.leaseMs, this.codeRevision);
    if (!lease) { this.held.delete(id); return; }
    if (!lease.renewed) this.log(`campaign ${id}: holding lease generation ${lease.generation}${lease.takeover ? ' after expiry of the previous holder' : ''}`);
    this.held.set(id, lease.generation);
    const ctx = { id, generation: lease.generation };
    // A conflicting published PR reopens its task and with it the finished campaign (aiworks#27).
    if (this.ir && this.store.campaign(id).control === 'finished') this.checkPublishedIntegration(ctx);
    // A published head whose CI fails reopens its task the same way (aiworks#42).
    if (this.ci && this.store.campaign(id).control === 'finished') this.checkPublishedCi(ctx);
    if (['finished', 'cancelled'].includes(this.store.campaign(id).control)) return;

    this.processEvents(ctx);
    if (this.oi) this.ownerInterventionTick(ctx);
    for (const op of this.store.openOperations(id)) await this.reconcile(ctx, op);
    const campaign = this.store.campaign(id);
    if (campaign.control === 'cancel-requested') {
      if (!this.store.openOperations(id).length) {
        this.fenced(ctx, () => {
          const c = this.store.campaign(id);
          this.store.patch('campaigns', { id }, c.version, { control: 'cancelled', blocker: null, next_action: null, next_wakeup_at: null }, this.now());
          this.store.journal(id, 'cancelled', null, this.now());
        });
      }
      return;
    }
    if (campaign.control === 'registered') {
      const unmerged = this.unmergedRevision();
      if (unmerged) this.holdForUnmergedCode(ctx, unmerged);
      else {
        this.releaseUnmergedHold(ctx);
        if (this.ir) this.checkPublishedIntegration(ctx);
        if (this.ci) this.checkPublishedCi(ctx);
        this.reconcileIntegration(ctx);
        await this.schedule(ctx);
      }
    }
    this.refreshStatus(ctx);
  }

  /** Why this code may not start new work (AW-005), or null. Re-evaluated at most every revisionCheckMs. */
  unmergedRevision() {
    if (!this.revisionCheck) return null;
    const now = this.now();
    if (!this.revisionState || now - this.revisionState.at >= this.revisionCheckMs) {
      let reason;
      try { reason = this.revisionCheck(); } catch (error) { reason = `revision check failed: ${error.message}`; }
      reason = reason ? String(reason).slice(0, 400) : null;
      if (reason && reason !== this.revisionState?.reason) this.log(`no new work: ${reason}`);
      this.revisionState = { at: now, reason };
    }
    return this.revisionState.reason;
  }

  /**
   * Unmerged code starts no new work: no dispatch, no launch of an unlaunched operation, no publication. Operations
   * already running keep running and their results are still recorded. The campaign shows a B2 blocker unless it
   * already has another one, which stays as it is.
   */
  holdForUnmergedCode(ctx, reason) {
    if (this.store.campaign(ctx.id).blocker) return;
    this.fenced(ctx, () => this.raiseBlocker(ctx, this.store.campaign(ctx.id).declaration, {
      kind: 'runtime-not-merged', class: 'B2',
      reason: `No new work starts: ${reason}. A campaign runs only from merged supervisor code (AW-005).`,
      requestedAction: 'Deploy a revision of origin/main to the supervisor runtime checkout (fetch origin first if this revision is already merged); the hold then clears by itself.',
    }, this.now(), { identity: this.codeRevision ?? 'unknown' }));
  }

  releaseUnmergedHold(ctx) {
    if (this.store.campaign(ctx.id).blocker?.kind !== 'runtime-not-merged') return;
    this.fenced(ctx, () => {
      const c = this.store.campaign(ctx.id);
      if (c.blocker?.kind !== 'runtime-not-merged') return;
      this.store.patch('campaigns', { id: ctx.id }, c.version, { blocker: null }, this.now());
      this.store.journal(ctx.id, 'blocker-cleared', { kind: 'runtime-not-merged', revision: this.codeRevision }, this.now());
      // With the aiworks#1 owner-intervention core on, the durable blocker record resolves on the same evidence.
      const record = this.oi && c.blocker.fingerprint ? this.store.blocker(c.blocker.fingerprint) : null;
      if (record && record.status !== 'resolved') this.resolveBlocker(ctx, record, { trigger: 'state-change', probe: 'deterministic', pass: true,
        detail: `supervisor code ${String(this.codeRevision ?? 'unknown').slice(0, 12)} is an ancestor of origin/main`, at: this.now() }, this.now());
    });
  }

  processEvents(ctx) {
    for (const event of this.store.all('SELECT * FROM events WHERE campaign_id = ? AND processed_at IS NULL ORDER BY seq', ctx.id)) {
      if (event.kind === 'agent-instruction') continue; // Dispatch owns the durable delivery receipt.
      this.fenced(ctx, () => {
        const now = this.now();
        if (event.kind === 'recheck') {
          const only = event.payload?.task ?? null;
          if (!only) {
            this.store.run('DELETE FROM executor_waits WHERE campaign_id = ?', ctx.id);
            // The owner's "the limit lifted" is about the account: it ends once for every campaign that uses it.
            for (const { kind } of executorOrder(this.store.campaign(ctx.id).declaration.executor)) this.endAccountWait(kind, `recheck of ${ctx.id}`, now);
          }
          for (const task of this.store.tasks(ctx.id)) {
            // A usage-limit wait is not a blocker, but recheck also ends it (the owner knows the limit lifted early).
            const quotaWait = !task.blocked && task.retry_at &&
              /^(quota:|waiting for executor availability:)/.test(String(task.last_error ?? ''));
            if ((!task.blocked && !quotaWait) || (only && task.task_id !== only)) continue;
            // An owner-reserved decision is cleared only by a recheck naming that task.
            if (task.blocked?.class === 'B3' && !only) continue;
            this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, task.version,
              quotaWait ? { retry_at: null, last_error: null } : { blocked: null, failures: {}, retry_at: null, last_error: null }, now);
            // The owner's decision recorded against this task is the evidence an owner-decision blocker needs.
            const record = this.oi && task.blocked?.fingerprint ? this.store.blocker(task.blocked.fingerprint) : null;
            if (record && record.status !== 'resolved') {
              this.resolveBlocker(ctx, record, { trigger: 'owner-decision', probe: 'decision', pass: true,
                detail: redact(event.payload?.note ?? `recheck --task ${task.task_id}`), at: now }, now);
            }
          }
          const c = this.store.campaign(ctx.id);
          const record = this.oi && c.blocker?.fingerprint ? this.store.blocker(c.blocker.fingerprint) : null;
          if (record && record.status === 'open') this.recheckBlocker(ctx, record, only ? `owner-recheck:${only}` : 'owner-recheck', now);
          else if (record) { /* a recheck is already running, or ownerInterventionTick releases a resolved record */ }
          else if (c.blocker && c.blocker.kind !== 'budget') this.store.patch('campaigns', { id: ctx.id }, c.version, { blocker: null }, now);
        }
        this.store.journal(ctx.id, `event-${event.kind}`, event.payload, now);
        this.store.run('UPDATE events SET processed_at = ? WHERE seq = ?', now, event.seq);
      });
    }
  }

  async reconcile(ctx, op) {
    const runner = readJsonIfExists(join(op.run_dir, 'runner.json'));
    const result = readJsonIfExists(join(op.run_dir, 'result.json'));
    const campaign = this.store.campaign(ctx.id);
    if (campaign.control === 'cancel-requested' && !result) {
      const stopped = this.fenced(ctx, () => runner ? stopOwnedRun(runner)
        : existsSync(join(op.run_dir, 'run.lock')) || existsSync(join(op.run_dir, 'launch.json')) ? 'ownership-unavailable' : 'not-running');
      if (!['stopped', 'not-running'].includes(stopped)) { this.blockOwnership(ctx, op, stopped); return; }
      this.fenced(ctx, () => {
        this.store.updateOperation(op.id, { state: 'abandoned', outcome: { class: 'cancelled', detail: stopped } }, this.now());
        const task = this.store.task(ctx.id, op.task_id);
        this.store.patch('tasks', { campaign_id: ctx.id, task_id: op.task_id }, task.version, { state: op.kind === 'verify' ? 'implemented' : 'pending' }, this.now());
        this.store.journal(ctx.id, 'operation-abandoned', { op: op.id, reason: 'cancel' }, this.now());
      });
      return;
    }
    if (result) { this.consume(ctx, op, result); return; }
    const now = this.now();
    if (op.state === 'recorded') {
      if (runner || existsSync(join(op.run_dir, 'run.lock'))) {
        this.fenced(ctx, () => this.store.updateOperation(op.id, { state: 'dispatched' }, this.now()));
      } else {
        if (existsSync(join(op.run_dir, 'launch.json'))) {
          if (now - op.updated_at >= this.config.startGraceMs) this.blockOwnership(ctx, op, 'launch receipt missing');
          return;
        }
        // Checkpoint committed but never launched (controller died in between): launch the
        // same operation. The runner's exclusive lock prevents a second agent for it.
        // Unmerged code does not start it (AW-005); it stays recorded until merged code runs.
        if (this.unmergedRevision()) return;
        this.log(`resuming recorded operation ${op.id}`);
        await this.launch(ctx, op);
      }
      return;
    }
    const beat = Number(readTextIfExists(join(op.run_dir, 'heartbeat')) || 0);
    const alive = beat ? now - beat < this.config.staleMs : now - op.updated_at < this.config.startGraceMs;
    if (alive) return;
    const stopped = this.fenced(ctx, () => runner ? stopOwnedRun(runner)
      : existsSync(join(op.run_dir, 'run.lock')) || existsSync(join(op.run_dir, 'launch.json')) ? 'ownership-unavailable' : 'not-running');
    if (!['stopped', 'not-running'].includes(stopped)) { this.blockOwnership(ctx, op, stopped); return; }
    if (readJsonIfExists(join(op.run_dir, 'result.json'))) return; // finished meanwhile; consume next tick
    this.applyOutcome(ctx, op, { class: 'lost', detail: `runner heartbeat stale; ${stopped}`, receipt: { measured: false } });
  }

  deliverable(ctx, taskId) {
    // A planning step is read-only report work (WORK_ENVELOPE 6.2); it has no spec of its own.
    return taskId === PLAN_TASK ? 'report' : specOf(this.store, ctx.id, taskId).deliverable;
  }

  consume(ctx, op, run) {
    if (run.containment !== 'windows-job-v1' || run.containmentStopped !== true) {
      const runner = readJsonIfExists(join(op.run_dir, 'runner.json'));
      const stopped = this.fenced(ctx, () => runner ? stopOwnedRun(runner) : 'ownership-unavailable');
      if (!['stopped', 'not-running'].includes(stopped)) {
        this.blockOwnership(ctx, op, stopped);
        return;
      }
      this.applyOutcome(ctx, op, { class: 'lost', detail: 'run has no confirmed process containment', receipt: { measured: false } });
      return;
    }
    const executor = this.store.campaign(ctx.id).declaration.executor;
    const outcome = executors.classify({
      executorKind: op.executor_kind,
      researchOnly: (executor.kind === 'cli-chain' ? executor.providers : [executor])
        .find((provider) => provider.kind === op.executor_kind)?.researchOnly === true,
      role: op.kind === 'verify' ? 'verification' : 'implementer', run,
      // The browser worker's audit needs the whole event log, not the 4 MiB tail: a violation early in a long log would be cut.
      stdoutText: readTextIfExists(join(op.run_dir, 'stdout.json'), op.executor_kind === 'agy-cli' ? executors.AGY_LOG_LIMIT : undefined),
      logBytes: existsSync(join(op.run_dir, 'stdout.json')) ? statSync(join(op.run_dir, 'stdout.json')).size : 0,
      stderrText: readTextIfExists(join(op.run_dir, 'stderr.log')),
      expect: { deliverable: this.deliverable(ctx, op.task_id), targetSha: op.target_sha, reportDigest: op.report_digest,
        sessionId: op.session_id, packetDigest: op.packet_digest },
      now: this.now(),
    });
    this.applyOutcome(ctx, op, outcome);
  }

  applyOutcome(ctx, op, outcome) {
    if (op.kind === 'plan') return this.settlePlan(ctx, op, outcome);
    let verdict = outcome;
    const before = this.store.task(ctx.id, op.task_id);
    // Deterministic checks of the worker's claims, outside the write transaction.
    if (verdict.class === 'result' && op.kind === 'implement' && verdict.value.result === 'resolved' &&
        this.deliverable(ctx, op.task_id) === 'commit') {
      const problem = gitA.checkImplementation({ git: this.cmd.git, path: op.workspace, baseSha: before.base_sha, headSha: verdict.value.headSha });
      if (problem) verdict = { ...verdict, class: 'invalid-result', detail: problem };
      // An integration repair must actually merge the base it was reopened for (aiworks#27).
      const integration = this.integrationFinding(before);
      if (!problem && integration && !gitA.isAncestor({ git: this.cmd.git, path: op.workspace, ancestor: integration.base, descendant: verdict.value.headSha })) {
        verdict = { ...verdict, class: 'invalid-result', detail: `integration repair head ${verdict.value.headSha} does not contain the base ${integration.base}` };
      }
      // A declared write domain is checked, not trusted (ADAPTIVE_SCHEDULER 4.3): a path outside it is a boundary
      // violation, held for the owner and never retried on another provider. An integration repair is measured from the
      // base it merged, so the sibling changes it brought in are not counted as its own.
      const decl = this.store.campaign(ctx.id).declaration;
      const spec = specOf(this.store, ctx.id, op.task_id, decl);
      const domain = verdict.class === 'result' ? domainOf(decl, spec) : null;
      if (domain && !domain.whole) {
        const changed = gitA.changedPaths({ git: this.cmd.git, path: op.workspace, from: integration ? integration.base : before.base_sha, to: verdict.value.headSha });
        const outside = changed === null ? null : pathsOutside(domain, changed);
        if (outside === null) verdict = { ...verdict, class: 'invalid-result', detail: 'cannot list the paths the commit changed' };
        else if (outside.length) {
          verdict = { ...verdict, class: 'error', violation: true,
            detail: `writes outside the declared domain (${spec.writes.join(', ')}): ${outside.slice(0, 10).join(', ')}${outside.length > 10 ? ', ...' : ''}` };
        }
      }
    }
    if (verdict.class === 'result' && op.kind === 'verify' && before.head_sha !== op.target_sha) {
      verdict = { ...verdict, class: 'invalid-result', detail: `stale verification: task head is ${before.head_sha}, verifier saw ${op.target_sha}` };
    }
    if (verdict.class === 'result' && op.kind === 'verify') {
      const problem = gitA.checkVerification({ git: this.cmd.git, path: op.workspace, targetSha: op.target_sha });
      if (problem) verdict = { ...verdict, class: 'invalid-result', detail: problem };
    }
    this.fenced(ctx, () => {
      const now = this.now();
      const fresh = this.store.get('SELECT * FROM operations WHERE id = ?', op.id);
      if (!['recorded', 'dispatched'].includes(fresh.state)) return; // already applied
      verdict = { ...verdict, executorKind: fresh.executor_kind };
      // historical regression C0 predicate inside the authoritative commit: the result must come from the exact dispatched run.
      if (verdict.class === 'result' && !acceptsLease(runLease(fresh, 'active'), runLease(fresh, 'active', verdict.receipt?.sessionId ?? ''), now)) {
        verdict = { ...verdict, class: 'invalid-result', detail: `result session ${verdict.receipt?.sessionId} is not the dispatched session ${fresh.session_id}` };
      }
      if (executors.runNotCounted(verdict)) verdict = { ...verdict, refunded: true };
      this.store.updateOperation(op.id, { state: 'finished', outcome: verdict }, now);
      if (verdict.class === 'result') {
        this.store.run('DELETE FROM executor_waits WHERE campaign_id = ? AND executor_kind = ?', ctx.id, op.executor_kind);
        // The account works again: its wait ends for every campaign that uses it.
        this.endAccountWait(op.executor_kind, op.id, now);
      }
      const blocked = this.store.campaign(ctx.id);
      // Only the operation whose ownership was unresolved clears its blocker; another operation finishing proves nothing
      // about it. A blocker recorded before the operation id was kept (no `operation`) keeps the old behaviour.
      if (blocked.blocker?.kind === 'process-ownership' && (!blocked.blocker.operation || blocked.blocker.operation === op.id)) {
        this.store.patch('campaigns', { id: ctx.id }, blocked.version, { blocker: null }, now);
        const record = this.oi && blocked.blocker.fingerprint ? this.store.blocker(blocked.blocker.fingerprint) : null;
        if (record && record.status !== 'resolved') this.resolveBlocker(ctx, record, { trigger: 'state-change', probe: 'deterministic', pass: true,
          detail: `operation ${op.id} finished under confirmed containment`, operation: op.id, at: now }, now);
      }
      const campaign = this.store.campaign(ctx.id);
      if (verdict.receipt?.costUsd) this.store.patch('campaigns', { id: ctx.id }, campaign.version, { cost_usd: campaign.cost_usd + verdict.receipt.costUsd }, now);
      if (verdict.refunded) {
        const c = this.store.campaign(ctx.id);
        this.store.patch('campaigns', { id: ctx.id }, c.version, { runs_used: Math.max(0, c.runs_used - 1) }, now);
        this.store.journal(ctx.id, 'run-refunded', { op: op.id, reason: verdict.class === 'unavailable'
          ? 'executor was unavailable; no task attempt took place' : 'provider usage limit refused the run before any work' }, now);
      }
      const task = this.store.task(ctx.id, op.task_id);
      const change = this.transition(ctx, task, op, verdict, campaign.declaration, now);
      if (this.oi && OWNER_CLASSES.has(change.blocked?.class)) {
        const reason = redact(change.blocked.reason);
        const record = this.openBlocker(ctx, campaign.declaration, { dependency: 'owner-decision', cls: change.blocked.class,
          identity: `${task.task_id}:${/^no progress:/.test(reason) ? 'no-progress' : reason}`, summary: `${task.task_id}: ${reason}`,
          requestedAction: `Decide on ${campaign.declaration.target.repository}#${specOf(this.store, ctx.id, task.task_id, campaign.declaration).issue}: ${reason}`,
          parents: [{ ...task, state: change.state ?? task.state }], scope: 'task' }, now);
        change.blocked = { ...change.blocked, reason, fingerprint: record.fingerprint };
      }
      this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, task.version, change, now);
      // The learned fan-out follows real results (ADAPTIVE_SCHEDULER 4.4): +1 for a useful result while work of this
      // campaign waited for fan-out, -1 for a failed run, back to 1 on thrash. Neutral and refunded runs change nothing.
      if (this.sched) {
        const run = classifyRun(op.kind, verdict);
        const window = Math.max(...this.config.retryBackoffMs);
        adjustFanout(this.store, { campaignId: ctx.id, bound: fanoutBound(campaign.declaration, hostCeiling(this.config)), run,
          waited: this.fanoutWaited.has(ctx.id), thrash: run === 'failed' && thrashing(this.store, ctx.id, now, window), now });
        if (run === 'useful') this.fanoutWaited.delete(ctx.id);
      }
      // A probe run that returned a structured result got past the failure that held its parents.
      if (this.oi && verdict.class === 'result') this.probeSucceeded(ctx, op.task_id, { operation: op.id, detail: `${op.kind} run on ${op.executor_kind} returned a structured result` }, now);
      this.store.journal(ctx.id, 'operation-finished', {
        op: op.id, executor: op.executor_kind, class: verdict.class, detail: verdict.detail ?? null, session: verdict.receipt?.sessionId ?? null,
        // The worker's own verdict: a valid `result` can still say rejected or evidence-unavailable.
        terminal: verdict.class === 'result' ? verdict.value?.result ?? verdict.value?.verdict ?? null : null,
        blocking: verdict.class === 'result' && Array.isArray(verdict.value?.findings) ? verdict.value.findings.filter((f) => f.severity === 'blocking').length : null,
        nativeSession: verdict.receipt?.nativeSessionId ?? null,
        costUsd: verdict.receipt?.costUsd ?? null, usage: verdict.receipt?.usage ?? null,
      }, now);
      if (change.blocked) {
        this.enqueue(ctx.id, `${ctx.id}:${task.task_id}:blocked:${op.id}`, campaign.declaration,
          `**${task.task_id}** is blocked (${change.blocked.class}): ${change.blocked.reason}\n\nThe campaign keeps ownership. After recovery or an owner decision recorded on the task issue, run \`supervisor recheck ${ctx.id} --task ${task.task_id}\`.`, now);
      }
    });
  }

  /**
   * Settle a planning operation (WORK_ENVELOPE 6.3 and 6.4, slice E3). The operation finishes and its amendment is admitted,
   * with its task rows, in one fenced transaction: both commit or neither does. A controller whose lease generation is stale
   * gets FencedError and writes nothing. After a crash before the commit the operation is still open and is settled again
   * with the same idempotency key; after the commit it is finished and nothing is applied twice. Code admits, never a model.
   * Nothing records a planning operation yet: planning triggers and the plan-stage result are slice E5.
   */
  settlePlan(ctx, op, outcome) {
    const merged = !this.unmergedRevision();
    const settled = this.fenced(ctx, () => {
      const now = this.now();
      const fresh = this.store.get('SELECT * FROM operations WHERE id = ?', op.id);
      if (!['recorded', 'dispatched'].includes(fresh.state)) return null; // already settled
      let verdict = { ...outcome, executorKind: fresh.executor_kind };
      if (verdict.class === 'result' && !acceptsLease(runLease(fresh, 'active'), runLease(fresh, 'active', verdict.receipt?.sessionId ?? ''), now)) {
        verdict = { ...verdict, class: 'invalid-result', detail: `result session ${verdict.receipt?.sessionId} is not the dispatched session ${fresh.session_id}` };
      }
      this.store.updateOperation(op.id, { state: 'finished', outcome: verdict }, now);
      const campaign = this.store.campaign(ctx.id);
      if (verdict.receipt?.costUsd) this.store.patch('campaigns', { id: ctx.id }, campaign.version, { cost_usd: campaign.cost_usd + verdict.receipt.costUsd }, now);
      this.store.journal(ctx.id, 'operation-finished', { op: op.id, executor: fresh.executor_kind, class: verdict.class, detail: verdict.detail ?? null,
        session: verdict.receipt?.sessionId ?? null, costUsd: verdict.receipt?.costUsd ?? null }, now);
      if (verdict.class !== 'result') return null;
      const admission = settleAmendment(this.store, { campaign: this.store.campaign(ctx.id), operation: fresh, amendment: verdict.value?.amendment,
        merged, leaseGeneration: ctx.generation, codeRevision: this.codeRevision, now });
      const kind = { admitted: 'amendment-admitted', repeated: 'amendment-repeated', none: 'plan-no-change', refused: 'amendment-refused' }[admission.outcome];
      this.store.journal(ctx.id, kind, { op: op.id, ...admission, ops: admission.ops?.length }, now);
      this.injectFault('before-plan-settle');
      return admission;
    });
    this.injectFault('after-plan-settle');
    return settled;
  }

  transition(ctx, task, op, v, decl, now) {
    const limits = campaignLimits(decl);
    const back = op.kind === 'verify' ? 'implemented' : 'pending';
    const retry = (cls, detail, state) => {
      const failures = { ...task.failures, [cls]: (task.failures?.[cls] ?? 0) + 1 };
      const total = Object.entries(failures).filter(([key]) => RETRYABLE.has(key)).reduce((sum, [, n]) => sum + n, 0);
      if (cls === 'evidence-unavailable' && failures[cls] >= NO_PROGRESS_LIMIT) {
        return { state, failures, retry_at: null, last_error: `${cls}: ${detail}`,
          blocked: { class: 'B3', reason: `no progress: ${failures[cls]} evidence-unavailable results; last: ${String(detail).slice(0, 300)}`, at: now } };
      }
      if (limits.maxRetriesPerTask !== null && total > limits.maxRetriesPerTask) {
        return { state, failures, retry_at: null, last_error: `${cls}: ${detail}`,
          blocked: { class: 'stalled', reason: `${total} failed attempts; last ${cls}: ${String(detail).slice(0, 300)}`, at: now } };
      }
      const backoff = this.config.retryBackoffMs;
      return { state, failures, retry_at: now + backoff[Math.min(total - 1, backoff.length - 1)], last_error: `${cls}: ${detail}` };
    };
    // A worker that left its boundary is never retried on the same provider: the task waits for the owner.
    if (v.violation) return { state: back, retry_at: null, last_error: `violation: ${v.detail}`,
      blocked: { class: 'B3', reason: `boundary violation on ${op.executor_kind}: ${String(v.detail).slice(0, 300)}`, at: now } };
    if (decl.executor.kind === 'cli-chain' && ['quota', 'auth', 'spawn-failed', 'unavailable'].includes(v.class)) {
      // A timed wait (quota reset, or a host sandbox failure that may clear) re-admits the provider by itself;
      // an untimed wait (auth, missing support) lasts until an explicit recheck.
      // This campaign's row stays as before. A usage limit, a failed login or an unavailable host also belongs to the
      // account, so its row holds every other campaign on it too; a failed launch stays with this campaign only.
      const waitUntil = ['quota', 'unavailable'].includes(v.class) ? v.retryAt ?? null : null;
      this.store.run('INSERT OR REPLACE INTO executor_waits (campaign_id, executor_kind, retry_at, reason) VALUES (?, ?, ?, ?)',
        ctx.id, op.executor_kind, waitUntil, `${v.class}: ${v.detail}`);
      if (ACCOUNT_SCOPED.has(v.class)) setAccountWait(this.store, this.config, { kind: op.executor_kind, retryAt: waitUntil, reason: `${v.class}: ${v.detail}`, campaignId: ctx.id, now });
      const choice = this.executorChoice(decl, { ...task, state: back }, now);
      if (choice.executor) {
        this.store.journal(ctx.id, 'executor-fallback', { task: task.task_id, from: op.executor_kind,
          executor: choice.executor.kind, reason: v.class, credits: /credits\/billing/.test(v.detail) }, now);
        return { state: back, retry_at: now, last_error: `${op.executor_kind}: ${v.class}: ${v.detail}` };
      }
      if (choice.retryAt) return { state: back, retry_at: choice.retryAt, last_error: `waiting for executor availability: ${v.detail}` };
      this.raiseBlocker(ctx, decl, { kind: 'executors', class: 'B2', reason: 'No authorized executor is available for this task role',
        requestedAction: 'Restore an executor listed in status.executorWaits or its scoped role support, then recheck the campaign.' }, now,
      { identity: 'no-eligible-executor' });
      return { state: back, retry_at: null, last_error: `${op.executor_kind}: ${v.class}: ${v.detail}` };
    }
    // A single-provider campaign's failed login stays its own B2 blocker, whose recheck or probe resolution resumes it;
    // an account row here would outlive that resolution. (A chain records it on the account above.)
    if (v.class === 'auth') {
      this.raiseBlocker(ctx, decl, { kind: 'auth', class: 'B2', reason: v.detail,
        requestedAction: `Re-authenticate the selected CLI on this PC, then run: supervisor recheck ${ctx.id}` }, now,
      { identity: op.executor_kind });
      return { state: back, last_error: `auth: ${v.detail}` };
    }
    if (v.class === 'quota') {
      setAccountWait(this.store, this.config, { kind: op.executor_kind, retryAt: v.retryAt ?? null, reason: `quota: ${v.detail}`, campaignId: ctx.id, now });
      return { state: back, retry_at: v.retryAt, last_error: `quota: ${v.detail}` };
    }
    if (v.class !== 'result') return retry(v.class, v.detail, back);
    const value = v.value;
    if (op.kind === 'implement') {
      if (value.result === 'resolved') {
        // A report deliverable is bound to the revision it was produced against.
        const head = specOf(this.store, ctx.id, task.task_id, decl).deliverable === 'commit' ? value.headSha : op.base_sha;
        return { state: 'implemented', head_sha: head, result: value, retry_at: null, last_error: null, failures: {} };
      }
      if (value.result === 'blocked-owner-reserved') {
        return { state: 'pending', result: value, blocked: { class: 'B3', reason: `owner-reserved: ${value.ownerTrigger}`, at: now } };
      }
      return retry('evidence-unavailable', value.tried || value.summary, 'pending');
    }
    if (value.verdict === 'accepted') return { state: 'verified', verified_sha: op.target_sha, verification: value, retry_at: null, last_error: null, failures: {} };
    if (value.verdict === 'rejected') {
      const blocking = value.findings.filter((finding) => finding.severity === 'blocking');
      if (!blocking.length) return retry('invalid-result', 'rejected without a blocking finding', 'implemented');
      // The integration or CI finding stays with the task until its repaired head is published.
      const repair = this.publishedRepair(task);
      const findings = repair ? [...blocking, repair] : blocking;
      if (limits.maxRepairRounds !== null && task.repair_rounds >= limits.maxRepairRounds) {
        return { state: 'pending', verification: value, findings,
          blocked: { class: 'stalled', reason: `verifier still rejects after ${task.repair_rounds} repair rounds`, at: now } };
      }
      return { state: 'pending', verification: value, findings, repair_rounds: task.repair_rounds + 1, retry_at: null, last_error: null };
    }
    return retry('evidence-unavailable', value.summary, 'implemented');
  }

  /** `identity` and `subject` name the failure for the aiworks#1 fingerprint; they are used only when the feature is enabled. */
  raiseBlocker(ctx, decl, blocker, now, { identity = null, subject = null } = {}) {
    const c = this.store.campaign(ctx.id);
    if (c.blocker?.kind === blocker.kind) return;
    let key = `${ctx.id}:blocker:${blocker.kind}:${now}`;
    if (this.oi) {
      blocker = { ...blocker, reason: redact(blocker.reason) };
      const record = this.openBlocker(ctx, decl, { dependency: blocker.kind, cls: blocker.class, identity: identity ?? blocker.reason,
        summary: blocker.reason, requestedAction: blocker.requestedAction, subject,
        parents: this.store.tasks(ctx.id).filter((task) => task.state !== 'done')
          .map((task) => ({ ...task, state: RESUME_PHASE[task.state] ?? task.state })), scope: 'campaign' }, now);
      if (record) {
        blocker = { ...blocker, fingerprint: record.fingerprint };
        // One tracking-issue comment per blocker episode: a failed recheck updates the record, not the issue thread.
        key = `${ctx.id}:blocker:${record.fingerprint}:${record.episode}`;
      }
    }
    this.store.patch('campaigns', { id: ctx.id }, c.version, { blocker: { ...blocker, at: now } }, now);
    this.store.journal(ctx.id, 'blocker-raised', blocker, now);
    this.enqueue(ctx.id, key, decl,
      `Campaign \`${ctx.id}\` is blocked (${blocker.class}): ${blocker.reason}\n\n**Requested owner action:** ${blocker.requestedAction}`, now);
  }

  blockOwnership(ctx, op, detail) {
    this.fenced(ctx, () => this.raiseBlocker(ctx, this.store.campaign(ctx.id).declaration, {
      kind: 'process-ownership', class: 'B4', operation: op.id, reason: `process ownership is unresolved for ${op.id}: ${detail}`,
      requestedAction: 'Reconcile the recorded run and prove its processes stopped before repairing its ownership receipt; do not dispatch a replacement from missing receipt files alone.',
    }, this.now(), { identity: op.id, subject: op.id }));
  }

  missingIntegratedDependencies(decl, spec, tasks, revision, path) {
    const specs = specsOf(this.store, decl.campaignId, decl);
    const inRevision = (sha) => /^[0-9a-f]{40}$/.test(revision ?? '') &&
      gitA.exec(this.cmd.git, ['merge-base', '--is-ancestor', sha, revision], { cwd: path }).ok;
    return spec.dependsOn.filter((id) => {
      const dep = tasks.find((t) => t.task_id === id);
      if (dep?.state !== 'done') return true;
      if (specs.get(id).deliverable === 'report') return false;
      if (!dep.verified_sha) return true;
      if (inRevision(dep.verified_sha)) return false;
      const mergedSha = github.integratedPullRequest({ gh: this.cmd.gh, repository: decl.target.repository,
        url: dep.pr_url, headSha: dep.verified_sha, baseBranch: decl.target.baseBranch });
      return !mergedSha || !inRevision(mergedSha);
    });
  }

  /**
   * Fetch the base branch into this supervisor's own ref and read it there. FETCH_HEAD is shared by every fetch in the
   * checkout (another campaign, the dashboard, the owner), so a base read from it can be another branch's tip.
   */
  fetchBase(repoPath, base) {
    const ref = `refs/aiworks/base/${base}`;
    const fetched = gitA.exec(this.cmd.git, ['fetch', 'origin', `+refs/heads/${base}:${ref}`], { cwd: repoPath, timeoutMs: 30_000 });
    const sha = fetched.ok ? gitA.exec(this.cmd.git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoPath }).stdout : '';
    return /^[0-9a-f]{40}$/.test(sha ?? '') ? { ok: true, sha } : { ok: false, sha: null };
  }

  /** Publication is not integration. Refresh only when an explicitly gated task is due, whatever else is running. */
  reconcileIntegration(ctx) {
    const c = this.store.campaign(ctx.id);
    if (c.blocker) return;
    const tasks = this.store.tasks(ctx.id), specs = specsOf(this.store, ctx.id, c.declaration);
    const due = tasks.filter((t) => t.state === 'pending' && !t.blocked && (!t.retry_at || t.retry_at <= this.now()) &&
      specs.get(t.task_id).requiresMergedDependencies && specs.get(t.task_id).dependsOn.every((id) => tasks.find((d) => d.task_id === id)?.state === 'done'));
    if (!due.length) return;
    // A project and config.json that disagree: refresh nothing, so dispatch raises the CONFIG_CONFLICT blocker.
    if (resolveCheckout(this.store, this.config, c.declaration.target.repository)?.conflict) return;
    this.fenced(ctx, () => {
      const repo = this.repo(c.declaration), base = c.declaration.target.baseBranch;
      const fetched = this.fetchBase(repo.path, base);
      const fetchedSha = fetched.sha;
      for (const task of due) {
        const missing = !fetched.ok ? specs.get(task.task_id).dependsOn
          : this.missingIntegratedDependencies(c.declaration, specs.get(task.task_id), tasks, fetchedSha, repo.path);
        const reason = missing.length ? `dependency-integration: waiting for ${missing.join(', ')} in ${base}${fetched.ok ? '' : ' (remote refresh unavailable)'}` : null;
        if (!reason && !String(task.last_error ?? '').startsWith('dependency-integration:')) continue;
        this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, task.version,
          { retry_at: reason ? this.now() + this.config.integrationPollMs : null, last_error: reason }, this.now());
        if (reason !== task.last_error) this.store.journal(ctx.id, reason ? 'integration-wait' : 'integration-ready', { task: task.task_id }, this.now());
      }
    });
  }

  integrationDue(id, now = this.now()) {
    return (this.integrationCheckedAt.get(id) ?? -Infinity) + this.config.integrationPollMs <= now;
  }

  /**
   * aiworks#27: a published, unmerged commit task whose verified head no longer merges cleanly into the freshly fetched
   * base becomes an integration repair round. Detection is local (`git merge-tree`), after the same bounded base fetch as
   * reconcileIntegration, and never calls GitHub. A task is left alone once its remote branch no longer points at its
   * verified head (merged and deleted, or changed by someone else), or once the base contains it.
   */
  checkPublishedIntegration(ctx) {
    if (!this.integrationDue(ctx.id)) return;
    const c = this.store.campaign(ctx.id);
    if (c.blocker) return;
    const decl = c.declaration, specs = specsOf(this.store, ctx.id, decl);
    const published = (tasks) => tasks.filter((t) => t.state === 'done' && !t.blocked && t.pr_url &&
      specs.get(t.task_id)?.deliverable === 'commit' && /^[0-9a-f]{40}$/.test(t.verified_sha ?? ''));
    const candidates = published(this.store.tasks(ctx.id)).length;
    // A finished campaign with nothing left to check is not visited again until a restart; a running one may publish more.
    this.integrationCheckedAt.set(ctx.id, !candidates && c.control === 'finished' ? Infinity : this.now());
    if (!candidates) return;
    if (resolveCheckout(this.store, this.config, decl.target.repository)?.conflict) { this.log(`integration check of ${ctx.id} skipped: CONFIG_CONFLICT`); return; }
    this.fenced(ctx, () => {
      const repo = this.repo(decl), base = decl.target.baseBranch, git = this.cmd.git;
      const baseSha = this.fetchBase(repo.path, base).sha;
      const heads = /^[0-9a-f]{40}$/.test(baseSha ?? '') ? gitA.remoteBranches({ git, repoPath: repo.path, pattern: `refs/heads/campaign/${ctx.id}/*` }) : null;
      if (!heads) { this.log(`integration check of ${ctx.id} skipped: remote refresh unavailable`); return; }
      const limits = campaignLimits(decl);
      let open = 0;
      for (const task of published(this.store.tasks(ctx.id))) {
        const sha = task.verified_sha, branch = gitA.branchName(ctx.id, task.task_id);
        if (heads.get(`refs/heads/${branch}`) !== sha) continue;
        if (gitA.isAncestor({ git, path: repo.path, ancestor: sha, descendant: baseSha })) continue;
        const merge = gitA.mergeCheck({ git, repoPath: repo.path, baseSha, sha });
        if (merge.clean) { if (merge.tree !== merge.baseTree) open++; continue; }
        open++;
        const now = this.now();
        const paths = merge.paths.slice(0, 20);
        const commits = gitA.siblingCommits({ git, repoPath: repo.path, baseSha, sha, paths });
        const finding = {
          id: 'integration-conflict', severity: 'blocking', base: baseSha, verified: sha, paths, commits,
          description: `Integration conflict: the verified commit ${sha} (${task.pr_url}) no longer merges into ${base} at ${baseSha}. ` +
            `Conflicting paths: ${paths.join(', ')}. Sibling commits on ${base}: ${commits.map((item) => `${item.sha.slice(0, 12)} ${item.subject}`).join('; ') || 'unknown'}. ` +
            `Merge ${baseSha} into this branch (git merge ${baseSha}), resolve the conflicts, run the full gate and commit the merge. Never rebase, reset or amend: ${sha} must stay an ancestor of the new head.`,
        };
        const stalled = limits.maxRepairRounds !== null && task.repair_rounds >= limits.maxRepairRounds;
        this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, task.version, {
          state: 'pending', base_sha: sha, findings: [finding], failures: {}, retry_at: null,
          last_error: `integration-conflict: ${paths.join(', ')} conflict with ${base} at ${baseSha}`.slice(0, 1000),
          ...(stalled ? { blocked: { class: 'stalled', reason: `integration conflict with ${base} after ${task.repair_rounds} repair rounds`, at: now } }
            : { repair_rounds: task.repair_rounds + 1 }),
        }, now);
        this.store.journal(ctx.id, 'integration-conflict', { task: task.task_id, sha, base: baseSha, paths, commits: commits.map((item) => item.sha), stalled }, now);
        const fresh = this.store.campaign(ctx.id);
        if (fresh.control === 'finished') {
          this.store.patch('campaigns', { id: ctx.id }, fresh.version, { control: 'registered', status: 'active', next_action: null }, now);
        }
      }
      if (!open && this.store.campaign(ctx.id).control === 'finished') this.integrationCheckedAt.set(ctx.id, Infinity);
    });
  }

  /** The open integration-conflict finding of a task in an integration repair round, or null. */
  integrationFinding(task) {
    return (task.findings ?? []).find((finding) => finding.id === 'integration-conflict') ?? null;
  }

  /**
   * The finding that reopened a published task as a repair round on its own branch and PR: an integration conflict
   * (aiworks#27) or a CI failure (aiworks#42). Its `verified` head must stay an ancestor of the repair. Null otherwise.
   */
  publishedRepair(task) {
    return (task.findings ?? []).find((finding) => REPAIR_FINDINGS.has(finding.id)) ?? null;
  }

  /** Published heads whose CI result is settled (passed, failed, inconclusive or none), as `<task>:<sha>` keys. */
  ciSettled(id) {
    return new Set(this.store.all(`SELECT detail FROM journal WHERE campaign_id = ? AND kind IN (${CI_SETTLED.map(() => '?').join(', ')})`, id, ...CI_SETTLED)
      .map((row) => `${row.detail?.task}:${row.detail?.sha}`));
  }

  /**
   * aiworks#42: after publication, the PR head's CI is read through REST (GET repos/{repo}/commits/{sha}/check-runs) at
   * most once per ciPollMs per published task, until it completes; then its polling stops. A failure reopens the task as
   * a repair round on the same branch and PR, carrying the failing check names, unless its PR is no longer open at that
   * head. Every result is journaled; status reads it from there, so a published head never shows green before CI does.
   */
  checkPublishedCi(ctx) {
    const now = this.now();
    if ((this.ciNextAt.get(ctx.id) ?? -Infinity) > now) return;
    const c = this.store.campaign(ctx.id);
    const decl = c.declaration, specs = specsOf(this.store, ctx.id, decl);
    const settled = this.ciSettled(ctx.id);
    const watched = this.store.tasks(ctx.id).filter((t) => t.state === 'done' && !t.blocked && t.pr_url &&
      specs.get(t.task_id)?.deliverable === 'commit' && /^[0-9a-f]{40}$/.test(t.verified_sha ?? '') && !settled.has(`${t.task_id}:${t.verified_sha}`));
    // A finished campaign with nothing left to read is not visited again until a restart or a new publication.
    let next = !watched.length && c.control === 'finished' ? Infinity : now + this.config.ciPollMs;
    for (const task of watched) {
      const key = `${ctx.id}:${task.task_id}:${task.verified_sha}`;
      const due = (this.ciPolledAt.get(key) ?? -Infinity) + this.config.ciPollMs;
      if (due > now) { next = Math.min(next, due); continue; }
      this.ciPolledAt.set(key, now);
      let read;
      try {
        read = github.commitChecks({ gh: this.cmd.gh, repository: decl.target.repository, sha: task.verified_sha });
        // A PR merged, closed or pushed by someone else since publication is not repaired: its head is no longer ours to fix.
        if (read.state === 'failure') read.pr = github.findOpenPullRequest({ gh: this.cmd.gh, repository: decl.target.repository, branch: gitA.branchName(ctx.id, task.task_id) });
      } catch (error) {
        // A rate-limit refusal waits for its reset; any other failure is read again after ciPollMs. CI stays unknown.
        if (error instanceof github.RateLimitError && Number.isFinite(error.resetAt)) {
          this.ciPolledAt.set(key, Math.min(Math.max(error.resetAt, now), now + RATE_LIMIT_MAX_WAIT_MS) + this.config.rateLimitMarginMs - this.config.ciPollMs);
        }
        next = Math.min(next, this.ciPolledAt.get(key) + this.config.ciPollMs);
        this.log(`CI read of ${task.task_id} at ${task.verified_sha} failed: ${error.message}`);
        continue;
      }
      if (this.recordCi(ctx, task, read)) next = Math.min(next, now + this.config.ciPollMs);
    }
    this.ciNextAt.set(ctx.id, next);
  }

  /** Journal one CI read; reopen the task on a failure. Returns whether the head's CI is to be read again. */
  recordCi(ctx, task, { state, checks, pr = null }) {
    return this.fenced(ctx, () => {
      const fresh = this.store.task(ctx.id, task.task_id), now = this.now();
      if (fresh.version !== task.version) return false;
      const decl = this.store.campaign(ctx.id).declaration, spec = specOf(this.store, ctx.id, task.task_id, decl);
      const sha = task.verified_sha, names = (list) => list.map((check) => check.name);
      if (state === 'pending') {
        if (!checks.length && now - task.updated_at >= this.config.ciNoChecksMs) {
          this.store.journal(ctx.id, 'ci-none', { task: task.task_id, sha }, now);
          return false;
        }
        const seen = this.store.all("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'ci-pending'", ctx.id)
          .some((row) => row.detail?.task === task.task_id && row.detail?.sha === sha);
        if (!seen) this.store.journal(ctx.id, 'ci-pending', { task: task.task_id, sha, checks: names(checks) }, now);
        return true;
      }
      if (state === 'success' || state === 'inconclusive') {
        this.store.journal(ctx.id, state === 'success' ? 'ci-passed' : 'ci-inconclusive',
          { task: task.task_id, sha, checks: checks.map((check) => `${check.name}: ${check.conclusion}`) }, now);
        return false;
      }
      const failed = checks.filter((check) => !['success', 'neutral', 'skipped'].includes(check.conclusion)).slice(0, 20);
      const repairable = pr?.url === task.pr_url && pr.headRefOid === sha;
      const limits = campaignLimits(decl);
      const stalled = repairable && limits.maxRepairRounds !== null && task.repair_rounds >= limits.maxRepairRounds;
      this.store.journal(ctx.id, 'ci-failed', { task: task.task_id, sha, checks: names(failed), url: task.pr_url,
        repair: repairable, stalled, ...(repairable ? {} : { reason: pr ? `the open PR is at ${pr.headRefOid}` : 'no open PR' }) }, now);
      if (!repairable) return false;
      const list = failed.map((check) => `${check.name} (${check.conclusion}${check.url ? `, ${check.url}` : ''})`).join('; ');
      const finding = {
        id: 'ci-failure', severity: 'blocking', verified: sha, checks: failed,
        description: `CI failure: repository CI failed on the verified, published commit ${sha} (${task.pr_url}). Failing checks: ${list}. ` +
          'CI may run on another platform than this computer: reproduce the failure from the check output, fix its cause on top of this branch, ' +
          'guard platform-specific behaviour with a skip that names the reason without weakening what it checks, run the full gate and commit. ' +
          `Never rebase, reset or amend: ${sha} must stay an ancestor of the new head. Never weaken, skip or delete a test to make CI pass.`,
      };
      this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, fresh.version, {
        state: 'pending', base_sha: sha, findings: [finding], failures: {}, retry_at: null,
        last_error: `ci-failure: ${names(failed).join(', ')} failed on ${sha}`.slice(0, 1000),
        ...(stalled ? { blocked: { class: 'stalled', reason: `CI failure on ${sha} after ${task.repair_rounds} repair rounds`, at: now } }
          : { repair_rounds: task.repair_rounds + 1 }),
      }, now);
      const campaign = this.store.campaign(ctx.id);
      if (campaign.control === 'finished') {
        this.store.patch('campaigns', { id: ctx.id }, campaign.version, { control: 'registered', status: 'active', next_action: null }, now);
      }
      this.enqueue(ctx.id, `${ctx.id}:${task.task_id}:ci-failed:${sha}`, decl, `**${task.task_id}** (#${spec.issue}): CI failed on the published head \`${sha}\` (${task.pr_url}) in ${names(failed).join(', ')}. ` +
        (stalled ? 'The repair-round limit is reached, so the task stalls until a recheck.' : 'The task is reopened as a repair round; a fresh independent verification precedes any push to the same PR.') +
        ' Nothing was merged or deployed.', now);
      return false;
    });
  }

  async schedule(ctx) {
    const now = this.now();
    let campaign = this.store.campaign(ctx.id);
    const decl = campaign.declaration;
    if (campaign.blocker?.kind === 'budget' && !campaignBudget(this.store, campaign).exhausted) {
      this.fenced(ctx, () => {
        const c = this.store.campaign(ctx.id);
        this.store.patch('campaigns', { id: ctx.id }, c.version, { blocker: null }, this.now());
        this.store.journal(ctx.id, 'blocker-cleared', { kind: 'budget', ...campaignBudget(this.store, c) }, this.now());
        const record = this.oi && c.blocker.fingerprint ? this.store.blocker(c.blocker.fingerprint) : null;
        if (record && record.status !== 'resolved') this.resolveBlocker(ctx, record, { trigger: 'state-change', probe: 'deterministic', pass: true,
          detail: `budget available under authorization v${c.authorization_version}`, at: this.now() }, this.now());
      });
      campaign = this.store.campaign(ctx.id);
      this.reconcileIntegration(ctx);
    }
    const tasks = this.store.tasks(ctx.id);
    const done = new Set(tasks.filter((task) => task.state === 'done').map((task) => task.task_id));
    const spec = specsOf(this.store, ctx.id, decl);
    const hold = decl.executor.kind === 'cli-chain' ? 0 : Math.max(quotaHoldUntil(tasks, now), this.accountHoldUntil(decl.executor.kind, now)); // a chain holds only the exhausted account
    const held = this.heldTasks(ctx.id);
    const runnable = tasks.filter((task) => RUNNABLE.includes(task.state) && !task.blocked && !held.has(task.task_id) && (!task.retry_at || task.retry_at <= now) &&
      (!hold || task.state === 'verified') && spec.get(task.task_id).dependsOn.every((dep) => done.has(dep)));
    // Publication is not a worker and takes no capacity: every verified task publishes this tick, whatever else is
    // running (ADAPTIVE_SCHEDULER row 2). Dependents see the new state on the next tick.
    const verified = runnable.filter((task) => task.state === 'verified');
    for (const task of verified) await this.publish(ctx, this.store.campaign(ctx.id), task);
    if (verified.length) return;
    // Without the scheduler: one worker at a time per campaign, as before. With it, the admission pass decides.
    if (!this.sched && this.store.openOperations(ctx.id).length) return;
    const ready = runnable[0];
    if (!ready) return;
    if (campaign.blocker) return;
    const budget = campaignBudget(this.store, campaign);
    // Open runs are reserved against a cost ceiling while they last: with work still running, an exhausted budget is a
    // wait for those results, not yet the owner's budget decision (the one-slot path never gets here with a run open).
    if (this.sched && budget.exhausted && this.store.openOperations(ctx.id).length) return;
    if (this.sched && !budget.exhausted) {
      // Settle only: every runnable task without an open operation becomes a candidate; admit() starts at most one.
      const running = new Set(this.store.openOperations(ctx.id).map((op) => op.task_id));
      for (const task of runnable.filter((item) => !running.has(item.task_id))) {
        this.candidates.push({ ctx, campaignId: ctx.id, taskId: task.task_id, kind: task.state === 'pending' ? 'implement' : 'verify',
          ord: task.ord, declaration: decl, createdAt: campaign.created_at });
      }
      return;
    }
    if (budget.exhausted) {
      this.fenced(ctx, () => this.raiseBlocker(ctx, decl, {
        kind: 'budget', class: 'B3',
        reason: `${budget.exhausted} under authorization v${campaign.authorization_version}`,
        requestedAction: 'Decide whether to raise limits.maxWorkerRuns or limits.maxCostUsd; if yes, start the campaign again with authorization.version + 1 and the new limits',
      }, this.now(), { identity: `v${campaign.authorization_version}:${budget.exhausted.split(' (')[0]}` }));
      return;
    }
    await this.dispatch(ctx, campaign, ready, ready.state === 'pending' ? 'implement' : 'verify');
  }

  /** Admission inputs, all from store rows or local refs (ADAPTIVE_SCHEDULER 4.1). Host pressure is slice RUN7. */
  admissionInputs() {
    return {
      ceiling: hostCeiling(this.config),
      pressure: null,
      providerWaiting: (candidate) => {
        const task = this.store.task(candidate.campaignId, candidate.taskId);
        return !this.executorChoice(candidate.declaration, task).executor;
      },
      integrated: (campaignId, row, decl) => this.inBase(decl, row.verified_sha) || this.mergedHeads.has(`${row.pr_url}#${row.verified_sha}`),
    };
  }

  /**
   * Published but unmerged work holds its write domain until it is in its base (ADAPTIVE_SCHEDULER 4.3). For each base
   * where the last pass refused a step because of such a holder, refresh the base ref at most every integrationPollMs
   * (inside the fenced transaction, like every fetch) and, for a holder whose verified head is not in it, read its PR
   * once (REST): a merge at that exact head whose merge commit is in the base releases the domain too (squash or rebase
   * merges leave the head itself out of the base). Without such a refusal nothing is fetched or read.
   */
  refreshPublished(refusals) {
    const now = this.now();
    const due = new Map();
    for (const { candidate, refusal } of refusals) {
      for (const holder of refusal.detail?.holders ?? []) {
        if (holder.reason !== 'published-unmerged') continue;
        const decl = this.store.campaign(holder.campaignId).declaration;
        const key = `${decl.target.repository.toLowerCase()}\u0000${decl.target.baseBranch}`;
        if ((this.baseCheckedAt.get(key) ?? -Infinity) + this.config.integrationPollMs > now) continue;
        // The fetch is fenced by a lease this instance holds now: the refusal came from the last pass, its lease may be gone.
        const ctx = this.candidates.find((item) => item.campaignId === candidate.campaignId)?.ctx;
        if (!ctx) continue;
        if (!due.has(key)) due.set(key, { ctx, decl, holders: new Map() });
        due.get(key).holders.set(`${holder.campaignId}/${holder.taskId}`, holder);
      }
    }
    for (const [key, { ctx, decl, holders }] of due) {
      this.baseCheckedAt.set(key, now);
      const repo = this.checkout(decl);
      if (!repo?.path) continue;
      const fetched = this.fenced(ctx, () => this.fetchBase(repo.path, decl.target.baseBranch));
      if (!fetched?.ok) continue;
      for (const holder of holders.values()) {
        const row = this.store.task(holder.campaignId, holder.taskId);
        if (!row?.pr_url || !row.verified_sha || this.inBase(decl, row.verified_sha)) continue;
        const merged = github.integratedPullRequest({ gh: this.cmd.gh, repository: decl.target.repository, url: row.pr_url,
          headSha: row.verified_sha, baseBranch: decl.target.baseBranch });
        if (merged && this.inBase(decl, merged)) this.mergedHeads.add(`${row.pr_url}#${row.verified_sha}`);
      }
    }
  }

  /** Is this commit in the base as last fetched into refs/aiworks/base/<base>? Local read only; unknown counts as no. */
  inBase(decl, sha) {
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) return false;
    const repo = this.checkout(decl);
    if (!repo?.path) return false;
    return gitA.exec(this.cmd.git, ['merge-base', '--is-ancestor', sha, `refs/aiworks/base/${decl.target.baseBranch}`], { cwd: repo.path }).ok;
  }

  /**
   * One admission pass (ADAPTIVE_SCHEDULER 4.1): order this tick's candidates fairly and start the first admissible one,
   * at most one launch per tick. A candidate refused only by its campaign's fan-out marks that campaign as waiting, so
   * its next useful result may raise the fan-out. Every other candidate keeps exactly one reason (status shows it, RUN9).
   */
  async admit() {
    this.refreshPublished(this.domainWaits);
    const inputs = this.admissionInputs();
    const reasons = new Map();
    const domainWaits = [];
    let launched = false;
    for (const candidate of orderCandidates(this.store, this.candidates)) {
      const key = `${candidate.campaignId}/${candidate.taskId}`;
      const refusal = admissionCheck(this.store, candidate, inputs);
      if (refusal) {
        reasons.set(key, refusal);
        if (refusal.reason === 'campaign-fanout') this.fanoutWaited.add(candidate.campaignId);
        if (refusal.reason === 'write-domain') domainWaits.push({ candidate, refusal });
        continue;
      }
      // Admissible, but this tick already started one: it is next (one launch per tick keeps leases renewed on time).
      if (launched || !this.held.has(candidate.campaignId)) { reasons.set(key, { reason: 'launch-turn' }); continue; }
      const op = await this.dispatch(candidate.ctx, this.store.campaign(candidate.campaignId), this.store.task(candidate.campaignId, candidate.taskId),
        candidate.kind, { admission: () => admissionCheck(this.store, candidate, inputs) });
      // null means the recording transaction refused it (a race): the next candidate may still go this tick.
      launched = Boolean(op);
    }
    this.waitReasons = reasons;
    this.domainWaits = domainWaits;
  }

  /**
   * The campaign's checkout (PROJECT_CONNECTION 6.1, slice STA3): the live GitHub project for target.repository, else
   * config.json as before. A project and a config entry that disagree are never chosen between: CONFIG_CONFLICT.
   */
  repo(decl) {
    const repo = resolveCheckout(this.store, this.config, decl.target.repository);
    if (repo?.conflict) throw Object.assign(new Error(repo.conflict.message), { code: 'CONFIG_CONFLICT' });
    if (!repo?.path || !repo?.worktreeRoot) throw new Error(`no local checkout configured for ${decl.target.repository}`);
    return repo;
  }

  /** The checkout for local reads that tolerate its absence: null on CONFIG_CONFLICT too (dispatch raises that blocker). */
  checkout(decl) {
    const repo = resolveCheckout(this.store, this.config, decl.target.repository);
    return repo?.conflict ? null : repo;
  }

  /** This task's finished attempts of the same kind, newest first, as routing receipt entries (router.mjs priorAttempt). */
  priorAttempts(decl, task) {
    const kind = task.state === 'implemented' ? 'verify' : 'implement';
    return this.store.all("SELECT id, executor_kind, outcome, routing FROM operations WHERE campaign_id = ? AND task_id = ? AND kind = ? AND state = 'finished' ORDER BY created_at DESC",
      decl.campaignId, task.task_id, kind).map(priorAttempt);
  }

  /** A timed account wait for a single-provider campaign, as an epoch, or 0. An untimed one holds it at dispatch (untimedAccountWait). */
  accountHoldUntil(kind, now = this.now()) {
    const wait = accountWait(this.store, this.config, kind);
    return wait && wait.retry_at !== null && wait.retry_at > now ? wait.retry_at : 0;
  }

  /**
   * End the wait of the account behind `kind` once, for every campaign that uses it: a success on the account proves it
   * works, and a recheck is the owner saying the limit lifted. Each such campaign drops its own copy of that wait (a usage
   * limit, a failed login or an unavailable host; a failed launch stays with its campaign), its tasks that waited for it
   * are due again at once, and its journal records provider-wait-cleared. Store writes only, no model call.
   */
  endAccountWait(kind, by, now) {
    if (!clearAccountWait(this.store, this.config, kind)) return false;
    const users = this.store.all("SELECT id, declaration FROM campaigns WHERE control NOT IN ('finished', 'cancelled')")
      .filter((c) => executorOrder(c.declaration.executor).some((provider) => provider.kind === kind));
    for (const c of users) {
      this.store.run(`DELETE FROM executor_waits WHERE campaign_id = ? AND executor_kind = ? AND (reason LIKE 'quota:%'
        OR reason LIKE 'auth:%' OR reason LIKE 'unavailable:%' OR reason LIKE '%sandbox setup failed%' OR reason LIKE '%sandbox probe%')`, c.id, kind);
      const single = c.declaration.executor.kind !== 'cli-chain';
      for (const task of this.store.tasks(c.id)) {
        const error = String(task.last_error ?? '');
        if (task.blocked || !(task.retry_at > now) ||
            !(error.startsWith('waiting for executor availability:') || single && error.startsWith('quota:'))) continue;
        this.store.patch('tasks', { campaign_id: c.id, task_id: task.task_id }, task.version, { retry_at: null, last_error: null }, now);
      }
      this.store.journal(c.id, 'provider-wait-cleared', { executor: kind, account: accountOf(this.config, kind), by }, now);
    }
    return true;
  }

  /** The first untimed account wait (a failed login, or a host finding that needs a recheck) on a provider of `decl`, or null. */
  untimedAccountWait(decl) {
    for (const { kind } of executorOrder(decl.executor)) {
      const wait = accountWait(this.store, this.config, kind);
      if (wait && wait.retry_at === null) return wait;
    }
    return null;
  }

  /**
   * Today's choice, as a routing receipt (router.mjs, static mode): the facts are observed here once and route() decides
   * from them alone. After a failed attempt the next eligible provider in the chain gets the task first; the one that
   * failed remains the fallback when it is the only eligible provider. Denials and rejections are not routed around:
   * this only reorders between providers the owner already authorized.
   */
  executorChoice(decl, task, now = this.now()) {
    const waits = this.store.all('SELECT * FROM executor_waits WHERE campaign_id = ?', decl.campaignId);
    const facts = (kind) => {
      const own = waits.find((item) => item.executor_kind === kind);
      if (!this.cmd[kind.replace('-cli', '')]?.length) {
        return { cliConfigured: false, cliRecheckAt: own?.retry_at > now ? own.retry_at : now + 15 * 60_000, hostUnavailable: null, wait: null };
      }
      // The later of this campaign's own wait and the account's wait (ADAPTIVE_SCHEDULER 4.5); an elapsed timed wait is none.
      const wait = laterWait(own, accountWait(this.store, this.config, kind));
      const active = wait && (wait.retry_at === null || wait.retry_at > now);
      return { cliConfigured: true, hostUnavailable: null, wait: active ? { retryAt: wait.retry_at, reason: wait.reason } : null };
    };
    const receipt = staticReceipt(receiptInputs({
      stage: task.state === 'implemented' ? 'verify' : 'implement', chain: decl.executor.kind === 'cli-chain',
      spec: specOf(this.store, decl.campaignId, task.task_id, decl), providers: executorOrder(decl.executor),
      platform: process.platform, facts, priorAttempts: this.priorAttempts(decl, task),
    }));
    const chosen = receipt.decision.chosen;
    return { executor: chosen ? executorOrder(decl.executor).find((provider) => provider.kind === chosen.kind) : null,
      retryAt: receipt.decision.retryAt, receipt };
  }

  async dispatch(ctx, campaign, task, kind, { admission = null } = {}) {
    const op = this.fenced(ctx, () => {
      const current = this.store.campaign(ctx.id);
      // The one-slot check, or with the scheduler the full admission predicate again, inside the transaction that
      // records the operation: two instances admitting at once serialise here (ADAPTIVE_SCHEDULER 4.1).
      const busy = admission ? Boolean(admission()) : this.store.openOperations(ctx.id).length > 0;
      if (current.control !== 'registered' || current.blocker || current.version !== campaign.version ||
          busy || campaignBudget(this.store, current).exhausted) return null;
      const decl = campaign.declaration;
      // The target project's own rules (governance provider governance inheritance), resolved from the registry exactly as the registration gate matches.
      // Without them no new worker starts: there is no default project to fall back to.
      let governance;
      try { governance = projectGovernance(decl.target.repository, this.governanceRoot); }
      catch (error) {
        this.raiseBlocker(ctx, decl, { kind: 'project-governance', class: 'B2',
          reason: `No new worker dispatched: the governance of ${decl.target.repository} cannot be resolved from the governance checkout (${error.code ? `${error.code}: ` : ''}${String(error.message).slice(0, 400)})`,
          requestedAction: `Make sure governanceRoot in the supervisor config.json names a current governance provider checkout in which exactly one registry/projects entry declares repository.github ${decl.target.repository}, then run: supervisor recheck ${ctx.id}` }, this.now());
        return null;
      }
      // A project and a config.json entry that disagree about this repository: B2, and nothing is dispatched (design 8.2).
      const checkout = resolveCheckout(this.store, this.config, decl.target.repository);
      if (checkout?.conflict) {
        this.raiseBlocker(ctx, decl, { kind: 'project-connection', class: 'B2', code: 'CONFIG_CONFLICT', reason: checkout.conflict.message,
          requestedAction: `Remove either the ${decl.target.repository} entry in the supervisor config.json or the project connection, then run: supervisor recheck ${ctx.id}` }, this.now());
        return null;
      }
      for (const provider of executorOrder(decl.executor)) {
        if (this.cmd[provider.kind.replace('-cli', '')]?.length) continue;
        const wait = this.store.get('SELECT * FROM executor_waits WHERE campaign_id = ? AND executor_kind = ?', ctx.id, provider.kind);
        if (!wait || wait.retry_at <= this.now()) {
          this.store.run('INSERT OR REPLACE INTO executor_waits (campaign_id, executor_kind, retry_at, reason) VALUES (?, ?, ?, ?)',
            ctx.id, provider.kind, this.now() + 15 * 60_000, 'unavailable: CLI command is not configured on this PC');
          if (!wait) this.store.journal(ctx.id, 'executor-unavailable', { executor: provider.kind, reason: 'CLI command is not configured on this PC' }, this.now());
        }
      }
      const choice = this.executorChoice(decl, task);
      if (!choice.executor) {
        const account = choice.retryAt ? null : this.untimedAccountWait(decl);
        if (choice.retryAt) this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, task.version,
          { retry_at: choice.retryAt, last_error: 'waiting for executor availability: all eligible providers are cooling down' }, this.now());
        // The account already waits for the owner; the campaign that found it raised the blocker. This one waits silently
        // and is due again as soon as a recheck or success ends the account's wait; the timer only bounds a re-read.
        else if (account) this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, task.version,
          { retry_at: this.now() + 15 * 60_000, last_error: `waiting for executor availability: the ${account.account} account waits for a recheck (${account.reason})` }, this.now());
        else this.raiseBlocker(ctx, decl, { kind: 'executors', class: 'B2', reason: 'No configured executor supports this task role',
          requestedAction: 'Configure an authorized native CLI command and scoped role support, then recheck the campaign.' }, this.now(),
        { identity: 'no-role-support' });
        return null;
      }
      const executor = choice.executor;
      const spec = specOf(this.store, ctx.id, task.task_id, decl);
      const repo = this.repo(decl);
      const seq = task.attempts + 1;
      const opId = `${ctx.id}.${task.task_id}.${kind}.${seq}`;
      let workspace;
      let revision;
      let targetSha = null;
      const repair = spec.deliverable === 'commit' ? this.publishedRepair(task) : null;
      const integration = repair?.id === 'integration-conflict' ? repair : null;
      const ci = repair?.id === 'ci-failure' ? repair : null;
      if (kind === 'implement') {
        let integrationBase;
        if (spec.requiresMergedDependencies) {
          const fetched = this.fetchBase(repo.path, decl.target.baseBranch);
          integrationBase = fetched.sha;
          const missing = !fetched.ok ? spec.dependsOn : this.missingIntegratedDependencies(decl, spec, this.store.tasks(ctx.id), integrationBase, repo.path);
          if (!/^[0-9a-f]{40}$/.test(integrationBase ?? '') || missing.length) {
            this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, task.version,
              { retry_at: this.now() + this.config.integrationPollMs, last_error: `dependency-integration: waiting for ${missing.join(', ')} in ${decl.target.baseBranch}${fetched.ok ? '' : ' (remote refresh unavailable)'}` }, this.now());
            return null;
          }
        }
        // An integration or CI repair continues the published branch: a missing worktree and branch are recreated at the verified head.
        const ws = gitA.prepareImplementWorkspace({ git: this.cmd.git, repoPath: repo.path, worktreeRoot: repo.worktreeRoot,
          campaignId: ctx.id, taskId: task.task_id, baseBranch: decl.target.baseBranch, baseSha: repair ? repair.verified : integrationBase });
        if (repair && !gitA.isAncestor({ git: this.cmd.git, path: ws.path, ancestor: repair.verified, descendant: ws.head })) {
          const prefix = ci ? 'ci' : 'integration';
          this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, task.version,
            { blocked: { class: 'stalled', reason: `Implementation workspace ${ws.head} does not contain the published verified head ${repair.verified}; preserve it and reconcile the branch before recheck.`, at: this.now() },
              last_error: `${prefix}-workspace: verified head absent` }, this.now());
          this.store.journal(ctx.id, `${prefix}-workspace-blocked`, { task: task.task_id }, this.now());
          return null;
        }
        if (spec.requiresMergedDependencies && this.missingIntegratedDependencies(decl, spec, this.store.tasks(ctx.id), ws.head, ws.path).length) {
          this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, task.version,
            { blocked: { class: 'stalled', reason: 'Existing implementation workspace lacks the integrated dependency revisions; preserve it and reconcile its base before recheck.', at: this.now() }, last_error: 'dependency-workspace: required integrated revisions absent' }, this.now());
          this.store.journal(ctx.id, 'integration-workspace-blocked', { task: task.task_id }, this.now());
          return null;
        }
        workspace = ws.path;
        revision = ws.head;
      } else {
        targetSha = task.head_sha;
        workspace = gitA.prepareVerifyWorkspace({ git: this.cmd.git, repoPath: repo.path, worktreeRoot: repo.worktreeRoot,
          campaignId: ctx.id, taskId: task.task_id, targetSha, attempt: seq }).path;
        revision = targetSha;
      }
      const baseSha = task.base_sha ?? revision;
      const role = kind === 'verify' ? 'verification' : 'implementer';
      const readOnly = kind === 'verify' || spec.deliverable === 'report';
      // A verifier reviews the implementer's report; a repair implementer must also receive the rejected report,
      // otherwise it is asked to fix findings against an artifact it has never seen.
      const repairing = kind === 'implement' && Boolean(task.findings?.length);
      const report = kind === 'verify' || repairing ? String(task.result?.report ?? '') : null;
      const reportDigest = report !== null ? createHash('sha256').update(report, 'utf8').digest('hex') : null;
      const findings = kind === 'implement' ? (task.findings ?? []).slice(0, 8)
        .map((finding) => `Blocking ${finding.id === 'integration-conflict' ? 'integration' : finding.id === 'ci-failure' ? 'CI' : 'verifier'} finding ${finding.id}: ${finding.description}`.slice(0, 2000)) : [];
      const packet = validatePacket({
        version: 1, tenantId: decl.target.tenantId, projectId: decl.target.projectId, environment: decl.target.environment,
        taskId: task.task_id, stageId: kind, runId: opId, role, revision,
        authorityDigest: authorityDigest(decl),
        access: readOnly ? 'read-only' : 'write',
        goal: `${spec.title} (${decl.target.repository}#${spec.issue}). ${spec.goal}`.slice(0, 2000),
        // A declared write domain is enforced on the commit, so the worker and its verifier are told it first.
        constraints: [...decl.constraints, ...(spec.constraints ?? []), ...(spec.writes ? [writeDomainConstraint(spec.writes)] : []), ...findings],
        acceptance: spec.acceptance,
        references: spec.references.map((path) => ({ path, revision })),
        governance,
      }, POLICY);
      const digest = packetDigest(packet, POLICY);
      const instructions = pendingInstructions(this.store, current, task.task_id, kind);
      const sessionId = randomUUID();
      const note = integration && kind === 'verify'
        ? `This head is an integration repair round: it must merge ${integration.base} (the current ${decl.target.baseBranch}) into the previously verified ${integration.verified} to resolve conflicts in ${integration.paths.join(', ')}. Check that both are ancestors of the target, review the resolution with git show --remerge-diff ${targetSha}, and run the full gate.`
        : integration && task.findings.length === 1
          ? `This is repair round ${task.repair_rounds}, an integration repair: the verified, published commit ${integration.verified} conflicts with ${decl.target.baseBranch} at ${integration.base} after a sibling merge. Merge that base into this branch, resolve the conflicts listed in the packet constraints, run the full gate, commit, and return resolved with the new headSha. Never rebase, reset or amend the verified commit.`
          : ci && kind === 'verify'
            ? `This head is a CI repair round: repository CI failed on the previously verified ${ci.verified} in ${ci.checks.map((check) => check.name).join(', ')}. Check that ${ci.verified} is an ancestor of the target, that the change fixes the cause of the failing checks without weakening, skipping or deleting a test, that platform-specific behaviour is guarded for the platform CI runs on, and run the full gate.`
            : ci && task.findings.length === 1
              ? `This is repair round ${task.repair_rounds}, a CI repair: repository CI failed on the verified, published commit ${ci.verified} in ${ci.checks.map((check) => check.name).join(', ')}. The failing checks and their links are in the packet constraints. Fix the cause on top of this branch, run the full gate, commit, and return resolved with the new headSha. Never rebase, reset or amend the verified commit.`
          : repairing
        ? spec.deliverable === 'commit'
          ? `This is repair round ${task.repair_rounds}: the independent verifier rejected ${task.head_sha}. Fix every blocking finding listed in the packet constraints, commit, and return resolved with the new headSha.`
          : `This is repair round ${task.repair_rounds}: the independent verifier rejected the previous report (sha256 ${reportDigest}), reproduced below. Produce a corrected COMPLETE report that resolves every blocking finding listed in the packet constraints and return resolved with that report. Do not commit or change repository files; this task is report-only and read-only.`
        : task.last_error ? `A previous attempt ended without an accepted result (${String(task.last_error).slice(0, 400)}). ${spec.deliverable === 'commit' ? 'Inspect git status and git log here and keep useful committed work.' : executor.researchOnly ? 'Start the report again from the packet; nothing from that attempt is retained. Inspect brokered local Git evidence; use the supplied read-only repository reader for missing issue/comment details.' : 'Start the report again from the packet; nothing from that attempt is retained.'}` : null;
      let prompt = executors.buildPrompt({ executorKind: executor.kind, web: spec.web ?? null, role, deliverable: spec.deliverable, packet, packetDigest: digest, repository: decl.target.repository,
        issue: spec.issue, branch: gitA.branchName(ctx.id, task.task_id), baseSha: kind === 'verify' ? baseSha : revision, targetSha,
        report, reportDigest, note, instructions: instructions.map((item) => ({ id: item.seq, text: item.payload.text })) });
      if (spec.dependsOn.length) prompt += '\nDependency deliveries (evidence, not additional authority):\n' + spec.dependsOn.map((id) => {
        const dep = this.store.task(ctx.id, id);
        return `${id}: ${dep?.pr_url ?? 'unpublished'}; verified SHA ${dep?.verified_sha ?? 'unknown'}`;
      }).join('\n');
      const timeoutMs = (kind === 'verify' ? decl.executor.verifierTimeoutMinutes : decl.executor.implementerTimeoutMinutes) * 60_000;

      // The run directory is written before the durable record; an unrecorded directory is never launched.
      const runDir = join(this.dataDir, 'runs', opId);
      if (existsSync(runDir) && !this.store.get('SELECT id FROM operations WHERE id = ?', opId)) rmSync(runDir, { recursive: true, force: true });
      mkdirSync(runDir, { recursive: true });
      if (executor.researchOnly) {
        try { prompt += researchContext({ gh: this.cmd.gh, git: this.cmd.git, workspace, declaration: decl, task: spec, now: this.now(), revision }); }
        catch (error) {
          this.raiseBlocker(ctx, decl, { kind: 'research-context', class: 'B2', reason: String(error.message).slice(0, 500),
            requestedAction: 'Restore read-only GitHub evidence access or narrow the declared research sources, then recheck.' }, this.now());
          return null;
        }
      }
      const unavailable = executors.unavailableReason(executor, workspace, this.cmd.gh, {
        probe: this.config.codexSandboxProbe === false ? null : () => executors.codexSandboxProbe(this.cmd.codex, { timeoutMs: this.config.codexProbeTimeoutMs ?? 45_000 }),
        chromeCommand: this.cmd.chrome, web: Boolean(spec.web),
      });
      if (unavailable) {
        // A sandbox/host failure may clear (another Codex session ends); a configuration finding waits for a recheck.
        const transient = /sandbox setup failed|sandbox probe/.test(unavailable);
        const until = transient ? this.now() + 20 * 60_000 : null;
        this.store.run('INSERT OR REPLACE INTO executor_waits (campaign_id, executor_kind, retry_at, reason) VALUES (?, ?, ?, ?)',
          ctx.id, executor.kind, until, unavailable);
        // Only the host's own sandbox failure belongs to the account; a finding about this project or task stays here.
        if (transient) setAccountWait(this.store, this.config, { kind: executor.kind, retryAt: until, reason: unavailable, campaignId: ctx.id, now: this.now() });
        this.store.journal(ctx.id, 'executor-unavailable', { executor: executor.kind, reason: unavailable }, this.now());
        return null;
      }
      // Project Claude tuning comes from the task base commit in the main checkout, never the worker-writable worktree.
      const settings = gitA.exec(this.cmd.git, ['show', `${baseSha}:.claude/settings.json`], { cwd: repo.path });
      const invocation = executors.prepare({ executor, command: this.cmd[executor.kind.replace('-cli', '')], role,
        deliverable: spec.deliverable, sessionId, digest, runDir, workspace, prompt,
        repository: decl.target.repository, ghCommand: this.cmd.gh, projectSettings: settings.ok ? settings.stdout : null,
        web: spec.web ?? null, chromeCommand: this.cmd.chrome, timeoutMs });
      writeFileSync(join(runDir, 'prompt.txt'), invocation.prompt, 'utf8');
      writeAtomic(join(runDir, 'spec.json'), JSON.stringify({
        argv: invocation.argv, ...(invocation.env ? { env: invocation.env } : {}),
        cwd: invocation.cwd ?? workspace, timeoutMs, heartbeatMs: this.config.heartbeatMs,
      }));

      const now = this.now();
      const c = this.store.campaign(ctx.id);
      const t = this.store.task(ctx.id, task.task_id);
      if (t.version !== task.version) return null;
      this.store.recordOperation({
        id: opId, campaign_id: ctx.id, task_id: task.task_id, kind, seq, idempotency_key: opId, lease_generation: ctx.generation,
        state: 'recorded', session_id: sessionId, run_dir: runDir, workspace, base_sha: revision, target_sha: targetSha,
        report_digest: reportDigest, packet, packet_digest: digest, outcome: null, created_at: now, updated_at: now,
        executor_kind: executor.kind, routing: choice.receipt,
      });
      this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, t.version,
        { attempts: seq, base_sha: baseSha, state: kind === 'implement' ? 'implementing' : 'verifying', retry_at: null }, now);
      this.store.patch('campaigns', { id: ctx.id }, c.version, { runs_used: c.runs_used + 1 }, now);
      this.store.journal(ctx.id, 'operation-recorded', { op: opId, kind, executor: executor.kind, model: choice.receipt.decision.chosen.model, session: sessionId, packetDigest: digest, generation: ctx.generation, run: c.runs_used + 1 }, now);

      // This checkpoint and admission decision commit together before launch.
      const plan = planContext({
        packet, authorityCurrent: true, predecessorSafe: true, session: null,
        checkpoint: { committed: true, packetDigest: digest, tenantId: packet.tenantId, projectId: packet.projectId, environment: packet.environment,
          taskId: packet.taskId, stageId: packet.stageId, revision: packet.revision, authorityDigest: packet.authorityDigest },
        budget: dispatchBudget(executor, role, prompt),
        capabilities: { freshSession: 'verified' }, replacementAttempts: 0, quarantinedSessions: 0, capacityAvailable: true,
      }, POLICY);
      if (plan.action !== 'start-fresh') {
        const c = this.store.campaign(ctx.id);
        const t = this.store.task(ctx.id, task.task_id);
        this.store.updateOperation(opId, { state: 'abandoned', outcome: { class: 'admission-blocked', detail: plan.reason } }, now);
        this.store.patch('campaigns', { id: ctx.id }, c.version, { runs_used: c.runs_used - 1 }, now);
        this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, t.version,
          { state: kind === 'implement' ? 'pending' : 'implemented', blocked: { class: 'stalled', reason: `admission blocked: ${plan.reason}`, at: now } }, now);
        return;
      }
      attachInstructions(this.store, instructions, opId, now);
      return this.store.get('SELECT * FROM operations WHERE id = ?', opId);
    });
    if (!op) return null;
    this.injectFault('after-record');
    await this.launch(ctx, op);
    return op;
  }

  async launch(ctx, op) {
    const child = this.fenced(ctx, () => {
      const current = this.store.get('SELECT * FROM operations WHERE id = ?', op.id);
      if (this.store.campaign(ctx.id).control !== 'registered' || current?.state !== 'recorded') return null;
      if (existsSync(join(op.run_dir, 'launch.json'))) return null;
      // shortcut: unknown spawn acceptance blocks recovery until an executor provides durable process acknowledgement.
      writeAtomic(join(op.run_dir, 'launch.json'), JSON.stringify({ operationId: op.id, at: this.now() }));
      return spawn(process.execPath, [RUNNER, op.run_dir], { detached: true, stdio: 'ignore', windowsHide: true });
    });
    if (!child) return;
    child.on('error', (error) => {
      this.log(`runner spawn for ${op.id} failed: ${error.message}`);
      if (!child.pid) writeAtomic(join(op.run_dir, 'result.json'), JSON.stringify({
        spawnError: String(error.code || error.message), containment: 'windows-job-v1', containmentStopped: true,
      }));
    });
    child.unref();
    const deadline = Date.now() + this.config.dispatchWaitMs;
    while (Date.now() < deadline && !existsSync(join(op.run_dir, 'runner.json'))) await sleep(50);
    this.injectFault('after-spawn');
    const confirmed = existsSync(join(op.run_dir, 'runner.json'));
    this.fenced(ctx, () => {
      this.store.updateOperation(op.id, { state: 'dispatched' }, this.now());
      this.store.journal(ctx.id, 'operation-dispatched', { op: op.id, runnerConfirmed: confirmed }, this.now());
    });
    this.log(`dispatched ${op.id} (session ${op.session_id})${confirmed ? '' : ' - runner not yet confirmed'}`);
  }

  async publish(ctx, campaign, task) {
    const decl = campaign.declaration;
    const spec = specOf(this.store, ctx.id, task.task_id, decl);
    const repo = this.repo(decl);
    const branch = gitA.branchName(ctx.id, task.task_id);
    const bodyFile = join(this.dataDir, 'runs', `${ctx.id}.${task.task_id}.publish.md`);
    try {
      this.fenced(ctx, () => {
        const current = this.store.campaign(ctx.id);
        const fresh = this.store.task(ctx.id, task.task_id);
        if (current.control !== 'registered' || fresh.state !== 'verified' || fresh.version !== task.version) return;
        let url;
        const repair = spec.deliverable === 'commit' ? this.publishedRepair(fresh) : null;
        const integration = repair?.id === 'integration-conflict' ? repair : null;
        const repairKind = integration ? 'integration' : 'ci';
        if (repair) {
          // aiworks#27, aiworks#42: the repaired head goes to the same branch and PR. The push is a plain fast-forward (the
          // earlier verified head is an ancestor), never a force-push; without an open PR nothing is pushed and no PR is opened.
          const key = `${ctx.id}:${task.task_id}:${repairKind}:${task.verified_sha}`;
          const comment = `${integration ? this.integrationBody(decl, spec, task, integration) : this.ciBody(decl, spec, task, repair)}\n\n${github.marker(key)}`;
          if (comment.length > BODY_LIMIT) {
            this.raiseBlocker(ctx, decl, { kind: 'publication-size', class: 'B2', reason: `The ${repairKind === 'ci' ? 'CI' : 'integration'} repair verification exceeds the GitHub comment limit; nothing was truncated or pushed.`,
              requestedAction: 'Provide an authorized publication format that preserves the verification, then recheck.' }, this.now(),
            { identity: task.task_id });
            return;
          }
          const existing = github.findOpenPullRequest({ gh: this.cmd.gh, repository: decl.target.repository, branch });
          if (!existing) {
            const now = this.now();
            this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, fresh.version, { retry_at: null,
              blocked: { class: 'stalled', reason: `${repairKind === 'ci' ? 'CI' : 'integration'} repair ${task.verified_sha} verified, but ${branch} has no open PR; nothing was pushed or opened`, at: now } }, now);
            this.store.journal(ctx.id, `${repairKind}-repair-unpublished`, { task: task.task_id, sha: task.verified_sha }, now);
            return;
          }
          gitA.pushVerified({ git: this.cmd.git, repoPath: repo.path, branch, sha: task.verified_sha });
          this.injectFault('after-push');
          url = existing.url;
          const prefix = `https://github.com/${decl.target.repository}/pull/`;
          const number = String(url).startsWith(prefix) ? /^(\d+)/.exec(String(url).slice(prefix.length))?.[1] : null;
          if (!number) throw new Error(`cannot post the ${repairKind} repair comment: no PR number in ${url}`);
          const target = { gh: this.cmd.gh, repository: decl.target.repository, issue: Number(number), key };
          if (!github.findMarkedComment(target)) github.postComment({ ...target, body: comment, bodyFile });
        } else if (spec.deliverable === 'commit') {
          // Over GitHub's body limit, the verification moves to its own marked PR comment: nothing is truncated.
          const split = this.prBody(decl, spec, task).length > BODY_LIMIT;
          const body = this.prBody(decl, spec, task, { verificationElsewhere: split });
          const verification = split ? this.verificationBody(decl, spec, task) : null;
          const vKey = `${ctx.id}:${task.task_id}:verification:${task.verified_sha}`;
          if (body.length > BODY_LIMIT || (verification && `${verification}\n\n${github.marker(vKey)}`.length > BODY_LIMIT)) {
            this.raiseBlocker(ctx, decl, { kind: 'publication-size', class: 'B2', reason: 'Even split into a PR body and a verification comment, the verified report exceeds the GitHub limit; nothing was truncated or published.',
              requestedAction: 'Provide an authorized publication format that preserves the verified report, then recheck.' }, this.now(),
            { identity: task.task_id });
            return;
          }
          gitA.pushVerified({ git: this.cmd.git, repoPath: repo.path, branch, sha: task.verified_sha });
          this.injectFault('after-push');
          url = github.openPullRequest({ gh: this.cmd.gh, repository: decl.target.repository, baseBranch: decl.target.baseBranch, branch,
            title: `${spec.id}: ${spec.title}`, body, bodyFile });
          if (verification) {
            const prefix = `https://github.com/${decl.target.repository}/pull/`;
            const number = String(url).startsWith(prefix) ? /^(\d+)/.exec(String(url).slice(prefix.length))?.[1] : null;
            if (!number) throw new Error(`cannot post the verification comment: no PR number in ${url}`);
            const target = { gh: this.cmd.gh, repository: decl.target.repository, issue: Number(number), key: vKey };
            if (!github.findMarkedComment(target)) github.postComment({ ...target, body: `${verification}\n\n${github.marker(vKey)}`, bodyFile });
          }
        } else {
          // Reconcile before posting: a crash after an accepted post must not post twice.
          const digest = createHash('sha256').update(String(task.result?.report ?? ''), 'utf8').digest('hex');
          const key = `${ctx.id}:${task.task_id}:report:${digest}`;
          const target = { gh: this.cmd.gh, repository: decl.target.repository, issue: spec.issue, key };
          // Over GitHub's comment limit, the verification goes in a second marked comment: nothing is truncated.
          const split = `${this.reportBody(decl, spec, task, digest)}\n\n${github.marker(key)}`.length > BODY_LIMIT;
          const body = `${this.reportBody(decl, spec, task, digest, { verificationElsewhere: split })}\n\n${github.marker(key)}`;
          const vTarget = { ...target, key: `${key}:verification` };
          const verification = split ? `${this.verificationBody(decl, spec, task)}\n\n${github.marker(vTarget.key)}` : null;
          if (body.length > BODY_LIMIT || (verification && verification.length > BODY_LIMIT)) {
            this.raiseBlocker(ctx, decl, { kind: 'publication-size', class: 'B2', reason: 'Even split into a report comment and a verification comment, the verified report exceeds the GitHub limit; nothing was truncated or posted.',
              requestedAction: 'Provide an authorized publication format that preserves the verified report, then recheck.' }, this.now(),
            { identity: task.task_id });
            return;
          }
          url = github.findMarkedComment(target);
          if (!url) {
            url = github.postComment({ ...target, body, bodyFile });
            this.injectFault('after-report-post');
          }
          if (!url) url = github.findMarkedComment(target);
          if (verification && !github.findMarkedComment(vTarget)) github.postComment({ ...vTarget, body: verification, bodyFile });
        }
        const now = this.now();
        this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, fresh.version,
          { state: 'done', pr_url: url, retry_at: null, last_error: null, ...(repair ? { findings: null } : {}) }, now);
        this.store.journal(ctx.id, 'published', { task: task.task_id, sha: task.verified_sha, url }, now);
        if (integration) this.store.journal(ctx.id, 'integration-repaired', { task: task.task_id, from: integration.verified, base: integration.base, sha: task.verified_sha, url }, now);
        else if (repair) this.store.journal(ctx.id, 'ci-repaired', { task: task.task_id, from: repair.verified, checks: repair.checks.map((check) => check.name), sha: task.verified_sha, url }, now);
        if (this.oi) this.probeSucceeded(ctx, task.task_id, { detail: `publication of ${task.verified_sha} succeeded` }, now);
        // With CI repair on, a published head is never announced as if its CI had passed (aiworks#42).
        const ciNote = this.ci && spec.deliverable === 'commit' ? ' CI on this head is not known yet; the supervisor reads it and reopens the task if it fails.' : '';
        this.enqueue(ctx.id, `${ctx.id}:${task.task_id}:published:${task.verified_sha}`, decl, (integration
          ? `**${task.task_id}** (#${spec.issue}) conflicted with ${decl.target.baseBranch} after a sibling merge. The supervisor merged the base, a fresh independent verification accepted \`${task.verified_sha}\`, and it is pushed to the same PR: ${url}. Not merged; merge follows ${decl.target.repository}'s release gate.`
          : repair
          ? `**${task.task_id}** (#${spec.issue}) failed CI at \`${repair.verified}\`. A repair round fixed it, a fresh independent verification accepted \`${task.verified_sha}\`, and it is pushed to the same PR: ${url}. Not merged; merge follows ${decl.target.repository}'s release gate.`
          : spec.deliverable === 'commit'
          ? `**${task.task_id}** (#${spec.issue}) passed independent verification and is published for review: ${url} at \`${task.verified_sha}\`. Not merged; merge follows ${decl.target.repository}'s release gate.`
          : `**${task.task_id}** (#${spec.issue}) passed independent verification; the verified report is posted: ${url} (revision \`${task.verified_sha}\`).`) + ciNote, now);
        this.log(`published ${task.task_id}: ${url}`);
      });
    } catch (error) {
      if (error instanceof FencedError) throw error;
      this.log(`publish ${task.task_id} failed: ${error.message}`);
      this.fenced(ctx, () => {
        const t = this.store.task(ctx.id, task.task_id), now = this.now();
        // A rate-limit refusal with a reset time waits until that reset; any other failure retries after publishRetryMs.
        const reset = error instanceof github.RateLimitError && Number.isFinite(error.resetAt)
          ? Math.min(Math.max(error.resetAt, now), now + RATE_LIMIT_MAX_WAIT_MS) + this.config.rateLimitMarginMs : null;
        const detail = String(error.message).slice(0, 500);
        this.store.patch('tasks', { campaign_id: ctx.id, task_id: task.task_id }, t.version, reset
          ? { retry_at: reset, last_error: `publish: GitHub rate limit; waiting until ${new Date(reset).toISOString()}: ${detail}` }
          : { retry_at: now + this.config.publishRetryMs, last_error: `publish: ${detail}` }, now);
        if (reset) this.store.journal(ctx.id, 'publish-rate-limited', { task: task.task_id, retryAt: reset }, now);
      });
    }
  }

  verificationLines(task) {
    const v = task.verification ?? {};
    const checks = (v.checks ?? []).map((check) => `- \`${check.command}\`: ${check.result}${check.detail ? ` - ${check.detail}` : ''}`);
    const notes = (v.findings ?? []).filter((f) => f.severity !== 'blocking').map((f) => `- ${f.id}: ${f.description}`);
    return [v.summary ?? '', ...(checks.length ? ['', 'Checks:', ...checks] : []), ...(notes.length ? ['', 'Non-blocking findings:', ...notes] : [])];
  }

  /** The independent verification alone, for publication split over GitHub's body limit. */
  verificationBody(decl, spec, task) {
    return [
      `## ${spec.id}: independent verification`,
      '',
      `Campaign \`${decl.campaignId}\`, revision \`${task.verified_sha}\`. Continues the verified report above, which was too long for one GitHub body together with its verification.`,
      '',
      ...this.verificationLines(task),
      '',
      'Generated by the AIWorks delivery supervisor.',
    ].join('\n');
  }

  /** PR comment for a repaired head pushed to an already open PR (aiworks#27). */
  integrationBody(decl, spec, task, integration) {
    return [
      `## ${spec.id}: integration repair, independently verified`,
      '',
      `The verified commit \`${integration.verified}\` stopped merging into \`${decl.target.baseBranch}\` at \`${integration.base}\` after a sibling merge. Conflicting paths: ${integration.paths.map((path) => `\`${path}\``).join(', ')}.`,
      '',
      `The base was merged into this branch and the conflicts resolved. A separate fresh verifier session accepted exactly \`${task.verified_sha}\`, which was pushed here as a fast-forward: \`${integration.verified}\` stays an ancestor.`,
      '',
      ...this.verificationLines(task),
      '',
      `Not merged and not deployed: merge and release follow ${decl.target.repository}'s release gate. Generated by the AIWorks delivery supervisor.`,
    ].join('\n');
  }

  /** PR comment for a CI repair pushed to its already open PR (aiworks#42). */
  ciBody(decl, spec, task, repair) {
    return [
      `## ${spec.id}: CI repair, independently verified`,
      '',
      `Repository CI failed on the verified commit \`${repair.verified}\`. Failing checks: ${repair.checks.map((check) => `\`${check.name}\` (${check.conclusion})`).join(', ')}.`,
      '',
      `A repair round fixed it on this branch. A separate fresh verifier session accepted exactly \`${task.verified_sha}\`, which was pushed here as a fast-forward: \`${repair.verified}\` stays an ancestor. CI on this head is not known yet; the supervisor reads it again.`,
      '',
      ...this.verificationLines(task),
      '',
      `Not merged and not deployed: merge and release follow ${decl.target.repository}'s release gate. Generated by the AIWorks delivery supervisor.`,
    ].join('\n');
  }

  reportBody(decl, spec, task, digest, { verificationElsewhere = false } = {}) {
    return [
      `## ${spec.id}: ${spec.title} (independently verified report)`,
      '',
      `Campaign \`${decl.campaignId}\` (#${decl.target.trackingIssue}), AIWorks supervisor (AIWorks). Revision \`${task.verified_sha}\`, report sha256 \`${digest}\`.`,
      '',
      String(task.result?.report ?? ''),
      '',
      '### Independent verification',
      '',
      ...(verificationElsewhere ? ['Accepted. The full independent verification is posted as a separate supervisor comment on this issue (split to stay within the GitHub body limit).'] : this.verificationLines(task)),
      '',
      'Generated by the AIWorks delivery supervisor.',
    ].join('\n');
  }

  prBody(decl, spec, task, { verificationElsewhere = false } = {}) {
    return [
      `## ${spec.id}: ${spec.title}`,
      '',
      `Refs #${spec.issue}. Campaign \`${decl.campaignId}\` (parent plan #${decl.target.trackingIssue}), run by the AIWorks supervisor (AIWorks).`,
      '',
      `**Verified commit:** \`${task.verified_sha}\`. A separate fresh verifier session accepted exactly this SHA; the branch was pushed at that SHA.`,
      '',
      '### Implementer report',
      '',
      String(task.result?.report ?? ''),
      '',
      '### Independent verification',
      '',
      ...(verificationElsewhere ? ['Accepted. The full independent verification is posted as a separate supervisor comment on this PR (split to stay within the GitHub body limit).'] : this.verificationLines(task)),
      '',
      '### Gate',
      '',
      `Opened by the supervisor after independent verification. Not merged and not deployed: merge and release follow ${decl.target.repository}'s release gate.`,
      '',
      'Generated by the AIWorks delivery supervisor.',
    ].join('\n');
  }

  refreshStatus(ctx) {
    this.fenced(ctx, () => {
      const now = this.now();
      const c = this.store.campaign(ctx.id);
      const decl = c.declaration;
      const tasks = this.store.tasks(ctx.id);
      const open = this.store.openOperations(ctx.id);
      const spec = specsOf(this.store, ctx.id, decl);
      const done = new Set(tasks.filter((task) => task.state === 'done').map((task) => task.task_id));
      // A cancelled child task (WORK_ENVELOPE 6.4) is settled: it never runs and keeps no campaign open.
      const waiting = tasks.filter((task) => !['done', 'cancelled'].includes(task.state));
      const blockedTasks = waiting.filter((task) => task.blocked);
      const held = this.heldTasks(ctx.id);
      const runnable = waiting.filter((task) => !task.blocked && !held.has(task.task_id) && RUNNABLE.includes(task.state) &&
        spec.get(task.task_id).dependsOn.every((dep) => done.has(dep)) && (task.state === 'verified' || !c.blocker));
      let status = c.status;
      let control = c.control;
      let nextAction = null;
      let wakeup = null;
      if (!waiting.length) {
        status = 'ready';
        control = 'finished';
        const reportsOnly = decl.tasks.every((task) => task.deliverable === 'report');
        nextAction = reportsOnly ? `Planning reports published in ${decl.target.repository}; review recommendations before assigning implementation.`
          : `Release gate: review campaign deliveries under ${decl.target.repository}'s own merge and release policy.`;
        this.enqueue(ctx.id, `${ctx.id}:ready`, decl, `Campaign \`${ctx.id}\` (${decl.target.repository}): all ${tasks.length} tasks passed independent verification and their declared deliverables are published. Status \`ready\`; nothing was merged or deployed.`, now);
      } else if (c.blocker) {
        status = STATUS_FOR[c.blocker.class] ?? 'blocked-external';
        nextAction = c.blocker.requestedAction;
      } else if (open.length) {
        // Every open operation is named; the campaign is `verifying` only while all of them verify (ADAPTIVE_SCHEDULER row 5).
        status = open.every((op) => op.kind === 'verify') ? 'verifying' : 'active';
        nextAction = open.map((op) => `${op.kind} ${op.task_id} running (operation ${op.id}, session ${op.session_id})`).join('; ').slice(0, 1000);
        wakeup = c.next_wakeup_at && c.next_wakeup_at > now ? c.next_wakeup_at : now + this.config.pollMs;
      } else if (c.control === 'paused') {
        nextAction = 'Paused by the owner; start the campaign again to resume.';
      } else if (runnable.length) {
        const hold = c.declaration.executor.kind === 'cli-chain' || runnable.some((task) => task.state === 'verified') ? 0
          : Math.max(quotaHoldUntil(tasks, now), this.accountHoldUntil(c.declaration.executor.kind, now));
        const due = Math.max(hold, Math.min(...runnable.map((task) => task.retry_at ?? now)));
        status = 'active';
        nextAction = hold ? `waiting for the provider usage reset at ${new Date(hold).toISOString()}; no dispatch before then`
          : due > now ? `retry ${runnable[0].task_id} after backoff (${runnable[0].last_error ?? 'wait'})`.slice(0, 1000) : `dispatch ${runnable[0].task_id}`;
        wakeup = Math.max(due, now);
      } else if (blockedTasks.length) {
        status = blockedTasks.some((task) => task.blocked.class === 'B3') ? 'blocked-owner-decision' : 'blocked-child';
        nextAction = `${blockedTasks.map((task) => `${task.task_id}: ${task.blocked.reason}`).join(' | ')}; run recheck after recovery`.slice(0, 1000);
      } else if (held.size) {
        status = 'blocked-child';
        nextAction = `${[...held].join(', ')} held until blocker recheck evidence passes`;
      }
      // Liveness: a nonterminal campaign needs executable work, a durable wakeup, or an explicit pause/blocker.
      const defect = control === 'registered' && !open.length && !wakeup && !c.blocker && !blockedTasks.length && !held.size ? 1 : 0;
      if (defect && !c.liveness_defect) this.store.journal(ctx.id, 'liveness-defect', { tasks: waiting.map((task) => [task.task_id, task.state]) }, now);
      const changes = { status, control, next_action: nextAction, next_wakeup_at: wakeup, liveness_defect: defect };
      if (Object.entries(changes).some(([key, value]) => c[key] !== value)) this.store.patch('campaigns', { id: ctx.id }, c.version, changes, now);
    });
  }

  // ---- aiworks#1 owner-intervention core. Every method below runs inside a fenced transaction and only when enabled. ----

  /** Tasks that wait on an open or rechecking blocker; a rechecking blocker's single probe task is not held. */
  heldTasks(campaignId) {
    if (!this.oi) return new Set();
    const rows = this.store.all(`SELECT p.task_id, b.status, b.probe FROM blocker_parents p JOIN blockers b ON b.fingerprint = p.fingerprint
      WHERE p.campaign_id = ? AND p.released_at IS NULL AND b.status IN ('open', 'rechecking')`, campaignId);
    const probing = new Set(rows.filter((row) => row.status === 'rechecking' && row.probe?.campaignId === campaignId).map((row) => row.probe.taskId));
    return new Set(rows.map((row) => row.task_id).filter((id) => !probing.has(id)));
  }

  deterministic(dependency) { return typeof this.probes[dependency] === 'function' || DETERMINISTIC_PROBES.has(dependency); }

  /** A deterministic recheck result `{ pass, evidence }`, or null when the evidence needs a probe run. */
  probeOf(ctx, record) {
    try {
      if (typeof this.probes[record.dependency] === 'function') {
        return this.probes[record.dependency]({ campaignId: ctx.id,
          record: { fingerprint: record.fingerprint, dependency: record.dependency, class: record.class, subject: record.subject } });
      }
      if (record.dependency === 'budget') {
        const budget = campaignBudget(this.store, this.store.campaign(ctx.id));
        return { pass: !budget.exhausted, evidence: budget.exhausted ?? `budget available (${budget.runsUsed} runs used)` };
      }
      if (record.dependency === 'runtime-not-merged') {
        const reason = this.unmergedRevision();
        return { pass: !reason, evidence: reason ?? 'the supervisor code revision is an ancestor of origin/main' };
      }
      if (record.dependency === 'process-ownership') {
        const open = this.store.openOperations(ctx.id).some((op) => op.id === record.subject);
        return { pass: !open, evidence: open ? `operation ${record.subject} still has unresolved process ownership` : `operation ${record.subject} is no longer open` };
      }
    } catch (error) {
      return { pass: false, evidence: `probe failed: ${error.message}` };
    }
    return null;
  }

  /**
   * Create or deduplicate the durable record behind a B2-B5 blocker (OWNER_INTERVENTION §6-§7). The same
   * fingerprint while open or rechecking is one record and one notification; a recurrence while rechecking is a
   * failed recheck. A recurrence after resolution opens a new episode with its own notification. B0/B1: null.
   */
  openBlocker(ctx, decl, { dependency, cls, identity, summary, requestedAction = null, subject = null, parents, scope }, now) {
    if (!OWNER_CLASSES.has(cls)) return null;
    const project = decl.target.projectId, environment = decl.target.environment;
    const fingerprint = blockerFingerprint({ project, environment, dependency, blockerClass: cls, identity });
    const existing = this.store.blocker(fingerprint);
    const timed = this.deterministic(dependency);
    const action = requestedAction ? redact(requestedAction) : null;
    let notify = false;
    if (!existing) {
      this.store.insert('blockers', { fingerprint, project, environment, dependency, class: cls, identity: redact(identity, 300), subject,
        status: 'open', episode: 1, summary: redact(summary), requested_action: action,
        recheck_procedure: RECHECK_PROCEDURE[dependency] ?? 'Run the held task once; a structured result is the evidence.',
        first_detected_at: now, last_seen_at: now, occurrences: 1, recheck_attempts: 0,
        next_recheck_at: timed ? nextRecheckAt(cls, 0, now) : null, reminders: 0, updated_at: now });
      notify = true;
      this.store.journal(ctx.id, 'blocker-opened', { fingerprint, class: cls, dependency }, now);
    } else if (existing.status === 'resolved') {
      this.store.run(`UPDATE blockers SET status = 'open', episode = episode + 1, summary = ?, requested_action = ?, probe = NULL,
        last_seen_at = ?, occurrences = occurrences + 1, recheck_attempts = 0, next_recheck_at = ?, acknowledged_at = NULL,
        resolution = NULL, resolved_at = NULL, last_notified_at = NULL, reminders = 0, updated_at = ? WHERE fingerprint = ?`,
      redact(summary), action, now, timed ? nextRecheckAt(cls, 0, now) : null, now, fingerprint);
      notify = true;
      this.store.journal(ctx.id, 'blocker-reopened', { fingerprint, class: cls, dependency, episode: existing.episode + 1 }, now);
    } else {
      const failed = existing.status === 'rechecking';
      const attempts = existing.recheck_attempts + (failed ? 1 : 0);
      const evidence = failed ? { trigger: existing.probe?.trigger ?? null, probe: 'run', pass: false,
        detail: 'the same failure recurred during the recheck run', at: now } : existing.last_evidence;
      this.store.run(`UPDATE blockers SET status = 'open', summary = ?, probe = NULL, last_seen_at = ?, occurrences = occurrences + 1,
        recheck_attempts = ?, next_recheck_at = ?, last_evidence = ?, updated_at = ? WHERE fingerprint = ?`,
      redact(summary), now, attempts, failed && timed ? nextRecheckAt(cls, attempts, now) : existing.next_recheck_at, evidence, now, fingerprint);
      this.store.journal(ctx.id, failed ? 'blocker-recheck-failed' : 'blocker-deduplicated', { fingerprint, class: cls, dependency }, now);
    }
    for (const task of parents) {
      this.store.run(`INSERT INTO blocker_parents (fingerprint, campaign_id, task_id, phase, scope, attached_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (fingerprint, campaign_id, task_id) DO UPDATE SET phase = excluded.phase, scope = excluded.scope, released_at = NULL`,
      fingerprint, ctx.id, task.task_id, task.state, scope, now);
    }
    const record = this.store.blocker(fingerprint);
    if (notify) this.recordNotification(ctx, decl, record, 'initial', now);
    return this.store.blocker(fingerprint);
  }

  /** Outbox entry for what the owner would be told (§8, §10). The key makes repeats of the same notice no-ops. */
  recordNotification(ctx, decl, record, kind, now) {
    const parents = this.store.all('SELECT campaign_id, task_id FROM blocker_parents WHERE fingerprint = ? AND released_at IS NULL ORDER BY campaign_id, task_id', record.fingerprint);
    const key = `${record.fingerprint}:${record.episode}:${kind}`;
    const message = ownerMessage({ record, kind, parents, repository: decl.target.repository, trackingIssue: decl.target.trackingIssue,
      tried: RECOVERY_TRIED[record.dependency] });
    const info = this.store.run(`INSERT OR IGNORE INTO owner_notifications (key, fingerprint, campaign_id, kind, class, message, state, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`, key, record.fingerprint, ctx.id, kind, record.class, message, now, now);
    if (!info.changes) return;
    this.store.run('UPDATE blockers SET last_notified_at = ?, reminders = ? WHERE fingerprint = ?',
      now, kind.startsWith('reminder-') ? Number(kind.slice('reminder-'.length)) : 0, record.fingerprint);
    this.store.journal(ctx.id, 'owner-notification-recorded', { key, class: record.class, kind }, now);
  }

  releaseParents(ctx, record, now) {
    const rows = this.store.all('SELECT task_id, phase FROM blocker_parents WHERE fingerprint = ? AND campaign_id = ? AND released_at IS NULL', record.fingerprint, ctx.id);
    if (!rows.length) return;
    this.store.run('UPDATE blocker_parents SET released_at = ? WHERE fingerprint = ? AND campaign_id = ? AND released_at IS NULL', now, record.fingerprint, ctx.id);
    // Tasks keep their state while held, so each resumes in the phase it was blocked in (§11).
    this.store.journal(ctx.id, 'parents-resumed', { fingerprint: record.fingerprint, tasks: rows.map((row) => [row.task_id, row.phase]) }, now);
  }

  /** Close a blocker on passing evidence only, release this campaign's parents and record the resolution. */
  resolveBlocker(ctx, record, evidence, now) {
    this.store.run(`UPDATE blockers SET status = 'resolved', resolution = ?, last_evidence = ?, resolved_at = ?, probe = NULL,
      next_recheck_at = NULL, updated_at = ? WHERE fingerprint = ?`, evidence, evidence, now, now, record.fingerprint);
    this.store.journal(ctx.id, 'blocker-resolved', { fingerprint: record.fingerprint, class: record.class, dependency: record.dependency, evidence }, now);
    this.releaseParents(ctx, record, now);
    const c = this.store.campaign(ctx.id);
    if (c.blocker?.fingerprint === record.fingerprint) this.store.patch('campaigns', { id: ctx.id }, c.version, { blocker: null }, now);
    this.enqueue(ctx.id, `${ctx.id}:blocker:${record.fingerprint}:${record.episode}:resolved`, c.declaration,
      `Blocker \`${record.fingerprint.slice(0, 12)}\` (${record.class}, ${record.dependency}) resolved after recheck evidence: ${evidence.detail}. Held tasks resume in the phase they were blocked in.`, now);
  }

  /**
   * Owner Recheck/Done or a due timer. A deterministic probe decides at once; otherwise one held parent task is
   * released as the probe run and the others stay held until its evidence arrives. Acknowledgement never gets here.
   */
  recheckBlocker(ctx, record, trigger, now) {
    const result = this.probeOf(ctx, record);
    if (result) {
      const evidence = { trigger, probe: 'deterministic', pass: result.pass === true, detail: redact(result.evidence ?? ''), at: now };
      if (evidence.pass) { this.resolveBlocker(ctx, record, evidence, now); return; }
      const attempts = record.recheck_attempts + 1;
      this.store.run('UPDATE blockers SET last_evidence = ?, recheck_attempts = ?, next_recheck_at = ?, updated_at = ? WHERE fingerprint = ?',
        evidence, attempts, nextRecheckAt(record.class, attempts, now), now, record.fingerprint);
      this.store.journal(ctx.id, 'blocker-recheck-failed', { fingerprint: record.fingerprint, trigger, detail: evidence.detail }, now);
      return;
    }
    // A timer never spends a worker run.
    if (trigger === 'timer') { this.store.run('UPDATE blockers SET next_recheck_at = NULL WHERE fingerprint = ?', record.fingerprint); return; }
    const tasks = this.store.tasks(ctx.id);
    const done = new Set(tasks.filter((task) => task.state === 'done').map((task) => task.task_id));
    const spec = specsOf(this.store, ctx.id);
    const parents = new Set(this.store.all('SELECT task_id FROM blocker_parents WHERE fingerprint = ? AND campaign_id = ? AND released_at IS NULL',
      record.fingerprint, ctx.id).map((row) => row.task_id));
    const probe = tasks.find((task) => parents.has(task.task_id) && RUNNABLE.includes(task.state) && !task.blocked &&
      spec.get(task.task_id).dependsOn.every((dep) => done.has(dep)));
    if (!probe) {
      const evidence = { trigger, probe: 'run', pass: false, detail: 'no runnable held task can carry the recheck run', at: now };
      this.store.run('UPDATE blockers SET last_evidence = ?, updated_at = ? WHERE fingerprint = ?', evidence, now, record.fingerprint);
      this.store.journal(ctx.id, 'blocker-recheck-failed', { fingerprint: record.fingerprint, trigger, detail: evidence.detail }, now);
      return;
    }
    this.store.run("UPDATE blockers SET status = 'rechecking', probe = ?, updated_at = ? WHERE fingerprint = ?",
      { campaignId: ctx.id, taskId: probe.task_id, trigger, at: now }, now, record.fingerprint);
    const c = this.store.campaign(ctx.id);
    if (c.blocker?.fingerprint === record.fingerprint) this.store.patch('campaigns', { id: ctx.id }, c.version, { blocker: null }, now);
    this.store.journal(ctx.id, 'blocker-rechecking', { fingerprint: record.fingerprint, task: probe.task_id, trigger }, now);
  }

  /** The probe run for a rechecking blocker got past the failure: that is the recovery evidence. */
  probeSucceeded(ctx, taskId, { operation = null, detail }, now) {
    for (const record of this.store.all("SELECT * FROM blockers WHERE status = 'rechecking'")) {
      if (record.probe?.campaignId !== ctx.id || record.probe?.taskId !== taskId) continue;
      this.resolveBlocker(ctx, record, { trigger: record.probe.trigger, probe: 'run', pass: true, detail: redact(detail),
        ...(operation ? { operation } : {}), at: now }, now);
    }
  }

  /** Per tick: adopt resolutions proven by another campaign, run due timer rechecks and record due reminders. */
  ownerInterventionTick(ctx) {
    this.fenced(ctx, () => {
      const now = this.now();
      const c = this.store.campaign(ctx.id);
      const mine = (status) => this.store.all(`SELECT DISTINCT b.* FROM blockers b JOIN blocker_parents p ON p.fingerprint = b.fingerprint
        WHERE p.campaign_id = ? AND p.released_at IS NULL AND b.status = ? ORDER BY b.first_detected_at`, ctx.id, status);
      const shared = c.blocker?.fingerprint ? this.store.blocker(c.blocker.fingerprint) : null;
      if (shared?.status === 'resolved') {
        this.store.patch('campaigns', { id: ctx.id }, c.version, { blocker: null }, now);
        this.store.journal(ctx.id, 'blocker-resumed', { fingerprint: shared.fingerprint, resolution: shared.resolution }, now);
      }
      for (const record of mine('resolved')) this.releaseParents(ctx, record, now);
      for (const record of mine('open')) {
        if (record.next_recheck_at !== null && record.next_recheck_at <= now) this.recheckBlocker(ctx, record, 'timer', now);
      }
      for (const record of mine('open')) {
        const reminder = reminderDue(record, now);
        if (reminder) this.recordNotification(ctx, c.declaration, record, `reminder-${reminder}`, now);
      }
    });
  }

  /**
   * Hand pending owner notifications to the transport, only when `ownerIntervention.deliver` is set and a live
   * transport was injected. The attempt is counted before the effect, so a crash retries with the same key
   * (at-least-once); the transport deduplicates by key. Failures back off and stop after MAX_NOTIFY_ATTEMPTS.
   */
  async drainOwnerNotifications() {
    if (!this.oi || this.config.ownerIntervention?.deliver !== true || this.notifier?.live !== true) return;
    const now = this.now();
    const items = [...this.held.keys()].flatMap((id) => this.store.all(
      "SELECT * FROM owner_notifications WHERE campaign_id = ? AND state = 'pending' ORDER BY created_at LIMIT 5", id))
      .filter((item) => item.attempts === 0 || now - item.updated_at >= this.config.outboxRetryMs * item.attempts);
    for (const item of items) {
      const ctx = { id: item.campaign_id, generation: this.held.get(item.campaign_id) };
      try {
        const claimed = this.fenced(ctx, () => {
          if (this.store.get('SELECT state FROM owner_notifications WHERE key = ?', item.key)?.state !== 'pending') return false;
          this.store.run('UPDATE owner_notifications SET attempts = attempts + 1, updated_at = ? WHERE key = ?', this.now(), item.key);
          return true;
        });
        if (!claimed) continue;
        let receipt = null;
        let failure = null;
        try { receipt = await this.notifier.send({ key: item.key, message: item.message }); } catch (error) { failure = error; }
        this.fenced(ctx, () => {
          const at = this.now();
          if (!failure && receipt?.delivered === true) {
            this.store.run("UPDATE owner_notifications SET state = 'delivered', delivered_at = ?, last_error = NULL, updated_at = ? WHERE key = ?", at, at, item.key);
            this.store.journal(item.campaign_id, 'owner-notification-delivered', { key: item.key, transport: this.notifier.name }, at);
            return;
          }
          const detail = redact(failure ? failure.message : `not delivered: ${receipt?.receipt ?? 'no receipt'}`, 300);
          const state = item.attempts + 1 >= MAX_NOTIFY_ATTEMPTS ? 'failed' : 'pending';
          this.store.run('UPDATE owner_notifications SET state = ?, last_error = ?, updated_at = ? WHERE key = ?', state, detail, at, item.key);
          if (state === 'failed') this.store.journal(item.campaign_id, 'owner-notification-failed', { key: item.key, detail }, at);
        });
        if (failure) this.log(`owner notification ${item.key}: ${redact(failure.message, 300)}`);
      } catch (error) {
        if (!(error instanceof FencedError)) throw error;
        this.log(`owner notification ${item.key}: ${error.message}`);
      }
    }
  }

  enqueue(campaignId, key, decl, body, now) {
    if (this.config.github?.comments === false) return;
    this.store.run("INSERT OR IGNORE INTO outbox (key, campaign_id, target, body, state, attempts, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?)",
      key, campaignId, `${decl.target.repository}#${decl.target.trackingIssue}`, body, now);
  }

  /** At-least-once GitHub notes, reconciled by an embedded marker before any repost. */
  async drainOutbox() {
    const now = this.now();
    const items = [...this.held.keys()].flatMap((id) => this.store.all(
      "SELECT * FROM outbox WHERE campaign_id = ? AND state = 'pending' ORDER BY updated_at LIMIT 5", id))
      .filter((item) => item.attempts === 0 || now - item.updated_at >= this.config.outboxRetryMs * item.attempts);
    for (const item of items) {
      const [repository, issue] = item.target.split('#');
      try {
        this.fenced({ id: item.campaign_id, generation: this.held.get(item.campaign_id) }, () => {
          if (this.store.get('SELECT state FROM outbox WHERE key = ?', item.key)?.state !== 'pending') return;
          if (github.findMarkedComment({ gh: this.cmd.gh, repository, issue, key: item.key })) {
            this.store.run("UPDATE outbox SET state = 'posted', posted = 'reconciled', updated_at = ? WHERE key = ?", now, item.key);
            return;
          }
          this.store.run('UPDATE outbox SET attempts = attempts + 1, updated_at = ? WHERE key = ?', now, item.key);
          const url = github.postComment({ gh: this.cmd.gh, repository, issue, body: `${item.body}\n\n${github.marker(item.key)}`,
            bodyFile: join(this.dataDir, 'runs', 'outbox.md') });
          this.store.run("UPDATE outbox SET state = 'posted', posted = ?, updated_at = ? WHERE key = ?", url ?? 'posted', this.now(), item.key);
        });
      } catch (error) {
        if (!(error instanceof FencedError)) {
          try {
            this.fenced({ id: item.campaign_id, generation: this.held.get(item.campaign_id) }, () =>
              this.store.run("UPDATE outbox SET attempts = attempts + 1, updated_at = ? WHERE key = ? AND state = 'pending'", this.now(), item.key));
          } catch (leaseError) {
            if (!(leaseError instanceof FencedError)) throw leaseError;
          }
        }
        this.log(`outbox ${item.key}: ${error.message}`);
      }
    }
  }
}
