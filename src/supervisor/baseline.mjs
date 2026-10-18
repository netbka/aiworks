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

  const reading = readingReport(store, { from, campaigns, operations, acceptedTasks });

  return {
    report: 'aiworks-baseline/2',
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
    reading,
    cannotMeasure: CANNOT_MEASURE,
  };
}

// ---- Scoped reading (docs/design/SCOPED_READING.md section 8, slice READ3). Additive in aiworks-baseline/2. ----

export const MIN_COHORT_TASKS = 5;
const READING_KINDS = ['reference-section-resolved', 'cite-covered', 'section-miss', 'unreferenced-doc', 'reading-guide-extended'];
const RULED = /^Blocking verifier finding .* \(rule: /s;

function emptyReading() {
  return { dispatchesGuided: 0, anchors: { resolved: 0, fallback: 0 },
    blockingFindings: { withCites: 0, covered: 0, sectionMiss: 0, unreferencedDoc: 0, implementerReadAnyway: 0 },
    repairRoundsWithRule: 0, guidesExtended: 0 };
}

/** A declaration whose tasks mostly mark sections: more than half of them list at least one `path#anchor` reference. */
export function mostlyAnchored(declaration) {
  const tasks = declaration?.tasks ?? [];
  const anchored = tasks.filter((task) => (task.references ?? []).some((reference) => typeof reference === 'string' && reference.includes('#')));
  return tasks.length > 0 && anchored.length * 2 > tasks.length;
}

/** One cohort's accepted outcomes: cost in its own units, and dollars and repair rounds per accepted outcome. */
function cohort(campaignIds, outcomes) {
  const finished = outcomes.filter((outcome) => campaignIds.has(outcome.campaignId));
  const cost = emptyCost();
  let repairRounds = 0, repairKnown = 0;
  for (const outcome of finished) {
    if (outcome.usd.reported !== null) cost.usd.reported = (cost.usd.reported ?? 0) + outcome.usd.reported;
    cost.usd.reportedRuns += outcome.usd.reportedRuns;
    cost.usd.unknownRuns += outcome.usd.unknownRuns;
    for (const [kind, tokens] of Object.entries(outcome.tokens)) {
      const sum = cost.tokens[kind] ??= { runs: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, inputIncludesCacheReadRuns: 0 };
      for (const key of Object.keys(sum)) sum[key] += tokens[key] ?? 0;
    }
    if (Number.isFinite(outcome.repairRounds)) { repairRounds += outcome.repairRounds; repairKnown += 1; }
  }
  return { campaigns: campaignIds.size, finishedTasks: finished.length, ...cost,
    // Dollars per outcome only when every run reported dollars: one unknown run makes the whole figure unknown.
    usdPerAcceptedOutcome: finished.length && cost.usd.unknownRuns === 0 && cost.usd.reported !== null ? cost.usd.reported / finished.length : null,
    repairRoundsPerTask: repairKnown ? repairRounds / repairKnown : null };
}

/**
 * Per campaign and overall: guided dispatches, anchors resolved and fallen back, blocking findings by citation class,
 * repair rounds whose packet carried a cited rule and guides that sibling carry-forward extended. Null where a campaign
 * has no reading event and no ruled repair round (a store that predates them, or nothing anchored or cited). Cohorts set
 * campaigns whose tasks mostly mark sections against the rest; they are compared only when each has five finished tasks.
 */
function readingReport(store, { from, campaigns, operations, acceptedTasks }) {
  const perCampaign = new Map();
  const of = (id) => {
    if (!perCampaign.has(id)) perCampaign.set(id, emptyReading());
    return perCampaign.get(id);
  };
  const findings = new Map();
  const extended = new Set();
  const rows = store.all(`SELECT campaign_id, kind, detail FROM journal WHERE at >= ? AND kind IN (${READING_KINDS.map(() => '?').join(', ')}) ORDER BY seq`,
    from, ...READING_KINDS);
  for (const { campaign_id: id, kind, detail } of rows) {
    const item = of(id);
    if (kind === 'reference-section-resolved') {
      item.dispatchesGuided += 1;
      item.anchors.resolved += detail?.resolved ?? 0;
      item.anchors.fallback += detail?.fallback ?? 0;
    } else if (kind === 'reading-guide-extended') {
      const key = `${id}\0${detail?.op}`;
      if (!extended.has(key)) { extended.add(key); item.guidesExtended += 1; }
    } else {
      const key = `${id}\0${detail?.op}\0${detail?.finding}`;
      if (!findings.has(key)) { findings.set(key, true); item.blockingFindings.withCites += 1; }
      if (kind === 'cite-covered') item.blockingFindings.covered += 1;
      else {
        item.blockingFindings[kind === 'section-miss' ? 'sectionMiss' : 'unreferencedDoc'] += 1;
        if (detail?.implementerRead === true) item.blockingFindings.implementerReadAnyway += 1;
      }
    }
  }
  for (const { op } of operations) {
    if (op.kind === 'implement' && (op.packet?.constraints ?? []).some((text) => RULED.test(String(text)))) of(op.campaign_id).repairRoundsWithRule += 1;
  }
  const overall = perCampaign.size ? emptyReading() : null;
  for (const item of perCampaign.values()) {
    overall.dispatchesGuided += item.dispatchesGuided;
    overall.repairRoundsWithRule += item.repairRoundsWithRule;
    overall.guidesExtended += item.guidesExtended;
    for (const key of Object.keys(overall.anchors)) overall.anchors[key] += item.anchors[key];
    for (const key of Object.keys(overall.blockingFindings)) overall.blockingFindings[key] += item.blockingFindings[key];
  }
  const anchoredIds = new Set([...campaigns].filter(([, declaration]) => mostlyAnchored(declaration)).map(([id]) => id));
  const otherIds = new Set([...campaigns.keys()].filter((id) => !anchoredIds.has(id)));
  const anchored = cohort(anchoredIds, acceptedTasks), unanchored = cohort(otherIds, acceptedTasks);
  const comparable = anchored.finishedTasks >= MIN_COHORT_TASKS && unanchored.finishedTasks >= MIN_COHORT_TASKS;
  return {
    overall,
    campaigns: [...campaigns.keys()].sort().map((id) => ({ campaignId: id, anchored: anchoredIds.has(id), reading: perCampaign.get(id) ?? null })),
    cohorts: { minimumFinishedTasks: MIN_COHORT_TASKS, comparison: comparable ? 'comparable' : 'not comparable', anchored, unanchored },
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
    ...readingLines(report.reading),
  ].join('\n');
}

const perOutcome = (value, digits) => value === null ? 'unknown' : value.toFixed(digits);

/** Scoped reading: the two cohorts side by side, or why they are not compared. No saving is computed. */
function readingLines(reading) {
  if (!reading) return [];
  const { anchored, unanchored, comparison, minimumFinishedTasks } = reading.cohorts;
  const counts = `marked sections ${anchored.finishedTasks} finished tasks, whole documents ${unanchored.finishedTasks}`;
  if (comparison !== 'comparable') return [`Reading cohorts: not comparable (${counts}; each needs ${minimumFinishedTasks}).`];
  return [
    `Reading cohorts (${counts}):`,
    ...[['marked sections', anchored], ['whole documents', unanchored]].map(([name, item]) =>
      `  ${name}: ${item.campaigns} campaigns, reported usd per accepted outcome ${item.usdPerAcceptedOutcome === null ? 'unknown' : `$${perOutcome(item.usdPerAcceptedOutcome, 2)}`}, repair rounds per task ${perOutcome(item.repairRoundsPerTask, 2)}`),
  ];
}
