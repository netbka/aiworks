// One owner-action set (AW-016 as amended by AW-017, owner.mjs `attention`): on the review fixture, read through the dashboard API, Needs you,
// its count, Home, every project row and Overview sentence and the results offered for review are that set; a result of
// paused or stopped work is never offered for acceptance; and with the set empty nothing says the owner is needed.
// Synthetic review fixture and local git only: no GitHub, network or model call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { configuredCheckouts, configuredGitCommand, configuredLocalMain, MergeWatcher, publishedSteps } from '../../src/dashboard/merges.mjs';
import { nowView } from '../../src/dashboard/copy.mjs';
import { Store } from '../../src/supervisor/store.mjs';
import { buildReviewFixture } from './fixtures/review-store.mjs';

async function readState(t, dataDir) {
  const merges = new MergeWatcher({ steps: () => publishedSteps(dataDir), checkouts: configuredCheckouts(dataDir), localMain: configuredLocalMain(dataDir),
    git: configuredGitCommand(dataDir) });
  await merges.refresh();
  const server = createDashboardServer({ dataDir, merges, roadmap: { snapshot: () => ({ entries: [], governance: { configured: false, reason: 'Synthetic test.' } }) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    return await (await fetch(`${origin}/api/state`, { headers: { origin } })).json();
  } finally { server.close(); }
}

/** Every surface against the set; returns the set's size. */
function assertOneSet(state) {
  const { owner, home, projects, supervisor } = state;
  const actions = owner.items.filter((item) => !item.system), control = new Map(supervisor.campaigns.map((c) => [c.id, c.control]));
  assert.equal(owner.count, actions.length);
  assert.equal(owner.attention.count, actions.length);
  assert.equal(home.needsYou.count, actions.length, 'Home says the Needs you count');
  for (const row of projects.projects) {
    const key = row.repository ? row.repository.toLowerCase() : row.id;
    const mine = actions.filter((item) => (item.repository ? item.repository.toLowerCase() : item.project) === key).length;
    assert.equal(row.details.needsYou, mine, `${row.id}: its row counts its share of Needs you`);
    assert.equal(row.state.key === 'needs-you', mine > 0, `${row.id}: says it needs the owner only with items in Needs you`);
    assert.equal(home.projects.find((p) => p.id === row.id)?.needsYou, mine, `${row.id}: Home row`);
    if (row.repository) assert.equal(Boolean(nowView(row.repository, state).state.needsYou), mine > 0, `${row.id}: Overview sentence`);
  }
  const offered = Object.values(owner.results).flatMap((entry) => entry.groups.flatMap((group) => group.rows)).filter((row) => row.needsYou);
  for (const row of offered) {
    assert.ok(owner.attention.results.includes(`${row.campaignId}/${row.taskId}`), 'a result offered for review is in Needs you');
    assert.ok(['registered', 'finished'].includes(control.get(row.campaignId)), 'a result of paused or stopped work is never offered');
  }
  for (const item of actions.filter((entry) => ['review', 'accept'].includes(entry.kind))) {
    assert.ok(['registered', 'finished'].includes(control.get(item.campaignId)), 'Needs you offers no result whose work cannot finish');
  }
  for (const entry of owner.handling) assert.ok(!['paused', 'cancelled'].includes(control.get(entry.campaignId)), 'AIWorks is handling holds no stopped work');
  for (const [id, view] of Object.entries(owner.campaigns)) {
    assert.equal(view.counts.awaiting, actions.filter((item) => item.campaignId === id && ['review', 'unchecked'].includes(item.kind)).length, `${id}: "for your review" is its share`);
  }
  return actions.length;
}

test('Needs you, Home, project rows, Overview and offered results are one owner-action set; empty, nothing claims the owner', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-attention-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const { dataDir } = buildReviewFixture(root);
  // AW-017: decisions, stopped steps and results to review are AIWorks's own; only the owner's own sign-in or payment counts.
  assert.equal(assertOneSet(await readState(t, dataDir)), 0, 'decisions and results in the fixture claim nothing of the owner');
  const store = new Store(join(dataDir, 'supervisor.db'));
  try {
    const c = store.campaign('notes-theme');
    store.patch('campaigns', { id: c.id }, c.version, { blocker: { kind: 'budget', class: 'B3', reason: 'Synthetic: all approved runs used.', requestedAction: 'Approve more runs.' } }, Date.now());
  } finally { store.close(); }
  assert.equal(assertOneSet(await readState(t, dataDir)), 1, 'more runs than approved is a payment for the owner, in Needs you');

  // Settle what is left the owner's: the decision's work is cancelled and the result's work is paused.
  const again = new Store(join(dataDir, 'supervisor.db'));
  try { for (const [id, control] of [['notes-theme', 'cancelled'], ['shop-search', 'paused']]) again.patch('campaigns', { id }, again.campaign(id).version, { control, status: control }, Date.now()); }
  finally { again.close(); }
  const empty = await readState(t, dataDir);
  assert.equal(assertOneSet(empty), 0, 'nothing is left for the owner');
  assert.deepEqual(empty.owner.attention, { count: 0, projects: {}, results: [] });
  assert.ok(empty.owner.stalled.some((entry) => entry.campaignId === 'shop-search'), 'the paused result is listed apart, not offered');
});
