// RUN4 (ADAPTIVE_SCHEDULER slice S3, aiworks#5 scope B): commit tasks may declare `writes`; a task without it owns the whole
// repository; who holds a domain is derived from rows across campaigns until the change is integrated; a commit that
// changes paths outside its plan goes to the verifier, and only a secret-like or forbidden path is a boundary violation
// (AW-013); `limits.slots` accepts 1..8 and "auto". Admission by
// domain is the scheduler's (RUN5): nothing here changes what the one-slot controller dispatches. Workers are played
// through applyOutcome; no model, network or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignPause, campaignStart } from '../../src/supervisor/api.mjs';
import { scopeDigest, validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { domainHolders, domainOf, domainsOverlap, outsideWrites, pathsOutside } from '../../src/supervisor/work-ownership.mjs';
import { ROOT, declaration, environment } from './helpers.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const commitTask = (id, issue, extra = {}) => ({ id, issue, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`,
  dependsOn: [], acceptance: [`${id} exists`], references: ['AGENTS.md'], ...extra });

test('writes and slots validate; declarations without them keep their digests', () => {
  const d = declaration({ tasks: [commitTask('T1', 901, { writes: ['src/dashboard/', 'docs/SUPERVISOR.md', 'resource:port-4319'] })] });
  validateDeclaration(d);
  for (const slots of [1, 2, 8, 'auto']) validateDeclaration({ ...d, limits: { ...d.limits, slots } });
  for (const slots of [0, 9, 1.5, 'many']) assert.throws(() => validateDeclaration({ ...d, limits: { ...d.limits, slots } }), /limits.slots/);
  for (const writes of [[], ['/abs/path'], ['../up'], ['a/../b'], ['C:/x'], ['resource:UPPER'], ['dup/', 'DUP/'], 'src/']) {
    assert.throws(() => validateDeclaration(declaration({ tasks: [commitTask('T1', 902, { writes })] })), /writes must be/, JSON.stringify(writes));
  }
  const report = { ...commitTask('R1', 903, { writes: ['docs/'] }), deliverable: 'report' };
  assert.throws(() => validateDeclaration(declaration({ tasks: [report] })), /writes must be/, 'reports write nothing');
  // An absent list changes no digest: every committed declaration still validates and digests as its canonical JSON says.
  const plain = declaration();
  assert.equal(scopeDigest(plain), scopeDigest({ ...plain, tasks: plain.tasks.map((task) => ({ ...task, writes: undefined })) }));
  for (const name of readdirSync(join(ROOT, 'tests/fixtures/campaigns')).filter((file) => file.endsWith('.json'))) {
    validateDeclaration(JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/campaigns', name), 'utf8')));
  }
});

test('domains overlap by repository, workKey, path prefix (case folded) or resource; reports hold none', () => {
  const decl = (repository, tasks) => ({ ...declaration({ tasks }), target: { ...declaration().target, repository } });
  const dom = (task, repository = 'example-org/sampleapp') => domainOf(decl(repository, [task]), task);
  const a = dom(commitTask('A', 1, { writes: ['src/dashboard/'] }));
  assert.equal(domainOf(decl('example-org/sampleapp', []), { ...commitTask('R', 1), deliverable: 'report' }), null);
  assert.ok(domainsOverlap(a, dom(commitTask('B', 2, { writes: ['SRC/Dashboard/server.mjs'] }))), 'prefix, case folded');
  assert.ok(!domainsOverlap(a, dom(commitTask('C', 3, { writes: ['src/supervisor/'] }))), 'disjoint prefixes');
  assert.ok(domainsOverlap(a, dom(commitTask('D', 4))), 'a task without writes owns the whole repository');
  assert.ok(!domainsOverlap(a, dom(commitTask('E', 5), 'example-org/aiworks')), 'different repositories never conflict');
  assert.ok(domainsOverlap(dom(commitTask('F', 6, { writes: ['resource:port-4319'] })), dom(commitTask('G', 7, { writes: ['resource:port-4319'] }))));
  assert.ok(domainsOverlap(dom(commitTask('H', 8, { writes: ['a/'], workKey: 'repair-x' })), dom(commitTask('I', 9, { writes: ['b/'], workKey: 'repair-x' }))), 'a shared workKey always conflicts');
  assert.deepEqual(pathsOutside(a, ['src/dashboard/server.mjs', 'src/Dashboard/public/x.js', 'src/supervisor/api.mjs']), ['src/supervisor/api.mjs']);
  assert.deepEqual(pathsOutside(dom(commitTask('W', 10)), ['anything']), [], 'a whole-repository domain has no outside');
  // A declared entry covers itself and what is below it, never a sibling that merely starts with the same letters.
  const file = dom(commitTask('J', 11, { writes: ['docs/SUPERVISOR.md', 'src/a'] }));
  assert.deepEqual(pathsOutside(file, ['docs/supervisor.md', 'src/a/x.js', 'docs/SUPERVISOR.md.bak', 'src/ab.js']),
    ['docs/SUPERVISOR.md.bak', 'src/ab.js']);
  assert.ok(!domainsOverlap(file, dom(commitTask('K', 12, { writes: ['src/ab/', 'docs/SUPERVISOR.mdx'] }))), 'a shared leading string is not overlap');
  assert.ok(domainsOverlap(file, dom(commitTask('L', 13, { writes: ['src/a/b/'] }))), 'a directory below a declared entry overlaps it');
});

test('who holds a domain follows the holder table, across campaigns, until integration', (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const other = (id, writes) => declaration({ campaignId: id, tasks: [commitTask('X', 910, { writes, goal: `Produce X in ${id}.` })] });
  const mine = declaration({ campaignId: 'mine', tasks: [commitTask('M', 911, { writes: ['src/a/'] })] });
  campaignStart(store, mine);
  const candidate = { campaignId: 'mine', taskId: 'M', domain: domainOf(mine, mine.tasks[0]) };
  const setTask = (id, changes) => {
    const task = store.task(id, 'X');
    store.patch('tasks', { campaign_id: id, task_id: 'X' }, task.version, changes, Date.now());
  };
  const holders = (integrated = () => false) => domainHolders(store, candidate, { integrated }).map((h) => `${h.campaignId}:${h.reason}`);

  campaignStart(store, other('c1', ['src/a/b.js']));
  assert.deepEqual(holders(), [], 'a pending task with nothing open holds nothing');
  const now = Date.now();
  store.run(`INSERT INTO operations (id, campaign_id, task_id, kind, seq, idempotency_key, lease_generation, state, session_id, run_dir,
    workspace, packet, packet_digest, created_at, updated_at) VALUES ('c1.X.implement.1', 'c1', 'X', 'implement', 1, 'c1.X.implement.1', 1,
    'dispatched', 's', 'r', 'w', '{}', 'd', ?, ?)`, now, now);
  setTask('c1', { state: 'implementing' });
  assert.deepEqual(holders(), ['c1:writing'], 'an open implement operation writes');
  store.run("UPDATE operations SET state = 'finished' WHERE id = 'c1.X.implement.1'");
  for (const state of ['implemented', 'verifying', 'verified']) {
    setTask('c1', { state });
    assert.deepEqual(holders(), ['c1:unintegrated'], `${state} is not integrated yet`);
  }
  setTask('c1', { state: 'done', verified_sha: 'a'.repeat(40), pr_url: 'https://github.com/example-org/sampleapp/pull/1' });
  assert.deepEqual(holders(), ['c1:published-unmerged'], 'published but unmerged keeps its domain');
  assert.deepEqual(holders(() => true), [], 'released once integrated');

  campaignPause(store, 'c1', 'owner pause', Date.now());
  setTask('c1', { state: 'verified' });
  assert.deepEqual(holders(), ['c1:unintegrated'], 'pausing does not release ownership');
  setTask('c1', { state: 'done' });
  const c1 = store.campaign('c1');
  store.patch('campaigns', { id: 'c1' }, c1.version, { control: 'finished' }, Date.now());
  assert.deepEqual(holders(), ['c1:published-unmerged'], 'a finished campaign still holds its unmerged PR');

  campaignStart(store, other('c2', ['src/z/']));
  setTask('c2', { state: 'verified' });
  campaignStart(store, { ...other('c3', undefined), target: { ...declaration().target, repository: 'example-org/aiworks' } });
  setTask('c3', { state: 'verified' });
  assert.deepEqual(holders(), ['c1:published-unmerged'], 'disjoint paths and other repositories never hold it');
  campaignStart(store, other('c4', undefined));
  setTask('c4', { state: 'implemented' });
  assert.deepEqual(holders(), ['c1:published-unmerged', 'c4:unintegrated'], 'a task without writes owns the whole repository');

  // A cancelled campaign releases its unpublished work, but a run that is still open keeps writing until it is settled.
  campaignStart(store, other('c5', ['src/']));
  setTask('c5', { state: 'implementing' });
  store.run(`INSERT INTO operations (id, campaign_id, task_id, kind, seq, idempotency_key, lease_generation, state, session_id, run_dir,
    workspace, packet, packet_digest, created_at, updated_at) VALUES ('c5.X.implement.1', 'c5', 'X', 'implement', 1, 'c5.X.implement.1', 1,
    'recorded', 's', 'r', 'w', '{}', 'd', ?, ?)`, now, now);
  const c5 = store.campaign('c5');
  store.patch('campaigns', { id: 'c5' }, c5.version, { control: 'cancelled' }, Date.now());
  assert.deepEqual(holders(), ['c1:published-unmerged', 'c4:unintegrated', 'c5:writing'], 'an open run holds its domain after cancel');
  store.run("UPDATE operations SET state = 'finished' WHERE id = 'c5.X.implement.1'");
  assert.deepEqual(holders(), ['c1:published-unmerged', 'c4:unintegrated'], 'released once the run is settled');
});

test('published but unmerged work keeps its domain until merged', (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const first = declaration({ campaignId: 'first', tasks: [commitTask('X', 930, { writes: ['src/a/'] })] });
  const second = declaration({ campaignId: 'second', tasks: [commitTask('Y', 931, { writes: ['src/a/b/'] })] });
  campaignStart(store, first);
  campaignStart(store, second);
  // The first task's verified commit, published on its own branch of a disposable origin and not yet in main.
  git(env.repo, 'checkout', '-qb', 'campaign/first/X');
  mkdirSync(join(env.repo, 'src', 'a'), { recursive: true });
  writeFileSync(join(env.repo, 'src', 'a', 'one.txt'), 'one\n');
  git(env.repo, 'add', '-A'); git(env.repo, 'commit', '-qm', 'first X');
  const verified = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'push', '-q', 'origin', 'campaign/first/X');
  git(env.repo, 'checkout', '-q', 'main');
  const task = store.task('first', 'X');
  store.patch('tasks', { campaign_id: 'first', task_id: 'X' }, task.version,
    { state: 'done', verified_sha: verified, pr_url: 'https://github.com/example-org/sampleapp/pull/7' }, Date.now());
  // Integrated means: the verified SHA is in the fetched base branch, read from an explicit ref as the controller does.
  const integrated = (campaignId, row) => {
    git(env.repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/aiworks/base/main');
    return spawnSync('git', ['merge-base', '--is-ancestor', row.verified_sha, 'refs/aiworks/base/main'], { cwd: env.repo, windowsHide: true }).status === 0;
  };
  const candidate = { campaignId: 'second', taskId: 'Y', domain: domainOf(second, second.tasks[0]) };
  assert.deepEqual(domainHolders(store, candidate, { integrated }), [{ campaignId: 'first', taskId: 'X', reason: 'published-unmerged' }],
    'the PR head is not in origin main: the domain stays held');
  const c = store.campaign('first');
  store.patch('campaigns', { id: 'first' }, c.version, { control: 'finished' }, Date.now());
  assert.equal(domainHolders(store, candidate, { integrated }).length, 1, 'finishing the campaign does not release an unmerged PR');
  // The owner merges the PR: main now contains the verified SHA, and the domain is free.
  git(env.repo, 'merge', '-q', '--no-ff', '-m', 'Merge first X', 'campaign/first/X');
  git(env.repo, 'push', '-q', 'origin', 'main');
  assert.deepEqual(domainHolders(store, candidate, { integrated }), [], 'released once the verified SHA is in origin main');
});

/** One registered campaign; the test plays the implementer. */
function rig(t, task) {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const decl = declaration({ tasks: [task] });
  campaignStart(store, decl);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  controller.launch = async () => {};
  const implement = (files) => {
    const op = store.openOperations(decl.campaignId)[0];
    for (const file of files) { mkdirSync(join(op.workspace, file, '..'), { recursive: true }); writeFileSync(join(op.workspace, file), `${file}\n`); }
    git(op.workspace, 'add', '-A'); git(op.workspace, 'commit', '-qm', 'work');
    controller.applyOutcome({ id: decl.campaignId, generation: controller.held.get(decl.campaignId) }, op, { class: 'result',
      receipt: { sessionId: op.session_id }, value: { result: 'resolved', summary: 'done', headSha: git(op.workspace, 'rev-parse', 'HEAD'), report: '# r' } });
    return store.task(decl.campaignId, task.id);
  };
  return { controller, store, campaignId: decl.campaignId, implement, tick: () => controller.tick() };
}

test('a commit that changes files outside its plan goes on to the verifier, who is told exactly those files (AW-013)', async (t) => {
  const r = rig(t, commitTask('T1', 920, { writes: ['src/a/', 'docs/naïve/'] }));
  await r.tick();
  const task = r.implement(['src/a/ok.txt', 'docs/naïve/inside name.txt', 'src/b/outside.txt', 'src/ab.txt']);
  assert.equal(task.state, 'implemented', 'not held for the owner');
  assert.equal(task.blocked, null);
  await r.tick();
  const op = r.store.openOperations(r.campaignId)[0];
  assert.equal(op.kind, 'verify');
  const line = op.packet.constraints.find((entry) => entry.startsWith('This head changes files outside the plan:'));
  assert.ok(line, 'the verifier judges the files outside the plan');
  assert.match(line, /^This head changes files outside the plan: (src\/ab\.txt, src\/b\/outside\.txt|src\/b\/outside\.txt, src\/ab\.txt)\./,
    'only the files outside the plan; a sibling sharing leading letters is outside; git must not quote the non-ASCII path');
});

test('a commit that changes a secret-like file or a file the plan forbids is still a boundary violation held for the owner', async (t) => {
  for (const writes of [['src/a/'], undefined]) await t.test(writes ? 'planned files' : 'whole repository', async (t) => {
    const r = rig(t, commitTask('T1', 926, { writes }));
    await r.tick();
    const held = r.implement(['src/a/ok.txt', 'config/.env.local']);
    assert.equal(held.state, 'pending');
    assert.equal(held.blocked?.class, 'B3');
    assert.match(held.blocked.reason, /boundary violation .*secret-like or forbidden files: config\/\.env\.local/);
    assert.equal(held.retry_at, null, 'no timed retry');
    // Never retried: later ticks open no new operation, on this provider or any other, until the owner rechecks.
    await r.tick();
    await r.tick();
    assert.equal(r.store.openOperations(r.campaignId).length, 0);
    assert.equal(r.store.all("SELECT id FROM operations WHERE campaign_id = ? AND kind = 'implement'", r.campaignId).length, 1);
  });
  const decl = { envelope: { denyWrites: ['src/a/locked'] } };
  const domain = domainOf(declaration({ tasks: [commitTask('T2', 927, { writes: ['src/'] })] }), commitTask('T2', 927, { writes: ['src/'] }));
  assert.deepEqual(outsideWrites(decl, domain, ['SRC/A/Locked/x.js', 'docs/x.md']), { forbidden: ['SRC/A/Locked/x.js'], beyond: ['docs/x.md'] },
    'a denied path is forbidden even where a broad plan would cover it');
});

test('a commit inside its declared domain, or a task without writes, is accepted as before', async (t) => {
  const inside = rig(t, commitTask('T1', 921, { writes: ['src/a/'] }));
  await inside.tick();
  assert.equal(inside.implement(['SRC/A/Nested/file.txt']).state, 'implemented', 'case folded, nested');
  const whole = rig(t, commitTask('T1', 922));
  await whole.tick();
  assert.equal(whole.implement(['anywhere/at/all.txt']).state, 'implemented');
});

test('the worker and its verifier are told the declared write domain before it is enforced', async (t) => {
  const r = rig(t, commitTask('T1', 923, { writes: ['src/a/', 'resource:dev-db'] }));
  await r.tick();
  const op = r.store.openOperations(r.campaignId)[0];
  const prompt = readFileSync(join(op.run_dir, 'prompt.txt'), 'utf8');
  assert.ok(prompt.includes('Planned files: src/a/ (resources held: resource:dev-db).'), 'the plan is in the packet constraints');
  const whole = rig(t, commitTask('T1', 924));
  await whole.tick();
  const unrestricted = readFileSync(join(whole.store.openOperations(whole.campaignId)[0].run_dir, 'prompt.txt'), 'utf8');
  assert.doesNotMatch(unrestricted, /Planned files:/, 'a task without writes is unchanged');
});
