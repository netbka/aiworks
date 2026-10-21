#!/usr/bin/env node
// A disposable owner-journey runtime (issue #39): the real `cli.mjs serve` and dashboard `main.mjs` from a committed copy of
// this checkout, a synthetic worker (tests/supervisor/fixtures/fake-claude.mjs, no model or network call), synthetic
// governance and two fictional owner projects, driven by a headless Chrome over the DevTools protocol.
//   node scripts/supervisor/owner-journey.mjs <empty-or-new-folder>
// The folder must not lie inside a Git repository or the home folder (project preflight refuses owner folders there), and it
// keeps the screenshots and journey.json afterwards; nothing is written into this checkout. Protected owner actions pass
// the production Windows caller check unchanged: the browser is a process AIWorks did not start, in no AIWorks job.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
  .find((path) => existsSync(path));
const FICTIONAL_HOST = 'Example PC';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const git = (cwd, ...args) => {
  const out = spawnSync('git', ['-c', 'user.name=Journey Owner', '-c', 'user.email=owner@example.invalid', ...args],
    { cwd, encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};
const freePort = () => new Promise((done, fail) => {
  const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); }).on('error', fail);
});

/** The runtime: this checkout's source as one commit that its own origin/main contains (provenance.mjs revisionNotMerged). */
export function setup(root) {
  if (existsSync(root) && readdirSync(root).length) throw new Error('the journey folder must be new or empty');
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(root), encoding: 'utf8', windowsHide: true });
  if (top.status === 0) throw new Error('the journey folder must not lie inside a Git repository');
  const dirs = Object.fromEntries(['runtime', 'data', 'fake', 'owner', 'evidence', 'chrome'].map((name) => [name, join(root, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  for (const dir of ['src', 'scripts/lib', 'registry', 'schemas', 'tests/supervisor/fixtures', 'tests/fixtures/governance']) {
    cpSync(join(ROOT, dir), join(dirs.runtime, dir), { recursive: true });
  }
  cpSync(join(ROOT, 'package.json'), join(dirs.runtime, 'package.json'));
  writeFileSync(join(dirs.runtime, '.gitignore'), 'node_modules\n');
  symlinkSync(join(ROOT, 'node_modules'), join(dirs.runtime, 'node_modules'), 'junction');
  git(dirs.runtime, 'init', '-q', '-b', 'main');
  git(dirs.runtime, 'add', '-A');
  git(dirs.runtime, 'commit', '-q', '-m', 'journey runtime');
  git(dirs.runtime, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  // Two fictional owner projects: a plain folder and a local Git repository, each with rules and a static home page.
  const page = '<!doctype html><title>Notes</title><h1>Notes</h1>\n';
  const notes = join(dirs.owner, 'notes');
  mkdirSync(notes);
  writeFileSync(join(notes, 'AGENTS.md'), '# Notes rules\n\nKeep the page small.\n');
  writeFileSync(join(notes, 'README.md'), '# Notes\n\nA fictional notes page.\n');
  writeFileSync(join(notes, 'index.html'), page);
  const site = join(dirs.owner, 'site');
  mkdirSync(site);
  writeFileSync(join(site, 'AGENTS.md'), '# Site rules\n\nKeep the page small.\n');
  writeFileSync(join(site, 'index.html'), page.replaceAll('Notes', 'Site'));
  git(site, 'init', '-q', '-b', 'main');
  git(site, 'add', '-A');
  git(site, 'commit', '-q', '-m', 'first page');

  writeFileSync(join(dirs.fake, 'scenario.json'), JSON.stringify({ intake: true, implement: ['commit-page', 'commit-page', 'commit-page', 'commit-page'] }));
  const config = {
    tickMs: 200, leaseMs: 10_000, pollMs: 500, heartbeatMs: 100, staleMs: 5000, startGraceMs: 5000, dispatchWaitMs: 5000,
    publishRetryMs: 200, outboxRetryMs: 100, retryBackoffMs: [50, 50, 50], codexSandboxProbe: false,
    governanceRoot: join(dirs.runtime, 'tests', 'fixtures', 'governance'),
    projectConnection: { enabled: true },
    coordinator: { intake: true, repositories: ['example-org/sampleapp'] },
    ownerIntervention: { enabled: true, deliver: true },
    // The synthetic rehearsal transport: alerts are recorded on this computer, nothing is sent.
    alerts: { transport: { kind: 'synthetic' } },
    commands: { claude: [process.execPath, join(dirs.runtime, 'tests', 'supervisor', 'fixtures', 'fake-claude.mjs')], ...(CHROME ? { chrome: [CHROME] } : {}) },
  };
  writeFileSync(join(dirs.data, 'config.json'), JSON.stringify(config, null, 2));
  // The checkout the runtime was copied from, by commit and whether it had uncommitted changes: the revision accepted.
  const source = { commit: git(ROOT, 'rev-parse', 'HEAD'), uncommitted: git(ROOT, 'status', '--porcelain', '--untracked-files=no') !== '' };
  return { dirs, notes, site, revision: git(dirs.runtime, 'rev-parse', 'HEAD'), source };
}

/**
 * Start a process detached and hidden through a launcher that exits at once, and return its pid. Like the scheduled task
 * that starts AIWorks and the browser the owner opens, it has no live parent here, so the caller check walks its ancestry
 * only as far as for those (an ancestor this session cannot open would otherwise fail the check closed).
 */
function detached(command, args, { cwd = undefined, env = process.env } = {}) {
  const pidFile = join(tmpdir(), `owner-journey-${process.pid}-${Date.now()}.pid`);
  spawnSync(process.execPath, ['-e', `const c = require('node:child_process').spawn(${JSON.stringify(command)}, ${JSON.stringify(args)},
    { cwd: ${JSON.stringify(cwd ?? null)} ?? undefined, detached: true, windowsHide: true, stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref();`],
  { env, windowsHide: true });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  rmSync(pidFile, { force: true });
  return pid;
}

/** Start serve, the dashboard and Chrome, each detached and hidden; their pids go to <root>/pids.json for stop(). */
export async function start(root) {
  const dirs = Object.fromEntries(['runtime', 'data', 'fake', 'chrome'].map((name) => [name, join(root, name)]));
  const env = { ...process.env, AIWORKS_DATA: '', FAKE_CLAUDE_STATE: dirs.fake,
    GIT_AUTHOR_NAME: 'Fake Worker', GIT_AUTHOR_EMAIL: 'worker@example.invalid', GIT_COMMITTER_NAME: 'Fake Worker', GIT_COMMITTER_EMAIL: 'worker@example.invalid' };
  delete env.NODE_TEST_CONTEXT;
  const launch = (command, args) => detached(command, args, { cwd: dirs.runtime, env });
  rmSync(join(dirs.data, 'STOP'), { force: true });
  const port = await freePort();
  const pids = {
    serve: launch(process.execPath, [join(dirs.runtime, 'src', 'supervisor', 'cli.mjs'), 'serve', '--data', dirs.data]),
    dashboard: launch(process.execPath, [join(dirs.runtime, 'src', 'dashboard', 'main.mjs'), '--data', dirs.data, '--port', String(port)]),
  };
  rmSync(join(dirs.chrome, 'DevToolsActivePort'), { force: true });
  // The owner's browser: a process AIWorks did not start, in no AIWorks job.
  pids.chrome = detached(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dirs.chrome}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update',
    '--window-size=1366,900', 'about:blank']);
  const portFile = join(dirs.chrome, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
  const devtools = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) { if (await fetch(url).then((r) => r.ok, () => false)) break; await sleep(100); }
  const state = { port, url, devtools, pids };
  writeFileSync(join(root, 'pids.json'), JSON.stringify(state, null, 2));
  return state;
}

/** Stop serve through its STOP file, then the dashboard and Chrome with their process trees. */
export async function stop(root) {
  const file = join(root, 'pids.json');
  if (!existsSync(file)) return;
  const { pids } = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(join(root, 'data', 'STOP'), new Date().toISOString());
  for (let i = 0; i < 100 && alive(pids.serve); i++) await sleep(100);
  for (const pid of Object.values(pids)) if (alive(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  rmSync(file, { force: true });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A minimal DevTools protocol client for one page target. */
export async function page(devtools) {
  const targets = await fetch(`http://127.0.0.1:${devtools}/json/list`).then((r) => r.json());
  const target = targets.find((t) => t.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let id = 0;
  const waiting = new Map();
  const events = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    else if (message.method) events.push(message);
  };
  const send = (method, params = {}) => new Promise((done, fail) => {
    const n = ++id;
    waiting.set(n, (message) => (message.error ? fail(new Error(`${method}: ${message.error.message}`)) : done(message.result)));
    socket.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(`page: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  };
  return {
    send, evaluate, events, close: () => socket.close(),
    viewport: (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }),
    // The page names this computer, the one real detail it shows: a screenshot names a fictional computer instead, and
    // is taken again when a refresh put the real name back while it was captured.
    screenshot: async (path, { full = false } = {}) => {
      const size = full ? (await send('Page.getLayoutMetrics')).cssContentSize : null;
      const clip = size ? { x: 0, y: 0, width: size.width, height: Math.min(size.height, 6000), scale: 1 } : undefined;
      const name = JSON.stringify(hostname());
      for (let attempt = 1; ; attempt++) {
        await evaluate(`(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n; (n = w.nextNode());) if (n.nodeValue.includes(${name})) n.nodeValue = n.nodeValue.replaceAll(${name}, ${JSON.stringify(FICTIONAL_HOST)}); })()`);
        const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}) });
        if (!(await evaluate(`document.body.innerText.includes(${name})`))) { writeFileSync(path, Buffer.from(data, 'base64')); return; }
        if (attempt === 5) throw new Error(`screenshot ${path}: the page kept naming this computer`);
      }
    },
    navigate: async (url) => { await send('Page.navigate', { url }); await sleep(1500); },
  };
}

/** Stop the dashboard alone and start it again on the same port, as after a crash or an upgrade of the page's server. */
export async function restartDashboard(root) {
  const file = join(root, 'pids.json'), state = JSON.parse(readFileSync(file, 'utf8'));
  spawnSync('taskkill', ['/PID', String(state.pids.dashboard), '/T', '/F'], { windowsHide: true });
  await sleep(8000);
  state.pids.dashboard = detached(process.execPath, [join(root, 'runtime', 'src', 'dashboard', 'main.mjs'), '--data', join(root, 'data'), '--port', String(state.port)],
    { cwd: join(root, 'runtime') });
  writeFileSync(file, JSON.stringify(state, null, 2));
  for (let i = 0; i < 100; i++) { if (await fetch(state.url).then((r) => r.ok, () => false)) break; await sleep(100); }
}

// Page helpers: sleep, the first visible control whose text is `label` (waited for), the main region's text, the notice,
// a field set as typing would, a JSON read.
const PRELUDE = "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));" +
  "const byText = (label, sel = 'a,button,summary,label') => [...document.querySelectorAll(sel)].find((e) => (e.textContent.trim() === label || e.getAttribute('aria-label') === label) && e.offsetParent);" +
  "const click = async (label, sel) => { let e; for (let i = 0; i < 40 && !(e = byText(label, sel)); i++) await sleep(250); if (!e) throw new Error('no control ' + label); e.click(); await sleep(1500); };" +
  "const main = () => document.querySelector('main').innerText;" +
  "const notice = () => document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent;" +
  "const type = (id, value) => { const e = document.getElementById(id); e.focus(); e.value = value; e.dispatchEvent(new Event('input', { bubbles: true })); };" +
  "const api = async (path) => (await fetch(path)).json();" +
  // A press whose answer is a notice: protected actions run the caller check first, so the answer can take seconds.
  "const press = async (label) => { const before = notice(); await click(label); for (let i = 0; i < 80 && notice() === before; i++) await sleep(250); return notice(); };";

/**
 * The whole owner journey on a fresh runtime, step by step; each step's outcome goes to <root>/evidence/journey.json and
 * a failed step stops the run. Synthetic data only: two fictional projects and the synthetic worker.
 */
export async function journey(root) {
  const { notes, site, revision, source } = setup(root);
  const steps = [], evidence = join(root, 'evidence');
  const record = (step, ok, detail) => {
    steps.push({ step, ok, detail });
    writeFileSync(join(evidence, 'journey.json'), JSON.stringify({ source, runtime: revision, steps }, null, 2));
    if (!ok) throw new Error(`${step}: ${JSON.stringify(detail)}`);
  };
  const state = await start(root);
  // Builder runs in order: the first goal, a goal that stops for a decision and continues after the answer, a goal whose
  // worker tries the owner's Apply from inside its job, then ordinary runs.
  writeFileSync(join(root, 'fake', 'scenario.json'), JSON.stringify({ intake: true, probe: state.url,
    implement: ['commit-page', 'owner', 'commit-page', 'probe-commit-page', 'commit-page', 'commit-page'] }));
  const p = await page(state.devtools);
  const ui = (body) => p.evaluate(`(async () => { ${PRELUDE} ${body} })()`);
  const shot = (name, full = false) => p.screenshot(join(evidence, `${name}.png`), { full });
  const waitFor = async (body, ms = 180_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(1500)) { const value = await ui(body); if (value) return value; }
    return null;
  };
  const read = (file) => readFileSync(file, 'utf8');
  const head = () => git(site, 'rev-parse', 'HEAD');
  try {
    await p.viewport(1366, 900);
    await p.navigate(state.url);
    record('home-empty', Boolean(await waitFor('return /No projects yet/.test(main());', 30_000)), null);
    await shot('01-home-empty');

    // Idea first, connect a folder, confirm its rules (a protected owner action through the Windows caller check).
    const connect = async (folder, name, idea) => {
      await ui(`location.hash = '#/projects/add'; await sleep(1200); type('idea-text', ${JSON.stringify(idea)}); type('add-path', ${JSON.stringify(folder)});
        await click('Check folder'); await click('Connect project');
        for (let i = 0; i < 40 && !location.hash.startsWith('#/p/'); i++) await sleep(250); await sleep(1000);`);
      return ui(`await click('Review and confirm the rules…'); const n = [...document.querySelectorAll('main input[type=text]')].find((i) => i.offsetParent && i.id !== 'add-path');
        n.value = ${JSON.stringify(name)}; n.dispatchEvent(new Event('input', { bubbles: true })); return press('Confirm the rules');`);
    };
    const notesRules = await connect(notes, 'notes', 'Greet visitors on the home page.');
    record('notes-connected-rules-confirmed', /Confirmed the rules/.test(notesRules), { notice: notesRules });
    await shot('02-notes-overview');

    // Ask for a plan (the idea waits as its goal), edit it with a draft kept across navigation, save version 2, approve.
    const plan = async (project, goal) => {
      await ui(`location.hash = '#/p/${project}/start'; await sleep(1200); ${goal ? `type('start-goal', ${JSON.stringify(goal)});` : ''} await click('Ask for a plan');`);
      return waitFor(`const s = await api('/api/state'); return s.work.plans.find((x) => x.project === '${project}' && x.code === 'DRAFT_READY')?.id ?? null;`);
    };
    const first = await plan('notes', null);
    record('plan-drafted', Boolean(first), null);
    const edit = await ui(`location.hash = '#/p/notes/review/${first}'; await click('Edit plan');
      const s = document.getElementById('edit-priority'); s.value = 'high'; s.dispatchEvent(new Event('change', { bubbles: true }));
      const h = location.hash; location.hash = '#/'; await sleep(1200); location.hash = h; await sleep(1500);
      const kept = document.getElementById('edit-priority').value; await click('Save as version 2'); return { kept, text: main() };`);
    record('plan-edited-v2', edit.kept === 'high' && /Priority: Normal → High/.test(edit.text), { kept: edit.kept });
    await shot('03-review-v2');
    await ui(`await click('Approve and start');`);
    const ready = await waitFor(`const s = await api('/api/state'); return s.work.local.notes?.flatMap((c) => c.results).find((r) => r.action === 'apply') ?? null;`);
    record('implemented-verified-candidate', Boolean(ready), ready && { sha7: ready.sha7, state: ready.state });

    // Review: the checked version in its sealed frame, and desktop and phone screenshots taken under job containment.
    const preview = await ui(`location.hash = '#/p/notes/review'; await click('Open preview'); await sleep(1500);
      const sandbox = document.querySelector('main iframe')?.getAttribute('sandbox') ?? null;
      await click('Capture screenshots'); for (let i = 0; i < 60 && !/Phone: [0-9]/.test(main()); i++) await sleep(1000);
      return { sandbox, captured: /Desktop: [0-9]/.test(main()) && /Phone: [0-9]/.test(main()) };`);
    record('preview-and-capture', preview.sandbox === 'allow-scripts' && preview.captured, preview);
    await shot('04-review-preview');

    // Apply refuses a file the owner changed and writes nothing; Apply then keeps unrelated owner edits; Undo refuses an
    // applied file the owner edited, then puts the folder back.
    const original = read(join(notes, 'index.html'));
    writeFileSync(join(notes, 'index.html'), '<!doctype html><h1>Edited by the owner</h1>\n');
    const refused = await ui(`return press('Apply');`);
    record('apply-refuses-owner-edit', /Not applied/.test(refused) && /index\.html/.test(refused) &&
      read(join(notes, 'index.html')).includes('Edited by the owner') && !existsSync(join(notes, 'src')), { notice: refused });
    writeFileSync(join(notes, 'index.html'), original);
    writeFileSync(join(notes, 'README.md'), `${read(join(notes, 'README.md'))}An owner note.\n`);
    const applied = await ui(`return press('Apply');`);
    record('apply-keeps-unrelated-edits', /^Applied/.test(applied) && read(join(notes, 'index.html')).includes('Hello from') &&
      read(join(notes, 'README.md')).includes('An owner note'), { notice: applied });
    const greeting = join(notes, 'src', 'greeting.txt'), written = read(greeting);
    writeFileSync(greeting, `${written}owner line\n`);
    const undoRefused = await ui(`return press('Undo apply');`);
    record('undo-refuses-owner-edit', /Not undone/.test(undoRefused) && read(greeting).includes('owner line'), { notice: undoRefused });
    writeFileSync(greeting, written);
    const undone = await ui(`return press('Undo apply');`);
    record('undo-restores-folder', /^Undone/.test(undone) && read(join(notes, 'index.html')) === original && !existsSync(greeting) &&
      read(join(notes, 'README.md')).includes('An owner note'), { notice: undone });

    // A step stops for the owner: Needs you and Home list it under its project; it is answered on Overview with a draft
    // kept across navigation; the answer reaches the next try; the alert is recorded by the rehearsal transport only.
    const second = await plan('notes', 'Add a footer.');
    await ui(`location.hash = '#/p/notes/review/${second}'; await click('Approve and start');`);
    const needs = await waitFor(`const s = await api('/api/state'); return s.owner.count ? s.owner.groups.map((g) => g.name + ':' + g.items.map((i) => i.kind).join(',')).join(' ') : null;`);
    record('decision-in-needs-you', needs === 'notes:decision', { groups: needs });
    // Settings › AI workers counts the local goal that waits: every unfinished goal that allows the worker, GitHub or not.
    const workers = await ui(`const s = await api('/api/state'); return { usedBy: s.supervisor.settings.workers.find((w) => w.kind === 'claude-cli')?.usedBy ?? 0,
      open: s.supervisor.local.filter((c) => !['finished', 'cancelled'].includes(c.control) && c.executors.includes('claude-cli')).length };`);
    record('ai-workers-count-local', workers.open >= 1 && workers.usedBy === workers.open, workers);
    await ui(`location.hash = '#/'; return 1;`);
    const home = await waitFor(`return document.getElementById('decision-text') && main().includes('A step waits for your decision.') ? { card: true, project: true } : null;`, 30_000);
    record('decision-on-home', Boolean(home), home);
    await shot('05-home-decision');
    const answer = await ui(`location.hash = '#/needs'; await click('Answer'); type('decision-text', 'Stay on the free plan.'); location.hash = '#/needs'; await sleep(1200);
      location.hash = '#/p/notes'; await sleep(1500); const kept = document.getElementById('decision-text').value; return { kept, notice: await press('Send answer') };`);
    record('decision-answered', answer.kept === 'Stay on the free plan.' && /Answer received/.test(answer.notice), answer);
    const resumed = await waitFor(`const s = await api('/api/state'); return s.work.local.notes.find((c) => c.id.includes('${second.slice(0, 8).toLowerCase()}'))?.results.length ? true : null;`);
    const runs = join(root, 'data', 'runs');
    const guided = readdirSync(runs).some((run) => run.includes(second.slice(0, 8).toLowerCase()) && run.includes('.implement.') &&
      existsSync(join(runs, run, 'prompt.txt')) && read(join(runs, run, 'prompt.txt')).includes('Stay on the free plan.'));
    record('decision-guides-next-try', Boolean(resumed) && guided, { resumed: Boolean(resumed), guided });
    const alerts = await ui(`const a = await api('/api/v2/settings/alerts'); return { transport: a.delivery.transport, rehearsed: a.outbox.rehearsed, delivered: a.outbox.delivered,
      text: JSON.stringify(a.rehearsals.map((r) => r.alert)) };`);
    // The alert names the project as the owner named it and the dashboard's own actions: no lp- id, task issue or CLI command.
    const wording = !/\blp-|task issue|supervisor recheck/.test(alerts.text) && alerts.text.includes('notes');
    record('alert-rehearsed-not-sent', alerts.transport === 'rehearsal' && alerts.rehearsed >= 1 && alerts.delivered === 0 && wording,
      { transport: alerts.transport, rehearsed: alerts.rehearsed, delivered: alerts.delivered, wording });

    // Local Git: connect, plan; its builder tries the owner's Apply from inside its job and is refused (production lookup).
    const siteRules = await connect(site, 'site', 'Greet visitors on the site.');
    record('site-connected-rules-confirmed', /Confirmed the rules/.test(siteRules), { notice: siteRules });
    const third = await plan('site', null);
    await ui(`location.hash = '#/p/site/review/${third}'; await click('Approve and start');`);
    const siteReady = await waitFor(`const s = await api('/api/state'); return s.work.local.site?.flatMap((c) => c.results).find((r) => r.action === 'apply') ?? null;`);
    const probeFile = join(root, 'fake', 'probe.jsonl');
    const probe = existsSync(probeFile) ? JSON.parse(read(probeFile).trim().split('\n').at(-1)) : null;
    // Either refusal writes nothing: from AIWorks (its job or runner named it) or unchecked (it could not be identified, fail closed).
    record('worker-apply-refused', Boolean(siteReady) && probe?.status === 403 && ['APPLY_FROM_AIWORKS', 'APPLY_UNCHECKED'].includes(probe?.body?.code) &&
      Boolean(probe?.target) && read(join(notes, 'index.html')) === original && !existsSync(join(notes, 'src')), probe && { status: probe.status, code: probe.body?.code });
    const base = head();
    writeFileSync(join(site, 'index.html'), `${read(join(site, 'index.html'))}<p>owner draft</p>\n`);
    const dirty = await ui(`location.hash = '#/p/site/review'; return press('Apply');`);
    record('git-apply-refuses-dirty-tree', /Not applied/.test(dirty) && head() === base, { notice: dirty });
    git(site, 'checkout', '-q', '--', 'index.html');
    const gitApplied = await ui(`return press('Apply');`);
    record('git-apply-fast-forwards', /^Applied/.test(gitApplied) && head() !== base && git(site, 'status', '--porcelain') === '', { notice: gitApplied });
    writeFileSync(join(site, 'owner.txt'), 'owner\n');
    git(site, 'add', 'owner.txt');
    git(site, 'commit', '-q', '-m', 'owner commit');
    const ownerHead = head();
    const gitUndoRefused = await ui(`return press('Undo apply');`);
    record('git-undo-refuses-owner-commit', /Not undone/.test(gitUndoRefused) && head() === ownerHead, { notice: gitUndoRefused });
    git(site, 'reset', '-q', '--hard', 'HEAD~1');
    const gitUndone = await ui(`return press('Undo apply');`);
    record('git-undo-restores-branch', /^Undone/.test(gitUndone) && head() === base, { notice: gitUndone });

    // Drafts stay with their project; a route change moves focus to the screen's title.
    const drafts = await ui(`location.hash = '#/p/site/start'; await sleep(1200); type('start-goal', 'A site-only draft.'); location.hash = '#/p/notes/start'; await sleep(1200);
      const other = document.getElementById('start-goal').value; location.hash = '#/p/site/start'; await sleep(1200);
      return { other, own: document.getElementById('start-goal').value, focus: document.activeElement?.id };`);
    record('drafts-per-project-and-focus', drafts.other !== 'A site-only draft.' && drafts.own === 'A site-only draft.' && drafts.focus === 'view-title', drafts);

    // Owner writes, each through the caller check: a Knowledge fact, the project budget, the alert rules.
    const knowledge = await ui(`location.hash = '#/p/notes/knowledge'; return press('Confirm');`);
    record('knowledge-confirmed', /Confirmed/.test(knowledge), { notice: knowledge });
    const settings = await ui(`location.hash = '#/p/notes/settings'; await sleep(1500); type('settings-areas', 'AGENTS.md'); type('settings-total', '25'); type('settings-price', '0.50');
      const saved = await press('Save settings'); return { notice: saved, text: main() };`);
    record('project-budget-saved', /Saved as version 1/.test(settings.notice) && /counted of \$25\.00/.test(settings.text), { notice: settings.notice });
    const alertRules = await ui(`location.hash = '#/settings/alerts'; return press('Save alert rules');`);
    record('alert-rules-saved', /Saved as version 1/.test(alertRules), { notice: alertRules });

    // What is reported stays true: Usage counts local work's runs; Releases sends a local project's results to Review.
    const usage = await ui(`const u = await api('/api/v2/settings/usage'); return { usd: u.workers.usd, runs: u.workers.usdRuns };`);
    record('usage-counts-local-runs', usage.usd > 0 && usage.runs > 0, usage);
    // Local work's runs per goal and step, by project: models and cost from the same builders as GitHub work, each run
    // counted once (Usage equals the goals' sum), a project's total equal to its own goals' and no goal in two projects.
    const local = await ui(`const s = await api('/api/state'), u = await api('/api/v2/settings/usage'), sv = s.supervisor;
      const sum = (list) => Math.round(list.reduce((n, c) => n + (c.costByUnit.usd ?? 0), 0) * 10000) / 10000;
      const of = (project) => sv.local.filter((c) => c.project === project);
      const total = (project) => sv.localCosts.find((t) => t.project === project);
      const model = (used) => used ? used.executor + '/' + (used.model ?? 'not recorded') : null;
      location.hash = '#/p/notes'; await sleep(2000);
      return { notes: of('notes').map((c) => c.id), site: of('site').map((c) => c.id),
        runsMatch: ['notes', 'site'].every((p) => total(p)?.runs === of(p).reduce((n, c) => n + c.runsUsed, 0)),
        models: [...new Set(sv.local.flatMap((c) => c.tasks.map((t) => model(t.routing.implement))).filter(Boolean))],
        stepRuns: sv.local.reduce((n, c) => n + c.tasks.reduce((m, t) => m + t.cost.runs, 0), 0), runs: sv.local.reduce((n, c) => n + c.runsUsed, 0),
        usage: u.workers.usd, sum: Math.round((sum(sv.campaigns) + sum(sv.local)) * 10000) / 10000, breakdown: main().includes('See the breakdown') };`);
    record('local-cost-per-step', local.notes.length >= 2 && local.site.length >= 1 && !local.notes.some((id) => local.site.includes(id)) && local.runsMatch &&
      local.models.length > 0 && local.stepRuns > 0 && local.usage === local.sum && local.breakdown, local);
    const releases = await ui(`location.hash = '#/p/site/releases'; await sleep(2500); return main();`);
    record('releases-local-truthful', /Release does not apply to a project without GitHub/.test(releases) && /never released/.test(releases), null);

    // A restarted dashboard: the open page reconnects and its next owner action works without a reload.
    await ui(`location.hash = '#/p/site/review'; return 1;`);
    await restartDashboard(root);
    await sleep(8000);
    const reconnect = await ui(`return press('Apply');`);
    record('reconnect-then-owner-action', /^Applied/.test(reconnect), { notice: reconnect });

    // A 320 px window and a phone: no screen scrolls sideways.
    const routes = ['#/', '#/needs', '#/projects', '#/projects/add', '#/p/notes', '#/p/notes/plan', '#/p/notes/review', '#/p/notes/knowledge',
      '#/p/notes/settings', '#/p/site/releases', '#/settings', '#/settings/alerts', '#/settings/usage'];
    const wide = [];
    for (const [width, height, mobile] of [[320, 640, false], [390, 844, true]]) {
      await p.viewport(width, height, mobile);
      for (const route of routes) {
        const overflow = await ui(`location.hash = ${JSON.stringify(route)}; await sleep(1200); return document.documentElement.scrollWidth - document.documentElement.clientWidth;`);
        if (overflow > 0) wide.push({ width, route, overflow });
        if (['#/', '#/p/notes', '#/p/notes/review'].includes(route)) await shot(`narrow-${width}${route.replace(/[#/]+/g, '-')}`, true);
      }
    }
    record('narrow-layouts', wide.length === 0, { wide });
    // Every goal has finished: no alert is left waiting; each was rehearsed or retired, never delivered.
    const settled = await ui(`const a = await api('/api/v2/settings/alerts'); return a.outbox;`);
    record('alerts-settled', settled.pending === 0 && settled.sending === 0 && settled.delivered === 0, settled);
  } finally {
    p.close();
    await stop(root);
  }
  return steps;
}

const [command, folder, ...rest] = process.argv.slice(2);
if (command) {
  if (!folder) { console.error('Usage: node scripts/supervisor/owner-journey.mjs journey|setup|start|stop|eval|shot <folder> [...]'); process.exit(2); }
  const root = resolve(folder);
  if (command === 'journey') {
    try { for (const step of await journey(root)) console.log(`ok ${step.step}`); }
    catch (error) { console.error(`journey failed: ${error.message}`); process.exitCode = 1; }
  } else if (command === 'setup') console.log(JSON.stringify(setup(root), null, 2));
  else if (command === 'start') console.log(JSON.stringify(await start(root), null, 2));
  else if (command === 'stop') await stop(root);
  else if (command === 'eval' || command === 'shot') {
    const { devtools } = JSON.parse(readFileSync(join(root, 'pids.json'), 'utf8'));
    const p = await page(devtools);
    if (command === 'eval') console.log(JSON.stringify(await p.evaluate(`(async () => { ${PRELUDE} ${rest.join(' ')} })()`), null, 1));
    else {
      const [name, width = '1366', height = '900', full] = rest;
      await p.viewport(Number(width), Number(height), Number(width) < 600);
      await sleep(600);
      await p.screenshot(join(root, 'evidence', `${name}.png`), { full: full === 'full' });
      console.log(join(root, 'evidence', `${name}.png`));
    }
    p.close();
  }
}
