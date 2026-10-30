// LO L8 (docs/design/LOCAL_OPERATION.md sections 4.4 and 6, slice SELF8): the local merge gate of the self-hosted
// repository. Only an independently verified local review merges, as a merge commit of the trusted tip and the verified
// head carrying the verified tree; main moves only from the trusted tip, and the main ledger records it once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { mergePass, mergeSettings } from '../../src/supervisor/merge.mjs';
import { mainLedger, recordAnchor, recordMainCommit } from '../../src/supervisor/self-hosting.mjs';
import { createItem, item, items, reviewItem } from '../../src/supervisor/work-list.mjs';
import { declaration, environment, runUntil, skipWithoutSqlite } from './helpers.mjs';

const REPOSITORY = 'example-org/sampleapp';
const GATE = [`"${process.execPath}"`, `"${join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-refresh-gate.mjs')}"`];
const FORCE_TREE = 'AIWORKS_TEST_FORCE_TREE';
const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

/**
 * A gh that records and refuses every call, and a Git wrapper that refuses fetch, push, pull and ls-remote and, while
 * AIWORKS_TEST_FORCE_TREE is set, gives commit-tree that tree instead of the one asked for.
 */
function guards(dir) {
  const log = join(dir, 'forbidden.log');
  writeFileSync(join(dir, 'forbidden-gh.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], JSON.stringify(['gh', ...process.argv.slice(3)]) + '\\n');
process.exit(97);
`);
  writeFileSync(join(dir, 'git-guard.mjs'), `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(3);
if (args.some((arg) => ['fetch', 'push', 'ls-remote', 'pull'].includes(arg))) {
  appendFileSync(process.argv[2], JSON.stringify(['git', ...args]) + '\\n');
  process.exit(97);
}
const at = args.indexOf('commit-tree');
if (at >= 0 && process.env.${FORCE_TREE}) args[at + 1] = process.env.${FORCE_TREE};
const out = spawnSync('git', args, { stdio: 'inherit', windowsHide: true });
process.exit(out.status ?? 1);
`);
  return { log, gh: [process.execPath, join(dir, 'forbidden-gh.mjs'), log], git: [process.execPath, join(dir, 'git-guard.mjs'), log] };
}

/**
 * The self-hosted repository with its ledger anchored and no remote, one commit task verified and recorded as a local
 * review, and the merge gate opted in for it. `pass()` runs one merge pass now.
 */
async function delivered(t, { config: extra = {}, campaignId, taskId = 'T1' } = {}) {
  const env = environment();
  const forbidden = guards(env.tmp);
  const config = { ...env.config, commands: { ...env.config.commands, gh: forbidden.gh, git: forbidden.git },
    selfHosting: { repository: REPOSITORY, trustedMain: 'local' }, ...extra };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { delete process.env[FORCE_TREE]; store.close(); env.cleanup(); });
  const anchor = git(env.repo, 'rev-parse', 'main');
  git(env.repo, 'update-ref', 'refs/remotes/origin/main', anchor);
  assert.equal(recordAnchor(store, { repoPath: env.repo, repository: REPOSITORY, sha: anchor, now: 1 }).recorded, true);
  git(env.repo, 'remote', 'remove', 'origin');
  for (const number of [437, 443]) createItem(store, { number, kind: 'task', title: `synthetic item ${number}`, authorKind: 'import', now: 1 });
  const d = declaration({ campaignId, tasks: [{ ...declaration().tasks[0], id: taskId }] });
  campaignStart(store, d);
  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  await runUntil(controller, store, d.campaignId, (c) => c.control === 'finished');
  const task = store.task(d.campaignId, taskId);
  assert.match(task.pr_url, /^aiworks-work:\d+$/);
  controller.merges = mergeSettings({ merges: { delegatedTo: 'supervisor', repositories: [REPOSITORY] } });
  const pass = async () => { controller.mergeCheckedAt.clear(); controller.mergeWaits.clear(); await mergePass(controller); };
  const journal = (kind) => store.all('SELECT detail FROM journal WHERE campaign_id = ? AND kind = ? ORDER BY seq', d.campaignId, kind).map((row) => row.detail);
  const gateRows = () => mainLedger(store, REPOSITORY).filter((row) => row.kind === 'gate-merge');
  return { env, forbidden, store, controller, id: d.campaignId, task, sha: task.verified_sha, anchor, pass, journal, gateRows };
}

test('LO L8: wrong head, wrong tree, unrecorded main, dirty checkout, stale lease and cancellation never move main; a valid review merges once', { skip: skipWithoutSqlite }, async (t) => {
  const { env, forbidden, store, controller, id, sha, anchor, pass, journal, gateRows } = await delivered(t);
  const main = () => git(env.repo, 'rev-parse', 'main');
  const branch = `refs/heads/campaign/${id}/T1`;
  const unmoved = (what) => { assert.equal(main(), anchor, `${what}: main did not move`); assert.equal(gateRows().length, 0, what); assert.equal(journal('merged').length, 0, what); };

  // The task branch no longer at the verified head.
  git(env.repo, 'update-ref', branch, anchor);
  await pass();
  unmoved('wrong head');
  assert.match(journal('merge-waiting').at(-1).reason, /not the verified/);
  git(env.repo, 'update-ref', branch, sha);

  // A merge commit whose tree is not the verified tree is refused before any ref moves.
  process.env[FORCE_TREE] = git(env.repo, 'rev-parse', `${anchor}^{tree}`);
  await pass();
  delete process.env[FORCE_TREE];
  unmoved('wrong tree');
  assert.match(journal('merge-refused').at(-1).detail, /verified tree/);

  // A commit someone put on main by hand: the gate waits and leaves it.
  writeFileSync(join(env.repo, 'owner.txt'), 'by hand\n');
  git(env.repo, 'add', 'owner.txt');
  git(env.repo, 'commit', '-q', '-m', 'unrecorded');
  const unrecorded = main();
  await pass();
  assert.equal(main(), unrecorded);
  assert.equal(gateRows().length, 0);
  assert.match(journal('merge-waiting').at(-1).reason, /main has 1 commits/);
  git(env.repo, 'reset', '-q', '--hard', anchor);

  // Unsaved work in the checkout that has main checked out stays byte-identical.
  writeFileSync(join(env.repo, 'AGENTS.md'), 'owner draft\n');
  await pass();
  unmoved('dirty checkout');
  assert.equal(readFileSync(join(env.repo, 'AGENTS.md'), 'utf8'), 'owner draft\n');
  assert.match(journal('merge-waiting').at(-1).reason, /unsaved changes/);
  git(env.repo, 'checkout', '-q', '--', 'AGENTS.md');

  // The lease lost to another instance after the request: nothing moves.
  controller.injectFault = (name) => {
    if (name !== 'before-merge') return;
    store.releaseLease(id, controller.instanceId, controller.held.get(id), controller.now());
    assert.ok(store.acquireLease(id, 'synthetic-other-instance', controller.now(), 60_000));
  };
  await pass();
  unmoved('stale lease');
  store.releaseLease(id, 'synthetic-other-instance', store.lease(id).generation, controller.now());

  // A cancellation committed after the request: nothing moves.
  controller.injectFault = (name) => {
    if (name !== 'before-merge') return;
    const c = store.campaign(id);
    store.patch('campaigns', { id }, c.version, { control: 'cancelled' }, controller.now());
  };
  await pass();
  unmoved('cancelled');
  controller.injectFault = () => {};
  store.patch('campaigns', { id }, store.campaign(id).version, { control: 'finished' }, controller.now());

  // Valid: one merge commit, trusted tip first, the verified tree, the owner's files follow, one ledger row.
  await pass();
  const merge = main();
  assert.deepEqual(git(env.repo, 'rev-list', '--parents', '-n', '1', merge).split(' ').slice(1), [anchor, sha]);
  assert.equal(git(env.repo, 'rev-parse', `${merge}^{tree}`), git(env.repo, 'rev-parse', `${sha}^{tree}`));
  assert.equal(git(env.repo, 'status', '--porcelain'), '', 'the checkout followed main');
  assert.deepEqual(gateRows().map((row) => [row.old_tip, row.new_tip, row.task_id, row.verified_sha]), [[anchor, merge, 'T1', sha]]);
  assert.equal(journal('merged').length, 1);
  await pass();
  assert.equal(main(), merge, 'a recorded merge is never attempted again');
  assert.equal(gateRows().length, 1);
  assert.deepEqual(lines(forbidden.log), [], 'nothing ran gh, fetched, pushed or listed a remote');
});

test('LO L8: a crash after main moved records the same merge once; a moved trusted tip needs a fresh review', { skip: skipWithoutSqlite }, async (t) => {
  const { env, controller, anchor, pass, journal, gateRows } = await delivered(t);
  const main = () => git(env.repo, 'rev-parse', 'main');
  let crashed = 0;
  controller.injectFault = (name) => { if (name === 'after-merge' && !crashed++) throw new Error('synthetic crash after the ref move'); };
  await pass();
  assert.equal(crashed, 1);
  const merge = main();
  assert.notEqual(merge, anchor, 'main moved before the crash');
  assert.equal(gateRows().length, 0, 'the record rolled back with the crash');
  await pass();
  assert.equal(main(), merge, 'no second merge commit');
  assert.equal(git(env.repo, 'rev-list', '--count', '--merges', `${anchor}..main`), '1');
  assert.deepEqual(gateRows().map((row) => [row.old_tip, row.new_tip]), [[anchor, merge]]);
  assert.deepEqual(journal('merged').map((entry) => [entry.mergeCommit, entry.reconciled]), [[merge, true]]);
  await pass();
  assert.equal(gateRows().length, 1);

  // A second verified review, then the trusted tip moves past it: no merge, an integration repair round instead.
  const fresh = await delivered(t);
  writeFileSync(join(fresh.env.repo, 'owner.txt'), 'recorded by the owner\n');
  git(fresh.env.repo, 'add', 'owner.txt');
  git(fresh.env.repo, 'commit', '-q', '-m', 'owner commit');
  const owner = git(fresh.env.repo, 'rev-parse', 'main');
  assert.equal(recordMainCommit(fresh.store, { repository: REPOSITORY, kind: 'owner', oldTip: fresh.anchor, newTip: owner, now: 2 }).recorded, true);
  await fresh.pass();
  assert.equal(git(fresh.env.repo, 'rev-parse', 'main'), owner);
  assert.equal(fresh.gateRows().length, 0);
  const task = fresh.store.task(fresh.id, 'T1');
  assert.equal(task.state, 'pending');
  assert.equal(task.findings[0].id, 'integration-conflict');
  assert.equal(fresh.journal('merge-base-moved').length, 1);
});

test('LO L8 refresh: a trusted tip moved under a verified review merges only the gated merge result, once after a crash; a failed gate repairs', { skip: skipWithoutSqlite }, async (t) => {
  /** A delivered review whose trusted tip then moves by a recorded owner commit that shares no file with it. */
  const moved = async (mode) => {
    const r = await delivered(t);
    const state = join(r.env.tmp, 'refresh-gate');
    mkdirSync(state);
    writeFileSync(join(state, 'mode'), mode);
    process.env.FAKE_REFRESH_STATE = state;
    t.after(() => { delete process.env.FAKE_REFRESH_STATE; });
    writeFileSync(join(r.env.repo, 'owner.txt'), 'recorded by the owner\n');
    git(r.env.repo, 'add', 'owner.txt');
    git(r.env.repo, 'commit', '-q', '-m', 'owner commit');
    const owner = git(r.env.repo, 'rev-parse', 'main');
    assert.equal(recordMainCommit(r.store, { repository: REPOSITORY, kind: 'owner', oldTip: r.anchor, newTip: owner, now: 2 }).recorded, true);
    r.controller.merges = mergeSettings({ merges: { delegatedTo: 'supervisor', repositories: [REPOSITORY], refresh: { command: GATE } } });
    // Starts the gate, waits until it recorded its exit code, then runs the pass that reads it.
    const gated = async () => {
      await r.pass();
      const [started] = r.journal('merge-refresh-started');
      assert.equal(started.base, owner);
      assert.equal(git(r.env.repo, 'rev-parse', 'main'), owner, 'main waits while the gate runs');
      for (let i = 0; i < 600 && !existsSync(join(started.path, 'gate-exit.log')); i++) await new Promise((done) => setTimeout(done, 50));
      await r.pass();
      return started;
    };
    return { ...r, owner, gated };
  };

  // A failed gate on the merge result leaves main unmoved and reopens the task for the integration repair.
  const failing = await moved('fail');
  await failing.gated();
  assert.equal(git(failing.env.repo, 'rev-parse', 'main'), failing.owner);
  assert.equal(failing.gateRows().length, 0);
  assert.equal(failing.journal('merge-requested').length, 0);
  assert.equal(failing.store.task(failing.id, 'T1').findings[0].id, 'integration-conflict');

  // A passed gate: the merge commit of the trusted tip and the unchanged verified head carries exactly the gated tree.
  // A crash after main moved records that merge once on restart and never writes a second one.
  const passing = await moved('pass');
  let crashed = 0;
  passing.controller.injectFault = (name) => { if (name === 'after-merge' && !crashed++) throw new Error('synthetic crash after the ref move'); };
  const started = await passing.gated();
  assert.equal(crashed, 1);
  const main = () => git(passing.env.repo, 'rev-parse', 'main');
  const merge = main();
  assert.deepEqual(git(passing.env.repo, 'rev-list', '--parents', '-n', '1', merge).split(' ').slice(1), [passing.owner, passing.sha]);
  assert.equal(git(passing.env.repo, 'rev-parse', `${merge}^{tree}`), started.tree);
  assert.equal(lines(join(passing.env.tmp, 'refresh-gate', 'runs.jsonl')).map((line) => JSON.parse(line).tree).at(-1), started.tree, 'the gate ran on that tree');
  assert.equal(passing.gateRows().length, 0, 'the record rolled back with the crash');
  await passing.pass();
  await passing.pass();
  assert.equal(main(), merge, 'no second merge commit');
  assert.deepEqual(passing.gateRows().map((row) => [row.old_tip, row.new_tip, row.verified_sha]), [[passing.owner, merge, passing.sha]]);
  assert.deepEqual(passing.journal('merged').map((entry) => [entry.mergeCommit, entry.reconciled]), [[merge, true]]);
  assert.equal(passing.store.task(passing.id, 'T1').state, 'done', 'no AI repair round');
  assert.equal(git(passing.env.repo, 'status', '--porcelain'), '', 'the checkout followed main');
  assert.deepEqual(lines(passing.forbidden.log), []);
});

test('a maximal legal campaign and task id records its whole verified review and merges that exact head', { skip: skipWithoutSqlite }, async (t) => {
  // Both IDs at their 64-character limit: the branch is longer than a work-list label may be, and worktree folders named
  // after the whole pair would leave Git too little of a Windows path.
  const campaignId = `c${'x'.repeat(63)}`, taskId = `T${'y'.repeat(63)}`;
  const { env, forbidden, store, id, task, sha, anchor, pass, gateRows } = await delivered(t, { campaignId, taskId });
  assert.equal(task.state, 'done', JSON.stringify(task.blocked));
  const review = item(store, Number(task.pr_url.split(':')[1]));
  assert.equal(reviewItem(store, { campaignId: id, taskId, verifiedSha: sha })?.number, review.number, 'found by campaign, task and verified SHA');
  assert.ok(review.body.includes(String(task.result.report)), 'the complete verified report');
  assert.ok(review.body.includes(`campaign/${id}/${taskId}`) && review.body.includes(sha));
  await pass();
  const merge = git(env.repo, 'rev-parse', 'main');
  assert.deepEqual(git(env.repo, 'rev-list', '--parents', '-n', '1', merge).split(' ').slice(1), [anchor, sha]);
  assert.deepEqual(gateRows().map((row) => [row.task_id, row.verified_sha]), [[taskId, sha]]);
  assert.deepEqual(lines(forbidden.log), []);
});

test('malformed public-only publication settings never block a local review', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  const forbidden = guards(env.tmp);
  const config = { ...env.config, commands: { ...env.config.commands, gh: forbidden.gh, git: forbidden.git },
    selfHosting: { repository: REPOSITORY, trustedMain: 'local' } };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const anchor = git(env.repo, 'rev-parse', 'main');
  git(env.repo, 'update-ref', 'refs/remotes/origin/main', anchor);
  assert.equal(recordAnchor(store, { repoPath: env.repo, repository: REPOSITORY, sha: anchor, now: 1 }).recorded, true);
  git(env.repo, 'remote', 'remove', 'origin');
  for (const number of [437, 443]) createItem(store, { number, kind: 'task', title: `synthetic item ${number}`, authorKind: 'import', now: 1 });
  writeFileSync(join(env.repo, '.git', 'info', 'exclude'), '.local/\n');
  mkdirSync(join(env.repo, '.local'), { recursive: true });
  writeFileSync(join(env.repo, '.local', 'publication.json'), '{ not json');
  const d = declaration({ tasks: [declaration().tasks[0]] });
  campaignStart(store, d);
  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  await runUntil(controller, store, d.campaignId, (c) => c.control === 'finished');
  assert.equal(items(store).filter((item) => item.kind === 'review').length, 1);
  assert.deepEqual(lines(forbidden.log), []);
});
