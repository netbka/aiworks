// Read-only report over operation receipts and verification outcomes.
import { addOperation, emptyUsage, hasReportedUsage, mergeUsage, planningUsage, runIdentity } from './token-usage.mjs';
import { runNotCounted } from './adapters/executors.mjs';
import { indicators } from './router.mjs';
import { specOf } from './plan.mjs';

/**
 * A task's risk and complexity by the rules of MODEL_ROUTING section 3 (router.mjs indicators), from its spec: declared,
 * or an admitted child's. A step whose spec is no longer readable has an unknown class, never a guessed one.
 */
export function taskClass(task, { sensitivePaths = [] } = {}) {
  if (!task) return { risk: 'unknown', complexity: 'unknown' };
  const { risk, complexity } = indicators({ sensitivePaths, task: { deliverable: task.deliverable, web: Boolean(task.web), role: task.role ?? null,
    references: task.references?.length ?? 0, acceptance: task.acceptance?.length ?? 0, dependsOn: task.dependsOn?.length ?? 0,
    requiresMergedDependencies: task.requiresMergedDependencies === true, writes: task.writes ?? null,
    declared: { risk: task.routing?.risk ?? null, complexity: task.routing?.complexity ?? null } } });
  return { risk, complexity };
}

const MODEL_UNKNOWN = 'unknown';

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const CANNOT_MEASURE = [
  'Unreported token categories, models, tiers and effort remain unknown.',
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
  const taskDecl = (campaignId, taskId) => specOf(store, campaignId, taskId, campaigns.get(campaignId));

  const operations = store.all('SELECT * FROM operations WHERE created_at >= ? ORDER BY created_at, seq', from).map((op) => {
    const kind = op.executor_kind ?? 'claude-cli';
    const recorded = op.routing?.decision?.indicators;
    const recordedClass = recorded?.risk && recorded?.complexity ? { risk: recorded.risk, complexity: recorded.complexity } : null;
    const identity = runIdentity(op);
    const { model, tier, effort } = identity;
    const task = taskDecl(op.campaign_id, op.task_id);
    const cls = recordedClass ?? taskClass(task, { sensitivePaths: campaigns.get(op.campaign_id)?.routing?.sensitivePaths ?? [] });
    const outcome = op.outcome ?? null;
    const value = outcome?.class === 'result' ? outcome.value ?? null : null;
    // The head an implement run produced; a report deliverable is bound to its base, as the controller does.
    const produced = op.kind === 'implement' && value?.result === 'resolved' ? task?.deliverable === 'commit' ? value.headSha ?? null : op.base_sha : null;
    return { op, kind, tier, effort, model: model ?? MODEL_UNKNOWN, modelKnown: model !== null, modelRecorded: model !== null, classRecorded: Boolean(recordedClass),
      task, ...cls, outcome, value, produced };
  });
  const counted = operations.filter((item) => item.op.state === 'finished' && !(item.outcome?.refunded || runNotCounted(item.outcome)));
  const refunded = operations.filter((item) => item.op.state === 'finished' && (item.outcome?.refunded || runNotCounted(item.outcome)));

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
    const key = [item.op.kind, item.risk, item.complexity, item.kind, item.model, item.tier, item.effort].join('\0');
    const group = groups.get(key) ?? { stage: item.op.kind, risk: item.risk, complexity: item.complexity, executor: item.kind,
      model: item.model, tier: item.tier, effort: item.effort, modelKnown: item.modelKnown, modelRecordedRuns: 0, classRecordedRuns: 0, runs: 0, accepted: 0, rejected: 0, unusable: 0, unreviewed: 0,
      failuresByClass: {}, runMs: [], usage: emptyUsage() };
    groups.set(key, group);
    group.runs += 1;
    group.modelRecordedRuns += item.modelRecorded ? 1 : 0;
    group.classRecordedRuns += item.classRecorded ? 1 : 0;
    group[quality(item)] += 1;
    const failure = item.outcome?.class !== 'result' ? item.outcome?.class ?? 'unknown'
      : item.op.kind === 'implement' && item.value?.result !== 'resolved' ? item.value?.result ?? 'unknown' : null;
    if (failure) group.failuresByClass[failure] = (group.failuresByClass[failure] ?? 0) + 1;
    group.runMs.push(item.op.updated_at - item.op.created_at);
    addOperation(group.usage, item.op);
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
    const usage = emptyUsage();
    for (const item of items) addOperation(usage, item.op);
    const outcome = {
      campaignId: accept.op.campaign_id, taskId: accept.op.task_id, risk: accept.risk, complexity: accept.complexity,
      implementer: producer?.kind ?? null, model: producer?.model ?? null, verifiedSha: accept.op.target_sha,
      implementAttempts: implement.length, verifyRuns: items.filter((item) => item.op.kind === 'verify').length,
      firstPass: implement[0] === producer, repairRounds: taskRows.get(key)?.repair_rounds ?? null,
      msToVerified: accept.op.updated_at - items[0].op.created_at, usage,
    };
    acceptedTasks.push(outcome);
    const groupKey = [outcome.risk, outcome.complexity, outcome.implementer, outcome.model].join('\0');
    const group = outcomeGroups.get(groupKey) ?? { risk: outcome.risk, complexity: outcome.complexity, implementer: outcome.implementer,
      model: outcome.model, accepted: 0, firstPass: 0, implementAttempts: 0, verifyRuns: 0, repairRounds: 0, msToVerified: [], usage: emptyUsage() };
    outcomeGroups.set(groupKey, group);
    group.accepted += 1;
    group.firstPass += outcome.firstPass ? 1 : 0;
    group.implementAttempts += outcome.implementAttempts;
    group.verifyRuns += outcome.verifyRuns;
    group.repairRounds += outcome.repairRounds ?? 0;
    group.msToVerified.push(outcome.msToVerified);
    for (const item of items) addOperation(group.usage, item.op);
  }

  const totals = emptyUsage();
  for (const item of counted) addOperation(totals, item.op);
  const refundedUsage = emptyUsage();
  for (const item of refunded) if (hasReportedUsage(item.op)) addOperation(refundedUsage, item.op);
  mergeUsage(totals, refundedUsage);

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

  const coordinator = planningUsage(store, { since: from });

  const reading = readingReport(store, { from, campaigns, operations, acceptedTasks });

  return {
    report: 'aiworks-baseline/3',
    generatedAt: new Date(now).toISOString(),
    window: { since: since === null ? null : new Date(since).toISOString(), until: new Date(now).toISOString() },
    store: store.identity,
    units: 'provider-reported tokens; null means unreported; coverage gives the number of runs reporting each counter',
    operations: { counted: counted.length, refunded: refunded.length, open: operations.filter((item) => item.op.state !== 'finished' && item.op.state !== 'abandoned').length,
      abandoned: operations.filter((item) => item.op.state === 'abandoned').length },
    classes: [...groups.values()].map(({ runMs, ...group }) => ({ ...group, medianRunMs: median(runMs) })),
    acceptedOutcomes: [...outcomeGroups.values()].map(({ msToVerified, ...group }) => ({ ...group, medianMsToVerified: median(msToVerified) })),
    tasks: acceptedTasks,
    totals,
    refunded: { runs: refunded.length, usage: refundedUsage },
    waits,
    coordinator,
    reading,
    cannotMeasure: CANNOT_MEASURE,
  };
}

// ---- Scoped reading (docs/design/SCOPED_READING.md section 8, slice READ3). Additive in aiworks-baseline/3. ----

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

/** One cohort's accepted outcomes: reported tokens and repair rounds per accepted outcome. */
function cohort(campaignIds, outcomes) {
  const finished = outcomes.filter((outcome) => campaignIds.has(outcome.campaignId));
  const usage = emptyUsage();
  let repairRounds = 0, repairKnown = 0;
  for (const outcome of finished) {
    mergeUsage(usage, outcome.usage);
    if (Number.isFinite(outcome.repairRounds)) { repairRounds += outcome.repairRounds; repairKnown += 1; }
  }
  return { campaigns: campaignIds.size, finishedTasks: finished.length, usage,
    tokensPerAcceptedOutcome: finished.length && !usage.unknownRuns && !usage.partialRuns && usage.total !== null ? usage.total / finished.length : null,
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

const tokenText = (usage) => `${usage.total ?? 'unknown'} (${usage.unknownRuns + usage.partialRuns} incomplete)`;

/** The short table printed before the JSON report. */
export function formatBaseline(report) {
  const rows = [['stage', 'risk', 'size', 'executor', 'model', 'tier', 'effort', 'runs', 'accepted', 'rejected', 'unusable', 'reported tokens']];
  for (const group of report.classes) {
    rows.push([group.stage, group.risk, group.complexity, group.executor, group.model, group.tier ?? 'unknown', group.effort ?? 'unknown', group.runs, group.accepted, group.rejected, group.unusable, tokenText(group.usage)]);
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
  const lines = rows.map((row) => row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ').trimEnd());
  const accepted = report.acceptedOutcomes.reduce((sum, group) => sum + group.accepted, 0);
  return [
    `Baseline ${report.window.since ?? 'all time'} to ${report.window.until} (store ${report.store?.path})`,
    ...lines,
    `${accepted} accepted outcomes; ${report.operations.counted} runs counted, ${report.refunded.runs} refunded runs excluded.`,
    `Reported tokens: workers ${tokenText(report.totals)}, coordinator ${tokenText(report.coordinator)}.`,
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
      `  ${name}: ${item.campaigns} campaigns, reported tokens per accepted outcome ${perOutcome(item.tokensPerAcceptedOutcome, 1)}, repair rounds per task ${perOutcome(item.repairRoundsPerTask, 2)}`),
  ];
}
