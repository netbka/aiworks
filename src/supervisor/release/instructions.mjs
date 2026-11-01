// A project's own publication instructions (AW-018; docs/SUPERVISOR.md "Publishing by the project's instructions"). A
// project without a standing release grant is published by the instructions it documents at the merged revision: the
// instructions are the grant. This module finds them, reads the commands they name, and follows them as the release
// state machine's adapter (release/state.mjs run/observe for `deploy`, `check` and `rollback`). The rules:
// - where: PUBLISHING.md, DEPLOY.md or RELEASE.md at the root, else a Publish, Deploy or Release section of AGENTS.md or
//   README.md, read from the Git tree of the merged revision, never from a working folder;
// - what runs: the commands the instructions name in code, in their order: `npm run <script>` for a package script the
//   project defines, `npm ci`, `npm install`, `npm test`, and a script file of the checkout (`node <file>`, or a .mjs, .js,
//   .cjs, .ps1 or .sh path). No shell runs them. A command AIWorks does not run by itself (ssh, git push, curl, npm
//   publish, a pipe and the like) makes the whole instructions not followable: nothing runs and the reason is shown;
// - which step: the words before a command decide. Roll back, revert or undo is the rollback; live, currently deployed
//   or which revision reads the live revision; check, verify, smoke or health after the first publishing command is the
//   check; everything else, a check before publishing included, is publishing;
// - each command runs once, through the release runner, in a clean checkout of exactly the merged revision, with only
//   the logins already on this computer. `publish.json` records the intent before each effect: after a restart a
//   publication that may have started is never run again; only a live revision equal to the merged one settles it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as gitA from '../adapters/git.mjs';
import { writeAtomic } from '../proc.mjs';
import { commandFile, commandLine, printed, releaseCheckout } from './deploy.mjs';
import { releasePath } from './paths.mjs';
import { releaseCommandsStopped, runReleaseCommand } from './runner.mjs';

/** The destination of every release made from publication instructions. Such a release has no grant version. */
export const INSTRUCTIONS_DESTINATION = 'publication-instructions';
export const INSTRUCTION_FILES = Object.freeze(['PUBLISHING.md', 'DEPLOY.md', 'RELEASE.md']);
export const SECTION_FILES = Object.freeze(['AGENTS.md', 'README.md']);
export const PUBLISH_RECORD = 'publish.json';
const PINNED = 'instructions.json';
const SHA = /^[0-9a-f]{40}$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const SECTION = /^(?:how to\s+)?(publish|publishing|publication|deploy|deploying|deployment|release|releasing)\b/i;
const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)/;
const SHELL_BLOCKS = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'console', 'powershell', 'pwsh', 'ps1', 'ps', 'cmd', 'bat', 'batch']);
const SCRIPT_FILE = /\.(mjs|cjs|js|ps1|sh)$/i;
/** Programs that, named in the instructions, are commands AIWorks does not run by itself. */
const OTHER_TOOLS = new Set(['npx', 'pnpm', 'yarn', 'bun', 'git', 'gh', 'ssh', 'scp', 'sftp', 'rsync', 'curl', 'wget', 'docker', 'podman',
  'make', 'sh', 'bash', 'zsh', 'pwsh', 'powershell', 'cmd', 'python', 'python3', 'py', 'pip', 'vercel', 'netlify', 'firebase',
  'wrangler', 'fly', 'flyctl', 'heroku', 'aws', 'az', 'gcloud', 'kubectl', 'helm', 'terraform', 'ansible', 'cargo', 'go', 'dotnet',
  'mvn', 'gradle', 'deno', 'sudo', 'scoop', 'winget', 'choco', 'robocopy', 'xcopy', 'copy', 'cp', 'mv', 'rm', 'del', 'cd', 'export', 'set']);
const NPM_PLAIN = new Set(['ci', 'install', 'test']);
const ROLE = [
  ['rollback', /\broll\s*-?\s*back|\brevert|\bundo\b/i],
  ['live', /\blive\s+(revision|version|commit)|\b(deployed|published)\s+(revision|version|commit)|\bcurrently\s+(deployed|published|running)|\bwhich\s+(revision|version|commit)|\bobserve\b/i],
  ['check', /\b(check|verify|verif|smoke|health)/i],
];

const digest = (text) => createHash('sha256').update(text).digest('hex');

/**
 * A reader of one project's Git tree at `revision`: { names() -> root file names, text(path) -> its text or null }.
 * Nothing is checked out and no hook runs.
 */
export function treeReader({ git = ['git'], repoPath, revision }) {
  const run = (...args) => gitA.exec(git, ['-c', 'core.fsmonitor=false', ...args], { cwd: repoPath, timeoutMs: 30_000 });
  return {
    names: () => { const out = run('ls-tree', '--name-only', revision); if (!out.ok) throw new Error('The project files at the merged revision could not be read'); return out.stdout.split(/\r?\n/).filter(Boolean); },
    text: (path) => { const out = run('show', `${revision}:${path}`); return out.ok ? out.stdout : null; },
    isFile: (path) => { const out = run('cat-file', '-t', `${revision}:${path}`); return out.ok && out.stdout === 'blob'; },
  };
}

/** The section of a Markdown text under the first heading that names publishing, up to the next heading of its level. */
function section(text) {
  const lines = String(text).split(/\r?\n/);
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fence = !fence;
    const heading = !fence && HEADING.exec(lines[i]);
    if (!heading || !SECTION.test(heading[2])) continue;
    const level = heading[1].length, body = [];
    let inner = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (FENCE.test(lines[j])) inner = !inner;
      const next = !inner && HEADING.exec(lines[j]);
      if (next && next[1].length <= level) break;
      body.push(lines[j]);
    }
    return { heading: heading[2], text: body.join('\n') };
  }
  return null;
}

/**
 * One command as written: { command } when AIWorks runs it, { refused: program } when it is a command AIWorks does not
 * run by itself, null when the text is no command (a file name or a word in code).
 */
function command(words, { scripts, isFile }, inBlock) {
  const text = words.trim().replace(/^\$\s+/, '').replace(/^>\s+/, '');
  if (!text) return null;
  const parts = text.split(/\s+/);
  const program = parts[0].toLowerCase().replace(/\.(cmd|exe)$/, '');
  const plainArgs = (args) => args.every((arg) => /^[\w@%+=:,./-]+$/.test(arg));
  if (/[|;<>`$&(){}"']/.test(text)) return program === 'npm' || program === 'node' || OTHER_TOOLS.has(program) || inBlock ? { refused: text } : null;
  if (program === 'npm') {
    const [, sub, name, ...rest] = parts;
    if ((sub === 'run' || sub === 'run-script') && name && Object.hasOwn(scripts, name) && plainArgs(rest)) return { command: { kind: 'npm', args: ['run', name, ...rest], script: name } };
    if (NPM_PLAIN.has(sub) && parts.length === 2 && (sub !== 'test' || Object.hasOwn(scripts, 'test'))) return { command: { kind: 'npm', args: [sub], script: sub === 'test' ? 'test' : null } };
    return { refused: text };
  }
  if (program === 'node') {
    const [, file, ...rest] = parts;
    const path = file?.replace(/^\.\//, '');
    return path && /\.(mjs|cjs|js)$/i.test(path) && isFile(path) && plainArgs(rest) ? { command: { kind: 'file', path, args: rest } } : { refused: text };
  }
  const path = parts[0].replace(/^\.[\\/]/, '').replaceAll('\\', '/');
  if (SCRIPT_FILE.test(path) && isFile(path)) return plainArgs(parts.slice(1)) ? { command: { kind: 'file', path, args: parts.slice(1) } } : { refused: text };
  if (OTHER_TOOLS.has(program) || inBlock) return { refused: text };
  return null;
}

/** The role of a command from the words written before it. A check before the first publishing command is publishing. */
function roleOf(label, published) {
  for (const [role, pattern] of ROLE) {
    if (!pattern.test(label)) continue;
    if (role === 'check' && !published) return 'publish';
    return role;
  }
  return 'publish';
}

/**
 * The commands of an instructions text: { steps: { publish, check, rollback, live }, refused } where each step is a
 * list of commands in their written order, and `refused` the first command AIWorks does not run by itself.
 */
export function readSteps(text, { scripts = {}, isFile = () => false } = {}) {
  const steps = { publish: [], check: [], rollback: [], live: [] };
  let refused = null, block = null, label = '', heading = '';
  const add = (words, before, inBlock) => {
    for (const part of String(words).split(/\s+&&\s+/)) {
      const found = command(part, { scripts, isFile }, inBlock);
      if (!found) continue;
      if (found.refused) { refused ??= found.refused; continue; }
      const scriptWords = found.command.script ? ` ${found.command.script}` : ` ${found.command.path ?? ''}`;
      const role = roleOf(`${heading} ${before}${scriptWords}`, steps.publish.length > 0);
      steps[role].push(found.command);
    }
  };
  for (const line of String(text).split(/\r?\n/)) {
    const fence = FENCE.exec(line);
    if (block) {
      if (fence && fence[1][0] === block.marker[0] && fence[1].length >= block.marker.length && !fence[2]) { block = null; continue; }
      if (block.shell && line.trim() && !/^\s*(#|::|rem\s|\/\/)/i.test(line)) add(line, label, true);
      continue;
    }
    if (fence) { block = { marker: fence[1], shell: SHELL_BLOCKS.has(fence[2].toLowerCase()) }; continue; }
    const heading2 = HEADING.exec(line);
    if (heading2) { heading = heading2[2]; label = ''; continue; }
    if (!line.trim()) continue;
    let before = '', at = 0;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      before += line.slice(at, match.index);
      add(match[1], before, false);
      before = '';
      at = match.index + match[0].length;
    }
    label = line.replace(/`[^`]*`/g, ' ');
  }
  return { steps, refused };
}

/**
 * Find the publication instructions of a project in its tree (`treeReader`). Returns { found: true, source, digest,
 * steps } when they name commands AIWorks follows, or { found: false, reason } in the owner's words: none documented,
 * none it can follow, or a command it does not run by itself. `digest` covers the instructions text, the package scripts
 * they name and the script files they run, so a change to any of them is seen.
 */
export function findInstructions(tree) {
  const names = tree.names();
  const named = (wanted) => names.find((name) => name.toLowerCase() === wanted.toLowerCase());
  let pkg = {};
  const pkgName = named('package.json');
  if (pkgName) { try { pkg = JSON.parse(tree.text(pkgName) ?? '{}'); } catch { pkg = {}; } }
  const scripts = pkg && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
  const candidates = [];
  for (const wanted of INSTRUCTION_FILES) { const name = named(wanted); if (name) candidates.push({ source: name, text: tree.text(name) ?? '' }); }
  for (const wanted of SECTION_FILES) {
    const name = named(wanted), found = name && section(tree.text(name) ?? '');
    if (found) candidates.push({ source: `${name}#${found.heading}`, text: found.text });
  }
  if (!candidates.length) return { found: false, reason: 'The project documents no publishing steps' };
  const first = candidates[0];
  const read = readSteps(first.text, { scripts, isFile: (path) => tree.isFile(path) });
  if (read.refused) return { found: false, reason: 'The publishing steps use a tool AIWorks does not run by itself', source: first.source };
  if (!read.steps.publish.length) return { found: false, reason: 'The publishing steps name no command AIWorks can run', source: first.source };
  const all = Object.values(read.steps).flat();
  const named2 = [...new Set(all.map((c) => c.script).filter(Boolean))].map((name) => [name, scripts[name]]);
  const files = [...new Set(all.map((c) => c.path).filter(Boolean))].map((path) => [path, tree.text(path)]);
  return { found: true, source: first.source, steps: read.steps, digest: digest(JSON.stringify([first.source, first.text, named2, files])) };
}

/** Pin the instructions a release follows. Recovery after a restart uses these, never newer ones. */
export function pinInstructions(dataDir, row, instructions) {
  mkdirSync(releasePath(dataDir, row.id), { recursive: true });
  writeAtomic(releasePath(dataDir, row.id, PINNED), JSON.stringify({ version: 1, release: row.id, revision: instructions.revision,
    source: instructions.source, digest: instructions.digest, steps: instructions.steps }, null, 2));
}

export function pinnedInstructions(dataDir, row) {
  const pinned = JSON.parse(readFileSync(releasePath(dataDir, row.id, PINNED), 'utf8'));
  if (pinned.release !== row.id || !SHA.test(pinned.revision ?? '')) throw new Error('The pinned publication instructions belong to another release');
  return pinned;
}

/** The record of one publication, or null before its first step. */
export function publishRecord(dataDir, row) {
  const path = releasePath(dataDir, row.id, PUBLISH_RECORD);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** npm without a shell: its own entry script beside this Node, where an installer puts it; else `npm` from PATH. */
function npmLine(args) {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(cli) ? [process.execPath, cli, ...args] : ['npm', ...args];
}

/** The revision a live-revision command printed: `revision: <sha>`, else the one full hexadecimal SHA it printed. */
export function liveRevision(output) {
  const stated = printed(output).revision;
  if (stated) return stated;
  const shas = [...new Set(String(output ?? '').split('\n--- stderr ---\n')[0].match(/\b[0-9a-f]{40}\b/g) ?? [])];
  return shas.length === 1 ? shas[0] : null;
}

/**
 * The adapter that follows pinned instructions for release/state.mjs: { run(release, step), observe(release, step) }.
 * - `repo`: the project's release clone, holding the merged revision; `git` the Git command; `dataDir`, `config`, `store`
 *   as for the runner;
 * - `beforePublish()`: the forward gate, asked right before the first effect; a reason stops without any intent;
 * - `runCommand`: release/runner.mjs runReleaseCommand, replaceable only in tests of the runner itself.
 */
export function instructionsAdapter({ repo, git = ['git'], config, dataDir, store, clock = Date.now, timeoutMs = 1_800_000, runCommand = runReleaseCommand,
  beforePublish = async () => null, mutate = (fn) => fn() }) {
  const save = (r, record) => mutate(() => { writeAtomic(releasePath(dataDir, r.id, PUBLISH_RECORD), JSON.stringify(record, null, 2)); return record; });
  const tell = (r, kind, detail) => mutate(() => store.journal(r.campaign_id, kind, { release: r.id, ...detail }, clock()));
  const checkout = (r, revision) => mutate(() => releaseCheckout({ repo, dataDir, release: r, revision }));
  /** After publishing started, the same checkout stays, with what the publishing steps installed or built in it. */
  const kept = (r, revision) => mutate(() => {
    const dir = releasePath(dataDir, r.id, 'checkout');
    if (!releaseCommandsStopped({ dataDir, release: r })) throw new Error('An earlier release command has no process-tree stop proof');
    const head = existsSync(dir) ? gitA.exec(git, ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 30_000 }) : null;
    return head?.ok && head.stdout === revision ? dir : releaseCheckout({ repo, dataDir, release: r, revision });
  });

  /** Run one command in the checkout: { exitCode, output }, or null when it did not run or its end is unknown. */
  async function one(r, record, step, item, dir) {
    let line;
    if (item.kind === 'npm') line = npmLine(item.args);
    else {
      const file = commandFile(dir, item.path);
      if (!file) return null;
      line = commandLine(file, item.args);
    }
    record.runs = (record.runs ?? 0) + 1;
    save(r, record);
    let result;
    try {
      result = await runCommand({ config, dataDir, stepKey: `${r.step_key ?? `${r.id}.${step}`}.${record.runs}.${step}`, command: line, cwd: dir,
        timeoutMs, store, release: r, now: clock, credential: null, recovery: ['check', 'rollback', 'live'].includes(step) && record.publish !== 'not-started' ? (step === 'live' ? 'observe' : step) : null });
    } catch { return null; }
    mutate(() => null); // a takeover may have stopped the command while it was awaited
    return result?.ran === true && Number.isInteger(result.exitCode) ? { exitCode: result.exitCode, output: result.output ?? '' } : null;
  }

  /** Every command of a step in order: 'done', 'failed' (one exited non-zero) or 'unknown' (one gave no clear end). */
  async function all(r, record, step, dir, outputs = null) {
    for (const item of record.steps[step]) {
      const result = await one(r, record, step, item, dir);
      if (!result) return 'unknown';
      if (outputs) outputs.push(result.output);
      if (result.exitCode !== 0) return 'failed';
    }
    return 'done';
  }

  /** The live revision the instructions show, or null when they show none or it could not be read. */
  async function live(r, record, dir) {
    if (!record.steps.live.length) return null;
    const outputs = [];
    if (await all(r, record, 'live', dir, outputs) !== 'done') return null;
    return liveRevision(outputs.at(-1));
  }

  function prepare(r) {
    const known = publishRecord(dataDir, r);
    if (known) return known;
    const pinned = pinnedInstructions(dataDir, r);
    return save(r, { version: 1, release: r.id, revision: pinned.revision, source: pinned.source, digest: pinned.digest, steps: pinned.steps,
      publish: 'not-started', check: null, rollback: 'not-started', liveRevision: null, runs: 0 });
  }

  async function publish(r) {
    const record = prepare(r);
    if (record.publish !== 'not-started') return { outcome: 'unknown' }; // it may have run: only the live revision settles it
    const dir = checkout(r, record.revision);
    const blocked = await beforePublish();
    if (blocked !== null) { tell(r, 'publish-waiting', { reason: blocked }); return { outcome: 'unknown' }; }
    record.publish = 'started'; // intent before effect: from here on the publication may have run
    save(r, record);
    const outcome = await all(r, record, 'publish', dir);
    if (outcome === 'unknown') return { outcome: 'unknown' };
    record.publish = outcome;
    save(r, record);
    if (outcome === 'failed') return { outcome: 'failed' };
    record.liveRevision = await live(r, record, kept(r, record.revision));
    save(r, record);
    return { outcome: 'done' };
  }

  async function observePublish(r) {
    const known = publishRecord(dataDir, r);
    if (!known || known.publish === 'not-started') return { outcome: 'not-done' }; // nothing was started
    if (known.publish === 'done' || known.publish === 'failed') return { outcome: known.publish };
    // Started, end unknown: never run again. Only a live revision equal to the merged one proves it published.
    const seen = await live(r, known, kept(r, known.revision));
    if (seen && seen === known.revision) { save(r, { ...known, publish: 'done', liveRevision: seen }); return { outcome: 'done' }; }
    return { outcome: 'unknown' };
  }

  async function check(r) {
    const known = publishRecord(dataDir, r);
    if (!known) return { outcome: 'unknown' };
    const dir = kept(r, known.revision);
    if (known.liveRevision && known.liveRevision !== known.revision) { save(r, { ...known, check: 'failed' }); return { outcome: 'failed' }; }
    if (!known.steps.check.length) { save(r, { ...known, check: 'none' }); return { outcome: 'done' }; }
    const outcome = await all(r, known, 'check', dir);
    save(r, { ...known, check: outcome === 'done' ? 'passed' : 'failed' });
    return { outcome: outcome === 'done' ? 'done' : 'failed' }; // a check with no clear end counts as failed
  }

  async function rollback(r) {
    const known = publishRecord(dataDir, r);
    if (!known?.steps.rollback.length) {
      tell(r, 'publish-not-rolled-back', { reason: 'The instructions do not say how to roll back' });
      return { outcome: 'failed' };
    }
    if (known.rollback !== 'not-started') return observeRollback(r);
    const dir = kept(r, known.revision);
    save(r, Object.assign(known, { rollback: 'started' })); // intent before effect
    const outcome = await all(r, known, 'rollback', dir);
    if (outcome === 'unknown') return { outcome: 'unknown' };
    save(r, Object.assign(known, { rollback: outcome }));
    return { outcome };
  }

  /** A rollback left open is settled from its record, never run again. */
  async function observeRollback(r) {
    const known = publishRecord(dataDir, r);
    if (!known || known.rollback === 'not-started') return { outcome: 'not-done' };
    return { outcome: known.rollback === 'done' || known.rollback === 'failed' ? known.rollback : 'unknown' };
  }

  const steps = {
    run: { deploy: publish, check, rollback },
    observe: { deploy: observePublish, check, rollback: observeRollback },
  };
  const guarded = (table) => async (r, step) => {
    const act = table[step];
    if (!act) throw new Error(`publishing by instructions has no step ${step}`);
    try { return await act(r); } catch { return { outcome: 'unknown' }; }
  };
  return { run: guarded(steps.run), observe: guarded(steps.observe) };
}
