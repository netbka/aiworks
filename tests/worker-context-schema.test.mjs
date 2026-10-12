import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { packetDigest, validatePolicy, validatePacket } from '../scripts/lib/worker-context.mjs';
import * as workerContext from '../scripts/lib/worker-context.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url)));
const policy = read('registry/worker-context-policy.json');
const ajv = new Ajv({ allErrors: true, strict: true });
const policyShape = ajv.compile(read('schemas/worker-context-policy.schema.json'));
const packetShape = ajv.compile(read('schemas/worker-task-packet.schema.json'));
const packet = {
  version: 1, tenantId: 'synthetic', projectId: 'example-project', environment: 'test',
  taskId: 'TASK-1', stageId: 'schema', runId: 'schema-run', role: 'verification',
  revision: 'a'.repeat(40), authorityDigest: 'b'.repeat(64), access: 'read-only',
  goal: 'Verify the C0 schema.', constraints: ['Synthetic metadata only.'],
  acceptance: ['Unsafe packet shapes fail.'],
  references: [{ path: 'docs/WORKER_CONTEXT_LIFECYCLE.md', revision: 'a'.repeat(40) }],
};

test('policy and packet shapes agree with their semantic helpers', () => {
  assert.equal(policyShape(policy), true, JSON.stringify(policyShape.errors));
  assert.equal(packetShape(packet), true, JSON.stringify(packetShape.errors));
  validatePolicy(policy); validatePacket(packet, policy);
});
test('schema and semantic policy validators reject unsafe bounds', () => {
  for (const [field, value] of [['cleanupTimeoutMs', 0], ['maxCleanupAttempts', 2], ['maxReplacementAttempts', 99], ['maxReaperAttempts', 99], ['maxQuarantinedSessions', 0], ['hardOccupancy', 1]]) {
    const invalid = { ...policy, [field]: value };
    assert.equal(policyShape(invalid), false, field);
    assert.throws(() => validatePolicy(invalid), TypeError);
  }
});
test('pointer shapes reject traversal, URLs, encoded/control-character content and unknown fields', () => {
  for (const path of ['../secret', '/private', 'https://host', 'D:\\private', 'docs/%2e%2e/x', 'docs/\nraw', 'docs//x', './AGENTS.md']) {
    const invalid = structuredClone(packet); invalid.references[0].path = path;
    assert.equal(packetShape(invalid), false, path);
    assert.throws(() => validatePacket(invalid, policy), TypeError);
  }
  const invalid = { ...packet, copiedTranscript: 'not allowed' };
  assert.equal(packetShape(invalid), false);
  assert.throws(() => validatePacket(invalid, policy), TypeError);
});
test('shape validation alone is insufficient for packet byte budget and policy ordering', () => {
  const tooLarge = { ...packet, constraints: Array(32).fill('Ж'.repeat(1000)) };
  assert.equal(packetShape(tooLarge), true);
  assert.throws(() => validatePacket(tooLarge, policy), /byte budget/);
  const unordered = { ...policy, softOccupancy: 0.91 };
  assert.equal(policyShape(unordered), true);
  assert.throws(() => validatePolicy(unordered), TypeError);
});

// engineering-platform-archive#84: the target project's inherited governance, as values only.
const governance = {
  project: 'elma-wiki', policies: ['GOV-001', 'UX-001', 'VERIFY-001'],
  authorities: [{ role: 'agent-contract', path: 'AGENTS.md' }, { role: 'principles', path: 'docs/PRINCIPLES.md#owner-reserved-matters' }],
  exceptions: [{ id: 'prod-ssh-password', rule: 'constitution#7' }],
  gaps: [{ id: 'prod-root-credential', rule: 'baseline:credential-boundaries' }, { id: 'clause-gap', rule: 'policy:UX-001#preserve-context' }],
};
test('packet governance is optional, digest-bound and values only; schema and helper agree', () => {
  const carried = { ...packet, governance };
  assert.equal(packetShape(carried), true, JSON.stringify(packetShape.errors));
  validatePacket(carried, policy);
  validatePacket(packet, policy);
  assert.notEqual(packetDigest(carried, policy), packetDigest(packet, policy), 'the packet digest binds the governance block');
  for (const [label, change] of [
    ['copied summary', (g) => { g.exceptions[0].summary = 'Production updates read a shared password.'; }],
    ['file contents', (g) => { g.authorities[0].content = '# Agent rules'; }],
    ['another repository', (g) => { g.authorities[0].path = '../Dyk/AGENTS.md'; }],
    ['absolute path', (g) => { g.authorities[0].path = '/etc/AGENTS.md'; }],
    ['local path', (g) => { g.authorities[0].path = 'D:\\Git\\Dyk\\AGENTS.md'; }],
    ['URL', (g) => { g.authorities[0].path = 'https://github.com/netbka/Dyk/blob/main/AGENTS.md'; }],
    ['dot segment', (g) => { g.authorities[1].path = 'docs/./PRINCIPLES.md'; }],
    ['policy id', (g) => { g.policies.push('ux-001'); }],
    ['duplicate policy', (g) => { g.policies.push('GOV-001'); }],
    ['free-form rule', (g) => { g.gaps[0].rule = 'anything the project prefers'; }],
    ['missing list', (g) => { delete g.gaps; }],
    ['unknown field', (g) => { g.notes = 'free text'; }],
  ]) {
    const invalid = { ...packet, governance: structuredClone(governance) };
    change(invalid.governance);
    assert.equal(packetShape(invalid), false, label);
    assert.throws(() => validatePacket(invalid, policy), TypeError, label);
  }
  assert.throws(() => validatePacket({ ...packet, governance: undefined }, policy), TypeError, 'present means valid');
  assert.throws(() => validatePacket({ ...packet, governance: null }, policy), TypeError);
});

// engineering-platform-archive#132 review: workers are told to read the authorities, so no authority may point at a secret-like file.
const SECRET_LIKE = ['.env', '.env.production', 'deploy/.env.local', '.envrc', '.ENV', '.git/config', '.git', 'tools/.git/HEAD',
  '.ssh/id_rsa', 'home/.gnupg/pubring.kbx', 'secrets/prod.pem', 'secrets', 'config/Secrets.yaml', 'secret/token.txt',
  'credentials', 'credentials.json', 'aws/credential', 'keys/id_rsa', 'id_rsa.pub', 'id_ed25519', 'certs/server.key',
  'certs/server.crt', 'certs/ca.cer', 'certs/ca.der', 'certs/client.p12', 'certs/client.PFX', 'android/release.jks',
  'android/release.keystore', 'docs/server.pem#setup'];
const ORDINARY = ['AGENTS.md', '.agent/capabilities.yaml', '.github/workflows/check.yml', '.gitignore', '.gitattributes',
  'storybook/review-manifest.json', 'testing/workflows', 'docs/ENVIRONMENT.md', 'docs/SECRET_HANDLING.md', 'docs/keys.md',
  'deploy/README.md#environment', 'docs/PRINCIPLES.md#credentials', 'docs/secrets-policy.md', 'planning/ACTIVE_WORK.md'];
test('secret-like authority paths are refused by the packet helper and both schemas, which share one pattern', () => {
  const pattern = workerContext.SECRET_LIKE_PATH_PATTERN;
  assert.equal(typeof pattern, 'string');
  const contractPath = read('tests/fixtures/governance/schemas/project-contract.schema.json').$defs.projectPath;
  const packetPath = read('schemas/worker-task-packet.schema.json').properties.governance.properties.authorities.items.properties.path;
  assert.equal(contractPath.not?.pattern, pattern, 'the registry projectPath carries the identical pattern');
  assert.equal(packetPath.not?.pattern, pattern, 'the packet schema carries the identical pattern');
  const withPath = (path) => ({ ...packet, governance: { ...governance, authorities: [{ role: 'runtime-state', path }] } });
  for (const path of SECRET_LIKE) {
    assert.equal(packetShape(withPath(path)), false, `schema refuses ${path}`);
    assert.throws(() => validatePacket(withPath(path), policy), TypeError, `helper refuses ${path}`);
  }
  for (const path of ORDINARY) {
    assert.equal(packetShape(withPath(path)), true, `schema accepts ${path}: ${JSON.stringify(packetShape.errors)}`);
    assert.doesNotThrow(() => validatePacket(withPath(path), policy), `helper accepts ${path}`);
  }
});
