// LO L7 (docs/design/LOCAL_OPERATION.md sections 5.1 to 5.3 and 9, slice SELF7): with local main trusted, the
// self-hosted repository's verified results, reports and notes go to the local work list. A synthetic gh and a Git guard
// fail the test if anything reaches for GitHub or a remote; an owner-written work item admits only its own campaign.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { recordAnchor, selfHostingSettings } from '../../src/supervisor/self-hosting.mjs';
import { comments, createItem, items, workAuthorization } from '../../src/supervisor/work-list.mjs';
import { declaration, environment, runUntil, skipWithoutSqlite } from './helpers.mjs';

const REPOSITORY = 'example-org/sampleapp';
const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

/** A gh that records and refuses every call, and a Git wrapper that refuses fetch, push, pull and ls-remote. */
function guards(dir) {
  const log = join(dir, 'forbidden.log');
  writeFileSync(join(dir, 'forbidden-gh.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], JSON.stringify(['gh', ...process.argv.slice(3)]) + '\\n');
process.exit(97);
`);
  writeFileSync(join(dir, 'git-guard.mjs'), `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(3);
if (args.some((arg) => ['fetch', 'push', 'ls-remote', 'pull'].includes(arg))) {
  appendFileSync(process.argv[2], JSON.stringify(['git', ...args]) + '\\n');
  process.exit(97);
}
const out = spawnSync('git', args, { stdio: 'inherit', windowsHide: true });
process.exit(out.status ?? 1);
`);
  return { log, gh: [process.execPath, join(dir, 'forbidden-gh.mjs'), log], git: [process.execPath, join(dir, 'git-guard.mjs'), log] };
}

/** The self-hosted repository with its main ledger anchored and no remote, and the store that holds its work list. */
function selfHosted(t, { scenario } = {}) {
  const env = environment({ scenario });
  const forbidden = guards(env.tmp);
  const config = { ...env.config, commands: { ...env.config.commands, gh: forbidden.gh, git: forbidden.git },
    selfHosting: { repository: REPOSITORY, trustedMain: 'local' } };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const anchor = git(env.repo, 'rev-parse', 'main');
  git(env.repo, 'update-ref', 'refs/remotes/origin/main', anchor);
  assert.equal(recordAnchor(store, { repoPath: env.repo, repository: REPOSITORY, sha: anchor, now: 1 }).recorded, true);
  git(env.repo, 'remote', 'remove', 'origin');
  return { env, forbidden, config, store };
}
const imported = (store, number) => createItem(store, { number, kind: 'task', title: `synthetic item ${number}`, authorKind: 'import', now: 1 });

test('LO L7: verified commit and report of the self-hosted repository go to the work list once, whole, with no push and no gh', { skip: skipWithoutSqlite }, async (t) => {
  const { env, forbidden, config, store } = selfHosted(t, { scenario: { implement: ['commit', 'report-big'], verify: ['accept', 'accept-big'] } });
  for (const number of [437, 438, 443]) imported(store, number);
  const d = declaration({ tasks: [
    { id: 'T1', issue: 437, title: 'first task', deliverable: 'commit', goal: 'Produce the first artifact.', dependsOn: [], acceptance: ['artifact exists'], references: ['AGENTS.md'] },
    { id: 'R1', issue: 438, title: 'review', deliverable: 'report', goal: 'Review only.', dependsOn: [], acceptance: ['recorded'], references: ['AGENTS.md'] },
  ] });
  campaignStart(store, d);
  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  // A crash after the review item is recorded and before the task's `done` commits: the transaction holds both, so the
  // replacement records it again exactly once.
  let crashed = 0;
  controller.injectFault = (name) => { if (name === 'after-work-item' && !crashed++) throw new Error('synthetic crash after recording'); };

  await runUntil(controller, store, d.campaignId, (c) => c.control === 'finished' &&
    !store.all("SELECT 1 FROM outbox WHERE campaign_id = ? AND state = 'pending'", d.campaignId).length);
  assert.equal(crashed > 1, true, 'the crash happened and publication ran again');
  const t1 = store.task(d.campaignId, 'T1'), r1 = store.task(d.campaignId, 'R1');

  // Replay both publications of verified tasks, as a retry after a lost commit would: nothing is recorded twice.
  store.patch('campaigns', { id: d.campaignId }, store.campaign(d.campaignId).version, { control: 'registered' }, Date.now());
  for (const task of [t1, r1]) {
    store.patch('tasks', { campaign_id: d.campaignId, task_id: task.task_id }, store.task(d.campaignId, task.task_id).version, { state: 'verified' }, Date.now());
    const ctx = { id: d.campaignId, generation: controller.held.get(d.campaignId) };
    await controller.publish(ctx, store.campaign(d.campaignId), store.task(d.campaignId, task.task_id));
  }
  await controller.drainOutbox();

  const reviews = items(store).filter((item) => item.kind === 'review');
  assert.equal(reviews.length, 1, 'one review item for the verified commit');
  assert.equal(reviews[0].task_id, 'T1');
  assert.equal(store.task(d.campaignId, 'T1').pr_url, `aiworks-work:${reviews[0].number}`);
  assert.equal(t1.verified_sha, store.task(d.campaignId, 'T1').verified_sha);

  const report = comments(store, 438);
  assert.equal(report.length, 1, 'one report comment on the task item');
  const digest = createHash('sha256').update(r1.result.report, 'utf8').digest('hex');
  assert.ok(report[0].body.length > 65_536, 'the report and its verification exceed a GitHub body');
  assert.ok(report[0].body.includes(r1.result.report) && report[0].body.includes(digest) && report[0].body.includes(r1.verified_sha),
    'the whole digest-bound report is stored in one comment');

  const notes = comments(store, 443);
  const keys = notes.map((note) => note.idempotency_key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes(`${d.campaignId}:T1:published:${t1.verified_sha}`) && keys.includes(`${d.campaignId}:ready`), 'outbox notes land on the tracking item');
  assert.deepEqual(store.all('SELECT DISTINCT state FROM outbox WHERE campaign_id = ?', d.campaignId).map((row) => row.state), ['posted']);

  assert.deepEqual(lines(forbidden.log), [], 'nothing ran gh, fetched, pushed or listed a remote');
});

test('LO L7: an aiworks-work authorization admits only its own campaign of the self-hosted repository', { skip: skipWithoutSqlite }, async (t) => {
  const { env, forbidden, config, store } = selfHosted(t);
  const settings = selfHostingSettings(config);
  const owner = (campaignId) => createItem(store, { kind: 'decision', title: 'synthetic owner authorization', authorKind: 'owner',
    links: { campaignId }, now: 1 }).number;
  const authorized = (reference, campaignId = 'test-campaign', repository = REPOSITORY) => {
    const d = declaration({ campaignId, tasks: [declaration().tasks[0]] });
    d.authorization.reference = reference;
    d.target.repository = repository;
    return d;
  };
  const code = (fn) => { try { fn(); return null; } catch (error) { return error.code; } };

  const own = owner('test-campaign');
  assert.equal(workAuthorization(store, authorized(`aiworks-work:${own}`), { selfHosting: settings }).number, own);
  assert.equal(code(() => workAuthorization(store, authorized(`aiworks-work:${own}`, 'test-campaign', 'example-org/service'), { selfHosting: settings })),
    'WORK_AUTHORIZATION_UNTRUSTED', 'another repository is never admitted by a work item');
  assert.equal(code(() => workAuthorization(store, authorized(`aiworks-work:${own}`), { selfHosting: selfHostingSettings({}) })),
    'WORK_AUTHORIZATION_UNTRUSTED', 'without local trust a work item admits nothing');
  const machine = createItem(store, { kind: 'note', title: 'written by the supervisor', authorKind: 'supervisor', links: { campaignId: 'test-campaign' }, now: 1 }).number;
  assert.equal(code(() => workAuthorization(store, authorized(`aiworks-work:${machine}`), { selfHosting: settings })), 'WORK_AUTHORIZATION_NOT_OWNER');

  // A campaign that names the owner's item for another campaign registers, but no worker ever starts for it.
  const other = owner('another-campaign');
  const d = authorized(`aiworks-work:${other}`, 'unrelated-campaign');
  campaignStart(store, d);
  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  await runUntil(controller, store, d.campaignId, (c) => c.blocker?.kind === 'work-authorization');
  assert.equal(env.calls().length, 0, 'no worker started');
  assert.deepEqual(lines(forbidden.log), []);
});
