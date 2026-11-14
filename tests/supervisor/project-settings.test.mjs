import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { protectedAreasFor, saveSettings } from '../../src/supervisor/project-settings.mjs';
import { declaration, environment } from './helpers.mjs';

const PROJECT = 'example-org/sampleapp';
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const task = (id, issue, extra = {}) => ({ id, issue, title: `task ${id}`, deliverable: 'commit', goal: `Produce ${id}.`,
  dependsOn: [], acceptance: [`${id} exists`], references: ['AGENTS.md'], ...extra });
let requests = 0;
const settings = (store, version, value, now = Date.now()) =>
  saveSettings(store, { project: PROJECT, expectedVersion: version, requestId: `request-${++requests}`, settings: value }, now);

function rig(t) {
  const env = environment();
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  controller.launch = async () => {};
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  return { env, store, controller };
}

test('protected areas refuse new and re-authorized plans and hold every commit; removing one never loosens registered work', async (t) => {
  const { store, controller } = rig(t);
  settings(store, 0, { protectedAreas: ['docs/legal'] }, Date.now() - 1000);
  const inside = declaration({ campaignId: 'inside', tasks: [task('T1', 930, { writes: ['Docs/Legal/terms.md'] })] });
  assert.throws(() => campaignStart(store, inside), (error) => error.code === 'PROTECTED_AREA');
  assert.equal(store.campaign('inside'), null, 'nothing registered');

  const d = declaration({ campaignId: 'whole', tasks: [task('T1', 931)] });
  campaignStart(store, d);
  const registered = store.campaign('whole');
  // A stale or new approval that reaches into the area is refused; resuming the same declaration is not a new authorization.
  const widened = { ...declaration({ campaignId: 'whole', version: 2, tasks: [task('T1', 931, { writes: ['docs/legal/'] })] }) };
  assert.throws(() => campaignStart(store, widened), (error) => error.code === 'PROTECTED_AREA');
  campaignStart(store, d);
  // Saving settings never rewrites the campaign's authority; removing the area keeps it binding for this campaign.
  settings(store, 1, { protectedAreas: [] });
  const after = store.campaign('whole');
  assert.deepEqual([after.authorization_version, after.scope_digest, after.declaration], [registered.authorization_version, registered.scope_digest, registered.declaration]);
  assert.deepEqual(protectedAreasFor(store, after), ['docs/legal']);

  await controller.tick();
  const op = store.openOperations('whole')[0];
  for (const file of ['src/ok.txt', 'docs/legal/terms.md']) { mkdirSync(join(op.workspace, file, '..'), { recursive: true }); writeFileSync(join(op.workspace, file), `${file}\n`); }
  git(op.workspace, 'add', '-A'); git(op.workspace, 'commit', '-qm', 'work');
  controller.applyOutcome({ id: 'whole', generation: controller.held.get('whole') }, op, { class: 'result', receipt: { sessionId: op.session_id },
    value: { result: 'resolved', summary: 'done', headSha: git(op.workspace, 'rev-parse', 'HEAD'), report: '# r' } });
  const held = store.task('whole', 'T1');
  assert.equal(held.blocked?.class, 'B3', 'a commit inside a protected area is held for the owner');
  assert.match(held.blocked.reason, /protected areas \(docs\/legal\): docs\/legal\/terms\.md$/);
});

/** One finished or open worker run of a campaign, with its reported cost (null: not reported). */
test('settings carry no authority, and a stale, repeated or edited save changes nothing', (t) => {
  const { store } = rig(t);
  for (const [value, code] of [[{ release: { mode: 'auto' } }, 'SETTINGS_FIELD'], [{ writes: ['src/'] }, 'SETTINGS_FIELD'],
    [{ protectedAreas: ['../outside'] }, 'SETTINGS_PROTECTED']]) {
    assert.throws(() => settings(store, 0, value), (error) => error.code === code, code);
  }
  const first = saveSettings(store, { project: PROJECT, expectedVersion: 0, requestId: 'same-request', settings: { notes: 'Prefer small steps.' } }, 1);
  const again = saveSettings(store, { project: PROJECT, expectedVersion: 0, requestId: 'same-request', settings: { notes: 'Prefer small steps.' } }, 2);
  assert.deepEqual([first.version, again.version, again.duplicate], [1, 1, true]);
  assert.throws(() => saveSettings(store, { project: PROJECT, expectedVersion: 1, requestId: 'same-request', settings: { notes: 'Other.' } }, 3),
    (error) => error.code === 'SETTINGS_REQUEST_REUSED');
  assert.throws(() => settings(store, 0, { notes: 'From a stale page.' }), (error) => error.code === 'SETTINGS_CHANGED');
  assert.throws(() => store.run("UPDATE project_settings SET settings = '{}'"), /append-only/);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM project_settings').n, 1);
});
