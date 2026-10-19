// OWNER_UI_V2 WP8: the sample project and Knowledge routes. The sample is written only into a new or empty folder that
// passed the Add project check, connects like any folder and starts nothing: no rules, plan, approval or paid run follow
// by themselves. Its README is suggested as material, and only the owner (the caller check) confirms it as a fact.
// Synthetic folders and a fictional sample only; Git runs locally, no network or model call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { checkCaller } from '../../src/supervisor/local-admission.mjs';
import { createSampleProject } from '../../src/dashboard/projects.mjs';
import { knowledgeView, saveKnowledge } from '../../src/dashboard/knowledge.mjs';
import { GOVERNANCE } from '../supervisor/helpers.mjs';

const lookupAs = (ancestors) => async () => ({ pid: 999_991, ancestors, jobs: [] });
const owner = (store) => checkCaller(store, { platform: 'win32', lookup: lookupAs([999_990]) });
const worker = (store) => checkCaller(store, { platform: 'win32', lookup: lookupAs([process.pid]) });

test('the sample project connects through the folder check and starts nothing; only the owner confirms its facts', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-sample-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ projectConnection: { enabled: true }, governanceRoot: GOVERNANCE }));
  new Store(join(dataDir, 'supervisor.db')).close();
  const read = (sql) => { const store = new Store(join(dataDir, 'supervisor.db'), { readOnly: true }); try { return store.all(sql); } finally { store.close(); } };
  const sample = (path) => createSampleProject(dataDir, { path, requestId: randomUUID() }, { gitEnv: { GIT_CEILING_DIRECTORIES: root } });

  // A folder that holds anything else is the owner's: nothing is written into it.
  const busy = join(root, 'busy');
  mkdirSync(busy);
  writeFileSync(join(busy, 'mine.txt'), 'the owner’s file');
  assert.equal(sample(busy).code, 'SAMPLE_FOLDER_NOT_EMPTY');
  assert.deepEqual(readdirSync(busy), ['mine.txt']);
  // A place AIWorks never treats as a project is refused before a file is written, and the folder it made is gone.
  const inside = join(dataDir, 'sample');
  assert.equal(sample(inside).code, 'PATH_PROTECTED');
  assert.ok(!readdirSync(dataDir).includes('sample'));

  const folder = join(root, 'sample-notes');
  const connected = sample(folder);
  assert.equal(connected.ok, true, connected.message);
  assert.equal(connected.project.id, 'sample-notes');
  assert.match(readFileSync(join(folder, 'README.md'), 'utf8'), /synthetic/);
  // Connected, nothing more: no rules, no plan, no goal and no run until the owner confirms the rules and approves a plan.
  assert.deepEqual([read('SELECT * FROM project_overlays').length, read('SELECT * FROM work_requests').length, read('SELECT * FROM campaigns').length,
    read('SELECT * FROM operations').length], [0, 0, 0, 0]);
  // Again: the same project opens, none is added.
  assert.equal(sample(folder).project.id, 'sample-notes');
  assert.equal(read('SELECT id FROM projects').length, 1);

  // Its README is found in material, at the commit of AIWorks's copy; a worker cannot confirm it, the owner can.
  const view = knowledgeView(dataDir, 'sample-notes');
  const found = view.suggestions.find((item) => item.source === 'material');
  assert.ok(found && found.origin.path === 'README.md' && /^[0-9a-f]{40}$/.test(found.origin.commit), 'README suggested with its commit');
  assert.equal(view.facts.length, 0);
  const confirm = (caller) => saveKnowledge(dataDir, { requestId: randomUUID(), project: 'sample-notes', action: 'confirm', suggestion: found.key, version: 0 }, { caller });
  await assert.rejects(confirm(worker), { status: 403, code: 'APPROVAL_FROM_AIWORKS' });
  assert.equal(knowledgeView(dataDir, 'sample-notes').facts.length, 0);
  const saved = await confirm(owner);
  assert.deepEqual([saved.view.facts[0].text, saved.view.facts[0].basis.source], [found.text, 'material']);
});
