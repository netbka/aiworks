// Real synthetic commands exercise the ownership invariant; no live host namespace or model is used.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GateSlotStore, gateActivity, gateCheckoutKey, gateHostKey, recoverGateOwner, startGateRecovery } from '../../src/supervisor/gate-slot.mjs';
import { gateProcessIdentity, processCreationTime, stopOwnedRunAsync } from '../../src/supervisor/proc.mjs';
import { gateTestEnv, useGateTestHost } from './fixtures/gate-host-bootstrap.mjs';

const GATE = fileURLToPath(new URL('../../src/supervisor/gate.mjs', import.meta.url));
const quotedNode = `"${process.execPath}"`;
const script = [
  "import {spawn,spawnSync} from 'node:child_process';",
  "import {existsSync,writeFileSync} from 'node:fs';",
  "import {setTimeout as sleep} from 'node:timers/promises';",
  "const [mode,label,other]=process.argv.slice(2);",
  "writeFileSync(label+'.started.log',JSON.stringify({pid:process.pid,at:Date.now()}));",
  "if(mode.startsWith('tree')) spawn(process.execPath,['work.mjs','leaf',label+'-child'],{stdio:'ignore',windowsHide:true});",
  "if(mode==='tree-nested') {",
  "  const r=spawnSync(process.execPath,[process.env.AIWORKS_TEST_GATE_HELPER,'start','\"'+process.execPath+'\"','work.mjs','hold','orphan'],{cwd:other,encoding:'utf8',windowsHide:true,timeout:60000});",
  "  writeFileSync(label+'.nested.log',JSON.stringify({exit:r.status,output:r.stdout,errors:r.stderr}));",
  "  if(r.status!==0) process.exit(2);",
  "}",
  "if(mode==='nested') {",
  "  const r=spawnSync(process.execPath,[process.env.AIWORKS_TEST_GATE_HELPER,'start-wait','\"'+process.execPath+'\"','work.mjs','instant','nested'],{cwd:other,encoding:'utf8',windowsHide:true,timeout:60000});",
  "  writeFileSync(label+'.nested.log',JSON.stringify({exit:r.status,output:r.stdout,errors:r.stderr}));",
  "  if(r.status!==0) process.exit(2);",
  "}",
  "if(mode!=='instant') while(!existsSync(label+'.release.log')) await sleep(50);",
  "writeFileSync(label+'.ended.log',JSON.stringify({pid:process.pid,at:Date.now()}));",
  "console.log('# all test files\\n# tests 1\\n# pass 1\\n# fail 0');",
].join('\n');

async function until(predicate, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await sleep(100); } while (Date.now() < deadline);
  assert.fail(message);
}

test('managed gates keep one exact owner through nesting, queue changes, wrapper death and racing recovery',
  { skip: process.platform !== 'win32' ? 'Windows Job Object custody' : false, timeout: 300_000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'aiworks-strict-gate-'));
    const host = join(root, 'host');
    useGateTestHost(host);
    const store = new GateSlotStore(host), scratchStore = new GateSlotStore(join(root, 'synthetic-recovery'));
    const dirs = [], standalone = [];
    const resumeLauncher = join(root, 'resume-launcher.log');
    let passed = false;
    t.after(async () => {
      writeFileSync(resumeLauncher, '');
      for (const dir of dirs) for (const label of ['outer', 'b', 'c', 'tree', 'tree-child', 'orphan', 'e', 'f', 'lone', 'slow']) writeFileSync(join(dir, `${label}.release.log`), '');
      for (const child of standalone) { try { child.kill(); } catch { /* already ended */ } }
      const owner = store.owner();
      if (owner?.attached) await stopOwnedRunAsync({ ...owner, containment: 'windows-job-v1' });
      store.close(); scratchStore.close();
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
    const release = (cwd, label) => writeFileSync(marker(cwd, label, 'release'), '');
    const start = (cwd, mode, label, extra = {}, other = null) => {
      const r = spawnSync(process.execPath, [GATE, 'start', quotedNode, 'work.mjs', mode, label, ...(other ? [`"${other}"`] : [])],
        { cwd, env: gateTestEnv(host, { AIWORKS_TEST_GATE_HELPER: GATE, ...extra }), encoding: 'utf8', windowsHide: true, timeout: 45_000 });
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); return request(cwd);
    };
    const done = async (cwd) => {
      await until(() => ['finished', 'failed'].includes(request(cwd)?.state) && existsSync(join(cwd, 'gate-exit.log')), 'gate did not settle');
      assert.equal(readFileSync(join(cwd, 'gate-exit.log'), 'utf8').trim(), '0');
    };

    const a = repo('a'), b = repo('b'), c = repo('c'), nested = repo('nested'), changed = repo('changed'), dirty = repo('dirty');
    const first = start(a, 'nested', 'outer', {}, nested);
    await until(() => existsSync(marker(a, 'outer', 'nested')), 'contained nested gate did not finish');
    assert.equal(JSON.parse(readFileSync(marker(a, 'outer', 'nested'), 'utf8')).exit, 0, 'real in-job nesting shares its parent slot');
    assert.ok(started(nested, 'nested'));
    const originalOwner = store.owner();
    assert.equal(await gateProcessIdentity(originalOwner), 'running');
    const completedNested = request(nested);
    let nestedWrote = false;
    const oldNestedLease = { ...completedNested.identity, requestId: completedNested.id, generation: completedNested.generation, parent: originalOwner };
    assert.equal(store.finish(oldNestedLease, '0', null, () => { nestedWrote = true; }), false);
    assert.equal(nestedWrote, false, 'a completed nested request cannot rewrite evidence while its parent remains live');
    assert.equal(start(a, 'nested', 'outer', {}, nested).id, first.id, 'duplicate same-checkout starts reuse one request');
    const altered = repo('altered-command');
    const launchIdentity = { pid: process.pid, creationTime: await processCreationTime(process.pid) };
    const authorizedCommand = [quotedNode, 'work.mjs', 'instant', 'authorized'];
    const alteredRequest = store.enqueue({ cwd: altered, head: git(altered, 'rev-parse', 'HEAD'), clean: true, launcher: launchIdentity,
      commandDigest: createHash('sha256').update(JSON.stringify(authorizedCommand)).digest('hex') }).request;
    spawnSync(process.execPath, [GATE, 'run', alteredRequest.id, quotedNode, 'work.mjs', 'instant', 'unauthorized'],
      { cwd: altered, env: gateTestEnv(host), encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(request(altered).state, 'failed', 'actual run arguments must match the durable request before a permit');
    assert.equal(started(altered, 'unauthorized'), false);
    // With no waiting child polling the registry, corrupt only the owning row and attempt one synthetic claim.
    const contender = store.enqueue({ cwd: join(root, 'missing-owner-contender'), head: 'unknown', clean: false,
      launcher: launchIdentity, commandDigest: '0'.repeat(64) }).request;
    assert.equal(store.bind(contender.id, launchIdentity), true);
    const intactOwner = store.db.prepare('SELECT owner FROM slot WHERE id=1').get().owner;
    try {
      store.db.prepare('UPDATE slot SET owner=NULL WHERE id=1').run();
      assert.equal(gateActivity().available, false, 'an active request with a missing owner is unavailable, never free');
      assert.throws(() => store.claim(contender.id, launchIdentity, 'Global\\aiworks-gate-' + randomUUID()),
        'contradictory custody cannot admit a second command');
    } finally {
      store.db.prepare('UPDATE slot SET owner=? WHERE id=1').run(intactOwner);
      store.failQueued(contender.id, launchIdentity, 'synthetic-not-launched');
    }
    const copied = JSON.stringify({ host: gateHostKey(host), requestId: originalOwner.requestId, generation: originalOwner.generation, token: originalOwner.token });
    start(b, 'hold', 'b', { AIWORKS_GATE_OWNER: copied });
    await until(() => request(b)?.state === 'failed', 'a copied token outside the owning job was not refused');
    assert.equal(started(b, 'b'), false, 'an environment token alone cannot start a command');
    start(b, 'hold', 'b', { AIWORKS_GATE_SLOT_HELD: '1', AIWORKS_GATE_SLOTS: '99', AIWORKS_GATE_SLOTS_DIR: join(root, 'untrusted-slots') });
    start(c, 'hold', 'c'); start(changed, 'instant', 'changed'); start(dirty, 'instant', 'dirty');
    writeFileSync(join(changed, 'tracked.txt'), 'a new head while queued\n'); git(changed, 'add', 'tracked.txt');
    git(changed, '-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid', 'commit', '-qm', 'changed while waiting');
    writeFileSync(join(dirty, 'work.mjs'), script + '\n// edited while queued\n');
    // Synthetic age corruption cannot evict a demonstrably live owner.
    store.db.prepare('UPDATE slot SET owner=? WHERE id=1').run(JSON.stringify({ ...store.owner(), claimedAt: 0 }));
    assert.equal(await recoverGateOwner(store), false);
    await sleep(300);
    assert.equal(store.owner().requestId, originalOwner.requestId);
    assert.equal(started(b, 'b') || started(c, 'c') || started(changed, 'changed') || started(dirty, 'dirty'), false);
    release(a, 'outer'); await done(a);
    await until(() => started(b, 'b') || started(c, 'c'), 'no queued contender acquired released capacity');
    const winner = started(b, 'b') ? [b, 'b'] : [c, 'c'];
    const loser = winner[0] === b ? [c, 'c'] : [b, 'b'];
    assert.equal(started(...loser), false, 'racing contenders cannot both execute');
    let staleWrote = false;
    assert.equal(store.finish(originalOwner, '0', null, () => { staleWrote = true; }), false);
    assert.equal(staleWrote, false, 'a stale generation cannot publish successor evidence');
    release(...winner); await done(winner[0]);
    await until(() => started(...loser), 'next contender did not acquire capacity');
    release(...loser); await done(loser[0]);
    await until(() => request(changed)?.state === 'failed', 'changed queued head did not refuse');
    assert.equal(started(changed, 'changed'), false);
    assert.notEqual(readFileSync(join(changed, 'gate-exit.log'), 'utf8').trim(), '0');
    await until(() => request(dirty)?.state === 'failed', 'same-head dirty transition did not refuse');
    assert.equal(started(dirty, 'dirty'), false);
    assert.notEqual(readFileSync(join(dirty, 'gate-exit.log'), 'utf8').trim(), '0');
    const intervals = [[a, 'outer'], [b, 'b'], [c, 'c']].map(([cwd, label]) => ({
      start: JSON.parse(readFileSync(marker(cwd, label), 'utf8')).at,
      end: JSON.parse(readFileSync(marker(cwd, label, 'ended'), 'utf8')).at,
    })).sort((x, y) => x.start - y.start);
    assert.ok(intervals.slice(1).every((row, i) => row.start >= intervals[i].end), 'independent command lifetimes never overlap');

    const d = repo('d'), e = repo('e'), f = repo('f'), orphan = repo('orphan');
    start(d, 'tree-nested', 'tree', {}, orphan);
    await until(() => started(d, 'tree-child') && started(orphan, 'orphan'), 'contained descendants did not start');
    const owner = store.owner(), childPid = JSON.parse(readFileSync(marker(d, 'tree-child'), 'utf8')).pid;
    const childCreation = await processCreationTime(childPid);
    assert.ok(childCreation);
    // Reserved intent naming a real existing job is not authority to terminate that job.
    const dummy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }); standalone.push(dummy);
    const identity = { pid: dummy.pid, creationTime: await processCreationTime(dummy.pid) };
    const reserve = (tag, value, jobName) => {
      const row = scratchStore.enqueue({ cwd: join(root, tag), head: 'unknown', clean: false, launcher: value, commandDigest: '0'.repeat(64) }).request;
      assert.equal(scratchStore.bind(row.id, value), true);
      return scratchStore.claim(row.id, value, jobName);
    };
    const mismatched = reserve('mismatch', { ...identity, creationTime: String(BigInt(identity.creationTime) + 1n) }, 'Global\\aiworks-gate-' + randomUUID());
    assert.equal(await recoverGateOwner(scratchStore, mismatched), false, 'PID reuse or identity mismatch never proves capacity free');
    assert.equal(scratchStore.owner().requestId, mismatched.requestId);
    scratchStore.finish(mismatched, 'not-permitted'); // synthetic reservation never attached or executed
    const uncertain = reserve('uncertain', identity, 'Global\\aiworks-gate-' + randomUUID());
    const incomplete = { ...uncertain, creationTime: null };
    scratchStore.db.prepare('UPDATE slot SET owner=? WHERE id=1').run(JSON.stringify(incomplete));
    assert.equal(await recoverGateOwner(scratchStore, incomplete), false, 'unknown identity retains its hold');
    assert.throws(() => scratchStore.owner(), 'malformed custody is unavailable, never free');
    scratchStore.db.prepare('UPDATE slot SET owner=? WHERE id=1').run(JSON.stringify(uncertain));
    scratchStore.finish(uncertain, 'not-permitted');
    const reserved = reserve('reserved', identity, owner.jobName);
    dummy.kill(); await until(async () => await gateProcessIdentity(identity) === 'not-running', 'synthetic owner did not end');
    assert.equal(await recoverGateOwner(scratchStore, reserved), true);
    assert.equal(await gateProcessIdentity(owner), 'running', 'unattached reservation never kills a pre-existing job');
    assert.equal(await processCreationTime(childPid), childCreation);
    assert.equal(await gateProcessIdentity(owner), 'running');
    const reservedSnapshot = { ...owner, attached: false, phase: 'reserved' };
    process.kill(owner.pid); // exact, still-running fixture owner; its noninherited handle must contain every descendant
    await until(async () => await gateProcessIdentity(owner) === 'not-running', 'fixture wrapper did not end');
    const releases = [], finish = store.finish.bind(store);
    store.finish = (...args) => { const done = finish(...args); if (done) releases.push(args[0]); return done; };
    try {
      await Promise.all([recoverGateOwner(store, reservedSnapshot), recoverGateOwner(store, owner)]);
    } finally { store.finish = finish; }
    assert.equal(releases.length, 1, 'racing recoverers release the old generation once');
    assert.equal(releases[0].attached, true, 'a stale reserved snapshot must re-read committed attached custody');
    assert.notEqual(await processCreationTime(childPid), childCreation, 'release requires every old descendant to be gone');
    assert.equal(request(orphan).state, 'failed', 'outer custody drain settles its orphaned nested request');
    start(e, 'hold', 'e'); start(f, 'hold', 'f');
    await until(() => started(e, 'e') || started(f, 'f'), 'dead-owner recovery did not resume the queue');
    assert.notEqual(await processCreationTime(childPid), childCreation, 'new execution requires the old descendant to be gone');
    const recovered = started(e, 'e') ? [e, 'e'] : [f, 'f'];
    const waiting = recovered[0] === e ? [f, 'f'] : [e, 'e'];
    assert.equal(started(...waiting), false, 'concurrent recoverers release only the old generation');
    assert.equal(await recoverGateOwner(store, owner), false, 'a late old snapshot cannot release its successor');
    release(...recovered); await done(recovered[0]);
    await until(() => started(...waiting), 'remaining contender did not resume'); release(...waiting); await done(waiting[0]);

    // This is the same lifecycle used by supervisor serve, independent of worker admission. No contender or model
    // call exists to wake recovery: read-only pressure must become free when this exact owner is proven dead.
    const lone = repo('no-contender'); start(lone, 'hold', 'lone');
    await until(() => started(lone, 'lone'), 'standalone holder did not start');
    const loneOwner = store.owner(), beforeRecovery = store.snapshot().requests.length;
    assert.equal(store.snapshot().requests.some((row) => row.state === 'queued'), false);
    const maintenance = startGateRecovery({ intervalMs: 25 });
    try {
      await maintenance.poll();
      assert.equal(store.owner().requestId, loneOwner.requestId, 'maintenance cannot evict a living holder');
      store.db.prepare('UPDATE slot SET owner=? WHERE id=1').run(JSON.stringify({ ...loneOwner, creationTime: null }));
      await maintenance.poll();
      assert.equal(gateActivity().available, false, 'uncertain custody stays held without dispatching a replacement');
      store.db.prepare('UPDATE slot SET owner=? WHERE id=1').run(JSON.stringify(loneOwner));
      process.kill(loneOwner.pid);
      await until(() => store.owner() === null, 'supervisor maintenance did not recover a dead holder without a contender');
      assert.equal(gateActivity().count, 0);
      assert.equal(request(lone).state, 'failed');
      assert.equal(store.snapshot().requests.length, beforeRecovery, 'recovery does not create another gate request');
    } finally {
      await maintenance.stop();
      // Restore only a deliberately corrupted synthetic row if an assertion failed before its restoration.
      const raw = JSON.parse(store.db.prepare('SELECT owner FROM slot WHERE id=1').get().owner ?? 'null');
      if (raw?.requestId === loneOwner.requestId && raw.creationTime === null) store.db.prepare('UPDATE slot SET owner=? WHERE id=1').run(JSON.stringify(loneOwner));
    }

    // Pause a launcher after durable enqueue but before replacing the prior same-head passing files. A coalescing
    // start-wait must retain the NEW request identity, not return success from that old receipt/exit pair.
    const race = repo('launcher-race'); start(race, 'instant', 'seed'); await done(race);
    const oldRequest = request(race).id;
    const paused = join(root, 'launcher-paused.log'), joined = join(root, 'waiter-joined.log');
    const preload = join(root, 'pause-launcher.mjs');
    writeFileSync(preload, [
      `import {GateSlotStore} from ${JSON.stringify(new URL('../../src/supervisor/gate-slot.mjs', import.meta.url).href)};`,
      "import {existsSync,writeFileSync} from 'node:fs';",
      'const enqueue=GateSlotStore.prototype.enqueue;',
      'GateSlotStore.prototype.enqueue=function(...args){',
      '  const result=enqueue.apply(this,args);',
      `  writeFileSync(result.created?${JSON.stringify(paused)}:${JSON.stringify(joined)},result.request.id);`,
      '  const deadline=Date.now()+30000;',
      `  if(result.created) while(!existsSync(${JSON.stringify(resumeLauncher)})&&Date.now()<deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);`,
      '  return result;',
      '};',
    ].join('\n'));
    const env = gateTestEnv(host);
    env.NODE_OPTIONS += ` --import=${pathToFileURL(preload).href}`;
    const launch = (action) => {
      const child = spawn(process.execPath, [GATE, action, quotedNode, 'work.mjs', 'hold', 'slow'],
        { cwd: race, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); standalone.push(child);
      child.stdout.resume(); child.stderr.resume(); return child;
    };
    const launcher = launch('start');
    await until(() => existsSync(paused), 'launcher did not reach durable pause');
    const newRequest = readFileSync(paused, 'utf8');
    assert.notEqual(newRequest, oldRequest);
    assert.equal(JSON.parse(readFileSync(join(race, 'gate-request.log'), 'utf8')).id, oldRequest);
    assert.equal(readFileSync(join(race, 'gate-exit.log'), 'utf8').trim(), '0');
    const waiter = launch('start-wait');
    await until(() => existsSync(joined), 'duplicate waiter did not bind its request');
    assert.equal(readFileSync(joined, 'utf8'), newRequest);
    await sleep(500);
    assert.equal(waiter.exitCode, null, 'old passing evidence cannot complete a newly enqueued request');
    writeFileSync(resumeLauncher, '');
    await until(() => started(race, 'slow'), 'new gate command did not start');
    assert.equal(waiter.exitCode, null, 'start-wait awaits command completion without another caller');
    release(race, 'slow'); await done(race);
    await until(() => waiter.exitCode !== null && launcher.exitCode !== null, 'bounded helper calls did not finish');
    assert.equal(waiter.exitCode, 0); assert.equal(launcher.exitCode, 0);
    assert.equal(store.owner(), null);
    assert.ok(store.snapshot().requests.every((row) => !['queued', 'running', 'held'].includes(row.state)));
    passed = true;
  });
