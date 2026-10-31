// The Docker gate, after the host crash of 2026-10-31: up to ten workers each brought up their own Docker stack, merge-
// refresh gates more, and the PC ran out of TCP ports and crashed. Workers themselves are not the scarce resource; Docker
// is. The gate is one machine-wide limit on Docker, enforced in one place instead of in every project's scripts.
//
// It is a Docker API proxy on a named pipe. `serve` starts it (cli.mjs docker-gate) and gives every worker, and every
// refresh gate, DOCKER_HOST pointing at it, so every Docker client they use (the docker CLI, Compose, test libraries)
// goes through it. Every request is forwarded to the engine unchanged, except that starting a container waits while all
// slots are taken. A slot is one running Compose project, or one running container outside Compose, or one image
// build while it runs. The count is read from the engine on every decision, so it includes what anything else on this
// computer runs, survives a restart of the gate and needs no state of its own; a start admitted in the last minute counts
// until its containers show as running. Starting another container of a project that already runs never waits.
//
// config.json `docker`: { "slots": 2, "gate": true }. Off unless `gate` is true: one gate serves the whole computer, so an
// installation opts in (a test or second data directory never takes the machine-wide pipe by default).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const GATE_PIPE = '\\\\.\\pipe\\aiworks-docker-gate';
const DEFAULT_SLOTS = 2;

/** `docker` from config.json: { slots, gate } with defaults (2 slots, off). */
export function gateSettings(config) {
  const value = config?.docker ?? {};
  const slots = Number.isSafeInteger(value.slots) && value.slots >= 1 && value.slots <= 16 ? value.slots : DEFAULT_SLOTS;
  return { slots, gate: value.gate === true };
}

/** DOCKER_HOST for a named pipe: \\.\pipe\name -> npipe:////./pipe/name. */
export const pipeHost = (pipe) => `npipe://${pipe.replaceAll('\\', '/')}`;
/** The named pipe of an npipe:// DOCKER_HOST, or null for any other kind of host. */
export function hostPipe(host) {
  const match = /^npipe:\/\/\/?\/?\.\/pipe\/(.+)$/.exec(host ?? '');
  return match ? `\\\\.\\pipe\\${match[1]}` : null;
}

const START = /^\/(?:v[\d.]+\/)?containers\/([^/?]+)\/start(?:\?|$)/;
const BUILD = /^\/(?:v[\d.]+\/)?build(?:\?|$)/;
const PROJECT = 'com.docker.compose.project';
// Java and Go label the session `org.testcontainers.sessionId`; Node and Python `org.testcontainers.session-id`.
const TESTCONTAINERS = ['org.testcontainers.sessionId', 'org.testcontainers.session-id'];

/**
 * A gate in front of the engine at `engine` (a named pipe or socket path). `listen(server)` is left to the caller.
 * Returns { server, occupancy, acquire }: occupancy() is the set of slot keys in use now, acquire(key) resolves when `key`
 * may start. `pollMs` is how often a waiting start looks again; `graceMs` how long an admitted start counts before its
 * containers show as running. A start never waits longer than `maxWaitMs`: it is then forwarded with a log line, so two
 * workers that each wait for the other's stack cannot hold each other forever.
 */
export function createDockerGate({ engine, slots = DEFAULT_SLOTS, log = () => {}, now = Date.now, pollMs = 2_000, graceMs = 60_000, maxWaitMs = 600_000 }) {
  const admitted = new Map(); // key -> time admitted, until the engine shows it running or the grace ends
  const builds = new Set();

  const engineJson = (path) => new Promise((done, fail) => {
    const req = http.request({ socketPath: engine, path, method: 'GET', headers: { host: 'docker' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) { fail(new Error(`engine ${path}: HTTP ${res.statusCode}`)); return; }
        try { done(JSON.parse(body)); } catch (error) { fail(error); }
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`engine ${path}: timed out`)));
    req.on('error', fail);
    req.end();
  });

  // One slot per Compose project, per Testcontainers session (its reaper and every container it starts) or per loose container.
  const keyOf = (container) => {
    const labels = container.Labels ?? {};
    if (labels[PROJECT]) return `project:${labels[PROJECT]}`;
    const session = TESTCONTAINERS.map((name) => labels[name]).find(Boolean);
    return session ? `testcontainers:${session}` : `container:${container.Id}`;
  };

  async function occupancy() {
    const running = await engineJson('/containers/json');
    const keys = new Set(running.map(keyOf));
    for (const [key, at] of admitted) {
      if (keys.has(key) || now() - at >= graceMs) admitted.delete(key);
      else keys.add(key);
    }
    for (const key of builds) keys.add(key);
    return keys;
  }

  async function acquire(key, { closed = () => false } = {}) {
    let said = false;
    const since = now();
    for (;;) {
      if (closed()) return false;
      if (now() - since >= maxWaitMs) {
        log(`waited ${Math.round(maxWaitMs / 60_000)} min for ${key}: forwarded without a slot`);
        return true;
      }
      const keys = await occupancy();
      // Checked and recorded with no await in between, so two starts never take the last slot together.
      if (keys.has(key)) return true;
      if (keys.size < slots) {
        admitted.set(key, now());
        log(`admitted ${key} (${keys.size + 1} of ${slots} Docker slots)`);
        return true;
      }
      if (!said) log(`waiting: ${key} (all ${slots} Docker slots in use: ${[...keys].join(', ')})`);
      said = true;
      await sleep(pollMs);
    }
  }

  function forward(req, res) {
    const upstream = http.request({ socketPath: engine, path: req.url, method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode, answer.statusMessage, answer.rawHeaders);
      answer.pipe(res);
    });
    // A client that goes away (an interrupted `docker logs -f` or `docker events`) closes its engine stream too.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    upstream.on('error', (error) => {
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: `docker gate: ${error.message}` })); }
      else res.destroy(error);
    });
    req.pipe(upstream);
    return upstream;
  }

  const server = http.createServer(async (req, res) => {
    let gone = false;
    res.on('close', () => { gone = true; });
    try {
      const start = START.exec(req.url);
      if (req.method === 'POST' && start) {
        const container = await engineJson(`/containers/${start[1]}/json`).catch(() => null);
        // An unknown container is the engine's to refuse: forward it as it is.
        if (container && !(await acquire(keyOf({ ...container, Labels: container.Config?.Labels }), { closed: () => gone }))) return;
      } else if (req.method === 'POST' && BUILD.test(req.url)) {
        const key = `build:${now()}:${Math.random().toString(36).slice(2)}`;
        if (!(await acquire(key, { closed: () => gone }))) return;
        builds.add(key);
        admitted.delete(key);
        res.on('close', () => builds.delete(key));
      }
    } catch (error) {
      // The engine could not be read: forward, and the engine answers for itself.
      log(`gate check failed (${error.message}); forwarding ${req.method} ${req.url}`);
    }
    if (!gone) forward(req, res);
  });
  // attach, exec and other hijacked streams: pass the bytes through both ways.
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(engine, () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      upstream.write('\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  server.keepAliveTimeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  return { server, occupancy, acquire };
}

/** Whether something answers on the named pipe now. */
export function gateListening(pipe = GATE_PIPE, timeoutMs = 2_000) {
  return new Promise((done) => {
    const socket = net.connect(pipe);
    const end = (value) => { socket.destroy(); done(value); };
    socket.setTimeout(timeoutMs, () => end(false));
    socket.on('connect', () => end(true));
    socket.on('error', () => end(false));
  });
}

/**
 * The engine endpoint the docker CLI would use without the gate: the operator's own DOCKER_HOST when it names a pipe
 * other than the gate, else the current context's host, read with DOCKER_HOST removed so it can never be the gate itself.
 * A named pipe path, or null when docker is missing or names no pipe.
 */
export function engineEndpoint(docker = ['docker'], pipe = GATE_PIPE) {
  const own = process.env.DOCKER_HOST ? hostPipe(process.env.DOCKER_HOST) : null;
  if (own && own.toLowerCase() !== pipe.toLowerCase()) return Promise.resolve(own);
  // An operator engine that is not a named pipe (tcp://, ssh://) is one the gate cannot serve: refuse rather than pick another.
  if (process.env.DOCKER_HOST && !own) return Promise.resolve(null);
  return new Promise((done) => {
    const env = { ...process.env };
    delete env.DOCKER_HOST;
    const [cmd, ...prefix] = docker;
    execFile(cmd, [...prefix, 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env },
      (error, stdout) => done(error ? null : hostPipe(stdout.trim())));
  });
}

/**
 * The gate process (cli.mjs docker-gate): listens on `pipe` until `stopFile` exists and no client is connected. A second
 * instance finds the pipe taken and exits at once. Resolves to an exit code.
 */
export async function serveGate({ config, stopFile, log = () => {}, docker = ['docker'], pipe = GATE_PIPE }) {
  const settings = gateSettings(config);
  const engine = config?.docker?.engine ? hostPipe(config.docker.engine) : await engineEndpoint(docker, pipe);
  if (!engine) { log('docker gate not started: no Docker engine pipe found (docker context inspect)'); return 1; }
  if (engine.toLowerCase() === pipe.toLowerCase()) { log(`docker gate not started: the engine endpoint ${engine} is the gate itself`); return 1; }
  const gate = createDockerGate({ engine, slots: settings.slots, log });
  let open = 0;
  gate.server.on('connection', (socket) => { open += 1; socket.on('close', () => { open -= 1; }); });
  try {
    await new Promise((done, fail) => { gate.server.once('error', fail); gate.server.listen(pipe, done); });
  } catch (error) {
    if (error.code === 'EADDRINUSE') { log('docker gate already running'); return 0; }
    throw error;
  }
  log(`docker gate listening on ${pipe} for ${engine} with ${settings.slots} slot(s)`);
  // It ends with its installation: on the STOP file once no client is connected, or at once when the data directory is gone.
  const home = dirname(stopFile);
  while (existsSync(home) && !(existsSync(stopFile) && open === 0)) await sleep(5_000);
  gate.server.close();
  log(existsSync(home) ? 'docker gate stopped (STOP file)' : 'docker gate stopped (data directory removed)');
  return 0;
}
