// Critical behaviour of the Infisical credential helper (scripts/infisical-credential-helper.mjs): it never hands out a
// secret outside its allow list, never leaks a value or the identity's secret except `get`'s own stdout, and never
// reports "absent" when Infisical cannot be reached. A local fake Infisical stands in; every id and value is synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';

const HELPER = join(import.meta.dirname, '..', '..', 'scripts', 'infisical-credential-helper.mjs');
const IDENTITY_SECRET = 'synthetic-client-secret-7f3a';
const SESSION_BEARER = 'synthetic-access-token-91bc';
const SECRETS = { AIWORKS_CAMPAIGN_API_SAMPLEAPP: 'synthetic-campaign-token-5d2e', OTHER_PROJECT_PASSWORD: 'synthetic-other-value-c8a1' };

async function fakeInfisical() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push(url.pathname);
      if (url.pathname === '/api/v1/auth/universal-auth/login') {
        const ok = JSON.parse(body).clientSecret === IDENTITY_SECRET;
        res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' }).end(JSON.stringify(ok ? { accessToken: SESSION_BEARER } : {}));
        return;
      }
      const key = decodeURIComponent(url.pathname.replace('/api/v3/secrets/raw/', ''));
      if (req.headers.authorization !== `Bearer ${SESSION_BEARER}`) { res.writeHead(401).end(); return; }
      if (req.method === 'GET') {
        if (!(key in SECRETS)) { res.writeHead(404).end(JSON.stringify({ message: 'not found' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ secret: { secretKey: key, secretValue: SECRETS[key] } }));
        return;
      }
      res.writeHead(405).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { host: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function runHelper(host, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HELPER, '--project', 'example-project-id', '--environment', 'dev', '--allow', 'aiworks-campaign-api:sampleapp', ...args], {
      env: { ...process.env, INFISICAL_HOST: host, INFISICAL_CLIENT_ID: 'synthetic-client-id', INFISICAL_CLIENT_SECRET: IDENTITY_SECRET },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('a reference outside the allow list is refused for every operation without asking Infisical', async () => {
  const fake = await fakeInfisical();
  try {
    for (const op of ['has', 'get', 'set']) {
      const out = await runHelper(fake.host, [op, 'other-project-password']);
      assert.equal(out.code, 3, `${op} must be refused, not answered as absent or present`);
      assert.doesNotMatch(out.stdout + out.stderr, /synthetic-other-value/);
    }
    assert.deepEqual(fake.requests, []);
  } finally { await fake.close(); }
});

test('no secret value, identity secret or access token reaches output except the value on get stdout', async () => {
  const fake = await fakeInfisical();
  try {
    const has = await runHelper(fake.host, ['has', 'aiworks-campaign-api:sampleapp']);
    assert.equal(has.code, 0);
    const get = await runHelper(fake.host, ['get', 'aiworks-campaign-api:sampleapp']);
    assert.equal(get.code, 0);
    assert.equal(get.stdout, `${SECRETS.AIWORKS_CAMPAIGN_API_SAMPLEAPP}\n`);
    const leaks = [has.stdout, has.stderr, get.stderr].join('\n');
    for (const secret of [SECRETS.AIWORKS_CAMPAIGN_API_SAMPLEAPP, IDENTITY_SECRET, SESSION_BEARER]) assert.ok(!leaks.includes(secret));
    assert.ok(!get.stdout.includes(IDENTITY_SECRET) && !get.stdout.includes(SESSION_BEARER));
  } finally { await fake.close(); }
});

test('an unreachable Infisical is never reported as an absent secret', async () => {
  const fake = await fakeInfisical();
  const host = fake.host;
  await fake.close();
  for (const op of ['has', 'get']) {
    const out = await runHelper(host, [op, 'aiworks-campaign-api:sampleapp']);
    assert.notEqual(out.code, 0);
    assert.notEqual(out.code, 1, `${op} must say "cannot tell", never "absent"`);
  }
});

test('an Infisical redirect never forwards the identity secret to a different destination', async () => {
  let forwarded = 0;
  const destination = createServer((_req, res) => { forwarded++; res.end('{}'); });
  await new Promise((resolve) => destination.listen(0, '127.0.0.1', resolve));
  const redirect = createServer((_req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${destination.address().port}/login` }).end();
  });
  await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  try {
    const out = await runHelper(`http://127.0.0.1:${redirect.address().port}`, ['get', 'aiworks-campaign-api:sampleapp']);
    assert.equal(out.code, 4);
    assert.equal(forwarded, 0);
    assert.ok(!`${out.stdout}${out.stderr}`.includes(IDENTITY_SECRET));
  } finally {
    redirect.closeAllConnections(); destination.closeAllConnections();
    await Promise.all([new Promise((resolve) => redirect.close(resolve)), new Promise((resolve) => destination.close(resolve))]);
  }
});
