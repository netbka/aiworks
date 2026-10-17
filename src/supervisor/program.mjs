// The owner's program record (docs/PROJECT_WORKSPACE_PLAN.md section 6.8d, slice PROG1; netbka/aiworks#153 option B).
// One private aiworks-program/1 file names a repository, a plan and the slices whose waves may later start by themselves.
// This slice validates the record, keeps it by its canonical digest and reads the stop switches. It is built switched
// off: nothing here proposes or registers a wave or a campaign (PROG3 does, still off; PROG5 switches it on).
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { SECRET_LIKE_PATH_PATTERN } from '../../scripts/lib/worker-context.mjs';
import { CampaignError } from './api.mjs';
import { assertPrivateStore } from './approved-declarations.mjs';
import { canonicalJson, validateDeclaration } from './campaign.mjs';
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
    registers: 'nothing: no wave is proposed or registered until PROG3 is built and PROG5 switches program.enabled on' };
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
