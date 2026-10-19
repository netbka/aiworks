// Owner alerts (docs/design/OWNER_UI_V2.md section 9, work package WP6): which owner notifications are sent, when, and
// through which transport. The notification outbox itself is the owner-intervention core's (`owner_notifications`,
// controller.mjs recordNotification); this module only decides, per pending entry, whether the transport gets it now.
//
// - Alert rules and quiet hours are the owner's, kept as append-only versions in `alert_rules` and saved only from the
//   dashboard after the caller check. Version 0 (nothing saved) alerts on B2, B3 and B5, with reminders and no quiet hours.
// - The transport is chosen by the operator in config.json `alerts.transport`. A credential is named only by a reference
//   into the operator's secret store (`secretRef`, `recipientRef`); this module never resolves one and never returns,
//   logs or stores a reference's value. No adapter that leaves this computer is built: any kind but `synthetic` reads
//   as unavailable and nothing is sent. `synthetic` is a rehearsal transport: it records the rendered alert in
//   `alert_rehearsals` on this computer, once per notification key, and never reports a delivery.
// - An alert carries no authority. Its buttons are dashboard addresses on this computer; an answer is given only on the
//   dashboard, through the same caller, CSRF, task, version, authorization and scope checks as every decision there.
import { createHash } from 'node:crypto';
import { canonicalJson } from './campaign.mjs';
import { redact } from './owner-intervention.mjs';
import { containsKnownSecretValue } from '../shared/credential-metadata.mjs';

export class AlertRulesError extends Error {
  constructor(code, message) { super(message); this.name = 'AlertRulesError'; this.code = code; }
}
const refuse = (code, message) => { throw new AlertRulesError(code, message); };
const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const ALERT_CLASSES = Object.freeze(['B2', 'B3', 'B4', 'B5']);
export const DEFAULT_RULES = Object.freeze({ classes: Object.freeze({ B2: true, B3: true, B4: false, B5: true }), reminders: true, quietHours: null });

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ZONE = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;
const validZone = (zone) => {
  if (typeof zone !== 'string' || !ZONE.test(zone)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
};

/**
 * The owner's alert rules, checked and in their stored form. Refusals carry a code:
 *   ALERTS_FIELD  a field the rules do not have (a transport, a recipient or a credential is the operator's, never here);
 *   ALERTS_CLASS  a class switch that is not true or false;
 *   ALERTS_QUIET  quiet hours that are not a start and an end (HH:MM, different) in a known time zone.
 */
export function normalizeAlertRules(input) {
  if (!plainObject(input)) refuse('ALERTS_FIELD', 'alert rules must be an object');
  const extra = Object.keys(input).filter((key) => !['classes', 'reminders', 'quietHours'].includes(key));
  if (extra.length) refuse('ALERTS_FIELD', `alert rules cannot set ${extra.join(', ')}`);
  const classes = input.classes ?? {};
  if (!plainObject(classes) || Object.keys(classes).some((key) => !ALERT_CLASSES.includes(key)) ||
      Object.values(classes).some((value) => typeof value !== 'boolean')) {
    refuse('ALERTS_CLASS', `alert classes are ${ALERT_CLASSES.join(', ')}, each on or off`);
  }
  if (input.reminders !== undefined && typeof input.reminders !== 'boolean') refuse('ALERTS_CLASS', 'reminders are on or off');
  let quietHours = null;
  if (input.quietHours != null) {
    const q = input.quietHours;
    if (!plainObject(q) || Object.keys(q).some((key) => !['start', 'end', 'timeZone', 'incidents'].includes(key)) ||
        !CLOCK.test(q.start ?? '') || !CLOCK.test(q.end ?? '') || q.start === q.end || !validZone(q.timeZone) ||
        q.incidents !== undefined && typeof q.incidents !== 'boolean') {
      refuse('ALERTS_QUIET', 'quiet hours need a different start and end (HH:MM) and a known time zone');
    }
    quietHours = { start: q.start, end: q.end, timeZone: q.timeZone, incidents: q.incidents === true };
  }
  return { classes: Object.fromEntries(ALERT_CLASSES.map((cls) => [cls, classes[cls] ?? DEFAULT_RULES.classes[cls]])),
    reminders: input.reminders ?? true, quietHours };
}

export const alertRulesDigest = (rules) => `sha256:${createHash('sha256').update(canonicalJson(rules), 'utf8').digest('hex')}`;

const hasTable = (store, name) => Boolean(store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name));
const decoded = (row) => (row ? { version: row.version, rules: row.rules, digest: row.digest, requestId: row.request_id, createdAt: row.created_at } : null);

/** The newest alert rules, or the defaults as version 0. A store that never saved any (or predates the table) has the defaults. */
export function currentAlertRules(store) {
  const row = hasTable(store, 'alert_rules') ? store.get('SELECT * FROM alert_rules ORDER BY version DESC LIMIT 1') : null;
  return decoded(row) ?? { version: 0, rules: normalizeAlertRules({}), digest: null, requestId: null, createdAt: null };
}

/**
 * Save the owner's alert rules as the next version, bound to the version the owner saw and to a request id: a repeat of
 * the same request answers with the version it saved; the same id with other rules is refused. The caller holds the
 * store transaction and has run the caller check. Refusals: ALERTS_CHANGED, ALERTS_REQUEST_REUSED, ALERTS_REQUEST and
 * every code of normalizeAlertRules.
 */
export function saveAlertRules(store, { expectedVersion, requestId, rules }, now) {
  if (typeof requestId !== 'string' || !/^[\w-]{8,80}$/.test(requestId)) refuse('ALERTS_REQUEST', 'an alert rules change needs a request id');
  const value = normalizeAlertRules(rules);
  const digest = alertRulesDigest(value);
  const kept = store.get('SELECT * FROM alert_rules WHERE request_id = ?', requestId.toLowerCase());
  if (kept) {
    if (kept.digest !== digest) refuse('ALERTS_REQUEST_REUSED', 'this request id was already used for other alert rules');
    return { ...decoded(kept), duplicate: true };
  }
  const current = currentAlertRules(store);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== current.version) {
    refuse('ALERTS_CHANGED', `the alert rules changed since version ${expectedVersion}: version ${current.version} is the newest`);
  }
  const version = current.version + 1;
  store.run('INSERT INTO alert_rules (version, rules, digest, request_id, created_at) VALUES (?, ?, ?, ?, ?)',
    version, JSON.stringify(value), digest, requestId.toLowerCase(), now);
  store.journal(null, 'alert-rules-saved', { version, digest }, now);
  return { ...decoded(store.get('SELECT * FROM alert_rules WHERE version = ?', version)), duplicate: false };
}

const minutes = (clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
/** Whether `now` lies inside the quiet hours, read on the wall clock of their time zone. The window may cross midnight. */
export function inQuietHours(quietHours, now) {
  if (!quietHours) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: quietHours.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now));
  const at = Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
  const start = minutes(quietHours.start), end = minutes(quietHours.end);
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/**
 * What happens to one pending notification now: `send`, `hold` (quiet hours; it stays pending and no attempt is
 * counted) or `mute` (its class or its reminders are off; it is never sent). An incident (B5) breaks quiet hours only
 * when the owner said so.
 */
export function alertDecision(item, rules, now) {
  if (rules.classes[item.class] !== true) return 'mute';
  if (String(item.kind).startsWith('reminder-') && rules.reminders !== true) return 'mute';
  if (inQuietHours(rules.quietHours, now) && !(item.class === 'B5' && rules.quietHours.incidents === true)) return 'hold';
  return 'send';
}

// A secret store reference: `<store>:<path>`, such as `vault:alerts/bot`. It names where the credential is; it is not one.
const REFERENCE = /^[a-z][a-z0-9-]{1,31}:[A-Za-z0-9_./-]{1,200}$/;
const safeReference = (value) => typeof value === 'string' && REFERENCE.test(value) && !containsKnownSecretValue(value) && redact(value, 300) === value;

/**
 * The operator's transport setting (config.json `alerts.transport`), as states only; never a reference's value.
 *   unconfigured  no transport: notifications stay in the outbox on this computer and are shown in Needs me;
 *   rehearsal     the synthetic transport: alerts are recorded on this computer, nothing is sent;
 *   unavailable   a kind with no adapter in this version: nothing is sent;
 *   invalid       a setting that is not a kind with secret store references (for example a credential value): nothing is sent.
 */
export function transportSetup(config) {
  const value = config?.alerts?.transport;
  if (value === undefined || value === null) return { state: 'unconfigured', kind: null, references: [] };
  if (!plainObject(value) || Object.keys(value).some((key) => !['kind', 'secretRef', 'recipientRef'].includes(key)) ||
      typeof value.kind !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(value.kind) ||
      ['secretRef', 'recipientRef'].some((key) => value[key] !== undefined && !safeReference(value[key]))) {
    return { state: 'invalid', kind: null, references: [] };
  }
  const references = ['secretRef', 'recipientRef'].filter((key) => value[key] !== undefined);
  if (value.kind === 'synthetic') return { state: references.length ? 'invalid' : 'rehearsal', kind: 'synthetic', references: [] };
  return { state: 'unavailable', kind: value.kind, references };
}

const LABEL = { B2: 'Action required', B3: 'Decision required', B4: 'External wait', B5: 'Incident' };
const line = (text, max = 300) => redact(text, max) || null;
/**
 * The alert a transport is given for one outbox message: a title, short lines and buttons. Every text is redacted again
 * and bounded. Buttons are dashboard addresses on this computer (and the tracking link the message already names);
 * none answers, approves or resumes anything by itself.
 */
export function renderAlert(message) {
  const cls = ALERT_CLASSES.includes(message?.class) ? message.class : null;
  const reminder = /^reminder-\d+$/.test(message?.kind ?? '') ? ' (reminder)' : '';
  const link = typeof message?.link === 'string' && /^(?:https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|aiworks-work:\d+)$/.test(message.link) ? message.link : null;
  return {
    title: line(`${cls ? LABEL[cls] : 'Notice'}: ${message?.project ?? 'AIWorks'}${reminder}`, 120),
    lines: [line(message?.blocked), line(message?.impact), message?.nextAction ? line(`Next: ${message.nextAction}`) : null,
      line(message?.safeState)].filter(Boolean),
    buttons: [{ label: cls === 'B3' ? 'Decide in AIWorks' : 'Open in AIWorks', address: '#/needs' },
      ...(link ? [{ label: 'Tracking item', address: link }] : [])],
  };
}

/**
 * The rehearsal transport: `send` records the rendered alert in `alert_rehearsals` under the notification key, once.
 * A repeat of the same key (a retry after a restart) records nothing new. Nothing leaves this computer, and it never
 * answers `delivered`: the outbox entry becomes `rehearsed`.
 */
export function syntheticTransport(store, now = () => Date.now()) {
  return Object.freeze({
    name: 'synthetic', live: false, rehearsal: true,
    async send({ key, alert }) {
      const info = store.run('INSERT OR IGNORE INTO alert_rehearsals (key, alert, recorded_at) VALUES (?, ?, ?)', key, alert, now());
      return { delivered: false, rehearsed: true, duplicate: info.changes === 0 };
    },
  });
}
