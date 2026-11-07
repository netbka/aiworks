// Additional check-service client and exact-revision receipt validation (docs/guides/check-services.md).
// The managed gate helper always runs its required local contained command; it no longer submits service jobs or
// substitutes a service result for local evidence. Separate authorized callers can still use this bounded client.
// Service configuration comes only from SERVICES_ENV, populated from the installation config by serve, never from
// the shared gate registry. It contains addresses, certificate paths and project mappings, never secret values.
// Each offer has one bounded budget. An unsuitable or unavailable additional service never blocks local work.
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as sleepFor } from 'node:timers/promises';

export const SERVICES_ENV = 'AIWORKS_CHECK_SERVICES';
export const MAX_TIMEOUT_MINUTES = 75;
export const SERVICE_KINDS = Object.freeze(['remote-gate-http']);
const TERMINAL = new Set(['passed', 'test_failure', 'environment_failure', 'cancelled', 'interrupted']);
const KNOWN = new Set([...TERMINAL, 'pending', 'running']);
// A service's own words (states, commit ids, error messages) on one gate.log line: no control character, so it can never
// start a line the gate log readers (testSummary, exitedFiles, parseGateLog) take for their own.
const plain = (text) => String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, 300);
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
 * queue before the gate runs here instead; `timeoutMinutes` (default 60, at most MAX_TIMEOUT_MINUTES, so the gate here
 * still fits a verifier's 120-minute bound) ends a run that takes longer.
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
      queueSeconds: bounded(entry.queueSeconds, 10, 3600, 120), timeoutMinutes: bounded(entry.timeoutMinutes, 5, MAX_TIMEOUT_MINUTES, 60) });
  });
  return { services, problems };
}

/**
 * The value of SERVICES_ENV for the accepted services of `config` (null when there are none), with a relative caFile
 * read from `base` (the supervisor data folder).
 */
export function checkServicesEnvironment(config, base = process.cwd()) {
  const { services, problems } = checkServiceSettings(config);
  for (const service of services) if (!isAbsolute(service.caFile)) service.caFile = resolve(base, service.caFile);
  return { value: services.length ? JSON.stringify(services) : null, services, problems };
}

/** The services a gate helper may offer a commit to: those serve put in its environment, else none. */
export function readCheckServices(env = process.env) {
  if (!env[SERVICES_ENV]) return [];
  try { return checkServiceSettings({ checkServices: JSON.parse(env[SERVICES_ENV]) }).services; } catch { return []; }
}

/** `<owner>/<repository>` of a checkout's origin (https or ssh form), lower case, or null. */
export function originRepository(cwd = process.cwd()) {
  const url = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 }).stdout?.trim() ?? '';
  const match = /[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/**
 * Whether origin has `sha`, the only commits a service can fetch: a branch of origin as this checkout last fetched it
 * contains it, or origin lists it as the tip of a branch now. The second covers a repository that fetches only some
 * branches (a pushed task branch then has no remote-tracking ref here).
 */
export function onOrigin(sha, cwd = process.cwd()) {
  // Never a sign-in prompt: a gate helper runs unattended, and an origin that needs one simply does not count.
  const git = (args, timeout) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  const tracked = git(['branch', '-r', '--contains', sha], 30_000);
  if (tracked.status === 0 && tracked.stdout.split('\n').some((line) => line.trim().startsWith('origin/'))) return true;
  const listed = git(['ls-remote', '--heads', 'origin'], 30_000);
  return listed.status === 0 && listed.stdout.split('\n').some((line) => line.split('\t')[0] === sha);
}

/**
 * HTTPS requests to one service: only its fixed routes, its own certificate trusted, at most 64 MiB, and each request
 * ended after `limitMs` in all (a total bound, not an idle one: a trickling answer cannot hold the gate).
 */
function httpsTransport(service) {
  let ca = null;
  return (method, path, payload, limitMs = 30_000) => new Promise((resolve, reject) => {
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
      response.on('error', (error) => { clearTimeout(timer); reject(error); });
      response.on('end', () => {
        clearTimeout(timer);
        const data = Buffer.concat(chunks);
        if (response.statusCode >= 300) { reject(new Error(`HTTP ${response.statusCode}`)); return; }
        try { resolve(String(response.headers['content-type'] ?? '').includes('application/json') ? JSON.parse(data) : data.toString('utf8')); }
        catch { reject(new Error('invalid JSON response')); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error(`no complete answer in ${limitMs / 1000} s`)), limitMs);
    request.on('error', (error) => { clearTimeout(timer); reject(error); });
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
    log: (jobId) => transport('GET', `/v1/jobs/${jobId}/artifacts/stdout.log`, undefined, 5 * 60_000),
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
  if (result.requestedSha !== sha) return { counted: false, reason: `the result was asked for ${JSON.stringify(result.requestedSha)}, not ${sha}` };
  if (!TERMINAL.has(result.state)) return { counted: false, reason: `the job is ${JSON.stringify(result.state)}, not finished` };
  if (result.commitSha !== null && result.commitSha !== undefined && result.commitSha !== sha) return { counted: false, reason: `the service checked ${JSON.stringify(result.commitSha)}, not ${sha}` };
  if (result.state === 'passed') {
    if (result.exitCode !== 0 || result.commitSha !== sha) return { counted: false, reason: 'a pass without exit code 0 on the exact commit' };
    const full = Array.isArray(result.commands) && result.commands.some((command) => String(command?.phase ?? '').endsWith('-check')
      && command.exitCode === 0 && Array.isArray(command.argv) && command.argv.slice(-2).join(' ') === DEFAULT_GATE.join(' '));
    if (!full) return { counted: false, reason: 'a pass with no record of the full gate command having exited 0' };
    return { counted: true, passed: true, state: result.state };
  }
  if (result.state === 'test_failure') return { counted: true, passed: false, state: result.state };
  return { counted: false, reason: `the service ended with ${JSON.stringify(result.state)}, which says nothing about the code` };
}

/**
 * Offers the exact commit `sha` of `repository` to each service listed for it, in order, within one budget: the largest
 * timeoutMinutes of those services, so the gate here still fits a verifier's bound when no answer counts. Returns
 * { exit, text, service, jobId } for the first answer that counts (exit 0 for a pass, 1 for a test failure, text the
 * service's gate output), or null when the gate is to run on this computer. A pass counts only with its output, and with
 * a run-tests summary ("# all test files") when `summaryRequired`. `say` gets one line per decision, for gate.log; the
 * service's own words in it are reduced to plain text.
 */
export async function runOnService({ services, repository, sha, available = () => true, say: sayLine = () => {}, reference = 'gate',
  summaryRequired = false, client = remoteGateHttp, sleep = sleepFor, now = Date.now, pollMs = 10_000 }) {
  if (!SHA.test(sha ?? '') || !repository) return null;
  const listed = services.filter((service) => service.projects[repository.toLowerCase()]);
  if (!listed.length) return null;
  if (!available(sha)) { sayLine(`# check services skipped: ${sha} is on no origin branch, and a service can fetch only from origin`); return null; }
  const say = (line) => sayLine(plain(line));
  const budgetEnd = now() + Math.min(MAX_TIMEOUT_MINUTES, Math.max(...listed.map((service) => service.timeoutMinutes))) * 60_000;
  for (const service of listed) {
    const project = service.projects[repository.toLowerCase()];
    const name = `check service ${service.name}`;
    const deadline = Math.min(budgetEnd, now() + service.timeoutMinutes * 60_000);
    // The service is told to stop a little before AIWorks stops waiting, so its answer can still arrive.
    const timeoutSeconds = Math.floor((deadline - now()) / 1000) - 60;
    if (timeoutSeconds < 300) { say(`# ${name} skipped: under five minutes of the check service budget left`); continue; }
    const api = client(service);
    let jobId = null;
    try {
      const health = await api.health();
      if (health?.status !== 'ok') { say(`# ${name} skipped: health is ${JSON.stringify(health?.status ?? null)}`); continue; }
      const spec = { idempotencyKey: `aiworks-gate-${sha.slice(0, 12)}-${now().toString(36)}`, projectId: project.projectId, commitSha: sha,
        profile: project.profile, timeoutSeconds, aiworksTaskId: String(reference).replace(/[^\w.-]+/g, '-').slice(0, 120) };
      const submitted = await api.submit(spec);
      if (!JOB_ID.test(submitted?.jobId ?? '') || submitted.spec?.commitSha !== sha || submitted.spec?.projectId !== project.projectId
        || submitted.spec?.profile !== project.profile) { say(`# ${name} skipped: it answered the submission for another job`); continue; }
      jobId = submitted.jobId;
      say(`# ${name} accepted job ${jobId} for ${sha} (${project.projectId}, ${project.profile})`);
      const queuedUntil = now() + service.queueSeconds * 1000;
      let state = submitted.state, said = state, unknown = 0;
      const giveUp = async (why) => { await api.cancel(jobId).catch(() => {}); say(`# ${name} ${why}: job ${jobId} cancelled; next service or this computer`); jobId = null; };
      while (!TERMINAL.has(state)) {
        // A state outside the contract twice in a row: the service is not answering as agreed.
        unknown = KNOWN.has(state) ? 0 : unknown + 1;
        if (unknown >= 2) { await giveUp(`answers state ${JSON.stringify(state ?? null)}, which the contract does not name`); break; }
        if (state !== 'running' && now() >= queuedUntil) { await giveUp(`busy: still queued after ${service.queueSeconds} s`); break; }
        if (now() >= deadline) { await giveUp(`gave no answer within its ${service.timeoutMinutes}-minute limit or the check service budget`); break; }
        await sleep(Math.max(0, Math.min(pollMs, deadline - now())));
        state = (await api.status(jobId))?.state;
        if (state !== said) { say(`# ${name} job ${jobId}: ${JSON.stringify(state ?? null)}`); said = state; }
      }
      if (!jobId) continue;
      const verdict = acceptRemoteResult(await api.result(jobId), { jobId, sha, projectId: project.projectId, profile: project.profile });
      if (!verdict.counted) { say(`# ${name} job ${jobId} does not count: ${verdict.reason}; next service or this computer`); continue; }
      let text = '';
      try {
        const log = await api.log(jobId);
        text = typeof log === 'string' ? log : JSON.stringify(log);
      } catch (error) { say(`# ${name} output of job ${jobId} unavailable (${error.message})`); }
      if (verdict.passed && (!text.trim() || (summaryRequired && !/^# all test files/m.test(text)))) {
        say(`# ${name} job ${jobId} passed, but does not count without its ${text.trim() ? 'test summary' : 'output'}; next service or this computer`);
        continue;
      }
      return { exit: verdict.passed ? 0 : 1, text, service: service.name, jobId };
    } catch (error) {
      if (jobId) await api.cancel(jobId).catch(() => {});
      say(`# ${name} unavailable (${error.message}); next service or this computer`);
    }
  }
  return null;
}
