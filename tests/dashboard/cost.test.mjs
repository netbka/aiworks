// Cost (OWNER_WORKSPACE slice S7, build slice UI8): cost per project and per step, from the cost each run reported.
// Runs that reported no cost and runs still in progress are counted apart, and unknown is never $0.00. Project totals
// are exactly today's per-campaign totals. Synthetic review fixture and disposable stores only; no network, model or
// GitHub call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { costByUnit, projectCosts, stepRouting, supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { stateCopy } from '../../src/dashboard/copy.mjs';
import { buildReviewFixture } from './fixtures/review-store.mjs';
import { openPage } from './fixtures/page.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const page = () => readFileSync(join(ROOT, 'src/dashboard/public/dashboard.js'), 'utf8');
const M = 60_000;
const round = (value) => Math.round(value * 10000) / 10000;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-cost-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return buildReviewFixture(root);
}
function change(dataDir, write) {
  const store = new Store(join(dataDir, 'supervisor.db'));
  try { return write(store); } finally { store.close(); }
}
const snapshot = (dataDir) => {
  const state = supervisorSnapshot(dataDir);
  assert.equal(state.available, true);
  return state;
};
let seq = 5000;
function operation(store, dataDir, campaignId, taskId, kind, outcome, { state = 'finished', at = Date.now() - 30 * M, executor = 'codex-cli', routing = null } = {}) {
  const id = `${campaignId}.${taskId}.${kind}.${++seq}`;
  store.insert('operations', { id, campaign_id: campaignId, task_id: taskId, kind, seq, idempotency_key: id, lease_generation: 1, state,
    session_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, run_dir: join(dataDir, 'runs', id), workspace: join(dataDir, 'worktrees', id),
    packet: { synthetic: true }, packet_digest: '0'.repeat(64), outcome, created_at: at, updated_at: at, executor_kind: executor, routing });
  return id;
}
/** The page's own cost wording, taken from dashboard.js and run here with its own `usd` and `plural`. */
function pageCostText() {
  const source = page();
  const pick = (pattern) => { const found = pattern.exec(source); assert.ok(found, `dashboard.js has ${pattern}`); return found[0]; };
  return new Function(`${pick(/^const plural = .*$/m)}\n${pick(/^const usd = .*$/m)}\n${pick(/^function costText\([\s\S]*?\n}$/m)}\nreturn costText;`)();
}

test('each step’s cost is what its runs reported; runs without a cost are counted apart, never as $0.00', (t) => {
  const { dataDir } = fixture(t);
  const state = snapshot(dataDir), campaign = (id) => state.campaigns.find((c) => c.id === id);
  // shop-search: T1 reported 1.9 + 0.8; T2 reported 1.5 and one run reported nothing; T3 reported nothing in two runs.
  const search = campaign('shop-search'), step = (id) => search.tasks.find((task) => task.id === id).cost;
  assert.deepEqual(step('T1'), { runs: 2, reportedUsd: 2.7, unreportedRuns: 0, runningRuns: 0, retries: 0, checkerRejections: 0 });
  assert.deepEqual(step('T2'), { runs: 2, reportedUsd: 1.5, unreportedRuns: 1, runningRuns: 0, retries: 0, checkerRejections: 0 });
  assert.deepEqual(step('T3'), { runs: 2, reportedUsd: null, unreportedRuns: 2, runningRuns: 0, retries: 0, checkerRejections: 0 });
  // The steps add up to today's totals for the work: its recorded cost and its unreported runs.
  assert.equal(round(search.tasks.reduce((n, task) => n + (task.cost.reportedUsd ?? 0), 0)), search.recordedCostUsd);
  const units = campaign('recipes-units');
  assert.equal(round(units.tasks.reduce((n, task) => n + (task.cost.reportedUsd ?? 0), 0)), units.recordedCostUsd);
  assert.deepEqual(search.cost, { reportedUsd: 4.2, unreportedRuns: 3, runningRuns: 0 });
  // Everywhere: unreported runs per step add up to the budget's count, running runs to the workers on it, and no cost is 0.
  for (const c of state.campaigns) {
    assert.equal(c.tasks.reduce((n, task) => n + task.cost.unreportedRuns, 0), c.budget.unknownCostRuns, c.id);
    assert.equal(c.tasks.reduce((n, task) => n + task.cost.runningRuns, 0), c.agents.length, c.id);
    assert.equal(c.cost.unreportedRuns, c.budget.unknownCostRuns, c.id);
    assert.equal(c.cost.runningRuns, c.agents.length, c.id);
    for (const cost of [c.cost, ...c.tasks.map((task) => task.cost)]) assert.notEqual(cost.reportedUsd, 0, `${c.id}: unknown is null, never 0`);
  }
  // A run still in progress has no cost yet: it is running, not unreported.
  assert.deepEqual(campaign('shop-reviews').tasks[0].cost, { runs: 1, reportedUsd: 1.1, unreportedRuns: 0, runningRuns: 1, retries: 0, checkerRejections: 0 });
  // A step that never ran costs nothing known, and says so with null.
  assert.deepEqual(campaign('recipes-share').tasks[0].cost, { runs: 0, reportedUsd: null, unreportedRuns: 0, runningRuns: 0, retries: 0, checkerRejections: 0 });
});

test('a step’s retries and checker rejections are counted; a refunded run is not a run of the step', (t) => {
  const { dataDir } = fixture(t);
  change(dataDir, (store) => {
    // recipes-share T1 has never run. Now: a timed-out run, a refused run with no work, a rejected check that reported
    // a cost, then a build that reported none.
    operation(store, dataDir, 'recipes-share', 'T1', 'implement', { class: 'timeout' });
    operation(store, dataDir, 'recipes-share', 'T1', 'implement', { class: 'unavailable', refunded: true });
    operation(store, dataDir, 'recipes-share', 'T1', 'verify', { class: 'result', value: { verdict: 'rejected', findings: [] }, receipt: { costUsd: 0.75 } });
    operation(store, dataDir, 'recipes-share', 'T1', 'implement', { class: 'result', value: { result: 'implemented' }, receipt: { costUsd: null } });
    const c = store.campaign('recipes-share');
    store.patch('campaigns', { id: 'recipes-share' }, c.version, { cost_usd: 0.75, runs_used: 3 }, Date.now());
  });
  const c = snapshot(dataDir).campaigns.find((item) => item.id === 'recipes-share');
  assert.deepEqual(c.tasks[0].cost, { runs: 3, reportedUsd: 0.75, unreportedRuns: 2, runningRuns: 0, retries: 1, checkerRejections: 1 });
  assert.equal(c.budget.unknownCostRuns, 2, 'the same unreported runs as the budget');
  assert.deepEqual(c.cost, { reportedUsd: 0.75, unreportedRuns: 2, runningRuns: 0 });
});

test('a project’s cost is exactly the sum of its work’s totals today, with unreported and running runs apart', (t) => {
  const { dataDir } = fixture(t);
  const state = snapshot(dataDir);
  const repositories = [...new Set(state.campaigns.map((c) => c.repository))];
  assert.deepEqual(state.costs.map((item) => item.repository).sort(), repositories.sort());
  for (const project of state.costs) {
    const mine = state.campaigns.filter((c) => c.repository === project.repository);
    const reported = round(mine.reduce((n, c) => n + c.recordedCostUsd, 0));
    assert.deepEqual(project, { repository: project.repository, works: mine.length, worksWithRuns: mine.filter((c) => c.runsUsed > 0).length, runs: mine.reduce((n, c) => n + c.runsUsed, 0),
      reportedUsd: reported > 0 ? reported : null, unreportedRuns: mine.reduce((n, c) => n + c.budget.unknownCostRuns, 0),
      runningRuns: mine.reduce((n, c) => n + c.agents.length, 0), empty: null });
  }
  // One project per repository whatever its case, and nothing reported is null, never 0. A project where nothing has
  // run carries the §7.1 copy from the state copy module.
  const costs = projectCosts([
    { repository: 'Example/App', runsUsed: 2, cost: { reportedUsd: 1.25, unreportedRuns: 1, runningRuns: 0 } },
    { repository: 'example/app', runsUsed: 1, cost: { reportedUsd: null, unreportedRuns: 1, runningRuns: 1 } },
    { repository: 'example/other', runsUsed: 3, cost: { reportedUsd: null, unreportedRuns: 3, runningRuns: 0 } },
    { repository: 'example/new', runsUsed: 0, cost: { reportedUsd: null, unreportedRuns: 0, runningRuns: 0 } },
    { repository: 'example/starting', runsUsed: 0, cost: { reportedUsd: null, unreportedRuns: 0, runningRuns: 1 } },
    // Run counts can disagree (a recount, a refund): any run that reported no cost still means something ran.
    { repository: 'example/recounted', runsUsed: 0, cost: { reportedUsd: null, unreportedRuns: 2, runningRuns: 0 } }]);
  const empty = { title: stateCopy('cost-empty').title, text: stateCopy('cost-empty').text };
  assert.deepEqual(empty, { title: 'No cost yet.', text: 'Nothing has run for this project.' });
  assert.deepEqual(costs, [
    { repository: 'Example/App', works: 2, worksWithRuns: 2, runs: 3, reportedUsd: 1.25, unreportedRuns: 2, runningRuns: 1, empty: null },
    { repository: 'example/other', works: 1, worksWithRuns: 1, runs: 3, reportedUsd: null, unreportedRuns: 3, runningRuns: 0, empty: null },
    { repository: 'example/new', works: 1, worksWithRuns: 0, runs: 0, reportedUsd: null, unreportedRuns: 0, runningRuns: 0, empty },
    { repository: 'example/starting', works: 1, worksWithRuns: 0, runs: 0, reportedUsd: null, unreportedRuns: 0, runningRuns: 1, empty: null },
    { repository: 'example/recounted', works: 1, worksWithRuns: 0, runs: 0, reportedUsd: null, unreportedRuns: 2, runningRuns: 0, empty: null }]);
  // Without a readable store there is no cost, not a zero cost.
  const root = mkdtempSync(join(tmpdir(), 'aiworks-cost-none-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(supervisorSnapshot(root).costs, []);
});

test('the Cost screen never shows unknown as $0.00 and counts unreported runs apart', () => {
  const costText = pageCostText();
  assert.equal(costText({ runs: 2, reportedUsd: 2.7, unreportedRuns: 0, runningRuns: 0 }), '$2.70 reported');
  assert.equal(costText({ runs: 2, reportedUsd: 1.5, unreportedRuns: 1, runningRuns: 0 }), '$1.50 reported + 1 run not reported');
  assert.equal(costText({ runs: 2, reportedUsd: null, unreportedRuns: 2, runningRuns: 0 }), 'not reported (2 runs)');
  assert.equal(costText({ runs: 1, reportedUsd: 1.1, unreportedRuns: 0, runningRuns: 1 }), '$1.10 reported · 1 run still running');
  assert.equal(costText({ runs: 0, reportedUsd: null, unreportedRuns: 0, runningRuns: 1 }), '1 run still running');
  assert.equal(costText({ runs: 0, reportedUsd: null, unreportedRuns: 0, runningRuns: 0 }), 'Nothing has run');
  assert.equal(costText({ runs: 0, reportedUsd: null, unreportedRuns: 5, runningRuns: 0 }), 'not reported (5 runs)', 'unreported runs are never "nothing"');
  for (const runs of [0, 1, 3]) for (const unreportedRuns of [0, 1, 2]) for (const runningRuns of [0, 2]) {
    assert.doesNotMatch(costText({ runs, reportedUsd: null, unreportedRuns, runningRuns }), /\$0\.00|\$/, 'unknown is never a dollar amount');
  }
  const source = page();
  // The Cost tab is this screen; its headline is the project's reported total, the unreported runs and the empty copy.
  assert.match(source, /route\.tab === 'cost'\) return costScreen\(project, all\)/);
  assert.match(source, /reported for this project/);
  assert.match(source, /did not report a cost, so the real total is \$\{total\.reportedUsd !== null \? 'higher' : 'not known'\}/);
  assert.match(source, /No cost reported for this project yet/);
  // With nothing run, the screen shows the module's §7.1 copy the server sent; the page never writes it itself.
  assert.match(source, /if \(total\.empty\) return \[empty\(total\.empty\.title, total\.empty\.text\)\]/);
  assert.ok(!source.includes('No cost yet.') && !source.includes('Nothing has run for this project.'));
  // The breakdown names every column of the design, and the dollar total only appears for a reported cost.
  assert.match(source, /'See the breakdown'/);
  assert.match(source, /\['Step', 'Runs', 'Cost', 'Retries', 'Checker rejections'\]/);
  assert.match(source, /total\.reportedUsd !== null \? `\$\{usd\(total\.reportedUsd\)\} reported for this project/);
  // The page imports nothing new: the cost copy comes with the data.
  assert.deepEqual([...source.matchAll(/^import \{[^}]+\} from '(\/[^']+)';$/gm)].map((m) => m[1]), ['/router.mjs', '/copy.mjs']);
  // The headline replaces today's "Cost so far" card on this tab: one cost view (plan §6.12 C8).
  assert.doesNotMatch(source, /'Cost so far'/);
});

test('a step’s run count beside its cost includes the runs still running, so the two agree (aiworks#11 review 4 F18)', async (t) => {
  const page = await openPage(t);
  await page.go('#/p/example%2Fshop-app/cost');
  const state = supervisorSnapshot(page.dataDir);
  const rows = [...page.document.body.walk()].filter((node) => node.tagName === 'TR' && /^cost\/[^/]+\/[^/]+$/.test(node.getAttribute('data-focus-scope') ?? ''));
  assert.ok(rows.length, 'the breakdown has its steps');
  let onlyRunning = 0;
  for (const row of rows) {
    const [, campaignId, taskId] = row.getAttribute('data-focus-scope').split('/');
    const cost = state.campaigns.find((c) => c.id === campaignId).tasks.find((task) => task.id === taskId).cost;
    const [, runs, costCell] = row.childNodes.filter((node) => node.tagName === 'TD').map((node) => node.textContent);
    // Runs is every run of the step: the finished ones and those still running.
    assert.equal(runs, String(cost.runs + cost.runningRuns), `${campaignId}/${taskId}`);
    const still = /(\d+) runs? still running/.exec(costCell);
    if (still) assert.ok(Number(runs) >= Number(still[1]), `${campaignId}/${taskId}: never fewer runs than "${still[0]}"`);
    // The case the review saw on "Checkout form": its one run is still running, and none has finished.
    if (!cost.runs && cost.runningRuns) {
      onlyRunning++;
      assert.equal(runs, String(cost.runningRuns), `${campaignId}/${taskId}`);
      assert.match(costCell, new RegExp(`^${cost.runningRuns} runs? still running`));
    }
  }
  assert.ok(onlyRunning > 0, 'the fixture has a step whose only run is still running');
});

// ---- UI12 (MODEL_ROUTING slice R6, dashboard half): model, tier, cost by unit and why a step moved up, from status (MOD6). ----

const MARKER = 'SECRET-WORKER-TEXT';
const receipt = (kind, model, tier, priorAttempts = [], escalated = false) => ({ version: 1, policy: 'routing-policy/1', mode: 'auto',
  inputs: { escalation: { priorAttempts } }, decision: { chosen: { kind, model, tier }, escalation: { tier, escalated }, reason: `chosen: ${MARKER}` } });
/** The page's own model and unit wording, taken from dashboard.js and run here with its own helpers. */
function pageUnitText() {
  const source = page();
  const pick = (pattern) => { const found = pattern.exec(source); assert.ok(found, `dashboard.js has ${pattern}`); return found[0]; };
  return new Function([/^const provider = .*$/m, /^const plural = .*$/m, /^const usd = .*$/m, /^const tokenCount = .*$/m, /^const modelText = .*$/m,
    /^function modelsText\([\s\S]*?\n}$/m, /^function unitCostText\([\s\S]*?\n}$/m, /^const movedUpText = .*$/m].map(pick).join('\n')
    + '\nreturn { modelsText, unitCostText, movedUpText };')();
}

test('each step shows its models, tiers, why it moved up and its cost by unit; units are never added together', (t) => {
  const { dataDir } = fixture(t);
  change(dataDir, (store) => {
    // recipes-share T1 has never run. Now: a cheap build reporting dollars and Claude tokens, a check reporting Codex tokens
    // and no dollars, then a build that moved up after a timeout and a rejection and reported $0 (unknown, not free).
    const result = (receiptValue, value = { result: 'resolved', summary: MARKER }) => ({ class: 'result', value, detail: MARKER, receipt: receiptValue });
    const first = operation(store, dataDir, 'recipes-share', 'T1', 'implement', result({ costUsd: 0.5, usage: { input: 1200, output: 10, cacheRead: 0, cacheCreation: 0 } }),
      { executor: 'claude-cli', routing: receipt('claude-cli', 'haiku', 1) });
    operation(store, dataDir, 'recipes-share', 'T1', 'verify', result({ costUsd: null, usage: { input: 2000, output: 20, cacheRead: 500, inputIncludesCacheRead: true } },
      { verdict: 'rejected', summary: MARKER }), { routing: receipt('codex-cli', 'gpt-6-astra', 3) });
    const timeout = operation(store, dataDir, 'recipes-share', 'T1', 'implement', { class: 'timeout', detail: MARKER }, { executor: 'claude-cli', routing: receipt('claude-cli', 'haiku', 1) });
    operation(store, dataDir, 'recipes-share', 'T1', 'implement', result({ costUsd: 0, usage: null }), { executor: 'claude-cli', routing: receipt('claude-cli', 'sonnet', 2, [
      { op: timeout, kind: 'claude-cli', model: 'haiku', class: 'timeout', terminal: null, denied: false, tier: 1 },
      { op: first, kind: 'claude-cli', model: 'haiku', class: 'result', terminal: 'rejected', denied: false, tier: 1 }], true) });
    const c = store.campaign('recipes-share');
    store.patch('campaigns', { id: 'recipes-share' }, c.version, { cost_usd: 0.5, runs_used: 4 }, Date.now());
  });
  const state = snapshot(dataDir);
  const c = state.campaigns.find((item) => item.id === 'recipes-share'), [step] = c.tasks;
  assert.deepEqual(step.routing, {
    implement: { executor: 'claude-cli', model: 'sonnet', tier: 'standard' },
    verify: { executor: 'codex-cli', model: 'gpt-6-astra', tier: 'strongest' },
    movedUp: { stage: 'implement', tier: 'standard', reason: 'Moved to the standard model after one timed-out attempt and one rejected attempt' } });
  // Dollars stay dollars, tokens stay per provider, and three runs without reported dollars are counted, not $0.00.
  assert.deepEqual(step.costByUnit, { usd: 0.5, usdRuns: 1, unknownRuns: 3, tokens: [
    { executor: 'claude-cli', runs: 1, input: 1200, output: 10, cacheRead: 0, cacheCreation: 0, cachedInInput: false },
    { executor: 'codex-cli', runs: 1, input: 2000, output: 20, cacheRead: 500, cacheCreation: 0, cachedInInput: true }] });
  assert.deepEqual(c.costByUnit, step.costByUnit, 'one step: the work program is that step');
  // The same unknown count as the budget and UI8's unreported runs, and the same dollars as the recorded cost.
  assert.equal(c.costByUnit.unknownRuns, c.budget.unknownCostRuns);
  assert.equal(c.costByUnit.unknownRuns, c.cost.unreportedRuns);
  assert.equal(c.costByUnit.usd, c.recordedCostUsd);
  // No worker, error or router text reaches the page.
  assert.ok(!JSON.stringify(state).includes(MARKER), 'no worker text in a reason or anywhere in the state');
  // Every other step and work program: no receipt means no model, and an unknown dollar cost is null, never 0.
  for (const work of state.campaigns) {
    assert.equal(work.costByUnit.unknownRuns, work.budget.unknownCostRuns, work.id);
    for (const cost of [work.costByUnit, ...work.tasks.map((task) => task.costByUnit)]) {
      assert.notEqual(cost.usd, 0, `${work.id}: unknown dollars are null, never 0`);
      if (cost.usd === null) assert.equal(cost.usdRuns, 0);
    }
    if (work.id === 'recipes-share') continue;
    for (const task of work.tasks) {
      for (const used of [task.routing.implement, task.routing.verify]) if (used) assert.equal(used.model, null, `${work.id}/${task.id}: no receipt, no model`);
      assert.equal(task.routing.movedUp, null);
    }
  }
});

test('only safe model names, known tiers and the status’s own reason sentences reach the page', () => {
  const routing = stepRouting({ routing: {
    implement: { executor: 'claude-cli', model: `<img src=x onerror=alert(1)> ${MARKER}`, tier: 2, tierName: 'standard' },
    verify: { executor: 'not a kind!', model: 'gpt-6.1-astra', tier: 9, tierName: 'ultimate' },
    escalation: { stage: 'verify', toTierName: 'strongest', reason: `Moved to the strongest model after ${MARKER}` } } });
  assert.deepEqual(routing, {
    implement: { executor: 'claude-cli', model: null, tier: 'standard' },
    verify: { executor: null, model: 'gpt-6.1-astra', tier: null },
    movedUp: { stage: 'verify', tier: 'strongest', reason: 'Moved to the strongest model after poor-quality results' } });
  for (const reason of ['Moved to the standard model after two rejected attempts', 'Moved to the strongest model after two unusable reviews',
    'Moved to the standard model after one timed-out attempt and one rejected attempt', 'Moved to the tier 4 model after poor-quality results']) {
    assert.equal(stepRouting({ routing: { escalation: { stage: 'implement', toTierName: 'standard', reason } } }).movedUp.reason, reason);
  }
  assert.deepEqual(stepRouting({}), { implement: null, verify: null, movedUp: null }, 'a step that never ran has no model');
  // A reported $0 is unknown, not free; a provider kind of any other shape is dropped; counts are whole numbers.
  assert.deepEqual(costByUnit({ usd: { reported: 0, reportedRuns: 1 }, tokens: { 'bad kind': { runs: 1, input: 5 }, 'agy-cli': { runs: 2, input: 7, output: -1, inputIncludesCacheReadRuns: 1 } }, unknownCostRuns: 2 }),
    { usd: null, usdRuns: 0, unknownRuns: 2, tokens: [{ executor: 'agy-cli', runs: 2, input: 7, output: 0, cacheRead: 0, cacheCreation: 0, cachedInInput: false }] });
  assert.deepEqual(costByUnit(undefined), { usd: null, usdRuns: 0, tokens: [], unknownRuns: 0 });
});

test('Work and Cost say the model, tier, move up and cost by unit; never a sum across units, never $0.00 for unknown', () => {
  const { modelsText, unitCostText, movedUpText } = pageUnitText();
  assert.equal(modelsText({ implement: { executor: 'claude-cli', model: 'sonnet', tier: 'standard' }, verify: { executor: 'codex-cli', model: 'gpt-6-astra', tier: 'strongest' } }),
    'Model: Claude sonnet (standard) · checked by Codex gpt-6-astra (strongest)');
  assert.equal(modelsText({ implement: { executor: 'cursor-cli', model: null, tier: null }, verify: null }), 'Model: Cursor Agent (model not recorded)');
  assert.equal(modelsText({ implement: null, verify: null, movedUp: null }), null);
  assert.equal(movedUpText({ movedUp: { reason: 'Moved to the strongest model after two rejected attempts' } }), 'Moved to the strongest model after two rejected attempts');
  assert.equal(movedUpText({ movedUp: null }), null);
  const both = { usd: 0.5, usdRuns: 1, unknownRuns: 2, tokens: [
    { executor: 'claude-cli', runs: 1, input: 1200, output: 10, cacheRead: 300, cacheCreation: 40, cachedInInput: false },
    { executor: 'codex-cli', runs: 1, input: 2000, output: 20, cacheRead: 500, cacheCreation: 0, cachedInInput: true }] };
  assert.equal(unitCostText(both), '$0.50 reported (1 run) · Claude: 1,200 input + 300 read from cache + 40 written to cache and 10 output tokens'
    + ' · Codex: 2,000 input (500 of them cached) and 20 output tokens · 2 runs with unknown cost');
  // Never one total: no sum of the two providers' tokens, nor of tokens and dollars.
  assert.doesNotMatch(unitCostText(both), /3,200|3200|1,210|2,020|\$0\.5[1-9]/);
  assert.equal(unitCostText({ usd: null, usdRuns: 0, unknownRuns: 3, tokens: [] }), '3 runs with unknown cost');
  assert.equal(unitCostText({ usd: null, usdRuns: 0, unknownRuns: 0, tokens: [] }), null, 'nothing counted yet is no line, not $0.00');
  assert.equal(unitCostText(undefined), null);
  for (const unknownRuns of [0, 1, 4]) for (const tokens of [[], both.tokens]) {
    assert.doesNotMatch(unitCostText({ usd: null, usdRuns: 0, unknownRuns, tokens }) ?? '', /\$/, 'unknown dollars are never a dollar amount');
  }
  const source = page();
  // Work: why a step moved up in its row; its models and units in Details. Cost: the same per step, and the work's units.
  assert.match(source, /movedUpText\(task\.routing\) \? el\('div', \{ class: 'subtext' \}, movedUpText\(task\.routing\)\) : null\)/);
  assert.match(source, /stepsTable\(c\), terminal \? null : providerStatus\(c\), body, modelNotes\(c\)\)/);
  assert.match(source, /\[modelsText\(task\.routing\), movedUpText\(task\.routing\)\]\.filter\(Boolean\)/);
  assert.match(source, /cell\(costText\(task\.cost\), unitCostText\(task\.costByUnit\)/);
  assert.match(source, /`By unit, never added together: \$\{unitCostText\(c\.costByUnit\)\}`/);
});
