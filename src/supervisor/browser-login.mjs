// Resolve the login for a task's page origins before its browser tools start. Configuration and run files carry
// references only; credential values exist only in this process and the short-lived login page.
import { tokenStoreFrom, validTokenRef } from './token-store.mjs';

const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512;
const originOf = (value) => {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid login URL');
  return url.origin;
};

/** Only task page URLs select a login, never resource origins, a goal's prose or a worker-supplied URL. */
export function browserLoginSettings(web, config) {
  if (!web || config === undefined) return null;
  try {
    if (!config || !Array.isArray(config.profiles)) throw new Error();
    const origins = new Set(web.urls.map(originOf));
    const seen = new Set();
    const profiles = config.profiles.filter((profile) => {
      if (!profile || originOf(profile.origin) !== profile.origin) throw new Error();
      if (!origins.has(profile.origin)) return false;
      const url = new URL(profile.origin);
      if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error();
      if (seen.has(profile.origin)) throw new Error();
      seen.add(profile.origin);
      if (originOf(profile.loginUrl) !== profile.origin || !validTokenRef(profile.usernameRef) ||
          !validTokenRef(profile.passwordRef) ||
          !['usernameSelector', 'passwordSelector', 'submitSelector', 'successSelector'].every((key) => text(profile[key]))) throw new Error();
      return true;
    }).map(({ origin, loginUrl, usernameRef, passwordRef, usernameSelector, passwordSelector, submitSelector, successSelector }) =>
      ({ origin, loginUrl, usernameRef, passwordRef, usernameSelector, passwordSelector, submitSelector, successSelector }));
    if (!profiles.length) return null;
    // Validate the store without reading any value. It is the operator's configured helper, never task input.
    tokenStoreFrom(config.credentialStore);
    return { credentialStore: config.credentialStore ?? { kind: 'windows' }, profiles };
  } catch {
    throw new Error('Browser pre-login configuration is invalid');
  }
}

/**
 * No worker/MCP client is attached yet. Close every login page before handing over the browser, so its form and
 * authentication requests cannot appear in the worker's snapshots or network history. Cookies stay in the fresh
 * run-local browser profile; they are never exported to a packet, result, log or shared browser profile.
 */
export async function loginBrowser(browser, settings, { store = null, timeoutMs = 60_000 } = {}) {
  if (!settings) return;
  const credentials = store ?? tokenStoreFrom(settings.credentialStore);
  for (const profile of settings.profiles) {
    const existingPages = new Set(await browser.pages());
    let page;
    let stage = 'opening the login page';
    try {
      page = await browser.newPage();
      page.setDefaultTimeout(timeoutMs);
      page.setDefaultNavigationTimeout(timeoutMs);
      // Defense in depth for this page's redirects/forms; browser-mcp also binds all targets to the login origin.
      // This is destination binding, not a permission prompt: configured tasks sign in automatically.
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        let sameOrigin = false;
        try { sameOrigin = originOf(request.url()) === profile.origin; } catch { /* no network destination */ }
        const action = sameOrigin ? request.continue() : request.abort('blockedbyclient');
        action.catch(() => {}); // closing the page may settle a request first
      });
      // Some applications keep their initial navigation open after the login form is usable. The visible form and
      // exact origin are the readiness proof; a failed navigation with no form still times out below.
      void page.goto(profile.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForSelector(profile.passwordSelector, { visible: true });
      if (originOf(page.url()) !== profile.origin) throw new Error();
      stage = 'resolving credential references';
      const username = credentials.get(profile.usernameRef);
      const password = credentials.get(profile.passwordRef);
      if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) throw new Error();
      stage = 'submitting the login';
      await page.locator(profile.usernameSelector).fill(username);
      await page.locator(profile.passwordSelector).fill(password);
      await page.click(profile.submitSelector);
      stage = 'checking the signed-in page';
      await page.waitForSelector(profile.passwordSelector, { hidden: true });
      await page.waitForSelector(profile.successSelector, { visible: true });
      if (originOf(page.url()) !== profile.origin) throw new Error();
    } catch {
      // Browser, page and helper errors can contain request payloads or values. Never forward their text.
      throw new Error(`Browser pre-login failed while ${stage}`);
    } finally {
      try {
        if (page && !page.isClosed()) await page.close();
        // A login can open popups whose URL, form or request history contains credentials. None may reach MCP.
        const opened = (await browser.pages()).filter((item) => !existingPages.has(item));
        await Promise.all(opened.map((item) => item.close()));
        if ((await browser.pages()).some((item) => !existingPages.has(item))) throw new Error();
        // A login's background worker must not retain a credential when MCP restores the broader task scope.
        // Clear only service-worker registrations in this fresh profile; keep the authenticated cookies/storage.
        const controlPage = [...existingPages][0] ?? await browser.newPage();
        const control = await controlPage.createCDPSession();
        try {
          await control.send('Storage.clearDataForOrigin', { origin: profile.origin, storageTypes: 'service_workers' });
          await control.send('ServiceWorker.enable');
          await control.send('ServiceWorker.stopAllWorkers');
          const deadline = Date.now() + 10_000;
          const workerOpen = () => browser.targets().some((target) => ['service_worker', 'shared_worker', 'worker'].includes(target.type()));
          while (workerOpen() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
          if (workerOpen()) throw new Error();
        } finally {
          await control.detach();
          if (!existingPages.has(controlPage)) await controlPage.close();
        }
      } catch { throw new Error('Browser pre-login could not clear its private pages and workers'); }
    }
  }
}
