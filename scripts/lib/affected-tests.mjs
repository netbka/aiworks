// Which test files can a change reach? A fast pre-check for `scripts/run-tests.mjs --affected`, never the gate: the full
// gate (`npm run check`) still runs every file.
//
// A test reaches every file it imports, and every repository path it names as a string: './x.mjs' and '../x' relative to
// its own folder, 'src/dashboard/public' or 'README.md' from the repository root, and the literal segments of a
// join(ROOT, 'src', 'supervisor', 'cli.mjs') or resolve(...) call. A named folder covers everything below it. Reaching is
// transitive through JavaScript files, so a test that starts the supervisor CLI reaches everything the CLI imports.
// The rule leans to running more: a word in a comment that names a repository path counts too, and a change to the
// dependencies or to the test runner itself (EVERYTHING) selects every file.
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/** Changed paths that select every test file: the dependencies and the test runner itself. */
export const EVERYTHING = ['package.json', 'package-lock.json', 'scripts/run-tests.mjs', 'scripts/lib/affected-tests.mjs'];
const SKIP = new Set(['.git', 'node_modules', '.local', 'campaigns', 'runs', 'backups', 'state']);
const CODE = /\.(?:mjs|cjs|js)$/;

/** Every file of the repository at `root`, as repository-relative paths with forward slashes (ignored folders left out). */
export function repositoryFiles(root, dir = '') {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : repositoryFiles(root, path);
    return entry.isFile() ? [path] : [];
  });
}

/** The string literals of a JavaScript source; a template literal gives each of its fixed parts. */
function literals(source) {
  const found = [], joined = [];
  // join(ROOT, 'src', 'supervisor', 'cli.mjs'): the literal arguments form one path, and only that path counts ('src'
  // alone would name the whole folder).
  for (const match of source.matchAll(/\b(?:join|resolve)\(([^()]*)\)/g)) {
    const parts = [...match[1].matchAll(/(['"])([^'"\r\n]*)\1/g)].map((part) => part[2]);
    if (parts.length < 2) continue;
    found.push(parts.join('/'));
    joined.push([match.index, match.index + match[0].length]);
  }
  const inJoin = (at) => joined.some(([start, end]) => at >= start && at < end);
  for (const match of source.matchAll(/(['"])((?:\\.|(?!\1)[^\\\r\n])*)\1/g)) if (!inJoin(match.index)) found.push(match[2]);
  for (const [, text] of source.matchAll(/`((?:\\.|[^\\`])*)`/g)) found.push(...text.split(/\$\{[^}]*\}/));
  return found;
}

/**
 * The repository paths `text` can name from `file`: relative to its folder, and for a test file also from the repository
 * root. Code outside tests/ finds its own files relative to itself (new URL('../../schemas/x.json', import.meta.url),
 * join(here, 'runner.mjs')); a root-relative string there ('docs/', 'registry/projects') names a path in a target
 * repository or the governance checkout, not in this one.
 */
function candidates(file, text) {
  const value = text.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  // '.', '..' and '../..' are path arithmetic (a base for a join, a check for escaping paths), never a file of their own.
  if (/^[./]*$/.test(value) || value.length > 300 || /[\s*?<>|:]/.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) return [];
  const local = posix.normalize(posix.join(posix.dirname(file), value));
  const paths = value.startsWith('.') || !file.startsWith('tests/') ? [local] : [local, posix.normalize(value)];
  // The repository root itself, or a path outside it, names nothing in particular.
  return paths.filter((path) => path !== '.' && path !== '' && !path.startsWith('../'));
}

/**
 * The reference graph of a repository: for each JavaScript file, the files and folders it names. `files` lists every
 * repository path (see repositoryFiles); `read(path)` returns a file's text.
 */
export function referenceGraph(files, read) {
  const known = new Set(files);
  const folders = new Set(files.flatMap((path) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  const graph = new Map();
  for (const file of files.filter((path) => CODE.test(path))) {
    const refs = new Set();
    for (const text of literals(read(file))) {
      for (const path of candidates(file, text)) {
        if (known.has(path)) refs.add(path);
        else if (folders.has(path)) refs.add(`${path}/`);
      }
    }
    refs.delete(file);
    graph.set(file, refs);
  }
  return graph;
}

/** Everything `test` reaches: files, and folders as `name/` prefixes. */
export function reach(graph, test) {
  const seen = new Set([test]);
  const queue = [test];
  while (queue.length) {
    for (const ref of graph.get(queue.shift()) ?? []) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (CODE.test(ref)) queue.push(ref);
    }
  }
  return seen;
}

/**
 * The test files among `tests` that `changed` paths can reach, in the order of `tests`, and why: `everything` names the
 * changed paths that select every file (EVERYTHING).
 */
export function affectedTests({ graph, tests, changed }) {
  const everything = changed.filter((path) => EVERYTHING.includes(path));
  if (everything.length) return { tests: [...tests], everything };
  const selected = tests.filter((test) => {
    const reached = [...reach(graph, test)];
    return changed.some((path) => reached.some((ref) => ref === path || (ref.endsWith('/') && path.startsWith(ref))));
  });
  return { tests: selected, everything };
}
