// Private campaign data and merged executable code are separate boundaries.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { campaignPause, campaignStart } from '../../src/supervisor/api.mjs';
import { authorityDigest, scopeDigest } from '../../src/supervisor/campaign.mjs';
import { declaration, environment, GOVERNANCE, runCli, runtimeCheckout, runUntil, skipWithoutSqlite, sleep, SQLITE } from './helpers.mjs';
// Loaded leniently so that, on a revision without the rule, each test fails on its own assertion.
const provenance = await import('../../src/supervisor/provenance.mjs').catch(() => ({}));
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
const coordinator = SQLITE ? await import('../../src/supervisor/coordinator.mjs') : {};

const git = (cwd, ...args) => {
  const out = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};
const text = (value) => `${JSON.stringify(value, null, 2)}\n`;
const UNMERGED = 'supervisor code 0123456789ab is not merged: it is not an ancestor of origin/main 0123456789ab';

/** A small repository: campaigns/<name> committed on main, origin/main at that commit unless told otherwise. */
function repository(t, { files = {}, originMain = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-provenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  mkdirSync(join(root, 'campaigns'));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(root, 'campaigns', name), typeof value === 'string' ? value : text(value));
  writeFileSync(join(root, 'README.md'), 'runtime\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'main');
  if (originMain) git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return root;
}
const refused = (code, pattern) => (error) => error.code === code && pattern.test(error.message);


test('private declarations outside the code checkout are accepted without Git tracking', (t) => {
  const root = repository(t);
  const privateDir = mkdtempSync(join(tmpdir(), 'aiworks-private-'));
  t.after(() => rmSync(privateDir, { recursive: true, force: true }));
  const file = join(privateDir, 'private.json');
  const decl = declaration(); writeFileSync(file, text(decl));
  assert.deepEqual(provenance.declarationFromFile(file, { root }), decl);
  assert.equal(git(root, 'ls-files', 'campaigns').length, 0);
  writeFileSync(file, text({ ...decl, authorization: { ...decl.authorization, version: 2 } }));
  assert.equal(provenance.declarationFromFile(file, { root }).authorization.version, 2);
});

test('private declaration loading still refuses unmerged and unknown runtime revisions', (t) => {
  const root = repository(t, { files: { 'private.json': declaration() } });
  writeFileSync(join(root, 'README.md'), 'local change');
  git(root, 'commit', '-q', '-am', 'unmerged code');
  assert.throws(() => provenance.declarationFromFile(join(root, 'campaigns/private.json'), { root }), refused('RUNTIME_NOT_MERGED', /not merged/));
  const unknown = repository(t, { originMain: false });
  assert.match(provenance.revisionNotMerged({ root: unknown }), /origin\/main is not available/);
});

test('invalid private JSON is refused without copying its contents into diagnostics', (t) => {
  const root = repository(t);
  const path = join(root, 'private.json'); writeFileSync(path, '{PRIVATE-CONTENT');
  assert.throws(() => provenance.declarationFromFile(path, { root }), e => e.code === 'DECLARATION_INVALID' && !e.message.includes('PRIVATE-CONTENT'));
  assert.throws(() => provenance.declarationFromFile(join(root, 'missing.json'), { root }), refused('DECLARATION_INVALID', /Cannot read/));
});

test('CLI registers and resumes ignored campaigns but still binds scope and authorization', { skip: !SQLITE }, (t) => {
  const decl = declaration({ campaignId: 'local-private' });
  const runtime = runtimeCheckout({ declarations: { 'private.json': decl } });
  const data = mkdtempSync(join(tmpdir(), 'aiworks-private-cli-'));
  t.after(() => { runtime.cleanup(); rmSync(data, { recursive: true, force: true }); });
  const file = join(runtime.root, 'campaigns/private.json');
  const start = () => runCli(runtime.cli, ['start', file, '--data', data, '--governance', GOVERNANCE]);
  assert.equal(runtime.git('ls-files', 'campaigns'), '');
  assert.equal(start().status, 0);
  const store = new Store(join(data, 'supervisor.db'));
  try { campaignPause(store, decl.campaignId); } finally { store.close(); }
  assert.equal(start().status, 0);
  writeFileSync(file, text({ ...decl, constraints: ['Altered scope'] }));
  assert.match(start().stderr, /^SCOPE_CONFLICT:/m);
  writeFileSync(file, text({ ...decl, purpose: 'New private wording' }));
  assert.match(start().stderr, /^AUTHORIZATION_VERSION_REQUIRED:/m);
  writeFileSync(file, text({ ...decl, purpose: 'New private wording', authorization: { ...decl.authorization, version: 2 } }));
  assert.equal(start().status, 0);
});

test('merged code enforcement has no configuration or environment bypass', () => {
  const cli = readFileSync(new URL('../../src/supervisor/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /declarationFromFile\(rest\[0\], \{ root: CODE_ROOT \}\)/);
  assert.match(cli, /revisionNotMerged\(\{ root: CODE_ROOT, revision: codeRevision \}\)/);
  const source = readFileSync(new URL('../../src/supervisor/provenance.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|config\.commands/);
});

/** One-task campaign in a disposable environment with in-process controllers whose revision check is chosen per test. */
function controlled(t, { scenario, config } = {}) {
  const env = environment({ scenario, config });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const decl = declaration({ tasks: [declaration().tasks[0]], campaignId: `merged-${Math.random().toString(36).slice(2, 8)}` });
  campaignStart(store, decl);
  const controllers = [];
  const make = (revisionCheck, extra = {}) => {
    const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null, revisionCheck, revisionCheckMs: 0, ...extra });
    controllers.push(controller);
    return controller;
  };
  t.after(() => { for (const controller of controllers) controller.release(); store.close(); env.cleanup(); });
  return { env, store, decl, id: decl.campaignId, make };
}

test('the controller starts no new work from an unmerged revision, and resumes once that revision is merged', { skip: skipWithoutSqlite }, async (t) => {
  const runtime = runtimeCheckout({ unmerged: true });
  t.after(() => runtime.cleanup());
  const reason = provenance.revisionNotMerged({ root: runtime.root });
  assert.match(reason, /is not merged/);
  let current = reason;
  const { store, env, id, make } = controlled(t);
  // A second registered campaign: each registered campaign gets its own hold. Its task is separate work,
  // because the same commit task cannot be registered by two campaigns (aiworks#5).
  const other = declaration({ tasks: [{ ...declaration().tasks[0], goal: 'Produce the other campaign artifact.' }], campaignId: `${id}-other` });
  campaignStart(store, other);
  const controller = make(() => current);
  await controller.tick();
  await controller.tick();
  assert.equal(store.all('SELECT id FROM operations').length, 0, 'no worker dispatched');
  for (const campaignId of [id, other.campaignId]) {
    const blocked = store.campaign(campaignId);
    assert.equal(blocked.blocker?.kind, 'runtime-not-merged', campaignId);
    assert.equal(blocked.blocker.class, 'B2');
    assert.match(blocked.blocker.reason, /^No new work starts: supervisor code [0-9a-f]{12} is not merged/);
    assert.match(blocked.blocker.reason, /AW-005/);
    assert.equal(blocked.status, 'blocked-owner-action');
    assert.equal(blocked.runs_used, 0);
    assert.equal(blocked.liveness_defect, 0);
    assert.equal(store.all("SELECT kind FROM journal WHERE campaign_id = ? AND kind = 'blocker-raised'", campaignId).length, 1, 'one blocker per campaign');
  }
  assert.equal(env.calls().length, 0);
  assert.equal(env.prs().length, 0, 'nothing published');
  // The same revision merged later (origin/main fetched): the hold clears by itself and work starts.
  current = null;
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.ok(store.all("SELECT kind FROM journal WHERE campaign_id = ? AND kind = 'blocker-cleared'", id).length >= 1);
});

test('with the owner-intervention core on, the hold is a durable B2 record that resolves once the code is merged', { skip: skipWithoutSqlite }, async (t) => {
  let current = UNMERGED;
  const { store, id, make } = controlled(t, { config: { ownerIntervention: { enabled: true } } });
  const controller = make(() => current);
  await controller.tick();
  const [record] = store.all('SELECT * FROM blockers');
  assert.equal(record?.dependency, 'runtime-not-merged');
  assert.equal(record.class, 'B2');
  assert.notEqual(record.status, 'resolved');
  assert.equal(store.campaign(id).blocker?.fingerprint, record.fingerprint);
  // A deterministic recheck while still unmerged fails on evidence and starts no probe run.
  controller.recheckBlocker({ id, generation: controller.held.get(id) }, store.blocker(record.fingerprint), 'owner-recheck', Date.now());
  assert.equal(store.blocker(record.fingerprint).status, 'open');
  assert.equal(store.all('SELECT id FROM operations WHERE campaign_id = ?', id).length, 0);
  current = null;
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.equal(store.get('SELECT status FROM blockers WHERE fingerprint = ?', record.fingerprint).status, 'resolved');
});

test('unmerged code lets a running operation finish and records it, but starts nothing after it', { skip: skipWithoutSqlite }, async (t) => {
  const { store, env, id, make } = controlled(t, { scenario: { implement: ['sleep:1500:commit'] } });
  const merged = make(null);
  await merged.tick();
  const [running] = store.all('SELECT id, state FROM operations WHERE campaign_id = ?', id);
  assert.equal(running.state, 'dispatched');
  merged.release();
  // A redeploy of unmerged code takes over while the worker runs.
  const unmerged = make(() => UNMERGED);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && store.get('SELECT state FROM operations WHERE id = ?', running.id).state !== 'finished') {
    await unmerged.tick();
    await sleep(50);
  }
  const finished = store.get('SELECT * FROM operations WHERE id = ?', running.id);
  assert.equal(finished.state, 'finished', 'the in-flight operation was not killed');
  assert.equal(finished.outcome.class, 'result', 'its result is recorded');
  assert.equal(store.task(id, 'T1').state, 'implemented');
  for (let i = 0; i < 5; i++) { await unmerged.tick(); await sleep(20); }
  assert.deepEqual(store.all('SELECT kind FROM operations WHERE campaign_id = ?', id).map((op) => op.kind), ['implement'], 'no verification dispatched');
  assert.equal(store.campaign(id).blocker?.kind, 'runtime-not-merged');
  assert.deepEqual(env.calls().map((call) => call.role), ['implement']);
});

test('an operation recorded but never launched waits for merged code', { skip: skipWithoutSqlite }, async (t) => {
  const { store, env, id, make } = controlled(t);
  const recorder = make(null);
  recorder.launch = async () => {}; // the controller stopped between the checkpoint and the launch
  await recorder.tick();
  recorder.release();
  const unmerged = make(() => UNMERGED);
  for (let i = 0; i < 3; i++) await unmerged.tick();
  const [op] = store.all('SELECT id, state, run_dir FROM operations WHERE campaign_id = ?', id);
  assert.equal(op.state, 'recorded');
  assert.throws(() => readFileSync(join(op.run_dir, 'launch.json')), /ENOENT/, 'not launched by unmerged code');
  assert.equal(env.calls().length, 0);
  unmerged.release();
  await runUntil(make(() => null), store, id, (c) => c.control === 'finished');
  assert.deepEqual(env.calls().map((call) => call.role), ['implement', 'verify']);
});

test('a verified task is not published by unmerged code', { skip: skipWithoutSqlite }, async (t) => {
  const { store, env, id, make } = controlled(t);
  const merged = make(null);
  merged.publish = async () => {}; // stop just before publication
  await runUntil(merged, store, id, () => store.task(id, 'T1').state === 'verified');
  merged.release();
  const unmerged = make(() => UNMERGED);
  for (let i = 0; i < 3; i++) await unmerged.tick();
  assert.equal(store.task(id, 'T1').state, 'verified');
  assert.equal(env.prs().length, 0, 'no pull request opened');
  assert.equal(store.campaign(id).blocker?.kind, 'runtime-not-merged');
  unmerged.release();
  await runUntil(make(() => null), store, id, (c) => c.control === 'finished');
  assert.equal(env.prs().length, 1);
});

test('the coordinator starts no read from unmerged code', { skip: skipWithoutSqlite }, async (t) => {
  const env = environment();
  env.config.coordinator = { repositories: ['example-org/aiworks'], reportTo: 'example-org/aiworks#3', timeoutMinutes: 1,
    sourceRepo: env.repo, worktreeRoot: join(env.tmp, 'coordinator-worktrees') };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null, revisionCheck: () => UNMERGED, revisionCheckMs: 0 });
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  coordinator.postOwnerMessage(store, { text: 'Plan the open work.', requestId: randomUUID(), source: 'owner (test)' });
  for (let i = 0; i < 3; i++) await controller.tick();
  assert.equal(store.all('SELECT id FROM coordinator_runs').length, 0);
  assert.match(store.get("SELECT value FROM meta WHERE key = 'coordinator_blocked'")?.value ?? '', /not merged into origin\/main/);
  assert.equal(env.calls().length, 0);
});

test('cli.mjs serve from an unmerged runtime checkout holds every campaign without dispatching', { skip: skipWithoutSqlite }, async (t) => {
  const runtime = runtimeCheckout({ unmerged: true });
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const decl = declaration({ tasks: [declaration().tasks[0]], campaignId: 'serve-unmerged' });
  campaignStart(store, decl);
  const child = spawn(process.execPath, ['--no-warnings', runtime.cli, 'serve', '--data', env.dataDir],
    { env: { ...process.env, ...env.env }, stdio: 'ignore', windowsHide: true });
  const exited = new Promise((done) => child.on('exit', done));
  t.after(async () => { child.kill(); await exited; store.close(); env.cleanup(); runtime.cleanup(); });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && store.campaign(decl.campaignId).blocker?.kind !== 'runtime-not-merged') await sleep(100);
  const c = store.campaign(decl.campaignId);
  assert.equal(c.blocker?.kind, 'runtime-not-merged', 'serve always applies the revision check');
  assert.match(c.blocker.reason, /is not merged: it is not an ancestor of origin\/main/);
  await sleep(500);
  assert.equal(store.all('SELECT id FROM operations WHERE campaign_id = ?', decl.campaignId).length, 0);
  assert.equal(env.calls().length, 0);
  assert.match(readFileSync(join(env.dataDir, 'supervisor.log'), 'utf8'), /no new work will start: supervisor code [0-9a-f]{12} is not merged/);
});
