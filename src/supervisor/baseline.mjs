// Cost and outcome baseline (docs/design/MODEL_ROUTING.md section 8, slice R1). Read-only: it only runs SELECTs on a
// store the caller opened read-only, and makes no model, network or GitHub call. Costs stay in the unit each provider
// reports: dollars, tokens, or unknown. Unknown is counted as unknown, never as zero, and units are never added together.

// The design's risk table also has R2 (catalog role, sensitive paths, routing.risk) and narrows commit tasks with `writes`.
// None of those declaration fields exist yet (slices R3 and S3), so today every commit task and every web task is R1.
export function taskClass(task) {
  const risk = task?.deliverable === 'commit' || task?.web ? 'R1' : 'R0';
  const references = task?.references?.length ?? 0;
  const points = (task?.deliverable === 'commit' ? 1 : 0) + (references > 5 ? 1 : 0) + (references > 12 ? 1 : 0)
    + ((task?.acceptance?.length ?? 0) > 4 ? 1 : 0) + ((task?.dependsOn?.length ?? 0) >= 2 ? 1 : 0) + (task?.requiresMergedDependencies ? 1 : 0);
  return { risk, complexity: points >= 4 ? 'C3' : points >= 2 ? 'C2' : 'C1' };
}

/** The model an operation ran with, from the executor declared when it was recorded. The model is not stored on the
 * operation (slice R2 adds that), so it is inferred; a provider without a declared model ran its CLI default (unknown). */
function modelOf(executor, kind) {
  const providers = executor?.kind === 'cli-chain' ? executor.providers ?? [] : [executor];
  const provider = providers.find((item) => item?.kind === kind);
  return provider?.model ?? null;
}

const MODEL_UNKNOWN = 'cli-default (unknown)';

function emptyCost() {
  return { usd: { reported: null, reportedRuns: 0, unknownRuns: 0 }, tokens: {} };
}

/** Adds one run's receipt to a cost record: dollars only when reported, tokens per provider, never mixed. */
function addCost(cost, kind, receipt) {
  if (Number.isFinite(receipt?.costUsd)) {
    cost.usd.reported = (cost.usd.reported ?? 0) + receipt.costUsd;
    cost.usd.reportedRuns += 1;
  } else cost.usd.unknownRuns += 1;
  const usage = receipt?.usage;
  if (!usage) return;
  const tokens = cost.tokens[kind] ??= { runs: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, inputIncludesCacheReadRuns: 0 };
  tokens.runs += 1;
  for (const key of ['input', 'output', 'cacheRead', 'cacheCreation']) if (Number.isFinite(usage[key])) tokens[key] += usage[key];
  if (usage.inputIncludesCacheRead) tokens.inputIncludesCacheReadRuns += 1;
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const CANNOT_MEASURE = [
  'Dollars for codex-cli, cursor-cli and agy-cli: they report none, so their cost and any total that includes them is unknown.',
  'Any cursor-cli usage: it reports nothing.',
  'What the owner actually pays: dollars are as reported by the CLI, never "spent".',
  'The model of an operation with certainty: it is inferred from the declaration and executor-amended entries.',
  'Defects found after acceptance and defects a verifier missed: they are in GitHub, not in the store.',
  'Exact provider wait duration: the journal records only when a wait starts.',
];

/**
 * Builds the section 8.2 report. `store` should be opened read-only; the caller holds a read transaction for a
 * consistent snapshot. `since` (ms) limits operations, journal entries and coordinator runs to that time and later.
 */
export function baselineReport(store, { since = null, now = Date.now() } = {}) {
  const from = since ?? 0;
  const campaigns = new Map(store.all('SELECT id, declaration FROM campaigns').map((row) => [row.id, row.declaration]));
  const amendments = new Map();
  for (const entry of store.all("SELECT campaign_id, at, detail FROM journal WHERE kind = 'executor-amended' ORDER BY seq")) {
    if (!amendments.has(entry.campaign_id)) amendments.set(entry.campaign_id, []);
    amendments.get(entry.campaign_id).push(entry);
  }
  // The executor in force when an operation was recorded: the `from` of the first later amendment, else today's.
  const executorAt = (campaignId, at) => amendments.get(campaignId)?.find((entry) => entry.at > at)?.detail?.from
    ?? campaigns.get(campaignId)?.executor;
  const taskDecl = (campaignId, taskId) => campaigns.get(campaignId)?.tasks?.find((task) => task.id === taskId);

  const operations = store.all('SELECT * FROM operations WHERE created_at >= ? ORDER BY created_at, seq', from).map((op) => {
    const kind = op.executor_kind ?? 'claude-cli';
    const model = modelOf(executorAt(op.campaign_id, op.created_at), kind);
    const task = taskDecl(op.campaign_id, op.task_id);
    const outcome = op.outcome ?? null;
    const value = outcome?.class === 'result' ? outcome.value ?? null : null;
    // The head an implement run produced; a report deliverable is bound to its base, as the controller does.
    const produced = op.kind === 'implement' && value?.result === 'resolved' ? task?.deliverable === 'commit' ? value.headSha ?? null : op.base_sha : null;
    return { op, kind, model: model ?? MODEL_UNKNOWN, modelKnown: model !== null, task, ...taskClass(task), outcome, value, produced };
  });
  const counted = operations.filter((item) => item.op.state === 'finished' && !item.outcome?.refunded);
  const refunded = operations.filter((item) => item.outcome?.refunded);

  // A verify run names the head it checked in target_sha; that links it to the implement run that produced the head.
  const verdicts = new Map();
  for (const item of counted) {
    if (item.op.kind !== 'verify' || !item.value?.verdict || !item.op.target_sha) continue;
    const key = `${item.op.campaign_id}\0${item.op.task_id}\0${item.op.target_sha}`;
    if (item.value.verdict === 'accepted' || !verdicts.has(key)) verdicts.set(key, item.value.verdict);
  }
  const quality = (item) => {
    if (item.op.kind === 'verify') return ['accepted', 'rejected'].includes(item.value?.verdict) ? item.value.verdict : 'unusable';
    if (!item.produced) return 'unusable';
    return verdicts.get(`${item.op.campaign_id}\0${item.op.task_id}\0${item.produced}`) ?? 'unreviewed';
  };

  const groups = new Map();
  for (const item of counted) {
    const key = [item.op.kind, item.risk, item.complexity, item.kind, item.model].join('\0');
    const group = groups.get(key) ?? { stage: item.op.kind, risk: item.risk, complexity: item.complexity, executor: item.kind,
      model: item.model, modelKnown: item.modelKnown, runs: 0, accepted: 0, rejected: 0, unusable: 0, unreviewed: 0,
      failuresByClass: {}, runMs: [], ...emptyCost() };
    groups.set(key, group);
    group.runs += 1;
    group[quality(item)] += 1;
    const failure = item.outcome?.class !== 'result' ? item.outcome?.class ?? 'unknown'
      : item.op.kind === 'implement' && item.value?.result !== 'resolved' ? item.value?.result ?? 'unknown' : null;
    if (failure) group.failuresByClass[failure] = (group.failuresByClass[failure] ?? 0) + 1;
    group.runMs.push(item.op.updated_at - item.op.created_at);
    addCost(group, item.kind, item.outcome?.receipt);
  }

  // Accepted outcomes: a task whose head a verifier accepted. Attributed to the class and to the run that produced the head.
  const byTask = new Map();
  for (const item of counted) {
    const key = `${item.op.campaign_id}\0${item.op.task_id}`;
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key).push(item);
  }
  const taskRows = new Map(store.all('SELECT campaign_id, task_id, repair_rounds FROM tasks')
    .map((row) => [`${row.campaign_id}\0${row.task_id}`, row]));
  const outcomeGroups = new Map();
  const acceptedTasks = [];
  for (const [key, items] of byTask) {
    const accept = items.find((item) => item.op.kind === 'verify' && item.value?.verdict === 'accepted');
    if (!accept) continue;
    const implement = items.filter((item) => item.op.kind === 'implement');
    const producer = implement.findLast((item) => item.produced === accept.op.target_sha);
    const cost = emptyCost();
    for (const item of items) addCost(cost, item.kind, item.outcome?.receipt);
    const outcome = {
      campaignId: accept.op.campaign_id, taskId: accept.op.task_id, risk: accept.risk, complexity: accept.complexity,
      implementer: producer?.kind ?? null, model: producer?.model ?? null, verifiedSha: accept.op.target_sha,
      implementAttempts: implement.length, verifyRuns: items.filter((item) => item.op.kind === 'verify').length,
      firstPass: implement[0] === producer, repairRounds: taskRows.get(key)?.repair_rounds ?? null,
      msToVerified: accept.op.updated_at - items[0].op.created_at, ...cost,
    };
    acceptedTasks.push(outcome);
    const groupKey = [outcome.risk, outcome.complexity, outcome.implementer, outcome.model].join('\0');
    const group = outcomeGroups.get(groupKey) ?? { risk: outcome.risk, complexity: outcome.complexity, implementer: outcome.implementer,
      model: outcome.model, accepted: 0, firstPass: 0, implementAttempts: 0, verifyRuns: 0, repairRounds: 0, msToVerified: [], ...emptyCost() };
    outcomeGroups.set(groupKey, group);
    group.accepted += 1;
    group.firstPass += outcome.firstPass ? 1 : 0;
    group.implementAttempts += outcome.implementAttempts;
    group.verifyRuns += outcome.verifyRuns;
    group.repairRounds += outcome.repairRounds ?? 0;
    group.msToVerified.push(outcome.msToVerified);
    for (const item of items) addCost(group, item.kind, item.outcome?.receipt);
  }

  const totals = emptyCost();
  for (const item of counted) addCost(totals, item.kind, item.outcome?.receipt);
  const refundedCost = emptyCost();
  for (const item of refunded) addCost(refundedCost, item.kind, item.outcome?.receipt);

  const waits = { fallbacks: {}, unavailable: {}, refundedRuns: 0 };
  for (const entry of store.all("SELECT kind, detail FROM journal WHERE at >= ? AND kind IN ('executor-fallback', 'executor-unavailable', 'run-refunded') ORDER BY seq", from)) {
    if (entry.kind === 'executor-fallback') {
      const key = `${entry.detail?.from} -> ${entry.detail?.executor} (${entry.detail?.reason})`;
      waits.fallbacks[key] = (waits.fallbacks[key] ?? 0) + 1;
    } else if (entry.kind === 'executor-unavailable') {
      const key = entry.detail?.executor ?? 'unknown';
      waits.unavailable[key] = (waits.unavailable[key] ?? 0) + 1;
    } else waits.refundedRuns += 1;
  }

  const coordinator = { runs: 0, usd: { reported: null, reportedRuns: 0, unknownRuns: 0 } };
  for (const run of store.all('SELECT cost_usd FROM coordinator_runs WHERE created_at >= ?', from)) {
    coordinator.runs += 1;
    if (Number.isFinite(run.cost_usd)) {
      coordinator.usd.reported = (coordinator.usd.reported ?? 0) + run.cost_usd;
      coordinator.usd.reportedRuns += 1;
    } else coordinator.usd.unknownRuns += 1;
  }

  return {
    report: 'aiworks-baseline/1',
    generatedAt: new Date(now).toISOString(),
    window: { since: since === null ? null : new Date(since).toISOString(), until: new Date(now).toISOString() },
    store: store.identity,
    units: 'usd is as reported by the CLI, never spent; tokens are per provider; unknown is never zero; units are never added together',
    operations: { counted: counted.length, refunded: refunded.length, open: operations.filter((item) => item.op.state !== 'finished' && item.op.state !== 'abandoned').length,
      abandoned: operations.filter((item) => item.op.state === 'abandoned').length },
    classes: [...groups.values()].map(({ runMs, ...group }) => ({ ...group, medianRunMs: median(runMs) })),
    acceptedOutcomes: [...outcomeGroups.values()].map(({ msToVerified, ...group }) => ({ ...group, medianMsToVerified: median(msToVerified) })),
    tasks: acceptedTasks,
    totals,
    refunded: { runs: refunded.length, ...refundedCost },
    waits,
    coordinator,
    cannotMeasure: CANNOT_MEASURE,
  };
}

const usdText = (usd) => usd.reported === null ? 'unknown' : `$${usd.reported.toFixed(2)}${usd.unknownRuns ? ` + ${usd.unknownRuns} unknown` : ''}`;

/** The short table printed before the JSON report. */
export function formatBaseline(report) {
  const rows = [['stage', 'risk', 'size', 'executor', 'model', 'runs', 'accepted', 'rejected', 'unusable', 'reported usd']];
  for (const group of report.classes) {
    rows.push([group.stage, group.risk, group.complexity, group.executor, group.model, group.runs, group.accepted, group.rejected, group.unusable, usdText(group.usd)]);
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
  const lines = rows.map((row) => row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ').trimEnd());
  const accepted = report.acceptedOutcomes.reduce((sum, group) => sum + group.accepted, 0);
  return [
    `Baseline ${report.window.since ?? 'all time'} to ${report.window.until} (store ${report.store?.path})`,
    ...lines,
    `${accepted} accepted outcomes; ${report.operations.counted} runs counted, ${report.refunded.runs} refunded runs excluded.`,
    `Reported usd ${usdText(report.totals.usd)}; coordinator ${usdText(report.coordinator.usd)}. Reported, never spent.`,
  ].join('\n');
}
