#!/usr/bin/env node
// An Infisical credential helper for the `{ kind: 'command' }` token store (src/supervisor/token-store.mjs
// commandTokenStore; docs/SUPERVISOR.md section 16). It answers the helper protocol for one Infisical project,
// environment and folder:
//
//   node scripts/infisical-credential-helper.mjs [--env-file <path>] --project <id> --environment <slug> [--path </folder>]
//        [--allow <ref> ...] has|get|set <ref>
//
// - `has <ref>` exits 0 when the secret exists, 1 when it does not; `get <ref>` prints the value and exits 0, or exits 1
//   when absent; `set <ref>` reads the value from stdin and creates or updates the secret.
// - Without `--allow`, every reference in the configured folder is answered. With `--allow`, only those are; any other
//   reference exits 3 (refused) without contacting Infisical.
// - A store that cannot tell (Infisical unreachable, login refused, an unexpected answer) exits 4, never 1: the
//   callers treat "cannot tell" as refused, never as absent. Usage errors exit 2.
// - The machine identity (universal auth) comes from INFISICAL_HOST, INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET,
//   in the environment or in the `--env-file`. The client secret and the access token travel only in HTTPS request
//   bodies and headers: never in a command line, stdout or stderr. Only `get` prints anything to stdout, the value.
// - A reference maps to an Infisical key by uppercasing it and turning every other character into `_`:
//   `aiworks-campaign-api:sampleapp` -> `AIWORKS_CAMPAIGN_API_SAMPLEAPP`.
import { readFileSync } from 'node:fs';

const EXIT = { ok: 0, absent: 1, usage: 2, refused: 3, unavailable: 4 };
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]*([/:][A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const TIMEOUT_MS = 20_000;

class HelperError extends Error {
  constructor(exit, message) { super(message); this.exit = exit; }
}

const infisicalKey = (ref) => ref.toUpperCase().replace(/[^A-Z0-9]/g, '_');

function parseArgs(argv) {
  const options = { allow: [], path: '/' };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new HelperError(EXIT.usage, `${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--env-file') options.envFile = value();
    else if (arg === '--project') options.project = value();
    else if (arg === '--environment') options.environment = value();
    else if (arg === '--path') options.path = value();
    else if (arg === '--allow') options.allow.push(value());
    else if (arg.startsWith('--')) throw new HelperError(EXIT.usage, `unknown option ${arg}`);
    else positional.push(arg);
  }
  const [op, ref, ...extra] = positional;
  if (!['has', 'get', 'set'].includes(op) || !ref || extra.length) throw new HelperError(EXIT.usage, 'expected has|get|set <ref>');
  if (!options.project || !options.environment) throw new HelperError(EXIT.usage, '--project and --environment are required');
  if (!options.path.startsWith('/')) throw new HelperError(EXIT.usage, '--path is an Infisical folder starting with /');
  if (!REF.test(ref) || ref.length > 128) throw new HelperError(EXIT.usage, 'the reference is not a valid credential reference');
  return { ...options, op, ref };
}

/** KEY=VALUE lines; blank lines and # comments are ignored; one pair of surrounding quotes is removed. */
function readEnvFile(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { throw new HelperError(EXIT.unavailable, 'the --env-file cannot be read'); }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

function identity(options) {
  const source = options.envFile ? { ...process.env, ...readEnvFile(options.envFile) } : process.env;
  const { INFISICAL_HOST: host, INFISICAL_CLIENT_ID: clientId, INFISICAL_CLIENT_SECRET: clientSecret } = source;
  if (!host || !clientId || !clientSecret) {
    throw new HelperError(EXIT.unavailable, 'INFISICAL_HOST, INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET are required');
  }
  let url;
  try { url = new URL(host); } catch { throw new HelperError(EXIT.unavailable, 'INFISICAL_HOST is not a URL'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  // The client secret travels in a request body: plain http is accepted only to this computer itself.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new HelperError(EXIT.unavailable, 'INFISICAL_HOST must be https');
  }
  return { base: url.origin + url.pathname.replace(/\/+$/, ''), clientId, clientSecret };
}

async function request(url, init) {
  try {
    // A 307/308 redirect would forward the identity secret or a set payload to its new destination.
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new HelperError(EXIT.unavailable, 'Infisical cannot be reached');
  }
}

async function login({ base, clientId, clientSecret }) {
  const response = await request(`${base}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!response.ok) throw new HelperError(EXIT.unavailable, `Infisical refused the login (HTTP ${response.status})`);
  const token = (await response.json().catch(() => ({}))).accessToken;
  if (typeof token !== 'string' || !token) throw new HelperError(EXIT.unavailable, 'Infisical login answered without an access token');
  return token;
}

/** The secret's value, or null when Infisical answers that it does not exist. */
async function readSecret(base, token, options, key) {
  const query = new URLSearchParams({ workspaceId: options.project, environment: options.environment, secretPath: options.path, type: 'shared' });
  const response = await request(`${base}/api/v3/secrets/raw/${encodeURIComponent(key)}?${query}`, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 404) return null;
  if (!response.ok) throw new HelperError(EXIT.unavailable, `Infisical could not read the secret (HTTP ${response.status})`);
  const value = (await response.json().catch(() => ({}))).secret?.secretValue;
  if (typeof value !== 'string') throw new HelperError(EXIT.unavailable, 'Infisical answered without a secret value');
  return value;
}

async function writeSecret(base, token, options, key, value, exists) {
  const response = await request(`${base}/api/v3/secrets/raw/${encodeURIComponent(key)}`, {
    method: exists ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: options.project, environment: options.environment, secretPath: options.path, secretValue: value, type: 'shared' }),
  });
  if (!response.ok) throw new HelperError(EXIT.unavailable, `Infisical could not store the secret (HTTP ${response.status})`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.allow.length && !options.allow.includes(options.ref)) throw new HelperError(EXIT.refused, 'this reference is not on the helper\'s --allow list');
  const value = options.op === 'set' ? await readStdin() : null;
  if (options.op === 'set' && !value) throw new HelperError(EXIT.usage, 'set reads a non-empty value from stdin');
  const id = identity(options);
  const token = await login(id);
  const key = infisicalKey(options.ref);
  const current = await readSecret(id.base, token, options, key);
  if (options.op === 'has') return current === null ? EXIT.absent : EXIT.ok;
  if (options.op === 'get') {
    if (current === null) return EXIT.absent;
    process.stdout.write(`${current}\n`);
    return EXIT.ok;
  }
  await writeSecret(id.base, token, options, key, value, current !== null);
  return EXIT.ok;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    // Messages name only the step and an HTTP status: never a value, token, secret or response body.
    process.stderr.write(`infisical-credential-helper: ${error instanceof HelperError ? error.message : 'unexpected failure'}\n`);
    process.exitCode = error instanceof HelperError ? error.exit : EXIT.unavailable;
  },
);
