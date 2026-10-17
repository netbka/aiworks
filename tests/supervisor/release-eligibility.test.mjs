// Slice R2 of docs/design/AUTO_RELEASE.md (build slice REL2): the eligibility evaluator, report only. Every E-check
// fails on missing, unreadable and unknown evidence, not only on a negative value; an unmatched path is unclassified
// and blocks; the stricter class wins; one session implementing and verifying is not eligible; a moved base is not
// eligible. Readers are injected; the only other inputs are a disposable store and a disposable git repository. No
// model, network or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECK_IDS, eligibilitySummary, evaluateEligibility } from '../../src/supervisor/release/eligibility.mjs';
import { changedPaths, classOf, classify, globRegExp, UNCLASSIFIED } from '../../src/supervisor/release/classify.mjs';
import { recordDigest } from '../../src/supervisor/release/authorization.mjs';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const SHA = 'c'.repeat(40);
const BASE = 'b'.repeat(40);
const candidate = { project: 'sampleapp', destinationId: 'main-merge', taskId: 'T1', verifiedSha: SHA };
const record = (change = (value) => value) => change({
  schema: 'aiworks-release-authorization/1',
  project: 'sampleapp', version: 3, approval: 'https://github.com/example-org/sampleapp/issues/120',
  grantedAt: '2026-11-01', expiresAt: '2027-01-30', revoked: false,
  destinations: [
    {
      id: 'main-merge', environment: 'production', kind: 'merge', baseBranch: 'main', mergeMethod: 'squash',
      changeClasses: ['docs', 'tests', 'app-code'], credential: { ref: 'aiworks-release/sampleapp', owner: 'example-org' }, rollback: 'automatic', checkWindowMinutes: 5,
    },
    {
      id: 'production', environment: 'production', kind: 'merge-then-deploy', baseBranch: 'main', mergeMethod: 'squash',
      changeClasses: ['docs', 'tests', 'app-code'],
      commands: { deploy: 'deploy/release.ps1', observe: 'deploy/observe.ps1', check: 'deploy/check.ps1', rollback: 'deploy/rollback.ps1' },
      credential: { ref: 'aiworks-release/sampleapp', owner: 'example-org' }, rollback: 'automatic', checkWindowMinutes: 10,
    },
    {
      id: 'folder', environment: 'local', kind: 'local-folder-apply', changeClasses: ['docs', 'tests', 'app-code'],
      commands: { check: 'scripts/check.ps1' }, credential: { ref: 'aiworks-release/sampleapp', owner: 'example-org' }, rollback: 'report-only', checkWindowMinutes: 5,
    },
  ],
  classes: { docs: ['docs/**', '*.md'], tests: ['tests/**'], 'app-code': ['src/**'], migration: ['db/migrations/**'] },
  ownerConfirm: ['dependency-update'],
});
const bytesOf = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const local = (id) => id === 'folder';

/** Readers that make every check pass for `destinationId`; a test overrides one at a time. */
const passing = (destinationId = 'main-merge') => ({
  switches: () => ({ enabled: true, stop: false, mode: 'auto-release' }),
  grant: () => ({ bytes: bytesOf(record()), commit: BASE }),
  authority: () => ({ decisionAccepted: true, registryPointsHere: true }),
  verification: () => ({ taskState: 'done', verdict: 'accepted', targetSha: SHA, verifySession: 'verify-1', implementSessions: ['impl-1', 'impl-2'] }),
  published: () => (local(destinationId) ? { stagedRevision: SHA } : { state: 'OPEN', isDraft: false, headSha: SHA, baseBranch: 'main' }),
  current: () => (local(destinationId) ? { manifestMatches: true } : { baseHead: BASE, baseIsAncestor: true }),
  diff: () => 'M\tdocs/guide.md\nA\ttests/x.test.mjs\nM\tsrc/a.mjs\n',
  checks: () => ({ sha: SHA, required: [{ name: 'check', conclusion: 'success' }], preflight: true }),
  wayBack: () => ({ rollback: true, knownGood: true, backupSpace: true, readable: true }),
  dependencies: () => ({ independent: true }),
  destinationState: () => ({ lockHeld: false, unknownRelease: false }),
  role: () => ({ installed: true, credentialResolves: true }),
  ownerReserved: () => ({ reported: false }),
});
const evaluate = (read, destinationId = 'main-merge') => evaluateEligibility({ ...candidate, destinationId }, read, { now: NOW });
const reasonOf = (result, check) => result.failed.find((item) => item.check === check)?.reason;

test('a candidate with positive evidence for every check would be eligible, and the inputs are recorded', () => {
  assert.deepEqual(CHECK_IDS, ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11', 'E12', 'E13']);
  for (const destinationId of ['main-merge', 'production', 'folder']) {
    const result = evaluate(passing(destinationId), destinationId);
    assert.deepEqual(result.failed, [], destinationId);
    assert.equal(result.eligible, true);
  }
  const result = evaluate(passing());
  assert.equal(result.inputs.grantDigest, recordDigest(bytesOf(record())));
  assert.equal(result.inputs.grantCommit, BASE);
  assert.deepEqual(result.inputs.classification.classes, ['app-code', 'tests', 'docs']);
  assert.equal(result.inputs.evidence.published.headSha, SHA);
  assert.equal(result.inputs.evaluatedAt, '2026-11-15T12:00:00.000Z');
  assert.match(eligibilitySummary(result), /^Would be eligible for Auto Release \(report only/);
});

// The reader each check depends on. E9 is read only for destinations that are not plain merges (a merge is always
// undone by a revert), so its row runs against the deploy destination.
const READER = { E1: 'switches', E2: 'grant', E3: 'authority', E4: 'verification', E5: 'published', E6: 'current', E7: 'diff',
  E8: 'checks', E9: 'wayBack', E10: 'dependencies', E11: 'destinationState', E12: 'role', E13: 'ownerReserved' };
const BROKEN = [
  ['no reader', undefined, /no reader/],
  ['missing', () => undefined, /missing/],
  ['unreadable', () => { throw new Error('read failed'); }, /unreadable \(read failed\)/],
  ['unknown', () => null, /unknown/],
  ['unanswered (a promise)', () => Promise.resolve({}), /did not answer synchronously/],
  ['of the wrong shape', () => ({}), /./],
];

for (const [check, reader] of Object.entries(READER)) {
  test(`${check} fails on missing, unreadable and unknown evidence (${reader})`, () => {
    const destinationId = check === 'E9' ? 'production' : 'main-merge';
    for (const [label, broken, pattern] of BROKEN) {
      const read = { ...passing(destinationId), [reader]: broken };
      if (broken === undefined) delete read[reader];
      const result = evaluate(read, destinationId);
      assert.equal(result.eligible, false, `${label} ${reader} must not be eligible`);
      const reason = reasonOf(result, check);
      assert.ok(reason, `${check} must fail on ${label} ${reader}; failed: ${result.failed.map((f) => f.check).join(', ')}`);
      // The failure is this check's own, not a side effect of another check: only E2's grant feeds E5-E7, E9 and E13.
      if (check !== 'E2') assert.deepEqual(result.failed.map((f) => f.check), check === 'E7' ? ['E7', 'E13'] : [check], label);
      assert.match(reason, pattern, `${check} ${label}: ${reason}`);
    }
  });
}

test('negative values fail too, each with a plain reason', () => {
  const cases = [
    ['E1', { switches: () => ({ enabled: false, stop: false, mode: 'auto-release' }) }, /switched off/],
    ['E1', { switches: () => ({ enabled: true, stop: true, mode: 'auto-release' }) }, /RELEASE-STOP is set/],
    ['E1', { switches: () => ({ enabled: true, stop: false, mode: 'review-only' }) }, /review-only mode/],
    ['E2', { grant: () => ({ bytes: bytesOf(record((r) => ({ ...r, revoked: true }))), commit: BASE }) }, /revoked/],
    ['E2', { grant: () => ({ bytes: bytesOf(record((r) => ({ ...r, expiresAt: '2026-11-10' }))), commit: BASE }) }, /expired/],
    ['E2', { grant: () => ({ bytes: bytesOf(record((r) => ({ ...r, project: 'other' }))), commit: BASE }) }, /for project other, not sampleapp/],
    ['E2', { grant: () => ({ bytes: '{ not json', commit: BASE }) }, /not valid JSON/],
    ['E2', { grant: () => ({ bytes: bytesOf(record()), commit: 'main' }) }, /commit the grant was read from is unknown/],
    ['E3', { authority: () => ({ decisionAccepted: false, registryPointsHere: true }) }, /not accepted/],
    ['E4', { verification: () => ({ ...passing().verification(), taskState: 'published' }) }, /T1 is published, not done/],
    ['E4', { verification: () => ({ ...passing().verification(), verdict: 'rejected' }) }, /verdict rejected/],
    ['E5', { published: () => ({ state: 'OPEN', isDraft: false, headSha: 'f'.repeat(40), baseBranch: 'main' }) }, /head is f{40}/],
    ['E5', { published: () => ({ state: 'CLOSED', isDraft: false, headSha: SHA, baseBranch: 'main' }) }, /is closed/],
    ['E5', { published: () => ({ state: 'OPEN', isDraft: true, headSha: SHA, baseBranch: 'main' }) }, /draft/],
    ['E5', { published: () => ({ state: 'OPEN', isDraft: false, headSha: SHA, baseBranch: 'release' }) }, /targets release, not main/],
    ['E8', { checks: () => ({ sha: SHA, required: [{ name: 'check', conclusion: 'failure' }], preflight: true }) }, /check \(failure\)/],
    ['E8', { checks: () => ({ sha: SHA, required: [{ name: 'check', conclusion: 'pending' }], preflight: true }) }, /check \(pending\)/],
    ['E8', { checks: () => ({ sha: SHA, required: [], preflight: true }) }, /no required check/],
    ['E8', { checks: () => ({ sha: 'f'.repeat(40), required: [{ name: 'check', conclusion: 'success' }], preflight: true }) }, /not c{40}/],
    ['E8', { checks: () => ({ sha: SHA, required: [{ name: 'check', conclusion: 'success' }], preflight: false }) }, /preflight/],
    ['E10', { dependencies: () => ({ tasks: [{ taskId: 'T0', released: false }] }) }, /not released yet: T0/],
    ['E11', { destinationState: () => ({ lockHeld: true, unknownRelease: false }) }, /holds the destination lock/],
    ['E11', { destinationState: () => ({ lockHeld: false, unknownRelease: true }) }, /unresolved/],
    ['E12', { role: () => ({ installed: true, credentialResolves: false }) }, /credential reference does not resolve/],
    ['E13', { ownerReserved: () => ({ reported: true }) }, /owner-reserved trigger/],
  ];
  for (const [check, override, pattern] of cases) {
    const result = evaluate({ ...passing(), ...override });
    assert.equal(result.eligible, false);
    assert.match(reasonOf(result, check) ?? `${check} did not fail`, pattern);
  }
  const deploy = evaluate({ ...passing('production'), wayBack: () => ({ rollback: true, knownGood: false }) }, 'production');
  assert.match(reasonOf(deploy, 'E9'), /known-good/);
  const folder = evaluate({ ...passing('folder'), wayBack: () => ({ backupSpace: false, readable: true }) }, 'folder');
  assert.match(reasonOf(folder, 'E9'), /free space/);
});

test('the grant is validated by the evaluator, never taken from the reader', () => {
  // A reader that only claims validity, as a loader summary would, is not a record: E2 fails.
  const claim = evaluate({ ...passing(), grant: () => ({ valid: true, record: record(), digest: 'd'.repeat(64), commit: BASE }) });
  assert.match(reasonOf(claim, 'E2'), /record bytes are missing/);
  // A destination the grant does not name is not eligible.
  assert.match(reasonOf(evaluate(passing(), 'staging'), 'E2'), /names no destination staging/);
});

test('an unmatched path is unclassified and blocks', () => {
  const result = evaluate({ ...passing(), diff: () => 'M\tsrc/a.mjs\nA\tscripts/deploy.sh\n' });
  assert.deepEqual(result.failed.map((f) => f.check), ['E7']);
  assert.match(reasonOf(result, 'E7'), /unclassified: scripts\/deploy\.sh/);
  assert.equal(classOf('scripts/deploy.sh', record().classes), UNCLASSIFIED);
  // A candidate that changes nothing has nothing a grant could accept.
  assert.match(reasonOf(evaluate({ ...passing(), diff: () => '' }), 'E7'), /changes no file/);
  // Two project-named classes, or one with a design class, have no order: the file is unclassified, never guessed.
  assert.equal(classOf('src/web/a.js', { frontend: ['src/web/**'], 'app-code': ['src/**'] }), UNCLASSIFIED);
  assert.equal(classOf('src/web/a.js', { frontend: ['src/web/**'] }), 'frontend');
});

test('the stricter class wins, and a never-grantable or owner-confirm class blocks', () => {
  const classes = { docs: ['**/*.sql', 'docs/**'], 'app-code': ['src/**'], 'dependency-update': ['package*.json'], migration: ['db/migrations/**'] };
  assert.equal(classOf('db/migrations/0042.sql', classes), 'migration', 'migration is stricter than docs');
  assert.equal(classOf('docs/schema.sql', classes), 'docs');
  const migration = evaluate({ ...passing(), diff: () => 'A\tdb/migrations/0042.sql\n' });
  assert.match(reasonOf(migration, 'E7'), /not granted for this destination: migration/);
  assert.match(reasonOf(migration, 'E13'), /owner-reserved classes: migration/);
  // ownerConfirm classes always wait for the owner, even when a destination accepts them.
  const confirm = record((r) => ({ ...r, classes: { ...r.classes, 'dependency-update': ['package.json'] },
    destinations: r.destinations.map((d) => ({ ...d, changeClasses: [...d.changeClasses, 'dependency-update'] })) }));
  const dependency = evaluate({ ...passing(), grant: () => ({ bytes: bytesOf(confirm), commit: BASE }), diff: () => 'M\tpackage.json\n' });
  assert.match(reasonOf(dependency, 'E7'), /dependency-update/);
  assert.match(reasonOf(dependency, 'E13'), /owner-reserved classes: dependency-update/);
});

test('the same session implementing and verifying is not eligible', () => {
  const same = evaluate({ ...passing(), verification: () => ({ ...passing().verification(), verifySession: 'impl-2' }) });
  assert.deepEqual(same.failed.map((f) => f.check), ['E4']);
  assert.match(reasonOf(same, 'E4'), /same session implemented and verified/);
  const other = evaluate({ ...passing(), verification: () => ({ ...passing().verification(), targetSha: 'e'.repeat(40) }) });
  assert.match(reasonOf(other, 'E4'), /checked e{40}, not c{40}/);
  const unknown = evaluate({ ...passing(), verification: () => ({ ...passing().verification(), implementSessions: [] }) });
  assert.match(reasonOf(unknown, 'E4'), /sessions are unknown/);
});

test('base moved since verification is not eligible', () => {
  const moved = evaluate({ ...passing(), current: () => ({ baseHead: 'a'.repeat(40), baseIsAncestor: false }) });
  assert.deepEqual(moved.failed.map((f) => f.check), ['E6']);
  assert.match(reasonOf(moved, 'E6'), /base moved since verification \(now a{40}\)/);
  assert.equal(eligibilitySummary(moved), `Not eligible, because the base moved since verification (now ${'a'.repeat(40)})`);
  // A local destination compares the target's manifest instead.
  const folder = evaluate({ ...passing('folder'), current: () => ({ manifestMatches: false }) }, 'folder');
  assert.deepEqual(folder.failed.map((f) => f.check), ['E6']);
  assert.match(reasonOf(folder, 'E6'), /changed at the destination/);
});

test('globs: ** spans segments, * stays in one, a slashless pattern matches at any depth', () => {
  assert.ok(globRegExp('docs/**').test('docs/a/b.md'));
  assert.ok(globRegExp('src/**/x.mjs').test('src/x.mjs'));
  assert.ok(globRegExp('src/**/x.mjs').test('src/a/b/x.mjs'));
  assert.ok(!globRegExp('src/*.mjs').test('src/a/b.mjs'));
  assert.ok(globRegExp('*.md').test('deep/down/README.md'));
  assert.ok(!globRegExp('*.md').test('README.mdx'));
  assert.ok(!globRegExp('docs/**').test('notdocs/a.md'));
  assert.ok(!globRegExp('a.b').test('axb'), 'a dot is literal');
});

test('name-status parsing: renames count both paths, CRLF is tolerated and unreadable lines throw', () => {
  assert.deepEqual(changedPaths('R100\tdocs/old.md\tsrc/new.mjs\r\nD\tdocs/gone.md\r\n'), ['docs/old.md', 'src/new.mjs', 'docs/gone.md']);
  assert.throws(() => changedPaths('garbage line\n'), /unreadable name-status/);
  assert.throws(() => changedPaths('R100\tonly-one-path\n'), /unreadable name-status/);
  assert.throws(() => changedPaths(undefined), /not name-status text/);
  const result = evaluate({ ...passing(), diff: () => 'garbage line\n' });
  assert.match(reasonOf(result, 'E7'), /diff: unreadable/);
});

test('classification reads real git diff --name-status output of a disposable repository', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-release-classify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
      { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout;
  };
  git('init', '-q');
  const write = (path, text) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
  write('docs/old.md', 'a long enough body so that rename detection is certain\n'.repeat(4));
  write('src/a.mjs', 'export const a = 1;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  git('mv', 'docs/old.md', 'docs/new.md');
  write('src/a.mjs', 'export const a = 2;\n');
  write('db/migrations/0001.sql', 'create table t (id int);\n');
  git('add', '-A'); git('commit', '-q', '-m', 'candidate');
  const nameStatus = git('diff', '--name-status', '-M', `${base}..HEAD`);
  const result = classify(nameStatus, record().classes);
  assert.deepEqual(result.files.map((f) => `${f.path}=${f.class}`).sort(),
    ['db/migrations/0001.sql=migration', 'docs/new.md=docs', 'docs/old.md=docs', 'src/a.mjs=app-code']);
  assert.deepEqual(result.classes, ['migration', 'app-code', 'docs']);
});
