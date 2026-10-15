// Child tasks are admitted inside the approved envelope (docs/design/WORK_ENVELOPE.md sections 6.3, 6.4 and 6.8, slice E3;
// plan STA8). Every widening of the matrix in 6.8 is refused with its code and the index of the operation; one property
// test checks that whatever is admitted lies inside the envelope. The store tests write the chain and show that a child
// is admitted once. Pure functions and disposable stores only; no worker, model, network or GitHub call.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scopeDigest, validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { ACCEPT_TASK, admitAmendment, MAX_CAMPAIGN_TASKS, PLAN_TASK, REFUSALS } from '../../src/supervisor/plan.mjs';
import { domainHolders, domainOf } from '../../src/supervisor/work-ownership.mjs';
import { declaration, SQLITE } from './helpers.mjs';
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { campaignStart } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const { planHead, settleAmendment, specOf, specsOf, verifyChain, amendmentDigest } = SQLITE ? await import('../../src/supervisor/plan.mjs') : {};
// Admission never starts a worker, so these store tests need only node:sqlite, on Windows and on Linux CI alike.
const needsSqlite = SQLITE ? false : 'node:sqlite requires Node >= 22.5';

const BASE = 'a'.repeat(40);
const declaredTask = (id, extra = {}) => ({ id, issue: 512, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`,
  dependsOn: [], acceptance: [`${id} exists`], references: ['AGENTS.md'], writes: ['src/chat/ui/'], ...extra });
/** A child as a planner would propose it: inside the envelope unless a test changes it. */
const child = (id, extra = {}) => ({ id, issue: 512, title: `child ${id}`, deliverable: 'commit', goal: `Child ${id}.`,
  dependsOn: ['T1'], acceptance: [`${id} works`], references: ['AGENTS.md'], writes: [`src/search/${id.toLowerCase()}/`], ...extra });

/** The WORK_ENVELOPE 4.1 example on the synthetic declaration, validated as a registered campaign would be. */
function approved({ envelope = {}, campaignId = 'envelope-campaign', constraints, tasks } = {}) {
  const v1 = declaration({ campaignId, tasks: tasks ?? [declaredTask('T1'), declaredTask('T2', { dependsOn: ['T1'], writes: ['src/search/', 'tests/chat/'] })] });
  return validateDeclaration({
    ...v1, version: 2, ...(constraints ? { constraints } : {}),
    envelope: {
      scopeVersion: 1,
      request: { route: 'issue', reference: 'example-org/sampleapp#512', pinned: { base: BASE, issueUpdatedAt: '2026-10-19T08:00:00Z' } },
      outcome: 'People can search the text of their chats and open the matching message.',
      acceptance: ['Searching a word shows every chat message containing it, newest first'],
      writes: ['src/chat/', 'src/search/', 'tests/chat/'], denyWrites: ['src/chat/migrations/'],
      deliverables: ['commit', 'report'], issues: [512], web: { urls: ['https://sampleapp.example/chat'], resourceOrigins: ['https://fonts.example'] },
      release: { mode: 'review-only' }, planning: 'adaptive', ...envelope,
    },
  });
}

/** Admission of `ops` against the approved declaration with its current plan (no children yet unless given). */
function admit(ops, { decl = approved(), specs, head, stored, ...rest } = {}) {
  return admitAmendment({
    declaration: decl, stored: stored ?? { scopeDigest: scopeDigest(decl), authorizationVersion: decl.authorization.version },
    head: head === undefined ? scopeDigest(decl) : head, specs: specs ?? new Map(decl.tasks.map((task) => [task.id, task])),
    amendment: { basis: head ?? scopeDigest(decl), ops, rationale: 'The work needs this step.' }, ...rest,
  });
}
const add = (task) => ({ op: 'add', task });
/** The refusal code (and index) of one operation, or 'admitted'. */
const verdict = (ops, options) => {
  const result = admit(ops, options);
  return result.admitted ? 'admitted' : result.code;
};

test('an in-scope child is admitted; a refusal names its code, its kind and the first failing operation', () => {
  const result = admit([add(child('C1')), add(child('C2', { dependsOn: ['C1'] }))]);
  assert.equal(result.admitted, true);
  assert.deepEqual(result.ops.map((op) => op.task.id), ['C1', 'C2'], 'a child may depend on one added earlier in the same amendment');
  assert.deepEqual(result.dropped, []);
  const refused = admit([add(child('C1')), add(child('C2', { writes: ['src/billing/'] })), add(child('C3', { writes: ['docs/'] }))]);
  assert.deepEqual({ ...refused, detail: undefined }, { admitted: false, code: 'WIDEN_FILES', kind: 'owner', index: 1, detail: undefined });
  assert.match(refused.detail, /C2 wants to change src\/billing\/, outside the approved files/);
  for (const code of ['WIDEN_FILES', 'WIDEN_CAPABILITY', 'WIDEN_PERMISSION', 'WIDEN_DESTINATION', 'WIDEN_RELEASE', 'WIDEN_LIMITS', 'WIDEN_ACCEPTANCE', 'SCOPE_GROWTH']) {
    assert.equal(REFUSALS[code], 'owner', `${code} goes to the owner, never retried`);
  }
  for (const code of ['NOT_A_PLAN_RESULT', 'STALE_PLAN', 'INVALID_TASK', 'UNSAFE_TEXT']) assert.equal(REFUSALS[code], 'replan', code);
  assert.equal(REFUSALS.DUPLICATE_WORK, 'drop');
});

test('matrix 6.8, files: outside writes, inside denyWrites (case folded), unsafe or secret-like paths, a commit without writes', () => {
  assert.equal(verdict([add(child('C1', { writes: ['src/billing/'] }))]), 'WIDEN_FILES');
  assert.equal(verdict([add(child('C1', { writes: ['SRC/Chat/../billing'] }))]), 'INVALID_TASK', '.. is an unsafe path');
  assert.equal(verdict([add(child('C1', { writes: ['src\\chat\\x'] }))]), 'INVALID_TASK', 'a backslash is an unsafe path');
  assert.equal(verdict([add(child('C1', { writes: ['SRC/Chat/Migrations/0042.sql'] }))]), 'WIDEN_FILES', 'denyWrites is compared case folded');
  assert.equal(verdict([add(child('C1', { writes: ['src/chat/migrations'] }))]), 'WIDEN_FILES', 'the denied prefix itself');
  assert.equal(verdict([add(child('C1', { writes: ['src/chat/'] }))]), 'WIDEN_FILES', 'a prefix that contains a denied one reaches it');
  assert.equal(verdict([add(child('C1', { writes: ['src/'] }))]), 'WIDEN_FILES', 'a wider prefix than the envelope');
  assert.equal(verdict([add(child('C1', { writes: ['src/chatroom/'] }))]), 'WIDEN_FILES', 'a sibling that only shares the text prefix');
  assert.equal(verdict([add(child('C1', { writes: undefined }))]), 'WIDEN_FILES', 'a commit task with no writes owns the whole repository');
  assert.equal(verdict([add(child('C1', { writes: ['.env.local'] }))]), 'WIDEN_FILES');
  assert.equal(verdict([add(child('C1', { writes: ['src/chat/ui/.env.local'] }))]), 'WIDEN_FILES', 'secret-like inside the approved files');
  assert.equal(verdict([add(child('C1', { writes: ['SRC/Chat/UI/'] }))]), 'admitted', 'an approved prefix in another case is the same path');
});

test('matrix 6.8, capabilities: a deliverable, a browser origin or a reference the approval does not allow', () => {
  const commitOnly = approved({ envelope: { deliverables: ['commit'] } });
  const report = (extra = {}) => child('C1', { deliverable: 'report', writes: undefined, ...extra });
  assert.equal(verdict([add(report())], { decl: commitOnly }), 'WIDEN_CAPABILITY');
  assert.equal(verdict([add(report())]), 'admitted');
  assert.equal(verdict([add(report({ web: { urls: ['https://elsewhere.example/'] } }))]), 'WIDEN_CAPABILITY', 'a new page origin');
  assert.equal(verdict([add(report({ web: { urls: ['https://sampleapp.example/search'], resourceOrigins: ['https://cdn.example'] } }))]), 'WIDEN_CAPABILITY', 'a new resource origin');
  assert.equal(verdict([add(report({ web: { urls: ['https://sampleapp.example/search'], resourceOrigins: ['https://fonts.example'] } }))]), 'admitted');
  assert.equal(verdict([add(report({ web: { urls: ['https://sampleapp.example/search'] } }))], { decl: approved({ envelope: { web: null } }) }), 'WIDEN_CAPABILITY', 'no browser at all');
  assert.equal(verdict([add(child('C1', { references: ['AGENTS.md', 'config/secrets.json'] }))]), 'WIDEN_CAPABILITY');
});

test('matrix 6.8, permissions and providers: refused by name, and any key that is not a task key', () => {
  for (const extra of [{ permissionMode: 'bypassPermissions' }, { executor: { kind: 'claude-cli', model: 'opus' } }, { model: 'x' },
    { providers: [] }, { researchOnly: true }, { role: 'release-manager' }, { sandbox: 'off' }]) {
    assert.equal(verdict([add(child('C1', extra))]), 'WIDEN_PERMISSION', JSON.stringify(extra));
  }
  assert.equal(verdict([add(child('C1', { deliverable: 'report', writes: undefined, access: 'write' }))]), 'WIDEN_PERMISSION', 'access: write on a report');
});

test('matrix 6.8, destination: another repository, branch, project or an issue the approval does not list', () => {
  for (const extra of [{ repository: 'example-org/other' }, { baseBranch: 'release' }, { target: { repository: 'example-org/other' } }, { projectId: 'other' }, { environment: 'production' }]) {
    assert.equal(verdict([add(child('C1', extra))]), 'WIDEN_DESTINATION', JSON.stringify(extra));
  }
  assert.equal(verdict([add(child('C1', { issue: 999 }))]), 'WIDEN_DESTINATION');
});

test('matrix 6.8, release mode and limits', () => {
  for (const extra of [{ release: { mode: 'auto-release' } }, { deploy: true }, { merge: true }, { publish: 'pr' }, { apply: true }]) {
    assert.equal(verdict([add(child('C1', extra))]), 'WIDEN_RELEASE', JSON.stringify(extra));
  }
  for (const extra of [{ limits: { maxCostUsd: 1000 } }, { slots: 8 }, { maxWorkerRuns: 100 }]) {
    assert.equal(verdict([add(child('C1', extra))]), 'WIDEN_LIMITS', JSON.stringify(extra));
  }
  // The 129th task: 2 declared, 126 children already admitted (some cancelled), one more.
  const childIds = new Set(Array.from({ length: MAX_CAMPAIGN_TASKS - 2 }, (_, i) => `K${i}`));
  assert.equal(verdict([add(child('C1'))], { childIds }), 'SCOPE_GROWTH');
  assert.equal(verdict([add(child('C1'))], { childIds: new Set([...childIds].slice(1)) }), 'admitted', 'the 128th task still fits');
  assert.equal(verdict([add(child('C1'))], { decl: approved({ envelope: { planning: 'fixed' } }) }), 'SCOPE_GROWTH', 'a fixed plan takes no added step');
});

test('matrix 6.8, acceptance: the closing check and declared tasks are untouchable; a started child cannot be revised', () => {
  const live = (decl = approved()) => new Map([...decl.tasks.map((task) => [task.id, task]), ['C1', child('C1')]]);
  assert.equal(verdict([{ op: 'revise', taskId: ACCEPT_TASK, task: child(ACCEPT_TASK) }]), 'WIDEN_ACCEPTANCE');
  assert.equal(verdict([add(child(ACCEPT_TASK))]), 'WIDEN_ACCEPTANCE');
  assert.equal(verdict([{ op: 'cancel', taskId: 'T1', reason: 'not needed' }]), 'WIDEN_ACCEPTANCE');
  assert.equal(verdict([{ op: 'revise', taskId: 'T2', task: declaredTask('T2', { goal: 'Something else.' }) }]), 'WIDEN_ACCEPTANCE');
  assert.equal(verdict([add(declaredTask('T2'))]), 'WIDEN_ACCEPTANCE', 'adding under a declared id would shadow it');
  const revise = { op: 'revise', taskId: 'C1', task: child('C1', { goal: 'A sharper child.' }) };
  assert.equal(verdict([revise], { specs: live(), started: new Set(['C1']) }), 'INVALID_TASK', 'already implementing');
  assert.equal(verdict([{ op: 'cancel', taskId: 'C1', reason: 'superseded' }], { specs: live(), started: new Set(['C1']) }), 'INVALID_TASK');
  assert.equal(verdict([revise], { specs: live() }), 'admitted', 'a child that has not started may be revised');
  assert.equal(verdict([{ op: 'cancel', taskId: 'C1', reason: 'superseded' }], { specs: live() }), 'admitted');
  // Each child's own acceptance only adds checks for that child: 1 to 16 items.
  assert.equal(verdict([add(child('C1', { acceptance: [] }))]), 'INVALID_TASK');
  assert.equal(verdict([add(child('C1', { acceptance: Array.from({ length: 17 }, (_, i) => `check ${i}`) }))]), 'INVALID_TASK');
});

test('A12 duplicate work: owned elsewhere or repeated here, only that operation is dropped', () => {
  const owned = { campaignId: 'other-campaign', ownerTaskId: 'T9', taskId: 'C2', reason: 'work-key' };
  const result = admit([add(child('C1')), add(child('C2', { workKey: 'search-index' }))], { conflict: (task) => (task.workKey === 'search-index' ? owned : null) });
  assert.equal(result.admitted, true);
  assert.deepEqual(result.ops.map((op) => op.task.id), ['C1']);
  assert.deepEqual(result.dropped.map(({ index, code, kind, taskId }) => ({ index, code, kind, taskId })), [{ index: 1, code: 'DUPLICATE_WORK', kind: 'drop', taskId: 'C2' }]);
  assert.match(result.dropped[0].detail, /owned by other-campaign\/T9/);
  // The same child twice in one proposal, under another id, and the same work as a declared task.
  const twice = admit([add(child('C1')), add({ ...child('C1'), id: 'C9' })]);
  assert.deepEqual([twice.ops.length, twice.dropped[0].code], [1, 'DUPLICATE_WORK']);
  const declaredTwin = admit([add({ ...declaredTask('T1'), id: 'C3' })]);
  assert.deepEqual([declaredTwin.admitted, declaredTwin.code], [false, 'DUPLICATE_WORK'], 'nothing is left to admit');
});

test('A1 stale plans and A0 malformed results', () => {
  const decl = approved();
  const stored = { scopeDigest: scopeDigest(decl), authorizationVersion: 1 };
  assert.equal(admitAmendment({ declaration: decl, stored, head: scopeDigest(decl), specs: new Map(), amendment: { basis: 'f'.repeat(64), ops: [add(child('C1'))] } }).code, 'STALE_PLAN', 'an old basis');
  assert.equal(verdict([add(child('C1'))], { stored: { ...stored, scopeDigest: 'e'.repeat(64) } }), 'STALE_PLAN', 'the envelope digest moved');
  assert.equal(verdict([add(child('C1'))], { stored: { ...stored, authorizationVersion: 2 } }), 'STALE_PLAN', 'a newer authorization');
  assert.equal(verdict([add(child('C1'))], { merged: false }), 'STALE_PLAN', 'unmerged code admits nothing');
  assert.equal(verdict([add(child('C1'))], { head: null }), 'STALE_PLAN', 'a chain that does not verify has no head');
  const v1 = declaration();
  assert.equal(admitAmendment({ declaration: v1, stored, head: scopeDigest(v1), specs: new Map(), amendment: { basis: scopeDigest(v1), ops: [add(child('C1'))] } }).code, 'NOT_A_PLAN_RESULT', 'version 1 has no envelope');
  for (const amendment of [null, 'add C1', { basis: scopeDigest(decl) }, { basis: scopeDigest(decl), ops: [] }, { basis: 'x', ops: [add(child('C1'))] },
    { basis: scopeDigest(decl), ops: Array.from({ length: 17 }, (_, i) => add(child(`C${i}`))) }, { basis: scopeDigest(decl), ops: [add(child('C1'))], extra: 1 }]) {
    assert.equal(admitAmendment({ declaration: decl, stored, head: scopeDigest(decl), specs: new Map(), amendment }).code, 'NOT_A_PLAN_RESULT', JSON.stringify(amendment)?.slice(0, 80));
  }
});

test('A3, A11 and A13: task rules, ids, dependencies, constraints and injected text', () => {
  const cancelled = new Set(['C5']);
  assert.equal(verdict([add(child('C5'))], { retired: cancelled, childIds: cancelled }), 'INVALID_TASK', 'a cancelled id is never reused');
  assert.equal(verdict([add(child(PLAN_TASK))]), 'INVALID_TASK', 'PLAN is reserved');
  assert.equal(verdict([add(child('C1', { dependsOn: ['C5'] }))], { retired: cancelled }), 'INVALID_TASK', 'a cancelled dependency');
  assert.equal(verdict([add(child('C1', { dependsOn: ['ACCEPT'] }))]), 'INVALID_TASK', 'the closing check is no dependency');
  assert.equal(verdict([{ op: 'add', task: child('C1'), extra: 1 }]), 'INVALID_TASK');
  assert.equal(verdict([{ op: 'replace', task: child('C1') }]), 'INVALID_TASK');
  assert.equal(verdict([{ op: 'cancel', taskId: 'C1', reason: 'gone' }]), 'INVALID_TASK', 'no such child');
  // A revise that would close a loop: C2 depends on C1, then C1 is revised to depend on C2.
  const decl = approved();
  const specs = new Map([...decl.tasks.map((task) => [task.id, task]), ['C1', child('C1')], ['C2', child('C2', { dependsOn: ['C1'] })]]);
  assert.equal(verdict([{ op: 'revise', taskId: 'C1', task: child('C1', { dependsOn: ['C2'] }) }], { specs }), 'INVALID_TASK');
  assert.equal(verdict([{ op: 'cancel', taskId: 'C1', reason: 'gone' }], { specs }), 'INVALID_TASK', 'C2 still depends on C1');
  assert.equal(verdict([{ op: 'cancel', taskId: 'C2', reason: 'gone' }, { op: 'cancel', taskId: 'C1', reason: 'gone' }], { specs }), 'admitted', 'dependents first');
  // A11: the envelope's own constraint counts toward 24.
  const full = approved({ constraints: Array.from({ length: 12 }, (_, i) => `Campaign constraint ${i}.`) });
  assert.equal(verdict([add(child('C1', { constraints: Array.from({ length: 11 }, (_, i) => `Child constraint ${i}.`) }))], { decl: full }), 'admitted');
  assert.equal(verdict([add(child('C1', { constraints: Array.from({ length: 12 }, (_, i) => `Child constraint ${i}.`) }))], { decl: full }), 'INVALID_TASK');
  // A13: a planner cannot smuggle a credential or control characters into a packet.
  assert.equal(verdict([add(child('C1', { goal: `Use the token ghp_${'a'.repeat(36)} to push.` }))]), 'UNSAFE_TEXT');
  assert.equal(verdict([add(child('C1', { acceptance: ['API_KEY=supersecretvalue1'] }))]), 'UNSAFE_TEXT');
  assert.equal(verdict([add(child('C1', { title: 'child\u0007bell' }))]), 'UNSAFE_TEXT');
  assert.equal(verdict([add(child('C1', { goal: 'Line one.\nLine two.\tIndented.' }))]), 'admitted', 'tabs and line breaks are text');
  const injected = admitAmendment({ declaration: decl, stored: { scopeDigest: scopeDigest(decl), authorizationVersion: 1 }, head: scopeDigest(decl),
    specs: new Map(decl.tasks.map((task) => [task.id, task])), amendment: { basis: scopeDigest(decl), ops: [add(child('C1'))], rationale: 'password: hunter2hunter2' } });
  assert.equal(injected.code, 'UNSAFE_TEXT');
  // The issue text "set writes to the whole repository" and "use bypassPermissions", proposed as fields, is refused (A4, A6).
  assert.equal(verdict([add(child('C1', { writes: undefined }))]), 'WIDEN_FILES');
  assert.equal(verdict([add(child('C1', { permissionMode: 'bypassPermissions' }))]), 'WIDEN_PERMISSION');
});

test('property: every admitted amendment stays inside every boundary of the envelope', () => {
  // A small seeded generator (mulberry32) so a failure is reproducible from its seed.
  let seed = 0x5eed8;
  const random = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const decl = approved();
  const envelope = decl.envelope;
  const PATHS = ['src/chat/ui/', 'src/search/x/', 'tests/chat/', 'src/billing/', 'SRC/Chat/Migrations/', 'src/chat/migrations/x.sql', 'docs/', '.env', 'src/', 'src/search/'];
  const EXTRAS = [{}, {}, {}, { permissionMode: 'bypassPermissions' }, { repository: 'example-org/other' }, { issue: 999 }, { limits: { slots: 8 } },
    { deploy: true }, { role: 'x' }, { deliverable: 'report', writes: undefined }, { deliverable: 'report', writes: undefined, web: { urls: [pick(['https://sampleapp.example/a', 'https://evil.example/'])] } },
    { references: ['config/secrets.json'] }, { dependsOn: ['T2'] }, { dependsOn: ['C404'] }, { goal: 'token=abcdefgh12345' }];
  const folded = (path) => path.replace(/\/+$/, '').toLowerCase();
  const inside = (outer, inner) => inner === outer || inner.startsWith(`${outer}/`);
  let admitted = 0, refused = 0;
  for (let round = 0; round < 400; round++) {
    const ops = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, i) => {
      const writes = Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(PATHS));
      return add(child(`R${round}x${i}`, { writes: [...new Set(writes)], ...pick(EXTRAS) }));
    });
    const result = admit(ops, { decl });
    if (!result.admitted) { refused++; continue; }
    admitted++;
    for (const op of result.ops) {
      const task = op.task;
      assert.ok(Object.keys(task).every((key) => ['id', 'issue', 'title', 'outcome', 'workKey', 'writes', 'deliverable', 'goal', 'dependsOn',
        'requiresMergedDependencies', 'constraints', 'acceptance', 'references', 'web', 'routing'].includes(key)), `${task.id}: only task keys`);
      assert.ok(envelope.deliverables.includes(task.deliverable));
      assert.ok(envelope.issues.includes(task.issue));
      if (task.deliverable === 'commit') {
        assert.ok(Array.isArray(task.writes), `${task.id} declares writes`);
        for (const path of task.writes.map(folded)) {
          assert.ok(envelope.writes.map(folded).some((prefix) => inside(prefix, path)), `${task.id}: ${path} inside writes`);
          assert.ok(!envelope.denyWrites.map(folded).some((prefix) => inside(prefix, path) || inside(path, prefix)), `${task.id}: ${path} outside denyWrites`);
        }
      }
      for (const url of task.web?.urls ?? []) assert.ok(envelope.web.urls.some((page) => new URL(page).origin === new URL(url).origin));
      assert.ok(!task.references.some((path) => /secret/i.test(path)));
    }
  }
  assert.ok(admitted > 20 && refused > 20, `both outcomes were exercised: ${admitted} admitted, ${refused} refused`);
});

// ---- Store: the chain, idempotency and work ownership (WORK_ENVELOPE 6.4 and 6.7). ----

function opened(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-plan-admission-'));
  const store = new Store(join(root, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  return store;
}
let planSeq = 0;
/** A finished planning operation row, as slice E5 will record one; settleAmendment only reads its identity. */
function planOperation(store, campaignId) {
  const seq = ++planSeq;
  const op = { id: `${campaignId}.${PLAN_TASK}.plan.${seq}`, campaign_id: campaignId, task_id: PLAN_TASK, kind: 'plan', seq,
    idempotency_key: `${campaignId}.${PLAN_TASK}.plan.${seq}`, lease_generation: 1, state: 'finished', session_id: `session-${seq}`,
    run_dir: 'run', workspace: 'workspace', packet: { taskId: PLAN_TASK }, packet_digest: String(seq).padStart(64, '0'), created_at: 1, updated_at: 1 };
  store.insert('operations', op);
  return store.get('SELECT * FROM operations WHERE id = ?', op.id);
}
const settle = (store, campaignId, ops, { operation = planOperation(store, campaignId), basis = planHead(store, campaignId) } = {}) =>
  store.tx(() => settleAmendment(store, { campaign: store.campaign(campaignId), operation, amendment: { basis, ops }, leaseGeneration: 1, now: 10 }));

test('admitted amendments are chained to the envelope digest; children get spec and task rows; nothing is deleted', { skip: needsSqlite }, (t) => {
  const store = opened(t);
  const decl = approved();
  campaignStart(store, decl);
  const envelopeDigest = store.campaign(decl.campaignId).scope_digest;
  assert.equal(planHead(store, decl.campaignId), envelopeDigest, 'with no amendment the head is the envelope digest');

  const first = settle(store, decl.campaignId, [add(child('C1')), add(child('C2', { dependsOn: ['C1'] }))]);
  assert.equal(first.outcome, 'admitted');
  assert.equal(first.seq, 1);
  const row1 = store.get('SELECT * FROM plan_amendments WHERE campaign_id = ? AND seq = 1', decl.campaignId);
  assert.equal(row1.parent_digest, envelopeDigest, 'seq 1 hangs off the envelope digest');
  assert.equal(row1.digest, amendmentDigest({ campaignId: decl.campaignId, seq: 1, parent: envelopeDigest, scopeDigest: envelopeDigest,
    authorizationVersion: 1, sourceOperation: row1.source_operation, sourcePacketDigest: row1.source_packet_digest, ops: row1.ops }));
  assert.equal(planHead(store, decl.campaignId), row1.digest);
  assert.deepEqual(store.tasks(decl.campaignId).map((row) => [row.task_id, row.state, row.ord]), [['T1', 'pending', 0], ['T2', 'pending', 1], ['C1', 'pending', 2], ['C2', 'pending', 3]]);
  assert.deepEqual(specOf(store, decl.campaignId, 'C2'), child('C2', { dependsOn: ['C1'] }));

  const second = settle(store, decl.campaignId, [{ op: 'revise', taskId: 'C2', task: child('C2', { goal: 'A sharper second child.', dependsOn: ['C1'] }) },
    { op: 'cancel', taskId: 'C2', reason: 'superseded by C3' }, add(child('C3'))]);
  assert.equal(second.outcome, 'admitted');
  const row2 = store.get('SELECT * FROM plan_amendments WHERE campaign_id = ? AND seq = 2', decl.campaignId);
  assert.equal(row2.parent_digest, row1.digest, 'each amendment hangs off the one before');
  assert.deepEqual(store.all('SELECT task_id, revision, amendment_seq, cancelled_at FROM task_specs WHERE campaign_id = ? ORDER BY task_id, revision', decl.campaignId)
    .map((row) => [row.task_id, row.revision, row.amendment_seq, row.cancelled_at]),
  [['C1', 1, 1, null], ['C2', 1, 1, null], ['C2', 2, 2, 10], ['C3', 1, 2, null]], 'a revision is a new row; a cancel only marks the live one');
  assert.equal(store.task(decl.campaignId, 'C2').state, 'cancelled');
  assert.deepEqual([...specsOf(store, decl.campaignId).keys()], ['T1', 'T2', 'C1', 'C3']);
  assert.deepEqual(verifyChain(store, decl.campaignId), { ok: true, head: row2.digest });
  // The declaration and its digests never change when children are added (WORK_ENVELOPE 6.1).
  assert.deepEqual(store.campaign(decl.campaignId).declaration, decl);
  assert.equal(store.campaign(decl.campaignId).scope_digest, scopeDigest(decl));
  assert.equal(settle(store, decl.campaignId, [add(child('C2'))]).code, 'INVALID_TASK', 'a cancelled id is never reused');
});

test('the same proposal settled again returns the earlier amendment; the same child from two planning steps is admitted once', { skip: needsSqlite }, (t) => {
  const store = opened(t);
  const decl = approved();
  campaignStart(store, decl);
  const operation = planOperation(store, decl.campaignId);
  const basis = planHead(store, decl.campaignId);
  const ops = [add(child('C1'))];
  const first = settle(store, decl.campaignId, ops, { operation, basis });
  const again = settle(store, decl.campaignId, ops, { operation, basis });
  assert.deepEqual(again, { outcome: 'repeated', seq: first.seq, digest: first.digest }, 'same idempotency key, same amendment');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM plan_amendments').n, 1);
  // A second planning step proposes the same child: by the same id it is refused, under another id it is a duplicate.
  assert.equal(settle(store, decl.campaignId, ops).code, 'INVALID_TASK');
  const renamed = settle(store, decl.campaignId, [add({ ...child('C1'), id: 'C7' })]);
  assert.deepEqual([renamed.outcome, renamed.code], ['refused', 'DUPLICATE_WORK']);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM task_specs').n, 1, 'admitted once');
  assert.equal(store.get("SELECT COUNT(*) AS n FROM tasks WHERE task_id LIKE 'C%'").n, 1);
  // An amendment against the head before C1 is stale.
  assert.equal(settle(store, decl.campaignId, [add(child('C8'))], { basis }).code, 'STALE_PLAN');
  // Not a planning operation of this campaign (A0).
  const implement = { ...planOperation(store, decl.campaignId), kind: 'implement', task_id: 'T1' };
  assert.equal(settle(store, decl.campaignId, [add(child('C9'))], { operation: implement }).code, 'NOT_A_PLAN_RESULT');
  assert.equal(store.tx(() => settleAmendment(store, { campaign: store.campaign(decl.campaignId), operation, amendment: undefined, leaseGeneration: 1, now: 1 })).outcome, 'none');
});

test('DUPLICATE_WORK across campaigns: a child sees declared work elsewhere, and other campaigns see admitted children', { skip: needsSqlite }, (t) => {
  const store = opened(t);
  const decl = approved();
  campaignStart(store, decl);
  const other = declaration({ campaignId: 'other-campaign', tasks: [{ id: 'T9', issue: 600, title: 'index', deliverable: 'commit', goal: 'Build the index.',
    dependsOn: [], acceptance: ['index exists'], references: ['AGENTS.md'], workKey: 'search-index' }] });
  campaignStart(store, other);
  const result = settle(store, decl.campaignId, [add(child('C1')), add(child('C2', { workKey: 'search-index' }))]);
  assert.equal(result.outcome, 'admitted');
  assert.deepEqual(result.dropped.map((drop) => [drop.taskId, drop.code]), [['C2', 'DUPLICATE_WORK']]);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM operations WHERE kind != 'plan'").n, 0, 'no worker run was spent on it');
  // Registration of another campaign finds the admitted child C1 as an owner (work-ownership reads task_specs).
  const third = declaration({ campaignId: 'third-campaign', tasks: [{ ...child('C1'), id: 'X1', dependsOn: [] }] });
  assert.throws(() => campaignStart(store, third), (error) => error.code === 'WORK_ALREADY_ASSIGNED' &&
    error.conflict.campaignId === decl.campaignId && error.conflict.ownerTaskId === 'C1');
  // A child's writes is its write domain, held like a declared task's.
  store.run("UPDATE tasks SET state = 'implemented' WHERE campaign_id = ? AND task_id = 'C1'", decl.campaignId);
  const domain = domainOf(decl, { deliverable: 'commit', writes: ['src/search/c1/deep/'] });
  assert.deepEqual(domainHolders(store, { campaignId: 'someone-else', taskId: 'Z', domain }), [{ campaignId: decl.campaignId, taskId: 'C1', reason: 'unintegrated' }]);
});

test('the chain detects an edited spec row, a removed amendment and a forged digest', { skip: needsSqlite }, (t) => {
  const store = opened(t);
  const decl = approved();
  campaignStart(store, decl);
  settle(store, decl.campaignId, [add(child('C1'))]);
  settle(store, decl.campaignId, [add(child('C2'))]);
  assert.equal(verifyChain(store, decl.campaignId).ok, true);
  const edit = (sql, ...params) => { store.run(sql, ...params); const chain = verifyChain(store, decl.campaignId); return chain; };
  const spec = store.get("SELECT spec FROM task_specs WHERE task_id = 'C1'").spec;
  let chain = edit("UPDATE task_specs SET spec = ? WHERE task_id = 'C1'", { ...spec, writes: ['src/billing/'] });
  assert.match(chain.problem, /child C1 revision 1 is not the spec its amendment admitted/);
  assert.equal(planHead(store, decl.campaignId), null, 'no head: nothing more is admitted on top');
  assert.equal(settle(store, decl.campaignId, [add(child('C3'))], { basis: 'f'.repeat(64) }).code, 'STALE_PLAN');
  edit("UPDATE task_specs SET spec = ? WHERE task_id = 'C1'", spec);
  assert.equal(verifyChain(store, decl.campaignId).ok, true, 'restored');
  const removed = store.get('SELECT * FROM plan_amendments WHERE seq = 1');
  chain = edit('DELETE FROM plan_amendments WHERE seq = 1');
  assert.match(chain.problem, /amendment 1 is missing/);
  store.insert('plan_amendments', removed);
  chain = edit("UPDATE plan_amendments SET digest = ? WHERE seq = 2", 'c'.repeat(64));
  assert.match(chain.problem, /amendment 2 does not match its digest/);
});
