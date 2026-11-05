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
import { acquireLock, createRelease, release, releaseGate, runStep } from '../../src/supervisor/release/state.mjs';
import { commandCredentialStore } from '../../src/supervisor/release/credential.mjs';
import { runReleaseCommand } from '../../src/supervisor/release/runner.mjs';

const SHA = 'c'.repeat(40);
const REF = 'aiworks-release/sampleapp';

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
