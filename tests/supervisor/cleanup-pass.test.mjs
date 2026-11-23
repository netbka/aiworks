// aiworks#119: the cleanup pass runs inside the controller tick, every integrationPollMs. With one git process per
// finished task it held the event loop past the lease on a large installation, so the leases lapsed on every pass. The
// Git work of a pass must not grow with the number of finished tasks. The real controller, store, checkout and git run
// here; a wrapper counts each git process. The base read is the only stub. No network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, skipWithoutSqlite, SQLITE } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const { campaignStart } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const { cleanupPass } = SQLITE ? await import('../../src/supervisor/cleanup.mjs') : {};

test('a cleanup pass starts as many git processes for 160 finished tasks as for 32', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment({ config: { cleanup: { enabled: true } } });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const calls = join(env.tmp, 'git-calls'), counting = join(env.tmp, 'counting-git.mjs');
  writeFileSync(counting, `import { appendFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\n` +
    `appendFileSync(${JSON.stringify(calls)}, 'x');\nconst run = spawnSync('git', process.argv.slice(2), { stdio: 'inherit', windowsHide: true });\nprocess.exit(run.status ?? 1);\n`);
  const started = () => (existsSync(calls) ? readFileSync(calls, 'utf8').length : 0);
  const main = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: env.repo, encoding: 'utf8', windowsHide: true }).stdout.trim();

  // A finished campaign of 32 tasks, each with its own task branch name; none of them has a worktree or branch left.
  const finish = (campaignId) => {
    campaignStart(store, declaration({ campaignId, tasks: Array.from({ length: 32 }, (_, at) => ({ id: `T${at}`, issue: 700 + at,
      title: `task ${at}`, deliverable: 'commit', goal: 'Produce it.', dependsOn: [], acceptance: ['it exists'], references: ['AGENTS.md'] })) }));
    store.patch('campaigns', { id: campaignId }, store.campaign(campaignId).version, { control: 'finished' }, Date.now());
  };
  let now = Date.now();
  const config = { ...env.config, commands: { ...env.config.commands, git: [process.execPath, counting] } };
  const controller = new Controller({ store, config, dataDir: env.dataDir, now: () => now, fault: null, sampler: { sample: () => null } });
  controller.fetchBase = async () => ({ ok: true, sha: main, failure: null });
  const pass = async () => {
    now += controller.config.integrationPollMs + 1;
    const before = started();
    assert.ok(await cleanupPass(controller), 'the pass ran');
    return started() - before;
  };

  finish('finished-0');
  const few = await pass();
  for (let at = 1; at < 5; at++) finish(`finished-${at}`);
  assert.equal(await pass(), few, 'the git processes of a pass do not grow with its finished tasks');
});
