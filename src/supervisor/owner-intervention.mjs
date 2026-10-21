// aiworks#1 owner-intervention core (governance provider's docs/OWNER_INTERVENTION.md, OPS-001). Pure helpers the controller uses to
// fingerprint, deduplicate and recheck B2-B5 blockers and to record what an owner notification would say.
// Nothing here reads credentials or talks to a network: the transport here is the no-op one below.
import { createHash } from 'node:crypto';

// B0 (transient) and B1 (agent-resolvable) are handled by retry, backoff and fallback; they never create a
// blocker record or an owner notification.
export const OWNER_CLASSES = new Set(['B2', 'B3', 'B4', 'B5']);

const MINUTE = 60_000;
/**
 * Category-bounded recheck schedule (OWNER_INTERVENTION §5, §9-§11). Timer rechecks run only for a dependency
 * with a deterministic probe; a probe that needs a worker run is triggered by the owner, never by a timer.
 * - B2: three timed rechecks, then only owner Recheck/Done (a human action is outstanding).
 * - B3: no timer; the owner decision is the dependency.
 * - B4: monitor; the last interval repeats while the external wait lasts.
 * - B5: no timer; the incident path owns recovery.
 */
export const RECHECK_SCHEDULE = {
  B2: { intervalsMs: [15 * MINUTE, 60 * MINUTE, 240 * MINUTE], repeatLast: false },
  B3: { intervalsMs: [], repeatLast: false },
  B4: { intervalsMs: [MINUTE, 5 * MINUTE, 15 * MINUTE], repeatLast: true },
  B5: { intervalsMs: [], repeatLast: false },
};

/** §10 defaults: one reminder after 60 minutes, then at most one per 24 hours. B4 and B5 get none here. */
export const REMINDERS = { B2: [60 * MINUTE, 24 * 60 * MINUTE], B3: [60 * MINUTE, 24 * 60 * MINUTE] };

const LABEL = { B2: 'Action required', B3: 'Decision required', B4: 'External wait', B5: 'Incident' };
const ACTIONS = { B2: ['open', 'acknowledge', 'recheck'], B3: ['open', 'acknowledge', 'decide'], B4: ['open'], B5: ['open', 'acknowledge', 'recheck'] };

const REDACTED = '[redacted]';
const PATTERNS = [
  [/-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g, REDACTED],
  [/\/\/[^\s/:@]+:[^\s/@]+@/g, `//${REDACTED}@`],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|otp|mfa[_-]?code)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, `$1$2${REDACTED}`],
  // Opaque mixed-case alphanumeric runs look like credentials; lowercase hex (Git SHAs, digests) stays readable.
  [/[A-Za-z0-9_+/=-]{32,}/g, (run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) ? REDACTED : run],
];

/** Remove secret-shaped values from free text before it is stored, hashed or put in a notification. */
export function redact(text, max = 500) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** §7 default fingerprint: project + environment + dependency + blocker-class + failure-identity, over redacted text. */
export function blockerFingerprint({ project, environment, dependency, blockerClass, identity }) {
  const parts = [project, environment, dependency, blockerClass, redact(identity, 300)].map((part) => String(part ?? ''));
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

/** Next timer recheck after `attempts` failed rechecks, or null when the category stops timing. */
export function nextRecheckAt(blockerClass, attempts, now) {
  const schedule = RECHECK_SCHEDULE[blockerClass];
  if (!schedule?.intervalsMs.length) return null;
  if (attempts >= schedule.intervalsMs.length && !schedule.repeatLast) return null;
  return now + schedule.intervalsMs[Math.min(attempts, schedule.intervalsMs.length - 1)];
}

/** The reminder number due now for an open record, or null. */
export function reminderDue(record, now) {
  const intervals = REMINDERS[record.class];
  if (!intervals || record.status !== 'open' || record.last_notified_at == null) return null;
  const wait = intervals[Math.min(record.reminders, intervals.length - 1)];
  return now - record.last_notified_at >= wait ? record.reminders + 1 : null;
}

/** §8 message content. Every free-text field is redacted; no secret, token or private content is carried. */
export function ownerMessage({ record, kind, parents, repository, trackingIssue, tried, workList = false, projectName = null }) {
  const cls = record.class;
  return {
    kind,
    // A project without GitHub is named as its owner named it (`projectName`); its record keeps the `lp-` id.
    project: projectName ? redact(projectName, 120) : record.project,
    environment: record.environment,
    tasks: parents.map((parent) => `${parent.campaign_id}/${parent.task_id}`),
    blocked: redact(record.summary),
    class: cls,
    label: LABEL[cls],
    impact: `${parents.length} parent task(s) held until recheck evidence passes`,
    tried: redact(tried ?? 'bounded retry and authorized fallback before raising this blocker'),
    nextAction: cls === 'B4' ? null : redact(record.requested_action ?? ''),
    safeState: 'Nothing was merged or deployed; held work keeps its phase in the supervisor store.',
    // AIWorks's own repository with local main trusted links its tracking item in the local work list instead.
    link: !(repository && trackingIssue) ? null : workList ? `aiworks-work:${trackingIssue}` : `https://github.com/${repository}/issues/${trackingIssue}`,
    afterAction: redact(record.recheck_procedure),
    fingerprint: record.fingerprint,
    actions: ACTIONS[cls],
  };
}

/**
 * Notification transport interface: `{ name, live, dedup?, send({ key, message, alert }) -> Promise<{ delivered,
 * outcome?, receipt? }> }`. `key` is stable across retries so a transport that deduplicates by key (`dedup: 'key'`) can
 * take at-least-once delivery; one whose provider cannot (`dedup: 'none'`) says `outcome` `retry` only when nothing
 * arrived, and is never retried otherwise. The default is this no-op transport: the outbox records what would be sent
 * and nothing leaves the host. The rehearsal and Telegram transports are in alerts.mjs and alert-telegram.mjs.
 */
export const noopTransport = Object.freeze({
  name: 'none',
  live: false,
  async send() { return { delivered: false, receipt: 'no transport configured' }; },
});
