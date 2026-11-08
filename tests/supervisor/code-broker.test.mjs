import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeBrokerPolicy, codeSnapshot, safeCodePath } from '../../src/supervisor/code-broker.mjs';
import { environment, declaration, skipWithoutSqlite } from './helpers.mjs';
import { exec } from '../../src/supervisor/adapters/git.mjs';
import { roleUnavailableReason } from '../../src/supervisor/adapters/executors.mjs';
import { Store } from '../../src/supervisor/store.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';

test('code capability requires the exact campaign, model, role and included-only grant', () => {
  const command = [process.execPath, fileURLToPath(new URL('../../src/supervisor/adapters/cursor-wsl.mjs', import.meta.url)), '--config', 'private.json'];
  const declaration = { campaignId: 'sample-campaign', target: { repository: 'example-org/sampleapp' } };
  const provider = { kind: 'cursor-cli', model: 'example-included-model' };
  const grant = { campaigns: ['sample-campaign'], models: [provider.model], roles: ['implementer', 'verification'],
    includedOnly: { attestedBy: 'owner', paidOverages: false, recordedAt: '2026-01-01' }, nativeModels: { [provider.model]: 'Example included' },
    verificationCommand: ['npm', 'ci', '&&', 'npm', 'run', 'check'], allowedRoot: process.cwd() };
  const config = { codeBroker: { enabled: true, repositories: { 'example-org/sampleapp': grant } } };
  const policy = (c = config, d = declaration, p = provider, role = 'implementer', cmd = command) => codeBrokerPolicy(c, d, p, role, cmd);
  assert.ok(policy());
  assert.equal(policy({}), null);
  assert.equal(policy(config, { ...declaration, campaignId: 'different' }), null);
  assert.equal(policy(config, { ...declaration, target: { repository: 'example-org/other' } }), null);
  assert.equal(policy(config, declaration, { ...provider, model: 'auto' }), null);
  assert.equal(policy(config, declaration, provider, 'release'), null);
  assert.equal(policy(config, declaration, { ...provider, researchOnly: true }), null);
  assert.equal(policy(config, declaration, provider, 'implementer', ['cursor']), null);
  for (const paid of [true, undefined]) {
    grant.includedOnly.paidOverages = paid;
    assert.equal(policy(), null);
  }
  assert.notEqual(roleUnavailableReason(provider, 'implementer', 'commit', 'win32'), null);
  assert.equal(roleUnavailableReason({ ...provider, brokeredCode: true }, 'implementer', 'commit', 'win32'), null);
});

test('code context uses complete pinned blobs and refuses uncommitted or escaping source', (t) => {
  const env = environment(); t.after(() => env.cleanup());
  const revision = exec(['git'], ['rev-parse', 'HEAD'], {cwd:env.repo}).stdout;
  const args = { git: ['git'], workspace: env.repo, revision, baseSha: null,
    task: { references: ['AGENTS.md', 'missing.mjs'] }, policy: { allowedRoot: env.tmp } };
  const snapshot = codeSnapshot(args);
  assert.equal(snapshot.value.files[0].content, '# Test repository rules\n');
  assert.equal(snapshot.value.files[1].missing, true, 'absence is pinned evidence, not an untracked file read');
  writeFileSync(join(env.repo, 'AGENTS.md'), 'uncommitted text');
  assert.throws(() => codeSnapshot(args));
  for (const path of ['../outside', '.git/config', '.local/data.json', '.github/WORKFLOWS/x.yml', 'CON.txt', 'src/file. ', 'x:stream']) assert.equal(safeCodePath(path), false);
});

test('controller applies only an audited bound proposal and cannot accept a verifier without its full check', { skip: skipWithoutSqlite || process.platform !== 'win32' }, async (t) => {
  const env = environment(), d = declaration({ tasks: [{ ...declaration().tasks[0], writes: ['note.txt'] }] });
  d.executor = { kind: 'cursor-cli', model: 'example-included-model', implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
  const packageRoot = join(env.tmp, 'package'); mkdirSync(packageRoot);
  for (const name of ['node', 'index.js']) writeFileSync(join(packageRoot, name), 'synthetic, never executed');
  const credentialFile = join(env.tmp, 'public-fixture.txt'); writeFileSync(credentialFile, 'not a credential');
  const configPath = join(env.tmp, 'transport.json');
  writeFileSync(configPath, JSON.stringify({ version: 1, distribution: 'ExampleLinux', allowedRoot: env.tmp,
    packageRoot, credentialFile, allowedModels: [d.executor.model] }));
  env.config.commands.cursor = [process.execPath, fileURLToPath(new URL('../../src/supervisor/adapters/cursor-wsl.mjs', import.meta.url)), '--config', configPath];
  env.config.codeBroker = { enabled: true, repositories: { [d.target.repository]: { campaigns: [d.campaignId], models: [d.executor.model],
    roles: ['implementer', 'verification'], includedOnly: { attestedBy: 'owner', paidOverages: false, recordedAt: '2026-01-01' },
    nativeModels: { [d.executor.model]: 'Example Included' }, allowedRoot: env.tmp, verificationCommand: ['npm', 'run', 'check'] } } };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  campaignStart(store, d);
  const ctl = new Controller({ store, config: env.config, dataDir: env.dataDir });
  ctl.launch = async () => {}; // Durable dispatch only; no real provider process.
  t.after(() => { ctl.release(); store.close(); env.cleanup(); });
  await ctl.tick();
  const op = store.openOperations(d.campaignId)[0]; assert.ok(op, 'eligible broker records a code operation');
  const config = JSON.parse(readFileSync(join(op.run_dir, 'spec.json')));
  const snapshot = JSON.parse(readFileSync(join(op.run_dir, 'code-broker.json'))).snapshot;
  const result = { result: 'resolved', summary: 'Proposed a synthetic note', report: JSON.stringify({ snapshotDigest: snapshot.digest,
    edits: [{ path: 'note.txt', before: '', after: 'synthetic artifact\n' }], report: 'Added the synthetic note. Full verification remains required.' }) };
  const output = (run, value) => [
    { type: 'system', subtype: 'init', session_id: 'native-session', apiKeySource: 'login', model: 'Example Included' },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'native-session',
      result: JSON.stringify({ runId: run.session_id, packetDigest: run.packet_digest, result: value }) },
  ].map(JSON.stringify).join('\n');
  writeFileSync(join(op.run_dir, 'stdout.json'), output(op, result));
  const ctx = { id: d.campaignId, generation: op.lease_generation };
  ctl.consume(ctx, op, { exitCode: 0, containment: 'windows-job-v1', containmentStopped: true,
    externalContainmentStopped: true, externalNonce: config.externalContainment.nonce });
  assert.equal(store.task(d.campaignId, 'T1').state, 'implemented');
  assert.equal(readFileSync(join(op.workspace, 'note.txt'), 'utf8').trim(), 'synthetic artifact');
  await ctl.tick();
  const verify = store.openOperations(d.campaignId)[0]; assert.equal(verify.kind, 'verify');
  const verifySpec = JSON.parse(readFileSync(join(verify.run_dir, 'spec.json')));
  assert.ok(verifySpec.argv.some((a) => a.endsWith('code-check-worker.mjs')));
  writeFileSync(join(verify.run_dir, 'stdout.json'), output(verify, { verdict: 'accepted', targetSha: verify.target_sha,
    reportDigest: verify.report_digest, summary: 'Synthetic review', findings: [], checks: [{ command: 'full check', result: 'pass' }],
    criteria: [{ criterion: 1, result: 'pass', check: 'synthetic', evidence: 'synthetic' }] }));
  ctl.consume({ id: d.campaignId, generation: verify.lease_generation }, verify, { exitCode: 0, containment: 'windows-job-v1', containmentStopped: true,
    externalContainmentStopped: true, externalNonce: verifySpec.externalContainment.nonce });
  assert.notEqual(store.task(d.campaignId, 'T1').state, 'verified');
  assert.equal(store.task(d.campaignId, 'T1').verified_sha, null);
});
