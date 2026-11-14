// BASE-HOLD (merge-refresh.mjs, merge.mjs): a refreshed head keeps its checked base without merging stale or unverified
// work, starving siblings or preempting a group. Split from merge-refresh.test.mjs so each file fits the runner's file limit.
import { test } from 'node:test';
import { spawnSync, A, B, C, BATCH, GATE, ON, REPOSITORY, assert, branchName, campaignStart, Controller, declaration, existsSync, git, groupRows, join, mergePass, mergeSettings, mkdirSync, passedGate, passedTree, published, readFileSync, refreshSettings, refreshStep, rmSync, sleep, Store, task, writeFileSync } from './merge-refresh-harness.mjs';

test('BASE-HOLD preserves a checked base without merging stale or unverified work, starving eligible siblings or preempting a group',
  { skip: process.platform !== 'win32' ? 'Windows Job Object custody for synthetic refresh gates' : false }, async (t) => {
    const pass = async (r) => { r.controller.mergeCheckedAt.clear(); await mergePass(r.controller); };
    const url = (r, id) => r.store.tasks(id)[0].pr_url;
    const advanceBase = (r, name) => {
      git(r.env.repo, 'fetch', 'origin', 'main');
      git(r.env.repo, 'checkout', '--detach', r.main());
      writeFileSync(join(r.env.repo, `${name}.txt`), `${name}\n`);
      git(r.env.repo, 'add', '-A'); git(r.env.repo, 'commit', '-qm', name);
      git(r.env.repo, 'push', 'origin', 'HEAD:main');
      return r.main();
    };
    // Settle the real refresh state machine without invoking its subsequent merge. This models a supervisor restart
    // after its gate passed; no fabricated passed journal row substitutes for the synthetic gate and exact tree check.
    const refresh = async (r, id, base = r.main()) => {
      git(r.env.repo, 'fetch', 'origin', 'main');
      const task = r.store.tasks(id)[0], campaign = r.store.campaign(id);
      const lease = r.store.acquireLease(id, r.controller.instanceId, r.controller.now(), r.controller.config.leaseMs, r.controller.codeRevision);
      assert.ok(lease); r.controller.held.set(id, lease.generation);
      const ctx = { id, generation: lease.generation }, item = { campaignId: id, decl: campaign.declaration, task };
      const step = () => refreshStep(r.controller, ctx, item, r.env.repo, base, refreshSettings({ command: GATE }));
      assert.equal((await step()).next, 'wait');
      const started = r.journal(id, 'merge-refresh-started').at(-1);
      await r.gateEnds(started.path);
      assert.deepEqual(await step(), { tree: started.tree, next: 'merge' });
      assert.equal(passedTree(r.store, id, task.task_id, task.verified_sha, base), started.tree);
      return started;
    };

    await t.test('a competing real lease holds this base for the later refreshed head, then normal siblings batch in age order', async (t) => {
      const D = 'camp-d';
      const { r, heads } = await published(t, { [A]: 'a.txt', [B]: 'b.txt', [C]: 'c.txt', [D]: 'd.txt' }, { branches: { [D]: 'release' } });
      const base = advanceBase(r, 'external-before-refresh'), checked = await refresh(r, B, base);
      r.start(BATCH()); // reads the durable proof after a restart
      const other = r.store.acquireLease(B, 'another-supervisor', r.controller.now(), 60_000, r.controller.codeRevision);
      assert.ok(other);
      const acquire = r.store.acquireLease.bind(r.store); let actualRefusal = false;
      r.store.acquireLease = (...args) => {
        const result = acquire(...args);
        if (args[0] === B && args[1] === r.controller.instanceId && result === null) actualRefusal = true;
        return result;
      };
      try { await pass(r); } finally { r.store.acquireLease = acquire; }
      assert.equal(actualRefusal, true, 'the actual lease acquisition, not a pre-read, refused');
      assert.equal(r.main(), base);
      assert.deepEqual(r.mergeCalls().map((call) => call.fields.sha), [heads[D]], 'a busy main does not hold an independent base branch');
      assert.equal(r.parents(r.env.remoteHead('release'))[1], heads[D]);
      assert.equal(r.journal(A, 'merge-refresh-started').length, 0, 'a sibling cannot spend a new gate to move the held base');
      assert.equal(groupRows(r, 'merge-batch-started').length, 0);
      r.store.releaseLease(B, 'another-supervisor', other.generation, r.controller.now());
      await pass(r);
      assert.deepEqual(r.mergeCalls().map((call) => call.fields.sha), [heads[D], heads[B]]);
      assert.deepEqual(r.parents(r.main()), [base, heads[B]]);
      assert.equal(r.tree(r.main()), checked.tree);
      assert.equal(r.runs().length, 1, 'the accepted refresh is not repeated');
      await pass(r);
      const group = groupRows(r, 'merge-batch-started').at(-1);
      assert.deepEqual(group.members.map((member) => member.sha), [heads[A], heads[C]], 'remaining order is stable');
      await r.gateEnds(group.path); await pass(r);
      assert.deepEqual(r.mergeCalls().map((call) => call.fields.sha), [heads[D], heads[B], heads[A], heads[C]]);
    });

    await t.test('a passed refresh never authorizes an unverified remote head or a task without verification', async (t) => {
      const { r, heads } = await published(t, { [A]: 'a.txt', [B]: 'b.txt' });
      await refresh(r, B);
      git(r.env.repo, 'checkout', '--detach', heads[B]);
      writeFileSync(join(r.env.repo, 'unverified.txt'), 'not checked\n');
      git(r.env.repo, 'add', '-A'); git(r.env.repo, 'commit', '-qm', 'unverified change');
      const changed = git(r.env.repo, 'rev-parse', 'HEAD');
      git(r.env.repo, 'push', 'origin', `${changed}:refs/heads/${branchName(B, 'B1')}`);
      r.start({ merges: { ...ON().merges, held: { [url(r, A)]: 'synthetic hold' } } });
      const base = r.main(); await pass(r);
      assert.equal(r.main(), base); assert.deepEqual(r.mergeCalls(), []);
      const task = r.store.task(B, 'B1');
      r.store.patch('tasks', { campaign_id: B, task_id: 'B1' }, task.version, { verified_sha: null, verification: null }, r.controller.now());
      await pass(r);
      assert.equal(r.main(), base); assert.deepEqual(r.mergeCalls(), []);
      assert.equal(r.runs().length, 1);
    });

    await t.test('external base movement invalidates the old priority proof and requires a new exact merge-result check', async (t) => {
      const { r, heads } = await published(t, { [A]: 'a.txt', [B]: 'b.txt' });
      const old = await refresh(r, B), base = advanceBase(r, 'external-after-refresh');
      r.start({ merges: { ...ON().merges, held: { [url(r, A)]: 'synthetic hold' } } });
      await pass(r);
      assert.deepEqual(r.mergeCalls(), []);
      assert.equal(passedTree(r.store, B, 'B1', heads[B], base), null);
      const next = r.journal(B, 'merge-refresh-started').at(-1);
      assert.equal(next.base, base); assert.notEqual(next.base, old.base);
      await r.gateEnds(next.path); await pass(r);
      assert.deepEqual(r.mergeCalls().map((call) => call.fields.sha), [heads[B]]);
      assert.deepEqual(r.parents(r.main()), [base, heads[B]]);
      assert.equal(r.tree(r.main()), next.tree);
      assert.equal(r.runs().length, 2);
    });

    for (const blocked of ['owner-held', 'nonmergeable', 'backoff']) await t.test(`${blocked} refreshed work does not starve compatible siblings`, async (t) => {
      const { r, heads } = await published(t, { [A]: 'a.txt', [B]: 'b.txt', [C]: 'c.txt' });
      await refresh(r, B);
      if (blocked === 'nonmergeable') writeFileSync(join(r.env.env.FAKE_GH_STATE, 'mergeable.json'), JSON.stringify({ [url(r, B)]: false }));
      r.start({ merges: { ...BATCH().merges, ...(blocked === 'owner-held' ? { held: { [url(r, B)]: 'synthetic hold' } } : {}) } });
      if (blocked === 'backoff') for (let i = 0; i < 2; i++) r.store.journal(B, 'merge-refused', { task: 'B1', sha: heads[B], url: url(r, B) }, r.controller.now());
      await pass(r);
      const group = groupRows(r, 'merge-batch-started').at(-1);
      assert.ok(group, 'an ineligible preferred candidate cannot suppress an eligible batch');
      assert.deepEqual(group.members.map((member) => member.sha), [heads[A], heads[C]]);
      await r.gateEnds(group.path); await pass(r);
      assert.deepEqual(r.mergeCalls().map((call) => call.fields.sha), [heads[A], heads[C]]);
    });

    await t.test('an open batch keeps its checked member order when a later member obtains separate priority', async (t) => {
      const { r, heads } = await published(t, { [A]: 'a.txt', [B]: 'b.txt', [C]: 'c.txt' });
      r.start(BATCH()); await pass(r);
      const group = groupRows(r, 'merge-batch-started').at(-1);
      await r.gateEnds(group.path);
      await refresh(r, C, group.base);
      r.start(BATCH()); await pass(r);
      assert.deepEqual(r.mergeCalls().map((call) => call.fields.sha), [heads[A], heads[B], heads[C]]);
      assert.equal(groupRows(r, 'merge-batch-started').length, 1);
      assert.equal(groupRows(r, 'merge-batch-done').length, 1);
      assert.equal(r.tree(r.main()), r.runs()[0].tree, 'the existing group result is what lands');
    });
  });
