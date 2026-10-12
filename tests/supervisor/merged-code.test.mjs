// AW-005 (docs/DECISIONS.md): a campaign runs only from merged supervisor code, with its declaration file in campaigns/
// on main. Registration and resume through `cli.mjs start <file>` check the file and the checkout; the controller starts
// no new work from an unmerged revision. Every case uses disposable git repositories; no model, network or GitHub call.
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

test('a committed, unmodified declaration at a merged HEAD is accepted, from its committed blob', (t) => {
  const decl = declaration({ campaignId: 'merged-one' });
  const root = repository(t, { files: { 'merged-one.json': decl } });
  assert.deepEqual(provenance.declarationFromMain(join(root, 'campaigns', 'merged-one.json'), { root }), decl);
  // Line endings converted by the checkout (core.autocrlf, as on HomePc) are not a modification.
  writeFileSync(join(root, 'campaigns', 'merged-one.json'), text(decl).replace(/\n/g, '\r\n'));
  assert.deepEqual(provenance.declarationFromMain(join(root, 'campaigns', 'merged-one.json'), { root }), decl);
  // origin/main moving ahead keeps HEAD an ancestor: a fresh deploy never fails for that.
  git(root, 'checkout', '-q', '-b', 'later');
  writeFileSync(join(root, 'README.md'), 'later on main\n');
  git(root, 'commit', '-q', '-am', 'later on main');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-q', '--detach', 'main');
  assert.equal(provenance.revisionNotMerged({ root }), null);
  assert.deepEqual(provenance.declarationFromMain(join(root, 'campaigns', 'merged-one.json'), { root }), decl);
});

test('a declaration outside campaigns/ is refused, even a committed copy elsewhere', (t) => {
  const decl = declaration({ campaignId: 'outside' });
  const root = repository(t, { files: { 'outside.json': decl } });
  mkdirSync(join(root, 'campaigns', 'nested'));
  writeFileSync(join(root, 'campaigns', 'nested', 'outside.json'), text(decl));
  writeFileSync(join(root, 'outside.json'), text(decl));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'copies outside campaigns/');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const elsewhere = mkdtempSync(join(tmpdir(), 'aiworks-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  writeFileSync(join(elsewhere, 'outside.json'), text(decl));
  for (const file of [join(root, 'outside.json'), join(root, 'campaigns', 'nested', 'outside.json'), join(elsewhere, 'outside.json'),
    join(root, 'campaigns', '..', 'outside.json'), join(root, 'campaigns', 'missing.json')]) {
    assert.throws(() => provenance.declarationFromMain(file, { root }), refused('DECLARATION_NOT_ON_MAIN', /campaigns|cannot be read/), file);
  }
});

test('an untracked, staged-only or modified declaration is refused', (t) => {
  const decl = declaration({ campaignId: 'tracked' });
  const root = repository(t, { files: { 'tracked.json': decl } });
  writeFileSync(join(root, 'campaigns', 'untracked.json'), text(declaration({ campaignId: 'untracked' })));
  assert.throws(() => provenance.declarationFromMain(join(root, 'campaigns', 'untracked.json'), { root }),
    refused('DECLARATION_NOT_ON_MAIN', /campaigns\/untracked\.json is not committed at this checkout's HEAD/));
  git(root, 'add', 'campaigns/untracked.json'); // staged is still not committed
  assert.throws(() => provenance.declarationFromMain(join(root, 'campaigns', 'untracked.json'), { root }), refused('DECLARATION_NOT_ON_MAIN', /not committed/));
  writeFileSync(join(root, 'campaigns', 'tracked.json'), text({ ...decl, limits: { ...decl.limits, maxWorkerRuns: 99 } }));
  assert.throws(() => provenance.declarationFromMain(join(root, 'campaigns', 'tracked.json'), { root }),
    refused('DECLARATION_NOT_ON_MAIN', /campaigns\/tracked\.json differs from its committed version at HEAD/));
});

test('a HEAD that is not an ancestor of origin/main, or no origin/main, is refused', (t) => {
  const decl = declaration({ campaignId: 'local' });
  const root = repository(t, { files: { 'local.json': decl } });
  writeFileSync(join(root, 'README.md'), 'a local commit\n');
  git(root, 'commit', '-q', '-am', 'not on origin/main');
  assert.match(provenance.revisionNotMerged({ root }), /is not merged: it is not an ancestor of origin\/main/);
  assert.throws(() => provenance.declarationFromMain(join(root, 'campaigns', 'local.json'), { root }),
    refused('RUNTIME_NOT_MERGED', /is not an ancestor of origin\/main/));
  const unfetched = repository(t, { files: { 'local.json': decl }, originMain: false });
  assert.throws(() => provenance.declarationFromMain(join(unfetched, 'campaigns', 'local.json'), { root: unfetched }),
    refused('RUNTIME_NOT_MERGED', /origin\/main is not available/));
  assert.match(provenance.revisionNotMerged({ root, revision: null }), /unknown/);
  assert.match(provenance.revisionNotMerged({ root, revision: 'f'.repeat(40) }), /cannot be resolved/);
});

test('a stored declaration resumes when any merged revision committed it; main\'s tip is not required', (t) => {
  const v1 = declaration({ campaignId: 'history' });
  const v2 = { ...v1, authorization: { ...v1.authorization, version: 2 }, limits: { ...v1.limits, maxWorkerRuns: 20 } };
  const root = repository(t, { files: { 'history.json': v1 } });
  const first = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'campaigns', 'history.json'), text(v2));
  git(root, 'commit', '-q', '-am', 'amend the declaration on main');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal(provenance.storedDeclarationOnMain(v1, { root }), `${first}:campaigns/history.json`, 'an older merged version');
  assert.match(provenance.storedDeclarationOnMain(v2, { root }), /:campaigns\/history\.json$/);
  // Committed under another file name on main still counts; the content is what was merged.
  const renamed = { ...v1, campaignId: 'renamed' };
  writeFileSync(join(root, 'campaigns', 'other-name.json'), text(renamed));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'another declaration');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.match(provenance.storedDeclarationOnMain(renamed, { root }), /:campaigns\/other-name\.json$/);
  // A version committed only after origin/main, or never committed, is refused.
  const local = { ...v2, authorization: { ...v2.authorization, version: 3 } };
  writeFileSync(join(root, 'campaigns', 'history.json'), text(local));
  git(root, 'commit', '-q', '-am', 'local amendment, not merged');
  for (const stored of [local, declaration({ campaignId: 'never-committed' })]) {
    assert.throws(() => provenance.storedDeclarationOnMain(stored, { root }),
      refused('DECLARATION_NOT_ON_MAIN', /is not committed in campaigns\/ in any revision merged to main; .*main's tip is not required/));
  }
  const unfetched = repository(t, { files: { 'history.json': v1 }, originMain: false });
  assert.throws(() => provenance.storedDeclarationOnMain(v1, { root: unfetched }), refused('DECLARATION_NOT_ON_MAIN', /origin\/main is not available/));
});

test('cli.mjs start registers and resumes only committed declarations of a merged runtime checkout', { skip: !SQLITE }, (t) => {
  const decl = declaration({ campaignId: 'cli-merged' });
  const merged = runtimeCheckout({ declarations: { 'cli-merged.json': decl } });
  const unmerged = runtimeCheckout({ declarations: { 'cli-merged.json': decl }, unmerged: true });
  const data = mkdtempSync(join(tmpdir(), 'aiworks-cli-merged-'));
  t.after(() => { merged.cleanup(); unmerged.cleanup(); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const start = (cli, file, dir) => runCli(cli, ['start', file, '--data', join(data, dir), '--governance', GOVERNANCE]);
  const stored = (dir) => {
    const store = new Store(join(data, dir, 'supervisor.db'));
    try { return store.campaign(decl.campaignId); } finally { store.close(); }
  };

  // Refused: another checkout's campaigns/, an unmerged runtime HEAD, an untracked or a modified file. Nothing is stored.
  for (const [dir, cli, file, pattern] of [
    ['other-checkout', merged.cli, join(unmerged.root, 'campaigns', 'cli-merged.json'), /^DECLARATION_NOT_ON_MAIN: .* is not a file in /m],
    ['unmerged', unmerged.cli, join(unmerged.root, 'campaigns', 'cli-merged.json'), /^RUNTIME_NOT_MERGED: supervisor code [0-9a-f]{12} is not merged/m],
  ]) {
    const out = start(cli, file, dir);
    assert.equal(out.status, 1, dir);
    assert.match(out.stderr, pattern, dir);
    assert.equal(stored(dir), null, `${dir}: nothing registered`);
  }
  writeFileSync(join(merged.root, 'campaigns', 'cli-untracked.json'), text(declaration({ campaignId: 'cli-untracked' })));
  const untracked = start(merged.cli, join(merged.root, 'campaigns', 'cli-untracked.json'), 'untracked');
  assert.equal(untracked.status, 1);
  assert.match(untracked.stderr, /^DECLARATION_NOT_ON_MAIN: campaigns\/cli-untracked\.json is not committed/m);
  const none = new Store(join(data, 'untracked', 'supervisor.db'));
  try { assert.equal(none.campaign('cli-untracked'), null, 'untracked: nothing registered'); } finally { none.close(); }

  // Accepted: register, then the deploy procedure's identical resume after a pause.
  const registered = start(merged.cli, join(merged.root, 'campaigns', 'cli-merged.json'), 'live');
  assert.equal(registered.status, 0, registered.stderr);
  assert.equal(JSON.parse(registered.stdout).scopeDigest, scopeDigest(decl));
  pauseAt(join(data, 'live'), decl.campaignId);
  const resumed = start(merged.cli, join(merged.root, 'campaigns', 'cli-merged.json'), 'live');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).control, 'registered');
  assert.equal(authorityDigest(stored('live').declaration), authorityDigest(decl), 'the stored declaration is the committed one');

  // A resume or amendment from an edited, uncommitted file is refused and leaves the campaign as it was.
  pauseAt(join(data, 'live'), decl.campaignId);
  writeFileSync(join(merged.root, 'campaigns', 'cli-merged.json'), text({ ...decl, authorization: { ...decl.authorization, version: 2 } }));
  const edited = start(merged.cli, join(merged.root, 'campaigns', 'cli-merged.json'), 'live');
  assert.equal(edited.status, 1);
  assert.match(edited.stderr, /^DECLARATION_NOT_ON_MAIN: campaigns\/cli-merged\.json differs from its committed version/m);
  assert.equal(stored('live').control, 'paused');
  assert.equal(stored('live').authorization_version, 1);
});

function pauseAt(dataDir, id) {
  const store = new Store(join(dataDir, 'supervisor.db'));
  try { campaignPause(store, id, 'upgrade'); } finally { store.close(); }
}

test('no CLI flag, config.json key or environment variable skips the checks', () => {
  const sources = ['src/supervisor/provenance.mjs', 'src/supervisor/cli.mjs', 'src/supervisor/controller.mjs', 'src/dashboard/supervisor.mjs']
    // Code only: comments may name config.json and the environment to say they are not read.
    .map((path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\/\*\*|\*)/.test(line)).map((line) => line.replace(/\s\/\/ .*$/, '')).join('\n'));
  const [provenanceSource, cliSource, controllerSource] = sources;
  assert.doesNotMatch(provenanceSource, /process\.env|config\b|argv/, 'the checks read no environment, configuration or arguments');
  assert.match(cliSource, /declarationFromMain\(rest\[0\], \{ root: CODE_ROOT \}\)/, 'start always checks this checkout');
  assert.match(cliSource, /revisionNotMerged\(\{ root: CODE_ROOT, revision: codeRevision \}\)/, 'serve always checks its own revision');
  assert.doesNotMatch(controllerSource, /config\.revisionCheck/, 'the controller takes no revision setting from config.json');
  for (const source of sources) assert.doesNotMatch(source, /AIWORKS_[A-Z_]*(MERGED|PROVENANCE|BYPASS|SKIP)/);
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
  // A second registered campaign: each registered campaign gets its own hold.
  const other = declaration({ tasks: [declaration().tasks[0]], campaignId: `${id}-other` });
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
  env.config.coordinator = { repositories: ['netbka/aiworks'], reportTo: 'netbka/aiworks#3', timeoutMinutes: 1,
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
