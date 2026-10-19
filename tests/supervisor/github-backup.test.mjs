// LO L9 (docs/design/LOCAL_OPERATION.md sections 4.6 and 6, slice SELF9): the optional backup of trusted local main to a
// disposable bare remote. Only the ledger's trusted tip is pushed, never a forced update or an unrecorded commit; a
// refused or unreachable remote is recorded and the next local merge still happens; attempts are once per 10 minutes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart, campaignStatus } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { mergePass, mergeSettings } from '../../src/supervisor/merge.mjs';
import { mainLedger, recordAnchor } from '../../src/supervisor/self-hosting.mjs';
import { createItem } from '../../src/supervisor/work-list.mjs';
import { declaration, environment, runUntil, skipWithoutSqlite } from './helpers.mjs';

const REPOSITORY = 'example-org/sampleapp';
const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

/** A Git wrapper that records every push's arguments and runs it; a gh that refuses every call. */
function wrappers(dir) {
  const pushes = join(dir, 'pushes.log'), gh = join(dir, 'gh.log');
  writeFileSync(join(dir, 'git-log.mjs'), `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(3);
if (args.includes('push')) appendFileSync(process.argv[2], JSON.stringify(args) + '\\n');
process.exit(spawnSync('git', args, { stdio: 'inherit', windowsHide: true }).status ?? 1);
`);
  writeFileSync(join(dir, 'gh-refuse.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + '\\n');
process.exit(97);
`);
  return { pushes, gh, commands: { git: [process.execPath, join(dir, 'git-log.mjs'), pushes], gh: [process.execPath, join(dir, 'gh-refuse.mjs'), gh] } };
}

/** The self-hosted repository, anchored, with the merge gate and the backup to the remote `backup` switched on. */
function installation(t, backupUrl) {
  const env = environment();
  const wrapped = wrappers(env.tmp);
  const config = { ...env.config, commands: { ...env.config.commands, ...wrapped.commands },
    selfHosting: { repository: REPOSITORY, trustedMain: 'local', backup: { enabled: true, remote: 'backup', branch: 'main' } } };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const anchor = git(env.repo, 'rev-parse', 'main');
  git(env.repo, 'update-ref', 'refs/remotes/origin/main', anchor);
  assert.equal(recordAnchor(store, { repoPath: env.repo, repository: REPOSITORY, sha: anchor, now: 1 }).recorded, true);
  git(env.repo, 'remote', 'remove', 'origin');
  git(env.repo, 'remote', 'add', 'backup', backupUrl(env));
  for (const number of [437, 438, 443]) createItem(store, { number, kind: 'task', title: `synthetic item ${number}`, authorKind: 'import', now: 1 });
  let offset = 0;
  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  controller.merges = mergeSettings({ merges: { delegatedTo: 'supervisor', repositories: [REPOSITORY] } });
  controller.now = () => Date.now() + offset;
  const pass = async () => { controller.mergeCheckedAt.clear(); controller.mergeWaits.clear(); await mergePass(controller); };
  /** Run one synthetic campaign to a verified local review. */
  const deliver = async (campaignId, issue) => {
    const d = declaration({ campaignId, tasks: [{ ...declaration().tasks[0], issue }] });
    campaignStart(store, d);
    await runUntil(controller, store, campaignId, (c) => c.control === 'finished');
    return store.task(campaignId, 'T1').verified_sha;
  };
  const backups = () => store.all("SELECT kind, detail FROM journal WHERE kind LIKE 'backup-%' ORDER BY seq").map((row) => ({ kind: row.kind, ...row.detail }));
  const merges = () => mainLedger(store, REPOSITORY).filter((row) => row.kind === 'gate-merge').map((row) => row.new_tip);
  const status = (id) => campaignStatus(store, id, controller.now(), { config }).selfHosting;
  return { env, wrapped, store, controller, anchor, pass, deliver, backups, merges, status, later: (ms) => { offset += ms; } };
}

/** Every push named the trusted tip as a plain refspec: no force, no `+`, no mirror, no tags. */
function plainPushes(file) {
  for (const args of lines(file)) {
    assert.ok(!args.some((arg) => /^(-f|--force.*|--mirror|--tags|--all|--delete|-d)$/.test(arg) || arg.startsWith('+')), JSON.stringify(args));
    assert.match(args.at(-1), /^[0-9a-f]{40}:refs\/heads\/main$/);
  }
}

test('LO L9: a diverged backup remote is refused and left unchanged, never forced, and the refused tip is not pushed again', { skip: skipWithoutSqlite }, async (t) => {
  const { env, wrapped, controller, anchor, pass, deliver, backups, merges, status, later } = installation(t, (env) => {
    // Someone merged on the remote: its main has a commit local main does not.
    const remote = join(env.tmp, 'backup.git'), clone = join(env.tmp, 'other');
    git(env.tmp, 'init', '-q', '--bare', '-b', 'main', remote);
    git(env.repo, 'push', '-q', remote, 'main');
    git(env.tmp, 'clone', '-q', remote, clone);
    writeFileSync(join(clone, 'remote-only.txt'), 'merged elsewhere\n');
    git(clone, 'add', '-A');
    git(clone, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-q', '-m', 'remote only');
    git(clone, 'push', '-q', 'origin', 'main');
    return remote;
  });
  const remote = join(env.tmp, 'backup.git'), diverged = git(remote, 'rev-parse', 'main');
  assert.notEqual(diverged, anchor);
  const id = 'backup-refused';
  await deliver(id, 437);
  await pass();
  assert.equal(merges().length, 1, 'the local merge happened');
  assert.deepEqual(backups().map((entry) => [entry.kind, entry.tip]), [['backup-requested', merges()[0]], ['backup-refused', merges()[0]]]);
  assert.equal(git(remote, 'rev-parse', 'main'), diverged, 'the remote is unchanged');
  assert.equal(status(id).backup.state, 'refused');
  assert.equal(status(id).backup.current, false);

  later(11 * 60_000);
  await pass();
  assert.equal(backups().length, 2, 'a refused tip waits for the next merge, never a force');
  assert.equal(git(remote, 'rev-parse', 'main'), diverged);
  plainPushes(wrapped.pushes);
  assert.equal(lines(wrapped.pushes).length, 1);
  assert.deepEqual(lines(wrapped.gh), []);
  assert.equal(controller.store.campaign(id).control, 'finished');
});

test('LO L9: an unreachable remote does not hold the next merge; retries are bounded; only the trusted tip is ever pushed', { skip: skipWithoutSqlite }, async (t) => {
  const { env, wrapped, store, anchor, pass, deliver, backups, merges, status, later } = installation(t, (env) => join(env.tmp, 'missing.git'));
  await deliver('backup-first', 437);
  await pass();
  assert.equal(merges().length, 1);
  assert.deepEqual(backups().map((entry) => entry.kind), ['backup-requested', 'backup-failed']);
  assert.equal(status('backup-first').backup.state, 'failed');

  // The next verified review merges at once, and the backup does not try again within 10 minutes.
  await deliver('backup-second', 438);
  await pass();
  assert.equal(merges().length, 2, 'the failed backup held nothing');
  assert.equal(git(env.repo, 'rev-parse', 'main'), merges()[1]);
  assert.equal(backups().length, 2, 'no second attempt within the interval');
  assert.equal(lines(wrapped.pushes).length, 1);

  // The remote comes back and someone commits on main by hand: after the interval only the trusted tip is pushed.
  const remote = join(env.tmp, 'missing.git');
  git(env.tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  writeFileSync(join(env.repo, 'owner.txt'), 'by hand\n');
  git(env.repo, 'add', 'owner.txt');
  git(env.repo, 'commit', '-q', '-m', 'unrecorded');
  const view = status('backup-second');
  assert.deepEqual([view.trustedTip, view.unrecordedCount, view.main], [merges()[1], 1, git(env.repo, 'rev-parse', 'main')]);
  later(11 * 60_000);
  await pass();
  assert.deepEqual(backups().slice(2).map((entry) => [entry.kind, entry.tip]), [['backup-requested', merges()[1]], ['backup-pushed', merges()[1]]]);
  assert.equal(git(remote, 'rev-parse', 'main'), merges()[1], 'the remote has the trusted tip, not the unrecorded commit');
  assert.equal(status('backup-second').backup.current, true);
  later(11 * 60_000);
  await pass();
  assert.equal(backups().length, 4, 'a pushed tip is not pushed again');
  plainPushes(wrapped.pushes);
  assert.notEqual(anchor, merges()[1]);
  assert.equal(store.all("SELECT 1 FROM journal WHERE kind = 'merge-refused'").length, 0);
});
