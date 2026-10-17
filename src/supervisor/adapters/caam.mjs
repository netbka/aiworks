// CAAM account discovery and shallow-profile launch environment (docs/design/ACCOUNT_ADAPTER_CAAM.md section 3.2, slices
// CAAM2-DISCOVERY and CAAM4-LAUNCH). Discovery is read-only: it runs `caam robot status <provider>` and turns the JSON
// into validated profile records; it never activates, cools down or refreshes a profile. ensureShallowProfile creates a
// missing shallow home and caamProfileEnv points a worker at it; executors.mjs applies that environment when a launch
// names a profile home. cli.mjs wires none of it yet: the owner's Phase 2 pilot turns it on. The record shape follows
// CAAM v0.1.23 cmd/caam/cmd/robot.go (RobotOutput, RobotProviderInfo, RobotProfileInfo); compatibility with the CAAM
// installed on workstation, including `caam shallow-profile create`, is unverified.
// Robot status carries no credentials. The adapter keeps only the fields below, never the email, auth paths or raw
// output, and its errors quote CAAM's own error code and message, never stdout or stderr.
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Executor kinds CAAM rotates, and CAAM's provider id for each. */
export const PROVIDERS = Object.freeze({ 'claude-cli': 'claude', 'codex-cli': 'codex' });
// Health states CAAM reports. healthy and warning may run; critical and unknown may not.
const HEALTH = new Set(['healthy', 'warning', 'critical', 'unknown']);
const USABLE = new Set(['healthy', 'warning']);
// The same names accounts.mjs accepts for an account, so a profile name can become an account identity unchanged.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class CaamError extends Error {
  /**
   * code: unsupported-executor, consumer-agy-excluded, missing-executable, timeout, cli-error, invalid-json, invalid-output,
   * invalid-profile-home or shallow-profile-missing.
   */
  constructor(code, message) {
    super(`caam ${code}: ${message}`);
    this.name = 'CaamError';
    this.code = code;
  }
}

/** CAAM's provider id for an executor kind. Consumer AGY and every unmapped kind are refused. */
export function caamProvider(kind) {
  if (kind === 'agy-cli') {
    throw new CaamError('consumer-agy-excluded', 'consumer AGY account rotation is excluded: Google consumer terms do not allow '
      + 'automated account rotation for agy (ACCOUNT_ADAPTER_CAAM.md section 1.2 rule 4); agy-cli keeps its single login');
  }
  if (!Object.hasOwn(PROVIDERS, kind)) throw new CaamError('unsupported-executor', `CAAM rotation covers ${Object.keys(PROVIDERS).join(' and ')}, not ${kind}`);
  return PROVIDERS[kind];
}

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (message) => { throw new CaamError('invalid-output', message); };

/** An RFC 3339 time as epoch ms; absent or empty is null. */
function time(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : invalid(`${field} is not a timestamp`);
}

function text(value, field) {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : invalid(`${field} must be a string`);
}

/** One validated profile record from a RobotProfileInfo. A malformed profile fails the whole read closed. */
export function profileRecord(provider, raw) {
  if (!plain(raw)) invalid('profile must be an object');
  if (typeof raw.name !== 'string' || !NAME.test(raw.name)) invalid('profile name is missing or not a plain name');
  const at = `profile ${raw.name}`;
  if (typeof raw.active !== 'boolean') invalid(`${at}: active must be a boolean`);
  if (!plain(raw.health) || !HEALTH.has(raw.health.status)) invalid(`${at}: health.status must be one of ${[...HEALTH].join(', ')}`);
  if (raw.cooldown !== undefined && raw.cooldown !== null && (!plain(raw.cooldown) || typeof raw.cooldown.active !== 'boolean')) {
    invalid(`${at}: cooldown.active must be a boolean`);
  }
  const errors = raw.health.error_count_1h ?? 0;
  if (!Number.isInteger(errors) || errors < 0) invalid(`${at}: health.error_count_1h must be a count`);
  return {
    id: `${provider}/${raw.name}`,
    provider,
    name: raw.name,
    active: raw.active,
    system: raw.system === true,
    planType: text(raw.plan_type, `${at}: plan_type`),
    health: { status: raw.health.status, reason: text(raw.health.reason, `${at}: health.reason`), errorCount1h: errors },
    cooldown: { active: raw.cooldown?.active === true, until: time(raw.cooldown?.until, `${at}: cooldown.until`),
      reason: text(raw.cooldown?.reason, `${at}: cooldown.reason`) },
    expiresAt: time(raw.health.expires_at, `${at}: health.expires_at`),
  };
}

/**
 * Whether a profile may take work at `now`, and every reason it may not: critical or unknown health, an active cooldown,
 * or an expired session. CAAM's cooldown.active decides; a cooldown CAAM still reports active stays blocked even after
 * its `until`, so a stale clock never frees a profile early.
 */
export function caamProfileHealth(profile, now = Date.now()) {
  const reasons = [];
  if (!USABLE.has(profile.health.status)) reasons.push(`health ${profile.health.status}`);
  if (profile.cooldown.active) reasons.push(profile.cooldown.until === null ? 'cooldown' : `cooldown until ${new Date(profile.cooldown.until).toISOString()}`);
  if (profile.expiresAt !== null && profile.expiresAt <= now) reasons.push(`session expired at ${new Date(profile.expiresAt).toISOString()}`);
  return {
    eligible: reasons.length === 0,
    healthy: profile.health.status === 'healthy',
    critical: profile.health.status === 'critical',
    coolingDown: profile.cooldown.active,
    expired: profile.expiresAt !== null && profile.expiresAt <= now,
    reasons,
  };
}

/** Validated profile records from the stdout of `caam robot status <provider>`, each with its health at `now`. */
export function parseRobotStatus(stdout, provider, now = Date.now()) {
  let output;
  try { output = JSON.parse(stdout); } catch { throw new CaamError('invalid-json', `robot status for ${provider} did not print JSON`); }
  if (!plain(output) || typeof output.success !== 'boolean') invalid('robot output has no success flag');
  if (!output.success) {
    const code = plain(output.error) && typeof output.error.code === 'string' ? output.error.code : 'UNKNOWN';
    const message = plain(output.error) && typeof output.error.message === 'string' ? output.error.message : 'no message';
    throw new CaamError('cli-error', `robot status for ${provider} failed: ${code}: ${message}`.slice(0, 500));
  }
  if (!plain(output.data) || !Array.isArray(output.data.providers)) invalid('robot status data has no providers list');
  const info = output.data.providers.find((item) => plain(item) && item.id === provider);
  if (!info) invalid(`robot status lists no ${provider} provider`);
  if (!Array.isArray(info.profiles)) invalid(`${provider} provider has no profiles list`);
  const profiles = info.profiles.map((raw) => profileRecord(provider, raw));
  const seen = new Set();
  for (const profile of profiles) {
    if (seen.has(profile.name)) invalid(`${provider} lists profile ${profile.name} twice`);
    seen.add(profile.name);
  }
  return profiles.map((profile) => ({ ...profile, ...caamProfileHealth(profile, now) }));
}

/**
 * Discover the CAAM profiles behind an executor kind: runs `<command> robot status <provider>` (command is the argv
 * prefix from config.json commands.caam) and returns { provider, profiles }. Throws CaamError, never a partial list.
 */
export function caamRobotStatus({ command, kind, now = Date.now(), timeoutMs = 15_000, spawn = spawnSync }) {
  const provider = caamProvider(kind);
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || !part)) {
    throw new CaamError('missing-executable', 'commands.caam is not configured in config.json');
  }
  const result = spawn(command[0], [...command.slice(1), 'robot', 'status', provider], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error?.code === 'ENOENT') throw new CaamError('missing-executable', `${command[0]} was not found`);
  if (result.error?.code === 'ETIMEDOUT') throw new CaamError('timeout', `robot status for ${provider} ran longer than ${timeoutMs} ms`);
  if (result.error) throw new CaamError('cli-error', `robot status for ${provider} could not run (${result.error.code ?? 'spawn failed'})`);
  const stdout = (result.stdout || '').trim();
  // CAAM prints a structured error on stdout and exits non-zero; that error is the better message, so read it first.
  if (result.status !== 0) {
    let printed = null;
    try { printed = JSON.parse(stdout); } catch { /* not JSON: report the exit status */ }
    if (plain(printed) && printed.success === false) parseRobotStatus(stdout, provider, now);
    throw new CaamError('cli-error', `robot status for ${provider} exited ${result.status ?? result.signal}`);
  }
  return { provider, profiles: parseRobotStatus(stdout, provider, now) };
}

/**
 * The shallow home of profile `name` under `root` (the configured shallow homes directory). The name must be a plain
 * profile name and the root absolute, so the home can never be a relative path or climb out of the root.
 */
export function shallowHomeOf(root, name) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new CaamError('invalid-profile-home', 'the shallow homes directory must be an absolute path');
  if (typeof name !== 'string' || !NAME.test(name) || name === '.' || name === '..') {
    throw new CaamError('invalid-profile-home', 'profile name is missing or not a plain name');
  }
  return join(resolve(root), name);
}

/**
 * The environment that runs a worker inside one CAAM shallow profile (design section 3.2 step 3): HOME and USERPROFILE
 * are the shallow home, so the CLI reads that profile's credentials and never the host login. Codex also gets
 * CODEX_HOME, which Codex reads instead of the Windows profile folder. Claude also gets the switches that keep it off
 * Agent View, background tasks and auto-memory. It adds no flag: the executor's own isolation arguments stay as they are.
 * A relative home or the host's own home is refused, so a profile launch can never change the default login.
 */
export function caamProfileEnv(shallowHome, provider) {
  if (!Object.values(PROVIDERS).includes(provider)) throw new CaamError('unsupported-executor', `no CAAM profile environment for ${provider}`);
  if (typeof shallowHome !== 'string' || !isAbsolute(shallowHome)) throw new CaamError('invalid-profile-home', 'the shallow home must be an absolute path');
  const home = resolve(shallowHome);
  const host = resolve(homedir());
  // The host home inside (or equal to) the shallow home; a home on another drive gives an absolute relative path.
  const up = relative(home, host);
  if (!up || (up !== '..' && !up.startsWith(`..${sep}`) && !isAbsolute(up))) {
    throw new CaamError('invalid-profile-home', 'the shallow home cannot be the host home or contain it');
  }
  const env = { HOME: home, USERPROFILE: home };
  if (provider === 'claude') {
    env.CLAUDE_CODE_DISABLE_AGENT_VIEW = '1';
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  } else env.CODEX_HOME = join(home, '.codex');
  return env;
}

const isDirectory = (path) => existsSync(path) && statSync(path).isDirectory();

/**
 * The shallow home of profile `name` for an executor kind, created first when it is missing (design section 3.2 step 2):
 * runs `<command> shallow-profile create <name> --from-vault <provider>/<name> --json` once and checks the home exists
 * afterwards. An existing home is used as it is and CAAM is not called. Throws CaamError, never a home that is missing.
 */
export function ensureShallowProfile({ command, kind, name, root, timeoutMs = 60_000, spawn = spawnSync }) {
  const provider = caamProvider(kind);
  const home = shallowHomeOf(root, name);
  if (isDirectory(home)) return home;
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || !part)) {
    throw new CaamError('missing-executable', 'commands.caam is not configured in config.json');
  }
  const result = spawn(command[0], [...command.slice(1), 'shallow-profile', 'create', name, '--from-vault', `${provider}/${name}`, '--json'], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error?.code === 'ENOENT') throw new CaamError('missing-executable', `${command[0]} was not found`);
  if (result.error?.code === 'ETIMEDOUT') throw new CaamError('timeout', `shallow-profile create for ${provider}/${name} ran longer than ${timeoutMs} ms`);
  if (result.error) throw new CaamError('cli-error', `shallow-profile create for ${provider}/${name} could not run (${result.error.code ?? 'spawn failed'})`);
  let printed = null;
  try { printed = JSON.parse((result.stdout || '').trim()); } catch { /* not JSON: judged by the exit status */ }
  if (plain(printed) && printed.success === false) {
    const code = plain(printed.error) && typeof printed.error.code === 'string' ? printed.error.code : 'UNKNOWN';
    const message = plain(printed.error) && typeof printed.error.message === 'string' ? printed.error.message : 'no message';
    throw new CaamError('cli-error', `shallow-profile create for ${provider}/${name} failed: ${code}: ${message}`.slice(0, 500));
  }
  if (result.status !== 0) throw new CaamError('cli-error', `shallow-profile create for ${provider}/${name} exited ${result.status ?? result.signal}`);
  if (!isDirectory(home)) throw new CaamError('shallow-profile-missing', `CAAM reported success but ${provider}/${name} has no shallow home under the configured directory`);
  return home;
}

/**
 * Remove the shallow home of profile `name` for an executor kind: deletes the shallow directory under `root`
 * and optionally informs CAAM via `shallow-profile remove`. Returns removal status.
 */
export function removeShallowProfile({ command = null, kind, name, root, spawn = spawnSync }) {
  const provider = Object.hasOwn(PROVIDERS, kind) ? PROVIDERS[kind] : (kind.endsWith('-cli') ? kind.slice(0, -4) : kind);
  const home = shallowHomeOf(root, name);
  let removed = false;
  if (existsSync(home)) {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    removed = true;
  }
  if (Object.hasOwn(PROVIDERS, kind) && Array.isArray(command) && command.length && command[0]) {
    try {
      spawn(command[0], [...command.slice(1), 'shallow-profile', 'remove', name, '--from-vault', `${provider}/${name}`, '--json'], {
        encoding: 'utf8', windowsHide: true, timeout: 15_000,
      });
    } catch { /* best-effort notification to CAAM */ }
  }
  return { removed, name, provider, path: home };
}

/**
 * Export configured profile credentials into an AES-256-GCM encrypted binary bundle using PBKDF2/scrypt.
 */
const SHARE_PROVIDERS = new Set(['claude', 'codex', 'cursor', 'agy']);
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const invalidBundle = () => new CaamError('invalid-bundle', 'invalid account profile, file path or contents');
const portableSegment = value => typeof value === 'string' && value.length > 0 && value.length <= 255
  && !/[\\/:\x00-\x1f<>"|?*]/.test(value) && value !== '.' && value !== '..' && !/[. ]$/.test(value) && !DEVICE_NAME.test(value);
function shareHome(root, item) {
  if (!item || !SHARE_PROVIDERS.has(item.provider) || !portableSegment(item.name) || !NAME.test(item.name)) throw invalidBundle();
  const home = shallowHomeOf(root, item.name), host = relative(home, resolve(homedir()));
  if (!host || !host.startsWith('..') && !isAbsolute(host)) throw invalidBundle();
  return home;
}
// Check existing ancestors without following a symlink/junction or hard-linked file.
// The operator supplies the root; bundle contents can only name descendants of it.
function sharePath(root, target, file = false) {
  const base = resolve(root), rel = relative(base, resolve(target));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw invalidBundle();
  const parts = rel.split(sep); let current = base;
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const last = i === parts.length - 1;
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1
      || (last && file ? !stat.isFile() : !stat.isDirectory())) throw invalidBundle();
  }
  return resolve(target);
}
function bundleFile(root, home, relPath) {
  if (typeof relPath !== 'string' || relPath.length > 1024 || !relPath.split('/').every(portableSegment)) throw invalidBundle();
  return sharePath(root, join(home, ...relPath.split('/')), true);
}
function collectProfileFiles(root, home, budget) {
  const files = {};
  if (!existsSync(home)) return files;
  const walk = (dir) => {
    try {
      sharePath(root, dir);
      for (const dirent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (['node_modules', '.git', 'cache', 'logs'].includes(dirent.name)) continue;
          walk(full);
        } else if (dirent.isFile()) {
          const rel = relative(home, full).replace(/\\/g, '/');
          bundleFile(root, home, rel);
          const stat = statSync(full);
          if (stat.size <= 1_048_576) {
            if (++budget.files > 1000 || (budget.bytes += stat.size) > 16 * 1024 * 1024) throw invalidBundle();
            files[rel] = readFileSync(full, 'utf8');
          }
        }
      }
    } catch (error) { if (error instanceof CaamError) throw error; /* ignore unreadable dirs */ }
  };
  walk(home);
  return files;
}

export function exportProfileCredentials({ root, profiles, passphrase }) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new CaamError('invalid-passphrase', 'passphrase must be at least 8 characters');
  }
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    items: [],
  };
  if (!Array.isArray(profiles) || profiles.length > 100) throw invalidBundle();
  const selected = profiles.map(item => ({ ...item, home: sharePath(root, shareHome(root, item)) }));
  if (new Set(selected.map(item => item.home.toLowerCase())).size !== selected.length) throw invalidBundle();
  const budget = { files: 0, bytes: 0 };
  for (const { provider, name, home } of selected) {
    if (!existsSync(home)) continue;
    const files = collectProfileFiles(root, home, budget);
    payload.items.push({ provider, name, files });
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) + 44 > 16 * 1024 * 1024) throw invalidBundle();
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]);
}

/**
 * Import and unpack profile credentials from an AES-256-GCM encrypted binary bundle.
 */
export function importProfileCredentials({ root, bundleBuffer, passphrase }) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) throw new CaamError('invalid-passphrase', 'passphrase must be at least 8 characters');
  if (!Buffer.isBuffer(bundleBuffer) || bundleBuffer.length < 44 || bundleBuffer.length > 16 * 1024 * 1024) {
    throw new CaamError('invalid-bundle', 'corrupted or truncated accounts bundle');
  }
  const salt = bundleBuffer.subarray(0, 16);
  const iv = bundleBuffer.subarray(16, 28);
  const tag = bundleBuffer.subarray(28, 44);
  const ciphertext = bundleBuffer.subarray(44);
  const key = scryptSync(passphrase, salt, 32);
  let decrypted;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new CaamError('auth-failed', 'incorrect passphrase or corrupted accounts bundle');
  }
  let payload;
  try { payload = JSON.parse(decrypted); } catch { throw new CaamError('invalid-bundle', 'decrypted bundle is not valid JSON'); }
  if (!payload || payload.version !== 1 || !Array.isArray(payload.items) || payload.items.length > 100) {
    throw new CaamError('invalid-bundle', 'unsupported accounts bundle format');
  }
  // Validate the complete bundle before creating any directory or changing a file.
  const plan = [], targets = new Set(), profiles = new Set(); let count = 0;
  for (const item of payload.items) {
    const home = sharePath(root, shareHome(root, item));
    const identity = home.toLowerCase();
    if (profiles.has(identity) || !item.files || typeof item.files !== 'object' || Array.isArray(item.files)) throw invalidBundle();
    profiles.add(identity);
    const files = [];
    for (const [relPath, content] of Object.entries(item.files)) {
      if (++count > 1000 || typeof content !== 'string' || Buffer.byteLength(content) > 1_048_576) throw invalidBundle();
      const fullPath = bundleFile(root, home, relPath), key = fullPath.toLowerCase();
      if ([...targets].some(existing => existing === key || existing.startsWith(key + sep) || key.startsWith(existing + sep))) throw invalidBundle();
      targets.add(key); files.push({ fullPath, content });
    }
    plan.push({ provider: item.provider, name: item.name, home, files });
  }
  const imported = [];
  for (const item of plan) {
    sharePath(root, item.home);
    for (const { fullPath, content } of item.files) {
      sharePath(root, fullPath, true);
      mkdirSync(resolve(fullPath, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(fullPath, content, { encoding: 'utf8', mode: 0o600 });
    }
    imported.push({ provider: item.provider, name: item.name, home: item.home });
  }
  return {
    success: true,
    count: imported.length,
    imported: imported.map((i) => `${i.provider}/${i.name}`),
    profiles: imported,
  };
}

