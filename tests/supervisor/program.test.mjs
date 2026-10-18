// The owner's program record (docs/PROJECT_WORKSPACE_PLAN.md section 6.8d, slice PROG1; netbka/aiworks#153). Every record
// here is synthetic and lives in a disposable directory; the runtime is a disposable checkout whose origin/main is a local
// ref. No model, network or GitHub call. Nothing in this slice registers a wave or a campaign.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GOVERNANCE, runCli, runtimeCheckout, skipWithoutSqlite, SQLITE } from './helpers.mjs';
// Loaded leniently so that, on a revision without slice PROG1, each test fails on its own assertion.
const program = await import('../../src/supervisor/program.mjs').catch(() => ({}));
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
// A host whose temporary directory lies inside a Git work tree (a home directory under Git) must not decide these tests:
// Git looks for a work tree no higher than the temporary directory, as approved-declarations.test.mjs does.
process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());

const text = (value) => `${JSON.stringify(value, null, 2)}\n`;
/** A synthetic program record for a fictional repository. */
const record = ({ version = 1, ...extra } = {}) => ({
  schema: 'aiworks-program/1', programId: 'sample-program', repository: 'example-org/sampleapp', baseBranch: 'main',
  plan: 'docs/PLAN.md', allow: ['LANE', 'OTHER2'], exclude: ['LANE7'],
  executor: { kind: 'cli-chain', providers: [{ kind: 'codex-cli' }, { kind: 'claude-cli', model: 'opus', permissionMode: 'auto' }], implementerTimeoutMinutes: 60, verifierTimeoutMinutes: 30 },
  constraints: ['Synthetic program constraint: PRIVATE-CONSTRAINT-TEXT.'],
  authorization: { version, grantedBy: 'owner', grantedAt: '2026-10-17', reference: 'https://github.com/example-org/sampleapp/issues/9', text: 'PRIVATE-OWNER-WORDS: just do it.' },
  ...extra,
});
const without = (value, key) => { const copy = structuredClone(value); delete copy[key]; return copy; };
const codeOf = (out) => /^([A-Z_]+):/m.exec(out.stderr)?.[1] ?? null;
const PRIVATE = ['PRIVATE-CONSTRAINT-TEXT', 'PRIVATE-OWNER-WORDS', 'PRIVATE-FIELD', 'privateNote', 'example-org/sampleapp'];
const echoes = (message) => PRIVATE.some((marker) => message.includes(marker));

/** A disposable store outside every Git work tree. */
function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-program-'));
  const store = new Store(join(dir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  return { dir, store };
}
/** Everything a program approval could change: the schema, the journal and every campaign. */
const snapshot = (store) => ({
  tables: store.all("SELECT name, sql FROM sqlite_master ORDER BY name"),
  journal: store.all('SELECT campaign_id, kind, detail FROM journal ORDER BY rowid'),
  campaigns: store.all('SELECT * FROM campaigns'),
  tasks: store.all('SELECT * FROM tasks'),
});

test('a program record has one shape; an unknown or missing field is refused without echoing the file', () => {
  assert.equal(program.validateProgram(record()).programId, 'sample-program');
  assert.equal(program.validateProgram(record({ executor: { kind: 'codex-cli', implementerTimeoutMinutes: 5, verifierTimeoutMinutes: 5 } })).schema, 'aiworks-program/1');
  assert.equal(program.validateProgram(record({ revoked: true })).revoked, true);
  for (const [label, value] of [
    ['an unknown top-level field', { ...record(), privateNote: 'PRIVATE-FIELD' }],
    ['an unknown authorization field', record({ authorization: { ...record().authorization, privateNote: 'PRIVATE-FIELD' } })],
    ['an unknown executor field', record({ executor: { ...record().executor, privateNote: 'PRIVATE-FIELD' } })],
    ...['schema', 'programId', 'repository', 'baseBranch', 'plan', 'allow', 'exclude', 'executor', 'constraints', 'authorization']
      .map((key) => [`no ${key}`, without(record(), key)]),
    ['no authorization text', record({ authorization: without(record().authorization, 'text') })],
    ['no authorization version', record({ authorization: without(record().authorization, 'version') })],
    ['another schema', record({ schema: 'aiworks-program/2' })],
    ['an impossible date', record({ authorization: { ...record().authorization, grantedAt: '2026-13-45' } })],
    ['a plan path that leaves the repository', record({ plan: '../PRIVATE-FIELD.md' })],
    ['a lower-case slice', record({ allow: ['lane1'] })],
    ['no allowed slice', record({ allow: [] })],
    ['a claude-cli provider without a permission mode', record({ executor: { kind: 'claude-cli', model: 'opus', implementerTimeoutMinutes: 5, verifierTimeoutMinutes: 5 } })],
    ['bypassPermissions', record({ executor: { kind: 'claude-cli', model: 'opus', permissionMode: 'bypassPermissions', implementerTimeoutMinutes: 5, verifierTimeoutMinutes: 5 } })],
    ['a duplicate provider (declaration rule)', record({ executor: { ...record().executor, providers: [{ kind: 'codex-cli' }, { kind: 'codex-cli' }] } })],
    ['only the web worker (declaration rule)', record({ executor: { kind: 'agy-cli', model: 'gemini', implementerTimeoutMinutes: 5, verifierTimeoutMinutes: 5 } })],
    ['too many constraints', record({ constraints: Array.from({ length: 13 }, (_, i) => `constraint ${i}`) })],
    ['a blank constraint', record({ constraints: ['   '] })],
    ['not an object', ['PRIVATE-FIELD']],
  ]) {
    assert.throws(() => program.validateProgram(structuredClone(value)),
      (error) => error.code === 'PROGRAM_INVALID' && !echoes(error.message), label);
  }
});

test('programs are off by default: only "program": { "enabled": true } switches them on', () => {
  assert.equal(program.programEnabled(undefined), false);
  assert.equal(program.programEnabled({}), false, 'no program block');
  for (const value of [null, true, 'yes', { enabled: 'true' }, { enabled: 1 }, { enabled: false }, []]) {
    assert.equal(program.programEnabled({ program: value }), false, JSON.stringify(value));
  }
  assert.equal(program.programEnabled({ program: { enabled: true } }), true);
});

test('the digest is canonical: key order and whitespace never change it, one changed value does', () => {
  const reordered = Object.fromEntries(Object.entries(record()).reverse());
  assert.match(program.programDigest(record()), /^[0-9a-f]{64}$/);
  assert.equal(program.programDigest(reordered), program.programDigest(record()));
  assert.equal(program.programDigest(JSON.parse(text(record()).replaceAll('\n', '\r\n'))), program.programDigest(record()));
  assert.notEqual(program.programDigest(record({ exclude: ['LANE8'] })), program.programDigest(record()));
});

test('PROGRAM-STOP is read without the database and stops everything; an unreadable stop counts as unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-program-stop-'));
  try {
    assert.equal(program.programStopped(dir), false);
    assert.equal(existsSync(join(dir, 'supervisor.db')), false);
    const file = program.stopPrograms(dir, { reason: 'owner pause', now: Date.parse('2026-10-17T10:00:00Z') });
    assert.equal(file, join(dir, program.PROGRAM_STOP));
    assert.equal(readFileSync(file, 'utf8'), '2026-10-17T10:00:00.000Z owner pause\n');
    assert.equal(program.programStopped(dir), true);
    assert.equal(existsSync(join(dir, 'supervisor.db')), false, 'no store was opened or created');
    assert.equal(program.programStopped(dir, { exists: () => { throw new Error('unreadable'); } }), null);
    assert.equal(program.programStopped(''), null);
    // Status reads the stop with no store at all.
    assert.deepEqual((({ enabled, stop, programs }) => ({ enabled, stop, programs }))(program.programStatus({ dataDir: dir, config: {} })),
      { enabled: false, stop: true, programs: [] });
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('with no program block and no record the store is unchanged until program-approve runs', { skip: skipWithoutSqlite }, (t) => {
  const { dir, store } = tempStore(t);
  const before = snapshot(store);
  assert.deepEqual(program.approvedPrograms(store), []);
  assert.deepEqual(program.programStatus({ store, dataDir: dir, config: {} }).programs, []);
  assert.equal(program.programStatus({ store, dataDir: dir, config: {} }).enabled, false);
  assert.throws(() => program.approveProgram(store, { ...record(), privateNote: 'PRIVATE-FIELD' }), (error) => error.code === 'PROGRAM_INVALID');
  assert.deepEqual(snapshot(store), before, 'reads and a refused record change nothing');
  assert.equal(store.get("SELECT 1 AS present FROM sqlite_master WHERE name = 'programs'"), null);
  program.approveProgram(store, record(), { now: 1000 });
  assert.ok(store.get("SELECT 1 AS present FROM sqlite_master WHERE name = 'programs'"), 'the table appears with the first approval');
});

test('a newer version replaces the old one; a lower or equal version is refused; nothing is registered', { skip: skipWithoutSqlite }, (t) => {
  const { store } = tempStore(t);
  const first = program.approveProgram(store, record({ version: 2 }), { now: 1000 });
  assert.deepEqual({ ...first, approvedAt: undefined }, { programId: 'sample-program', version: 2, digest: program.programDigest(record({ version: 2 })),
    grantedBy: 'owner', grantedAt: '2026-10-17', approvedAt: undefined, revoked: false, revokedAt: null, replaced: null });
  for (const version of [1, 2]) {
    assert.throws(() => program.approveProgram(store, record({ version, exclude: [] }), { now: 2000 }),
      (error) => error.code === 'PROGRAM_VERSION_NOT_NEWER' && !echoes(error.message), `version ${version}`);
  }
  assert.equal(program.approvedPrograms(store)[0].digest, first.digest, 'a refused record changes nothing');
  const newer = record({ version: 3, allow: ['LANE'] });
  const replaced = program.approveProgram(store, newer, { now: 3000 });
  assert.equal(replaced.replaced, 2);
  assert.deepEqual(program.approvedPrograms(store).map((row) => [row.programId, row.version, row.digest]),
    [['sample-program', 3, program.programDigest(newer)]], 'one row per program, the newer one');
  assert.equal(store.get('SELECT record_text FROM programs').record_text, JSON.stringify(JSON.parse(store.get('SELECT record_text FROM programs').record_text)),
    'the record is kept canonically');
  assert.equal(program.programDigest(JSON.parse(store.get('SELECT record_text FROM programs').record_text)), program.programDigest(newer));
  assert.deepEqual(store.all('SELECT campaign_id, kind FROM journal ORDER BY rowid').map((row) => [row.campaign_id, row.kind]),
    [[null, 'program-approved'], [null, 'program-approved']]);
  assert.deepEqual(store.all('SELECT * FROM campaigns'), [], 'nothing is registered');
  assert.deepEqual(store.all('SELECT * FROM tasks'), []);
  // Status lists the programs without their contents.
  assert.equal(echoes(JSON.stringify(program.programStatus({ store, dataDir: '', config: {} }))), false);
});

test('a record is never kept in a store that source Git would track', { skip: skipWithoutSqlite }, (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'aiworks-program-repo-'));
  const store = new Store(join(repo, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const before = snapshot(store);
  assert.throws(() => program.approveProgram(store, record()), (error) => error.code === 'PRIVATE_STORE_NOT_IGNORED');
  assert.deepEqual(snapshot(store), before, 'nothing was written');
});

test('a revoked record stays revoked: no later version revives it', { skip: skipWithoutSqlite }, (t) => {
  const { store } = tempStore(t);
  program.approveProgram(store, record({ version: 1 }), { now: 1000 });
  const revoked = program.approveProgram(store, record({ version: 2, revoked: true }), { now: 2000 });
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.revokedAt, new Date(2000).toISOString());
  for (const version of [3, 100]) {
    assert.throws(() => program.approveProgram(store, record({ version }), { now: 3000 }), (error) => error.code === 'PROGRAM_REVOKED', `version ${version}`);
  }
  assert.throws(() => program.approveProgram(store, record({ version: 4, revoked: false }), { now: 3000 }), (error) => error.code === 'PROGRAM_REVOKED');
  assert.deepEqual(program.approvedPrograms(store).map((row) => [row.version, row.revoked]), [[2, true]]);
  // A record that arrives revoked is stored revoked; another program is unaffected.
  program.approveProgram(store, record({ programId: 'other-program', revoked: true }), { now: 4000 });
  program.approveProgram(store, record({ programId: 'third-program' }), { now: 4000 });
  assert.deepEqual(program.approvedPrograms(store).map((row) => [row.programId, row.revoked]),
    [['other-program', true], ['sample-program', true], ['third-program', false]]);
  assert.deepEqual(store.all('SELECT kind FROM journal ORDER BY rowid').map((row) => row.kind),
    ['program-approved', 'program-revoked', 'program-revoked', 'program-approved']);
  assert.deepEqual(store.all('SELECT * FROM campaigns'), [], 'nothing is registered');
});

test('the CLI: program-status and program-stop leave the store alone; program-approve keeps the record and registers nothing', { skip: skipWithoutSqlite }, (t) => {
  const runtime = runtimeCheckout();
  const privateDir = mkdtempSync(join(tmpdir(), 'aiworks-program-private-'));
  const data = mkdtempSync(join(tmpdir(), 'aiworks-program-data-'));
  t.after(() => { runtime.cleanup(); for (const dir of [privateDir, data]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const file = (name, value) => { const path = join(privateDir, name); writeFileSync(path, typeof value === 'string' ? value : text(value)); return path; };
  const cli = (...args) => runCli(runtime.cli, [...args, '--data', data, '--governance', GOVERNANCE]);
  const refs = runtime.refs();

  // No store and no config: status creates nothing and reports programs off.
  const empty = cli('program-status');
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual((({ enabled, stop, programs }) => ({ enabled, stop, programs }))(JSON.parse(empty.stdout)), { enabled: false, stop: false, programs: [] });
  assert.equal(existsSync(join(data, 'supervisor.db')), false, 'program-status never creates a store');

  // An existing store with no program block in config.json is unchanged by status and by a refused record.
  new Store(join(data, 'supervisor.db')).close();
  writeFileSync(join(data, 'config.json'), text({ tickMs: 100 }));
  const inspect = (fn) => { const store = new Store(join(data, 'supervisor.db')); try { return fn(store); } finally { store.close(); } };
  const before = inspect(snapshot);
  assert.equal(cli('program-status').status, 0);
  const unknown = cli('program-approve', file('unknown.json', { ...record(), privateNote: 'PRIVATE-FIELD' }));
  assert.equal(codeOf(unknown), 'PROGRAM_INVALID');
  assert.equal(echoes(unknown.stderr + unknown.stdout), false, 'the refusal does not echo the file');
  const broken = cli('program-approve', file('broken.json', '{ "schema": "PRIVATE-FIELD", '));
  assert.equal(codeOf(broken), 'PROGRAM_INVALID');
  assert.equal(echoes(broken.stderr + broken.stdout), false, 'a parse error does not echo the file');
  assert.deepEqual(inspect(snapshot), before, 'the store is unchanged until program-approve succeeds');

  const approved = cli('program-approve', file('program.json', record({ version: 2 })));
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(JSON.parse(approved.stdout).digest, program.programDigest(record({ version: 2 })));
  assert.equal(echoes(approved.stdout), false, 'approval output names the program, not its contents');
  const lower = cli('program-approve', file('lower.json', record({ version: 1 })));
  assert.equal(codeOf(lower), 'PROGRAM_VERSION_NOT_NEWER');
  assert.equal(echoes(lower.stderr), false);

  // A malformed config.json keeps programs off.
  writeFileSync(join(data, 'config.json'), '{ "program": { "enabled": true ');
  const status = JSON.parse(cli('program-status').stdout);
  assert.equal(status.enabled, false);
  assert.deepEqual(status.programs.map((row) => [row.programId, row.version, row.revoked]), [['sample-program', 2, false]]);

  // program-stop writes the file only: it opens no store.
  const stopped = cli('program-stop', 'owner', 'pause');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(readFileSync(join(data, 'PROGRAM-STOP'), 'utf8'), / owner pause\n$/);
  assert.equal(JSON.parse(cli('program-status').stdout).stop, true);
  inspect((store) => {
    assert.deepEqual(store.all('SELECT * FROM campaigns'), [], 'nothing is registered');
    assert.deepEqual(store.all('SELECT kind FROM journal ORDER BY rowid').map((row) => row.kind), ['program-approved']);
  });
  assert.equal(runtime.refs(), refs, 'no branch or commit was made');
});
