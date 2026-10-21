// Settings -> Alerts in the dashboard (docs/design/OWNER_UI_V2.md section 9, work package WP6): the owner's alert rules
// and quiet hours, the state of the alert transport, and what the synthetic rehearsal transport recorded. The rules live
// in src/supervisor/alerts.mjs; this module only reads them for the page and saves the owner's change.
//
// Saving is an owner route (server.mjs: same origin, CSRF token, 16 KiB, JSON) that runs the caller check first, so a
// worker or any other program AIWorks started cannot mute the owner's alerts. It binds the version the page showed and a
// request id. The transport is the operator's config.json setting and is only described here, by state: no reference to
// a secret store, and no credential, is ever served. Nothing on this page sends an alert, resolves a reference or answers
// a decision.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../supervisor/store.mjs';
import { ALERT_CLASSES, alertDecision, AlertRulesError, currentAlertRules, inQuietHours, renderAlert, saveAlertRules, transportSetup } from '../supervisor/alerts.mjs';
import { redact } from '../supervisor/owner-intervention.mjs';
import { ownerOnly } from './work-list.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message, code = null) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const storePath = (dataDir) => join(dataDir, 'supervisor.db');
const UNREADABLE = 'AIWorks can’t read its work records on this computer right now.';
const readConfig = (dataDir) => { try { return JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { return {}; } };
const STATES = ['pending', 'sending', 'rehearsed', 'delivered', 'unknown', 'failed', 'muted'];

// A fictional notice, so the owner sees what an alert would carry before any is raised.
const SAMPLE = { kind: 'initial', class: 'B3', project: 'example-org/sampleapp', blocked: 'A step needs your choice between two designs.',
  impact: '1 parent task(s) held until recheck evidence passes', nextAction: 'Choose a design in Needs you.',
  safeState: 'Nothing was merged or deployed; held work keeps its phase in the supervisor store.', link: null };

// A recorded rehearsal, allowlisted field by field and redacted again on the way out.
const recorded = (alert) => ({ title: redact(alert?.title, 120), lines: (Array.isArray(alert?.lines) ? alert.lines : []).slice(0, 6).map((text) => redact(text, 300)),
  buttons: (Array.isArray(alert?.buttons) ? alert.buttons : []).slice(0, 3).map((b) => ({ label: redact(b?.label, 40), address: redact(b?.address, 200) })) });

function view(store, config, now) {
  const current = currentAlertRules(store), setup = transportSetup(config);
  let counts = [], rehearsals = [];
  try {
    counts = store.all('SELECT state, COUNT(*) AS n FROM owner_notifications GROUP BY state');
    rehearsals = store.all('SELECT alert, recorded_at FROM alert_rehearsals ORDER BY recorded_at DESC, key LIMIT 5');
  } catch { /* a store older than these tables has neither */ }
  const outbox = Object.fromEntries(STATES.map((state) => [state, counts.find((row) => row.state === state)?.n ?? 0]));
  return { available: true, version: current.version, savedAt: current.createdAt, rules: current.rules, classes: ALERT_CLASSES,
    quietNow: inQuietHours(current.rules.quietHours, now),
    delivery: { transport: setup.state, kind: ['unavailable', 'ready', 'incomplete'].includes(setup.state) ? setup.kind : null,
      references: setup.references.length, recording: config.ownerIntervention?.enabled === true,
      sending: setup.state === 'ready' && config.ownerIntervention?.enabled === true && config.ownerIntervention?.deliver === true },
    outbox, rehearsals: rehearsals.map((row) => ({ at: row.recorded_at, alert: recorded(row.alert) })),
    sample: { alert: renderAlert(SAMPLE), now: alertDecision(SAMPLE, current.rules, now) } };
}

/** GET /api/v2/settings/alerts. Read-only; a missing store is unavailable, never default rules. */
export function alertsView(dataDir, now = Date.now()) {
  if (!existsSync(storePath(dataDir))) throw fail(503, UNREADABLE);
  const store = new Store(storePath(dataDir), { readOnly: true });
  try { return view(store, readConfig(dataDir), now); } finally { store.close(); }
}

const REFUSAL_STATUS = { ALERTS_CHANGED: 409, ALERTS_REQUEST_REUSED: 409 };
const REFUSAL_WORDS = {
  ALERTS_CHANGED: 'The alert rules changed since this page read them. Your entries are kept: review the newest version and save again. Nothing was saved.',
  ALERTS_REQUEST_REUSED: 'This request was already used for other alert rules. Refresh the page; nothing was saved.',
};

/**
 * POST /api/v2/settings/alerts: the owner saves the alert rules as the next version. input: { requestId, version, rules:
 * { classes, reminders, quietHours } }. The caller check runs first.
 */
export async function saveAlerts(dataDir, input, { caller, now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['requestId', 'version', 'rules'].includes(key)) ||
      !UUID.test(input.requestId ?? '') || !Number.isSafeInteger(input.version) || input.version < 0) {
    throw fail(400, 'Invalid request.');
  }
  if (!existsSync(storePath(dataDir))) throw fail(503, UNREADABLE);
  const store = new Store(storePath(dataDir));
  try {
    await ownerOnly(store, caller);
    return store.tx(() => {
      const saved = saveAlertRules(store, { expectedVersion: input.version, requestId: input.requestId, rules: input.rules }, now);
      return { ok: true, duplicate: saved.duplicate, version: saved.version,
        message: saved.duplicate ? `Version ${saved.version} was already saved; nothing was saved twice.` : `Saved as version ${saved.version}. It applies to the next alert.`,
        view: view(store, readConfig(dataDir), now) };
    });
  } catch (error) {
    if (error instanceof AlertRulesError) throw fail(REFUSAL_STATUS[error.code] ?? 400, REFUSAL_WORDS[error.code] ?? `Not saved: ${error.message}.`, error.code);
    throw error;
  } finally { store.close(); }
}
