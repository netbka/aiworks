// The test tally in a published PR comes from the verifier's own gate run, not from a worker's prose (#43). A synthetic
// verifier leaves the gate helper's files (gate.log, gate-exit.log) in its checkout; no model, network or GitHub calls.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, runUntil, skipWithoutSqlite } from './helpers.mjs';

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

test('the PR body shows the summary block read from the verifier\'s own gate output, verbatim', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id } = await setup(t, { scenario: { gate: { log: `${NOISE}${PASSED}\n`, exit: '0' } } });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const [task] = store.tasks(id);
  assert.equal(task.state, 'done');
  assert.deepEqual(task.verification.gate, { exit: '0', summary: PASSED });
  const pr = env.prs().find((p) => p.url === task.pr_url);
  const gate = pr.body.slice(pr.body.indexOf('### Gate'));
  assert.ok(gate.includes("Read by the supervisor from the verifier's own gate output (`gate.log`), not typed by a worker. Exit code 0."), gate);
  assert.ok(gate.includes(`\`\`\`text\n${PASSED}\n\`\`\``), 'the summary block is copied verbatim');
  assert.equal(pr.body.includes('# start tests/a.test.mjs'), false, 'only the summary block, not the rest of the log');
  assert.ok(gate.includes('Not merged and not deployed'));
});

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

test('without gate files the PR body says no gate output was found and the verdict is unchanged', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id } = await setup(t);
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const ops = verifications(store, id);
  assert.equal(ops.length, 1, 'one verification, accepted');
  assert.equal(ops[0].outcome.class, 'result');
  const [task] = store.tasks(id);
  assert.equal(task.state, 'done');
  assert.equal(task.verification.gate, null);
  const pr = env.prs().find((p) => p.url === task.pr_url);
  assert.ok(pr.body.includes("No gate output was found: the verifier's checkout had no `gate.log` from the gate helper (`src/supervisor/gate.mjs`)."), pr.body);
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
