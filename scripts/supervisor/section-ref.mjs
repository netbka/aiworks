// Section references for campaign declarations (docs/design/SCOPED_READING.md section 3). A task reference may name one
// section of a Markdown document as `path#slug`: the implementer reads that section, the verifier still reads the whole
// document. This helper lists a document's section references with their lines, and checks one before it goes into a
// declaration, so a declaration never carries a stale or invented anchor. Read-only: it reads one file, or one blob with
// `git show` when `--rev` is given, and makes no network or GitHub call.
//
//   node scripts/supervisor/section-ref.mjs docs/SUPERVISOR.md [--rev main] [--repo <checkout>]   list the sections
//   node scripts/supervisor/section-ref.mjs docs/SUPERVISOR.md#1-boundary [--rev main]              check one reference
//
// A generator imports `sectionReference(path, slug, { repo, rev })`, which returns `path#slug` or throws.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extent, headings, parseReference, resolveSection } from '../../src/supervisor/reading.mjs';

const read = (path, { repo = process.cwd(), rev = null } = {}) => (rev
  ? execFileSync('git', ['-C', repo, 'show', `${rev}:${path}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  : readFileSync(resolve(repo, path), 'utf8'));

const lineCount = (text) => {
  const all = text.split(/\r?\n/);
  return all.length > 1 && all.at(-1) === '' ? all.length - 1 : all.length;
};

/** Every heading of a Markdown document as `{ reference, heading, level, from, to }`, in document order. */
export function sectionTable(path, options = {}) {
  const text = read(path, options);
  const table = headings(text);
  const count = lineCount(text);
  return table.map((heading, index) => ({ reference: `${path}#${heading.slug}`, heading: heading.text, level: heading.level, ...extent(table, index, count) }));
}

/**
 * `path#slug` when the document has a heading with exactly that slug; otherwise an Error that names the reason and the
 * closest slugs. A slug that only matches as a prefix is refused too: the declaration should carry the exact slug.
 */
export function sectionReference(path, slug, options = {}) {
  const reference = `${path}#${slug}`;
  if (!parseReference(reference)) throw new Error(`${reference} is not a valid reference (SCOPED_READING section 3)`);
  const found = resolveSection(read(path, options), slug, path);
  if (found.resolved && found.slug === slug) return reference;
  const near = headings(read(path, options)).map((heading) => heading.slug).filter((candidate) => candidate.startsWith(slug.split('-')[0]));
  const reason = found.resolved ? `the exact slug is ${found.slug}` : found.reason;
  throw new Error(`${reference}: ${reason}${near.length ? `; headings that start alike: ${near.slice(0, 6).join(', ')}` : ''}`);
}

function main(argv) {
  const options = {};
  const rest = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--rev') options.rev = argv[++index];
    else if (argv[index] === '--repo') options.repo = argv[++index];
    else rest.push(argv[index]);
  }
  if (rest.length !== 1) {
    console.error('usage: section-ref.mjs <path>[#slug] [--rev <revision>] [--repo <checkout>]');
    return 2;
  }
  const [path, slug] = rest[0].split('#');
  if (slug !== undefined) {
    try {
      const { from, to } = resolveSection(read(path, options), slug, path);
      console.log(`${sectionReference(path, slug, options)}  lines ${from}-${to}`);
      return 0;
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  }
  for (const row of sectionTable(path, options)) console.log(`${'  '.repeat(row.level - 1)}${row.reference}  lines ${row.from}-${row.to}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
