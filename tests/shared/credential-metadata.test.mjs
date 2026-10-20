import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Coordinator reply bodies of up to 61000 characters are classified on every owner Home/state request, so the
// classifier must stay linear on long unbroken text and long wrapper chains while every credential-bearing form
// stays refused.
test('long report text is classified in bounded time and credential-bearing URLs stay refused', () => {
  const classifier = new URL('../../src/shared/credential-metadata.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { containsCredentialMaterial } from ${JSON.stringify(classifier)};
    const word = 'a'.repeat(61000);
    const chain = (unit) => unit.repeat(Math.floor(61000 / unit.length));
    const inputs = {
      plainWord: word, schemeLikeWord: 'ab1.c+d-'.repeat(7625), lateDelimiter: word + '//',
      lateUserinfo: word + ' https://user:' + 'pw@example.test/x', lateSchemeRelative: word + ' //example.test/?token=x',
      encodedQuery: 'see https%3A%2F%2Fexample.test%2Fcb%3Fapi_key%3Dx',
      nestedRedirect: 'go https://example.test/?next=https%3A%2F%2Fexample.test%2F%3Fpassword%3Dx',
      jsonNested: '{"link":"https://example.test/?client_secret=x"}', malformedEscape: 'open https://example.test/%E0%A4%A here',
      ordinary: 'Report: see https://example.test/docs for the plan.',
      colonChain: chain('a:'), equalsChain: chain('a='), authorityChain: chain('a://'), lineChain: chain('name: value\\n'),
      codeChain: chain('x = y;\\n'), mixedChain: chain('a:a='),
      equalsLateKey: chain('a=') + 'token=x', authorityLateUserinfo: chain('a://') + 'user:' + 'pw@example.test/',
      lineLateEncoded: chain('name: value\\n') + 'cb: https%3A%2F%2Fexample.test%2F%3Fpassword%3Dx',
      codeLateMalformed: chain('x = y;\\n') + 'z = %E0%A4%A', colonLateMalformed: chain('a:') + 'b%E0%A4%A',
      fragmentChain: chain('a:#'),
    };
    for (let i = 0; i < 20; i++) containsCredentialMaterial(word + i);
    console.log(JSON.stringify(Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, containsCredentialMaterial(v)]))));
  `], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(child.error, undefined, 'classification exceeded its time bound');
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    plainWord: false, schemeLikeWord: false, lateDelimiter: false, lateUserinfo: true, lateSchemeRelative: true,
    encodedQuery: true, nestedRedirect: true, jsonNested: true, malformedEscape: true, ordinary: false,
    colonChain: false, equalsChain: false, authorityChain: false, lineChain: false, codeChain: false, mixedChain: false,
    equalsLateKey: true, authorityLateUserinfo: true, lineLateEncoded: true, codeLateMalformed: true, colonLateMalformed: true,
    // A chain the one-pass walk cannot skip exhausts the work budget and is refused, never passed unread.
    fragmentChain: true,
  });
});
