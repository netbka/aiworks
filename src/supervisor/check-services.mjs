// Additional check-service client and exact-revision receipt validation (docs/guides/check-services.md).
// The managed gate helper always runs its required local contained command; it no longer submits service jobs or
// substitutes a service result for local evidence. The authorized caller (check-service-caller.mjs) offers verified
// commits to the services that opted in (`"offer": "verified"`) through offerOnService, as information only.
// Service configuration comes only from SERVICES_ENV, populated from the installation config by serve, never from
// the shared gate registry. It contains addresses, certificate paths and project mappings, never secret values and
// never an authentication contract: workers inherit and can rewrite it. A service that requires authentication is
// offered a credential only when the authorized caller read it from the controller's own config.json
// (checkServiceSettings) and passes a credential broker (token-store.mjs) built from that same config. The value never
// reaches gate.log, an error message or the returned result.
// Each offer has one bounded budget. An unsuitable or unavailable additional service never blocks local work.
import https from 'node:https';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { readToken, validTokenRef } from './token-store.mjs';

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
const SOURCE_ID = /^[0-9a-f]{32}$/;
/** The largest bundle of unpublished commits AIWorks sends, the same cap the service states. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const IDENTIFIER = /^[\w.-]{1,64}$/;
const DEFAULT_GATE = ['run', 'check'];
// A project's own full gate: the last words of the step's argv that count as it (`"gate": ["npm", "test"]`).
const GATE_WORD = /^[^\p{Cc}]{1,200}$/u;
const validGate = (gate) => Array.isArray(gate) && gate.length >= 1 && gate.length <= 16 && gate.every((word) => typeof word === 'string' && GATE_WORD.test(word));
// Authentication contracts a service may declare. `bearer` sends `Authorization: Bearer <value>`; `header` sends the
// value alone in the one header the contract names. Nothing else is ever inferred: a service without `auth` gets no
// credential, and a malformed `auth` leaves the service out rather than sending it unauthenticated or guessing.
export const AUTH_SCHEMES = Object.freeze(['bearer', 'header']);
/** Every check-service credential reference lives under this prefix, so one can never name another operator secret. */
export const CHECK_SERVICE_TOKEN_PREFIX = 'aiworks-check-service';
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
// Headers the transport owns, or that would change routing, framing or another credential: never a credential header.
const RESERVED_HEADERS = new Set(['authorization', 'host', 'content-type', 'content-length', 'transfer-encoding', 'connection', 'te',
  'upgrade', 'cookie', 'proxy-authorization', 'expect', 'keep-alive', 'trailer']);
// A credential value fit for one header line: printable ASCII without `"` or `\` (so its JSON-escaped form is itself and
// redaction finds it in JSON text too), no space at either end, bounded.
const CREDENTIAL_VALUE = /^[\x21\x23-\x5b\x5d-\x7e](?:[\x20\x21\x23-\x5b\x5d-\x7e]{0,4094}[\x21\x23-\x5b\x5d-\x7e])?$/;
const validStoreSpec = (store) => store === undefined || (store && typeof store === 'object' && !Array.isArray(store) &&
  (store.kind === 'windows' || (store.kind === 'command' && Array.isArray(store.command) && store.command.length > 0 &&
    store.command.every((part) => typeof part === 'string' && part))));
/**
 * `sources: true` sends a bundle of the commits origin lacks, only for a commit origin does not have; `sources: "full"`
 * always sends a self-contained bundle of the commit (every object it reaches), for a service whose copy of the
 * repository cannot fetch origin.
 */
export const SOURCES_FULL = 'full';
/** Whether a service takes the commit as a bundle at all. */
export const acceptsSources = (service) => service?.sources === true || service?.sources === SOURCES_FULL;
/** The one value of a service's `offer` switch: offer each commit verified here once (check-service-caller.mjs). */
export const OFFER_VERIFIED = 'verified';
const bounded = (value, low, high, fallback) => (Number.isSafeInteger(value) && value >= low && value <= high ? value : fallback);

/** Why a configured service cannot be used, or null. */
function serviceProblem(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'is not an object';
  if (!SERVICE_KINDS.includes(entry.kind)) return `has unknown kind ${JSON.stringify(entry.kind)} (known: ${SERVICE_KINDS.join(', ')})`;
  if (typeof entry.name !== 'string' || !IDENTIFIER.test(entry.name)) return 'needs a name of letters, digits, dot, dash or underscore';
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
    if (!IDENTIFIER.test(project?.projectId ?? '') || !IDENTIFIER.test(project?.profile ?? '')) return `needs projectId and profile for ${repository}`;
    if (project.gate !== undefined && !validGate(project.gate)) return `has gate for ${repository} that is not a list of 1 to 16 non-empty words`;
  }
  if (entry.sources !== undefined && typeof entry.sources !== 'boolean' && entry.sources !== SOURCES_FULL) return `has sources that is not true, false or ${JSON.stringify(SOURCES_FULL)}`;
  if (entry.offer !== undefined && entry.offer !== OFFER_VERIFIED) return `has offer that is not ${JSON.stringify(OFFER_VERIFIED)}`;
  return entry.auth === undefined ? null : authProblem(entry.auth);
}

/** Why a declared authentication contract cannot be used, or null. Never names a value: configuration holds none. */
function authProblem(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return 'has auth that is not an object';
  if (Object.keys(auth).some((key) => !['scheme', 'header', 'tokenRef', 'credentialStore'].includes(key))) {
    return 'has auth with a key other than scheme, header, tokenRef or credentialStore';
  }
  if (!AUTH_SCHEMES.includes(auth.scheme)) return `needs auth.scheme, the scheme the service contract documents (known: ${AUTH_SCHEMES.join(', ')})`;
  if (auth.scheme === 'bearer' && auth.header !== undefined) return 'has auth.header with scheme bearer, which is sent only as Authorization';
  if (auth.scheme === 'header' && (typeof auth.header !== 'string' || !HEADER_NAME.test(auth.header) || RESERVED_HEADERS.has(auth.header.toLowerCase()))) {
    return 'needs auth.header, the one header name the service contract documents (not Authorization or a transport header)';
  }
  if (!validTokenRef(auth.tokenRef) || !auth.tokenRef.startsWith(`${CHECK_SERVICE_TOKEN_PREFIX}:`) || auth.tokenRef.length <= CHECK_SERVICE_TOKEN_PREFIX.length + 1) {
    return `needs auth.tokenRef, a credential reference ${CHECK_SERVICE_TOKEN_PREFIX}:<name>`;
  }
  if (!validStoreSpec(auth.credentialStore)) return 'has auth.credentialStore that is neither { "kind": "windows" } nor { "kind": "command", "command": [...] }';
  return null;
}

/**
 * The request headers carrying a service's credential, resolved fresh through `broker` (a token-store.mjs store that
 * the authorized caller passes in): `{ headers }`, or `{ problem }` naming why no request may be sent. A service with no
 * declared `auth` gets `{ headers: {} }`. A missing broker, an unresolved reference, a store that cannot tell or a value
 * unfit for one header line all fail closed. No problem text contains the value.
 */
export function serviceCredentialHeaders(service, broker) {
  const auth = service?.auth;
  if (auth === undefined) return { headers: {} };
  if (authProblem(auth)) return { problem: 'its declared authentication contract is invalid' };
  if (!broker || typeof broker.get !== 'function') return { problem: `it requires credential reference ${auth.tokenRef}, and no credential broker was provided` };
  let value;
  try { value = readToken(broker, auth.tokenRef); } catch { return { problem: `the credential store cannot tell whether ${auth.tokenRef} resolves` }; }
  if (!value) return { problem: `credential reference ${auth.tokenRef} does not resolve` };
  return headersFor(auth, value);
}

/**
 * serviceCredentialHeaders for a broker whose `get` returns a promise (token-store.mjs asyncTokenReader), so resolving
 * the value never blocks the event loop. The same contract and the same fail-closed answers.
 */
export async function serviceCredentialHeadersAsync(service, broker) {
  const auth = service?.auth;
  if (auth === undefined) return { headers: {} };
  if (authProblem(auth)) return { problem: 'its declared authentication contract is invalid' };
  if (!broker || typeof broker.get !== 'function') return { problem: `it requires credential reference ${auth.tokenRef}, and no credential broker was provided` };
  let value;
  try { value = await broker.get(auth.tokenRef); } catch { return { problem: `the credential store cannot tell whether ${auth.tokenRef} resolves` }; }
  if (typeof value !== 'string' || !value.length) return { problem: `credential reference ${auth.tokenRef} does not resolve` };
  return headersFor(auth, value);
}

function headersFor(auth, value) {
  if (!CREDENTIAL_VALUE.test(value)) return { problem: `the value of ${auth.tokenRef} is not fit for one header line` };
  return { headers: auth.scheme === 'bearer' ? { Authorization: `Bearer ${value}` } : { [auth.header]: value } };
}

/**
 * The usable services of config.json `checkServices`, in the order listed, and why any entry was left out. An entry
 * with `enabled: false` is left out quietly; `offer: "verified"` lets the authorized caller offer it each commit verified
 * here. `queueSeconds` (default 120) is how long a job may wait in the service's queue before the gate runs here instead; `timeoutMinutes` (default 60, at most MAX_TIMEOUT_MINUTES, so the gate here
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
        { projectId: p.projectId, profile: p.profile, ...(p.gate === undefined ? {} : { gate: [...p.gate] }) }])),
      ...(entry.sources === true || entry.sources === SOURCES_FULL ? { sources: entry.sources } : {}),
      ...(entry.offer === OFFER_VERIFIED ? { offer: OFFER_VERIFIED } : {}),
      ...(entry.auth === undefined ? {} : { auth: { scheme: entry.auth.scheme, ...(entry.auth.scheme === 'header' ? { header: entry.auth.header } : {}),
        tokenRef: entry.auth.tokenRef, ...(entry.auth.credentialStore ? { credentialStore: entry.auth.credentialStore } : {}) } }),
      queueSeconds: bounded(entry.queueSeconds, 10, 3600, 120), timeoutMinutes: bounded(entry.timeoutMinutes, 5, MAX_TIMEOUT_MINUTES, 60) });
  });
  return { services, problems };
}

// A service as the shared environment may carry it: never its authentication contract. Every worker inherits and can
// rewrite SERVICES_ENV, so a credential is offered only to a service the authorized caller read from the controller's
// own config.json (checkServiceSettings), with a broker built from that same config.
const withoutAuth = (entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const { auth, ...rest } = entry;
  return rest;
};

/**
 * The value of SERVICES_ENV for the accepted services of `config` (null when there are none), with a relative caFile
 * read from `base` (the supervisor data folder). No `auth` is exported.
 */
export function checkServicesEnvironment(config, base = process.cwd()) {
  const { services: accepted, problems } = checkServiceSettings(config);
  const services = accepted.map(withoutAuth);
  for (const service of services) if (!isAbsolute(service.caFile)) service.caFile = resolve(base, service.caFile);
  return { value: services.length ? JSON.stringify(services) : null, services, problems };
}

/**
 * The services a gate helper may offer a commit to: those serve put in its environment, else none. Any `auth` found
 * there is dropped, so a service from the environment can never produce credential headers.
 */
export function readCheckServices(env = process.env) {
  if (!env[SERVICES_ENV]) return [];
  try {
    const listed = JSON.parse(env[SERVICES_ENV]);
    return checkServiceSettings({ checkServices: Array.isArray(listed) ? listed.map(withoutAuth) : [] }).services;
  } catch { return []; }
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
export async function onOrigin(sha, cwd = process.cwd()) {
  // Never a sign-in prompt: the caller runs unattended, and an origin that needs one simply does not count.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  const tracked = await git(['branch', '-r', '--contains', sha], { cwd, timeout: 30_000, env });
  if (tracked.status === 0 && tracked.stdout.split('\n').some((line) => line.trim().startsWith('origin/'))) return true;
  // The one network call. A worker can write the shared checkout's configuration (remote.origin.uploadpack,
  // credential.helper, core.askPass, core.gitProxy, protocol.ext.allow, include.path, ...), and several of those values
  // name a command git would run here. So origin's address is only read from that configuration, and ls-remote runs
  // outside every repository on that address, where no checkout value applies; ssh never asks for anything and no
  // transport that runs a command (ext::) is allowed.
  const address = await git(['remote', 'get-url', 'origin'], { cwd, timeout: 10_000, env });
  const url = remoteAddress(address.status === 0 ? address.stdout.trim() : '', cwd);
  if (!url) return false;
  const outside = tmpdir();
  const listed = await git(['-c', 'core.sshCommand=ssh -o BatchMode=yes', '-c', 'protocol.ext.allow=never', '-c', 'core.askPass=',
    'ls-remote', '--heads', '--', url], { cwd: outside, timeout: 30_000, env: { ...env, GIT_CEILING_DIRECTORIES: dirname(outside) } });
  return listed.status === 0 && listed.stdout.split('\n').some((line) => line.split('\t')[0] === sha);
}

// origin's address as ls-remote outside the checkout can use it: a URL or scp-style address as written, a path made
// absolute against the checkout, and never one that git would read as an option.
function remoteAddress(url, cwd) {
  if (!url || url.startsWith('-') || /[\0\r\n]/.test(url)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || isAbsolute(url) || /^[^/\\]{2,}:/.test(url)) return url;
  return resolve(cwd, url);
}

// Reads that take no optional lock and start no fsmonitor, gc or maintenance, as the other supervisor git readers do.
const GIT_PREFIX = Object.freeze(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']);

// One git command that does not block the event loop (the caller runs beside the controller tick): { status, stdout }.
function git(args, { cwd, timeout, env = process.env }) {
  return new Promise((done) => {
    execFile('git', [...GIT_PREFIX, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      done({ status: error ? (Number.isInteger(error.code) ? error.code : -1) : 0, stdout: stdout ?? '' }));
  });
}

/** A transport failure that keeps the HTTP status, so a refused credential is told apart from an outage. */
class ServiceHttpError extends Error {
  constructor(status) { super(`HTTP ${status}`); this.status = status; }
}

/**
 * HTTPS requests to one service: only its fixed routes, its own certificate trusted (verification never disabled), at
 * most 64 MiB, and each request ended after `limitMs` in all (a total bound, not an idle one: a trickling answer cannot
 * hold the gate). `credentialHeaders` (from serviceCredentialHeaders) go with each request to that fixed origin only;
 * Node's https client follows no redirect. An error answer is reduced to its status: its body, which might echo a
 * request header, is never read into a message.
 */
function httpsTransport(service, credentialHeaders = {}, signal = undefined) {
  let ca = null;
  return (method, path, payload, limitMs = 30_000, bundle = null) => new Promise((resolve, reject) => {
    if (path !== '/health' && !(path === '/v1/sources' && bundle) && !/^\/v1\/jobs(?:\/[0-9a-f-]{36}(?:\/(?:result|cancel|artifacts\/stdout\.log))?)?$/.test(path)) {
      reject(new Error(`route ${path} is not part of the service contract`)); return;
    }
    try { ca ??= readFileSync(service.caFile); } catch (error) { reject(new Error(`certificate ${service.caFile} unreadable (${error.code ?? error.message})`)); return; }
    const body = bundle ? bundle.bytes : payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const type = bundle ? { 'Content-Type': 'application/x-git-bundle', 'X-Project-Id': bundle.projectId, 'X-Commit-Sha': bundle.sha } : { 'Content-Type': 'application/json' };
    const request = https.request(new URL(path, service.baseUrl), { method, ca, rejectUnauthorized: true, ...(signal ? { signal } : {}),
      headers: { ...credentialHeaders, ...(body ? { ...type, 'Content-Length': body.length } : {}) } }, (response) => {
      if (response.statusCode >= 300) { clearTimeout(timer); response.resume(); reject(new ServiceHttpError(response.statusCode)); return; }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > 64 * 1024 * 1024) response.destroy(new Error('response over 64 MiB')); else chunks.push(chunk); });
      response.on('error', (error) => { clearTimeout(timer); reject(error); });
      response.on('end', () => {
        clearTimeout(timer);
        const data = Buffer.concat(chunks);
        try { resolve(String(response.headers['content-type'] ?? '').includes('application/json') ? JSON.parse(data) : data.toString('utf8')); }
        catch { reject(new Error('invalid JSON response')); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error(`no complete answer in ${limitMs / 1000} s`)), limitMs);
    request.on('error', (error) => { clearTimeout(timer); reject(error); });
    request.end(body);
  });
}

/**
 * The service-contract client of kind remote-gate-http. `headers` are the credential headers serviceCredentialHeaders
 * resolved for it; `signal` (an AbortSignal) ends any request in flight; `transport` is injectable for tests.
 */
export function remoteGateHttp(service, { headers = {}, signal = undefined, transport = httpsTransport(service, headers, signal) } = {}) {
  return {
    health: () => transport('GET', '/health'),
    submit: (spec) => transport('POST', '/v1/jobs', spec),
    status: (jobId) => transport('GET', `/v1/jobs/${jobId}`),
    result: (jobId) => transport('GET', `/v1/jobs/${jobId}/result`),
    log: (jobId) => transport('GET', `/v1/jobs/${jobId}/artifacts/stdout.log`, undefined, 5 * 60_000),
    cancel: (jobId) => transport('POST', `/v1/jobs/${jobId}/cancel`, {}),
    source: ({ bytes, projectId, sha }) => transport('POST', '/v1/sources', undefined, 10 * 60_000, { bytes, projectId, sha }),
  };
}

/**
 * The unpublished commits of `sha` as a git bundle, for a service that accepts sources: `sha` must be the checkout's
 * HEAD (never a working tree), and the bundle holds HEAD and only the commits no origin branch has, so its prerequisites
 * are commits the service already fetched from origin. Returns { bytes, sha256 }, or { problem }.
 */
export async function bundleOf(sha, cwd = process.cwd()) {
  const head = await git(['rev-parse', 'HEAD'], { cwd, timeout: 30_000 });
  if (head.status !== 0 || head.stdout.trim() !== sha) return { problem: `${sha} is not this checkout's HEAD` };
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-bundle-'));
  try {
    const file = join(dir, 'source.bundle');
    if ((await git(['bundle', 'create', file, 'HEAD', '--not', '--remotes=origin'], { cwd, timeout: 120_000 })).status !== 0) {
      return { problem: 'git could not bundle the commits origin does not have' };
    }
    const bytes = readFileSync(file);
    if (bytes.length > MAX_BUNDLE_BYTES) return { problem: `the bundle is ${bytes.length} bytes; the limit is ${MAX_BUNDLE_BYTES}` };
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * A self-contained bundle of the exact commit `sha` (every object it reaches, no prerequisite), for a service with
 * `sources: "full"`, whose copy of the repository cannot fetch origin. `cwd` is any checkout that holds the commit; its
 * HEAD and working tree do not matter. The bundle is made in a new repository of its own that only borrows the
 * checkout's objects (objects/info/alternates), so nothing in the checkout changes and no checkout configuration
 * applies. Its one head is `refs/heads/aiworks-source` at `sha`. Returns { bytes, sha256 }, or { problem }, with
 * `tooLarge` when the bundle is over MAX_BUNDLE_BYTES.
 */
export async function fullBundleOf(sha, cwd = process.cwd()) {
  if (!SHA.test(sha ?? '')) return { problem: 'no exact commit to bundle' };
  const objects = await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd, timeout: 30_000 });
  const store = objects.status === 0 ? objects.stdout.trim() : '';
  if (!store || !isAbsolute(store)) return { problem: 'the checkout has no object store to bundle from' };
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-bundle-'));
  try {
    const repo = join(dir, 'source.git');
    const quiet = { cwd: dir, timeout: 30_000, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) } };
    if ((await git(['init', '-q', '--bare', repo], quiet)).status !== 0) return { problem: 'git could not make a repository for the bundle' };
    writeFileSync(join(repo, 'objects', 'info', 'alternates'), `${store}\n`);
    const own = { ...quiet, cwd: repo };
    if ((await git(['update-ref', 'refs/heads/aiworks-source', sha], own)).status !== 0) return { problem: `the checkout does not hold ${sha}` };
    const file = join(dir, 'source.bundle');
    if ((await git(['bundle', 'create', file, 'refs/heads/aiworks-source'], { ...own, timeout: 120_000 })).status !== 0) {
      return { problem: `git could not bundle every object of ${sha}` };
    }
    const bytes = readFileSync(file);
    if (bytes.length > MAX_BUNDLE_BYTES) return { problem: `the self-contained bundle of ${sha} is ${bytes.length} bytes; the limit is ${MAX_BUNDLE_BYTES}`, tooLarge: true };
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Why a service's receipt for an uploaded bundle does not match what was sent, or null. */
export function sourceProblem(receipt, { sha, projectId, bundle }) {
  if (!receipt || typeof receipt !== 'object' || !SOURCE_ID.test(receipt.sourceId ?? '')) return 'it answered without a sourceId';
  if (receipt.commitSha !== sha || receipt.projectId !== projectId) return 'its receipt names another commit or project';
  if (receipt.sizeBytes !== bundle.bytes.length || receipt.sha256 !== bundle.sha256) return 'its receipt names other bundle bytes than were sent';
  return null;
}

/**
 * Whether a service's terminal result counts as this gate's run, and as a pass or a failure. It counts only when it names
 * the job, project, profile and exact commit asked for. A pass also needs exit code 0 and the service's record of the full
 * gate command (a step ending in `npm run check`) having exited 0. A test failure counts as a failed gate. An
 * environment failure, a cancel or an interruption does not count: the gate then runs on this computer.
 */
export function acceptRemoteResult(result, { jobId, sha, projectId, profile, gate = null }) {
  if (!result || typeof result !== 'object') return { counted: false, reason: 'no result' };
  if (result.jobId !== jobId || result.projectId !== projectId || result.profile !== profile) return { counted: false, reason: 'the result names another job, project or profile' };
  if (result.requestedSha !== sha) return { counted: false, reason: `the result was asked for ${JSON.stringify(result.requestedSha)}, not ${sha}` };
  if (!TERMINAL.has(result.state)) return { counted: false, reason: `the job is ${JSON.stringify(result.state)}, not finished` };
  if (result.commitSha !== null && result.commitSha !== undefined && result.commitSha !== sha) return { counted: false, reason: `the service checked ${JSON.stringify(result.commitSha)}, not ${sha}` };
  if (result.state === 'passed') {
    if (result.exitCode !== 0 || result.commitSha !== sha) return { counted: false, reason: 'a pass without exit code 0 on the exact commit' };
    // The project's own gate, when its mapping names one: a step whose argv ends in exactly those words exited 0.
    const ends = (argv, words) => Array.isArray(argv) && argv.length >= words.length && words.every((word, at) => argv[argv.length - words.length + at] === word);
    const full = Array.isArray(result.commands) && result.commands.some((command) => command?.exitCode === 0 && (validGate(gate)
      ? ends(command.argv, gate) : String(command?.phase ?? '').endsWith('-check') && ends(command.argv, DEFAULT_GATE)));
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
 * A service that declares `auth` is offered the commit only through a credential `broker` (a token-store.mjs store that
 * the authorized caller passes in): without one, or when its reference does not resolve, the service is recorded as
 * unavailable and no request is sent. A refused request (HTTP 401 or 403) is recorded as unavailable, never as a result.
 */
export async function runOnService({ services, repository, sha, available = () => true, say: sayLine = () => {}, reference = 'gate',
  summaryRequired = false, client = remoteGateHttp, broker = null, sleep = sleepFor, now = Date.now, pollMs = 10_000, bundle = null }) {
  if (!SHA.test(sha ?? '') || !repository) return null;
  let listed = services.filter((service) => service.projects[repository.toLowerCase()]);
  if (!listed.length) return null;
  // A commit origin does not have goes only to a service that declared it accepts sources, and only as a bundle.
  let source = null;
  if (!(await available(sha))) {
    listed = bundle ? listed.filter(acceptsSources) : [];
    if (!listed.length) { sayLine(`# check services skipped: ${sha} is on no origin branch, and no service for it accepts sources`); return null; }
    source = await bundle(sha);
    if (!source?.bytes) { sayLine(plain(`# check services skipped: no bundle of ${sha} (${source?.problem ?? 'unavailable'})`)); return null; }
  }
  // The credential in use, if any, is cut from every line: a service's own words may echo a request header back.
  let secrets = [];
  const redact = (text) => secrets.reduce((cut, secret) => cut.split(secret).join('[credential]'), String(text));
  const say = (line) => sayLine(plain(redact(line)));
  const budgetEnd = now() + Math.min(MAX_TIMEOUT_MINUTES, Math.max(...listed.map((service) => service.timeoutMinutes))) * 60_000;
  for (const service of listed) {
    const project = service.projects[repository.toLowerCase()];
    const name = `check service ${service.name}`;
    const deadline = Math.min(budgetEnd, now() + service.timeoutMinutes * 60_000);
    // The service is told to stop a little before AIWorks stops waiting, so its answer can still arrive.
    const timeoutSeconds = Math.floor((deadline - now()) / 1000) - 60;
    if (timeoutSeconds < 300) { say(`# ${name} skipped: under five minutes of the check service budget left`); continue; }
    const credential = serviceCredentialHeaders(service, broker);
    secrets = [];
    if (credential.problem) { say(`# ${name} unavailable: ${credential.problem}; next service or this computer`); continue; }
    secrets = Object.values(credential.headers).flatMap((header) => [header, header.replace(/^Bearer /, '')]);
    const api = client(service, { headers: credential.headers });
    let jobId = null;
    try {
      const health = await api.health();
      if (health?.status !== 'ok') { say(`# ${name} skipped: health is ${JSON.stringify(health?.status ?? null)}`); continue; }
      let sourceId = null;
      if (source) {
        const receipt = await api.source({ bytes: source.bytes, projectId: project.projectId, sha });
        const problem = sourceProblem(receipt, { sha, projectId: project.projectId, bundle: source });
        if (problem) { say(`# ${name} skipped: ${problem}`); continue; }
        sourceId = receipt.sourceId;
        say(`# ${name} accepted source ${sourceId} for ${sha} (${source.bytes.length} bytes, sha256 ${source.sha256})`);
      }
      const spec = { idempotencyKey: `aiworks-gate-${sha.slice(0, 12)}-${now().toString(36)}`, projectId: project.projectId, commitSha: sha,
        profile: project.profile, timeoutSeconds, aiworksTaskId: String(reference).replace(/[^\w.-]+/g, '-').slice(0, 120), ...(sourceId ? { sourceId } : {}) };
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
      const verdict = acceptRemoteResult(await api.result(jobId), { jobId, sha, projectId: project.projectId, profile: project.profile, gate: project.gate ?? null });
      if (!verdict.counted) { say(`# ${name} job ${jobId} does not count: ${verdict.reason}; next service or this computer`); continue; }
      let text = '';
      try {
        const log = await api.log(jobId);
        text = redact(typeof log === 'string' ? log : JSON.stringify(log));
      } catch (error) { say(`# ${name} output of job ${jobId} unavailable (${error.message})`); }
      if (verdict.passed && (!text.trim() || (summaryRequired && !/^# all test files/m.test(text)))) {
        say(`# ${name} job ${jobId} passed, but does not count without its ${text.trim() ? 'test summary' : 'output'}; next service or this computer`);
        continue;
      }
      return { exit: verdict.passed ? 0 : 1, text, service: service.name, jobId };
    } catch (error) {
      if (jobId) await api.cancel(jobId).catch(() => {});
      const refused = error?.status === 401 || error?.status === 403;
      const why = !refused ? error?.message : service.auth ? `HTTP ${error.status}: the service refused the configured credential`
        : `HTTP ${error.status}: the service requires authentication, and no authentication contract is configured for it`;
      say(`# ${name} unavailable (${why}); next service or this computer`);
    }
  }
  return null;
}

/** The idempotency key of an offer: one per service, project and exact commit, so every retry asks for the same job. */
export const offerKey = (service, project, sha) => `aiworks-verified-${service.name}-${project.projectId}-${sha}`;

/**
 * Offers the exact verified commit `sha` of `repository` to one service, as information only (check-service-caller.mjs).
 * Unlike runOnService it never cancels a job, never stands in for a gate and never moves on to a local run. The job is
 * submitted under offerKey, so an offer that lost its receipt asks for the same job again; given the recorded `jobId` it
 * submits nothing and re-attaches. It waits at most the service's queueSeconds plus timeoutMinutes from `startedAt`; a
 * wait that ends leaves the job running. `source` (a bundleOf result) goes only to a service with `sources: true`.
 * `broker.get` may return a promise (token-store.mjs asyncTokenReader), so no credential lookup blocks the event loop.
 * `signal` ends a request in flight when the caller stops. `onSubmitted(jobId)` runs once the service accepted the job,
 * before any wait.
 * Returns { state, jobId, exitCode, summary, transient, refused }, state one of passed, test_failure,
 * environment_failure, not_counted, unavailable or timeout, with the service's words reduced to one plain line without
 * the credential. `transient` marks an `unavailable` that may pass (no answer, a server error, an unhealthy service, an
 * answer cut short): the caller asks again later rather than record it. `refused` marks an HTTP 401 or 403. Returns null
 * when `stopping()` ended the offer first (nothing to record: the next start re-attaches).
 */
export async function offerOnService({ service, repository, sha, jobId = null, startedAt = Date.now(), reference = 'verified', source = null,
  broker = null, client = remoteGateHttp, signal = undefined, onSubmitted = async () => {}, stopping = () => false, sleep = sleepFor,
  now = Date.now, pollMs = 30_000 }) {
  let secrets = [];
  const outcome = (state, summary, { exitCode = null, transient = false, refused = false } = {}) => ({ state, jobId, exitCode, transient, refused,
    summary: plain(secrets.reduce((cut, secret) => cut.split(secret).join('[credential]'), String(summary))) });
  const project = service?.projects?.[String(repository ?? '').toLowerCase()];
  if (!SHA.test(sha ?? '') || !project) return outcome('unavailable', 'the service is not configured for this repository');
  const credential = await serviceCredentialHeadersAsync(service, broker);
  if (credential.problem) return outcome('unavailable', credential.problem);
  secrets = Object.values(credential.headers).flatMap((header) => [header, header.replace(/^Bearer /, '')]);
  const api = client(service, { headers: credential.headers, signal });
  const deadline = startedAt + service.queueSeconds * 1000 + service.timeoutMinutes * 60_000;
  try {
    let state;
    if (jobId) state = (await api.status(jobId))?.state;
    else {
      const health = await api.health();
      if (health?.status !== 'ok') return outcome('unavailable', `health is ${JSON.stringify(health?.status ?? null)}`, { transient: true });
      let sourceId = null;
      if (source) {
        if (!acceptsSources(service)) return outcome('unavailable', 'the commit is on no origin branch, and the service does not accept sources');
        if (stopping()) return null;
        const receipt = await api.source({ bytes: source.bytes, projectId: project.projectId, sha });
        const problem = sourceProblem(receipt, { sha, projectId: project.projectId, bundle: source });
        if (problem) return outcome('unavailable', problem);
        sourceId = receipt.sourceId;
      }
      if (stopping()) return null;
      const submitted = await api.submit({ idempotencyKey: offerKey(service, project, sha), projectId: project.projectId, commitSha: sha,
        profile: project.profile, timeoutSeconds: Math.max(300, service.timeoutMinutes * 60 - 60),
        aiworksTaskId: String(reference).replace(/[^\w.-]+/g, '-').slice(0, 120), ...(sourceId ? { sourceId } : {}) });
      if (!JOB_ID.test(submitted?.jobId ?? '') || submitted.spec?.commitSha !== sha || submitted.spec?.projectId !== project.projectId
        || submitted.spec?.profile !== project.profile) return outcome('unavailable', 'it answered the submission for another job');
      jobId = submitted.jobId;
      await onSubmitted(jobId);
      state = submitted.state;
    }
    let unknown = 0;
    while (!TERMINAL.has(state)) {
      // A state outside the contract twice in a row: the service is not answering as agreed.
      unknown = KNOWN.has(state) ? 0 : unknown + 1;
      if (unknown >= 2) return outcome('unavailable', `it answers state ${JSON.stringify(state ?? null)}, which the contract does not name`);
      if (now() >= deadline) return outcome('timeout', `no answer within ${service.queueSeconds} s in the queue and ${service.timeoutMinutes} min of running; the job was left to finish`);
      if (stopping()) return null;
      await sleep(Math.max(0, Math.min(pollMs, deadline - now())));
      if (stopping()) return null;
      state = (await api.status(jobId))?.state;
    }
    const result = await api.result(jobId);
    const exitCode = Number.isSafeInteger(result?.exitCode) ? result.exitCode : null;
    const verdict = acceptRemoteResult(result, { jobId, sha, projectId: project.projectId, profile: project.profile, gate: project.gate ?? null });
    if (verdict.counted) {
      // The output's node:test counts, when it has them, make the summary; a pass without any output does not count.
      // Output that could not be read is asked for again later, never taken for missing output. A job the service
      // finished without an output file (HTTP 404 on the log alone) has empty output: its own state stays the verdict.
      let log;
      try { log = await api.log(jobId); } catch (error) {
        if (error?.status !== 404) throw error;
        log = '';
      }
      const text = typeof log === 'string' ? log : JSON.stringify(log ?? '');
      const counts = [...text.matchAll(/^# (tests|pass|fail) (\d+)\s*$/gm)].slice(-3).map((match) => `${match[1]} ${match[2]}`).join(', ');
      if (verdict.passed && !text.trim()) return outcome('not_counted', 'a pass without its output', { exitCode });
      if (verdict.passed) return outcome('passed', `the full gate passed on the exact commit${counts ? ` (${counts})` : ''}`, { exitCode });
      const failed = Array.isArray(result.commands) ? result.commands.find((command) => command?.exitCode !== 0) : null;
      return outcome('test_failure', `the gate failed${failed?.phase ? ` in ${failed.phase}` : ''} (exit ${exitCode}${counts ? `; ${counts}` : ''})`, { exitCode });
    }
    if (result?.jobId === jobId && result.requestedSha === sha && ['environment_failure', 'cancelled', 'interrupted'].includes(result.state)) {
      return outcome('environment_failure', `the service ended with ${result.state}, which says nothing about the code`, { exitCode });
    }
    return outcome('not_counted', verdict.reason, { exitCode });
  } catch (error) {
    if (stopping()) return null;
    const status = error?.status;
    if (status === 401 || status === 403) {
      return outcome('unavailable', service.auth ? `HTTP ${status}: the service refused the configured credential`
        : `HTTP ${status}: the service requires authentication, and no authentication contract is configured for it`, { refused: true });
    }
    if (status === 404 && jobId) return outcome('unavailable', `HTTP 404: the service does not know job ${jobId}`);
    // No answer, an answer cut short, a server error or a rate limit may pass; another client error will not.
    const transient = status === undefined || status === 429 || status >= 500;
    return outcome('unavailable', error?.message ?? 'no answer', { transient });
  }
}
