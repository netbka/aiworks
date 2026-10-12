#!/usr/bin/env node
// AIWorks supervisor CLI. `serve` is the long-lived controller process (run it under OS
// supervision); the other commands are owner actions against the same durable store.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CampaignError, campaignCancel, campaignPause, campaignRecheck, campaignStart, campaignStatus, supervisorLiveness } from './api.mjs';
import { assertRegisteredTarget } from './campaign.mjs';
import { Controller, DEFAULTS } from './controller.mjs';
import { configuredGovernanceRoot, requireGovernanceRoot } from './governance.mjs';
import { clearCoordinatorViolation, coordinatorView, postOwnerMessage } from './coordinator.mjs';
import { CODE_ROOT, declarationFromMain, revisionNotMerged } from './provenance.mjs';
import { Store } from './store.mjs';

const USAGE = `Usage: node src/supervisor/cli.mjs <command> [--data <dir>] [--governance <engineering-platform-checkout>] ...
  serve                                 run the controller loop (exits cleanly when <data>/STOP exists)
  keep                                  OS-supervision helper: run serve and restart it after any exit until STOP
  stop                                  create <data>/STOP so serve and keep exit cleanly
  start <declaration.json>              register, amend (authorization.version + 1) or resume a campaign. The file must be
                                        campaigns/<name>.json of this checkout, committed unmodified at a HEAD merged into
                                        origin/main (DECLARATION_NOT_ON_MAIN / RUNTIME_NOT_MERGED); registering a new one also
                                        needs the governance checkout (GOVERNANCE_ROOT_REQUIRED / GOVERNANCE_ROOT_INVALID)
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
if (command === 'keep') await keep();
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
    // AW-005: registration, amendment and resume all take the declaration committed in this checkout's campaigns/,
    // unmodified, at a HEAD merged into origin/main. There is no flag to skip this.
    const declaration = declarationFromMain(rest[0], { root: CODE_ROOT });
    // Only a new registration is gated on the registry; resuming or amending a stored campaign is unaffected.
    if (!store.campaign(declaration?.campaignId)) {
      assertRegisteredTarget(declaration, explicitGovernance ? resolve(explicitGovernance) : configuredGovernanceRoot(dataDir));
    }
    print(campaignStart(store, declaration));
  }
  else if (command === 'status') {
    store.db.exec('BEGIN');
    try {
      // aiworks#18: whether any controller is running leads the output, so a stopped supervisor is the first thing read.
      let config = {};
      try { config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { /* the default lease length */ }
      const now = Date.now();
      const supervisor = supervisorLiveness(store, { now, leaseMs: config.leaseMs ?? DEFAULTS.leaseMs, stopRequested: existsSync(STOP) });
      print({ supervisor, ...campaignStatus(store, rest[0], now), dataSource: explicitData ? '--data' : 'AIWORKS_DATA' });
    }
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
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: CODE_ROOT, encoding: 'utf8', windowsHide: true });
  const codeRevision = head.status === 0 ? head.stdout.trim() : null;
  // AW-005: this process's own code must be merged into origin/main before it starts new work. Always supplied here.
  const revisionCheck = () => revisionNotMerged({ root: CODE_ROOT, revision: codeRevision });
  // Governance is optional at startup: without a valid root the controller still runs but dispatches no worker (it raises a
  // project-governance blocker per campaign) rather than fall back to this checkout.
  const governanceRoot = explicitGovernance ? resolve(explicitGovernance) : config.governanceRoot;
  let governanceNote = 'governance checkout ok';
  try { requireGovernanceRoot(governanceRoot); } catch (error) { governanceNote = `${error.code}: no worker will be dispatched until it is fixed`; }
  const controller = new Controller({ store, config, dataDir, log, codeRevision, governanceRoot, revisionCheck });
  log(`supervisor instance ${controller.instanceId} started (pid ${process.pid}, code ${codeRevision ?? 'unknown'}, data ${dataDir}, ${governanceNote})`);
  const unmerged = controller.unmergedRevision();
  if (unmerged) log(`no new work will start: ${unmerged} (AW-005)`);
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

// The scheduled task starts keep again every 5 minutes (aiworks#18). Before it ends, keep writes one line saying why:
// the STOP file, a console signal (a closed console or Ctrl+C arrives as SIGHUP, SIGINT or SIGBREAK) or an error.
// Only a forced kill ends it without that line. A start while STOP exists exits at once and writes nothing, so a
// stopped supervisor's log does not gain a line every 5 minutes.
async function keep() {
  if (existsSync(STOP)) { console.error(`${STOP} exists; keeper not started`); process.exit(0); }
  const logFile = join(dataDir, 'supervisor.log');
  const log = (line) => { try { appendFileSync(logFile, `${new Date().toISOString()} [keep] ${line}\n`); } catch { /* no log file */ } };
  const self = fileURLToPath(import.meta.url);
  let child = null;
  const end = (reason, code) => {
    const running = child && child.exitCode === null && child.signalCode === null;
    log(`keeper ending (pid ${process.pid}): ${reason}; exit code ${code}${running ? `; serve (pid ${child.pid}) stops on its own signal or the STOP file` : ''}`);
    process.exit(code);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(signal, () => end(`received ${signal}`, 128 + (osConstants.signals[signal] ?? 0)));
  process.on('uncaughtException', (error) => end(`failed: ${String(error?.stack ?? error).split('\n')[0]}`, 1));
  log(`keeper started (pid ${process.pid})`);
  while (!existsSync(STOP)) {
    child = spawn(process.execPath, ['--no-warnings', self, 'serve', '--data', dataDir, ...(explicitGovernance ? ['--governance', resolve(explicitGovernance)] : [])], { stdio: 'ignore', windowsHide: true });
    const code = await new Promise((done) => { child.on('exit', done); child.on('error', () => done('spawn-error')); });
    log(`serve exited with ${code}`);
    if (existsSync(STOP)) break;
    await new Promise((done) => setTimeout(done, 10_000));
  }
  end('STOP file present', 0);
}
