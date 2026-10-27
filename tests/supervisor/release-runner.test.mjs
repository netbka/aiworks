// REL5 (AUTO_RELEASE slice R5): a release step runs in its own clean process and fetches its credential by reference
// only. The runner's environment holds no supervisor variable; workers never see the credential; the credential never
// reaches the journal, a release row, a log or a packet; a missing credential fails E12 and runs nothing; with
// release.enabled off the runner is never started. Built switched off until example-org/aiworks#33. The credential is a
// synthetic string served by a synthetic helper; no test reads a real credential store, the network or GitHub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { workerEnv } from '../../src/supervisor/proc.mjs';
import { evaluateEligibility } from '../../src/supervisor/release/eligibility.mjs';
import { acquireLock, createRelease, release, releaseGate, runStep } from '../../src/supervisor/release/state.mjs';
import {
  commandCredentialStore, credentialResolves, fetchCredential, releaseRoleReader, validCredentialRef, windowsCredentialStore,
} from '../../src/supervisor/release/credential.mjs';
import { RELEASE_ENV_KEEP, RELEASE_LOGIN_ENV, releaseEnv, runReleaseCommand } from '../../src/supervisor/release/runner.mjs';

const SHA = 'c'.repeat(40);
const REF = 'aiworks-release/sampleapp';
// On Windows, libuv gives every child it starts these system variables from the parent's own environment when the
// given one lacks them (uv_spawn's required set). They name the machine and user, never the supervisor's configuration.
const LIBUV_WINDOWS = ['homedrive', 'homepath', 'logonserver', 'path', 'systemdrive', 'systemroot', 'temp', 'userdomain', 'username', 'userprofile', 'windir'];
const KEEP = [...RELEASE_ENV_KEEP.map((key) => key.toLowerCase()), ...(process.platform === 'win32' ? LIBUV_WINDOWS : [])];
const PROBES = ['AIWORKS_SUPERVISOR_PROBE', 'CLAUDE_CODE_ENTRYPOINT', 'FAKE_GH_STATE'];

/** A disposable rig: a synthetic credential helper holding one synthetic value, a synthetic `gh`, a data directory. */
function rig(t, { present = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-release-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const secret = `synthetic-release-credential-${randomUUID()}`;
  const tools = join(dir, 'tools'), dataDir = join(dir, 'data'), work = join(dir, 'work');
  for (const path of [tools, dataDir, work]) mkdirSync(path);
  const vault = join(tools, 'vault.json');
  writeFileSync(vault, JSON.stringify(present ? { [REF]: secret } : {}));
  // The credential helper records the environment of the process that asked it: the release runner itself.
  writeFileSync(join(tools, 'helper.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
const [vault, op, ref] = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(tools, 'runner-env.json'))}, JSON.stringify(Object.keys(process.env)));
const value = JSON.parse(readFileSync(vault, 'utf8'))[ref];
if (value === undefined) process.exit(1);
if (op === 'get') process.stdout.write(value + '\\n');
process.exit(0);
`);
  // The synthetic gh prints its whole environment and, deliberately, the token itself on both streams.
  writeFileSync(join(tools, 'gh.mjs'), `import { writeFileSync } from 'node:fs';
writeFileSync('ran', 'yes');
console.log(JSON.stringify(process.env));
console.log('token=' + (process.env.GH_TOKEN ?? ''));
console.error('stderr token=' + (process.env.GH_TOKEN ?? ''));
`);
  const store = { kind: 'command', command: [process.execPath, join(tools, 'helper.mjs'), vault] };
  return { dir, dataDir, work, tools, secret, store, config: { release: { enabled: true, credentialStore: store } },
    gh: [process.execPath, join(tools, 'gh.mjs')], helper: commandCredentialStore(store.command) };
}

/** Every file under `root`, recursively. */
const files = (root) => readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
  const path = join(root, entry.name);
  return entry.isDirectory() ? files(path) : [path];
});

/** The files under `root` whose bytes hold the value, as UTF-8, UTF-16 or base64. */
function holders(root, value) {
  const needles = [Buffer.from(value, 'utf8'), Buffer.from(value, 'utf16le'), Buffer.from(Buffer.from(value).toString('base64'))];
  return files(root).filter((path) => { const bytes = readFileSync(path); return needles.some((needle) => bytes.includes(needle)); });
}

test("the release runner's environment contains no supervisor variables", async (t) => {
  const r = rig(t);
  const inherited = { ...process.env, AIWORKS_SUPERVISOR_PROBE: 'supervisor-only', CLAUDE_CODE_ENTRYPOINT: 'cli', FAKE_GH_STATE: 'x',
    GH_TOKEN: 'the-supervisor-own-gh-login', HOME: 'h', USERPROFILE: 'u', APPDATA: 'a' };
  const result = await runReleaseCommand({ config: r.config, dataDir: r.dataDir, stepKey: 'sampleapp.prod.x.1.merge.1', command: r.gh, cwd: r.work,
    credential: { ref: REF }, inherited });
  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 0, result.output);
  // The release runner process itself: what its credential helper saw.
  const runnerKeys = JSON.parse(readFileSync(join(r.tools, 'runner-env.json'), 'utf8'));
  assert.ok(runnerKeys.length > 0 && runnerKeys.every((key) => KEEP.includes(key.toLowerCase())), `runner environment: ${runnerKeys.join(', ')}`);
  for (const probe of [...PROBES, 'GH_TOKEN']) assert.ok(!runnerKeys.includes(probe), `the runner inherited ${probe}`);
  // The command it ran: PATH, SystemRoot and the fetched credential in GH_TOKEN, nothing else.
  const commandEnv = JSON.parse(result.output.split('\n')[0]);
  for (const key of Object.keys(commandEnv)) assert.ok([...KEEP, 'gh_token'].includes(key.toLowerCase()), `the command inherited ${key}`);
  for (const probe of PROBES) assert.equal(commandEnv[probe], undefined, `the command inherited ${probe}`);
  // Values the supervisor's environment overrode never pass through, even for names libuv supplies on Windows.
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA']) assert.notEqual(commandEnv[key], inherited[key], `${key} came from the supervisor's environment`);
  assert.equal(commandEnv.GH_TOKEN, '[credential withheld]', 'the fetched credential reached the command, and its output is masked');
  assert.ok(!result.output.includes('the-supervisor-own-gh-login'), "the supervisor's own GitHub login never reaches a release command");
  assert.ok(!result.output.includes('supervisor-only'));
  // The same boundary as a pure function: only PATH and SystemRoot survive, whatever their case.
  assert.deepEqual(releaseEnv({ Path: 'p', systemroot: 's', AIWORKS_X: 'x', GH_TOKEN: 't', CLAUDECODE: '1' }), { PATH: 'p', SystemRoot: 's' });
  // A step without a credential gets no GH_TOKEN at all, not the supervisor's.
  const bare = await runReleaseCommand({ config: r.config, dataDir: r.dataDir, stepKey: 'sampleapp.prod.x.1.check.1', command: r.gh, cwd: r.work, inherited });
  assert.equal(JSON.parse(bare.output.split('\n')[0]).GH_TOKEN, undefined);
});

test('worker environments never contain the release credential', async (t) => {
  const r = rig(t);
  const before = JSON.stringify(process.env);
  const result = await runReleaseCommand({ config: r.config, dataDir: r.dataDir, stepKey: 'sampleapp.prod.x.1.merge.1', command: r.gh, cwd: r.work, credential: { ref: REF } });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(JSON.stringify(process.env), before, "running a release step leaves the supervisor's environment unchanged");
  // A worker's environment is the supervisor's (workerEnv) plus its spec: neither holds the value or the reference.
  const worker = JSON.stringify(workerEnv(process.env, { FAKE_CLAUDE_STATE: r.dir }));
  assert.ok(!worker.includes(r.secret), 'a worker never receives the release credential');
  assert.ok(!worker.includes(REF), 'a worker is not even given the credential reference');
  assert.ok(!JSON.stringify(result).includes(r.secret), 'what the supervisor gets back never holds the value');
});

test('the credential never appears in the journal, row, log or packet', async (t) => {
  const r = rig(t);
  const store = new Store(join(r.dataDir, 'supervisor.db'));
  let open = true;
  t.after(() => { if (open) store.close(); });
  const now = Date.parse('2026-11-05T10:00:00Z');
  const lease = { instanceId: 'first', generation: store.acquireLease('c', 'first', now, 60_000).generation };
  const { id } = createRelease(store, { project: 'sampleapp', destination: 'prod', campaignId: 'c', taskId: 'T1', verifiedSha: SHA, grantVersion: 1,
    grantDigest: 'g'.repeat(64), steps: ['merge', 'check'], lease, now });
  assert.equal(acquireLock(store, id, { lease, now, recheck: () => ({ eligible: true, failed: [], inputs: { grantDigest: 'g'.repeat(64) } }) }).locked, true);
  const grant = { record: { version: 1, grantedAt: '2026-11-01', destinations: [{ id: 'prod' }] }, digest: 'g'.repeat(64) };
  const gate = (row) => releaseGate({ dataDir: r.dataDir, config: r.config, store, project: row.project, destination: row.destination, grant });
  const adapter = {
    run: async (row) => {
      const out = await runReleaseCommand({ config: r.config, dataDir: r.dataDir, stepKey: row.step_key, command: r.gh, cwd: r.work,
        credential: { ref: REF }, store, release: row });
      return out.exitCode === 0 ? 'done' : 'failed';
    },
    observe: async () => 'unknown',
  };
  assert.equal((await runStep(store, adapter, id, { lease, now, gate })).state, 'merged');
  assert.equal((await runStep(store, adapter, id, { lease, now, gate })).state, 'accepted');
  const audit = store.all("SELECT detail FROM journal WHERE kind = 'release-command' ORDER BY seq").map((row) => row.detail);
  assert.equal(audit.length, 2, 'every command is journalled');
  for (const entry of audit) {
    assert.equal(entry.exitCode, 0);
    assert.match(entry.outputDigest, /^[0-9a-f]{64}$/);
    assert.equal(entry.credentialRef, REF, 'the journal names the credential by reference');
    assert.ok(entry.startedAt && entry.endedAt);
  }
  const row = release(store, id);
  assert.ok(!JSON.stringify(row).includes(r.secret), 'the release row');
  assert.ok(!JSON.stringify(store.all('SELECT * FROM journal')).includes(r.secret), 'the journal');
  store.close(); open = false;
  // Every byte the supervisor and the runner wrote: the database (rows and journal), the packets, results and logs.
  const written = files(r.dataDir);
  assert.ok(written.some((path) => path.endsWith('packet.json')) && written.some((path) => path.endsWith('output.log')));
  assert.deepEqual(holders(r.dataDir, r.secret), [], 'no file in the data directory holds the credential');
  const packet = readFileSync(written.find((path) => path.endsWith('packet.json')), 'utf8');
  assert.match(packet, new RegExp(REF.replace('/', '\\/')), 'the packet carries the reference');
  const log = readFileSync(written.find((path) => path.endsWith('output.log')), 'utf8');
  assert.match(log, /token=\[credential withheld\]/, 'the command printed the token; the log holds it masked');
  assert.ok(statSync(join(r.work, 'ran')).isFile(), 'the command ran');
});

test('a missing credential makes E12 fail', async (t) => {
  const r = rig(t, { present: false });
  const candidate = { project: 'sampleapp', destinationId: 'prod', taskId: 'T1', verifiedSha: SHA };
  const e12 = (role) => evaluateEligibility(candidate, { role }).failed.find((item) => item.check === 'E12');
  assert.equal(e12(releaseRoleReader({ store: r.helper, refFor: () => REF })).reason, 'the release credential reference does not resolve');
  assert.equal(e12(releaseRoleReader({ store: r.helper, refFor: () => null })).reason, 'the release credential reference does not resolve', 'no reference at all');
  assert.match(e12(releaseRoleReader({ store: { has() { throw new Error('locked'); } }, refFor: () => REF })).reason, /^role: unreadable/,
    'a store that cannot tell is never "present"');
  // Present (another vault): E12 passes on presence alone; the value is never read for it.
  const present = rig(t);
  let gets = 0;
  const watched = { has: (ref) => present.helper.has(ref), get: () => { gets += 1; return null; } };
  assert.equal(e12(releaseRoleReader({ store: watched, refFor: () => REF })), undefined);
  assert.equal(gets, 0, 'E12 asks for presence only');
  assert.equal(credentialResolves(watched, 'not a ref'), false);
  // The runner refuses to run a command whose credential does not resolve.
  const result = await runReleaseCommand({ config: r.config, dataDir: r.dataDir, stepKey: 'sampleapp.prod.x.1.merge.1', command: r.gh, cwd: r.work, credential: { ref: REF } });
  assert.equal(result.ran, false);
  assert.match(result.reason, /aiworks-release\/sampleapp does not resolve/);
  assert.equal(existsSync(join(r.work, 'ran')), false, 'nothing ran without its credential');
  assert.equal(fetchCredential(r.helper, REF), null);
});

test('with release.enabled off the release runner is never started', async (t) => {
  const r = rig(t);
  let started = 0;
  const start = async () => { started += 1; return { code: 0, signal: null }; };
  for (const config of [undefined, {}, { release: {} }, { release: { enabled: 'true' } }, { release: { enabled: 1 } }, { release: { enabled: false } }]) {
    await assert.rejects(runReleaseCommand({ config, dataDir: r.dataDir, stepKey: 'k', command: r.gh, cwd: r.work, credential: { ref: REF }, start }),
      /Auto Release is switched off/);
  }
  assert.equal(started, 0);
  assert.equal(existsSync(join(r.dataDir, 'releases')), false, 'not even a packet is written');
  // A value in place of a reference is refused before anything starts.
  await assert.rejects(runReleaseCommand({ config: r.config, dataDir: r.dataDir, stepKey: 'k', command: r.gh, cwd: r.work, credential: { ref: 'ghp_ value' }, start }),
    /by reference only/);
  await assert.rejects(runReleaseCommand({ config: r.config, dataDir: r.dataDir, stepKey: 'k', command: r.gh, cwd: r.work, credential: { value: r.secret }, start }),
    /by reference only/);
  assert.equal(started, 0);
});

test('a runner that gives no result is an unknown outcome, and a command past its timeout is stopped', async (t) => {
  const r = rig(t);
  await assert.rejects(runReleaseCommand({ config: r.config, dataDir: r.dataDir, stepKey: 'k1', command: r.gh, cwd: r.work,
    start: async () => ({ code: null, signal: 'SIGKILL' }) }), /gave no result/);
  writeFileSync(join(r.tools, 'slow.mjs'), 'setTimeout(() => {}, 60_000);\n');
  const slow = await runReleaseCommand({ config: r.config, dataDir: r.dataDir, stepKey: 'k2', command: [process.execPath, join(r.tools, 'slow.mjs')],
    cwd: r.work, timeoutMs: 500 });
  assert.equal(slow.ran, true);
  assert.equal(slow.exitCode, null);
  assert.equal(slow.reason, 'the command timed out');
});

test('the Windows Credential Manager adapter reads by reference, and presence without the value', () => {
  const calls = [];
  const answer = (out) => (file, args) => { calls.push({ file, args }); return out; };
  const listing = '\r\nCurrently stored credentials for aiworks-release/sampleapp:\r\n\r\n    Target: LegacyGeneric:target=aiworks-release/sampleapp\r\n    Type: Generic\r\n';
  assert.equal(windowsCredentialStore({ exec: answer({ status: 0, stdout: listing }), powershell: 'ps.exe' }).has(REF), true);
  assert.deepEqual(calls.at(-1), { file: 'cmdkey', args: [`/list:${REF}`] }, 'presence comes from cmdkey, which never prints a password');
  assert.equal(windowsCredentialStore({ exec: answer({ status: 0, stdout: listing.replaceAll('sampleapp', 'sampleapp2') }), powershell: 'ps.exe' }).has(REF), false);
  assert.equal(windowsCredentialStore({ exec: answer({ status: 0, stdout: '\r\n* NONE *\r\n' }), powershell: 'ps.exe' }).has(REF), false);
  assert.throws(() => windowsCredentialStore({ exec: answer({ status: 5 }), powershell: 'ps.exe' }).has(REF), /could not list/);
  const reader = windowsCredentialStore({ exec: answer({ status: 0, stdout: 'synthetic' }), powershell: 'ps.exe' });
  assert.equal(reader.get(REF), 'synthetic');
  const script = Buffer.from(calls.at(-1).args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /CredRead/);
  assert.ok(script.includes(`Read('${REF}')`), 'the reference is the only input');
  assert.equal(windowsCredentialStore({ exec: answer({ status: 3 }), powershell: 'ps.exe' }).get(REF), null, 'not found');
  assert.throws(() => windowsCredentialStore({ exec: answer({ status: 1 }), powershell: 'ps.exe' }).get(REF), /could not be read/);
  assert.throws(() => windowsCredentialStore({ exec: answer({ status: 0 }), powershell: null }).has(REF), /only on Windows/);
  // A reference that could break out of the script, the listing or a path never reaches a command.
  const before = calls.length;
  for (const bad of ["x'); Remove-Item C:\\", 'a b', '../x', 'a\nb', '', 'x'.repeat(129), null]) {
    assert.equal(validCredentialRef(bad), false, String(bad));
    assert.throws(() => reader.get(bad), /by reference|short name/);
  }
  assert.equal(calls.length, before);
});

// aiworks campaign-token CLI (src/supervisor/campaign-token.mjs): a generic `set`, usable for any reference this
// store holds, not only the release credential. The value must reach the child only over stdin, never argv.
test('the Windows Credential Manager adapter writes by reference, the value only over stdin', () => {
  const calls = [];
  const answer = (out) => (file, args, options) => { calls.push({ file, args, options }); return out; };
  const writer = windowsCredentialStore({ exec: answer({ status: 0 }), powershell: 'ps.exe' });
  writer.set(REF, 'synthetic-value');
  const call = calls.at(-1);
  assert.equal(call.file, 'ps.exe');
  assert.equal(call.options.input, 'synthetic-value', 'the secret is piped over stdin, an exec option, never a command-line argument');
  for (const arg of call.args) assert.ok(!String(arg).includes('synthetic-value'), 'the value never appears in argv');
  const script = Buffer.from(call.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /CredWrite/);
  assert.ok(script.includes(`Write('${REF}', `), 'the reference is embedded, the value is read from stdin at run time');
  assert.ok(!script.includes('synthetic-value'), 'the value is never embedded in the script text');
  assert.throws(() => windowsCredentialStore({ exec: answer({ status: 5 }), powershell: 'ps.exe' }).set(REF, 'v'), /could not be written/);
  assert.throws(() => windowsCredentialStore({ exec: answer({ status: 0 }), powershell: null }).set(REF, 'v'), /only on Windows/);
  for (const bad of ['', null, undefined, 42]) assert.throws(() => writer.set(REF, bad), /non-empty string/);
  for (const bad of ["x'); Remove-Item C:\\", 'a b', '']) assert.throws(() => writer.set(bad, 'v'), /by reference|short name/);
});

test('a configured command helper can also set a reference, the value only over stdin', () => {
  const calls = [];
  const exec = (file, args, options) => { calls.push({ file, args, options }); return { status: 0 }; };
  const store = commandCredentialStore(['helper'], { exec });
  store.set(REF, 'synthetic-value');
  const call = calls.at(-1);
  assert.deepEqual(call.args, ['set', REF]);
  assert.equal(call.options.input, 'synthetic-value');
  assert.throws(() => store.set(REF, ''), /non-empty string/);
  const failing = commandCredentialStore(['helper'], { exec: () => ({ status: 2 }) });
  assert.throws(() => failing.set(REF, 'v'), /could not set/);
});

// REL5a (plan section 8 (i)): a step that names no credential uses the logins already on this computer.
test('a step without a credential reads no credential store and never sets GH_TOKEN', async (t) => {
  const r = rig(t);
  const inherited = { ...process.env, AIWORKS_SUPERVISOR_PROBE: 'supervisor-only', CLAUDE_CODE_ENTRYPOINT: 'cli', FAKE_GH_STATE: 'x',
    GH_TOKEN: 'the-supervisor-own-gh-token', GITHUB_TOKEN: 'another-token', HOME: join(r.dir, 'home'), APPDATA: join(r.dir, 'appdata'),
    GH_CONFIG_DIR: join(r.dir, 'gh-config') };
  const result = await runReleaseCommand({ config: r.config, dataDir: r.dataDir, stepKey: 'sampleapp.live.x.1.deploy.1', command: r.gh, cwd: r.work, inherited });
  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 0, result.output);
  // The configured credential store is a helper that records every time it is asked; it was never asked.
  assert.equal(existsSync(join(r.tools, 'runner-env.json')), false, 'the credential store was read');
  const packet = JSON.parse(readFileSync(join(r.dataDir, 'releases', 'sampleapp.live.x.1.deploy.1', 'packet.json'), 'utf8'));
  assert.equal(packet.credential, null, 'the packet names no credential and no store');
  // The command finds the operator's logins where they already are, and gets no token and no supervisor variable.
  const commandEnv = JSON.parse(result.output.split('\n')[0]);
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', ...PROBES]) assert.equal(commandEnv[key], undefined, `the command received ${key}`);
  for (const key of ['HOME', 'APPDATA', 'GH_CONFIG_DIR']) assert.equal(commandEnv[key], inherited[key], `the command cannot find the login in ${key}`);
  const allowed = [...KEEP, ...RELEASE_LOGIN_ENV.map((key) => key.toLowerCase())];
  for (const key of Object.keys(commandEnv)) assert.ok(allowed.includes(key.toLowerCase()), `the command inherited ${key}`);
  assert.ok(!result.output.includes('the-supervisor-own-gh-token') && !result.output.includes('another-token'));
  assert.ok(!RELEASE_LOGIN_ENV.some((key) => /TOKEN/i.test(key)), 'no token variable is ever kept');
});
