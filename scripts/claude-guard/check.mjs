#!/usr/bin/env node
// Checks this computer's installation of the Claude Code public-repository guard: `node scripts/claude-guard/check.mjs`.
// It publishes nothing: it feeds sample commands to the installed hook, which only inspects them.
// - the hook is registered in ~/.claude/settings.json and the installed copy matches this checkout;
// - ~/.claude/hooks/public-guard.json and its terms files can be read and name at least one private term;
// - this checkout's Git privacy hooks are switched on (core.hooksPath .githooks);
// - the hook refuses a private term, a personal path and --no-verify for a public repository, and lets a clean write
//   and a mere mention of `git push` through.
// Options: --repo owner/name (default: this checkout's origin). It prints no private term. Exit 1 when a check fails.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const hooks = join(homedir(), '.claude', 'hooks');
const installed = join(hooks, 'public-guard.mjs');
const configPath = join(hooks, 'public-guard.json');
const settingsPath = join(homedir(), '.claude', 'settings.json');
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...options });

let failed = 0;
const ok = (text) => console.log(`ok   ${text}`);
const bad = (text) => { failed++; console.log(`FAIL ${text}`); };
const note = (text) => console.log(`note ${text}`);

// Installation.
const settings = readJson(settingsPath);
const registered = (settings?.hooks?.PreToolUse ?? []).some((entry) =>
  /Bash/.test(entry.matcher ?? '') && JSON.stringify(entry.hooks ?? []).includes('public-guard.mjs'));
registered ? ok('registered in ~/.claude/settings.json') : bad('not registered: run node scripts/claude-guard/install.mjs');
if (!existsSync(installed)) bad('~/.claude/hooks/public-guard.mjs is missing: run node scripts/claude-guard/install.mjs');
else {
  const same = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  same(installed) === same(join(here, 'public-guard.mjs'))
    ? ok('installed copy matches this checkout')
    : bad('installed copy differs from this checkout: run node scripts/claude-guard/install.mjs');
}

// Settings.
const config = readJson(configPath);
let term = null;
if (!config) bad('~/.claude/hooks/public-guard.json is missing or not valid JSON');
else {
  let terms = [...(config.privateTerms ?? [])];
  for (const file of config.termsFiles ?? []) {
    const data = readJson(file);
    if (!data) { bad(`terms file cannot be read: ${file}`); continue; }
    terms.push(...(data.privateTerms ?? []));
  }
  terms = terms.filter((t) => typeof t === 'string' && t.trim().length >= 3);
  terms.length ? ok(`${terms.length} private terms`) : bad('no private terms: list them in .local/publication.json or in "privateTerms"');
  term = terms[0] ?? null;
  for (const root of config.repositoryRoots ?? []) existsSync(root) ? ok(`repository root ${root}`) : note(`repository root not on this computer: ${root}`);
}

// Git privacy hooks of this checkout.
const hooksPath = run('git', ['-C', here, 'config', '--get', 'core.hooksPath']).stdout.trim();
hooksPath === '.githooks'
  ? ok('Git privacy hooks on (core.hooksPath .githooks)')
  : bad(`core.hooksPath is "${hooksPath}": run git config core.hooksPath .githooks (npm install does it)`);

// Behaviour.
const flag = process.argv.indexOf('--repo');
const origin = run('git', ['-C', here, 'remote', 'get-url', 'origin']).stdout.trim();
const repo = flag > 0 ? process.argv[flag + 1] : origin.match(/github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i)?.[1];
if (!repo) { bad('no GitHub repository to test against: pass --repo owner/name'); process.exit(1); }
const view = run('gh', ['repo', 'view', repo, '--json', 'visibility', '-q', '.visibility'], { shell: process.platform === 'win32' });
const visibility = view.status === 0 ? view.stdout.trim() : 'unknown';
const cwd = resolve(here, '../..');
const decide = (command) => {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
  const result = run(process.execPath, [installed], { input, cwd, timeout: 120000 });
  return result.status === 2 ? 'refuse' : result.status === 0 ? 'allow' : `exit ${result.status}`;
};
const cases = [
  ['clean comment', `gh issue comment 1 --repo ${repo} --body "hello"`, 'allow'],
  ['mention of git push', 'echo "git push later"', 'allow'],
];
if (visibility === 'PRIVATE' || visibility === 'INTERNAL') note(`${repo} is ${visibility.toLowerCase()}: the hook leaves it alone, so the refusal cases are skipped; pass --repo with a public repository`);
else {
  if (term) cases.push(['private term', `gh issue comment 1 --repo ${repo} --body "about ${term}"`, 'refuse']);
  cases.push(['personal path', `gh issue comment 1 --repo ${repo} --body "see ${join(homedir(), 'notes')}"`, 'refuse']);
  cases.push(['--no-verify push', 'git push --no-verify origin HEAD:refs/heads/guard-check', 'refuse']);
}
if (existsSync(installed)) {
  for (const [name, command, want] of cases) {
    const got = decide(command);
    got === want ? ok(`${name}: ${got}`) : bad(`${name}: expected ${want}, got ${got}`);
  }
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
