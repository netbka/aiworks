// campaign-token.mjs: the one general, reusable way to create or rotate the external campaign API's bearer token
// (docs/SUPERVISOR.md section 16) for any AIWorks-registered project, not a one-off for a single external project. A
// synthetic command-helper credential store only; no test reads the real Windows Credential Manager. Critical
// behaviour covered: the registration gate (a token is never created for an unregistered project id), the standard
// reference naming (no caller can invent its own name), create/rotate never silently overwrite or silently do
// nothing, and the token value itself never appears in a return value, a thrown error or config.json.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyCampaignApiConfig, assertRegisteredProjectId, campaignTokenRef, issueCampaignToken,
} from '../../src/supervisor/campaign-token.mjs';
import { GOVERNANCE } from './helpers.mjs';

/** A synthetic credential-helper command (release/credential.mjs commandCredentialStore's contract), has/get/set
 * all backed by one JSON file. `set` reads its value from stdin, exactly as the real helper contract requires, so the
 * value is never a process argument the test (or anything else on the machine) could observe in a listing. */
function vaultHelper(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-campaign-token-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vault = join(dir, 'vault.json');
  writeFileSync(vault, JSON.stringify({}));
  writeFileSync(join(dir, 'helper.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
const [vaultPath, op, ref] = process.argv.slice(2);
const vault = JSON.parse(readFileSync(vaultPath, 'utf8'));
if (op === 'has') process.exit(ref in vault ? 0 : 1);
else if (op === 'get') { if (!(ref in vault)) process.exit(1); process.stdout.write(vault[ref] + '\\n'); process.exit(0); }
else if (op === 'set') {
  let value = '';
  process.stdin.on('data', (chunk) => { value += chunk; });
  process.stdin.on('end', () => { vault[ref] = value; writeFileSync(vaultPath, JSON.stringify(vault)); process.exit(0); });
}
else process.exit(2);
`);
  return {
    command: [process.execPath, join(dir, 'helper.mjs'), vault],
    read: (ref) => JSON.parse(readFileSync(vault, 'utf8'))[ref],
  };
}

test('campaignTokenRef is the one standard name: aiworks-campaign-api:<projectId>, never invented by a caller', () => {
  assert.equal(campaignTokenRef('sample-wiki'), 'aiworks-campaign-api:sample-wiki');
  for (const bad of ['Sample-Wiki', 'sample wiki', '../x', '', null, undefined, 42, 'x'.repeat(129)]) {
    assert.throws(() => campaignTokenRef(bad), /PROJECT_ID_INVALID|project id/, String(bad));
  }
});

test('assertRegisteredProjectId only passes a project with registry/projects/<id>.json in the governance checkout', () => {
  assertRegisteredProjectId('sample-wiki', GOVERNANCE); // present in tests/fixtures/governance/registry/projects
  assert.throws(() => assertRegisteredProjectId('never-registered-project', GOVERNANCE), (error) => error.code === 'PROJECT_NOT_REGISTERED');
  assert.throws(() => assertRegisteredProjectId('sample-wiki', null), (error) => error.code === 'GOVERNANCE_ROOT_REQUIRED');
  assert.throws(() => assertRegisteredProjectId('sample-wiki', '/not/absolute'), (error) => error.code === 'GOVERNANCE_ROOT_INVALID');
});

test('create refuses an unregistered project id; nothing is written to the credential store', (t) => {
  const vault = vaultHelper(t);
  assert.throws(() => issueCampaignToken('never-registered-project', { governanceRoot: GOVERNANCE, credentialStoreSpec: { kind: 'command', command: vault.command } }),
    (error) => error.code === 'PROJECT_NOT_REGISTERED');
  assert.equal(vault.read('aiworks-campaign-api:never-registered-project'), undefined);
});

test('create writes a fresh random token under the standard reference and points config.json at it; the value is never returned', (t) => {
  const vault = vaultHelper(t);
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-campaign-token-data-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = issueCampaignToken('sample-wiki', { governanceRoot: GOVERNANCE, dataDir, credentialStoreSpec: { kind: 'command', command: vault.command } });
  assert.equal(result.projectId, 'sample-wiki');
  assert.equal(result.ref, 'aiworks-campaign-api:sample-wiki');
  assert.equal(result.rotated, false);
  assert.deepEqual(result.config, { enabled: true, tokenRef: 'aiworks-campaign-api:sample-wiki', credentialStore: { kind: 'command', command: vault.command } });
  assert.ok(!JSON.stringify(result).includes(vault.read('aiworks-campaign-api:sample-wiki')), 'the stored value never appears in the returned object');

  const stored = vault.read('aiworks-campaign-api:sample-wiki');
  assert.equal(typeof stored, 'string');
  assert.match(stored, /^[A-Za-z0-9_-]{43}$/, 'crypto.randomBytes(32).toString(base64url): 256 bits, unpadded');

  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  assert.deepEqual(config.campaignApi, { enabled: true, tokenRef: 'aiworks-campaign-api:sample-wiki', credentialStore: { kind: 'command', command: vault.command } });
  assert.ok(!JSON.stringify(config).includes(stored), 'config.json never holds the token value itself');
});

test('create refuses to overwrite an existing token; rotate refuses when none exists; rotate replaces it with a new value', (t) => {
  const vault = vaultHelper(t);
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-campaign-token-data-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const spec = { governanceRoot: GOVERNANCE, dataDir, credentialStoreSpec: { kind: 'command', command: vault.command } };

  assert.throws(() => issueCampaignToken('sample-wiki', { ...spec, rotate: true }), (error) => error.code === 'TOKEN_NOT_FOUND');

  const first = issueCampaignToken('sample-wiki', spec);
  const firstValue = vault.read(first.ref);

  assert.throws(() => issueCampaignToken('sample-wiki', spec), (error) => error.code === 'TOKEN_ALREADY_EXISTS');
  assert.equal(vault.read(first.ref), firstValue, 'a refused create never touches the existing value');

  const rotated = issueCampaignToken('sample-wiki', { ...spec, rotate: true });
  assert.equal(rotated.rotated, true);
  assert.equal(rotated.ref, first.ref);
  const secondValue = vault.read(first.ref);
  assert.notEqual(secondValue, firstValue, 'rotate replaces the value; it is never reused');
});

test('applyCampaignApiConfig keeps the rest of config.json and names only tokenRef (and a non-default store)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-campaign-token-cfg-'));
  try {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ governanceRoot: GOVERNANCE, tickMs: 50 }));
    const ref = `aiworks-campaign-api:${randomUUID()}`;
    const setting = applyCampaignApiConfig(dataDir, ref);
    assert.deepEqual(setting, { enabled: true, tokenRef: ref });
    const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
    assert.equal(config.governanceRoot, GOVERNANCE);
    assert.equal(config.tickMs, 50);
    assert.deepEqual(config.campaignApi, setting);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
