// aiworks#18: a stopped supervisor restarts itself and says that it stopped. The keeper logs why it ends, status and
// the dashboard API report a supervisor whose leases all expired as stopped, the scheduled tasks repeat every 5 minutes
// with MultipleInstances IgnoreNew, and deploy.ps1 keeps them from starting anything mid-upgrade.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { CLI, FAST, ROOT, SQLITE, declaration, sleep } from './helpers.mjs';
import { campaignPause, campaignStart, STOPPED_AFTER_MS, supervisorLiveness } from '../../src/supervisor/api.mjs';
const Store = SQLITE ? (await import('../../src/supervisor/store.mjs')).Store : null;

const PRELOAD = pathToFileURL(join(ROOT, 'tests', 'supervisor', 'fixtures', 'keep-preload.mjs')).href;
const LEASE_MS = 120_000;
// CI runs on ubuntu-latest (aiworks#42); workstation runs Windows. AIWORKS_TEST_PLATFORM=linux runs the non-Windows branch
// of these tests on Windows, so the Linux path can be checked locally.
const WINDOWS = (process.env.AIWORKS_TEST_PLATFORM || process.platform) === 'win32';
const WINDOWS_ONLY = !WINDOWS && 'Windows only: Task Scheduler and powershell.exe';
// A closed console reaches keep as SIGBREAK on Windows. SIGBREAK does not exist elsewhere; there SIGHUP is the
// console-close signal. keep handles both the same way (one listener per signal), so the test checks the same path.
const CONSOLE_SIGNAL = WINDOWS ? 'SIGBREAK' : 'SIGHUP';

function dataDir(t, { before = () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-keeper-'));
  t.after(() => { before(); rmSync(root, { recursive: true, force: true }); });
  const data = join(root, 'data');
  mkdirSync(data);
  return { root, data };
}

/** Run `cli.mjs keep` with the synthetic child; resolves with its exit code and the keeper's log lines. */
function keep(data, { child, signal = null, trigger = null }) {
  const env = { ...process.env, KEEP_TEST_CHILD: child, KEEP_TEST_SIGNAL: signal ?? '', KEEP_TEST_TRIGGER: trigger ?? '' };
  delete env.NODE_TEST_CONTEXT;
  const proc = spawn(process.execPath, ['--no-warnings', '--import', PRELOAD, CLI, 'keep', '--data', data], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((done) => proc.on('exit', (code) => done({ code, stderr,
    log: existsSync(join(data, 'supervisor.log')) ? readFileSync(join(data, 'supervisor.log'), 'utf8').trim().split('\n') : [] })));
}

test('keep logs the STOP file as its exit reason after its serve child exits', async (t) => {
  const { data } = dataDir(t);
  // The synthetic serve requests a stop, as `cli.mjs stop` does, and exits with 3.
  const child = `require('node:fs').writeFileSync(${JSON.stringify(join(data, 'STOP'))}, 'test'); process.exit(3)`;
  const out = await keep(data, { child });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.log.length, 3, out.log.join('\n'));
  assert.match(out.log[0], /\[keep\] keeper started \(pid \d+\)$/);
  assert.match(out.log[1], /\[keep\] serve exited with 3$/);
  assert.match(out.log[2], /\[keep\] keeper ending \(pid \d+\): STOP file present; exit code 0$/);
});

test('keep logs a console signal and its exit code before it ends, naming the serve child still running', async (t) => {
  const { root, data } = dataDir(t);
  const ready = join(root, 'child.pid'), trigger = join(root, 'signal');
  const child = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const pending = keep(data, { child, signal: CONSOLE_SIGNAL, trigger });
  let pid = null;
  t.after(() => { if (pid) try { process.kill(pid); } catch { /* already gone */ } });
  for (let waited = 0; !existsSync(ready) && waited < 20_000; waited += 50) await sleep(50);
  pid = Number(readFileSync(ready, 'utf8'));
  writeFileSync(trigger, '');
  const out = await pending;
  const code = 128 + (await import('node:os')).constants.signals[CONSOLE_SIGNAL];
  assert.ok(Number.isInteger(code), `${CONSOLE_SIGNAL} has a signal number on this platform`);
  assert.equal(out.code, code, out.stderr);
  assert.match(out.log.at(-1), new RegExp(`\\[keep\\] keeper ending \\(pid \\d+\\): received ${CONSOLE_SIGNAL}; exit code ${code}; serve \\(pid ${pid}\\) stops on its own signal or the STOP file$`));
});

test('keep started while STOP exists exits at once and writes nothing to the log', async (t) => {
  const { data } = dataDir(t);
  writeFileSync(join(data, 'STOP'), 'test');
  const out = await keep(data, { child: 'process.exit(9)' });
  assert.equal(out.code, 0);
  assert.match(out.stderr, /STOP exists; keeper not started/);
  assert.deepEqual(out.log, []);
});

function store(t) {
  let s = null;
  const { data } = dataDir(t, { before: () => s.close() });
  s = new Store(join(data, 'supervisor.db'));
  campaignStart(s, declaration());
  return { data, store: s, id: 'test-campaign' };
}

test('every lease expired: stopped, with the last renewal time; a live or just-expired lease is never stopped', { skip: !SQLITE }, (t) => {
  const { store: s, id } = store(t);
  const t0 = Date.parse('2026-10-12T11:25:38.000Z');
  assert.equal(supervisorLiveness(s, { now: t0, leaseMs: LEASE_MS }).state, 'not-started');
  s.acquireLease(id, 'controller', t0, LEASE_MS);
  s.acquireLease('_coordinator', 'controller', t0, LEASE_MS);
  const running = supervisorLiveness(s, { now: t0 + LEASE_MS - 1, leaseMs: LEASE_MS });
  assert.equal(running.state, 'running');
  assert.equal(running.stopped, false);
  // A restart takes over within a tick: just after expiry it is not yet reported stopped.
  const handover = supervisorLiveness(s, { now: t0 + LEASE_MS + STOPPED_AFTER_MS - 1, leaseMs: LEASE_MS });
  assert.equal(handover.state, 'restarting');
  assert.equal(handover.stopped, false);
  const stopped = supervisorLiveness(s, { now: t0 + LEASE_MS + STOPPED_AFTER_MS, leaseMs: LEASE_MS });
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.lastLeaseRenewalAt, '2026-10-12T11:25:38.000Z');
  assert.equal(stopped.leaseEndedAt, '2026-10-12T11:27:38.000Z');
  assert.equal(stopped.message, 'supervisor stopped; last lease renewal at 2026-10-12T11:25:38.000Z');
  // One live lease (here the coordinator lane) means a controller is running.
  s.acquireLease('_coordinator', 'controller', t0 + LEASE_MS + STOPPED_AFTER_MS, LEASE_MS);
  assert.equal(supervisorLiveness(s, { now: t0 + LEASE_MS + STOPPED_AFTER_MS + 1, leaseMs: LEASE_MS }).state, 'running');
});

test('without a campaign that needs a controller, expired leases claim nothing', { skip: !SQLITE }, (t) => {
  const { store: s, id } = store(t);
  const t0 = Date.now() - 10 * LEASE_MS;
  s.acquireLease(id, 'controller', t0, LEASE_MS);
  s.run("UPDATE campaigns SET control = 'finished'");
  const idle = supervisorLiveness(s, { now: Date.now(), leaseMs: LEASE_MS });
  assert.equal(idle.state, 'idle');
  assert.equal(idle.stopped, false);
});

test('a controller that ticks is never reported stopped', { skip: !SQLITE }, async (t) => {
  const { data, store: s, id } = store(t);
  campaignPause(s, id, 'test: no dispatch');
  const { Controller } = await import('../../src/supervisor/controller.mjs');
  let clock = Date.parse('2026-10-12T10:00:00.000Z');
  const controller = new Controller({ store: s, config: FAST, dataDir: data, now: () => clock });
  for (let tick = 0; tick < 5; tick++) {
    await controller.tick();
    // Each tick renews; the next one comes within tickMs, far inside the lease.
    for (const at of [clock, clock + FAST.tickMs]) assert.equal(supervisorLiveness(s, { now: at, leaseMs: FAST.leaseMs }).state, 'running');
    clock += FAST.tickMs;
  }
  // A graceful stop expires its leases at once: after the handover margin it is stopped, the renewal time bounded below.
  controller.release();
  const after = supervisorLiveness(s, { now: clock + STOPPED_AFTER_MS, leaseMs: FAST.leaseMs });
  assert.equal(after.state, 'stopped');
  assert.ok(Date.parse(after.lastLeaseRenewalAt) <= clock);
});

test('status and the dashboard API lead with a stopped supervisor and its last lease renewal', { skip: !SQLITE }, async (t) => {
  const { data, store: s, id } = store(t);
  writeFileSync(join(data, 'config.json'), JSON.stringify({ leaseMs: LEASE_MS }));
  const renewed = Date.now() - 10 * 60_000;
  s.acquireLease(id, 'controller', renewed, LEASE_MS);
  const env = { ...process.env, AIWORKS_DATA: '' };
  delete env.NODE_TEST_CONTEXT;
  const status = () => {
    const out = spawnSync(process.execPath, ['--no-warnings', CLI, 'status', id, '--data', data], { env, windowsHide: true, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  const first = status();
  assert.equal(Object.keys(first)[0], 'supervisor');
  assert.equal(first.supervisor.stopped, true);
  assert.equal(first.supervisor.lastLeaseRenewalAt, new Date(renewed).toISOString());
  assert.equal(first.supervisor.message, `supervisor stopped; last lease renewal at ${new Date(renewed).toISOString()}`);
  assert.equal(first.readiness, 'CONTROLLER_OFFLINE');
  writeFileSync(join(data, 'STOP'), 'test');
  assert.equal(status().supervisor.stopRequested, true);
  const { supervisorSnapshot } = await import('../../src/dashboard/supervisor.mjs');
  const snapshot = supervisorSnapshot(data);
  assert.equal(snapshot.controller.stopped, true);
  assert.equal(snapshot.controller.lastLeaseRenewalAt, new Date(renewed).toISOString());
  assert.equal(snapshot.controller.stopRequested, true);
  s.acquireLease(id, 'controller-2', Date.now(), LEASE_MS);
  assert.equal(supervisorSnapshot(data).controller.state, 'running');
  assert.equal(status().supervisor.stopped, false);
});

test('both task scripts register a logon trigger and a 5-minute repeating trigger with MultipleInstances IgnoreNew', { skip: WINDOWS_ONLY }, (t) => {
  const { root, data } = dataDir(t);
  const checkout = join(root, 'runtime');
  for (const path of ['src/supervisor/cli.mjs', 'src/dashboard/main.mjs']) { mkdirSync(join(checkout, path, '..'), { recursive: true }); writeFileSync(join(checkout, path), ''); }
  writeFileSync(join(data, 'config.json'), JSON.stringify({ governanceRoot: root }));
  writeFileSync(join(data, 'STOP'), 'test');
  for (const [script, name] of [['install-windows-task.ps1', 'AIWorks Supervisor'], ['install-dashboard-task.ps1', 'AIWorks Dashboard']]) {
    const out = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      join(ROOT, 'scripts', 'supervisor', script), '-Checkout', checkout, '-DataDir', data, '-DefinitionOnly'], { encoding: 'utf8', windowsHide: true });
    assert.equal(out.status, 0, out.stderr);
    const definition = JSON.parse(out.stdout);
    assert.equal(definition.taskName, name);
    assert.equal(definition.multipleInstances, 'IgnoreNew');
    assert.equal(definition.executionTimeLimit, 'PT0S');
    assert.deepEqual(definition.triggers.map((trigger) => trigger.kind), ['MSFT_TaskLogonTrigger', 'MSFT_TaskTimeTrigger']);
    // Every 5 minutes, indefinitely (no duration), never stopping the running instance.
    const repeat = definition.triggers[1];
    assert.equal(repeat.interval, 'PT5M');
    assert.equal(repeat.duration, null);
    assert.equal(repeat.stopAtDurationEnd, false);
  }
  // Printing the definition changes nothing: the STOP file of a stopped supervisor stays.
  assert.equal(existsSync(join(data, 'STOP')), true);
});

test('deploy.ps1 disables both tasks before the stop and enables them only after STOP is removed', () => {
  const script = readFileSync(join(ROOT, 'scripts', 'supervisor', 'deploy.ps1'), 'utf8');
  const at = (pattern) => {
    const index = script.search(pattern);
    assert.ok(index >= 0, `deploy.ps1 lacks ${pattern}`);
    return index;
  };
  const steps = [
    at(/\nDisable-Task 'AIWorks Supervisor'/), at(/\nDisable-Task 'AIWorks Dashboard'/),
    at(/cli\.mjs" stop --data/), at(/supervisor processes still running/),
    at(/Stop-ScheduledTask -TaskName 'AIWorks Supervisor'/), at(/git -C \$runtime checkout/), at(/npm ci/),
    at(/Remove-Item -LiteralPath "\$data\/STOP"/),
    at(/Enable-ScheduledTask -TaskName 'AIWorks Supervisor'/), at(/Enable-ScheduledTask -TaskName 'AIWorks Dashboard'/),
    at(/Start-ScheduledTask -TaskName 'AIWorks Supervisor'/), at(/Start-ScheduledTask -TaskName 'AIWorks Dashboard'/),
  ];
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b));
  assert.equal(script.match(/Enable-ScheduledTask/g).length, 2, 'the tasks are enabled only at the end');
  // aiworks#42: a failed disable is never silently ignored.
  const disables = script.match(/Disable-ScheduledTask[^\n]*/g);
  assert.equal(disables.length, 1);
  assert.match(disables[0], /-ErrorAction Stop/);
});

/**
 * Run deploy.ps1 on a disposable root with every scheduled-task and process cmdlet it calls replaced by a recording
 * stub, so the real tasks are never touched. `disable` maps a task name to the error category its Disable-ScheduledTask
 * raises. Get-CimInstance (step 1's wait for the old processes) throws a marker, so a deploy that passes step 0 ends there.
 */
function deploy(t, disable) {
  const { root } = dataDir(t);
  const data = join(root, '.local', 'supervisor');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'STOP'), 'earlier failed deploy');
  const calls = join(root, 'calls.txt');
  writeFileSync(calls, '');
  const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const recorded = ['Enable-ScheduledTask', 'Start-ScheduledTask', 'Stop-ScheduledTask', 'Stop-Process'];
  const stubs = ['Disable-ScheduledTask', ...recorded, 'Get-CimInstance', 'Start-Sleep'];
  const command = [
    `$calls = ${q(calls)}`,
    `$fail = @{ ${Object.entries(disable).map(([name, category]) => `${q(name)} = ${q(category)}`).join('; ')} }`,
    'function global:Disable-ScheduledTask { [CmdletBinding()] param([string]$TaskName)',
    '  Add-Content -LiteralPath $calls "Disable-ScheduledTask $TaskName"',
    '  if ($fail[$TaskName]) { $PSCmdlet.WriteError((New-Object System.Management.Automation.ErrorRecord ((New-Object Exception "test: $($fail[$TaskName])"), \'test\', $fail[$TaskName], $TaskName))) } }',
    ...recorded.map((name) => `function global:${name} { Add-Content -LiteralPath $calls '${name}' }`),
    "function global:Get-CimInstance { Add-Content -LiteralPath $calls 'Get-CimInstance'; throw 'test: reached step 1' }",
    'function global:Start-Sleep { }',
    // Refuse to run unless every stub is in place: the real cmdlets would act on the live tasks.
    `foreach ($name in ${stubs.map(q).join(', ')}) { if ((Get-Command $name).CommandType -ne 'Function') { [Console]::Error.WriteLine("stub missing: $name"); exit 99 } }`,
    `& ${q(join(ROOT, 'scripts', 'supervisor', 'deploy.ps1'))} -Sha ${q('a'.repeat(40))} -Root ${q(root)} -Node ${q(process.execPath)}`,
  ].join('\n');
  const out = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(out.status, 99, out.stderr);
  return { ...out, calls: readFileSync(calls, 'utf8').trim().split(/\r?\n/).filter(Boolean), stop: readFileSync(join(data, 'STOP'), 'utf8') };
}

test('deploy.ps1 stops before writing STOP or stopping anything when a task cannot be disabled, and leaves STOP in place', { skip: WINDOWS_ONLY }, (t) => {
  const denied = deploy(t, { 'AIWorks Supervisor': 'PermissionDenied' });
  assert.notEqual(denied.status, 0, denied.stdout);
  assert.match(denied.stderr, /deploy stopped: could not disable task 'AIWorks Supervisor': test: PermissionDenied/);
  assert.doesNotMatch(denied.stderr, /Already disabled/);
  assert.deepEqual(denied.calls, ['Disable-ScheduledTask AIWorks Supervisor']);
  assert.equal(denied.stop, 'earlier failed deploy');
  // When the second task fails, the message names the first, which stays disabled.
  const second = deploy(t, { 'AIWorks Dashboard': 'ResourceUnavailable' });
  assert.notEqual(second.status, 0, second.stdout);
  assert.match(second.stderr, /deploy stopped: could not disable task 'AIWorks Dashboard': test: ResourceUnavailable/);
  assert.match(second.stderr, /Already disabled: AIWorks Supervisor\./);
  assert.deepEqual(second.calls, ['Disable-ScheduledTask AIWorks Supervisor', 'Disable-ScheduledTask AIWorks Dashboard']);
  assert.equal(second.stop, 'earlier failed deploy');
});

test('deploy.ps1 goes on past a task that does not exist', { skip: WINDOWS_ONLY }, (t) => {
  const out = deploy(t, { 'AIWorks Supervisor': 'ObjectNotFound', 'AIWorks Dashboard': 'ObjectNotFound' });
  assert.match(out.stdout, /no task 'AIWorks Supervisor' to disable/);
  assert.match(out.stdout, /no task 'AIWorks Dashboard' to disable/);
  assert.match(out.stdout, /scheduled tasks disabled/);
  assert.match(out.stderr, /test: reached step 1/);
  assert.deepEqual(out.calls, ['Disable-ScheduledTask AIWorks Supervisor', 'Disable-ScheduledTask AIWorks Dashboard', 'Get-CimInstance']);
});
