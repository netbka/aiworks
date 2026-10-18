// LO L2 (docs/design/LOCAL_OPERATION.md section 9, slice SELF2): the selfHosting setting, the main ledger and the trusted
// tip of local main, in disposable git repositories. No network: origin/main is set with update-ref, never fetched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { mainLedger, recordAnchor, recordMainCommit, selfHostingSettings, trustedTip, trustsLocalMain } from '../../src/supervisor/self-hosting.mjs';

const REPOSITORY = 'example-org/aiworks';

/** A disposable repository with commits on main and refs/remotes/origin/main at its tip, plus a store beside it. */
function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-self-hosting-'));
  const repoPath = join(dir, 'repo');
  const git = (...args) => {
    const out = spawnSync('git', ['-c', 'user.name=Self Hosting Test', '-c', 'user.email=self-hosting@example.invalid', ...args],
      { cwd: repoPath, encoding: 'utf8', windowsHide: true });
    if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
    return out.stdout.trim();
  };
  spawnSync('git', ['init', '-q', '-b', 'main', repoPath], { windowsHide: true });
  let n = 0;
  const commit = () => { writeFileSync(join(repoPath, 'file.txt'), `${++n}\n`); git('add', '-A'); git('commit', '-q', '-m', `commit ${n}`); return git('rev-parse', 'HEAD'); };
  const stores = [];
  const open = () => { const store = new Store(join(dir, 'supervisor.db')); stores.push(store); return store; };
  t.after(() => { for (const store of stores) try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  return { repoPath, git, commit, open, store: open(), at: { repoPath, repository: REPOSITORY } };
}

test('a malformed selfHosting block is off and logged; an absent one is off without a word', () => {
  const logged = [];
  const log = (line) => logged.push(line);
  const absent = selfHostingSettings({}, { log });
  assert.equal(absent.local, false);
  assert.equal(absent.trustedMain, 'origin');
  assert.equal(trustsLocalMain(absent, REPOSITORY), false);
  assert.deepEqual(logged, []);
  const malformed = [
    'local', [], { trustedMain: 'local' }, { repository: 'not a repository', trustedMain: 'local' },
    { repository: REPOSITORY, trustedMain: 'remote' }, { repository: REPOSITORY, trustedMain: 'local', backup: [] },
    { repository: REPOSITORY, trustedMain: 'local', backup: { enabled: 'yes' } },
    { repository: REPOSITORY, trustedMain: 'local', backup: { enabled: true, branch: '+main' } },
    { repository: REPOSITORY, trustedMain: 'local', backup: { remote: '--mirror' } },
  ];
  for (const selfHosting of malformed) {
    const settings = selfHostingSettings({ selfHosting }, { log });
    assert.equal(settings.local, false, JSON.stringify(selfHosting));
    assert.equal(settings.trustedMain, 'origin');
    assert.equal(trustsLocalMain(settings, REPOSITORY), false);
    assert.match(settings.problem, /^self-hosting stays off: /);
  }
  assert.equal(logged.length, malformed.length);
  const on = selfHostingSettings({ selfHosting: { repository: 'Example-Org/AIWorks', trustedMain: 'local' } }, { log });
  assert.equal(on.problem, null);
  assert.equal(trustsLocalMain(on, REPOSITORY), true);
  assert.equal(trustsLocalMain(on, 'example-org/other'), false);
  assert.equal(on.backup.enabled, false);
});

test('an anchor is recorded only when it equals origin/main and local main, and only once', (t) => {
  const r = rig(t);
  const first = r.commit();
  assert.match(recordAnchor(r.store, { ...r.at, sha: first, now: 1 }).reason, /not origin\/main \(absent\)/);
  const second = r.commit();
  r.git('update-ref', 'refs/remotes/origin/main', first);
  // origin/main behind local main, then local main behind origin/main: both refused.
  assert.match(recordAnchor(r.store, { ...r.at, sha: second, now: 1 }).reason, /not origin\/main/);
  assert.match(recordAnchor(r.store, { ...r.at, sha: first, now: 1 }).reason, /not local main/);
  assert.deepEqual(mainLedger(r.store, REPOSITORY), []);
  r.git('update-ref', 'refs/remotes/origin/main', second);
  assert.equal(recordAnchor(r.store, { ...r.at, sha: second, now: 1 }).recorded, true);
  assert.match(recordAnchor(r.store, { ...r.at, sha: second, now: 2 }).reason, /already has its anchor/);
  assert.deepEqual(mainLedger(r.store, REPOSITORY).map((row) => [row.kind, row.new_tip]), [['anchor', second]]);
  assert.equal(trustedTip(r.store, r.at).tip, second);
});

test('commits on main after the trusted tip are unrecorded until a ledger row records them', (t) => {
  const r = rig(t);
  const anchor = r.commit();
  r.git('update-ref', 'refs/remotes/origin/main', anchor);
  assert.equal(trustedTip(r.store, r.at).state, 'NO_ANCHOR');
  assert.equal(recordMainCommit(r.store, { repository: REPOSITORY, kind: 'owner', oldTip: anchor, newTip: anchor, now: 1 }).recorded, false);
  assert.equal(recordAnchor(r.store, { ...r.at, sha: anchor, now: 1 }).recorded, true);
  const forged = [r.commit(), r.commit()];
  const state = trustedTip(r.store, r.at);
  assert.equal(state.state, 'TRUSTED');
  assert.equal(state.tip, anchor);
  assert.equal(state.unrecordedCount, 2);
  assert.deepEqual(state.unrecorded, [...forged].reverse());
  assert.equal(recordMainCommit(r.store, { repository: REPOSITORY, kind: 'gate-merge', oldTip: anchor, newTip: forged[0], now: 2 }).recorded, false,
    'a gate-merge row names its campaign, task and verified SHA');
  assert.equal(recordMainCommit(r.store, { repository: REPOSITORY, kind: 'gate-merge', oldTip: anchor, newTip: forged[0],
    campaignId: 'c', taskId: 'T1', verifiedSha: forged[0], now: 2 }).recorded, true);
  assert.deepEqual([trustedTip(r.store, r.at).tip, trustedTip(r.store, r.at).unrecorded], [forged[0], [forged[1]]]);
  assert.equal(recordMainCommit(r.store, { repository: REPOSITORY, kind: 'owner', oldTip: forged[0], newTip: forged[1], now: 3 }).recorded, true);
  assert.deepEqual([trustedTip(r.store, r.at).tip, trustedTip(r.store, r.at).unrecordedCount], [forged[1], 0]);
  // Rewinding main below the newest row falls back to the newest row still on main.
  r.git('reset', '-q', '--hard', forged[0]);
  assert.equal(trustedTip(r.store, r.at).tip, forged[0]);
});

test('main rewound below, or rewritten away from, every ledger commit gives MAIN_REWRITTEN', (t) => {
  const r = rig(t);
  const base = r.commit();
  const anchor = r.commit();
  r.git('update-ref', 'refs/remotes/origin/main', anchor);
  assert.equal(recordAnchor(r.store, { ...r.at, sha: anchor, now: 1 }).recorded, true);
  r.git('reset', '-q', '--hard', base);
  assert.equal(trustedTip(r.store, r.at).state, 'MAIN_REWRITTEN');
  r.commit();
  const rewritten = trustedTip(r.store, r.at);
  assert.equal(rewritten.state, 'MAIN_REWRITTEN');
  assert.equal(rewritten.main, r.git('rev-parse', 'main'));
});

test('the main ledger is additive to an existing store and append-only', (t) => {
  const r = rig(t);
  r.store.journal('c', 'existing', { kept: true }, 1);
  r.store.db.exec('DROP TABLE main_ledger;');
  r.store.close();
  const store = r.open();
  assert.deepEqual(store.all("SELECT kind, detail FROM journal WHERE kind = 'existing'"), [{ kind: 'existing', detail: { kept: true } }]);
  assert.deepEqual(store.get('SELECT value FROM meta WHERE key = ?', 'store_version'), { value: '1' });
  const anchor = r.commit();
  r.git('update-ref', 'refs/remotes/origin/main', anchor);
  assert.equal(recordAnchor(store, { ...r.at, sha: anchor, now: 1 }).recorded, true);
  assert.throws(() => store.run('UPDATE main_ledger SET new_tip = ?', 'f'.repeat(40)), /append-only/);
  assert.throws(() => store.run('DELETE FROM main_ledger'), /append-only/);
  assert.equal(mainLedger(store, REPOSITORY).length, 1);
});
