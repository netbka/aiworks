// The test tally in a published PR comes from the verifier's own gate run, not from a worker's prose (#43). A synthetic
// verifier leaves the gate helper's files (gate.log, gate-exit.log) in its checkout; no model, network or GitHub calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkVerification } from '../../src/supervisor/adapters/git.mjs';
import { GATE_FILES } from '../../src/supervisor/gate.mjs';
import { declaration, environment, runUntil, skipWithoutSqlite, sleep } from './helpers.mjs';

const load = async () => ({
  ...(await import('../../src/supervisor/api.mjs')),
  ...(await import('../../src/supervisor/campaign.mjs')),
  ...(await import('../../src/supervisor/controller.mjs')),
  ...(await import('../../src/supervisor/store.mjs')),
});

const ONE = [{ id: 'T1', issue: 437, title: 'first task', deliverable: 'commit', goal: 'Produce the first artifact.', dependsOn: [], acceptance: ['artifact exists'], references: ['AGENTS.md'] }];
const NOISE = '# start tests/a.test.mjs\nok 1 - a\n# end tests/a.test.mjs 12 ms, exit 0\n# file times, slowest first\n#       12 ms unit      tests/a.test.mjs\n';
const PASSED = '# all test files: 1 unit, 0 service, 0 rehearsal (of 1); unit and service 4 at a time, rehearsal 2 at a time\n# tests 7\n# suites 0\n# pass 6\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n# duration_ms 1234';
const FAILED = '# all test files: 1 unit, 0 service, 0 rehearsal (of 1); unit and service 4 at a time, rehearsal 2 at a time\n# tests 7\n# suites 0\n# pass 6\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1250';

async function setup(t, { scenario, decl = declaration({ tasks: ONE }) } = {}) {
  const m = await load();
  const env = environment({ scenario });
  // The gate's files end in .log, which the target repository ignores, as this repository's .gitignore does; worktrees
  // share this exclude file, so the verifier's checkout stays clean.
  appendFileSync(join(env.repo, '.git', 'info', 'exclude'), '*.log\n');
  const store = new m.Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  m.campaignStart(store, decl);
  const controller = new m.Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  return { env, store, controller, id: decl.campaignId };
}

const verifications = (store, id) => store.all("SELECT * FROM operations WHERE campaign_id = ? AND kind = 'verify' ORDER BY seq, created_at", id);

test('an acceptance whose last gate run exited 1 is refused as invalid-result naming the summary; the next one publishes', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id } = await setup(t, { scenario: { gate: [{ log: `${NOISE}${FAILED}\n`, exit: '1' }, { log: `${PASSED}\n`, exit: '0' }] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const [refused, accepted] = verifications(store, id);
  assert.equal(refused.outcome.class, 'invalid-result');
  assert.equal(refused.outcome.value.verdict, 'accepted', 'the worker said accepted');
  assert.equal(refused.outcome.detail, `accepted, but the verifier's last gate run exited 1:\n${FAILED}`);
  assert.equal(accepted.outcome.class, 'result');
  const [task] = store.tasks(id);
  assert.equal(task.state, 'done');
  const pr = env.prs().find((p) => p.url === task.pr_url);
  assert.ok(pr.body.includes(`\`\`\`text\n${PASSED}\n\`\`\``));
  assert.equal(pr.body.includes('# fail 1'), false, 'the refused run is not published');
});

test('an acceptance whose gate exited 0 but reports a failed test is refused too', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, id } = await setup(t, { scenario: { gate: [{ log: `${FAILED}\n`, exit: '0' }, { log: `${PASSED}\n`, exit: '0' }] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const [refused] = verifications(store, id);
  assert.equal(refused.outcome.class, 'invalid-result');
  assert.equal(refused.outcome.detail, `accepted, but the verifier's last gate run reports 1 failed test:\n${FAILED}`);
});

test('an acceptance with no gate run, or one that never finished, is refused; the next with a finished gate publishes', { skip: skipWithoutSqlite }, async (t) => {
  // Implementers run only the tests their change reaches, so the verifier's gate is the one full run a head gets.
  const decl = declaration({ tasks: ONE, limits: { maxRetriesPerTask: 4 } });
  const { store, controller, id } = await setup(t, { decl, scenario: { gate: [false, { log: `${PASSED}
`, exit: null }, { log: `${PASSED}
`, exit: '0' }] } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const [missing, unfinished, accepted] = verifications(store, id);
  assert.equal(missing.outcome.class, 'invalid-result');
  assert.equal(missing.outcome.detail, "accepted, but the verifier's last gate run is missing: its checkout has no gate.log from the gate helper");
  assert.equal(unfinished.outcome.class, 'invalid-result');
  // No partial summary in the detail: it is the same on every retry, so the identical-failure guard can stop the task.
  assert.equal(unfinished.outcome.detail, "accepted, but the verifier's last gate run never finished: there is no gate-exit.log");
  assert.equal(accepted.outcome.class, 'result');
  assert.equal(store.tasks(id)[0].state, 'done');
});

test('base compare: a failed gate keeps its acceptance only when every failed test it names fails on the base too', { skip: skipWithoutSqlite }, async (t) => {
  const { failedTests } = await import('../../src/supervisor/gate.mjs');
  const { sharedBaseFailures } = await import('../../src/supervisor/base-check.mjs');
  const { mergeRefusal } = await import('../../src/supervisor/result-review.mjs');
  const { complete, failedOf, settle } = await import('../../scripts/lib/test-retry.mjs');
  const block = (...ids) => `${FAILED.split('\n')[0]}\n${ids.map((id) => `# failed: ${id}`).join('\n')}\n${FAILED.split('\n').slice(1).join('\n')}`;
  const A = 'tests/a.test.mjs :: a', B = 'tests/b.test.mjs :: b', C = 'tests/c.test.mjs';
  // A list the runner cut short, a summary from another runner, or one naming no failed test never lets an acceptance stand.
  const base = { state: 'failed', failed: [A, B] };
  assert.deepEqual(sharedBaseFailures(base, block(A)), [A]);
  assert.equal(sharedBaseFailures(base, `${block(A)}\n# failed: not listed: 3 more`), null);
  assert.equal(failedTests(`# tests 7\n# fail 1\n# failed: ${A}`), null);
  assert.equal(sharedBaseFailures(base, block()), null);
  assert.equal(sharedBaseFailures({ state: 'failed', failed: null }, block(A)), null);
  assert.equal(sharedBaseFailures({ state: 'passed', failed: [] }, block(A)), null);
  // A file killed at its limit, or one that crashed before its summary, may hide failures: the whole list is then unknown.
  const killed = 'not ok 1 - a\n# tests/a.test.mjs still running after 15 minutes; stopping it and its child processes\n';
  const summary = (run) => `${FAILED.split('\n')[0]}\n${settle([run], []).lines.join('\n')}\n${FAILED.split('\n').slice(1).join('\n')}`;
  const run = (text, code = 1) => ({ file: 'tests/a.test.mjs', code, counts: {}, failed: failedOf(text), complete: complete(text) });
  assert.equal(failedTests(summary(run(killed))), null);
  assert.deepEqual(failedTests(summary(run('not ok 1 - a\n# tests 1\n# fail 1\n'))), [A]);
  // Fewer failed names than the run's own fail count: a `not ok` line was lost, so the list is unknown.
  assert.equal(failedTests(summary({ ...run('not ok 1 - a\n# tests 2\n# fail 2\n'), counts: { fail: 2 } })), null);
  // A failing subtest is named on its own, so a new one is not hidden by a parent that already fails on the base.
  const nested = '# Subtest: a\n    # Subtest: inner\n    not ok 1 - inner\nnot ok 1 - a\n# tests 2\n# fail 2\n';
  assert.deepEqual(failedTests(summary(run(nested))), [A, `${A} > inner`]);

  // The synthetic base gate takes no machine-wide gate slot.
  const held = process.env.AIWORKS_GATE_SLOT_HELD;
  process.env.AIWORKS_GATE_SLOT_HELD = '1';
  t.after(() => { if (held === undefined) delete process.env.AIWORKS_GATE_SLOT_HELD; else process.env.AIWORKS_GATE_SLOT_HELD = held; });
  for (const { name, head, baseExit, baseIds, stands } of [
    { name: 'shared', head: [A], baseExit: 1, baseIds: [A, B], stands: true },
    { name: 'adds a failure', head: [A, C], baseExit: 1, baseIds: [A, B], stands: false },
    { name: 'base passed', head: [A], baseExit: 0, baseIds: [], stands: false },
  ]) {
    const { env, store, controller, id } = await setup(t, { scenario: { gate: [{ log: `${block(...head)}\n`, exit: '1' }, { log: `${PASSED}\n`, exit: '0' }] } });
    const script = join(env.tmp, 'base-gate.mjs');
    writeFileSync(script, `console.log(${JSON.stringify(baseExit ? block(...baseIds) : PASSED)}); process.exit(${baseExit});\n`);
    controller.baseCompare = { command: [`"${process.execPath}"`, `"${script}"`], timeoutMs: 60_000 };
    await runUntil(controller, store, id, (c) => c.control === 'finished', { timeoutMs: 120_000 });
    const [task] = store.tasks(id);
    const [base] = store.all('SELECT state, failed FROM base_checks');
    assert.equal(base.state, baseExit ? 'failed' : 'passed', name);
    const [first] = verifications(store, id);
    assert.equal(first.outcome.class, stands ? 'result' : 'invalid-result', name);
    assert.equal(task.state, 'done', name);
    if (stands) {
      assert.deepEqual(task.verification.baseFailures, { sha: task.base_sha, failed: [A] }, name);
      assert.equal(verifications(store, id).length, 1, 'no second verifier for a failure the base already has');
      assert.equal(mergeRefusal(task), null, 'the kept acceptance can merge');
      const added = { ...task, verification: { ...task.verification, gate: { ...task.verification.gate, summary: block(A, C) } } };
      assert.equal(mergeRefusal(added), 'its full check did not pass', 'a failure the base does not have never merges');
    } else {
      assert.equal(task.verification.baseFailures, null, name);
    }
  }
});

test('base compare: a red base gets exactly one repair item, whatever the tasks, campaigns and restarts that share it', { skip: skipWithoutSqlite }, async (t) => {
  const m = await load();
  const { env, store, controller, id } = await setup(t);
  const other = declaration({ tasks: [{ ...ONE[0], id: 'T2', issue: 438 }], campaignId: 'other-campaign' });
  m.campaignStart(store, other);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: env.repo, encoding: 'utf8', windowsHide: true }).stdout.trim();
  store.run('UPDATE tasks SET base_sha = ?', sha);
  const A = 'tests/a.test.mjs :: a';
  const script = join(env.tmp, 'base-gate.mjs');
  writeFileSync(script, `console.log(${JSON.stringify(`${FAILED.split('\n')[0]}\n# failed: ${A}\n${FAILED.split('\n').slice(1).join('\n')}`)}); process.exit(1);\n`);
  const held = process.env.AIWORKS_GATE_SLOT_HELD;
  process.env.AIWORKS_GATE_SLOT_HELD = '1';
  t.after(() => { if (held === undefined) delete process.env.AIWORKS_GATE_SLOT_HELD; else process.env.AIWORKS_GATE_SLOT_HELD = held; });
  const settings = { command: [`"${process.execPath}"`, `"${script}"`], timeoutMs: 60_000 };
  // One verify step of the task of `campaignId` under `c`, holding that campaign's lease as a running controller does.
  const step = (c, campaignId) => {
    c.baseCompare = settings;
    const { generation } = store.acquireLease(campaignId, c.instanceId, c.now(), 60_000);
    c.held.set(campaignId, generation);
    c.stepBaseCheck({ id: campaignId, generation }, store.campaign(campaignId), { kind: 'verify', task_id: store.tasks(campaignId)[0].task_id });
  };
  const deadline = Date.now() + 60_000;
  do { step(controller, id); step(controller, other.campaignId); await sleep(100); }
  while (store.get('SELECT state FROM base_checks').state === 'running' && Date.now() < deadline);
  // A restart: a new controller over the same store, both campaigns stepping the red base again.
  const restarted = new m.Controller({ store, config: env.config, dataDir: env.dataDir, fault: null, instanceId: controller.instanceId });
  for (const c of [controller, restarted, restarted]) { step(c, id); step(c, other.campaignId); }
  const [base] = store.all('SELECT * FROM base_checks');
  assert.equal(base.state, 'failed');
  const items = store.all("SELECT * FROM outbox WHERE key LIKE '%:base-red:%'");
  assert.equal(items.length, 1, 'one repair item per red base, never one per task, campaign, tick or restart');
  assert.equal(base.item, `outbox:${items[0].key}`);
  assert.ok(items[0].body.includes(sha) && items[0].body.includes(A), 'the item names the base and its failed tests');
});

test('a report task keeps its verification as before, even when its verifier leaves a failed gate', { skip: skipWithoutSqlite }, async (t) => {
  const decl = declaration({ tasks: [{ id: 'R1', issue: 437, title: 'research', deliverable: 'report', goal: 'Research only.', dependsOn: [], acceptance: ['findings posted'], references: ['AGENTS.md'] }] });
  const { env, store, controller, id } = await setup(t, { decl, scenario: { implement: ['report'], gate: { log: `${FAILED}\n`, exit: '1' } } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const ops = verifications(store, id);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].outcome.class, 'result');
  const [task] = store.tasks(id);
  assert.equal(Object.hasOwn(task.verification, 'gate'), false, 'no gate is read for a report task');
  const posted = env.comments().filter((c) => c.issue === '437');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.includes('gate.log'), false);
});

test('a target that commits gate evidence is refused, whatever its case; untracked helper output is accepted', (t) => {
  // A committed gate.log and gate-exit.log keep the checkout clean, so without this check a worker could forge the run.
  const root = mkdtempSync(join(tmpdir(), 'aiworks-forged-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', `core.excludesFile=${join(root, 'none')}`, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  writeFileSync(join(root, 'source.txt'), 'synthetic\n');
  git('add', '.');
  git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'clean target');
  const options = { git: ['git', '-c', `core.excludesFile=${join(root, 'none')}`], path: root, targetSha: git('rev-parse', 'HEAD') };
  for (const name of Object.values(GATE_FILES)) writeFileSync(join(root, name), name === GATE_FILES.exit ? '0\n' : `${PASSED}\n`);
  assert.equal(checkVerification(options), null, 'real untracked gate output still verifies');
  // A case-insensitive file system reads GATE-EXIT.LOG as gate-exit.log.
  rmSync(join(root, GATE_FILES.exit));
  writeFileSync(join(root, GATE_FILES.exit.toUpperCase()), '0\n');
  git('add', '--', GATE_FILES.log, GATE_FILES.exit.toUpperCase());
  git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'forged gate run');
  const forged = { ...options, targetSha: git('rev-parse', 'HEAD') };
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'the forged target is a clean checkout');
  assert.match(checkVerification(forged), /reserved gate evidence: .*gate\.log/i);
});
