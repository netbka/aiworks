// The authorized caller of the additional check services (docs/guides/check-services.md, "Offering verified commits").
// serve owns it beside the controller: it is never part of a controller tick and never changes a task, an operation, a
// budget, publication, merge, release or the required local gate. It reads only the journal and finished operations,
// and writes only its own journal records:
//   check-service-offered  { task, service, sha, project, jobId }        the service accepted a job for the commit
//   check-service-result   { task, service, sha, project, jobId, state, exitCode, summary }
// Each commit a verifier accepted (a finished verify operation of a commit task whose verdict is `accepted`) goes once
// to each service that lists the task's repository and opted in with `"offer": "verified"`. The services and each
// service's credential broker come only from the controller's own config.json (checkServiceSettings, asyncTokenReader),
// never from the worker-inherited AIWORKS_CHECK_SERVICES. At most one offer per service is in flight. A restart finds
// the recorded job and re-attaches to it; an offer whose job was accepted but not yet recorded is submitted again under
// the same idempotency key, which the service answers with the same job. No record ever holds credential material.
// A failure that may pass (no answer, a server error, an unhealthy service) is not recorded: the service is asked again
// after RETRY_MS, a recorded job is re-attached to, and only the end of the offer window records it as unavailable.
// Every offer ends with one result record: a commit whose window ended while its service was busy, or whose recorded
// job outlived its wait, is recorded unavailable the next time the due offers are listed.
import { setTimeout as sleepFor } from 'node:timers/promises';
import { bundleOf, checkServiceSettings, offerOnService, OFFER_VERIFIED, onOrigin, originRepository } from './check-services.mjs';
import { specOf } from './plan.mjs';
import { asyncTokenReader } from './token-store.mjs';

export const OFFERED = 'check-service-offered';
export const RESULT = 'check-service-result';
/** How far back a verification is still offered: a restart catches up within it, older ones are never offered. */
export const OFFER_WINDOW_MS = 24 * 3600_000;
// How many windows back a verification whose window ended is still looked at, to record its final result once.
const CLOSE_LOOKBACK = 2;
// How often a commit on no origin branch yet (a head verified before its publication) is looked for again, and how long
// a service that failed in a way that may pass is left alone.
const RETRY_MS = 5 * 60_000;
// How long a resolved credential is reused, in memory only, before the store is asked again.
const CREDENTIAL_TTL_MS = 10 * 60_000;

/** The services of the controller's own config.json that opted in to offers of verified commits. */
export function offeringServices(config) {
  return checkServiceSettings(config).services.filter((service) => service.offer === OFFER_VERIFIED);
}

const keyOf = (service, sha) => `${service}\n${sha}`;

/** The check-service records of these campaigns: per (service, sha), the offered job and whether a result is recorded. */
function offerRecords(store, campaignIds) {
  const records = new Map();
  for (const campaignId of campaignIds) {
    for (const row of store.all('SELECT at, kind, detail FROM journal WHERE campaign_id = ? AND kind IN (?, ?) ORDER BY seq', campaignId, OFFERED, RESULT)) {
      const detail = row.detail;
      if (!detail || typeof detail !== 'object') continue;
      const key = keyOf(detail.service, detail.sha);
      const record = records.get(key) ?? { campaignId, offered: null, result: false };
      if (row.kind === RESULT) record.result = true;
      else record.offered ??= { jobId: detail.jobId, at: row.at, campaignId, task: detail.task };
      records.set(key, record);
    }
  }
  return records;
}

/**
 * The latest check-service record of each task of a campaign, for status: Map task -> [{ service, sha, state, jobId,
 * exitCode, summary, at }], one per service, newest first. A job offered and not yet answered reads `offered`.
 */
export function checkServiceView(store, campaignId) {
  const tasks = new Map();
  const rows = store.all('SELECT at, kind, detail FROM journal WHERE campaign_id = ? AND kind IN (?, ?) ORDER BY seq DESC', campaignId, OFFERED, RESULT);
  const seen = new Set();
  for (const row of rows) {
    const detail = row.detail;
    if (!detail || typeof detail !== 'object') continue;
    const key = `${detail.task}\n${detail.service}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = tasks.get(detail.task) ?? [];
    list.push({ service: detail.service, sha: detail.sha, state: row.kind === RESULT ? detail.state : 'offered', jobId: detail.jobId ?? null,
      exitCode: detail.exitCode ?? null, summary: detail.summary ?? null, at: new Date(row.at).toISOString() });
    tasks.set(detail.task, list);
  }
  return tasks;
}

/**
 * The caller. `tick()` starts due offers and returns at once; `stop()` ends the waits (never a remote job) and settles.
 * `checkoutOf(declaration)` is the campaign's checkout folder or null. Everything else is injectable for tests.
 */
export function createCheckServiceCaller({ store, config, log = () => {}, checkoutOf = () => null, client, now = Date.now, pollMs = 30_000,
  windowMs = OFFER_WINDOW_MS, readerFor = (service) => asyncTokenReader(service.auth.credentialStore ?? { kind: 'windows' }),
  repositoryOf = null, available = (sha, cwd) => (cwd ? onOrigin(sha, cwd) : false), bundle = (sha, cwd) => (cwd ? bundleOf(sha, cwd) : null), sleep = null }) {
  const services = offeringServices(config);
  const inFlight = new Map();
  // The (service, commit) keys an offer is working on now: never closed by due() while their own offer may still record.
  const active = new Set();
  // The keys due() recorded a final result for: a service's list made before that never offers them.
  const closed = new Set();
  const notBefore = new Map();
  const serviceWait = new Map();
  const origins = new Map();
  const credentials = new Map();
  const abort = new AbortController();
  let stopped = false;
  const wait = sleep ?? ((ms) => sleepFor(ms, undefined, { signal: abort.signal, ref: false }).catch(() => {}));
  const checkout = (campaign) => { try { return checkoutOf(campaign.declaration) ?? null; } catch { return null; } };
  // The declaration's repository; the checkout's origin only for a target that names none (a project without GitHub).
  const repository = repositoryOf ?? ((campaign) => {
    if (!origins.has(campaign.id)) {
      const named = campaign.declaration?.target?.repository;
      const path = named ? null : checkout(campaign);
      origins.set(campaign.id, named ? String(named).toLowerCase() : path ? originRepository(path) : null);
    }
    return origins.get(campaign.id);
  });
  // A service's broker: its store asked without blocking, and a resolved value reused for CREDENTIAL_TTL_MS, in memory
  // only (never logged or recorded); a refusal drops it.
  const brokerFor = (service) => {
    if (!service.auth) return null;
    const reader = readerFor(service);
    return { get: async (ref) => {
      const hit = credentials.get(service.name);
      if (hit && hit.ref === ref && hit.until > now()) return hit.value;
      const value = await reader.get(ref);
      if (typeof value === 'string' && value.length) credentials.set(service.name, { ref, value, until: now() + CREDENTIAL_TTL_MS });
      else credentials.delete(service.name);
      return value;
    } };
  };
  const record = (campaignId, kind, detail) => {
    try { store.journal(campaignId, kind, detail, now()); return true; } catch (error) { log(`check service ${detail.service}: could not record ${kind} (${error.message})`); return false; }
  };

  /**
   * Every (service, verified commit) not yet answered, oldest verification first. A commit whose offer window ended
   * without a result (never asked about in time, or its job never answered) gets its final `unavailable` result here,
   * once: the record itself keeps it from being recorded again after a restart. A recorded job keeps its own wait
   * (queueSeconds plus timeoutMinutes from its offer) even past the window, and an offer in flight is never closed here.
   */
  function due() {
    const at = now();
    const ops = store.all(`SELECT campaign_id, task_id, target_sha, workspace, updated_at FROM operations WHERE kind = 'verify' AND state = 'finished'
      AND updated_at >= ? AND json_extract(outcome, '$.class') = 'result' AND json_extract(outcome, '$.value.verdict') = 'accepted'
      ORDER BY updated_at, seq`, at - CLOSE_LOOKBACK * windowMs);
    if (!ops.length) return [];
    const records = offerRecords(store, [...new Set(ops.map((op) => op.campaign_id))]);
    const campaigns = new Map();
    const checkouts = new Map();
    const items = [];
    for (const op of ops) {
      if (!/^[0-9a-f]{40}$/.test(op.target_sha ?? '')) continue;
      if (!campaigns.has(op.campaign_id)) campaigns.set(op.campaign_id, store.campaign(op.campaign_id));
      const campaign = campaigns.get(op.campaign_id);
      if (!campaign || specOf(store, campaign.id, op.task_id, campaign.declaration)?.deliverable !== 'commit') continue;
      const repo = repository(campaign);
      if (!repo) continue;
      for (const service of services) {
        const key = keyOf(service.name, op.target_sha);
        const known = records.get(key);
        if (!service.projects[repo] || known?.result || closed.has(key) || items.some((item) => item.key === key)) continue;
        const offered = known?.offered ?? null;
        const open = at - op.updated_at < windowMs || (offered && at < offered.at + service.queueSeconds * 1000 + service.timeoutMinutes * 60_000);
        if (!open) {
          if (active.has(key)) continue;
          closed.add(key);
          // A recorded job keeps the campaign and task it was offered for, so its result is recorded beside it.
          const [campaignId, task] = [offered?.campaignId ?? campaign.id, offered?.task ?? op.task_id];
          const summary = offered ? `job ${offered.jobId} gave no answer AIWorks recorded within the offer window`
            : `the service gave no usable answer about the commit within the ${windowMs / 3600_000}-hour offer window`;
          if (record(campaignId, RESULT, { task, service: service.name, sha: op.target_sha, project: service.projects[repo].projectId,
            jobId: offered?.jobId ?? null, state: 'unavailable', exitCode: null, summary })) {
            log(`check service ${service.name} unavailable for ${campaignId}/${task} at ${op.target_sha}: ${summary}`);
          } else closed.delete(key);
          continue;
        }
        if (!checkouts.has(campaign.id)) checkouts.set(campaign.id, checkout(campaign));
        // A recorded job keeps the campaign and task it was offered for, so its result is recorded beside it.
        items.push({ key, service, repository: repo, campaignId: known?.offered?.campaignId ?? campaign.id, taskId: known?.offered?.task ?? op.task_id,
          sha: op.target_sha, workspace: op.workspace, checkout: checkouts.get(campaign.id), verifiedAt: op.updated_at,
          jobId: known?.offered?.jobId ?? null, startedAt: known?.offered?.at ?? null });
      }
    }
    return items;
  }

  async function offer(item) {
    const { service, campaignId, taskId, sha } = item;
    const project = service.projects[item.repository].projectId;
    const closing = now() - item.verifiedAt >= windowMs - 2 * RETRY_MS;
    const finish = (state, summary, { jobId = item.jobId, exitCode = null } = {}) => {
      record(campaignId, RESULT, { task: taskId, service: service.name, sha, project, jobId, state, exitCode, summary });
      log(`check service ${service.name} ${state} for ${campaignId}/${taskId} at ${sha}${jobId ? ` (job ${jobId})` : ''}: ${summary}`);
    };
    let source = null;
    if (!item.jobId && !(await available(sha, item.checkout ?? item.workspace))) {
      // A head verified before its publication: a service that accepts sources gets it as a bundle of the verifier's
      // checkout, if that still holds the exact commit; any other service waits until origin has it.
      const made = service.sources === true ? await bundle(sha, item.workspace) : null;
      if (made?.bytes) source = made;
      else {
        if (closing) finish('unavailable', 'the commit reached no origin branch within the offer window, and the service took no source of it');
        else notBefore.set(item.key, now() + RETRY_MS);
        return false;
      }
    }
    if (stopped) return true;
    const outcome = await offerOnService({ service, repository: item.repository, sha, jobId: item.jobId, startedAt: item.startedAt ?? now(),
      reference: `${campaignId}-${taskId}`, source, broker: brokerFor(service), ...(client ? { client } : {}), signal: abort.signal,
      stopping: () => stopped, sleep: wait, now, pollMs,
      onSubmitted: async (jobId) => {
        record(campaignId, OFFERED, { task: taskId, service: service.name, sha, project, jobId });
        log(`check service ${service.name} accepted job ${jobId} for ${campaignId}/${taskId} at ${sha}`);
      } });
    if (!outcome) return true;
    if (outcome.refused) credentials.delete(service.name);
    if (outcome.transient && !closing) {
      // Asked again later: the service is left alone for RETRY_MS, and a recorded job is re-attached to then.
      serviceWait.set(service.name, now() + RETRY_MS);
      log(`check service ${service.name} unavailable for ${campaignId}/${taskId} at ${sha}, asked again in ${RETRY_MS / 60_000} min: ${outcome.summary}`);
      return true;
    }
    finish(outcome.state, outcome.transient ? `${outcome.summary}; still so at the end of the offer window` : outcome.summary,
      { jobId: outcome.jobId, exitCode: outcome.exitCode });
    return true;
  }

  // The due offers of one service in order: a commit still waiting for origin is passed over, and the first one the
  // service is actually asked about ends the turn, so at most one offer per service is ever in flight.
  async function serve(items) {
    for (const item of items) {
      if (stopped) return;
      if (closed.has(item.key) || notBefore.get(item.key) > now()) continue;
      active.add(item.key);
      try { if (await offer(item)) return; } catch (error) {
        // An unexpected failure is retried later, never in a loop and never as a result.
        notBefore.set(item.key, now() + RETRY_MS);
        log(`check service ${item.service.name}: offer of ${item.sha} failed (${error?.message ?? error})`);
        return;
      } finally { active.delete(item.key); }
    }
  }

  return {
    services,
    /** Starts the next due offer of each idle service; returns at once. */
    tick() {
      if (stopped || !services.length) return;
      const at = now();
      const idle = services.filter((service) => !inFlight.has(service.name) && !(serviceWait.get(service.name) > at));
      if (!idle.length) return;
      const items = due();
      for (const service of idle) {
        const mine = items.filter((item) => item.service === service && !(notBefore.get(item.key) > at));
        if (!mine.length) continue;
        inFlight.set(service.name, serve(mine).finally(() => inFlight.delete(service.name)));
      }
    },
    /** Settles every offer in flight (tests). */
    idle: () => Promise.allSettled([...inFlight.values()]),
    /** Ends every wait without cancelling a remote job, and settles within `boundMs`. */
    async stop(boundMs = 30_000) {
      stopped = true;
      abort.abort();
      await Promise.race([Promise.allSettled([...inFlight.values()]), sleepFor(boundMs, undefined, { ref: false })]);
    },
  };
}
