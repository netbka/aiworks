// The routing cohort against the recorded baseline (docs/design/MODEL_ROUTING.md section 8.4, slice R7 / MOD7). Read-only:
// it reads two `baseline --json` reports the operator saved and prints, per task class, whether the sides may be compared
// at all and, where they may, the measures each side reached. It opens no store and makes no model, network or GitHub call.
//
//   node scripts/supervisor/routing-comparison.mjs --before <baseline.json> --after <after-cohort.json> --cohort <campaignId> [--cohort <id>] [--json]
//
// The baseline side is the accepted outcomes of `--before`, recorded before the cohort started; the cohort side is the
// accepted outcomes of `--after` whose campaign is a `--cohort` campaign. A class is compared only when each side has
// MIN_ACCEPTED accepted outcomes. No saving is computed or claimed: it reports what each side measured, the share of runs
// whose cost is unknown, and a quality drop, after which routing stays off for that class. Dollars are as reported,
// never spent; tokens are never added to dollars. The output names classes, never store paths or campaign contents.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIN_ACCEPTED = 10;

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const ratio = (a, b) => (b ? a / b : null);

/** One side's measures for one class, from its accepted outcomes (baseline.mjs `tasks`). */
function measures(outcomes) {
  const reportedRuns = outcomes.reduce((sum, item) => sum + (item.usd?.reportedRuns ?? 0), 0);
  const unknownRuns = outcomes.reduce((sum, item) => sum + (item.usd?.unknownRuns ?? 0), 0);
  const reported = outcomes.reduce((sum, item) => sum + (item.usd?.reported ?? 0), 0);
  const repairs = outcomes.filter((item) => Number.isFinite(item.repairRounds));
  return {
    accepted: outcomes.length,
    firstPassRate: ratio(outcomes.filter((item) => item.firstPass).length, outcomes.length),
    implementAttemptsPerAccepted: ratio(outcomes.reduce((sum, item) => sum + item.implementAttempts, 0), outcomes.length),
    verifyRunsPerAccepted: ratio(outcomes.reduce((sum, item) => sum + item.verifyRuns, 0), outcomes.length),
    repairRoundsPerAccepted: ratio(repairs.reduce((sum, item) => sum + item.repairRounds, 0), repairs.length),
    medianMsToVerified: median(outcomes.map((item) => item.msToVerified).filter(Number.isFinite)),
    // Over the runs that reported dollars only; the unknown share travels with any claim.
    reportedUsdPerReportedRun: reportedRuns ? reported / reportedRuns : null,
    unknownCostShare: ratio(unknownRuns, reportedRuns + unknownRuns),
    models: [...new Set(outcomes.map((item) => `${item.implementer ?? 'unknown'} ${item.model ?? 'unknown'}`))].sort(),
  };
}

/** The comparison of `before` and `after` (two aiworks-baseline reports) for the cohort campaigns `cohort`. */
export function compare(before, after, cohort) {
  for (const report of [before, after]) {
    if (!/^aiworks-baseline\//.test(report?.report ?? '')) throw new Error('both inputs must be `baseline --json` reports');
  }
  const ids = new Set(cohort);
  if (!ids.size) throw new Error('name at least one cohort campaign with --cohort');
  const problems = [];
  if (before.store?.id !== after.store?.id) problems.push('the two reports come from different stores');
  if ((before.tasks ?? []).some((item) => ids.has(item.campaignId))) problems.push('the baseline already holds cohort outcomes: record it before the cohort starts');
  if (Date.parse(after.window?.until) <= Date.parse(before.window?.until)) problems.push('the cohort report is not later than the baseline');
  const baseline = (before.tasks ?? []).filter((item) => !ids.has(item.campaignId));
  const routed = (after.tasks ?? []).filter((item) => ids.has(item.campaignId));
  const key = (item) => `${item.risk}/${item.complexity}`;
  const classes = [...new Set([...baseline, ...routed].map(key))].sort();
  return {
    report: 'aiworks-routing-comparison/1',
    minimumAccepted: MIN_ACCEPTED,
    valid: problems.length === 0,
    problems,
    classes: classes.map((cls) => {
      const a = measures(baseline.filter((item) => key(item) === cls));
      const b = measures(routed.filter((item) => key(item) === cls));
      const comparable = problems.length === 0 && a.accepted >= MIN_ACCEPTED && b.accepted >= MIN_ACCEPTED;
      const worse = (x, y) => x !== null && y !== null && x > y;
      const qualityDrop = comparable && (worse(a.firstPassRate, b.firstPassRate) || worse(b.repairRoundsPerAccepted, a.repairRoundsPerAccepted));
      return { class: cls, comparison: comparable ? 'comparable' : 'not comparable', qualityDrop, baseline: a, cohort: b };
    }),
  };
}

const show = (value, digits = 2) => (value === null ? 'unknown' : Number(value).toFixed(digits));

function format(result) {
  const lines = [`Routing cohort against the baseline (each side needs ${result.minimumAccepted} accepted outcomes per class; no saving is computed).`];
  for (const problem of result.problems) lines.push(`NOT VALID: ${problem}.`);
  for (const row of result.classes) {
    lines.push('', `${row.class}: ${row.comparison}${row.qualityDrop ? ' - QUALITY DROP: keep routing off for this class' : ''}`);
    for (const [name, side] of [['baseline', row.baseline], ['cohort', row.cohort]]) {
      lines.push(`  ${name.padEnd(8)} accepted ${side.accepted}, first pass ${show(side.firstPassRate)}, implement/accepted ${show(side.implementAttemptsPerAccepted)}, ` +
        `verify/accepted ${show(side.verifyRunsPerAccepted)}, repairs/accepted ${show(side.repairRoundsPerAccepted)}, median to verified ${show(side.medianMsToVerified === null ? null : side.medianMsToVerified / 60_000, 1)} min, ` +
        `reported usd/run ${show(side.reportedUsdPerReportedRun, 4)} (unknown cost ${show(side.unknownCostShare)} of runs); models: ${side.models.join(', ') || 'none'}`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
  const cohort = args.flatMap((arg, index) => (arg === '--cohort' && args[index + 1] ? [args[index + 1]] : []));
  if (!value('--before') || !value('--after')) {
    process.stderr.write('usage: routing-comparison.mjs --before <baseline.json> --after <after-cohort.json> --cohort <campaignId> [--cohort <id>] [--json]\n');
    process.exit(2);
  }
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const result = compare(read(value('--before')), read(value('--after')), cohort);
  process.stdout.write(`${args.includes('--json') ? JSON.stringify(result, null, 2) : format(result)}\n`);
  process.exit(result.valid ? 0 : 1);
}
