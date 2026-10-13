// Review fixture (OWNER_WORKSPACE slice S0, build slice UI1, resolution C1): a synthetic store and disposable local git
// repositories show every owner state of OWNER_WORKSPACE §7 through today's dashboard, with no GitHub at all, and the
// documented command serves them on a port other than the live dashboard's. Disposable directories only; no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { once } from 'node:events';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { ownerView } from '../../src/dashboard/owner.mjs';
import { configuredCheckouts, configuredGitCommand, MergeWatcher, publishedSteps } from '../../src/dashboard/merges.mjs';
import { buildReviewFixture, PROJECTS, REVIEW_STATES, REVIEW_PORT, LIVE_PORT } from './fixtures/review-store.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const COMMAND = join(ROOT, 'tests/dashboard/fixtures/review-store.mjs');
const M = 60_000;

function fixture(t, options) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-review-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return buildReviewFixture(root, options);
}
const inside = (root, path) => { const rel = relative(root, path); return !rel.startsWith('..') && !isAbsolute(rel); };
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

/** The merge check exactly as the dashboard runs it: the configured local checkouts, git only. */
async function merges(dataDir) {
  const watcher = new MergeWatcher({ steps: () => publishedSteps(dataDir), checkouts: configuredCheckouts(dataDir), git: configuredGitCommand(dataDir) });
  await watcher.refresh();
  return watcher.snapshot();
}

test('the full fixture is three made-up projects in local git repositories, configured without any GitHub command', (t) => {
  const { root, dataDir, repositories, governance } = fixture(t);
  assert.ok(inside(root, governance), 'the governance copy is built inside the disposable directory');
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  // C1: no fake gh and no commands at all; the dashboard reads merges from local git only.
  assert.deepEqual(Object.keys(config), ['repositories']);
  assert.deepEqual(Object.keys(config.repositories), PROJECTS);
  assert.deepEqual(repositories, config.repositories);
  for (const [name, { path }] of Object.entries(config.repositories)) {
    assert.ok(inside(root, path), `${name} is checked out inside the disposable directory`);
    const origin = git(path, 'remote', 'get-url', 'origin').stdout.trim();
    assert.ok(inside(root, origin), `${name}'s origin is a path on disk, never a URL: ${origin}`);
    assert.equal(existsSync(origin), name !== 'example/notes-site', `only notes-site's origin is missing, so its merge check fails`);
  }
  assert.doesNotMatch(readFileSync(join(dataDir, 'config.json'), 'utf8'), /token|secret|password|"gh"/i);
});

test('the supervisor snapshot shows one piece of work for every owner state', (t) => {
  const { dataDir } = fixture(t);
  const now = Date.now();
  const snapshot = supervisorSnapshot(dataDir, now);
  assert.equal(snapshot.available, true);
  assert.deepEqual([...new Set(snapshot.campaigns.map((c) => c.repository))].sort(), [...PROJECTS].sort(), 'only the made-up projects');
  const campaign = (state) => {
    const matches = snapshot.campaigns.filter((c) => c.id === REVIEW_STATES[state].campaignId);
    assert.equal(matches.length, 1, state);
    return matches[0];
  };
  const step = (state) => campaign(state).tasks.find((item) => item.id === REVIEW_STATES[state].taskId);
  for (const [state, entry] of Object.entries(REVIEW_STATES)) if (!entry.store) campaign(state);
  // §7.6 Running: a builder, a checker, a worker whose record stopped moving, a merge wait and work not picked up yet.
  const builder = campaign('builder-working');
  assert.equal(builder.phase, 'implement');
  assert.deepEqual(builder.agents.map((a) => [a.taskId, a.role, a.executor, a.heartbeatState]), [['T1', 'Implementer', 'codex-cli', 'recent']]);
  assert.deepEqual([builder.agents[0].progress.turns, builder.agents[0].progress.toolCalls], [2, 1]);
  assert.ok(now - builder.agents[0].progress.lastActivityAt < 5 * M);
  const checker = campaign('checker-working');
  assert.equal(checker.phase, 'verify');
  assert.deepEqual(checker.agents.map((a) => [a.taskId, a.role, a.heartbeatState]), [['T1', 'Verifier', 'recent']]);
  assert.equal(step('checker-working').state, 'implemented');
  const stuck = campaign('possibly-stuck').agents[0];
  assert.equal(stuck.heartbeatState, 'recent', 'the worker process is alive');
  assert.ok(now - stuck.progress.lastActivityAt >= 25 * M - 5000, 'but its own record has not moved for 25 minutes');
  assert.match(step('waiting-for-merge').waitingReason, /^Waiting for verified dependencies in main: T1$/);
  assert.equal(step('waiting-for-merge').requiresMergedDependencies, true);
  assert.equal(campaign('waiting-for-merge').nextAction, 'Waiting for verified dependencies in main: T1');
  assert.deepEqual([campaign('awaiting-pickup').controllerLive, campaign('awaiting-pickup').leaseExpiresAt], [false, null]);
  // §7.3 No worker: every allowed worker waits for a usage limit; no allowed worker can run; nothing running, no reason.
  const wait = campaign('provider-wait');
  assert.deepEqual([wait.phase, wait.waitingReason], ['provider-wait', 'provider-availability']);
  assert.deepEqual(wait.providers.filter((p) => p.priority).map((p) => [p.kind, p.state, p.reason]), [['claude-cli', 'cooldown', 'quota']]);
  assert.ok(wait.providers[0].retryAt > now);
  const none = campaign('no-worker-can-run');
  assert.deepEqual(none.providers.filter((p) => p.priority).map((p) => [p.kind, p.state, p.availabilityReason]),
    [['codex-cli', 'unavailable', 'CLI command is not configured on this PC']]);
  const idle = campaign('nothing-running');
  assert.deepEqual([idle.controllerLive, idle.agents.length, idle.waitingReason, idle.nextAction], [true, 0, null, 'Next task: T1']);
  // §7.5 Paused, with AIWorks running and stopped.
  const paused = campaign('paused');
  assert.deepEqual([paused.control, paused.controllerLive, paused.pausedReason], ['paused', true, 'Paused for an update on this computer']);
  assert.ok(paused.pausedAt < now);
  assert.deepEqual([campaign('paused-supervisor-stopped').control, campaign('paused-supervisor-stopped').controllerLive], ['paused', false]);
  // §7.2 Stopped and late: both have a lease that ended, two hours and two minutes ago.
  for (const [state, ago] of [['supervisor-stopped', 120 * M], ['supervisor-late', 2 * M]]) {
    assert.equal(campaign(state).controllerLive, false, state);
    assert.equal(now - Date.parse(campaign(state).leaseExpiresAt) >= ago - 5000, true, state);
  }
  // §7.7 Blocked: an owner decision while another step continues, failed attempts, a recorded blocker, a supervisor fault.
  assert.deepEqual([step('needs-decision').blocked, step('needs-decision').blockedReason], ['B3', 'the AI worker needs your decision; see the step issue']);
  assert.deepEqual([step('others-continue').blocked, step('others-continue').state], [null, 'pending']);
  assert.deepEqual(campaign('needs-decision').stopReasons, ['T1: the AI worker needs your decision; see the step issue']);
  assert.deepEqual([step('failed-attempts').blocked, step('failed-attempts').attempts, step('failed-attempts').blockedReason],
    ['stalled', 5, '5 failed attempts (last: invalid result); check it again after fixing the cause']);
  const blocker = campaign('recorded-blocker');
  assert.deepEqual([blocker.blocker, blocker.blockerClass, blocker.blockerReason], ['executors', 'B2', 'No configured executor supports this task role']);
  assert.equal(campaign('supervisor-fault').livenessDefect, true);
  // §7.8 Finished and cancelled, and the cost of finished work: reported dollars and runs that reported none, apart.
  const search = campaign('finished-open-and-merged');
  assert.deepEqual([search.control, search.recordedCostUsd, search.budget.measuredCostUsd, search.budget.unknownCostRuns], ['finished', 4.2, 4.2, 3]);
  assert.deepEqual(search.tasks.map((item) => item.state), ['done', 'done', 'done']);
  const units = campaign('finished-all-merged');
  assert.deepEqual([units.control, units.repository, units.tasks.map((item) => item.state)], ['finished', 'example/recipes', ['done', 'done']]);
  assert.ok(units.tasks.every((item) => item.verifiedSha && item.resultUrl), 'every step has a verified commit and a result link');
  assert.deepEqual([campaign('no-runs').runsUsed, campaign('no-runs').recordedCostUsd, campaign('no-runs').budget.unknownCostRuns], [0, 0, 0]);
  assert.equal(campaign('cancelled').control, 'cancelled');
  assert.equal(campaign('finished-reports').control, 'finished');
});

test('the owner view, with the local merge check, says where every result stands and what needs the owner', async (t) => {
  const { dataDir, commits } = fixture(t);
  const now = Date.now();
  const merged = await merges(dataDir);
  const view = ownerView(supervisorSnapshot(dataDir, now), merged, { host: 'review-pc', now });
  const owner = (state) => view.campaigns[REVIEW_STATES[state].campaignId];
  // The local repositories decide merged: shop-app and recipes were fetched; notes-site's check failed.
  assert.deepEqual(merged.repositories.map((r) => [r.repository, r.configured, r.fetchedAt !== null, r.error]).sort(),
    [['example/notes-site', true, false, 'fetch-failed'], ['example/recipes', true, true, null], ['example/shop-app', true, true, null]]);
  const search = owner('finished-open-and-merged').deliveries;
  assert.deepEqual([search.T1.state, search.T2.state, search.T2.reason], ['merged', 'published', null]);
  assert.equal(typeof search.T1.mergedAt, 'number', 'merged with a merge commit');
  // A pull request closed without merging cannot be told apart without GitHub (gap G3): it is never shown as merged.
  assert.deepEqual([search.T3.state, search.T3.note], ['published', 'Your review and merge']);
  assert.equal(owner('finished-open-and-merged').finished, 'All steps are finished · 2 steps wait for your review (merge not seen yet) · 1 merged');
  // §7.8 Everything merged, all states known: the release follows the project's own rule, never assumed done.
  const units = owner('finished-all-merged');
  assert.deepEqual(Object.values(units.deliveries).map((d) => d.state), ['merged', 'merged']);
  assert.equal(units.finished, "All steps are finished · the merged work is ready; release follows recipes's release policy");
  assert.equal(units.releaseReady, true);
  assert.equal(owner('finished-reports').counts.reports, 2);
  assert.equal(owner('finished-reports').finished, 'All steps are finished · Planning reports published in example/notes-site; review recommendations before assigning implementation.');
  const links = owner('finished-unknown').deliveries;
  assert.deepEqual([links.T1.state, links.T2.reason, links.T3.reason], ['unknown', 'no-verified-sha', 'fetch-failed']);
  assert.equal(links.T3.note, 'The last check of the base branch failed; showing the last known state');
  assert.equal(owner('cancelled').outcome, 'Cancelled · 1 of 3 steps delivered');
  assert.equal(owner('cancelled').deliveries.T1.state, 'merged');
  assert.deepEqual(Object.fromEntries(['builder-working', 'nothing-running', 'paused', 'supervisor-stopped', 'supervisor-late', 'awaiting-pickup', 'paused-supervisor-stopped', 'finished-reports']
    .map((state) => [state, owner(state).liveness])), { 'builder-working': 'running', 'nothing-running': 'running', 'paused': 'running',
    'supervisor-stopped': 'stopped', 'supervisor-late': 'late', 'awaiting-pickup': 'awaiting-pickup', 'paused-supervisor-stopped': 'stopped', 'finished-reports': 'finished' });
  // Needs me: one item per piece of work that waits on the owner, and nothing for waits AIWorks handles itself.
  const items = view.items.map((item) => [item.campaignId, item.kind, item.text]);
  for (const expected of [
    ['shop-search', 'review', 'Search filters'], ['shop-search', 'review', 'Sale banner'], ['shop-contracts', 'review', 'Contracts import'],
    ['notes-links', 'check', 'Link redirects'], ['notes-links', 'review', 'Footer links'], ['notes-links', 'review', 'Sitemap'],
    ['notes-theme', 'decision', 'Dark theme'], ['notes-search', 'stopped', 'Notes search'], ['notes-deploy', 'stopped', 'This work is stopped'],
    ['notes-health', 'controller', 'AIWorks has a problem of its own with this work'],
    ['notes-archive', 'controller', 'AIWorks stopped on this computer'],
    ['notes-tags', 'controller', 'This work was paused, then AIWorks stopped on this computer'],
  ]) assert.ok(items.some((item) => JSON.stringify(item) === JSON.stringify(expected)), `Needs me lists ${expected.join(' · ')}`);
  assert.equal(items.length, 12, JSON.stringify(items));
  for (const quiet of ['shop-checkout', 'shop-reviews', 'shop-wishlist', 'recipes-import', 'recipes-tags', 'recipes-idle', 'recipes-share', 'recipes-print', 'recipes-units', 'notes-drafts', 'notes-audit']) {
    assert.ok(!items.some(([id]) => id === quiet), `${quiet} is not listed for the owner`);
  }
  assert.equal(view.headline, 'Needs you (12)');
  assert.deepEqual(view.items.find((item) => item.text === 'Contracts import').points.map((p) => p.text).at(-1), '“Price sync” cannot start until you merge it.');
  assert.equal(view.also.text, 'Also: 2 reports for you to read · merged work in recipes is ready; release follows its release policy');
  // Nothing claims more than the evidence: no deployed, released or live work, and notes-site is never merged.
  assert.doesNotMatch(JSON.stringify(view), /deployed|released|is live|ready to merge/i);
  assert.deepEqual(Object.entries(view.campaigns).filter(([, c]) => c.releaseReady).map(([id]) => id), ['recipes-units']);
  assert.ok(!Object.values(links).some((d) => d.state === 'merged'));
  assert.equal(merged.steps['shop-search/T1'].sha, commits['example/shop-app']['search-page']);
});

test('the empty store is the first run: no projects and nothing blocked on the owner', async (t) => {
  const { dataDir, repositories } = fixture(t, { store: 'empty' });
  const snapshot = supervisorSnapshot(dataDir);
  assert.deepEqual([snapshot.available, snapshot.campaigns.length, Object.keys(repositories).length], [true, 0, 0]);
  const view = ownerView(snapshot, await merges(dataDir));
  assert.deepEqual([view.available, view.items.length, view.headline, view.also], [true, 0, 'Nothing is blocked on you right now', null]);
});

test('the unreadable store shows that AIWorks cannot read its work records', (t) => {
  const { dataDir } = fixture(t, { store: 'unreadable' });
  const snapshot = supervisorSnapshot(dataDir);
  assert.deepEqual([snapshot.available, snapshot.message], [false, 'Supervisor state is temporarily unavailable. Commands are disabled until it reconnects.']);
  assert.equal(ownerView(snapshot).available, false);
});

test('the review command refuses the live dashboard port and a directory that is not empty', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-review-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  assert.equal(REVIEW_PORT, 4319);
  const live = spawnSync(process.execPath, [COMMAND, '--port', String(LIVE_PORT), '--dir', join(root, 'live')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(live.status, 1);
  assert.match(live.stderr, /Port 4318 is the live dashboard's; use 4319\./);
  assert.equal(existsSync(join(root, 'live')), false, 'nothing is built');
  buildReviewFixture(join(root, 'used'), { store: 'empty' });
  const used = spawnSync(process.execPath, [COMMAND, '--port', '4319', '--dir', join(root, 'used')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(used.status, 1);
  assert.match(used.stderr, /needs a new or empty directory/);
});

/** Runs the documented review command on a free port with `store`; returns a function that reads its /api/state. */
async function serveReview(t, store) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-review-test-'));
  // A free port other than the live one; the documented command uses 4319, which another review may hold.
  let port;
  do {
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    port = probe.address().port;
    probe.close();
    await once(probe, 'close');
  } while (port === LIVE_PORT || port < 1024);
  const child = spawn(process.execPath, [COMMAND, '--port', String(port), '--store', store, '--dir', join(root, 'review')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  // Stop the dashboard first: its checkouts are busy while it runs (Windows refuses to remove them).
  t.after(async () => {
    child.kill();
    await exited;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((done, fail) => {
    child.stdout.on('data', (chunk) => { output += chunk; if (output.includes(`AIWorks dashboard: http://127.0.0.1:${port}`)) done(); });
    exited.then(([code]) => fail(new Error(`review command exited ${code}: ${output}`)));
  });
  return () => new Promise((done, fail) => {
    request({ host: '127.0.0.1', port, path: '/api/state' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => done({ status: res.statusCode, text: body, body: JSON.parse(body) }));
    }).on('error', fail).end();
  });
}

test('the review command serves today\'s dashboard from the fixture on the port it is given', async (t) => {
  const get = await serveReview(t, 'full');
  // Every answer starts the local merge check and never waits for it (each says it is refreshing); ask again until the
  // owner view settles on the checked results, at most for 30 seconds.
  const settled = (body) => body.owner.headline === 'Needs you (12)';
  let state = await get();
  for (let i = 0; i < 120 && !settled(state.body); i++) {
    await new Promise((done) => setTimeout(done, 250));
    state = await get();
  }
  assert.equal(state.status, 200);
  assert.equal(state.body.supervisor.available, true);
  assert.deepEqual([...new Set(state.body.supervisor.campaigns.map((c) => c.repository))].sort(), [...PROJECTS].sort());
  assert.deepEqual(state.body.merges.repositories.map((r) => [r.repository, r.error]).sort(),
    [['example/notes-site', 'fetch-failed'], ['example/recipes', null], ['example/shop-app', null]]);
  assert.equal(state.body.owner.headline, 'Needs you (12)');
});

// AIWorks' own issue links, fixed in src/dashboard: the Auto Release decision (#33, supervisor.mjs) and the supervisor
// fault issue (#2, owner.mjs, shown for the supervisor-fault state). They are the tool's own state, not a project.
const OWN_LINKS = /https:\/\/github\.com\/netbka\/aiworks\/issues\/(?:33|2)(?!\d)/g;
/** Every string a `repository` key holds anywhere in `value`. */
function repositoriesIn(value, found = []) {
  if (Array.isArray(value)) for (const item of value) repositoriesIn(item, found);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'repository' && typeof item === 'string') found.push(item);
      else repositoriesIn(item, found);
    }
  }
  return found;
}

test('the review dashboard shows only made-up projects, for the full, empty and unreadable stores', async (t) => {
  for (const store of ['full', 'empty', 'unreadable']) {
    const get = await serveReview(t, store);
    let state = await get();
    // The full store's owner view names its projects once the local merge check settles; read it then.
    for (let i = 0; store === 'full' && i < 120 && state.body.owner.headline !== 'Needs you (12)'; i++) {
      await new Promise((done) => setTimeout(done, 250));
      state = await get();
    }
    assert.equal(state.status, 200, store);
    // The dashboard reads the fixture's own governance copy, and the copy is usable.
    assert.equal(state.body.roadmap.governance.configured, true, store);
    const outside = repositoriesIn(state.body).filter((name) => !name.startsWith('example/'));
    assert.deepEqual(outside, [], `${store}: no repository outside example/`);
    const text = state.text.replace(OWN_LINKS, '');
    assert.doesNotMatch(text, /netbka\//i, `${store}: nothing of the owner's beyond AIWorks' own issue links`);
    for (const [, owner] of text.matchAll(/github\.com\/([\w.-]+)\//g)) assert.equal(owner, 'example', `${store}: links point at made-up projects`);
  }
});
