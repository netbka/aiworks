// The deploy adapter: deploy, check and roll back one release through the project's own commands (docs/design/
// AUTO_RELEASE.md sections 4.4, 7.2 steps 3 and 5 to 7, 7.4 and 8; plan slice REL7). Built switched off: it runs a
// command only through release/runner.mjs, which starts nothing while `release.enabled` is not true in config.json, and
// the supervisor builds this adapter for no release until slice REL11 switches Auto Release on (the disposable rehearsal,
// release/rehearsal.mjs, and the owner's Check the site now, release/health.mjs, build it under that same switch). It is the adapter that
// release/state.mjs drives: state.mjs records each step's intent before this acts and its outcome after. The rules:
// - the revision: for kind `deploy`, the merge commit the merge gate journaled as `merged` for this task at its verified
//   revision (one merge path per repository, plan section 8 (k)); for `merge-then-deploy`, the merge commit the merge
//   step recorded. The release clone must already hold it (this adapter fetches nothing). Its tree must equal the
//   verified tree, else the deploy is refused and no command runs;
// - every command runs in a clean, detached release checkout at that revision under `<dataDir>/releases/<release id>/`,
//   never in the owner's working tree, through the release runner, with a timeout;
// - deploy: `observe` records the previous digest, `deploy <revision>` prints the digest it deployed, `observe` again
//   must report that revision and that digest. Anything else is unknown, never success;
// - check: `check` until it passes or `checkWindowMinutes` ends; unknown at the end counts as failed;
// - rollback (`automatic` only): `rollback <previous digest>`, then `observe` must report the previous digest, then
//   `check` again. Anything else is a failed rollback: an incident that keeps the destination lock;
// - reconcile, never repeat: the adapter writes `deploy.json` beside the checkout before each command that changes the
//   destination. After a restart, `observe` settles a step from what is live. A command that may have run is never run
//   again: the grant has no way to mark a command idempotent, so a deploy proven not done after it may have started
//   goes to the owner (AUTO_RELEASE.md section 8).
// Commands print `revision: <sha>` and `digest: <digest>` lines on standard output.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { writeAtomic } from '../proc.mjs';
import { mergedEventReader } from './eligibility.mjs';
import { releaseCommandsStopped, runReleaseCommand } from './runner.mjs';

export const DEPLOY_RECORD = 'deploy.json';
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[A-Za-z0-9][A-Za-z0-9:._+/=-]{0,199}$/;
const STDERR = '\n--- stderr ---\n';
const GIT_PREFIX = Object.freeze(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']);

/** One Git command. Inherited GIT_* variables could point Git elsewhere, so they are dropped; no hook runs. */
function git(cwd, hooksOff, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const result = spawnSync('git', [...GIT_PREFIX, '-c', `core.hooksPath=${hooksOff}`, '-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 64 * 1024 * 1024, env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: !result.error && result.status === 0, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

const same = (a, b) => {
  const norm = (path) => { let real; try { real = realpathSync.native(path); } catch { real = resolve(path); } return process.platform === 'win32' ? real.toLowerCase() : real; };
  return norm(a) === norm(b);
};

/** The `revision:` and `digest:` a command printed on standard output; a field printed twice with two values is null. */
export function printed(output) {
  const stdout = String(output ?? '').split(STDERR)[0];
  const found = { revision: undefined, digest: undefined, 'rollback-ready': undefined };
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(revision|digest|rollback-ready)\s*:\s*(\S+)\s*$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    found[key] = found[key] === undefined || found[key] === match[2] ? match[2] : null;
  }
  return {
    revision: SHA.test(found.revision ?? '') ? found.revision : null,
    digest: DIGEST.test(found.digest ?? '') ? found.digest : null,
    ...(found['rollback-ready'] !== undefined ? { rollbackReady: DIGEST.test(found['rollback-ready'] ?? '') ? found['rollback-ready'] : null } : {}),
  };
}

/** How a command file in the checkout is started without a shell: by its extension, or as an executable. */
function commandLine(file, args) {
  switch (extname(file).toLowerCase()) {
    case '.mjs': case '.cjs': case '.js': return [process.execPath, file, ...args];
    case '.ps1': return ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args];
    case '.sh': return ['sh', file, ...args];
    default: return [file, ...args];
  }
}

/**
 * The deploy adapter of one destination, for runStep and reconcile of release/state.mjs: { run(release, step),
 * observe(release, step) } for the steps `deploy`, `check` and `rollback`, and health(release, key) for the owner's
 * read-only Check the site now (release/health.mjs).
 * - `destination`: the validated grant's destination (kind `deploy` or `merge-then-deploy`, commands, rollback,
 *   checkWindowMinutes);
 * - `repo`: the project's release clone, already holding the merge commit and the verified revision. Read here; never the cwd
 *   of a project command;
 * - `config`, `dataDir`: as release/runner.mjs takes them; with `release.enabled` not true nothing is started;
 * - `store`: the supervisor store, for the merge gate's `merged` event and the journal; `merged` replaces the reader;
 * - `timeoutMs`: each command's timeout; `checkIntervalMs`, `clock` and `sleep` pace the check window;
 * - `runCommand`: release/runner.mjs runReleaseCommand, replaceable only in tests of the runner itself.
 */
export function deployAdapter({ destination, repo, config, dataDir, store, merged = null, timeoutMs = 600_000, checkIntervalMs = 15_000,
  clock = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), runCommand = runReleaseCommand,
  beforeDeploy = async () => null, mutate = (fn) => fn() }) {
  if (!['deploy', 'merge-then-deploy'].includes(destination?.kind)) throw new TypeError('the deploy adapter serves a deploy or merge-then-deploy destination');
  if (!destination.commands?.deploy || !destination.commands?.observe) throw new TypeError('a deploy destination names its deploy and observe commands');
  if (!Number.isInteger(destination.checkWindowMinutes) || destination.checkWindowMinutes <= 0) throw new TypeError('a deploy destination names its check window');
  if (typeof repo !== 'string' || !repo) throw new TypeError('the deploy adapter needs the project release clone');
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('the deploy adapter needs the supervisor data directory');
  if (!store) throw new TypeError('the deploy adapter needs the supervisor store');
  const windowMs = destination.checkWindowMinutes * 60_000;

  const home = (r) => join(dataDir, 'releases', r.id);
  const hooksOff = (r) => join(home(r), 'no-hooks');
  const read = (r) => { const path = join(home(r), DEPLOY_RECORD); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; };
  const save = (r, record) => mutate(() => { mkdirSync(home(r), { recursive: true }); writeAtomic(join(home(r), DEPLOY_RECORD), JSON.stringify(record, null, 2)); return record; });
  const tell = (r, kind, detail) => mutate(() => store.journal(r.campaign_id, kind, { release: r.id, ...detail }, clock()));

  /** The revision to deploy, after the tree check of AUTO_RELEASE.md 7.2 step 3: { revision } or { refused: reason }. */
  function revisionOf(r) {
    let commit;
    if (destination.kind === 'deploy') {
      let event;
      try { event = (merged ?? mergedEventReader(store, r.campaign_id))({ taskId: r.task_id, verifiedSha: r.verified_sha }); } catch { event = undefined; }
      if (!event || event.task !== r.task_id || event.sha !== r.verified_sha) return { refused: `the merge gate recorded no merged event for task ${r.task_id} at ${r.verified_sha}` };
      commit = event.mergeCommit;
    } else commit = r.merge_commit;
    if (!SHA.test(commit ?? '')) return { refused: 'no merge commit is recorded for this release' };
    const off = hooksOff(r);
    const merge = git(repo, off, 'rev-parse', '--verify', '-q', `${commit}^{tree}`), verified = git(repo, off, 'rev-parse', '--verify', '-q', `${r.verified_sha}^{tree}`);
    if (!merge.ok || !verified.ok || !SHA.test(merge.stdout) || !SHA.test(verified.stdout)) return { refused: `the trees of merge commit ${commit} and verified revision ${r.verified_sha} could not be read` };
    if (merge.stdout !== verified.stdout) return { refused: `merge commit ${commit} does not hold the verified tree of ${r.verified_sha}: the merged code is not the checked code` };
    return { revision: commit };
  }

  /** A clean, detached release checkout at `revision`, under the release's own directory. Returns its path. */
  const checkout = (r, revision) => mutate(() => checkoutOwned(r, revision));
  function checkoutOwned(r, revision) {
    if (!releaseCommandsStopped({ dataDir, release: r })) throw new Error('An earlier release command has no process-tree stop proof');
    const dir = join(home(r), 'checkout'), off = hooksOff(r);
    mkdirSync(home(r), { recursive: true });
    if (existsSync(dir)) {
      // Reuse it only when it is a worktree of its own: a Git command in a broken directory would reach a parent repository.
      const top = git(dir, off, 'rev-parse', '--show-toplevel');
      if (top.ok && same(top.stdout, dir) && git(dir, off, 'checkout', '--quiet', '--detach', '--force', revision).ok && git(dir, off, 'clean', '-ffdxq').ok) return verify(dir, off, revision);
      rmSync(dir, { recursive: true, force: true });
      git(repo, off, 'worktree', 'prune');
    }
    const added = git(repo, off, 'worktree', 'add', '--quiet', '--detach', '--force', dir, revision);
    if (!added.ok) throw new Error(`the release checkout could not be made: ${added.stderr}`);
    return verify(dir, off, revision);
  }
  function verify(dir, off, revision) {
    const head = git(dir, off, 'rev-parse', 'HEAD'), status = git(dir, off, 'status', '--porcelain', '--untracked-files=all', '--ignored');
    if (!head.ok || head.stdout !== revision || !status.ok || status.stdout !== '') throw new Error(`the release checkout is not clean at ${revision}`);
    return dir;
  }

  /** Run one project command in the checkout through the release runner: { exitCode, output } or null when unknown. */
  async function command(r, record, name, dir, args = [], key = r.step_key) {
    const file = commandFile(dir, destination.commands[name]);
    if (!file) return null;
    record.runs = (record.runs ?? 0) + 1;
    save(r, record);
    let result;
    try {
      result = await runCommand({ config, dataDir, stepKey: `${key}.${record.runs}.${name}`, command: commandLine(file, args), cwd: dir,
        timeoutMs, store, release: r, now: clock, credential: destination.credential ?? null,
        recovery: record.deploy !== 'not-started' && ['observe', 'check', 'rollback'].includes(name) ? name : null });
    } catch { return null; }
    mutate(() => null); // a takeover may have stopped the command while it was awaited
    return result?.ran === true && Number.isInteger(result.exitCode) ? { exitCode: result.exitCode, output: result.output ?? '' } : null;
  }

  /** What is live: { revision, digest }, or null when observe gives no clear answer. */
  async function look(r, record, dir) {
    const seen = await command(r, record, 'observe', dir);
    if (seen?.exitCode !== 0) return null;
    const live = printed(seen.output);
    return live.revision && live.digest ? live : null;
  }

  /** `check` until it passes or the window ends: 'done', or 'failed' (a fail or unknown still at the end). */
  async function checks(r, record, dir, startedAt) {
    if (!destination.commands.check) return 'failed';
    const deadline = startedAt + windowMs;
    for (;;) {
      const result = await command(r, record, 'check', dir);
      if (result?.exitCode === 0) return 'done';
      if (clock() >= deadline) return 'failed';
      await sleep(Math.min(checkIntervalMs, Math.max(0, deadline - clock())));
    }
  }

  /** The record of one release, made at the first step: the revision and the checkout. Refused when the tree differs. */
  function prepare(r) {
    const known = read(r);
    if (known) return { record: known, dir: checkout(r, known.revision) };
    const target = revisionOf(r);
    if (target.refused) return target;
    // `repo` lets a later read-only health check (release/health.mjs) remake the checkout; it stays in the data directory.
    return { record: save(r, { version: 1, release: r.id, revision: target.revision, repo: resolve(repo), previousDigest: null, deployedDigest: null,
      deploy: 'not-started', rollback: 'not-started', runs: 0 }), dir: checkout(r, target.revision) };
  }

  const deployed = (record) => ({ outcome: 'done', deployedDigest: record.deployedDigest, previousDigest: record.previousDigest });

  async function runDeploy(r) {
    const prepared = prepare(r);
    if (prepared.refused) {
      tell(r, 'release-deploy-refused', { reason: prepared.refused });
      return { outcome: 'refused' };
    }
    const { record, dir } = prepared;
    if (record.deploy !== 'not-started') return { outcome: 'unknown' }; // it may have run: only observe settles it
    const proof = await preflight(r);
    if (!proof.knownGood || !proof.rollback) return { outcome: 'unknown' }; // no deploy intent: reconciliation proves not-done
    const before = proof.live;
    // Preflight ran the existing version's health check. Recreate the target
    // checkout only after every command's native process tree has stopped.
    checkout(r, record.revision);
    Object.assign(record, read(r));
    if (!git(repo, hooksOff(r), 'merge-base', '--is-ancestor', before.revision, record.revision).ok) return { outcome: 'refused' };
    const blocked = await beforeDeploy();
    if (blocked !== null) { tell(r, 'release-deploy-waiting', { reason: blocked }); return { outcome: 'unknown' }; }
    record.previousDigest = before.digest;
    record.deploy = 'started'; // intent before effect: from here on the deploy may have run
    save(r, record);
    const result = await command(r, record, 'deploy', dir, [record.revision]);
    if (!result) return { outcome: 'unknown' };
    if (result.exitCode !== 0) {
      save(r, Object.assign(record, { deploy: 'failed' }));
      return { outcome: 'failed', previousDigest: record.previousDigest };
    }
    const digest = printed(result.output).digest;
    if (!digest) return { outcome: 'unknown' };
    save(r, Object.assign(record, { deploy: 'printed', deployedDigest: digest }));
    const after = await look(r, record, dir);
    // The drift check: what is live must be the revision and the digest deploy printed, else unknown.
    return after?.revision === record.revision && after.digest === digest ? deployed(record) : { outcome: 'unknown' };
  }

  async function observeDeploy(r) {
    const known = read(r);
    if (!known || known.deploy === 'not-started') return { outcome: 'not-done' }; // the deploy command never started
    const dir = checkout(r, known.revision);
    const live = await look(r, known, dir);
    if (!live) return { outcome: 'unknown' };
    const target = known.deployedDigest ? live.digest === known.deployedDigest : live.digest !== known.previousDigest;
    if (live.revision === known.revision && target) {
      if (!known.deployedDigest) save(r, { ...known, deploy: 'printed', deployedDigest: live.digest });
      return deployed({ ...known, deployedDigest: known.deployedDigest ?? live.digest });
    }
    if (live.digest === known.previousDigest && live.revision !== known.revision) {
      if (known.deploy === 'failed') return { outcome: 'failed', previousDigest: known.previousDigest };
      // Proven not done, but the deploy may have started: it is never run again on that proof. The owner decides.
      tell(r, 'release-owner-needed', { step: 'deploy', reason: 'the previous digest is still live after a deploy that may have started; the deploy is not run again' });
    }
    return { outcome: 'unknown' };
  }

  async function runCheck(r, startedAt) {
    const known = read(r);
    if (!known) return { outcome: 'unknown' };
    return { outcome: await checks(r, known, checkout(r, known.revision), startedAt) };
  }

  async function runRollback(r) {
    const known = read(r);
    if (destination.rollback !== 'automatic') {
      tell(r, 'release-owner-needed', { step: 'rollback', reason: 'the grant asks for report-only rollback: nothing is rolled back and the destination stays locked' });
      return { outcome: 'failed' };
    }
    if (!known?.previousDigest || !destination.commands.rollback) {
      tell(r, 'release-incident', { step: 'rollback', reason: 'no retained previous digest or no rollback command' });
      return { outcome: 'failed' };
    }
    const dir = checkout(r, known.revision);
    if (known.rollback !== 'not-started') return observeRollback(r);
    save(r, Object.assign(known, { rollback: 'started' })); // intent before effect
    const result = await command(r, known, 'rollback', dir, [known.previousDigest]);
    if (!result || result.exitCode !== 0 || printed(result.output).digest !== known.previousDigest) return incident(r, 'the rollback command did not report the previous digest');
    return restored(r, known, dir);
  }

  /** After a rollback: observe must report the previous digest, then check must pass again. */
  async function restored(r, record, dir) {
    const live = await look(r, record, dir);
    if (live?.digest !== record.previousDigest) return incident(r, 'observe does not report the previous digest after the rollback');
    if (await checks(r, record, dir, clock()) !== 'done') return incident(r, 'the checks fail after the rollback');
    save(r, Object.assign(record, { rollback: 'done' }));
    return { outcome: 'done', previousDigest: record.previousDigest };
  }

  function incident(r, reason) {
    tell(r, 'release-incident', { step: 'rollback', reason });
    return { outcome: 'failed' };
  }

  /** A rollback left open: settled from what is live, never run again. */
  async function observeRollback(r) {
    const known = read(r);
    if (!known || known.rollback === 'not-started') return { outcome: 'not-done' };
    return restored(r, known, checkout(r, known.revision));
  }

  const steps = {
    run: { deploy: runDeploy, check: (r) => runCheck(r, clock()), rollback: runRollback },
    observe: { deploy: observeDeploy, check: (r) => runCheck(r, Math.min(clock(), Number.isFinite(r.step_started_at) ? r.step_started_at : clock())), rollback: observeRollback },
  };
  const guarded = (table) => async (r, step) => {
    const act = table[step];
    if (!act) throw new Error(`the deploy adapter has no step ${step}`);
    try { return await act(r); } catch { return { outcome: 'unknown' }; }
  };

  /**
   * One read-only `check` of a settled release, at the revision it deployed, outside the step log: 'passed' (exit 0),
   * 'failed' (exit 1) or 'unknown' (anything else, no check command, no deploy record or a command that did not run).
   * `key` names its runner directories. It changes no release state, runs no other command and never rolls back.
   */
  async function health(r, key) {
    const known = read(r);
    if (!known || !destination.commands.check) return 'unknown';
    const result = await command(r, known, 'check', checkout(r, known.revision), [], key);
    return result?.exitCode === 0 ? 'passed' : result?.exitCode === 1 ? 'failed' : 'unknown';
  }
  // Read-only evidence before admitting a release. The caller uses a private,
  // instance-specific probe id so no destination lock or another probe is raced.
  async function preflight(r) {
    if (!destination.commands.check || !destination.commands.rollback) return { knownGood: false, rollback: false };
    const prepared = prepare(r);
    if (prepared.refused) return { knownGood: false, rollback: false, reason: prepared.refused };
    if (Object.values(destination.commands).some((path) => !commandFile(prepared.dir, path))) {
      return { knownGood: false, rollback: false, reason: 'A project release command is not a regular file inside the verified checkout' };
    }
    const live = await look(r, prepared.record, prepared.dir);
    if (!live?.revision || !live.digest || live.rollbackReady !== live.digest) return { knownGood: false, rollback: false,
      reason: 'Observe must identify the live revision and its retained rollback artifact' };
    const current = checkout(r, live.revision);
    const health = await command(r, prepared.record, 'check', current);
    return { knownGood: health?.exitCode === 0, rollback: true, live };
  }
  return { run: guarded(steps.run), observe: guarded(steps.observe),
    preflight: async (r) => { try { return await preflight(r); } catch { return { knownGood: false, rollback: false }; } },
    health: async (r, key) => { try { return await health(r, key); } catch { return 'unknown'; } } };
}

/** Refuse links, junctions and paths outside the private checkout, including a
 * linked parent directory. A command is code from the verified Git tree. */
function commandFile(dir, path) {
  if (typeof path !== 'string' || !path || /[\\:]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  try {
    let at = dir;
    for (const part of path.split('/')) {
      at = join(at, part);
      if (lstatSync(at).isSymbolicLink()) return null;
    }
    const canonical = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    return lstatSync(at).isFile() && canonical(realpathSync.native(at)).startsWith(canonical(realpathSync.native(dir) + sep)) ? at : null;
  } catch { return null; }
}
