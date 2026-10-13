import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { POWERSHELL, writeAtomic } from '../../src/supervisor/proc.mjs';

test('atomic receipts survive a Windows reader lock and fail closed for a persistent lock', { skip: !POWERSHELL }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-atomic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const receipt = join(dir, 'heartbeat'), ready = join(dir, 'ready'), release = join(dir, 'release');
  writeFileSync(receipt, 'old');
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  // The brief lock ends on the reader's own timer, inside writeAtomic's >= 1 s retry window. The persistent lock is held until
  // the test writes `release`, so the expected EPERM never depends on how fast a loaded machine schedules either side (historical regression).
  for (const persistent of [false, true]) {
    for (const marker of [ready, release]) rmSync(marker, { force: true });
    const hold = persistent ? `while (-not [IO.File]::Exists(${quote(release)})) { [Threading.Thread]::Sleep(20) }` : '[Threading.Thread]::Sleep(300)';
    const script = `$f=[IO.File]::Open(${quote(receipt)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); ` +
      `try { [IO.File]::WriteAllText(${quote(ready)},''); ${hold} } finally { $f.Dispose() }`;
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let stderr = ''; child.stdout.resume(); child.stderr.on('data', (data) => { stderr += data; });
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await sleep(10);
      assert.ok(existsSync(ready), stderr || 'reader did not acquire lock');
      if (!persistent) {
        writeAtomic(receipt, 'new');
        assert.equal(readFileSync(receipt, 'utf8'), 'new');
      } else {
        assert.throws(() => writeAtomic(receipt, 'unconfirmed'), { code: 'EPERM' });
        assert.equal(readFileSync(receipt, 'utf8'), 'new', 'failed replace preserves the last durable receipt');
      }
    } finally { writeFileSync(release, ''); await exited; }
  }
});
