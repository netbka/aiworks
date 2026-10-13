// CAAM account discovery and shallow-profile launch environment (docs/design/ACCOUNT_ADAPTER_CAAM.md section 3.2, slices
// CAAM2-DISCOVERY and CAAM4-LAUNCH). Discovery is read-only: it runs `caam robot status <provider>` and turns the JSON
// into validated profile records; it never activates, cools down or refreshes a profile. ensureShallowProfile creates a
// missing shallow home and caamProfileEnv points a worker at it; executors.mjs applies that environment when a launch
// names a profile home. cli.mjs wires none of it yet: the owner's Phase 2 pilot turns it on. The record shape follows
// CAAM v0.1.23 cmd/caam/cmd/robot.go (RobotOutput, RobotProviderInfo, RobotProfileInfo); compatibility with the CAAM
// installed on HomePc, including `caam shallow-profile create`, is unverified.
// Robot status carries no credentials. The adapter keeps only the fields below, never the email, auth paths or raw
// output, and its errors quote CAAM's own error code and message, never stdout or stderr.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
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
