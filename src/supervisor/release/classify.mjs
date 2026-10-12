// Change classes of a release candidate (docs/design/AUTO_RELEASE.md section 4.3, slice REL2). Deterministic code over
// `git diff --name-status base..candidate`: no model decides a class. A file matched by no rule is `unclassified`, which
// blocks; a file matched by several rules takes the stricter class. Report only: nothing here releases anything.

/** The design's classes, strictest first (AUTO_RELEASE.md 4.3). */
export const STRICTNESS = Object.freeze(['migration', 'infrastructure', 'permissions', 'dependency-update', 'app-code', 'tests', 'docs']);
export const UNCLASSIFIED = 'unclassified';

const rank = (name) => STRICTNESS.indexOf(name);

/**
 * A glob over repository paths as a RegExp: `**` matches any number of whole segments (including none), `*` any run
 * of characters inside one segment, `?` one character inside a segment. A pattern without a slash matches the file's
 * base name at any depth (`*.md`), as the design's example rules read. Paths compare case-sensitively, as Git stores them.
 */
export function globRegExp(pattern) {
  const anchored = pattern.includes('/');
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      source += slash ? '(?:[^/]+/)*' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`);
}

/**
 * The class of one path under the project's rules ({ className: [globs] }): the strictest that matches, or
 * unclassified. The design orders only its own seven classes. When a project's own class name is among several
 * matches, no order says which is stricter, so the file is unclassified and blocks instead of taking a guessed class.
 */
export function classOf(path, classes) {
  const matched = Object.entries(classes ?? {})
    .filter(([, globs]) => Array.isArray(globs) && globs.some((glob) => globRegExp(glob).test(path)))
    .map(([name]) => name);
  if (matched.length === 0) return UNCLASSIFIED;
  if (matched.length === 1) return matched[0];
  if (matched.some((name) => rank(name) < 0)) return UNCLASSIFIED;
  return matched.reduce((best, name) => (rank(name) < rank(best) ? name : best));
}

/**
 * Parse `git diff --name-status` output (tab separated; renames and copies name both paths) into the paths a release
 * would change. A rename counts both its old and new path: the old one is deleted at the destination. A line that is
 * not name-status output throws, so unreadable evidence is never read as "nothing changed".
 */
export function changedPaths(nameStatus) {
  if (typeof nameStatus !== 'string') throw new Error('the diff is not name-status text');
  const paths = [];
  for (const line of nameStatus.split('\n').map((text) => text.replace(/\r$/, '')).filter(Boolean)) {
    const [status, ...rest] = line.split('\t');
    const pair = /^[RC]\d*$/.test(status);
    if (!/^[ACDMRTUX]\d*$/.test(status) || rest.length !== (pair ? 2 : 1) || rest.some((path) => !path)) {
      throw new Error(`unreadable name-status line: ${line.slice(0, 120)}`);
    }
    paths.push(...rest);
  }
  return [...new Set(paths)];
}

/** Every changed file with its class, and the classes the candidate touches, strictest first. */
export function classify(nameStatus, classes) {
  const files = changedPaths(nameStatus).map((path) => ({ path, class: classOf(path, classes) }));
  const order = (name) => (name === UNCLASSIFIED ? -1 : rank(name) < 0 ? STRICTNESS.length : rank(name));
  return { files, classes: [...new Set(files.map((file) => file.class))].sort((a, b) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0)) };
}
