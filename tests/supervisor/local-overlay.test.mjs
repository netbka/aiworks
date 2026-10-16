// A project without GitHub follows rules the owner confirmed once (docs/design/PROJECT_CONNECTION.md section 7, slice
// S7, plan STA15): an overlay entry passes the schema AIWorks ships, can only add or tighten rules, and gets every
// portfolio policy from the governance directory by the same derivation as a registry entry. Nothing here writes the
// governance directory, and starting work on a local project stays off.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { validGovernance } from '../../scripts/lib/worker-context.mjs';
import { governanceForContract, overlayGovernance, projectGovernance } from '../../src/supervisor/campaign.mjs';
import { OverlayError, overlayDigest, validateOverlayEntry } from '../../src/supervisor/local-overlay.mjs';
import { GOVERNANCE, ROOT } from './helpers.mjs';

const NOW = new Date('2026-10-16T12:00:00Z');
const readGov = (path) => JSON.parse(readFileSync(join(GOVERNANCE, path), 'utf8'));
const catalogPolicies = readGov('policies/catalog.json').policies.map(readGov);
const catalogIds = catalogPolicies.map((policy) => policy.id);
const uiOnlyIds = catalogPolicies.filter((policy) => policy.applies_when.boundaries?.every((boundary) => boundary === 'ui')).map((policy) => policy.id);

/** A valid entry, confirmed: `change` edits the unconfirmed entry before its digest is taken. */
function entry(change = () => {}) {
  const value = {
    id: 'lp-sample-notes',
    name: 'Sample notes',
    source: { kind: 'folder' },
    lifecycle: 'active',
    capabilities: ['ui'],
    environments: ['local'],
    governance: {
      observedAt: `local:lp-sample-notes@sha256:${'a'.repeat(64)}`,
      authorities: [{ role: 'agent-contract', path: 'AGENTS.md' }],
      stricter: [{ id: 'tests-always', rule: 'baseline:tests-always', note: 'every change runs the tests' }],
      gaps: [{ id: 'no-backup', rule: 'baseline:backups', note: 'backups are manual for now' }],
      independentVerificationGate: 'enabled',
    },
    approval: { by: 'owner', at: '2026-10-16', method: 'owner-local-ui', digest: '' },
    reviewBy: '2027-10-16',
  };
  change(value);
  value.approval.digest = overlayDigest(value);
  return value;
}
// `root: undefined` means no governance directory is configured, so the fixture is used only when `root` is not given.
const refused = (value, code, options = {}) => {
  const { root, ...rest } = options;
  assert.throws(() => overlayGovernance(value, Object.hasOwn(options, 'root') ? root : GOVERNANCE, { now: NOW, ...rest }),
    (error) => error instanceof OverlayError && error.code === code, `refused with ${code}`);
};

/** Every file under `dir` with its bytes and modification time, to prove a directory was not written. */
function snapshot(dir) {
  const out = {};
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else out[full] = `${stat.mtimeMs}:${readFileSync(full).toString('base64')}`;
    }
  };
  walk(dir);
  return out;
}
let governanceBefore;
before(() => { governanceBefore = snapshot(GOVERNANCE); });
after(() => assert.deepEqual(snapshot(GOVERNANCE), governanceBefore, 'nothing under the governance directory is written'));

/** A disposable governance root copied from the fixture; `edit` may change it before use. */
function governanceRoot(t, edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-overlay-governance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(GOVERNANCE, root, { recursive: true });
  edit(root);
  return root;
}

test('a valid entry yields the values a registry entry would, with no exceptions and only id and rule for gaps', () => {
  const value = entry();
  const governance = overlayGovernance(value, GOVERNANCE, { now: NOW });
  assert.deepEqual(governance, {
    project: 'lp-sample-notes',
    policies: catalogIds,
    authorities: [{ role: 'agent-contract', path: 'AGENTS.md' }],
    exceptions: [],
    gaps: [{ id: 'no-backup', rule: 'baseline:backups' }],
  });
  assert.ok(validGovernance(governance), 'a worker packet can carry the values');
  assert.ok(!JSON.stringify(governance).includes('"note"'), 'no note reaches a packet');
  assert.deepEqual(validateOverlayEntry(value, GOVERNANCE, { now: NOW }).entry, value, 'validation returns the entry unchanged');
});

test('policies equal the registry derivation for the same capabilities: every portfolio policy, none left out', () => {
  assert.ok(uiOnlyIds.length > 0, 'the catalog has ui-only policies to rule out');
  for (const capabilities of [['ui'], [], ['api', 'database'], ['ui', 'ai']]) {
    const contract = { id: 'same-caps', name: 'Same', repository: { github: 'example-org/same-caps' }, lifecycle: 'active', capabilities, environments: ['local'] };
    const registry = governanceForContract(contract, GOVERNANCE);
    const overlay = overlayGovernance(entry((value) => { value.capabilities = capabilities; }), GOVERNANCE, { now: NOW });
    assert.deepEqual(overlay.policies, registry.policies, `same policies for [${capabilities}]`);
    assert.deepEqual(overlay.policies, capabilities.includes('ui') ? catalogIds : catalogIds.filter((id) => !uiOnlyIds.includes(id)));
  }
  assert.deepEqual(overlayGovernance(entry(), GOVERNANCE, { now: NOW }).policies, projectGovernance('example-org/sampleapp', GOVERNANCE).policies,
    'a ui project gets the policies the registered ui project gets');
});

test('an entry that loosens a rule is refused with its code', () => {
  refused(entry((value) => { value.governance.exceptions = [{ id: 'skip-review', rule: 'constitution#7' }]; }), 'RULES_EXCEPTION');
  refused(entry((value) => { value.governance.releaseAuthorization = { source: 'RELEASE.md', approval: 'owner', summary: 'deploy' }; }), 'RULES_RELEASE_AUTHORIZATION');
  refused(entry((value) => { value.environments = ['prod']; }), 'RULES_ENVIRONMENT');
  refused(entry((value) => { value.environments = ['local', 'prod']; }), 'RULES_ENVIRONMENT');
  refused(entry((value) => { delete value.environments; }), 'RULES_ENVIRONMENT');
  refused(entry((value) => { value.governance.independentVerificationGate = 'not-enabled'; }), 'RULES_VERIFICATION_OFF');
  refused(entry((value) => { delete value.governance.independentVerificationGate; }), 'RULES_VERIFICATION_OFF');
  refused(entry((value) => { value.repository = { github: 'example-org/sample-notes' }; }), 'RULES_REPOSITORY');
  refused(entry((value) => { value.secrets = { current: 'vault' }; }), 'RULES_REPOSITORY');
  refused(entry((value) => { value.resources = {}; }), 'RULES_REPOSITORY');
  for (const path of ['.env', 'config/.env.local', 'keys/id_rsa', 'secrets/prod.json', 'certs/server.pem']) {
    refused(entry((value) => { value.governance.authorities = [{ role: 'agent-contract', path }]; }), 'RULES_PATH');
  }
  for (const path of ['/etc/passwd', 'C:/Users/x', '../outside.md', 'docs/../../x', 'docs\\x.md']) {
    refused(entry((value) => { value.governance.authorities = [{ role: 'agent-contract', path }]; }), 'RULES_PATH');
  }
});

test('an entry outside the schema is refused: it lists no policies and has no field the schema leaves out', () => {
  refused(entry((value) => { value.policies = ['GOV-001']; }), 'RULES_INVALID');
  refused(entry((value) => { value.governance.parentLink = 'linked'; }), 'RULES_INVALID');
  refused(entry((value) => { value.source = { kind: 'github' }; }), 'RULES_INVALID');
  refused(entry((value) => { value.approval.method = 'agent'; }), 'RULES_INVALID');
  refused(entry((value) => { value.reviewBy = '2027-02-30'; }), 'RULES_INVALID');
  refused('not an entry', 'RULES_INVALID');
  // A gap rule a worker packet cannot carry is refused, never dropped.
  refused(entry((value) => { value.governance.gaps = [{ id: 'free-text', rule: 'anything goes' }]; }), 'RULES_INVALID');
});

test('capabilities use the governance directory\'s own words', () => {
  refused(entry((value) => { value.capabilities = ['ui', 'no-policies-here']; }), 'RULES_UNKNOWN_CAPABILITY');
});

test('ids start with lp-, never equal a registry id and are never reused', (t) => {
  refused(entry((value) => { value.id = 'sampleapp'; }), 'RULES_ID_PREFIX');
  refused(entry((value) => { value.id = 'local-tool'; }), 'RULES_ID_PREFIX');
  const root = governanceRoot(t, (dir) => writeFileSync(join(dir, 'registry', 'projects', 'lp-sample-notes.json'),
    JSON.stringify({ id: 'lp-sample-notes', name: 'Taken', repository: { github: 'example-org/taken' }, lifecycle: 'active', capabilities: [], environments: ['local'] })));
  refused(entry(), 'RULES_ID_REGISTERED', { root });
  refused(entry(), 'RULES_ID_REUSED', { takenIds: ['lp-other', 'lp-sample-notes'] });
  assert.doesNotThrow(() => overlayGovernance(entry(), GOVERNANCE, { now: NOW, takenIds: ['lp-other'] }));
});

test('the owner\'s confirmation is bound to the exact entry', () => {
  const edited = entry();
  edited.capabilities = [];
  refused(edited, 'RULES_DIGEST_MISMATCH');
  const widened = entry();
  widened.governance.gaps.push({ id: 'another', rule: 'baseline:another' });
  refused(widened, 'RULES_DIGEST_MISMATCH');
  const value = entry();
  assert.equal(overlayDigest({ ...value, approval: { ...value.approval, by: 'someone else' } }), value.approval.digest, 'the digest leaves out approval');
});

test('a confirmation lasts at most 365 days and is refused after reviewBy', () => {
  assert.doesNotThrow(() => overlayGovernance(entry(), GOVERNANCE, { now: new Date('2027-10-16T23:59:00Z') }), 'valid through reviewBy');
  refused(entry(), 'RULES_EXPIRED', { now: new Date('2027-10-17T00:00:00Z') });
  refused(entry((value) => { value.reviewBy = '2027-10-17'; }), 'RULES_REVIEW_TOO_FAR');
  refused(entry((value) => { value.reviewBy = '2026-10-15'; }), 'RULES_REVIEW_TOO_FAR');
  // 2028 is a leap year: 365 days after 2027-10-16 is 2028-10-15.
  assert.doesNotThrow(() => overlayGovernance(entry((value) => { value.approval.at = '2027-10-16'; value.reviewBy = '2028-10-15'; }), GOVERNANCE, { now: NOW }));
  refused(entry((value) => { value.approval.at = '2027-10-16'; value.reviewBy = '2028-10-16'; }), 'RULES_REVIEW_TOO_FAR');
});

test('without a readable governance directory every entry is inert: RULES_UNAVAILABLE, no fallback', (t) => {
  refused(entry(), 'RULES_UNAVAILABLE', { root: undefined });
  refused(entry(), 'RULES_UNAVAILABLE', { root: 'relative/governance' });
  refused(entry(), 'RULES_UNAVAILABLE', { root: join(tmpdir(), 'aiworks-no-such-governance') });
  for (const missing of ['policies/catalog.json', 'policies/GOV-001.json', 'schemas/project-contract.schema.json']) {
    refused(entry(), 'RULES_UNAVAILABLE', { root: governanceRoot(t, (dir) => rmSync(join(dir, missing))) });
  }
  refused(entry(), 'RULES_UNAVAILABLE', { root: governanceRoot(t, (dir) => writeFileSync(join(dir, 'policies', 'catalog.json'), '{')) });
  // A broken root refuses even an entry that is otherwise malformed: there is no rule set to check it against.
  refused({ id: 'lp-x' }, 'RULES_UNAVAILABLE', { root: undefined });
});

test('the overlay code only reads: no writes, no store, no git, gh or network', () => {
  const source = readFileSync(join(ROOT, 'src', 'supervisor', 'local-overlay.mjs'), 'utf8');
  for (const forbidden of ['writeFile', 'appendFile', 'mkdir', 'rmSync', 'renameSync', 'child_process', 'fetch(', 'node:http', 'node:net', '.run(', 'INSERT', 'UPDATE ']) {
    assert.ok(!source.includes(forbidden), `local-overlay.mjs does not use ${forbidden}`);
  }
});

test('a disposable copy of the governance directory is read, never written', (t) => {
  const root = governanceRoot(t);
  const beforeRun = snapshot(root);
  overlayGovernance(entry(), root, { now: NOW });
  refused(entry((value) => { value.environments = ['prod']; }), 'RULES_ENVIRONMENT', { root });
  assert.deepEqual(snapshot(root), beforeRun);
});
