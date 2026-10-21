#!/usr/bin/env node
// Dashboard speed measurement on a synthetic store (netbka/aiworks#49). A documented tool, not a test: it builds a
// disposable supervisor data directory of a busy installation's size from fictional campaigns only (about 70 campaigns,
// 200 steps, 650 operations with routing, 5,500 journal rows, 50 work items, result reviews, accepted results and
// project settings), times supervisorSnapshot on it, then starts the dashboard of this checkout as its own hidden
// process on a free loopback port and times /api/state, /api/v2/home and the project routes, and how long a static file
// asked for while a state request runs waits. It never reads an installation's data directory, and it stops its
// dashboard before it exits.
//
//   node scripts/dashboard-speed.mjs [--keep <empty-directory>] [--rounds 3] [--scale 1]
//   node --cpu-prof --cpu-prof-dir <dir> scripts/dashboard-speed.mjs    (a CPU profile of the supervisorSnapshot rounds)
//
// --keep builds the store in that directory and leaves it there; without it a temp directory is used and removed.
// --scale multiplies every size, to see how the time grows with the installation.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, get } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/supervisor/store.mjs';
import { campaignStart } from '../src/supervisor/api.mjs';
import { supervisorSnapshot } from '../src/dashboard/supervisor.mjs';
import { DisplayTextChecks } from '../src/dashboard/display-text.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const rounds = Number(option('--rounds', 3));
const keep = option('--keep', null);
if (keep && existsSync(keep) && readdirSync(keep).length) throw new Error('--keep must name a new or empty directory');
const root = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), 'aiworks-dashboard-speed-'));
mkdirSync(root, { recursive: true });

const scale = Number(option('--scale', 1));
const SIZE = Object.fromEntries(Object.entries({ campaigns: 70, steps: 200, operations: 650, journal: 5500, workItems: 50 }).map(([key, value]) => [key, Math.round(value * scale)]));
const REPOSITORIES = ['example-org/sampleapp', 'example-org/samplesite', 'example-org/sampletool', 'example-org/sampledocs'];
const git = (cwd, ...rest) => {
  const out = spawnSync('git', rest, { cwd, encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw new Error(`git ${rest[0]} failed`);
  return out.stdout.trim();
};

function build() {
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const repositories = {};
  for (const name of REPOSITORIES) {
    const repo = join(root, 'repos', name.split('/')[1]);
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Synthetic');
    git(repo, 'config', 'user.email', 'synthetic@example.invalid');
    writeFileSync(join(repo, 'AGENTS.md'), '# Synthetic rules\n');
    writeFileSync(join(repo, 'index.html'), '<!doctype html><title>Synthetic</title>\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'initial');
    repositories[name] = { path: repo, worktreeRoot: join(root, 'worktrees', name.split('/')[1]) };
  }
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ repositories, mergeDelegation: { enabled: true, repositories: [REPOSITORIES[0]] } }, null, 2));
  const store = new Store(join(dataDir, 'supervisor.db'));
  const now = Date.now(), day = 86_400_000;
  const sha = (value) => createHash('sha1').update(String(value)).digest('hex');
  const report = (id) => `# Synthetic report ${id}\n\nChecked.`;
  const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  let stepCount = 0, opCount = 0, journalCount = 0;
  const journal = (campaignId, kind, detail, at) => { store.journal(campaignId, kind, detail, at); journalCount++; };
  store.tx(() => {
    for (let n = 0; n < SIZE.campaigns; n++) {
      const campaignId = `synthetic-${String(n).padStart(3, '0')}`, repository = REPOSITORIES[n % REPOSITORIES.length];
      const count = n < SIZE.steps % SIZE.campaigns ? Math.ceil(SIZE.steps / SIZE.campaigns) : Math.floor(SIZE.steps / SIZE.campaigns);
      const tasks = Array.from({ length: count }, (_, i) => ({ id: `T${i + 1}`, issue: 1000 + n * 10 + i, title: `Synthetic step ${i + 1}`,
        deliverable: i === 2 ? 'report' : 'commit', goal: `Make synthetic change ${i + 1}.`, dependsOn: i ? [`T${i}`] : [],
        acceptance: ['The list shows every item', 'The list loads within one second', 'The empty list says so'],
        references: ['AGENTS.md', 'docs/GUIDE.md#setup'], ...(i === 0 && n % 5 === 0 ? { routing: { risk: 'high' } } : {}) }));
      const at = now - (SIZE.campaigns - n) * 3_600_000;
      campaignStart(store, {
        version: 1, campaignId, purpose: `Synthetic goal ${n}.`,
        authorization: { version: 1, grantedBy: 'owner', grantedAt: '2026-10-01', reference: `https://github.com/${repository}/issues/${n + 1}`, text: 'Synthetic authorization.' },
        target: { tenantId: 'example-org', projectId: repository.split('/')[1], environment: 'research', repository, baseBranch: 'main', trackingIssue: 100 + n },
        limits: { maxWorkerRuns: 30, slots: 2, maxRepairRounds: 2, maxRetriesPerTask: 2 },
        executor: { kind: 'claude-cli', model: 'opus', permissionMode: 'auto', implementerTimeoutMinutes: 30, verifierTimeoutMinutes: 30 },
        constraints: ['Synthetic constraint.'], tasks,
      }, at);
      journalCount++;
      const finished = n < SIZE.campaigns - 6;
      if (finished) store.run("UPDATE campaigns SET control = 'finished', status = 'finished' WHERE id = ?", campaignId);
      for (const [i, task] of tasks.entries()) {
        stepCount++;
        const head = sha(`${campaignId}/${task.id}`), text = report(`${campaignId}/${task.id}`);
        const done = finished || i < count - 1;
        const opsHere = Math.round(SIZE.operations / SIZE.steps) + (stepCount % 4 === 0 ? 1 : 0);
        for (let k = 0; k < opsHere && opCount < SIZE.operations; k++) {
          const verify = k % 2 === 1, opAt = at + (i * 10 + k) * 60_000, id = `${campaignId}.${task.id}.${verify ? 'verify' : 'implement'}.${k}`;
          const verdict = verify ? (k === opsHere - 1 ? 'accepted' : 'rejected') : null;
          store.insert('operations', { id, campaign_id: campaignId, task_id: task.id, kind: verify ? 'verify' : 'implement', seq: k, idempotency_key: id, lease_generation: 1,
            state: 'finished', session_id: `s-${opCount}`, run_dir: join(root, 'runs', id), workspace: join(root, 'worktrees', id), base_sha: sha('base'), target_sha: head,
            report_digest: digest(text), packet: { references: [{ path: 'AGENTS.md' }, { path: 'docs/GUIDE.md#setup' }] }, packet_digest: digest(id),
            outcome: verify ? { class: 'result', receipt: { costUsd: 0.4 }, value: { verdict, findings: verdict === 'rejected' ? [{ id: 'F1', severity: 'blocking', description: 'Synthetic finding.' }] : [] },
              reading: { cites: [{ finding: 'F1', path: 'docs/GUIDE.md', anchor: 'setup', heading: 'Setup', classification: 'covered' }] } }
              : { class: 'result', receipt: { costUsd: 1.2 }, value: { result: 'resolved' } },
            created_at: opAt, updated_at: opAt + 30_000, executor_kind: 'claude-cli',
            routing: { decision: { indicators: { risk: ['R0', 'R1', 'R2'][opCount % 3] } }, stage: verify ? 'verify' : 'implement', tier: 'standard', model: 'opus' } });
          opCount++;
          journal(campaignId, 'dispatched', { op: id, task: task.id, executor: 'claude-cli' }, opAt);
          journal(campaignId, 'operation-finished', { op: id, task: task.id, class: 'result', terminal: verdict ?? 'resolved' }, opAt + 30_000);
        }
        if (done) {
          store.run("UPDATE tasks SET state = 'done', head_sha = ?, verified_sha = ?, result = ?, verification = ?, pr_url = ?, version = version + 1 WHERE campaign_id = ? AND task_id = ?",
            head, head, JSON.stringify({ result: 'resolved', report: text }),
            JSON.stringify({ verdict: 'accepted', targetSha: head, reportDigest: digest(text), summary: 'Checked.', verdictSummary: 'It does what was promised.', findings: [],
              checks: [{ command: 'npm run check', result: 'pass' }], criteria: [{ criterion: 1, result: 'pass', check: 'Opened the list', evidence: 'All synthetic items shown.' }],
              eyesOn: ['The wording of the empty list'] }),
            `https://github.com/${repository}/pull/${stepCount}`, campaignId, task.id);
          if (finished && task.deliverable === 'commit') journal(campaignId, 'merged', { task: task.id, sha: head, url: `https://github.com/${repository}/pull/${stepCount}`, mergeCommit: sha(`m${stepCount}`) }, at + day / 2);
          else if (stepCount % 3 === 0) store.addEvent(campaignId, 'result-accepted', { taskId: task.id, verifiedSha: head, reportDigest: digest(text) }, `accept-${campaignId}-${task.id}`, at + day / 3);
        }
      }
      for (let k = 0; k < 4; k++) store.addEvent(campaignId, 'agent-instruction', { taskId: 'T1', role: 'implementer', text: `Synthetic instruction ${k} for ${campaignId}. `.repeat(k === 3 ? 12 : 1),
        authorizationVersion: 1, scopeDigest: 'x' }, `instr-${campaignId}-${k}`, at + k);
    }
    // The rest of the journal: supervisor bookkeeping a long-running installation accumulates.
    for (let k = 0; journalCount < SIZE.journal; k++) {
      const n = k % SIZE.campaigns, campaignId = `synthetic-${String(n).padStart(3, '0')}`;
      journal(campaignId, ['lease-acquired', 'wakeup', 'reading-guide-extended', 'event-dashboard-command'][k % 4],
        k % 4 === 2 ? { task: 'T1', path: 'docs/GUIDE.md', anchor: `part-${k % 7}` } : { at: k }, now - k * 1000);
    }
    for (let k = 1; k <= SIZE.workItems; k++) {
      store.insert('work_items', { number: k, kind: ['finding', 'decision', 'review', 'task', 'note'][k % 5], title: `Synthetic item ${k}`, body: `Synthetic body ${k}.`,
        state: k % 4 ? 'open' : 'closed', labels: '[]', needs_owner: k % 5 === 1 ? 1 : 0, campaign_id: null, task_id: null, verified_sha: null, source_url: null,
        source_updated_at: null, author_kind: 'supervisor', created_at: now - k * 60_000, updated_at: now - k * 60_000 });
      store.insert('work_item_comments', { item_number: k, idempotency_key: `c-${k}`, body: `Synthetic comment ${k}.`, author_kind: 'supervisor', author: null, created_at: now - k * 1000, recorded_at: now - k * 1000 });
    }
    for (const [k, project] of REPOSITORIES.entries()) {
      const settings = { protectedAreas: [], notes: `Synthetic notes ${k}.`, budget: { totalUsd: null, monthlyUsd: null, unknownRunCostUsd: null }, acceptance: k % 2 ? 'owner' : 'automatic' };
      store.insert('project_settings', { project, version: 1, settings: JSON.stringify(settings), digest: digest(JSON.stringify(settings)), request_id: `ps-${k}`, created_at: now - day });
    }
  });
  const counts = Object.fromEntries(['campaigns', 'tasks', 'operations', 'journal', 'work_items', 'events'].map((table) => [table, store.get(`SELECT COUNT(*) AS n FROM ${table}`).n]));
  store.close();
  return { dataDir, counts };
}

const ms = (start) => Math.round(performance.now() - start);
// One GET on its own connection, so a request never waits for another's socket.
const timed = (url) => new Promise((done, fail) => {
  const start = performance.now();
  get(url, { agent: false }, (res) => { res.resume(); res.on('end', () => done({ status: res.statusCode, ms: ms(start) })); }).on('error', fail);
});
const sleep = (delay) => new Promise((done) => setTimeout(done, delay));

/** A free loopback port: one the system hands out, released again before the dashboard takes it. */
async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/** The dashboard of this checkout (src/dashboard/main.mjs) as its own hidden process on the synthetic data directory. */
async function startDashboard(dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/dashboard/main.mjs', import.meta.url)), '--data', dataDir, '--port', String(port)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  await new Promise((done, fail) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('AIWorks dashboard:')) done(); });
    child.once('exit', (code) => fail(new Error(`the dashboard exited (${code}) before it listened`)));
  });
  return { base: `http://127.0.0.1:${port}`, child };
}

async function main() {
  const { dataDir, counts } = build();
  console.log(`synthetic store: ${JSON.stringify(counts)}`);
  const checks = new DisplayTextChecks();
  for (let r = 0; r < rounds; r++) {
    const start = performance.now();
    const snapshot = supervisorSnapshot(dataDir, Date.now(), { textChecks: checks });
    console.log(`supervisorSnapshot round ${r + 1}: ${ms(start)} ms (${snapshot.campaigns.length} campaigns, available ${snapshot.available})`);
  }
  await checks.close();
  const { base, child } = await startDashboard(dataDir);
  try {
    const project = encodeURIComponent(REPOSITORIES[0]);
    const routes = ['/api/state', '/api/v2/home', `/api/v2/projects/${project}`, `/api/v2/projects/${project}/releases`,
      `/api/v2/projects/${project}/settings`, `/api/v2/projects/${project}/knowledge`];
    for (let r = 0; r < rounds; r++) {
      for (const route of routes) {
        const out = await timed(base + route);
        console.log(`GET ${route} round ${r + 1}: ${out.ms} ms (${out.status})`);
      }
    }
    // A static file asked for while a state request runs (100 ms after it): it waits at most for the rest of that one.
    const state = timed(`${base}/api/state`);
    await sleep(100);
    const [page, during] = await Promise.all([state, timed(`${base}/dashboard.css`)]);
    console.log(`GET /dashboard.css asked 100 ms into /api/state: ${during.ms} ms (${during.status}); that /api/state: ${page.ms} ms`);
  } finally {
    child.kill();
    await new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', done)));
    if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

await main();
