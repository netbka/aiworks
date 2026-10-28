// Credentials must stay bound to the task's destination and out of the browser tool's form/network history.
// The browser fixture uses only loopback, synthetic values and a fresh disposable profile.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { browserLoginSettings, loginBrowser } from '../../src/supervisor/browser-login.mjs';
import { browserServers } from '../../src/supervisor/adapters/agy.mjs';

const profile = (origin, prefix) => ({ origin, loginUrl: `${origin}/login`, usernameRef: `${prefix}-user`,
  passwordRef: `${prefix}-password`, usernameSelector: 'input[name=user]', passwordSelector: 'input[type=password]',
  submitSelector: 'button[type=submit]', successSelector: '#signed-in' });

test('browser pre-login selects only declared page origins, keeping DEV and PROD references separate', () => {
  const dev = profile('https://dev.example.invalid', 'dev');
  const prod = profile('https://app.example.invalid', 'prod');
  const config = { profiles: [dev, prod] };
  assert.deepEqual(browserLoginSettings({ urls: [`${dev.origin}/work`], resourceOrigins: [prod.origin] }, config).profiles, [dev]);
  assert.deepEqual(browserLoginSettings({ urls: [`${prod.origin}/work`] }, config).profiles, [prod]);
  assert.equal(browserLoginSettings({ urls: ['https://app.example.invalid.attacker.invalid/'] }, config), null);
  assert.throws(() => browserLoginSettings({ urls: [dev.origin] }, { profiles: [{ ...dev, loginUrl: `${prod.origin}/login` }] }));
  const plain = profile('http://app.example.invalid', 'plain');
  assert.throws(() => browserLoginSettings({ urls: [plain.origin] }, { profiles: [plain] }));
});

const chrome = [process.env.AIWORKS_TEST_CHROME,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')].find((path) => path && existsSync(path));

test('pre-login keeps credentials on the selected origin and closes its private page before browser tools attach',
  { skip: !chrome && 'set AIWORKS_TEST_CHROME to run the synthetic browser credential boundary', timeout: 60_000 }, async (t) => {
    const { puppeteer } = await import(pathToFileURL(createRequire(import.meta.url)
      .resolve('chrome-devtools-mcp/build/src/third_party/index.js')).href);
    const dir = mkdtempSync(join(tmpdir(), 'aiworks-browser-login-'));
    let browser;
    t.after(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
    const user = 'synthetic-account', password = 'fake-password';
    const received = [];
    let mode = 'success';
    const foreign = createServer((req, res) => { received.push({ foreign: true }); res.end('foreign'); });
    foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
    t.after(() => { foreign.closeAllConnections(); foreign.close(); });
    const foreignOrigin = `http://127.0.0.1:${foreign.address().port}`;
    const server = createServer(async (req, res) => {
      if (mode === 'redirect') { res.writeHead(302, { location: `${foreignOrigin}/login` }); res.end(); return; }
      if (req.url === '/login') {
        res.setHeader('content-type', 'text/html');
        res.end('<form method="POST" action="/session"><input name="user"><input name="password" type="password"><button type="submit">Sign in</button></form>');
      } else if (req.url === '/session') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        received.push({ body: Buffer.concat(chunks).toString() });
        res.writeHead(302, { location: '/home', 'set-cookie': 'session=synthetic-session; HttpOnly; Path=/' }); res.end();
      } else { res.setHeader('content-type', 'text/html'); res.end('<main id="signed-in">Signed in</main>'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const settings = browserLoginSettings({ urls: [`${origin}/home`] }, { profiles: [profile(origin, 'dev')] });
    const servers = browserServers({ runDir: dir, web: { urls: [`${origin}/home`] }, chromeCommand: [chrome], browserLogin: settings });
    const runConfig = readFileSync(servers.mcpServers.browser.args[1], 'utf8');
    for (const value of [user, password]) assert.ok(!runConfig.includes(value));
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: join(dir, 'profile'),
      args: ['--disable-background-networking', '--disable-extensions'] });
    const reads = [];
    const store = { get(ref) { reads.push(ref); return ref === 'dev-user' ? user : password; } };
    await loginBrowser(browser, settings, { store, timeoutMs: 5000 });
    assert.deepEqual(reads, ['dev-user', 'dev-password']);
    assert.deepEqual(received, [{ body: `user=${user}&password=${password}` }]);
    assert.ok((await browser.cookies()).some((cookie) => cookie.name === 'session'));
    assert.deepEqual((await browser.pages()).map((page) => page.url()), ['about:blank'], 'no login form or request history is handed over');

    mode = 'redirect'; reads.length = 0; received.length = 0;
    await assert.rejects(loginBrowser(browser, settings, { store, timeoutMs: 1000 }), { message: 'Browser pre-login failed while opening the login page' });
    assert.deepEqual(reads, [], 'a redirected page never receives a credential');
    assert.deepEqual(received, [], 'the foreign origin is not contacted');
    assert.deepEqual((await browser.pages()).map((page) => page.url()), ['about:blank']);
  });
