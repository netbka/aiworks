// External check services: plug-ins that run a project's full gate on another computer (docs/guides/check-services.md).
// Switched off unless config.json lists `checkServices`. When one is listed for the checkout's repository, the gate helper
// (gate.mjs run) first offers it the exact commit: a service that is down, does not have the commit, or leaves the job
// queued longer than its `queueSeconds` is skipped (its own queued job cancelled), and the gate runs on this computer as
// before. Nothing waits on a service and no service is required.
//
// A service's answer counts only for the exact commit the gate helper recorded on a clean checkout, with the service's
// own record of the full gate command having exited 0 (acceptRemoteResult). A test failure there is a failed gate here; an
// environment failure, a cancel or an interruption says nothing about the code and the gate runs here instead.
//
// The supervisor writes the services it accepted (no secret: an address, the certificate file to trust and the project
// mapping) to SERVICES_FILE in the gate slot folder when serve starts, and removes it when none is configured. The gate
// helper, run inside a worker's containment, reads only that file. A worker could rewrite it as it could rewrite
// gate-exit.log itself; the head check (gateHeadProblem) and the verifier's independence are what this relies on.
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleepFor } from 'node:timers/promises';

export const SERVICES_FILE = 'check-services.json';
export const SERVICE_KINDS = Object.freeze(['remote-gate-http']);
const TERMINAL = new Set(['passed', 'test_failure', 'environment_failure', 'cancelled', 'interrupted']);
const SHA = /^[0-9a-f]{40}$/;
const JOB_ID = /^[0-9a-f-]{36}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const TOKEN = /^[\w.-]{1,64}$/;
const DEFAULT_GATE = ['run', 'check'];
const bounded = (value, low, high, fallback) => (Number.isSafeInteger(value) && value >= low && value <= high ? value : fallback);

/** Why a configured service cannot be used, or null. */
function serviceProblem(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'is not an object';
  if (!SERVICE_KINDS.includes(entry.kind)) return `has unknown kind ${JSON.stringify(entry.kind)} (known: ${SERVICE_KINDS.join(', ')})`;
  if (typeof entry.name !== 'string' || !TOKEN.test(entry.name)) return 'needs a name of letters, digits, dot, dash or underscore';
  let url;
  try { url = new URL(entry.baseUrl); } catch { return 'needs baseUrl, an https address'; }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return 'baseUrl must be a plain https origin: no credentials, path, query or fragment';
  }
  if (typeof entry.caFile !== 'string' || !entry.caFile.trim()) return 'needs caFile, the service certificate this computer trusts';
  const projects = entry.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects) || !Object.keys(projects).length) {
    return 'needs projects: { "<owner>/<repository>": { "projectId": ..., "profile": ... } }';
  }
  for (const [repository, project] of Object.entries(projects)) {
    if (!REPOSITORY.test(repository)) return `has projects key ${JSON.stringify(repository)}, which is not <owner>/<repository>`;
    if (!TOKEN.test(project?.projectId ?? '') || !TOKEN.test(project?.profile ?? '')) return `needs projectId and profile for ${repository}`;
  }
  return null;
}

/**
 * The usable services of config.json `checkServices`, in the order listed, and why any entry was left out. An entry
 * with `enabled: false` is left out quietly. `queueSeconds` (default 120) is how long a job may wait in the service's
 * queue before the gate runs here instead; `timeoutMinutes` (default 90, under a verifier's 120-minute bound) ends a run
 * that takes longer.
 */
export function checkServiceSettings(config) {
  const list = Array.isArray(config?.checkServices) ? config.checkServices : [];
  const services = [], problems = [];
  list.forEach((entry, index) => {
    if (entry?.enabled === false) return;
    const problem = serviceProblem(entry);
    if (problem) { problems.push(`checkServices[${index}] ${problem}`); return; }
    services.push({ name: entry.name, kind: entry.kind, baseUrl: new URL(entry.baseUrl).origin, caFile: entry.caFile,
      projects: Object.fromEntries(Object.entries(entry.projects).map(([repository, p]) => [repository.toLowerCase(),
        { projectId: p.projectId, profile: p.profile }])),
      queueSeconds: bounded(entry.queueSeconds, 10, 3600, 120), timeoutMinutes: bounded(entry.timeoutMinutes, 5, 600, 90) });
  });
  return { services, problems };
}

/**
 * Writes the accepted services for gate helpers on this computer, or removes the file when there are none. A relative
 * caFile is read from `base` (the supervisor data folder).
 */
export function publishCheckServices(config, dir, base = process.cwd()) {
  const { services, problems } = checkServiceSettings(config);
  for (const service of services) if (!isAbsolute(service.caFile)) service.caFile = resolve(base, service.caFile);
  const file = join(dir, SERVICES_FILE);
  if (!services.length) { rmSync(file, { force: true }); return { services, problems }; }
  mkdirSync(dir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ services }, null, 2));
  renameSync(temporary, file);
  return { services, problems };
}

/** The services a gate helper may offer a commit to; none when the file is absent or unreadable. */
export function readCheckServices(dir) {
  const file = join(dir, SERVICES_FILE);
  if (!existsSync(file)) return [];
  try { return checkServiceSettings({ checkServices: JSON.parse(readFileSync(file, 'utf8')).services }).services; } catch { return []; }
}

/** `<owner>/<repository>` of a checkout's origin (https or ssh form), lower case, or null. */
export function originRepository(cwd = process.cwd()) {
  const url = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 }).stdout?.trim() ?? '';
  const match = /[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** Whether a branch of origin, as this checkout last fetched it, contains `sha`: the only commits a service can fetch. */
export function onOrigin(sha, cwd = process.cwd()) {
  const result = spawnSync('git', ['branch', '-r', '--contains', sha], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return result.status === 0 && result.stdout.split('\n').some((line) => line.trim().startsWith('origin/'));
}

/** HTTPS requests to one service: only its fixed routes, its own certificate trusted, bounded in time and size. */
function httpsTransport(service) {
  let ca = null;
  return (method, path, payload) => new Promise((resolve, reject) => {
    if (path !== '/health' && !/^\/v1\/jobs(?:\/[0-9a-f-]{36}(?:\/(?:result|cancel|artifacts\/stdout\.log))?)?$/.test(path)) {
      reject(new Error(`route ${path} is not part of the service contract`)); return;
    }
    try { ca ??= readFileSync(service.caFile); } catch (error) { reject(new Error(`certificate ${service.caFile} unreadable (${error.code ?? error.message})`)); return; }
    const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const request = https.request(new URL(path, service.baseUrl), { method, ca, rejectUnauthorized: true,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {} }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > 64 * 1024 * 1024) response.destroy(new Error('response over 64 MiB')); else chunks.push(chunk); });
      response.on('error', (error) => reject(error));
      response.on('end', () => {
        const data = Buffer.concat(chunks);
        if (response.statusCode >= 300) { reject(new Error(`HTTP ${response.statusCode}`)); return; }
        try { resolve(String(response.headers['content-type'] ?? '').includes('application/json') ? JSON.parse(data) : data.toString('utf8')); }
        catch { reject(new Error('invalid JSON response')); }
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error('no response in 15 s')));
    request.on('error', (error) => reject(error));
    request.end(body);
  });
}

/** The service-contract client of kind remote-gate-http; `transport` is injectable for tests. */
export function remoteGateHttp(service, { transport = httpsTransport(service) } = {}) {
  return {
    health: () => transport('GET', '/health'),
    submit: (spec) => transport('POST', '/v1/jobs', spec),
    status: (jobId) => transport('GET', `/v1/jobs/${jobId}`),
    result: (jobId) => transport('GET', `/v1/jobs/${jobId}/result`),
    log: (jobId) => transport('GET', `/v1/jobs/${jobId}/artifacts/stdout.log`),
    cancel: (jobId) => transport('POST', `/v1/jobs/${jobId}/cancel`, {}),
  };
}

/**
 * Whether a service's terminal result counts as this gate's run, and as a pass or a failure. It counts only when it names
 * the job, project, profile and exact commit asked for. A pass also needs exit code 0 and the service's record of the full
 * gate command (a step ending in `npm run check`) having exited 0. A test failure counts as a failed gate. An
 * environment failure, a cancel or an interruption does not count: the gate then runs on this computer.
 */
export function acceptRemoteResult(result, { jobId, sha, projectId, profile }) {
  if (!result || typeof result !== 'object') return { counted: false, reason: 'no result' };
  if (result.jobId !== jobId || result.projectId !== projectId || result.profile !== profile) return { counted: false, reason: 'the result names another job, project or profile' };
  if (result.requestedSha !== sha) return { counted: false, reason: `the result was asked for ${result.requestedSha}, not ${sha}` };
  if (!TERMINAL.has(result.state)) return { counted: false, reason: `the job is ${result.state}, not finished` };
  if (result.commitSha !== null && result.commitSha !== undefined && result.commitSha !== sha) return { counted: false, reason: `the service checked ${result.commitSha}, not ${sha}` };
  if (result.state === 'passed') {
    if (result.exitCode !== 0 || result.commitSha !== sha) return { counted: false, reason: 'a pass without exit code 0 on the exact commit' };
    const full = Array.isArray(result.commands) && result.commands.some((command) => String(command?.phase ?? '').endsWith('-check')
      && command.exitCode === 0 && Array.isArray(command.argv) && command.argv.slice(-2).join(' ') === DEFAULT_GATE.join(' '));
    if (!full) return { counted: false, reason: 'a pass with no record of the full gate command having exited 0' };
    return { counted: true, passed: true, state: result.state };
  }
  if (result.state === 'test_failure') return { counted: true, passed: false, state: result.state };
  return { counted: false, reason: `the service ended with ${result.state}, which says nothing about the code` };
}

/**
 * Offers the exact commit `sha` of `repository` to each service listed for it, in order. Returns { exit, text, service,
 * jobId } for the first answer that counts (exit 0 for a pass, 1 for a test failure, text the service's gate output), or
 * null when the gate is to run on this computer. `say` gets one line per decision, for gate.log.
 */
export async function runOnService({ services, repository, sha, available = () => true, say = () => {}, reference = 'gate',
  client = remoteGateHttp, sleep = sleepFor, now = Date.now, pollMs = 10_000 }) {
  if (!SHA.test(sha ?? '') || !repository) return null;
  for (const service of services) {
    const project = service.projects[repository.toLowerCase()];
    if (!project) continue;
    const name = `check service ${service.name}`;
    if (!available(sha)) { say(`# ${name} skipped: ${sha} is on no origin branch, and the service can fetch only from origin`); return null; }
    const api = client(service);
    let jobId = null;
    try {
      const health = await api.health();
      if (health?.status !== 'ok') { say(`# ${name} skipped: health is ${JSON.stringify(health?.status ?? null)}`); continue; }
      const spec = { idempotencyKey: `aiworks-gate-${sha.slice(0, 12)}-${now().toString(36)}`, projectId: project.projectId, commitSha: sha,
        profile: project.profile, timeoutSeconds: service.timeoutMinutes * 60, aiworksTaskId: String(reference).slice(0, 120) };
      const submitted = await api.submit(spec);
      if (!JOB_ID.test(submitted?.jobId ?? '') || submitted.spec?.commitSha !== sha || submitted.spec?.projectId !== project.projectId
        || submitted.spec?.profile !== project.profile) { say(`# ${name} skipped: it answered the submission for another job`); continue; }
      jobId = submitted.jobId;
      say(`# ${name} accepted job ${jobId} for ${sha} (${project.projectId}, ${project.profile})`);
      const queuedUntil = now() + service.queueSeconds * 1000, deadline = now() + service.timeoutMinutes * 60_000;
      let state = submitted.state, said = state;
      while (!TERMINAL.has(state)) {
        if (state === 'pending' && now() >= queuedUntil) { await api.cancel(jobId).catch(() => {}); say(`# ${name} busy: job ${jobId} still queued after ${service.queueSeconds} s, cancelled; next service or this computer`); jobId = null; break; }
        if (now() >= deadline) { await api.cancel(jobId).catch(() => {}); say(`# ${name} took over ${service.timeoutMinutes} minutes: job ${jobId} cancelled; next service or this computer`); jobId = null; break; }
        await sleep(pollMs);
        state = (await api.status(jobId))?.state;
        if (state !== said) { say(`# ${name} job ${jobId}: ${state}`); said = state; }
      }
      if (!jobId) continue;
      const verdict = acceptRemoteResult(await api.result(jobId), { jobId, sha, projectId: project.projectId, profile: project.profile });
      if (!verdict.counted) { say(`# ${name} job ${jobId} does not count: ${verdict.reason}; next service or this computer`); continue; }
      let text = '';
      try { text = String(await api.log(jobId)); } catch (error) { say(`# ${name} output of job ${jobId} unavailable (${error.message})`); }
      return { exit: verdict.passed ? 0 : 1, text, service: service.name, jobId };
    } catch (error) {
      if (jobId) await api.cancel(jobId).catch(() => {});
      say(`# ${name} unavailable (${error.message}); next service or this computer`);
    }
  }
  return null;
}
