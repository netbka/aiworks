// Shared harness of the no-capacity-limits tests (unlimited*.test.mjs): a synthetic environment, a store and a
// controller for one declaration. Owner decision 2026-10-10: no campaign capacity limits by default.
import { join } from 'node:path';
import { environment, SQLITE } from './helpers.mjs';

export const api = SQLITE ? await import('../../src/supervisor/api.mjs') : {};
const { Store } = SQLITE ? await import('../../src/supervisor/store.mjs') : {};
const { Controller } = SQLITE ? await import('../../src/supervisor/controller.mjs') : {};
export const NONE = { maxWorkerRuns: null, slots: 1, maxRepairRounds: null, maxRetriesPerTask: null };

export function setup(t, { decl, scenario }) {
  const env = environment({ scenario });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  api.campaignStart(store, decl);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  return { env, store, controller, id: decl.campaignId };
}
