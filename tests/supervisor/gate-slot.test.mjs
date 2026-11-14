// The exclusive full-check slot (gate-slot.mjs) mostly decides host contention, which is not product-critical. What it
// must never do is let a gate run produce evidence for something other than its durable request: a command other than
// the requested one, or a checkout that changed while the request waited. Real synthetic commands; no live host
// namespace or model is used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { GateSlotStore, gateCheckoutKey } from '../../src/supervisor/gate-slot.mjs';
import { processCreationTime, stopOwnedRunAsync } from '../../src/supervisor/proc.mjs';
import { gateTestEnv, useGateTestHost } from './fixtures/gate-host-bootstrap.mjs';

const GATE = fileURLToPath(new URL('../../src/supervisor/gate.mjs', import.meta.url));
const quotedNode = `"${process.execPath}"`;
const script = [
  "import {existsSync,writeFileSync} from 'node:fs';",
  "import {setTimeout as sleep} from 'node:timers/promises';",
  "const [mode,label]=process.argv.slice(2);",
  "writeFileSync(label+'.started.log',JSON.stringify({pid:process.pid,at:Date.now()}));",
  "if(mode!=='instant') while(!existsSync(label+'.release.log')) await sleep(50);",
  "writeFileSync(label+'.ended.log',JSON.stringify({pid:process.pid,at:Date.now()}));",
  "console.log('# all test files\\n# tests 1\\n# pass 1\\n# fail 0');",
].join('\n');

async function until(predicate, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await sleep(100); } while (Date.now() < deadline);
  assert.fail(message);
}

test('a gate runs only its requested command, and a checkout changed while queued is refused, never passed',
  { skip: process.platform !== 'win32' ? 'Windows Job Object custody' : false, timeout: 300_000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'aiworks-strict-gate-'));
    const host = join(root, 'host');
    useGateTestHost(host);
    const store = new GateSlotStore(host);
    const dirs = [];
    let passed = false;
    t.after(async () => {
      for (const dir of dirs) writeFileSync(join(dir, 'outer.release.log'), '');
      const owner = store.owner();
      if (owner?.attached) await stopOwnedRunAsync({ ...owner, containment: 'windows-job-v1' });
      store.close();
      if (passed) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      else t.diagnostic(`Synthetic gate evidence retained in ${root}`);
    });
    const git = (cwd, ...args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
    };
    const repo = (name) => {
      const cwd = join(root, name); mkdirSync(cwd); dirs.push(cwd);
      writeFileSync(join(cwd, 'work.mjs'), script); writeFileSync(join(cwd, '.gitignore'), '*.log\n');
      git(cwd, 'init', '-q'); git(cwd, 'add', '-A');
      git(cwd, '-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid', 'commit', '-qm', 'synthetic gate');
      return cwd;
    };
    const request = (cwd) => store.snapshot().requests.filter((r) => r.checkoutKey === gateCheckoutKey(cwd)).at(-1);
    const marker = (cwd, label, kind = 'started') => join(cwd, `${label}.${kind}.log`);
    const started = (cwd, label) => existsSync(marker(cwd, label));
    const start = (cwd, mode, label) => {
      const r = spawnSync(process.execPath, [GATE, 'start', quotedNode, 'work.mjs', mode, label],
        { cwd, env: gateTestEnv(host), encoding: 'utf8', windowsHide: true, timeout: 45_000 });
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); return request(cwd);
    };

    // A run whose arguments differ from the durable request gets no permit and leaves no passing evidence.
    const altered = repo('altered-command');
    const launcher = { pid: process.pid, creationTime: await processCreationTime(process.pid) };
    const authorizedCommand = [quotedNode, 'work.mjs', 'instant', 'authorized'];
    const alteredRequest = store.enqueue({ cwd: altered, head: git(altered, 'rev-parse', 'HEAD'), clean: true, launcher,
      commandDigest: createHash('sha256').update(JSON.stringify(authorizedCommand)).digest('hex') }).request;
    spawnSync(process.execPath, [GATE, 'run', alteredRequest.id, quotedNode, 'work.mjs', 'instant', 'unauthorized'],
      { cwd: altered, env: gateTestEnv(host), encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(request(altered).state, 'failed', 'actual run arguments must match the durable request before a permit');
    assert.equal(started(altered, 'unauthorized'), false);

    // While one gate holds the slot, two others queue; one gets a new commit and one a changed tracked file.
    const a = repo('a'), changed = repo('changed'), dirty = repo('dirty');
    start(a, 'hold', 'outer');
    await until(() => started(a, 'outer'), 'the holding gate did not start');
    start(changed, 'instant', 'changed'); start(dirty, 'instant', 'dirty');
    writeFileSync(join(changed, 'tracked.txt'), 'a new head while queued\n'); git(changed, 'add', 'tracked.txt');
    git(changed, '-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid', 'commit', '-qm', 'changed while waiting');
    writeFileSync(join(dirty, 'work.mjs'), script + '\n// edited while queued\n');
    await sleep(300);
    assert.equal(started(changed, 'changed') || started(dirty, 'dirty'), false, 'nothing runs while the slot is held');
    writeFileSync(marker(a, 'outer', 'release'), '');
    for (const [cwd, label] of [[changed, 'changed'], [dirty, 'dirty']]) {
      await until(() => request(cwd)?.state === 'failed', `${label}: a checkout changed while queued did not refuse`);
      assert.equal(started(cwd, label), false, `${label}: its command never ran`);
      assert.notEqual(readFileSync(join(cwd, 'gate-exit.log'), 'utf8').trim(), '0', `${label}: no passing evidence`);
    }
    await until(() => store.owner() === null, 'the slot was not released');
    passed = true;
  });
