#!/usr/bin/env node
// PreToolUse guard for every Claude Code session: stops a `git push` or a `gh` write to a PUBLIC GitHub repository
// when the command, a file it sends, or a pushed commit contains private data: owner-listed private terms, the names of
// local Git checkouts (other projects), personal paths, session links, or unreviewed binary files (screenshots).
// Installed to ~/.claude/hooks/ by scripts/claude-guard/install.mjs. Config: ~/.claude/hooks/public-guard.json, which
// stays on the computer (it names private things); see public-guard.example.json.
//   termsFiles      - JSON files with {privateTerms, repositoryRoots, ignoreRepositories} (AIWorks publication.json format)
//   repositoryRoots - folders whose Git checkouts' names are private
//   privateTerms    - more private words; privatePatterns - regular expressions
//   allow           - {"owner/repo": ["term", ...]} terms a given public repository may contain; "*" means every public
//                     repository except those listed in "strict"
//   binaries        - blob ids of binary files already reviewed for publication
// Exit 2 blocks the tool call and shows stderr to Claude. Any internal error blocks only a public write it cannot check.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const HERE = join(homedir(), '.claude', 'hooks');
const block = (reason) => { process.stderr.write(`public-guard: ${reason}\n`); process.exit(2); };
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const command = String(input?.tool_input?.command ?? '');
const cwd = input?.cwd || process.cwd();
// Only a command in command position counts: at the start, or after ;, &, |, ( or a `VAR=x ` prefix. Text that merely
// mentions it (an echo, a commit message, a file being written) is not a push.
const AT = String.raw`(?:^|[;&|(]\s*|\n\s*)(?:[A-Za-z_]\w*=\S*\s+)*`;
const isPush = new RegExp(`${AT}git(?:\\.exe)?(?:\\s+(?:-C\\s+\\S+|-c\\s+\\S+|--[\\w-]+(?:=\\S+)?))*\\s+push\\b`).test(command);
const isGh = new RegExp(`${AT}gh(?:\\.exe)?\\s+(?:pr|issue|api|release|gist|repo|label)\\b`).test(command);
if (!isPush && !isGh) process.exit(0);
// Reads (`gh pr view`, `gh api` GET without fields) publish nothing.
if (!isPush && /\bgh(?:\.exe)?\s+(?:pr|issue|release|repo|gist|label)\s+(?:view|list|status|diff|checks|clone)\b/.test(command) &&
    !/\bgh(?:\.exe)?\s+\S+\s+(?:create|edit|comment|review|merge|close|reopen|delete|upload|rename)\b/.test(command)) process.exit(0);
if (!isPush && /\bgh(?:\.exe)?\s+api\b/.test(command) && !/\s(?:-f|-F|--field|--raw-field|--input)\s|\s-X\s*(?:POST|PATCH|PUT|DELETE)|--method\s+(?:POST|PATCH|PUT|DELETE)/i.test(command)) process.exit(0);

const config = readJson(join(HERE, 'public-guard.json'), {});
const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });

// The working directory of a `git -C <dir> push` or of a `cd <dir> && ...` prefix.
let workdir = cwd;
const cdMatch = command.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/);
if (cdMatch) workdir = resolve(cwd, cdMatch[1].replace(/^["']|["']$/g, ''));
const dashC = command.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/);
if (dashC) workdir = resolve(workdir, dashC[1].replace(/^["']|["']$/g, ''));

function slugOf(url) {
  const m = String(url).trim().match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

// The push arguments end at the first shell operator or redirection.
const pushSegment = isPush ? command.slice(command.search(/\bpush\b/) + 4).split(/\s(?:\d?>|<|\||;|&)/)[0] : '';

// Target repository.
let repo = null, remoteName = 'origin';
if (isPush) {
  const args = pushSegment.split(/\s+/).filter(word => word && !word.startsWith('-') && !/^[;&|]/.test(word));
  if (args[0] && !/[:/]/.test(args[0]) || args[0] && /github\.com/.test(args[0])) remoteName = args[0];
  const url = /github\.com/.test(remoteName) ? remoteName : git(workdir, ['remote', 'get-url', remoteName]).stdout;
  repo = slugOf(url);
  if (!repo) process.exit(0); // not a GitHub remote
} else {
  const flag = command.match(/(?:-R|--repo)[\s=]+["']?([\w.-]+\/[\w.-]+)/);
  const api = command.match(/\brepos\/([\w.-]+\/[\w.-]+)/);
  const url = command.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\/|\.git|["'\s]|$)/);
  repo = flag?.[1] ?? api?.[1] ?? url?.[1] ?? slugOf(git(workdir, ['remote', 'get-url', 'origin']).stdout);
  if (!repo) {
    if (/\bgh(?:\.exe)?\s+gist\b/.test(command)) repo = 'gist/public';
    else if (/\bgh(?:\.exe)?\s+api\s+["']?\/?(?:user|graphql)\b/.test(command)) repo = 'user/api';
    else block('cannot tell which repository this gh command writes to; add -R owner/repo.');
  }
}

// Visibility, cached for six hours. Unknown visibility counts as public.
function visibility(slug) {
  if (slug === 'user/api') return 'public';
  if (slug === 'gist/public') return /--public|-p\b/.test(command) ? 'public' : 'secret';
  const cachePath = join(HERE, '.public-guard-cache.json');
  const cache = readJson(cachePath, {});
  const hit = cache[slug.toLowerCase()];
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.visibility;
  let value = 'public';
  try { value = execFileSync('gh', ['api', `repos/${slug}`, '--jq', '.visibility'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim() || 'public'; }
  catch { return 'public'; }
  cache[slug.toLowerCase()] = { visibility: value, at: Date.now() };
  try { writeFileSync(cachePath, JSON.stringify(cache, null, 1)); } catch { /* cache is optional */ }
  return value;
}
if (visibility(repo) !== 'public') process.exit(0);

// Private terms.
const terms = new Set();
const roots = [...(config.repositoryRoots ?? [])];
const ignored = new Set((config.ignoreRepositories ?? []).map(name => name.toLowerCase()));
for (const file of config.termsFiles ?? []) {
  const value = readJson(file, null);
  if (!value) continue;
  for (const term of value.privateTerms ?? []) terms.add(String(term));
  roots.push(...(value.repositoryRoots ?? []));
  for (const name of value.ignoreRepositories ?? []) ignored.add(String(name).toLowerCase());
}
for (const dir of roots) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !existsSync(join(dir, entry.name, '.git'))) continue;
    const lower = entry.name.toLowerCase();
    if (lower.length < 5 || ignored.has(lower) || lower.startsWith('tmp')) continue;
    terms.add(entry.name);
  }
}
for (const term of config.privateTerms ?? []) terms.add(String(term));
const norm = (text) => String(text).toLowerCase().replace(/[_\s]/g, '-');
const repoName = norm(repo.split('/')[1]);
// "allow": {"*": [...]} applies to every public repository except those in "strict".
const strict = (config.strict ?? []).some(slug => slug.toLowerCase() === repo.toLowerCase());
const allowed = new Set(Object.entries(config.allow ?? {}).filter(([slug]) => slug.toLowerCase() === repo.toLowerCase() || (slug === '*' && !strict)).flatMap(([, list]) => list.map(norm)));
// A repository may name itself: a term inside its own name, or its own name inside a term (a worktree folder), is allowed.
const active = [...terms].map(norm).filter(term => term.length >= 3 && !allowed.has(term) && !repoName.includes(term) && !term.includes(repoName));

function findings(text) {
  const found = new Set();
  const lower = norm(text);
  for (const term of active) if (lower.includes(term)) found.add(`private name "${term}"`);
  if (/claude\.ai\/code\/session_/i.test(text)) found.add('Claude session link');
  if (/[A-Z]:[\\/]+(?:Users|Git)[\\/]+[\w.-]+/i.test(text)) found.add('personal local path');
  for (const pattern of config.privatePatterns ?? []) if (new RegExp(pattern, 'i').test(text)) found.add(`private pattern /${pattern}/`);
  return [...found];
}

const problems = [];
const check = (where, text) => { for (const f of findings(text)) problems.push(`${where}: ${f}`); };

// The command text itself (bodies, titles, -f fields), without the repository slug, which names the repository, and
// without words that are existing local paths (a `cd` target, `-C <dir>`, a file argument): those are not sent.
const sent = command.replaceAll(repo, '<repo>').split(/(\s+)/).filter(word => {
  const bare = word.replace(/^["'@]|["';&|)]+$/g, '').replace(/^[\w.-]+=@?/, '');
  if (!bare || !/[\\/]/.test(bare)) return true;
  try { return !existsSync(isAbsolute(bare) ? bare : resolve(cwd, bare)); } catch { return true; }
}).join('');
check('command', sent);
// Files the command sends.
const fileArgs = [...command.matchAll(/(?:--body-file|--notes-file|--input|-F|--field|--template)[\s=]+["']?(?:[\w.-]+=)?@?([^"'\s]+)/g)].map(m => m[1]);
for (const file of fileArgs) {
  const path = isAbsolute(file) ? file : resolve(workdir, file);
  if (file === '-' || !existsSync(path)) continue;
  try { check(`file ${basename(path)}`, readFileSync(path, 'utf8')); } catch { /* unreadable: nothing sent from it either */ }
}

if (isPush) {
  if (/\s--no-verify\b|\s-n\b/.test(command)) problems.push('push: --no-verify skips the repository privacy hooks for a public repository');
  // Commits this push publishes: reachable from the pushed refs (or HEAD) and not yet on the remote.
  const words = pushSegment.split(/\s+/).filter(word => word && !word.startsWith('-') && !/^[;&|]/.test(word));
  const refspecs = words.slice(1).map(spec => spec.replace(/^\+/, '').split(':')[0]).filter(Boolean);
  const sources = command.match(/\s--(?:all|mirror)\b/) ? ['--branches'] : refspecs.length ? refspecs : ['HEAD'];
  const listed = git(workdir, ['rev-list', '--max-count=2000', ...sources, '--not', `--remotes=${remoteName}`]);
  const commits = listed.status === 0 ? listed.stdout.trim().split('\n').filter(Boolean) : [];
  if (listed.status !== 0 && sources.some(source => !source.startsWith('--'))) problems.push('push: cannot list the commits it would publish');
  const reviewed = new Set(config.binaries ?? []);
  const listFile = git(workdir, ['cat-file', 'blob', `${sources[0] === '--branches' ? 'HEAD' : sources[0]}:.public-binaries`]);
  if (listFile.status === 0) for (const line of listFile.stdout.split('\n')) { const id = line.trim().split(/\s+/)[0]; if (/^[0-9a-f]{40}$/.test(id)) reviewed.add(id); }
  for (const sha of commits) {
    const short = sha.slice(0, 8);
    check(`commit ${short} message`, git(workdir, ['show', '-s', '--format=%B', sha]).stdout);
    const patch = git(workdir, ['show', '--format=', '-p', '--no-color', '--no-ext-diff', '-U0', sha]).stdout;
    check(`commit ${short} changes`, patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n'));
    check(`commit ${short} file names`, git(workdir, ['show', '--format=', '--name-only', sha]).stdout);
    // Binary files added or changed: numstat prints "-\t-\tpath".
    for (const line of git(workdir, ['show', '--format=', '--numstat', '--no-renames', sha]).stdout.split('\n')) {
      const m = line.match(/^-\t-\t(.+)$/);
      if (!m) continue;
      const blob = git(workdir, ['rev-parse', `${sha}:${m[1]}`]).stdout.trim();
      if (blob && !reviewed.has(blob)) problems.push(`commit ${short}: binary file ${m[1]} (blob ${blob}) is not reviewed`);
    }
  }
}

if (problems.length) {
  block(`refused a write to the PUBLIC repository ${repo}:\n  - ${[...new Set(problems)].slice(0, 20).join('\n  - ')}\n` +
    'Remove the private data (reword, or rewrite the unpublished commits) and try again. A binary file must be opened and checked for ' +
    'private data first; then list its blob id in the repository\'s .public-binaries or in ~/.claude/hooks/public-guard.json "binaries". ' +
    'If a match is a false positive the owner must approve an "allow" entry for this repository in ~/.claude/hooks/public-guard.json.');
}
process.exit(0);
