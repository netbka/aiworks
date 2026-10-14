// An approved plan starts only under its exact private approval and merged runtime code (docs/design/WORK_ENVELOPE.md
// section 5, slice E7; plan STA11). Every approval and declaration here is synthetic and lives in a disposable directory;
// the runtime is a disposable checkout whose origin/main is a local ref. No model, network or GitHub call.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { authorityDigest } from '../../src/supervisor/campaign.mjs';
import { declaration, GOVERNANCE, runCli, runtimeCheckout, skipWithoutSqlite, SQLITE } from './helpers.mjs';
// Loaded leniently so that, on a revision without slice E7, each test fails on its own assertion.
const approvals = await import('../../src/supervisor/approvals.mjs').catch(() => ({}));
const provenance = await import('../../src/supervisor/provenance.mjs').catch(() => ({}));
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { campaignPause } = SQLITE ? await import('../../src/supervisor/api.mjs') : {};

const text = (value) => `${JSON.stringify(value, null, 2)}\n`;
const commitTask = (id, issue, extra = {}) => ({ id, issue, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`,
  dependsOn: [], acceptance: [`${id} exists`], references: ['AGENTS.md'], writes: ['src/chat/ui/'], ...extra });
/** A synthetic version 2 declaration: the example of WORK_ENVELOPE 4.1 on the test declaration. Each test campaign
 * reports to its own issue, so two campaigns in one store never hold the same work (#5). */
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
/** The owner's private approval of exactly `decl`. */
const approvalOf = (decl, extra = {}) => ({ schema: 'aiworks-envelope-approval/1', approvalId: `approval-${decl.campaignId}-1`, campaignId: decl.campaignId,
  authorityDigest: authorityDigest(decl), approvedBy: 'owner', approvedAt: '2026-10-20T09:00:00Z', draftVersion: 1, request: 'example-org/sampleapp#512', ...extra });

/** A merged runtime checkout, a private directory for the owner's files and a data directory. */
function installation(t, { unmerged = false } = {}) {
  const runtime = runtimeCheckout({ unmerged });
  const privateDir = mkdtempSync(join(tmpdir(), 'aiworks-approval-private-'));
  const data = mkdtempSync(join(tmpdir(), 'aiworks-approval-data-'));
  t.after(() => { runtime.cleanup(); for (const dir of [privateDir, data]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const file = (name, value) => { const path = join(privateDir, name); writeFileSync(path, typeof value === 'string' ? value : text(value)); return path; };
  const cli = (...args) => runCli(runtime.cli, [...args, '--data', data, '--governance', GOVERNANCE]);
  const inspect = (fn) => { const store = new Store(join(data, 'supervisor.db')); try { return fn(store); } finally { store.close(); } };
  return { runtime, data, file, cli, inspect };
}
const codeOf = (out) => /^([A-Z_]+):/m.exec(out.stderr)?.[1] ?? null;

test('an approval record has one shape, and a bad record is refused without echoing it', () => {
  const decl = declaration({ campaignId: 'shape' });
  assert.equal(approvals.validateApproval(approvalOf(decl)).campaignId, 'shape');
  for (const [label, record] of [
    ['an unknown key', { ...approvalOf(decl), note: 'PRIVATE-NOTE' }],
    ['a short digest', approvalOf(decl, { authorityDigest: 'abc' })],
    ['another schema', approvalOf(decl, { schema: 'aiworks-envelope-approval/2' })],
    ['an impossible date', approvalOf(decl, { approvedAt: '2026-13-45' })],
    ['no approver', { ...approvalOf(decl), approvedBy: undefined }],
  ]) {
    assert.throws(() => approvals.validateApproval(JSON.parse(JSON.stringify(record))),
      (error) => error.code === 'APPROVAL_INVALID' && !error.message.includes('PRIVATE-NOTE'), label);
  }
});

test('approvals are off by default: version 1 and version 2 start as before; the switch requires one for new version 2 only', { skip: skipWithoutSqlite }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-approval-switch-'));
  const store = new Store(join(dir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  assert.equal(approvals.approvalRequired({}), false);
  assert.equal(approvals.approvalRequired({ approvals: { required: 'yes' } }), false, 'only true switches it on');
  const v1 = (campaignId, issue) => declaration({ campaignId, tasks: [{ ...declaration().tasks[0], issue }] });
  approvals.approvedStart(store, v1('v1-free', 601), null);
  approvals.approvedStart(store, envelope('v2-free', 602), null);
  assert.ok(store.campaign('v1-free') && store.campaign('v2-free'));
  assert.equal(store.get("SELECT 1 AS present FROM sqlite_master WHERE name = 'envelope_approvals'"), null, 'a store without approvals is untouched');
  const required = { required: approvals.approvalRequired({ approvals: { required: true } }) };
  assert.throws(() => approvals.approvedStart(store, envelope('v2-required', 603), null, required), (e) => e.code === 'APPROVAL_REQUIRED');
  assert.equal(store.campaign('v2-required'), null);
  approvals.approvedStart(store, v1('v1-required', 604), null, required);
  approvals.approvedStart(store, envelope('v2-free', 602), null, required);
  assert.equal(store.campaign('v2-free').control, 'registered', 'a stored campaign resumes as before');
  const approved = envelope('v2-approved', 605);
  approvals.approvedStart(store, approved, approvalOf(approved), required);
  assert.deepEqual(approvals.campaignApprovals(store, 'v2-approved').map((row) => row.authorityDigest), [authorityDigest(approved)]);
});

test('the identical approved file starts; one changed byte gives DECLARATION_DIFFERS_FROM_APPROVAL and starts nothing', { skip: skipWithoutSqlite }, (t) => {
  const { file, cli, inspect } = installation(t);
  const decl = envelope('exact-plan');
  const approval = file('approval.json', approvalOf(decl));
  const approvedText = text(decl);
  const changed = approvedText.replace('newest first', 'newest firsT');
  assert.equal(changed.length, approvedText.length);
  assert.equal([...changed].filter((char, index) => char !== approvedText[index]).length, 1, 'exactly one byte differs');
  const tampered = cli('start', file('plan.json', changed), '--approval', approval);
  assert.equal(tampered.status, 1);
  assert.equal(codeOf(tampered), 'DECLARATION_DIFFERS_FROM_APPROVAL');
  inspect((store) => {
    assert.equal(store.campaign('exact-plan'), null, 'a refused start registers nothing');
    assert.deepEqual(approvals.campaignApprovals(store, 'exact-plan'), [], 'and records no approval');
  });
  // The approved bytes, even with Windows line endings, start under the approval and record it once.
  const started = cli('start', file('plan.json', approvedText.replaceAll('\n', '\r\n')), '--approval', approval);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(cli('start', file('plan.json', approvedText), '--approval', approval).status, 0, 'resuming under the same approval');
  inspect((store) => {
    assert.equal(store.campaign('exact-plan').control, 'registered');
    assert.deepEqual(approvals.campaignApprovals(store, 'exact-plan').map((row) => row.approvalId), ['approval-exact-plan-1']);
    assert.equal(store.all("SELECT 1 FROM journal WHERE campaign_id = 'exact-plan' AND kind = 'approval-bound'").length, 1);
    campaignPause(store, 'exact-plan', 'test');
  });
  // A campaign started under an approval never resumes without one, or under a changed declaration.
  assert.equal(codeOf(cli('start', file('plan.json', approvedText))), 'APPROVAL_REQUIRED');
  const amended = { ...decl, purpose: 'Changed wording', authorization: { ...decl.authorization, version: 2 } };
  assert.equal(codeOf(cli('start', file('plan.json', amended), '--approval', approval)), 'DECLARATION_DIFFERS_FROM_APPROVAL');
  inspect((store) => assert.equal(store.campaign('exact-plan').control, 'paused'));
  // The owner's new approval of the amended plan, under a new id, amends it; a reused id with another digest is refused.
  assert.equal(codeOf(cli('start', file('plan.json', amended), '--approval', file('reused.json', approvalOf(amended)))), 'APPROVAL_INVALID');
  const reapproved = file('approval-2.json', approvalOf(amended, { approvalId: 'approval-exact-plan-2' }));
  const amendedStart = cli('start', file('plan.json', amended), '--approval', reapproved);
  assert.equal(amendedStart.status, 0, amendedStart.stderr);
  inspect((store) => assert.equal(store.campaign('exact-plan').authorization_version, 2));
});

test('an approval for another campaign, or an unreadable one, starts nothing and echoes nothing', { skip: skipWithoutSqlite }, (t) => {
  const { file, cli, inspect } = installation(t);
  const decl = envelope('one-plan');
  const plan = file('plan.json', decl);
  assert.equal(codeOf(cli('start', plan, '--approval', file('other.json', approvalOf({ ...decl, campaignId: 'other-plan' })))), 'APPROVAL_CAMPAIGN_MISMATCH');
  const broken = cli('start', plan, '--approval', file('broken.json', '{PRIVATE-APPROVAL'));
  assert.equal(codeOf(broken), 'APPROVAL_INVALID');
  assert.doesNotMatch(broken.stderr, /PRIVATE-APPROVAL/);
  assert.equal(codeOf(cli('start', plan, '--approval', file('extra.json', { ...approvalOf(decl), secretNote: 'PRIVATE-NOTE' }))), 'APPROVAL_INVALID');
  inspect((store) => assert.equal(store.campaign('one-plan'), null));
});

test('unmerged runtime code starts nothing, even under a matching approval', { skip: skipWithoutSqlite }, (t) => {
  const { runtime, file, cli, inspect } = installation(t, { unmerged: true });
  const decl = envelope('unmerged-plan');
  const approval = file('approval.json', approvalOf(decl));
  const out = cli('start', file('plan.json', decl), '--approval', approval);
  assert.equal(out.status, 1);
  assert.equal(codeOf(out), 'RUNTIME_NOT_MERGED');
  assert.throws(() => provenance.approvalFromFile(approval, { root: runtime.root }), (e) => e.code === 'RUNTIME_NOT_MERGED');
  inspect((store) => assert.equal(store.campaign('unmerged-plan'), null));
  // Once origin/main contains the same code, the same files start.
  runtime.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal(cli('start', file('plan.json', decl), '--approval', approval).status, 0);
});

test('a revoked private approval starts nothing', { skip: skipWithoutSqlite }, (t) => {
  const { file, cli, inspect } = installation(t);
  // Revoked in the owner's private file before any start.
  const early = envelope('revoked-early');
  const revokedFile = cli('start', file('early.json', early), '--approval', file('early-approval.json', approvalOf(early, { revokedAt: '2026-10-21T10:00:00Z' })));
  assert.equal(codeOf(revokedFile), 'APPROVAL_REVOKED');
  inspect((store) => assert.equal(store.campaign('revoked-early'), null));
  // Revoked after the start: the campaign is cancelled, so neither the CLI nor the dashboard's Resume can restart it.
  const decl = envelope('revoked-late', 513);
  const plan = file('plan.json', decl);
  const approval = file('approval.json', approvalOf(decl));
  assert.equal(cli('start', plan, '--approval', approval).status, 0);
  const revoked = cli('approval-revoke', 'revoked-late', 'owner withdrew the plan');
  assert.equal(revoked.status, 0, revoked.stderr);
  const result = JSON.parse(revoked.stdout);
  assert.equal(result.revoked, 1);
  assert.equal(result.control, 'cancel-requested');
  assert.equal(codeOf(cli('start', plan, '--approval', approval)), 'APPROVAL_REVOKED');
  assert.equal(codeOf(cli('start', plan)), 'APPROVAL_REQUIRED');
  inspect((store) => {
    assert.equal(store.campaign('revoked-late').control, 'cancel-requested');
    assert.equal(store.all("SELECT 1 FROM operations WHERE campaign_id = 'revoked-late'").length, 0, 'no worker operation exists');
    assert.ok(approvals.campaignApprovals(store, 'revoked-late').every((row) => row.revokedAt && row.revokedReason === 'owner withdrew the plan'));
  });
  assert.equal(codeOf(cli('approval-revoke', 'never-approved')), 'APPROVAL_NOT_FOUND');
});

test('approvals and the loader never publish and have no bypass', () => {
  const source = ['approvals.mjs', 'provenance.mjs'].map((name) => readFileSync(new URL(`../../src/supervisor/${name}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(source, /process\.env|config\.commands|adapters\/github|\bgh\b|push/);
  const cli = readFileSync(new URL('../../src/supervisor/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /approvalFromFile\(approvalFlag, \{ root: CODE_ROOT \}\)/);
  assert.doesNotMatch(cli, /campaignStart\(/, 'every CLI start goes through the approval check');
});
