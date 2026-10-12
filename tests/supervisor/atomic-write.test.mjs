import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeAtomic } from '../../src/supervisor/proc.mjs';

test('atomic replacement tolerates transient Windows sharing errors and bounds permanent failure', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'aiworks-atomic-'));
  const path = join(root, 'heartbeat');
  const rename = fs.renameSync;
  let calls = 0;
  try {
    fs.writeFileSync(path, 'old');
    fs.renameSync = (...args) => { if (++calls <= 2) throw Object.assign(new Error('sharing'), { code: 'EPERM' }); return rename(...args); };
    syncBuiltinESMExports();
    writeAtomic(path, 'new');
    assert.equal(calls, 3);
    assert.equal(fs.readFileSync(path, 'utf8'), 'new');
    calls = 0;
    fs.renameSync = () => { calls++; throw Object.assign(new Error('locked'), { code: 'EACCES' }); };
    syncBuiltinESMExports();
    assert.throws(() => writeAtomic(path, 'unsafe'), /locked/);
    assert.equal(calls, 51);
    assert.equal(fs.readFileSync(path, 'utf8'), 'new', 'previous durable receipt survives');
    calls = 0;
    fs.renameSync = () => { calls++; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    syncBuiltinESMExports();
    assert.throws(() => writeAtomic(path, 'unsafe'), /missing/);
    assert.equal(calls, 1, 'unrelated errors are never retried');
  } finally {
    fs.renameSync = rename; syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
