// AW-014 for AIWorks's own repository with local main trusted: verified local reviews waiting for trusted main merge as
// one group after one gate run on their combined tree. Main moves only from the previous checked step, with exactly the
// tree that step predicted, and each merge is recorded once with its main ledger row, also after a crash.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, FencedError } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { mergePass, mergeSettings } from '../../src/supervisor/merge.mjs';
import { mainLedger, recordAnchor, recordMainCommit } from '../../src/supervisor/self-hosting.mjs';
import { createItem } from '../../src/supervisor/work-list.mjs';
import { declaration, environment, runUntil, sleep, skipWithoutSqlite } from './helpers.mjs';

const REPOSITORY = 'example-org/sampleapp';
const GATE = [`"${process.execPath}"`, `"${join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-refresh-gate.mjs')}"`];
const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

/**
 * The self-hosted repository with its ledger anchored and no remote, and one verified local review per campaign of
 * `modes` (the synthetic worker's implement mode), delivered one after the other with merging off. `start(merges)` turns
 * the merge gate on with merges.batch, `pass()` runs one merge pass now.
 */
async function reviews(t, modes) {
  const env = environment({ scenario: { implement: Object.values(modes) } });
  writeFileSync(join(env.tmp, 'forbidden-gh.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + '\\n');
process.exit(97);
`);
  const forbidden = join(env.tmp, 'forbidden.log');
  const config = { ...env.config, commands: { ...env.config.commands, gh: [process.execPath, join(env.tmp, 'forbidden-gh.mjs'), forbidden] },
    selfHosting: { repository: REPOSITORY, trustedMain: 'local' } };
  const gate = join(env.tmp, 'refresh-gate');
  mkdirSync(gate);
  process.env.FAKE_REFRESH_STATE = gate;
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const groups = (kind) => store.all('SELECT detail FROM journal WHERE campaign_id IS NULL AND kind = ? ORDER BY seq', kind).map((row) => row.detail);
  t.after(async () => {
    for (const { path } of groups('merge-batch-started')) for (let i = 0; i < 600 && existsSync(join(path, 'gate-pid.log')) && !existsSync(join(path, 'gate-exit.log')); i++) await sleep(50);
    delete process.env.FAKE_REFRESH_STATE;
    r.controller.release(); store.close(); env.cleanup();
  });
  const anchor = git(env.repo, 'rev-parse', 'main');
  git(env.repo, 'update-ref', 'refs/remotes/origin/main', anchor);
  assert.equal(recordAnchor(store, { repoPath: env.repo, repository: REPOSITORY, sha: anchor, now: 1 }).recorded, true);
  git(env.repo, 'remote', 'remove', 'origin');
  for (const number of [437, 443]) createItem(store, { number, kind: 'task', title: `synthetic item ${number}`, authorKind: 'import', now: 1 });
  const r = {
    env, store, anchor, groups, controller: new Controller({ store, config, dataDir: env.dataDir, fault: null }), merges: null,
    start(merges = {}) {
      r.merges = mergeSettings({ merges: { delegatedTo: 'supervisor', repositories: [REPOSITORY], refresh: { command: GATE }, batch: true, ...merges } });
      r.controller.merges = r.merges;
    },
    restart() {
      r.controller.release();
      r.controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
      r.controller.merges = r.merges;
    },
    pass: async () => { r.controller.mergeCheckedAt.clear(); r.controller.mergeWaits.clear(); await mergePass(r.controller); },
    main: () => git(env.repo, 'rev-parse', 'main'),
    tree: (sha) => git(env.repo, 'rev-parse', `${sha}^{tree}`),
    parents: (sha) => git(env.repo, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1),
    runs: () => lines(join(gate, 'runs.jsonl')),
    mode: (value) => writeFileSync(join(gate, 'mode'), value),
    journal: (id, kind) => store.all('SELECT detail FROM journal WHERE campaign_id = ? AND kind = ? ORDER BY seq', id, kind).map((row) => row.detail),
    gateRows: () => mainLedger(store, REPOSITORY).filter((row) => row.kind === 'gate-merge'),
    async gateEnds(path) {
      for (let i = 0; i < 600 && !existsSync(join(path, 'gate-exit.log')); i++) await sleep(50);
      assert.ok(existsSync(join(path, 'gate-exit.log')), `the gate in ${path} ended`);
    },
    forbidden: () => lines(forbidden),
    sha: {}, url: {},
  };
  for (const id of Object.keys(modes)) {
    campaignStart(store, declaration({ campaignId: id, tasks: [declaration().tasks[0]] }));
    await runUntil(r.controller, store, id, (c) => c.control === 'finished');
    const task = store.task(id, 'T1');
    assert.match(task.pr_url, /^aiworks-work:\d+$/);
    r.sha[id] = task.verified_sha; r.url[id] = task.pr_url;
  }
  return r;
}

test('local group: two verified reviews merge after one gate run on their combined tree; a conflicting or held review stays out', { skip: skipWithoutSqlite }, async (t) => {
  const r = await reviews(t, { 'camp-a': 'commit', 'camp-b': 'commit-page', 'camp-c': 'commit-page', 'camp-d': 'commit' });
  r.start({ held: { [r.url['camp-d']]: 'synthetic hold' } });
  await r.pass();
  const [started] = r.groups('merge-batch-started');
  assert.deepEqual(started.members.map((m) => m.sha), [r.sha['camp-a'], r.sha['camp-b']], 'the conflicting and the held review stay out');
  assert.equal(r.main(), r.anchor, 'main waits while the gate runs');
  await r.gateEnds(started.path);
  await r.pass();
  const runs = r.runs();
  assert.equal(runs.length, 1, 'one gate run for the whole group');
  assert.equal(r.tree(r.main()), runs[0].tree, 'main now carries exactly the tree the gate ran');
  const [a] = r.journal('camp-a', 'merged'), [b] = r.journal('camp-b', 'merged');
  assert.deepEqual(r.parents(a.mergeCommit), [r.anchor, r.sha['camp-a']]);
  assert.deepEqual(r.parents(b.mergeCommit), [a.mergeCommit, r.sha['camp-b']]);
  assert.equal(r.main(), b.mergeCommit);
  assert.deepEqual([a.group, b.group], [started.id, started.id], 'each merge names the gate run');
  assert.deepEqual(r.gateRows().map((row) => [row.old_tip, row.new_tip, row.verified_sha]),
    [[r.anchor, a.mergeCommit, r.sha['camp-a']], [a.mergeCommit, b.mergeCommit, r.sha['camp-b']]]);
  assert.equal(r.groups('merge-batch-done').length, 1);
  assert.equal(git(r.env.repo, 'status', '--porcelain'), '', 'the checkout followed main');
  // The rest go one at a time: the conflicting review is never merged onto an unchecked tree, the held one never merged.
  await r.pass();
  await r.pass();
  assert.equal(r.main(), b.mergeCommit);
  assert.equal(r.journal('camp-c', 'merged').length + r.journal('camp-d', 'merged').length, 0);
  assert.equal(r.runs().length, 1);
  assert.deepEqual(r.forbidden(), [], 'nothing called GitHub');
});

test('local group: a failed gate or a moved main merges none of it together, and the same group on the same base is not gated again', { skip: skipWithoutSqlite }, async (t) => {
  const r = await reviews(t, { 'camp-a': 'commit', 'camp-b': 'commit' });
  r.start();
  r.mode('fail');
  await r.pass();
  const [failing] = r.groups('merge-batch-started');
  await r.gateEnds(failing.path);
  await r.pass();
  assert.match(r.groups('merge-batch-failed')[0].reason, /the gate on the combined result exited 1/);
  assert.equal(r.groups('merge-batch-started').length, 1, 'the failed group is not gated again on the same base');
  // One at a time instead: A contains main and merges as verified; B is not merged onto that without a check of its own.
  assert.deepEqual(r.gateRows().map((row) => row.verified_sha), [r.sha['camp-a']]);
  await r.pass();
  assert.equal(r.journal('camp-b', 'merged').length, 0);

  // A recorded owner commit lands on main while a group's gate runs: the group ends before anything merges.
  const fresh = await reviews(t, { 'camp-a': 'commit', 'camp-b': 'commit' });
  fresh.start();
  fresh.mode('hold');
  await fresh.pass();
  const [held] = fresh.groups('merge-batch-started');
  writeFileSync(join(fresh.env.repo, 'owner.txt'), 'recorded by the owner\n');
  git(fresh.env.repo, 'add', 'owner.txt');
  git(fresh.env.repo, 'commit', '-q', '-m', 'owner commit');
  const owner = fresh.main();
  assert.equal(recordMainCommit(fresh.store, { repository: REPOSITORY, kind: 'owner', oldTip: fresh.anchor, newTip: owner, now: 2 }).recorded, true);
  writeFileSync(join(process.env.FAKE_REFRESH_STATE, 'release'), '');
  await fresh.gateEnds(held.path);
  await fresh.pass();
  assert.match(fresh.groups('merge-batch-failed')[0].reason, /moved/);
  assert.equal(fresh.gateRows().length, 0, 'nothing merged onto the unchecked main');
});

test('local group: a crash after main moved continues the same group, records that step once and gates nothing twice', { skip: skipWithoutSqlite }, async (t) => {
  const r = await reviews(t, { 'camp-a': 'commit', 'camp-b': 'commit' });
  r.start();
  await r.pass();
  const [started] = r.groups('merge-batch-started');
  await r.gateEnds(started.path);
  let crashed = 0;
  r.controller.injectFault = (name) => { if (name === 'after-merge' && !crashed++) throw new FencedError('synthetic crash after the ref move'); };
  await r.pass();
  assert.equal(crashed, 1);
  const first = r.main();
  assert.notEqual(first, r.anchor, 'main moved before the crash');
  assert.equal(r.gateRows().length, 0, 'the record rolled back with the crash');
  r.restart();
  await r.pass();
  await r.pass();
  const [a] = r.journal('camp-a', 'merged'), [b] = r.journal('camp-b', 'merged');
  assert.deepEqual([a.mergeCommit, a.reconciled, a.group], [first, true, started.id], 'the step on main is recorded once, as planned');
  assert.equal(r.journal('camp-a', 'merged').length, 1);
  assert.deepEqual(r.parents(b.mergeCommit), [first, r.sha['camp-b']]);
  assert.equal(r.main(), b.mergeCommit);
  assert.equal(r.tree(r.main()), r.runs()[0].tree);
  assert.equal(r.runs().length, 1, 'the group is gated once');
  assert.equal(r.groups('merge-batch-done').length, 1);
  assert.deepEqual(r.gateRows().map((row) => row.verified_sha), [r.sha['camp-a'], r.sha['camp-b']]);
});
