// GET /api/farm/reach (docs/SUPERVISOR.md section 16): the risk is a secret leaving this computer. The check reads the
// sign-in credentials only to see that they exist; they must never appear in the answer or in any request it makes,
// and it must request nothing but the operator's own configured login pages. Synthetic origins and values only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { elmaReach } from '../../src/dashboard/elma-reach.mjs';

test('the reach check requests only configured login pages, sends no credential and never returns one', async () => {
  const secret = `synthetic-password-${randomUUID()}`;
  const config = { browserLogin: { credentialStore: { kind: 'windows' }, profiles: [
    { origin: 'https://app-one.example.invalid', loginUrl: 'https://app-one.example.invalid/_login?returnUrl=%2F', usernameRef: 'app-one-user', passwordRef: 'app-one-pass' },
    { origin: 'https://app-two.example.invalid', loginUrl: 'https://app-two.example.invalid/_login', usernameRef: 'app-two-user', passwordRef: 'app-two-pass' }]
    .map((profile) => ({ ...profile, usernameSelector: '#user', passwordSelector: '#pass', submitSelector: '#go', successSelector: '#home' })) } };
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.startsWith('https://app-two.')) throw Object.assign(new Error(`connect failed ${secret}`), { name: 'TypeError' });
    return new Response('<form></form>', { status: 200 });
  };
  const values = { 'app-one-user': 'synthetic-user', 'app-one-pass': secret, 'app-two-user': 'synthetic-user' };
  const reach = elmaReach({ fetch, reader: () => ({ get: async (ref) => values[ref] ?? null }) });
  const answer = await reach(config);

  assert.deepEqual(requests.map(({ url }) => url).sort(), ['https://app-one.example.invalid/_login?returnUrl=%2F', 'https://app-two.example.invalid/_login']);
  for (const { options } of requests) {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual'); assert.equal(options.body, undefined);
    assert.ok(!JSON.stringify(options.headers ?? {}).includes(secret));
  }
  assert.deepEqual(answer.targets.map(({ origin, network, credentials }) => [origin, network, credentials]),
    [['https://app-one.example.invalid', 'ok', 'ok'], ['https://app-two.example.invalid', 'down', 'missing']]);
  assert.ok(!JSON.stringify(answer).includes(secret) && !JSON.stringify(answer).includes('synthetic-user'), 'no credential value in the answer');
});

// A project's token must not learn another project's hosts: it sees only the origins its registry entry lists.
test('a project-named token reads only the reach of its own project origins; another token reads all', async (t) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { once } = await import('node:events');
  const { createCampaignApiServer } = await import('../../src/dashboard/server.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-reach-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'governance', 'registry', 'projects'), { recursive: true });
  writeFileSync(join(dir, 'governance', 'registry', 'projects', 'sample-wiki.json'), JSON.stringify({ id: 'sample-wiki', web: { buildOrigins: ['https://mine.example.invalid'] } }));
  const values = { 'aiworks-campaign-api:sample-wiki': `scoped-${randomUUID()}`, 'aiworks-campaign-api': `shared-${randomUUID()}` };
  writeFileSync(join(dir, 'vault.json'), JSON.stringify(values));
  writeFileSync(join(dir, 'helper.mjs'), `import { readFileSync } from 'node:fs';
const [vault, op, name] = process.argv.slice(2);
const value = JSON.parse(readFileSync(vault, 'utf8'))[name];
if (value === undefined) process.exit(1);
if (op === 'get') process.stdout.write(value + '\\n');
process.exit(0);
`);
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'data', 'config.json'), JSON.stringify({ governanceRoot: join(dir, 'governance'), campaignApi: { enabled: true, port: 4399,
    tokenRefs: Object.keys(values), credentialStore: { kind: 'command', command: [process.execPath, join(dir, 'helper.mjs'), join(dir, 'vault.json')] } } }));
  const reach = async () => ({ checkedAt: new Date().toISOString(), targets: [{ origin: 'https://mine.example.invalid', network: 'ok' }, { origin: 'https://theirs.example.invalid', network: 'ok' }] });
  const server = createCampaignApiServer({ dataDir: join(dir, 'data'), reach });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const read = async (token) => fetch(`http://127.0.0.1:${server.address().port}/api/farm/reach`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await read(null)).status, 401);
  const scoped = await read(values['aiworks-campaign-api:sample-wiki']), body = await scoped.json(); assert.equal(scoped.status, 200, JSON.stringify(body));
  assert.deepEqual(body.targets.map((row) => row.origin), ['https://mine.example.invalid']);
  assert.equal((await (await read(values['aiworks-campaign-api'])).json()).targets.length, 2);
});
