// Shared harness of the merge-refresh, BASE-HOLD and merge-batch tests. Merge-gate refresh (merges.refresh, src/supervisor/merge-refresh.mjs): when the base moved past a verified pull request
// without touching its files, the supervisor runs the gate on the exact merge result itself and merges the unchanged
// head, instead of reopening the task for an AI repair round. A shared file, a failed or stuck gate falls back to that
// repair. Workers are played through applyOutcome; the gate is a synthetic command (fixtures/fake-refresh-gate.mjs) run
// by the real gate helper. No model, network or GitHub call: a disposable origin and the synthetic gh of the merge gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { mergePass, mergeSettings } from '../../src/supervisor/merge.mjs';
import { passedTree, refreshSettings, refreshStep } from '../../src/supervisor/merge-refresh.mjs';
import { branchName } from '../../src/supervisor/adapters/git.mjs';
import { declaration, environment, sleep, passedGate } from './helpers.mjs';

export const here = dirname(fileURLToPath(import.meta.url));
export const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
export const A = 'camp-a', B = 'camp-b', C = 'camp-c';
export const REPOSITORY = 'example-org/sampleapp';
export const GATE = [`"${process.execPath}"`, `"${join(here, 'fixtures', 'fake-refresh-gate.mjs')}"`];
export const ON = (refresh = { command: GATE }) => ({ merges: { delegatedTo: 'supervisor', decision: '#138', repositories: [REPOSITORY], refresh } });
export const task = (id, issue, file) => ({ id, issue, title: `change ${file}`, deliverable: 'commit', goal: `Change ${file}.`,
  dependsOn: [], acceptance: [`${file} changed`], references: ['AGENTS.md'] });

/** Campaigns over a disposable origin, each with one task that writes `files[id]`; published with merging off. */
export async function published(t, files, { branches = {} } = {}) {
  const env = environment({ config: { commands: {
    claude: [process.execPath, join(here, 'fixtures', 'fake-claude.mjs')],
    gh: [process.execPath, join(here, 'fixtures', 'fake-gh-merge.mjs')],
  } } });
  process.env.FAKE_GH_ORIGIN = env.origin;
  const gate = join(env.tmp, 'refresh-gate');
  mkdirSync(gate);
  process.env.FAKE_REFRESH_STATE = gate;
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(async () => {
    // Release any held synthetic gate and wait for it to exit, so no gate child or gate slot outlives the test.
    writeFileSync(join(gate, 'release'), '');
    const paths = [...ids.flatMap((id) => r.journal(id, 'merge-refresh-started').map((detail) => detail.path)),
      ...store.all("SELECT detail FROM journal WHERE campaign_id IS NULL AND kind = 'merge-batch-started'").map((row) => row.detail.path)];
    for (const path of paths) for (let i = 0; i < 600 && existsSync(join(path, 'gate-pid.log')) && !existsSync(join(path, 'gate-exit.log')); i++) await sleep(50);
    r.controller?.release(); store.close(); env.cleanup();
  });
  const ids = Object.keys(files);
  for (const branch of new Set(Object.values(branches))) if (branch !== 'main') git(env.origin, 'branch', branch, 'main');
  ids.forEach((id, i) => {
    const declared = declaration({ campaignId: id, tasks: [task(`${id.at(-1).toUpperCase()}1`, 501 + i, files[id])] });
    if (branches[id]) declared.target.baseBranch = branches[id];
    campaignStart(store, declared);
  });
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
    passedGate(op.workspace); // the verifier's full gate, as the gate helper leaves it
    r.controller.applyOutcome(ctx(id), op, { class: 'result', receipt: { sessionId: op.session_id },
      value: { verdict: 'accepted', summary: 'checked', targetSha: op.target_sha, findings: [], checks: [{ command: 'npm run check', result: 'pass' }] } });
  }
  await r.controller.tick();
  for (const id of ids) assert.ok(store.tasks(id)[0].pr_url, `${id} published`);
  return { r, heads };
}

export const BATCH = () => ({ merges: { ...ON().merges, batch: true } });
export const groupRows = (r, kind) => r.store.all('SELECT detail FROM journal WHERE campaign_id IS NULL AND kind = ? ORDER BY seq', kind).map((row) => row.detail);

export { spawnSync, assert, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, join, Store, campaignStart, Controller, mergePass, mergeSettings, passedTree, refreshSettings, refreshStep, branchName, declaration, environment, sleep, passedGate };
