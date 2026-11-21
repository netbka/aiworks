import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../src/supervisor/controller.mjs';
import { Store } from '../../src/supervisor/store.mjs';
import { declaration, environment, skipWithoutSqlite } from './helpers.mjs';

const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};

// A private term the target's base already holds shows that repository's readers nothing new, so it is exempt there. A
// term only a worker's verified head holds stays private: otherwise a worker could publish a term by writing it into its
// own change. A search that cannot run exempts nothing.
test('only a term the target base holds is exempt, never one only the verified head holds', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  writeFileSync(join(env.repo, 'NOTES.md'), 'Runs beside Fictional_Base_Host.\n');
  git(env.repo, 'add', '-A');
  git(env.repo, 'commit', '-q', '-m', 'base');
  git(env.repo, 'push', '-q', 'origin', 'main');
  // The worker's verified head, pushed and checked out in the target checkout itself.
  git(env.repo, 'checkout', '-q', '-b', 'campaign/test-campaign/T1');
  writeFileSync(join(env.repo, 'WORK.md'), 'Calls fictional-head-host.\n');
  git(env.repo, 'add', '-A');
  git(env.repo, 'commit', '-q', '-m', 'worker change');
  git(env.repo, 'push', '-q', 'origin', 'campaign/test-campaign/T1');
  // Written after the commits, so the terms file itself is tracked nowhere.
  mkdirSync(join(env.repo, '.local'));
  writeFileSync(join(env.repo, '.local', 'publication.json'), JSON.stringify({ privateTerms: ['fictional-base-host', 'fictional-head-host'] }));
  const decl = declaration();

  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  controller.log = () => {};
  const present = await controller.presentTerms(decl);
  assert.ok(present.includes('fictional-base-host'), 'the base holds it, in another case and with an underscore');
  assert.ok(!present.includes('fictional-head-host'), 'only the verified head holds it');
  const terms = controller.publicationTerms(decl, present);
  assert.ok(!terms.includes('fictional-base-host'));
  assert.ok(terms.includes('fictional-head-host'));

  // A git whose search fails, while its fetch and reads work: nothing is exempt.
  const failing = join(env.tmp, 'failing-grep.mjs');
  writeFileSync(failing, `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('grep')) process.exit(2);
process.exit(spawnSync('git', args, { stdio: 'inherit', windowsHide: true }).status ?? 1);
`);
  const broken = new Controller({ store, config: { ...env.config, commands: { ...env.config.commands, git: [process.execPath, failing] } }, dataDir: env.dataDir, fault: null });
  broken.log = () => {};
  assert.equal((await broken.fetchBase(env.repo, 'main', decl.target.repository, { fresh: true })).ok, true, 'the base itself is readable');
  assert.deepEqual(await broken.presentTerms(decl), []);
});
