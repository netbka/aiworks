// Children run with their own packet binding, checked again before every dispatch (docs/design/WORK_ENVELOPE.md section
// 6.5, slice E4; plan STA9). A child's packet binds to the approval and the amendment that set its live revision and
// carries the approved outcome as a constraint; a declared task's packet is byte-identical to before. An edited spec row,
// a removed amendment or a rewritten chain raises B2 plan-integrity and dispatches nothing. Children keep the write-domain
// check and the merged-dependency wait of declared tasks. The test plays the planner (settleAmendment) and the implementer
// (applyOutcome); launch is stubbed, so no worker, model, network or GitHub call, and no Windows containment is needed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acceptsLease } from '../../scripts/lib/worker-context.mjs';
import { authorityDigest, canonicalJson, validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { declaration, environment, SQLITE } from './helpers.mjs';
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { campaignStart } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const { PLAN_TASK, amendmentDigest, planHead, settleAmendment, specDigest, verifyChain } = SQLITE ? await import('../../src/supervisor/plan.mjs') : {};
const needsSqlite = SQLITE ? false : 'node:sqlite requires Node >= 22.5';

const CAMPAIGN = 'plan-dispatch';
const OUTCOME = 'People can search the text of their chats.';
const ENVELOPE_CONSTRAINT = `Approved outcome: ${OUTCOME} Change only: src/chat/, src/search/ (never src/chat/migrations/); anything else is a boundary violation.`;
const sha256 = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const child = (id, extra = {}) => ({ id, issue: 512, title: `child ${id}`, deliverable: 'commit', goal: `Child ${id}.`,
  dependsOn: ['T1'], acceptance: [`${id} works`], references: ['AGENTS.md'], writes: [`src/search/${id.toLowerCase()}/`], ...extra });

function approved(campaignId = CAMPAIGN) {
  const v1 = declaration({ campaignId, tasks: [{ id: 'T1', issue: 512, title: 'first task', deliverable: 'commit', goal: 'Produce T1.',
    dependsOn: [], acceptance: ['T1 exists'], references: ['AGENTS.md'], writes: ['src/chat/ui/'] }] });
  return validateDeclaration({ ...v1, version: 2, envelope: {
    scopeVersion: 1, request: { route: 'goal', pinned: { base: 'a'.repeat(40) } },
    outcome: OUTCOME, acceptance: ['Searching a word finds the message'],
    writes: ['src/chat/', 'src/search/'], denyWrites: ['src/chat/migrations/'], deliverables: ['commit'], issues: [512], web: null,
    release: { mode: 'review-only' }, planning: 'adaptive',
  } });
}

/**
 * A registered campaign in a disposable store and repository, and a controller whose launch is stubbed: a tick records
 * the next operation (its packet, prompt and run directory) and starts nothing. `t1Done` marks the declared task done,
 * so the next runnable task is a child.
 */
function rig(t, { decl = approved(), t1Done = false, config = {} } = {}) {
  const env = environment({ config });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  campaignStart(store, decl);
  if (t1Done) store.patch('tasks', { campaign_id: decl.campaignId, task_id: 'T1' }, 1, { state: 'done' }, Date.now());
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  controller.launch = async () => {};
  let planning = 0;
  return {
    env, store, controller, decl, campaignId: decl.campaignId,
    tick: () => controller.tick(),
    /** Settle one planning result proposing `ops` against the current plan head, as a planning step of slice E5 would. */
    admit: (ops) => {
      planning++;
      const operation = { id: `${decl.campaignId}.${PLAN_TASK}.plan.${planning}`, kind: 'plan', task_id: PLAN_TASK, campaign_id: decl.campaignId,
        packet_digest: String(planning).repeat(64).slice(0, 64) };
      const settled = store.tx(() => settleAmendment(store, { campaign: store.campaign(decl.campaignId), operation,
        amendment: { basis: planHead(store, decl.campaignId), ops }, leaseGeneration: 1, now: Date.now() }));
      assert.equal(settled.outcome, 'admitted', JSON.stringify(settled));
      return settled;
    },
    operations: () => store.all('SELECT * FROM operations WHERE campaign_id = ? ORDER BY created_at, id', decl.campaignId),
  };
}

// The same initial commit in every rig, so the revision a packet binds to is the same and packets compare byte for byte:
// fixed dates, and the identity environment() exports (which a second rig would otherwise inherit from the first).
function fixedCommits(t) {
  const fixed = { GIT_AUTHOR_DATE: '2026-10-13T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-13T00:00:00Z',
    GIT_AUTHOR_NAME: 'Fake Worker', GIT_AUTHOR_EMAIL: 'worker@example.invalid', GIT_COMMITTER_NAME: 'Fake Worker', GIT_COMMITTER_EMAIL: 'worker@example.invalid' };
  const saved = Object.fromEntries(Object.keys(fixed).map((key) => [key, process.env[key]]));
  Object.assign(process.env, fixed);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

const childAuthority = (decl, digest) => sha256({ authority: authorityDigest(decl), amendment: digest });
const journal = (store, kind) => store.all('SELECT detail FROM journal WHERE campaign_id = ? AND kind = ?', CAMPAIGN, kind).map((row) => row.detail);

/** Nothing was dispatched, and the campaign holds one B2 plan-integrity blocker naming the problem. */
function assertIntegrityBlock(r, problem) {
  assert.deepEqual(r.operations(), [], 'no operation recorded');
  assert.equal(r.store.campaign(r.campaignId).runs_used, 0, 'no worker run counted');
  const blocker = r.store.campaign(r.campaignId).blocker;
  assert.equal(blocker?.kind, 'plan-integrity', JSON.stringify(blocker));
  assert.equal(blocker.class, 'B2');
  assert.match(blocker.reason, problem);
  assert.deepEqual(journal(r.store, 'blocker-raised').map((detail) => detail.kind), ['plan-integrity']);
}

test('a declared task\'s packet is byte-identical with and without admitted children', { skip: needsSqlite }, async (t) => {
  fixedCommits(t);
  const plain = rig(t);
  await plain.tick();
  const grown = rig(t);
  grown.admit([{ op: 'add', task: child('C1') }, { op: 'add', task: child('C2', { dependsOn: ['C1'] }) }]);
  await grown.tick();
  const [before] = plain.operations(), [after] = grown.operations();
  assert.equal(before.task_id, 'T1');
  assert.equal(after.task_id, 'T1', 'the declared task still runs first');
  assert.equal(canonicalJson(after.packet), canonicalJson(before.packet), 'the same packet bytes');
  assert.equal(after.packet_digest, before.packet_digest);
  assert.equal(after.packet.authorityDigest, authorityDigest(grown.decl), 'bound to the approval, as before');
  assert.ok(!after.packet.constraints.some((item) => item.startsWith('Approved outcome:')), 'no envelope constraint on a declared task');
  // A version 1 campaign has no plan rows at all: its packet binds to authorityDigest(decl) as it always did.
  const v1 = rig(t, { decl: declaration({ campaignId: 'plan-dispatch-v1' }) });
  await v1.tick();
  const [op] = v1.operations();
  assert.equal(op.packet.authorityDigest, authorityDigest(v1.decl));
  assert.deepEqual(op.packet.constraints, v1.decl.constraints);
});

test('a child runs with its own binding: the approval plus its amendment, and the approved outcome as a constraint', { skip: needsSqlite }, async (t) => {
  const r = rig(t, { t1Done: true });
  const admitted = r.admit([{ op: 'add', task: child('C1', { constraints: ['Child constraint: keep the index small.'] }) }]);
  await r.tick();
  const [op] = r.operations();
  assert.equal(op.task_id, 'C1');
  assert.equal(op.packet.authorityDigest, childAuthority(r.decl, admitted.digest));
  assert.notEqual(op.packet.authorityDigest, authorityDigest(r.decl));
  assert.match(op.packet.authorityDigest, /^[0-9a-f]{64}$/, 'still a 64-hex digest: the packet schema is unchanged');
  // Campaign constraints, then the envelope's, then the child's own, then its write domain.
  assert.deepEqual(op.packet.constraints.slice(0, 3), [...r.decl.constraints, ENVELOPE_CONSTRAINT, 'Child constraint: keep the index small.']);
  assert.match(op.packet.constraints[3], /^Write domain: change only files under src\/search\/c1\//);
  assert.match(op.packet.goal, /Child C1\.$/);
  assert.deepEqual(op.packet.acceptance, ['C1 works']);
  assert.equal(op.packet.access, 'write');
  assert.equal(op.state, 'recorded', 'admitted by planContext with the real authorityCurrent');
  assert.equal(r.store.task(r.campaignId, 'C1').state, 'implementing');
  assert.equal(r.store.campaign(r.campaignId).blocker, null);
});

test('a revised child gets a new packet digest and a fresh session', { skip: needsSqlite }, async (t) => {
  fixedCommits(t);
  const first = rig(t, { t1Done: true });
  const original = first.admit([{ op: 'add', task: child('C1') }]);
  await first.tick();
  const revisedRig = rig(t, { t1Done: true });
  const same = revisedRig.admit([{ op: 'add', task: child('C1') }]);
  assert.equal(same.digest, original.digest, 'the same amendment in both stores');
  const revision = revisedRig.admit([{ op: 'revise', taskId: 'C1', task: child('C1', { goal: 'Child C1, with a smaller index.' }) }]);
  await revisedRig.tick();
  const [a] = first.operations(), [b] = revisedRig.operations();
  assert.equal(a.packet.authorityDigest, childAuthority(first.decl, original.digest));
  assert.equal(b.packet.authorityDigest, childAuthority(revisedRig.decl, revision.digest), 'bound to the amendment that set the live revision');
  assert.notEqual(a.packet.authorityDigest, b.packet.authorityDigest);
  assert.notEqual(a.packet_digest, b.packet_digest);
  assert.equal(a.packet.revision, b.packet.revision, 'the same base revision: only the binding and the spec differ');
  assert.match(b.packet.goal, /with a smaller index/);
  assert.notEqual(a.session_id, b.session_id);
  // The revised packet never continues a session bound to the earlier revision (WORKER_CONTEXT_LIFECYCLE).
  const lease = (op) => ({ tenantId: op.packet.tenantId, projectId: op.packet.projectId, environment: op.packet.environment,
    taskId: op.packet.taskId, stageId: op.packet.stageId, runId: op.packet.runId, sessionId: a.session_id, revision: op.packet.revision,
    authorityDigest: op.packet.authorityDigest, generation: 1, state: 'active', expiresAtMs: Number.MAX_SAFE_INTEGER });
  assert.equal(acceptsLease(lease(a), lease(a), Date.now()), true);
  assert.equal(acceptsLease(lease(a), lease(b), Date.now()), false);
});

test('an edited spec row blocks dispatch with B2 plan-integrity, also when its digest is recomputed', { skip: needsSqlite }, async (t) => {
  for (const recompute of [false, true]) {
    const r = rig(t, { t1Done: true });
    r.admit([{ op: 'add', task: child('C1') }]);
    const widened = child('C1', { writes: ['src/billing/'] });
    r.store.run(`UPDATE task_specs SET spec = ?${recompute ? ', spec_digest = ?' : ''} WHERE campaign_id = ? AND task_id = 'C1'`,
      JSON.stringify(widened), ...(recompute ? [specDigest(widened)] : []), r.campaignId);
    await r.tick();
    await r.tick();
    assertIntegrityBlock(r, /C1 revision 1 is not the spec its amendment admitted/);
    assert.equal(r.store.task(r.campaignId, 'C1').state, 'pending');
  }
});

test('a removed amendment blocks dispatch, of its own children and of earlier ones', { skip: needsSqlite }, async (t) => {
  const removedOnly = rig(t, { t1Done: true });
  removedOnly.admit([{ op: 'add', task: child('C1') }]);
  removedOnly.store.run('DELETE FROM plan_amendments WHERE campaign_id = ?', removedOnly.campaignId);
  await removedOnly.tick();
  assertIntegrityBlock(removedOnly, /child C1 revision 1 is not the spec its amendment admitted/);

  // Removing the latest amendment leaves a valid-looking chain, but its child's spec row has no amendment behind it.
  const removedLast = rig(t, { t1Done: true });
  removedLast.admit([{ op: 'add', task: child('C1') }]);
  removedLast.admit([{ op: 'add', task: child('C2') }]);
  removedLast.store.run('DELETE FROM plan_amendments WHERE campaign_id = ? AND seq = 2', removedLast.campaignId);
  await removedLast.tick();
  assertIntegrityBlock(removedLast, /child C2 revision 1 is not the spec its amendment admitted/);

  // A missing amendment in the middle breaks the sequence itself.
  const gap = rig(t, { t1Done: true });
  gap.admit([{ op: 'add', task: child('C1') }]);
  gap.admit([{ op: 'add', task: child('C2') }]);
  gap.store.run('DELETE FROM plan_amendments WHERE campaign_id = ? AND seq = 1', gap.campaignId);
  await gap.tick();
  assertIntegrityBlock(gap, /amendment 1 is missing/);

  // A removed spec row leaves a task row without a spec: dispatch refuses it the same way, and nothing throws.
  const noSpec = rig(t, { t1Done: true });
  noSpec.admit([{ op: 'add', task: child('C1') }]);
  noSpec.store.run('DELETE FROM task_specs WHERE campaign_id = ?', noSpec.campaignId);
  await noSpec.tick();
  assertIntegrityBlock(noSpec, /child C1 was admitted without its spec row/);
});

test('a rewritten chain that verifies still cannot widen: the admission checks run again at dispatch', { skip: needsSqlite }, async (t) => {
  const r = rig(t, { t1Done: true });
  r.admit([{ op: 'add', task: child('C1') }]);
  // Everything rewritten consistently: the ops, the amendment digest and the spec row. Only the boundary can catch it.
  const widened = child('C1', { writes: ['src/billing/'] });
  const row = r.store.get('SELECT * FROM plan_amendments WHERE campaign_id = ? AND seq = 1', r.campaignId);
  const ops = [{ op: 'add', task: widened }];
  const digest = amendmentDigest({ campaignId: r.campaignId, seq: 1, parent: row.parent_digest, scopeDigest: row.scope_digest,
    authorizationVersion: row.authorization_version, sourceOperation: row.source_operation, sourcePacketDigest: row.source_packet_digest, ops });
  r.store.run('UPDATE plan_amendments SET ops = ?, digest = ? WHERE campaign_id = ? AND seq = 1', JSON.stringify(ops), digest, r.campaignId);
  r.store.run("UPDATE task_specs SET spec = ?, spec_digest = ? WHERE campaign_id = ? AND task_id = 'C1'", JSON.stringify(widened), specDigest(widened), r.campaignId);
  assert.equal(verifyChain(r.store, r.campaignId).ok, true, 'the rewritten chain verifies');
  await r.tick();
  assertIntegrityBlock(r, /C1 no longer passes admission: WIDEN_FILES: C1 wants to change src\/billing\/, outside the approved files/);
});

test('a child commit outside its own writes is a boundary violation, held for the owner and not retried', { skip: needsSqlite }, async (t) => {
  const r = rig(t, { t1Done: true });
  r.admit([{ op: 'add', task: child('C1') }]);
  await r.tick();
  const [op] = r.operations();
  assert.equal(op.task_id, 'C1');
  // Inside the envelope's src/chat/, but outside the child's own src/search/c1/.
  for (const file of ['src/search/c1/index.txt', 'src/chat/other.txt']) {
    mkdirSync(join(op.workspace, file, '..'), { recursive: true });
    writeFileSync(join(op.workspace, file), `${file}\n`);
  }
  git(op.workspace, 'add', '-A');
  git(op.workspace, 'commit', '-qm', 'child work');
  r.controller.applyOutcome({ id: r.campaignId, generation: r.controller.held.get(r.campaignId) }, op, { class: 'result',
    receipt: { sessionId: op.session_id }, value: { result: 'resolved', summary: 'done', headSha: git(op.workspace, 'rev-parse', 'HEAD'), report: '# r' } });
  const held = r.store.task(r.campaignId, 'C1');
  assert.equal(held.state, 'pending');
  assert.equal(held.blocked?.class, 'B3');
  assert.match(held.blocked.reason, /boundary violation .*writes outside the declared domain \(src\/search\/c1\/\): src\/chat\/other\.txt$/);
  assert.equal(held.retry_at, null);
  await r.tick();
  await r.tick();
  assert.equal(r.operations().length, 1, 'never retried, on this provider or another');
});

test('a child with requiresMergedDependencies waits for integration exactly as a declared task', { skip: needsSqlite }, async (t) => {
  const config = { integrationPollMs: 50 };
  const envelope = rig(t, { config });
  envelope.admit([{ op: 'add', task: child('C1', { requiresMergedDependencies: true }) }]);
  // The same wait for a declared task, in a version 1 campaign of the same repository.
  const plain = declaration({ campaignId: 'plan-dispatch-declared' });
  plain.tasks[1].requiresMergedDependencies = true;
  campaignStart(envelope.store, plain);
  const { repo } = envelope.env;
  // T1 of both campaigns is done: its verified commit is published on a branch, not yet in main.
  git(repo, 'checkout', '-qb', 'dependency');
  writeFileSync(join(repo, 'dependency.txt'), 'verified dependency\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'dependency');
  const sha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', '-q', 'origin', 'dependency');
  git(repo, 'checkout', '-q', 'main');
  for (const id of [envelope.campaignId, plain.campaignId]) {
    const row = envelope.store.task(id, 'T1');
    envelope.store.patch('tasks', { campaign_id: id, task_id: 'T1' }, row.version, { state: 'done', verified_sha: sha, head_sha: sha }, Date.now());
  }
  await envelope.tick();
  const waiting = [envelope.store.task(envelope.campaignId, 'C1'), envelope.store.task(plain.campaignId, 'T2')];
  assert.deepEqual(waiting.map((row) => row.last_error), ['dependency-integration: waiting for T1 in main', 'dependency-integration: waiting for T1 in main']);
  assert.ok(waiting.every((row) => row.state === 'pending' && row.retry_at > 0 && !row.blocked));
  assert.equal(envelope.store.get('SELECT COUNT(*) AS n FROM operations').n, 0, 'neither is dispatched before integration');

  // The owner merges the dependency: both are dispatched on its integrated base.
  git(repo, 'merge', '-q', '--ff-only', 'dependency');
  git(repo, 'push', '-q', 'origin', 'main');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && envelope.store.get('SELECT COUNT(*) AS n FROM operations').n < 2) {
    await envelope.tick();
    await new Promise((done) => setTimeout(done, 60));
  }
  const ops = envelope.store.all('SELECT campaign_id, task_id, base_sha, packet FROM operations ORDER BY campaign_id');
  assert.deepEqual(ops.map((op) => `${op.campaign_id}/${op.task_id}`), [`${envelope.campaignId}/C1`, `${plain.campaignId}/T2`]);
  assert.ok(ops.every((op) => op.base_sha === sha), 'both start from the base that contains the dependency');
  assert.equal(ops[0].packet.authorityDigest, childAuthority(envelope.decl, verifyChain(envelope.store, envelope.campaignId).head));
});
