// MERGE-GATE (aiworks#138): the supervisor merges a verified pull request itself only when the owner opted in for the
// repository and merging it puts exactly the verified tree on the base. Workers are played by the test through the
// controller's own result path (applyOutcome), so these tests need no Windows runner and run on Linux too. No model,
// network or GitHub call: a disposable git origin, and a synthetic gh (fixtures/fake-gh-merge.mjs) that records every
// merge call and merges into that origin.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignCancel, campaignPause, campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { mergeSettings } from '../../src/supervisor/merge.mjs';
import { branchName } from '../../src/supervisor/adapters/git.mjs';
import { declaration, environment, passedGate } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const A = 'camp-a', B = 'camp-b';
const REPOSITORY = 'example-org/sampleapp';
const ON = { delegatedTo: 'supervisor', decision: '#138', repositories: [REPOSITORY] };
const task = (id, issue, file, dependsOn = []) => ({ id, issue, title: `change ${file}`, deliverable: 'commit', goal: `Change ${file}.`,
  dependsOn, acceptance: [`${file} changed`], references: ['AGENTS.md'] });

/** Registered campaigns over a disposable origin; merging is off until the test starts a controller with it on. */
function rig(t, campaigns = { [A]: [task('A1', 501, 'a.txt')] }) {
  const env = environment({ config: { commands: {
    claude: [process.execPath, join(here, 'fixtures', 'fake-claude.mjs')],
    gh: [process.execPath, join(here, 'fixtures', 'fake-gh-merge.mjs')],
  } } });
  process.env.FAKE_GH_ORIGIN = env.origin;
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { r.controller?.release(); store.close(); env.cleanup(); });
  for (const [campaignId, tasks] of Object.entries(campaigns)) campaignStart(store, declaration({ campaignId, tasks }));
  let now = Date.now();
  const ctx = (id) => ({ id, generation: r.controller.held.get(id) });
  const state = (name) => join(env.env.FAKE_GH_STATE, name);
  const r = {
    env, store, controller: null,
    /** A controller with this config.json and options, as after a restart: the previous one releases its leases. */
    start(config = {}, options = {}) {
      r.controller?.release();
      r.controller = new Controller({ store, config: { ...env.config, ...config }, dataDir: env.dataDir, now: () => now, fault: null, ...options });
      r.controller.launch = async () => {}; // the test plays the worker; nothing is spawned
    },
    advance: (ms = r.controller.config.integrationPollMs + 1) => { now += ms; },
    tick: () => r.controller.tick(),
    open(id, kind) {
      const [op] = store.openOperations(id);
      assert.equal(op?.kind, kind, `${id}: expected an open ${kind} operation, found ${op?.kind ?? 'none'}`);
      return op;
    },
    /** Play the implementer: `edit` changes the worktree, then the commit is reported as resolved. */
    implement(id, edit, { commit = true } = {}) {
      const op = r.open(id, 'implement');
      edit(op.workspace);
      if (commit) { git(op.workspace, 'add', '-A'); git(op.workspace, 'commit', '-qm', `work for ${id}`); }
      const headSha = git(op.workspace, 'rev-parse', 'HEAD');
      r.controller.applyOutcome(ctx(id), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { result: 'resolved', summary: 'implemented', headSha, report: `# Report for ${id}` } });
      return headSha;
    },
    /** Play the independent verifier of the exact target. */
    verify(id) {
      const op = r.open(id, 'verify');
      passedGate(op.workspace); // the verifier's full gate, as the gate helper leaves it
      r.controller.applyOutcome(ctx(id), op, { class: 'result', receipt: { sessionId: op.session_id },
        value: { verdict: 'accepted', summary: 'checked', targetSha: op.target_sha, findings: [], checks: [{ command: 'npm run check', result: 'pass' }] } });
      return op;
    },
    journal: (id, kind) => store.all('SELECT detail FROM journal WHERE campaign_id = ? AND kind = ? ORDER BY seq', id, kind).map((row) => row.detail),
    mergeCalls: () => (existsSync(state('merge-calls.jsonl'))
      ? readFileSync(state('merge-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    pullReads: () => r.env.ghCalls().filter((call) => call.args.includes('GET') && call.args.some((arg) => /\/pulls\/\d+$/.test(arg))).length,
    setMergeable: (map) => writeFileSync(state('mergeable.json'), JSON.stringify(map)),
    loseNextMergeResponse: () => writeFileSync(state('lose-merge-response'), ''),
    main: () => r.env.remoteHead('main'),
    tree: (sha) => git(r.env.origin, 'rev-parse', `${sha}^{tree}`),
    parents: (sha) => git(r.env.origin, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1),
  };
  r.start();
  return r;
}

/** Each listed campaign's first task is implemented (one new file each), verified and published, with merging off. */
async function publish(r, ids = [A], files = { [A]: 'a.txt', [B]: 'b.txt' }) {
  await r.tick();
  const heads = {};
  for (const id of ids) heads[id] = r.implement(id, (dir) => writeFileSync(join(dir, files[id]), `${id}\n`));
  await r.tick();
  for (const id of ids) r.verify(id);
  await r.tick();
  for (const id of ids) assert.ok(r.store.tasks(id)[0].pr_url, `${id} published`);
  assert.equal(r.mergeCalls().length, 0, 'nothing merges while merging is off');
  return heads;
}

test('merge settings: off unless delegated to the supervisor with an explicit repository list', () => {
  assert.equal(mergeSettings({}).enabled, false);
  assert.equal(mergeSettings({ merges: { delegatedTo: 'monitor', decision: '#17' } }).enabled, false);
  assert.equal(mergeSettings({ merges: { delegatedTo: 'monitor', decision: '#17' } }).problem, null, 'the monitor delegation is not malformed');
  const unlisted = mergeSettings({ merges: { delegatedTo: 'supervisor', decision: '#138' } });
  assert.equal(unlisted.enabled, false);
  assert.match(unlisted.problem, /merges\.repositories/);
  assert.equal(mergeSettings({ merges: { delegatedTo: 'supervisor', repositories: [] } }).enabled, false);
  assert.equal(mergeSettings({ merges: { delegatedTo: 'supervisor', repositories: ['not a repository'] } }).enabled, false);
  assert.equal(mergeSettings({ merges: { ...ON, held: ['https://github.com/example-org/sampleapp/pull/1'] } }).enabled, false, 'held must be a map');
  const on = mergeSettings({ merges: { ...ON, repositories: ['Example-Org/SampleApp'], held: { 'https://github.com/example-org/sampleapp/pull/7': 'owner-review' } } });
  assert.equal(on.enabled, true);
  assert.ok(on.repositories.has(REPOSITORY));
  assert.ok(on.held.has('https://github.com/example-org/sampleapp/pull/7'));
});

test('nothing merges when merging is absent, delegated to the monitor, malformed or the repository is not listed', async (t) => {
  const r = rig(t);
  await publish(r);
  const main = r.main(), reads = r.pullReads();
  for (const config of [{}, { merges: { delegatedTo: 'monitor', decision: '#17' } }, { merges: { delegatedTo: 'supervisor', decision: '#138' } },
    { merges: { ...ON, repositories: ['example-org/other'] } }]) {
    r.start(config);
    for (let i = 0; i < 2; i++) { r.advance(); await r.tick(); }
    assert.equal(r.mergeCalls().length, 0, `no merge call with ${JSON.stringify(config)}`);
    assert.equal(r.pullReads(), reads, `the pull request is not even read with ${JSON.stringify(config)}`);
    assert.equal(r.main(), main);
  }
  assert.equal(r.journal(A, 'merged').length, 0);
});

test('an eligible pull request is merged once with a merge commit of the verified SHA; repeated ticks and a restart do not merge again', async (t) => {
  const r = rig(t);
  const { [A]: verified } = await publish(r);
  const before = r.main(), url = r.store.task(A, 'A1').pr_url;
  r.start({ merges: ON });
  await r.tick();

  const calls = r.mergeCalls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { url, fields: { merge_method: 'merge', sha: verified } });
  // A merge commit: the old base first, the verified head second, and exactly the verified tree.
  const merged = r.main();
  assert.notEqual(merged, before);
  assert.deepEqual(r.parents(merged), [before, verified]);
  assert.equal(r.tree(merged), r.tree(verified), 'the merge result is the verified tree');
  assert.equal(r.env.remoteHead(branchName(A, 'A1')), verified, 'the branch is never deleted or rewritten');
  const [record] = r.journal(A, 'merged');
  assert.deepEqual(record, { task: 'A1', sha: verified, url, mergeCommit: merged, reconciled: false, requested: true });
  assert.equal(r.journal(A, 'merge-requested').length, 1);
  await r.tick(); // drain the note
  assert.ok(r.env.comments().some((comment) => comment.body.includes(`merged into main under the merge gate`) && comment.body.includes('Merged is not deployed')));

  const reads = r.pullReads();
  for (let i = 0; i < 3; i++) { r.advance(); await r.tick(); }
  r.start({ merges: ON }); // a restart
  for (let i = 0; i < 2; i++) { r.advance(); await r.tick(); }
  assert.equal(r.mergeCalls().length, 1, 'never merged twice');
  assert.equal(r.pullReads(), reads, 'a recorded merge is not read again');
  assert.equal(r.journal(A, 'merged').length, 1);
});

test('cancelling a finished campaign stops its later merge and repair work without losing evidence or stopping another campaign', async (t) => {
  const r = rig(t, { [A]: [task('A1', 501, 'a.txt')], [B]: [task('B1', 502, 'b.txt')] });
  const heads = await publish(r, [A, B]);
  await r.tick();
  assert.equal(r.store.campaign(A).control, 'finished');
  const declaration = r.store.campaign(A).declaration;
  const outcome = r.store.task(A, 'A1');
  const operations = r.store.all('SELECT * FROM operations WHERE campaign_id = ?', A);
  campaignCancel(r.store, A, 'Repository moved; retain this campaign as historical evidence');
  await r.tick();
  assert.equal(r.store.campaign(A).control, 'cancelled');
  r.start({ merges: ON, integrationRepair: { enabled: true } });
  for (let i = 0; i < 2; i++) { r.advance(); await r.tick(); }
  assert.deepEqual(r.store.campaign(A).declaration, declaration);
  assert.deepEqual(r.store.task(A, 'A1'), outcome);
  assert.deepEqual(r.store.all('SELECT * FROM operations WHERE campaign_id = ?', A), operations);
  assert.equal(r.journal(A, 'merged').length, 0);
  assert.equal(r.journal(A, 'integration-conflict').length, 0);
  assert.equal(r.journal(A, 'merge-base-moved').length, 0);
  assert.deepEqual(r.mergeCalls().map((call) => call.fields.sha), [heads[B]]);
  assert.equal(r.pullReads(), 1, 'only the current campaign is polled');
});

test('a pull request GitHub reports missing is not read every pass, and another campaign still merges', async (t) => {
  const r = rig(t, { [A]: [task('A1', 501, 'a.txt')], [B]: [task('B1', 502, 'b.txt')] });
  const heads = await publish(r, [A, B]);
  const urlA = r.store.task(A, 'A1').pr_url, prs = join(r.env.env.FAKE_GH_STATE, 'prs.json');
  writeFileSync(prs, JSON.stringify(JSON.parse(readFileSync(prs, 'utf8')).filter((pr) => pr.url !== urlA)));
  const readsOfA = () => r.env.ghCalls().filter((call) => call.args.includes(`repos/${REPOSITORY}/pulls/${urlA.split('/').pop()}`)).length;
  r.start({ merges: ON });
  for (let i = 0; i < 4; i++) { r.advance(); await r.tick(); }
  assert.equal(readsOfA(), 1, 'the missing pull request is read once');
  assert.deepEqual(r.mergeCalls().map((call) => call.fields.sha), [heads[B]]);
  assert.equal(r.journal(A, 'merged').length, 0);
});

test('a merge whose response was lost is settled by reading the pull request after a restart, never by a second merge', async (t) => {
  const r = rig(t);
  const { [A]: verified } = await publish(r);
  r.loseNextMergeResponse();
  r.start({ merges: ON });
  await r.tick();
  assert.equal(r.mergeCalls().length, 1);
  assert.equal(r.journal(A, 'merged').length, 0, 'the outcome is unknown');
  assert.match(r.journal(A, 'merge-refused')[0].detail, /connection reset/);
  const merged = r.main();

  r.start({ merges: ON }); // restart after the unknown outcome
  r.advance();
  await r.tick();
  assert.equal(r.mergeCalls().length, 1, 'the pull request was read, not merged again');
  assert.deepEqual(r.journal(A, 'merged'), [{ task: 'A1', sha: verified, url: r.store.task(A, 'A1').pr_url, mergeCommit: merged, reconciled: true, requested: true }]);
});

/** Publish A1 with merging off, set up one gate failure, then run a controller with merging on: nothing merges. */
async function neverMerges(t, setup, { options = {}, campaigns } = {}) {
  const r = rig(t, campaigns);
  await publish(r);
  const main = r.main();
  const config = await setup(r) ?? { merges: ON };
  r.start(config, options);
  for (let i = 0; i < 3; i++) { r.advance(); await r.tick(); }
  assert.equal(r.mergeCalls().length, 0, 'no merge call');
  assert.equal(r.main(), main, 'the base did not move');
  assert.equal(r.journal(A, 'merged').length, 0);
  assert.equal(r.journal(A, 'merge-base-moved').length, 0, 'no repair either');
  return r;
}

test('a head that is not the verified SHA never merges', async (t) => {
  const r = await neverMerges(t, (rr) => {
    // Someone else pushes to the campaign branch after publication.
    const clone = join(rr.env.tmp, 'other');
    git(rr.env.tmp, 'clone', '-q', '-b', branchName(A, 'A1'), rr.env.origin, clone);
    writeFileSync(join(clone, 'extra.txt'), 'not verified\n');
    git(clone, '-c', 'user.name=Someone', '-c', 'user.email=someone@example.invalid', 'add', '-A');
    git(clone, '-c', 'user.name=Someone', '-c', 'user.email=someone@example.invalid', 'commit', '-qm', 'unverified');
    git(clone, 'push', '-q', 'origin', `HEAD:${branchName(A, 'A1')}`);
  });
  assert.match(r.journal(A, 'merge-waiting')[0].reason, /is not the verified/);
  assert.equal(r.store.task(A, 'A1').state, 'done');
});

test('a held pull request never merges', async (t) => {
  const r = await neverMerges(t, (rr) => ({ merges: { ...ON, held: { [rr.store.task(A, 'A1').pr_url]: 'owner-review' } } }));
  assert.match(r.journal(A, 'merge-waiting')[0].reason, /held/);
});

test('a pull request GitHub reports not mergeable never merges', async (t) => {
  const r = await neverMerges(t, (rr) => { rr.setMergeable({ [rr.store.task(A, 'A1').pr_url]: false }); });
  assert.match(r.journal(A, 'merge-waiting')[0].reason, /not mergeable/);
});

test('supervisor code that fails the AW-005 merged-code check never merges', async (t) => {
  await neverMerges(t, () => undefined, { options: { revisionCheck: () => 'HEAD is not an ancestor of origin/main' } });
});

for (const [name, control] of [['paused', campaignPause], ['cancelled', campaignCancel]]) {
  test(`a ${name} campaign never merges`, async (t) => {
    // A second task keeps the campaign running after A1 is published, so it can be paused or cancelled.
    const r = await neverMerges(t, (rr) => { control(rr.store, A, 'owner'); },
      { campaigns: { [A]: [task('A1', 501, 'a.txt'), task('A2', 502, 'a2.txt', ['A1'])] } });
    assert.notEqual(r.store.campaign(A).control, 'registered');
  });
}

test('a moved base starts the integration repair, and the pull request merges only after the new head is verified', async (t) => {
  const r = rig(t, { [A]: [task('A1', 501, 'a.txt')], [B]: [task('B1', 502, 'b.txt')] });
  const heads = await publish(r, [A, B]);
  const urlB = r.store.task(B, 'B1').pr_url;
  r.start({ merges: ON });
  await r.tick();
  // One pull request per repository per pass: A merges, B waits for the refreshed base.
  assert.deepEqual(r.mergeCalls().map((call) => call.fields.sha), [heads[A]]);
  const mergedA = r.main();

  r.advance();
  await r.tick();
  const [moved] = r.journal(B, 'merge-base-moved');
  assert.deepEqual({ task: moved.task, sha: moved.sha, base: moved.base, paths: moved.paths, stalled: moved.stalled },
    { task: 'B1', sha: heads[B], base: mergedA, paths: [], stalled: false });
  assert.equal(r.mergeCalls().length, 1, 'a head that does not contain the base is not merged');
  assert.equal(r.store.task(B, 'B1').state, 'pending', 'B1 reopens as a repair round');
  assert.equal(r.store.campaign(B).control, 'registered');

  // The repair round merges the base into the same branch.
  await r.tick();
  const op = r.open(B, 'implement');
  assert.equal(op.base_sha, heads[B]);
  assert.ok(op.packet.constraints.some((line) => line.startsWith('Blocking integration finding integration-conflict: Base moved') && line.includes(mergedA)));
  const repaired = r.implement(B, (dir) => git(dir, 'merge', '-q', '--no-edit', mergedA), { commit: false });

  // Not merged before a fresh verification of the exact new head.
  r.advance();
  await r.tick();
  assert.equal(r.open(B, 'verify').target_sha, repaired);
  assert.equal(r.mergeCalls().length, 1);
  r.verify(B);
  r.advance();
  await r.tick(); // publishes the repaired head to the same PR, then merges it

  assert.equal(r.env.remoteHead(branchName(B, 'B1')), repaired);
  assert.equal(r.store.task(B, 'B1').pr_url, urlB, 'the same pull request');
  const calls = r.mergeCalls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { url: urlB, fields: { merge_method: 'merge', sha: repaired } });
  const mergedB = r.main();
  assert.deepEqual(r.parents(mergedB), [mergedA, repaired]);
  assert.equal(r.tree(mergedB), r.tree(repaired), 'the merge result is the verified repaired tree');
  assert.deepEqual(r.journal(B, 'merged').map((entry) => entry.sha), [repaired]);
});

test('a cancellation committed after a moved-base task is selected leaves its completed task and operations unchanged', async (t) => {
  const r = rig(t, { [A]: [task('A1', 501, 'a.txt')], [B]: [task('B1', 502, 'b.txt')] });
  const heads = await publish(r, [A, B]);
  r.start({ merges: ON });
  await r.tick(); // A merges; B is judged on the next pass against the moved base
  const outcome = r.store.task(B, 'B1'), operations = r.store.all('SELECT * FROM operations WHERE campaign_id = ?', B);
  // The base is fetched after the merge pass selected B1 and before its fenced repair: the owner cancels in that window.
  const fetchBase = r.controller.fetchBase.bind(r.controller);
  let cancelled = false;
  r.controller.fetchBase = (...args) => {
    if (!cancelled) { cancelled = true; campaignCancel(r.store, B, 'owner'); }
    return fetchBase(...args);
  };
  r.advance();
  await r.tick();
  assert.ok(cancelled, 'the cancellation landed inside the merge pass');
  await r.tick();
  assert.equal(r.store.campaign(B).control, 'cancelled');
  assert.deepEqual(r.store.task(B, 'B1'), outcome);
  assert.deepEqual(r.store.all('SELECT * FROM operations WHERE campaign_id = ?', B), operations);
  assert.equal(r.journal(B, 'merge-base-moved').length, 0);
  assert.deepEqual(r.mergeCalls().map((call) => call.fields.sha), [heads[A]]);
});

test('with CI repair on, a head merges only after its CI passed: never while CI is unread, pending or failed', async (t) => {
  const r = rig(t);
  const { [A]: verified } = await publish(r);
  r.start({ merges: ON });
  // CI is played by the test: the controller reads it (ciRepair on) but the journal rows come from here.
  r.controller.ci = true;
  r.controller.checkPublishedCi = () => {};
  const ci = (kind) => r.store.journal(A, kind, { task: 'A1', sha: verified }, Date.now());
  const waits = () => r.journal(A, 'merge-waiting').map((row) => row.reason);
  await r.tick();
  assert.equal(r.mergeCalls().length, 0, 'CI never read: no merge');
  for (const [kind, reason] of [['ci-pending', /not passed/], ['ci-failed', /CI failed/]]) {
    ci(kind);
    r.advance(); await r.tick();
    assert.equal(r.mergeCalls().length, 0, `${kind}: no merge`);
    assert.match(waits().at(-1), reason);
  }
  ci('ci-passed');
  r.advance(); await r.tick();
  assert.equal(r.mergeCalls().length, 1, 'merged once CI passed');
  assert.equal(r.journal(A, 'merged').length, 1);
});
