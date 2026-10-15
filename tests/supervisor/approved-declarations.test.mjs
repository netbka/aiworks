// Approved declarations persist privately and register once (docs/design/WORK_ENVELOPE.md section 5, slice E9; plan
// STA13). Every declaration and approval here is synthetic and lives in a disposable directory; the runtime is a
// disposable checkout whose origin/main is a local ref, and gh is the synthetic one. No model, network or GitHub call.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { authorityDigest } from '../../src/supervisor/campaign.mjs';
import { declaration, environment, GOVERNANCE, runCli, runtimeCheckout, SQLITE } from './helpers.mjs';
// Loaded leniently so that, on a revision without slice E9, each test fails on its own assertion.
const stored = await import('../../src/supervisor/approved-declarations.mjs').catch(() => ({}));
const github = await import('../../src/supervisor/adapters/github.mjs');
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { campaignPause } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const { revokeApprovals } = SQLITE ? await import('../../src/supervisor/approvals.mjs') : {};
// A host whose temporary directory lies inside a Git work tree (a home directory under Git) must not decide these tests:
// Git looks for a work tree no higher than the temporary directory, so only the disposable repositories below count.
process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());
// These tests run no worker, so they need SQLite only and run on Linux as on Windows.
const skipWithoutSqlite = SQLITE ? false : 'node:sqlite requires Node >= 22.5; the supervisor refuses to run without it';

const text = (value) => `${JSON.stringify(value, null, 2)}\n`;
const commitTask = (id, issue) => ({ id, issue, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`,
  dependsOn: [], acceptance: [`${id} exists`], references: ['AGENTS.md'], writes: ['src/chat/ui/'] });
/** A synthetic version 2 declaration (WORK_ENVELOPE 4.1); each campaign reports to its own issue (#5). */
const envelope = (campaignId, issue = 512) => ({
  ...declaration({ campaignId, tasks: [commitTask('T1', issue)] }), version: 2,
  envelope: {
    scopeVersion: 1,
    request: { route: 'issue', reference: 'example-org/sampleapp#512', pinned: { base: 'a'.repeat(40), issueUpdatedAt: '2026-10-19T08:00:00Z' } },
    outcome: 'People can search the text of their chats and open the matching message.',
    acceptance: ['Searching a word shows every chat message containing it, newest first'],
    writes: ['src/chat/', 'tests/chat/'], deliverables: ['commit'], issues: [issue], web: null,
    release: { mode: 'review-only' }, planning: 'adaptive',
  },
});
const approvalOf = (decl, extra = {}) => ({ schema: 'aiworks-envelope-approval/1', approvalId: `approval-${decl.campaignId}-1`, campaignId: decl.campaignId,
  authorityDigest: authorityDigest(decl), approvedBy: 'owner', approvedAt: '2026-10-20T09:00:00Z', draftVersion: 1, request: 'example-org/sampleapp#512', ...extra });
const count = (store, campaignId, kind) => store.all('SELECT 1 FROM journal WHERE campaign_id = ? AND kind = ?', campaignId, kind).length;
const codeOf = (out) => /^([A-Z_]+):/m.exec(out.stderr)?.[1] ?? null;

/** A disposable store outside every Git work tree. */
function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-approved-'));
  const path = join(dir, 'supervisor.db');
  const opened = [];
  const open = () => { const store = new Store(path); opened.push(store); return store; };
  t.after(() => { for (const store of opened) { try { store.close(); } catch { /* already closed */ } } rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  return { dir, open };
}

test('persisting an approved declaration keeps its exact digest, registers nothing and is idempotent', { skip: skipWithoutSqlite }, (t) => {
  const store = tempStore(t).open();
  assert.equal(store.get("SELECT 1 AS present FROM sqlite_master WHERE name = 'approved_declarations'"), null, 'a store that never persisted is untouched');
  const decl = envelope('kept-plan');
  const first = stored.persistApproved(store, decl, approvalOf(decl));
  assert.equal(first.persisted, true);
  assert.equal(first.authorityDigest, authorityDigest(decl));
  assert.equal(first.registeredAt, null);
  assert.equal(store.campaign('kept-plan'), null, 'persisting registers nothing');
  assert.equal(store.all("SELECT 1 FROM operations WHERE campaign_id = 'kept-plan'").length, 0);
  assert.equal(stored.persistApproved(store, decl, approvalOf(decl)).persisted, false, 'the same approval again changes nothing');
  assert.equal(count(store, 'kept-plan', 'declaration-persisted'), 1);
  assert.deepEqual(Object.keys(stored.approvedDeclarations(store, 'kept-plan')[0]).sort(),
    ['approvalId', 'authorityDigest', 'campaignId', 'persistedAt', 'registeredAt'], 'the listing carries no private contents');
  // One changed byte, an approval for another campaign, a missing approval or a reused approval id persists nothing.
  const changed = JSON.parse(JSON.stringify(decl).replace('newest first', 'newest firsT'));
  assert.throws(() => stored.persistApproved(store, changed, approvalOf(decl)), (e) => e.code === 'DECLARATION_DIFFERS_FROM_APPROVAL');
  assert.throws(() => stored.persistApproved(store, decl, approvalOf({ ...decl, campaignId: 'other-plan' })), (e) => e.code === 'APPROVAL_CAMPAIGN_MISMATCH');
  assert.throws(() => stored.persistApproved(store, decl, null), (e) => e.code === 'APPROVAL_REQUIRED');
  const amended = { ...decl, authorization: { ...decl.authorization, version: 2 } };
  assert.throws(() => stored.persistApproved(store, amended, approvalOf(amended)), (e) => e.code === 'APPROVAL_INVALID');
  assert.equal(stored.approvedDeclarations(store, 'kept-plan').length, 1);
});

test('a restart preserves the approved digest and the campaign registers only once', { skip: skipWithoutSqlite }, (t) => {
  const { open } = tempStore(t);
  const decl = envelope('restart-plan');
  const digest = authorityDigest(decl);
  let store = open();
  stored.persistApproved(store, decl, approvalOf(decl));
  store.close(); // the supervisor stops between the owner's approval and the registration
  store = open();
  assert.equal(stored.approvedDeclaration(store, 'restart-plan').authorityDigest, digest, 'the persisted digest survives the restart');
  const first = stored.registerApproved(store, 'restart-plan');
  assert.equal(first.registered, true);
  assert.equal(first.authorityDigest, digest);
  // A second connection, a retry and a later restart each find it registered and change nothing.
  const other = open();
  assert.equal(stored.registerApproved(other, 'restart-plan').registered, false);
  assert.equal(stored.registerApproved(store, 'restart-plan').registered, false);
  store.close();
  other.close();
  store = open();
  assert.equal(stored.registerApproved(store, 'restart-plan').registered, false);
  assert.equal(authorityDigest(store.campaign('restart-plan').declaration), digest, 'the registered declaration is the approved one');
  assert.equal(count(store, 'restart-plan', 'registered'), 1);
  assert.equal(count(store, 'restart-plan', 'approval-bound'), 1);
  assert.equal(store.tasks('restart-plan').length, 1);
  assert.notEqual(stored.approvedDeclarations(store, 'restart-plan')[0].registeredAt, null);
  // Registering again never resumes a paused campaign: Resume stays a separate owner act.
  campaignPause(store, 'restart-plan', 'test');
  assert.equal(stored.registerApproved(store, 'restart-plan').registered, false);
  assert.equal(store.campaign('restart-plan').control, 'paused');
  assert.equal(count(store, 'restart-plan', 'resumed'), 0);
});

test('a changed byte in the private store, a revoked approval or no approved declaration starts nothing', { skip: skipWithoutSqlite }, (t) => {
  const store = tempStore(t).open();
  assert.throws(() => stored.registerApproved(store, 'never-persisted'), (e) => e.code === 'APPROVED_DECLARATION_NOT_FOUND');
  const decl = envelope('tampered-plan');
  stored.persistApproved(store, decl, approvalOf(decl));
  const row = store.get("SELECT declaration_text FROM approved_declarations WHERE campaign_id = 'tampered-plan'");
  store.run("UPDATE approved_declarations SET declaration_text = ? WHERE campaign_id = 'tampered-plan'", row.declaration_text.replace('newest first', 'newest firsT'));
  assert.throws(() => stored.registerApproved(store, 'tampered-plan'), (e) => e.code === 'DECLARATION_DIFFERS_FROM_APPROVAL' && !e.message.includes('newest'));
  store.run("UPDATE approved_declarations SET declaration_text = '{PRIVATE' WHERE campaign_id = 'tampered-plan'");
  assert.throws(() => stored.registerApproved(store, 'tampered-plan'), (e) => e.code === 'DECLARATION_DIFFERS_FROM_APPROVAL' && !e.message.includes('PRIVATE'));
  assert.equal(store.campaign('tampered-plan'), null);
  // Revoked after registration: the campaign is cancelled and the stored declaration never registers again.
  const revoked = envelope('revoked-plan', 513);
  stored.persistApproved(store, revoked, approvalOf(revoked));
  stored.registerApproved(store, 'revoked-plan');
  revokeApprovals(store, 'revoked-plan', { reason: 'owner withdrew the plan' });
  assert.throws(() => stored.registerApproved(store, 'revoked-plan'), (e) => e.code === 'APPROVAL_REVOKED');
  assert.throws(() => stored.persistApproved(store, revoked, approvalOf(revoked)), (e) => e.code === 'APPROVAL_REVOKED');
  assert.equal(store.campaign('revoked-plan').control, 'cancel-requested');
});

test('a newer approved declaration amends the campaign once', { skip: skipWithoutSqlite }, (t) => {
  const store = tempStore(t).open();
  const decl = envelope('amended-plan');
  stored.persistApproved(store, decl, approvalOf(decl));
  stored.registerApproved(store, 'amended-plan');
  const amended = { ...decl, purpose: 'Changed wording', authorization: { ...decl.authorization, version: 2 } };
  stored.persistApproved(store, amended, approvalOf(amended, { approvalId: 'approval-amended-plan-2' }));
  assert.equal(stored.registerApproved(store, 'amended-plan').registered, true);
  assert.equal(stored.registerApproved(store, 'amended-plan').registered, false);
  assert.equal(store.campaign('amended-plan').authorization_version, 2);
  assert.equal(authorityDigest(store.campaign('amended-plan').declaration), authorityDigest(amended));
  assert.equal(count(store, 'amended-plan', 'authorization-amended'), 1);
  assert.equal(count(store, 'amended-plan', 'registered'), 1);
});

test('campaign data never enters source Git: a store Git would track is refused', { skip: skipWithoutSqlite }, (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'aiworks-approved-repo-'));
  const opened = [];
  t.after(() => { for (const store of opened) store.close(); rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(git('init', '-q', '-b', 'main').status, 0);
  const open = (name) => { mkdirSync(join(repo, name), { recursive: true }); const store = new Store(join(repo, name, 'supervisor.db')); opened.push(store); return store; };
  const decl = envelope('git-plan');
  const tracked = open('data');
  assert.throws(() => stored.persistApproved(tracked, decl, approvalOf(decl)), (e) => e.code === 'PRIVATE_STORE_NOT_IGNORED');
  assert.equal(tracked.get("SELECT 1 AS present FROM sqlite_master WHERE name = 'approved_declarations'"), null, 'nothing private was written');
  // Ignoring only the database file is not enough: its WAL files hold the same data.
  writeFileSync(join(repo, '.gitignore'), 'partial/*.db\nprivate/\n');
  assert.throws(() => stored.persistApproved(open('partial'), decl, approvalOf(decl)), (e) => e.code === 'PRIVATE_STORE_NOT_IGNORED');
  assert.equal(stored.persistApproved(open('private'), decl, approvalOf(decl)).persisted, true, 'an ignored data directory is private');
});

test('approve and start --approved: restart-safe, registered once, and the checkout gains no branch, commit or file', { skip: skipWithoutSqlite }, (t) => {
  const runtime = runtimeCheckout();
  const privateDir = mkdtempSync(join(tmpdir(), 'aiworks-approved-private-'));
  // The data directory is inside the checkout's ignored campaigns/ directory, as private operator data may be.
  const data = join(runtime.root, 'campaigns', 'data');
  t.after(() => { runtime.cleanup(); rmSync(privateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const file = (name, value) => { const path = join(privateDir, name); writeFileSync(path, text(value)); return path; };
  const cli = (...args) => runCli(runtime.cli, [...args, '--data', data, '--governance', GOVERNANCE]);
  const before = { refs: runtime.refs(), changes: runtime.changes() };
  const decl = envelope('cli-plan');
  const approval = file('approval.json', approvalOf(decl));
  assert.equal(codeOf(cli('approve', file('plan.json', decl))), 'APPROVAL_REQUIRED');
  const changed = cli('approve', file('changed.json', { ...decl, purpose: 'Not what was approved' }), '--approval', approval);
  assert.equal(codeOf(changed), 'DECLARATION_DIFFERS_FROM_APPROVAL');
  const approved = cli('approve', file('plan.json', decl), '--approval', approval);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(JSON.parse(approved.stdout).authorityDigest, authorityDigest(decl));
  // The owner's files may go away: registration reads only the private store. Each CLI call is a fresh process.
  rmSync(privateDir, { recursive: true, force: true });
  const first = cli('start', '--approved', 'cli-plan');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).registered, true);
  const again = cli('start', '--approved', 'cli-plan');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).registered, false);
  assert.equal(codeOf(cli('start', '--approved', 'unknown-plan')), 'APPROVED_DECLARATION_NOT_FOUND');
  const store = new Store(join(data, 'supervisor.db'));
  try {
    assert.equal(count(store, 'cli-plan', 'registered'), 1);
    assert.equal(authorityDigest(store.campaign('cli-plan').declaration), authorityDigest(decl));
  } finally { store.close(); }
  assert.deepEqual({ refs: runtime.refs(), changes: runtime.changes() }, before, 'no branch, commit or trackable file was created');
});

test('unmerged runtime code registers nothing from the private store', { skip: skipWithoutSqlite }, (t) => {
  const runtime = runtimeCheckout();
  const data = mkdtempSync(join(tmpdir(), 'aiworks-approved-data-'));
  t.after(() => { runtime.cleanup(); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const decl = envelope('unmerged-plan');
  const store = new Store(join(data, 'supervisor.db'));
  try { stored.persistApproved(store, decl, approvalOf(decl)); } finally { store.close(); }
  writeFileSync(join(runtime.root, 'UNMERGED.md'), 'A local commit that origin/main does not contain.\n');
  runtime.git('add', '-A');
  runtime.git('commit', '-q', '-m', 'unmerged local change');
  const out = runCli(runtime.cli, ['start', '--approved', 'unmerged-plan', '--data', data, '--governance', GOVERNANCE]);
  assert.equal(codeOf(out), 'RUNTIME_NOT_MERGED');
  const after = new Store(join(data, 'supervisor.db'));
  try { assert.equal(after.campaign('unmerged-plan'), null); } finally { after.close(); }
});

test('a declaration pull request is never opened: the declaration branch is refused before any gh call', (t) => {
  const env = environment();
  t.after(() => env.cleanup());
  const gh = env.config.commands.gh;
  for (const branch of ['declare/sampleapp-chat-search', 'Declare/x']) {
    assert.throws(() => github.openPullRequest({ gh, repository: 'example-org/sampleapp', baseBranch: 'main', branch, title: 'plan', body: 'plan', bodyFile: join(env.tmp, 'body.md') }),
      (e) => e.code === 'DECLARATION_PUBLISH_REFUSED');
  }
  assert.deepEqual(env.ghCalls(), [], 'gh was never called');
  assert.deepEqual(env.prs(), []);
  assert.equal(github.declarationBranch('campaign/sampleapp/T1'), false, 'task branches publish as before');
});

test('the private store and its loader have no publication path', () => {
  const source = readFileSync(new URL('../../src/supervisor/approved-declarations.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|config\.commands|adapters\/|\bgh\b|push|fetch\(|https?:|writeFile|commit/);
  const cli = readFileSync(new URL('../../src/supervisor/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /command === 'start' && approvedFlag !== null\) \{\n?\r?\n?[^]*?revisionNotMerged\(\{ root: CODE_ROOT \}\)/);
  assert.doesNotMatch(cli, /campaignStart\(/, 'every CLI start goes through the approval check');
});
