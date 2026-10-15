// AIWorks scoped reading (docs/design/SCOPED_READING.md sections 3 and 4, slice READ1): a task reference may name one
// section of a Markdown document as `path#anchor`. This module is pure: it parses a reference, builds a document's
// heading table with the slugs GitHub renders, and finds the lines of one section. It reads no file, runs no command and
// calls no model; the caller supplies the text at a pinned revision. Nothing dispatches with it yet (READ2).

// The anchor of a reference: a GitHub heading slug in the characters a reference may carry, at most 160 of them.
export const ANCHOR = /^[a-z0-9_-]{1,160}$/;
// Resolution reads Markdown only, and nothing larger than this (SCOPED_READING section 4, step 1).
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

// The repository-relative path rule every reference already follows (`safePath` in campaign.mjs): no leading `/`, none
// of `\ : %` or control characters, no empty, `.` or `..` segment, at most 512 characters.
const safePath = (path) => typeof path === 'string' && path.trim().length > 0 && path.length <= 512 && !path.startsWith('/') &&
  !/[\\:%\u0000-\u001f\u007f]/.test(path) && !path.split('/').some((part) => !part || part === '.' || part === '..');

/**
 * A reference as `{ path, anchor }`: `anchor` is null for a whole document. Null when the reference is not one: an unsafe
 * path, more than one `#`, or an anchor that is empty or holds a character outside `[a-z0-9_-]`.
 */
export function parseReference(reference) {
  if (typeof reference !== 'string') return null;
  const parts = reference.split('#');
  if (parts.length > 2) return null;
  const [path, anchor = null] = parts;
  if (!safePath(path) || (anchor !== null && !ANCHOR.test(anchor))) return null;
  return { path, anchor };
}

/**
 * The slug GitHub renders for a heading's text: lower case; every character that is not a letter, a digit, a space, a
 * hyphen or an underscore dropped; each space a hyphen. Links and images count by their text, HTML tags not at all.
 * Duplicates are numbered by `headings`, not here.
 */
export function slugify(text) {
  return String(text)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

const lines = (text) => String(text).split(/\r?\n/);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * The ATX headings (`#` to `######`) outside fenced code blocks, in order: `{ level, text, slug, line }`, `line` counted
 * from 1. The second heading with a slug gets `-1` appended, the third `-2`, as GitHub numbers them. Setext headings are
 * not recognised.
 */
export function headings(text) {
  const table = [];
  const occurrences = new Map();
  let fence = null;
  for (const [index, line] of lines(text).entries()) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      // A closing fence is the opening character, at least as long, with nothing after it but spaces.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null;
      continue;
    }
    // A backtick fence's info string may not hold a backtick.
    if (marker && !(marker[0] === '`' && line.trim().slice(marker.length).includes('`'))) { fence = marker; continue; }
    const match = ATX.exec(line);
    if (!match) continue;
    // An optional closing sequence of `#` marks, after a space, is not part of the text.
    const heading = (match[2] ?? '').replace(/(?:^|[ \t]+)#+$/, '').trim();
    const base = slugify(heading);
    let slug = base;
    while (occurrences.has(slug)) {
      occurrences.set(base, occurrences.get(base) + 1);
      slug = `${base}-${occurrences.get(base)}`;
    }
    occurrences.set(slug, 0);
    table.push({ level: match[1].length, text: heading, slug, line: index + 1 });
  }
  return table;
}

/**
 * The lines of the section that starts at `table[index]`: from its heading line to the line before the next heading of
 * the same or a higher level (fewer `#`), or to the last line of the document. `lineCount` is the document's line count.
 */
export function extent(table, index, lineCount) {
  const start = table[index];
  const next = table.slice(index + 1).find((heading) => heading.level <= start.level);
  return { from: start.line, to: next ? next.line - 1 : lineCount };
}

const byteLength = (content) => (typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length);

/**
 * One anchor in one document: `{ resolved: true, heading, level, slug, from, to }`, or `{ resolved: false, reason }` with
 * reason `missing`, `ambiguous`, `not-markdown` or `unreadable`. An exact slug wins; otherwise the one slug that starts
 * with `<anchor>-`, when there is exactly one. `content` is the document's text or bytes; with `path`, a file that is not
 * `.md` or `.markdown` is `not-markdown`, as is one over 2 MiB or one holding a NUL byte. An unresolved anchor means
 * the whole document is read (SCOPED_READING section 4).
 */
export function resolveSection(content, anchor, path = null) {
  if (typeof content !== 'string' && !Buffer.isBuffer(content)) return { resolved: false, reason: 'unreadable' };
  const text = typeof content === 'string' ? content : content.toString('utf8');
  if ((path !== null && !/\.(?:md|markdown)$/i.test(path)) || byteLength(content) > MAX_DOCUMENT_BYTES || text.includes('\u0000')) {
    return { resolved: false, reason: 'not-markdown' };
  }
  const table = headings(text);
  let index = table.findIndex((heading) => heading.slug === anchor);
  if (index < 0) {
    const prefixed = table.flatMap((heading, at) => (heading.slug.startsWith(`${anchor}-`) ? [at] : []));
    if (prefixed.length > 1) return { resolved: false, reason: 'ambiguous' };
    if (prefixed.length === 0) return { resolved: false, reason: 'missing' };
    [index] = prefixed;
  }
  const all = lines(text);
  // A final line break ends the last line; it does not start another.
  const lineCount = all.length > 1 && all.at(-1) === '' ? all.length - 1 : all.length;
  const { level, text: heading, slug } = table[index];
  return { resolved: true, heading, level, slug, ...extent(table, index, lineCount) };
}
