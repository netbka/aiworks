// Version 2 declarations with an `envelope` block validate (docs/design/WORK_ENVELOPE.md section 4, slice E2; plan STA7).
// Every field rule of 4.1, `auto-release` refused until #33, the initial commit tasks inside the envelope's `writes`, and
// version 1 unchanged: every committed declaration keeps its digests. Pure validation plus one disposable store; no model,
// network or GitHub call.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { authorityDigest, scopeDigest, validateDeclaration, validateTask } from '../../src/supervisor/campaign.mjs';
import { declaration, ROOT, skipWithoutSqlite, SQLITE } from './helpers.mjs';
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { campaignStart } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};

const BASE = 'a'.repeat(40);
const commitTask = (id, extra = {}) => ({ id, issue: 512, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`,
  dependsOn: [], acceptance: [`${id} exists`], references: ['AGENTS.md'], writes: ['src/chat/ui/'], ...extra });

/** The example of WORK_ENVELOPE 4.1 on the synthetic test declaration. */
function envelope({ envelope: changes = {}, tasks, ...top } = {}) {
  const v1 = declaration({ tasks: tasks ?? [commitTask('T1'), commitTask('T2', { dependsOn: ['T1'], writes: ['src/search/', 'tests/chat/'] })] });
  return {
    ...v1, version: 2,
    envelope: {
      scopeVersion: 1,
      request: { route: 'issue', reference: 'netbka/Dyk#512', pinned: { base: BASE, issueUpdatedAt: '2026-10-19T08:00:00Z' } },
      outcome: 'People can search the text of their chats and open the matching message.',
      acceptance: ['Searching a word shows every chat message containing it, newest first'],
      writes: ['src/chat/', 'src/search/', 'tests/chat/'],
      denyWrites: ['src/chat/migrations/'],
      deliverables: ['commit', 'report'],
      issues: [512],
      web: null,
      release: { mode: 'review-only' },
      planning: 'adaptive',
      ...changes,
    },
    ...top,
  };
}
const refused = (decl, pattern, label) => assert.throws(() => validateDeclaration(decl), pattern, label);

test('a version 2 declaration with an envelope validates; the envelope belongs to version 2 only', () => {
  const decl = envelope();
  assert.equal(validateDeclaration(decl), decl);
  refused({ ...decl, envelope: undefined }, /version 2 needs an envelope object/);
  refused({ ...declaration(), envelope: decl.envelope }, /unknown key envelope/, 'version 1 keeps refusing the key');
  refused({ ...decl, version: 3 }, /version must be 1, or 2 with an envelope/);
  refused(envelope({ envelope: { extra: true } }), /unknown envelope key extra/);
  // The envelope is part of the immutable scope and of the approval digest (WORK_ENVELOPE 4.4): no new digest function.
  const narrower = envelope({ envelope: { denyWrites: ['src/chat/migrations/', 'tests/chat/fixtures/'] } });
  assert.notEqual(scopeDigest(narrower), scopeDigest(decl));
  assert.notEqual(authorityDigest(narrower), authorityDigest(decl));
  assert.equal(scopeDigest({ ...decl, limits: { maxCostUsd: 40, unknownRunCostUsd: 2 } }), scopeDigest(decl), 'limits stay outside the scope');
});

test('every envelope field rule of WORK_ENVELOPE 4.1', () => {
  const cases = [
    // outcome: 1 to 300 characters
    [{ outcome: '' }, /envelope.outcome/], [{ outcome: 'x'.repeat(301) }, /envelope.outcome/], [{ outcome: undefined }, /envelope.outcome/],
    // acceptance: 1 to 16 items
    [{ acceptance: [] }, /envelope.acceptance/], [{ acceptance: Array(17).fill('check') }, /envelope.acceptance/], [{ acceptance: [''] }, /envelope.acceptance/],
    // writes: safe repository-relative prefixes, nothing secret-like
    [{ writes: undefined }, /envelope.writes/], [{ writes: ['/abs/'] }, /envelope.writes/], [{ writes: ['../up/'] }, /envelope.writes/],
    [{ writes: ['src\\chat\\'] }, /envelope.writes/], [{ writes: ['.env.local'] }, /envelope.writes/], [{ writes: ['config/secrets.json'] }, /envelope.writes/],
    [{ writes: ['src/', 'SRC/'] }, /envelope.writes/], [{ writes: 'src/' }, /envelope.writes/],
    // denyWrites: optional, inside writes
    [{ denyWrites: [] }, /envelope.denyWrites/], [{ denyWrites: ['docs/'] }, /envelope.denyWrites docs must lie inside envelope.writes/],
    // deliverables: commit, report or both
    [{ deliverables: [] }, /envelope.deliverables/], [{ deliverables: ['deploy'] }, /envelope.deliverables/], [{ deliverables: ['commit', 'commit'] }, /envelope.deliverables/],
    // issues: issue numbers, may be empty
    [{ issues: [0] }, /envelope.issues/], [{ issues: [512, 512] }, /envelope.issues/], [{ issues: undefined }, /envelope.issues/],
    // web: today's web rules, or null
    [{ web: undefined }, /envelope.web must be/], [{ web: { urls: [] } }, /envelope.web.urls/],
    [{ web: { urls: ['http://127.0.0.1:4318/'] } }, /envelope.web must not name port 4318/], [{ web: { urls: ['https://a.example/'], extra: 1 } }, /envelope.web must be/],
    // release: review-only only
    [{ release: { mode: 'manual' } }, /envelope.release.mode must be review-only/], [{ release: undefined }, /envelope.release must be/],
    [{ release: { mode: 'review-only', merge: true } }, /envelope.release must be/],
    // planning: adaptive or fixed
    [{ planning: 'auto' }, /envelope.planning/],
    // scopeVersion and supersedes
    [{ scopeVersion: 0 }, /envelope.scopeVersion/], [{ scopeVersion: 2 }, /envelope.supersedes/],
    [{ supersedes: { campaignId: 'older', scopeDigest: 'b'.repeat(64) } }, /envelope.supersedes/, 'supersedes needs scopeVersion above 1'],
    [{ scopeVersion: 2, supersedes: { campaignId: 'test-campaign', scopeDigest: 'b'.repeat(64) } }, /envelope.supersedes/, 'never supersedes itself'],
    [{ scopeVersion: 2, supersedes: { campaignId: 'older', scopeDigest: 'short' } }, /envelope.supersedes/],
    // request: route, reference and pinned revisions, as the draft pinned them
    [{ request: undefined }, /envelope.request must be/], [{ request: { route: 'telegram', reference: 'x', pinned: { base: BASE } } }, /envelope.request.route/],
    [{ request: { route: 'issue', pinned: { base: BASE, issueUpdatedAt: '2026-10-19T08:00:00Z' } } }, /envelope.request.reference/],
    [{ request: { route: 'goal', pinned: { base: 'main' } } }, /envelope.request.pinned.base/],
    [{ request: { route: 'issue', reference: '#512', pinned: { base: BASE } } }, /pinned.issueUpdatedAt is required for route issue/],
    [{ request: { route: 'pr', reference: '#7', pinned: { base: BASE } } }, /pinned.headSha is required for route pr/],
    [{ request: { route: 'plan-file', reference: 'docs/PLAN.md', pinned: { base: BASE, path: '.env', blob: BASE } } }, /pinned.path/],
    [{ request: { route: 'goal', pinned: { base: BASE, headSha: BASE } } }, /pinned.headSha does not belong to route goal/],
    [{ request: { route: 'goal', pinned: { base: BASE }, text: 'x' } }, /envelope.request must be/],
  ];
  for (const [changes, pattern, label] of cases) refused(envelope({ envelope: changes }), pattern, label ?? JSON.stringify(changes));
  // Every accepted shape of the optional and route-dependent fields.
  const report = { ...commitTask('R1'), deliverable: 'report', writes: undefined };
  for (const changes of [
    { denyWrites: undefined }, { issues: [512, 513] }, { planning: 'fixed' },
    { writes: [], deliverables: ['report'], denyWrites: undefined },
    { web: { urls: ['https://a.example/x'], resourceOrigins: ['https://fonts.example'] } },
    { scopeVersion: 2, supersedes: { campaignId: 'older', scopeDigest: 'b'.repeat(64) } },
    { request: { route: 'goal', pinned: { base: BASE } } },
    { request: { route: 'pr', reference: 'netbka/Dyk#7', pinned: { base: BASE, headSha: 'c'.repeat(40) } } },
    { request: { route: 'plan-file', reference: 'docs/PLAN.md', pinned: { base: 'd'.repeat(64), path: 'docs/PLAN.md', blob: 'e'.repeat(40) } } },
  ]) {
    const tasks = changes.deliverables?.length === 1 ? [report] : undefined;
    validateDeclaration(envelope({ envelope: changes, tasks }));
  }
});

test('auto-release is refused with RELEASE_MODE_UNAVAILABLE until the owner decides #33', () => {
  refused(envelope({ envelope: { release: { mode: 'auto-release' } } }), /RELEASE_MODE_UNAVAILABLE/);
  assert.throws(() => validateDeclaration(envelope({ envelope: { release: { mode: 'auto-release' } } })), /#33/);
  validateDeclaration(envelope({ envelope: { release: { mode: 'review-only' } } }));
});

test('initial commit tasks need writes within the envelope; tasks stay inside its capabilities and destinations', () => {
  const tasks = (...list) => envelope({ tasks: list });
  refused(tasks(commitTask('T1', { writes: undefined })), /commit task without writes \(WIDEN_FILES\)/);
  refused(tasks(commitTask('T1', { writes: ['src/billing/'] })), /src\/billing\/ is outside envelope.writes \(WIDEN_FILES\)/);
  refused(tasks(commitTask('T1', { writes: ['src/chatter/'] })), /outside envelope.writes/, 'a sibling that starts with the same letters');
  refused(tasks(commitTask('T1', { writes: ['src/chat/migrations/001.sql'] })), /reaches into envelope.denyWrites \(WIDEN_FILES\)/);
  refused(tasks(commitTask('T1', { writes: ['SRC/Chat/Migrations/'] })), /reaches into envelope.denyWrites/, 'case folded, as on Windows');
  refused(tasks(commitTask('T1', { writes: ['src/'] })), /outside envelope.writes/);
  refused(tasks(commitTask('T1', { writes: ['src/chat/.env.local'] })), /secret-like path \(WIDEN_FILES\)/);
  refused(tasks(commitTask('T1', { writes: ['resource:port-4319'] })), /outside envelope.writes/);
  // Case is folded and a trailing slash dropped before comparing.
  validateDeclaration(tasks(commitTask('T1', { writes: ['SRC/Chat/ui/', 'tests/chat'] })));
  validateDeclaration(envelope({ envelope: { writes: ['src/', 'resource:port-4319'], denyWrites: undefined },
    tasks: [commitTask('T1', { writes: ['src/chat/x.js', 'resource:port-4319'] })] }));
  // A report task writes nothing, so it needs no writes.
  validateDeclaration(tasks({ ...commitTask('R1'), deliverable: 'report', writes: undefined }));

  refused(envelope({ envelope: { deliverables: ['commit'] }, tasks: [{ ...commitTask('R1'), deliverable: 'report', writes: undefined }] }),
    /deliverable report is not in envelope.deliverables \(WIDEN_CAPABILITY\)/);
  refused(tasks(commitTask('T1', { references: ['AGENTS.md', 'config/secrets.json'] })), /secret-like path \(WIDEN_CAPABILITY\)/);
  const web = (taskWeb, envelopeWeb = { urls: ['https://a.example/x'], resourceOrigins: ['https://fonts.example'] }) => envelope({
    envelope: { web: envelopeWeb }, executor: { kind: 'claude-cli', model: 'opus', permissionMode: 'auto', implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 },
    tasks: [{ ...commitTask('W1'), deliverable: 'report', writes: undefined, web: taskWeb }] });
  validateDeclaration(web({ urls: ['https://a.example/other'], resourceOrigins: ['https://fonts.example', 'https://a.example'] }));
  refused(web({ urls: ['https://b.example/'] }), /web reaches an origin outside envelope.web \(WIDEN_CAPABILITY\)/);
  refused(web({ urls: ['https://a.example/'], resourceOrigins: ['https://cdn.example'] }), /outside envelope.web/);
  refused(web({ urls: ['https://a.example/'] }, null), /outside envelope.web/, 'no browser step without envelope.web');

  refused(tasks(commitTask('T1', { issue: 999 })), /issue 999 is not in envelope.issues \(WIDEN_DESTINATION\)/);
  for (const id of ['ACCEPT', 'PLAN']) refused(tasks(commitTask(id)), new RegExp(`${id} is reserved for the envelope`));
  // The envelope adds one constraint to every packet, inside today's limit of 24.
  const twelve = Array.from({ length: 12 }, (_, i) => `campaign constraint ${i}`);
  validateDeclaration(envelope({ constraints: twelve, tasks: [commitTask('T1', { constraints: twelve.slice(0, 11) })] }));
  refused(envelope({ constraints: twelve, tasks: [commitTask('T1', { constraints: twelve })] }), /campaign \+ task \+ envelope constraints exceed 24/);
});

test('a project without GitHub cannot start through an envelope while local admission is not built', () => {
  refused(envelope({ target: { ...declaration().target, source: 'folder' } }), /LOCAL_START_OFF/);
  refused(envelope({ authorization: { ...declaration().authorization, reference: 'aiworks-local:approval-1' } }), /LOCAL_START_OFF/);
});

test('validateTask is the per-task rule set of every version, extracted unchanged', () => {
  const errors = [];
  const bad = (message) => errors.push(message);
  const seen = new Set(['T0']);
  validateTask(commitTask('T1', { dependsOn: ['T0'] }), 'tasks[1]', { seen, constraints: ['c'], bad });
  assert.deepEqual(errors, []);
  assert.ok(seen.has('T1'), 'a valid task is recorded for later dependencies');
  validateTask({ id: 'T1', deliverable: 'deploy', issue: 0, title: '', goal: '', dependsOn: ['T9'], acceptance: [], references: ['/x'], web: { urls: [], extra: 1 }, extra: 1 },
    'tasks[2]', { seen, constraints: ['c'], bad });
  assert.deepEqual(errors, [
    'tasks[2] unknown key extra', 'tasks[2].deliverable must be commit or report', 'tasks[2].id duplicate T1', 'tasks[2].issue must be an issue number',
    'tasks[2].title required', 'tasks[2].goal required (max 1500)', 'tasks[2].dependsOn T9 must name an earlier task', 'tasks[2].acceptance must be 1..16 strings',
    'tasks[2].references must be 1..24 repository-relative paths', 'tasks[2].web must be { urls, resourceOrigins? }', 'tasks[2].web requires deliverable report']);
});

// The digest functions as they stood before version 2, frozen here: a committed version 1 declaration must keep both values.
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object'
  ? `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const frozen = (value) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const frozenScope = (d) => frozen({ ...d, authorization: undefined, limits: undefined, purpose: undefined,
  tasks: d.tasks.map((task) => ({ ...task, outcome: undefined })) });

test('version 1 digests of every committed campaigns/*.json are unchanged', () => {
  // Values computed on the task base c49b91f, before this change, for the synthetic declaration every supervisor test uses.
  assert.equal(scopeDigest(declaration()), '409bb2f8dbf2451ef4f80dddf4d8d509b3ee1412bc0eace3f0896919315c4d75');
  assert.equal(authorityDigest(declaration()), '3c2dc9a98d7398440a433b2a417a0bd4eadc342d9616204d43139f7a0d38d37a');
  const names = readdirSync(join(ROOT, 'campaigns')).filter((name) => name.endsWith('.json'));
  assert.ok(names.length > 0);
  for (const name of names) {
    const raw = readFileSync(join(ROOT, 'campaigns', name), 'utf8');
    const decl = JSON.parse(raw);
    if (decl.version !== 1) continue;
    assert.equal(decl.envelope, undefined, name);
    validateDeclaration(decl);
    assert.deepEqual(decl, JSON.parse(raw), `${name}: validation changes nothing`);
    assert.equal(scopeDigest(decl), frozenScope(decl), `${name} scopeDigest`);
    assert.equal(authorityDigest(decl), frozen(decl), `${name} authorityDigest`);
  }
});

test('a version 2 declaration registers through the existing start, and its envelope is immutable', { skip: skipWithoutSqlite }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-envelope-'));
  const store = new Store(join(root, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const decl = envelope();
  campaignStart(store, decl);
  const stored = store.campaign(decl.campaignId);
  assert.equal(stored.scope_digest, scopeDigest(decl));
  assert.deepEqual(stored.declaration.envelope, decl.envelope);
  assert.deepEqual(store.all('SELECT task_id FROM tasks WHERE campaign_id = ? ORDER BY ord', decl.campaignId).map((row) => row.task_id), ['T1', 'T2']);
  campaignStart(store, decl);
  assert.throws(() => campaignStart(store, envelope({ envelope: { writes: [...decl.envelope.writes, 'docs/'] },
    authorization: { ...decl.authorization, version: 2 } })), (error) => error.code === 'SCOPE_CONFLICT');
  assert.throws(() => campaignStart(store, envelope({ campaignId: 'auto', envelope: { release: { mode: 'auto-release' } } })), /RELEASE_MODE_UNAVAILABLE/);
  assert.equal(store.campaign('auto'), null, 'a refused declaration stores nothing');
});
