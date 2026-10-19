#!/usr/bin/env node
// AIWorks supervisor CLI. `serve` is the long-lived controller process (run it under OS
// supervision); the other commands are owner actions against the same durable store.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalRequired, approvedStart, revokeApprovals } from './approvals.mjs';
import { approvedDeclaration, persistApproved, registerApproved } from './approved-declarations.mjs';
import { baselineReport, formatBaseline } from './baseline.mjs';
import { CampaignError, campaignCancel, campaignPause, campaignRecheck, campaignStatus, supervisorLiveness } from './api.mjs';
import { assertRegisteredTarget } from './campaign.mjs';
import { Controller, DEFAULTS } from './controller.mjs';
import { configuredGovernanceRoot, requireGovernanceRoot } from './governance.mjs';
import { clearCoordinatorViolation, coordinatorView, postOwnerMessage } from './coordinator.mjs';
import { approvalFromFile, CODE_ROOT, declarationFromFile, revisionNotMerged, runtimeTrust } from './provenance.mjs';
import { selfHostingSettings, trustedTip } from './self-hosting.mjs';
import { Store } from './store.mjs';
import { comments as workItemComments, item as workItem, items as workItems } from './work-list.mjs';
import { importIssues } from './work-list-import.mjs';
import { approveProgram, programFromFile, programStatus, stopPrograms } from './program.mjs';
import { RELEASE_STOP, REVIEW_ONLY, releaseNarrowings, setReviewOnly } from './release/state.mjs';
import { modelPreferences, setRoleModelPreference, clearRoleModelPreferences, configuredAccounts, addDashboardAccount, removeDashboardAccount, exportDashboardAccounts, importDashboardAccounts } from './accounts.mjs';

const USAGE = `Usage: node src/supervisor/cli.mjs <command> [--data <dir>] [--governance <governance-checkout>] ...
  serve                                 run the controller loop (exits cleanly when <data>/STOP exists)
  keep                                  OS-supervision helper: run serve and restart it after any exit until STOP
  stop                                  create <data>/STOP so serve and keep exit cleanly
  start <declaration.json>              register, amend (authorization.version + 1) or resume a private local campaign.
                                        Runtime code must be merged into origin/main (RUNTIME_NOT_MERGED). A new registration
                                        needs the governance checkout (GOVERNANCE_ROOT_REQUIRED / GOVERNANCE_ROOT_INVALID)
    --approval <approval.json>          start only under this private approval: its authorityDigest must equal the declaration's
                                        (DECLARATION_DIFFERS_FROM_APPROVAL). A campaign started under an approval needs one on
                                        every later start. config.json "approvals": { "required": true } (off by default) also
                                        requires one for every new version 2 campaign
  start --approved <campaignId>         register the campaign once from its persisted private approved declaration; the stored
                                        bytes must still match the approval. Already registered under that digest: no change
  approve <declaration.json> --approval <approval.json>
                                        keep the approved declaration in the private store (supervisor.db, which Git must not
                                        track: PRIVATE_STORE_NOT_IGNORED). Registers nothing; never opens a branch or PR
  approval-revoke <campaignId> [reason] revoke the campaign's recorded private approvals and cancel the campaign:
                                        nothing starts under them again
  status <campaignId>
  pause <campaignId> [reason]
  cancel <campaignId> [reason]
  recheck <campaignId> [--task <taskId>] [note]
  message <text>                        send a message to the coordinator agent; prints its receipt
  messages                              list coordinator message receipts (received, read, answered)
  coordinator-clear                     after inspecting a boundary violation, let the coordinator read again
  baseline [--since <date>] [--json]    print the cost and outcome baseline (read-only; --json prints the report only)
  release-stop                          create <data>/RELEASE-STOP: every release stops before its next step (Auto Release
                                        is built switched off; removing the file is the owner's action)
  release-mode <project> <destination> review-only
                                        narrow one destination to Review only. review-only is the only mode accepted:
                                        no command switches a destination to Auto Release, only a newer valid grant does
  program-approve <program.json>        keep the owner's private program record (aiworks-program/1) by its digest. A higher
                                        authorization.version replaces it; a lower or equal one is refused; revoked stays
                                        revoked. Registers nothing (built switched off: config.json "program": { "enabled": true })
  program-stop [reason]                 create <data>/PROGRAM-STOP: no program starts a new wave (removing it is the owner's action)
  program-status                        print whether programs are switched on or stopped, and the approved records (read-only)
  trusted-main                          with config.json "selfHosting": { "trustedMain": "local" } (off by default), print the
                                        trusted tip of local main, then the number of unrecorded commits after it (read-only;
                                        never fetches). Refused while origin/main is the trusted main (TRUSTED_MAIN_NOT_LOCAL)
  work-list [open|closed]               list the items of the local work list (read-only)
  work-list <number>                    print one work item and its comments (read-only; WORK_ITEM_NOT_FOUND)
  work-list import [--apply]            import the open issues of config.json selfHosting.repository and all their comments,
                                        read-only towards GitHub (REST GET only). A dry run by default: prints the counts and
                                        writes nothing. --apply records them; a re-run adds only new comments and reports
                                        changed issues without overwriting. Secret-like text is withheld and listed
  account list                          list configured accounts and profile cooldown / usage metrics
  account add <provider> <name> [--token <tok>] [--api-key <key>]
                                        add a local login profile under the shallow homes root
  account remove <provider> <name>      remove an account profile from local storage and store
  account export [<file>] --passphrase <pass>
                                        export encrypted credential bundle of all profiles
  account import <file> --passphrase <pass>
                                        import encrypted credential bundle into profile folders
  account preferences                   list role model order and preferences (implementer, verification, etc.)
  account set-preference <role> <model1> [model2...] [--kind <kind>] [--effort <effort>]
                                        set model order and preferences for a role
  account clear-preferences [<role>]    clear model preferences for a role or all roles
The data directory defaults to AIWORKS_DATA and holds config.json, supervisor.db, runs/ and supervisor.log.
The governance checkout (an operator-configured read-only directory) is --governance, else config.json "governanceRoot".`;

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
const approvalFlag = take('--approval');
const approvedFlag = take('--approved');
const explicitGovernance = take('--governance');
const sinceFlag = take('--since');
const tokenFlag = take('--token');
const apiKeyFlag = take('--api-key');
const passphraseFlag = take('--passphrase');
const kindFlag = take('--kind');
const effortFlag = take('--effort');
const applyImport = args.includes('--apply') ? Boolean(args.splice(args.indexOf('--apply'), 1)) : false;
const jsonOnly = args.includes('--json') ? Boolean(args.splice(args.indexOf('--json'), 1)) : false;
const [command, ...rest] = args;
if (!command || !selectedData) {
  console.error(USAGE);
  process.exit(2);
}

const STOP = join(dataDir, 'STOP');
if (command === 'keep') await keep();
if (command === 'stop') { writeFileSync(STOP, new Date().toISOString()); console.log(`created ${STOP}`); process.exit(0); }
// Stop all releases is a file, so it works without SQLite and without healthy release code (AUTO_RELEASE.md 4.5).
if (command === 'release-stop') {
  const file = join(dataDir, RELEASE_STOP);
  writeFileSync(file, new Date().toISOString());
  console.log(`created ${file}: every release stops before its next step. Delete the file to allow releases again.`);
  process.exit(0);
}
// Like release-stop, the program stop is a file: it works without SQLite and without healthy program code.
if (command === 'program-stop') {
  const file = stopPrograms(dataDir, { reason: rest.join(' ') || null });
  console.log(`created ${file}: no program starts a new wave. Delete the file to allow new waves again.`);
  process.exit(0);
}
// The mode only narrows. Anything but `release-mode <project> <destination> review-only` is refused before the store opens.
if (command === 'release-mode' && (rest.length !== 3 || !rest[0]?.trim() || !rest[1]?.trim() || rest[2] !== REVIEW_ONLY)) {
  console.error(`RELEASE_MODE_REFUSED: release-mode only narrows: use release-mode <project> <destination> ${REVIEW_ONLY}. No command switches a destination to Auto Release; only a newer valid release grant makes it available (docs/design/AUTO_RELEASE.md section 3).`);
  process.exit(2);
}

let store;
const print = (value) => console.log(JSON.stringify(value, null, 2));
// config.json, or {} when it is absent or malformed (every switch then stays off).
const dataConfig = () => { try { return JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { return {}; } };
// AW-005: the trusted main this runtime is checked against: origin/main unless selfHosting trusts local main.
const trustHere = () => runtimeTrust(dataConfig(), store);

try {
  // A conflicting shell default is evidence of an ambiguous status target, never a reason to create a store.
  const environmentData = process.env.AIWORKS_DATA;
  const canonical = (path) => existsSync(path) ? realpathSync(path) : resolve(path);
  if (command === 'status' && explicitData && environmentData && canonical(explicitData) !== canonical(environmentData)) {
    throw new CampaignError('DATA_DIR_MISMATCH', '--data differs from AIWORKS_DATA; confirm the installed task path and unset or correct the stale value');
  }
  // Only `work-list import --apply` writes the work list; every other work-list command reads it.
  const importWrites = command === 'work-list' && rest[0] === 'import' && applyImport;
  const readOnlyCommand = (['status', 'messages', 'baseline', 'program-status', 'trusted-main', 'work-list'].includes(command) && !importWrites) ||
    ((command === 'account' || command === 'accounts') && existsSync(join(dataDir, 'supervisor.db')) && (!rest[0] || ['list', 'preferences', 'prefs'].includes(rest[0])));
  // program-status, trusted-main and work-list never create a store: without one there is no approved program, no main
  // ledger and no work item.
  if (!['program-status', 'trusted-main', 'work-list'].includes(command) || importWrites || existsSync(join(dataDir, 'supervisor.db'))) store = new Store(join(dataDir, 'supervisor.db'), { readOnly: readOnlyCommand });
  if (command === 'serve') await serve();
  else if (command === 'start' && approvedFlag !== null) {
    // The owner's private approved declaration (WORK_ENVELOPE.md section 5, slice E9), registered by merged code only.
    const notMerged = revisionNotMerged({ root: CODE_ROOT, trust: trustHere() });
    if (notMerged) throw new CampaignError('RUNTIME_NOT_MERGED', notMerged);
    if (!store.campaign(approvedFlag)) {
      assertRegisteredTarget(approvedDeclaration(store, approvedFlag).declaration, explicitGovernance ? resolve(explicitGovernance) : configuredGovernanceRoot(dataDir));
    }
    print(registerApproved(store, approvedFlag));
  }
  else if (command === 'approve') {
    if (approvalFlag === null) throw new CampaignError('APPROVAL_REQUIRED', 'approve <declaration.json> needs --approval <approval.json>');
    const trust = trustHere();
    print(persistApproved(store, declarationFromFile(rest[0], { root: CODE_ROOT, trust }), approvalFromFile(approvalFlag, { root: CODE_ROOT, trust })));
  }
  else if (command === 'start') {
    // Explicit operator registration reads private data; executable code must still be merged.
    // Off (no selfHosting block), the call is today's; with local trust the same check reads the trusted tip of local main.
    const trust = trustHere();
    const declaration = trust ? declarationFromFile(rest[0], { root: CODE_ROOT, trust }) : declarationFromFile(rest[0], { root: CODE_ROOT });
    // The owner's private approval, when given, is read by the same merged code (WORK_ENVELOPE.md section 5, slice E7).
    const approval = approvalFlag === null ? null : approvalFromFile(approvalFlag, { root: CODE_ROOT, trust });
    // Only a new registration is gated on the registry; resuming or amending a stored campaign is unaffected.
    if (!store.campaign(declaration?.campaignId)) {
      assertRegisteredTarget(declaration, explicitGovernance ? resolve(explicitGovernance) : configuredGovernanceRoot(dataDir));
    }
    let config = {};
    try { config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { /* no config: approvals stay optional */ }
    print(approvedStart(store, declaration, approval, { required: approvalRequired(config) }));
  }
  else if (command === 'status') {
    store.db.exec('BEGIN');
    try {
      // aiworks#18: whether any controller is running leads the output, so a stopped supervisor is the first thing read.
      let config = {};
      try { config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { /* the default lease length */ }
      const now = Date.now();
      const supervisor = supervisorLiveness(store, { now, leaseMs: config.leaseMs ?? DEFAULTS.leaseMs, stopRequested: existsSync(STOP) });
      print({ supervisor, ...campaignStatus(store, rest[0], now, { releaseStop: existsSync(join(dataDir, RELEASE_STOP)), selfHostingConfig: config }), dataSource: explicitData ? '--data' : 'AIWORKS_DATA' });
    }
    finally { store.db.exec('ROLLBACK'); }
  }
  else if (command === 'baseline') {
    // docs/design/MODEL_ROUTING.md section 8: a read-only snapshot of the store; no model, network or GitHub call.
    const since = sinceFlag === null ? null : Date.parse(sinceFlag);
    if (Number.isNaN(since)) throw new CampaignError('BASELINE_SINCE_INVALID', `--since ${sinceFlag} is not a date`);
    store.db.exec('BEGIN');
    try {
      const report = baselineReport(store, { since });
      if (!jsonOnly) console.log(`${formatBaseline(report)}
`);
      print(report);
    }
    finally { store.db.exec('ROLLBACK'); }
  }
  else if (command === 'program-approve') print(approveProgram(store, programFromFile(rest[0], { root: CODE_ROOT })));
  else if (command === 'program-status') {
    let config = {};
    try { config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { /* no or malformed config: programs stay off */ }
    print(programStatus({ store, dataDir, config }));
  }
  else if (command === 'trusted-main') {
    // LOCAL_OPERATION.md section 4.3: what an upgrade deploys with local trust. Line 1 is the commit, never typed by hand.
    const settings = selfHostingSettings(dataConfig());
    if (!settings.local) throw new CampaignError('TRUSTED_MAIN_NOT_LOCAL', `the trusted main is origin/main${settings.problem ? ` (${settings.problem})` : ''}`);
    const tip = store ? trustedTip(store, { repoPath: CODE_ROOT, repository: settings.repository })
      : { state: 'NO_ANCHOR', reason: 'the main ledger of this repository has no anchor' };
    if (tip.state !== 'TRUSTED') throw new CampaignError(tip.state, tip.reason);
    console.log(tip.tip);
    console.log(`${tip.unrecordedCount} unrecorded commit${tip.unrecordedCount === 1 ? '' : 's'} on local main ${tip.main.slice(0, 12)} after it`);
  }
  else if (command === 'work-list') {
    // LOCAL_OPERATION.md section 5.1: read-only. Items are written by the owner route and the supervisor; here only by the
    // import (section 5.4), which writes nothing without --apply and only reads from GitHub.
    if (rest[0] === 'import' && rest.length === 1) {
      const { repository } = selfHostingSettings(dataConfig());
      if (!repository) throw new CampaignError('WORK_IMPORT_NO_REPOSITORY', 'config.json selfHosting.repository must name the repository whose issues are imported');
      print(importIssues({ store: store ?? null, gh: dataConfig().commands?.gh ?? ['gh'], repository, dryRun: !applyImport, now: Date.now() }));
    }
    else if (/^\d+$/.test(rest[0] ?? '')) {
      const found = store ? workItem(store, Number(rest[0])) : null;
      if (!found) throw new CampaignError('WORK_ITEM_NOT_FOUND', `no work item #${rest[0]}`);
      print({ ...found, comments: workItemComments(store, found.number) });
    }
    else if (rest[0] === undefined || ['open', 'closed'].includes(rest[0])) print(store ? workItems(store, { state: rest[0] ?? null }) : []);
    else { console.error(USAGE); process.exitCode = 2; }
  }
  else if (command === 'pause') print(campaignPause(store, rest[0], rest.slice(1).join(' ') || null));
  else if (command === 'cancel') print(campaignCancel(store, rest[0], rest.slice(1).join(' ') || null));
  else if (command === 'recheck') print(campaignRecheck(store, rest[0], { task: taskFlag, note: rest.slice(1).join(' ') || null }));
  else if (command === 'approval-revoke') print(revokeApprovals(store, rest[0], { reason: rest.slice(1).join(' ') || null }));
  else if (command === 'coordinator-clear') print(clearCoordinatorViolation(store));
  else if (command === 'release-mode') {
    setReviewOnly(store, { project: rest[0], destination: rest[1], source: 'owner (cli)', now: Date.now() });
    print({ project: rest[0], narrowed: releaseNarrowings(store, rest[0]).find((row) => row.destination === rest[1]) });
  }
  else if (command === 'message') print(postOwnerMessage(store, { text: rest.join(' '), requestId: randomUUID(), source: 'owner (cli)' }));
  else if (command === 'messages') {
    const config = existsSync(join(dataDir, 'config.json')) ? JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) : {};
    const view = coordinatorView(store, config);
    print({ ...view, runs: view.runs.map((run) => ({ id: run.id, state: run.state, messages: run.message_ids, createdAt: new Date(run.created_at).toISOString() })) });
  }
  else if (command === 'account' || command === 'accounts') {
    const sub = rest[0];
    let config = {};
    try { config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { /* default empty config */ }
    if (!sub || sub === 'list') {
      const accounts = configuredAccounts(store, config, { dataDir });
      print({ accounts });
    } else if (sub === 'add') {
      const provider = rest[1];
      const name = rest[2];
      const token = tokenFlag ?? apiKeyFlag;
      print(addDashboardAccount(dataDir, { provider, name, token, apiKey: apiKeyFlag }));
    } else if (sub === 'remove') {
      const provider = rest[1];
      const name = rest[2];
      print(removeDashboardAccount(dataDir, { provider, name }));
    } else if (sub === 'export') {
      const outPath = rest[1] && !rest[1].startsWith('--') ? rest[1] : null;
      const res = exportDashboardAccounts(dataDir, { passphrase: passphraseFlag });
      if (outPath) {
        writeFileSync(resolve(outPath), Buffer.from(res.bundleBase64, 'base64'));
        print({ success: true, count: res.count, exportedTo: resolve(outPath) });
      } else {
        print(res);
      }
    } else if (sub === 'import') {
      const inPath = rest[1] && !rest[1].startsWith('--') ? rest[1] : null;
      if (!inPath) throw new CampaignError('FILE_REQUIRED', 'account import <bundleFile> requires file path');
      const bundleBase64 = readFileSync(resolve(inPath)).toString('base64');
      print(importDashboardAccounts(dataDir, { bundleBase64, passphrase: passphraseFlag }));
    } else if (sub === 'preferences' || sub === 'prefs') {
      print({ preferences: modelPreferences(config) });
    } else if (sub === 'set-preference') {
      const role = rest[1];
      if (!role) throw new CampaignError('ROLE_REQUIRED', 'account set-preference <role> <model1> [model2...]');
      const models = rest.slice(2).filter((item) => !item.startsWith('--'));
      if (!models.length) throw new CampaignError('MODEL_REQUIRED', 'account set-preference requires at least one model');
      const modelEntries = models.map((m) => {
        const entry = { model: m };
        if (kindFlag) entry.kind = kindFlag;
        if (effortFlag) entry.effort = effortFlag;
        return entry;
      });
      print(setRoleModelPreference(dataDir, role, modelEntries));
    } else if (sub === 'clear-preferences') {
      const role = rest[1] && !rest[1].startsWith('--') ? rest[1] : null;
      print(clearRoleModelPreferences(dataDir, role));
    } else {
      console.error(USAGE);
      process.exitCode = 2;
    }
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
  // AW-005: this process's own code must be merged into the trusted main before it starts new work. Always supplied here.
  const trust = runtimeTrust(config, store, { log });
  const revisionCheck = trust ? () => revisionNotMerged({ root: CODE_ROOT, revision: codeRevision, trust })
    : () => revisionNotMerged({ root: CODE_ROOT, revision: codeRevision });
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
