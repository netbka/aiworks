// aiworks#119: a GitHub that does not answer must not stop the core loop. Admission reads the merge receipt of every
// published but unmerged head that holds a waiting task's write domain. Read blocking, a silent GitHub held the event
// loop for one bounded read per holder: the lease timer could not run, the leases lapsed and the next fenced write was
// refused, tick after tick. The real controller, store and checkout run here; gh is a synthetic command that never
// answers, and the base read is the only stub. No network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, skipWithoutSqlite, SQLITE } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const { campaignStart } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const step = (id, issue) => ({ id, issue, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`, dependsOn: [],
  acceptance: [`${id} exists`], references: ['AGENTS.md'], writes: ['shared/'] });

test('a GitHub that does not answer costs admission one bounded read and never stops the lease renewal', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });

  // gh records that it started, then never answers.
  const started = join(env.tmp, 'gh-started'), silentGh = join(env.tmp, 'silent-gh.mjs');
  writeFileSync(silentGh, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(started)}, 'x');\nsetInterval(() => {}, 1000);\n`);
  const config = { ...env.config, githubReadMs: 2000, commands: { ...env.config.commands, gh: [process.execPath, silentGh] } };

  // Three published heads outside the base hold the domain a waiting task needs.
  const holders = ['H1', 'H2', 'H3'];
  campaignStart(store, declaration({ campaignId: 'holding', tasks: holders.map((id, at) => step(id, 901 + at)) }));
  campaignStart(store, declaration({ campaignId: 'waiting', tasks: [step('W1', 911)] }));
  const base = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'update-ref', 'refs/aiworks/base/main', base);
  git(env.repo, 'checkout', '-qb', 'published');
  writeFileSync(join(env.repo, 'published.txt'), 'published work\n');
  git(env.repo, 'add', '-A'); git(env.repo, 'commit', '-qm', 'published work');
  const head = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'checkout', '-q', 'main');
  holders.forEach((id, at) => {
    const row = store.task('holding', id);
    store.patch('tasks', { campaign_id: 'holding', task_id: id }, row.version,
      { state: 'done', head_sha: head, verified_sha: head, pr_url: `https://github.com/example-org/sampleapp/pull/${21 + at}` }, Date.now());
  });

  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  const lease = store.acquireLease('waiting', controller.instanceId, Date.now(), config.leaseMs);
  controller.held.set('waiting', lease.generation);
  controller.candidates = [{ campaignId: 'waiting', taskId: 'W1', ctx: { id: 'waiting', generation: lease.generation } }];
  controller.fetchBase = async () => ({ ok: true, sha: base, failure: null });

  // The serve loop's lease timer, and every renewal it makes.
  const renewedAt = [], renewLease = store.renewLease.bind(store);
  store.renewLease = (...args) => { renewedAt.push(performance.now()); return renewLease(...args); };
  const timer = setInterval(() => controller.renewOnTimer(), 100);

  const refusals = [{ candidate: { campaignId: 'waiting', taskId: 'W1' },
    refusal: { reason: 'write-domain', detail: { holders: holders.map((taskId) => ({ campaignId: 'holding', taskId, reason: 'published-unmerged' })) } } }];
  const began = performance.now();
  await controller.githubPass(() => controller.refreshPublished(refusals));
  const ended = performance.now();
  clearInterval(timer);

  assert.ok(renewedAt.some((at) => at > began && at < ended), 'the lease timer renewed the lease while GitHub was silent');
  assert.equal(existsSync(started) ? readFileSync(started, 'utf8').length : 0, 1, 'one silent read; the other holders wait for the next pass');
  assert.ok(ended - began < 2 * config.githubReadMs + 10_000, 'the pass ends within one read bound and the stop of its process tree');
  const now = store.lease('waiting');
  assert.deepEqual([now.instance_id, now.generation], [controller.instanceId, lease.generation], 'the lease was never lost');
  assert.equal(controller.mergedHeads.size, 0, 'an unanswered read never counts a head as merged');
});
