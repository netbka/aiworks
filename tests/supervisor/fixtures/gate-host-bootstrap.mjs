// Explicit test code injection. Product gate entrypoints never read these test environment variables.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureGateHost } from '../../../src/supervisor/gate-slot.mjs';

const bootstrap = `--import=${import.meta.url}`;
export function gateTestEnv(root, extra = {}, inherited = process.env) {
  const path = resolve(root);
  const env = { ...inherited, ...extra, AIWORKS_TEST_GATE_ROOT: path };
  if (env.AIWORKS_TEST_GATE_ACTIVE_ROOT !== path) {
    delete env.AIWORKS_GATE_OWNER;
    delete env.AIWORKS_GATE_SLOT_HELD;
  }
  env.AIWORKS_TEST_GATE_ACTIVE_ROOT = path;
  if (!(env.NODE_OPTIONS ?? '').includes(bootstrap)) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} ${bootstrap}`.trim();
  return env;
}

export function useGateTestHost(root) {
  const env = gateTestEnv(root);
  if (!Object.hasOwn(env, 'AIWORKS_GATE_OWNER')) delete process.env.AIWORKS_GATE_OWNER;
  if (!Object.hasOwn(env, 'AIWORKS_GATE_SLOT_HELD')) delete process.env.AIWORKS_GATE_SLOT_HELD;
  Object.assign(process.env, env);
  configureGateHost({ root: resolve(root) });
}

if (process.env.AIWORKS_TEST_GATE_ROOT) {
  useGateTestHost(process.env.AIWORKS_TEST_GATE_ROOT);
  // runtimeCheckout deliberately copies the supervisor into a different Git root. Configure that ESM instance too,
  // before its CLI/status code loads, so even copied-runtime tests cannot inspect the real host namespace.
  let directory = dirname(resolve(process.argv[1] ?? '.'));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(directory, 'src', 'supervisor', 'gate-slot.mjs');
    if (existsSync(candidate)) {
      const { configureGateHost: configureEntry } = await import(pathToFileURL(candidate).href);
      configureEntry({ root: resolve(process.env.AIWORKS_TEST_GATE_ROOT) });
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
