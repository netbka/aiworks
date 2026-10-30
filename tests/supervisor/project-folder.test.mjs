// AW-018: merged results land in the project's own folder. A GitHub project's configured folder is fast-forwarded to the
// merged base after a merge AIWorks recorded, only while its base branch is checked out and clean; otherwise it is left
// as it is with the reason recorded and tried again after the next merge. A checked result of a project without GitHub
// is applied by AIWorks itself through the owner's Apply adapters, with a backup; a file the owner changed since the
// baseline is never written over, and Undo apply restores the folder. AIWorks's own runtime checkout is never written.
// Disposable repositories and folders, a synthetic origin and a synthetic caller check: no network, model or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { FOLDER_LEFT, FOLDER_UPDATED, updateFolder } from '../../src/supervisor/merge.mjs';
import { SNAPSHOT_DIR } from '../../src/supervisor/adapters/mirror.mjs';
import { checkCaller } from '../../src/supervisor/local-admission.mjs';
import { recordCandidate } from '../../src/supervisor/local-candidates.mjs';
import { connectFolderProject } from '../../src/supervisor/project-connect.mjs';
import { projects } from '../../src/supervisor/projects.mjs';
import { autoApply, undoOwnerApply } from '../../src/supervisor/release/owner-apply.mjs';
import { declaration, environment } from './helpers.mjs';

const GOVERNANCE = fileURLToPath(new URL('../fixtures/governance', import.meta.url));
const REPOSITORY = 'example-org/sampleapp';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (cwd, args, { input, env = {} } = {}) => {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const owner = ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid'];

/** Every file under `root`, `.git` excluded, with its hash. */
function snapshot(root) {
  const seen = {};
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), key);
      else seen[key] = sha256(readFileSync(join(dir, entry.name)));
    }
  };
  walk(root, '');
  return seen;
}

/** A GitHub project's configured folder, a controller over it, and a way to merge on the synthetic origin. */
function githubRig(t) {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const campaignId = 'folder-sync';
  campaignStart(store, declaration({ campaignId, tasks: [{ id: 'T1', issue: 501, title: 'change a', deliverable: 'commit', goal: 'Change a.',
    dependsOn: [], acceptance: ['a changed'], references: ['AGENTS.md'] }] }));
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  const other = join(env.tmp, 'elsewhere');
  run(env.tmp, ['clone', '-q', env.origin, other]);
  let n = 0;
  /** A merge on GitHub (the synthetic origin) that AIWorks recorded: returns its merge commit. */
  const merge = () => {
    n += 1;
    run(other, ['pull', '-q', '--ff-only', 'origin', 'main']);
    writeFileSync(join(other, `merged-${n}.txt`), `merge ${n}\n`);
    run(other, ['add', '-A']);
    run(other, [...owner, 'commit', '-q', '-m', `merge ${n}`]);
    run(other, ['push', '-q', 'origin', 'main']);
    const mergeCommit = run(other, ['rev-parse', 'HEAD']);
    store.journal(campaignId, 'merged', { task: 'T1', sha: mergeCommit, url: `https://github.com/${REPOSITORY}/pull/${n}`, mergeCommit, reconciled: false, requested: true }, Date.now());
    return mergeCommit;
  };
  const head = () => run(env.repo, ['rev-parse', 'HEAD']);
  const last = () => store.get('SELECT kind, detail FROM journal WHERE kind IN (?, ?) ORDER BY seq DESC LIMIT 1', FOLDER_UPDATED, FOLDER_LEFT);
  return { env, store, controller, merge, head, last, sync: () => updateFolder(controller, REPOSITORY) };
}

/** A plain folder project with one checked result in the local ledger. */
function localRig(t, { result }) {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiworks-project-folder-')));
  const root = join(tmp, 'Notes');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Notes\n');
  writeFileSync(join(root, 'src', 'app.js'), 'console.log("app");\n');
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir);
  const store = new Store(join(dataDir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const gitEnv = { GIT_CEILING_DIRECTORIES: tmp };
  const connected = connectFolderProject({ path: root }, { store, dataDir, governanceRoot: GOVERNANCE, git: ['git'], gitEnv });
  assert.equal(connected.ok, true, connected.message);
  const project = projects(store)[0];
  const repo = join(project.mirror_root, SNAPSHOT_DIR);
  const index = { GIT_INDEX_FILE: join(tmp, 'index') };
  run(repo, ['read-tree', project.current_baseline.commit], { env: index });
  for (const [path, bytes] of Object.entries(result)) {
    run(repo, ['update-index', '--add', '--cacheinfo', `100644,${run(repo, ['hash-object', '-w', '--stdin'], { input: bytes })},${path}`], { env: index });
  }
  const sha = run(repo, [...owner, 'commit-tree', run(repo, ['write-tree'], { env: index }), '-p', project.current_baseline.commit, '-m', 'the checked result']);
  run(repo, ['update-ref', `refs/heads/aiworks/task/${sha.slice(0, 12)}`, sha]);
  recordCandidate(store, {
    declaration: { campaignId: 'local-work', target: { projectId: project.id, source: 'folder', baseline: project.current_baseline } },
    task: { task_id: 'T1', verified_sha: sha, verification: { verdict: 'accepted', summary: 'Independent verification.', checks: [], findings: [] } },
    deliverable: 'commit', now: Date.now(),
  });
  const apply = (extra = {}) => autoApply(store, { campaignId: 'local-work', taskId: 'T1', dataDir, runtimeRoot: join(tmp, 'aiworks-runtime'), gitEnv, ...extra });
  return { tmp, root, dataDir, store, gitEnv, project, apply };
}

const OWNER = (store) => checkCaller(store, { platform: 'win32', lookup: async () => ({ pid: 999_991, ancestors: [999_990], jobs: [] }) });

test('a clean folder on its base branch follows a recorded merge; a changed folder or another branch is left with the reason', async (t) => {
  const r = githubRig(t);
  const first = r.merge();
  assert.equal(r.sync(), FOLDER_UPDATED);
  assert.equal(r.head(), first, 'the folder was fast-forwarded to the merged base');
  assert.equal(r.sync(), null, 'a recorded merge is tried once');

  // The owner has a change of their own: nothing is touched, the reason is recorded, the next merge tries again.
  const second = r.merge();
  writeFileSync(join(r.env.repo, 'AGENTS.md'), '# The owner is editing\n');
  assert.equal(r.sync(), FOLDER_LEFT);
  assert.equal(r.last().detail.reason, 'changes');
  assert.equal(r.head(), first, 'the branch did not move');
  assert.equal(readFileSync(join(r.env.repo, 'AGENTS.md'), 'utf8'), '# The owner is editing\n', 'the owner\'s change is kept');
  assert.equal(r.sync(), null, 'not retried until the next merge');
  run(r.env.repo, ['checkout', '--', 'AGENTS.md']);
  const third = r.merge();
  assert.equal(r.sync(), FOLDER_UPDATED);
  assert.equal(r.head(), third, 'the next merge brought it up to date');
  assert.notEqual(second, third);

  // Another branch is checked out: neither it nor the base branch moves.
  run(r.env.repo, ['checkout', '-q', '-b', 'owner-work']);
  r.merge();
  assert.equal(r.sync(), FOLDER_LEFT);
  assert.equal(r.last().detail.reason, 'other-branch');
  assert.equal(r.head(), third);
  assert.equal(run(r.env.repo, ['rev-parse', 'refs/heads/main']), third);
});

test('a checked local result is applied with a backup and no click; a file the owner changed is never written; Undo apply restores', async (t) => {
  const changed = localRig(t, { result: { 'README.md': '# Notes\nmore\n', 'src/search.js': 'export const search = () => [];\n' } });
  writeFileSync(join(changed.root, 'README.md'), '# Notes, the owner\'s edit\n');
  const before = snapshot(changed.root);
  const refused = changed.apply();
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.code, 'APPLY_FOLDER_CHANGED');
  assert.deepEqual(snapshot(changed.root), before, 'nothing was written over the owner\'s change');
  assert.equal(changed.apply(), null, 'AIWorks tries a result once; the owner\'s Apply stays');

  const r = localRig(t, { result: { 'README.md': '# Notes\nmore\n', 'src/search.js': 'export const search = () => [];\n' } });
  const original = snapshot(r.root);
  const applied = r.apply();
  assert.equal(applied.outcome, 'applied', applied.reason);
  assert.equal(applied.undo, true, 'Undo apply is offered');
  assert.equal(readFileSync(join(r.root, 'README.md'), 'utf8'), '# Notes\nmore\n');
  assert.equal(readFileSync(join(r.root, 'src', 'search.js'), 'utf8'), 'export const search = () => [];\n');
  const [row] = r.store.all('SELECT * FROM local_applies');
  assert.ok(existsSync(join(row.backup_dir, 'apply.json')), 'the backup is recorded under AIWorks\'s data directory');
  assert.equal(r.store.all("SELECT * FROM journal WHERE kind = 'auto-apply-finished'").length, 1, 'the update is journaled');
  assert.equal(r.apply(), null, 'an applied result is never applied again');
  const undone = await undoOwnerApply(r.store, { applyId: applied.applyId, requestId: randomUUID(), caller: OWNER, gitEnv: r.gitEnv });
  assert.equal(undone.outcome, 'rolled-back', undone.reason);
  assert.deepEqual(snapshot(r.root), original, 'Undo apply restores the folder byte for byte');
});

test('AIWorks\'s own runtime checkout is never written by either path', async (t) => {
  const r = githubRig(t);
  r.controller.runtimeRoot = r.env.repo;
  const before = r.head();
  r.merge();
  assert.equal(r.sync(), FOLDER_LEFT);
  assert.equal(r.last().detail.reason, 'aiworks-runtime');
  assert.equal(r.head(), before, 'the runtime checkout did not move');

  const local = localRig(t, { result: { 'README.md': '# Notes\nmore\n' } });
  const files = snapshot(local.root);
  const refused = local.apply({ runtimeRoot: local.root });
  assert.equal(refused.outcome, 'refused');
  assert.deepEqual(snapshot(local.root), files, 'nothing was written');
  assert.equal(existsSync(join(local.dataDir, 'applies', local.project.id, refused.applyId, 'apply.json')), false, 'no backup was even taken');
});
