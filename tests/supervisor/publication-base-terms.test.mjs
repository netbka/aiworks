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

// A git that names the target's GitHub repository as `origin` while it fetches from the local test origin, and whose
// search fails with `failGrep`; every other call goes to the real git.
function wrappedGit(env, name, { failGrep = false } = {}) {
  const path = join(env.tmp, `${name}.mjs`);
  writeFileSync(path, `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === 'remote' && args[1] === 'get-url') { console.log('https://github.com/example-org/sampleapp.git'); process.exit(0); }
if (${failGrep} && args[0] === 'grep') process.exit(2);
process.exit(spawnSync('git', args, { stdio: 'inherit', windowsHide: true }).status ?? 1);
`);
  return [process.execPath, path];
}

// A private term the target's base already holds as a word shows that repository's readers nothing new, so it is exempt
// there. A term only a worker's verified head holds stays private: otherwise a worker could publish a term by writing it
// into its own change. A term inside a longer word (git grep -w sees only ASCII word characters, so a non-ASCII term
// never qualifies), a search that fails and an origin not shown to be the target exempt nothing.
test('only a term the target base holds is exempt, never one only the verified head holds', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  writeFileSync(join(env.repo, 'NOTES.md'), 'Runs beside Fictional_Base_Host and fictional-long-hostname, see вымысловский-сервис.\n');
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
  writeFileSync(join(env.repo, '.local', 'publication.json'),
    JSON.stringify({ privateTerms: ['fictional-base-host', 'fictional-head-host', 'fictional-long-host', 'вымыслов'] }));
  const decl = declaration();
  const controller = (gitCommand) => {
    const made = new Controller({ store, config: { ...env.config, commands: { ...env.config.commands, ...(gitCommand ? { git: gitCommand } : {}) } },
      dataDir: env.dataDir, fault: null });
    made.log = () => {};
    return made;
  };

  const ctl = controller(wrappedGit(env, 'github-origin'));
  const present = await ctl.presentTerms(decl);
  assert.ok(present.includes('fictional-base-host'), 'the base holds it, in another case and with an underscore');
  assert.ok(!present.includes('fictional-head-host'), 'only the verified head holds it');
  assert.ok(!present.includes('fictional-long-host'), 'the base holds only a longer word that contains it');
  assert.ok(!present.includes('вымыслов'), 'the base holds only a longer Cyrillic word that contains it');
  const terms = ctl.publicationTerms(decl, present);
  assert.ok(!terms.includes('fictional-base-host'));
  assert.ok(terms.includes('fictional-head-host'));
  assert.ok(terms.includes('fictional-long-host'));

  // The real git: origin is a local folder, not shown to be the target repository.
  assert.deepEqual(await controller(null).presentTerms(decl), []);
  // A search that fails, while the remote, the fetch and the base read work.
  const broken = controller(wrappedGit(env, 'failing-grep', { failGrep: true }));
  assert.equal((await broken.fetchBase(env.repo, 'main', decl.target.repository, { fresh: true })).ok, true, 'the base itself is readable');
  assert.deepEqual(await broken.presentTerms(decl), []);
});
