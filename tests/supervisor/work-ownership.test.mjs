// aiworks#5 scope A: a second campaign cannot take commit work another campaign already owns.
// Disposable SQLite stores and synthetic declarations only; no model, network or GitHub calls.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { declaration, SQLITE } from './helpers.mjs';
import { campaignStart, campaignPause, campaignCancel } from '../../src/supervisor/api.mjs';
import { authorityDigest, scopeDigest, validateDeclaration } from '../../src/supervisor/campaign.mjs';
const Store = SQLITE ? (await import('../../src/supervisor/store.mjs')).Store : null;
const options = { skip: !SQLITE };

function setup(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}
function assigned(id = 'owner', patch = {}) {
  const d = declaration({ campaignId: id });
  d.tasks = [{ ...d.tasks[0], ...patch }];
  return d;
}
/** The refusal names the owner, and the refused campaign leaves no campaign, task, operation or journal row. */
function conflict(store, d, expected = {}) {
  assert.throws(() => campaignStart(store, d), (error) => {
    assert.equal(error.code, 'WORK_ALREADY_ASSIGNED');
    for (const [key, value] of Object.entries(expected)) assert.equal(error.conflict[key], value);
    assert.match(error.message, new RegExp(`${error.conflict.campaignId}/${error.conflict.ownerTaskId}`));
    return true;
  });
  assert.equal(store.campaign(d.campaignId), null);
  assert.equal(store.tasks(d.campaignId).length, 0);
  assert.equal(store.all('SELECT * FROM operations WHERE campaign_id = ?', d.campaignId).length, 0);
  assert.equal(store.all('SELECT * FROM journal WHERE campaign_id = ?', d.campaignId).length, 0);
}
function terminal(store, id, control) {
  const c = store.campaign(id);
  store.patch('campaigns', { id }, c.version, { control }, Date.now());
}
function openOperation(store, id, state) {
  store.insert('operations', {
    id: 'owned-op', campaign_id: id, task_id: 'T1', kind: 'implement', seq: 1,
    idempotency_key: 'owned-op', lease_generation: 1, state, session_id: 'synthetic-session',
    run_dir: 'synthetic-run', workspace: 'synthetic-workspace', packet: {}, packet_digest: 'synthetic',
    created_at: 1, updated_at: 1,
  });
}

test('the same commit assignment cannot be registered again under new campaign and task IDs', options, (t) => {
  const store = setup(t);
  campaignStart(store, assigned());
  conflict(store, assigned('duplicate', { id: 'renamed' }), {
    campaignId: 'owner', ownerTaskId: 'T1', taskId: 'renamed', reason: 'same-task', ownerControl: 'registered',
  });
  // Nothing launched and no budget consumed, for either campaign.
  assert.equal(store.campaign('owner').runs_used, 0);
  assert.equal(store.all('SELECT * FROM operations').length, 0);
  assert.equal(store.all('SELECT * FROM campaigns').length, 1);
});

test('display wording, references and acceptance order do not disguise the same work', options, (t) => {
  const store = setup(t);
  campaignStart(store, assigned('owner', { acceptance: ['A', 'B'], references: ['AGENTS.md', 'README.md'] }));
  const d = assigned('duplicate', { title: 'New title', outcome: 'New display', goal: ' Produce the first artifact. ',
    acceptance: [' B ', 'A'], references: ['README.md', 'AGENTS.md'] });
  d.purpose = 'A different dashboard label';
  conflict(store, d, { reason: 'same-task' });
});

test('an explicit work key catches a differently worded repair under another issue', options, (t) => {
  const store = setup(t);
  campaignStart(store, assigned('owner', { workKey: 'quota:run-accounting' }));
  conflict(store, assigned('duplicate', { workKey: 'quota:run-accounting', issue: 999,
    goal: 'Repair the counter from another entry point.', acceptance: ['Counter agrees with receipts'] }),
  { reason: 'work-key', workKey: 'quota:run-accounting', campaignId: 'owner', ownerTaskId: 'T1' });
});

test('a different work key cannot bypass an exact duplicate', options, (t) => {
  const store = setup(t);
  campaignStart(store, assigned('owner', { workKey: 'first-key' }));
  conflict(store, assigned('duplicate', { workKey: 'second-key' }), { reason: 'same-task' });
});

test('independent tasks under one issue that read the same files are not serialized', options, (t) => {
  const store = setup(t);
  campaignStart(store, assigned());
  campaignStart(store, assigned('independent', { goal: 'A different artifact.', acceptance: ['Different artifact exists'] }));
  campaignStart(store, assigned('another', { workKey: 'another-repair', goal: 'A third artifact.', acceptance: ['Third artifact exists'] }));
  assert.equal(store.all('SELECT * FROM campaigns').length, 3);
});

test('report tasks never reserve or conflict with commit ownership', options, (t) => {
  const store = setup(t);
  campaignStart(store, assigned('report-first', { deliverable: 'report' }));
  campaignStart(store, assigned('writer'));
  campaignStart(store, assigned('report-second', { deliverable: 'report' }));
  assert.equal(store.all('SELECT * FROM campaigns').length, 3);
});

test('ownership is scoped to tenant and repository, with repository case ignored', options, (t) => {
  const store = setup(t);
  campaignStart(store, assigned());
  const otherRepo = assigned('other-repo');
  otherRepo.target.repository = 'netbka/another-project';
  campaignStart(store, otherRepo);
  const otherTenant = assigned('other-tenant');
  otherTenant.target.tenantId = 'another-owner';
  campaignStart(store, otherTenant);
  const alias = assigned('alias');
  Object.assign(alias.target, { repository: 'NetBka/dyk', projectId: 'alias', environment: 'another-env', baseBranch: 'next' });
  conflict(store, alias, { campaignId: 'owner' });
});

test('identical start, pause, resume and an authorization amendment keep ownership', options, (t) => {
  const store = setup(t), d = assigned();
  campaignStart(store, d);
  campaignStart(store, structuredClone(d));
  conflict(store, assigned('after-identical-start'));
  campaignPause(store, d.campaignId);
  conflict(store, assigned('while-paused'));
  campaignStart(store, d);
  conflict(store, assigned('after-resume'));
  d.authorization.version++;
  campaignStart(store, d);
  conflict(store, assigned('after-amendment'), { campaignId: 'owner' });
  assert.equal(store.all('SELECT * FROM campaigns').length, 1);
  assert.equal(store.tasks(d.campaignId).length, 1);
  assert.equal(store.campaign(d.campaignId).runs_used, 0);
  assert.equal(store.campaign(d.campaignId).authorization_version, 2);
  assert.equal(store.campaign(d.campaignId).control, 'registered');
});

test('a cancel request keeps ownership; a completed cancellation releases it', options, (t) => {
  const store = setup(t);
  campaignStart(store, assigned());
  campaignCancel(store, 'owner');
  conflict(store, assigned('while-cancelling'), { ownerControl: 'cancel-requested' });
  terminal(store, 'owner', 'cancelled');
  campaignStart(store, assigned('after-cancellation'));
});

test('a published task keeps ownership while its campaign runs; completion releases it', options, (t) => {
  const store = setup(t);
  campaignStart(store, assigned());
  const task = store.task('owner', 'T1');
  store.patch('tasks', { campaign_id: 'owner', task_id: 'T1' }, task.version,
    { state: 'done', pr_url: 'https://github.com/netbka/Dyk/pull/1' }, Date.now());
  conflict(store, assigned('duplicate'));
  terminal(store, 'owner', 'finished');
  campaignStart(store, assigned('after-finish'));
});

for (const control of ['finished', 'cancelled']) for (const state of ['recorded', 'dispatched']) {
  test(`a ${control} campaign keeps ownership while an operation is ${state}`, options, (t) => {
    const store = setup(t);
    campaignStart(store, assigned());
    openOperation(store, 'owner', state);
    terminal(store, 'owner', control);
    conflict(store, assigned('duplicate'));
    store.updateOperation('owned-op', { state: 'finished' }, Date.now());
    campaignStart(store, assigned('after-drain'));
  });
}

test('a conflict in a later task leaves no partial campaign, tasks or journal', options, (t) => {
  const store = setup(t);
  campaignStart(store, assigned());
  const d = assigned('duplicate');
  d.tasks.unshift({ ...d.tasks[0], id: 'independent', goal: 'Independent work' });
  conflict(store, d, { taskId: 'T1' });
  assert.equal(store.all('SELECT * FROM tasks').length, 1);
});

test('an unreadable stored declaration owns nothing instead of failing every registration', options, (t) => {
  const store = setup(t);
  campaignStart(store, assigned('broken'));
  store.run('UPDATE campaigns SET declaration = ? WHERE id = ?', JSON.stringify({ campaignId: 'broken' }), 'broken');
  campaignStart(store, assigned('owner'));
  conflict(store, assigned('duplicate'), { campaignId: 'owner' });
});

test('workKey is bounded, commit-only, and an absent key leaves both digests unchanged', () => {
  const plain = assigned('owner');
  const scope = scopeDigest(plain), authority = authorityDigest(plain);
  const keyed = assigned('owner', { workKey: 'quota:run-accounting' });
  assert.equal(validateDeclaration(keyed), keyed);
  assert.equal(scopeDigest({ ...plain, tasks: [{ ...plain.tasks[0], workKey: undefined }] }), scope);
  assert.equal(authorityDigest({ ...plain, tasks: [{ ...plain.tasks[0], workKey: undefined }] }), authority);
  assert.notEqual(scopeDigest(keyed), scope);
  const changed = structuredClone(keyed);
  changed.tasks[0].workKey = 'different-repair';
  assert.notEqual(scopeDigest(keyed), scopeDigest(changed));
  for (const key of ['', null, 5, {}, 'UPPERCASE', 'has space', '../path', 'x'.repeat(97)]) {
    assert.throws(() => validateDeclaration(assigned('invalid', { workKey: key })), /workKey/);
  }
  assert.throws(() => validateDeclaration(assigned('report', { deliverable: 'report', workKey: 'repair' })), /workKey/);
});

test('an admitted task cannot switch its work key with a new authorization version', options, (t) => {
  const store = setup(t), d = assigned('owner', { workKey: 'original' });
  campaignStart(store, d);
  d.authorization.version++;
  d.tasks[0].workKey = 'replacement';
  assert.throws(() => campaignStart(store, d), (error) => error.code === 'SCOPE_CONFLICT');
  assert.equal(store.campaign('owner').declaration.tasks[0].workKey, 'original');
});

test('two concurrent registrations on two SQLite connections admit exactly one owner', { ...options, timeout: 20000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-ownership-')), path = join(dir, 'supervisor.db');
  const initial = new Store(path);
  initial.close();
  const workers = [];
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const script = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { Store } = await import(workerData.storeUrl);
      const { campaignStart } = await import(workerData.apiUrl);
      const store = new Store(workerData.path);
      parentPort.once('message', () => {
        try { campaignStart(store, workerData.declaration); parentPort.postMessage('admitted'); }
        catch (error) { parentPort.postMessage(error.code || String(error)); }
        finally { store.close(); parentPort.close(); }
      });
      parentPort.postMessage('ready');
    })().catch((error) => { throw error; });
  `;
  const ready = ['first', 'second'].map((id) => {
    const worker = new Worker(script, { eval: true, workerData: {
      path, declaration: assigned(id),
      storeUrl: new URL('../../src/supervisor/store.mjs', import.meta.url).href,
      apiUrl: new URL('../../src/supervisor/api.mjs', import.meta.url).href,
    } });
    workers.push(worker);
    return once(worker, 'message');
  });
  assert.deepEqual(await Promise.all(ready), [['ready'], ['ready']]);
  const results = workers.map((worker) => once(worker, 'message'));
  workers.forEach((worker) => worker.postMessage('start'));
  assert.deepEqual((await Promise.all(results)).flat().sort(), ['WORK_ALREADY_ASSIGNED', 'admitted']);
  const store = new Store(path);
  try {
    assert.equal(store.all('SELECT * FROM campaigns').length, 1);
    assert.equal(store.all('SELECT * FROM tasks').length, 1);
    assert.equal(store.all('SELECT * FROM operations').length, 0);
    assert.equal(store.all('SELECT * FROM journal').length, 1);
    assert.equal(store.all('SELECT runs_used FROM campaigns')[0].runs_used, 0);
  } finally { store.close(); }
});
