// A timed-out bounded read stops every process it started before it settles (aiworks#140): a helper that outlived the
// deadline could keep writing refs after the controller had judged the read failed.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execBounded } from '../../src/supervisor/adapters/git.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

test('a read that times out has stopped its whole process tree when it settles', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-bounded-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const pidFile = join(dir, 'helper.pid'), late = join(dir, 'late-write');
  // The helper stands in for a fetch's remote helper: it records its pid, then writes after the deadline.
  const helper = join(dir, 'helper.mjs');
  writeFileSync(helper, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => writeFileSync(${JSON.stringify(late)}, 'written after the deadline'), 4000);`);
  const parent = join(dir, 'parent.mjs');
  writeFileSync(parent, `import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(helper)}], { stdio: 'ignore', windowsHide: true });
setInterval(() => {}, 1000);`);

  const result = await execBounded([process.execPath, parent], [], { timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ETIMEDOUT');
  assert.equal(result.contained, undefined, 'the tree stop was shown to finish');
  assert.ok(existsSync(pidFile), 'the helper was running before the deadline');
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false, 'the helper is gone when the read settles');
  await new Promise((done) => setTimeout(done, 3000));
  assert.equal(existsSync(late), false, 'nothing the read started writes after it settled');
});
