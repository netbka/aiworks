// Can this farm reach the web applications its browser workers sign in to? (docs/SUPERVISOR.md section 16, "GET
// /api/farm/reach"). An external caller (the change-request tracker that sends work here) asks before it sends work and
// warns its operator when an application cannot be reached from this computer (a VPN down, a host renamed, a password
// missing in the secret store), instead of finding out from a failed run.
//
// What is checked, and what is not:
// - network: one plain GET of each configured `browserLogin` profile's own login URL, with no cookie, no credential and
//   no redirect followed. Any HTTP answer below 500 means the application answers this computer. Nothing is submitted:
//   a sign-in is never attempted here, so a check can never lock an account or change anything there.
// - credentials: whether both references of the profile resolve in the configured store, once an hour. The values are
//   read only to see that they are non-empty and are dropped at once; they are never compared, sent, stored or logged.
// Only the operator's own `config.json` profiles are checked: the caller names nothing, so this route cannot be used to
// make this computer fetch an address of the caller's choosing or test a secret against one.
import { asyncTokenReader } from '../supervisor/token-store.mjs';
import { browserLoginSettings } from '../supervisor/browser-login.mjs';

export const REACH_FRESH_MS = 5 * 60_000;
export const CREDENTIALS_FRESH_MS = 60 * 60_000;
export const REACH_TIMEOUT_MS = 15_000;
// A store that could not tell is asked again sooner than a definite answer.
const UNKNOWN_FRESH_MS = 5 * 60_000;

/**
 * The operator's configured sign-in targets, one per profile: `{ origin, loginUrl, usernameRef, passwordRef }` for a
 * profile a browser run would accept, `{ origin, invalid: true }` for one it would refuse (each checked alone, with the
 * same validation a run applies to the profile of its own origin), so a broken profile is reported, never dropped.
 */
export function reachTargets(config) {
  const browserLogin = config?.browserLogin, profiles = Array.isArray(browserLogin?.profiles) ? browserLogin.profiles : [];
  const seen = new Set();
  return profiles.map((profile) => {
    let origin = null;
    try { origin = new URL(profile?.origin).origin; } catch { /* reported as an invalid profile below */ }
    try {
      if (!origin || seen.has(origin)) throw new Error();
      seen.add(origin);
      if (!browserLoginSettings({ urls: [origin] }, { ...browserLogin, profiles: [profile] })) throw new Error();
      return { origin, loginUrl: new URL(profile.loginUrl).href, usernameRef: profile.usernameRef, passwordRef: profile.passwordRef };
    } catch { return { origin, invalid: true }; }
  });
}

/**
 * The answer of `GET /api/farm/reach`, refreshed at most every REACH_FRESH_MS (credentials every CREDENTIALS_FRESH_MS);
 * one check runs at a time and callers in between share it. `fetch`, `reader` and `now` are injectable for tests.
 */
export function elmaReach({ fetch = globalThis.fetch, reader = asyncTokenReader, now = Date.now } = {}) {
  let answer = null, running = null;
  const credentials = new Map(), downSince = new Map();
  const network = async (target) => {
    const started = now();
    try {
      const response = await fetch(target.loginUrl, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(REACH_TIMEOUT_MS) });
      await response.body?.cancel().catch(() => {});
      return response.status < 500 ? { network: 'ok', httpStatus: response.status, ms: now() - started } : { network: 'down', httpStatus: response.status, reason: 'server-error' };
    } catch (error) {
      const code = String(error?.cause?.code ?? '');
      return { network: 'down', httpStatus: null, reason: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout'
        : /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code) ? 'tls' : 'no-answer' };
    }
  };
  const credentialsOf = async (target, store) => {
    // Kept per origin and both references, so a changed reference is asked at once.
    const key = `${target.origin}|${target.usernameRef}|${target.passwordRef}`, kept = credentials.get(key);
    if (kept && now() - kept.at < (kept.state === 'unknown' ? UNKNOWN_FRESH_MS : CREDENTIALS_FRESH_MS)) return kept.state;
    let state = 'unknown';
    if (!target.usernameRef || !target.passwordRef) state = 'missing';
    else if (store) {
      try {
        const values = await Promise.all([store.get(target.usernameRef), store.get(target.passwordRef)]);
        state = values.every((value) => typeof value === 'string' && value.length > 0) ? 'ok' : 'missing';
      } catch { state = 'unknown'; }
    }
    credentials.set(key, { state, at: now() });
    return state;
  };
  const check = async (config) => {
    const targets = reachTargets(config);
    let store = null;
    try { store = reader(config?.browserLogin?.credentialStore ?? { kind: 'windows' }); } catch { store = null; }
    const rows = await Promise.all(targets.map(async (target) => {
      // A profile a browser run would refuse is reported as such and not fetched: its address may not be a login page.
      if (target.invalid) return { origin: target.origin, config: 'invalid', network: null, httpStatus: null, downSince: null, credentials: null };
      const [seen, secret] = await Promise.all([network(target), credentialsOf(target, store)]);
      if (seen.network === 'ok') downSince.delete(target.origin);
      else if (!downSince.has(target.origin)) downSince.set(target.origin, new Date(now()).toISOString());
      return { origin: target.origin, config: 'ok', ...seen, downSince: downSince.get(target.origin) ?? null, credentials: secret };
    }));
    return { checkedAt: new Date(now()).toISOString(), targets: rows };
  };
  return async (config) => {
    if (answer && now() - Date.parse(answer.checkedAt) < REACH_FRESH_MS) return answer;
    running ??= check(config).then((fresh) => { answer = fresh; return fresh; }).finally(() => { running = null; });
    return running;
  };
}
