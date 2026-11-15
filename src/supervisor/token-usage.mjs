// Provider counters are evidence from one operation. Cached input and reasoning can be subsets of other counters.
import { containsKnownSecretValue } from '../shared/credential-metadata.mjs';

const fields = ['input', 'output', 'cacheRead', 'cacheCreation', 'reasoning', 'total'];
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const modelLabel = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9 ._:/()\[\]-]{0,99}$/i.test(value) && !containsKnownSecretValue(value) ? value : null;
const concreteModel = (value) => /^(?:auto|default|inherit|cli-default)$/i.test(value) ? null : modelLabel(value);
const tierOf = (value) => [1, 2, 3].includes(value) ? value : null;

export function normalizedUsage(raw, executor) {
  if (!raw || typeof raw !== 'object') return null;
  const input = count(raw.input ?? raw.input_tokens ?? raw.inputTokens);
  const output = count(raw.output ?? raw.output_tokens ?? raw.outputTokens);
  const cacheRead = count(raw.cacheRead ?? raw.cached_input_tokens ?? raw.cachedInputTokens ?? raw.cache_read_input_tokens ?? raw.cacheReadInputTokens ?? raw.cache_read_tokens);
  const cacheCreation = count(raw.cacheCreation ?? raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens);
  const reasoning = count(raw.reasoning ?? raw.reasoning_output_tokens ?? raw.reasoningOutputTokens ?? raw.reasoningTokens ?? raw.reasoning_tokens ?? raw.output_tokens_details?.reasoning_tokens ?? raw.thinking_tokens);
  let total = count(raw.total ?? raw.total_tokens ?? raw.totalTokens);
  if (total === null && input !== null && output !== null) {
    if (executor === 'codex-cli' || raw.inputIncludesCacheRead === true) total = count(input + output);
    else if (executor === 'claude-cli' && cacheRead !== null && cacheCreation !== null) total = count(input + cacheRead + cacheCreation + output);
  }
  const usage = { input, output, cacheRead, cacheCreation, reasoning, total };
  return fields.some((field) => usage[field] !== null) ? usage : null;
}

export function providerTokens(out, executor) {
  const usage = normalizedUsage(out?.usage, executor);
  const breakdown = out?.modelUsage;
  const models = Object.entries(breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown) ? breakdown : {}).map(([name, counters]) => {
    const effort = modelLabel(counters?.effort ?? counters?.reasoning_effort ?? counters?.reasoningEffort);
    return { model: concreteModel(name), usage: normalizedUsage(counters, executor), ...(effort ? { effort } : {}) };
  });
  const model = concreteModel(out?.model);
  const effort = modelLabel(out?.reasoning_effort ?? out?.reasoningEffort ?? out?.effort);
  return { usage, ...(models.length ? { models } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

// Read the final launch arguments. A configured preference or a task's risk is not evidence of effective effort.
export function launchMetadata(argv, executor) {
  let model = null, effort = null;
  for (let i = 0; i < (argv?.length ?? 0); i++) {
    const arg = argv[i];
    if (arg === '--model' || arg === '-m') model = modelLabel(argv[++i]);
    else if (arg.startsWith('--model=')) model = modelLabel(arg.slice(8));
    else if (executor === 'claude-cli' && arg === '--effort') effort = modelLabel(argv[++i]);
    else if (executor === 'claude-cli' && arg.startsWith('--effort=')) effort = modelLabel(arg.slice(9));
    else if (executor === 'codex-cli' && /^(?:-c|--config)$/.test(arg)) {
      const match = /^model_reasoning_effort=["']?([\w-]+)["']?$/.exec(argv[++i] ?? '');
      if (match) effort = modelLabel(match[1]);
    }
  }
  return { executor, model, effort };
}

export function runIdentity(op) {
  const receipt = op.outcome?.receipt;
  const executor = modelLabel(op.executor_kind ?? receipt?.executorKind);
  const chosen = op.routing?.decision?.chosen;
  const route = chosen?.kind === executor ? chosen : null;
  const launch = op.routing?.launch?.executor === executor ? op.routing.launch : null;
  const model = concreteModel(receipt?.model) ?? (receipt?.models?.length === 1 ? concreteModel(receipt.models[0].model) : null)
    ?? concreteModel(launch?.model) ?? concreteModel(route?.model);
  return { executor, model, tier: tierOf(route?.tier), effort: modelLabel(receipt?.effort) ?? modelLabel(launch?.effort), role: modelLabel(op.kind) };
}

const nullCounts = () => Object.fromEntries(fields.map((field) => [field, null]));
const emptyCounts = () => ({ runs: 0, reportedRuns: 0, unknownRuns: 0, partialRuns: 0, total: null });
export const emptyUsage = () => ({ ...emptyCounts(), completeTotal: null, models: [] });

function addFields(target, source) {
  for (const field of fields) if (source?.[field] != null) target[field] = (target[field] ?? 0) + source[field];
}

function groupFor(summary, identity) {
  let group = summary.models.find((item) => Object.keys(identity).every((key) => item[key] === identity[key]));
  if (!group) {
    group = { ...identity, ...emptyCounts(), ...nullCounts(), coverage: Object.fromEntries(fields.map((key) => [key, 0])) };
    summary.models.push(group);
  }
  return group;
}

function addCounts(target, source) {
  for (const field of ['runs', 'reportedRuns', 'unknownRuns', 'partialRuns']) target[field] += source[field];
}

function record(target, reported, total) {
  target.runs++;
  if (!reported) target.unknownRuns++;
  else {
    target.reportedRuns++;
    if (total === null) target.partialRuns++;
  }
}

export function addOperation(summary, op) {
  const id = runIdentity(op);
  const receipt = op.outcome?.receipt;
  const aggregate = normalizedUsage(receipt?.usage, id.executor);
  const split = receipt?.models;
  const parts = split?.length ? split : [{ model: id.model, usage: aggregate }];
  let sum = null, complete = true, reported = false;
  for (const part of parts) {
    const model = concreteModel(part.model);
    const ownSettings = !split?.length || split.length === 1 || model !== null && model === id.model;
    const group = groupFor(summary, { ...id, model, tier: ownSettings ? id.tier : null, effort: modelLabel(part.effort) ?? (ownSettings ? id.effort : null) });
    const usage = normalizedUsage(part.usage, id.executor);
    const partial = new Set(part.partialFields ?? []);
    record(group, Boolean(usage), partial.has('total') ? null : usage?.total ?? null);
    addFields(group, usage);
    for (const field of fields) if (usage?.[field] != null && !partial.has(field)) group.coverage[field]++;
    if (usage) reported = true;
    if (usage?.total == null || partial.has('total')) complete = false;
    if (usage?.total != null) sum = (sum ?? 0) + usage.total;
  }
  // Never add the aggregate and the rows to each other. A complete per-model breakdown takes precedence (AW-021): a
  // provider's top-level usage can omit side models the breakdown reports. Otherwise the provider-wide total is used.
  const fromModels = Boolean(split?.length) && complete;
  const total = fromModels ? sum : aggregate?.total ?? sum;
  const completeTotal = fromModels ? sum : aggregate?.total ?? (complete ? total : null);
  record(summary, Boolean(aggregate) || reported, completeTotal);
  if (completeTotal !== null) summary.completeTotal = (summary.completeTotal ?? 0) + completeTotal;
  if (total !== null) summary.total = (summary.total ?? 0) + total;
  return summary;
}

export function mergeUsage(target, source) {
  if (!source) return target;
  addCounts(target, source);
  if (source.completeTotal != null) target.completeTotal = (target.completeTotal ?? 0) + source.completeTotal;
  if (source.total !== null) target.total = (target.total ?? 0) + source.total;
  for (const row of source.models) {
    const { executor, model, tier, effort, role } = row;
    const group = groupFor(target, { executor, model, tier, effort, role });
    addCounts(group, row);
    addFields(group, row);
    for (const field of fields) group.coverage[field] += row.coverage[field];
  }
  return target;
}

export function operationUsage(op) {
  return addOperation(emptyUsage(), op);
}

export function hasReportedUsage(op) {
  const receipt = op.outcome?.receipt;
  return Boolean(normalizedUsage(receipt?.usage, op.executor_kind) || receipt?.models?.some((part) => normalizedUsage(part.usage, op.executor_kind)));
}

export function planningUsage(store, { since = 0, byProject } = {}) {
  const summary = emptyUsage();
  let openRuns = 0;
  for (const row of store.all('SELECT id, state, outcome FROM coordinator_runs WHERE created_at >= ?', since)) {
    const receipt = row.outcome?.receipt;
    if (row.state === 'recorded' || row.state === 'dispatched') { openRuns++; continue; }
    if (row.outcome?.notStarted) continue;
    const op = { kind: row.id.startsWith('intake.') ? 'planning' : 'coordinator', executor_kind: receipt?.executorKind, outcome: row.outcome };
    addOperation(summary, op);
    if (byProject && receipt?.project) {
      const project = byProject.get(receipt.project) ?? emptyUsage();
      byProject.set(receipt.project, addOperation(project, op));
    }
  }
  return { ...summary, openRuns };
}
