// Runs every AIWorks test file serially (native Windows containment probes need capacity for helper startup).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const discover = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : discover(path);
  return entry.isFile() && entry.name.endsWith('.test.mjs') ? [relative(root, path).replaceAll(sep, '/')] : [];
});
const files = discover(join(root, 'tests')).sort();
// An inherited test-worker marker makes a nested node --test silently skip its files.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit', env, windowsHide: true });
if (result.error) console.error(`Test process failed: ${result.error.message}`);
process.exit(result.status ?? 1);
