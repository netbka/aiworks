import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredGithubCommand, configuredRepositories, readReleaseAuthorizations } from './roadmap.mjs';
import { configuredGovernanceRoot } from '../supervisor/governance.mjs';
import { RoadmapSource } from './roadmap.mjs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { createDashboardServer } from './server.mjs';
import { supervisorSnapshot } from './supervisor.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--data', '--port', '--cache', '--governance'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Usage: npm run dashboard -- --data <supervisor-directory> [--port 4318] [--cache <directory>] [--governance <engineering-platform-checkout>]');
  options[args[i]] = args[i + 1];
}
if (!options['--data']) throw new Error('--data must name the existing supervisor data directory');
const port = Number(options['--port'] ?? 4318);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('port must be 1024..65535');
const dataDir = resolve(options['--data']);
// The governance root is a read-only checkout of netbka/engineering-platform: --governance, else config.json governanceRoot.
// Without a valid one the roadmap panels say so; the dashboard still serves the campaigns.
const configuredGovernance = options['--governance'] ? resolve(options['--governance']) : configuredGovernanceRoot(dataDir);
const roadmap = new RoadmapSource({ root: configuredGovernance, cacheDir: resolve(options['--cache'] ?? join(root, '.local/dashboard-cache')),
  gh: configuredGithubCommand(dataDir), repositories: configuredRepositories(dataDir) });
let revision = null;
try { revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim(); }
catch { /* A checkout without git still serves; the revision is shown as unknown. */ }
// Campaign target repositories are fetched from the first refresh, so finished steps match their pull requests.
roadmap.track(supervisorSnapshot(dataDir).campaigns.map((c) => c.repository));
// Release wording follows each project's registry entry in the governance checkout.
const server = createDashboardServer({ dataDir, roadmap, host: { name: hostname(), revision }, releases: readReleaseAuthorizations(configuredGovernance) });
server.on('error', (error) => { console.error(`Dashboard could not listen (${error.code ?? 'unknown'}).`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`AIWorks dashboard: http://127.0.0.1:${port}`);
  void roadmap.refresh();
});
const refresh = setInterval(() => { void roadmap.refresh(); }, 60_000);
refresh.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(refresh); server.close(); });
