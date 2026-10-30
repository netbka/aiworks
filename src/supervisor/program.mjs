// The owner's program record (docs/PROJECT_WORKSPACE_PLAN.md section 6.8d, slice PROG1; netbka/aiworks#153 option B).
// One private aiworks-program/1 file names a repository, a plan and the slices whose waves may later start by themselves.
// PROG1 validates the record, keeps it by its canonical digest and reads the stop switches. PROG3 adds the registration
// pass (programPass), one call per controller pass. Both are built switched off: with program.enabled absent nothing here
// reads the plan or registers a wave or a campaign; PROG5 switches it on.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { SECRET_LIKE_PATH_PATTERN } from '../../scripts/lib/worker-context.mjs';
import * as gitA from './adapters/git.mjs';
import { CampaignError, campaignStart } from './api.mjs';
import { assertPrivateStore } from './approved-declarations.mjs';
import { assertRegisteredTarget, authorityDigest, canonicalJson, validateDeclaration } from './campaign.mjs';
import { blockerFingerprint, redact } from './owner-intervention.mjs';
import { coversSlice, proposeWave } from './program-plan.mjs';
import { CODE_ROOT, revisionNotMerged } from './provenance.mjs';

export const PROGRAM_SCHEMA = 'aiworks-program/1';
/** The file in the supervisor data directory that stops every new wave of every program. Removing it is the owner's. */
export const PROGRAM_STOP = 'PROGRAM-STOP';
const validate = new Ajv2020({ allErrors: true })
  .compile(JSON.parse(readFileSync(new URL('../../schemas/program-record.schema.json', import.meta.url), 'utf8')));
const secretPath = new RegExp(SECRET_LIKE_PATH_PATTERN, 'u');

// Created here, on the first approved record, because slice PROG1 does not own store.mjs. It is additive: a store that
// never saw a program record has no table and behaves exactly as before. One row per program: a newer version replaces it.
const PROGRAMS_DDL = `CREATE TABLE IF NOT EXISTS programs (
  program_id TEXT PRIMARY KEY, version INTEGER NOT NULL, digest TEXT NOT NULL, record_text TEXT NOT NULL,
  granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, approved_at INTEGER NOT NULL, revoked_at INTEGER)`;
const hasPrograms = (store) => Boolean(store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'programs'"));
const short = (digest) => String(digest).slice(0, 12);

/** Off unless config.json says `"program": { "enabled": true }`; absent, malformed or anything else is off. */
export const programEnabled = (config) => config?.program?.enabled === true;

/** The canonical digest of a record: key order and whitespace never change it. */
export const programDigest = (record) => createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex');

/**
 * The shape of a program record; throws PROGRAM_INVALID without echoing its contents. The executor and constraints must
 * also pass the campaign declaration rules, because each wave's declaration carries them unchanged.
 */
export function validateProgram(record) {
  if (!validate(record) || Number.isNaN(Date.parse(record.authorization.grantedAt))) {
    // Only schema-defined names are reported: an unknown field is located, never named, since its name is the file's.
    const fields = [...new Set((validate.errors ?? []).map((error) => error.params?.additionalProperty !== undefined
      ? `${error.instancePath || '/'} (unknown field)` : error.instancePath || (error.params?.missingProperty ? `/${error.params.missingProperty}` : '/')))];
    throw new CampaignError('PROGRAM_INVALID', `The program record is not a valid ${PROGRAM_SCHEMA} record${fields.length ? ` (check ${fields.slice(0, 5).join(', ')})` : ' (check /authorization/grantedAt)'}.`);
  }
  try {
    validateDeclaration({
      version: 1, campaignId: 'program-check', authorization: record.authorization,
      target: { tenantId: 'program', projectId: 'program', environment: 'research', repository: record.repository, baseBranch: record.baseBranch, trackingIssue: 1 },
      executor: record.executor, constraints: record.constraints,
      tasks: [{ id: 'T1', issue: 1, title: 'check', deliverable: 'commit', goal: 'check', dependsOn: [], acceptance: ['check'], references: [record.plan] }],
    });
  } catch {
    throw new CampaignError('PROGRAM_INVALID', `The program record is not a valid ${PROGRAM_SCHEMA} record (check /executor, /constraints: a campaign declaration would refuse them).`);
  }
  return record;
}

/** The owner's private program record, read only by merged runtime code, as an envelope approval is (provenance.mjs). */
export function programFromFile(file, { root = CODE_ROOT } = {}) {
  const notMerged = revisionNotMerged({ root });
  if (notMerged) throw new CampaignError('RUNTIME_NOT_MERGED', notMerged);
  try {
    const requested = resolve(String(file ?? ''));
    if (secretPath.test(requested.replaceAll('\\', '/').toLowerCase())) throw new Error('Not a program record path');
    const path = realpathSync.native(requested);
    if (secretPath.test(path.replaceAll('\\', '/').toLowerCase())) throw new Error('Not a program record path');
    const stat = statSync(path);
    if (extname(path) !== '.json' || !stat.isFile() || stat.size > 1024 * 1024) throw new Error('Expected a JSON record of at most 1 MiB');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // Never echo private file contents or parser snippets into diagnostics.
    throw new CampaignError('PROGRAM_INVALID', `Cannot read the local program record (${error.code ?? error.name}).`);
  }
}

/**
 * Whether `<dataDir>/PROGRAM-STOP` exists: true, false, or null when that cannot be read. It needs no database, so it
 * works when SQLite or the program code is broken. A caller treats null as stopped: a stop is never assumed absent.
 */
export function programStopped(dataDir, { exists = existsSync } = {}) {
  try { return typeof dataDir === 'string' && dataDir ? exists(join(dataDir, PROGRAM_STOP)) === true : null; } catch { return null; }
}

/** Create PROGRAM-STOP: every program stops before its next wave. No database is opened. Returns the file's path. */
export function stopPrograms(dataDir, { reason = null, now = Date.now() } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('stopPrograms needs the data directory');
  const file = join(dataDir, PROGRAM_STOP);
  writeFileSync(file, `${new Date(now).toISOString()}${reason ? ` ${reason}` : ''}\n`);
  return file;
}

const view = (row) => ({ programId: row.program_id, version: row.version, digest: row.digest, grantedBy: row.granted_by, grantedAt: row.granted_at,
  approvedAt: new Date(row.approved_at).toISOString(), revoked: row.revoked_at !== null, revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString() });

/** The approved programs, without their contents. Read-only; a store that never saw a record has none. */
export function approvedPrograms(store) {
  if (!store || !hasPrograms(store)) return [];
  return store.all('SELECT * FROM programs ORDER BY program_id').map(view);
}

/** The switches and the approved programs. Reads the store only when one is given and never writes it. */
export function programStatus({ store = null, dataDir, config }) {
  return { enabled: programEnabled(config), stop: programStopped(dataDir), programs: approvedPrograms(store),
    registers: programEnabled(config) ? 'the next wave of each unrevoked program, at most once an hour, while PROGRAM-STOP is absent and no earlier wave has unfinished tasks'
      : 'nothing: program.enabled is off, so no wave is proposed or registered (PROG5 switches it on)' };
}

/**
 * Keep the owner's record by its canonical digest. The first record of a program is stored; a higher
 * authorization.version replaces it; a lower or equal version is refused (PROGRAM_VERSION_NOT_NEWER). `revoked: true`
 * revokes the program, and a revoked program stays revoked: every later record of it is refused (PROGRAM_REVOKED).
 * New work after a revocation uses a new programId. Approving registers nothing and starts nothing.
 */
export function approveProgram(store, record, { now = Date.now() } = {}) {
  validateProgram(record);
  assertPrivateStore(store);
  store.db.exec(PROGRAMS_DDL);
  return store.tx(() => {
    const { programId, authorization: { version, grantedBy, grantedAt } } = record;
    const digest = programDigest(record);
    const existing = store.get('SELECT * FROM programs WHERE program_id = ?', programId);
    if (existing?.revoked_at !== null && existing?.revoked_at !== undefined) {
      throw new CampaignError('PROGRAM_REVOKED', `program ${programId} was revoked at ${new Date(existing.revoked_at).toISOString()} and stays revoked; approve new work under a new programId`);
    }
    if (existing && version <= existing.version) {
      throw new CampaignError('PROGRAM_VERSION_NOT_NEWER', `program ${programId} is approved at version ${existing.version}; a record replaces it only with a higher authorization.version (this one is ${version})`);
    }
    const revokedAt = record.revoked === true ? now : null;
    store.run(`INSERT INTO programs (program_id, version, digest, record_text, granted_by, granted_at, approved_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (program_id) DO UPDATE SET version = excluded.version, digest = excluded.digest, record_text = excluded.record_text,
      granted_by = excluded.granted_by, granted_at = excluded.granted_at, approved_at = excluded.approved_at, revoked_at = excluded.revoked_at`,
    programId, version, digest, canonicalJson(record), grantedBy, grantedAt, now, revokedAt);
    store.journal(null, revokedAt === null ? 'program-approved' : 'program-revoked',
      { programId, version, digest, replaced: existing ? { version: existing.version, digest: short(existing.digest) } : null }, now);
    return { ...view(store.get('SELECT * FROM programs WHERE program_id = ?', programId)), replaced: existing ? existing.version : null };
  });
}

// ---- PROG3: registration in the supervisor pass (docs/PROJECT_WORKSPACE_PLAN.md section 6.8d, "Registration"). ----

/** A program is checked at most once an hour. The check times are memory only: after a restart each program is checked once more. */
export const PROGRAM_PASS_MS = 60 * 60_000;
// One row per registered wave. The primary key is what makes a wave number registrable once: the row, the campaign and
// the program-registered journal event are written in one transaction, so a crash between them leaves none of them.
const WAVES_DDL = `CREATE TABLE IF NOT EXISTS program_waves (
  program_id TEXT NOT NULL, wave INTEGER NOT NULL, campaign_id TEXT NOT NULL UNIQUE, record_version INTEGER NOT NULL,
  record_digest TEXT NOT NULL, declaration_digest TEXT NOT NULL, plan_revision TEXT NOT NULL, registered_at INTEGER NOT NULL,
  PRIMARY KEY (program_id, wave))`;
const hasWaves = (store) => Boolean(store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'program_waves'"));
// A wave campaign is `<programId>-w<n>` (program-plan.mjs buildWave).
const waveOf = (programId, campaignId) => {
  const match = /-w(\d+)$/.exec(campaignId);
  return match && campaignId === `${programId}-w${match[1]}` ? Number(match[1]) : null;
};
const ACTIVE = new Set(['registered', 'paused', 'cancel-requested']);
const sameRepository = (decl, record) => String(decl?.target?.repository ?? '').toLowerCase() === record.repository.toLowerCase();
/** The owner's misfit item: one per program, deduplicated by this fingerprint whatever the reason or the wave. */
const misfitFingerprint = (record) => blockerFingerprint({ project: record.repository, environment: 'program', dependency: 'program-wave',
  blockerClass: 'B3', identity: `program ${record.programId}` });

/**
 * Why a built wave does not fit the record exactly, or null. The proposal is built from the record, so a misfit here
 * means the builder and the record disagree: nothing is registered on a disagreement.
 */
export function waveMisfit(declaration, record, wave) {
  if (declaration.campaignId !== `${record.programId}-w${wave}`) return `the campaign id is not ${record.programId}-w${wave}`;
  if (declaration.target.repository !== record.repository || declaration.target.baseBranch !== record.baseBranch) return "the target is not the record's repository and base branch";
  for (const key of ['authorization', 'executor', 'constraints']) {
    if (canonicalJson(declaration[key]) !== canonicalJson(record[key])) return `the ${key} is not the record's, unchanged`;
  }
  for (const task of declaration.tasks) {
    if (!record.allow.some((entry) => coversSlice(entry, task.id))) return `slice ${task.id} is not allowed by the record`;
    const excluded = record.exclude.find((entry) => coversSlice(entry, task.id));
    if (excluded) return `slice ${task.id} is excluded by the record (${excluded})`;
    if (task.deliverable !== 'commit' || task.requiresMergedDependencies !== true || !task.writes?.length) {
      return `slice ${task.id} is not a commit with named files that waits for merged dependencies`;
    }
  }
  return null;
}

/** Task facts for program-plan.mjs: every task of every campaign of the record's repository, `onMain` read from the fetched base. */
function taskFacts(controller, campaigns, repoPath, baseSha) {
  const facts = [];
  for (const c of campaigns) {
    for (const task of controller.store.tasks(c.id)) {
      if (task.state === 'done') {
        const onMain = /^[0-9a-f]{40}$/.test(task.verified_sha ?? '') &&
          gitA.isAncestor({ git: controller.cmd.git, path: repoPath, ancestor: task.verified_sha, descendant: baseSha });
        facts.push({ taskId: task.task_id, state: 'done', onMain });
      } else if (ACTIVE.has(c.control)) facts.push({ taskId: task.task_id, state: 'running', onMain: false });
    }
  }
  return facts;
}

/**
 * One Needs you item for a wave that was not registered: a B3 blocker record (owner-intervention.mjs), one per program. A
 * recurrence updates it; a changed reason or proposal is journaled as program-misfit with the proposed declaration.
 */
function recordMisfit(controller, row, record, { wave, reason, proposal = null }) {
  const { store } = controller;
  const now = controller.now();
  const fingerprint = misfitFingerprint(record);
  const evidence = { wave, reason: redact(reason, 300), declarationDigest: proposal?.digest ?? null };
  const summary = `Wave ${wave} of program ${record.programId} was not registered: ${reason}`;
  const action = proposal?.digest
    ? `Read the proposed declaration ${proposal.digest.slice(0, 12)} in the program-misfit journal event. Approve a program record it fits with program-approve, or change the plan on main. Nothing was registered.`
    : 'Fix the cause named here, or approve a newer program record with program-approve. Nothing was registered.';
  store.tx(() => {
    const existing = store.blocker(fingerprint);
    const changed = !existing || existing.status === 'resolved' || canonicalJson(existing.last_evidence ?? null) !== canonicalJson(evidence);
    if (!existing) {
      store.insert('blockers', { fingerprint, project: record.repository, environment: 'program', dependency: 'program-wave', class: 'B3',
        identity: `program ${record.programId}`, subject: record.programId, status: 'open', episode: 1, summary: redact(summary), requested_action: redact(action),
        recheck_procedure: 'The program pass checks the plan again within the hour; a registered wave resolves this item.',
        first_detected_at: now, last_seen_at: now, occurrences: 1, recheck_attempts: 0, next_recheck_at: null, last_evidence: evidence, reminders: 0, updated_at: now });
    } else {
      store.run(`UPDATE blockers SET status = 'open', episode = episode + ?, summary = ?, requested_action = ?, last_seen_at = ?, occurrences = occurrences + 1,
        last_evidence = ?, resolution = NULL, resolved_at = NULL, updated_at = ? WHERE fingerprint = ?`,
      existing.status === 'resolved' ? 1 : 0, redact(summary), redact(action), now, evidence, now, fingerprint);
    }
    if (changed) {
      store.journal(null, 'program-misfit', { programId: record.programId, wave, reason: evidence.reason, fingerprint,
        recordDigest: row.digest, declarationDigest: proposal?.digest ?? null, declaration: proposal?.declaration ?? null }, now);
    }
  });
  controller.log(`program ${record.programId}: wave ${wave} not registered (Needs you): ${redact(reason, 300)}`);
  return { programId: record.programId, wave, registered: false, reason };
}

/** The next wave of one approved program, registered when it fits; see programPass. */
function programWave(controller, row) {
  const { store } = controller;
  const record = JSON.parse(row.record_text);
  validateProgram(record);
  if (programDigest(record) !== row.digest) throw new CampaignError('PROGRAM_INVALID', `program ${row.program_id} does not match its stored digest`);
  if (record.revoked === true) return null;
  const campaigns = store.all('SELECT id, declaration, control, created_at FROM campaigns ORDER BY created_at DESC, id DESC')
    .filter((c) => sameRepository(c.declaration, record));
  // One wave at a time: a wave of this program with an unfinished task holds the next one. A step AIWorks ended as not
  // done (AW-017, a cancelled task) is settled, so its wave finishes and the next one may start.
  const waves = campaigns.filter((c) => waveOf(record.programId, c.id) !== null);
  const open = waves.find((c) => c.control !== 'cancelled' && store.tasks(c.id).some((task) => !['done', 'cancelled'].includes(task.state)));
  if (open) return { programId: record.programId, waiting: `wave ${open.id} has unfinished tasks` };
  const numbers = [...waves.map((c) => waveOf(record.programId, c.id)),
    ...(hasWaves(store) ? store.all('SELECT wave FROM program_waves WHERE program_id = ?', record.programId).map((w) => w.wave) : [])];
  const wave = Math.max(0, ...numbers) + 1;
  // The trusted main: the base branch fetched into the supervisor's own ref, as the merge gate reads it. Read-only.
  const repo = controller.repo({ target: { repository: record.repository } });
  const fetched = controller.fetchBase(repo.path, record.baseBranch);
  if (!fetched.ok) return { programId: record.programId, waiting: `${record.baseBranch} could not be fetched` };
  const plan = gitA.exec(controller.cmd.git, ['show', `${fetched.sha}:${record.plan}`], { cwd: repo.path });
  if (!plan.ok) return recordMisfit(controller, row, record, { wave, reason: `${record.plan} is not on ${record.baseBranch} at ${fetched.sha.slice(0, 12)}` });
  // The project, environment and tracking issue come from the newest campaign the owner registered for this repository.
  const template = campaigns.find((c) => c.declaration.target.baseBranch === record.baseBranch)?.declaration.target;
  if (!template) return recordMisfit(controller, row, record, { wave, reason: `no campaign for ${record.repository} ${record.baseBranch} names its project and tracking issue yet` });
  const target = { tenantId: template.tenantId, projectId: template.projectId, environment: template.environment, trackingIssue: template.trackingIssue };
  const facts = taskFacts(controller, campaigns, repo.path, fetched.sha);
  let proposal;
  try {
    proposal = proposeWave({ planText: plan.stdout, record, facts, wave, target });
  } catch (error) {
    return recordMisfit(controller, row, record, { wave, reason: `the wave cannot be built from the plan: ${error.message}` });
  }
  if (!proposal.declaration) {
    // No wave is open here. An allowed slice that is not done but held anyway would wait silently forever (#228).
    const never = new Set(['not-allowed', 'excluded', 'runbook-only', 'done']);
    const held = proposal.notReady.filter((entry) => !entry.reasons.some((reason) => never.has(reason.code)));
    // In flight: an allowed slice still running, or verified but not yet on main. Its merge will free the held slices (#228).
    const inFlight = facts.some((fact) => !fact.onMain &&
      record.allow.some((entry) => coversSlice(entry, fact.taskId)) && !record.exclude.some((entry) => coversSlice(entry, fact.taskId)));
    if (!held.length || inFlight) return { programId: record.programId, waiting: 'no slice is ready' };
    const reason = `no slice is ready and no wave is open; held: ${held.map((entry) =>
      `${entry.id} (${entry.reasons.map((r) => r.detail).join('; ')})`).join('; ')}`;
    return recordMisfit(controller, row, record, { wave, reason });
  }
  const misfit = waveMisfit(proposal.declaration, record, wave);
  if (misfit) return recordMisfit(controller, row, record, { wave, reason: misfit, proposal });
  // The same gate as cli.mjs start: a new campaign targets only a registered project with known roles.
  try { assertRegisteredTarget(proposal.declaration, controller.governanceRoot); }
  catch (error) { return recordMisfit(controller, row, record, { wave, reason: error.message, proposal }); }
  const { declaration, digest } = proposal;
  const now = controller.now();
  try {
    store.db.exec(WAVES_DDL);
    store.tx(() => {
      store.insert('program_waves', { program_id: record.programId, wave, campaign_id: declaration.campaignId, record_version: record.authorization.version,
        record_digest: row.digest, declaration_digest: digest, plan_revision: fetched.sha, registered_at: now });
      campaignStart(store, declaration, now);
      // Crash rehearsal (AIWORKS_FAULT): the transaction is not committed, so the wave row and the campaign are undone too.
      controller.injectFault('program-after-register');
      store.journal(declaration.campaignId, 'program-registered', { programId: record.programId, wave, recordVersion: record.authorization.version,
        recordDigest: row.digest, declarationDigest: digest, planRevision: fetched.sha, tasks: declaration.tasks.map((task) => task.id) }, now);
      store.run("UPDATE blockers SET status = 'resolved', resolution = ?, resolved_at = ?, updated_at = ? WHERE fingerprint = ? AND status != 'resolved'",
        { registered: declaration.campaignId }, now, now, misfitFingerprint(record));
    });
  } catch (error) {
    if (error instanceof CampaignError) return recordMisfit(controller, row, record, { wave, reason: `${error.code}: ${error.message}`, proposal });
    throw error;
  }
  controller.log(`program ${record.programId}: registered wave ${wave} as ${declaration.campaignId} (${declaration.tasks.map((task) => task.id).join(', ')})`);
  return { programId: record.programId, wave, registered: true, campaignId: declaration.campaignId, declarationDigest: digest };
}

/**
 * The registration pass, one call per controller pass (docs/PROJECT_WORKSPACE_PLAN.md section 6.8d). It does nothing
 * unless config.json says `"program": { "enabled": true }`, PROGRAM-STOP is absent and readable, and this code is merged
 * (AW-005). Then each approved, unrevoked program is checked at most once an hour: while a wave of it has unfinished
 * tasks nothing happens; otherwise the plan is read from the fetched base branch, the ready slices become one declaration
 * (program-plan.mjs), and the wave is registered through campaignStart only if it fits the record exactly and its target
 * is a registered project. A wave that does not fit registers nothing and becomes one Needs you item. Returns one entry
 * per program checked (empty when off).
 */
export function programPass(controller) {
  if (!programEnabled(controller.config)) return [];
  const { store } = controller;
  if (!hasPrograms(store)) return [];
  if (programStopped(controller.dataDir) !== false) return [];
  if (controller.unmergedRevision()) return [];
  const now = controller.now();
  controller.programCheckedAt ??= new Map();
  const results = [];
  for (const row of store.all('SELECT * FROM programs WHERE revoked_at IS NULL ORDER BY program_id')) {
    if ((controller.programCheckedAt.get(row.program_id) ?? -Infinity) + PROGRAM_PASS_MS > now) continue;
    controller.programCheckedAt.set(row.program_id, now);
    try {
      const result = programWave(controller, row);
      if (result) results.push(result);
      if (result?.waiting) controller.log(`program ${row.program_id}: no wave registered: ${result.waiting}`);
    } catch (error) {
      controller.log(`program ${row.program_id} pass failed: ${error.code ?? error.name}: ${redact(error.message, 300)}`);
      results.push({ programId: row.program_id, error: error.code ?? error.name });
    }
  }
  return results;
}
