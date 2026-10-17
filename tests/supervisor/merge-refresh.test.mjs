// Merge-gate refresh (merges.refresh, src/supervisor/merge-refresh.mjs): when the base moved past a verified pull request
// without touching its files, the supervisor runs the gate on the exact merge result itself and merges the unchanged
// head, instead of reopening the task for an AI repair round. A shared file, a failed or stuck gate falls back to that
// repair. Workers are played through applyOutcome; the gate is a synthetic command (fixtures/fake-refresh-gate.mjs) run
// by the real gate helper. No model, network or GitHub call: a disposable origin and the synthetic gh of the merge gate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { mergeSettings } from '../../src/supervisor/merge.mjs';
import { refreshSettings } from '../../src/supervisor/merge-refresh.mjs';
import { branchName } from '../../src/supervisor/adapters/git.mjs';
import { declaration, environment, sleep } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const A = 'camp-a', B = 'camp-b', C = 'camp-c';
const REPOSITORY = 'example-org/sampleapp';
const GATE = [`"${process.execPath}"`, `"${join(here, 'fixtures', 'fake-refresh-gate.mjs')}"`];
const ON = (refresh = { command: GATE }) => ({ merges: { delegatedTo: 'supervisor', decision: '#138', repositories: [REPOSITORY], refresh } });
const task = (id, issue, file) => ({ id, issue, title: `change ${file}`, deliverable: 'commit', goal: `Change ${file}.`,
  dependsOn: [], acceptance: [`${file} changed`], references: ['AGENTS.md'] });

/** Campaigns over a disposable origin, each with one task that writes `files[id]`; published with merging off. */
async function published(t, files) {
  const env = environment({ config: { commands: {
    claude: [process.execPath, join(here, 'fixtures', 'fake-claude.mjs')],
    gh: [process.execPath, join(here, 'fixtures', 'fake-gh-merge.mjs')],
  } } });
  process.env.FAKE_GH_ORIGIN = env.origin;
  const gate = join(env.tmp, 'refresh-gate');
  mkdirSync(gate);
  process.env.FAKE_REFRESH_STATE = gate;
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { writeFileSync(join(gate, 'release'), ''); r.controller?.release(); store.close(); env.cleanup(); });
  const ids = Object.keys(files);
  ids.forEach((id, i) => campaignStart(store, declaration({ campaignId: id, tasks: [task(`${id.at(-1).toUpperCase()}1`, 501 + i, files[id])] })));
  let now = Date.now();
  const ctx = (id) => ({ id, generation: r.controller.held.get(id) });
  const r = {
    env, store, controller: null,
    start(config = {}) {
      r.controller?.release();
      r.controller = new Controller({ store, config: { ...env.config, ...config }, dataDir: env.dataDir, now: () => now, fault: null });
      r.controller.launch = async () => {};
    },
    pass: async () => { now += r.controller.config.integrationPollMs + 1; await r.controller.tick(); },
    later: (ms) => { now += ms; },
    open: (id, kind) => store.openOperations(id).find((op) => op.kind === kind),
    journal: (id, kind) => store.all('SELECT detail FROM journal WHERE campaign_id = ? AND kind = ? ORDER BY seq', id, kind).map((row) => row.detail),
    mergeCalls: () => (existsSync(join(env.env.FAKE_GH_STATE, 'merge-calls.jsonl'))
      ? readFileSync(join(env.env.FAKE_GH_STATE, 'merge-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    runs: () => (existsSync(join(gate, 'runs.jsonl')) ? readFileSync(join(gate, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    mode: (value) => writeFileSync(join(gate, 'mode'), value),
    /** Waits until the refresh gate in `path` recorded its exit code. */
    async gateEnds(path) {
      for (let i = 0; i < 600 && !existsSync(join(path, 'gate-exit.log')); i++) await sleep(50);
      assert.ok(existsSync(join(path, 'gate-exit.log')), `the gate in ${path} ended`);
    },
    main: () => env.remoteHead('main'),
    tree: (sha) => git(env.origin, 'rev-parse', `${sha}^{tree}`),
    parents: (sha) => git(env.origin, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1),
  };
  r.start();
  await r.controller.tick();
  const heads = {};
  for (const id of ids) {
    const op = r.open(id, 'implement');
    writeFileSync(join(op.workspace, files[id]), `${id}\n`);
    git(op.workspace, 'add', '-A');
    git(op.workspace, 'commit', '-qm', `work for ${id}`);
    heads[id] = git(op.workspace, 'rev-parse', 'HEAD');
    r.controller.applyOutcome(ctx(id), op, { class: 'result', receipt: { sessionId: op.session_id },
      value: { result: 'resolved', summary: 'implemented', headSha: heads[id], report: `# Report for ${id}` } });
  }
  await r.controller.tick();
  for (const id of ids) {
    const op = r.open(id, 'verify');
    r.controller.applyOutcome(ctx(id), op, { class: 'result', receipt: { sessionId: op.session_id },
      value: { verdict: 'accepted', summary: 'checked', targetSha: op.target_sha, findings: [], checks: [{ command: 'npm run check', result: 'pass' }] } });
  }
  await r.controller.tick();
  for (const id of ids) assert.ok(store.tasks(id)[0].pr_url, `${id} published`);
  return { r, heads };
}

test('refresh settings: absent is off, a command list turns it on, anything else keeps merging off', () => {
  assert.equal(refreshSettings(undefined), null);
  assert.deepEqual(refreshSettings({ command: ['npm', 'run', 'check'] }), { command: ['npm', 'run', 'check'], timeoutMs: 120 * 60_000 });
  assert.equal(refreshSettings({ command: ['npm'], timeoutMinutes: 5 }).timeoutMs, 5 * 60_000);
  for (const bad of ['npm run check', [], { command: [] }, { command: ['npm', ''] }, { command: ['npm'], timeoutMinutes: 0 }]) {
    assert.ok(refreshSettings(bad).problem, JSON.stringify(bad));
    const settings = mergeSettings(ON(bad));
    assert.equal(settings.enabled, false, JSON.stringify(bad));
    assert.match(settings.problem, /merges\.refresh/);
  }
  assert.equal(mergeSettings({ merges: { ...ON().merges, refresh: undefined } }).refresh, null);
  assert.deepEqual(mergeSettings(ON()).refresh.command, GATE);
});

test('a moved base that shares no file with the pull request is gated on the exact merge result and merged without an AI round', async (t) => {
  const { r, heads } = await published(t, { [A]: 'a.txt', [B]: 'b.txt', [C]: 'c.txt' });
  r.start(ON());
  await r.controller.tick();
  assert.equal(r.mergeCalls().length, 1, 'the first pull request contains the base and merges at once');
  const mergedA = r.main();

  // B's head does not contain the new base: the refresh gates the merge result instead of reopening B1.
  await r.pass();
  const [started] = r.journal(B, 'merge-refresh-started');
  assert.equal(started.sha, heads[B]);
  assert.equal(started.base, mergedA);
  assert.equal(r.store.task(B, 'B1').state, 'done', 'B1 is not reopened');
  assert.match(r.journal(B, 'merge-waiting').at(-1).reason, /gate runs on the merge result/);
  // One refresh per repository at a time: C waits for B, so it is judged against the base B leaves.
  await r.gateEnds(started.path);
  assert.equal(r.journal(C, 'merge-refresh-started').length, 0);

  await r.pass();
  const calls = r.mergeCalls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].fields, { merge_method: 'merge', sha: heads[B] }, 'the unchanged verified head merges');
  const mergedB = r.main();
  assert.deepEqual(r.parents(mergedB), [mergedA, heads[B]]);
  const [run] = r.runs();
  assert.equal(r.tree(mergedB), run.tree, 'the base now carries exactly the tree the gate ran');
  assert.equal(run.tree, started.tree);
  assert.equal(r.env.remoteHead(branchName(B, 'B1')), heads[B], 'the refresh commit is local: the branch is never pushed');
  assert.equal(spawnSync('git', ['cat-file', '-e', started.commit], { cwd: r.env.origin }).status === 0, false);
  assert.equal(r.journal(B, 'merge-refresh-passed').length, 1);
  assert.equal(r.journal(B, 'merge-base-moved').length, 0);
  assert.equal(r.journal(B, 'merged').length, 1);
  assert.equal(r.open(B, 'implement'), undefined, 'no implementer or verifier ran again');

  // C follows against the base B left, through its own refresh.
  await r.pass();
  const [startedC] = r.journal(C, 'merge-refresh-started');
  assert.equal(startedC.base, mergedB);
  await r.gateEnds(startedC.path);
  await r.pass();
  assert.equal(r.mergeCalls().length, 3);
  assert.deepEqual(r.parents(r.main()), [mergedB, heads[C]]);
  assert.equal(r.runs().length, 2, 'one gate run per refresh');
});

test('a moved base that changed a file the pull request changed goes to the integration repair, with no gate run', async (t) => {
  const { r } = await published(t, { [A]: 'shared.txt', [B]: 'shared.txt' });
  r.start(ON());
  await r.controller.tick();
  await r.pass();
  const [failed] = r.journal(B, 'merge-refresh-failed');
  assert.match(failed.reason, /the base changed 1 file\(s\) this pull request changed too/);
  assert.deepEqual(failed.paths, ['shared.txt']);
  assert.equal(r.journal(B, 'merge-base-moved').length, 1);
  assert.equal(r.store.task(B, 'B1').state, 'pending', 'B1 reopens as a repair round');
  assert.equal(r.runs().length, 0);
  await r.controller.tick();
  assert.ok(r.open(B, 'implement').packet.constraints.some((line) => line.includes("The supervisor's refresh did not merge it: the base changed 1 file(s)")));
});

test('a refresh whose gate fails goes to the integration repair and names the failure', async (t) => {
  const { r, heads } = await published(t, { [A]: 'a.txt', [B]: 'b.txt' });
  r.mode('fail');
  r.start(ON());
  await r.controller.tick();
  await r.pass();
  const [started] = r.journal(B, 'merge-refresh-started');
  await r.gateEnds(started.path);
  await r.pass();
  const [failed] = r.journal(B, 'merge-refresh-failed');
  assert.equal(failed.reason, 'the gate on the merge result exited 1');
  assert.match(failed.summary, /# fail 1/);
  assert.equal(r.mergeCalls().length, 1, 'B is not merged');
  assert.equal(r.journal(B, 'merge-base-moved')[0].sha, heads[B]);
  assert.equal(r.store.task(B, 'B1').state, 'pending');
  // Later passes do not gate the same head and base again.
  await r.pass();
  assert.equal(r.runs().length, 1);
});

test('a restart while the gate runs keeps the same refresh; a gate that ended without an exit code starts once more', async (t) => {
  const { r, heads } = await published(t, { [A]: 'a.txt', [B]: 'b.txt' });
  r.mode('hold');
  r.start(ON());
  await r.controller.tick();
  await r.pass();
  const [started] = r.journal(B, 'merge-refresh-started');
  for (let i = 0; i < 200 && r.runs().length === 0; i++) await sleep(50);
  r.start(ON()); // a restart: the next controller finds the running gate through the journal and the gate's own files
  await r.pass();
  assert.equal(r.journal(B, 'merge-refresh-started').length, 1);
  assert.equal(r.runs().length, 1, 'the running gate is not started twice');
  writeFileSync(join(process.env.FAKE_REFRESH_STATE, 'release'), '');
  await r.gateEnds(started.path);

  // As after a reboot: the recorded run has no exit code and its process is gone.
  r.mode('pass');
  rmSync(join(started.path, 'gate-exit.log'));
  const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(started.path, 'gate-pid.log'), `${gone}\n`);
  await r.pass();
  await r.gateEnds(started.path);
  assert.equal(r.runs().length, 2, 'started once more in the same worktree');
  await r.pass();
  assert.deepEqual(r.mergeCalls().at(-1).fields, { merge_method: 'merge', sha: heads[B] });
  assert.equal(r.journal(B, 'merged').length, 1);
});

test('a gate that runs past its time bound fails the refresh and the integration repair runs', async (t) => {
  const { r } = await published(t, { [A]: 'a.txt', [B]: 'b.txt' });
  r.mode('hold');
  r.start(ON({ command: GATE, timeoutMinutes: 1 }));
  await r.controller.tick();
  await r.pass();
  assert.equal(r.journal(B, 'merge-refresh-started').length, 1);
  r.later(61_000);
  await r.pass();
  assert.equal(r.journal(B, 'merge-refresh-failed')[0].reason, 'the gate did not finish within 1 minutes');
  assert.equal(r.store.task(B, 'B1').state, 'pending');
  assert.equal(r.mergeCalls().length, 1);
});
