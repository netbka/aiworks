import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../../src/supervisor/store.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { decisionId } from '../../src/supervisor/decisions.mjs';
import { decisionInstructions, pendingInstructions, attachInstructions } from '../../src/supervisor/instructions.mjs';
import { declaration, environment } from './helpers.mjs';
import { exec, safeEnvironmentExamples } from '../../src/supervisor/adapters/git.mjs';
import { domainOf, outsideWrites } from '../../src/supervisor/work-ownership.mjs';
import { safeEnvironmentExample } from '../../src/supervisor/environment-example.mjs';

test('an applied owner answer survives consumption and restart for both roles, but never crosses task or authority', (t) => {
  const env = environment();
  let store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const decl = declaration(); campaignStart(store, decl, 1000);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir });
  const lease = store.acquireLease(decl.campaignId, controller.instanceId, 1000, 60_000);
  const ctx = { id: decl.campaignId, generation: lease.generation };
  const blocked = { class: 'B3', reason: 'owner-reserved: palette', at: 1000 };
  const task = store.task(ctx.id, 'T1');
  store.patch('tasks', { campaign_id: ctx.id, task_id: 'T1' }, task.version, { blocked }, 1000);
  const campaign = store.campaign(ctx.id);
  controller.answerDecision(ctx, { taskId: 'T1', decision: decisionId(ctx.id, 'T1', blocked),
    authorizationVersion: campaign.authorization_version, scopeDigest: campaign.scope_digest, text: 'Use blue.' }, 1001);
  const first = pendingInstructions(store, campaign, 'T1', 'implement');
  assert.equal(first.length, 1);
  attachInstructions(store, first, 'synthetic.implement.1', 1002);
  store.close(); store = new Store(join(env.dataDir, 'supervisor.db'));
  assert.equal(pendingInstructions(store, campaign, 'T1', 'implement').length, 0);
  assert.equal(decisionInstructions(store, campaign, 'T1').length, 1);
  assert.equal(decisionInstructions(store, campaign, 'T1')[0].payload.text, first[0].payload.text);
  assert.equal(decisionInstructions(store, campaign, 'T2').length, 0);
  assert.equal(decisionInstructions(store, { ...campaign, authorization_version: 2 }, 'T1').length, 0);
  assert.equal(decisionInstructions(store, { ...campaign, scope_digest: 'different' }, 'T1').length, 0);
  assert.equal(store.campaign(ctx.id).runs_used, 0);
});

test('an expired pre-launch adapter hold recovers without a paid run; auth and task boundary holds remain', (t) => {
  const env = environment(); const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  let now = 1000;
  const decl = declaration(); campaignStart(store, decl, now);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, now: () => now });
  const lease = store.acquireLease(decl.campaignId, controller.instanceId, now, 3_600_000);
  const ctx = { id: decl.campaignId, generation: lease.generation };
  controller.recordUnavailable(ctx, 'claude-cli', 'Managed Claude policy is present or unknown; scoped research adapter review required');
  controller.raiseBlocker(ctx, decl, { kind: 'executors', class: 'B2', reason: 'unavailable' }, now);
  const task = store.task(ctx.id, 'T2');
  store.patch('tasks', { campaign_id: ctx.id, task_id: 'T2' }, task.version,
    { blocked: { class: 'B3', reason: 'boundary violation', at: now } }, now);
  controller.recoverExecutorAvailability(ctx);
  assert.equal(store.campaign(ctx.id).blocker.kind, 'executors');
  now += 16 * 60_000;
  ctx.generation = store.acquireLease(decl.campaignId, controller.instanceId, now, 3_600_000).generation;
  controller.recoverExecutorAvailability(ctx);
  assert.equal(store.campaign(ctx.id).blocker, null);
  assert.equal(store.task(ctx.id, 'T2').blocked.reason, 'boundary violation');
  assert.equal(store.campaign(ctx.id).runs_used, 0);
  assert.equal(store.openOperations(ctx.id).length, 0);
  controller.recordUnavailable(ctx, 'claude-cli', 'Managed Claude policy is present or unknown; scoped research adapter review required');
  store.run('UPDATE executor_waits SET retry_at = NULL WHERE campaign_id = ?', ctx.id);
  controller.raiseBlocker(ctx, decl, { kind: 'executors', class: 'B2', reason: 'legacy adapter hold' }, now);
  controller.recoverExecutorAvailability(ctx);
  assert.equal(store.campaign(ctx.id).blocker, null, 'a pre-upgrade untimed adapter hold is also recovered');
  controller.raiseBlocker(ctx, decl, { kind: 'auth', class: 'B2', reason: 'login required' }, now);
  controller.recoverExecutorAvailability(ctx);
  assert.equal(store.campaign(ctx.id).blocker.kind, 'auth');
});

test('a browser adapter hold recovers only after its task browser capability is restored', (t) => {
  const env = environment(); const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  let now = 1000;
  const decl = declaration({ tasks: [{ ...declaration().tasks[0], deliverable: 'report',
    web: { urls: ['https://example.invalid/'] } }] });
  decl.executor = { kind: 'agy-cli', model: 'gemini-3.1-pro-high', implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
  campaignStart(store, decl, now);
  const chrome = join(env.tmp, 'chrome.exe');
  const config = { ...env.config, commands: { ...env.config.commands, agy: [process.execPath], chrome: [chrome] } };
  const controller = new Controller({ store, config, dataDir: env.dataDir, now: () => now });
  const lease = store.acquireLease(decl.campaignId, controller.instanceId, now, 3_600_000);
  const ctx = { id: decl.campaignId, generation: lease.generation };
  controller.recordUnavailable(ctx, 'agy-cli', 'web acceptance: commands.chrome does not exist on this PC');
  controller.raiseBlocker(ctx, decl, { kind: 'executors', class: 'B2', reason: 'browser unavailable' }, now);
  now += 16 * 60_000;
  ctx.generation = store.acquireLease(decl.campaignId, controller.instanceId, now, 3_600_000).generation;
  controller.recoverExecutorAvailability(ctx);
  assert.equal(store.campaign(ctx.id).blocker.kind, 'executors');
  writeFileSync(chrome, ''); mkdirSync(join(env.tmp, '155.0.8059.39'));
  now += 16 * 60_000;
  ctx.generation = store.acquireLease(decl.campaignId, controller.instanceId, now, 3_600_000).generation;
  controller.recoverExecutorAvailability(ctx);
  assert.equal(store.campaign(ctx.id).blocker, null);
  assert.equal(store.campaign(ctx.id).runs_used, 0);
  assert.equal(store.openOperations(ctx.id).length, 0);
});

test('only regular placeholder-only environment examples pass; secrets, symlinks and explicit denials remain forbidden', (t) => {
  const env = environment(); t.after(() => env.cleanup());
  const git = (...args) => { const out = exec(['git'], args, { cwd: env.repo }); assert.ok(out.ok, out.stderr); return out.stdout; };
  const decl = declaration(); const domain = domainOf(decl, decl.tasks[0]);
  writeFileSync(join(env.repo, '.env.example'), '# Set through the local environment\nSERVICE_TOKEN=\nURL=${SERVICE_URL}\nKEY=REPLACE_ME\n');
  git('add', '.env.example'); git('commit', '-qm', 'synthetic environment example');
  const inspect = () => safeEnvironmentExamples({ git: ['git'], path: env.repo, sha: git('rev-parse', 'HEAD'), paths: ['.env.example'] });
  const safeTemplates = inspect(); assert.deepEqual(safeTemplates, ['.env.example']);
  assert.deepEqual(outsideWrites(decl, domain, ['.env.example', '.env'], { safeTemplates }).forbidden, ['.env']);
  assert.deepEqual(outsideWrites({ ...decl, envelope: { denyWrites: ['.env.example'] } }, domain, ['.env.example'], { safeTemplates }).forbidden, ['.env.example']);
  assert.equal(safeEnvironmentExample('.ssh/.env.example', 'KEY=\n'), false);
  assert.equal(safeEnvironmentExample('.env.example', 'KEY=synthetic-concrete-value\n'), false);
  assert.equal(safeEnvironmentExample('.env.example', '# SERVICE_TOKEN=\n# KEY=REPLACE_ME\n'), true);
  for (const comment of ['# SERVICE_TOKEN=syntheticopaquecredential123456789', '# DATABASE_PASSWORD=syntheticpassword123',
    '# Authorization: Bearer syntheticopaquecredential123456789', '# See https://example.invalid/setup?token=syntheticopaquecredential123456789']) {
    assert.equal(safeEnvironmentExample('.env.example', `${comment}\nKEY=\n`), false);
  }
  const blob = git('rev-parse', 'HEAD:.env.example');
  git('update-index', '--cacheinfo', `120000,${blob},.env.example`);
  git('commit', '-qm', 'synthetic symlink mode');
  assert.deepEqual(inspect(), []);
});
