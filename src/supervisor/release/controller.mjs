// Production continuation after the existing merge gate. Project commands and
// standing authority are project-specific; scheduling and crash recovery are not.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as git from '../adapters/git.mjs';
import { specsOf } from '../plan.mjs';
import { readJsonIfExists } from '../proc.mjs';
import { gateFailure } from '../gate.mjs';
import { credentialStoreFrom, releaseRoleReader } from './credential.mjs';
import { awaitingAcceptance, passedCheck, pendingChanges } from '../result-review.mjs';
import { authorityChange } from './authority-path.mjs';
import { deployAdapter } from './deploy.mjs';
import { evaluateEligibility, mergedEventReader } from './eligibility.mjs';
import { pinGrant, pinnedGrant, projectReleasePointer, readProjectGrant } from './grant-source.mjs';
import { releaseCommandsStopped, runReleaseCommand } from './runner.mjs';
import { acquireLock, createRelease, destinationState, nextStep, reconcile, release, releaseGate, releaseSwitches, runStep, TERMINAL } from './state.mjs';

const SOURCE = fileURLToPath(new URL('../../../', import.meta.url));
const POLL_MS = 60_000;
const leaseOf = (c, ctx) => ({ instanceId: c.instanceId, generation: ctx.generation });
const maintenance = (c) => existsSync(join(c.dataDir, '..', 'runtime-maintenance.lock')) || existsSync(join(c.dataDir, 'STOP'));
const runGit = (c, repo, args) => git.exec(c.cmd.git, args, { cwd: repo.path, timeoutMs: 30_000 });
const ancestor = (c, repo, from, to) => Boolean(from && to && git.isAncestor({ git: c.cmd.git, path: repo.path, ancestor: from, descendant: to }));
function authorityProblem(c, decl, repo, base, sha) {
  const common = runGit(c, repo, ['merge-base', base, sha]);
  if (!common.ok) throw new Error('The release authority boundary could not be checked');
  return authorityChange(c, decl, repo.path, common.stdout, sha);
}

function context(c, id) {
  const held = c.store.acquireLease(id, c.instanceId, c.now(), c.config.leaseMs, c.codeRevision);
  if (!held) return null;
  c.held.set(id, held.generation);
  return { id, generation: held.generation };
}

function newestMerge(c, project, repo, base) {
  if (!base) return null;
  const events = c.store.all("SELECT j.seq, j.campaign_id, j.detail FROM journal j JOIN campaigns c ON c.id = j.campaign_id " +
    "WHERE j.kind = 'merged' AND json_extract(c.declaration, '$.target.projectId') = ? ORDER BY j.seq DESC", project);
  c.releaseOrderMemo ??= new Map();
  const key = `${project}:${base}:${events[0]?.seq ?? 0}`;
  if (c.releaseOrderMemo.has(key)) return c.releaseOrderMemo.get(key);
  let maxima = [];
  for (const event of events) {
    if (!ancestor(c, repo, event.detail.mergeCommit, base)) continue;
    if (maxima.some((item) => ancestor(c, repo, event.detail.mergeCommit, item.detail.mergeCommit))) continue;
    maxima = maxima.filter((item) => !ancestor(c, repo, item.detail.mergeCommit, event.detail.mergeCommit));
    maxima.push(event);
  }
  if (maxima.length > 1) throw new Error('The merged branches need one independently verified combined release revision');
  const newest = maxima[0] ?? null;
  c.releaseOrderMemo.set(key, newest);
  return newest;
}

function expectRelease(c, ctx, grant, task, repo) {
  const decl = c.store.campaign(ctx.id).declaration, specs = specsOf(c.store, ctx.id, decl);
  const covered = c.store.tasks(ctx.id).filter((item) => specs.get(item.task_id)?.deliverable === 'commit' &&
    item.state === 'done' && passedCheck(item, specs.get(item.task_id).acceptance) &&
    ancestor(c, repo, item.verified_sha, task.verified_sha)).map((item) => ({ task: item.task_id, sha: item.verified_sha }));
  const detail = { task: task.task_id, sha: task.verified_sha, grantDigest: grant.digest, grantVersion: grant.record.version,
    grantedAt: grant.record.grantedAt, expiresAt: grant.record.expiresAt,
    destinations: grant.record.destinations.map((d) => d.id), covered };
  c.fenced(ctx, () => {
    const last = c.store.get("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'release-plan' ORDER BY seq DESC LIMIT 1", ctx.id)?.detail;
    if (JSON.stringify(last) !== JSON.stringify(detail)) c.store.journal(ctx.id, 'release-plan', detail, c.now());
  });
}

function waiting(c, ctx, task, destination, reason, eligibility = null) {
  c.fenced(ctx, () => {
    const detail = { task: task?.task_id ?? null, sha: task?.verified_sha ?? null, destination, reason, eligibility };
    const last = c.store.get("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'release-waiting' ORDER BY seq DESC LIMIT 1", ctx.id)?.detail;
    if (JSON.stringify(last) !== JSON.stringify(detail)) c.store.journal(ctx.id, 'release-waiting', detail, c.now());
  });
}

function ownRuntime(c, decl, repo) {
  if (decl.target.projectId === 'aiworks' || c.selfHosted(decl.target.repository)) return true;
  const common = (path) => {
    const out = git.exec(c.cmd.git, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: path });
    return out.ok ? resolve(out.stdout).toLowerCase() : null;
  };
  const own = common(SOURCE), target = common(repo.path);
  return !target || Boolean(own && own === target);
}

function taskEvidence(c, campaign, task, spec) {
  const ops = c.store.all('SELECT * FROM operations WHERE campaign_id = ? AND task_id = ? ORDER BY created_at', campaign.id, task.task_id);
  const checked = ops.filter((op) => op.kind === 'verify' && op.target_sha === task.verified_sha &&
    op.state === 'finished' && op.outcome?.class === 'result' && op.outcome.value?.verdict === 'accepted').at(-1);
  const implementSessions = ops.filter((op) => op.kind === 'implement').map((op) => op.session_id).filter(Boolean);
  const good = passedCheck(task, spec.acceptance) && !task.blocked && !pendingChanges(c.store, campaign.id, task.task_id, task.verified_sha) &&
    !awaitingAcceptance(c.store, campaign, task);
  return { taskState: task.state, verdict: good ? task.verification?.verdict : null, targetSha: checked?.target_sha,
    verifySession: checked?.session_id, implementSessions };
}

/** All production readers are positive evidence from the store, fresh base and
 * actual project preflight. No rehearsal reader is used by the supervisor. */
function evaluate(c, ctx, row, grant, repo, wayBack) {
  const campaign = c.store.campaign(ctx.id), decl = campaign.declaration, task = c.store.task(ctx.id, row.task_id);
  const spec = specsOf(c.store, ctx.id, decl).get(row.task_id);
  if (!task || !spec) return { eligible: false, failed: [{ reason: 'The assigned task is no longer present' }] };
  const candidate = { project: row.project, destinationId: row.destination, taskId: row.task_id, verifiedSha: row.verified_sha };
  const merged = mergedEventReader(c.store, ctx.id)(candidate);
  const verification = taskEvidence(c, campaign, task, spec);
  const protectedChange = authorityProblem(c, decl, repo, grant.base, row.verified_sha);
  const current = ancestor(c, repo, merged?.mergeCommit, grant.base) && task.verified_sha === row.verified_sha;
  const from = wayBack?.live?.revision ?? task.base_sha;
  const diff = runGit(c, repo, ['diff', '--name-status', '--no-renames', from, row.verified_sha]);
  const destState = destinationState(c.store, row.project, row.destination);
  const covered = (dep) => {
    const t = c.store.task(ctx.id, dep), s = specsOf(c.store, ctx.id, decl).get(dep);
    if (!t || !s || t.state !== 'done' || !passedCheck(t, s.acceptance)) return false;
    if (s.deliverable !== 'commit') return true;
    // A verified successor releases its included dependencies in one artifact.
    return Boolean(mergedEventReader(c.store, ctx.id)({ taskId: dep, verifiedSha: t.verified_sha })) && ancestor(c, repo, t.verified_sha, row.verified_sha);
  };
  const gatePassed = task.verification?.gate?.exit === '0' && !gateFailure(task.verification.gate) && passedCheck(task, spec.acceptance);
  const result = evaluateEligibility(candidate, {
    switches: () => releaseSwitches({ dataDir: c.dataDir, config: c.config, store: c.store, project: row.project, destination: row.destination, grant }),
    grant: () => grant.reason ? null : grant.loaded,
    authority: () => ({ decisionAccepted: true, registryPointsHere: Boolean(grant.pointer && !grant.reason) }), // accepted AW-010 in this reviewed runtime
    mergeGate: () => ({ repository: decl.target.repository, merges: c.config.merges }),
    verification: () => verification,
    merged: () => merged,
    current: () => ({ baseHead: grant.base, mergeCommitOnBase: current }),
    diff: () => diff.ok ? diff.stdout : null,
    checks: () => ({ sha: row.verified_sha, required: [{ name: 'independent verifier project gate', conclusion: gatePassed ? 'success' : 'unknown' }],
      preflight: wayBack?.knownGood === true && wayBack?.rollback === true }),
    wayBack: () => wayBack ?? { knownGood: false, rollback: false },
    dependencies: () => ({ independent: spec.dependsOn.length === 0, tasks: spec.dependsOn.map((id) => ({ taskId: id, released: covered(id) })) }),
    destinationState: () => ({ lockHeld: !destState.free && destState.releaseId !== row.id,
      unknownRelease: !destState.free && destState.releaseId !== row.id && ['unknown', 'rollback-failed'].includes(destState.state) }),
    ownerReserved: () => ({ reported: Boolean(protectedChange || task.blocked || task.result?.result !== 'resolved') }),
    role: releaseRoleReader({ store: credentialStoreFrom(c.config.release?.credentialStore ?? { kind: 'windows' }),
      refFor: () => grant.record?.destinations.find((d) => d.id === row.destination)?.credential?.ref }),
  }, { now: c.now() });
  const extra = !['registered', 'finished'].includes(campaign.control) ? 'The campaign is paused or cancelled'
    : maintenance(c) ? 'Runtime maintenance is draining releases'
      : c.unmergedRevision() ? 'Release requires the trusted merged runtime'
        : grant.reason ?? protectedChange ?? (wayBack?.live && !ancestor(c, repo, wayBack.live.revision, merged?.mergeCommit)
          ? 'The live revision is not an ancestor of this release; an older or divergent artifact will not be deployed' : null);
  if (extra) { result.eligible = false; result.failed.unshift({ check: 'authority', reason: extra }); }
  return result;
}

function forwardGate(c, ctx, row, repo, grant) {
  const campaign = c.store.campaign(ctx.id);
  if (!['registered', 'finished'].includes(campaign.control) || maintenance(c)) return 'Admissions are paused';
  if (c.unmergedRevision()) return 'Release requires the trusted merged runtime';
  if (grant.reason || grant.digest !== row.grant_digest || grant.record?.version !== row.grant_version) return grant.reason ?? 'Release authority changed; this release remains bound to its original grant';
  const task = c.store.task(ctx.id, row.task_id);
  const newest = newestMerge(c, row.project, repo, grant.base);
  if (newest && (newest.campaign_id !== row.campaign_id || newest.detail.sha !== row.verified_sha)) return 'A newer verified merge is waiting to be released';
  const event = mergedEventReader(c.store, ctx.id)({ taskId: row.task_id, verifiedSha: row.verified_sha });
  if (!ancestor(c, repo, event?.mergeCommit, grant.base) || task?.verified_sha !== row.verified_sha || task.state !== 'done' || task.blocked ||
      pendingChanges(c.store, ctx.id, row.task_id, row.verified_sha) || awaitingAcceptance(c.store, campaign, task)) return 'The exact merged and accepted candidate is no longer current';
  return authorityProblem(c, campaign.declaration, repo, grant.base, row.verified_sha) ??
    releaseGate({ config: c.config, dataDir: c.dataDir, store: c.store, project: row.project, destination: row.destination, grant });
}

async function drive(c, ctx, initial, repo) {
  let row = release(c.store, initial.id);
  const decl = c.store.campaign(ctx.id).declaration;
  if (!c.fenced(ctx, () => releaseCommandsStopped({ dataDir: c.dataDir, release: row }))) throw new Error('Prior release process ownership is unresolved');
  c.fenced(ctx, () => c.store.run('INSERT OR REPLACE INTO release_activity VALUES (?, ?, ?, ?, ?)', row.id, ctx.id, c.instanceId, ctx.generation, c.now()));
  try {
    const fresh = () => { try { return readProjectGrant(c, ctx, decl, repo); } catch (error) { return { reason: String(error.message) }; } };
    let grant = fresh();
    const newest = newestMerge(c, row.project, repo, grant.base);
    if (newest && (newest.campaign_id !== row.campaign_id || newest.detail.sha !== row.verified_sha)) {
      const record = readJsonIfExists(join(c.dataDir, 'releases', row.id, 'deploy.json'));
      if ((!record && row.history.length === 0) || record?.deploy === 'not-started') {
        c.fenced(ctx, () => {
          c.store.run("UPDATE releases SET state='refused', reason=?, updated_at=? WHERE id=?", 'Superseded by a newer verified merge before deployment started', c.now(), row.id);
          c.store.run('DELETE FROM release_locks WHERE release_id=?', row.id);
          c.store.journal(ctx.id, 'release-superseded', { release: row.id, by: newest.detail.sha }, c.now());
        });
        return;
      }
    }
    if (row.state === 'eligible' && row.history.length === 0 && !grant.reason && grant.record?.version > row.grant_version &&
        grant.record.destinations.some((d) => d.id === row.destination && d.kind === 'deploy')) {
      const record = readJsonIfExists(join(c.dataDir, 'releases', row.id, 'deploy.json'));
      if (!record || record.deploy === 'not-started') c.fenced(ctx, () => {
        const previous = { version: row.grant_version, digest: row.grant_digest };
        const updated = { ...row, grant_version: grant.record.version, grant_digest: grant.digest };
        // Snapshot first. If interrupted before the DB update, the same valid
        // higher grant repeats this preparation; no forward intent exists.
        pinGrant(c.dataDir, updated, grant.loaded);
        c.store.run('UPDATE releases SET grant_version=?, grant_digest=?, eligibility=NULL, reason=NULL, updated_at=? WHERE id=?',
          updated.grant_version, updated.grant_digest, c.now(), row.id);
        c.store.journal(ctx.id, 'release-grant-renewed', { release: row.id, previous, version: updated.grant_version, digest: updated.grant_digest }, c.now());
        row = release(c.store, row.id);
      });
    }
    if (row.state === 'eligible' && grant.digest === row.grant_digest && !grant.reason) c.fenced(ctx, () => pinGrant(c.dataDir, row, grant.loaded));
    const original = pinnedGrant(c.dataDir, row);
    const destination = original.destinations.find((d) => d.id === row.destination);
    if (destination?.kind !== 'deploy') throw new Error('Only post-merge project deployment is connected to this continuation');
    const adapter = deployAdapter({ destination, repo: repo.path, config: c.config, dataDir: c.dataDir, store: c.store, clock: () => c.now(),
      mutate: (fn) => c.fenced(ctx, fn),
      beforeDeploy: async () => {
        grant = fresh();
        return forwardGate(c, ctx, release(c.store, row.id), repo, grant);
      },
      runCommand: (args) => c.fenced(ctx, () => runReleaseCommand({ ...args, mutate: (fn) => c.fenced(ctx, fn) })) });
    const options = { lease: leaseOf(c, ctx), now: () => c.now() };
    if (row.state === 'eligible') {
      const gate = forwardGate(c, ctx, row, repo, grant);
      if (gate) { waiting(c, ctx, c.store.task(ctx.id, row.task_id), row.destination, gate); return; }
      const proof = await adapter.preflight({ ...row, step_key: row.id + '.preflight' });
      grant = fresh();
      if (!grant.reason) expectRelease(c, ctx, grant, c.store.task(ctx.id, row.task_id), repo);
      const result = evaluate(c, ctx, row, grant, repo, proof);
      c.fenced(ctx, () => c.store.run('UPDATE releases SET eligibility = ?, reason = ?, updated_at = ? WHERE id = ?',
        result, result.failed[0]?.reason ?? null, c.now(), row.id));
      if (!result.eligible) { waiting(c, ctx, c.store.task(ctx.id, row.task_id), row.destination, result.failed[0].reason, result); return; }
      const lock = acquireLock(c.store, row.id, { ...options, now: c.now(), recheck: () => evaluate(c, ctx, row, grant, repo, proof) });
      if (!lock.locked) return;
      row = lock.release;
    }
    row = await reconcile(c.store, adapter, row.id, options);
    if (TERMINAL.includes(row.state) || row.state === 'unknown' || row.state === 'rollback-failed') return;
    for (let n = 0; n < 3 && nextStep(row); n++) {
      grant = fresh();
      const previous = row.step_key;
      row = await runStep(c.store, adapter, row.id, { ...options, gate: (r) => forwardGate(c, ctx, r, repo, grant) });
      if (row.step_key === previous || TERMINAL.includes(row.state) || row.state === 'unknown') break;
    }
  } finally {
    c.fenced(ctx, () => {
      if (releaseCommandsStopped({ dataDir: c.dataDir, release: row })) c.store.run('DELETE FROM release_activity WHERE release_id = ?', row.id);
    });
  }
}

function launch(c, ctx, row, repo) {
  // One nonblocking command lane. The main loop keeps serving other campaigns;
  // this lease stays alive even during a long health window or graceful shutdown.
  const timer = setInterval(() => {
    try { c.fenced(ctx, () => null); } catch { clearInterval(timer); }
  }, Math.max(50, Math.min(5000, Math.floor(c.config.leaseMs / 3))));
  const promise = Promise.resolve().then(() => drive(c, ctx, row, repo)).catch((error) => {
    c.log(`release continuation: ${error.message}`);
    try { waiting(c, ctx, c.store.task(ctx.id, row.task_id), row.destination, String(error.message).slice(0, 400)); } catch { /* fenced */ }
  }).finally(() => { clearInterval(timer); c.releaseJob = null; });
  c.releaseJob = { promise, campaignId: ctx.id };
}

/** Called every tick, including after a campaign has finished implementation. */
export function releasePass(c) {
  if (c.releaseJob || c.unmergedRevision()) return;
  c.releaseNextAt ??= new Map();
  for (const activity of c.store.all('SELECT * FROM release_activity')) {
    const row = release(c.store, activity.release_id);
    if (!row || ![...TERMINAL, 'rollback-failed'].includes(row.state)) continue;
    const ctx = context(c, activity.campaign_id);
    if (ctx) c.fenced(ctx, () => {
      if (releaseCommandsStopped({ dataDir: c.dataDir, release: row })) c.store.run('DELETE FROM release_activity WHERE release_id = ?', row.id);
    });
  }
  // Recovery takes priority, even with new releases switched off or cancelled.
  const existing = c.store.all("SELECT * FROM releases WHERE state NOT IN ('accepted', 'rolled-back', 'refused', 'rollback-failed') ORDER BY created_at");
  for (const row of existing) {
    const key = row.id;
    if ((c.releaseNextAt.get(key) ?? 0) > c.now()) continue;
    c.releaseNextAt.set(key, c.now() + POLL_MS);
    const campaign = c.store.campaign(row.campaign_id);
    if (!campaign) continue;
    const ctx = context(c, campaign.id);
    if (!ctx) continue;
    const repo = c.repo(campaign.declaration);
    if (ownRuntime(c, campaign.declaration, repo)) continue;
    launch(c, ctx, row, repo); return;
  }
  if (c.config.release?.enabled !== true || maintenance(c)) return;
  for (const campaign of c.store.all("SELECT * FROM campaigns WHERE control IN ('registered', 'finished') ORDER BY created_at DESC")) {
    const key = 'campaign:' + campaign.id;
    if ((c.releaseNextAt.get(key) ?? 0) > c.now()) continue;
    c.releaseNextAt.set(key, c.now() + POLL_MS);
    const ctx = context(c, campaign.id);
    if (!ctx) continue;
    try {
      const decl = campaign.declaration;
      if (!projectReleasePointer(c, decl)) continue;
      const repo = c.repo(decl);
      if (ownRuntime(c, decl, repo)) continue;
      const grant = readProjectGrant(c, ctx, decl, repo);
      if (grant.reason) { waiting(c, ctx, null, null, grant.reason); continue; }
      const newest = newestMerge(c, decl.target.projectId, repo, grant.base);
      if (newest?.campaign_id !== campaign.id) continue;
      const task = c.store.task(campaign.id, newest.detail.task);
      if (task?.state !== 'done' || task.verified_sha !== newest.detail.sha || !ancestor(c, repo, newest.detail.mergeCommit, grant.base)) continue;
      expectRelease(c, ctx, grant, task, repo);
      for (const destination of grant.record.destinations) {
        if (destination.kind !== 'deploy') {
          waiting(c, ctx, null, destination.id, 'Automatic continuation supports deploy after the merge gate; this destination kind is not connected'); continue;
        }
        for (const task of [c.store.task(campaign.id, newest.detail.task)]) {
          if (task.state !== 'done' || !task.verified_sha) continue;
          const candidate = { project: decl.target.projectId, destination: destination.id, task_id: task.task_id, verified_sha: task.verified_sha };
          const event = mergedEventReader(c.store, campaign.id)({ taskId: task.task_id, verifiedSha: task.verified_sha });
          if (!event || !ancestor(c, repo, event.mergeCommit, grant.base)) continue;
          if (c.store.get('SELECT id FROM releases WHERE project = ? AND destination = ? AND verified_sha = ? LIMIT 1', candidate.project, candidate.destination, candidate.verified_sha)) continue;
          const result = evaluate(c, ctx, candidate, grant, repo, null);
          const gatePassed = result.inputs?.evidence?.checks?.required?.every((check) => check.conclusion === 'success') === true;
          const failure = result.failed.find((item) => item.check !== 'E9' && !(item.check === 'E8' && gatePassed));
          if (failure) { waiting(c, ctx, task, destination.id, failure.reason, result); continue; }
          const row = c.fenced(ctx, () => {
            if (c.store.get('SELECT id FROM releases WHERE project = ? AND destination = ? AND verified_sha = ? LIMIT 1', candidate.project, candidate.destination, candidate.verified_sha)) return null;
            return createRelease(c.store, { project: candidate.project, destination: destination.id, campaignId: campaign.id, taskId: task.task_id,
              verifiedSha: task.verified_sha, grantVersion: grant.record.version, grantDigest: grant.digest,
              steps: ['deploy', 'check'], lease: leaseOf(c, ctx), now: c.now() });
          });
          if (!row) continue;
          c.fenced(ctx, () => pinGrant(c.dataDir, row, grant.loaded));
          launch(c, ctx, row, repo); return;
        }
      }
    } catch (error) { waiting(c, ctx, null, null, String(error.message).slice(0, 400)); }
  }
}

export async function drainReleases(c) {
  if (c.releaseJob) await c.releaseJob.promise;
}
