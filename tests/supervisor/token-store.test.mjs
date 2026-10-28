// token-store.mjs: the campaign API token's store, apart from the release credential. A secret value reaches a child
// process over stdin only, never argv or script text. Synthetic exec only; no test reads the real store.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandTokenStore, readToken, windowsTokenStore } from '../../src/supervisor/token-store.mjs';

const REF = 'aiworks-campaign-api:sample-wiki';

test('the Windows store writes by reference, the value only over stdin, and refuses an unsafe reference', () => {
  const calls = [];
  const answer = (out) => (file, args, options) => { calls.push({ file, args, options }); return out; };
  const writer = windowsTokenStore({ exec: answer({ status: 0 }), powershell: 'ps.exe' });
  writer.set(REF, 'synthetic-value');
  const call = calls.at(-1);
  assert.equal(call.file, 'ps.exe');
  assert.equal(call.options.input, 'synthetic-value');
  assert.equal(call.options.windowsHide, true);
  for (const arg of call.args) assert.ok(!String(arg).includes('synthetic-value'), 'the value never appears in argv');
  const script = Buffer.from(call.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /CredWrite/);
  assert.ok(script.includes(`Write('${REF}', $value)`));
  assert.ok(!script.includes('synthetic-value'), 'the value is never embedded in the script text');
  assert.throws(() => windowsTokenStore({ exec: answer({ status: 5 }), powershell: 'ps.exe' }).set(REF, 'v'), /could not be written/);
  const before = calls.length;
  for (const bad of ["x'); Remove-Item C:\\", 'a b', '', 'x\ny']) assert.throws(() => writer.set(bad, 'v'), /short name/);
  for (const bad of ['', null, 42]) assert.throws(() => writer.set(REF, bad), /non-empty string/);
  assert.equal(calls.length, before, 'nothing runs for a refused reference or value');
});

test('the Windows store answers presence without the value, and a failing read is cannot-tell, never absent', () => {
  const calls = [];
  const store = (status, stdout = '') => windowsTokenStore({ exec: (file, args, options) => { calls.push({ args, options }); return { status, stdout }; }, powershell: 'ps.exe' });
  assert.equal(store(0).has(REF), true);
  assert.equal(store(3).has(REF), false);
  const presence = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le');
  assert.doesNotMatch(presence, /Out\.Write/, 'the presence check never prints the value');
  assert.throws(() => store(1).has(REF), /could not be read/);
  assert.equal(readToken(store(0, 'synthetic-value'), REF), 'synthetic-value');
  assert.equal(readToken(store(3), REF), null);
  assert.equal(readToken(store(0, ''), REF), null);
  assert.throws(() => readToken(store(1), REF), /could not be read/);
});

test('a configured command helper sets a reference over stdin only', () => {
  const calls = [];
  const store = commandTokenStore(['helper'], { exec: (file, args, options) => { calls.push({ file, args, options }); return { status: 0 }; } });
  store.set(REF, 'synthetic-value');
  assert.deepEqual(calls.at(-1).args, ['set', REF]);
  assert.equal(calls.at(-1).options.input, 'synthetic-value');
  assert.throws(() => commandTokenStore(['helper'], { exec: () => ({ status: 2 }) }).set(REF, 'v'), /could not set/);
  assert.throws(() => commandTokenStore(['helper'], { exec: () => ({ status: 2 }) }).has(REF), /could not answer/);
});
