// Host pressure for the scheduler (docs/design/ADAPTIVE_SCHEDULER.md section 4.6, slice RUN7). One in-process sample per
// admission pass, with no model, network or child-process call: free memory, CPU busy over the last minute, free disk on
// each worktree volume and runner heartbeats that arrive late. Ephemeral ports in use and Docker's state come from a probe
// (createHostProbe) that runs netstat and docker on its own timer, never inside the admission pass; the pass reads its
// last result. Ports and Docker were added after the host crash of 2026-10-31, when TCP ports ran out while memory and
// CPU looked fine. Pressure only refuses new admission (scheduler.mjs
// hostPressure, admissionCheck); running work continues untouched. This is host safety, not an AW-002 limit: it never
// stops a campaign, counts runs or money, or notifies the owner. It only says "not now".
import * as nodeOs from 'node:os';
import * as nodeFs from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

const GiB = 1024 ** 3;

/** Thresholds, each overridable in the data directory's config.json under scheduler.pressure. */
export const PRESSURE_DEFAULTS = Object.freeze({
  minFreeMemoryBytes: 2 * GiB, minFreeMemoryShare: 0.10, // free memory below max(2 GiB, 10% of total)
  maxCpuBusy: 0.90, cpuWindowMs: 60_000,                  // CPU busy above 90% over the last 60 s
  minFreeDiskBytes: 5 * GiB,                              // free disk on a worktree volume below 5 GiB
  lateHeartbeats: 3,                                      // a heartbeat older than three intervals but not yet stale
  maxPortShare: 0.5,                                      // more than half of the TCP or UDP ephemeral ports in use
  maxContainers: 12,                                      // more running Docker containers than this
  probeStaleMs: 180_000,                                  // a probe result older than this says nothing
  pauseAtGates: 1,                                        // this many gate helper runs holding or awaiting a slot; 99 turns it off
});

/** The signals, in the order they are checked. A sample under pressure names the first that applies. */
export const PRESSURE_SIGNALS = Object.freeze(['memory', 'cpu', 'disk', 'ports', 'docker', 'gates', 'heartbeats']);

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
 * starts again. A volume that cannot be read gives no signal. `probe.latest()` (createHostProbe) gives the last port and
 * Docker reading; none, or one older than probeStaleMs, gives no signal. `gates()` gives the number of gate helper runs
 * that hold a slot or wait for the browser session now; none gives no signal. Every dependency is injectable for tests;
 * the defaults read the real host.
 */
export function createHostSampler({ os = nodeOs, fs = nodeFs, volumes = [], heartbeatMs = RUNNER_DEFAULTS.heartbeatMs,
  staleMs = RUNNER_DEFAULTS.staleMs, thresholds = {}, probe = null, gates = null } = {}) {
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

      const seen = probe?.latest?.() ?? null;
      if (seen && Number.isFinite(seen.at) && now - seen.at <= limits.probeStaleMs) {
        for (const protocol of ['tcp', 'udp']) {
          const ports = seen.ports?.[protocol];
          if (ports && ports.range > 0 && ports.used / ports.range > limits.maxPortShare) {
            return { signal: 'ports', detail: { protocol, used: ports.used, range: ports.range } };
          }
        }
        if (seen.docker?.unresponsive) return { signal: 'docker', detail: { unresponsive: true } };
        if (Number.isFinite(seen.docker?.containers) && seen.docker.containers > limits.maxContainers) {
          return { signal: 'docker', detail: { containers: seen.docker.containers, max: limits.maxContainers } };
        }
      }

      // A gate running (owner decision 2026-11-05: pause new work during heavy tests). On 2026-11-05 about half of 49
      // saved gate failures were browser, preview and timing tests that failed under load from other workers. `gates`
      // (gate.mjs heldSlotCount) counts every run of the gate helper that holds a slot, a verifier's full gate, an
      // implementer's affected tests or the supervisor's own base-check and refresh gates, and every gate waiting for the
      // browser session, so a wave of web task runs cannot starve it. A lock counts only while its holder beats.
      // cli.mjs serve supplies it, tests and other callers do not.
      let running = 0;
      try { running = gates?.() ?? 0; } catch { running = 0; }
      if (running >= limits.pauseAtGates) return { signal: 'gates', detail: { running, pauseAt: limits.pauseAtGates } };

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
export function hostSamplerFor(config = {}, { os, fs, probe = null, gates = null } = {}) {
  const volumes = [...new Set(Object.values(config.repositories ?? {}).map((repo) => repo?.worktreeRoot).filter(Boolean))];
  return createHostSampler({ os, fs, volumes, heartbeatMs: config.heartbeatMs ?? RUNNER_DEFAULTS.heartbeatMs,
    staleMs: config.staleMs ?? RUNNER_DEFAULTS.staleMs, thresholds: config.scheduler?.pressure ?? {}, probe, gates });
}

// ---- The probe: ports and Docker, read outside the admission pass ----

const exec = (command, args, timeoutMs) => new Promise((done) => {
  const [cmd, ...prefix] = command;
  execFile(cmd, [...prefix, ...args], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout) => done({ ok: !error, stdout: stdout ?? '', timedOut: Boolean(error?.killed) }));
});

const DEFAULT_DYNAMIC = { start: 49152, count: 16384 };
/** The dynamic port range from `netsh int ipv4 show dynamicport <protocol>`: its first two numbers (labels are localized). */
export function parseDynamicRange(text) {
  const [start, count] = (text.match(/\d+/g) ?? []).map(Number);
  return start > 0 && count > 0 && start + count <= 65536 ? { start, count } : null;
}

/** Distinct local TCP and UDP ports inside each range in `netstat -an` output (IPv4 and IPv6 rows). */
export function countEphemeral(text, ranges) {
  const seen = { tcp: new Set(), udp: new Set() };
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const protocol = parts[0]?.toLowerCase();
    if (protocol !== 'tcp' && protocol !== 'udp') continue;
    const port = Number(/:(\d+)$/.exec(parts[1] ?? '')?.[1]);
    const range = ranges[protocol];
    if (port >= range.start && port < range.start + range.count) seen[protocol].add(port);
  }
  return { tcp: { used: seen.tcp.size, range: ranges.tcp.count }, udp: { used: seen.udp.size, range: ranges.udp.count } };
}

/**
 * A probe that every `intervalMs` reads the ephemeral ports in use (Windows: netstat) and, when `docker` is a command,
 * the number of running Docker containers; a docker that does not answer within `dockerTimeoutMs` is reported unresponsive.
 * `latest()` returns { at, ports, docker } of the last complete reading, or null. Its timer never keeps the process up.
 */
export function createHostProbe({ docker = null, intervalMs = 60_000, dockerTimeoutMs = 30_000, platform = process.platform,
  run = exec, clock = Date.now } = {}) {
  let latest = null, ranges = null, timer = null, busy = false;
  const read = async () => {
    if (busy) return;
    busy = true;
    try {
      let ports = null;
      if (platform === 'win32') {
        if (!ranges) {
          const range = async (protocol) => parseDynamicRange((await run(['netsh'], ['int', 'ipv4', 'show', 'dynamicport', protocol], 10_000)).stdout) ?? DEFAULT_DYNAMIC;
          ranges = { tcp: await range('tcp'), udp: await range('udp') };
        }
        const listed = await run(['netstat'], ['-an'], 30_000);
        if (listed.ok) ports = countEphemeral(listed.stdout, ranges);
      }
      let state = null;
      if (docker) {
        const listed = await run(docker, ['ps', '-q'], dockerTimeoutMs);
        state = listed.ok ? { containers: listed.stdout.split(/\r?\n/).filter((line) => line.trim()).length }
          : listed.timedOut ? { unresponsive: true } : null; // not installed or engine stopped: no Docker load
      }
      latest = { at: clock(), ports, docker: state };
    } finally { busy = false; }
  };
  return {
    latest: () => latest,
    read,
    start() {
      if (timer) return;
      read().catch(() => {});
      timer = setInterval(() => read().catch(() => {}), intervalMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
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
