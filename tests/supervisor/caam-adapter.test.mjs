// CAAM read-only discovery (docs/design/ACCOUNT_ADAPTER_CAAM.md section 3.2): provider mapping, robot status parsing,
// health flags and every failure path, against a synthetic caam script. No real CAAM, model, network or GitHub access.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CaamError, caamProfileHealth, caamProvider, caamRobotStatus, parseRobotStatus } from '../../src/supervisor/adapters/caam.mjs';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const HOUR = 3_600_000;

const profile = (name, extra = {}) => ({ name, active: false, system: false, email: `${name}@example.invalid`, plan_type: 'max',
  health: { status: 'healthy', expires_at: at(24 * HOUR), expires_in: '24h', error_count_1h: 0, renewable: true }, ...extra });
const status = (profiles, provider = 'claude') => ({ success: true, command: 'status', timestamp: at(0), data: {
  version: '0.1.23', os: 'windows', arch: 'amd64', vault_path: 'C:/vault', config_path: 'C:/config',
  providers: [{ id: provider, display_name: provider, logged_in: true, profiles,
    auth_paths: [{ path: 'C:/home/.claude/.credentials.json', exists: true, required: true, description: 'credentials' }] }],
  summary: { total_profiles: profiles.length } } });
const failure = (code, message) => ({ success: false, command: 'status', timestamp: at(0), error: { code, message } });

/** A synthetic caam executable: records its arguments, prints `stdout` and exits with `exit`, optionally after `sleepMs`. */
function fakeCaam(t, { stdout = '', exit = 0, sleepMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-caam-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const script = join(dir, 'fake-caam.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(process.argv.slice(2)));
const finish = () => { process.stdout.write(${JSON.stringify(typeof stdout === 'string' ? stdout : `${JSON.stringify(stdout)}\n`)}); process.exitCode = ${exit}; };
${sleepMs ? `setTimeout(finish, ${sleepMs});` : 'finish();'}
`);
  return { command: [process.execPath, script], args: () => JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')), dir };
}

const rejects = (fn, code, pattern) => assert.throws(fn, (error) => {
  assert.ok(error instanceof CaamError, `expected CaamError, got ${error}`);
  assert.equal(error.code, code);
  if (pattern) assert.match(error.message, pattern);
  return true;
});

test('executor kinds map to CAAM providers; consumer AGY is excluded with the reason', () => {
  assert.equal(caamProvider('claude-cli'), 'claude');
  assert.equal(caamProvider('codex-cli'), 'codex');
  rejects(() => caamProvider('agy-cli'), 'consumer-agy-excluded', /consumer AGY account rotation is excluded: Google consumer terms/);
  rejects(() => caamProvider('cursor-cli'), 'unsupported-executor', /claude-cli and codex-cli, not cursor-cli/);
  rejects(() => caamProvider('toString'), 'unsupported-executor');
});

test('an AGY lookup is refused before any CAAM process starts', (t) => {
  const caam = fakeCaam(t, { stdout: status([profile('a')]) });
  rejects(() => caamRobotStatus({ command: caam.command, kind: 'agy-cli', now: NOW }), 'consumer-agy-excluded');
  assert.throws(() => caam.args(), /ENOENT/, 'the synthetic caam never ran');
});

test('robot status of healthy profiles becomes validated records', (t) => {
  const caam = fakeCaam(t, { stdout: status([profile('work', { active: true }), profile('spare', { plan_type: 'pro',
    health: { status: 'warning', reason: 'expires soon', expires_at: at(HOUR), error_count_1h: 2 } })]) });
  const result = caamRobotStatus({ command: caam.command, kind: 'claude-cli', now: NOW });
  assert.deepEqual(caam.args(), ['robot', 'status', 'claude']);
  assert.equal(result.provider, 'claude');
  assert.deepEqual(result.profiles[0], {
    id: 'claude/work', provider: 'claude', name: 'work', active: true, system: false, planType: 'max',
    health: { status: 'healthy', reason: null, errorCount1h: 0 },
    cooldown: { active: false, until: null, reason: null },
    expiresAt: NOW + 24 * HOUR,
    eligible: true, healthy: true, critical: false, coolingDown: false, expired: false, reasons: [],
  });
  const spare = result.profiles[1];
  assert.equal(spare.planType, 'pro');
  assert.equal(spare.health.status, 'warning');
  assert.equal(spare.healthy, false, 'warning is not healthy');
  assert.equal(spare.eligible, true, 'a non-critical warning may still run');
  assert.equal(spare.health.errorCount1h, 2);
  // Only the listed fields are kept: no email, auth paths or raw output.
  assert.doesNotMatch(JSON.stringify(result), /example\.invalid|credentials|vault/);
});

test('codex profiles are read from the codex provider entry', (t) => {
  const caam = fakeCaam(t, { stdout: status([profile('team')], 'codex') });
  const result = caamRobotStatus({ command: caam.command, kind: 'codex-cli', now: NOW });
  assert.deepEqual(caam.args(), ['robot', 'status', 'codex']);
  assert.deepEqual(result.profiles.map((item) => item.id), ['codex/team']);
});

test('cooling-down, critical, unknown and expired profiles are flagged and not eligible', (t) => {
  const caam = fakeCaam(t, { stdout: status([
    profile('cool', { cooldown: { active: true, until: at(2 * HOUR), remaining_ms: 2 * HOUR, reason: 'rate limit' } }),
    profile('broken', { health: { status: 'critical', reason: 'refresh failed', error_count_1h: 9 } }),
    profile('unsure', { health: { status: 'unknown' } }),
    profile('old', { health: { status: 'healthy', expires_at: at(-HOUR) } }),
    profile('stale-cool', { cooldown: { active: true, until: at(-HOUR) } }),
    profile('ended', { cooldown: { active: false, until: at(-HOUR) } }),
  ]) });
  const byName = Object.fromEntries(caamRobotStatus({ command: caam.command, kind: 'claude-cli', now: NOW }).profiles.map((item) => [item.name, item]));
  assert.equal(byName.cool.coolingDown, true);
  assert.deepEqual(byName.cool.cooldown, { active: true, until: NOW + 2 * HOUR, reason: 'rate limit' });
  assert.deepEqual(byName.cool.reasons, [`cooldown until ${at(2 * HOUR)}`]);
  assert.equal(byName.cool.eligible, false);
  assert.equal(byName.broken.critical, true);
  assert.deepEqual(byName.broken.reasons, ['health critical']);
  assert.equal(byName.broken.eligible, false);
  assert.deepEqual(byName.unsure.reasons, ['health unknown']);
  assert.equal(byName.old.expired, true);
  assert.deepEqual(byName.old.reasons, [`session expired at ${at(-HOUR)}`]);
  assert.equal(byName.old.eligible, false);
  assert.equal(byName['stale-cool'].eligible, false, 'CAAM still reports the cooldown active: it holds');
  assert.equal(byName.ended.eligible, true, 'a cooldown CAAM reports ended does not block');
});

test('health is judged at the time given', () => {
  const [record] = parseRobotStatus(JSON.stringify(status([profile('soon', { health: { status: 'healthy', expires_at: at(HOUR) } })])), 'claude', NOW);
  assert.equal(record.eligible, true);
  const later = caamProfileHealth(record, NOW + 2 * HOUR);
  assert.equal(later.expired, true);
  assert.equal(later.eligible, false);
  assert.equal(caamProfileHealth(record, NOW + HOUR).expired, true, 'expiry at exactly now is expired');
});

test('output that is not JSON is refused', (t) => {
  const caam = fakeCaam(t, { stdout: 'caam: vault locked\n' });
  rejects(() => caamRobotStatus({ command: caam.command, kind: 'claude-cli', now: NOW }), 'invalid-json', /did not print JSON/);
  rejects(() => parseRobotStatus('', 'claude', NOW), 'invalid-json');
});

test('a structured CAAM error is reported by its code, with or without a failing exit', (t) => {
  const failing = fakeCaam(t, { stdout: failure('INVALID_PROVIDER', 'unknown provider: claude'), exit: 1 });
  rejects(() => caamRobotStatus({ command: failing.command, kind: 'claude-cli', now: NOW }), 'cli-error', /INVALID_PROVIDER: unknown provider: claude/);
  const quiet = fakeCaam(t, { stdout: failure('VAULT_ERROR', 'vault unreadable') });
  rejects(() => caamRobotStatus({ command: quiet.command, kind: 'claude-cli', now: NOW }), 'cli-error', /VAULT_ERROR/);
});

test('a failing exit without a structured error is a CLI error that quotes no output', (t) => {
  const crashed = fakeCaam(t, { stdout: 'panic: token sk-secret-value\n', exit: 2 });
  rejects(() => caamRobotStatus({ command: crashed.command, kind: 'claude-cli', now: NOW }), 'cli-error', /exited 2$/);
  // A success document with a failing exit is not trusted either.
  const mixed = fakeCaam(t, { stdout: status([profile('a')]), exit: 3 });
  rejects(() => caamRobotStatus({ command: mixed.command, kind: 'claude-cli', now: NOW }), 'cli-error', /exited 3/);
});

test('a missing or unconfigured CAAM executable is reported as missing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-caam-missing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  rejects(() => caamRobotStatus({ command: [join(dir, 'caam-not-installed.exe')], kind: 'claude-cli', now: NOW }), 'missing-executable', /was not found/);
  for (const command of [undefined, [], [''], 'caam']) {
    rejects(() => caamRobotStatus({ command, kind: 'claude-cli', now: NOW }), 'missing-executable', /commands.caam is not configured/);
  }
});

test('a CAAM that does not answer in time is stopped and reported', (t) => {
  const slow = fakeCaam(t, { stdout: status([profile('a')]), sleepMs: 10_000 });
  rejects(() => caamRobotStatus({ command: slow.command, kind: 'claude-cli', now: NOW, timeoutMs: 500 }), 'timeout', /longer than 500 ms/);
});

test('malformed robot documents and profiles fail closed', () => {
  const read = (doc) => () => parseRobotStatus(JSON.stringify(doc), 'claude', NOW);
  rejects(read([]), 'invalid-output', /no success flag/);
  rejects(read({ success: true }), 'invalid-output', /no providers list/);
  rejects(read(status([profile('a')], 'codex')), 'invalid-output', /lists no claude provider/);
  rejects(read({ success: true, data: { providers: [{ id: 'claude' }] } }), 'invalid-output', /no profiles list/);
  const bad = (change, pattern) => {
    const item = profile('a');
    change(item);
    rejects(read(status([item])), 'invalid-output', pattern);
  };
  bad((p) => { delete p.name; }, /profile name/);
  bad((p) => { p.name = '../escape'; }, /profile name/);
  bad((p) => { p.active = 'yes'; }, /active must be a boolean/);
  bad((p) => { delete p.health; }, /health.status/);
  bad((p) => { p.health.status = 'fine'; }, /health.status/);
  bad((p) => { p.health.expires_at = 'tomorrow'; }, /expires_at is not a timestamp/);
  bad((p) => { p.cooldown = { until: at(HOUR) }; }, /cooldown.active must be a boolean/);
  bad((p) => { p.cooldown = { active: true, until: 12 }; }, /cooldown.until is not a timestamp/);
  bad((p) => { p.plan_type = 3; }, /plan_type must be a string/);
  bad((p) => { p.health.error_count_1h = -1; }, /error_count_1h/);
  rejects(read(status([profile('a'), profile('a')])), 'invalid-output', /lists profile a twice/);
  assert.deepEqual(parseRobotStatus(JSON.stringify(status([])), 'claude', NOW), [], 'no profiles is an empty list, not an error');
});
