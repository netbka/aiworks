// Privacy rules for text that leaves this computer: staged source and commit messages (scripts/check-public-scope.mjs)
// and every GitHub publication body (aiworks#8). Findings name a category only; a matched value is never returned.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { containsKnownSecretValue } from './credential-metadata.mjs';

// The public AIWorks repository. Naming the upstream owner's other projects is refused only here; other registered
// repositories keep their own naming and rely on the generic rules and the installation's private terms.
export const PUBLIC_REPOSITORY = 'netbka/aiworks';

/** Installation-specific private terms from `<root>/.local/publication.json`; none when the file is absent. */
export function privateTerms(root) {
  try {
    const value = JSON.parse(readFileSync(resolve(root, '.local/publication.json'), 'utf8'));
    if (!Array.isArray(value.privateTerms) || !value.privateTerms.every(term => typeof term === 'string' && term.trim().length >= 3)) throw new Error();
    return value.privateTerms;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Invalid private publication settings in .local/publication.json.');
  }
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
