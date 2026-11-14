#!/usr/bin/env node
// Installs the Claude Code public-repository guard for the current user: `node scripts/claude-guard/install.mjs`.
// - copies public-guard.mjs to ~/.claude/hooks/ (replacing an older copy);
// - writes ~/.claude/hooks/public-guard.json only when it does not exist yet, pointing at this checkout's
//   .local/publication.json and at the folder that holds this checkout (its other checkouts are private names);
// - registers the hook in ~/.claude/settings.json under hooks.PreToolUse once, after a dated backup of that file.
// Run it again after pulling a newer guard. It never edits an existing config.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// A linked worktree keeps no .local/ of its own: the settings live in the main checkout it belongs to.
const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: here, encoding: 'utf8', windowsHide: true });
const checkout = common.status === 0 ? dirname(common.stdout.trim()) : resolve(here, '../..');
const claude = join(homedir(), '.claude');
const hooks = join(claude, 'hooks');
const slash = (path) => path.replace(/\\/g, '/');
mkdirSync(hooks, { recursive: true });

const script = join(hooks, 'public-guard.mjs');
copyFileSync(join(here, 'public-guard.mjs'), script);
console.log(`installed ${slash(script)}`);

const config = join(hooks, 'public-guard.json');
if (existsSync(config)) console.log(`kept the existing ${slash(config)}`);
else {
  writeFileSync(config, JSON.stringify({
    termsFiles: [slash(join(checkout, '.local', 'publication.json'))],
    repositoryRoots: [slash(dirname(checkout))],
    ignoreRepositories: [],
    privateTerms: [],
    privatePatterns: [],
    strict: [],
    allow: {},
    binaries: [],
  }, null, 2) + '\n');
  console.log(`wrote ${slash(config)}; add your email and other private words to "privateTerms" there`);
}

const settingsPath = join(claude, 'settings.json');
let settings = {};
if (existsSync(settingsPath)) {
  const text = readFileSync(settingsPath, 'utf8');
  try { settings = JSON.parse(text); }
  catch { console.error(`${slash(settingsPath)} is not valid JSON; fix it, then run this again. Nothing was registered.`); process.exit(1); }
  writeFileSync(`${settingsPath}.bak-${new Date().toISOString().slice(0, 10)}-public-guard`, text);
}
settings.hooks ??= {};
settings.hooks.PreToolUse ??= [];
if (JSON.stringify(settings.hooks.PreToolUse).includes('public-guard.mjs')) console.log('the hook was already registered');
else {
  settings.hooks.PreToolUse.push({ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: `node "${slash(script)}"`, timeout: 120 }] });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`registered the hook in ${slash(settingsPath)}; it applies to Claude Code sessions started from now on`);
}
