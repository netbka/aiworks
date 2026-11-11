// Merge groups (merges.batch, merge-batch.mjs): waiting pull requests merge after one gate run on their combined result;
// a failed or recovered group never merges unchecked trees. Split from merge-refresh.test.mjs.
import { test } from 'node:test';
import { spawnSync, A, B, C, BATCH, GATE, ON, REPOSITORY, assert, branchName, campaignStart, Controller, declaration, existsSync, git, groupRows, join, mergePass, mergeSettings, mkdirSync, passedGate, passedTree, published, readFileSync, refreshSettings, refreshStep, rmSync, sleep, Store, task, writeFileSync } from './merge-refresh-harness.mjs';

test('with merges.batch, waiting pull requests merge after one gate run on their combined result, which is what lands on the base', async (t) => {
  const { r, heads } = await published(t, { [A]: 'a.txt', [B]: 'b.txt', [C]: 'c.txt' });
  const before = r.main();
  r.start(BATCH());
  await r.controller.tick();
  const [started] = groupRows(r, 'merge-batch-started');
  assert.deepEqual(started.members.map((m) => m.sha), [heads[A], heads[B], heads[C]]);
  assert.equal(r.mergeCalls().length, 0, 'nothing merges before the combined result passed the gate');
  await r.gateEnds(started.path);
  await r.pass();
  assert.deepEqual(r.mergeCalls().map((call) => call.fields.sha), [heads[A], heads[B], heads[C]]);
  const runs = r.runs();
  assert.equal(runs.length, 1, 'one gate run for the whole group');
  assert.equal(r.tree(r.main()), runs[0].tree, 'the base now carries exactly the tree the gate ran');
  const [mergedA] = r.journal(A, 'merged'), [mergedB] = r.journal(B, 'merged');
  assert.deepEqual(r.parents(mergedA.mergeCommit), [before, heads[A]]);
  assert.deepEqual(r.parents(mergedB.mergeCommit), [mergedA.mergeCommit, heads[B]]);
  assert.deepEqual(r.parents(r.main()), [mergedB.mergeCommit, heads[C]]);
  assert.equal(groupRows(r, 'merge-batch-done').length, 1);
  for (const id of [A, B, C]) {
    assert.equal(r.journal(id, 'merge-refresh-started').length, 0, `${id}: no gate of its own`);
    assert.equal(r.journal(id, 'merge-base-moved').length, 0, `${id}: no repair round`);
  }
});

test('a group whose gate fails merges none of it together; each pull request then goes alone through its own checked tree', async (t) => {
  const { r, heads } = await published(t, { [A]: 'a.txt', [B]: 'b.txt' });
  r.mode('fail');
  r.start(BATCH());
  await r.controller.tick();
  const [started] = groupRows(r, 'merge-batch-started');
  await r.gateEnds(started.path);
  r.mode('pass');
  await r.pass();
  assert.match(groupRows(r, 'merge-batch-failed')[0].reason, /the gate on the combined result exited 1/);
  // Alone, A's verified head contains the base and merges as verified; B is not merged onto it without a gate of its own.
  assert.deepEqual(r.mergeCalls().map((call) => call.fields.sha), [heads[A]]);
  await r.pass();
  const [refresh] = r.journal(B, 'merge-refresh-started');
  assert.equal(refresh.sha, heads[B]);
  assert.equal(r.mergeCalls().length, 1);
  assert.equal(groupRows(r, 'merge-batch-started').length, 1, 'the failed group is not gated again');
});

test('a recovered group merge is never repeated and its actual tree is checked before the next merge', async (t) => {
  for (const movedBase of [false, true]) await t.test(movedBase ? 'unexpected recovered tree stops the group' : 'checked recovered tree continues', async (t) => {
  const { r, heads } = await published(t, { [A]: 'a.txt', [B]: 'b.txt' });
  r.start(BATCH());
  await r.controller.tick();
  const [started] = groupRows(r, 'merge-batch-started');
  await r.gateEnds(started.path);
  writeFileSync(join(r.env.env.FAKE_GH_STATE, 'lose-merge-response'), '');
  await r.pass();
  assert.equal(r.mergeCalls().length, 1);
  assert.equal(r.journal(A, 'merged').length, 0, 'the outcome is unknown');
  if (movedBase) {
    // Model the base advancing immediately before GitHub merged A, with its response lost.
    git(r.env.repo, 'fetch', 'origin', 'main');
    git(r.env.repo, 'checkout', '--detach', started.base);
    writeFileSync(join(r.env.repo, 'concurrent.txt'), 'concurrent base change\n');
    git(r.env.repo, 'add', 'concurrent.txt');
    git(r.env.repo, 'commit', '-qm', 'Concurrent base update');
    const parent = git(r.env.repo, 'rev-parse', 'HEAD');
    const tree = git(r.env.repo, 'merge-tree', '--write-tree', parent, heads[A]).split('\n')[0];
    const actual = git(r.env.repo, 'commit-tree', tree, '-p', parent, '-p', heads[A], '-m', 'Merge A after concurrent base update');
    git(r.env.repo, 'push', 'origin', `${actual}:refs/heads/concurrent-result`);
    git(r.env.origin, 'update-ref', 'refs/heads/main', actual, r.main());
    const file = join(r.env.env.FAKE_GH_STATE, 'prs.json');
    const prs = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify(prs.map((pr) => pr.merged ? { ...pr, mergeCommit: actual } : pr)));
    assert.notEqual(tree, started.members[0].tree);
  }
  r.start(BATCH()); // a restart
  await r.pass();
  await r.pass();
  if (movedBase) {
    assert.equal(r.mergeCalls().length, 1, 'B is not merged onto the unexpected recovered result');
    assert.match(groupRows(r, 'merge-batch-stopped')[0].reason, /recovered merge.*checked tree and parents/);
    return;
  }
  assert.deepEqual(r.mergeCalls().map((call) => call.fields.sha), [heads[A], heads[B]], 'A was never merged twice');
  assert.equal(r.journal(A, 'merged')[0].reconciled, true);
  assert.equal(r.tree(r.main()), r.runs()[0].tree);
  assert.equal(groupRows(r, 'merge-batch-done').length, 1);
  });
});
