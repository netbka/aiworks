// A new campaign may target only a registered portfolio project; stored campaigns are unaffected. Task roles must be in
// governance provider's role catalog, and campaign `routing` validates (docs/design/MODEL_ROUTING.md slice R3).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, GOVERNANCE, ROOT, runCli, runtimeCheckout, SQLITE } from './helpers.mjs';
import { assertRegisteredTarget, authorityDigest, canonicalJson, scopeDigest, validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { roleCatalog } from '../../src/supervisor/governance.mjs';
import { campaignPause, campaignStart } from '../../src/supervisor/api.mjs';
const Store = SQLITE ? (await import('../../src/supervisor/store.mjs')).Store : null;

const REGISTRY = GOVERNANCE;
const unregistered = () => {
  const decl = declaration({ campaignId: 'unregistered-target' });
  decl.target = { ...decl.target, projectId: 'nowhere', repository: 'example-org/not-a-registered-project' };
  return decl;
};

test('registered targets pass, case-insensitively; unregistered targets are refused', () => {
  assert.doesNotThrow(() => assertRegisteredTarget(declaration(), REGISTRY));
  const upper = declaration();
  upper.target = { ...upper.target, repository: 'EXAMPLE-ORG/sampleapp' };
  assert.doesNotThrow(() => assertRegisteredTarget(upper, REGISTRY));
  assert.throws(() => assertRegisteredTarget(unregistered(), REGISTRY), /not a registered project/);
});

test('the check reads only the given governance root registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-registry-'));
  try {
    mkdirSync(join(dir, 'registry', 'projects'), { recursive: true });
    writeFileSync(join(dir, 'registry', 'projects', 'one.json'), JSON.stringify({ id: 'one', repository: { github: 'owner/one' } }));
    writeFileSync(join(dir, 'registry', 'projects', 'notes.txt'), 'ignored');
    const decl = declaration();
    decl.target = { ...decl.target, repository: 'owner/one' };
    assert.doesNotThrow(() => assertRegisteredTarget(decl, dir));
    assert.throws(() => assertRegisteredTarget(declaration(), dir), /example-org\/sampleapp is not a registered project/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every committed campaign declaration targets a registered project', () => {
  const dir = join(ROOT, 'tests/fixtures/campaigns');
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
    const decl = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    assert.doesNotThrow(() => assertRegisteredTarget(decl, REGISTRY), `${name} targets an unregistered repository`);
  }
});

test('CLI start refuses a new unregistered target but still resumes a stored campaign', { skip: !SQLITE }, () => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-campaign-registry-'));
  // The declaration is merged to main in a runtime checkout (AW-005), so only the registry gate can refuse it.
  const decl = unregistered();
  const runtime = runtimeCheckout({ declarations: { 'unregistered-target.json': decl } });
  const start = (dataDir, file) => runCli(runtime.cli, ['start', file, '--data', dataDir, '--governance', GOVERNANCE]);
  try {
    const file = join(runtime.root, 'campaigns', 'unregistered-target.json');

    const refusedData = join(root, 'refused');
    mkdirSync(refusedData);
    const refused = start(refusedData, file);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not a registered project/);
    const empty = new Store(join(refusedData, 'supervisor.db'));
    try { assert.ok(!empty.campaign(decl.campaignId), 'a refused registration stores nothing'); } finally { empty.close(); }

    // A campaign stored before the rule (or before its project left the registry) keeps resuming.
    const storedData = join(root, 'stored');
    const store = new Store(join(storedData, 'supervisor.db'));
    try { campaignStart(store, decl); } finally { store.close(); }
    const resumed = start(storedData, file);
    assert.equal(resumed.status, 0, resumed.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    runtime.cleanup();
  }
});

// Routing, task role, risk and complexity (MODEL_ROUTING slice R3). They validate; nothing routes on them yet.
const chain = { kind: 'cli-chain', implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1, providers: [
  { kind: 'claude-cli', model: 'opus', permissionMode: 'auto' }, { kind: 'codex-cli' }] };
const routing = () => ({ mode: 'auto', sensitivePaths: ['src/supervisor/'], pin: null, candidates: [
  { kind: 'claude-cli', model: 'haiku', tier: 1 }, { kind: 'claude-cli', model: 'sonnet', tier: 2 },
  { kind: 'claude-cli', model: 'opus', tier: 3 }, { kind: 'codex-cli', model: 'gpt-6-astra', tier: 3 }] });
const routed = (campaignId = 'routed') => ({ ...declaration({ campaignId }), executor: chain, routing: routing() });
const withTask = (decl, extra) => ({ ...decl, tasks: [{ ...decl.tasks[0], ...extra }, decl.tasks[1]] });
const invalid = (decl, pattern) => assert.throws(() => validateDeclaration(decl), pattern);

test('the role catalog is read from the governance checkout: ids, independent_from and the blob digest', () => {
  const catalog = roleCatalog(GOVERNANCE);
  assert.ok(catalog.roles.some((role) => role.id === 'backend-engineer'));
  assert.deepEqual(catalog.roles.find((role) => role.id === 'verification-agent').independentFrom, ['backend-engineer']);
  assert.deepEqual(catalog.roles.find((role) => role.id === 'orchestrator').independentFrom, []);
  const bytes = readFileSync(join(GOVERNANCE, 'registry', 'agents.json'));
  assert.equal(catalog.digest, createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'));
});

test('a declared routing with candidates, sensitive paths and a pin validates', () => {
  assert.doesNotThrow(() => validateDeclaration(routed()));
  const pinned = routed();
  pinned.routing.pin = { implementer: { kind: 'claude-cli', model: 'opus' }, verifier: { tier: 3 } };
  assert.doesNotThrow(() => validateDeclaration(pinned));
  const minimal = routed();
  minimal.routing = { mode: 'auto', candidates: [{ kind: 'claude-cli', model: 'sonnet', tier: 2 }] };
  assert.doesNotThrow(() => validateDeclaration(minimal));
  // A single executor is its own provider list.
  assert.doesNotThrow(() => validateDeclaration({ ...declaration(), routing: { mode: 'auto', candidates: [{ kind: 'claude-cli', model: 'opus', tier: 3 }] } }));
});

test('a candidate kind outside executor.providers is rejected', () => {
  const decl = routed();
  decl.routing.candidates.push({ kind: 'cursor-cli', model: 'any', tier: 1 });
  invalid(decl, /routing\.candidates\[4\]\.kind cursor-cli is not a declared executor provider/);
  invalid({ ...declaration(), routing: routing() }, /codex-cli is not a declared executor provider/);
});

test('a pin outside the candidates is rejected', () => {
  const model = routed();
  model.routing.pin = { implementer: { kind: 'claude-cli', model: 'fable' } };
  invalid(model, /routing\.pin\.implementer claude-cli fable is not a declared candidate/);
  const kind = routed();
  kind.routing.pin = { verifier: { kind: 'codex-cli', model: 'opus' } };
  invalid(kind, /routing\.pin\.verifier codex-cli opus is not a declared candidate/);
  const tier = routed();
  tier.routing.candidates = tier.routing.candidates.filter((candidate) => candidate.tier !== 1);
  tier.routing.pin = { implementer: { tier: 1 } };
  invalid(tier, /routing\.pin\.implementer tier 1 has no declared candidate/);
  const both = routed();
  both.routing.pin = { implementer: { kind: 'claude-cli', model: 'opus', tier: 3 } };
  invalid(both, /must be \{ kind, model \} or \{ tier \}/);
  const stage = routed();
  stage.routing.pin = { coordinator: { tier: 3 } };
  invalid(stage, /routing\.pin must be null/);
});

test('malformed routing is rejected', () => {
  const cases = [
    [(r) => { r.mode = 'manual'; }, /routing\.mode must be "auto"/],
    [(r) => { r.candidates = []; }, /routing\.candidates must contain 1\.\.16/],
    [(r) => { r.candidates[0].tier = 4; }, /tier must be 1, 2 or 3/],
    [(r) => { r.candidates[0].model = ''; }, /model required/],
    [(r) => { r.candidates[0].permissionMode = 'plan'; }, /must be \{ kind, model, tier \}/],
    [(r) => { r.candidates.push({ kind: 'claude-cli', model: 'haiku', tier: 2 }); }, /duplicates claude-cli haiku/],
    [(r) => { r.sensitivePaths = ['../outside/']; }, /sensitivePaths must be/],
    [(r) => { r.sensitivePaths = ['resource:db']; }, /sensitivePaths must be/],
    [(r) => { r.budget = 5; }, /unknown routing key budget/],
  ];
  for (const [change, pattern] of cases) {
    const decl = routed();
    change(decl.routing);
    invalid(decl, pattern);
  }
  invalid({ ...routed(), routing: [] }, /routing must be an object/);
});

test('task role, risk and complexity validate; a declaration can only raise a level', () => {
  assert.doesNotThrow(() => validateDeclaration(withTask(routed(), { role: 'backend-engineer', routing: { risk: 'high', complexity: 'high' } })));
  assert.doesNotThrow(() => validateDeclaration(withTask(declaration(), { routing: { complexity: 'high' } })));
  invalid(withTask(routed(), { role: 'Backend Engineer' }), /tasks\[0\]\.role must be a role id/);
  invalid(withTask(routed(), { role: 7 }), /tasks\[0\]\.role must be a role id/);
  for (const value of [{ risk: 'low' }, { complexity: 'C1' }, {}, { tier: 'high' }, ['high']]) {
    invalid(withTask(routed(), { routing: value }), /tasks\[0\]\.routing must be/);
  }
});

test('an unknown role fails closed at registration; tasks without a role need no catalog', () => {
  assert.doesNotThrow(() => assertRegisteredTarget(withTask(routed(), { role: 'backend-engineer' }), GOVERNANCE));
  assert.throws(() => assertRegisteredTarget(withTask(routed(), { role: 'chief-of-staff' }), GOVERNANCE),
    /task role T1: chief-of-staff is not in the governance checkout's registry\/agents\.json/);
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-catalog-'));
  try {
    mkdirSync(join(dir, 'registry', 'projects'), { recursive: true });
    writeFileSync(join(dir, 'registry', 'projects', 'sampleapp.json'), JSON.stringify({ id: 'sampleapp', repository: { github: 'example-org/sampleapp' } }));
    // No registry/agents.json: a declaration without a role still registers; one with a role is refused.
    assert.doesNotThrow(() => assertRegisteredTarget(routed(), dir));
    const withRole = withTask(routed(), { role: 'backend-engineer' });
    const refused = (error) => error.code === 'ROLE_CATALOG_INVALID';
    assert.throws(() => assertRegisteredTarget(withRole, dir), refused);
    for (const catalog of [{ roles: 'all' }, { roles: [{ id: 'backend-engineer', independent_from: 'x' }] },
      { roles: [{ name: 'backend-engineer' }] }, { roles: [{ id: 'backend-engineer' }, { id: 'backend-engineer' }] }]) {
      writeFileSync(join(dir, 'registry', 'agents.json'), JSON.stringify(catalog));
      assert.throws(() => assertRegisteredTarget(withRole, dir), refused, JSON.stringify(catalog));
    }
    writeFileSync(join(dir, 'registry', 'agents.json'), '{ not json');
    assert.throws(() => assertRegisteredTarget(withRole, dir), refused);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('declarations without the new keys validate and digest exactly as before', () => {
  // Synthetic identities replace installation names. Pins use the frozen pre-routing hash formulas.
  const decl = { version: 1, campaignId: 'digest-pin',
    authorization: { version: 1, grantedBy: 'owner', grantedAt: '2026-10-09', reference: 'https://github.com/netbka/aiworks/issues/2', text: 'Synthetic test authorization.' },
    target: { tenantId: 'example-org', projectId: 'sampleapp', environment: 'research', repository: 'example-org/sampleapp', baseBranch: 'main', trackingIssue: 443 },
    limits: { maxWorkerRuns: 12, slots: 1, maxRepairRounds: 2, maxRetriesPerTask: 2 },
    executor: { kind: 'claude-cli', model: 'opus', permissionMode: 'auto', implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 },
    constraints: ['Synthetic test constraint: no network, no production.'],
    tasks: [
      { id: 'T1', issue: 437, title: 'first task', deliverable: 'commit', goal: 'Produce the first artifact.', dependsOn: [], acceptance: ['artifact exists'], references: ['AGENTS.md'] },
      { id: 'T2', issue: 438, title: 'second task', deliverable: 'commit', goal: 'Produce the second artifact.', dependsOn: ['T1'], acceptance: ['artifact exists'], references: ['AGENTS.md'] },
    ] };
  assert.doesNotThrow(() => validateDeclaration(decl));
  assert.equal(scopeDigest(decl), '8be3e164c24bb4d577c55dfab9ce9ce65629aced4646aa09caf66b12bed8fb7f');
  assert.equal(authorityDigest(decl), '76736ce25f9d949d2c5c2ad679e01c03d4a19ef23d18a6dfc7ad995c887d48aa');
  // Every committed campaign still validates, and its scope digest is the pre-routing formula: nothing routing adds
  // (no default `routing`, no default task `role`) enters the digest of a declaration that does not declare it.
  const before = (d) => createHash('sha256').update(canonicalJson({ ...d, authorization: undefined, limits: undefined, purpose: undefined,
    tasks: d.tasks.map((task) => ({ ...task, outcome: undefined })) }), 'utf8').digest('hex');
  const dir = join(ROOT, 'tests/fixtures/campaigns');
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
    const committed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    assert.doesNotThrow(() => validateDeclaration(structuredClone(committed)), name);
    assert.equal(scopeDigest(committed), before(committed), name);
  }
});

test('amending routing follows the executor rule: refused while running, then versioned, idle and journalled', { skip: !SQLITE }, (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const d = { ...declaration({ campaignId: 'routing-amend' }), executor: chain };
  campaignStart(store, d);
  const amended = { ...d, authorization: { ...d.authorization, version: 2 }, routing: routing() };
  assert.throws(() => campaignStart(store, amended), (error) => error.code === 'ROUTING_HANDOVER_REQUIRED');
  assert.equal(store.campaign(d.campaignId).authorization_version, 1);
  campaignPause(store, d.campaignId);
  store.insert('operations', { id: 'open-op', campaign_id: d.campaignId, task_id: 'T1', kind: 'implement', seq: 1, idempotency_key: 'open-op',
    lease_generation: 1, state: 'dispatched', session_id: 'open-session', run_dir: 'synthetic', workspace: 'synthetic',
    packet: {}, packet_digest: 'synthetic', created_at: 1, updated_at: 1 });
  assert.throws(() => campaignStart(store, amended), /routing amendment requires a paused campaign with no open operations/);
  store.run("UPDATE operations SET state = 'finished' WHERE id = 'open-op'");
  assert.throws(() => campaignStart(store, { ...amended, authorization: d.authorization }), /increase authorization/);
  assert.throws(() => campaignStart(store, { ...amended, constraints: ['different work scope'] }), /immutable scope/);
  const status = campaignStart(store, amended);
  assert.equal(status.scopeDigest, scopeDigest(amended));
  assert.deepEqual(store.campaign(d.campaignId).declaration.routing, amended.routing);
  assert.equal(store.all("SELECT * FROM journal WHERE kind = 'routing-amended'").length, 1);
  assert.equal(store.all("SELECT * FROM journal WHERE kind = 'executor-amended'").length, 0);
  // Removing routing again is an amendment too.
  campaignPause(store, d.campaignId);
  campaignStart(store, { ...amended, authorization: { ...d.authorization, version: 3 }, routing: undefined });
  assert.equal(store.campaign(d.campaignId).declaration.routing, undefined);
  assert.equal(store.all("SELECT * FROM journal WHERE kind = 'routing-amended'").length, 2);
});
