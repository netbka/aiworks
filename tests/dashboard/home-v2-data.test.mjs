// Home v2 data (docs/design/HOME_V2.md), read through GET /api/v2/home on a synthetic store of fictional projects: a step
// is landed only when its checked version was merged, once per step however many events it had; the needs count is the
// one owner-action set, so a result AIWorks merged itself is never counted as waiting for the owner; and goal titles
// carry no reference numbers, hashes, ids or codes. No GitHub, network or model call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';

const H = 60 * 60 * 1000;
const sha = (char) => char.repeat(40);
const step = (id, title, extra = {}) => ({ id, issue: 7, title, deliverable: 'commit', goal: `${title}.`, dependsOn: [],
  acceptance: ['Synthetic Home step.'], references: ['README.md'], ...extra });
const declaration = (campaignId, repository, tasks, wording = {}) => ({ version: 1, campaignId, ...wording,
  authorization: { version: 1, grantedBy: 'owner', grantedAt: '2026-10-31', reference: 'https://github.com/example/bakery/issues/1', text: 'Synthetic Home fixture; nothing runs.' },
  target: { tenantId: 'example', projectId: repository.split('/')[1], environment: 'research', repository, baseBranch: 'main', trackingIssue: 7 },
  limits: { slots: 1 }, executor: { kind: 'claude-cli', model: 'opus', permissionMode: 'auto', implementerTimeoutMinutes: 60, verifierTimeoutMinutes: 30 },
  constraints: ['Synthetic Home fixture: no network.'], tasks });

function build(dataDir, now) {
  const store = new Store(join(dataDir, 'supervisor.db'));
  let seq = 0;
  const operation = (campaignId, taskId, kind, { state = 'finished', at = now - H, outcome = null } = {}) => {
    const id = `${campaignId}.${taskId}.${kind}.${++seq}`, runDir = join(dataDir, 'runs', id);
    mkdirSync(runDir, { recursive: true });
    store.insert('operations', { id, campaign_id: campaignId, task_id: taskId, kind, seq, idempotency_key: id, lease_generation: 1, state,
      session_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, run_dir: runDir, workspace: join(dataDir, 'work', id),
      packet: { synthetic: true }, packet_digest: '0'.repeat(64), outcome, created_at: at, updated_at: at, executor_kind: 'claude-cli' });
  };
  const setTask = (campaignId, taskId, changes) => store.patch('tasks', { campaign_id: campaignId, task_id: taskId }, store.task(campaignId, taskId).version, changes, now);
  const setCampaign = (campaignId, changes) => store.patch('campaigns', { id: campaignId }, store.campaign(campaignId).version, changes, now);
  try {
    // Goal 1: a declared title; its first step was built, checked and merged by AIWorks (three events), the second is being built.
    campaignStart(store, declaration('bakery-orders', 'example/bakery', [step('T1', 'order form'), step('T2', 'order email', { dependsOn: ['T1'] }),
      step('T3', 'order history', { dependsOn: ['T2'] })], { title: 'Online cake orders', purpose: 'Let customers order cakes online' }), now - 6 * H);
    operation('bakery-orders', 'T1', 'implement', { at: now - 3 * H, outcome: { class: 'result', value: { result: 'implemented' }, receipt: { costUsd: 1.25 } } });
    operation('bakery-orders', 'T1', 'verify', { at: now - 2 * H, outcome: { class: 'result', value: { verdict: 'accepted', findings: [] } } });
    const url = 'https://github.com/example/bakery/pull/31';
    setTask('bakery-orders', 'T1', { state: 'done', attempts: 1, head_sha: sha('a'), verified_sha: sha('a'), pr_url: url });
    store.journal('bakery-orders', 'operation-finished', { task: 'T1', class: 'result', terminal: 'implemented' }, now - 3 * H);
    store.journal('bakery-orders', 'operation-finished', { task: 'T1', class: 'result', terminal: 'accepted' }, now - 2 * H);
    store.journal('bakery-orders', 'merged', { task: 'T1', sha: sha('a'), url, mergeCommit: sha('b'), reconciled: false, requested: true }, now - H);
    operation('bakery-orders', 'T2', 'implement', { state: 'dispatched', at: now - 10 * 60 * 1000 });
    setTask('bakery-orders', 'T2', { state: 'implementing', attempts: 1 });

    // Goal 2: no title, a purpose full of codes; its runs used all approved runs, which only the owner can pay for.
    campaignStart(store, declaration('bakery-menu', 'example/bakery', [step('T1', 'menu page'), step('T2', 'menu prices')],
      { purpose: 'MENU-2: Seasonal menu page for 3f2a9c1d7e (example/bakery#12) #44' }), now - 5 * H);
    setTask('bakery-menu', 'T1', { state: 'verifying', attempts: 1, head_sha: sha('c') });
    setCampaign('bakery-menu', { blocker: { kind: 'budget', class: 'B3', reason: 'Synthetic: all approved runs used.', requestedAction: 'Approve more runs.' } });

    // Goal 3: paused in another project, one step dropped.
    campaignStart(store, declaration('garden-photos', 'example/garden', [step('T1', 'photo upload'), step('T2', 'photo captions')],
      { purpose: 'Wave 3: Share garden photos' }), now - 4 * H);
    setTask('garden-photos', 'T2', { state: 'cancelled' });
    setCampaign('garden-photos', { control: 'paused', status: 'paused' });

    // A finished goal: its project is quiet.
    campaignStart(store, declaration('library-search', 'example/library', [step('T1', 'search box')], { purpose: 'Find a book by its title' }), now - 30 * H);
    setTask('library-search', 'T1', { state: 'done', attempts: 1 });
    setCampaign('library-search', { control: 'finished', status: 'ready' });
  } finally { store.close(); }
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ repositories: {} }));
}

async function readHome(dataDir) {
  const server = createDashboardServer({ dataDir, roadmap: { snapshot: () => ({ entries: [], governance: { configured: false, reason: 'Synthetic test.' } }) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const [home, state] = await Promise.all([`${origin}/api/v2/home`, `${origin}/api/state`].map(async (address) => (await fetch(address, { headers: { origin } })).json()));
    return { home, state };
  } finally { server.close(); }
}

test('Home lands a merged step once, counts only what the owner must answer and shows plain goal titles', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-home-v2-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  build(dataDir, Date.now());
  const { home, state } = await readHome(dataDir);
  assert.equal(home.available, true);

  // Three events of one step (built, checked, merged) are one landed entry.
  for (const type of ['built', 'checked', 'merged']) assert.equal(home.since.counts[type], 1, `the step's ${type} event is recorded`);
  assert.equal(home.landed.total, 1, 'one landed entry per merged step, not per event');
  assert.deepEqual(home.landed.entries.map(({ title, project }) => ({ title, project })), [{ title: 'Order form', project: 'bakery' }]);

  // Needs: the one owner-action set. The payment the owner must make counts; the result AIWorks merged does not.
  const actions = state.owner.items.filter((item) => !item.system);
  assert.equal(home.needs.count, actions.length);
  assert.equal(home.needs.count, state.owner.attention.count, 'the same number as the nav badge');
  assert.equal(home.needs.count, 1);
  assert.ok(!actions.some((item) => item.campaignId === 'bakery-orders'), 'a result AIWorks merged is landed, never waiting for the owner');

  // Goals: every running or paused goal, asks-you first and paused last, one segment per step.
  assert.deepEqual(home.goals.map(({ title, state: goalState }) => [title, goalState]),
    [['Seasonal menu page', 'Asks you'], ['Online cake orders', 'Building'], ['Share garden photos', 'Paused']]);
  const [menu, orders, garden] = home.goals;
  assert.equal(menu.now, 'Waiting for your answer');
  assert.deepEqual([orders.now, orders.done, orders.total, orders.segments], ['Now: Order email', 1, 3, ['done', 'now', 'todo']]);
  assert.deepEqual([garden.dropped, garden.segments], [1, ['todo', 'dropped']]);
  for (const { title } of home.goals) {
    assert.ok(title.length <= 60, `"${title}" is at most 60 characters`);
    assert.doesNotMatch(title, /#\d|\b[0-9a-f]{7,}\b|\b[A-Z]+-\d+|\b[A-Z]{2,}-[A-Z0-9]|\(|wave \d/i, `"${title}" has no reference, hash, id or code`);
  }

  // Quiet projects and today's spend on the running goals.
  assert.deepEqual(home.quiet, [{ name: 'library', state: 'Done' }]);
  assert.equal(home.spentToday.usd, new Date(Date.now() - 3 * H).toDateString() === new Date().toDateString() ? 1.25 : null);
});
