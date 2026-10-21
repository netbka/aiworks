// Slice PROG3 of docs/PROJECT_WORKSPACE_PLAN.md section 6.8d: the supervisor registers the next wave of an approved
// program by itself, built switched off. A disposable origin holds a synthetic plan; the store, the record and the
// governance registry are synthetic. No worker runs: no model, network or GitHub call.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, GOVERNANCE, SQLITE } from './helpers.mjs';

const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const { campaignStart } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const program = SQLITE ? await import('../../src/supervisor/program.mjs') : {};
const HOUR = 60 * 60_000;
// A host whose temporary directory lies inside a Git work tree must not decide these tests, as program.test.mjs does.
process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());

const PLAN = `# Sample plan

## 6. Build order

Paths: \`sup/\` is \`src/supervisor/\`, \`ts/\` is \`tests/supervisor/\`.

### 6.3 Lane WAV - waves

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **WAV1** | The first module exists. | \`sup/one.mjs\` (new) | none | The first test passes | No |
| **WAV2** | The second module builds on it. | \`sup/two.mjs\` (new) | WAV1 | The second test passes | No |

**Turn order:** WAV1 → WAV2.

| Shared file | Writers, in order |
| --- | --- |
| \`sup/one.mjs\` | WAV1 |
`;

const record = {
  schema: 'aiworks-program/1', programId: 'sample-program', repository: 'example-org/sampleapp', baseBranch: 'main',
  plan: 'docs/PLAN.md', allow: ['WAV'], exclude: [],
  executor: { kind: 'claude-cli', model: 'opus', permissionMode: 'auto', implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 },
  constraints: ['Synthetic program constraint: no network, no production.'],
  authorization: { version: 1, grantedBy: 'owner', grantedAt: '2026-10-17', reference: 'https://github.com/example-org/sampleapp/issues/9', text: 'Synthetic program approval.' },
};

const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};

/**
 * A disposable origin whose main holds the plan, a store with the approved record and one finished campaign for the
 * repository (the wave's project and tracking issue come from it), and a controller on a hand-moved clock.
 */
function setup(t, { enabled = true, governanceRoot = GOVERNANCE, plan = PLAN, programRecord = record } = {}) {
  const env = environment();
  mkdirSync(join(env.repo, 'docs'), { recursive: true });
  writeFileSync(join(env.repo, 'docs', 'PLAN.md'), plan);
  git(env.repo, 'add', '-A');
  git(env.repo, 'commit', '-q', '-m', 'plan');
  git(env.repo, 'push', '-q', 'origin', 'main');
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  program.approveProgram(store, programRecord, { now: 1 });
  campaignStart(store, declaration({ campaignId: 'seed' }), 1);
  store.run("UPDATE campaigns SET control = 'finished' WHERE id = 'seed'");
  const clock = { now: Date.parse('2026-10-17T10:00:00Z') };
  const config = { ...env.config, governanceRoot, ...(enabled ? { program: { enabled: true } } : {}) };
  const controller = (options = {}) => new Controller({ store, config, dataDir: env.dataDir, now: () => clock.now, revisionCheck: () => null, ...options });
  t.after(() => { store.close(); env.cleanup(); });
  return { env, store, clock, controller };
}

const waveIds = (store) => store.all("SELECT id FROM campaigns WHERE id LIKE 'sample-program-w%' ORDER BY id").map((row) => row.id);
const journal = (store, kind) => store.all('SELECT campaign_id, detail FROM journal WHERE kind = ? ORDER BY seq', kind);
const wavesTable = (store) => Boolean(store.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'program_waves'"));

test('off, stopped or on unmerged code: a pass registers nothing and changes no status', { skip: !SQLITE }, async (t) => {
  const off = setup(t, { enabled: false });
  const before = program.programStatus({ store: off.store, dataDir: off.env.dataDir, config: off.env.config });
  await off.controller().tick();
  assert.deepEqual(waveIds(off.store), []);
  assert.equal(wavesTable(off.store), false);
  assert.deepEqual(program.programStatus({ store: off.store, dataDir: off.env.dataDir, config: off.env.config }), before);
  assert.deepEqual(off.store.all("SELECT kind FROM journal WHERE kind LIKE 'program-%' AND kind != 'program-approved'"), []);

  const on = setup(t);
  program.stopPrograms(on.env.dataDir, { now: on.clock.now });
  await on.controller().tick();
  assert.deepEqual(program.programPass(on.controller({ revisionCheck: () => 'not merged' })), []);
  assert.deepEqual(waveIds(on.store), [], 'PROGRAM-STOP or code that is not merged registers nothing');
  rmSync(join(on.env.dataDir, program.PROGRAM_STOP));
  assert.deepEqual(program.programPass(on.controller({ revisionCheck: () => 'not merged' })), []);
  assert.deepEqual(waveIds(on.store), []);
  // The same setup with every switch clear registers its first wave: the cases above were held by the switches alone.
  await on.controller().tick();
  assert.deepEqual(waveIds(on.store), ['sample-program-w1']);
});

test('on: a fitting wave is registered once, also after a crash between registration and journal, and one wave at a time', { skip: !SQLITE }, async (t) => {
  const { env, store, clock, controller } = setup(t);
  const first = controller();
  let crashed = false;
  first.injectFault = (name) => { if (name === 'program-after-register' && !crashed) { crashed = true; throw new Error('crash rehearsal'); } };
  await first.tick();
  assert.equal(crashed, true);
  assert.deepEqual(waveIds(store), [], 'the crash undid the registration');
  assert.deepEqual(store.all('SELECT * FROM program_waves'), []);
  assert.deepEqual(journal(store, 'program-registered'), []);

  clock.now += HOUR;
  const [registered] = program.programPass(first);
  assert.equal(registered.registered, true);
  assert.deepEqual(waveIds(store), ['sample-program-w1']);
  assert.deepEqual(store.tasks('sample-program-w1').map((task) => [task.task_id, task.state]), [['WAV1', 'pending']]);
  const events = journal(store, 'program-registered');
  assert.equal(events.length, 1);
  assert.equal(events[0].campaign_id, 'sample-program-w1');
  assert.equal(events[0].detail.recordDigest, program.programDigest(record));
  assert.equal(events[0].detail.declarationDigest, registered.declarationDigest);

  // An unfinished wave holds the next one, also for a restarted controller that checks at once.
  clock.now += HOUR;
  assert.deepEqual(program.programPass(first).map((result) => result.waiting), ['wave sample-program-w1 has unfinished tasks']);
  assert.deepEqual(program.programPass(controller()).map((result) => result.waiting), ['wave sample-program-w1 has unfinished tasks']);
  assert.deepEqual(waveIds(store), ['sample-program-w1']);

  // WAV1 done with its verified commit on main: the next pass registers wave 2 with WAV2, and nothing twice.
  const main = git(env.repo, 'rev-parse', 'HEAD');
  store.run("UPDATE tasks SET state = 'done', verified_sha = ? WHERE campaign_id = 'sample-program-w1'", main);
  store.run("UPDATE campaigns SET control = 'finished' WHERE id = 'sample-program-w1'");
  clock.now += HOUR;
  program.programPass(first);
  program.programPass(controller());
  assert.deepEqual(waveIds(store), ['sample-program-w1', 'sample-program-w2']);
  assert.deepEqual(store.tasks('sample-program-w2').map((task) => task.task_id), ['WAV2']);
  assert.deepEqual(store.all('SELECT wave FROM program_waves ORDER BY wave').map((row) => row.wave), [1, 2]);
  assert.equal(journal(store, 'program-registered').length, 2);
});

test('a misfit registers nothing and becomes one Needs you item with the reason and the proposed declaration', { skip: !SQLITE }, (t) => {
  // A governance checkout in which the target repository is not a registered project: cli.mjs start would refuse it too.
  const governance = mkdtempSync(join(tmpdir(), 'aiworks-governance-'));
  t.after(() => rmSync(governance, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  cpSync(GOVERNANCE, governance, { recursive: true });
  rmSync(join(governance, 'registry', 'projects', 'sampleapp.json'));
  const { store, clock, controller } = setup(t, { governanceRoot: governance });
  const pass = controller();
  for (let n = 0; n < 2; n += 1) {
    const [result] = program.programPass(pass);
    assert.equal(result.registered, false);
    clock.now += HOUR;
  }
  assert.deepEqual(waveIds(store), []);
  assert.equal(wavesTable(store), false);
  const items = store.all("SELECT * FROM blockers WHERE status = 'open'");
  assert.equal(items.length, 1, 'one Needs you item, however often the pass sees the misfit');
  assert.equal(items[0].class, 'B3');
  assert.equal(items[0].occurrences, 2);
  assert.match(items[0].summary, /not a registered project/);
  const misfits = journal(store, 'program-misfit');
  assert.equal(misfits.length, 1);
  assert.deepEqual(misfits[0].detail.declaration.tasks.map((task) => task.id), ['WAV1']);
});

test('no Needs you item while a verified wave task is not yet on main; one once only an excluded dependency holds', { skip: !SQLITE }, (t) => {
  // WAV2 depends on WAV1 and on WAV3, which the record excludes: no wave ever builds WAV3 (#228).
  const plan = PLAN.replace('| WAV1 | The second test passes | No |', `| WAV1, WAV3 | The second test passes | No |
| **WAV3** | A deferred module. | \`sup/three.mjs\` (new) | none | The third test passes | No |`);
  const { env, store, clock, controller } = setup(t, { plan, programRecord: { ...record, exclude: ['WAV3'] } });
  const pass = controller();
  assert.equal(program.programPass(pass)[0].registered, true);
  assert.deepEqual(store.tasks('sample-program-w1').map((task) => task.task_id), ['WAV1']);

  // WAV1 verified on a branch whose merge has not reached main yet: the wave is closed but its work is in flight.
  git(env.repo, 'checkout', '-q', '-b', 'wav1');
  writeFileSync(join(env.repo, 'one.txt'), 'one');
  git(env.repo, 'add', '-A');
  git(env.repo, 'commit', '-q', '-m', 'WAV1');
  const verified = git(env.repo, 'rev-parse', 'HEAD');
  git(env.repo, 'push', '-q', 'origin', 'wav1');
  git(env.repo, 'checkout', '-q', 'main');
  store.run("UPDATE tasks SET state = 'done', verified_sha = ? WHERE campaign_id = 'sample-program-w1'", verified);
  store.run("UPDATE campaigns SET control = 'finished' WHERE id = 'sample-program-w1'");
  clock.now += HOUR;
  assert.deepEqual(program.programPass(pass).map((result) => result.waiting), ['no slice is ready']);
  assert.deepEqual(store.all('SELECT fingerprint FROM blockers'), [], 'work on its way to main is not a stall');
  assert.deepEqual(journal(store, 'program-misfit'), []);

  // The same plan with WAV1 on main: WAV2 is held only by the excluded WAV3, so the program records its one item.
  git(env.repo, 'merge', '-q', '--ff-only', 'wav1');
  git(env.repo, 'push', '-q', 'origin', 'main');
  clock.now += HOUR;
  assert.equal(program.programPass(pass)[0].registered, false);
  const items = store.all("SELECT * FROM blockers WHERE status = 'open'");
  assert.equal(items.length, 1);
  assert.equal(items[0].class, 'B3');
  assert.match(items[0].summary, /WAV2/);
  assert.deepEqual(waveIds(store), ['sample-program-w1']);
});
