// Privacy rules for text that leaves this computer: staged source and commit messages (scripts/check-public-scope.mjs)
// and every GitHub publication body (aiworks#8). Findings name a category only; a matched value is never returned.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { containsKnownSecretValue } from './credential-metadata.mjs';

// The public AIWorks repository. Naming the upstream owner's other projects is refused only here; other registered
// repositories keep their own naming and rely on the generic rules and the installation's private terms.
export const PUBLIC_REPOSITORY = 'netbka/aiworks';

function publicationSettings(root) {
  try {
    const value = JSON.parse(readFileSync(resolve(root, '.local/publication.json'), 'utf8'));
    const strings = (list, min) => list === undefined || (Array.isArray(list) && list.every(item => typeof item === 'string' && item.trim().length >= min));
    if (!Array.isArray(value.privateTerms) || !strings(value.privateTerms, 3) || !strings(value.repositoryRoots, 1) || !strings(value.ignoreRepositories, 1)) throw new Error();
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Invalid private publication settings in .local/publication.json.');
  }
}

/** Installation-specific private terms from `<root>/.local/publication.json`; none when the file is absent. */
export function privateTerms(root) {
  return publicationSettings(root)?.privateTerms ?? [];
}

/**
 * The names of the Git checkouts under the `repositoryRoots` of `<root>/.local/publication.json` (relative roots resolve
 * against `root`), so a project the operator adds later is private without anyone listing it. Only the public
 * repository's own commit and push checks use them: the supervisor's publications to a target name that target, so they
 * keep to the listed terms. Names shorter than five characters, names in `ignoreRepositories` and `own`, the checking
 * repository's own folder name, are left out (exact names, ignoring case).
 */
export function repositoryNameTerms(root, own) {
  const value = publicationSettings(root);
  if (!value?.repositoryRoots) return [];
  const skip = new Set([...(value.ignoreRepositories ?? []), own].filter(Boolean).map(name => name.toLowerCase()));
  const names = value.repositoryRoots.flatMap(entry => {
    const dir = resolve(root, entry);
    try { return readdirSync(dir, { withFileTypes: true }).filter(item => item.isDirectory() && existsSync(join(dir, item.name, '.git'))).map(item => item.name); }
    catch { return []; } // a root absent on this machine lists nothing
  }).filter(name => name.length >= 5 && !skip.has(name.toLowerCase()));
  // A folder name is written with hyphens or underscores interchangeably in prose and URLs.
  return [...new Set(names.flatMap(name => [name, name.replace(/_/g, '-'), name.replace(/-/g, '_')]))];
}

// The start of a path in Git Bash's drive form: a slash, the drive letter as the first folder and a slash. Not after a
// word character, `.`, `-` (a relative path or URL) or `#` (a dashboard hash route such as `#/p/<id>`), and not after a
// slash that follows anything but `:` or another slash (a doubled slash inside a URL path); `file:///<drive>/` stays.
const BASH_DRIVE = String.raw`(?<![\w.#-])(?<![^:\/]\/)\/[A-Za-z]\/`;

export function contentFindings(text, terms = []) {
  const findings = [];
  if (containsKnownSecretValue(text) || /(?:https?|postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s/@:]+:[^\s/@]+@/i.test(text) ||
      /\b(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\b["']?\s*[:=]\s*["'][A-Za-z0-9_+\/=-]{16,}["']/i.test(text)) findings.push('credential material');
  // A sentence-ending period belongs to the prose, not the repository name.
  const repositories = text.match(/\bnetbka\/[\w.-]+/gi) ?? [];
  if (repositories.some(reference => !/^netbka\/aiworks(?:\.git)?$/i.test(reference.replace(/\.+$/, '')))) findings.push('another upstream-owner project');
  // The same folders in Git Bash's drive form too, which a worker in bash writes.
  if (/[A-Z]:[\\/]+(?:Users|Git)[\\/]+[\w.-]+/i.test(text) || new RegExp(String.raw`${BASH_DRIVE}(?:Users|Git)\/[\w.-]+`, 'i').test(text) ||
      /\/home\/(?!example\b|user\b)[\w.-]+/i.test(text)) findings.push('personal installation path');
  if (terms.some(term => text.toLowerCase().includes(term.toLowerCase()))) findings.push('private installation reference');
  return findings;
}

// Published reports cite repository-relative paths only: any drive or UNC path, in Windows or Git Bash form, and any
// path under a POSIX or macOS filesystem root, is local detail. Relative paths, URLs, dashboard hash routes and REST
// routes (`GET /repos/o/r/issues`) pass: a route starts with no filesystem root, and the slash in a relative path or
// URL follows a word character. A Git Bash drive path needs a first folder of two or more characters, so cmd switches
// written together (`cmd /d/c`) are not taken for one.
const ABSOLUTE_PATH = [
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]+[\w.$~-]/,
  new RegExp(String.raw`${BASH_DRIVE}[\w.$~-]{2,}`),
  /(?<![\w\\])\\\\[\w.$-]+\\[\w.$-]+/,
  /(?<![\w.-])\/(?:home|Users|root|mnt|media|opt|tmp|srv|etc|var|usr(?!\/bin\/env\b)|private|Volumes|Library|Applications|System|run|snap|nix)\/(?!example\b|user\b)[\w.-]+/,
];

/**
 * `text` with every path under one of `roots` made repository-relative (aiworks work item 86): a worker or verifier that
 * names a file by its absolute path in its own checkout cites the repository file, so the prefix is local detail only.
 * A root is `{ path, depth }`: `depth` further folder names after `path` belong to the prefix too (a worktree root's
 * own worktree folder). `under` names the one folder after `path` whose paths are cut: the folder name stays, and a
 * path into any other folder keeps its prefix. Only exact prefixes followed by a separator are cut, in either slash form
 * and either case, and a root on a drive also in Git Bash's drive form (`C:\x` as `/c/x`), which the privacy check
 * refuses like any drive path; anything else stays for the privacy check to judge.
 */
export function relativeTo(text, roots = []) {
  let value = String(text ?? '');
  for (const { path, depth = 0, under = null } of roots) {
    const parts = String(path ?? '').split(/[\\/]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const sep = '[\\\\/]+';
    const escape = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escaped = parts.map(escape).join(sep);
    const start = /^[A-Za-z]:$/.test(parts[0])
      ? `(?:${escaped}|\\/${parts[0][0]}${sep}${parts.slice(1).map(escape).join(sep)})` : `[\\\\/]${escaped}`;
    // A worktree folder may carry `+` (git.mjs workspaceName). A path with any `..` folder after the prefix may leave the
    // root, so it keeps its prefix, whole, for the privacy check to refuse. The rest is read to the end of the line, not
    // to the first space or quote: a folder name may hold either, and keeping a prefix only keeps the old refusal.
    const folder = under ? `(?=${String(under).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/])` : '';
    const pattern = new RegExp(`(?<![\\w.-])${start}${`${sep}(?!\\.\\.?[\\\\/])[\\w.$~+-]+`.repeat(depth)}${sep}${folder}`, 'gi');
    value = value.replace(pattern, (match, offset, whole) => {
      const rest = /^[^\r\n]*/.exec(whole.slice(offset + match.length))[0];
      return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(rest) ? match : '';
    });
  }
  return value;
}

/** Categories of private content in text published to `repository` (PR title and body, issue or PR comment). */
export function publicationFindings(text, { repository, terms = [] } = {}) {
  const value = String(text ?? '');
  const findings = contentFindings(value, terms)
    .filter((finding) => finding !== 'another upstream-owner project' || String(repository ?? '').toLowerCase() === PUBLIC_REPOSITORY);
  if (!findings.includes('personal installation path') && ABSOLUTE_PATH.some((pattern) => pattern.test(value))) findings.push('absolute local path');
  return findings;
}

export const PUBLICATION_REFUSED = 'PUBLICATION_TEXT_REFUSED';

/** Throws before any outbound write when the text is not publishable; the message names categories, never the text. */
export function assertPublishable(what, text, options) {
  const findings = publicationFindings(text, options);
  if (!findings.length) return;
  throw Object.assign(new Error(`${PUBLICATION_REFUSED}: the ${what} was not sent: it contains ${findings.join(', ')}. No matched text is printed.`),
    { code: PUBLICATION_REFUSED, findings });
}
