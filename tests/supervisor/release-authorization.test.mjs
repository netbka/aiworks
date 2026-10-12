// Slice R1 of docs/design/AUTO_RELEASE.md (build slice REL1): the standing release record and its validator.
// Pure functions plus one read of a disposable git repository; no network, model or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FORBIDDEN_CLASSES, loadAuthorization, parseAuthorization, recordDigest, validateAuthorization,
} from '../../src/supervisor/release/authorization.mjs';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const options = { project: 'dyk', now: NOW };
const record = (change = (value) => value) => change({
  schema: 'aiworks-release-authorization/1',
  project: 'dyk',
  version: 3,
  approval: 'https://github.com/netbka/Dyk/issues/120',
  grantedAt: '2026-11-01',
  expiresAt: '2027-01-30',
  revoked: false,
  destinations: [
    {
      id: 'production', environment: 'production', kind: 'merge-then-deploy', baseBranch: 'main', mergeMethod: 'squash',
      changeClasses: ['docs', 'app-code'],
      commands: { deploy: 'deploy/release.ps1', observe: 'deploy/observe.ps1', check: 'deploy/check.ps1', rollback: 'deploy/rollback.ps1' },
      credential: { ref: 'aiworks-release/dyk', owner: 'netbka' }, rollback: 'automatic', checkWindowMinutes: 10,
    },
    {
      id: 'main-merge', environment: 'production', kind: 'merge', baseBranch: 'main', mergeMethod: 'merge',
      changeClasses: ['docs'], credential: { ref: 'aiworks-release/dyk', owner: 'netbka' }, rollback: 'automatic', checkWindowMinutes: 5,
    },
  ],
  classes: { docs: ['docs/**', '*.md'], 'app-code': ['src/**'], migration: ['db/migrations/**'] },
  ownerConfirm: ['dependency-update'],
});
const invalidBecause = (value, pattern) => {
  const result = validateAuthorization(value, options);
  assert.equal(result.valid, false, `expected invalid: ${JSON.stringify(value)}`);
  assert.deepEqual(result.destinations, []);
  assert.ok(result.reasons.some((reason) => pattern.test(reason)), `no reason matches ${pattern}: ${JSON.stringify(result.reasons)}`);
};

test('a valid record yields its digest and destinations', () => {
  const bytes = Buffer.from(`${JSON.stringify(record(), null, 2)}\n`);
  const result = parseAuthorization(bytes, options);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.valid, true);
  assert.deepEqual(result.destinations, ['production', 'main-merge']);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
  assert.equal(result.digest, recordDigest(bytes));
  // The digest binds to the exact bytes read: the same record with other whitespace is a different digest.
  assert.notEqual(parseAuthorization(JSON.stringify(record()), options).digest, result.digest);
  // Optional fields may be absent; local kinds take commands and no merge fields.
  assert.equal(validateAuthorization(record((r) => { delete r.ownerConfirm; return r; }), options).valid, true);
  assert.equal(validateAuthorization(record((r) => ({ ...r, destinations: [{
    id: 'folder', environment: 'local', kind: 'local-folder-apply', changeClasses: ['docs'], commands: { check: 'scripts/check.ps1' },
    credential: { ref: 'aiworks-release/dyk', owner: 'netbka' }, rollback: 'report-only', checkWindowMinutes: 5,
  }] })), options).valid, true);
});

test('missing, unknown or mistyped fields are invalid', () => {
  for (const field of ['schema', 'project', 'version', 'approval', 'grantedAt', 'expiresAt', 'revoked', 'destinations', 'classes']) {
    invalidBecause(record((r) => { delete r[field]; return r; }), new RegExp(`missing ${field}$`));
  }
  for (const field of ['id', 'environment', 'kind', 'changeClasses', 'credential', 'rollback', 'checkWindowMinutes']) {
    invalidBecause(record((r) => { delete r.destinations[0][field]; return r; }), new RegExp(`^/destinations/0 is missing ${field}$`));
  }
  invalidBecause(record((r) => { delete r.destinations[1].baseBranch; return r; }), /^\/destinations\/1 is missing baseBranch$/);
  invalidBecause(record((r) => { delete r.destinations[0].commands; return r; }), /^\/destinations\/0 is missing commands$/);
  invalidBecause(record((r) => ({ ...r, autoApprove: true })), /^the record has unknown field autoApprove$/);
  invalidBecause(record((r) => { r.destinations[0].credential.value = 'secret'; return r; }), /credential has unknown field value$/);
  invalidBecause(record((r) => { r.destinations[0].commands.migrate = 'x.ps1'; return r; }), /commands has unknown field migrate$/);
  invalidBecause(record((r) => ({ ...r, version: '3' })), /^\/version must be integer$/);
  invalidBecause(record((r) => ({ ...r, version: 0 })), /^\/version /);
  invalidBecause(record((r) => ({ ...r, revoked: 'no' })), /^\/revoked must be boolean$/);
  invalidBecause(record((r) => ({ ...r, destinations: [] })), /^\/destinations /);
  invalidBecause(record((r) => ({ ...r, schema: 'aiworks-release-authorization/2' })), /^\/schema /);
  invalidBecause(record((r) => ({ ...r, approval: 'https://example.com/approve' })), /^\/approval /);
  invalidBecause(record((r) => { r.destinations[0].kind = 'deploy'; return r; }), /^\/destinations\/0\/kind /);
  invalidBecause(record((r) => { r.destinations[0].commands.deploy = '../outside.ps1'; return r; }), /commands\/deploy is not a plain path inside the project$/);
  invalidBecause(record((r) => { r.destinations[0].commands.deploy = 'C:/deploy.ps1'; return r; }), /commands\/deploy is not a plain path/);
  invalidBecause(record((r) => ({ ...r, destinations: [{
    id: 'git', environment: 'local', kind: 'local-git-apply', baseBranch: 'main', changeClasses: ['docs'], commands: { check: 'c.ps1' },
    credential: { ref: 'aiworks-release/dyk', owner: 'netbka' }, rollback: 'report-only', checkWindowMinutes: 5,
  }] })), /names baseBranch or mergeMethod, which only merge destinations take$/);
  invalidBecause(record((r) => ({ ...r, grantedAt: '2026-02-30' })), /grantedAt 2026-02-30 is not a real date/);
  invalidBecause(record((r) => ({ ...r, project: 'aiworks' })), /^the record is for project aiworks, not dyk$/);
  // Several problems are each reported, not only the first.
  assert.equal(validateAuthorization(record((r) => ({ ...r, version: 'x', revoked: 'x' })), options).reasons.length, 2);
  assert.deepEqual(parseAuthorization('{"schema":', options).reasons, ['the record is not valid JSON']);
  for (const value of [null, [], 'record', 7]) assert.equal(validateAuthorization(value, options).valid, false);
});

test('expired or revoked grants are invalid', () => {
  invalidBecause(record((r) => ({ ...r, revoked: true })), /^grant version 3 is revoked$/);
  // Expiry is checked against the evaluation time: valid the day before expiresAt, invalid from that day on.
  const late = { ...options, now: Date.parse('2027-01-29T23:59:59Z') };
  assert.equal(validateAuthorization(record(), late).valid, true);
  for (const now of [Date.parse('2027-01-30T00:00:00Z'), Date.parse('2027-06-01T00:00:00Z')]) {
    const result = validateAuthorization(record(), { ...options, now });
    assert.equal(result.valid, false);
    assert.deepEqual(result.reasons, ['the grant expired on 2027-01-30']);
  }
  const early = validateAuthorization(record(), { ...options, now: new Date('2026-10-31T23:00:00Z') });
  assert.deepEqual(early.reasons, ['the grant starts on 2026-11-01, which is still to come']);
  assert.throws(() => validateAuthorization(record(), { project: 'dyk' }), /evaluation time/);
  assert.throws(() => validateAuthorization(record(), { now: NOW }), /expected project id/);
});

test('migration, infrastructure or permissions in changeClasses make the record invalid', () => {
  assert.deepEqual(FORBIDDEN_CLASSES, ['migration', 'infrastructure', 'permissions']);
  for (const name of FORBIDDEN_CLASSES) {
    invalidBecause(record((r) => { r.destinations[1].changeClasses.push(name); return r; }),
      new RegExp(`^destination main-merge accepts ${name}, which no AIWorks grant may release$`));
  }
  // Declaring a path rule for a forbidden class is allowed: it is how such files are recognised and blocked.
  assert.equal(validateAuthorization(record(), options).valid, true);
});

test('a deploy destination without observe is invalid', () => {
  invalidBecause(record((r) => { delete r.destinations[0].commands.observe; return r; }),
    /^destination production deploys but names no read-only observe command/);
  invalidBecause(record((r) => { delete r.destinations[0].commands.deploy; return r; }), /^destination production deploys but names no deploy command$/);
  invalidBecause(record((r) => { delete r.destinations[0].commands.rollback; return r; }),
    /^destination production asks for automatic rollback but names no rollback command$/);
  // A plain merge is rolled back by a revert and needs no commands at all.
  assert.equal(record().destinations[1].commands, undefined);
});

test('expiry beyond 90 days is invalid', () => {
  assert.equal(validateAuthorization(record((r) => ({ ...r, expiresAt: '2027-01-30' })), options).valid, true); // exactly 90 days
  invalidBecause(record((r) => ({ ...r, expiresAt: '2027-01-31' })), /^expiresAt 2027-01-31 is more than 90 days after grantedAt 2026-11-01$/);
  invalidBecause(record((r) => ({ ...r, expiresAt: '2026-11-01' })), /^expiresAt 2026-11-01 is not after grantedAt 2026-11-01$/);
});

test('a record is loaded from the commit of a fetched base ref, and an unreadable one is invalid', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'aiworks-release-auth-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => {
    const out = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test'); git('config', 'core.autocrlf', 'false');
  mkdirSync(join(repo, 'release'));
  const bytes = `${JSON.stringify(record(), null, 2)}\n`;
  writeFileSync(join(repo, 'release', 'aiworks-release.json'), bytes);
  git('add', '.'); git('commit', '-q', '-m', 'grant');
  const granted = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', granted);
  // A later revocation on an unmerged branch does not change what the base ref says.
  git('checkout', '-q', '-b', 'pending');
  writeFileSync(join(repo, 'release', 'aiworks-release.json'), JSON.stringify(record((r) => ({ ...r, revoked: true }))));
  git('commit', '-q', '-am', 'revoke');

  const loaded = loadAuthorization({ repoPath: repo, ref: 'origin/main', path: 'release/aiworks-release.json', ...options });
  assert.equal(loaded.valid, true, loaded.reasons.join('; '));
  assert.equal(loaded.commit, granted);
  assert.equal(loaded.digest, recordDigest(Buffer.from(bytes)));
  assert.deepEqual(loaded.destinations, ['production', 'main-merge']);
  const pending = loadAuthorization({ repoPath: repo, ref: 'pending', path: 'release/aiworks-release.json', ...options });
  assert.deepEqual(pending.reasons, ['grant version 3 is revoked']);

  const missingRef = loadAuthorization({ repoPath: repo, ref: 'origin/absent', path: 'release/aiworks-release.json', ...options });
  assert.deepEqual([missingRef.valid, missingRef.commit, missingRef.reasons], [false, null, ['base ref origin/absent cannot be read']]);
  const missingFile = loadAuthorization({ repoPath: repo, ref: 'origin/main', path: 'release/other.json', ...options });
  assert.equal(missingFile.valid, false);
  assert.equal(missingFile.commit, granted);
  assert.match(missingFile.reasons[0], /^there is no release record at release\/other.json on origin\/main/);
  for (const path of ['../release/aiworks-release.json', '/release/aiworks-release.json', 'release\\aiworks-release.json', 'C:/x.json']) {
    assert.match(loadAuthorization({ repoPath: repo, ref: 'origin/main', path, ...options }).reasons[0], /is not a plain path inside the project$/);
  }
  assert.match(loadAuthorization({ repoPath: repo, ref: '--all', path: 'release/aiworks-release.json', ...options }).reasons[0], /is not a ref name$/);
});
