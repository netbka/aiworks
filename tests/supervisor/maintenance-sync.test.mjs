// Safe checkout sync (docs/plans/git-maintenance-merge-orchestrator.md P1, acceptance 4): the fast-forward path moves a
// clean, inactive checkout to its upstream, and every other checkout keeps every byte and commit it had: dirty,
// diverged, detached, without an upstream, with recorded activity, or with unknown activity. The apply path runs only
// for a checkout the owner listed; without that authorization nothing moves, dry run or not. No network: the upstream
// is what the checkout has fetched before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { safeSync, syncSettings } from '../../src/supervisor/maintenance-sync.mjs';

const git = (cwd, ...args) => {
  const out = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};

/** A bare origin whose main has two commits; `checkout(name)` clones it at the first commit with main's upstream set, then fetches the second. */
function rig(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-sync-'));
  const origin = join(root, 'origin.git'), seed = join(root, 'seed');
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', 'a.txt'); git(seed, 'commit', '-qm', 'one');
  const first = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  writeFileSync(join(seed, 'a.txt'), 'two\n');
  git(seed, 'commit', '-qam', 'two');
  const second = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', '-q', 'origin', 'main');
  const checkout = (name) => {
    const path = join(root, name);
    git(root, 'clone', '-q', origin, name);
    git(path, 'config', 'core.autocrlf', 'false');
    git(path, 'reset', '-q', '--hard', first);
    git(path, 'fetch', '-q', 'origin');
    return path;
  };
  const store = new Store(join(root, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, first, second, checkout, store, dataDir: join(root, 'data') };
}

const head = (path) => git(path, 'rev-parse', 'HEAD');
const one = (report) => report.checkouts[0];

test('only a clean, inactive, listed checkout fast-forwards, and only with apply; everything else keeps its bytes and commits', async (t) => {
  const r = rig(t);
  const clean = r.checkout('clean');
  const settings = syncSettings({ maintenance: { sync: { enabled: true, checkouts: [clean] } } });
  assert.equal(settings.enabled, true);

  // Dry run: judged, not moved. Apply without authorization: refused, not moved.
  assert.equal(one(safeSync({ checkouts: [clean], store: r.store, settings, dataDir: r.dataDir })).action, 'would-update');
  assert.equal(head(clean), r.first);
  const unlisted = safeSync({ checkouts: [clean], store: r.store, settings: syncSettings({}), dataDir: r.dataDir, apply: true });
  assert.deepEqual([one(unlisted).action, one(unlisted).reason], ['left', 'not-authorized']);
  assert.equal(head(clean), r.first);

  // The fast-forward path.
  const moved = one(safeSync({ checkouts: [clean], store: r.store, settings, dataDir: r.dataDir, apply: true }));
  assert.deepEqual([moved.action, moved.head, moved.target], ['updated', r.second, r.second]);
  assert.equal(head(clean), r.second);
  assert.equal(readFileSync(join(clean, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(git(clean, 'status', '--porcelain'), '');
  assert.equal(one(safeSync({ checkouts: [clean], store: r.store, settings, dataDir: r.dataDir, apply: true })).action, 'already');

  // Every skip, under apply with the checkout listed: nothing moves and nothing is lost.
  const cases = [];
  const dirty = r.checkout('dirty');
  writeFileSync(join(dirty, 'draft.txt'), 'owner draft\n');
  cases.push([dirty, 'changes', () => assert.equal(readFileSync(join(dirty, 'draft.txt'), 'utf8'), 'owner draft\n')]);
  const diverged = r.checkout('diverged');
  writeFileSync(join(diverged, 'b.txt'), 'mine\n');
  git(diverged, 'add', 'b.txt'); git(diverged, 'commit', '-qm', 'own commit');
  const own = head(diverged);
  cases.push([diverged, 'own-commits', () => assert.equal(head(diverged), own)]);
  const detached = r.checkout('detached');
  git(detached, 'checkout', '-q', '--detach');
  cases.push([detached, 'detached', () => assert.equal(head(detached), r.first)]);
  const local = r.checkout('local');
  git(local, 'checkout', '-q', '-b', 'topic');
  cases.push([local, 'no-upstream', () => assert.equal(head(local), r.first)]);
  const active = r.checkout('active');
  r.store.insert('operations', { id: 'op-1', campaign_id: 'c1', task_id: 'T1', kind: 'implement', seq: 1, idempotency_key: 'c1:T1:1', lease_generation: 1,
    state: 'dispatched', session_id: 's1', run_dir: join(r.root, 'run'), workspace: active, packet: '{}', packet_digest: 'd', created_at: 1, updated_at: 1 });
  cases.push([active, 'active', () => assert.equal(head(active), r.first)]);
  for (const [path, reason, intact] of cases) {
    const listed = syncSettings({ maintenance: { sync: { enabled: true, checkouts: [path] } } });
    const entry = one(safeSync({ checkouts: [path], store: r.store, settings: listed, dataDir: r.dataDir, apply: true }));
    assert.deepEqual([entry.action, entry.reason], ['left', reason], path);
    intact();
  }

  // Without a store nothing says whether the checkout is in use: unknown activity never fast-forwards.
  const unknown = r.checkout('unknown');
  const listed = syncSettings({ maintenance: { sync: { enabled: true, checkouts: [unknown] } } });
  const entry = one(safeSync({ checkouts: [unknown], store: null, settings: listed, dataDir: r.dataDir, apply: true }));
  assert.deepEqual([entry.action, entry.reason], ['left', 'unknown-activity']);
  assert.equal(head(unknown), r.first);
});
