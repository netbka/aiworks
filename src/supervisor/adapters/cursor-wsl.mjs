// Optional Cursor research transport for Windows installations with a supported WSL sandbox.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const PYTHON = fileURLToPath(new URL('./cursor-wsl.py', import.meta.url));
const WSL = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'wsl.exe');
const MAX = 1_100_000;
const inside = (root, path) => { const p = relative(root, path); return p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p); };
const read = (path) => {
  if (!statSync(path).isFile() || statSync(path).size > MAX) throw new Error('Invalid Cursor WSL record');
  return JSON.parse(readFileSync(path, 'utf8'));
};
const canonical = (path, directory) => {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Cursor WSL requires absolute paths');
  const result = realpathSync(path);
  if (directory ? !statSync(result).isDirectory() : !statSync(result).isFile()) throw new Error('Invalid Cursor WSL path type');
  return result;
};
export function linuxPath(path) {
  const p = path.replaceAll('\\', '/');
  if (!/^[A-Za-z]:\//.test(p) || /[\x00-\x1f]/.test(p)) throw new Error('Cursor WSL requires a local Windows drive');
  return '/mnt/' + p[0].toLowerCase() + p.slice(2);
}
const validNonce = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value ?? '');
const distribution = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value);

export function isCursorWsl(command) {
  return Array.isArray(command) && command.length === 4 && resolve(command[1] ?? '') === SELF && command[2] === '--config';
}

export function cursorWslInvocation(command, { runDir, cwd, configDir, dataDir, model, timeoutMs }) {
  if (!isCursorWsl(command) || process.platform !== 'win32') throw new Error('Unsupported Cursor WSL launcher');
  const config = read(canonical(command[3], false));
  const keys = ['version', 'distribution', 'allowedRoot', 'packageRoot', 'credentialFile', 'allowedModels'];
  if (Object.keys(config).some((key) => !keys.includes(key)) || config.version !== 1 || !distribution(config.distribution) ||
      !Array.isArray(config.allowedModels) || !config.allowedModels.length ||
      config.allowedModels.some((m) => typeof m !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,100}$/i.test(m) || /^auto$/i.test(m)) ||
      !config.allowedModels.includes(model)) throw new Error('Cursor WSL model or configuration is not authorized');
  const root = canonical(config.allowedRoot, true), run = canonical(runDir, true);
  const paths = { package: canonical(config.packageRoot, true), credential: canonical(config.credentialFile, false),
    scratch: canonical(cwd, true), config: canonical(configDir, true), data: canonical(dataDir, true) };
  if (!inside(root, run) || !inside(root, paths.package) ||
      !['scratch', 'config', 'data'].every((key) => inside(run, paths[key]) && paths[key] !== run) ||
      new Set([paths.scratch, paths.config, paths.data]).size !== 3) throw new Error('Cursor WSL mount escapes its assigned root');
  const overlaps = (a, b) => inside(a, b) || inside(b, a);
  const writable = [paths.scratch, paths.config, paths.data];
  if (overlaps(run, paths.package) || inside(run, paths.credential) ||
      writable.some((path, i) => writable.slice(i + 1).some((other) => overlaps(path, other)))) {
    throw new Error('Cursor WSL mounts overlap');
  }
  for (const file of ['node', 'index.js']) if (!inside(paths.package, canonical(join(paths.package, file), false))) throw new Error('Cursor executable escapes its package');
  const boundedMs = Math.min(timeoutMs ?? 900_000, 900_000);
  if (!Number.isSafeInteger(boundedMs) || boundedMs < 30_000) throw new Error('Invalid Cursor WSL time bound');
  mkdirSync(join(paths.scratch, 'home'), { recursive: true });
  const nonce = randomUUID(), requestFile = join(run, 'wsl-request.json');
  const argv = ['--print', '--trust', '--mode', 'ask', '--sandbox', 'enabled', '--disable-project-configs',
    '--exclude-workspace-context', '--disable-auto-update', '--single-turn',
    '--allowed-tools', 'read_todos_tool_call', '--output-format', 'stream-json', '--model', model];
  const request = { version: 1, nonce, distribution: config.distribution,
    paths: Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, linuxPath(value)])),
    argv, timeoutMs: boundedMs };
  writeFileSync(requestFile, JSON.stringify(request), { flag: 'wx' });
  writeFileSync(join(run, 'wsl-state.json'), JSON.stringify({ nonce, phase: 'reserved' }), { flag: 'wx' });
  const externalContainment = { kind: 'cursor-wsl-v1', nonce, distribution: config.distribution, requestFile };
  return { argv: [command[0], SELF, 'run', requestFile], externalContainment };
}

function cleanupArgs(external) {
  if (external?.kind !== 'cursor-wsl-v1' || !validNonce(external.nonce) || !distribution(external.distribution)) throw new Error('Invalid external custody');
  const file = canonical(external.requestFile, false), request = read(file);
  if (request.version !== 1 || request.nonce !== external.nonce || request.distribution !== external.distribution ||
      !existsSync(join(dirname(file), 'wsl-state.json'))) throw new Error('External custody identity changed');
  return ['--distribution', external.distribution, '--exec', '/usr/bin/python3', '-I', '-S', linuxPath(PYTHON), 'cleanup', linuxPath(file)];
}

export function cursorWslCleanupResult(output, external) {
  if (output?.status !== 0 || output.error || !validNonce(external?.nonce)) return 'ownership-unavailable';
  try {
    const result = JSON.parse(output.stdout);
    return Object.keys(result).sort().join(',') === 'nonce,stopped,version' &&
      result.version === 1 && result.nonce === external.nonce && result.stopped === true
      ? 'stopped' : 'ownership-unavailable';
  } catch { return 'ownership-unavailable'; }
}

export function stopCursorWsl(external) {
  try {
    const out = spawnSync(WSL, cleanupArgs(external), { encoding: 'utf8', windowsHide: true, timeout: 45_000, maxBuffer: MAX });
    return cursorWslCleanupResult(out, external);
  } catch { return 'ownership-unavailable'; }
}

export async function stopCursorWslAsync(external) {
  let args;
  try { args = cleanupArgs(external); } catch { return 'ownership-unavailable'; }
  return new Promise((done) => {
    const child = spawn(WSL, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 45_000);
    child.stdout.on('data', (bytes) => { output += bytes; if (output.length > MAX) { failed = true; child.kill(); } });
    child.on('error', () => { clearTimeout(timer); done('ownership-unavailable'); });
    child.on('close', (code) => { clearTimeout(timer); done(cursorWslCleanupResult({ status: code, stdout: output, error: failed }, external)); });
  });
}

async function launch(requestFile) {
  const file = canonical(requestFile, false), request = read(file);
  if (request.version !== 1 || !validNonce(request.nonce) || !distribution(request.distribution)) throw new Error('Invalid Cursor WSL launch');
  const chunks = [];
  let length = 0;
  for await (const bytes of process.stdin) {
    length += bytes.length;
    if (length > 1_000_000) throw new Error('Cursor WSL prompt exceeds its bound');
    chunks.push(bytes);
  }
  const prompt = Buffer.concat(chunks).toString('utf8');
  const child = spawn(WSL, ['--distribution', request.distribution, '--exec', '/usr/bin/python3', '-I', '-S',
    linuxPath(PYTHON), 'run', linuxPath(file)], { windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
  let closed = false;
  const send = (value) => { if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n'); };
  const timer = setInterval(() => send({ nonce: request.nonce, heartbeat: true }), 1000);
  child.stdin.on('error', () => { closed = true; clearInterval(timer); });
  const code = await new Promise((done) => {
    child.once('error', () => done(1));
    child.once('close', (value) => done(value ?? 1));
    send({ nonce: request.nonce, prompt });
  });
  closed = true;
  clearInterval(timer);
  process.exitCode = code;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  if (process.argv.length !== 4 || process.argv[2] !== 'run') {
    console.error('Cursor WSL accepts only a controller-created run request');
    process.exitCode = 2;
  } else {
    launch(process.argv[3]).catch(() => { console.error('Cursor WSL launcher failed'); process.exitCode = 1; });
  }
}
