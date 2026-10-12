// Worker packets carry the target project's own governance (inherited policy IDs, declared authority
// pointers, declared exception and gap IDs and rules), resolved from the governance root's registry exactly as the registration
// gate matches. Never another project's, never a default; earlier packets, digests and resumes are unchanged.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { packetDigest } from '../../scripts/lib/worker-context.mjs';
import * as workerContext from '../../scripts/lib/worker-context.mjs';
import { buildPrompt } from '../../src/supervisor/adapters/claude.mjs';
import { campaignPause, campaignRecheck, campaignStart } from '../../src/supervisor/api.mjs';
import * as campaign from '../../src/supervisor/campaign.mjs';
import { declaration, environment, GOVERNANCE, ROOT, runCli, runtimeCheckout, runUntil, skipWithoutSqlite, SQLITE } from './helpers.mjs';
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};

const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
// Governance files come from the fixture governance root (a small stand-in for an Engineering Platform checkout).
const readGov = (path) => JSON.parse(readFileSync(join(GOVERNANCE, path), 'utf8'));
const POLICY = read('registry/worker-context-policy.json');
const registry = (id) => readGov(`registry/projects/${id}.json`);
const catalogPolicies = readGov('policies/catalog.json').policies.map(readGov);
// Every repository pointer a registry governance block declares: the shape Engineering Platform's registry uses.
const governancePointers = (governance) => [
  ...(governance?.authorities ?? []).map((item) => [`authority ${item.role}`, item.path]),
  ...(governance?.ownerReserved ?? []).map((item) => [`owner-reserved ${item.id}`, item.source]),
  ...(governance?.stricter ?? []).map((item) => [`stricter ${item.rule}`, item.source]),
  ...(governance?.exceptions ?? []).map((item) => [`exception ${item.id}`, item.source]),
  ...(governance?.gaps ?? []).map((item) => [`gap ${item.id}`, item.source]),
  ...(governance?.releaseAuthorization ? [['release authorization', governance.releaseAuthorization.source]] : []),
];
const catalogIds = catalogPolicies.map((policy) => policy.id);
const uiOnlyIds = catalogPolicies.filter((policy) => policy.applies_when.boundaries?.every((boundary) => boundary === 'ui')).map((policy) => policy.id);
const COMMITTED = readdirSync(join(ROOT, 'campaigns')).filter((name) => name.endsWith('.json')).sort();
const PROSE = ['summary', 'source', 'approval', 'reviewBy', 'request', 'notes', 'retiresWhen'];

/** A disposable governance root with the fixture policy catalog and schema and the given registry files. */
function governanceRoot(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-governance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'registry', 'projects'), { recursive: true });
  cpSync(join(GOVERNANCE, 'policies'), join(root, 'policies'), { recursive: true });
  cpSync(join(GOVERNANCE, 'schemas'), join(root, 'schemas'), { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(root, 'registry', 'projects', name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

test('Dyk resolves to its own policy IDs and declared authority pointers, as values only', () => {
  const governance = campaign.projectGovernance('netbka/Dyk', GOVERNANCE);
  assert.equal(governance.project, 'dyk');
  assert.deepEqual(governance.policies, catalogIds, 'a ui project inherits every portfolio policy in catalog order');
  assert.ok(governance.policies.includes('UX-001') && governance.policies.includes('VERIFY-001'));
  assert.deepEqual(governance.authorities, registry('dyk').governance.authorities);
  assert.ok(governance.authorities.some((item) => item.role === 'ui-authority' && item.path === 'storybook/review-manifest.json'));
  assert.deepEqual(governance.exceptions, []);
  assert.deepEqual(governance.gaps, []);
  for (const key of PROSE) assert.ok(!JSON.stringify(governance).includes(`"${key}"`), `no ${key} reaches a packet`);
  assert.deepEqual(campaign.projectGovernance('NETBKA/dyk', GOVERNANCE), governance, 'matched ignoring case, like the registration gate');
});

test('declared exceptions and gaps travel as id and rule only', () => {
  const wiki = campaign.projectGovernance('netbka/elma_wiki', GOVERNANCE);
  assert.equal(wiki.project, 'elma-wiki');
  assert.deepEqual(wiki.exceptions, [{ id: 'prod-ssh-password', rule: 'constitution#7' }]);
  assert.deepEqual(wiki.gaps, [{ id: 'prod-root-credential', rule: 'baseline:credential-boundaries' }]);
  const commander = campaign.projectGovernance('netbka/local-commander-mcp', GOVERNANCE);
  assert.deepEqual(commander.gaps, registry('local-commander').governance.gaps.map(({ id, rule }) => ({ id, rule })));
  for (const key of PROSE) assert.ok(!JSON.stringify([wiki, commander]).includes(`"${key}"`), `no ${key} reaches a packet`);
});

test('a project without the ui capability does not inherit ui-only policies; a contract without governance declares nothing', () => {
  assert.ok(uiOnlyIds.length > 0, 'the catalog has ui-only policies to rule out');
  assert.ok(!registry('otp').capabilities.includes('ui') && !registry('otp').governance);
  const otp = campaign.projectGovernance('netbka/OTP', GOVERNANCE);
  assert.deepEqual(otp.policies, catalogIds.filter((id) => !uiOnlyIds.includes(id)));
  assert.deepEqual([otp.authorities, otp.exceptions, otp.gaps], [[], [], []]);
});

test('an unregistered, ambiguous or unreadable registry fails closed; there is no default project', (t) => {
  assert.throws(() => campaign.projectGovernance('netbka/not-a-registered-project', GOVERNANCE), /netbka\/not-a-registered-project is not a registered project/);
  assert.throws(() => campaign.projectGovernance('', GOVERNANCE), /is not a registered project/);
  const twice = governanceRoot(t, { 'dyk.json': registry('dyk'), 'dyk-copy.json': { ...registry('dyk'), id: 'dyk-copy' } });
  assert.throws(() => campaign.projectGovernance('netbka/Dyk', twice), /matches 2 registry entries \((dyk, dyk-copy|dyk-copy, dyk)\); refusing to choose one/);
  const broken = governanceRoot(t, { 'dyk.json': '{ not json' });
  assert.throws(() => campaign.projectGovernance('netbka/Dyk', broken), SyntaxError);
  const escaping = registry('dyk');
  escaping.governance.authorities = [{ role: 'agent-contract', path: '../another-repository/AGENTS.md' }];
  assert.throws(() => campaign.projectGovernance('netbka/Dyk', governanceRoot(t, { 'dyk.json': escaping })), /cannot carry|does not satisfy/);
  const noCatalog = governanceRoot(t, { 'dyk.json': registry('dyk') });
  rmSync(join(noCatalog, 'policies'), { recursive: true });
  assert.throws(() => campaign.projectGovernance('netbka/Dyk', noCatalog), /ENOENT/);
});

/** Dyk's registry entry with its runtime-state authority pointed at `path`. */
const dykWithAuthority = (path) => {
  const entry = registry('dyk');
  entry.governance.authorities = entry.governance.authorities.map((item) => item.role === 'runtime-state' ? { ...item, path } : item);
  return entry;
};

test('a secret-like authority path is refused when the project is resolved, so no worker is told to read it', (t) => {
  for (const path of ['.env', 'deploy/.env.production', '.git/config', 'secrets/prod.pem', '.ssh/id_ed25519', 'certs/release.keystore']) {
    assert.throws(() => campaign.projectGovernance('netbka/Dyk', governanceRoot(t, { 'dyk.json': dykWithAuthority(path) })),
      /does not satisfy schemas\/project-contract\.schema\.json: \/governance\/authorities\/\d+\/path must NOT be valid/, path);
  }
  assert.equal(campaign.projectGovernance('netbka/Dyk', governanceRoot(t, { 'dyk.json': dykWithAuthority('docs/ENVIRONMENT.md') }))
    .authorities.find((item) => item.role === 'runtime-state').path, 'docs/ENVIRONMENT.md', 'an ordinary document is still carried');
});

test('a malformed governance list fails closed; an absent one is an empty list, as the registry schema allows', (t) => {
  for (const [field, value] of [['authorities', 'AGENTS.md'], ['exceptions', { id: 'prod-ssh-password', rule: 'constitution#7' }], ['gaps', null], ['gaps', 7]]) {
    const entry = registry('elma-wiki');
    entry.governance[field] = value;
    assert.throws(() => campaign.projectGovernance('netbka/elma_wiki', governanceRoot(t, { 'elma-wiki.json': entry })),
      new RegExp(`/governance/${field} must be array`), `${field}: ${JSON.stringify(value)}`);
  }
  const capabilities = registry('dyk');
  capabilities.capabilities = 'ui';
  assert.throws(() => campaign.projectGovernance('netbka/Dyk', governanceRoot(t, { 'dyk.json': capabilities })), /\/capabilities must be array/);
  const absent = registry('elma-wiki');
  for (const field of ['authorities', 'exceptions', 'gaps']) delete absent.governance[field];
  const resolved = campaign.projectGovernance('netbka/elma_wiki', governanceRoot(t, { 'elma-wiki.json': absent }));
  assert.deepEqual([resolved.authorities, resolved.exceptions, resolved.gaps], [[], [], []]);
  const implicit = registry('dyk');
  delete implicit.governance;
  assert.deepEqual(campaign.projectGovernance('netbka/Dyk', governanceRoot(t, { 'dyk.json': implicit })).authorities, []);
});

test('the registry schema refuses a secret-like path in every pointer field, and no committed pointer is one', () => {
  const validate = new Ajv2020({ allErrors: true }).compile(readGov('schemas/project-contract.schema.json'));
  const secretLike = new RegExp(workerContext.SECRET_LIKE_PATH_PATTERN, 'u');
  for (const name of readdirSync(join(GOVERNANCE, 'registry', 'projects')).filter((file) => file.endsWith('.json'))) {
    const entry = readGov(`registry/projects/${name}`);
    assert.equal(validate(entry), true, `${name}: ${JSON.stringify(validate.errors)}`);
    for (const [label, path] of governancePointers(entry.governance)) assert.ok(!secretLike.test(path), `${name} ${label}: ${path}`);
  }
  for (const [id, change, where] of [
    ['dyk', (g) => { g.authorities[0].path = '.env'; }, '/governance/authorities/0/path'],
    ['dyk', (g) => { g.ownerReserved[0].source = '.git/config'; }, '/governance/ownerReserved/0/source'],
    ['dyk', (g) => { g.stricter[0].source = 'secrets/prod.pem'; }, '/governance/stricter/0/source'],
    ['dyk', (g) => { g.releaseAuthorization.source = 'deploy/.env.production'; }, '/governance/releaseAuthorization/source'],
    ['elma-wiki', (g) => { g.exceptions[0].source = '.ssh/id_rsa'; }, '/governance/exceptions/0/source'],
    ['elma-wiki', (g) => { g.gaps[0].source = 'certs/server.key'; }, '/governance/gaps/0/source'],
  ]) {
    const entry = registry(id);
    change(entry.governance);
    assert.equal(validate(entry), false, where);
    assert.ok(validate.errors.some((error) => error.keyword === 'not' && error.instancePath === where), `${where}: ${JSON.stringify(validate.errors)}`);
  }
});

/** Register a one-task campaign and let one tick record its first operation without launching a model. */
async function dispatchOnce(t, decl, options = {}) {
  const env = environment();
  env.config.repositories[decl.target.repository] = env.config.repositories['netbka/Dyk'];
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  campaignStart(store, decl);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null, ...options });
  controller.launch = async () => {}; // the durable record and prompt are what is under test
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  await controller.tick();
  return { env, store, controller, id: decl.campaignId, op: store.get('SELECT * FROM operations WHERE campaign_id = ?', decl.campaignId) };
}
const oneTask = (campaignId, target = {}) => {
  const decl = declaration({ tasks: [declaration().tasks[0]], campaignId });
  decl.target = { ...decl.target, ...target };
  return decl;
};

test('a Dyk campaign packet carries Dyk\'s policy IDs and authority pointers, and the prompt routes to them', { skip: skipWithoutSqlite }, async (t) => {
  const { op } = await dispatchOnce(t, oneTask('dyk-packet'));
  assert.ok(op, 'a worker operation was recorded');
  assert.deepEqual(op.packet.governance, campaign.projectGovernance('netbka/Dyk', GOVERNANCE));
  assert.equal(op.packet.governance.project, 'dyk');
  assert.deepEqual(op.packet.governance.authorities, registry('dyk').governance.authorities);
  assert.equal(op.packet_digest, packetDigest(op.packet, POLICY), 'the recorded digest binds the governance block');
  const prompt = readFileSync(join(op.run_dir, 'prompt.txt'), 'utf8');
  assert.match(prompt, /registered project "dyk" \(netbka\/Dyk\)/);
  assert.match(prompt, /Read the authorities that bear on your task in this checkout/);
  assert.match(prompt, /Do not take project rules or files from any other project's repository; the portfolio policies listed in packet\.governance\.policies are inherited and apply here\./);
  assert.doesNotMatch(prompt, /do not take rules or files from another project's repository/, 'inherited portfolio policies are not "another project\'s rules"');
  assert.ok(prompt.includes('"path": "storybook/review-manifest.json"') && prompt.includes('"UX-001"'));
});

test('an engineering-platform campaign packet carries the platform\'s governance and no Dyk path', { skip: skipWithoutSqlite }, async (t) => {
  const { op } = await dispatchOnce(t, oneTask('platform-packet', { projectId: 'engineering-platform', repository: 'netbka/engineering-platform', trackingIssue: 13 }));
  const governance = op.packet.governance;
  assert.equal(governance.project, 'engineering-platform');
  assert.deepEqual(governance.authorities, registry('engineering-platform').governance.authorities);
  assert.deepEqual(governance.policies, campaign.projectGovernance('netbka/engineering-platform', GOVERNANCE).policies);
  const prompt = readFileSync(join(op.run_dir, 'prompt.txt'), 'utf8');
  const platformPaths = governance.authorities.map((item) => item.path);
  const dykOnly = registry('dyk').governance.authorities.map((item) => item.path).filter((path) => !platformPaths.includes(path));
  assert.ok(dykOnly.length >= 5, 'Dyk declares authorities the platform does not');
  for (const path of dykOnly) assert.ok(!JSON.stringify(op.packet).includes(path) && !prompt.includes(path), `no Dyk path ${path}`);
  assert.doesNotMatch(JSON.stringify(op.packet), /dyk/i);
  assert.doesNotMatch(prompt, /dyk/i, 'nothing Dyk-specific reaches a platform worker');
  assert.match(prompt, /registered project "engineering-platform" \(netbka\/engineering-platform\)/);
});

test('an unregistered target blocks new dispatch with a clear B2 blocker and never falls back', { skip: skipWithoutSqlite }, async (t) => {
  // Registered before the gate (or its registry entry was removed later): the store keeps it, dispatch refuses it.
  const decl = oneTask('unregistered-dispatch', { projectId: 'nowhere', repository: 'netbka/not-a-registered-project' });
  const { env, store, controller, id, op } = await dispatchOnce(t, decl);
  controller.launch = async () => { throw new Error('no worker may launch for an unregistered target'); };
  assert.equal(op, null, 'no operation was recorded');
  const blocked = store.campaign(id);
  assert.equal(blocked.blocker?.kind, 'project-governance');
  assert.equal(blocked.blocker.class, 'B2');
  assert.match(blocked.blocker.reason, /No new worker dispatched: the governance of netbka\/not-a-registered-project cannot be resolved/);
  assert.match(blocked.blocker.reason, /is not a registered project/);
  assert.match(blocked.blocker.requestedAction, /registry\/projects entry declares repository\.github netbka\/not-a-registered-project/);
  assert.equal(blocked.status, 'blocked-owner-action');
  assert.equal(blocked.runs_used, 0);
  assert.equal(existsSync(env.config.repositories[decl.target.repository].worktreeRoot), false, 'no workspace was prepared');
  assert.ok(store.all('SELECT body FROM outbox WHERE campaign_id = ?', id).some((row) => /not a registered project/.test(row.body)), 'the owner is told');
  campaignRecheck(store, id);
  await controller.tick();
  assert.equal(store.all('SELECT id FROM operations WHERE campaign_id = ?', id).length, 0, 'a recheck re-evaluates and stays closed');
  assert.equal(store.campaign(id).blocker?.kind, 'project-governance');
});

test('an ambiguous registry entry blocks dispatch instead of choosing one', { skip: skipWithoutSqlite }, async (t) => {
  const root = governanceRoot(t, { 'dyk.json': registry('dyk'), 'dyk-copy.json': { ...registry('dyk'), id: 'dyk-copy' } });
  const { store, id, op } = await dispatchOnce(t, oneTask('ambiguous-dispatch'), { governanceRoot: root });
  assert.equal(op, null);
  assert.match(store.campaign(id).blocker?.reason ?? '', /refusing to choose one/);
});

test('a malformed list or a secret-like authority blocks dispatch with the B2 project-governance blocker', { skip: skipWithoutSqlite }, async (t) => {
  const malformed = registry('dyk');
  malformed.governance.authorities = { role: 'agent-contract', path: 'AGENTS.md' };
  const secret = dykWithAuthority('.env');
  for (const [name, entry, reason] of [['malformed-dispatch', malformed, /\/governance\/authorities must be array/],
    ['secret-dispatch', secret, /\/governance\/authorities\/\d+\/path must NOT be valid/]]) {
    const { store, id, op } = await dispatchOnce(t, oneTask(name), { governanceRoot: governanceRoot(t, { 'dyk.json': entry }) });
    assert.equal(op, null, `${name}: no worker dispatched`);
    const { blocker, runs_used: runs } = store.campaign(id);
    assert.equal(blocker?.kind, 'project-governance', name);
    assert.equal(blocker.class, 'B2');
    assert.match(blocker.reason, reason);
    assert.equal(runs, 0);
  }
});

test('an operation recorded before the upgrade keeps its packet; only new operations carry governance', { skip: skipWithoutSqlite }, async (t) => {
  const decl = oneTask('in-flight-legacy');
  const id = decl.campaignId;
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  let after = null;
  t.after(() => { after?.release(); store.close(); env.cleanup(); });
  campaignStart(store, decl);
  // The controller before the upgrade recorded an implement operation, then stopped before its launch.
  const before = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  before.launch = async () => {};
  await before.tick();
  before.release();
  const recorded = store.get('SELECT * FROM operations WHERE campaign_id = ?', id);
  const legacy = { ...recorded.packet };
  delete legacy.governance; // the packet shape before packets carried governance
  const legacyDigest = packetDigest(legacy, POLICY);
  const spec = decl.tasks[0];
  writeFileSync(join(recorded.run_dir, 'prompt.txt'), buildPrompt({ role: 'implementer', deliverable: 'commit', packet: legacy,
    packetDigest: legacyDigest, repository: decl.target.repository, issue: spec.issue, branch: `campaign/${id}/${spec.id}`,
    baseSha: recorded.base_sha, targetSha: null }), 'utf8');
  store.run('UPDATE operations SET packet = ?, packet_digest = ? WHERE id = ?', JSON.stringify(legacy), legacyDigest, recorded.id);
  const promptDigest = createHash('sha256').update(readFileSync(join(recorded.run_dir, 'prompt.txt'))).digest('hex');

  // The upgraded controller adopts the recorded operation as it is, then verifies and publishes.
  after = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  await runUntil(after, store, id, () => store.task(id, spec.id)?.state === 'done');
  const implement = store.get('SELECT * FROM operations WHERE id = ?', recorded.id);
  assert.deepEqual(implement.packet, legacy, 'the in-flight packet is not rebuilt');
  assert.equal(implement.packet_digest, legacyDigest);
  assert.equal(createHash('sha256').update(readFileSync(join(recorded.run_dir, 'prompt.txt'))).digest('hex'), promptDigest, 'its prompt is not rewritten');
  assert.equal(implement.outcome.class, 'result', 'the legacy run passes the same lease and verification checks');
  const verify = store.get("SELECT * FROM operations WHERE campaign_id = ? AND kind = 'verify'", id);
  assert.deepEqual(verify.packet.governance, campaign.projectGovernance('netbka/Dyk', GOVERNANCE), 'the next operation carries the project governance');
  assert.equal(verify.packet_digest, packetDigest(verify.packet, POLICY));
  assert.equal(verify.packet.authorityDigest, implement.packet.authorityDigest, 'the authority digest is the same for both');
  assert.equal(verify.outcome.class, 'result');
});

// The digest formulas as they were before packets carried governance, frozen here: committed declarations keep exactly these digests,
// so a resumed campaign's stored scope digest and every recorded packet's authority digest still match.
const frozenCanonical = (value) => Array.isArray(value) ? `[${value.map(frozenCanonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${frozenCanonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const frozenSha = (value) => createHash('sha256').update(frozenCanonical(value), 'utf8').digest('hex');
const frozenScope = (d) => frozenSha({ ...d, authorization: undefined, limits: undefined, purpose: undefined,
  tasks: d.tasks.map((task) => ({ ...task, outcome: undefined })) });

test('the scope and authority digests of every committed declaration are unchanged', () => {
  assert.ok(COMMITTED.includes('dyk-457-connections.json') && COMMITTED.includes('ep-13-owner-intervention-core.json'), 'the live campaigns are covered');
  for (const name of COMMITTED) {
    const decl = read(`campaigns/${name}`);
    assert.equal(campaign.scopeDigest(decl), frozenScope(decl), `${name} scope digest`);
    assert.equal(campaign.authorityDigest(decl), frozenSha(decl), `${name} authority digest`);
  }
});

test('an identical resume of every committed declaration is accepted, in process and through cli.mjs start', { skip: !SQLITE }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-resume-'));
  // The deploy runs the runtime checkout's own CLI on its own campaigns/ files, at a revision merged into main (AW-005).
  const runtime = runtimeCheckout();
  t.after(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); runtime.cleanup(); });
  for (const name of COMMITTED) {
    const data = join(dir, name.replace(/\.json$/, ''));
    const store = new Store(join(data, 'supervisor.db'));
    let scope;
    try {
      const decl = read(`campaigns/${name}`);
      campaignStart(store, decl);
      scope = store.campaign(decl.campaignId).scope_digest;
      assert.doesNotThrow(() => campaignStart(store, read(`campaigns/${name}`)), `${name}: identical start while registered`);
      campaignPause(store, decl.campaignId, 'upgrade');
    } finally { store.close(); }
    // The upgrade procedure: pause, stop, deploy, then `cli.mjs start <file>` with the identical declaration.
    const resumed = runCli(runtime.cli, ['start', join(runtime.root, 'campaigns', name), '--data', data]);
    assert.equal(resumed.status, 0, `${name}: ${resumed.stderr}`);
    const status = JSON.parse(resumed.stdout);
    assert.equal(status.control, 'registered', `${name} resumed`);
    assert.equal(status.scopeDigest, scope, `${name} keeps its stored scope digest`);
  }
});
