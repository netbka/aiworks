// Host pressure for the scheduler (docs/design/ADAPTIVE_SCHEDULER.md section 4.6, slice RUN7). One in-process sample per
// admission pass, with no model, network or child-process call: free memory, CPU busy over the last minute, free disk on
// each worktree volume and runner heartbeats that arrive late. Pressure only refuses new admission (scheduler.mjs
// hostPressure, admissionCheck); running work continues untouched. This is host safety, not an AW-002 limit: it never
// stops a campaign, counts runs or money, or notifies the owner. It only says "not now".
import * as nodeOs from 'node:os';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';

const GiB = 1024 ** 3;

/** Thresholds, each overridable in the data directory's config.json under scheduler.pressure. */
export const PRESSURE_DEFAULTS = Object.freeze({
  minFreeMemoryBytes: 2 * GiB, minFreeMemoryShare: 0.10, // free memory below max(2 GiB, 10% of total)
  maxCpuBusy: 0.90, cpuWindowMs: 60_000,                  // CPU busy above 90% over the last 60 s
  minFreeDiskBytes: 5 * GiB,                              // free disk on a worktree volume below 5 GiB
  lateHeartbeats: 3,                                      // a heartbeat older than three intervals but not yet stale
});

/** The signals, in the order they are checked. A sample under pressure names the first that applies. */
export const PRESSURE_SIGNALS = Object.freeze(['memory', 'cpu', 'disk', 'heartbeats']);

// The controller's defaults (controller.mjs DEFAULTS), for a config that does not set them.
const RUNNER_DEFAULTS = { heartbeatMs: 10_000, staleMs: 90_000 };

/** Configured thresholds over the defaults; a value that is not a positive finite number keeps its default. */
export function pressureThresholds(set = {}) {
  const limits = { ...PRESSURE_DEFAULTS };
  for (const key of Object.keys(PRESSURE_DEFAULTS)) {
    const value = set?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) limits[key] = value;
  }
  return limits;
}

const cpuTimes = (cpus) => cpus.reduce((acc, cpu) => {
  const t = cpu.times;
  const total = t.user + t.nice + t.sys + t.idle + t.irq;
  return { busy: acc.busy + total - t.idle, total: acc.total + total };
}, { busy: 0, total: 0 });

/**
 * A sampler bound to this host. `sample({ now, beats })` returns null (no pressure) or { signal, detail } for the first
 * signal that applies, in PRESSURE_SIGNALS order. `beats` are the last heartbeat times of the open runs (openRunBeats).
 * CPU is judged only over a complete window of os.cpus() time deltas (os.loadavg is always zero on Windows); a window
 * that ran much longer than cpuWindowMs (no sample while the host was idle) says nothing about the last minute, so it
 * starts again. A volume that cannot be read gives no signal. Every dependency is injectable for tests; the defaults
 * read the real host.
 */
export function createHostSampler({ os = nodeOs, fs = nodeFs, volumes = [], heartbeatMs = RUNNER_DEFAULTS.heartbeatMs,
  staleMs = RUNNER_DEFAULTS.staleMs, thresholds = {} } = {}) {
  const limits = pressureThresholds(thresholds);
  let window = null; // { at, busy, total }: CPU times at the start of the current window
  let cpuBusy = null; // the busy share over the last complete window
  return {
    limits,
    sample({ now, beats = [] }) {
      const free = os.freemem(), total = os.totalmem();
      const floor = Math.max(limits.minFreeMemoryBytes, total * limits.minFreeMemoryShare);
      if (free < floor) return { signal: 'memory', detail: { freeBytes: free, floorBytes: Math.round(floor) } };

      const times = cpuTimes(os.cpus());
      if (!window || now - window.at > 2 * limits.cpuWindowMs) { window = { at: now, ...times }; cpuBusy = null; }
      else if (now - window.at >= limits.cpuWindowMs) {
        const span = times.total - window.total;
        cpuBusy = span > 0 ? (times.busy - window.busy) / span : null;
        window = { at: now, ...times };
      }
      if (cpuBusy !== null && cpuBusy > limits.maxCpuBusy) return { signal: 'cpu', detail: { busyShare: Math.round(cpuBusy * 100) / 100 } };

      if (typeof fs.statfsSync === 'function') {
        for (const volume of volumes) {
          let freeDisk;
          try { const stat = fs.statfsSync(volume); freeDisk = Number(stat.bavail) * Number(stat.bsize); } catch { continue; }
          if (Number.isFinite(freeDisk) && freeDisk < limits.minFreeDiskBytes) return { signal: 'disk', detail: { volume, freeBytes: freeDisk } };
        }
      }

      // Late but not stale: the host is starving its runners (tests/supervisor/measure-liveness.mjs). A stale run is the
      // controller's to reconcile as lost, not pressure.
      const late = beats.filter((beat) => Number.isFinite(beat) && beat > 0
        && now - beat > limits.lateHeartbeats * heartbeatMs && now - beat < staleMs);
      if (late.length) return { signal: 'heartbeats', detail: { lateRuns: late.length } };
      return null;
    },
  };
}

/**
 * The sampler for a controller config: the worktree volume of every configured repository, the runner heartbeat and
 * stale intervals, and config.scheduler.pressure thresholds.
 */
export function hostSamplerFor(config = {}, { os, fs } = {}) {
  const volumes = [...new Set(Object.values(config.repositories ?? {}).map((repo) => repo?.worktreeRoot).filter(Boolean))];
  return createHostSampler({ os, fs, volumes, heartbeatMs: config.heartbeatMs ?? RUNNER_DEFAULTS.heartbeatMs,
    staleMs: config.staleMs ?? RUNNER_DEFAULTS.staleMs, thresholds: config.scheduler?.pressure ?? {} });
}

/**
 * The last heartbeat of every open run: worker operations and the coordinator's runs (the coordinator takes no worker
 * place under the ceiling, but it counts in the pressure sample). A run that has not beaten yet is left out; the
 * controller's start grace covers it. Local file reads only.
 */
export function openRunBeats(store, { fs = nodeFs } = {}) {
  const dirs = [
    ...store.all("SELECT run_dir FROM operations WHERE state IN ('recorded', 'dispatched')"),
    ...store.all("SELECT run_dir FROM coordinator_runs WHERE state IN ('recorded', 'dispatched')"),
  ].map((row) => row.run_dir).filter(Boolean);
  const beats = [];
  for (const dir of dirs) {
    let text;
    try { text = fs.readFileSync(join(dir, 'heartbeat'), 'utf8'); } catch { continue; }
    const beat = Number(text);
    if (Number.isFinite(beat) && beat > 0) beats.push(beat);
  }
  return beats;
}
