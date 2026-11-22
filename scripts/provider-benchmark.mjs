// Provider benchmark: runs the same five small tasks (plan, implement, merge, verify a bug, verify clean code) on each
// provider/model/effort in disposable folders and appends one JSON row per run to <dir>/results.jsonl.
// Usage: node scripts/provider-benchmark.mjs <empty-dir> [all|web] [concurrency]
// Set CLAUDE_BIN, CODEX_BIN and AGY_BIN to the native executables when they are not on PATH.
// Permissions stay scoped (edits plus git/npm/node); nothing here bypasses a provider's sandbox. Not part of npm run check.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { classify as classifyRun, prepare as prepareRun } from '../src/supervisor/adapters/executors.mjs';
import { workerEnv } from '../src/supervisor/proc.mjs';
import http from 'node:http';
const ROOT = process.argv[2]; const OUT = join(ROOT, 'results.jsonl');
const CODEX = process.env.CODEX_BIN ?? 'codex';
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude'; const AGY = process.env.AGY_BIN ?? 'agy';
const sh = (cwd, c, a) => spawnSync(c, a, { cwd, encoding: 'utf8', shell: process.platform === 'win32' && c === 'npm' });
const git = (cwd, ...a) => sh(cwd, 'git', ['-c', 'user.name=bench', '-c', 'user.email=b@b', ...a]);
const write = (d, f, t) => { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), t); };

const CONFIGS = [
  ...['haiku', 'sonnet', 'opus'].flatMap((m) => ['low', 'high'].map((e) => ({ p: 'claude', m, e }))),
  ...['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'].flatMap((m) => ['low', 'high'].map((e) => ({ p: 'codex', m, e }))),
  { p: 'codex', m: 'gpt-6-astra', e: 'medium' },
  ...['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'].map((m) => ({ p: 'agy', m, e: '-' })),
];
// Scoped permissions only: edits in the scratch folder plus git/npm/node; no permission bypass.
function cmd(c, prompt, dir) {
  if (c.p === 'claude') return [CLAUDE, ['-p', prompt, '--model', c.m, '--effort', c.e, '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(git:*)', 'Bash(npm:*)', 'Bash(node:*)', 'Read', 'Edit', 'Write', 'Glob', 'Grep', '--output-format', 'json']];
  if (c.p === 'codex') return [CODEX, ['exec', '-m', c.m, '-c', `model_reasoning_effort="${c.e}"`, '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '--skip-git-repo-check', '-s', 'workspace-write', '-C', dir, prompt]];
  // The web run only: an AGY code task runs through agyRun below.
  return [AGY, ['--settings', '{"useG1Credits":false}', '--model', c.m, '--mode', 'accept-edits', '-p', prompt]];
}
function run(c, prompt, dir, timeout = 420000) {
  return new Promise((res) => {
    const [x, a] = cmd(c, prompt, dir); const t0 = Date.now(); let out = '', err = '';
    // AGY's web run, like every production AGY run, keeps auto-update off, so the CLI cannot change mid-benchmark.
    const ch = spawn(x, a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: c.p === 'agy' ? { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: '1' } : process.env });
    const to = setTimeout(() => { ch.kill(); }, timeout);
    ch.stdout.on('data', (d) => out += d); ch.stderr.on('data', (d) => err += d);
    ch.on('close', (code) => { clearTimeout(to); res({ code, out, err: err.slice(-300), ms: Date.now() - t0 }); });
  });
}
// AGY runs a code task exactly as production runs a report task in code mode (AW-024): executors.prepare (run-local profile,
// sandboxed commands, no command allow rule, the role's terminal schema) and executors.classify (the code-mode audit). Its
// reply is the report of its terminal result; toolsSeen and audit record what the production audit saw and decided.
function agyRun(c, prompt, dir, timeout = 420000) {
  const runDir = join(ROOT, 'runs', basename(dir)); rmSync(runDir, { recursive: true, force: true }); mkdirSync(runDir, { recursive: true });
  const sessionId = randomUUID(); const packetDigest = createHash('sha256').update(prompt).digest('hex');
  const inv = prepareRun({ executor: { kind: 'agy-cli', model: c.m }, command: [AGY], role: 'implementer', deliverable: 'report', sessionId, digest: packetDigest,
    runDir, workspace: dir, timeoutMs: timeout, prompt: prompt + '\nReturn the terminal result with result "resolved", a one-line summary, and your reply as report.' });
  return new Promise((res) => {
    const t0 = Date.now(); let out = '', err = '';
    const ch = spawn(inv.argv[0], inv.argv.slice(1), { cwd: inv.cwd, env: workerEnv(process.env, inv.env), stdio: ['pipe', 'pipe', 'pipe'] });
    const to = setTimeout(() => { ch.kill(); }, timeout);
    ch.stdout.on('data', (d) => out += d); ch.stderr.on('data', (d) => err += d);
    ch.stdin.end(inv.prompt);
    ch.on('close', (code, signal) => {
      clearTimeout(to);
      const outcome = classifyRun({ executorKind: 'agy-cli', role: 'implementer', run: { exitCode: code, signal }, stdoutText: out, stderrText: err,
        expect: { deliverable: 'report', sessionId, packetDigest, web: false }, now: Date.now() });
      const toolsSeen = [...new Set(out.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)?.step_update?.tool_name]; } catch { return []; } }).filter(Boolean))].sort();
      res({ code, out: outcome.value?.report ?? '', err: err.slice(-300), ms: Date.now() - t0, toolsSeen,
        audit: outcome.class === 'result' ? 'result' : outcome.class + (outcome.violation ? ' (violation)' : '') + ': ' + outcome.detail });
    });
  });
}
const text = (c, r) => { if (c.p === 'claude') { try { return JSON.parse(r.out).result ?? r.out; } catch { return r.out; } } return r.out; };
const tokens = (c, r) => { try { if (c.p === 'claude') { const j = JSON.parse(r.out); return { cost: j.total_cost_usd, tok: (j.usage?.input_tokens ?? 0) + (j.usage?.output_tokens ?? 0) }; } if (c.p === 'codex') { const m = (r.err + r.out).match(/tokens used\s*\n?\s*([\d\s,]+)/); return { tok: m ? Number(m[1].replace(/\D/g, '')) : null }; } } catch { /* none */ } return {}; };

function fixImpl(d) {
  write(d, 'package.json', '{"type":"module","scripts":{"test":"node --test"}}');
  write(d, 'duration.mjs', `export function parseDuration(s){\n  const m = /^(\\d+)([smh])$/.exec(s);\n  if(!m) throw new Error('bad');\n  return Number(m[1]) * {s:1,m:60,h:3600}[m[2]];\n}\n`);
  write(d, 'duration.test.mjs', `import test from 'node:test';import assert from 'node:assert';import {parseDuration as p} from './duration.mjs';\ntest('simple',()=>{assert.equal(p('90s'),90);assert.equal(p('2m'),120)});\ntest('compound',()=>{assert.equal(p('1h30m'),5400);assert.equal(p('2m10s'),130)});\ntest('invalid',()=>{assert.throws(()=>p('abc'));assert.throws(()=>p(''));assert.throws(()=>p('5x'))});\n`);
}
const impl = { commit: true, prompt: 'In this directory the tests in duration.test.mjs fail. Fix duration.mjs so `npm test` passes. Do not edit the test file. Reply with one line when done.',
  setup: fixImpl, score: (d) => { const ok = sh(d, 'npm', ['test']).status === 0; const same = readFileSync(join(d, 'duration.test.mjs'), 'utf8').includes("assert.equal(p('1h30m'),5400)"); return { pass: ok && same, note: ok ? '' : 'tests fail' }; } };

function fixMerge(d) {
  write(d, 'package.json', '{"type":"module","scripts":{"test":"node --test"}}');
  write(d, 'cfg.mjs', `export const config = {\n  timeout: 30,\n  retries: 1,\n};\n`);
  write(d, 'cfg.test.mjs', `import test from 'node:test';import assert from 'node:assert';import {config as c} from './cfg.mjs';\ntest('both changes kept',()=>{assert.equal(c.timeout,60);assert.equal(c.retries,3);assert.equal(c.logLevel,'warn');assert.equal(c.cache,true)});\n`);
  git(d, 'init', '-q', '-b', 'main'); git(d, 'add', '.'); git(d, 'commit', '-qm', 'base');
  git(d, 'checkout', '-qb', 'feature');
  write(d, 'cfg.mjs', `export const config = {\n  timeout: 60,\n  retries: 3,\n  logLevel: 'warn',\n};\n`); git(d, 'commit', '-qam', 'feature: timeout+retries+log');
  git(d, 'checkout', '-q', 'main');
  write(d, 'cfg.mjs', `export const config = {\n  timeout: 30,\n  retries: 1,\n  cache: true,\n};\n`); git(d, 'commit', '-qam', 'main: cache');
}
const merge = { commit: true, prompt: 'This git repo has branch main checked out and a branch "feature". Merge feature into main, resolving the conflict so the changes of both branches are kept, make sure `npm test` passes, and finish with a merge commit (two parents). Reply with one line when done.',
  setup: fixMerge, score: (d) => { const t = sh(d, 'npm', ['test']).status === 0; const par = git(d, 'rev-list', '--parents', '-n', '1', 'HEAD').stdout.trim().split(' ').length - 1; const clean = !readFileSync(join(d, 'cfg.mjs'), 'utf8').includes('<<<<<<<'); return { pass: t && par === 2 && clean, note: `tests=${t} parents=${par}` }; } };

const PAGER_OK = `export function page(items, n, size){\n  const start = (n - 1) * size;\n  return items.slice(start, start + size);\n}\n`;
const PAGER_BAD = `export function page(items, n, size){\n  const start = n * size;\n  return items.slice(start, start + size);\n}\n`;
const fixVerify = (bug) => (d) => {
  write(d, 'package.json', '{"type":"module","scripts":{"test":"node --test"}}');
  write(d, 'pager.mjs', 'export function page(items, n, size){ return items.slice(0,size); }\n');
  write(d, 'pager.test.mjs', `import test from 'node:test';import assert from 'node:assert';import {page} from './pager.mjs';\ntest('first page',()=>{assert.deepEqual(page([1,2,3,4,5],1,2),[1,2])});\n`);
  git(d, 'init', '-q', '-b', 'main'); git(d, 'add', '.'); git(d, 'commit', '-qm', 'base'); git(d, 'checkout', '-qb', 'change');
  write(d, 'pager.mjs', bug ? PAGER_BAD : PAGER_OK); git(d, 'commit', '-qam', 'Paginate: page(items, n, size), pages numbered from 1');
};
const verifyP = 'You are an independent reviewer. Task that was assigned: "page(items, n, size) returns the n-th page of size items, pages numbered from 1". Review the diff `git diff main..change` in this repo (read only, do not modify files). Reply with ONLY a JSON object {"verdict":"accepted"|"rejected","finding":"<one sentence>"}.';
const verdictScore = (want) => (d, out) => { const j = (out.match(/\{[\s\S]*\}/) || [''])[0]; try { const o = JSON.parse(j); return { pass: o.verdict === want, note: String(o.finding).slice(0, 80) }; } catch { return { pass: false, note: 'no json' }; } };
const verifyBad = { prompt: verifyP, setup: fixVerify(true), score: verdictScore('rejected') };
const verifyOk = { prompt: verifyP, setup: fixVerify(false), score: verdictScore('accepted') };

const plan = { prompt: 'You are a delivery planner. Brief: "Add per-user rate limiting to our small Node API. Requirements: no new npm dependencies; use the library express-rate-limit; limit 100 requests/minute; must have tests; must be documented in the README." Reply with ONLY a JSON object {"conflicts":[strings],"tasks":[{"id":string,"dependsOn":[ids],"acceptance":[strings]}]} with 3 to 5 tasks. List any contradiction in the brief under conflicts.',
  setup: () => {}, score: (d, out) => { const j = (out.match(/\{[\s\S]*\}/) || [''])[0]; try { const o = JSON.parse(j); const ids = new Set(o.tasks.map((t) => t.id)); const okT = o.tasks.length >= 3 && o.tasks.length <= 5 && o.tasks.every((t) => t.acceptance?.length && t.dependsOn.every((x) => ids.has(x))); const flag = o.conflicts.some((c) => /depend|express-rate-limit|library/i.test(c)); return { pass: okT && flag, note: `tasks=${o.tasks.length} conflictFlagged=${flag}` }; } catch { return { pass: false, note: 'no json' }; } } };

const TASKS = { plan, implement: impl, merge, verifyBug: verifyBad, verifyClean: verifyOk };
async function one(c, name, t) {
  const dir = join(ROOT, 'w', `${c.p}-${c.m}-${c.e}-${name}`.replace(/[^\w.-]/g, '_')); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  // Production never gives AGY a commit task (executors.roleUnavailableReason), so the benchmark does not either.
  if (c.p === 'agy' && t.commit) { const row = { ...c, task: name, pass: null, note: 'not run: AGY takes only report tasks outside the browser' }; writeFileSync(OUT, JSON.stringify(row) + '\n', { flag: 'a' }); console.log(JSON.stringify(row)); return; }
  t.setup(dir); const r = c.p === 'agy' ? await agyRun(c, t.prompt, dir) : await run(c, t.prompt, dir); const o = c.p === 'agy' ? r.out : text(c, r); let s; try { s = t.score(dir, o); } catch (e) { s = { pass: false, note: 'score error ' + e.message }; }
  const row = { ...c, task: name, pass: s.pass, note: s.note, ms: r.ms, exit: r.code, ...tokens(c, r), ...(c.p === 'agy' ? { toolsSeen: r.toolsSeen, audit: r.audit } : {}) }; writeFileSync(OUT, JSON.stringify(row) + '\n', { flag: 'a' }); console.log(JSON.stringify(row));
}
async function webRun(c) {
  const srv = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end('<html><body><h1>Status</h1><div id="v"></div><script>setTimeout(()=>{document.getElementById("v").textContent="code:7413"},800)</script></body></html>'); }).listen(0);
  const port = srv.address().port; const dir = join(ROOT, 'w', `${c.p}-${c.m}-browser`.replace(/[^\w.-]/g, '_')); mkdirSync(dir, { recursive: true });
  const prompt = `Open http://127.0.0.1:${port}/ in a real browser (the page renders its content with JavaScript; curl or reading the HTML source will NOT show it). Report the text of the element with id "v" after the page has rendered. If you have no way to use a real browser, reply exactly NO_BROWSER.`;
  const r = await run(c, prompt, dir, 240000); const o = text(c, r);
  const row = { ...c, task: 'browser', pass: /7413/.test(o), note: /NO_BROWSER/.test(o) ? 'NO_BROWSER' : o.slice(-80).replace(/\s+/g, ' '), ms: r.ms, exit: r.code }; writeFileSync(OUT, JSON.stringify(row) + '\n', { flag: 'a' }); console.log(JSON.stringify(row)); srv.close();
}
const jobs = []; const only = process.argv[3];
if (only === 'web') { for (const c of [{ p: 'agy', m: 'gemini-3.8-flash-medium', e: '-' }, { p: 'agy', m: 'claude-sonnet-4-6', e: '-' }, { p: 'claude', m: 'sonnet', e: 'medium' }, { p: 'codex', m: 'gpt-6.1-terra', e: 'medium' }]) jobs.push(() => webRun(c)); }
else for (const c of CONFIGS) for (const [n, t] of Object.entries(TASKS)) jobs.push(() => one(c, n, t));
const CONC = Number(process.argv[4] || 4); let i = 0;
await Promise.all(Array.from({ length: CONC }, async () => { while (i < jobs.length) { const j = jobs[i++]; try { await j(); } catch (e) { console.log('ERR', e.message); } } }));
console.log('DONE');
