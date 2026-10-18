// Slice PROG2 of docs/PROJECT_WORKSPACE_PLAN.md section 6.8d: the next wave proposed from the plan by fixed rules.
// Pure functions over a synthetic plan fixture and the real plan text; no store, git, network, model or GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { coversSlice, parsePlan, proposeWave } from '../../src/supervisor/program-plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const FIXTURE = readFileSync(join(HERE, 'fixtures', 'program-plan.md'), 'utf8');

const record = (change = (value) => value) => change({
  schema: 'aiworks-program/1',
  programId: 'sample-program',
  repository: 'example-org/sampleapp',
  baseBranch: 'main',
  plan: 'docs/PLAN.md',
  allow: ['AAA', 'BBB'],
  exclude: ['BBB3'],
  executor: {
    kind: 'cli-chain',
    providers: [{ kind: 'claude-cli', model: 'opus', permissionMode: 'auto' }, { kind: 'codex-cli' }],
    implementerTimeoutMinutes: 60,
    verifierTimeoutMinutes: 30,
  },
  constraints: ['Synthetic test constraint: no network, no production.', 'Change only the files your task names.'],
  authorization: {
    version: 2, grantedBy: 'owner', grantedAt: '2026-10-17',
    reference: 'https://github.com/example-org/sampleapp/issues/7', text: 'Synthetic program approval.',
  },
});
const target = { tenantId: 'example-org', projectId: 'sampleapp', environment: 'research', trackingIssue: 7 };
const facts = [
  { taskId: 'AAA4', state: 'done', onMain: true },
  { taskId: 'AAA5', state: 'running', onMain: false },
];
const propose = (overrides = {}) => proposeWave({ planText: FIXTURE, record: record(), facts, wave: 3, target, ...overrides });
const codes = (result) => Object.fromEntries(result.notReady.map(({ id, reasons }) => [id, reasons.map((reason) => reason.code)]));

test('a slice that is not ready is never proposed, and each one says why', () => {
  const result = propose();
  assert.deepEqual(result.ready, ['AAA1', 'AAA6', 'BBB1']);
  assert.deepEqual(codes(result), {
    AAA2: ['dependency-unfinished'],
    AAA3: ['earlier-writer-unfinished'],
    AAA4: ['done'],
    AAA5: ['running'],
    BBB2: ['runbook-only', 'earlier-writer-unfinished'],
    BBB3: ['excluded'],
    CCC1: ['not-allowed'],
  });
  for (const { reasons } of result.notReady) for (const { detail } of reasons) assert.ok(detail.length > 0);

  // A finished dependency counts only once its verified commit is on main.
  const pending = propose({ facts: [...facts, { taskId: 'AAA1', state: 'done', onMain: false }, { taskId: 'BBB1', state: 'done', onMain: false }] });
  assert.deepEqual(codes(pending).AAA2, ['dependency-unfinished']);
  assert.deepEqual(codes(pending).AAA3, ['earlier-writer-unfinished']);
  const merged = propose({ facts: [...facts, { taskId: 'AAA1', state: 'done', onMain: true }, { taskId: 'BBB1', state: 'done', onMain: true }] });
  assert.deepEqual(merged.ready, ['AAA2', 'AAA3', 'AAA6']);
});

test('a writer no wave will build does not hold a slice, but a dependency no wave will build still does (#228)', () => {
  // The runbook-only BBB2 now writes SUPERVISOR.md before AAA6, and AAA2 depends on the excluded BBB3.
  const planText = FIXTURE
    .replace('| `docs/SUPERVISOR.md` | AAA6, BBB2 (switch on last) |', '| `docs/SUPERVISOR.md` | BBB2 (switch on first), AAA6 |')
    .replace('| AAA1 | The next test passes |', '| BBB3 | The next test passes |');
  const result = propose({ planText });
  assert.deepEqual(result.ready, ['AAA1', 'AAA6', 'BBB1']);
  const held = result.notReady.find(({ id }) => id === 'AAA2');
  assert.deepEqual(held.reasons.map((reason) => reason.code), ['dependency-unfinished']);
  assert.match(held.reasons[0].detail, /\bBBB3\b/);
});

test('the wave is one valid version 1 declaration with the record unchanged, and the same inputs give the same digest', () => {
  const result = propose();
  const { declaration } = result;
  assert.doesNotThrow(() => validateDeclaration(structuredClone(declaration)));
  assert.equal(declaration.version, 1);
  assert.equal(declaration.campaignId, 'sample-program-w3');
  assert.deepEqual(declaration.executor, record().executor);
  assert.deepEqual(declaration.constraints, record().constraints);
  assert.deepEqual(declaration.authorization, record().authorization);
  assert.deepEqual(declaration.target, { ...target, repository: 'example-org/sampleapp', baseBranch: 'main' });
  assert.deepEqual(declaration.tasks.map((task) => task.id), ['AAA1', 'AAA6', 'BBB1']);
  const after = declaration.tasks.find((task) => task.id === 'AAA6');
  assert.deepEqual(after.writes, ['src/supervisor/after.mjs', 'docs/SUPERVISOR.md']);
  assert.deepEqual(after.acceptance, ['The after test passes; the runbook section exists']);
  assert.deepEqual(after.references, ['docs/PLAN.md#63-lane-aaa---the-first-lane']);
  for (const task of declaration.tasks) {
    assert.equal(task.requiresMergedDependencies, true);
    assert.deepEqual(task.dependsOn, []);
    assert.equal(task.issue, target.trackingIssue);
  }

  const again = propose();
  assert.equal(again.digest, result.digest);
  assert.deepEqual(again.declaration, declaration);
  assert.notEqual(propose({ wave: 4 }).digest, result.digest);
});

test('the real plan parses without error and every slice it would propose makes a valid declaration', () => {
  const planText = readFileSync(join(ROOT, 'docs', 'PROJECT_WORKSPACE_PLAN.md'), 'utf8');
  const plan = parsePlan(planText);
  assert.ok(plan.slices.length > 0 && plan.turnOrder.length > 0 && plan.sharedFiles.length > 0);
  const short = Object.keys(plan.abbreviations).filter((key) => key.endsWith('/'));
  for (const slice of plan.slices) for (const file of slice.files) assert.ok(!short.some((key) => file.startsWith(key)), `${slice.id} ${file}`);
  const lanes = [...new Set(plan.slices.map((slice) => slice.id.replace(/\d.*$/, '')))];
  const result = proposeWave({ planText, record: record((value) => ({ ...value, allow: lanes, exclude: [] })), facts: [], wave: 1, target });
  assert.ok(result.ready.length > 0);
  assert.doesNotThrow(() => validateDeclaration(structuredClone(result.declaration)));
});

test('a slice ID in the record covers that slice alone; only a lane name covers the slices of its lane', () => {
  assert.equal(coversSlice('UI1', 'UI1'), true);
  for (const [entry, id] of [['UI1', 'UI10'], ['UI1', 'UI18'], ['REL1', 'REL11'], ['STA1', 'STA10'], ['SELF1', 'SELF13'], ['REL5', 'REL5a']]) {
    assert.equal(coversSlice(entry, id), false, `${entry} must not cover ${id}`);
  }
  for (const [entry, id] of [['UI', 'UI10'], ['REL', 'REL5a'], ['PROG', 'PROG2']]) assert.equal(coversSlice(entry, id), true, `${entry} covers ${id}`);
  assert.equal(coversSlice('UI', 'UIX1'), false);

  // On the real plan: allowing REL1 proposes nothing but REL1, and excluding REL1 leaves REL10 and REL11 to the lane.
  const planText = readFileSync(join(ROOT, 'docs', 'PROJECT_WORKSPACE_PLAN.md'), 'utf8');
  const ids = parsePlan(planText).slices.map((slice) => slice.id);
  assert.ok(['REL1', 'REL10', 'REL11'].every((id) => ids.includes(id)));
  const only = proposeWave({ planText, record: record((value) => ({ ...value, allow: ['REL1'], exclude: [] })), facts: [], wave: 1, target });
  assert.ok(only.ready.every((id) => id === 'REL1'), only.ready.join(', '));
  for (const { id, reasons } of only.notReady) {
    if (id !== 'REL1') assert.ok(reasons.some((reason) => reason.code === 'not-allowed'), `${id} must not be allowed`);
  }
  const lane = proposeWave({ planText, record: record((value) => ({ ...value, allow: ['REL'], exclude: ['REL1'] })), facts: [], wave: 1, target });
  const excluded = lane.notReady.filter(({ reasons }) => reasons.some((reason) => reason.code === 'excluded')).map(({ id }) => id);
  assert.deepEqual(excluded, ['REL1']);
});

test('the module reads nothing itself: it imports only the pure declaration and reading modules', () => {
  const source = readFileSync(join(ROOT, 'src', 'supervisor', 'program-plan.mjs'), 'utf8');
  const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'|^\s*import\s+'([^']+)'|\bimport\(\s*'([^']+)'/gm)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
  assert.deepEqual(imports.sort(), ['./campaign.mjs', './reading.mjs']);
  assert.doesNotMatch(source, /\bprocess\.|\brequire\(|\bimport\(/);
});
