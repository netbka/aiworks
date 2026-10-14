// Shared harness of the aiworks#1 owner-intervention tests (owner-intervention*.test.mjs): blocker fingerprint and dedup, category-bounded
// recheck, evidence-gated resume and the notification outbox (no-op transport by default). Synthetic workers
// only; no network, Telegram, credential or production access.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { declaration, environment } from './helpers.mjs';

export const OI = { ownerIntervention: { enabled: true } };
// The synthetic credential-shaped values the `owner-leak` fixture mode puts in its trigger text. The key
// shape is assembled at runtime so no token-shaped literal is committed (repository leak scan).
export const keyShape = (value) => ['sk', 'ant', 'api03', value].join('-');
export const SECRETS = [keyShape('SYNTHETICfakeVALUE0123456789abcdef'), 'SYNTHETICfakePassphrase', 'SYNTHETICfake'];

export const load = async () => ({
  ...(await import('../../src/supervisor/api.mjs')),
  ...(await import('../../src/supervisor/controller.mjs')),
  ...(await import('../../src/supervisor/store.mjs')),
  oi: await import('../../src/supervisor/owner-intervention.mjs'),
});

export async function setup(t, { scenario, config = OI, decl, notifier, probes } = {}) {
  const m = await load();
  const env = environment({ scenario, config });
  const store = new m.Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = decl ?? declaration();
  m.campaignStart(store, d);
  const controller = new m.Controller({ store, config: env.config, dataDir: env.dataDir, fault: null, notifier, probes });
  return { m, env, store, controller, d, id: d.campaignId };
}

export const blockers = (store) => store.all('SELECT * FROM blockers ORDER BY first_detected_at');
export const notes = (store) => store.all('SELECT * FROM owner_notifications ORDER BY created_at');
export const parents = (store, fp) => store.all('SELECT * FROM blocker_parents WHERE fingerprint = ? ORDER BY campaign_id, task_id', fp);
export const ops = (store, id) => store.all('SELECT id, task_id, kind, state, created_at FROM operations WHERE campaign_id = ? ORDER BY created_at', id);
export const independent = () => {
  const [first, second] = declaration().tasks;
  return declaration({ tasks: [first, { ...second, id: 'T3', dependsOn: [] }] });
};
