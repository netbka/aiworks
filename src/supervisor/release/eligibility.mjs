// Eligibility of one exact verified revision for one destination (docs/design/AUTO_RELEASE.md section 5, slice REL2).
// Report only: it answers "would be eligible" or "not eligible, because ..." and never acts. Every check needs positive
// evidence: no reader, a reader that throws, returns undefined, null or a promise, or a value of the wrong shape fails
// the check. There is no "assume yes". Readers are injected, synchronous and read-only; this module makes no write and
// no external call of its own. Auto Release stays off: release.enabled is false until REL11. As amended on 2026-10-17
// (plan section 8 (i) and (k), slice REL5a): E12 applies only to a destination that still names a credential; a `deploy`
// destination releases only a task the merge gate journaled as `merged` at its verified revision; and a merge kind is
// refused in a repository the merge gate covers.
import { FORBIDDEN_CLASSES, parseAuthorization } from './authorization.mjs';
import { classify, UNCLASSIFIED } from './classify.mjs';

const LOCAL_KINDS = new Set(['local-git-apply', 'local-folder-apply']);
const DEPLOY_KINDS = new Set(['merge-then-deploy', 'deploy']);
const MERGE_KINDS = new Set(['merge', 'merge-then-deploy']);
const SHA = /^[0-9a-f]{40}$/;
const AUTO_RELEASE = 'auto-release';

/** Read one piece of evidence: { value } or { reason } when it is missing, unreadable or unknown. */
function obtain(read, name, candidate) {
  const reader = read?.[name];
  if (typeof reader !== 'function') return { reason: `${name}: no reader, so the evidence is missing` };
  let value;
  try { value = reader(candidate); } catch (error) { return { reason: `${name}: unreadable (${String(error?.message ?? error).slice(0, 160)})` }; }
  if (value === undefined) return { reason: `${name}: the evidence is missing` };
  if (value === null) return { reason: `${name}: unknown` };
  if (typeof value?.then === 'function') return { reason: `${name}: the reader did not answer synchronously, so the evidence is unknown` };
  return { value };
}

/**
 * The thirteen checks of AUTO_RELEASE.md section 5, in order. Each returns null when it passes, or one plain reason.
 * `ctx.evidence(name)` reads a reader once per evaluation; `ctx.grant()`, `ctx.destination()` and `ctx.classification()`
 * hold what several checks share.
 */
const CHECKS = [
  ['E1', 'Auto Release is on for this destination', (c, ctx) => {
    const { value, reason } = ctx.evidence('switches');
    if (reason) return reason;
    if (value.enabled !== true) return 'Auto Release is switched off (release.enabled is not true)';
    if (value.stop !== false) return value.stop === true ? 'RELEASE-STOP is set' : 'whether RELEASE-STOP is set is unknown';
    return value.mode === AUTO_RELEASE ? null : `the destination is in ${typeof value.mode === 'string' ? value.mode : 'an unknown'} mode, not Auto Release`;
  }],
  ['E2', 'The grant is valid now', (c, ctx) => {
    const grant = ctx.grant();
    if (grant.reason) return grant.reason;
    const destination = ctx.destination();
    if (!destination) return `the grant names no destination ${c.destinationId ?? '(none given)'}`;
    // Positive evidence that the merge gate does not merge in this repository; the grant itself refused it if it does.
    const gate = ctx.evidence('mergeGate');
    return MERGE_KINDS.has(destination.kind) && gate.reason ? `whether the merge gate covers this repository is unknown (${gate.reason})` : null;
  }],
  ['E3', 'The authority exists', (c, ctx) => {
    const { value, reason } = ctx.evidence('authority');
    if (reason) return reason;
    if (value.decisionAccepted !== true) return 'the release decision is not accepted in docs/DECISIONS.md of the running revision';
    return value.registryPointsHere === true ? null : 'the governance provider registry entry does not point to this grant';
  }],
  ['E4', 'The candidate was independently checked', (c, ctx) => {
    const { value, reason } = ctx.evidence('verification');
    if (reason) return reason;
    if (value.taskState !== 'done') return `task ${c.taskId} is ${typeof value.taskState === 'string' ? value.taskState : 'in an unknown state'}, not done`;
    if (value.verdict !== 'accepted') return `no accepted verification (verdict ${value.verdict ?? 'unknown'})`;
    if (value.targetSha !== c.verifiedSha) return `the accepted verification checked ${value.targetSha ?? 'an unknown revision'}, not ${c.verifiedSha}`;
    if (typeof value.verifySession !== 'string' || !value.verifySession || !Array.isArray(value.implementSessions) || !value.implementSessions.length) {
      return 'the verifier and implementer sessions are unknown';
    }
    return value.implementSessions.includes(value.verifySession) ? 'the same session implemented and verified it' : null;
  }],
  ['E5', 'The candidate is the published one', (c, ctx) => {
    const destination = ctx.destination();
    if (!destination) return 'no valid destination to compare with';
    const { value, reason } = ctx.evidence(destination.kind === 'deploy' ? 'merged' : 'published');
    if (reason) return destination.kind === 'deploy' ? `the merge gate recorded no merged event for task ${c.taskId} at ${c.verifiedSha} (${reason})` : reason;
    if (LOCAL_KINDS.has(destination.kind)) return value.stagedRevision === c.verifiedSha ? null : 'the staged revision is not the verified one';
    if (destination.kind === 'deploy') return mergedReason(c, value);
    if (value.state !== 'OPEN') return `the pull request is ${typeof value.state === 'string' ? value.state.toLowerCase() : 'in an unknown state'}`;
    if (value.isDraft !== false) return 'the pull request is a draft, or whether it is one is unknown';
    if (value.headSha !== c.verifiedSha) return `the pull request head is ${value.headSha ?? 'unknown'}, not ${c.verifiedSha}`;
    return value.baseBranch === destination.baseBranch ? null : `the pull request targets ${value.baseBranch ?? 'an unknown branch'}, not ${destination.baseBranch}`;
  }],
  ['E6', 'The candidate is current', (c, ctx) => {
    const destination = ctx.destination();
    if (!destination) return 'no valid destination to compare with';
    const { value, reason } = ctx.evidence('current');
    if (reason) return reason;
    if (LOCAL_KINDS.has(destination.kind)) return value.manifestMatches === true ? null : 'a file the release would write changed at the destination since the work started';
    if (!SHA.test(value.baseHead ?? '')) return 'the freshly fetched base head is unknown';
    // A deploy follows the merge: the merge commit the gate recorded must still be on the freshly fetched base.
    if (destination.kind === 'deploy') return value.mergeCommitOnBase === true ? null : `the recorded merge commit is not on the base head ${value.baseHead}, or whether it is is unknown`;
    return value.baseIsAncestor === true ? null : `the base moved since verification (now ${value.baseHead})`;
  }],
  ['E7', 'Every changed file is in an accepted class', (c, ctx) => {
    const destination = ctx.destination();
    if (!destination) return 'no valid destination to compare with';
    const result = ctx.classification();
    if (result.reason) return result.reason;
    if (!result.files.length) return 'the candidate changes no file, so there is nothing to classify';
    const unclassified = result.files.filter((file) => file.class === UNCLASSIFIED);
    if (unclassified.length) return `unclassified: ${unclassified.slice(0, 5).map((file) => file.path).join(', ')}`;
    const accepted = new Set(destination.changeClasses);
    const confirm = new Set(ctx.grant().record.ownerConfirm ?? []);
    const refused = result.classes.filter((name) => !accepted.has(name) || confirm.has(name) || FORBIDDEN_CLASSES.includes(name));
    return refused.length ? `not granted for this destination: ${refused.join(', ')}` : null;
  }],
  ['E8', 'Required project checks passed on this exact revision', (c, ctx) => {
    const { value, reason } = ctx.evidence('checks');
    if (reason) return reason;
    if (value.sha !== c.verifiedSha) return `the checks read are for ${value.sha ?? 'an unknown revision'}, not ${c.verifiedSha}`;
    if (!Array.isArray(value.required) || !value.required.length) return 'no required check is known for this revision';
    const notGreen = value.required.filter((check) => check?.conclusion !== 'success');
    if (notGreen.length) return `not passed: ${notGreen.slice(0, 5).map((check) => `${check?.name ?? 'unnamed'} (${check?.conclusion ?? 'unknown'})`).join(', ')}`;
    return value.preflight === true ? null : 'the release preflight evidence is absent';
  }],
  ['E9', 'There is a way back', (c, ctx) => {
    const destination = ctx.destination();
    if (!destination) return 'no valid destination to compare with';
    if (destination.kind === 'merge') return null; // a merge is undone by a revert pull request (AUTO_RELEASE.md 7.3)
    const { value, reason } = ctx.evidence('wayBack');
    if (reason) return reason;
    if (DEPLOY_KINDS.has(destination.kind)) {
      if (!destination.commands?.rollback || value.rollback !== true) return 'no rollback command';
      return value.knownGood === true ? null : 'observe does not report a previous known-good version';
    }
    if (value.backupSpace !== true) return 'there is not enough free space for the backup, or it is unknown';
    return value.readable === true ? null : 'a target path is not readable, or it is unknown';
  }],
  ['E10', 'Dependencies are released', (c, ctx) => {
    const { value, reason } = ctx.evidence('dependencies');
    if (reason) return reason;
    if (value.independent === true) return null;
    if (!Array.isArray(value.tasks)) return 'the dependencies are unknown';
    const pending = value.tasks.filter((task) => task?.released !== true);
    return pending.length ? `not released yet: ${pending.map((task) => task?.taskId ?? 'unknown').join(', ')}` : null;
  }],
  ['E11', 'The destination is free', (c, ctx) => {
    const { value, reason } = ctx.evidence('destinationState');
    if (reason) return reason;
    if (value.lockHeld !== false) return value.lockHeld === true ? 'another release holds the destination lock' : 'the destination lock state is unknown';
    return value.unknownRelease === false ? null : 'an earlier release to this destination is unresolved, or whether one is is unknown';
  }],
  ['E12', 'The release role can act', (c, ctx) => {
    // A destination that names no credential uses the logins already on this computer (plan section 8 (i)): there is
    // no credential to resolve. Without a valid destination it is unknown whether one is named, so the check runs.
    const destination = ctx.destination();
    if (destination && !destination.credential) return null;
    const { value, reason } = ctx.evidence('role');
    if (reason) return reason;
    if (value.installed !== true) return 'the release role is not installed';
    return value.credentialResolves === true ? null : 'the release credential reference does not resolve';
  }],
  ['E13', 'Nothing owner-reserved is touched', (c, ctx) => {
    const { value, reason } = ctx.evidence('ownerReserved');
    if (reason) return reason;
    if (value.reported !== false) return value.reported === true ? 'a worker reported an owner-reserved trigger on this task' : 'whether a worker reported an owner-reserved trigger is unknown';
    const result = ctx.classification();
    if (result.reason) return `the changed classes are unknown: ${result.reason}`;
    const confirm = ctx.grant().record.ownerConfirm ?? [];
    const reserved = result.classes.filter((name) => FORBIDDEN_CLASSES.includes(name) || confirm.includes(name));
    return reserved.length ? `owner-reserved classes: ${reserved.join(', ')}` : null;
  }],
];

export const CHECK_IDS = Object.freeze(CHECKS.map(([id]) => id));

/** E5 for a `deploy` destination: the merge gate's own `merged` journal entry for this task at its verified revision. */
function mergedReason(c, value) {
  if (value.task !== c.taskId || value.sha !== c.verifiedSha) {
    return `the merge gate recorded no merged event for task ${c.taskId} at ${c.verifiedSha} (the one read is for ${value.task ?? 'an unknown task'} at ${value.sha ?? 'an unknown revision'})`;
  }
  return SHA.test(value.mergeCommit ?? '') ? null : 'the merged event names no merge commit';
}

/**
 * The `merged` reader for one campaign: the latest `merged` journal entry the merge gate (merge.mjs) wrote for the
 * candidate's task at its verified revision, or undefined (missing evidence) when there is none. Read-only.
 */
export const mergedEventReader = (store, campaignId) => (candidate) => store.get(`SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'merged'
    AND json_extract(detail, '$.task') = ? AND json_extract(detail, '$.sha') = ? ORDER BY seq DESC LIMIT 1`, campaignId, candidate.taskId, candidate.verifiedSha)?.detail;

/**
 * Evaluate one candidate ({ project, destinationId, taskId, verifiedSha }) with injected read-only readers, each called
 * once with the candidate: switches, grant, authority, verification, published, current, diff, checks, wayBack,
 * dependencies, destinationState, role, ownerReserved, mergeGate and, for a `deploy` destination, merged (mergedEventReader).
 * `mergeGate` returns { repository, merges }: the project's owner/name repository and config.json `merges`.
 * `grant` returns { bytes, commit, ref?, path? }: the record's exact bytes
 * at the freshly fetched base head, that commit and, optionally, the ref and path it was read from (kept in `inputs`). The grant is validated here (release/authorization.mjs), never
 * taken from the reader's word. `now` decides expiry.
 * Returns { eligible, failed: [{ check, title, reason }], inputs }. `inputs` records what was used (grant digest and
 * commit, classification, every other reader's answer), so a later step can refuse to carry an old answer forward.
 */
export function evaluateEligibility(candidate, read, { now = Date.now() } = {}) {
  const seen = new Map();
  let grant, classification;
  const ctx = {
    evidence(name) {
      if (!seen.has(name)) seen.set(name, obtain(read, name, candidate));
      return seen.get(name);
    },
    grant() {
      if (grant) return grant;
      const { value, reason } = ctx.evidence('grant');
      if (reason) return (grant = { reason });
      if (!SHA.test(value.commit ?? '')) return (grant = { reason: 'the base branch commit the grant was read from is unknown' });
      if (!Buffer.isBuffer(value.bytes) && typeof value.bytes !== 'string') return (grant = { reason: 'grant: the record bytes are missing' });
      const gate = ctx.evidence('mergeGate');
      const parsed = parseAuthorization(value.bytes, { project: candidate.project, now, ...(gate.value ? { mergeGate: gate.value } : {}) });
      if (!parsed.valid) return (grant = { reason: `the grant is not valid: ${parsed.reasons.slice(0, 3).join('; ')}`, digest: parsed.digest, commit: value.commit });
      const record = JSON.parse(Buffer.isBuffer(value.bytes) ? value.bytes.toString('utf8') : value.bytes);
      return (grant = { record, digest: parsed.digest, commit: value.commit, source: grantSource(value) });
    },
    destination() {
      return ctx.grant().record?.destinations.find((item) => item.id === candidate.destinationId) ?? null;
    },
    classification() {
      if (classification) return classification;
      const record = ctx.grant().record;
      if (!record) return (classification = { reason: 'there is no valid grant to classify against' });
      const { value, reason } = ctx.evidence('diff');
      if (reason) return (classification = { reason });
      try { return (classification = classify(value, record.classes)); }
      catch (error) { return (classification = { reason: `diff: unreadable (${error.message})` }); }
    },
  };
  const failed = [];
  for (const [check, title, run] of CHECKS) {
    const reason = run(candidate, ctx);
    if (reason) failed.push({ check, title, reason });
  }
  const evidence = Object.fromEntries([...seen].filter(([name, item]) => !['grant', 'diff'].includes(name) && 'value' in item).map(([name, item]) => [name, item.value]));
  return {
    eligible: failed.length === 0,
    failed,
    inputs: {
      evaluatedAt: new Date(now).toISOString(),
      grantDigest: grant?.digest ?? null,
      grantCommit: grant?.commit ?? null,
      grantVersion: Number.isInteger(grant?.record?.version) ? grant.record.version : null,
      grantSource: grant?.source ?? null,
      destination: destinationSnapshot(grant?.record ? ctx.destination() : null),
      classification: classification && !classification.reason ? classification : null,
      evidence,
    },
  };
}

/** Where the grant was read: { ref, path } when the reader named both as plain names, so a later read-only step can read it again. */
function grantSource(value) {
  const plain = (text) => typeof text === 'string' && text.length > 0 && text.length <= 512 && !text.startsWith('-') && !/[\\:\u0000-\u001f]/.test(text);
  return plain(value.ref) && plain(value.path) ? { ref: value.ref, path: value.path } : null;
}

/**
 * What a release row keeps of its destination (AUTO_RELEASE.md section 9, OWNER_UI_V2 WP9): its id, environment, kind,
 * rollback rule, check window and which project commands it names, never their paths' contents. The owner view states the
 * restore scope and whether a post-release check exists from this; a row without it says the scope is unknown.
 */
function destinationSnapshot(destination) {
  if (!destination) return null;
  const commands = destination.commands ?? {};
  return { id: destination.id, environment: destination.environment, kind: destination.kind, rollback: destination.rollback,
    checkWindowMinutes: destination.checkWindowMinutes, changeClasses: [...destination.changeClasses],
    commands: ['deploy', 'observe', 'check', 'rollback'].filter((name) => typeof commands[name] === 'string') };
}

/** The one-line owner wording for a result: "Would be eligible ..." or "Not eligible, because <first reason>". */
export function eligibilitySummary(result) {
  return result.eligible ? 'Would be eligible for Auto Release (report only: nothing is released)' : `Not eligible, because ${result.failed[0].reason}`;
}

export const REVIEW_ONLY_SUMMARY = 'Review only: checked results are published for review; AIWorks never merges or deploys them.';

/**
 * The `release` field of campaign status. Auto Release is built switched off: `release.enabled` is false (the switch
 * itself arrives with slice REL4), no grant is read and no reader is wired, so every done task is reported not eligible
 * with the reason and the project stays in Review only. It runs the real evaluator so the report is the evaluator's own
 * answer, and it acts on nothing. Waits for the owner's decision on example-org/aiworks#33.
 */
export function releaseStatus({ project, tasks }) {
  const read = { switches: () => ({ enabled: false, stop: null, mode: 'review-only' }) };
  return {
    mode: 'review-only',
    enabled: false,
    summary: REVIEW_ONLY_SUMMARY,
    tasks: tasks.filter((task) => task.state === 'done').map((task) => {
      const result = evaluateEligibility({ project, destinationId: null, taskId: task.task_id, verifiedSha: task.verified_sha }, read);
      return { taskId: task.task_id, verifiedSha: task.verified_sha ?? null, destination: null, eligible: result.eligible,
        summary: eligibilitySummary(result), failedChecks: result.failed.map((item) => item.check) };
    }),
  };
}
