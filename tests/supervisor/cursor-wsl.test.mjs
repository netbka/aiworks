import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { environment } from './helpers.mjs';
import { cursorWslInvocation, cursorWslCleanupResult, stopCursorWsl } from '../../src/supervisor/adapters/cursor-wsl.mjs';

test('WSL research cannot spend on another model or mount outside its authorized run root', { skip: process.platform !== 'win32' }, (t) => {
  const env = environment(); t.after(() => env.cleanup());
  const packageRoot = join(env.tmp, 'package'), runDir = join(env.tmp, 'run');
  for (const p of [packageRoot, runDir, ...['scratch', 'config', 'data'].map((p) => join(runDir, p))]) mkdirSync(p);
  for (const p of ['node', 'index.js']) writeFileSync(join(packageRoot, p), 'synthetic executable fixture; never launched');
  const credentialFile = join(env.tmp, 'login.fixture'); writeFileSync(credentialFile, 'synthetic');
  const configFile = join(env.tmp, 'bridge.json');
  writeFileSync(configFile, JSON.stringify({ version: 1, distribution: 'ExampleLinux', allowedRoot: env.tmp,
    packageRoot, credentialFile, allowedModels: ['included-model'] }));
  const command = [process.execPath, fileURLToPath(new URL('../../src/supervisor/adapters/cursor-wsl.mjs', import.meta.url)), '--config', configFile];
  const args = { runDir, cwd: join(runDir, 'scratch'), configDir: join(runDir, 'config'), dataDir: join(runDir, 'data'),
    model: 'included-model', timeoutMs: 60_000 };
  assert.throws(() => cursorWslInvocation(command, { ...args, model: 'other-model' }), /not authorized/);
  assert.throws(() => cursorWslInvocation(command, { ...args, cwd: env.repo }), /mount escapes/);
  const config = JSON.parse(readFileSync(configFile));
  for (const invalid of [{ packageRoot: args.cwd }, { packageRoot: env.tmp },
    { credentialFile: join(args.dataDir, 'login.fixture') }]) {
    if (invalid.credentialFile) writeFileSync(invalid.credentialFile, 'synthetic');
    writeFileSync(configFile, JSON.stringify({ ...config, ...invalid }));
    assert.throws(() => cursorWslInvocation(command, args), /mounts overlap/, 'read-only sources cannot alias writable mounts');
  }
  writeFileSync(configFile, JSON.stringify(config));
  const nested = join(args.cwd, 'nested'); mkdirSync(nested);
  assert.throws(() => cursorWslInvocation(command, { ...args, configDir: nested }), /mounts overlap/);
  const invocation = cursorWslInvocation(command, args);
  const request = JSON.parse(readFileSync(invocation.externalContainment.requestFile));
  assert.equal(request.argv[request.argv.indexOf('--model') + 1], 'included-model');
  assert.equal(request.argv[request.argv.indexOf('--sandbox') + 1], 'enabled');
  assert.equal(request.argv[request.argv.indexOf('--allowed-tools') + 1], 'read_todos_tool_call');
  assert.equal(request.nonce, invocation.externalContainment.nonce);
  assert.throws(() => cursorWslInvocation(command, args), /EEXIST/, 'a recorded launch cannot be overwritten');
  assert.equal(stopCursorWsl({ ...invocation.externalContainment, nonce: '00000000-0000-4000-8000-000000000000' }),
    'ownership-unavailable', 'a stale nonce refuses before calling any external program');
});

test('a Linux cleanup receipt cannot release custody for a different or unfinished attempt', () => {
  const expected = { nonce: '10000000-0000-4000-8000-000000000000' };
  const result = { version: 1, nonce: expected.nonce, stopped: true };
  const output = (value) => ({ status: 0, stdout: JSON.stringify(value) });
  assert.equal(cursorWslCleanupResult(output(result), expected), 'stopped');
  for (const value of [{ ...result, stopped: false }, { ...result, nonce: '20000000-0000-4000-8000-000000000000' },
    { ...result, version: 2 }, { ...result, error: true }, { version: 1, stopped: true }]) {
    assert.equal(cursorWslCleanupResult(output(value), expected), 'ownership-unavailable');
  }
  assert.equal(cursorWslCleanupResult({ ...output(result), status: 1 }, expected), 'ownership-unavailable');
  assert.equal(cursorWslCleanupResult({ ...output(result), error: true }, expected), 'ownership-unavailable');
  assert.equal(cursorWslCleanupResult(output({ version: 1, stopped: true }), {}), 'ownership-unavailable');
});
