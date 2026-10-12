#!/usr/bin/env node
// AIWorks supervisor CLI. `serve` is the long-lived controller process (run it under OS
// supervision); the other commands are owner actions against the same durable store.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CampaignError, campaignCancel, campaignPause, campaignRecheck, campaignStart, campaignStatus } from './api.mjs';
import { assertRegisteredTarget } from './campaign.mjs';
import { Controller } from './controller.mjs';
import { configuredGovernanceRoot, requireGovernanceRoot } from './governance.mjs';
import { clearCoordinatorViolation, coordinatorView, postOwnerMessage } from './coordinator.mjs';
import { Store } from './store.mjs';

const USAGE = `Usage: node src/supervisor/cli.mjs <command> [--data <dir>] [--governance <engineering-platform-checkout>] ...
  serve                                 run the controller loop (exits cleanly when <data>/STOP exists)
  keep                                  OS-supervision helper: run serve and restart it after any exit until STOP
  stop                                  create <data>/STOP so serve and keep exit cleanly
  start <declaration.json>              register, amend (authorization.version + 1) or resume a campaign; registering a new
                                        one needs the governance checkout (GOVERNANCE_ROOT_REQUIRED / GOVERNANCE_ROOT_INVALID)
  status <campaignId>
  pause <campaignId> [reason]
  cancel <campaignId> [reason]
  recheck <campaignId> [--task <taskId>] [note]
  message <text>                        send a message to the coordinator agent; prints its receipt
  messages                              list coordinator message receipts (received, read, answered)
  coordinator-clear                     after inspecting a boundary violation, let the coordinator read again
The data directory defaults to AIWORKS_DATA and holds config.json, supervisor.db, runs/ and supervisor.log.
The governance checkout (a read-only clone of netbka/engineering-platform) is --governance, else config.json "governanceRoot".`;

const args = process.argv.slice(2);
const take = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const [, value] = args.splice(index, 2);
  return value;
};
const explicitData = take('--data');
const selectedData = explicitData ?? process.env.AIWORKS_DATA;
const dataDir = resolve(selectedData ?? '');
const taskFlag = take('--task');
const explicitGovernance = take('--governance');
const [command, ...rest] = args;
if (!command || !selectedData) {
  console.error(USAGE);
  process.exit(2);
}

const STOP = join(dataDir, 'STOP');
if (command === 'keep') { await keep(); process.exit(0); }
if (command === 'stop') { writeFileSync(STOP, new Date().toISOString()); console.log(`created ${STOP}`); process.exit(0); }

let store;
const print = (value) => console.log(JSON.stringify(value, null, 2));

try {
  // A conflicting shell default is evidence of an ambiguous status target, never a reason to create a store.
  const environmentData = process.env.AIWORKS_DATA;
  const canonical = (path) => existsSync(path) ? realpathSync(path) : resolve(path);
  if (command === 'status' && explicitData && environmentData && canonical(explicitData) !== canonical(environmentData)) {
    throw new CampaignError('DATA_DIR_MISMATCH', '--data differs from AIWORKS_DATA; confirm the installed task path and unset or correct the stale value');
  }
  store = new Store(join(dataDir, 'supervisor.db'), { readOnly: command === 'status' || command === 'messages' });
  if (command === 'serve') await serve();
  else if (command === 'start') {
    const declaration = JSON.parse(readFileSync(rest[0], 'utf8'));
    // Only a new registration is gated; resuming or amending a stored campaign is unaffected.
    if (!store.campaign(declaration?.campaignId)) {
      assertRegisteredTarget(declaration, explicitGovernance ? resolve(explicitGovernance) : configuredGovernanceRoot(dataDir));
    }
    print(campaignStart(store, declaration));
  }
  else if (command === 'status') {
    store.db.exec('BEGIN');
    try { print({ ...campaignStatus(store, rest[0]), dataSource: explicitData ? '--data' : 'AIWORKS_DATA' }); }
    finally { store.db.exec('ROLLBACK'); }
  }
  else if (command === 'pause') print(campaignPause(store, rest[0], rest.slice(1).join(' ') || null));
  else if (command === 'cancel') print(campaignCancel(store, rest[0], rest.slice(1).join(' ') || null));
  else if (command === 'recheck') print(campaignRecheck(store, rest[0], { task: taskFlag, note: rest.slice(1).join(' ') || null }));
  else if (command === 'coordinator-clear') print(clearCoordinatorViolation(store));
  else if (command === 'message') print(postOwnerMessage(store, { text: rest.join(' '), requestId: randomUUID(), source: 'owner (cli)' }));
  else if (command === 'messages') {
    const config = existsSync(join(dataDir, 'config.json')) ? JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) : {};
    const view = coordinatorView(store, config);
    print({ ...view, runs: view.runs.map((run) => ({ id: run.id, state: run.state, messages: run.message_ids, createdAt: new Date(run.created_at).toISOString() })) });
  }
  else { console.error(USAGE); process.exitCode = 2; }
} catch (error) {
  console.error(`${error.code ?? error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (command !== 'serve') store?.close();
}

async function serve() {
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  const logFile = join(dataDir, 'supervisor.log');
  const log = (line) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    try { appendFileSync(logFile, text); } catch { /* keep running without a log file */ }
    if (process.stdout.isTTY) process.stdout.write(text);
  };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const codeRevision = head.status === 0 ? head.stdout.trim() : null;
  // Governance is optional at startup: without a valid root the controller still runs but dispatches no worker (it raises a
  // project-governance blocker per campaign) rather than fall back to this checkout.
  const governanceRoot = explicitGovernance ? resolve(explicitGovernance) : config.governanceRoot;
  let governanceNote = 'governance checkout ok';
  try { requireGovernanceRoot(governanceRoot); } catch (error) { governanceNote = `${error.code}: no worker will be dispatched until it is fixed`; }
  const controller = new Controller({ store, config, dataDir, log, codeRevision, governanceRoot });
  log(`supervisor instance ${controller.instanceId} started (pid ${process.pid}, code ${codeRevision ?? 'unknown'}, data ${dataDir}, ${governanceNote})`);
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`received ${signal}; releasing leases`);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => stop(signal));
  while (!stopping) {
    if (existsSync(STOP)) { stop('STOP file'); break; }
    await controller.tick();
    for (let waited = 0; waited < controller.config.tickMs && !stopping; waited += 100) await new Promise((done) => setTimeout(done, 100));
  }
  controller.release();
  store.close();
  log(`supervisor instance ${controller.instanceId} stopped`);
}

async function keep() {
  const logFile = join(dataDir, 'supervisor.log');
  const log = (line) => { try { appendFileSync(logFile, `${new Date().toISOString()} [keep] ${line}\n`); } catch { /* no log file */ } };
  const self = fileURLToPath(import.meta.url);
  log(`keeper started (pid ${process.pid})`);
  while (!existsSync(STOP)) {
    const child = spawn(process.execPath, ['--no-warnings', self, 'serve', '--data', dataDir, ...(explicitGovernance ? ['--governance', resolve(explicitGovernance)] : [])], { stdio: 'ignore', windowsHide: true });
    const code = await new Promise((done) => { child.on('exit', done); child.on('error', () => done('spawn-error')); });
    log(`serve exited with ${code}`);
    if (existsSync(STOP)) break;
    await new Promise((done) => setTimeout(done, 10_000));
  }
  log('keeper stopped (STOP file present)');
}
