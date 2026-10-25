// AIWorks rebuild (`npm run rebuild`, docs/SUPERVISOR.md section 6, "Rebuild"): the upgrade procedure of AGENTS.md as
// one resumable command. It checks everything before it changes anything, pauses the running campaigns, lets every open
// run finish and be recorded, stops the supervisor and dashboard and proves they exited, backs up the drained store,
// installs the exact trusted revision with its locked dependencies, checks it, starts it, compares the preserved state
// and resumes only the campaigns this invocation paused, under their identical registered declaration.
// Every step is recorded in a private state file under <data>/rebuild before or after it acts, so running the same
// command again after a failure or a crash continues from the first step not finished, never repeats one that finished,
// and never resumes a campaign it did not pause. External commands come from `services` (scripts/supervisor/rebuild.mjs
// runs them hidden through ProcessStartInfo); this module only reads and writes the store and the private files.
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { campaignPause, campaignStart } from './api.mjs';
import { authorityDigest, canonicalJson } from './campaign.mjs';
import { writeAtomic } from './proc.mjs';
import { selfHostingSettings } from './self-hosting.mjs';
import { Store } from './store.mjs';

export class RebuildError extends Error {
  constructor(code, message) { super(message); this.name = 'RebuildError'; this.code = code; }
}

const SHA = /^[0-9a-f]{40}$/;
// The steps in order; state.phase is the last one finished. 'draining' covers pause, drain and stop, which repeat safely.
const PHASES = ['draining', 'stopped', 'backed-up', 'installed', 'started', 'resumed'];
const TAIL = 4000;
const digest = (value) => createHash('sha256').update(canonicalJson(value ?? null), 'utf8').digest('hex');

/**
 * The installation an AIWorks root holds (docs/SUPERVISOR.md section 6). Everything the rebuild writes is under <data>/rebuild,
 * except the installation's runtime maintenance lock, which every session maintaining the runtime takes.
 */
export function installationPaths(root) {
  const data = join(root, '.local', 'supervisor');
  const dir = join(data, 'rebuild');
  return { root, data, runtime: join(root, '.local', 'runtime'), cli: join(root, '.local', 'runtime', 'src', 'supervisor', 'cli.mjs'),
    db: join(data, 'supervisor.db'), config: join(data, 'config.json'), stop: join(data, 'STOP'), dir, state: join(dir, 'state.json'),
    lock: join(root, '.local', 'runtime-maintenance.lock') };
}

/** The pause reason that marks a campaign as paused by this invocation, and by nothing else. */
export const pauseReason = (id) => `AIWorks rebuild ${id}: paused for maintenance; npm run rebuild resumes it`;

const hasTable = (store, name) => Boolean(store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", name));

/**
 * Work still open in the store: campaign runs (workers, verifiers, repairs, browser runs), coordinator and planning runs,
 * and release steps started without an outcome. None may be open when the runtime is replaced.
 */
export function openWork(store) {
  const open = store.all("SELECT campaign_id, task_id, kind FROM operations WHERE state IN ('recorded', 'dispatched') ORDER BY created_at")
    .map((op) => `${op.campaign_id}/${op.task_id} ${op.kind} run`);
  if (hasTable(store, 'coordinator_runs')) {
    open.push(...store.all("SELECT id FROM coordinator_runs WHERE state IN ('recorded', 'dispatched')").map((run) => `coordinator run ${run.id}`));
  }
  if (hasTable(store, 'releases')) {
    open.push(...store.all(`SELECT id, step FROM releases WHERE step IS NOT NULL AND step_outcome IS NULL
      AND state NOT IN ('unknown', 'rollback-failed', 'accepted', 'rolled-back', 'refused')`).map((r) => `release ${r.id} step ${r.step}`));
  }
  return open;
}

/** What must survive the rebuild, per campaign: authority, budget use, task outcomes and retry timers, runs and history. */
export function snapshot(store) {
  const campaigns = {};
  for (const c of store.all('SELECT * FROM campaigns ORDER BY created_at, id')) {
    const journal = store.get('SELECT COUNT(*) AS n, MAX(seq) AS last FROM journal WHERE campaign_id = ?', c.id);
    campaigns[c.id] = {
      control: c.control, scopeDigest: c.scope_digest, authorizationVersion: c.authorization_version, authority: authorityDigest(c.declaration),
      runsUsed: c.runs_used, costUsd: c.cost_usd,
      tasks: Object.fromEntries(store.tasks(c.id).map((t) => [t.task_id, { state: t.state, attempts: t.attempts, repairRounds: t.repair_rounds,
        headSha: t.head_sha, verifiedSha: t.verified_sha, prUrl: t.pr_url, retryAt: t.retry_at, result: digest(t.result) }])),
      operations: Object.fromEntries(store.all('SELECT id, state, outcome FROM operations WHERE campaign_id = ?', c.id)
        .map((op) => [op.id, digest([op.state, op.outcome])])),
      journal: { count: journal.n, last: journal.last ?? 0 },
    };
  }
  return { campaigns };
}

/**
 * Differences between the drained snapshot and the store now that would mean lost or altered data. A campaign still
 * paused or cancelled must be exactly as it was; any campaign keeps its authority, its recorded runs and its history,
 * and never spends less than before.
 */
export function preservationProblems(drained, store) {
  const now = snapshot(store);
  const problems = [];
  for (const [id, before] of Object.entries(drained.campaigns)) {
    const after = now.campaigns[id];
    if (!after) { problems.push(`${id} is no longer registered`); continue; }
    for (const key of ['scopeDigest', 'authorizationVersion', 'authority']) if (after[key] !== before[key]) problems.push(`${id}: ${key} changed`);
    if (after.runsUsed < before.runsUsed || after.costUsd < before.costUsd) problems.push(`${id}: recorded runs or cost went down`);
    for (const [op, value] of Object.entries(before.operations)) if (after.operations[op] !== value) problems.push(`${id}: run ${op} changed or is missing`);
    const kept = store.get('SELECT COUNT(*) AS n FROM journal WHERE campaign_id = ? AND seq <= ?', id, before.journal.last).n;
    if (kept !== before.journal.count) problems.push(`${id}: journal history changed`);
    if (after.control === before.control && ['paused', 'cancelled'].includes(before.control)) {
      if (after.runsUsed !== before.runsUsed || after.costUsd !== before.costUsd) problems.push(`${id}: budget use changed while ${before.control}`);
      if (canonicalJson(after.tasks) !== canonicalJson(before.tasks)) problems.push(`${id}: tasks, outcomes or retry timers changed while ${before.control}`);
    }
  }
  return problems;
}

const latestPause = (store, id) => store.get("SELECT seq, detail FROM journal WHERE campaign_id = ? AND kind = 'paused' ORDER BY seq DESC LIMIT 1", id);

/** Why a campaign this invocation paused may not be resumed by it, or null when it may. */
function resumeRefusal(store, entry) {
  const c = store.campaign(entry.id);
  if (!c) return 'it is no longer registered';
  if (c.control !== 'paused') return `it is ${c.control} now, not paused`;
  if (latestPause(store, entry.id)?.seq !== entry.pauseSeq) return 'it was paused again since, for another reason';
  if (c.scope_digest !== entry.scopeDigest || c.authorization_version !== entry.authorizationVersion || authorityDigest(c.declaration) !== entry.authority) {
    return 'its authority changed while it was paused';
  }
  return null;
}

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const tail = (text) => { const value = String(text ?? ''); return value.length > TAIL ? value.slice(-TAIL) : value; };
const refuse = (code, message) => { throw new RebuildError(code, `${message}; nothing was changed`); };

/**
 * Run the rebuild of the installation at `options.root` from the operator checkout `options.source`.
 * services: { exec(file, args, { cwd, timeoutMs }), maintain(step, { sha, main, keepStop }), dashboardAnswers(port),
 * processAlive(pid), sleep(ms), now(), log(line) }; exec and maintain resolve to { exitCode, stdout, stderr }.
 */
export async function rebuild(options, services) {
  const root = resolve(options.root);
  const source = resolve(options.source);
  const { waitMinutes = 240, port = 4318, node = process.execPath, pollMs = 15_000, startTimeoutMs = 180_000 } = options;
  const now = services.now ?? Date.now;
  const log = services.log ?? (() => {});
  const paths = installationPaths(root);
  for (const [what, path] of [['installation root', root], ['data directory', paths.data], ['supervisor.db', paths.db], ['config.json', paths.config],
    ['runtime checkout', paths.cli]]) {
    if (!existsSync(path)) refuse('INSTALLATION_NOT_FOUND', `no ${what} at ${path}: --root must name the root of an existing AIWorks installation`);
  }
  mkdirSync(paths.dir, { recursive: true });
  const lockToken = acquireLock(paths, services, now);
  let state = readJson(paths.state);
  const save = () => writeAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`);
  const evidence = (step, entry) => {
    if (state) appendFileSync(join(paths.dir, state.id, 'steps.jsonl'), `${JSON.stringify({ at: new Date(now()).toISOString(), step, ...entry })}\n`);
  };
  const exec = async (step, file, args, cwd, timeoutMs = 120_000) => {
    const out = await services.exec(file, args, { cwd, timeoutMs });
    evidence(step, { command: [file, ...args], cwd, exitCode: out.exitCode, stdout: tail(out.stdout), stderr: tail(out.stderr) });
    return { exitCode: out.exitCode, stdout: String(out.stdout ?? ''), stderr: String(out.stderr ?? '') };
  };
  const git = (step, args, cwd) => exec(step, 'git', args, cwd);
  const maintain = async (step, params = {}) => {
    log(`deploy.ps1 -Step ${step}`);
    const out = await services.maintain(step, params);
    evidence(`deploy-${step.toLowerCase()}`, { params, exitCode: out.exitCode, stdout: tail(out.stdout), stderr: tail(out.stderr) });
    for (const line of String(out.stdout ?? '').split(/\r?\n/).filter(Boolean)) log(`  ${line}`);
    return out;
  };
  const withStore = (fn, { readOnly = true } = {}) => {
    const store = new Store(paths.db, { readOnly });
    try { return fn(store); } finally { store.close(); }
  };
  const reached = (phase) => PHASES.indexOf(state.phase) >= PHASES.indexOf(phase);
  const halt = (code, message) => {
    throw new RebuildError(code, `${message}; ${state ? 'nothing more was changed, and the campaigns this rebuild paused stay paused until it finishes' : 'nothing was changed'}`);
  };

  try {
    // ---- Preflight: nothing changes before every check has passed. ----
    const settings = selfHostingSettings(readJson(paths.config) ?? {});
    const sourceStatus = await git('preflight', ['status', '--porcelain'], source);
    // The runtime is a worktree of the canonical AIWorks repository and shares its objects and refs; the installation
    // root may be a separate checkout without the new commits, so the target is resolved and checked in the runtime.
    const repo = paths.runtime;
    if (sourceStatus.exitCode !== 0 || sourceStatus.stdout.trim()) halt('SOURCE_NOT_CLEAN', `the operator checkout ${source} has uncommitted changes or is not a Git checkout`);
    const sourceHead = (await git('preflight', ['rev-parse', 'HEAD'], source)).stdout.trim();
    const runtimeStatus = await git('preflight', ['status', '--porcelain'], paths.runtime);
    if (runtimeStatus.exitCode !== 0 || runtimeStatus.stdout.trim()) halt('RUNTIME_NOT_CLEAN', `the runtime checkout ${paths.runtime} has local changes or is not a Git checkout`);
    let target = state?.target ?? null;
    if (!state || !reached('stopped')) {
      // The trusted main, never a typed hash: the main ledger's trusted tip (AW-005) or origin/main after a fetch.
      let tip = null;
      if (settings.local) {
        const out = await exec('preflight', node, [paths.cli, 'trusted-main', '--data', paths.data], paths.runtime);
        tip = out.exitCode === 0 ? out.stdout.split(/\r?\n/)[0].trim() : null;
        if (!SHA.test(tip ?? '')) halt('TARGET_NOT_TRUSTED', `trusted-main gave no trusted tip of local main: ${out.stderr.trim()}`);
      } else {
        const fetch = await git('preflight', ['fetch', '-q', 'origin'], repo);
        if (fetch.exitCode !== 0) halt('TARGET_NOT_TRUSTED', `git fetch origin failed: ${fetch.stderr.trim()}`);
        tip = (await git('preflight', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], repo)).stdout.trim();
        if (!SHA.test(tip)) halt('TARGET_NOT_TRUSTED', 'the repository of the runtime has no origin/main');
      }
      if (!target) target = tip;
      else if (target !== tip && (await git('preflight', ['merge-base', '--is-ancestor', target, tip], repo)).exitCode !== 0) {
        halt('TARGET_NOT_TRUSTED', `${target}, the revision this rebuild started with, is no longer on the trusted main`);
      }
    }
    if (sourceHead !== target) {
      halt('SOURCE_NOT_AT_TARGET', `the operator checkout is at ${sourceHead || 'no commit'}, not the trusted ${target}: the rebuild runs only the reviewed code it installs. Check out ${target} there and run npm run rebuild again`);
    }
    if ((await git('preflight', ['cat-file', '-e', `${target}^{commit}`], repo)).exitCode !== 0) halt('TARGET_NOT_IN_REPOSITORY', `the repository of the runtime ${repo} does not have ${target}`);

    if (!state) {
      const fresh = withStore((store) => ({ stopPreexisting: existsSync(paths.stop), open: openWork(store) }));
      if (fresh.stopPreexisting && fresh.open.length) {
        halt('STOPPED_WITH_OPEN_WORK', `the supervisor is stopped (STOP) while work is open (${fresh.open.slice(0, 5).join(', ')}): nothing would record it. Remove STOP so the supervisor records it, or wait`);
      }
      const previousRuntime = (await git('preflight', ['rev-parse', 'HEAD'], paths.runtime)).stdout.trim();
      state = { version: 1, id: `${new Date(now()).toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`, target,
        trustedMain: settings.local ? 'local' : 'origin', previousRuntime, stopPreexisting: fresh.stopPreexisting, phase: 'draining',
        stopWritten: false, paused: [], startedAt: new Date(now()).toISOString() };
      mkdirSync(join(paths.dir, state.id), { recursive: true });
      save();
      log(`rebuild ${state.id}: ${previousRuntime.slice(0, 12)} -> ${target} (trusted ${state.trustedMain} main)`);
    } else log(`rebuild ${state.id}: continuing after '${state.phase}' towards ${target}`);

    // ---- Pause admissions, drain, stop and prove the drain. ----
    if (state.phase === 'draining') {
      const deadline = now() + waitMinutes * 60_000;
      for (;;) {
        pauseAdmissions();
        if (!state.stopWritten) {
          let noted = -Infinity;
          // A campaign registered while the drain waits is paused too, so nothing new is admitted.
          for (let open = withStore(openWork); open.length; pauseAdmissions(), open = withStore(openWork)) {
            if (now() >= deadline) {
              const kept = abandon();
              throw new RebuildError('DRAIN_TIMEOUT', `work was still open after ${waitMinutes} minutes (${open.slice(0, 5).join(', ')}); nothing was replaced and the campaigns this rebuild paused were resumed${kept.length ? `, except ${kept.map((k) => `${k.id} (${k.why})`).join(', ')}` : ''}. Run npm run rebuild again later`);
            }
            if (now() - noted >= 300_000) { log(`waiting for ${open.length} open run(s) to finish and be recorded: ${open.slice(0, 5).join(', ')}`); noted = now(); }
            await services.sleep(pollMs);
          }
          state.stopWritten = true;
          save();
        }
        const stop = await maintain('Stop');
        if (stop.exitCode !== 0) {
          throw new RebuildError('STOP_FAILED', `deploy.ps1 -Step Stop failed (exit ${stop.exitCode}): ${tail(stop.stderr).trim()}. The runtime is unchanged and the paused campaigns stay paused; fix the cause and run npm run rebuild again`);
        }
        const open = withStore(openWork);
        if (!open.length) break;
        // Admitted between the drained check and STOP (the coordinator, a program wave or a reopened finished campaign has
        // no admission gate): the unchanged runtime starts again, records it, and the drain repeats. The run is never
        // stopped or started a second time.
        log(`opened while the supervisor stopped: ${open.slice(0, 5).join(', ')}; starting the unchanged runtime again to record it`);
        const start = await maintain('Start', { keepStop: state.stopPreexisting });
        if (start.exitCode !== 0) throw new RebuildError('START_FAILED', `deploy.ps1 -Step Start failed (exit ${start.exitCode}): ${tail(start.stderr).trim()}; run npm run rebuild again`);
        state.stopWritten = false;
        save();
      }
      state.phase = 'stopped';
      save();
      log('drained: no run is open and the supervisor and dashboard have exited');
    }

    // ---- Back up the drained store. Nothing writes it while the supervisor and dashboard are stopped. ----
    if (state.phase === 'stopped') {
      const backup = join(paths.dir, state.id, 'supervisor.db');
      rmSync(backup, { force: true });
      const db = new DatabaseSync(paths.db, { readOnly: true });
      try { db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`); } finally { db.close(); }
      state.drained = withStore(snapshot);
      state.backup = backup;
      state.phase = 'backed-up';
      save();
      log(`drained store backed up to ${backup}`);
    }

    // ---- Install the exact trusted revision with its locked dependencies, then check it. ----
    if (state.phase === 'backed-up') {
      const install = await maintain('Install', { sha: state.target, main: state.trustedMain });
      if (install.exitCode !== 0) {
        throw new RebuildError('INSTALL_FAILED', `deploy.ps1 -Step Install failed (exit ${install.exitCode}): ${tail(install.stderr).trim()}. The supervisor stays stopped and every paused campaign keeps its pause; fix the cause and run npm run rebuild again`);
      }
      const head = (await git('check', ['rev-parse', 'HEAD'], paths.runtime)).stdout.trim();
      const clean = await git('check', ['status', '--porcelain'], paths.runtime);
      // AIWorks has no bundle build: the runtime is its source at the commit plus `npm ci`. Loading the installed CLI with
      // its dependencies and reading the store through it is the build check.
      const smoke = await exec('check', node, [paths.cli, 'program-status', '--data', paths.data], paths.runtime);
      if (head !== state.target || clean.exitCode !== 0 || clean.stdout.trim() || smoke.exitCode !== 0) {
        throw new RebuildError('HEALTH_CHECK_FAILED', `the installed runtime failed its check (HEAD ${head || 'unknown'}, ${clean.stdout.trim() ? 'not clean' : 'clean'}, CLI exit ${smoke.exitCode}: ${tail(smoke.stderr).trim()}). The supervisor stays stopped; fix the cause and run npm run rebuild again`);
      }
      state.phase = 'installed';
      save();
    }

    // ---- Start the new runtime and prove it runs the installed commit. ----
    if (state.phase === 'installed') {
      const start = await maintain('Start', { keepStop: state.stopPreexisting });
      if (start.exitCode !== 0) throw new RebuildError('START_FAILED', `deploy.ps1 -Step Start failed (exit ${start.exitCode}): ${tail(start.stderr).trim()}; run npm run rebuild again`);
      if (!state.stopPreexisting) await controllerStarted();
      const deadline = now() + 60_000;
      let answers = await services.dashboardAnswers(port);
      while (!answers && now() < deadline) { await services.sleep(2_000); answers = await services.dashboardAnswers(port); }
      state.dashboard = answers ? 'answering' : `not answering on 127.0.0.1:${port}`;
      state.phase = 'started';
      save();
    }

    // ---- Compare with the drained state, then resume only what this invocation paused. ----
    if (state.phase === 'started') {
      const outcome = withStore((store) => {
        const problems = preservationProblems(state.drained, store);
        if (problems.length) {
          throw new RebuildError('STATE_CHANGED', `the store differs from the drained backup: ${problems.slice(0, 10).join('; ')}. No campaign was resumed; compare with ${state.backup} before resuming any by hand`);
        }
        return resumeOwn(store);
      }, { readOnly: false });
      state.result = outcome;
      state.phase = 'resumed';
      state.finishedAt = new Date(now()).toISOString();
      save();
    }
    const summary = { id: state.id, target: state.target, previousRuntime: state.previousRuntime, resumed: state.result.resumed, kept: state.result.kept,
      stopKept: state.stopPreexisting, dashboard: state.dashboard, backup: state.backup, evidence: join(paths.dir, state.id) };
    renameSync(paths.state, join(paths.dir, state.id, 'state.json'));
    return summary;
  } finally {
    if (readJson(paths.lock)?.token === lockToken) rmSync(paths.lock, { force: true });
  }

  // Pause every running campaign under this invocation's reason and record it, including one paused just before a crash.
  function pauseAdmissions() {
    const reason = pauseReason(state.id);
    withStore((store) => {
      for (const { id } of store.all("SELECT id FROM campaigns WHERE control = 'registered' ORDER BY created_at, id")) {
        // Its control changed since the read (an owner action): it is no longer this rebuild's to pause.
        try { campaignPause(store, id, reason, now()); }
        catch (error) { if (error.code !== 'INVALID_STATE') throw error; }
      }
      for (const { id } of store.all("SELECT id FROM campaigns WHERE control = 'paused' ORDER BY created_at, id")) {
        const last = latestPause(store, id);
        if (last?.detail?.reason !== reason || state.paused.some((entry) => entry.id === id && entry.pauseSeq === last.seq)) continue;
        const c = store.campaign(id);
        state.paused = state.paused.filter((entry) => entry.id !== id);
        state.paused.push({ id, pauseSeq: last.seq, scopeDigest: c.scope_digest, authorizationVersion: c.authorization_version, authority: authorityDigest(c.declaration) });
        log(`paused ${id}`);
      }
    }, { readOnly: false });
    save();
  }

  // Resume, with its identical registered declaration, each campaign this invocation paused that nobody changed since.
  function resumeOwn(store) {
    // Keep an owner action from slipping between the ownership check and the resume.
    return store.tx(() => {
      const resumed = [], kept = [];
      for (const entry of state.paused) {
        const why = resumeRefusal(store, entry);
        if (why) { kept.push({ id: entry.id, why }); log(`not resumed: ${entry.id}: ${why}`); continue; }
        campaignStart(store, store.campaign(entry.id).declaration, now());
        resumed.push(entry.id);
        log(`resumed ${entry.id}`);
      }
      return { resumed, kept };
    });
  }

  // Give up before anything was replaced: the campaigns this invocation paused run again and the state is filed away.
  function abandon() {
    const { kept } = withStore(resumeOwn, { readOnly: false });
    state.phase = 'abandoned';
    save();
    renameSync(paths.state, join(paths.dir, state.id, 'state.json'));
    return kept;
  }

  // The new supervisor holds a lease under the installed commit. Without a campaign that needs a controller there is
  // no lease to prove it, and the scheduled task's own state is what deploy.ps1 reported.
  async function controllerStarted() {
    const needed = withStore((store) => store.get("SELECT COUNT(*) AS n FROM campaigns WHERE control IN ('registered', 'paused', 'cancel-requested')").n);
    if (!needed) return;
    const deadline = now() + startTimeoutMs;
    for (;;) {
      const live = withStore((store) => store.get('SELECT COUNT(*) AS n FROM leases WHERE code_revision = ? AND expires_at > ?', state.target, now()).n);
      if (live) { log(`supervisor running ${state.target.slice(0, 12)}`); return; }
      if (now() >= deadline) {
        throw new RebuildError('SUPERVISOR_NOT_STARTED', `no supervisor took a lease under ${state.target} within ${Math.round(startTimeoutMs / 60_000)} minutes; every paused campaign keeps its pause. Read supervisor.log and run npm run rebuild again`);
      }
      await services.sleep(2_000);
    }
  }
}

// One maintenance session at a time: the installation's runtime maintenance lock, which any session maintaining the runtime
// holds. Only a lock this command left behind with a process that no longer exists is taken over: its state file says
// where it stopped, and this invocation continues from there. Another session's lock is never removed.
const LOCK_OWNER = 'aiworks rebuild';
function acquireLock(paths, services, now) {
  const token = randomBytes(8).toString('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.lock, 'wx');
      try { writeSync(fd, JSON.stringify({ owner: LOCK_OWNER, pid: process.pid, token, at: new Date(now()).toISOString() })); } finally { closeSync(fd); }
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readJson(paths.lock);
      if (holder?.owner !== LOCK_OWNER || !Number.isSafeInteger(holder.pid)) {
        throw new RebuildError('MAINTENANCE_IN_PROGRESS', `another session holds the runtime maintenance lock ${paths.lock}; nothing was changed. Run npm run rebuild again once that session has finished and released it`);
      }
      if (holder.pid !== process.pid && services.processAlive(holder.pid)) {
        throw new RebuildError('REBUILD_IN_PROGRESS', `another rebuild (pid ${holder.pid}, since ${holder.at}) is maintaining this installation; nothing was changed`);
      }
      rmSync(paths.lock, { force: true });
    }
  }
  throw new RebuildError('REBUILD_IN_PROGRESS', 'the maintenance lock could not be taken; nothing was changed');
}
