// Privacy rules for text that leaves this computer: staged source and commit messages (scripts/check-public-scope.mjs)
// and every GitHub publication body (aiworks#8). Findings name a category only; a matched value is never returned.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { containsKnownSecretValue } from './credential-metadata.mjs';

// The public AIWorks repository. Naming the upstream owner's other projects is refused only here; other registered
// repositories keep their own naming and rely on the generic rules and the installation's private terms.
export const PUBLIC_REPOSITORY = 'netbka/aiworks';

/**
 * Installation-specific private terms from `<root>/.local/publication.json`; none when the file is absent. Besides the
 * listed `privateTerms`, each folder under a `repositoryRoots` entry that holds a Git checkout is a term, so a project
 * the operator adds later is private without anyone listing it. Names shorter than five characters, names listed in
 * `ignoreRepositories` and names related to the checking checkout's own folder name are left out.
 */
export function privateTerms(root) {
  let value;
  try {
    value = JSON.parse(readFileSync(resolve(root, '.local/publication.json'), 'utf8'));
    const strings = (list, min) => list === undefined || (Array.isArray(list) && list.every(item => typeof item === 'string' && item.trim().length >= min));
    if (!Array.isArray(value.privateTerms) || !strings(value.privateTerms, 3) || !strings(value.repositoryRoots, 1) || !strings(value.ignoreRepositories, 1)) throw new Error();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Invalid private publication settings in .local/publication.json.');
  }
  const own = basename(resolve(root)).toLowerCase();
  const ignored = new Set((value.ignoreRepositories ?? []).map(name => name.toLowerCase()));
  const names = (value.repositoryRoots ?? []).flatMap(dir => {
    try { return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, '.git'))).map(entry => entry.name); }
    catch { return []; } // a root absent on this machine lists nothing
  }).filter(name => {
    const lower = name.toLowerCase();
    return lower.length >= 5 && !ignored.has(lower) && !lower.includes(own) && !own.includes(lower);
  });
  // A folder name is written with hyphens or underscores interchangeably in prose and URLs.
  return [...new Set([...value.privateTerms, ...names.flatMap(name => [name, name.replace(/_/g, '-'), name.replace(/-/g, '_')])])];
}

export function contentFindings(text, terms = []) {
  const findings = [];
  if (containsKnownSecretValue(text) || /(?:https?|postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s/@:]+:[^\s/@]+@/i.test(text) ||
      /\b(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\b["']?\s*[:=]\s*["'][A-Za-z0-9_+\/=-]{16,}["']/i.test(text)) findings.push('credential material');
  // A sentence-ending period belongs to the prose, not the repository name.
  const repositories = text.match(/\bnetbka\/[\w.-]+/gi) ?? [];
  if (repositories.some(reference => !/^netbka\/aiworks(?:\.git)?$/i.test(reference.replace(/\.+$/, '')))) findings.push('another upstream-owner project');
  if (/[A-Z]:[\\/]+(?:Users|Git)[\\/]+[\w.-]+/i.test(text) || /\/home\/(?!example\b|user\b)[\w.-]+/i.test(text)) findings.push('personal installation path');
  if (terms.some(term => text.toLowerCase().includes(term.toLowerCase()))) findings.push('private installation reference');
  return findings;
}

// Published reports cite repository-relative paths only: any drive or UNC path, and any path under a POSIX or macOS
// filesystem root, is local detail. Relative paths, URLs and REST routes (`GET /repos/o/r/issues`) pass: a route
// starts with no filesystem root, and the slash in a relative path or URL follows a word character.
const ABSOLUTE_PATH = [
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]+[\w.$~-]/,
  /(?<![\w\\])\\\\[\w.$-]+\\[\w.$-]+/,
  /(?<![\w.-])\/(?:home|Users|root|mnt|media|opt|tmp|srv|etc|var|usr(?!\/bin\/env\b)|private|Volumes|Library|Applications|System|run|snap|nix)\/(?!example\b|user\b)[\w.-]+/,
];

/**
 * `text` with every path under one of `roots` made repository-relative (aiworks work item 86): a worker or verifier that
 * names a file by its absolute path in its own checkout cites the repository file, so the prefix is local detail only.
 * A root is `{ path, depth }`: `depth` further folder names after `path` belong to the prefix too (a worktree root's
 * own worktree folder). Only exact prefixes followed by a separator are cut, in either slash form and either case;
 * anything else stays for the privacy check to judge.
 */
export function relativeTo(text, roots = []) {
  let value = String(text ?? '');
  for (const { path, depth = 0 } of roots) {
    const parts = String(path ?? '').split(/[\\/]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const sep = '[\\\\/]+';
    const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(sep);
    // A worktree folder may carry `+` (git.mjs workspaceName). A path with any `..` folder after the prefix may leave the
    // root, so it keeps its prefix, whole, for the privacy check to refuse. The rest is read to the end of the line, not
    // to the first space or quote: a folder name may hold either, and keeping a prefix only keeps the old refusal.
    const pattern = new RegExp(`(?<![\\w.-])${/^[A-Za-z]:$/.test(parts[0]) ? '' : '[\\\\/]'}${escaped}${`${sep}(?!\\.\\.?[\\\\/])[\\w.$~+-]+`.repeat(depth)}${sep}`, 'gi');
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
