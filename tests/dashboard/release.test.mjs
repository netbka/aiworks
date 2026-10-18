import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { RELEASE_STOP } from '../../src/supervisor/release/state.mjs';
import { declaration } from '../supervisor/helpers.mjs';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';
import { ownerView, releaseLadder } from '../../src/dashboard/owner.mjs';

// Slice UI15 (AUTO_RELEASE.md R9, OWNER_WORKSPACE.md S13). Synthetic stores only: no network, GitHub or model call.

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-release-view-'));
  const store = new Store(join(dataDir, 'supervisor.db'));
  const d = declaration();
  campaignStart(store, d);
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, d };
}

const SHA = 'a'.repeat(40);
const releaseRow = (d, taskId, fields) => ({ id: `sampleapp.production.${SHA}.${taskId}`, idempotency_key: `sampleapp.production.${SHA}.${taskId}`,
  project: 'sampleapp', destination: 'production', campaign_id: d.campaignId, task_id: taskId, verified_sha: SHA, attempt: 1,
  steps: JSON.stringify(['merge', 'deploy', 'check']), instance_id: 'test', generation: 1, created_at: 1, updated_at: 2, ...fields });

test('unknown is never shown as success: an open, unknown or unreadable release step is never Yes, and is a Needs me line', (t) => {
  const { dataDir, store, d } = fixture(t);
  // T1: deploy started, then the outcome was lost. T2: a state and an outcome no release code writes.
  store.insert('releases', releaseRow(d, 'T1', { state: 'unknown', step: 'deploy', step_started_at: 5, history: JSON.stringify([
    { key: 'k1', step: 'merge', outcome: 'done' }, { key: 'k2', step: 'deploy', outcome: null }]) }));
  store.insert('releases', releaseRow(d, 'T2', { state: 'live-probably', step: 'check', history: JSON.stringify([
    { key: 'k1', step: 'merge', outcome: 'done' }, { key: 'k2', step: 'deploy', outcome: 'done' }, { key: 'k3', step: 'check', outcome: 'passed?' }]) }));
  const snapshot = supervisorSnapshot(dataDir);
  const byTask = Object.fromEntries(snapshot.releases.map((r) => [r.taskId, r]));
  assert.equal(byTask.T2.state, 'unknown');
  const task = { headSha: SHA, verifiedSha: SHA };
  const answers = (ladder) => Object.fromEntries(ladder.steps.map((step) => [step.key, step.answer]));
  assert.deepEqual(answers(releaseLadder(task, { state: 'merged' }, byTask.T1)),
    { implemented: 'yes', checked: 'yes', merged: 'yes', deployed: 'unknown', 'release-checked': 'no' });
  assert.equal(answers(releaseLadder(task, { state: 'merged' }, byTask.T2))['release-checked'], 'unknown');
  // Without a recorded release, a merge not seen yet is unknown, and nothing after a merge is ever Yes.
  const reviewOnly = answers(releaseLadder(task, { state: 'published', pending: true }, null));
  assert.equal(reviewOnly.merged, 'unknown');
  assert.equal(answers(releaseLadder(task, { state: 'merged' }, null)).deployed, 'unknown');
  assert.notEqual(answers(releaseLadder(task, { state: 'merged' }, null))['release-checked'], 'yes');
  // A project without GitHub shows no merge step.
  assert.ok(!releaseLadder(task, null, null, { github: false }).steps.some((step) => step.key === 'merged'));
  // Both are owner lines in Needs me, counted.
  const view = ownerView(snapshot, { repositories: [], steps: {} });
  assert.equal(view.items.filter((item) => item.kind === 'release-unknown').length, 2);
  assert.ok(view.count >= 2);
});

test('the Auto Release switch is absent without a valid grant, even with release.enabled on', (t) => {
  const { dataDir } = fixture(t);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ release: { enabled: true }, autoReleaseDecision: 'https://github.com/example-org/aiworks/issues/33' }));
  const row = supervisorSnapshot(dataDir).settings.releases.find((r) => r.repository === 'example-org/sampleapp');
  assert.equal(row.mode, 'review-only');
  const auto = row.modes.find((m) => m.key === 'auto-release');
  assert.equal(auto.on, false);
  assert.equal(auto.available, false);
  // Text only: no field a page could turn into a control, and the exact missing condition is the grant.
  assert.deepEqual(Object.keys(auto).sort(), ['available', 'key', 'label', 'missing', 'on', 'text', 'waitsFor']);
  assert.deepEqual(auto.missing.map((item) => item.code), ['no-grant']);
});

test('Stop all releases writes RELEASE-STOP through the CSRF-checked command path, and nothing else', async (t) => {
  const { dataDir, store, d } = fixture(t);
  const roadmap = { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) };
  const server = createDashboardServer({ dataDir, roadmap });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
  const send = (headers) => fetch(`${base}/api/commands`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ action: 'release-stop', requestId: randomUUID() }) });
  const files = () => readdirSync(dataDir).filter((name) => !/^supervisor\.db-(?:wal|shm|journal)$/.test(name)).sort();
  const before = files(), journal = store.all('SELECT seq FROM journal').length, campaign = store.campaign(d.campaignId);
  assert.equal((await send({ 'X-Dashboard-CSRF': 'wrong' })).status, 403);
  assert.equal(existsSync(join(dataDir, RELEASE_STOP)), false);
  const accepted = await send({ 'X-Dashboard-CSRF': csrf });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).duplicate, false);
  assert.deepEqual(files(), [...before, RELEASE_STOP].sort());
  const written = readFileSync(join(dataDir, RELEASE_STOP), 'utf8');
  // Again: already stopped, the file is kept as it was.
  assert.equal((await (await send({ 'X-Dashboard-CSRF': csrf })).json()).duplicate, true);
  assert.equal(readFileSync(join(dataDir, RELEASE_STOP), 'utf8'), written);
  // Nothing else: no work record, journal line or supervisor STOP.
  assert.equal(store.all('SELECT seq FROM journal').length, journal);
  assert.deepEqual(store.campaign(d.campaignId), campaign);
  assert.equal(existsSync(join(dataDir, 'STOP')), false);
  assert.equal(supervisorSnapshot(dataDir).settings.releaseStop.set, true);
});
