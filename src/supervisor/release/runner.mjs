// The release runner: one release command in its own clean process (docs/design/AUTO_RELEASE.md section 6, slice REL5).
// Built switched off: with `release.enabled` not true in config.json the runner is never started, and no release
// credential exists until the owner answers netbka/aiworks#33 item 2. How one step runs:
// 1. the supervisor (runReleaseCommand) writes a packet that names the command, its working directory and the
//    credential by reference only, then starts `node runner.mjs --release-step <packet>` with a clean environment:
//    only PATH and SystemRoot, never the supervisor's own variables (workerEnv copies them; this does not). On Windows,
//    libuv adds its fixed set of system variables (user name, profile, TEMP and the like) to every child it starts;
//    they name the machine and user, not the supervisor's configuration;
// 2. that process fetches the credential by reference, at that moment, and runs the one command with it in GH_TOKEN.
//    A reference that does not resolve runs nothing;
// 3. it writes the output, with the value masked, and the result beside the packet, and exits. The supervisor journals
//    the command (never a secret), start, end, exit code and output digest.
// The value lives only in the runner process and the command it starts. It is never written to disk, SQLite, a log,
// the journal or a packet, and never placed in the supervisor's environment. The callers that merge, deploy or apply
// (slices REL6 to REL8) live in this directory too; tests/supervisor/release-boundary.test.mjs keeps them here.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonIfExists, writeAtomic } from '../proc.mjs';
import { credentialStoreFrom, fetchCredential, validCredentialRef } from './credential.mjs';

export const RELEASE_RUNNER = fileURLToPath(import.meta.url);
/** The only inherited variables a release process keeps (AUTO_RELEASE.md section 6). */
export const RELEASE_ENV_KEEP = Object.freeze(['PATH', 'SystemRoot']);
const MASK = '[credential withheld]';
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OUTPUT_LIMIT = 8 * 1024 * 1024;

/** A clean environment: PATH and SystemRoot from `inherited` (matched case-insensitively, as Windows does), then `extra`. */
export function releaseEnv(inherited, extra = {}) {
  const kept = {};
  for (const [key, value] of Object.entries(inherited ?? {})) {
    const name = RELEASE_ENV_KEEP.find((keep) => keep.toLowerCase() === key.toLowerCase());
    if (name && typeof value === 'string' && !(name in kept)) kept[name] = value;
  }
  return { ...kept, ...extra };
}

const digest = (text) => createHash('sha256').update(text).digest('hex');
const masked = (text, secret) => (secret ? String(text).replaceAll(secret, MASK) : String(text));

/**
 * Run one release command at the supervisor's request. `command` is [file, ...args], run without a shell in `cwd`.
 * `credential` is { ref } (fetched by the runner for this command only) or null. `stepKey` is runStep's
 * `<release id>.<step>.<n>`; the packet, result and output live in `<dataDir>/releases/<stepKey>/`. With a `store` and
 * the `release` row, the command is journalled. Returns { ran, exitCode, signal, reason, output, outputDigest,
 * startedAt, endedAt }; `ran` is false when nothing was run (the credential did not resolve). Throws when release is
 * switched off (nothing is started) and when the runner gives no result (the outcome is then unknown).
 */
export async function runReleaseCommand({ config, dataDir, stepKey, command, cwd, credential = null, timeoutMs = 600_000,
  store = null, release = null, inherited = process.env, start = startRunner, now = Date.now }) {
  if (config?.release?.enabled !== true) throw new Error('Auto Release is switched off (release.enabled is not true): the release runner is not started');
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('the release runner needs the supervisor data directory');
  if (!KEY.test(stepKey ?? '')) throw new TypeError('the release step key must be a plain name');
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || !part)) throw new TypeError('a release command is a non-empty array');
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('a release command needs its release working directory');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('a release command needs a positive timeout');
  if (credential !== null && !validCredentialRef(credential?.ref)) throw new TypeError('a release credential is named by reference only');
  const dir = join(dataDir, 'releases', stepKey);
  mkdirSync(dir, { recursive: true });
  const packet = join(dir, 'packet.json');
  writeAtomic(packet, JSON.stringify({ version: 1, stepKey, command, cwd: resolve(cwd), timeoutMs,
    credential: credential && { ref: credential.ref, store: config.release.credentialStore ?? { kind: 'windows' } } }, null, 2));
  const startedAt = new Date(now()).toISOString();
  const exit = await start(packet, { cwd: resolve(cwd), env: releaseEnv(inherited), timeoutMs: timeoutMs + 30_000 });
  const result = readJsonIfExists(join(dir, 'result.json'));
  const endedAt = new Date(now()).toISOString();
  if (store && release) {
    store.journal(release.campaign_id, 'release-command', { release: release.id, key: stepKey, command, cwd: resolve(cwd),
      credentialRef: credential?.ref ?? null, startedAt, endedAt, ran: result?.ran ?? null, exitCode: result?.exitCode ?? null,
      outputDigest: result?.outputDigest ?? null, reason: result?.reason ?? null }, now());
  }
  if (!result) throw new Error(`the release runner gave no result (runner exit ${exit.code ?? exit.signal})`);
  return { ...result, startedAt, endedAt };
}

/** Start the runner process and wait for it. A runner past its deadline is killed; its missing result is unknown. */
function startRunner(packet, { cwd, env, timeoutMs }) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, ['--no-warnings', RELEASE_RUNNER, '--release-step', packet], { cwd, env, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolveExit({ code: null, signal: 'spawn-failed' }); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); });
  });
}

/** Inside the runner process: fetch the credential, run the one command, write the masked output and the result. */
async function runStepProcess(packetPath) {
  const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
  const dir = resolve(packetPath, '..');
  const finish = (result) => writeAtomic(join(dir, 'result.json'), JSON.stringify({ version: 1, ...result }, null, 2));
  let secret = null;
  if (packet.credential) {
    try { secret = fetchCredential(credentialStoreFrom(packet.credential.store), packet.credential.ref); }
    catch (error) { return finish({ ran: false, exitCode: null, signal: null, reason: `the release credential could not be read: ${masked(error.message, secret)}`, output: '', outputDigest: null }); }
    if (secret === null) return finish({ ran: false, exitCode: null, signal: null, reason: `the release credential reference ${packet.credential.ref} does not resolve`, output: '', outputDigest: null });
  }
  const env = releaseEnv(process.env, secret ? { GH_TOKEN: secret } : {});
  const [file, ...args] = packet.command;
  const out = await new Promise((done) => execFile(file, args, { cwd: packet.cwd, env, timeout: packet.timeoutMs, maxBuffer: OUTPUT_LIMIT,
    windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => done({ error, stdout: stdout ?? '', stderr: stderr ?? '' })));
  const output = masked(`${out.stdout}${out.stderr ? `\n--- stderr ---\n${out.stderr}` : ''}`, secret);
  writeAtomic(join(dir, 'output.log'), output);
  const exitCode = out.error ? (Number.isInteger(out.error.code) ? out.error.code : null) : 0;
  const reason = out.error && exitCode === null ? masked(out.error.killed ? 'the command timed out' : `the command could not run: ${out.error.code ?? out.error.message}`, secret) : null;
  finish({ ran: true, exitCode, signal: out.error?.signal ?? null, reason, output, outputDigest: digest(output) });
}

const self = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
if (process.argv[2] === '--release-step' && process.argv[1] && self(process.argv[1]) === self(RELEASE_RUNNER)) {
  await runStepProcess(process.argv[3]);
}
