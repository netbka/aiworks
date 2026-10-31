// Worker CPU monitor, after the host crash of 2026-10-31. Every worker runs in its own Windows job (runner.mjs), and
// Windows keeps the CPU time of each job: of the worker and every process it started, however deep. The monitor reads
// those times every interval and works out each worker's share of the computer and the computer's total load.
//
// Policy: every worker job starts at below-normal priority (workerJob.priority), so the owner's own programs and the
// supervisor come first. When the computer stays busy (load over `high` for one interval), the worker using the most CPU
// drops to idle priority: it keeps running, but only on time nothing else wants. When the load falls under `low`, every
// lowered worker returns to its starting priority. Nothing is stopped or killed. Docker containers run inside Docker's
// virtual machine, outside any worker job; the Docker gate (docker-gate.mjs) limits those.
//
// config.json `workerCpu`: { "enabled": true, "high": 0.85, "low": 0.6, "minShare": 0.1, "intervalMs": 30000 }.
import { execFile } from 'node:child_process';
import * as nodeOs from 'node:os';
import { POWERSHELL, windowsHelperArgs } from './proc.mjs';

export const CPU_DEFAULTS = Object.freeze({ enabled: true, high: 0.85, low: 0.6, minShare: 0.1, intervalMs: 30_000 });

/** `workerCpu` from config.json over the defaults; a value of the wrong kind keeps its default. */
export function cpuSettings(config) {
  const set = config?.workerCpu ?? {};
  const out = { ...CPU_DEFAULTS };
  if (typeof set.enabled === 'boolean') out.enabled = set.enabled;
  for (const key of ['high', 'low', 'minShare']) if (typeof set[key] === 'number' && set[key] > 0 && set[key] <= 1) out[key] = set[key];
  if (Number.isSafeInteger(set.intervalMs) && set.intervalMs >= 5_000) out.intervalMs = set.intervalMs;
  if (out.low >= out.high) out.low = CPU_DEFAULTS.low < out.high ? CPU_DEFAULTS.low : out.high / 2;
  return out;
}

const helper = (mode, jobName, extra = {}) => new Promise((done) => {
  if (!POWERSHELL) { done(null); return; }
  execFile(POWERSHELL, windowsHelperArgs(mode, jobName, extra), { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    (error, stdout) => done(error ? null : stdout.trim()));
});

/** Job CPU times from the helper: Map jobName -> { cpu (100 ns units), active }. */
async function readUsage(jobNames) {
  const out = new Map();
  if (!jobNames.length) return out;
  const text = await helper('Usage', jobNames.join(','));
  for (const line of (text ?? '').split(/\r?\n/)) {
    try { const row = JSON.parse(line); out.set(row.job, { cpu: Number(row.cpu), active: Number(row.active) }); } catch { /* not a usage line */ }
  }
  return out;
}

const hostTimes = (os) => os.cpus().reduce((acc, cpu) => {
  const t = cpu.times, total = t.user + t.nice + t.sys + t.idle + t.irq;
  return { busy: acc.busy + total - t.idle, total: acc.total + total };
}, { busy: 0, total: 0 });

/**
 * Decides one interval (pure): `shares` maps job -> its share of the whole computer, `load` is the computer's busy share,
 * `lowered` the jobs at idle now. Returns { lower: job | null, restore: [jobs] }.
 */
export function decide({ shares, load, lowered, settings }) {
  if (load < settings.low) return { lower: null, restore: [...lowered] };
  if (load <= settings.high) return { lower: null, restore: [] };
  let top = null;
  for (const [job, share] of shares) if (!lowered.has(job) && share >= settings.minShare && (!top || share > shares.get(top))) top = job;
  return { lower: top, restore: [] };
}

/**
 * The monitor. `check(jobs)` takes the open runs, [{ op, jobName }], and resolves to the actions taken; at most one check
 * runs at a time. `latest()` is the last reading: { at, load, workers: [{ op, share, active, lowered }] }.
 */
export function createCpuMonitor({ settings = CPU_DEFAULTS, basePriority = 'belownormal', os = nodeOs, usage = readUsage,
  setPriority = (jobName, priorityClass) => helper('Priority', jobName, { priorityClass }), clock = Date.now, log = () => {} } = {}) {
  let last = null; // { at, host, jobs: Map jobName -> cpu }
  let latest = null, busy = false;
  const lowered = new Set();
  async function check(jobs) {
    if (busy) return null;
    busy = true;
    try {
      const now = clock(), host = hostTimes(os);
      const readings = await usage(jobs.map((job) => job.jobName));
      for (const name of [...lowered]) if (!readings.has(name)) lowered.delete(name); // the run ended
      const previous = last;
      last = { at: now, host, jobs: new Map([...readings].map(([name, row]) => [name, row.cpu])) };
      if (!previous) return null;
      const span = host.total - previous.host.total; // milliseconds of CPU time across all cores
      if (span <= 0) return null;
      const load = (host.busy - previous.host.busy) / span;
      const shares = new Map();
      for (const [name, row] of readings) {
        const before = previous.jobs.get(name);
        if (before !== undefined) shares.set(name, Math.max(0, (row.cpu - before) / 10_000) / span); // 100 ns -> ms
      }
      const byJob = new Map(jobs.map((job) => [job.jobName, job.op]));
      latest = { at: now, load, workers: [...shares].map(([name, share]) => ({ op: byJob.get(name) ?? null, share,
        active: readings.get(name)?.active ?? 0, lowered: lowered.has(name) })) };
      const { lower, restore } = decide({ shares, load, lowered, settings });
      const actions = [];
      if (lower && await setPriority(lower, 'idle') === 'set') {
        lowered.add(lower);
        actions.push({ kind: 'worker-cpu-lowered', op: byJob.get(lower) ?? null, share: shares.get(lower), load });
      }
      for (const name of restore) {
        if (await setPriority(name, basePriority === 'normal' ? 'normal' : 'belownormal') === 'set') {
          lowered.delete(name);
          actions.push({ kind: 'worker-cpu-restored', op: byJob.get(name) ?? null, load });
        }
      }
      for (const action of actions) log(`${action.kind}: ${action.op} (computer ${Math.round(load * 100)}% busy${action.share !== undefined ? `, this worker ${Math.round(action.share * 100)}%` : ''})`);
      return actions;
    } finally { busy = false; }
  }
  return { check, latest: () => latest, settings };
}
