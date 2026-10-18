import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseAuthorizations, RoadmapSource } from './roadmap.mjs';
import { configuredGovernanceRoot } from '../supervisor/governance.mjs';
import { configuredCheckouts, configuredGitCommand, MergeWatcher, publishedSteps } from './merges.mjs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { createDashboardServer } from './server.mjs';
import { DASHBOARD_VERSION, DASHBOARD_VERSION_NAME } from './copy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--data', '--port', '--cache', '--governance'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Usage: npm run dashboard -- --data <supervisor-directory> [--port 4318] [--governance <governance-checkout>]');
  options[args[i]] = args[i + 1];
}
// --cache is still accepted so existing launch commands keep working; the dashboard no longer keeps a GitHub cache.
if (!options['--data']) throw new Error('--data must name the existing supervisor data directory');
const port = Number(options['--port'] ?? 4318);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('port must be 1024..65535');
const dataDir = resolve(options['--data']);
// The governance root is an operator-configured read-only directory: --governance, else config.json governanceRoot.
// Without a valid one the roadmap panels say so; the dashboard still serves the campaigns.
const configuredGovernance = options['--governance'] ? resolve(options['--governance']) : configuredGovernanceRoot(dataDir);
const roadmap = new RoadmapSource({ root: configuredGovernance });
// Merged state comes from the configured local checkouts (git protocol only); the dashboard makes no GitHub API call.
const merges = new MergeWatcher({ steps: () => publishedSteps(dataDir), checkouts: configuredCheckouts(dataDir), git: configuredGitCommand(dataDir) });
let revision = null;
try { revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim(); }
catch { /* A checkout without git still serves; the revision is shown as unknown. */ }
// Release wording follows each project's registry entry in the governance checkout.
const server = createDashboardServer({ dataDir, roadmap, merges, host: { name: hostname(), revision, version: DASHBOARD_VERSION, versionName: DASHBOARD_VERSION_NAME }, releases: readReleaseAuthorizations(configuredGovernance) });
server.on('error', (error) => { console.error(`Dashboard could not listen (${error.code ?? 'unknown'}).`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`AIWorks dashboard: http://127.0.0.1:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); });
