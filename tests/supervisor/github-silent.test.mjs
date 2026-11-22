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

/** A gh that records each start in `started`, then never answers. */
function silentGh(env) {
  const started = join(env.tmp, 'gh-started'), script = join(env.tmp, 'silent-gh.mjs');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(started)}, 'x');\nsetInterval(() => {}, 1000);\n`);
  return { command: [process.execPath, script], starts: () => (existsSync(started) ? readFileSync(started, 'utf8').length : 0) };
}

/** The base, read into the supervisor's base ref, and a published head outside it. */
function publishedHead(env) {
  const base = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'update-ref', 'refs/aiworks/base/main', base);
  git(env.repo, 'checkout', '-qb', 'published');
  writeFileSync(join(env.repo, 'published.txt'), 'published work\n');
  git(env.repo, 'add', '-A'); git(env.repo, 'commit', '-qm', 'published work');
  const head = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'checkout', '-q', 'main');
  return { base, head };
}

test('a GitHub that does not answer costs admission one bounded read and never stops the lease renewal', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });

  const gh = silentGh(env);
  const config = { ...env.config, githubReadMs: 2000, commands: { ...env.config.commands, gh: gh.command } };

  // Three published heads outside the base hold the domain a waiting task needs.
  const holders = ['H1', 'H2', 'H3'];
  campaignStart(store, declaration({ campaignId: 'holding', tasks: holders.map((id, at) => step(id, 901 + at)) }));
  campaignStart(store, declaration({ campaignId: 'waiting', tasks: [step('W1', 911)] }));
  const { base, head } = publishedHead(env);
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
  assert.equal(gh.starts(), 1, 'one silent read; the other holders wait for the next pass');
  assert.ok(ended - began < 2 * config.githubReadMs + 10_000, 'the pass ends within one read bound and the stop of its process tree');
  const now = store.lease('waiting');
  assert.deepEqual([now.instance_id, now.generation], [controller.instanceId, lease.generation], 'the lease was never lost');
  assert.equal(controller.mergedHeads.size, 0, 'an unanswered read never counts a head as merged');
});

// The receipt that ends an integration repair round merged elsewhere (aiworks#207) is read before the fence. Unread because
// GitHub did not answer, the round must not run this tick: its pull request may already be merged, and the run is paid.
test('a repair round whose merge receipt GitHub did not answer gets no paid run, and is read again next tick', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment({ config: { integrationRepair: { enabled: true }, scheduler: { enabled: true, maxWorkers: 4 } } });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const gh = silentGh(env);
  const config = { ...env.config, githubReadMs: 1500, commands: { ...env.config.commands, gh: gh.command } };

  // R1 is an open repair round of a published head outside the base, as reopenPublished leaves it.
  campaignStart(store, declaration({ campaignId: 'repairing', tasks: [step('R1', 921)] }));
  const { base, head } = publishedHead(env);
  const row = store.task('repairing', 'R1');
  store.patch('tasks', { campaign_id: 'repairing', task_id: 'R1' }, row.version, {
    state: 'pending', head_sha: head, verified_sha: head, base_sha: head, pr_url: 'https://github.com/example-org/sampleapp/pull/31',
    findings: [{ id: 'integration-conflict', severity: 'blocking', base, verified: head, paths: ['published.txt'], commits: [], description: 'conflict' }],
  }, Date.now());

  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null, sampler: { sample: () => null } });
  controller.fetchBase = async () => ({ ok: true, sha: base, failure: null });
  const pass = async () => {
    controller.candidates = [];
    await controller.githubPass(() => controller.step('repairing'));
    return controller.candidates.filter((candidate) => candidate.taskId === 'R1').length;
  };

  assert.equal(await pass(), 0, 'no run is admitted for a round whose receipt was not read');
  assert.equal(store.task('repairing', 'R1').state, 'pending', 'an unread receipt ends nothing');
  assert.equal(gh.starts(), 1);
  assert.equal(await pass(), 0);
  assert.equal(gh.starts(), 2, 'the next tick reads the receipt again, without waiting for the integration poll');

  // GitHub answers: the pull request is not merged, so the round runs.
  controller.cmd.gh = env.config.commands.gh;
  assert.equal(await pass(), 1, 'a round whose receipt was read is scheduled as before');
});
